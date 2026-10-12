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

    def find_transaction(self, foreign_id):
        """Transaction encaissee par l'appli SumUp (Tap to Pay) d'apres notre reference, ou None.

        GET /v2.1/merchants/<code>/transactions?foreign_transaction_id=... ;
        404 = pas (encore) de transaction pour cette reference.
        """
        try:
            return self._call(
                "GET",
                f"/v2.1/merchants/{self.merchant_code}/transactions?foreign_transaction_id={requests.utils.quote(foreign_id)}",
            )
        except SumUpError as e:
            if e.status == 404:
                return None
            raise

    def get_transaction(self, transaction_code):
        """Transaction d'apres son code SumUp (TAAA...), ou None (404)."""
        try:
            return self._call(
                "GET",
                f"/v2.1/merchants/{self.merchant_code}/transactions?transaction_code={requests.utils.quote(transaction_code)}",
            )
        except SumUpError as e:
            if e.status in (400, 404):
                return None
            raise

    def transactions_between(self, oldest, newest, limit=50):
        """Transactions du compte entre deux instants (datetime UTC), plus recentes d'abord."""
        q = (
            f"limit={limit}&order=descending"
            f"&oldest_time={requests.utils.quote(oldest.strftime('%Y-%m-%dT%H:%M:%SZ'))}"
            f"&newest_time={requests.utils.quote(newest.strftime('%Y-%m-%dT%H:%M:%SZ'))}"
        )
        res = self._call("GET", f"/v2.1/merchants/{self.merchant_code}/transactions/history?{q}") or {}
        return res.get("items") or []

    def get_checkout(self, checkout_id):
        """GET /checkouts/<id> -> status PENDING / PAID / FAILED / EXPIRED."""
        return self._call("GET", f"/v0.1/checkouts/{checkout_id}")
