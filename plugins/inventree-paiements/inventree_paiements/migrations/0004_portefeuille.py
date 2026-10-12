"""Portefeuille des membres (Wallet, WalletEntry) ; type et moyen de paiement d'un achat."""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Ajoute Purchase.kind / Purchase.method, cree Wallet et WalletEntry."""

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("inventree_paiements", "0003_pricechange"),
    ]

    operations = [
        migrations.AddField(
            model_name="purchase",
            name="kind",
            field=models.CharField(
                choices=[("fridge", "Achat au frigo"), ("topup", "Recharge du portefeuille")],
                default="fridge",
                max_length=10,
                verbose_name="Type",
            ),
        ),
        migrations.AddField(
            model_name="purchase",
            name="method",
            field=models.CharField(
                choices=[("card", "Carte (SumUp)"), ("wallet", "Portefeuille")],
                default="card",
                max_length=10,
                verbose_name="Moyen de paiement",
            ),
        ),
        migrations.CreateModel(
            name="Wallet",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("balance_cents", models.PositiveIntegerField(default=0, verbose_name="Solde (centimes)")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Mis à jour le")),
                (
                    "user",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Membre",
                    ),
                ),
            ],
            options={
                "verbose_name": "Portefeuille",
                "verbose_name_plural": "Portefeuilles",
                "ordering": ["-balance_cents"],
            },
        ),
        migrations.CreateModel(
            name="WalletEntry",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "kind",
                    models.CharField(
                        choices=[("topup", "Recharge"), ("purchase", "Achat"), ("adjust", "Correction")],
                        max_length=10,
                        verbose_name="Type",
                    ),
                ),
                ("amount_cents", models.IntegerField(verbose_name="Montant (centimes)")),
                ("balance_after", models.PositiveIntegerField(verbose_name="Solde après (centimes)")),
                ("note", models.CharField(blank=True, max_length=250, verbose_name="Note")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Le")),
                (
                    "by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Par",
                    ),
                ),
                (
                    "purchase",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="inventree_paiements.purchase",
                        verbose_name="Achat",
                    ),
                ),
                (
                    "wallet",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="entries",
                        to="inventree_paiements.wallet",
                        verbose_name="Portefeuille",
                    ),
                ),
            ],
            options={
                "verbose_name": "Mouvement de portefeuille",
                "verbose_name_plural": "Mouvements de portefeuille",
                "ordering": ["-created_at", "-pk"],
            },
        ),
    ]
