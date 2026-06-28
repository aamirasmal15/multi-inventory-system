#!/usr/bin/env bash
#
# auth/bootstrap-dex.sh — Déploie le broker Dex tout seul (1ʳᵉ fois).
#
# Optionnel : create-asso.sh le fait automatiquement au premier déploiement SSO.
# Pratique pour tester le broker avant de créer une asso, ou pour le régénérer.
#
# Fait : creds EirbConnect (réutilise eirbconnect.env), réseau, clamp MSS,
#        route frontale auth.<domaine> -> dex, génération config Dex + démarrage.
#
# Variables (optionnelles) :
#   BASE_DOMAIN   ton domaine (défaut: eirspace.fr) -> AUTH_DOMAIN = auth.<domaine>
#   AUTH_DOMAIN   surcharge directe du domaine du broker (défaut: auth.<BASE_DOMAIN>)
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BASE_DOMAIN="${BASE_DOMAIN:-eirspace.fr}"

# réseau partagé (créé s'il manque)
docker network create inventree-front 2>/dev/null || true

. "$SCRIPT_DIR/../lib/sso.sh"

dex_ensure_up

# --- Enregistrement automatique de la Scanette comme client public ---
mkdir -p "$DEX_CLIENTS_DIR"
cat > "$DEX_CLIENTS_DIR/scanette.yaml" <<EOF
  - id: 'inventree-scanette'
    name: 'Scanette Multi-Inventory'
    public: true
    redirectURIs:
      - 'https://scanette.$BASE_DOMAIN/'
EOF
# ---------------------------------------------------------------------

dex_render_and_reload

echo ""
echo ">> Dex prêt sur $DEX_ISSUER"
echo ">>   discovery : $DEX_ISSUER/.well-known/openid-configuration"
echo ">>   callback amont (déjà enregistré côté Eirbware) : $DEX_ISSUER/callback"
echo ">> Vérifie : curl -s $DEX_ISSUER/.well-known/openid-configuration | head -c 200"
