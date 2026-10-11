"""Taches de fond du plugin (executees par le worker InvenTree)."""

import logging

logger = logging.getLogger("inventree")


def send_receipt(pk):
    """Envoie le recu d'un achat paye, une seule fois."""
    from .models import Purchase
    from .receipt import send_receipt_email

    p = Purchase.objects.filter(pk=pk, status=Purchase.STATUS_PAID).first()
    if p is None or p.receipt_sent_to:
        return
    try:
        to = send_receipt_email(p)
    except Exception:
        logger.exception("Paiements : envoi du reçu de l'achat #%s impossible", pk)
        return
    if to:
        Purchase.objects.filter(pk=pk).update(receipt_sent_to=to)
