"""AppConfig du plugin : patch du lien de connexion par e-mail (magic login).

Le plugin est un plugin de TEMPLATES — sauf pour UN e-mail : le lien de
connexion (InvenTree.magic_login.send_simple_login_email) est envoye en texte
seul par InvenTree, sans jamais rendre de template HTML. Aucune surcharge de
template ne peut donc l'habiller ; on remplace la fonction d'envoi par une
version qui rend le texte (repli) ET la carte HTML du plugin, via le meme
send_email (html_message).

Le patch est sur : la fonction est appelee par son nom de module a l'execution
(GetSimpleLoginView.email_submitted -> send_simple_login_email, meme module),
donc remplacer l'attribut du module suffit. Import defensif : si la fonction
bouge entre versions d'InvenTree, l'e-mail natif (texte seul) continue de
partir, on ne casse rien.
"""

from django.apps import AppConfig


class InventreeEmailsConfig(AppConfig):
    """App Django du plugin (label : inventree_emails)."""

    name = "inventree_emails"

    def ready(self):
        """Pose les patchs (une seule fois chacun)."""
        self._patch_simple_login_email()
        self._patch_email_confirmation_url()

    @staticmethod
    def _patch_email_confirmation_url():
        """Les liens de confirmation d'adresse menent a la page Scannette.

        La page InvenTree /web/verify-email affiche « non connecte » meme
        quand la validation a reussi : la Scannette sert sa propre page
        (verify-email.html, verdict clair). Les liens generes depuis la
        Scannette y arrivent deja (hote de la requete) ; ce patch y envoie
        AUSSI ceux generes depuis l'interface InvenTree, pour un seul et
        meme parcours.

        L'hote Scannette n'est pas un reglage : il se deduit de l'hote du
        lien par la convention de deploiement « inventaire[-<nom>] » <->
        « scannette[-<nom>] » (meme regle que GoItemView du plugin Prets).
        Hors convention, ou si le reglage SCANNETTE_VERIFY_PAGE est coupe
        (instance sans Scannette), le lien natif est conserve tel quel —
        jamais de lien casse.
        """
        try:
            from urllib.parse import urlsplit, urlunsplit

            from InvenTree.auth_overrides import CustomAccountAdapter

            if getattr(
                CustomAccountAdapter.get_email_confirmation_url, "_emails_plugin", False
            ):
                return  # deja patche (ready() peut repasser)
            orig = CustomAccountAdapter.get_email_confirmation_url

            def _enabled():
                try:
                    from plugin.registry import registry

                    plg = registry.get_plugin("emails")
                    return plg is None or bool(plg.get_setting("SCANNETTE_VERIFY_PAGE"))
                except Exception:
                    return True

            def get_email_confirmation_url(self, request, emailconfirmation):
                url = orig(self, request, emailconfirmation)
                try:
                    if not _enabled():
                        return url
                    parts = urlsplit(url)
                    hostname = (parts.hostname or "").split(".")
                    first = hostname[0] if hostname else ""
                    if first == "inventaire" or first.startswith("inventaire-"):
                        hostname[0] = "scannette" + first[len("inventaire"):]
                        netloc = ".".join(hostname) + (
                            f":{parts.port}" if parts.port else ""
                        )
                        # src=inventree : la page actuelle choisit sa sortie par
                        # User-Agent et ne le lit plus ; conserve pour les fronts
                        # encore sur l'ancienne page (sortie selon l'origine)
                        query = (parts.query + "&" if parts.query else "") + "src=inventree"
                        return urlunsplit(
                            (parts.scheme, netloc, parts.path, query, parts.fragment)
                        )
                    return url  # deja scannette, ou hors convention : on ne touche pas
                except Exception:
                    return url

            get_email_confirmation_url._emails_plugin = True
            CustomAccountAdapter.get_email_confirmation_url = get_email_confirmation_url
        except Exception:
            # InvenTree a change : on garde les liens natifs
            pass

    @staticmethod
    def _patch_simple_login_email():
        """Envoie le lien de connexion en texte + HTML au lieu de texte seul."""
        try:
            from django.conf import settings
            from django.template.loader import render_to_string

            import InvenTree.magic_login as magic_login
            import InvenTree.version
            from InvenTree.helpers_email import send_email

            if getattr(magic_login.send_simple_login_email, "_emails_plugin", False):
                return  # deja patche (ready() peut repasser)

            def send_simple_login_email(user, link):
                """Version du plugin E-mails : texte (repli) + carte HTML."""
                site_name = InvenTree.version.inventreeInstanceName()
                context = {
                    "username": user.username,
                    "site_name": site_name,
                    "link": link,
                }
                body = render_to_string(
                    "InvenTree/user_simple_login.txt", context
                )
                try:
                    html = render_to_string(
                        "InvenTree/user_simple_login.html", context
                    )
                except Exception:
                    html = None  # template HTML absent : texte seul, comme natif

                send_email(
                    f"[{site_name}] Votre lien de connexion",
                    body,
                    [user.email],
                    settings.DEFAULT_FROM_EMAIL,
                    html_message=html,
                )

            send_simple_login_email._emails_plugin = True
            magic_login.send_simple_login_email = send_simple_login_email
        except Exception:
            # InvenTree a change : on garde l'envoi natif (texte seul)
            pass
