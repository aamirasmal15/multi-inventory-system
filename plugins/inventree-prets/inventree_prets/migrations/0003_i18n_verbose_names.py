"""Libelles traduisibles (sources en anglais, traduction via locale/).

Aucun changement de schema : uniquement les verbose_name des champs,
pour que le makemigrations automatique d'InvenTree ne detecte pas de derive.
"""

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models
from django.utils.translation import gettext_lazy as _


class Migration(migrations.Migration):
    """Aligne les options du modele sur les libelles traduisibles."""

    dependencies = [
        ("inventree_prets", "0002_loan_stock_status_before"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="loan",
            options={
                "ordering": ["-lent_at"],
                "verbose_name": _("Loan"),
                "verbose_name_plural": _("Loans"),
            },
        ),
        migrations.AlterField(
            model_name="loan",
            name="stock_item",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name="prets",
                to="stock.stockitem",
                verbose_name=_("Stock item"),
            ),
        ),
        migrations.AlterField(
            model_name="loan",
            name="borrower_user",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
                verbose_name=_("Borrower (member)"),
            ),
        ),
        migrations.AlterField(
            model_name="loan",
            name="borrower_name",
            field=models.CharField(
                blank=True,
                max_length=200,
                verbose_name=_("Borrower (free text)"),
            ),
        ),
        migrations.AlterField(
            model_name="loan",
            name="lent_at",
            field=models.DateTimeField(
                default=django.utils.timezone.now,
                verbose_name=_("Lent at"),
            ),
        ),
        migrations.AlterField(
            model_name="loan",
            name="due_on",
            field=models.DateField(
                blank=True,
                null=True,
                verbose_name=_("Due date"),
            ),
        ),
        migrations.AlterField(
            model_name="loan",
            name="returned_at",
            field=models.DateTimeField(
                blank=True,
                null=True,
                verbose_name=_("Returned at"),
            ),
        ),
        migrations.AlterField(
            model_name="loan",
            name="lent_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
                verbose_name=_("Registered by"),
            ),
        ),
        migrations.AlterField(
            model_name="loan",
            name="notes",
            field=models.TextField(blank=True, verbose_name=_("Notes")),
        ),
        migrations.AlterField(
            model_name="loan",
            name="reminder_sent",
            field=models.BooleanField(
                default=False, verbose_name=_("Reminder sent")
            ),
        ),
        migrations.AlterField(
            model_name="loan",
            name="overdue_notified",
            field=models.BooleanField(
                default=False, verbose_name=_("Overdue notified")
            ),
        ),
        migrations.AlterField(
            model_name="loan",
            name="stock_status_before",
            field=models.IntegerField(
                blank=True,
                null=True,
                verbose_name=_("Status before loan"),
            ),
        ),
    ]
