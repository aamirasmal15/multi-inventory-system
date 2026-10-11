"""Admin Django des achats (consultation, avec leurs lignes)."""

from django.contrib import admin

from .models import Purchase, PurchaseLine


class PurchaseLineInline(admin.TabularInline):
    """Lignes du panier, en lecture."""

    model = PurchaseLine
    extra = 0
    readonly_fields = ("part", "name", "quantity", "unit_cents", "removed")
    can_delete = False


@admin.register(Purchase)
class PurchaseAdmin(admin.ModelAdmin):
    """Historique des achats du frigo."""

    list_display = (
        "pk",
        "created_at",
        "user",
        "amount_cents",
        "status",
        "stock_removed",
        "payment_ref",
    )
    list_filter = ("status", "stock_removed")
    search_fields = ("user__username", "payment_ref", "checkout_id", "lines__name")
    readonly_fields = ("created_at", "paid_at")
    inlines = [PurchaseLineInline]
