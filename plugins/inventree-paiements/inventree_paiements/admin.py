"""Admin Django des achats du frigo (consultation, avec leurs lignes).

Enregistrement tolerant : InvenTree recharge ce module quand il reactive les
apps de plugins (AppMixin._reregister_contrib_apps) ; un second register
leverait AlreadyRegistered.
"""

from django.contrib import admin

from .models import PriceChange, Purchase, PurchaseLine


class PurchaseLineInline(admin.TabularInline):
    """Lignes du panier, en lecture."""

    model = PurchaseLine
    extra = 0
    readonly_fields = ("part", "name", "quantity", "unit_cents", "removed")
    can_delete = False


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


if not admin.site.is_registered(Purchase):
    admin.site.register(Purchase, PurchaseAdmin)


class PriceChangeAdmin(admin.ModelAdmin):
    """Journal des prix du frigo, en lecture."""

    list_display = ("date", "part_name", "old_cents", "new_cents", "user")
    search_fields = ("part_name", "user__username")
    readonly_fields = ("date", "part", "part_name", "old_cents", "new_cents", "user")


if not admin.site.is_registered(PriceChange):
    admin.site.register(PriceChange, PriceChangeAdmin)
