"""Recu d'achat : contexte commun, PDF (weasyprint, fourni par InvenTree) et e-mail.

Le meme contexte alimente l'ecran de la Scannette (via l'API), le PDF
telechargeable et l'e-mail : un membre du bureau voit partout le meme recu.
"""

import base64
import logging
import mimetypes

import requests
from django.conf import settings
from django.core.cache import cache
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


def plugin_setting(key):
    """Reglage du plugin paiements ("" si indisponible)."""
    try:
        from plugin import registry

        pl = registry.get_plugin("paiements")
        return (pl.get_setting(key) or "") if pl else ""
    except Exception:
        return ""


def logo_data_uri():
    """Logo de l'en-tete du PDF, embarque en data: URI (mis en cache 1 jour).

    Ordre : reglage RECEIPT_LOGO_URL, puis le logo de la Scannette de
    l'instance (img/<instance>-black.png), puis celui de l'asso principale
    (img/eirspace-black.png, present sur toutes les Scannettes). Aucun logo
    joignable -> en-tete sans image (jamais d'echec du recu pour ca).
    """
    site = (getattr(settings, "SITE_URL", None) or "").rstrip("/")
    inst = "".join(c for c in instance_name().lower() if c.isalnum())
    urls = [plugin_setting("RECEIPT_LOGO_URL").strip()]
    if site:
        urls += [f"{site}/scannette/img/{inst}-black.png" if inst else "", f"{site}/scannette/img/eirspace-black.png"]
    key = "paiements_logo:" + "|".join(urls)
    hit = cache.get(key)
    if hit is not None:
        return hit
    uri = ""
    for u in filter(None, urls):
        if not u.startswith(("https://", "http://")):
            continue
        try:
            # lecture bornee (3 Mo), sans redirection, PNG/JPEG/WebP seulement
            # (pas de SVG : weasyprint suivrait ses references externes)
            with requests.get(u, timeout=5, stream=True, allow_redirects=False) as r:
                ctype = (r.headers.get("Content-Type") or mimetypes.guess_type(u)[0] or "").split(";")[0].strip()
                if r.status_code != 200 or ctype not in ("image/png", "image/jpeg", "image/webp"):
                    continue
                data = b""
                for chunk in r.iter_content(65536):
                    data += chunk
                    if len(data) > 3_000_000:
                        data = b""
                        break
            if data:
                uri = f"data:{ctype};base64," + base64.b64encode(data).decode()
                break
        except requests.RequestException:
            continue
    # logo trouve : 1 jour ; echec (passager ?) : 10 min seulement
    cache.set(key, uri, 86400 if uri else 600)
    return uri


def receipt_context(p):
    """Tout ce que montre un recu, en valeurs deja formatees."""
    paid = timezone.localtime(p.paid_at or p.created_at)
    topup = p.kind == p.KIND_TOPUP
    lines = (
        [{"name": "Recharge du portefeuille", "quantity": 1, "unit": euros(p.amount_cents), "total": euros(p.amount_cents)}]
        if topup
        else [
            {
                "name": ln.name,
                "quantity": ln.quantity,
                "unit": euros(ln.unit_cents),
                "total": euros(ln.total_cents),
            }
            for ln in p.lines.all()
        ]
    )
    return {
        "instance": instance_name(),
        "asso": plugin_setting("ASSO_NAME") or instance_name(),
        "asso_address": plugin_setting("ASSO_ADDRESS"),
        "asso_contact": plugin_setting("ASSO_CONTACT"),
        "asso_id": plugin_setting("ASSO_ID"),
        "note": plugin_setting("RECEIPT_NOTE"),
        "buyer_email": buyer_email(p.user),
        "number": p.pk,
        "paid": p.status == p.STATUS_PAID,
        "date": paid.strftime("%d/%m/%Y"),
        "time": paid.strftime("%H:%M"),
        "buyer": buyer_name(p.user),
        "source": "Portefeuille" if topup else "Frigo",
        "location": p.location.name if p.location else "",
        "topup": topup,
        "lines": lines,
        "count": sum(ln["quantity"] for ln in lines),
        "total": euros(p.amount_cents),
        "by_wallet": p.method == p.METHOD_WALLET,
        "provider": "Portefeuille" if p.method == p.METHOD_WALLET else p.get_provider_display(),
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

    ctx = receipt_context(p)
    ctx["logo"] = logo_data_uri()
    html = render_to_string("paiements/receipt_pdf.html", ctx)
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
