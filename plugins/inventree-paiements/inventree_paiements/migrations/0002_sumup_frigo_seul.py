"""SumUp seul, frigo seul : retrait du prestataire, de l'origine et de l'article de stock par ligne.

Les achats existants sont conserves (tous SumUp et frigo a ce stade).
"""

from django.db import migrations, models


class Migration(migrations.Migration):
    """Simplifie Purchase / PurchaseLine."""

    dependencies = [
        ("inventree_paiements", "0001_initial"),
    ]

    operations = [
        migrations.RemoveConstraint(model_name="purchase", name="paiements_unique_checkout"),
        migrations.RemoveField(model_name="purchase", name="provider"),
        migrations.RemoveField(model_name="purchase", name="source"),
        migrations.RemoveField(model_name="purchaseline", name="stock_item"),
        migrations.AlterField(
            model_name="purchase",
            name="checkout_id",
            field=models.CharField(blank=True, max_length=64, null=True, unique=True, verbose_name="Checkout SumUp"),
        ),
        migrations.AlterField(
            model_name="purchase",
            name="payment_ref",
            field=models.CharField(blank=True, max_length=64, verbose_name="Référence du paiement"),
        ),
    ]
