#!/usr/bin/env bash
#
# delete-asso.sh — Supprime une asso COMPLÈTE en une seule commande.
#
# Fait, dans l'ordre :
#   1. arrête + supprime les conteneurs de la Scanette  (<nom>-scan)
#   2. arrête + supprime les conteneurs InvenTree        (<nom>-db / -cache / -server / -worker / -proxy)
#   3. retire la route de l'asso du Caddy frontal (~/front/Caddyfile) puis recharge le frontal
#   4. efface ~/<nom>/  (DÉFINITIF — données InvenTree + scanette)
#
# ⚠️ DÉFINITIF : toutes les données de l'asso sont perdues. Sauvegarde avant si besoin :
#      cp -r ~/<nom>/<nom>-data ~/backup-<nom>
#
# Usage :
#   ./delete-asso.sh <nom>
#
# Exemple :
#   ./delete-asso.sh pixeirb
#
set -euo pipefail

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

# 3. Retirer le bloc de cette asso du Caddy frontal, puis recharger
#    (le bloc — combiné /scan ou InvenTree seul — contient toujours "<nom>-proxy:80")
if [ -f "$FRONT/Caddyfile" ]; then
  awk -v alias="$NAME-proxy:80" 'BEGIN{RS="";ORS="\n\n"} $0 !~ alias' \
    "$FRONT/Caddyfile" > "$FRONT/Caddyfile.tmp"
  mv "$FRONT/Caddyfile.tmp" "$FRONT/Caddyfile"
  ( cd "$FRONT" && docker compose up -d --force-recreate ) || true
fi

# 4. Effacer les données (définitif ; sudo car le dossier appartient à root via Docker)
sudo rm -rf "$DIR"

echo ">> Asso '$NAME' supprimée (Scanette + InvenTree + route frontale + données)."
echo ">> (Avec un wildcard DNS *.<domaine>, rien à changer côté DNS.)"
