"""Point d'entree du plugin : classe HelloAssoPlugin + logique d'achat.

Un article est achetable depuis la Scannette quand son part est coche
« Vendable » (salable) dans InvenTree et porte un prix de vente en EUR
(onglet Tarification > Prix de vente, palier de quantite 1). Le prix est
TOUJOURS recalcule ici, jamais recu du navigateur.

Parcours : la Scannette demande un checkout -> on cree un Purchase (pending)
puis un checkout-intent HelloAsso -> l'utilisateur paie sur la page HelloAsso
-> retour sur la Scannette (?achat=<pk>) et/ou webhook -> on RELIT le
checkout aupres de l'API ; seule la presence de la commande (paiement
autorise) declenche le retrait du stock, une seule fois (verrou de ligne).
"""

import logging
from decimal import ROUND_HALF_UP, Decimal

from django.conf import settings as django_settings
from django.db import transaction
from django.utils import timezone

from plugin import InvenTreePlugin
from plugin.mixins import AppMixin, SettingsMixin, UrlsMixin

from . import PLUGIN_VERSION
from .helloasso import HelloAssoClient, HelloAssoError

logger = logging.getLogger("inventree")

MAX_QTY = 20  # garde-fou : une Scannette n'est pas une caisse de grossiste


class HelloAssoPlugin(AppMixin, SettingsMixin, UrlsMixin, InvenTreePlugin):
    """Achat d'articles vendables via HelloAsso Checkout."""

    NAME = "HelloAsso"
    SLUG = "helloasso"
    TITLE = "Achat via HelloAsso"
    DESCRIPTION = (
        "Permet d'acheter depuis la Scannette les articles vendables : "
        "paiement sur HelloAsso, stock décrémenté une fois le paiement confirmé."
    )
    AUTHOR = "Aamir ASMAL"
    VERSION = PLUGIN_VERSION
    MIN_VERSION = "1.4.0"

    SETTINGS = {
        "HELLOASSO_ENV": {
            "name": "Environnement HelloAsso",
            "description": "Sandbox = test, aucun vrai paiement. Production = vrais paiements.",
            "choices": [("sandbox", "Sandbox (test)"), ("production", "Production")],
            "default": "sandbox",
        },
        "ORG_SLUG": {
            "name": "Slug de l'association",
            "description": "Partie de l'URL après /associations/ sur HelloAsso",
            "default": "",
        },
        "CLIENT_ID": {
            "name": "Client ID",
            "description": "Back-office HelloAsso > Intégrations et API",
            "default": "",
        },
        "CLIENT_SECRET": {
            "name": "Client Secret",
            "description": "Back-office HelloAsso > Intégrations et API",
            "default": "",
            "protected": True,
        },
        "PREFILL_PAYER": {
            "name": "Pré-remplir le payeur",
            "description": "Transmet nom, prénom et e-mail du compte à HelloAsso",
            "default": True,
            "validator": bool,
        },
    }

    def setup_urls(self):
        """Montage des endpoints sous /plugin/helloasso/."""
        from django.urls import path

        from . import api

        # Le webhook est appele par HelloAsso, sans session : InvenTree exige
        # une auth sur /plugin/ sauf pour les vues marquees auth_exempt.
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
            path("webhook", hook_view, name="webhook"),
        ]

    # ---- configuration ----
    def is_configured(self):
        """Les trois identifiants sont renseignes."""
        return all(self.get_setting(k) for k in ("ORG_SLUG", "CLIENT_ID", "CLIENT_SECRET"))

    def client(self):
        """Client API pour l'organisation configuree."""
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
    def scannette_url(self, request):
        """Base de la Scannette, pour les URL de retour HelloAsso."""
        site = (getattr(django_settings, "SITE_URL", None) or "").rstrip("/")
        if not site:
            site = request.build_absolute_uri("/").rstrip("/")
        return site + "/scannette/"

    def start_checkout(self, request, item, quantity):
        """Cree le Purchase puis le checkout HelloAsso ; renvoie (purchase, redirectUrl)."""
        from .models import Purchase

        offer = self.offer(item)
        if offer is None:
            raise ValueError("Cet article n'est pas en vente.")
        if quantity < 1 or quantity > offer["max_quantity"]:
            raise ValueError(f"Quantité possible : de 1 à {offer['max_quantity']}.")

        amount = offer["unit_cents"] * quantity
        label = offer["name"] if quantity == 1 else f"{quantity} × {offer['name']}"
        purchase = Purchase.objects.create(
            stock_item=item,
            item_name=label[:250],
            quantity=quantity,
            amount_cents=amount,
            user=request.user,
        )
        base = self.scannette_url(request)
        payload = {
            "totalAmount": amount,
            "initialAmount": amount,
            "itemName": label[:250],
            "backUrl": f"{base}?item={item.pk}",
            "errorUrl": f"{base}?achat={purchase.pk}",
            "returnUrl": f"{base}?achat={purchase.pk}",
            "containsDonation": False,
            "metadata": {"purchase": purchase.pk, "stock_item": item.pk},
        }
        u = request.user
        if self.get_setting("PREFILL_PAYER") and u.first_name and u.last_name and u.email:
            payload["payer"] = {"firstName": u.first_name, "lastName": u.last_name, "email": u.email}

        client = self.client()
        try:
            try:
                res = client.create_checkout(payload)
            except HelloAssoError as e:
                # HelloAsso valide strictement nom/prenom (chiffres, longueur...) :
                # un payeur refuse ne doit pas bloquer l'achat, il saisira lui-meme
                if e.status == 400 and "payer" in payload:
                    logger.warning("HelloAsso : payeur refusé, nouvel essai sans pré-remplissage : %s", e.body)
                    del payload["payer"]
                    res = client.create_checkout(payload)
                else:
                    raise
        except HelloAssoError as e:
            logger.error("HelloAsso : création du checkout refusée : %s %s", e, e.body)
            purchase.delete()
            raise
        purchase.checkout_intent_id = res["id"]
        purchase.save(update_fields=["checkout_intent_id"])
        return purchase, res["redirectUrl"]

    # ---- confirmation ----
    def confirm(self, purchase):
        """Verifie le paiement aupres de HelloAsso ; retire le stock une seule fois.

        Idempotent : appele au retour de l'utilisateur, a chaque webhook et a
        chaque relance de l'ecran de resultat. Renvoie le Purchase a jour.
        """
        from .models import Purchase

        if purchase.status == Purchase.STATUS_PAID or not purchase.checkout_intent_id:
            return purchase
        data = self.client().get_checkout(purchase.checkout_intent_id)
        order = (data or {}).get("order")
        if not order:
            return purchase  # pas (encore) paye

        meta = data.get("metadata") or {}
        if str(meta.get("purchase")) != str(purchase.pk):
            logger.error("HelloAsso : metadata incohérentes pour l'achat #%s : %s", purchase.pk, meta)
            return purchase
        total = (order.get("amount") or {}).get("total")
        if total is not None and int(total) != purchase.amount_cents:
            logger.error(
                "HelloAsso : montant payé %s ≠ attendu %s (achat #%s)", total, purchase.amount_cents, purchase.pk
            )
            return purchase
        payments = order.get("payments") or []
        if payments and not any(p.get("state") == "Authorized" for p in payments):
            return purchase

        with transaction.atomic():
            p = Purchase.objects.select_for_update().get(pk=purchase.pk)
            if p.status == Purchase.STATUS_PAID:
                return p
            p.status = Purchase.STATUS_PAID
            p.paid_at = timezone.now()
            p.order_id = order.get("id")
            self._remove_stock(p)
            p.save()
        return p

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
                notes=f"Achat HelloAsso (commande {p.order_id}, achat #{p.pk})",
            )
            p.stock_removed = True
