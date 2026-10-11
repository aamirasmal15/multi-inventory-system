"""Migration initiale : creation de la table des achats."""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Cree le modele Purchase."""

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("stock", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="Purchase",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("item_name", models.CharField(max_length=250, verbose_name="Libellé")),
                ("quantity", models.DecimalField(decimal_places=5, max_digits=15, verbose_name="Quantité")),
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
                ("checkout_intent_id", models.BigIntegerField(blank=True, null=True, unique=True, verbose_name="Checkout HelloAsso")),
                ("order_id", models.BigIntegerField(blank=True, null=True, verbose_name="Commande HelloAsso")),
                ("stock_removed", models.BooleanField(default=False, verbose_name="Stock retiré")),
                ("warning", models.TextField(blank=True, verbose_name="Anomalie")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Créé le")),
                ("paid_at", models.DateTimeField(blank=True, null=True, verbose_name="Payé le")),
                (
                    "stock_item",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="helloasso_purchases",
                        to="stock.stockitem",
                        verbose_name="Article de stock",
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
                "verbose_name": "Achat HelloAsso",
                "verbose_name_plural": "Achats HelloAsso",
                "ordering": ["-created_at"],
            },
        ),
    ]
