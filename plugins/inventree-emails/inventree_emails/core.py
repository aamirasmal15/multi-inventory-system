"""Point d'entree du plugin : classe EmailsPlugin.

Plugin d'habillage : il n'apporte aucun modele ni tache. Son role premier
est d'exposer un dossier `templates/` que le chargeur de templates d'InvenTree
(plugin.template.PluginTemplateLoader) scanne AVANT les templates natifs et
ceux d'allauth. Il suffit donc de surcharger, aux memes chemins :

- email/email.html : la base de TOUS les e-mails HTML natifs d'InvenTree
  (stock bas, peremption, evenement piece, commandes...). La restyler ici
  restyle tous ses enfants d'un coup, aux couleurs de la Scannette.
- email/low_stock_notification.html, stale_stock_notification.html,
  part_event_notification.html : restyle fin (sous-tableau de details).
- account/email/*_message.html : versions HTML des e-mails de compte allauth
  (mot de passe, confirmation d'adresse, changements). allauth envoie alors un
  e-mail multipart (texte natif conserve en repli + alternative HTML habillee).

Seule exception a la logique « templates seuls » : le lien de connexion par
e-mail (magic login), envoye en TEXTE SEUL par le code d'InvenTree — aucun
template HTML n'y est rendu. AppMixin (apps.py) patche la fonction d'envoi
pour joindre la carte HTML. Necessite ENABLE_PLUGINS_APP (deja pose par
create-asso.sh). Le plugin doit etre installe et active
(create-asso.sh : /api/plugins/emails/activate/).

Depuis la 0.10.0, le plugin porte aussi UNE api (UrlsMixin, necessite
ENABLE_PLUGINS_URL deja pose pour le plugin Prets) : la gestion des adresses
e-mail du compte pour l'ecran « Mon compte » de la Scannette — voir api.py
pour le pourquoi (headless allauth = session-only, Scannette = token-only).
"""

from django.utils.translation import gettext_lazy as _

from plugin import InvenTreePlugin
from plugin.mixins import AppMixin, SettingsMixin, UrlsMixin

from . import PLUGIN_VERSION


class EmailsPlugin(AppMixin, SettingsMixin, UrlsMixin, InvenTreePlugin):
    """Habillage des e-mails d'InvenTree a la DA EirSpace/Scannette."""

    NAME = "E-mails"
    SLUG = "emails"
    TITLE = _("Email theming")
    DESCRIPTION = _(
        "Restyle InvenTree e-mails (low stock, account, password...) to the "
        "EirSpace/Scannette look, by overriding their templates."
    )
    AUTHOR = "Aamir ASMAL"
    VERSION = PLUGIN_VERSION
    MIN_VERSION = "1.4.0"

    SETTINGS = {
        # Coupez ce reglage sur une instance SANS Scannette (WITH_SCANNETTE=0) :
        # les liens de confirmation d'adresse retombent alors sur la page
        # InvenTree native au lieu de la page Scannette (cf. apps.py).
        "SCANNETTE_VERIFY_PAGE": {
            "name": _("Scannette verification page"),
            "description": _(
                "Email confirmation links open the Scannette verification page "
                "(host derived from the 'inventaire' -> 'scannette' naming convention)"
            ),
            "default": True,
            "validator": bool,
        },
    }

    def setup_urls(self):
        """Montage sous /plugin/emails/ : adresses e-mail du compte (Scannette)."""
        from django.urls import path

        from . import api

        return [
            path(
                "addresses/",
                api.AddressesView.as_view(plugin=self),
                name="account-addresses",
            ),
        ]
