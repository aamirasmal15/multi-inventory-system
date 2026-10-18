"""Demandes d'acces a l'inventaire (frigo ouvert a tous, inventaire sur approbation)."""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


def keep_pending(apps, schema_editor):
    """Les comptes deja en attente (sans groupe ni drapeau admin) gardent leur demande.

    Sans elle, leur premier passage au frigo (qui les met dans le groupe frigo)
    les sortirait de la file d'attente des admins.
    """
    User = apps.get_model(*settings.AUTH_USER_MODEL.split("."))
    AccessRequest = apps.get_model("inventree_paiements", "AccessRequest")
    pending = User.objects.filter(groups__isnull=True, is_staff=False, is_superuser=False, is_active=True)
    AccessRequest.objects.bulk_create([AccessRequest(user_id=pk) for pk in pending.values_list("pk", flat=True)])


class Migration(migrations.Migration):
    """Ajoute AccessRequest et y verse les comptes en attente."""

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("inventree_paiements", "0006_tap_to_pay"),
    ]

    operations = [
        migrations.CreateModel(
            name="AccessRequest",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Demandé le")),
                (
                    "user",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="+",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Compte",
                    ),
                ),
            ],
            options={
                "verbose_name": "Demande d'accès à l'inventaire",
                "verbose_name_plural": "Demandes d'accès à l'inventaire",
                "ordering": ["created_at", "pk"],
            },
        ),
        migrations.RunPython(keep_pending, migrations.RunPython.noop),
    ]
