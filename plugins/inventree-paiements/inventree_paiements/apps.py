"""AppConfig du plugin (label : inventree_paiements) : modeles + mise en vente automatique.

Ranger un article dans le frigo = le mettre en vente : son part est coche
« Vendable » des qu'un article de stock arrive dans l'emplacement frigo (ou
un de ses sous-emplacements), quel que soit le chemin (Scannette, interface
InvenTree, API). Sans cette case, InvenTree refuse de lui donner un prix de
vente ; le prix lui-meme reste a saisir (mode « Gérer » du frigo).
"""

import logging

from django.apps import AppConfig

logger = logging.getLogger("inventree")


def mark_fridge_part_salable(sender, instance, **kwargs):
    """post_save StockItem : part rendu vendable s'il est range dans le frigo."""
    part = getattr(instance, "part", None)
    if part is None or part.salable or part.trackable or not instance.location_id:
        return
    try:
        from plugin import registry

        plugin = registry.get_plugin("paiements")
        fridge = plugin.fridge_location() if plugin else None
        if fridge is None:
            return
        if instance.location.get_ancestors(include_self=True).filter(pk=fridge.pk).exists():
            from part.models import Part

            Part.objects.filter(pk=part.pk).update(salable=True)
            part.salable = True
    except Exception:
        # jamais bloquer un mouvement de stock pour un confort de vente
        logger.exception("Paiements : mise en vente automatique du part #%s impossible", part.pk)


class InventreePaiementsConfig(AppConfig):
    """App Django du plugin : modeles Purchase / PurchaseLine + signal de mise en vente."""

    name = "inventree_paiements"

    def ready(self):
        """Branche le signal (dispatch_uid : une seule fois, meme si l'app est rechargee)."""
        from django.db.models.signals import post_save

        from stock.models import StockItem

        post_save.connect(
            mark_fridge_part_salable, sender=StockItem, dispatch_uid="paiements_fridge_salable"
        )
