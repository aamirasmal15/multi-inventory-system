"""Endpoints du plugin pour la Scannette (+ webhooks SumUp / HelloAsso).

Les vues heritent de l'authentification DRF configuree par InvenTree
(token, session, basic) : le token de la Scannette passe tel quel.

Aucun import de modele au niveau du module : InvenTree appelle setup_urls
(qui importe ce fichier) a l'instanciation du plugin, AVANT d'ajouter son app
a INSTALLED_APPS ; un import de .models ici fait echouer le chargement
(« doesn't declare an explicit app_label »). D'ou les imports dans les vues.
"""

import logging

from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .core import PaymentError

logger = logging.getLogger("inventree")


class PluginView(APIView):
    """Base : porte l'instance du plugin (passee par as_view)."""

    plugin = None
    permission_classes = [IsAuthenticated]


def purchase_data(p):
    """Representation d'un achat pour l'ecran de resultat."""
    return {
        "pk": p.pk,
        "status": p.status,
        "item_name": p.item_name,
        "quantity": float(p.quantity),
        "amount": f"{p.amount_cents / 100:.2f}",
        "stock_item": p.stock_item_id,
        "stock_removed": p.stock_removed,
        "warning": p.warning,
    }


class ConfigView(PluginView):
    """La Scannette n'affiche le bouton Acheter que si enabled est vrai.

    test : paiements fictifs (badge « test » dans la Scannette). Pour SumUp,
    une cle de compte sandbox ne se distingue pas d'une vraie : pas de badge.
    """

    def get(self, request):
        provider = self.plugin.provider()
        gp_id = self.plugin.get_setting("GOOGLE_PAY_MERCHANT_ID") if provider == "sumup" else ""
        return Response({
            "enabled": self.plugin.is_configured(),
            "provider": provider,
            "test": provider == "helloasso" and self.plugin.get_setting("HELLOASSO_ENV") == "sandbox",
            # option googlePay du widget SumUp (identifiant public, pas un secret)
            "google_pay": {
                "merchantId": gp_id,
                "merchantName": self.plugin.get_setting("PAY_DISPLAY_NAME") or "Scannette",
            } if gp_id else None,
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
        return Response({"buyable": offer is not None, **(offer or {})})


class CheckoutView(PluginView):
    """Cree le paiement : checkout_id (SumUp, widget) ou redirect_url (HelloAsso)."""

    def post(self, request):
        from stock.models import StockItem

        if not self.plugin.is_configured():
            return Response({"detail": "Paiement non configuré."}, status=503)
        try:
            pk = int(request.data.get("stock_item"))
            qty = int(request.data.get("quantity", 1))
            item = StockItem.objects.select_related("part").get(pk=pk)
        except (TypeError, ValueError, StockItem.DoesNotExist):
            return Response({"detail": "Article introuvable."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            purchase, out = self.plugin.start_checkout(request, item, qty)
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        except PaymentError as e:
            return Response({"detail": f"Paiement impossible : {e}"}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({"purchase": purchase.pk, "provider": purchase.provider, **out})


class PurchaseView(PluginView):
    """Etat d'un achat ; verifie le paiement aupres du prestataire s'il est en attente."""

    def get(self, request, pk):
        from .models import Purchase

        try:
            p = Purchase.objects.get(pk=pk)
        except Purchase.DoesNotExist:
            return Response({"detail": "Achat introuvable."}, status=status.HTTP_404_NOT_FOUND)
        u = request.user
        if p.user_id != u.pk and not (u.is_staff or u.is_superuser):
            return Response({"detail": "Achat introuvable."}, status=status.HTTP_404_NOT_FOUND)
        try:
            p = self.plugin.confirm(p)
        except PaymentError as e:
            # verification impossible pour l'instant : l'etat connu reste affiche
            logger.warning("Paiements : vérification de l'achat #%s impossible : %s", p.pk, e)
        return Response(purchase_data(p))


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
