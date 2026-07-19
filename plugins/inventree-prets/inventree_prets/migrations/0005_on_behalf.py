"""Champ facultatif « pour l'asso / le club » sur les prets et reservations."""

from django.db import migrations, models
from django.utils.translation import gettext_lazy as _


class Migration(migrations.Migration):
    """Ajoute Loan.on_behalf et Reservation.on_behalf."""

    dependencies = [
        ("inventree_prets", "0004_reservation"),
    ]

    operations = [
        migrations.AddField(
            model_name="loan",
            name="on_behalf",
            field=models.CharField(
                blank=True,
                max_length=200,
                verbose_name=_("For (association/club)"),
            ),
        ),
        migrations.AddField(
            model_name="reservation",
            name="on_behalf",
            field=models.CharField(
                blank=True,
                max_length=200,
                verbose_name=_("For (association/club)"),
            ),
        ),
    ]
