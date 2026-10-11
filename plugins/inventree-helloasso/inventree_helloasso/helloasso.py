"""Client minimal de l'API HelloAsso v5 (OAuth2 client_credentials + Checkout).

Seuls deux appels servent : creer un checkout-intent et le relire. La relecture
est la SEULE preuve de paiement retenue : HelloAsso n'y joint la commande
(cle 'order') qu'une fois le paiement autorise.
"""

import requests
from django.core.cache import cache

API_BASES = {
    "sandbox": "https://api.helloasso-sandbox.com",
    "production": "https://api.helloasso.com",
}
TIMEOUT = 15


class HelloAssoError(Exception):
    """Erreur d'appel a l'API HelloAsso (message lisible + code HTTP)."""

    def __init__(self, message, status=None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


class HelloAssoClient:
    """Acces a l'API pour une organisation donnee."""

    def __init__(self, env, client_id, client_secret, org_slug):
        self.base = API_BASES.get(env, API_BASES["sandbox"])
        self.client_id = client_id
        self.client_secret = client_secret
        self.org_slug = org_slug

    def _token(self):
        # jeton mis en cache (valable ~30 min chez HelloAsso) : evite un
        # aller-retour OAuth a chaque achat
        key = f"helloasso_token:{self.base}:{self.client_id}"
        tok = cache.get(key)
        if tok:
            return tok
        try:
            r = requests.post(
                f"{self.base}/oauth2/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                },
                timeout=TIMEOUT,
            )
        except requests.RequestException as e:
            raise HelloAssoError(f"HelloAsso injoignable ({e.__class__.__name__})")
        if r.status_code != 200:
            raise HelloAssoError(
                "Identifiants HelloAsso refusés (vérifier Client ID / Secret)",
                r.status_code,
                r.text[:500],
            )
        data = r.json()
        tok = data["access_token"]
        cache.set(key, tok, max(60, int(data.get("expires_in", 1800)) - 120))
        return tok

    def _call(self, method, path, payload=None):
        url = f"{self.base}/v5/organizations/{self.org_slug}{path}"
        try:
            r = requests.request(
                method,
                url,
                json=payload,
                headers={"Authorization": f"Bearer {self._token()}"},
                timeout=TIMEOUT,
            )
        except requests.RequestException as e:
            raise HelloAssoError(f"HelloAsso injoignable ({e.__class__.__name__})")
        if r.status_code >= 400:
            raise HelloAssoError(f"HelloAsso a répondu {r.status_code}", r.status_code, r.text[:1000])
        return r.json() if r.content else None

    def create_checkout(self, payload):
        """POST checkout-intents -> {'id', 'redirectUrl'}."""
        return self._call("POST", "/checkout-intents", payload)

    def get_checkout(self, intent_id):
        """GET checkout-intents/<id> -> contient 'order' une fois paye."""
        return self._call("GET", f"/checkout-intents/{int(intent_id)}")
