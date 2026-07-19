"""Migration initiale : creation de la table des prets."""

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Cree le modele Loan."""

    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("stock", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="Loan",
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
                        related_name="prets",
                        to="stock.stockitem",
                        verbose_name="Objet",
                    ),
                ),
                (
                    "borrower_user",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Emprunteur (membre)",
                    ),
                ),
                (
                    "borrower_name",
                    models.CharField(
                        blank=True,
                        max_length=200,
                        verbose_name="Emprunteur (nom libre)",
                    ),
                ),
                (
                    "lent_at",
                    models.DateTimeField(
                        default=django.utils.timezone.now,
                        verbose_name="Prêté le",
                    ),
                ),
                (
                    "due_on",
                    models.DateField(
                        blank=True,
                        null=True,
                        verbose_name="À rendre le",
                    ),
                ),
                (
                    "returned_at",
                    models.DateTimeField(
                        blank=True,
                        null=True,
                        verbose_name="Rendu le",
                    ),
                ),
                (
                    "lent_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Enregistré par",
                    ),
                ),
                ("notes", models.TextField(blank=True, verbose_name="Notes")),
                (
                    "reminder_sent",
                    models.BooleanField(default=False, verbose_name="Rappel envoyé"),
                ),
                (
                    "overdue_notified",
                    models.BooleanField(default=False, verbose_name="Retard signalé"),
                ),
            ],
            options={
                "verbose_name": "Prêt",
                "verbose_name_plural": "Prêts",
                "ordering": ["-lent_at"],
            },
        ),
    ]
