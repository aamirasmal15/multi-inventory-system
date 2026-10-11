"""Point d'entree du plugin : classe PaiementsPlugin + logique d'achat.

Un article est achetable depuis la Scannette quand son part est coche
« Vendable » (salable) dans InvenTree et porte un prix de vente en EUR
(onglet Tarification > Prix de vente, palier de quantite 1). Le prix est
TOUJOURS recalcule ici, jamais recu du navigateur.

Deux prestataires, au choix dans les reglages :
- SumUp : le checkout est cree ici, le formulaire de carte (Payment Widget,
  Apple Pay / Google Pay) s'affiche DANS la Scannette ;
- HelloAsso : le checkout-intent est cree ici, l'utilisateur est redirige
  vers la page de paiement HelloAsso puis revient sur ?achat=<pk>.

Dans les deux cas, au retour et/ou sur webhook, on RELIT le checkout aupres
de l'API du prestataire : seul un paiement confirme par elle retire le stock,
une seule fois (verrou de ligne).
"""

import logging
import uuid
from decimal import ROUND_HALF_UP, Decimal

from django.conf import settings as django_settings
from django.db import transaction
from django.utils import timezone

from plugin import InvenTreePlugin
from plugin.mixins import AppMixin, SettingsMixin, UrlsMixin

from . import PLUGIN_VERSION
from .helloasso import HelloAssoClient, HelloAssoError
from .sumup import SumUpClient, SumUpError

logger = logging.getLogger("inventree")

MAX_QTY = 20  # garde-fou : une Scannette n'est pas une caisse de grossiste

# erreurs de prestataire remontees telles quelles a la Scannette
PaymentError = (HelloAssoError, SumUpError)


