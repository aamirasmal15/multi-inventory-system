"""AppConfig du plugin : purge du cache de traductions Django + defauts.

Les apps de plugins sont injectees dans INSTALLED_APPS pendant le demarrage,
APRES que Django a pu construire (et mettre en cache) des catalogues de
traduction. Un catalogue construit trop tot ignore definitivement le dossier
locale/ du plugin : avec INVENTREE_LANGUAGE=fr, tout le francais du plugin
(erreurs API, notifications, emails) retombe alors sur l'anglais, requetes
web comprises. On purge donc le cache quand cette app devient prete : les
catalogues se reconstruisent a l'activation suivante, ce dossier inclus.
(C'est la remise a zero canonique de Django, la meme que
django.test.signals.language_changed.)
"""

from django.apps import AppConfig


class InventreePretsConfig(AppConfig):
    """App Django du plugin (label inchange : inventree_prets)."""

    name = "inventree_prets"

    def ready(self):
        """Purge gettext + defaut de format de date jour-mois-annee."""
        from django.utils.translation import trans_real

        trans_real._translations = {}
        trans_real._default = None

        self._patch_date_format_default()

    @staticmethod
    def _patch_date_format_default():
        """Nouveaux comptes en DD-MM-YYYY (affiche « 22-02-2022 »).

        DATE_DISPLAY_FORMAT est une preference PAR utilisateur dont
        InvenTree fixe le defaut a YYYY-MM-DD en dur (pas de reglage
        d'instance). InvenTreeUserSetting.SETTINGS pointe sur ce meme
        dictionnaire USER_SETTINGS : changer le defaut ici couvre l'UI
        des reglages, l'API et la ligne creee au premier acces d'un
        compte. Un utilisateur qui choisit un autre format garde son
        choix (ligne existante en base) ; seuls les comptes sans choix
        explicite sont concernes.
        """
        try:
            from common.setting.user import USER_SETTINGS

            USER_SETTINGS["DATE_DISPLAY_FORMAT"]["default"] = "DD-MM-YYYY"
        except Exception:
            # Structure InvenTree differente : on garde le defaut d'origine.
            pass
