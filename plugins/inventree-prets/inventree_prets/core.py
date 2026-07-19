"""Point d'entree du plugin : classe PretsPlugin.

Verifie contre le code source d'InvenTree 1.4.1 :
- common/notifications.py : trigger_notification(obj, category, targets=..., context={'name', 'message'})
- notification email native (core_notifications.InvenTreeEmailNotifications) :
  ne part que si context['template'] = {'html': chemin, 'subject': str} est fourni,
  le template est rendu avec tout le contexte ; destinataires filtres par le
  reglage utilisateur NOTIFY_BY_EMAIL et l'adresse du compte, envoi seulement
  si un serveur SMTP est configure (sinon la cloche part quand meme)
- plugin ScheduleMixin : SCHEDULED_TASKS avec 'func' en notation membre (sans point) et 'schedule' 'D'
- plugin UrlsMixin : methode setup_urls, montage sous /plugin/<slug>/ (necessite ENABLE_PLUGINS_URL)
- plugin UserInterfaceMixin : get_ui_panels(request, context), context {target_model, target_id},
  source = plugin_static_file('fichier.js:fonction') (necessite ENABLE_PLUGINS_INTERFACE)
- etat personnalise (badge tableau) : common.InvenTreeCustomUserStateModel + StockItem.status_custom_key
"""

import datetime

from django.conf import settings as django_settings
from django.core.validators import MinValueValidator
from django.utils import timezone, translation
from django.utils.translation import gettext
from django.utils.translation import gettext_lazy as _

from plugin import InvenTreePlugin
from plugin.mixins import (
    AppMixin,
    ScheduleMixin,
    SettingsMixin,
    UrlsMixin,
    UserInterfaceMixin,
)

from . import PLUGIN_VERSION


