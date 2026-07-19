"""Creation de la table des reservations (systeme de reservation Scannette)."""

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models
from django.utils.translation import gettext_lazy as _


class Migration(migrations.Migration):
    """Cree le modele Reservation."""

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("stock", "0001_initial"),
        ("inventree_prets", "0003_i18n_verbose_names"),
    ]

    operations = [
        migrations.CreateModel(
            name="Reservation",
            fields=[
                (
                    "id",
                    models.AutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                (
                    "stock_item",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="reservations",
                        to="stock.stockitem",
                        verbose_name=_("Stock item"),
                    ),
                ),
                (
                    "reserved_for_user",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name=_("Reserved for (member)"),
                    ),
                ),
                (
                    "reserved_for_name",
                    models.CharField(
                        blank=True,
                        max_length=200,
                        verbose_name=_("Reserved for (free text)"),
                    ),
                ),
                ("start_date", models.DateField(verbose_name=_("From"))),
                ("end_date", models.DateField(verbose_name=_("To"))),
                ("notes", models.TextField(blank=True, verbose_name=_("Notes"))),
                (
                    "created_at",
                    models.DateTimeField(
                        default=django.utils.timezone.now,
                        verbose_name=_("Created at"),
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name=_("Registered by"),
                    ),
                ),
                (
                    "cancelled_at",
                    models.DateTimeField(
                        blank=True,
                        null=True,
                        verbose_name=_("Cancelled at"),
                    ),
                ),
                (
                    "loan",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="reservations",
                        to="inventree_prets.loan",
                        verbose_name=_("Converted loan"),
                    ),
                ),
            ],
            options={
                "verbose_name": _("Reservation"),
                "verbose_name_plural": _("Reservations"),
                "ordering": ["start_date"],
            },
        ),
    ]
