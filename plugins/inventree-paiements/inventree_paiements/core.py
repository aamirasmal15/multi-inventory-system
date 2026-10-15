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

Portefeuille : SumUp refuse tout paiement par carte sous 1 €, or une canette
coute moins. Chaque membre recharge donc son portefeuille par carte (1 € au
moins) puis ses achats en sont deduits, a n'importe quel prix. Le solde ne
passe jamais sous zero (ligne verrouillee, verification avant debit). Le
paiement direct par carte reste possible pour un panier d'1 € ou plus.
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
MIN_CARD_CENTS = 100  # SumUp refuse (FAILED) tout paiement par carte sous 1 €
TOPUP_MIN_CENTS = 100  # recharge minimale, quel que soit le prestataire
PaymentError = (SumUpError,)
# plafond du portefeuille : le solde ne depasse jamais 100 € (securite ; une
# recharge est refusee au-dela, recharges en cours comprises)
WALLET_MAX_CENTS = 10000
TOPUP_MAX_CENTS = WALLET_MAX_CENTS


def euros(cents):
    """1234 -> « 12,34 € »."""
    return f"{cents / 100:.2f}".replace(".", ",") + " €"


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
        "SUMUP_AFFILIATE_KEY": {
            "name": "Tap to Pay : clé affiliate SumUp",
            "description": "me.sumup.com > Développeurs > Affiliate keys. Active l'encaissement des recharges par l'appli SumUp (Tap to Pay).",
            "default": "",
            "protected": True,
        },
        "SUMUP_APP_ID": {
            "name": "Tap to Pay : identifiant d'application",
            "description": "Application ID associé à la clé affiliate (facultatif selon SumUp)",
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
            path("wallet", api.WalletView.as_view(plugin=self), name="wallet"),
            path("wallet/topup", api.WalletTopupView.as_view(plugin=self), name="wallet-topup"),
            path("wallet/pay", api.WalletPayView.as_view(plugin=self), name="wallet-pay"),
            path("wallet/admin", api.WalletAdminView.as_view(plugin=self), name="wallet-admin"),
            path("treso/export.csv", api.TresoExportView.as_view(plugin=self), name="treso-export"),
            path("tap/members", api.TapMembersView.as_view(plugin=self), name="tap-members"),
            path("tap/start", api.TapStartView.as_view(plugin=self), name="tap-start"),
            path("purchase/<int:pk>", api.PurchaseView.as_view(plugin=self), name="purchase"),
            path("purchase/<int:pk>/receipt.pdf", api.ReceiptView.as_view(plugin=self), name="receipt"),
            path("purchase/<int:pk>/email", api.ReceiptEmailView.as_view(plugin=self), name="receipt-email"),
            # /webhook/sumup : return_url des checkouts SumUp
            path("webhook/<str:provider>", hook_view, name="webhook"),
        ]

    # ---- verrou du frigo (ValidationMixin, cf. guard.py) ----
    def validate_model_instance(self, instance, deltas=None):
        """Sauvegarde d'un article / emplacement du frigo : admins seulement."""
        guard.check_instance(instance)

    def validate_model_deletion(self, instance):
        """Suppression d'un article / emplacement du frigo : admins seulement."""
        guard.check_deletion(instance)

    # ---- configuration ----
    def is_configured(self, provider=None):
        """Cle API et code marchand SumUp renseignes (provider : historique, SumUp seul)."""
        if provider not in (None, "sumup"):
            return False
        return bool(self.get_setting("SUMUP_API_KEY") and self.get_setting("SUMUP_MERCHANT_CODE"))

    @staticmethod
    def min_card_cents():
        """Montant minimal d'un paiement par carte (SumUp : 1 €)."""
        return MIN_CARD_CENTS

    @staticmethod
    def can_collect(user):
        """Peut encaisser une recharge en Tap to Pay : admins seulement."""
        return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))

    def tap_ready(self):
        """Tap to Pay utilisable : compte SumUp et cle affiliate renseignes."""
        return self.is_configured("sumup") and bool(self.get_setting("SUMUP_AFFILIATE_KEY"))

    def start_tap(self, request, member, amount_cents):
        """Recharge encaissee par un admin : Purchase en attente + lien vers l'appli SumUp.

        La reference (foreign-tx-id) est gardee dans checkout_id : le paiement
        est ensuite retrouve et verifie chez SumUp par cette reference, jamais
        cru sur la seule foi du retour de l'appli.
        """
        from urllib.parse import urlencode

        from .models import Purchase

        amount = self.check_topup(member, amount_cents)
        p = Purchase.objects.create(
            location=None,
            user=member,
            amount_cents=amount,
            kind=Purchase.KIND_TOPUP,
            provider="sumup",
            channel=Purchase.CHANNEL_TAP,
            collected_by=request.user,
        )
        p.checkout_id = f"scannette-tap-{p.pk}-{uuid.uuid4().hex[:10]}"
        p.save(update_fields=["checkout_id"])
        back = f"{self.site_url(request)}/scannette/?achat={p.pk}"
        name = (member.get_full_name() or member.username)[:60]
        params = {
            "affiliate-key": self.get_setting("SUMUP_AFFILIATE_KEY"),
            # « total » (appli recente) et « amount » (anciennes versions, iOS)
            "total": f"{amount / 100:.2f}",
            "amount": f"{amount / 100:.2f}",
            "currency": "EUR",
            "title": f"Recharge portefeuille · {name}",
            "foreign-tx-id": p.checkout_id,
            # Android : callback ; iOS : callbacksuccess / callbackfail
            "callback": back,
            "callbacksuccess": back,
            "callbackfail": back,
        }
        if self.get_setting("SUMUP_APP_ID"):
            params["app-id"] = self.get_setting("SUMUP_APP_ID")
        return p, "sumupmerchant://pay/1.0?" + urlencode(params)

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
    def fridge_items(location, part=None, include_empty=False):
        """Articles de stock disponibles dans le frigo (sous-emplacements compris),
        les plus anciens d'abord : c'est l'ordre de prelevement.

        include_empty : aussi les articles tombes a 0 (gardes par InvenTree quand
        « supprimer a epuisement » est decoche), pour le mode Gerer."""
        from django.db.models import F, Q

        from stock.models import StockItem
        from stock.status_codes import StockStatusGroups

        if include_empty:
            # mêmes conditions qu'IN_STOCK_FILTER, sans « quantité > 0 »
            avail = Q(
                sales_order=None,
                belongs_to=None,
                customer=None,
                consumed_by=None,
                is_building=False,
                status__in=StockStatusGroups.AVAILABLE_CODES,
            )
        else:
            avail = StockItem.IN_STOCK_FILTER
        qs = StockItem.objects.filter(avail).filter(location__in=location.get_descendants(include_self=True))
        if part is not None:
            qs = qs.filter(part=part)
        return qs.select_related("part").order_by(F("expiry_date").asc(nulls_last=True), "pk")

    def fridge_catalog(self, location, include_empty=False):
        """Produits du frigo, un par part : stock cumule, prix, en vente ou non.

        En vente = actif, non trackable (objets pretes) et avec un prix.
        """
        products = {}
        for it in self.fridge_items(location, include_empty=include_empty):
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
        total = sum(ln["quantity"] * ln["unit_cents"] for ln in lines)
        if total < self.min_card_cents():
            raise ValueError(
                f"Paiement par carte : {euros(self.min_card_cents())} minimum. Paie avec ton portefeuille ou ajoute un article."
            )
        with transaction.atomic():
            purchase = Purchase.objects.create(
                location=location, user=request.user, amount_cents=total
            )
            PurchaseLine.objects.bulk_create([PurchaseLine(purchase=purchase, **ln) for ln in lines])
        return purchase, self._open_checkout(request, purchase)

    def topup_room(self, user):
        """Ce qu'on peut encore recharger sans depasser le plafond du portefeuille.

        Les recharges en attente des 20 dernieres minutes comptent deja : deux
        recharges lancees en meme temps ne passent pas au-dessus du plafond.
        """
        import datetime

        from .models import Purchase

        pending = sum(
            Purchase.objects.filter(
                user=user,
                kind=Purchase.KIND_TOPUP,
                status=Purchase.STATUS_PENDING,
                created_at__gte=timezone.now() - datetime.timedelta(minutes=20),
            ).values_list("amount_cents", flat=True)
        )
        return max(0, WALLET_MAX_CENTS - self.wallet_balance(user) - pending)

    def check_topup(self, user, amount_cents):
        """Montant de recharge valide (centimes) ou ValueError lisible."""
        try:
            amount = int(amount_cents)
        except (TypeError, ValueError):
            raise ValueError("Montant invalide.")
        if amount < TOPUP_MIN_CENTS:
            raise ValueError(f"Recharge de {euros(TOPUP_MIN_CENTS)} minimum.")
        room = self.topup_room(user)
        if amount > room:
            raise ValueError(
                f"Le portefeuille est plafonné à {euros(WALLET_MAX_CENTS)} : "
                + (f"{euros(room)} maximum pour cette recharge." if room >= TOPUP_MIN_CENTS else "il est déjà plein.")
            )
        return amount

    def start_topup(self, request, amount_cents):
        """Recharge du portefeuille : Purchase sans ligne + checkout SumUp ; renvoie (purchase, checkout_id)."""
        from .models import Purchase

        amount = self.check_topup(request.user, amount_cents)
        purchase = Purchase.objects.create(
            location=None, user=request.user, amount_cents=amount, kind=Purchase.KIND_TOPUP
        )
        return purchase, self._open_checkout(request, purchase)

    @staticmethod
    def _sumup_label(purchase):
        """Description vue dans le tableau de bord SumUp, toujours avec le membre :
        « Frigo · <membre> · <panier exact> » ou « Recharge portefeuille · <membre> »
        (meme libelle qu'en Tap to Pay)."""
        u = purchase.user
        name = (u.get_full_name() or u.username)[:60] if u else ""
        who = f" · {name}" if name else ""
        if purchase.kind == purchase.KIND_TOPUP:
            return "Recharge portefeuille" + who
        return "Frigo" + who + " · " + purchase.summary(180)

    def _open_checkout(self, request, purchase):
        """Checkout SumUp d'un Purchase deja cree (le widget de la Scannette l'execute) ;
        le supprime en cas d'echec. Renvoie {"checkout_id"}.
        """
        site = self.site_url(request)
        try:
            res = self.sumup().create_checkout(
                # unique par compte marchand, meme si la base est restauree
                f"scannette-{purchase.pk}-{uuid.uuid4().hex[:10]}",
                purchase.amount_cents,
                # ce que voit SumUp (tableau de bord, releve) : le panier exact
                self._sumup_label(purchase),
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
        return {"checkout_id": checkout_id}

    # ---- confirmation ----
    def confirm(self, purchase, tx_code=None):
        """Verifie le paiement aupres de SumUp ; retire le stock une seule fois.

        Idempotent : appele au retour de l'utilisateur, a chaque webhook et a
        chaque relance de l'ecran de recu. tx_code : code de transaction
        renvoye par l'appli SumUp (Tap to Pay), toujours reverifie chez SumUp.
        Renvoie le Purchase a jour.
        """
        from .models import Purchase

        if purchase.status == Purchase.STATUS_PAID or not purchase.checkout_id:
            return purchase
        if purchase.channel == Purchase.CHANNEL_TAP:
            ref = self._tap_paid(purchase, tx_code)
        else:
            ref = self._sumup_paid(purchase)
        if ref is None:
            return purchase  # pas (encore) paye

        # retrait fait par le plugin pour le compte de l'acheteur (membre, ou
        # webhook anonyme) : passe le verrou du frigo
        with transaction.atomic(), guard.system_action():
            p = Purchase.objects.select_for_update().get(pk=purchase.pk)
            if p.status == Purchase.STATUS_PAID:
                return p
            # une transaction SumUp ne paie qu'un seul achat (Tap to Pay : rapprochement)
            if Purchase.objects.filter(payment_ref=str(ref)[:64]).exclude(pk=p.pk).exists():
                logger.error("SumUp : transaction %s déjà rattachée à un autre achat (#%s)", ref, p.pk)
                return p
            p.status = Purchase.STATUS_PAID
            p.paid_at = timezone.now()
            p.payment_ref = str(ref)[:64]
            if p.kind == Purchase.KIND_TOPUP:
                note = ""
                if p.channel == Purchase.CHANNEL_TAP and p.collected_by:
                    by = p.collected_by.get_full_name() or p.collected_by.username
                    note = f"Recharge Tap to Pay, encaissée par {by}"
                self._wallet_move(p.user, p.amount_cents, "topup", purchase=p, note=note)
                p.stock_removed = True  # rien a retirer
            else:
                self._remove_stock(p)
            p.save()
            if self.get_setting("SEND_RECEIPT"):
                # apres commit : le worker relit un achat deja marque paye
                transaction.on_commit(lambda: self.queue_receipt(p.pk))
        return p

    # ---- portefeuille ----
    @staticmethod
    def _wallet_locked(user):
        """Portefeuille du membre, cree au besoin, VERROUILLE (a appeler dans une transaction)."""
        from .models import Wallet

        from django.db import IntegrityError

        if not Wallet.objects.filter(user=user).exists():
            try:
                # savepoint : une creation concurrente (meme membre, deux onglets)
                # ne doit pas casser la transaction appelante
                with transaction.atomic():
                    Wallet.objects.create(user=user)
            except IntegrityError:
                pass
        return Wallet.objects.select_for_update().get(user=user)

    def _wallet_move(self, user, amount_cents, kind, purchase=None, note="", by=None):
        """Credite (+) ou debite (−) le portefeuille ; leve ValueError si le solde passerait sous zero.

        A appeler dans une transaction : la ligne reste verrouillee jusqu'au commit.
        """
        from .models import WalletEntry

        w = self._wallet_locked(user)
        new = w.balance_cents + int(amount_cents)
        # correction d'un admin : jamais au-dessus du plafond (une recharge deja
        # payee, elle, est toujours creditee : le plafond est verifie a sa creation)
        if kind == "adjust" and amount_cents > 0 and new > WALLET_MAX_CENTS:
            raise ValueError(f"Le portefeuille est plafonné à {euros(WALLET_MAX_CENTS)}.")
        if new < 0:
            raise ValueError(
                f"Solde insuffisant : {euros(w.balance_cents)} sur ton portefeuille. Recharge-le pour continuer."
            )
        w.balance_cents = new
        w.save(update_fields=["balance_cents", "updated_at"])
        WalletEntry.objects.create(
            wallet=w, kind=kind, amount_cents=int(amount_cents), balance_after=new, purchase=purchase, note=note, by=by
        )
        return w

    @staticmethod
    def wallet_balance(user):
        """Solde en centimes (0 sans portefeuille)."""
        from .models import Wallet

        w = Wallet.objects.filter(user=user).only("balance_cents").first()
        return w.balance_cents if w else 0

    def pay_with_wallet(self, request, data):
        """Paie le panier avec le portefeuille : debit et retrait du stock dans la meme transaction.

        Rien n'est cree si le solde ne suffit pas (ValueError). Renvoie le Purchase paye.
        """
        from .models import Purchase, PurchaseLine

        location, lines = self.build_lines(data)
        total = sum(ln["quantity"] * ln["unit_cents"] for ln in lines)
        with transaction.atomic(), guard.system_action():
            p = Purchase.objects.create(
                location=location,
                user=request.user,
                amount_cents=total,
                method=Purchase.METHOD_WALLET,
                status=Purchase.STATUS_PAID,
                paid_at=timezone.now(),
            )
            PurchaseLine.objects.bulk_create([PurchaseLine(purchase=p, **ln) for ln in lines])
            # debit d'abord : solde insuffisant -> ValueError -> tout est annule (rollback)
            self._wallet_move(request.user, -total, "purchase", purchase=p)
            self._remove_stock(p)
            p.save()
            if self.get_setting("SEND_RECEIPT"):
                transaction.on_commit(lambda: self.queue_receipt(p.pk))
        return p

    def adjust_wallet(self, user, amount_cents, note, by):
        """Correction d'un admin (remboursement, credit en especes...) ; jamais sous zero."""
        with transaction.atomic():
            return self._wallet_move(user, amount_cents, "adjust", note=note[:250], by=by)

    def wallet_data(self, user, limit=20):
        """Solde et derniers mouvements, pour la Scannette."""
        from django.utils import timezone as tz

        from .models import Wallet, WalletEntry

        w = Wallet.objects.filter(user=user).first()
        entries = []
        if w is not None:
            for e in WalletEntry.objects.filter(wallet=w).select_related("purchase", "by")[:limit]:
                entries.append({
                    "date": tz.localtime(e.created_at).strftime("%d/%m/%Y %H:%M"),
                    "kind": e.kind,
                    "amount_cents": e.amount_cents,
                    "balance_after": e.balance_after,
                    "purchase": e.purchase_id,
                    "label": e.note or (e.purchase.summary(80) if e.purchase else ""),
                    "by": (e.by.get_full_name() or e.by.username) if e.by else "",
                })
        bal = w.balance_cents if w else 0
        return {"balance_cents": bal, "balance": euros(bal), "entries": entries}

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

    # fenetre ou chercher l'encaissement d'une recharge Tap to Pay apres sa creation
    TAP_WINDOW = (-60, 30 * 60)  # secondes

    def _tap_paid(self, p, tx_code=None):
        """Code de transaction si l'appli SumUp a encaisse la recharge (Tap to Pay), sinon None.

        L'appli SumUp, ouverte depuis une page web, ne garde pas notre
        reference (foreign-tx-id) sur la transaction. On la retrouve donc :
        1. par notre reference, au cas ou elle serait gardee ;
        2. par le code de transaction renvoye par l'appli au retour (smp-tx-code) ;
        3. a defaut (code absent, rattrapage planifie) : LA transaction reussie
           du meme montant encaissee juste apres la creation de la recharge,
           seulement si elle est unique et pas deja rattachee a un autre achat.
        Toujours verifie : statut, montant, devise, heure.
        """
        import datetime

        from .models import Purchase

        client = self.sumup()
        data = client.find_transaction(p.checkout_id)
        if isinstance(data, list):
            data = data[0] if data else None
        if not data and tx_code:
            data = client.get_transaction(str(tx_code)[:64])
        if not data:
            start = p.created_at + datetime.timedelta(seconds=self.TAP_WINDOW[0])
            end = p.created_at + datetime.timedelta(seconds=self.TAP_WINDOW[1])
            used = set(Purchase.objects.exclude(pk=p.pk).exclude(payment_ref="").values_list("payment_ref", flat=True))
            matches = [
                t for t in client.transactions_between(start, min(end, timezone.now()))
                if t.get("status") == "SUCCESSFUL"
                and self._cents_of(t) == p.amount_cents
                and t.get("transaction_code") not in used
            ]
            if len(matches) != 1:
                if len(matches) > 1:
                    logger.warning("Tap to Pay : %s transactions possibles pour la recharge #%s, rapprochement manuel", len(matches), p.pk)
                return None
            data = matches[0]
        if data.get("status") != "SUCCESSFUL":
            return None
        if self._cents_of(data) != p.amount_cents or data.get("currency", "EUR") != "EUR":
            logger.error("SumUp : transaction Tap to Pay incohérente avec l'achat #%s : %s", p.pk, data)
            return None
        # un vieux code de transaction ne peut pas payer une nouvelle recharge
        ts = data.get("timestamp")
        if ts:
            try:
                when = datetime.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            except ValueError:
                when = None
            if when and not (
                p.created_at + datetime.timedelta(seconds=self.TAP_WINDOW[0])
                <= when
                <= p.created_at + datetime.timedelta(seconds=self.TAP_WINDOW[1])
            ):
                logger.error("SumUp : transaction %s hors de la fenêtre de la recharge #%s", data.get("transaction_code"), p.pk)
                return None
        return data.get("transaction_code") or p.checkout_id

    @staticmethod
    def _cents_of(t):
        """Montant d'une transaction SumUp en centimes (-1 si illisible)."""
        try:
            amount = Decimal(str(t.get("amount"))) * 100
            return int(amount.quantize(Decimal("1"), ROUND_HALF_UP)) if amount.is_finite() else -1
        except (ArithmeticError, ValueError, TypeError):
            return -1

    def _remove_stock(self, p):
        """Preleve chaque ligne dans le frigo ; consigne les anomalies sans bloquer.

        Le paiement est acquis : un stock insuffisant (inventaire faux, autre
        achat simultane) ne l'annule pas, il est signale sur le recu et dans
        l'admin pour qu'un membre du bureau regularise.
        """
        notes = f"Achat frigo #{p.pk} (" + (
            "portefeuille" if p.method == p.METHOD_WALLET else f"{p.get_provider_display()} {p.payment_ref}"
        ) + ")"
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

        since = timezone.now() - datetime.timedelta(hours=48)
        for p in Purchase.objects.filter(status=Purchase.STATUS_PENDING, created_at__gte=since).exclude(
            checkout_id=None
        ):
            # chaque achat est relu chez SON prestataire, meme si le reglage a change depuis
            if not self.is_configured(p.provider):
                continue
            try:
                self.confirm(p)
            except PaymentError as e:
                logger.warning("Paiements : rattrapage de l'achat #%s impossible : %s", p.pk, e)
