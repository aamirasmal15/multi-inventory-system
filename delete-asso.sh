#!/usr/bin/env bash
#
# delete-asso.sh — Supprime une asso COMPLÈTE en une seule commande.
#
# Fait, dans l'ordre :
#   1. arrête + supprime les conteneurs de la Scanette  (<nom>-scan)
#   2. arrête + supprime les conteneurs InvenTree        (<nom>-db / -cache / -server / -worker / -proxy)
#   3. retire la route de l'asso du Caddy frontal (~/front/Caddyfile) puis recharge le frontal
#   4. retire le client Dex de cette asso (fragment + régénération du broker)   ← nouveau
#   5. efface ~/<nom>/  (DÉFINITIF — données InvenTree + scanette)
#
# ⚠️ DÉFINITIF : toutes les données de l'asso sont perdues.
#    SAUVEGARDE AVANT si besoin (procédure complète dans le README, section « Sauvegarde / restauration ») :
#      cd ~/<nom> && docker compose down
#      sudo tar czf ~/backup-<nom>-$(date +%F).tgz -C ~ "<nom>/<nom>-data" "<nom>/.env"
#
# Usage :
#   ./delete-asso.sh <nom>
#
# Exemple :
#   ./delete-asso.sh pixeirb
#
set -euo pipefail

# ====== Emplacement du repo + fonctions partagées (pour retirer le client Dex) ======
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/lib/sso.sh" ]; then
  # shellcheck source=/dev/null
  . "$SCRIPT_DIR/lib/sso.sh"
  # Recharge le VRAI domaine (settings.env) pour régénérer Dex avec le bon issuer.
  [ -f "$SETTINGS_ENV_FILE" ] && . "$SETTINGS_ENV_FILE"
  AUTH_DOMAIN="auth.${BASE_DOMAIN:-eirspace.fr}"
  DEX_ISSUER="https://$AUTH_DOMAIN/oauth2"
else
  echo ">> (lib/sso.sh introuvable : on sautera le nettoyage du client Dex)" >&2
fi

NAME="${1:?Usage: ./delete-asso.sh <nom>}"
DIR="$HOME/$NAME"
FRONT="$HOME/front"

read -r -p "Supprimer DÉFINITIVEMENT l'asso '$NAME' (InvenTree + Scanette + TOUTES les données) ? (tape: oui) : " ANS
[ "$ANS" = "oui" ] || { echo "Annulé."; exit 1; }

# 1. Scanette (si présente)
if [ -d "$DIR/scanette" ]; then
  ( cd "$DIR/scanette" && docker compose down ) || true
fi

# 2. InvenTree
if [ -d "$DIR" ]; then
  ( cd "$DIR" && docker compose down ) || true
else
  echo ">> (dossier ~/$NAME introuvable, on continue le nettoyage)"
fi

# 3. Retirer les blocs de cette asso du Caddy frontal, puis recharger.
#    Deux blocs possibles : InvenTree (contient "<nom>-proxy:80") et Scanette (contient
#    "<nom>-scan:80"). Couvre aussi l'ancien bloc combiné `@scan` (il contenait les deux).
if [ -f "$FRONT/Caddyfile" ]; then
  awk -v a1="$NAME-proxy:80" -v a2="$NAME-scan:80" \
    'BEGIN{RS="";ORS="\n\n"} $0 !~ a1 && $0 !~ a2' \
    "$FRONT/Caddyfile" > "$FRONT/Caddyfile.tmp"
  mv "$FRONT/Caddyfile.tmp" "$FRONT/Caddyfile"
  ( cd "$FRONT" && docker compose up -d --force-recreate ) || true
fi

# 4. Retirer le client Dex de cette asso (supprime le fragment + régénère le broker)
if command -v dex_remove_client >/dev/null 2>&1; then
  echo ">> Retrait du client Dex 'inventree-$NAME' ..."
  dex_remove_client "$NAME" || true
fi

# 5. Effacer les données (définitif ; sudo car le dossier appartient à root via Docker)
sudo rm -rf "$DIR"

echo ">> Asso '$NAME' supprimée (Scanette + InvenTree + route frontale + client Dex + données)."
echo ">> (Avec un wildcard DNS *.<domaine>, rien à changer côté DNS.)"
