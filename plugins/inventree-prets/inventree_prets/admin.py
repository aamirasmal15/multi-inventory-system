"""Admin Django des modeles Loan et Reservation."""

from django.contrib import admin
from django.utils.translation import gettext_lazy as _

from .models import Loan, Reservation


@admin.register(Loan)
class LoanAdmin(admin.ModelAdmin):
    """Administration des prets."""

    list_display = (
        "stock_item",
        "borrower_label",
        "lent_at",
        "lent_by",
        "due_on",
        "returned_at",
        "returned_by",
        "is_overdue",
    )
    list_filter = ("returned_at", "due_on", "reminder_sent", "overdue_notified")
    search_fields = (
        "stock_item__serial",
        "borrower_name",
        "borrower_user__username",
        "borrower_user__first_name",
        "borrower_user__last_name",
    )
    date_hierarchy = "lent_at"

    @admin.display(description=_("Borrower"))
    def borrower_label(self, obj):
        """Nom lisible de l'emprunteur."""
        return obj.borrower_label()

    @admin.display(boolean=True, description=_("Overdue"))
    def is_overdue(self, obj):
        """Indicateur de retard."""
        return obj.is_overdue


@admin.register(Reservation)
class ReservationAdmin(admin.ModelAdmin):
    """Administration des reservations."""

    list_display = (
        "stock_item",
        "reserved_for_label",
        "start_date",
        "end_date",
        "cancelled_at",
        "cancelled_by",
        "cancel_reason",
        "loan",
    )
    list_filter = ("start_date", "end_date", "cancelled_at")
    search_fields = (
        "stock_item__serial",
        "reserved_for_name",
        "reserved_for_user__username",
        "reserved_for_user__first_name",
        "reserved_for_user__last_name",
        "cancel_reason",
    )
    date_hierarchy = "start_date"

    @admin.display(description=_("Reserved for"))
    def reserved_for_label(self, obj):
        """Nom lisible du beneficiaire."""
        return obj.reserved_for_label()
