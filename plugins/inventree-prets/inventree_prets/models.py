"""Modele Loan : un pret d'un objet de stock a un emprunteur.

Chaines sources en anglais, traduction francaise dans locale/fr
(meme convention qu'InvenTree, la langue suit la preference utilisateur).
"""

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext
from django.utils.translation import gettext_lazy as _


# Reglage d'affichage InvenTree (DATE_DISPLAY_FORMAT) -> formats strftime
# (complet, court). Le court (jour + mois, messages compacts) suit l'ordre
# jour/mois du format complet choisi par l'utilisateur.
DATE_STRFTIME = {
    "DD-MM-YYYY": ("%d-%m-%Y", "%d-%m"),
    "MM-DD-YYYY": ("%m-%d-%Y", "%m-%d"),
    "YYYY-MM-DD": ("%Y-%m-%d", "%m-%d"),
    "YYYY-DD-MM": ("%Y-%d-%m", "%d-%m"),
}


def user_date_fmts(user=None):
    """Formats strftime (complet, court) suivant le reglage InvenTree
    DATE_DISPLAY_FORMAT de l'utilisateur.

    Toutes les dates que le plugin ecrit lui-meme (emails, cloche, messages
    d'erreur API) passent par ici : elles suivent ce que l'interface
    InvenTree affiche deja a cet utilisateur, au lieu d'un format code en
    dur. Repli : DD-MM-YYYY, le defaut d'instance patche au demarrage
    (voir apps.py).
    """
    fmt = "DD-MM-YYYY"
    if user is not None:
        try:
            from common.models import InvenTreeUserSetting

            fmt = InvenTreeUserSetting.get_setting(
                "DATE_DISPLAY_FORMAT", "DD-MM-YYYY", user=user
            )
        except Exception:
            pass
    return DATE_STRFTIME.get(fmt, DATE_STRFTIME["DD-MM-YYYY"])


def slot_label(start, end, fmt="%d-%m-%Y"):
    """Libelle lisible d'un creneau : « du 12-07 au 15-07 », ou « le 12-07 »
    quand il tient sur une seule journee (« du 12-07 au 12-07 » est absurde).
    Le format vient de user_date_fmts (celui du destinataire).
    """
    if start == end:
        return gettext("on {date}").format(date=start.strftime(fmt))
    return gettext("from {start} to {end}").format(
        start=start.strftime(fmt), end=end.strftime(fmt)
    )


def item_panel_url(stock_item_id):
    """Onglet Prets de la fiche d'un objet, cible cliquable des notifications
    cloche (via get_absolute_url des modeles). pui_url pose le bon prefixe
    d'interface (/web) depuis les reglages ; repli si indisponible."""
    try:
        from InvenTree.helpers import pui_url

        return pui_url(f"/stock/item/{stock_item_id}/prets-panel")
    except Exception:
        return f"/web/stock/item/{stock_item_id}/prets-panel"


class Loan(models.Model):
    """Pret d'un StockItem a un emprunteur (membre ou nom libre).

    Un objet est considere comme prete tant que returned_at est vide.
    L'historique complet des prets est conserve (un Loan par pret).
    """

    class Meta:
        """Options du modele."""

        app_label = "inventree_prets"
        verbose_name = _("Loan")
        verbose_name_plural = _("Loans")
        ordering = ["-lent_at"]

    stock_item = models.ForeignKey(
        "stock.StockItem",
        on_delete=models.CASCADE,
        related_name="prets",
        verbose_name=_("Stock item"),
    )

    borrower_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name=_("Borrower (member)"),
    )

    borrower_name = models.CharField(
        max_length=200,
        blank=True,
        verbose_name=_("Borrower (free text)"),
    )

    lent_at = models.DateTimeField(
        default=timezone.now,
        verbose_name=_("Lent at"),
    )

    due_on = models.DateField(
        null=True,
        blank=True,
        verbose_name=_("Due date"),
    )

    returned_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name=_("Returned at"),
    )

    lent_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name=_("Registered by"),
    )

    # Qui a enregistre le retour : l'emprunteur, celui qui a prete, ou un admin
    # (tous les trois y sont autorises). Pendant a lent_by ; expose par l'API
    # (returned_by_detail) pour que les historiques puissent afficher « Retour
    # enregistre par » quand l'auteur n'est pas l'emprunteur.
    returned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name=_("Returned by"),
    )

    notes = models.TextField(
        blank=True,
        verbose_name=_("Notes"),
    )

    # Facultatif : l'asso / le club pour lequel l'objet est emprunte
    # (active par le reglage ASK_ON_BEHALF ; le libelle devient « X pour Y »)
    on_behalf = models.CharField(
        max_length=200,
        blank=True,
        verbose_name=_("For (association/club)"),
    )

    # Drapeaux anti double-envoi pour la tache quotidienne
    reminder_sent = models.BooleanField(
        default=False,
        verbose_name=_("Reminder sent"),
    )

    overdue_notified = models.BooleanField(
        default=False,
        verbose_name=_("Overdue notified"),
    )

    # Statut d'affichage de l'objet avant le pret, pour le restaurer au retour
    # (quand le badge 'Emprunté' est active).
    stock_status_before = models.IntegerField(
        null=True,
        blank=True,
        verbose_name=_("Status before loan"),
    )

    def __str__(self):
        """Representation lisible du pret."""
        return f"Loan #{self.pk}: {self.stock_item} -> {self.borrower_label()}"

    def get_absolute_url(self):
        """Cible cliquable de la notification cloche : onglet Prets de l'objet."""
        return item_panel_url(self.stock_item_id)

    @property
    def is_active(self):
        """Le pret est en cours tant que l'objet n'est pas rendu."""
        return self.returned_at is None

    @property
    def is_overdue(self):
        """Le pret est en retard si actif et echeance depassee."""
        return (
            self.is_active
            and self.due_on is not None
            and self.due_on < timezone.localdate()
        )

    def borrower_label(self):
        """Nom lisible de l'emprunteur, ex. « Aamir ASMAL (EirSpace) ».

        L'asso est entre parenthèses (et non « X pour Y ») : la préposition
        se marie mal avec certains noms (« pour BDE ») et les parenthèses
        sont neutres pour toutes les langues.
        """
        if self.borrower_user:
            base = self.borrower_user.get_full_name() or self.borrower_user.username
        elif self.borrower_name:
            base = self.borrower_name
        else:
            base = str(_("Unknown"))
        if self.on_behalf:
            return f"{base} ({self.on_behalf})"
        return base

    @classmethod
    def check_user_permission(cls, user, permission):
        """Autorise la lecture du modele pour tout utilisateur actif.

        InvenTree filtre les destinataires des notifications via
        users.permissions.check_user_permission : les modeles de plugin
        n'appartenant a aucun ruleset, sans ce hook seuls les superusers
        recevraient les notifications de pret.
        """
        return permission == "view"


