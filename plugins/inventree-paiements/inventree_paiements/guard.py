"""Verrou du frigo : seuls les admins modifient ce qu'il contient, partout.

Couvert : articles de stock et emplacement du frigo (et sous-emplacements),
fiches produit des boissons du frigo et de leurs modeles, prix de vente.

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


def part_in_fridge(part_id, fridge):
    """Vrai si ce part, ou une de ses variantes, a du stock dans le frigo.

    Les variantes comptent : une variante sans prix propre herite du prix de
    son modele, et le modele lui-meme n'est souvent pas range dans le frigo.
    """
    from part.models import Part
    from stock.models import StockItem

    part = Part.objects.filter(pk=part_id).first()
    if part is None:
        return False
    parts = part.get_descendants(include_self=True).values_list("pk", flat=True)
    return StockItem.objects.filter(part__in=parts, location__in=fridge).exists()


def check_instance(instance):
    """Leve ValidationError si un non-admin touche au frigo (sauvegarde)."""
    from part.models import Part
    from stock.models import StockItem, StockLocation

    if isinstance(instance, Part):
        # fiche produit d'une boisson du frigo (ou de son modele) : nom,
        # activation, type... changer l'un d'eux la retirerait de la vente
        if instance.pk and blocked():
            fridge = fridge_ids()
            if fridge and part_in_fridge(instance.pk, fridge):
                raise ValidationError(MESSAGE)
        return
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
    """Leve ValidationError si un non-admin supprime un article, un emplacement ou un produit du frigo."""
    from part.models import Part
    from stock.models import StockItem, StockLocation

    if isinstance(instance, Part):
        if blocked():
            fridge = fridge_ids()
            if fridge and part_in_fridge(instance.pk, fridge):
                raise ValidationError(MESSAGE)
        return
    if isinstance(instance, StockItem):
        if instance.location_id and blocked() and instance.location_id in fridge_ids():
            raise ValidationError(MESSAGE)
    elif isinstance(instance, StockLocation):
        # le frigo, un de ses sous-emplacements, ou un de ses ANCETRES (supprimer
        # « Local 2ème » avec son contenu emporterait le frigo)
        if instance.pk and blocked():
            fridge = fridge_ids()
            if fridge and (instance.pk in fridge or fridge_root_under(instance)):
                raise ValidationError(MESSAGE)


def fridge_root_under(location):
    """Vrai si l'emplacement frigo est sous cet emplacement."""
    try:
        from plugin import registry

        loc = registry.get_plugin("paiements").fridge_location()
    except Exception:
        loc = None
    return bool(loc) and loc.get_ancestors().filter(pk=location.pk).exists()


def check_deletion_signal(sender, instance, **kwargs):
    """pre_delete : emis aussi pendant une suppression en cascade, que
    validate_model_deletion (appele par Model.delete) ne voit pas."""
    check_deletion(instance)


def check_price(sender, instance, **kwargs):
    """pre_save / pre_delete PartSellPriceBreak : prix d'un produit du frigo
    (ou de son modele, dont les variantes heritent le prix) = admins."""
    if not blocked():
        return
    fridge = fridge_ids()
    if not fridge:
        return
    parts = {instance.part_id}
    if instance.pk:
        # palier deplace vers un autre part : l'ancien part perdrait son prix
        from part.models import PartSellPriceBreak

        parts.add(PartSellPriceBreak.objects.filter(pk=instance.pk).values_list("part_id", flat=True).first())
    parts.discard(None)
    if any(part_in_fridge(pk, fridge) for pk in parts):
        raise ValidationError(MESSAGE)
