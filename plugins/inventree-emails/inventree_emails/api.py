"""API du plugin : gestion des adresses e-mail du compte pour la Scannette.

Pourquoi ici et pas via l'API headless d'allauth (/api/auth/v1/account/email) ?
Le headless n'accepte QUE la session Django, or la Scannette est volontairement
token-only (la session est coupee apres le login, cf. scannette-src/js/auth/sso.js).
Ces vues DRF heritent de l'authentification par defaut d'InvenTree (token,
session, basic) : le token de la Scannette passe sans configuration.

On ne reimplemente PAS la logique d'allauth : chaque action delegue aux flows
internes qu'utilise l'API headless elle-meme (allauth.account.internal.flows.
manage_email), qui portent les garde-fous (primaire non supprimable, adresse
non verifiee non promue si une adresse verifiee existe, e-mail de confirmation
a l'ajout, notification de changement d'adresse) et synchronisent user.email
-- champ que get_email_for_user() lit en premier pour TOUTES les notifications.
"""

from django.utils.translation import gettext_lazy as _

from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from allauth.account.forms import AddEmailForm
from allauth.account.internal.flows import manage_email
from allauth.account.models import EmailAddress

# Borne locale (ACCOUNT_MAX_EMAIL_ADDRESSES n'est pas pose par InvenTree) :
# personne n'a besoin de plus, et ca borne l'envoi d'e-mails de confirmation.
MAX_ADDRESSES = 5


def _taken_elsewhere(user, email):
    """True si l'adresse est deja VERIFIEE sur un autre compte : allauth
    (UNIQUE_EMAIL) refusera alors la cle de confirmation au moment du clic,
    en repondant « invalide ou expiree » — piege silencieux vecu en vrai."""
    return (
        EmailAddress.objects.filter(email__iexact=email, verified=True)
        .exclude(user=user)
        .exists()
    )


def _serialize(user):
    """Liste des adresses de l'utilisateur, principale puis verifiees d'abord.

    `blocked` marque une adresse non verifiee que la verification ne pourra
    JAMAIS aboutir (deja utilisee par un autre compte) : le front la signale
    au lieu de laisser renvoyer des liens condamnes.
    """
    qs = EmailAddress.objects.filter(user=user).order_by(
        "-primary", "-verified", "email"
    )
    return [
        {
            "email": a.email,
            "verified": a.verified,
            "primary": a.primary,
            "blocked": (not a.verified) and _taken_elsewhere(user, a.email),
        }
        for a in qs
    ]


def _sync(user):
    """Repare les comptes crees hors allauth (shell, admin Django) : une ligne
    EmailAddress pour user.email si elle manque, et une principale coherente
    avec user.email -- l'adresse qui recoit deja les notifications."""
    if user.email and not EmailAddress.objects.filter(user=user).exists():
        EmailAddress.objects.create(user=user, email=user.email, primary=True)
    if not EmailAddress.objects.filter(user=user, primary=True).exists():
        current = EmailAddress.objects.filter(user=user, email__iexact=user.email).first()
        if current:
            current.primary = True
            current.save()


def _find(user, email):
    """Adresse de l'utilisateur correspondante (insensible a la casse), ou None."""
    return EmailAddress.objects.filter(user=user, email__iexact=email).first()


class AddressesView(APIView):
    """GET : liste des adresses. POST {action, email} : add | primary | remove | resend.

    Toutes les operations sont bornees a request.user : impossible d'agir sur
    les adresses d'un autre compte, quel que soit le payload.
    """

    permission_classes = [IsAuthenticated]
    plugin = None

    def get(self, request):
        """Liste les adresses e-mail du compte."""
        _sync(request.user)
        return Response({"addresses": _serialize(request.user), "max": MAX_ADDRESSES})

    def post(self, request):
        """Execute une action sur une adresse du compte."""
        _sync(request.user)
        action = str(request.data.get("action") or "").strip()
        email = str(request.data.get("email") or "").strip()
        if not email:
            return self._err(_("Adresse manquante."))

        # Les flows allauth attendent une HttpRequest ; apres IsAuthenticated,
        # DRF a propage l'utilisateur token sur la requete sous-jacente.
        # NB : les liens de confirmation sont construits sur l'hote de la
        # REQUETE — donc sur l'hote Scannette quand l'action vient de l'app.
        # C'est voulu : la Scannette sert /web/verify-email/<cle> elle-meme
        # (verify-email.html, route nginx du tpl), avec un verdict clair,
        # au lieu de la page InvenTree qui affiche « non connecte » meme
        # quand la validation a reussi.
        raw = request._request

        if action == "add":
            if EmailAddress.objects.filter(user=request.user).count() >= MAX_ADDRESSES:
                return self._err(
                    _("Maximum %(n)d adresses : supprimez-en une d'abord.")
                    % {"n": MAX_ADDRESSES}
                )
            # Choix assume : on DIT que l'adresse appartient a un autre compte,
            # au lieu du comportement allauth (ajout accepte, verification qui
            # echouera toujours en « lien invalide »). Sur un outil d'asso en
            # petit comite, la clarte prime sur l'anti-enumeration d'adresses.
            if _taken_elsewhere(request.user, email):
                return self._err(
                    _("Cette adresse est déjà utilisée par un autre compte.")
                )
            form = AddEmailForm(user=request.user, data={"email": email})
            if not form.is_valid():
                errs = form.errors.get("email") or [_("Adresse invalide.")]
                return self._err(errs[0])
            # envoie l'e-mail de confirmation et emet le signal email_added
            manage_email.add_email(raw, form)
            return self._ok(request, _("E-mail de confirmation envoyé à %s.") % email)

        addr = _find(request.user, email)
        if addr is None:
            return self._err(_("Adresse introuvable sur ce compte."), status.HTTP_404_NOT_FOUND)

        if action == "primary":
            if addr.primary:
                return self._ok(request)  # deja principale : rien a faire
            if not manage_email.can_mark_as_primary(addr):
                return self._err(_("Vérifiez d'abord cette adresse."))
            if not manage_email.mark_as_primary(raw, addr):
                return self._err(_("Impossible de définir cette adresse comme principale."))
            return self._ok(
                request, _("Les notifications arrivent maintenant sur %s.") % addr.email
            )

        if action == "remove":
            if addr.primary:
                return self._err(
                    _("Impossible de supprimer l'adresse principale : basculez d'abord sur une autre.")
                )
            if not manage_email.delete_email(raw, addr):
                return self._err(_("Suppression impossible."))
            return self._ok(request, _("Adresse supprimée."))

        if action == "resend":
            if addr.verified:
                return self._err(_("Cette adresse est déjà vérifiée."))
            # inutile d'envoyer un lien condamne (cf. _taken_elsewhere)
            if _taken_elsewhere(request.user, addr.email):
                return self._err(
                    _("Cette adresse est déjà utilisée par un autre compte : le lien ne pourra pas aboutir.")
                )
            addr.send_confirmation(raw)
            return self._ok(request, _("E-mail de confirmation renvoyé à %s.") % addr.email)

        return self._err(_("Action inconnue."))

    def _ok(self, request, detail=None):
        out = {"addresses": _serialize(request.user), "max": MAX_ADDRESSES}
        if detail:
            out["detail"] = detail
        return Response(out)

    def _err(self, detail, code=status.HTTP_400_BAD_REQUEST):
        return Response({"detail": detail}, status=code)
