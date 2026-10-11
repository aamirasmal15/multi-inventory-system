"""Modele Purchase : un achat d'article paye (ou en attente) via SumUp ou HelloAsso.

Une ligne est creee AVANT le paiement (statut pending) : son pk voyage dans la
reference du checkout et dans l'URL de retour, ce qui permet de retrouver
l'achat aussi bien au retour de l'utilisateur que sur reception du webhook.
Le stock n'est retire qu'une fois le paiement verifie aupres de l'API du
prestataire (jamais sur la seule foi du navigateur).
"""

from django.conf import settings
from django.db import models


class Purchase(models.Model):
    """Achat d'une quantite d'un article de stock."""

    PROVIDER_CHOICES = [("sumup", "SumUp"), ("helloasso", "HelloAsso")]

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
    provider = models.CharField(max_length=20, choices=PROVIDER_CHOICES, verbose_name="Prestataire")
    # identifiant du checkout chez le prestataire (UUID SumUp, entier HelloAsso)
    checkout_id = models.CharField(max_length=64, null=True, blank=True, verbose_name="Checkout")
    # reference du paiement abouti (code transaction SumUp, n° de commande HelloAsso)
    payment_ref = models.CharField(max_length=64, blank=True, verbose_name="Référence du paiement")
    stock_removed = models.BooleanField(default=False, verbose_name="Stock retiré")
    # anomalie constatee a la confirmation (stock insuffisant, article supprime...)
    warning = models.TextField(blank=True, verbose_name="Anomalie")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="Créé le")
    paid_at = models.DateTimeField(null=True, blank=True, verbose_name="Payé le")

    class Meta:
        """Plus recents en premier."""

        ordering = ["-created_at"]
        verbose_name = "Achat"
        verbose_name_plural = "Achats"
        constraints = [
            models.UniqueConstraint(fields=["provider", "checkout_id"], name="paiements_unique_checkout")
        ]

    def __str__(self):
        """Libelle court pour l'admin Django."""
        return f"#{self.pk} {self.item_name} ({self.get_status_display()})"
