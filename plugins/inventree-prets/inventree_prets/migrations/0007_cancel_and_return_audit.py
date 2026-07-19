"""Tracabilite : qui annule une reservation (et pourquoi), qui rend un objet.

Aucune de ces trois informations n'etait conservee : le motif d'annulation
partait dans l'email puis etait jete, et l'auteur d'une annulation comme celui
d'un retour n'etaient nulle part. Champs volontairement absents des serializers
(cf. models.py) : la trace vit en base, consultable dans l'admin Django.
"""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.utils.translation import gettext_lazy as _


class Migration(migrations.Migration):
    """Ajoute Reservation.cancelled_by/cancel_reason et Loan.returned_by."""

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("inventree_prets", "0006_start_notified"),
    ]

    operations = [
        migrations.AddField(
            model_name="reservation",
            name="cancelled_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
                verbose_name=_("Cancelled by"),
            ),
        ),
        migrations.AddField(
            model_name="reservation",
            name="cancel_reason",
            field=models.CharField(
                blank=True,
                max_length=500,
                verbose_name=_("Cancellation reason"),
            ),
        ),
        migrations.AddField(
            model_name="loan",
            name="returned_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
                verbose_name=_("Returned by"),
            ),
        ),
    ]
