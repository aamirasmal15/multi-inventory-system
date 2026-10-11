"""Admin Django du modele Purchase (consultation des achats)."""

from django.contrib import admin

from .models import Purchase


@admin.register(Purchase)
class PurchaseAdmin(admin.ModelAdmin):
    """Historique des achats HelloAsso."""

    list_display = (
        "created_at",
        "item_name",
        "quantity",
        "amount_cents",
        "user",
        "status",
        "stock_removed",
        "order_id",
    )
    list_filter = ("status", "stock_removed")
    search_fields = ("item_name", "user__username", "order_id", "checkout_intent_id")
    readonly_fields = ("created_at", "paid_at")
