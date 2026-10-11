"""Endpoints du plugin pour la Scannette (+ webhooks SumUp / HelloAsso).

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

from .core import PaymentError

logger = logging.getLogger("inventree")


def is_admin(user):
    """Staff ou superuser : mode « Gérer » du frigo, tous les recus."""
    return bool(user and (user.is_staff or user.is_superuser))


class PluginView(APIView):
    """Base : porte l'instance du plugin (passee par as_view)."""

    plugin = None
    permission_classes = [IsAuthenticated]

    def get_purchase(self, request, pk):
        """Achat de l'utilisateur (ou n'importe lequel pour un admin), sinon None."""
        from .models import Purchase

        p = Purchase.objects.filter(pk=pk).select_related("user", "location").first()
        if p is None or (p.user_id != request.user.pk and not is_admin(request.user)):
            return None
        return p


def purchase_data(p):
    """Representation d'un achat pour l'ecran de recu de la Scannette."""
    from .receipt import receipt_context

    ctx = receipt_context(p)
    return {
        "pk": p.pk,
        "status": p.status,
        "source": p.source,
        "date": ctx["date"],
        "time": ctx["time"],
        "buyer": ctx["buyer"],
        "lines": ctx["lines"],
        "count": ctx["count"],
        "total": ctx["total"],
        "provider": ctx["provider"],
        "payment_ref": p.payment_ref,
        "stock_removed": p.stock_removed,
        "warning": p.warning,
        "receipt_sent_to": p.receipt_sent_to,
    }


class ConfigView(PluginView):
    """La Scannette n'affiche les achats que si enabled est vrai.

    test : paiements fictifs (badge « test »). Pour SumUp, une cle de compte
    sandbox ne se distingue pas d'une vraie : pas de badge.
    """

    def get(self, request):
        provider = self.plugin.provider()
        gp_id = self.plugin.get_setting("GOOGLE_PAY_MERCHANT_ID") if provider == "sumup" else ""
        loc = self.plugin.fridge_location()
        return Response({
            "enabled": self.plugin.is_configured(),
            "provider": provider,
            "test": provider == "helloasso" and self.plugin.get_setting("HELLOASSO_ENV") == "sandbox",
            # option googlePay du widget SumUp (identifiant public, pas un secret)
            "google_pay": {
                "merchantId": gp_id,
                "merchantName": self.plugin.get_setting("PAY_DISPLAY_NAME") or "Scannette",
            } if gp_id else None,
            "fridge": {"location": loc.pk, "name": loc.name} if loc else None,
            "admin": is_admin(request.user),
        })


class FridgeView(PluginView):
    """Catalogue du frigo : produits, prix, stock disponible.

    Un membre ne recoit que les produits vendables ; un admin recoit tout
    (produits sans prix compris, pour les reperer) avec le detail des
    articles de stock, que le mode « Gérer » corrige en direct.
    """

    def get(self, request):
        loc = self.plugin.fridge_location()
        if loc is None:
            return Response({"detail": "Le frigo n'est pas configuré."}, status=status.HTTP_404_NOT_FOUND)
        admin = is_admin(request.user)
        products = self.plugin.fridge_catalog(loc)
        if not admin:
            products = [p for p in products if p["buyable"]]
            for p in products:
                del p["items"]
        return Response({
            "location": loc.pk,
            "name": loc.name,
            "enabled": self.plugin.is_configured(),
            "products": products,
        })


class ItemView(PluginView):
    """Offre d'achat pour un article de stock ({'buyable': false} sinon)."""

    def get(self, request, pk):
        from stock.models import StockItem

        try:
            item = StockItem.objects.select_related("part").get(pk=pk)
        except StockItem.DoesNotExist:
            return Response({"detail": "Article introuvable."}, status=status.HTTP_404_NOT_FOUND)
        offer = self.plugin.offer(item) if self.plugin.is_configured() else None
        loc = self.plugin.fridge_location()
        in_fridge = bool(
            loc and item.location_id and item.location.get_ancestors(include_self=True).filter(pk=loc.pk).exists()
        )
        return Response({"buyable": offer is not None, "in_fridge": in_fridge, **(offer or {})})


class CheckoutView(PluginView):
    """Cree le paiement : checkout_id (SumUp, widget) ou redirect_url (HelloAsso)."""

    def post(self, request):
        if not self.plugin.is_configured():
            return Response({"detail": "Paiement non configuré."}, status=503)
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
            "total": purchase_data(purchase)["total"],
            **out,
        })


class PurchaseListView(PluginView):
    """« Mes achats » : les 30 derniers achats payes de l'utilisateur."""

    def get(self, request):
        from .models import Purchase

        qs = (
            Purchase.objects.filter(user=request.user, status=Purchase.STATUS_PAID)
            .select_related("user", "location")
            .prefetch_related("lines")[:30]
        )
        return Response([purchase_data(p) for p in qs])


class PurchaseView(PluginView):
    """Etat d'un achat ; verifie le paiement aupres du prestataire s'il est en attente."""

    def get(self, request, pk):
        p = self.get_purchase(request, pk)
        if p is None:
            return Response({"detail": "Achat introuvable."}, status=status.HTTP_404_NOT_FOUND)
        if self.plugin.is_configured(p.provider):
            try:
                p = self.plugin.confirm(p)
            except PaymentError as e:
                # verification impossible pour l'instant : l'etat connu reste affiche
                logger.warning("Paiements : vérification de l'achat #%s impossible : %s", p.pk, e)
        return Response(purchase_data(p))


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

        p = self.get_purchase(request, pk)
        if p is None or p.status != Purchase.STATUS_PAID:
            return Response({"detail": "Reçu introuvable."}, status=status.HTTP_404_NOT_FOUND)
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
    """Notification du prestataire (/webhook/sumup ou /webhook/helloasso).

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

        body = request.data if isinstance(request.data, dict) else {}
        p = None
        try:
            if provider == "sumup":
                # {"event_type": "CHECKOUT_STATUS_CHANGED", "id": "<checkout>"}
                if body.get("id"):
                    p = Purchase.objects.filter(provider="sumup", checkout_id=str(body["id"])).first()
            elif provider == "helloasso":
                data = body.get("data") if isinstance(body.get("data"), dict) else {}
                meta = body.get("metadata") or data.get("metadata") or {}
                if meta.get("purchase"):
                    p = Purchase.objects.filter(provider="helloasso", pk=int(meta["purchase"])).first()
                if p is None and data.get("checkoutIntentId"):
                    p = Purchase.objects.filter(
                        provider="helloasso", checkout_id=str(int(data["checkoutIntentId"]))
                    ).first()
        except (TypeError, ValueError):
            p = None
        if p is not None and self.plugin.is_configured(p.provider):
            try:
                self.plugin.confirm(p)
            except PaymentError as e:
                logger.warning("Paiements : webhook, vérification de l'achat #%s impossible : %s", p.pk, e)
        return Response({"ok": True})
