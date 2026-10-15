"""Endpoints du plugin pour la page frigo de la Scannette (+ webhook SumUp).

Les vues heritent de l'authentification DRF configuree par InvenTree
(token, session, basic) : le token de la Scannette passe tel quel.

Aucun import de modele au niveau du module : InvenTree appelle setup_urls
(qui importe ce fichier) a l'instanciation du plugin, AVANT d'ajouter son app
a INSTALLED_APPS ; un import de .models ici fait echouer le chargement
(« doesn't declare an explicit app_label »). D'ou les imports dans les vues.
"""

import logging

from django.http import HttpResponse
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .core import TOPUP_MAX_CENTS, TOPUP_MIN_CENTS, WALLET_MAX_CENTS, PaymentError

logger = logging.getLogger("inventree")


def instance_name():
    """Nom de l'instance InvenTree (receipt.py)."""
    from .receipt import instance_name as name

    return name()


def is_admin(user):
    """Staff ou superuser : mode « Gérer » du frigo (stocks, prix), tous les recus."""
    return bool(user and (user.is_staff or user.is_superuser))


class PluginView(APIView):
    """Base : porte l'instance du plugin (passee par as_view)."""

    plugin = None
    permission_classes = [IsAuthenticated]

    def get_purchase(self, request, pk):
        """Achat de l'utilisateur, ou qu'il a encaisse (Tap to Pay), ou n'importe lequel pour un admin ; sinon None."""
        from .models import Purchase

        p = Purchase.objects.filter(pk=pk).select_related("user", "location").first()
        if p is None:
            return None
        if p.user_id != request.user.pk and p.collected_by_id != request.user.pk and not is_admin(request.user):
            return None
        return p


def purchase_data(p):
    """Representation d'un achat pour l'ecran de recu de la Scannette."""
    from .receipt import receipt_context

    ctx = receipt_context(p)
    return {
        "pk": p.pk,
        "status": p.status,
        "kind": p.kind,
        "method": p.method,
        "channel": p.channel,
        "collected_by": (p.collected_by.get_full_name() or p.collected_by.username) if p.collected_by_id else "",
        # SumUp a refuse le paiement (banque, carte, compte marchand) : rien n'est debite.
        # Non stocke : le meme checkout peut encore aboutir sur un nouvel essai.
        "failed": p.status != "paid" and getattr(p, "sumup_status", None) in ("FAILED", "EXPIRED"),
        "date": ctx["date"],
        "time": ctx["time"],
        # instant du paiement (UTC, ISO) : « payé il y a 2 min » en direct sur le reçu
        "paid_at": p.paid_at.isoformat() if p.paid_at else None,
        "buyer": ctx["buyer"],
        "lines": ctx["lines"],
        "count": ctx["count"],
        "total": ctx["total"],
        "amount_cents": p.amount_cents,
        "provider": ctx["provider"],
        "payment_ref": p.payment_ref,
        "stock_removed": p.stock_removed,
        "warning": p.warning,
        "receipt_sent_to": p.receipt_sent_to,
        # envoi automatique du recu active ? sinon, bouton « Recevoir par e-mail »
        "receipt_auto": bool(_plugin_setting("SEND_RECEIPT")),
    }


def _plugin_setting(key):
    from .receipt import plugin_setting

    return plugin_setting(key)