class PaiementsPlugin(AppMixin, SettingsMixin, UrlsMixin, InvenTreePlugin):
    """Achat d'articles vendables via SumUp ou HelloAsso."""

    NAME = "Paiements"
    SLUG = "paiements"
    TITLE = "Achat d'articles (SumUp / HelloAsso)"
    DESCRIPTION = (
        "Permet d'acheter depuis la Scannette les articles vendables : "
        "stock décrémenté une fois le paiement confirmé par le prestataire."
    )
    AUTHOR = "Aamir ASMAL"
    VERSION = PLUGIN_VERSION
    MIN_VERSION = "1.4.0"

    SETTINGS = {
        "PROVIDER": {
            "name": "Prestataire de paiement",
            "description": "SumUp : formulaire de carte dans la Scannette. HelloAsso : redirection vers sa page.",
            "choices": [("sumup", "SumUp"), ("helloasso", "HelloAsso")],
            "default": "sumup",
        },
        "SUMUP_API_KEY": {
            "name": "SumUp : clé API",
            "description": "Clé secrète (sup_sk_...) du compte marchand. Celle d'un compte sandbox = paiements de test.",
            "default": "",
            "protected": True,
        },
        "SUMUP_MERCHANT_CODE": {
            "name": "SumUp : code marchand",
            "description": "Code du compte marchand qui encaisse (ex. MABCD1234)",
            "default": "",
        },
        "HELLOASSO_ENV": {
            "name": "HelloAsso : environnement",
            "description": "Sandbox = test, aucun vrai paiement. Production = vrais paiements.",
            "choices": [("sandbox", "Sandbox (test)"), ("production", "Production")],
            "default": "sandbox",
        },
        "ORG_SLUG": {
            "name": "HelloAsso : slug de l'association",
            "description": "Partie de l'URL après /associations/ sur HelloAsso",
            "default": "",
        },
        "CLIENT_ID": {
            "name": "HelloAsso : Client ID",
            "description": "Back-office HelloAsso > Intégrations et API",
            "default": "",
        },
        "CLIENT_SECRET": {
            "name": "HelloAsso : Client Secret",
            "description": "Back-office HelloAsso > Intégrations et API",
            "default": "",
            "protected": True,
        },
        "PREFILL_PAYER": {
            "name": "HelloAsso : pré-remplir le payeur",
            "description": "Transmet nom, prénom et e-mail du compte à HelloAsso",
            "default": True,
            "validator": bool,
        },
    }

    def setup_urls(self):
        """Montage des endpoints sous /plugin/paiements/."""
        from django.urls import path

        from . import api

        # Les webhooks sont appeles par le prestataire, sans session : InvenTree
        # exige une auth sur /plugin/ sauf pour les vues marquees auth_exempt.
        try:
            from InvenTree.permissions import auth_exempt
        except Exception:
            auth_exempt = None
        hook_view = api.WebhookView.as_view(plugin=self)
        if auth_exempt:
            hook_view = auth_exempt(hook_view)

        return [
            path("config", api.ConfigView.as_view(plugin=self), name="config"),
            path("item/<int:pk>", api.ItemView.as_view(plugin=self), name="item"),
            path("checkout", api.CheckoutView.as_view(plugin=self), name="checkout"),
            path("purchase/<int:pk>", api.PurchaseView.as_view(plugin=self), name="purchase"),
            path("webhook/<str:provider>", hook_view, name="webhook"),
        ]

    # ---- configuration ----
    def provider(self):
        """Prestataire choisi dans les reglages."""
        return self.get_setting("PROVIDER") or "sumup"

    def is_configured(self, provider=None):
        """Les identifiants du prestataire (choisi par defaut) sont renseignes."""
        keys = {
            "sumup": ("SUMUP_API_KEY", "SUMUP_MERCHANT_CODE"),
            "helloasso": ("ORG_SLUG", "CLIENT_ID", "CLIENT_SECRET"),
        }.get(provider or self.provider(), ())
        return bool(keys) and all(self.get_setting(k) for k in keys)

    def sumup(self):
        """Client SumUp du compte marchand configure."""
        return SumUpClient(self.get_setting("SUMUP_API_KEY"), self.get_setting("SUMUP_MERCHANT_CODE"))

    def helloasso(self):
        """Client HelloAsso de l'organisation configuree."""
        return HelloAssoClient(
            self.get_setting("HELLOASSO_ENV"),
            self.get_setting("CLIENT_ID"),
            self.get_setting("CLIENT_SECRET"),
            self.get_setting("ORG_SLUG"),
        )

    # ---- prix ----
    @staticmethod
    def unit_price(part):
        """Prix unitaire EUR (Decimal) du palier de quantite 1, ou None.

        Une variante sans prix propre herite de celui de son modele (une
        famille de jus vendue au meme prix n'a qu'un prix a saisir).
        """
        from part.models import PartSellPriceBreak

        p, seen = part, set()
        while p is not None and p.pk not in seen:
            seen.add(p.pk)
            pb = (
                PartSellPriceBreak.objects.filter(part=p, quantity__lte=1)
                .order_by("-quantity")
                .first()
            )
            if pb is not None and pb.price is not None:
                if str(pb.price.currency) != "EUR":
                    return None
                return Decimal(pb.price.amount)
            p = p.variant_of
        return None

    def offer(self, item):
        """Offre d'achat pour un StockItem : dict, ou None s'il n'est pas achetable."""
        part = item.part
        if part is None or not part.salable or not part.active or part.trackable:
            return None
        if item.quantity is None or item.quantity <= 0:
            return None
        price = self.unit_price(part)
        if price is None or price <= 0:
            return None
        return {
            "unit_price": str(price.quantize(Decimal("0.01"))),
            "unit_cents": int((price * 100).quantize(Decimal("1"), ROUND_HALF_UP)),
            "currency": "EUR",
            "max_quantity": int(min(item.quantity, MAX_QTY)),
            "name": part.full_name,
        }

    # ---- creation du checkout ----
    @staticmethod
    def site_url(request):
        """URL publique de l'instance (INVENTREE_SITE_URL, sinon l'hote de la requete)."""
        site = (getattr(django_settings, "SITE_URL", None) or "").rstrip("/")
        return site or request.build_absolute_uri("/").rstrip("/")

    def start_checkout(self, request, item, quantity):
        """Cree le Purchase puis le checkout chez le prestataire.

        Renvoie (purchase, dict) : {'checkout_id'} pour SumUp (le widget de la
        Scannette l'execute), {'redirect_url'} pour HelloAsso.
        """
        from .models import Purchase

        offer = self.offer(item)
        if offer is None:
            raise ValueError("Cet article n'est pas en vente.")
        if quantity < 1 or quantity > offer["max_quantity"]:
            raise ValueError(f"Quantité possible : de 1 à {offer['max_quantity']}.")

        provider = self.provider()
        amount = offer["unit_cents"] * quantity
        label = (offer["name"] if quantity == 1 else f"{quantity} × {offer['name']}")[:250]
        purchase = Purchase.objects.create(
            provider=provider,
            stock_item=item,
            item_name=label,
            quantity=quantity,
            amount_cents=amount,
            user=request.user,
        )
        site = self.site_url(request)
        back = f"{site}/scannette/?achat={purchase.pk}"
        try:
            if provider == "sumup":
                res = self.sumup().create_checkout(
                    # unique par compte marchand, meme si la base est restauree
                    f"scannette-{purchase.pk}-{uuid.uuid4().hex[:10]}",
                    amount,
                    label,
                    return_url=f"{site}/plugin/paiements/webhook/sumup",
                    redirect_url=back,
                )
                purchase.checkout_id = res["id"]
                out = {"checkout_id": res["id"]}
            else:
                res = self._helloasso_checkout(request, purchase, item, label, back)
                purchase.checkout_id = str(res["id"])
                out = {"redirect_url": res["redirectUrl"]}
        except PaymentError as e:
            logger.error("Paiements : création du checkout %s refusée : %s %s", provider, e, e.body)
            purchase.delete()
            raise
        purchase.save(update_fields=["checkout_id"])
        return purchase, out

    def _helloasso_checkout(self, request, purchase, item, label, back):
        payload = {
            "totalAmount": purchase.amount_cents,
            "initialAmount": purchase.amount_cents,
            "itemName": label,
            "backUrl": f"{self.site_url(request)}/scannette/?item={item.pk}",
            "errorUrl": back,
            "returnUrl": back,
            "containsDonation": False,
            "metadata": {"purchase": purchase.pk, "stock_item": item.pk},
        }
        u = request.user
        if self.get_setting("PREFILL_PAYER") and u.first_name and u.last_name and u.email:
            payload["payer"] = {"firstName": u.first_name, "lastName": u.last_name, "email": u.email}
        client = self.helloasso()
        try:
            return client.create_checkout(payload)
        except HelloAssoError as e:
            # HelloAsso valide strictement nom/prenom (chiffres, longueur...) :
            # un payeur refuse ne doit pas bloquer l'achat, il saisira lui-meme
            if e.status == 400 and "payer" in payload:
                logger.warning("HelloAsso : payeur refusé, nouvel essai sans pré-remplissage : %s", e.body)
                del payload["payer"]
                return client.create_checkout(payload)
            raise

    # ---- confirmation ----
    def confirm(self, purchase):
        """Verifie le paiement aupres du prestataire ; retire le stock une seule fois.

        Idempotent : appele au retour de l'utilisateur, a chaque webhook et a
        chaque relance de l'ecran de resultat. Renvoie le Purchase a jour.
        """
        from .models import Purchase

        if purchase.status == Purchase.STATUS_PAID or not purchase.checkout_id:
            return purchase
        if purchase.provider == "sumup":
            ref = self._sumup_paid(purchase)
        else:
            ref = self._helloasso_paid(purchase)
        if ref is None:
            return purchase  # pas (encore) paye

        with transaction.atomic():
            p = Purchase.objects.select_for_update().get(pk=purchase.pk)
            if p.status == Purchase.STATUS_PAID:
                return p
            p.status = Purchase.STATUS_PAID
            p.paid_at = timezone.now()
            p.payment_ref = str(ref)[:64]
            self._remove_stock(p)
            p.save()
        return p

    def _sumup_paid(self, p):
        """Reference de transaction si SumUp confirme le paiement, sinon None."""
        data = self.sumup().get_checkout(p.checkout_id) or {}
        if data.get("status") != "PAID":
            return None
        amount = Decimal(str(data.get("amount", "0"))) * 100
        if (
            int(amount.quantize(Decimal("1"), ROUND_HALF_UP)) != p.amount_cents
            or data.get("currency") != "EUR"
            or not str(data.get("checkout_reference", "")).startswith(f"scannette-{p.pk}-")
        ):
            logger.error("SumUp : checkout %s incohérent avec l'achat #%s : %s", p.checkout_id, p.pk, data)
            return None
        tx = data.get("transactions") or []
        return data.get("transaction_code") or (tx[0].get("transaction_code") if tx else "") or p.checkout_id

    def _helloasso_paid(self, p):
        """N° de commande si HelloAsso confirme le paiement, sinon None.

        HelloAsso n'ajoute la cle 'order' au checkout-intent qu'une fois le
        paiement autorise.
        """
        data = self.helloasso().get_checkout(p.checkout_id) or {}
        order = data.get("order")
        if not order:
            return None
        meta = data.get("metadata") or {}
        total = (order.get("amount") or {}).get("total")
        if str(meta.get("purchase")) != str(p.pk) or (total is not None and int(total) != p.amount_cents):
            logger.error("HelloAsso : checkout %s incohérent avec l'achat #%s : %s", p.checkout_id, p.pk, data)
            return None
        payments = order.get("payments") or []
        if payments and not any(x.get("state") == "Authorized" for x in payments):
            return None
        return order.get("id") or p.checkout_id

    @staticmethod
    def _remove_stock(p):
        """Retire la quantite achetee ; consigne une anomalie si impossible."""
        item = p.stock_item
        if item is None:
            p.warning = "Article supprimé avant la confirmation : stock non retiré."
            return
        item.refresh_from_db()
        qty = Decimal(p.quantity)
        if item.quantity < qty:
            p.warning = f"Stock insuffisant à la confirmation ({item.quantity} restant pour {qty} payé)."
            qty = item.quantity
        if qty > 0:
            item.take_stock(
                qty,
                p.user,
                notes=f"Achat {p.get_provider_display()} (paiement {p.payment_ref}, achat #{p.pk})",
            )
            p.stock_removed = True
