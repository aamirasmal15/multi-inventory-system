"""Admin Django du modele Purchase (consultation des achats)."""

from django.contrib import admin

from .models import Purchase


@admin.register(Purchase)
class PurchaseAdmin(admin.ModelAdmin):
    """Historique des achats (SumUp / HelloAsso)."""

    list_display = (
        "created_at",
        "item_name",
        "quantity",
        "amount_cents",
        "user",
        "status",
        "stock_removed",
        "provider",
        "payment_ref",
    )
    list_filter = ("status", "provider", "stock_removed")
    search_fields = ("item_name", "user__username", "payment_ref", "checkout_id")
    readonly_fields = ("created_at", "paid_at")