class ConfigView(PluginView):
    """Ce que la Scannette doit savoir avant d'ouvrir le frigo."""

    def get(self, request):
        gp_id = self.plugin.get_setting("GOOGLE_PAY_MERCHANT_ID")
        loc = self.plugin.fridge_location()
        return Response({
            # frigo ouvert : achat possible au portefeuille meme sans carte configuree
            "enabled": loc is not None,
            # paiement par carte (achat direct, recharge) configure
            "card": self.plugin.is_configured(),
            # option googlePay du widget SumUp (identifiant public, pas un secret)
            "google_pay": {
                "merchantId": gp_id,
                # nom presente dans Google Pay : celui de l'instance (EIRSPACE...)
                "merchantName": instance_name() or "Scannette",
            } if gp_id else None,
            # locations : le frigo et ses sous-emplacements (masques aux non-admins)
            "fridge": {
                "location": loc.pk,
                "name": loc.name,
                "locations": sorted(loc.get_descendants(include_self=True).values_list("pk", flat=True)),
            } if loc else None,
            "admin": is_admin(request.user),
            # encaisser des recharges en Tap to Pay (admins)
            "can_tap": self.plugin.tap_ready() and self.plugin.can_collect(request.user),
            # sous ce montant, SumUp refuse la carte : portefeuille obligatoire
            "min_card_cents": self.plugin.min_card_cents(),
            "topup_min_cents": TOPUP_MIN_CENTS,
            "topup_max_cents": TOPUP_MAX_CENTS,
            # plafond du solde du portefeuille
            "wallet_max_cents": WALLET_MAX_CENTS,
        })


class FridgeView(PluginView):
    """Catalogue du frigo : produits, prix, stock disponible.

    Un membre ne recoit que les produits en vente ; un admin recoit tout
    (produits sans prix compris) avec le detail des articles de stock, que le
    mode « Gérer » corrige en direct.
    """

    def get(self, request):
        loc = self.plugin.fridge_location()
        if loc is None:
            return Response({"detail": "Le frigo n'est pas configuré."}, status=status.HTTP_404_NOT_FOUND)
        admin = is_admin(request.user)
        # admins (mode Gérer) : aussi les produits épuisés, pour les voir et les réapprovisionner
        products = self.plugin.fridge_catalog(loc, include_empty=admin)
        if not admin:
            products = [p for p in products if p["buyable"]]
            for p in products:
                del p["items"]
        else:
            # mode « Gérer » : qui a ajoute chaque article en dernier
            added = self.plugin.last_additions([i["pk"] for p in products for i in p["items"]], loc)
            for p in products:
                for i in p["items"]:
                    i["added"] = added.get(i["pk"])
        return Response({
            "location": loc.pk,
            "name": loc.name,
            "enabled": True,
            "card": self.plugin.is_configured(),
            "products": products,
            "wallet_cents": self.plugin.wallet_balance(request.user),
        })


class FridgePriceView(PluginView):
    """Admins : prix de vente d'un produit du frigo.

    GET ?part=<pk> : historique des changements de prix (journal PriceChange).
    POST {"part": pk, "price": "0,70"} : nouveau prix ; vide ou nul = retire de
    la vente. Seuls les produits presents dans le frigo sont modifiables ici.
    """

    def get(self, request):
        from part.models import Part

        if not is_admin(request.user):
            return Response({"detail": "Réservé aux admins."}, status=status.HTTP_403_FORBIDDEN)
        try:
            part = Part.objects.get(pk=int(request.query_params.get("part")))
        except (TypeError, ValueError, Part.DoesNotExist):
            return Response({"detail": "Article introuvable."}, status=status.HTTP_400_BAD_REQUEST)
        return Response(self.plugin.price_history(part))

    def post(self, request):
        from decimal import Decimal, InvalidOperation

        from part.models import Part

        if not is_admin(request.user):
            return Response({"detail": "Réservé aux admins."}, status=status.HTTP_403_FORBIDDEN)
        loc = self.plugin.fridge_location()
        try:
            part = Part.objects.get(pk=int(request.data.get("part")))
        except (TypeError, ValueError, Part.DoesNotExist):
            return Response({"detail": "Article introuvable."}, status=status.HTTP_400_BAD_REQUEST)
        if loc is None or not self.plugin.fridge_items(loc, part=part).exists():
            return Response({"detail": "Cet article n'est pas dans le frigo."}, status=status.HTTP_400_BAD_REQUEST)
        raw = str(request.data.get("price") or "").strip().replace(",", ".").replace("€", "").strip()
        try:
            price = Decimal(raw).quantize(Decimal("0.01")) if raw else None
        except InvalidOperation:
            return Response({"detail": "Prix invalide."}, status=status.HTTP_400_BAD_REQUEST)
        if price is not None and (not price.is_finite() or price < 0 or price > 1000):
            return Response({"detail": "Prix invalide."}, status=status.HTTP_400_BAD_REQUEST)
        self.plugin.set_price(part, price if price else None, user=request.user)
        return Response({"part": part.pk, "price": str(price) if price else None})