class Reservation(models.Model):
    """Reservation d'un StockItem sur un creneau [start_date, end_date].

    Cycle de vie : active tant que non annulee (cancelled_at) et non
    convertie en pret (loan) ; elle expire d'elle-meme quand end_date
    est passee. L'historique complet est conserve.
    """

    class Meta:
        """Options du modele."""

        app_label = "inventree_prets"
        verbose_name = _("Reservation")
        verbose_name_plural = _("Reservations")
        ordering = ["start_date"]

    stock_item = models.ForeignKey(
        "stock.StockItem",
        on_delete=models.CASCADE,
        related_name="reservations",
        verbose_name=_("Stock item"),
    )

    reserved_for_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name=_("Reserved for (member)"),
    )

    reserved_for_name = models.CharField(
        max_length=200,
        blank=True,
        verbose_name=_("Reserved for (free text)"),
    )

    start_date = models.DateField(
        verbose_name=_("From"),
    )

    end_date = models.DateField(
        verbose_name=_("To"),
    )

    notes = models.TextField(
        blank=True,
        verbose_name=_("Notes"),
    )

    # Facultatif : l'asso / le club pour lequel l'objet est reserve
    on_behalf = models.CharField(
        max_length=200,
        blank=True,
        verbose_name=_("For (association/club)"),
    )

    created_at = models.DateTimeField(
        default=timezone.now,
        verbose_name=_("Created at"),
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name=_("Registered by"),
    )

    cancelled_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name=_("Cancelled at"),
    )

    # Tracabilite de l'annulation : qui, et pourquoi. Renseignes a l'annulation
    # mais volontairement HORS du serializer (donc invisibles de la Scannette et
    # du panneau) : la trace est conservee cote base, consultable dans l'admin
    # Django, prete a etre exposee un jour sans perdre l'historique d'ici la.
    cancelled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name=_("Cancelled by"),
    )

    # Motif transmis au beneficiaire dans l'email d'annulation. Obligatoire
    # quand on annule la reservation de quelqu'un d'autre, vide sinon.
    cancel_reason = models.CharField(
        max_length=500,
        blank=True,
        verbose_name=_("Cancellation reason"),
    )

    # Drapeau anti double-envoi pour la tache quotidienne : le beneficiaire
    # a ete prevenu que son creneau demarre.
    start_notified = models.BooleanField(
        default=False,
        verbose_name=_("Start notified"),
    )

    # Drapeau anti double-envoi pour la tache quotidienne : le beneficiaire
    # a ete relance parce que le creneau court depuis plusieurs jours sans
    # que l'emprunt soit confirme (ni la reservation annulee).
    confirm_reminder_sent = models.BooleanField(
        default=False,
        verbose_name=_("Confirmation reminder sent"),
    )

    # Pret cree quand l'objet a ete retire sur ce creneau (la reservation
    # est alors consideree honoree et sort des listes actives).
    loan = models.ForeignKey(
        Loan,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="reservations",
        verbose_name=_("Converted loan"),
    )

    def __str__(self):
        """Representation lisible de la reservation."""
        return (
            f"Reservation #{self.pk}: {self.stock_item} -> "
            f"{self.reserved_for_label()} ({self.start_date} - {self.end_date})"
        )

    def get_absolute_url(self):
        """Cible cliquable de la notification cloche : onglet Prets de l'objet."""
        return item_panel_url(self.stock_item_id)

    @property
    def is_cancelled(self):
        """La reservation a ete annulee."""
        return self.cancelled_at is not None

    @property
    def is_fulfilled(self):
        """La reservation a ete convertie en pret."""
        return self.loan_id is not None

    @property
    def is_active(self):
        """Active : ni annulee, ni honoree, ni expiree."""
        return (
            not self.is_cancelled
            and not self.is_fulfilled
            and self.end_date >= timezone.localdate()
        )

    @property
    def is_current(self):
        """Le creneau couvre la date du jour."""
        return self.is_active and self.start_date <= timezone.localdate()

    def reserved_for_label(self):
        """Nom lisible du beneficiaire, ex. « Aamir ASMAL (EirSpace) » (voir Loan)."""
        if self.reserved_for_user:
            base = (
                self.reserved_for_user.get_full_name()
                or self.reserved_for_user.username
            )
        elif self.reserved_for_name:
            base = self.reserved_for_name
        else:
            base = str(_("Unknown"))
        if self.on_behalf:
            return f"{base} ({self.on_behalf})"
        return base

    @classmethod
    def check_user_permission(cls, user, permission):
        """Lecture ouverte a tout utilisateur actif (voir Loan)."""
        return permission == "view"
