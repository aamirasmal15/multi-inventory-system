"""Point d'entree du plugin : classe PaiementsPlugin + logique d'achat.

Un article est achetable depuis la Scannette quand son part est coche
« Vendable » (salable) dans InvenTree et porte un prix de vente en EUR
(onglet Tarification > Prix de vente, palier de quantite 1). Le prix est
TOUJOURS recalcule ici, jamais recu du navigateur.

Le frigo : un emplacement choisi dans les reglages (FRIDGE_LOCATION). La
Scannette en affiche le catalogue (un produit = un part, stock cumule de ses
articles ranges dans le frigo et ses sous-emplacements) et y fait un panier.

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
        "FRIDGE_LOCATION": {
            "name": "Emplacement du frigo",
            "description": "Ses articles vendables forment la page /frigo de la Scannette (sous-emplacements compris)",
            "model": "stock.stocklocation",
        },
        "SEND_RECEIPT": {
            "name": "Envoyer le reçu par e-mail",
            "description": "Reçu (PDF joint) envoyé à l'adresse principale de l'acheteur une fois le paiement confirmé",
            "default": True,
            "validator": bool,
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
        "GOOGLE_PAY_MERCHANT_ID": {
            "name": "SumUp : Google Pay, identifiant marchand Google",
            "description": "Console Google Pay & Wallet (pay.google.com/business/console), domaine déclaré en « Gateway ». Vide = pas de bouton Google Pay.",
            "default": "",
        },
        "PAY_DISPLAY_NAME": {
            "name": "Nom affiché au payeur",
            "description": "Nom présenté dans Google Pay / Apple Pay (ex. le nom de l'association)",
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
            path("fridge", api.FridgeView.as_view(plugin=self), name="fridge"),
            path("item/<int:pk>", api.ItemView.as_view(plugin=self), name="item"),
            path("checkout", api.CheckoutView.as_view(plugin=self), name="checkout"),
            path("purchases", api.PurchaseListView.as_view(plugin=self), name="purchases"),
            path("purchase/<int:pk>", api.PurchaseView.as_view(plugin=self), name="purchase"),
            path("purchase/<int:pk>/receipt.pdf", api.ReceiptView.as_view(plugin=self), name="receipt"),
            path("purchase/<int:pk>/email", api.ReceiptEmailView.as_view(plugin=self), name="receipt-email"),
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

    # ---- frigo ----
    def fridge_location(self):
        """Emplacement du frigo (StockLocation) ou None."""
        from stock.models import StockLocation

        pk = self.get_setting("FRIDGE_LOCATION")
        try:
            return StockLocation.objects.get(pk=int(pk)) if pk else None
        except (StockLocation.DoesNotExist, TypeError, ValueError):
            return None

    @staticmethod
    def fridge_items(location, part=None):
        """Articles de stock disponibles dans le frigo (sous-emplacements compris),
        les plus anciens d'abord : c'est l'ordre de prelevement."""
        from django.db.models import F

        from stock.models import StockItem

        qs = StockItem.objects.filter(StockItem.IN_STOCK_FILTER).filter(
            location__in=location.get_descendants(include_self=True), quantity__gt=0
        )
        if part is not None:
            qs = qs.filter(part=part)
        return qs.select_related("part").order_by(F("expiry_date").asc(nulls_last=True), "pk")

    def fridge_catalog(self, location):
        """Produits du frigo, un par part : stock cumule, prix, achetable ou non."""
        products = {}
        for it in self.fridge_items(location):
            part = it.part
            if part is None or part.trackable:
                continue  # objets pretes : jamais vendus
            pr = products.get(part.pk)
            if pr is None:
                price = self.unit_price(part) if part.salable and part.active else None
                pr = products[part.pk] = {
                    "part": part.pk,
                    "name": part.full_name,
                    "description": part.description or "",
                    "units": part.units or "",
                    "thumbnail": part.get_thumbnail_url() if part.image else None,
                    "image": part.get_image_url() if part.image else None,
                    "unit_price": str(price.quantize(Decimal("0.01"))) if price else None,
                    "unit_cents": self.cents(price) if price else None,
                    "buyable": bool(price and price > 0),
                    "quantity": Decimal(0),
                    "items": [],
                }
            pr["quantity"] += it.quantity
            pr["items"].append({"pk": it.pk, "quantity": float(it.quantity), "batch": it.batch or ""})
        out = sorted(products.values(), key=lambda p: (not p["buyable"], p["name"].lower()))
        for p in out:
            # vendu a l'unite : une fraction de canette ne s'achete pas
            p["available"] = int(min(p["quantity"], MAX_QTY)) if p["buyable"] else 0
            p["quantity"] = float(p["quantity"])
        return out

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

    @staticmethod
    def cents(price):
        """Decimal en euros -> entier en centimes (arrondi commercial)."""
        return int((price * 100).quantize(Decimal("1"), ROUND_HALF_UP))

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
            "unit_cents": self.cents(price),
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

    def build_lines(self, data):
        """Valide le panier recu de la Scannette ; renvoie (source, location, lignes).

        Deux formes, jamais melangees :
        - frigo : {"source": "frigo", "lines": [{"part": pk, "quantity": n}, ...]}
        - fiche : {"lines": [{"stock_item": pk, "quantity": n}]}
        Chaque ligne = dict(part, stock_item, name, quantity, unit_cents). Prix et
        disponibilite sont TOUJOURS relus ici. Leve ValueError (message lisible).
        """
        from part.models import Part
        from stock.models import StockItem

        raw = data.get("lines")
        if not isinstance(raw, list) or not raw or len(raw) > 30:
            raise ValueError("Panier vide ou invalide.")
        merged = {}
        for ln in raw:
            try:
                q = int(ln.get("quantity", 1))
                key = ("part", int(ln["part"])) if ln.get("part") else ("item", int(ln["stock_item"]))
            except (TypeError, ValueError, KeyError, AttributeError):
                raise ValueError("Panier invalide.")
            if q < 1:
                raise ValueError("Quantité invalide.")
            merged[key] = merged.get(key, 0) + q

        if data.get("source") == "frigo":
            location = self.fridge_location()
            if location is None:
                raise ValueError("Le frigo n'est pas configuré.")
            catalog = {p["part"]: p for p in self.fridge_catalog(location)}
            lines = []
            for (kind, pk), q in merged.items():
                p = catalog.get(pk) if kind == "part" else None
                if p is None or not p["buyable"]:
                    raise ValueError("Un article du panier n'est plus en vente dans le frigo.")
                if q > p["available"]:
                    raise ValueError(f"{p['name']} : il n'en reste que {p['available']}.")
                lines.append({
                    "part": Part.objects.get(pk=pk), "stock_item": None, "name": p["name"],
                    "quantity": q, "unit_cents": p["unit_cents"],
                })
            return "frigo", location, lines

        if len(merged) != 1 or next(iter(merged))[0] != "item":
            raise ValueError("Panier invalide.")
        (_, pk), q = next(iter(merged.items()))
        try:
            item = StockItem.objects.select_related("part").get(pk=pk)
        except StockItem.DoesNotExist:
            raise ValueError("Article introuvable.")
        offer = self.offer(item)
        if offer is None:
            raise ValueError("Cet article n'est pas en vente.")
        if q > offer["max_quantity"]:
            raise ValueError(f"Quantité possible : de 1 à {offer['max_quantity']}.")
        return "item", None, [{
            "part": item.part, "stock_item": item, "name": offer["name"],
            "quantity": q, "unit_cents": offer["unit_cents"],
        }]

    def start_checkout(self, request, data):
        """Cree le Purchase et ses lignes, puis le checkout chez le prestataire.

        Renvoie (purchase, dict) : {'checkout_id'} pour SumUp (le widget de la
        Scannette l'execute), {'redirect_url'} pour HelloAsso.
        """
        from .models import Purchase, PurchaseLine

        source, location, lines = self.build_lines(data)
        provider = self.provider()
        with transaction.atomic():
            purchase = Purchase.objects.create(
                provider=provider,
                source=source,
                location=location,
                user=request.user,
                amount_cents=sum(ln["quantity"] * ln["unit_cents"] for ln in lines),
            )
            PurchaseLine.objects.bulk_create([PurchaseLine(purchase=purchase, **ln) for ln in lines])
        site = self.site_url(request)
        back = f"{site}/scannette/?achat={purchase.pk}"
        # ce que voit le prestataire (tableau de bord SumUp, recu HelloAsso)
        label = ("Frigo · " if source == "frigo" else "") + purchase.summary(240)
        try:
            if provider == "sumup":
                res = self.sumup().create_checkout(
                    # unique par compte marchand, meme si la base est restauree
                    f"scannette-{purchase.pk}-{uuid.uuid4().hex[:10]}",
                    purchase.amount_cents,
                    label,
                    return_url=f"{site}/plugin/paiements/webhook/sumup",
                    redirect_url=back,
                )
                purchase.checkout_id = res["id"]
                out = {"checkout_id": res["id"]}
            else:
                res = self._helloasso_checkout(request, purchase, label, back)
                purchase.checkout_id = str(res["id"])
                out = {"redirect_url": res["redirectUrl"]}
        except PaymentError as e:
            logger.error("Paiements : création du checkout %s refusée : %s %s", provider, e, e.body)
            purchase.delete()
            raise
        purchase.save(update_fields=["checkout_id"])
        return purchase, out

    def _helloasso_checkout(self, request, purchase, label, back):
        site = self.site_url(request)
        payload = {
            "totalAmount": purchase.amount_cents,
            "initialAmount": purchase.amount_cents,
            "itemName": label[:250],
            "backUrl": f"{site}/scannette/" + ("?frigo=1" if purchase.source == "frigo" else ""),
            "errorUrl": back,
            "returnUrl": back,
            "containsDonation": False,
            "metadata": {"purchase": purchase.pk},
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
            if self.get_setting("SEND_RECEIPT"):
                # apres commit : le worker relit un achat deja marque paye
                transaction.on_commit(lambda: self.queue_receipt(p.pk))
        return p

    @staticmethod
    def queue_receipt(pk):
        """Envoi du recu par le worker (repli synchrone gere par InvenTree)."""
        from InvenTree.tasks import offload_task

        offload_task("inventree_paiements.tasks.send_receipt", pk, group="notification")

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

    def _remove_stock(self, p):
        """Retire le stock de chaque ligne ; consigne les anomalies sans bloquer.

        Le paiement est acquis : un stock insuffisant (inventaire faux, autre
        achat simultane) ne l'annule pas, il est signale sur le recu et dans
        l'admin pour qu'un membre du bureau regularise.
        """
        notes = f"Achat {p.get_provider_display()} #{p.pk} (paiement {p.payment_ref})"
        warnings = []
        for ln in p.lines.all():
            if ln.stock_item_id:
                sources = [ln.stock_item] if ln.stock_item else []
            elif ln.part_id and p.location_id:
                sources = list(self.fridge_items(p.location, part=ln.part_id))
            else:
                sources = []
            need = Decimal(ln.quantity)
            for item in sources:
                if need <= 0:
                    break
                item.refresh_from_db()
                take = min(need, item.quantity)
                if take > 0 and item.take_stock(take, p.user, notes=notes) is not False:
                    need -= take
                    ln.removed += take
            if need > 0:
                warnings.append(f"{ln.name} : {need.normalize()} payé(s) sans stock à retirer")
            ln.save(update_fields=["removed"])
        p.stock_removed = not warnings
        p.warning = " ; ".join(warnings)
