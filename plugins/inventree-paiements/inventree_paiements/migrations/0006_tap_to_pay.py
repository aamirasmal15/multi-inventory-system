"""Recharges encaissees en Tap to Pay par un membre du bureau."""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Ajoute Purchase.channel (en ligne / Tap to Pay) et Purchase.collected_by."""

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("inventree_paiements", "0005_provider"),
    ]

    operations = [
        migrations.AddField(
            model_name="purchase",
            name="channel",
            field=models.CharField(
                choices=[("online", "En ligne"), ("tap", "Tap to Pay")],
                default="online",
                max_length=10,
                verbose_name="Canal",
            ),
        ),
        migrations.AddField(
            model_name="purchase",
            name="collected_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
                verbose_name="Encaissé par",
            ),
        ),
    ]
