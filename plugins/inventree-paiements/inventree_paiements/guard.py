"""Verrou du frigo : seuls les admins modifient ce qu'il contient, partout.

Branche sur deux mecanismes d'InvenTree :
- ValidationMixin (core.py) : appele a CHAQUE sauvegarde / suppression d'un
  article de stock ou d'un emplacement, quel que soit le chemin (interface
  web, API, Scannette) ; une ValidationError refuse l'operation (400) ;
- signaux pre_save / pre_delete (apps.py) pour les prix de vente
  (PartSellPriceBreak), qui n'ont pas de validation plugin.

L'auteur est lu sur la requete en cours, qu'InvenTree garde en memoire de
thread (InvenTree.cache.thread_data, pose par InvenTreeRequestCacheMiddleware).
Pas de requete (worker, commande, migration) = action systeme, autorisee.
Les operations du plugin lui-meme (retrait du stock d'un achat paye, appele
pendant la requete d'un membre ou d'un webhook anonyme) passent par
system_action().
"""

import threading
from contextlib import contextmanager

from django.core.exceptions import ValidationError

MESSAGE = "Le frigo est géré par les admins : ses articles ne sont modifiables que par eux."

_local = threading.local()


@contextmanager
def system_action():
    """Autorise les modifications du frigo faites par le plugin lui-meme."""
    prev = getattr(_local, "bypass", False)
    _local.bypass = True
    try:
        yield
    finally:
        _local.bypass = prev


def blocked():
    """Vrai si l'operation en cours vient d'un utilisateur non admin."""
    if getattr(_local, "bypass", False):
        return False
    try:
        from InvenTree.cache import thread_data
    except Exception:
        return False
    request = getattr(thread_data, "request", None)
    if request is None:
        return False  # action systeme (worker, commande d'administration)
    user = getattr(request, "user", None)
    return not (user and user.is_authenticated and (user.is_staff or user.is_superuser))


def fridge_ids():
    """pk de l'emplacement frigo et de ses sous-emplacements (vide si non configure)."""
    try:
        from plugin import registry

        plugin = registry.get_plugin("paiements")
        loc = plugin.fridge_location() if plugin else None
    except Exception:
        loc = None
    if loc is None:
        return set()
    return set(loc.get_descendants(include_self=True).values_list("pk", flat=True))


def check_instance(instance):
    """Leve ValidationError si un non-admin touche au frigo (sauvegarde)."""
    from stock.models import StockItem, StockLocation

    if isinstance(instance, StockItem):
        locs = {instance.location_id}
        if instance.pk:
            locs.add(StockItem.objects.filter(pk=instance.pk).values_list("location_id", flat=True).first())
    elif isinstance(instance, StockLocation):
        locs = {instance.parent_id}
        if instance.pk:
            locs.add(instance.pk)
    else:
        return
    locs.discard(None)
    if locs and blocked():
        fridge = fridge_ids()
        if locs & fridge:
            raise ValidationError(MESSAGE)


def check_deletion(instance):
    """Leve ValidationError si un non-admin supprime un article ou emplacement du frigo."""
    from stock.models import StockItem, StockLocation

    if isinstance(instance, StockItem):
        loc = instance.location_id
    elif isinstance(instance, StockLocation):
        loc = instance.pk
    else:
        return
    if loc and blocked() and loc in fridge_ids():
        raise ValidationError(MESSAGE)


def check_price(sender, instance, **kwargs):
    """pre_save / pre_delete PartSellPriceBreak : prix d'un produit du frigo = admins."""
    if not blocked():
        return
    fridge = fridge_ids()
    if not fridge or not instance.part_id:
        return
    from stock.models import StockItem

    if StockItem.objects.filter(part_id=instance.part_id, location__in=fridge).exists():
        raise ValidationError(MESSAGE)
