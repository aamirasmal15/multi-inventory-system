"""Modele Purchase : un achat d'article paye (ou en attente) via HelloAsso.

Une ligne est creee AVANT la redirection vers HelloAsso (statut pending) :
son pk voyage dans les metadata du checkout et dans l'URL de retour, ce qui
permet de retrouver l'achat aussi bien au retour de l'utilisateur que sur
reception du webhook. Le stock n'est retire qu'une fois le paiement verifie
aupres de l'API HelloAsso (jamais sur la seule foi de l'URL de retour).
"""

from django.conf import settings
from django.db import models


class Purchase(models.Model):
    """Achat d'une quantite d'un article de stock."""

    STATUS_PENDING = "pending"
    STATUS_PAID = "paid"
    STATUS_CHOICES = [
        (STATUS_PENDING, "En attente de paiement"),
        (STATUS_PAID, "Payé"),
    ]

    stock_item = models.ForeignKey(
        "stock.StockItem",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="helloasso_purchases",
        verbose_name="Article de stock",
    )
    # libelle fige au moment de l'achat : l'article peut etre renomme ou
    # supprime ensuite, l'historique des achats doit rester lisible
    item_name = models.CharField(max_length=250, verbose_name="Libellé")
    quantity = models.DecimalField(max_digits=15, decimal_places=5, verbose_name="Quantité")
    amount_cents = models.PositiveIntegerField(verbose_name="Montant (centimes)")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name="Acheteur",
    )
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default=STATUS_PENDING,
        verbose_name="Statut",
    )
    checkout_intent_id = models.BigIntegerField(
        null=True, blank=True, unique=True, verbose_name="Checkout HelloAsso"
    )
    order_id = models.BigIntegerField(null=True, blank=True, verbose_name="Commande HelloAsso")
    stock_removed = models.BooleanField(default=False, verbose_name="Stock retiré")
    # anomalie constatee a la confirmation (stock insuffisant, article supprime...)
    warning = models.TextField(blank=True, verbose_name="Anomalie")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="Créé le")
    paid_at = models.DateTimeField(null=True, blank=True, verbose_name="Payé le")

    class Meta:
        """Plus recents en premier."""

        ordering = ["-created_at"]
        verbose_name = "Achat HelloAsso"
        verbose_name_plural = "Achats HelloAsso"

    def __str__(self):
        """Libelle court pour l'admin Django."""
        return f"#{self.pk} {self.item_name} ({self.get_status_display()})"
