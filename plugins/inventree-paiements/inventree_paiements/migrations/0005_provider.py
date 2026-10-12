"""Prestataire du paiement par carte d'un achat (SumUp ou HelloAsso)."""

from django.db import migrations, models


class Migration(migrations.Migration):
    """Ajoute Purchase.provider (achats existants : SumUp) ; libelle « Carte » du moyen."""

    dependencies = [
        ("inventree_paiements", "0004_portefeuille"),
    ]

    operations = [
        migrations.AddField(
            model_name="purchase",
            name="provider",
            field=models.CharField(
                choices=[("sumup", "SumUp"), ("helloasso", "HelloAsso")],
                default="sumup",
                max_length=20,
                verbose_name="Prestataire",
            ),
        ),
        migrations.AlterField(
            model_name="purchase",
            name="method",
            field=models.CharField(
                choices=[("card", "Carte"), ("wallet", "Portefeuille")],
                default="card",
                max_length=10,
                verbose_name="Moyen de paiement",
            ),
        ),
    ]
