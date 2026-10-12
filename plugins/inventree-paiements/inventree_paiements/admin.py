"""Admin Django des achats du frigo (consultation, avec leurs lignes).

Enregistrement tolerant : InvenTree recharge ce module quand il reactive les
apps de plugins (AppMixin._reregister_contrib_apps) ; un second register
leverait AlreadyRegistered.
"""

from django.contrib import admin

from .models import PriceChange, Purchase, PurchaseLine, Wallet, WalletEntry


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
        "kind",
        "method",
        "amount_cents",
        "status",
        "stock_removed",
        "payment_ref",
    )
    list_filter = ("status", "kind", "method", "stock_removed")
    search_fields = ("user__username", "payment_ref", "checkout_id", "lines__name")
    # trace comptable : rien de ce qui touche au paiement ne se modifie a la main
    readonly_fields = (
        "user", "location", "amount_cents", "kind", "method", "status", "checkout_id", "payment_ref",
        "stock_removed", "warning", "receipt_sent_to", "created_at", "paid_at",
    )
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


class WalletEntryInline(admin.TabularInline):
    """Mouvements du portefeuille, en lecture."""

    model = WalletEntry
    fk_name = "wallet"
    extra = 0
    readonly_fields = ("created_at", "kind", "amount_cents", "balance_after", "purchase", "note", "by")
    can_delete = False

    def has_add_permission(self, request, obj=None):
        """Un solde ne se corrige que par l'API (journal + verrou), pas a la main."""
        return False


class WalletAdmin(admin.ModelAdmin):
    """Portefeuilles des membres : solde et historique, en lecture."""

    list_display = ("user", "balance_cents", "updated_at")
    search_fields = ("user__username", "user__first_name", "user__last_name")
    readonly_fields = ("user", "balance_cents", "updated_at")
    inlines = [WalletEntryInline]

    def has_add_permission(self, request):
        """Cree automatiquement a la premiere recharge."""
        return False

    def has_delete_permission(self, request, obj=None):
        """Trace comptable : jamais supprime."""
        return False


if not admin.site.is_registered(Wallet):
    admin.site.register(Wallet, WalletAdmin)
