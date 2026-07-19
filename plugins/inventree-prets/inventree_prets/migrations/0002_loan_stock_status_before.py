"""Ajoute le champ stock_status_before (restauration du statut au retour)."""

from django.db import migrations, models


class Migration(migrations.Migration):
    """Ajoute Loan.stock_status_before."""

    dependencies = [
        ("inventree_prets", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="loan",
            name="stock_status_before",
            field=models.IntegerField(
                blank=True,
                null=True,
                verbose_name="Statut avant le prêt",
            ),
        ),
    ]
