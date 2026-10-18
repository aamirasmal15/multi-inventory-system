"""Frigo ouvert a tous, inventaire sur approbation.

Tout compte (EirbConnect cree le sien a la premiere connexion) peut acheter au
frigo : les endpoints du plugin ne demandent qu'une authentification. L'acces
a l'inventaire, lui, passe par les roles InvenTree : un admin met le compte
dans le groupe des membres.

Trois etats pour un compte sans role (ni staff, ni superuser) :
- sans groupe : en attente d'approbation (comportement historique) ;
- groupe frigo : client du frigo seulement, absent de la file d'attente ;
- groupe frigo + demande (AccessRequest) : client du frigo qui a demande l'acces.

Le groupe frigo n'a aucun role (InvenTree cree ses RuleSet a False) : il
range ces comptes a part, il n'accorde rien. Cree automatiquement des que le
frigo est configure.
"""

FRIGO_GROUP = "frigo"


def frigo_group():
    """Groupe des clients du frigo, cree au besoin."""
    from django.contrib.auth.models import Group

    group, _created = Group.objects.get_or_create(name=FRIGO_GROUP)
    return group


def has_inventory_access(user):
    """Le compte voit-il l'inventaire ? Staff, superuser, ou un role InvenTree."""
    if not user or not user.is_authenticated:
        return False
    if user.is_staff or user.is_superuser:
        return True
    from users.models import RuleSet

    return RuleSet.objects.filter(group__in=user.groups.all(), can_view=True).exists()


def access_state(user):
    """Ce que la Scannette doit savoir d'un compte pour choisir son ecran."""
    from .models import AccessRequest

    inventory = has_inventory_access(user)
    req = None if inventory else AccessRequest.objects.filter(user=user).first()
    return {
        "inventory": inventory,
        "frigo_client": not inventory and user.groups.filter(name=FRIGO_GROUP).exists(),
        "requested": req is not None,
        "requested_at": req.created_at.isoformat() if req else None,
    }


def join_frigo(user):
    """Un compte sans role qui ouvre le frigo devient client du frigo.

    Ses autres groupes, s'il en a, restent (aucun role, sinon il aurait
    l'inventaire). Sa demande d'acces eventuelle aussi : il reste en attente.
    """
    if has_inventory_access(user):
        return
    user.groups.add(frigo_group())


def request_access(user):
    """Demande l'acces a l'inventaire (idempotent ; rien si deja accorde)."""
    from .models import AccessRequest

    if has_inventory_access(user):
        return
    AccessRequest.objects.get_or_create(user=user)


def cancel_request(user):
    """Retire la demande d'acces du compte."""
    from .models import AccessRequest

    AccessRequest.objects.filter(user=user).delete()


def pending_requests():
    """Demandes encore valables {pk du compte: date ISO} ; les caduques sont supprimees.

    Caduque = le compte a obtenu un role (approuve par la Scannette ou par
    l'interface InvenTree), ou a ete desactive.
    """
    from .models import AccessRequest

    out, stale = {}, []
    for req in AccessRequest.objects.select_related("user"):
        if not req.user.is_active or has_inventory_access(req.user):
            stale.append(req.pk)
        else:
            out[req.user_id] = req.created_at.isoformat()
    if stale:
        AccessRequest.objects.filter(pk__in=stale).delete()
    return out