class PretsPlugin(
    AppMixin,
    SettingsMixin,
    ScheduleMixin,
    UrlsMixin,
    UserInterfaceMixin,
    InvenTreePlugin,
):
    """Gestion des prets d'objets trackables aux membres et exterieurs."""

    NAME = "Prêts"
    SLUG = "prets"
    TITLE = _("Loan management")
    DESCRIPTION = _(
        "Lend and return trackable items, with due date reminders and overdue alerts."
    )
    AUTHOR = "Aamir ASMAL"
    VERSION = PLUGIN_VERSION
    MIN_VERSION = "1.4.0"

    SETTINGS = {
        "LOAN_DURATION_DAYS": {
            "name": _("Default loan duration"),
            "description": _("Duration (in days) applied when no due date is given"),
            "default": 1,
            "validator": int,
        },
        "REMINDER_ENABLED": {
            "name": _("Reminder before due date"),
            "description": _("Send a reminder to the borrower when the due date is near"),
            "default": True,
            "validator": bool,
        },
        "REMINDER_DAYS_BEFORE": {
            "name": _("Days before due date"),
            "description": _("Number of days before the due date to send the reminder"),
            "default": 1,
            "validator": int,
        },
        "CHECK_OVERDUE": {
            "name": _("Overdue alert"),
            "description": _(
                "Alert the administrators (staff and superusers, except the "
                "main account) when an item is not returned"
            ),
            "default": True,
            "validator": bool,
        },
        "NOTIFY_BORROWER": {
            "name": _("Notify the borrower"),
            "description": _(
                "Send the borrower (member) a daily reminder "
                "as long as the item is overdue"
            ),
            "default": True,
            "validator": bool,
        },
        "LOAN_RECEIPT": {
            "name": _("Borrowing receipt"),
            "description": _(
                "Send the borrower (member) a receipt when a loan is "
                "registered"
            ),
            "default": True,
            "validator": bool,
        },
        "RETURN_RECEIPT": {
            "name": _("Return receipt"),
            "description": _(
                "Send the borrower (member) a receipt when the return of "
                "the item is recorded"
            ),
            "default": True,
            "validator": bool,
        },
        "USE_STOCK_STATUS": {
            "name": _("'On loan' badge in the table"),
            "description": _(
                "Show an 'On loan' badge on the item in the stock table "
                "while it is borrowed"
            ),
            "default": True,
            "validator": bool,
        },
        "ENABLE_RESERVATIONS": {
            "name": _("Reservations"),
            "description": _(
                "Members can reserve an item for a date range. During the slot, "
                "only the beneficiary can borrow it."
            ),
            "default": False,
            "validator": bool,
        },
        "RESA_RECEIPT": {
            "name": _("Reservation receipt"),
            "description": _(
                "Send the beneficiary (member) a receipt when a reservation "
                "is registered for an upcoming slot"
            ),
            "default": True,
            "validator": bool,
        },
        "RESA_CONFIRM_REMINDER": {
            "name": _("Unconfirmed reservation reminder"),
            "description": _(
                "Remind the beneficiary who has not confirmed the borrowing "
                "a few days into the slot, so an unused reservation gets "
                "cancelled and frees the item"
            ),
            "default": True,
            "validator": bool,
        },
        "RESA_CONFIRM_DAYS": {
            "name": _("Days before the confirmation reminder"),
            "description": _(
                "Number of days after the start of the slot before reminding "
                "the beneficiary to confirm the borrowing"
            ),
            "default": 2,
            "units": _("days"),
            "validator": [int, MinValueValidator(1)],
        },
        "ASK_ON_BEHALF": {
            "name": _("Ask which association it is for"),
            "description": _(
                "Adds an optional field to say for which association or club "
                "the item is borrowed or reserved."
            ),
            "default": False,
            "validator": bool,
        },
        "DELETE_OLD_HISTORY": {
            "name": _("Delete old loan history"),
            "description": _(
                "Delete finished loans and past reservations older than the "
                "specified number of days"
            ),
            "default": True,
            "validator": bool,
        },
        "HISTORY_DELETE_DAYS": {
            "name": _("Loan history deletion interval"),
            "description": _(
                "Finished loans and past reservations will be deleted after "
                "the specified number of days"
            ),
            "default": 365,
            "units": _("days"),
            "validator": [int, MinValueValidator(30)],
        },
    }

    # Valeur numerique du statut personnalise 'Emprunté' (doit rester unique
    # cote StockStatus). Valeur haute pour ne pas heurter les statuts natifs.
    LOAN_STATUS_KEY = 1001

    # 'func' sans point = methode membre du plugin, 'D' = quotidien
    SCHEDULED_TASKS = {
        "daily_checks": {
            "func": "run_daily_checks",
            "schedule": "D",
        }
    }

    def setup_urls(self):
        """Montage des endpoints sous /plugin/prets/."""
        from django.urls import path

        from . import api

        # La redirection des boutons d'emails est ouverte SANS session : le
        # clic vient d'un email. InvenTree exige une auth sur /plugin/ (401
        # sinon) sauf si la vue porte l'attribut auth_exempt. Import defensif
        # du helper : s'il bouge entre versions, le montage des autres
        # endpoints ne casse pas (le bouton renverrait alors un 401 au clic).
        try:
            from InvenTree.permissions import auth_exempt
        except Exception:
            auth_exempt = None
        go_view = api.GoItemView.as_view(plugin=self)
        if auth_exempt:
            go_view = auth_exempt(go_view)

        return [
            path("lend", api.LendView.as_view(plugin=self), name="lend"),
            path("return", api.ReturnView.as_view(plugin=self), name="return"),
            path("active", api.ActiveLoansView.as_view(plugin=self), name="active"),
            path("overdue", api.OverdueLoansView.as_view(plugin=self), name="overdue"),
            path("item/<int:pk>", api.ItemLoanView.as_view(plugin=self), name="item"),
            path("loans", api.LoanHistoryView.as_view(plugin=self), name="loans"),
            path("config", api.ConfigView.as_view(plugin=self), name="config"),
            path("reserve", api.ReserveView.as_view(plugin=self), name="reserve"),
            path(
                "reservation/cancel",
                api.ReservationCancelView.as_view(plugin=self),
                name="reservation-cancel",
            ),
            path(
                "reservations",
                api.ReservationListView.as_view(plugin=self),
                name="reservations",
            ),
            # cible des boutons d'emails : redirection mobile/ordinateur
            path("go/<int:pk>", go_view, name="go"),
        ]

    def run_daily_checks(self):
        """Tache quotidienne : rappels, retards, debuts de reservation.

        La tache tourne hors requete : chaque notification est construite
        dans la langue CHOISIE par son destinataire (profil InvenTree),
        sinon celle de l'instance (INVENTREE_LANGUAGE).
        """
        with translation.override(self._instance_language()):
            if self.get_setting("REMINDER_ENABLED"):
                self._send_reminders()

            if self.get_setting("CHECK_OVERDUE"):
                self._notify_overdue()
                if self.get_setting("NOTIFY_BORROWER"):
                    self._remind_overdue_borrowers()

            if self.get_setting("ENABLE_RESERVATIONS"):
                self._notify_reservation_starts()
                if self.get_setting("RESA_CONFIRM_REMINDER"):
                    self._remind_unconfirmed_reservations()

        # Purge du vieil historique (hors bloc langue : aucune notification)
        if self.get_setting("DELETE_OLD_HISTORY"):
            self._delete_old_history()

    def _delete_old_history(self):
        """Supprime le vieil historique : prets rendus et reservations passees.

        Un pret EN COURS (non rendu) et une reservation ENCORE valable ne sont
        jamais supprimes, quel que soit leur age : on ne perd pas la trace d'un
        objet toujours sorti ou reserve. Seuls l'historique termine part.
        """
        from .models import Loan, Reservation

        try:
            days = int(self.get_setting("HISTORY_DELETE_DAYS"))
        except Exception:
            days = 365
        if days < 1:
            return

        returned_before = timezone.now() - datetime.timedelta(days=days)
        ended_before = timezone.localdate() - datetime.timedelta(days=days)

        # Prets rendus depuis plus de N jours (jamais un pret actif)
        Loan.objects.filter(
            returned_at__isnull=False,
            returned_at__lte=returned_before,
        ).delete()

        # Reservations dont le creneau est termine depuis plus de N jours
        # (donc expirees, honorees ou annulees ; jamais un creneau a venir)
        Reservation.objects.filter(end_date__lte=ended_before).delete()

    @staticmethod
    def _instance_language():
        """Langue de l'instance, resolue vers un catalogue disponible.

        INVENTREE_LANGUAGE peut valoir 'fr-fr' alors que les catalogues sont
        ranges sous 'fr' : une activation brute chercherait fr_FR, ne
        trouverait rien et retomberait sur l'anglais. La resolution est celle
        que Django applique aux requetes web.
        """
        from django.utils.translation import get_supported_language_variant

        try:
            return get_supported_language_variant(django_settings.LANGUAGE_CODE)
        except LookupError:
            return django_settings.LANGUAGE_CODE

    def _user_language(self, user):
        """Langue choisie par l'utilisateur dans InvenTree (UserProfile.language).

        Repli sur la langue de l'instance quand le profil n'a pas de choix
        (ou pas de profil du tout : comptes crees hors des parcours web).
        """
        from django.utils.translation import get_supported_language_variant

        try:
            lang = (user.profile.language or "").strip()
        except Exception:
            lang = ""

        if lang:
            try:
                return get_supported_language_variant(lang)
            except LookupError:
                pass
        return self._instance_language()

    def _by_language(self, users):
        """Regroupe des destinataires par preferences d'affichage.

        Cle : (langue, formats de date user_date_fmts) — chaque groupe recoit
        cloche et email dans sa langue ET avec les dates ecrites comme son
        interface InvenTree les affiche.
        """
        from .models import user_date_fmts

        groups = {}
        for user in users:
            key = (self._user_language(user), user_date_fmts(user))
            groups.setdefault(key, []).append(user)
        return groups

    def _send_reminders(self):
        """Rappelle aux membres emprunteurs que l'echeance approche.

        Fenetre [aujourd'hui, aujourd'hui + REMINDER_DAYS_BEFORE] plutot
        qu'une date pile, pour ne pas rater un rappel si la tache saute un jour.
        """
        from .models import Loan, user_date_fmts

        today = timezone.localdate()
        window = today + datetime.timedelta(
            days=int(self.get_setting("REMINDER_DAYS_BEFORE"))
        )

        loans = Loan.objects.filter(
            returned_at__isnull=True,
            reminder_sent=False,
            borrower_user__isnull=False,
            due_on__isnull=False,
            due_on__gte=today,
            due_on__lte=window,
        )

        for loan in loans:
            try:
                full, short = user_date_fmts(loan.borrower_user)
                with translation.override(self._user_language(loan.borrower_user)):
                    rows = [(gettext("Stock item"), self._item_label(loan.stock_item))]
                    location = self._item_location(loan.stock_item)
                    if location:
                        rows.append((gettext("Location"), location))
                    rows.append(
                        (gettext("Due date"), loan.due_on.strftime(full))
                    )
                    self._notify(
                        loan,
                        category="prets.rappel",
                        name=gettext("Loan due soon"),
                        message=gettext(
                            "Remember to return {item} by {date}."
                        ).format(
                            item=self._item_label(loan.stock_item),
                            date=loan.due_on.strftime(short),
                        ),
                        targets=[loan.borrower_user],
                        rows=rows,
                        accent="rappel",
                    )
                loan.reminder_sent = True
                loan.save()
            except Exception:
                # Un echec d'envoi ne doit pas bloquer les prets suivants
                continue

    def _notify_overdue(self):
        """Alerte les administrateurs des prets en retard (une fois par pret)."""
        from .models import Loan

        loans = Loan.objects.filter(
            returned_at__isnull=True,
            overdue_notified=False,
            due_on__isnull=False,
            due_on__lt=timezone.localdate(),
        )

        for loan in loans:
            # Alerte aux admins uniquement, UNE fois (l'emprunteur, lui, recoit
            # un rappel quotidien via _remind_overdue_borrowers).
            targets = set(self._admin_targets())
            if not targets:
                loan.overdue_notified = True
                loan.save()
                continue

            try:
                # Un envoi par groupe de preferences : chaque destinataire lit
                # la cloche et l'email dans la langue de son profil InvenTree,
                # avec les dates au format qu'il a choisi.
                for (lang, (full, short)), users in self._by_language(targets).items():
                    with translation.override(lang):
                        self._notify(
                            loan,
                            category="prets.retard",
                            name=gettext("Overdue loan"),
                            message=gettext(
                                "{item} has not been returned, due {date}, "
                                "borrowed by {who}."
                            ).format(
                                item=self._item_label(loan.stock_item),
                                date=loan.due_on.strftime(short),
                                who=loan.borrower_label(),
                            ),
                            targets=users,
                            rows=[
                                (
                                    gettext("Stock item"),
                                    self._item_label(loan.stock_item),
                                ),
                                (gettext("Borrower"), loan.borrower_label()),
                                (
                                    gettext("Due date"),
                                    loan.due_on.strftime(full),
                                ),
                            ],
                            accent="retard",
                        )
                loan.overdue_notified = True
                loan.save()
            except Exception:
                continue

    def _remind_overdue_borrowers(self):
        """Relance l'emprunteur membre CHAQUE JOUR tant qu'il n'a pas rendu.

        Contrairement a l'alerte admin (une fois), ce rappel repart a chaque
        passage de la tache : l'objectif est de relancer l'emprunteur tous les
        jours jusqu'au retour, cloche ET email (choix assume depuis la 0.38.1 :
        tout envoi passe par les deux canaux, quitte a empiler les cloches
        tant que l'objet n'est pas rendu).
        """
        from .models import Loan, user_date_fmts

        today = timezone.localdate()

        loans = Loan.objects.filter(
            returned_at__isnull=True,
            borrower_user__isnull=False,
            due_on__isnull=False,
            due_on__lt=today,
        )

        for loan in loans:
            try:
                full, short = user_date_fmts(loan.borrower_user)
                with translation.override(self._user_language(loan.borrower_user)):
                    rows = [(gettext("Stock item"), self._item_label(loan.stock_item))]
                    location = self._item_location(loan.stock_item)
                    if location:
                        rows.append((gettext("Location"), location))
                    rows.append(
                        (gettext("Due date"), loan.due_on.strftime(full))
                    )
                    self._notify(
                        loan,
                        category="prets.retard.emprunteur",
                        name=gettext("You have not returned this item"),
                        message=gettext(
                            "You still have not returned {item}, due on {date}. "
                            "Please bring it back as soon as possible."
                        ).format(
                            item=self._item_label(loan.stock_item),
                            date=loan.due_on.strftime(short),
                        ),
                        targets=[loan.borrower_user],
                        rows=rows,
                        accent="retard",
                    )
            except Exception:
                continue

    def _notify_reservation_starts(self):
        """Previent le beneficiaire (membre) que son creneau demarre.

        Fenetre [start_date, end_date] englobant aujourd'hui plutot que le
        jour de debut pile, pour ne pas rater la notification si la tache
        saute un jour ; un creneau deja termine n'est jamais notifie.
        """
        from .models import Reservation

        today = timezone.localdate()

        resas = Reservation.objects.filter(
            cancelled_at__isnull=True,
            loan__isnull=True,
            start_notified=False,
            reserved_for_user__isnull=False,
            start_date__lte=today,
            end_date__gte=today,
        )

        for resa in resas:
            try:
                self._send_reservation_start(resa)
            except Exception:
                continue

    def _send_reservation_start(self, resa):
        """Envoie la notif « ton creneau demarre » pour UNE reservation.

        Partage entre la tache quotidienne et l'envoi instantane a la creation
        (creneau du jour). Construit dans la langue du beneficiaire, pose le
        drapeau start_notified pour ne pas doubler.
        """
        from .models import slot_label, user_date_fmts

        full, short = user_date_fmts(resa.reserved_for_user)
        with translation.override(self._user_language(resa.reserved_for_user)):
            rows = [(gettext("Stock item"), self._item_label(resa.stock_item))]
            location = self._item_location(resa.stock_item)
            if location:
                rows.append((gettext("Location"), location))
            rows.append(
                (gettext("Slot"), slot_label(resa.start_date, resa.end_date, full))
            )
            # bouton « Confirmer l'emprunt » -> fiche de l'objet, via la
            # redirection mobile/ordinateur du plugin (voir GoItemView)
            go = self._go_link(resa.stock_item)
            self._notify(
                resa,
                category="prets.resa",
                name=gettext("Your reservation has started"),
                message=gettext(
                    "You can pick up {item}, it is reserved for you "
                    "until {date}."
                ).format(
                    item=self._item_label(resa.stock_item),
                    date=resa.end_date.strftime(short),
                ),
                targets=[resa.reserved_for_user],
                rows=rows,
                accent="resa",
                # la demande de confirmation vit en FIN d'email, pas dans
                # la phrase d'accroche (retour utilisateur sur v0.24)
                postscript=gettext(
                    "Please confirm the borrowing once you have picked up "
                    "the item."
                ),
                button=(gettext("Confirm the borrowing"), go) if go else None,
            )
        resa.start_notified = True
        resa.save(update_fields=["start_notified"])

    def _remind_unconfirmed_reservations(self):
        """Relance le beneficiaire qui n'a pas encore confirme l'emprunt.

        Le creneau court depuis RESA_CONFIRM_DAYS jours et l'objet n'a
        toujours pas ete retire : on rappelle au beneficiaire de confirmer
        l'emprunt — ou d'annuler la reservation pour laisser les autres
        emprunter l'objet. Une seule relance par reservation
        (confirm_reminder_sent) ; un creneau termine n'est jamais relance
        (la reservation est expiree, plus rien a confirmer ni a liberer).
        """
        from .models import Reservation, slot_label, user_date_fmts

        today = timezone.localdate()
        try:
            days = int(self.get_setting("RESA_CONFIRM_DAYS"))
        except Exception:
            days = 2
        started_before = today - datetime.timedelta(days=days)

        resas = Reservation.objects.filter(
            cancelled_at__isnull=True,
            loan__isnull=True,
            confirm_reminder_sent=False,
            reserved_for_user__isnull=False,
            start_date__lte=started_before,
            end_date__gte=today,
        )

        for resa in resas:
            try:
                full, short = user_date_fmts(resa.reserved_for_user)
                with translation.override(
                    self._user_language(resa.reserved_for_user)
                ):
                    rows = [
                        (gettext("Stock item"), self._item_label(resa.stock_item))
                    ]
                    location = self._item_location(resa.stock_item)
                    if location:
                        rows.append((gettext("Location"), location))
                    rows.append(
                        (
                            gettext("Slot"),
                            slot_label(resa.start_date, resa.end_date, full),
                        )
                    )
                    go = self._go_link(resa.stock_item)
                    self._notify(
                        resa,
                        category="prets.resa.confirmation",
                        name=gettext("Borrowing not confirmed"),
                        message=gettext(
                            "You have not confirmed the borrowing of {item}, "
                            "reserved for you until {date}."
                        ).format(
                            item=self._item_label(resa.stock_item),
                            date=resa.end_date.strftime(short),
                        ),
                        targets=[resa.reserved_for_user],
                        rows=rows,
                        accent="resa",
                        postscript=gettext(
                            "If you no longer need it, cancel the reservation "
                            "so others can borrow the item."
                        ),
                        button=(gettext("Confirm the borrowing"), go)
                        if go
                        else None,
                    )
                resa.confirm_reminder_sent = True
                resa.save(update_fields=["confirm_reminder_sent"])
            except Exception:
                continue

    def notify_reservation_started_now(self, resa):
        """Envoi INSTANTANE de la notif de debut de creneau (appel depuis l'API).

        Sert quand une reservation est creee pour un creneau qui commence
        aujourd'hui : inutile d'attendre la tache quotidienne. Ne fait rien si
        le beneficiaire n'est pas un membre ou si la notif est deja partie.
        """
        if not resa.reserved_for_user or resa.start_notified:
            return
        try:
            self._send_reservation_start(resa)
        except Exception:
            pass

    def notify_reservation_cancelled(self, resa, cancelled_by, reason=""):
        """Previent le beneficiaire (membre) que sa reservation a ete annulee.

        Appele par l'API seulement quand QUELQU'UN D'AUTRE (createur ou admin)
        annule : s'annuler soi-meme ne previent personne. Construit dans la
        langue du beneficiaire ; le motif, s'il est donne, apparait dans le
        message de la cloche et dans le tableau de details de l'email.
        """
        from .models import slot_label, user_date_fmts

        if not resa.reserved_for_user or not cancelled_by:
            return
        try:
            full, short = user_date_fmts(resa.reserved_for_user)
            with translation.override(self._user_language(resa.reserved_for_user)):
                who = cancelled_by.get_full_name() or cancelled_by.username
                message = gettext(
                    "Your reservation of {item} ({slot}) has been "
                    "cancelled by {who}."
                ).format(
                    item=self._item_label(resa.stock_item),
                    slot=slot_label(resa.start_date, resa.end_date, short),
                    who=who,
                )
                if reason:
                    message += " " + gettext("Reason: {reason}").format(
                        reason=reason
                    )
                rows = [(gettext("Stock item"), self._item_label(resa.stock_item))]
                rows.append(
                    (gettext("Slot"), slot_label(resa.start_date, resa.end_date, full))
                )
                rows.append((gettext("Cancelled by"), who))
                if reason:
                    rows.append((gettext("Reason"), reason))
                self._notify(
                    resa,
                    category="prets.resa.annulation",
                    name=gettext("Your reservation has been cancelled"),
                    message=message,
                    targets=[resa.reserved_for_user],
                    rows=rows,
                    accent="resa",
                )
        except Exception:
            pass

    def notify_reservation_self_cancelled(self, resa):
        """Confirme au beneficiaire l'annulation de SA PROPRE reservation.

        Cloche + email, dans sa langue. Le message distingue le creneau deja
        commence (aujourd'hui) du creneau a venir : dans le premier cas,
        l'annulation rend l'objet a tout le monde, et on le dit.
        """
        from .models import slot_label, user_date_fmts

        if not resa.reserved_for_user:
            return
        try:
            started = resa.start_date <= timezone.localdate()
            full, short = user_date_fmts(resa.reserved_for_user)
            with translation.override(
                self._user_language(resa.reserved_for_user)
            ):
                if started:
                    message = gettext(
                        "Your ongoing reservation of {item} ({slot}) has "
                        "been cancelled. The item is available to everyone "
                        "again."
                    )
                else:
                    message = gettext(
                        "Your reservation of {item} ({slot}) has been "
                        "cancelled."
                    )
                message = message.format(
                    item=self._item_label(resa.stock_item),
                    slot=slot_label(resa.start_date, resa.end_date, short),
                )
                rows = [
                    (gettext("Stock item"), self._item_label(resa.stock_item)),
                    (gettext("Slot"), slot_label(resa.start_date, resa.end_date, full)),
                ]
                self._notify(
                    resa,
                    category="prets.resa.annulation",
                    name=gettext("Reservation cancelled"),
                    message=message,
                    targets=[resa.reserved_for_user],
                    rows=rows,
                    accent="resa",
                )
        except Exception:
            pass

    def notify_loan_created(self, loan):
        """Envoie a l'emprunteur (membre) le recu d'enregistrement du pret.

        Cloche + email, dans sa langue.
        Quand un admin a enregistre le pret AU NOM de l'emprunteur
        (confirmation d'une reservation, v0.33), le message le nomme. La date
        de retour vit dans le tableau de details, pas dans la phrase.
        """
        if not self.get_setting("LOAN_RECEIPT"):
            return
        if not loan.borrower_user:
            return
        try:
            from .models import user_date_fmts

            by_other = (
                loan.lent_by is not None
                and loan.lent_by_id != loan.borrower_user_id
            )
            full, _short = user_date_fmts(loan.borrower_user)
            with translation.override(self._user_language(loan.borrower_user)):
                item = self._item_label(loan.stock_item)
                if by_other:
                    who = loan.lent_by.get_full_name() or loan.lent_by.username
                    message = gettext(
                        "The borrowing of {item} has been recorded in your "
                        "name by {who}."
                    ).format(item=item, who=who)
                else:
                    message = gettext(
                        "Your borrowing of {item} has been recorded."
                    ).format(item=item)
                rows = [(gettext("Stock item"), item)]
                location = self._item_location(loan.stock_item)
                if location:
                    rows.append((gettext("Location"), location))
                if loan.due_on:
                    rows.append(
                        (gettext("Due date"), loan.due_on.strftime(full))
                    )
                if by_other:
                    rows.append((gettext("Borrowing recorded by"), who))
                self._notify(
                    loan,
                    category="prets.emprunt",
                    name=gettext("Borrowing recorded"),
                    message=message,
                    targets=[loan.borrower_user],
                    rows=rows,
                    accent="emprunt",
                )
        except Exception:
            pass

    def notify_reservation_created(self, resa):
        """Envoie au beneficiaire (membre) le recu de sa reservation A VENIR.

        Cloche + email, dans sa langue. Pour un creneau qui commence aujourd'hui,
        l'API envoie a la place la notification de debut (via
        notify_reservation_started_now) : jamais les deux. Si la reservation
        a ete enregistree par quelqu'un d'autre, le message le nomme.
        """
        if not self.get_setting("RESA_RECEIPT"):
            return
        if not resa.reserved_for_user:
            return
        try:
            from .models import slot_label, user_date_fmts

            by_other = (
                resa.created_by is not None
                and resa.created_by_id != resa.reserved_for_user_id
            )
            full, short = user_date_fmts(resa.reserved_for_user)
            with translation.override(
                self._user_language(resa.reserved_for_user)
            ):
                item = self._item_label(resa.stock_item)
                slot = slot_label(resa.start_date, resa.end_date, short)
                if by_other:
                    who = (
                        resa.created_by.get_full_name()
                        or resa.created_by.username
                    )
                    message = gettext(
                        "A reservation of {item} ({slot}) has been recorded "
                        "in your name by {who}."
                    ).format(item=item, slot=slot, who=who)
                else:
                    message = gettext(
                        "Your reservation of {item} ({slot}) has been "
                        "recorded."
                    ).format(item=item, slot=slot)
                rows = [(gettext("Stock item"), item)]
                location = self._item_location(resa.stock_item)
                if location:
                    rows.append((gettext("Location"), location))
                rows.append(
                    (
                        gettext("Slot"),
                        slot_label(resa.start_date, resa.end_date, full),
                    )
                )
                if by_other:
                    rows.append((gettext("Reservation recorded by"), who))
                self._notify(
                    resa,
                    category="prets.resa.creation",
                    name=gettext("Reservation recorded"),
                    message=message,
                    targets=[resa.reserved_for_user],
                    rows=rows,
                    accent="resa",
                    postscript=gettext(
                        "You will receive an email when the slot starts."
                    ),
                )
        except Exception:
            pass

    def notify_loan_returned(self, loan):
        """Envoie a l'emprunteur (membre) le recu de cloture de son pret.

        Cloche + email, dans sa langue.
        Quand le retour a ete enregistre par quelqu'un d'autre
        (admin ou preteur), le message le nomme : l'emprunteur sait que son
        pret a ete clos a sa place — et les relances quotidiennes de retard
        cessent sans qu'il se demande pourquoi.
        """
        if not self.get_setting("RETURN_RECEIPT"):
            return
        if not loan.borrower_user or not loan.returned_at:
            return
        try:
            from .models import user_date_fmts

            by_other = (
                loan.returned_by is not None
                and loan.returned_by_id != loan.borrower_user_id
            )
            full, _short = user_date_fmts(loan.borrower_user)
            with translation.override(self._user_language(loan.borrower_user)):
                item = self._item_label(loan.stock_item)
                if by_other:
                    who = (
                        loan.returned_by.get_full_name()
                        or loan.returned_by.username
                    )
                    message = gettext(
                        "The return of {item} has been recorded by {who}. "
                        "Your loan is now closed."
                    ).format(item=item, who=who)
                else:
                    message = gettext(
                        "The return of {item} has been recorded. Thank you!"
                    ).format(item=item)
                rows = [(gettext("Stock item"), item)]
                rows.append(
                    (
                        gettext("Returned on"),
                        timezone.localtime(loan.returned_at).strftime(full),
                    )
                )
                if by_other:
                    rows.append((gettext("Return recorded by"), who))
                self._notify(
                    loan,
                    category="prets.retour",
                    name=gettext("Return recorded"),
                    message=message,
                    targets=[loan.borrower_user],
                    rows=rows,
                    accent="retour",
                )
        except Exception:
            pass

    def _admin_targets(self):
        """Destinataires des alertes de retard : admins (staff) ET superusers,
        SAUF le tout premier superuser cree.

        Ce premier superuser est le compte « bootstrap » pose a la creation de
        l'instance (create-asso.sh) ; son adresse mail est la meme pour toutes
        les assos, on ne veut donc pas le spammer depuis chaque instance. Il
        est repere par le plus petit pk (le plus ancien). On renvoie des
        utilisateurs concrets car les envois sont regroupes par langue.
        """
        from django.contrib.auth import get_user_model
        from django.db.models import Q

        model = get_user_model()
        bootstrap_pk = (
            model.objects.filter(is_superuser=True)
            .order_by("pk")
            .values_list("pk", flat=True)
            .first()
        )

        qs = model.objects.filter(
            Q(is_staff=True) | Q(is_superuser=True), is_active=True
        )
        if bootstrap_pk is not None:
            qs = qs.exclude(pk=bootstrap_pk)
        return list(qs)

    # Couleur d'accent de l'email par type de notification : les etats de la
    # Scannette (ambre = emprunte, rouge = retard, violet = reserve, vert =
    # disponible/rendu), avec leur fond clair. Le bleu (--primary) reste
    # celui du bouton.
    EMAIL_ACCENTS = {
        "emprunt": ("#f08c00", "#fff9db"),
        "rappel": ("#f08c00", "#fff9db"),
        "retard": ("#e03131", "#fff5f5"),
        "resa": ("#7048e8", "#f3f0ff"),
        "retour": ("#2f9e44", "#ebfbee"),
    }

    def _notify(
        self, obj, category, name, message, targets, rows=None, accent=None,
        email_only=False, postscript=None, button=None,
    ):
        """Appel centralise au systeme de notification d'InvenTree.

        Tout passe par les canaux NATIFS : la cloche ('name' et 'message') et
        l'email ('template', rendu par le plugin email d'InvenTree avec tout
        le contexte, envoye seulement si un serveur SMTP est configure et si
        le destinataire l'accepte). 'email_only' restreint a l'email seul
        (plus aucun envoi ne l'utilise depuis la 0.38.1 — tout passe cloche
        + email, choix utilisateur — mais le mecanisme reste disponible).
        'rows' alimente le tableau de details de l'email, 'accent' sa couleur
        (cle de EMAIL_ACCENTS), 'postscript' une phrase de cloture en fin
        d'email, 'button' un couple (libelle, url) rendu en bouton d'action
        aux couleurs de l'accent (email seul, la cloche garde son message
        court). Pas de logo dans les emails : une image distante est bloquee
        par les clients mail derriere « afficher les images externes », choix
        assume de rester 100 % natif.

        Point sensible entre versions : la signature de trigger_notification
        et les cles du contexte attendues par chaque canal.
        """
        from common.notifications import trigger_notification
        from common.settings import get_global_setting

        color, light = self.EMAIL_ACCENTS.get(accent) or ("#228be6", "#e7f5ff")

        try:
            instance = get_global_setting("INVENTREE_INSTANCE")
        except Exception:
            instance = ""

        button_label, button_url = button or ("", "")

        trigger_notification(
            obj,
            category,
            targets=targets,
            context={
                "name": name,
                "message": message,
                "template": {
                    "html": "prets/email/notification.html",
                    "subject": str(name),
                },
                "rows": rows or [],
                "accent": color,
                "accent_light": light,
                "instance": instance,
                "postscript": postscript or "",
                "button_label": str(button_label),
                "button_url": button_url or "",
            },
            check_recent=False,
            # email seul sur demande (slug du plugin email natif)
            delivery_methods=(
                ["inventree-email-notification"] if email_only else None
            ),
        )

    @staticmethod
    def _item_label(item):
        """Libelle lisible de l'objet : nom du part et numero de serie.

        Volontairement PAS str(item) : InvenTree y accole « @ emplacement »,
        illisible dans une phrase. L'emplacement a sa propre ligne de detail.
        """
        label = item.part.full_name if item.part else f"#{item.pk}"
        if item.serial:
            label += f" #{item.serial}"
        return label

    @staticmethod
    def _item_location(item):
        """Arborescence complete de l'emplacement, ex. « Local > Armoire > Bac ».

        InvenTree stocke le chemin dans pathstring, separateurs « / » ; on les
        remplace par « > » pour la lisibilite. None si l'objet n'a pas
        d'emplacement.
        """
        try:
            loc = item.location
            if not loc:
                return None
            path = getattr(loc, "pathstring", None) or loc.name
            return " > ".join(part.strip() for part in path.split("/"))
        except Exception:
            return None

    def _go_link(self, item):
        """URL absolue de la redirection mobile/ordinateur d'un objet.

        Cible des boutons d'emails : GoItemView choisit au clic, d'apres le
        User-Agent, entre la Scannette et la fiche InvenTree. Depend du
        reglage d'instance INVENTREE_SITE_URL ; None si l'URL de base n'est
        pas connue, le template masque alors le bouton.
        """
        try:
            from InvenTree.helpers_model import construct_absolute_url

            url = construct_absolute_url(f"/plugin/{self.SLUG}/go/{item.pk}")
            return url or None
        except Exception:
            return None

    # ----- Interface web (UserInterfaceMixin) -----

    def user_date_format(self, request):
        """Format d'affichage des dates du demandeur.

        Reglage InvenTree DATE_DISPLAY_FORMAT (par utilisateur) : le panneau
        et les widgets dashboard affichent les dates dans ce format. Le
        defaut (compte sans choix explicite) est DD-MM-YYYY, patche au
        demarrage dans apps.py.
        """
        try:
            from common.models import InvenTreeUserSetting

            return InvenTreeUserSetting.get_setting(
                "DATE_DISPLAY_FORMAT", "DD-MM-YYYY", user=request.user
            )
        except Exception:
            return "DD-MM-YYYY"

    def get_ui_panels(self, request, context, **kwargs):
        """Injecte un panneau 'Prêts' sur la fiche d'un article de stock."""
        context = context or {}

        if context.get("target_model") != "stockitem":
            return []
        if context.get("target_id") is None:
            return []

        try:
            default_days = int(self.get_setting("LOAN_DURATION_DAYS"))
        except Exception:
            default_days = 1

        try:
            reservations = bool(self.get_setting("ENABLE_RESERVATIONS"))
        except Exception:
            reservations = False

        try:
            ask_on_behalf = bool(self.get_setting("ASK_ON_BEHALF"))
        except Exception:
            ask_on_behalf = False

        # Identite de l'utilisateur : emprunts et reservations sont en
        # self-service, les formulaires affichent son nom dans un champ grise.
        # Compte sans prenom (superadmin local) : le nom de l'asso
        # (INVENTREE_COMPANY_NAME, pose par create-asso.sh) plutot qu'un login.
        me = None
        user = getattr(request, "user", None)
        if user and user.is_authenticated:
            name = user.get_full_name()
            if not name:
                try:
                    from common.models import InvenTreeSetting

                    name = InvenTreeSetting.get_setting(
                        "INVENTREE_COMPANY_NAME", ""
                    )
                except Exception:
                    name = ""
            me = {
                "pk": user.pk,
                "name": name or user.username,
                # motif d'emprunt obligatoire pour les admins (choix produit) :
                # le panneau le sait pour exiger le champ cote client
                "is_admin": bool(user.is_staff or user.is_superuser),
            }

        return [
            {
                "key": "prets-panel",
                "title": _("Loans"),
                "icon": "ti:arrows-exchange:outline",
                "source": self.plugin_static_file(
                    "prets_panel.js:renderPretsPanel"
                ),
                # Transmis au JS via data.context (prefill de la date de retour,
                # affichage de la section reservations, self-service, champ Pour)
                "context": {
                    "default_days": default_days,
                    "reservations_enabled": reservations,
                    "ask_on_behalf": ask_on_behalf,
                    "me": me,
                    "date_format": self.user_date_format(request),
                },
            }
        ]

    def get_ui_dashboard_items(self, request, context, **kwargs):
        """Widgets dashboard : prets en cours, et reservations a venir (si activees)."""
        widget_context = {"date_format": self.user_date_format(request)}
        items = [
            {
                "key": "prets-en-cours",
                "title": _("Active loans"),
                "description": _("Items currently on loan, overdue first"),
                "icon": "ti:arrows-exchange:outline",
                "source": self.plugin_static_file(
                    "prets_dashboard.js:renderPretsDashboard"
                ),
                "options": {"width": 4, "height": 3},
                "context": widget_context,
            }
        ]

        try:
            reservations = bool(self.get_setting("ENABLE_RESERVATIONS"))
        except Exception:
            reservations = False

        if reservations:
            items.append(
                {
                    "key": "resas-a-venir",
                    "title": _("Upcoming reservations"),
                    "description": _("Next reservation slots on trackable items"),
                    "icon": "ti:calendar-time:outline",
                    "source": self.plugin_static_file(
                        "prets_dashboard.js:renderResasDashboard"
                    ),
                    "options": {"width": 4, "height": 3},
                    "context": widget_context,
                }
            )

        return items

    # ----- Statut personnalise 'Emprunté' (badge dans le tableau) -----

    def loan_status_key(self):
        """Cle du statut personnalise 'Emprunté', en le creant au besoin.

        Renvoie None si la creation echoue (l'objet reste pretable sans badge).
        """
        from django.contrib.contenttypes.models import ContentType

        from common.models import InvenTreeCustomUserStateModel
        from generic.states.states import ColorEnum
        from stock.models import StockItem
        from stock.status_codes import StockStatus

        try:
            # Le libelle vit EN BASE, dans une seule langue : celle de
            # l'INSTANCE, jamais celle de la requete du moment (piege verifie :
            # un premier appel en contexte anglais figeait « On loan » pour
            # tout le monde, profils FR compris).
            with translation.override(self._instance_language()):
                expected_label = str(gettext("On loan"))
            state, created = InvenTreeCustomUserStateModel.objects.get_or_create(
                reference_status="StockStatus",
                key=self.LOAN_STATUS_KEY,
                defaults={
                    "logical_key": StockStatus.OK.value,
                    # 'name' est une cle technique stable, 'label' est affiche
                    "name": "EMPRUNTE",
                    "label": expected_label,
                    # orange : meme code couleur que l'etat 'emprunte' de la Scannette
                    "color": ColorEnum.warning.value,
                    "model": ContentType.objects.get_for_model(StockItem),
                },
            )
            # badge cree en bleu ou libelle fige dans la mauvaise langue par
            # une version precedente : realigner
            if not created:
                fields = []
                if state.color != ColorEnum.warning.value:
                    state.color = ColorEnum.warning.value
                    fields.append("color")
                if state.label != expected_label:
                    state.label = expected_label
                    fields.append("label")
                if fields:
                    state.save(update_fields=fields)
            return self.LOAN_STATUS_KEY
        except Exception:
            return None

    def apply_loan_status(self, loan):
        """Pose le badge 'Emprunté' sur l'objet, en gardant le statut precedent."""
        if not self.get_setting("USE_STOCK_STATUS"):
            return

        key = self.loan_status_key()
        if key is None:
            return

        item = loan.stock_item
        # Statut d'affichage courant (custom si present, sinon logique)
        previous = item.status_custom_key or item.status
        loan.stock_status_before = previous
        loan.save(update_fields=["stock_status_before"])

        item.status_custom_key = key
        item.save(add_note=False)

    def clear_loan_status(self, loan):
        """Restaure le statut d'avant le prêt au moment du retour."""
        if not self.get_setting("USE_STOCK_STATUS"):
            return

        item = loan.stock_item
        if item.status_custom_key != self.LOAN_STATUS_KEY:
            # Le statut a ete change ailleurs entre-temps : on n'ecrase pas
            return

        item.status_custom_key = loan.stock_status_before or item.status
        item.save(add_note=False)
