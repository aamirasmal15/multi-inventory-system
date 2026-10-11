"""Modeles Purchase (un panier paye ou en attente) et PurchaseLine (ses articles).

Un Purchase est cree AVANT le paiement (statut pending) : son pk voyage dans
la reference du checkout et dans l'URL de retour, ce qui permet de retrouver
l'achat aussi bien au retour de l'utilisateur que sur reception du webhook.
Le stock n'est retire qu'une fois le paiement verifie aupres de l'API du
prestataire (jamais sur la seule foi du navigateur).

Une ligne vise soit un article de stock precis (achat depuis sa fiche), soit
un part (achat depuis le frigo) : le stock est alors preleve dans les
articles de ce part ranges dans l'emplacement frigo, les plus anciens d'abord.
"""

from django.conf import settings
from django.db import models


class Purchase(models.Model):
    """Panier : une ou plusieurs lignes payees en une fois."""

    PROVIDER_CHOICES = [("sumup", "SumUp"), ("helloasso", "HelloAsso")]
    SOURCE_CHOICES = [("frigo", "Frigo"), ("item", "Fiche article")]

    STATUS_PENDING = "pending"
    STATUS_PAID = "paid"
    STATUS_CHOICES = [
        (STATUS_PENDING, "En attente de paiement"),
        (STATUS_PAID, "Payé"),
    ]

    provider = models.CharField(max_length=20, choices=PROVIDER_CHOICES, verbose_name="Prestataire")
    source = models.CharField(max_length=10, choices=SOURCE_CHOICES, default="item", verbose_name="Origine")
    # emplacement dans lequel le stock est preleve (frigo), fige a la creation
    location = models.ForeignKey(
        "stock.StockLocation",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name="Emplacement",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name="Acheteur",
    )
    amount_cents = models.PositiveIntegerField(verbose_name="Montant (centimes)")
    status = models.CharField(
        max_length=20,
        choices=STATUS_CHOICES,
        default=STATUS_PENDING,
        verbose_name="Statut",
    )
    # identifiant du checkout chez le prestataire (UUID SumUp, entier HelloAsso)
    checkout_id = models.CharField(max_length=64, null=True, blank=True, verbose_name="Checkout")
    # reference du paiement abouti (code transaction SumUp, n° de commande HelloAsso)
    payment_ref = models.CharField(max_length=64, blank=True, verbose_name="Référence du paiement")
    stock_removed = models.BooleanField(default=False, verbose_name="Stock retiré")
    # anomalie constatee a la confirmation (stock insuffisant, article supprime...)
    warning = models.TextField(blank=True, verbose_name="Anomalie")
    receipt_sent_to = models.CharField(max_length=254, blank=True, verbose_name="Reçu envoyé à")
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
        return f"#{self.pk} {self.summary()} ({self.get_status_display()})"

    def summary(self, limit=250):
        """« 2 × Coca 33cl, Jus d'orange » : description envoyee au prestataire."""
        parts = [
            (ln.name if ln.quantity == 1 else f"{ln.quantity} × {ln.name}")
            for ln in self.lines.all()
        ]
        s = ", ".join(parts)
        return s if len(s) <= limit else s[: limit - 1] + "…"


class PurchaseLine(models.Model):
    """Un article du panier, prix fige au moment de l'achat."""

    purchase = models.ForeignKey(Purchase, on_delete=models.CASCADE, related_name="lines", verbose_name="Achat")
    part = models.ForeignKey(
        "part.Part",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name="Article",
    )
    # article de stock precis (achat depuis sa fiche) ; vide = prelevement frigo
    stock_item = models.ForeignKey(
        "stock.StockItem",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        verbose_name="Article de stock",
    )
    # libelle fige : l'article peut etre renomme ou supprime ensuite
    name = models.CharField(max_length=250, verbose_name="Libellé")
    quantity = models.PositiveIntegerField(verbose_name="Quantité")
    unit_cents = models.PositiveIntegerField(verbose_name="Prix unitaire (centimes)")
    removed = models.DecimalField(
        max_digits=15, decimal_places=5, default=0, verbose_name="Quantité retirée du stock"
    )

    class Meta:
        """Ordre de saisie."""

        ordering = ["pk"]
        verbose_name = "Ligne d'achat"
        verbose_name_plural = "Lignes d'achat"

    @property
    def total_cents(self):
        """Montant de la ligne."""
        return self.quantity * self.unit_cents
