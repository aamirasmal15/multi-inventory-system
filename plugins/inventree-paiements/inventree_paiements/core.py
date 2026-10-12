"""Point d'entree du plugin : classe PaiementsPlugin + logique du frigo.

Le frigo est un emplacement choisi dans les reglages (FRIDGE_LOCATION),
verrouille : seuls les admins modifient ce qu'il contient (guard.py). Tout
article range dedans (sous-emplacements compris) est EN VENTE des qu'il a un
prix : pas de case « Vendable » a cocher a la main (elle est cochee toute
seule, cf. apps.py, pour qu'InvenTree accepte un prix de vente). Le prix est
le palier de quantite 1 du prix de vente, en EUR ; une variante sans prix
propre herite de celui de son modele. Les admins le saisissent depuis le
mode « Gérer » de la Scannette (set_price).

La Scannette affiche le catalogue (un produit = un part, stock cumule de ses
articles dans le frigo) et y fait un panier. Paiement SumUp : le checkout est
cree ici avec un montant TOUJOURS recalcule ici, le formulaire de carte
(Payment Widget, Apple Pay / Google Pay) s'affiche dans la Scannette. Au
retour et/ou sur webhook, on RELIT le checkout aupres de SumUp : seul un
statut PAID retire le stock, une seule fois (verrou de ligne).
"""

import logging
import uuid
from decimal import ROUND_HALF_UP, Decimal

from django.conf import settings as django_settings
from django.db import transaction
from django.utils import timezone

from plugin import InvenTreePlugin
from plugin.mixins import AppMixin, ScheduleMixin, SettingsMixin, UrlsMixin, ValidationMixin

from . import PLUGIN_VERSION
from . import guard
from .sumup import SumUpClient, SumUpError

logger = logging.getLogger("inventree")

MAX_QTY = 20  # garde-fou par produit : une Scannette n'est pas une caisse de grossiste


