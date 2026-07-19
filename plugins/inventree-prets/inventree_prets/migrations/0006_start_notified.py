"""Drapeau anti double-envoi de la notification de debut de creneau."""

from django.db import migrations, models
from django.utils.translation import gettext_lazy as _


class Migration(migrations.Migration):
    """Ajoute Reservation.start_notified."""

    dependencies = [
        ("inventree_prets", "0005_on_behalf"),
    ]

    operations = [
        migrations.AddField(
            model_name="reservation",
            name="start_notified",
            field=models.BooleanField(
                default=False,
                verbose_name=_("Start notified"),
            ),
        ),
    ]
