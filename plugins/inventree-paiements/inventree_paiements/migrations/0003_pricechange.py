"""Journal des changements de prix du frigo."""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Cree le modele PriceChange."""

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("part", "0001_initial"),
        ("inventree_paiements", "0002_sumup_frigo_seul"),
    ]

    operations = [
        migrations.CreateModel(
            name="PriceChange",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("part_name", models.CharField(max_length=250, verbose_name="Libellé")),
                ("old_cents", models.PositiveIntegerField(blank=True, null=True, verbose_name="Ancien prix (centimes)")),
                ("new_cents", models.PositiveIntegerField(blank=True, null=True, verbose_name="Nouveau prix (centimes)")),
                ("date", models.DateTimeField(auto_now_add=True, verbose_name="Le")),
                (
                    "part",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="part.part",
                        verbose_name="Article",
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
                        verbose_name="Modifié par",
                    ),
                ),
            ],
            options={
                "verbose_name": "Changement de prix",
                "verbose_name_plural": "Changements de prix",
                "ordering": ["-date", "-pk"],
            },
        ),
    ]