class PaiementsPlugin(AppMixin, SettingsMixin, ScheduleMixin, UrlsMixin, ValidationMixin, InvenTreePlugin):
    """Frigo de l'asso : achat des articles de l'emplacement frigo via SumUp."""

    NAME = "Paiements"
    SLUG = "paiements"
    TITLE = "Frigo : achats SumUp"
    DESCRIPTION = (
        "Page /frigo de la Scannette : achat des articles rangés dans le frigo, "
        "paiement SumUp, stock décrémenté une fois le paiement confirmé, reçu par e-mail."
    )
    AUTHOR = "Aamir ASMAL"
    VERSION = PLUGIN_VERSION
    MIN_VERSION = "1.4.0"

    SETTINGS = {
        "FRIDGE_LOCATION": {
            "name": "Emplacement du frigo",
            "description": "Ses articles (sous-emplacements compris) forment la page /frigo de la Scannette",
            "model": "stock.stocklocation",
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
            "name": "Google Pay : identifiant marchand Google",
            "description": "Console Google Pay & Wallet, domaine déclaré en « Gateway ». Vide = réglage SumUp par défaut.",
            "default": "",
        },
        "PAY_DISPLAY_NAME": {
            "name": "Nom affiché au payeur",
            "description": "Nom présenté dans Google Pay / Apple Pay (ex. le nom de l'association)",
            "default": "",
        },
        "ASSO_NAME": {
            "name": "Reçu : nom de l'association",
            "description": "En tête du reçu PDF (vide = nom de l'instance InvenTree)",
            "default": "",
        },
        "ASSO_ADDRESS": {
            "name": "Reçu : adresse",
            "description": "Adresse postale de l'association, sur une ligne",
            "default": "",
        },
        "ASSO_CONTACT": {
            "name": "Reçu : contact",
            "description": "E-mail ou site affiché sur le reçu",
            "default": "",
        },
        "ASSO_ID": {
            "name": "Reçu : identifiant légal",
            "description": "Ex. « RNA W332021661 · SIRET 104 205 901 00010 »",
            "default": "",
        },
        "RECEIPT_LOGO_URL": {
            "name": "Reçu : logo",
            "description": "Adresse d'une image PNG/JPG/SVG. Vide = logo de la Scannette de l'instance.",
            "default": "",
        },
        "RECEIPT_NOTE": {
            "name": "Reçu : mention en pied de page",
            "description": "Ex. « Association loi 1901 » ou une mention fiscale validée par le trésorier",
            "default": "",
        },
        "SEND_RECEIPT": {
            "name": "Envoyer le reçu par e-mail",
            "description": "Reçu (PDF joint) envoyé automatiquement à l'adresse principale de l'acheteur une fois le paiement confirmé. Désactivé : l'acheteur peut le demander depuis son reçu.",
            "default": False,
            "validator": bool,
        },
    }

    # filet de securite : un achat paye dont ni le retour navigateur ni le
    # webhook n'ont abouti est confirme ici (relecture SumUp toutes les 10 min)
    SCHEDULED_TASKS = {
        "reconcile": {
            "func": "reconcile_pending",
            "schedule": "I",
            "minutes": 10,
        }
    }

    def setup_urls(self):
        """Montage des endpoints sous /plugin/paiements/."""
        from django.urls import path

        from . import api

        # Le webhook est appele par SumUp, sans session : InvenTree exige une
        # auth sur /plugin/ sauf pour les vues marquees auth_exempt.
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
            path("fridge/price", api.FridgePriceView.as_view(plugin=self), name="fridge-price"),
            path("checkout", api.CheckoutView.as_view(plugin=self), name="checkout"),
            path("purchases", api.PurchaseListView.as_view(plugin=self), name="purchases"),
            path("purchase/<int:pk>", api.PurchaseView.as_view(plugin=self), name="purchase"),
            path("purchase/<int:pk>/receipt.pdf", api.ReceiptView.as_view(plugin=self), name="receipt"),
            path("purchase/<int:pk>/email", api.ReceiptEmailView.as_view(plugin=self), name="receipt-email"),
            path("webhook/sumup", hook_view, name="webhook"),
        ]

    # ---- verrou du frigo (ValidationMixin, cf. guard.py) ----
    def validate_model_instance(self, instance, deltas=None):
        """Sauvegarde d'un article / emplacement du frigo : admins seulement."""
        guard.check_instance(instance)

    def validate_model_deletion(self, instance):
        """Suppression d'un article / emplacement du frigo : admins seulement."""
        guard.check_deletion(instance)

    # ---- configuration ----
    def is_configured(self):
        """Cle API et code marchand SumUp renseignes."""
        return bool(self.get_setting("SUMUP_API_KEY") and self.get_setting("SUMUP_MERCHANT_CODE"))

    def sumup(self):
        """Client SumUp du compte marchand configure."""
        return SumUpClient(self.get_setting("SUMUP_API_KEY"), self.get_setting("SUMUP_MERCHANT_CODE"))

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
        """Produits du frigo, un par part : stock cumule, prix, en vente ou non.

        En vente = actif, non trackable (objets pretes) et avec un prix.
        """
        products = {}
        for it in self.fridge_items(location):
            part = it.part
            if part is None or part.trackable:
                continue
            pr = products.get(part.pk)
            if pr is None:
                price, own = self.unit_price(part) if part.active else (None, False)
                cents = self.cents(price) if price else 0
                pr = products[part.pk] = {
                    "part": part.pk,
                    "name": part.full_name,
                    "units": part.units or "",
                    "thumbnail": part.get_thumbnail_url() if part.image else None,
                    "image": part.get_image_url() if part.image else None,
                    # un seul arrondi (en centimes) : prix affiche = prix facture
                    "unit_price": f"{cents / 100:.2f}" if cents > 0 else None,
                    "unit_cents": cents if cents > 0 else None,
                    # prix herite du modele (variante sans prix propre)
                    "price_inherited": cents > 0 and not own,
                    "buyable": cents > 0,
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
        """(prix unitaire EUR, propre au part ?) du palier de quantite 1, ou (None, False).

        Une variante sans prix propre herite de celui de son modele (une
        famille de jus vendue au meme prix n'a qu'un prix a saisir).
        """
        from part.models import PartSellPriceBreak

        p, seen = part, set()
        while p is not None and p.pk not in seen:
            seen.add(p.pk)
            pb = PartSellPriceBreak.objects.filter(part=p, quantity__lte=1).order_by("-quantity").first()
            if pb is not None and pb.price is not None:
                if str(pb.price.currency) != "EUR":
                    return None, False
                return Decimal(pb.price.amount), p.pk == part.pk
            p = p.variant_of
        return None, False

    @staticmethod
    def cents(price):
        """Decimal en euros -> entier en centimes (arrondi commercial)."""
        return int((price * 100).quantize(Decimal("1"), ROUND_HALF_UP))

    def set_price(self, part, price, user=None):
        """Prix de vente unitaire propre au part (palier 1, EUR) ; None = le retirer.

        Coche « Vendable » au passage (InvenTree n'accepte un prix de vente
        que sur un part vendable) et consigne le changement (PriceChange) :
        ancien prix effectif -> nouveau, par qui.
        """
        from part.models import Part, PartSellPriceBreak

        from .models import PriceChange

        old, _own = self.unit_price(part)
        with transaction.atomic():
            if not part.salable:
                Part.objects.filter(pk=part.pk).update(salable=True)
            pb = PartSellPriceBreak.objects.filter(part=part, quantity=1).first()
            if price is None:
                if pb:
                    pb.delete()
            elif pb:
                pb.price = price
                pb.price_currency = "EUR"
                pb.save()
            else:
                PartSellPriceBreak.objects.create(part=part, quantity=1, price=price, price_currency="EUR")
            new, _own = self.unit_price(part)
            if new != old:
                PriceChange.objects.create(
                    part=part,
                    part_name=part.full_name,
                    old_cents=self.cents(old) if old else None,
                    new_cents=self.cents(new) if new else None,
                    user=user,
                )

    @staticmethod
    def price_history(part, limit=8):
        """Derniers changements de prix d'un part : [{date, user, old, new}]."""
        from django.utils import timezone as tz

        from .models import PriceChange

        out = []
        for c in PriceChange.objects.filter(part=part).select_related("user")[:limit]:
            out.append({
                "date": tz.localtime(c.date).strftime("%d/%m/%Y %H:%M"),
                "user": (c.user.get_full_name() or c.user.username) if c.user else "—",
                "old_cents": c.old_cents,
                "new_cents": c.new_cents,
            })
        return out

    @staticmethod
    def last_additions(items, location):
        """Dernier ajout de chaque article du frigo : {item_pk: {"user", "date"}}.

        Lu dans l'historique InvenTree (StockItemTracking) : creation, ajout
        manuel, separation/fusion de lot, ou deplacement VERS le frigo.
        """
        from django.utils import timezone as tz

        from stock.models import StockItemTracking
        from stock.status_codes import StockHistoryCode as C

        fridge = set(location.get_descendants(include_self=True).values_list("pk", flat=True))
        adds = {C.CREATED.value, C.STOCK_ADD.value, C.SPLIT_FROM_PARENT.value, C.MERGED_STOCK_ITEMS.value,
                C.RETURNED_TO_STOCK.value, C.RECEIVED_AGAINST_PURCHASE_ORDER.value}
        out = {}
        qs = (
            StockItemTracking.objects.filter(item__in=items)
            .select_related("user")
            .order_by("item_id", "-date", "-pk")
        )
        for t in qs:
            if t.item_id in out:
                continue
            deltas = t.deltas or {}
            moved_in = t.tracking_type == C.STOCK_MOVE.value and deltas.get("location") in fridge
            if t.tracking_type in adds or moved_in:
                out[t.item_id] = {
                    "user": (t.user.get_full_name() or t.user.username) if t.user else "—",
                    "date": tz.localtime(t.date).strftime("%d/%m %H:%M"),
                }
        return out

    # ---- creation du checkout ----
    @staticmethod
    def site_url(request):
        """URL publique de l'instance (INVENTREE_SITE_URL, sinon l'hote de la requete)."""
        site = (getattr(django_settings, "SITE_URL", None) or "").rstrip("/")
        return site or request.build_absolute_uri("/").rstrip("/")

    def build_lines(self, data):
        """Valide le panier recu de la Scannette ; renvoie (location, lignes).

        {"lines": [{"part": pk, "quantity": n}, ...]}. Chaque ligne =
        dict(part, name, quantity, unit_cents). Prix et disponibilite sont
        TOUJOURS relus ici. Leve ValueError (message lisible).
        """
        from part.models import Part

        location = self.fridge_location()
        if location is None:
            raise ValueError("Le frigo n'est pas configuré.")
        raw = data.get("lines")
        if not isinstance(raw, list) or not raw or len(raw) > 30:
            raise ValueError("Panier vide ou invalide.")
        merged = {}
        for ln in raw:
            try:
                pk, q = int(ln["part"]), int(ln.get("quantity", 1))
            except (TypeError, ValueError, KeyError, AttributeError):
                raise ValueError("Panier invalide.")
            if q < 1:
                raise ValueError("Quantité invalide.")
            merged[pk] = merged.get(pk, 0) + q
        catalog = {p["part"]: p for p in self.fridge_catalog(location)}
        lines = []
        for pk, q in merged.items():
            p = catalog.get(pk)
            if p is None or not p["buyable"]:
                raise ValueError("Un article du panier n'est plus en vente dans le frigo.")
            if q > p["available"]:
                raise ValueError(f"{p['name']} : il n'en reste que {p['available']}.")
            lines.append({
                "part": Part.objects.get(pk=pk), "name": p["name"],
                "quantity": q, "unit_cents": p["unit_cents"],
            })
        return location, lines

    def start_checkout(self, request, data):
        """Cree le Purchase et ses lignes, puis le checkout SumUp ; renvoie (purchase, checkout_id)."""
        from .models import Purchase, PurchaseLine

        location, lines = self.build_lines(data)
        with transaction.atomic():
            purchase = Purchase.objects.create(
                location=location,
                user=request.user,
                amount_cents=sum(ln["quantity"] * ln["unit_cents"] for ln in lines),
            )
            PurchaseLine.objects.bulk_create([PurchaseLine(purchase=purchase, **ln) for ln in lines])
        site = self.site_url(request)
        try:
            res = self.sumup().create_checkout(
                # unique par compte marchand, meme si la base est restauree
                f"scannette-{purchase.pk}-{uuid.uuid4().hex[:10]}",
                purchase.amount_cents,
                # ce que voit SumUp (tableau de bord, releve) : le panier exact
                "Frigo · " + purchase.summary(240),
                return_url=f"{site}/plugin/paiements/webhook/sumup",
                # retour navigateur apres une etape 3-D Secure en pleine page
                redirect_url=f"{site}/scannette/?achat={purchase.pk}",
            )
        except SumUpError as e:
            logger.error("Paiements : création du checkout SumUp refusée : %s %s", e, e.body)
            purchase.delete()
            raise
        checkout_id = (res or {}).get("id")
        if not checkout_id:
            purchase.delete()
            raise SumUpError("Réponse SumUp sans identifiant de paiement")
        purchase.checkout_id = checkout_id
        purchase.save(update_fields=["checkout_id"])
        return purchase, checkout_id

    # ---- confirmation ----
    def confirm(self, purchase):
        """Verifie le paiement aupres de SumUp ; retire le stock une seule fois.

        Idempotent : appele au retour de l'utilisateur, a chaque webhook et a
        chaque relance de l'ecran de recu. Renvoie le Purchase a jour.
        """
        from .models import Purchase

        if purchase.status == Purchase.STATUS_PAID or not purchase.checkout_id:
            return purchase
        ref = self._sumup_paid(purchase)
        if ref is None:
            return purchase  # pas (encore) paye

        # retrait fait par le plugin pour le compte de l'acheteur (membre, ou
        # webhook anonyme) : passe le verrou du frigo
        with transaction.atomic(), guard.system_action():
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
        # statut SumUp brut, pour que l'ecran de recu distingue « refuse » de « en attente »
        p.sumup_status = data.get("status")
        if data.get("status") != "PAID":
            return None
        try:
            amount = Decimal(str(data.get("amount"))) * 100
        except (ArithmeticError, ValueError, TypeError):
            amount = Decimal(-1)
        if not amount.is_finite() or (
            int(amount.quantize(Decimal("1"), ROUND_HALF_UP)) != p.amount_cents
            or data.get("currency") != "EUR"
            or not str(data.get("checkout_reference", "")).startswith(f"scannette-{p.pk}-")
        ):
            logger.error("SumUp : checkout %s incohérent avec l'achat #%s : %s", p.checkout_id, p.pk, data)
            return None
        tx = data.get("transactions") or []
        return data.get("transaction_code") or (tx[0].get("transaction_code") if tx else "") or p.checkout_id

    def _remove_stock(self, p):
        """Preleve chaque ligne dans le frigo ; consigne les anomalies sans bloquer.

        Le paiement est acquis : un stock insuffisant (inventaire faux, autre
        achat simultane) ne l'annule pas, il est signale sur le recu et dans
        l'admin pour qu'un membre du bureau regularise.
        """
        notes = f"Achat frigo #{p.pk} (SumUp {p.payment_ref})"
        warnings = []
        for ln in p.lines.all():
            # articles verrouilles (select_for_update) : deux achats confirmes
            # en meme temps ne peuvent pas lire le meme stock et en perdre un retrait
            sources = (
                list(self.fridge_items(p.location, part=ln.part_id).select_for_update(of=("self",)))
                if ln.part_id and p.location_id
                else []
            )
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

    # ---- rattrapage ----
    def reconcile_pending(self):
        """Tache planifiee : confirme les achats en attente des dernieres 48 h.

        Cas vise : paiement abouti chez SumUp, mais l'acheteur a ferme l'appli
        avant la verification et le webhook n'est pas arrive. Sans cela, il
        serait debite sans retrait de stock ni recu.
        """
        import datetime

        from .models import Purchase

        if not self.is_configured():
            return
        since = timezone.now() - datetime.timedelta(hours=48)
        for p in Purchase.objects.filter(status=Purchase.STATUS_PENDING, created_at__gte=since).exclude(
            checkout_id=None
        ):
            try:
                self.confirm(p)
            except SumUpError as e:
                logger.warning("Paiements : rattrapage de l'achat #%s impossible : %s", p.pk, e)