class CheckoutView(PluginView):
    """Cree le paiement SumUp du panier ; le widget de la Scannette l'execute."""

    def post(self, request):
        if not self.plugin.is_configured():
            return Response({"detail": "Paiement par carte non configuré."}, status=503)
        data = request.data if isinstance(request.data, dict) else {}
        try:
            purchase, out = self.plugin.start_checkout(request, data)
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        except PaymentError as e:
            return Response({"detail": f"Paiement impossible : {e}"}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({
            "purchase": purchase.pk,
            "provider": purchase.provider,
            **out,  # checkout_id
            "total": purchase_data(purchase)["total"],
            "amount_cents": purchase.amount_cents,
        })


def treso_queryset(request):
    """Achats payes de tous les membres, filtres ?user=<pk>&from=AAAA-MM-JJ&to=AAAA-MM-JJ (bornes incluses)."""
    import datetime

    from django.utils import timezone

    from .models import Purchase

    qs = Purchase.objects.filter(status=Purchase.STATUS_PAID).select_related("user", "location").prefetch_related("lines")
    q = request.query_params
    if q.get("user"):
        try:
            qs = qs.filter(user_id=int(q["user"]))
        except ValueError:
            pass
    for key, op in (("from", "gte"), ("to", "lt")):
        try:
            d = datetime.date.fromisoformat(q.get(key) or "")
        except ValueError:
            continue
        if key == "to":
            d += datetime.timedelta(days=1)
        start = timezone.make_aware(datetime.datetime.combine(d, datetime.time.min))
        qs = qs.filter(**{f"paid_at__{op}": start})
    return qs.order_by("-paid_at", "-pk")


class PurchaseListView(PluginView):
    """« Mes achats » : les 30 derniers achats payes de l'utilisateur.

    ?all=1 (admins, ecran Tresorerie) : ceux de tous les membres, filtres par
    membre et periode (treso_queryset), 300 au plus.
    """

    def get(self, request):
        from .models import Purchase

        if request.query_params.get("all"):
            if not is_admin(request.user):
                return Response({"detail": "Réservé aux admins."}, status=status.HTTP_403_FORBIDDEN)
            qs = treso_queryset(request)
            total = sum(qs.values_list("amount_cents", flat=True))
            return Response({"total_cents": total, "count": qs.count(), "purchases": [purchase_data(p) for p in qs[:300]]})
        qs = (
            Purchase.objects.filter(user=request.user, status=Purchase.STATUS_PAID)
            .select_related("user", "location")
            .prefetch_related("lines")[:30]
        )
        return Response([purchase_data(p) for p in qs])


class TresoExportView(PluginView):
    """Admins : export CSV (Excel FR : « ; », virgule decimale, UTF-8 BOM) des
    achats, recharges et corrections de solde d'une periode (memes filtres)."""

    def get(self, request):
        import csv
        import io

        from django.utils import timezone

        from .models import WalletEntry
        from .receipt import buyer_name

        if not is_admin(request.user):
            return Response({"detail": "Réservé aux admins."}, status=status.HTTP_403_FORBIDDEN)
        eur = lambda c: f"{c / 100:.2f}".replace(".", ",")
        rows = []
        for p in treso_queryset(request):
            topup = p.kind == p.KIND_TOPUP
            rows.append((
                p.paid_at,
                p.pk,
                buyer_name(p.user),
                p.user.username if p.user else "",
                "Recharge" if topup else "Achat",
                "Portefeuille" if p.method == p.METHOD_WALLET
                else "Tap to Pay (SumUp)" if p.channel == p.CHANNEL_TAP
                else f"Carte ({p.get_provider_display()})",
                ("Recharge du portefeuille" + (f", encaissée par {buyer_name(p.collected_by)}" if p.collected_by_id else ""))
                if topup else p.summary(500),
                eur(p.amount_cents),
                p.payment_ref,
                p.warning,
            ))
        # corrections des admins : pas d'achat associe, mais elles bougent les soldes
        adj = WalletEntry.objects.filter(kind=WalletEntry.KIND_ADJUST).select_related("wallet__user", "by")
        q = request.query_params
        if q.get("user"):
            try:
                adj = adj.filter(wallet__user_id=int(q["user"]))
            except ValueError:
                pass
        for e in adj:
            d = timezone.localdate(e.created_at).isoformat()
            if (q.get("from") and d < q["from"]) or (q.get("to") and d > q["to"]):
                continue
            u = e.wallet.user
            rows.append((
                e.created_at, "", buyer_name(u), u.username, "Correction", "Portefeuille",
                e.note + (f" (par {buyer_name(e.by)})" if e.by else ""), eur(e.amount_cents), "", "",
            ))
        rows.sort(key=lambda r: r[0], reverse=True)
        buf = io.StringIO()
        buf.write("\ufeff")
        w = csv.writer(buf, delimiter=";")
        w.writerow(["Date", "Heure", "N° achat", "Membre", "Identifiant", "Type", "Moyen", "Détail", "Montant (€)", "Réf. paiement", "Anomalie"])
        for r in rows:
            dt = timezone.localtime(r[0])
            w.writerow([dt.strftime("%d/%m/%Y"), dt.strftime("%H:%M"), *r[1:]])
        resp = HttpResponse(buf.getvalue(), content_type="text/csv; charset=utf-8")
        tag = "_".join(filter(None, [q.get("from"), q.get("to")])) or timezone.localdate().isoformat()
        resp["Content-Disposition"] = f'attachment; filename="tresorerie-frigo-{tag}.csv"'
        return resp


class PurchaseView(PluginView):
    """Etat d'un achat ; verifie le paiement aupres de SumUp s'il est en attente."""

    def get(self, request, pk):
        p = self.get_purchase(request, pk)
        if p is None:
            return Response({"detail": "Achat introuvable."}, status=status.HTTP_404_NOT_FOUND)
        if self.plugin.is_configured(p.provider):
            try:
                # Tap to Pay : code de transaction renvoye par l'appli SumUp (reverifie)
                p = self.plugin.confirm(p, tx_code=request.query_params.get("tx") or None)
            except PaymentError as e:
                # verification impossible pour l'instant : l'etat connu reste affiche
                logger.warning("Paiements : vérification de l'achat #%s impossible : %s", p.pk, e)
        data = purchase_data(p)
        # solde apres une recharge (ou un achat au portefeuille) : affiche sur le recu
        data["wallet_cents"] = self.plugin.wallet_balance(p.user) if p.user_id else 0
        return Response(data)


class ReceiptView(PluginView):
    """Recu PDF (telechargement depuis l'ecran de recu ou « Mes achats »)."""

    def get(self, request, pk):
        from .models import Purchase
        from .receipt import receipt_filename, render_pdf

        p = self.get_purchase(request, pk)
        if p is None or p.status != Purchase.STATUS_PAID:
            return Response({"detail": "Reçu introuvable."}, status=status.HTTP_404_NOT_FOUND)
        resp = HttpResponse(render_pdf(p), content_type="application/pdf")
        resp["Content-Disposition"] = f'attachment; filename="{receipt_filename(p)}"'
        return resp


class ReceiptEmailView(PluginView):
    """Renvoie le recu par e-mail a l'adresse principale de l'acheteur."""

    def post(self, request, pk):
        from .models import Purchase
        from .receipt import send_receipt_email

        from django.core.cache import cache

        p = self.get_purchase(request, pk)
        if p is None or p.status != Purchase.STATUS_PAID:
            return Response({"detail": "Reçu introuvable."}, status=status.HTTP_404_NOT_FOUND)
        # un envoi par minute et par achat (pas de rafale de mails)
        if not cache.add(f"paiements_mail:{p.pk}", 1, 60):
            return Response({"detail": "Reçu déjà envoyé, réessaie dans une minute."}, status=429)
        try:
            to = send_receipt_email(p)
        except Exception:
            logger.exception("Paiements : renvoi du reçu de l'achat #%s impossible", p.pk)
            to = ""
        if not to:
            return Response(
                {"detail": "Envoi impossible : pas d'adresse e-mail ou serveur d'e-mail non configuré."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        Purchase.objects.filter(pk=p.pk).update(receipt_sent_to=to)
        return Response({"sent_to": to})


class WebhookView(APIView):
    """Notification SumUp (/webhook/sumup) : {"event_type": "CHECKOUT_STATUS_CHANGED", "id": "<checkout>"}.

    Le contenu n'est PAS cru sur parole : il sert seulement a retrouver
    l'achat, dont le paiement est ensuite verifie par relecture du checkout
    aupres de l'API (confirm). Repond toujours 200 pour que le prestataire ne
    rejoue pas indefiniment une notification qui ne nous concerne pas.
    """

    plugin = None
    permission_classes = [AllowAny]
    authentication_classes = []  # pas de session -> pas de controle CSRF

    def post(self, request, provider):
        from .models import Purchase

        from django.core.cache import cache

        body = request.data if isinstance(request.data, dict) else {}
        p = None
        if provider == "sumup" and body.get("id"):
            p = Purchase.objects.filter(provider="sumup", checkout_id=str(body["id"])).first()
        # une relecture SumUp toutes les 10 s au plus par achat : le webhook est
        # anonyme, il ne doit pas pouvoir marteler l'API SumUp
        if p is not None and not cache.add(f"paiements_hook:{p.pk}", 1, 10):
            p = None
        if p is not None and self.plugin.is_configured(p.provider):
            try:
                self.plugin.confirm(p)
            except PaymentError as e:
                logger.warning("Paiements : webhook, vérification de l'achat #%s impossible : %s", p.pk, e)
        return Response({"ok": True})


class WalletView(PluginView):
    """Portefeuille du membre : solde et derniers mouvements."""

    def get(self, request):
        return Response(self.plugin.wallet_data(request.user))


class WalletTopupView(PluginView):
    """Recharge par carte : cree le checkout SumUp ({"amount_cents": 500}), execute par le widget."""

    def post(self, request):
        if not self.plugin.is_configured():
            return Response({"detail": "Paiement par carte non configuré."}, status=503)
        data = request.data if isinstance(request.data, dict) else {}
        try:
            purchase, out = self.plugin.start_topup(request, data.get("amount_cents"))
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        except PaymentError as e:
            return Response({"detail": f"Paiement impossible : {e}"}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({
            "purchase": purchase.pk,
            "provider": purchase.provider,
            **out,  # checkout_id
            "total": purchase_data(purchase)["total"],
            "amount_cents": purchase.amount_cents,
        })


class WalletPayView(PluginView):
    """Paie le panier avec le portefeuille ({"lines": [...]}, comme /checkout) ; immediat."""

    def post(self, request):
        data = request.data if isinstance(request.data, dict) else {}
        try:
            p = self.plugin.pay_with_wallet(request, data)
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"purchase": p.pk, "wallet_cents": self.plugin.wallet_balance(request.user)})


class WalletAdminView(PluginView):
    """Admins : soldes de tous les membres (GET) ; correction d'un solde (POST).

    POST {"user": pk, "amount_cents": -250, "note": "Remboursé en espèces"} :
    jamais sous zero. Chaque correction est journalisee (auteur, note).
    """

    def get(self, request):
        from .models import Wallet
        from .receipt import buyer_name

        if not is_admin(request.user):
            return Response({"detail": "Réservé aux admins."}, status=status.HTTP_403_FORBIDDEN)
        from django.contrib.auth import get_user_model

        # un membre precis : solde + derniers mouvements (fenetre de correction)
        if request.query_params.get("user"):
            try:
                user = get_user_model().objects.get(pk=int(request.query_params["user"]))
            except (TypeError, ValueError, get_user_model().DoesNotExist):
                return Response({"detail": "Membre introuvable."}, status=status.HTTP_404_NOT_FOUND)
            data = self.plugin.wallet_data(user, limit=50)
            data.update({"user": user.pk, "username": user.username, "name": buyer_name(user)})
            return Response(data)
        # tous les membres actifs, avec ou sans portefeuille (crediter un nouveau
        # membre qui paie en especes) ; plus gros soldes d'abord
        bal = dict(Wallet.objects.values_list("user_id", "balance_cents"))
        # compte technique (superuser) masque, sauf s'il a un solde (anomalie a voir)
        users = [
            u for u in get_user_model().objects.filter(is_active=True)
            if not u.is_superuser or bal.get(u.pk, 0)
        ]
        rows = [
            {"user": u.pk, "username": u.username, "name": buyer_name(u), "balance_cents": bal.get(u.pk, 0)}
            for u in users
        ]
        rows.sort(key=lambda r: (-r["balance_cents"], r["name"].lower()))
        return Response({
            "total_cents": sum(bal.values()),
            "count": sum(1 for v in bal.values() if v > 0),
            "members": rows,
        })

    def post(self, request):
        from django.contrib.auth import get_user_model

        if not is_admin(request.user):
            return Response({"detail": "Réservé aux admins."}, status=status.HTTP_403_FORBIDDEN)
        data = request.data if isinstance(request.data, dict) else {}
        try:
            user = get_user_model().objects.get(pk=int(data.get("user")))
            amount = int(data.get("amount_cents"))
        except (TypeError, ValueError, get_user_model().DoesNotExist):
            return Response({"detail": "Membre ou montant invalide."}, status=status.HTTP_400_BAD_REQUEST)
        note = str(data.get("note") or "").strip()
        if not amount or abs(amount) > 100000 or not note:
            return Response({"detail": "Montant non nul et note obligatoires."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            w = self.plugin.adjust_wallet(user, amount, note, request.user)
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"user": user.pk, "balance_cents": w.balance_cents})


class TapMembersView(PluginView):
    """Admins : membres actifs a qui encaisser une recharge (nom, identifiant ; pas de solde)."""

    def get(self, request):
        from django.contrib.auth import get_user_model

        from .receipt import buyer_name

        if not self.plugin.can_collect(request.user):
            return Response({"detail": "Réservé aux admins."}, status=status.HTTP_403_FORBIDDEN)
        # le superuser est le compte technique de l'instance (superadmin_<asso>) :
        # personne ne recharge son portefeuille
        rows = [
            {"user": u.pk, "username": u.username, "name": buyer_name(u)}
            for u in get_user_model().objects.filter(is_active=True, is_superuser=False)
        ]
        rows.sort(key=lambda r: r["name"].lower())
        return Response(rows)


class TapStartView(PluginView):
    """Admins : recharge d'un membre en Tap to Pay ({"user": pk, "amount_cents": 500}).

    Renvoie le lien sumupmerchant:// qui ouvre l'appli SumUp ; au retour
    (?achat=<pk>), le recu relit la transaction chez SumUp et credite le portefeuille.
    """

    def post(self, request):
        from django.contrib.auth import get_user_model

        if not self.plugin.can_collect(request.user):
            return Response({"detail": "Réservé aux admins."}, status=status.HTTP_403_FORBIDDEN)
        if not self.plugin.tap_ready():
            return Response({"detail": "Tap to Pay non configuré (clé affiliate SumUp)."}, status=503)
        data = request.data if isinstance(request.data, dict) else {}
        try:
            member = get_user_model().objects.get(pk=int(data.get("user")), is_active=True, is_superuser=False)
        except (TypeError, ValueError, get_user_model().DoesNotExist):
            return Response({"detail": "Membre introuvable."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            p, url = self.plugin.start_tap(request, member, data.get("amount_cents"))
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"purchase": p.pk, "url": url, "total": purchase_data(p)["total"]})
