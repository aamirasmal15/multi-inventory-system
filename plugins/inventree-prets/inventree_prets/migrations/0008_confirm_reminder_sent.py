"""Drapeau anti double-envoi de la relance « confirme ou annule »."""

from django.db import migrations, models
from django.utils.translation import gettext_lazy as _


class Migration(migrations.Migration):
    """Ajoute Reservation.confirm_reminder_sent."""

    dependencies = [
        ("inventree_prets", "0007_cancel_and_return_audit"),
    ]

    operations = [
        migrations.AddField(
            model_name="reservation",
            name="confirm_reminder_sent",
            field=models.BooleanField(
                default=False,
                verbose_name=_("Confirmation reminder sent"),
            ),
        ),
    ]
