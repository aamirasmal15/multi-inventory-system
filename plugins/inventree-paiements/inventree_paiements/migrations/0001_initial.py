"""Migration initiale : achats (paniers) et leurs lignes."""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Cree les modeles Purchase et PurchaseLine."""

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("stock", "0001_initial"),
        ("part", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="Purchase",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "provider",
                    models.CharField(
                        choices=[("sumup", "SumUp"), ("helloasso", "HelloAsso")],
                        max_length=20,
                        verbose_name="Prestataire",
                    ),
                ),
                (
                    "source",
                    models.CharField(
                        choices=[("frigo", "Frigo"), ("item", "Fiche article")],
                        default="item",
                        max_length=10,
                        verbose_name="Origine",
                    ),
                ),
                ("amount_cents", models.PositiveIntegerField(verbose_name="Montant (centimes)")),
                (
                    "status",
                    models.CharField(
                        choices=[("pending", "En attente de paiement"), ("paid", "Payé")],
                        default="pending",
                        max_length=20,
                        verbose_name="Statut",
                    ),
                ),
                ("checkout_id", models.CharField(blank=True, max_length=64, null=True, verbose_name="Checkout")),
                ("payment_ref", models.CharField(blank=True, max_length=64, verbose_name="Référence du paiement")),
                ("stock_removed", models.BooleanField(default=False, verbose_name="Stock retiré")),
                ("warning", models.TextField(blank=True, verbose_name="Anomalie")),
                ("receipt_sent_to", models.CharField(blank=True, max_length=254, verbose_name="Reçu envoyé à")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Créé le")),
                ("paid_at", models.DateTimeField(blank=True, null=True, verbose_name="Payé le")),
                (
                    "location",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="stock.stocklocation",
                        verbose_name="Emplacement",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Acheteur",
                    ),
                ),
            ],
            options={
                "verbose_name": "Achat",
                "verbose_name_plural": "Achats",
                "ordering": ["-created_at"],
                "constraints": [
                    models.UniqueConstraint(fields=("provider", "checkout_id"), name="paiements_unique_checkout")
                ],
            },
        ),
        migrations.CreateModel(
            name="PurchaseLine",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=250, verbose_name="Libellé")),
                ("quantity", models.PositiveIntegerField(verbose_name="Quantité")),
                ("unit_cents", models.PositiveIntegerField(verbose_name="Prix unitaire (centimes)")),
                (
                    "removed",
                    models.DecimalField(
                        decimal_places=5, default=0, max_digits=15, verbose_name="Quantité retirée du stock"
                    ),
                ),
                (
                    "part",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="part.part",
                        verbose_name="Article",
                    ),
                ),
                (
                    "purchase",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="lines",
                        to="inventree_paiements.purchase",
                        verbose_name="Achat",
                    ),
                ),
                (
                    "stock_item",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="stock.stockitem",
                        verbose_name="Article de stock",
                    ),
                ),
            ],
            options={
                "verbose_name": "Ligne d'achat",
                "verbose_name_plural": "Lignes d'achat",
                "ordering": ["pk"],
            },
        ),
    ]
