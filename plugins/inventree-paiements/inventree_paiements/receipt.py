"""Recu d'achat : contexte commun, PDF (weasyprint, fourni par InvenTree) et e-mail.

Le meme contexte alimente l'ecran de la Scannette (via l'API), le PDF
telechargeable et l'e-mail : un membre du bureau voit partout le meme recu.
"""

import logging

from django.conf import settings
from django.template.loader import render_to_string
from django.utils import timezone

logger = logging.getLogger("inventree")


def euros(cents):
    """1234 -> « 12,34 € »."""
    return f"{cents / 100:.2f}".replace(".", ",") + " €"


def buyer_name(user):
    """Prenom Nom, sinon identifiant."""
    if user is None:
        return "—"
    full = f"{user.first_name} {user.last_name}".strip()
    return full or user.username


def buyer_email(user):
    """Adresse principale de l'acheteur (celle choisie dans Mon compte), sinon user.email."""
    if user is None:
        return ""
    try:
        from allauth.account.models import EmailAddress

        ad = EmailAddress.objects.filter(user=user).order_by("-primary", "-verified").first()
        if ad:
            return ad.email
    except Exception:
        pass
    return user.email or ""


def instance_name():
    """Nom de l'instance InvenTree (« EIRSPACE »...)."""
    try:
        from common.settings import get_global_setting

        return get_global_setting("INVENTREE_INSTANCE") or ""
    except Exception:
        return ""


def receipt_context(p):
    """Tout ce que montre un recu, en valeurs deja formatees."""
    paid = timezone.localtime(p.paid_at or p.created_at)
    return {
        "instance": instance_name(),
        "number": p.pk,
        "paid": p.status == p.STATUS_PAID,
        "date": paid.strftime("%d/%m/%Y"),
        "time": paid.strftime("%H:%M"),
        "buyer": buyer_name(p.user),
        "source": "Frigo",
        "location": p.location.name if p.location else "",
        "lines": [
            {
                "name": ln.name,
                "quantity": ln.quantity,
                "unit": euros(ln.unit_cents),
                "total": euros(ln.total_cents),
            }
            for ln in p.lines.all()
        ],
        "count": sum(ln.quantity for ln in p.lines.all()),
        "total": euros(p.amount_cents),
        "provider": "SumUp",
        "payment_ref": p.payment_ref,
        "warning": p.warning,
    }


def receipt_filename(p):
    """recu-eirspace-27.pdf"""
    inst = "".join(c for c in instance_name().lower() if c.isalnum()) or "achat"
    return f"recu-{inst}-{p.pk}.pdf"


def render_pdf(p):
    """Recu PDF (octets)."""
    from weasyprint import HTML

    html = render_to_string("paiements/receipt_pdf.html", receipt_context(p))
    return HTML(string=html).write_pdf()


def send_receipt_email(p):
    """Envoie le recu (HTML + PDF joint) ; renvoie l'adresse, ou "" si impossible."""
    from django.core.mail import EmailMultiAlternatives

    from InvenTree.helpers_email import is_email_configured

    to = buyer_email(p.user)
    if not to or not is_email_configured():
        return ""
    ctx = receipt_context(p)
    subject = f"Reçu de ton achat n° {p.pk}" + (f" · {ctx['instance']}" if ctx["instance"] else "")
    text = "\n".join(
        [f"Merci pour ton achat, {ctx['buyer']} !", "", f"Achat n° {p.pk} du {ctx['date']} à {ctx['time']}", ""]
        + [f"{ln['quantity']} × {ln['name']} : {ln['total']}" for ln in ctx["lines"]]
        + ["", f"Total payé : {ctx['total']} ({ctx['provider']})", "", "Le reçu PDF est joint à cet e-mail."]
    )
    msg = EmailMultiAlternatives(subject, text, settings.DEFAULT_FROM_EMAIL, [to])
    msg.attach_alternative(render_to_string("paiements/receipt_email.html", ctx), "text/html")
    msg.attach(receipt_filename(p), render_pdf(p), "application/pdf")
    msg.send(fail_silently=False)
    return to
