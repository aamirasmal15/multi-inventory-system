"""Client minimal de l'API SumUp (paiements en ligne, cle API secrete).

Seuls deux appels servent : creer un checkout et le relire. La relecture est
la SEULE preuve de paiement retenue : statut PAID cote SumUp. Le formulaire
de carte (Payment Widget) tourne dans la Scannette et ne fait qu'executer le
checkout cree ici : montant et devise sont fixes par le serveur.
"""

import requests

API_BASE = "https://api.sumup.com"
TIMEOUT = 15


class SumUpError(Exception):
    """Erreur d'appel a l'API SumUp (message lisible + code HTTP)."""

    def __init__(self, message, status=None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


class SumUpClient:
    """Acces a l'API pour un compte marchand donne."""

    def __init__(self, api_key, merchant_code):
        self.api_key = api_key
        self.merchant_code = merchant_code

    def _call(self, method, path, payload=None):
        try:
            r = requests.request(
                method,
                f"{API_BASE}{path}",
                json=payload,
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=TIMEOUT,
            )
        except requests.RequestException as e:
            raise SumUpError(f"SumUp injoignable ({e.__class__.__name__})")
        if r.status_code == 401:
            raise SumUpError("Clé API SumUp refusée", 401, r.text[:500])
        if r.status_code >= 400:
            raise SumUpError(f"SumUp a répondu {r.status_code}", r.status_code, r.text[:1000])
        return r.json() if r.content else None

    def me(self):
        """Profil du compte marchand (sert au test de connexion)."""
        return self._call("GET", "/v0.1/me")

    def create_checkout(self, reference, amount_cents, description, return_url, redirect_url):
        """POST /checkouts -> {'id', 'status': 'PENDING', ...}."""
        return self._call("POST", "/v0.1/checkouts", {
            "checkout_reference": reference,
            "amount": round(amount_cents / 100, 2),
            "currency": "EUR",
            "merchant_code": self.merchant_code,
            "description": description,
            # webhook : SumUp y signale chaque changement de statut
            "return_url": return_url,
            # retour navigateur apres une etape 3-D Secure en pleine page
            "redirect_url": redirect_url,
        })

    def get_checkout(self, checkout_id):
        """GET /checkouts/<id> -> status PENDING / PAID / FAILED / EXPIRED."""
        return self._call("GET", f"/v0.1/checkouts/{checkout_id}")
