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

from .sumup import SumUpError

logger = logging.getLogger("inventree")


def is_admin(user):
    """Staff ou superuser : mode « Gérer » du frigo (stocks, prix), tous les recus."""
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
            "enabled": self.plugin.is_configured(),
            # option googlePay du widget SumUp (identifiant public, pas un secret)
            "google_pay": {
                "merchantId": gp_id,
                "merchantName": self.plugin.get_setting("PAY_DISPLAY_NAME") or "Scannette",
            } if gp_id else None,
            # locations : le frigo et ses sous-emplacements (masques aux non-admins)
            "fridge": {
                "location": loc.pk,
                "name": loc.name,
                "locations": sorted(loc.get_descendants(include_self=True).values_list("pk", flat=True)),
            } if loc else None,
            "admin": is_admin(request.user),
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
        products = self.plugin.fridge_catalog(loc)
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
            "enabled": self.plugin.is_configured(),
            "products": products,
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
        if price is not None and (price < 0 or price > 1000):
            return Response({"detail": "Prix invalide."}, status=status.HTTP_400_BAD_REQUEST)
        self.plugin.set_price(part, price if price else None, user=request.user)
        return Response({"part": part.pk, "price": str(price) if price else None})


class CheckoutView(PluginView):
    """Cree le paiement SumUp du panier ; le widget de la Scannette l'execute."""

    def post(self, request):
        if not self.plugin.is_configured():
            return Response({"detail": "Paiement non configuré."}, status=503)
        data = request.data if isinstance(request.data, dict) else {}
        try:
            purchase, checkout_id = self.plugin.start_checkout(request, data)
        except ValueError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        except SumUpError as e:
            return Response({"detail": f"Paiement impossible : {e}"}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({
            "purchase": purchase.pk,
            "checkout_id": checkout_id,
            "total": purchase_data(purchase)["total"],
            "amount_cents": purchase.amount_cents,
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
    """Etat d'un achat ; verifie le paiement aupres de SumUp s'il est en attente."""

    def get(self, request, pk):
        p = self.get_purchase(request, pk)
        if p is None:
            return Response({"detail": "Achat introuvable."}, status=status.HTTP_404_NOT_FOUND)
        if self.plugin.is_configured():
            try:
                p = self.plugin.confirm(p)
            except SumUpError as e:
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
    """Notification SumUp ({"event_type": "CHECKOUT_STATUS_CHANGED", "id": "<checkout>"}).

    Le contenu n'est PAS cru sur parole : il sert seulement a retrouver
    l'achat, dont le paiement est ensuite verifie par relecture du checkout
    aupres de SumUp (confirm). Repond toujours 200 pour que SumUp ne rejoue
    pas indefiniment une notification qui ne nous concerne pas.
    """

    plugin = None
    permission_classes = [AllowAny]
    authentication_classes = []  # pas de session -> pas de controle CSRF

    def post(self, request):
        from .models import Purchase

        body = request.data if isinstance(request.data, dict) else {}
        p = Purchase.objects.filter(checkout_id=str(body["id"])).first() if body.get("id") else None
        if p is not None and self.plugin.is_configured():
            try:
                self.plugin.confirm(p)
            except SumUpError as e:
                logger.warning("Paiements : webhook, vérification de l'achat #%s impossible : %s", p.pk, e)
        return Response({"ok": True})
