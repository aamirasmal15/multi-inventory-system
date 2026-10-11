"""Endpoints du plugin pour la Scannette (+ webhook HelloAsso).

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

from .helloasso import HelloAssoError

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
    """La Scannette n'affiche le bouton Acheter que si enabled est vrai."""

    def get(self, request):
        return Response({
            "enabled": self.plugin.is_configured(),
            "env": self.plugin.get_setting("HELLOASSO_ENV"),
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
    """Cree le paiement et renvoie l'URL de la page HelloAsso."""

    def post(self, request):
        from stock.models import StockItem

        if not self.plugin.is_configured():
            return Response({"detail": "Paiement HelloAsso non configuré."}, status=503)
        try:
            pk = int(request.data.get("stock_item"))
            qty = int(request.data.get("quantity", 1))
            item = StockItem.objects.select_related("part").get(pk=pk)
        except (TypeError, ValueError, StockItem.DoesNotExist):
            return Response({"detail": "Article introuvable."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            purchase, url = self.plugin.start_checkout(request, item, qty)
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        except HelloAssoError as e:
            return Response({"detail": f"Paiement impossible : {e}"}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({"purchase": purchase.pk, "redirect_url": url})


class PurchaseView(PluginView):
    """Etat d'un achat ; verifie le paiement aupres de HelloAsso s'il est en attente."""

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
        except HelloAssoError as e:
            # verification impossible pour l'instant : l'etat connu reste affiche
            logger.warning("HelloAsso : vérification de l'achat #%s impossible : %s", p.pk, e)
        return Response(purchase_data(p))


class WebhookView(APIView):
    """Notification HelloAsso (Order / Payment).

    Le contenu n'est PAS cru sur parole : il sert seulement a retrouver
    l'achat, dont le paiement est ensuite verifie par relecture du checkout
    aupres de l'API (confirm). Repond toujours 200 pour que HelloAsso ne
    rejoue pas indefiniment une notification qui ne nous concerne pas.
    """

    plugin = None
    permission_classes = [AllowAny]
    authentication_classes = []  # pas de session -> pas de controle CSRF

    def post(self, request):
        from .models import Purchase

        body = request.data if isinstance(request.data, dict) else {}
        data = body.get("data") if isinstance(body.get("data"), dict) else {}
        meta = body.get("metadata") or data.get("metadata") or {}
        p = None
        try:
            if meta.get("purchase"):
                p = Purchase.objects.filter(pk=int(meta["purchase"])).first()
            if p is None and data.get("checkoutIntentId"):
                p = Purchase.objects.filter(checkout_intent_id=int(data["checkoutIntentId"])).first()
        except (TypeError, ValueError):
            p = None
        if p is not None and self.plugin.is_configured():
            try:
                self.plugin.confirm(p)
            except HelloAssoError as e:
                logger.warning("HelloAsso : webhook, vérification de l'achat #%s impossible : %s", p.pk, e)
        return Response({"ok": True})
