#!/usr/bin/env bash
#
# delete-asso.sh : supprime une asso complète en une commande.
#
# Dans l'ordre : conteneurs Scannette, conteneurs InvenTree, route du Caddy
# frontal, client Dex, puis le dossier ~/assos/<nom>/ (DÉFINITIF, données
# comprises). Gère aussi les assos encore à l'ancien emplacement ~/<nom>/.
#
# Trois sécurités avant toute destruction :
#   1. retaper le NOM EXACT de l'asso (pas un simple « oui »)
#   2. mot de passe sudo redemandé à chaque fois (sudo -k invalide le cache) :
#      un terminal SSH resté ouvert ne suffit pas pour supprimer
#   3. backup automatique (<nom>-data + .env) dans ~/backups/, rendu immuable
#      (chattr +i) : même un `sudo rm` ne l'efface pas sans `sudo chattr -i`
#
# Les backups de plus de RETENTION_DAYS jours (défaut 30) sont purgés chaque
# jour à 4h par une tâche auto-installée à la première suppression : cron root
# si crontab existe, sinon timer systemd (Debian minimal n'a pas cron). La tâche
# appelle `delete-asso.sh --purge-backups`, qui sort avant toute question
# interactive : aucun risque qu'un cron déclenche une suppression d'asso.
# Log : /var/log/purge-backups.log
#
# Usage :
#   ./delete-asso.sh <nom>
#   ./delete-asso.sh --purge-backups
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
CRON_MARK="delete-asso.sh --purge-backups"

# Purge les backups plus vieux que RETENTION_DAYS (lève d'abord l'immutabilité).
purge_old_backups() {
  [ -d "$BACKUP_DIR" ] || return 0
  local found=0
  while IFS= read -r -d '' f; do
    found=1
    sudo chattr -i "$f" 2>/dev/null || true
    sudo rm -f "$f"
    echo ">> Backup purgé (> $RETENTION_DAYS jours) : $f"
  done < <(find "$BACKUP_DIR" -name 'backup-*.tgz' -mtime "+$RETENTION_DAYS" -print0)
  if [ "$found" = "0" ]; then
    echo ">> Aucun backup de plus de $RETENTION_DAYS jours à purger."
  fi
}

# Installe (une seule fois) la purge quotidienne : crontab root si présent,
# sinon timer systemd. Si aucun des deux, on prévient sans bloquer la suppression.
ensure_purge_cron() {
  local self; self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  if command -v crontab >/dev/null 2>&1; then
    if ! sudo crontab -l 2>/dev/null | grep -qF "$CRON_MARK"; then
      ( sudo crontab -l 2>/dev/null || true
        echo "0 4 * * * BACKUP_DIR=$BACKUP_DIR RETENTION_DAYS=$RETENTION_DAYS $self --purge-backups >> /var/log/purge-backups.log 2>&1"
      ) | sudo crontab -
      echo ">> Cron de purge installé (root, tous les jours à 4h, rétention $RETENTION_DAYS jours)."
    fi
  elif [ -d /run/systemd/system ]; then
    if [ ! -f /etc/systemd/system/purge-asso-backups.timer ]; then
      sudo tee /etc/systemd/system/purge-asso-backups.service >/dev/null <<EOF
[Unit]
Description=Purge des backups d'assos de plus de $RETENTION_DAYS jours

[Service]
Type=oneshot
Environment=BACKUP_DIR=$BACKUP_DIR
Environment=RETENTION_DAYS=$RETENTION_DAYS
ExecStart=$self --purge-backups
StandardOutput=append:/var/log/purge-backups.log
StandardError=append:/var/log/purge-backups.log
EOF
      sudo tee /etc/systemd/system/purge-asso-backups.timer >/dev/null <<EOF
[Unit]
Description=Purge quotidienne des backups d'assos

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
      sudo systemctl daemon-reload
      sudo systemctl enable --now purge-asso-backups.timer
      echo ">> Timer systemd de purge installé (tous les jours à 4h, rétention $RETENTION_DAYS jours)."
      echo ">> (le retirer un jour : sudo systemctl disable --now purge-asso-backups.timer)"
    fi
  else
    echo ">> ⚠️  Ni crontab ni systemd : purge automatique NON installée."
    echo ">>    Purge manuelle : $self --purge-backups"
  fi
}

# Mode purge seule (appelé par le cron root ; sort avant toute question interactive)
if [ "${1:-}" = "--purge-backups" ]; then
  purge_old_backups
  exit 0
fi

# Fonctions partagées (retrait du client Dex) + swap dynamique.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/lib/sso.sh" ]; then
  # shellcheck source=/dev/null
  . "$SCRIPT_DIR/lib/sso.sh"
  # recharge le vrai domaine (settings.env) pour régénérer Dex avec le bon issuer
  [ -f "$SETTINGS_ENV_FILE" ] && . "$SETTINGS_ENV_FILE"
  AUTH_DOMAIN="auth.${BASE_DOMAIN:-eirspace.fr}"
  DEX_ISSUER="https://$AUTH_DOMAIN/oauth2"
else
  echo ">> (lib/sso.sh introuvable : on sautera le nettoyage du client Dex)" >&2
fi
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/lib/swap.sh" ] && . "$SCRIPT_DIR/lib/swap.sh"

NAME="${1:?Usage: ./delete-asso.sh <nom>}"
DEPLOY_ROOT="${DEPLOY_ROOT:-$HOME/assos}"
DIR="$DEPLOY_ROOT/$NAME"
if [ ! -d "$DIR" ] && [ -d "$HOME/$NAME" ]; then
  DIR="$HOME/$NAME"
  echo ">> (asso trouvée à l'ancien emplacement : $DIR)"
fi
FRONT="$HOME/front"

# ====== Sécurité 1 : retaper le nom exact de l'asso ======
echo "⚠️  Suppression DÉFINITIVE de '$NAME' (InvenTree + Scannette + TOUTES les données)."
read -r -p "Pour confirmer, retape le nom exact de l'asso : " ANS
[ "$ANS" = "$NAME" ] || { echo "Le nom ne correspond pas. Annulé."; exit 1; }

# ====== Sécurité 2 : authentification sudo fraîche (pas de cache) ======
sudo -k
echo ">> Confirme ton identité (mot de passe sudo) :"
sudo -v || { echo "Authentification refusée. Annulé."; exit 1; }

# ====== Cron de purge auto-installé (première fois seulement) ======
ensure_purge_cron

# ====== Sécurité 3 : backup automatique immuable AVANT toute destruction ======
if [ -d "$DIR" ]; then
  mkdir -p "$BACKUP_DIR"
  BK="$BACKUP_DIR/backup-$NAME-$(date +%F-%H%M%S).tgz"
  echo ">> Backup de sécurité vers $BK ..."
  # on arrête d'abord l'instance pour un état cohérent de la base
  ( cd "$DIR" && docker compose down ) || true
  TAR_ITEMS=()
  [ -d "$DIR/$NAME-data" ] && TAR_ITEMS+=("$NAME/$NAME-data")
  [ -f "$DIR/.env" ]       && TAR_ITEMS+=("$NAME/.env")
  if [ ${#TAR_ITEMS[@]} -gt 0 ]; then
    sudo tar czf "$BK" -C "$(dirname "$DIR")" "${TAR_ITEMS[@]}"
    if sudo chattr +i "$BK" 2>/dev/null; then
      echo ">> Backup OK (immuable). Pour le supprimer un jour : sudo chattr -i '$BK' && sudo rm '$BK'"
    else
      echo ">> Backup OK. (chattr non supporté sur ce FS : backup non immuable)"
    fi
  else
    echo ">> (rien à sauvegarder : ni $NAME-data ni .env trouvés)"
  fi
fi

# 1. Scannette (les deux graphies de dossier, le conteneur est le même : <nom>-scan)
for _sdir in "$DIR/scannette" "$DIR/scanette"; do
  if [ -d "$_sdir" ]; then
    ( cd "$_sdir" && docker compose down ) || true
  fi
done

# 2. InvenTree (déjà arrêté par le backup si le dossier existait, on s'en assure)
if [ -d "$DIR" ]; then
  ( cd "$DIR" && docker compose down ) || true
else
  echo ">> (dossier $DIR introuvable, on continue le nettoyage)"
fi

# 3. Retirer les blocs de cette asso du Caddy frontal (InvenTree + Scannette,
#    y compris l'ancien bloc combiné), puis recharger le frontal.
if [ -f "$FRONT/Caddyfile" ]; then
  awk -v a1="$NAME-proxy:80" -v a2="$NAME-scan:80" \
    'BEGIN{RS="";ORS="\n\n"} $0 !~ a1 && $0 !~ a2' \
    "$FRONT/Caddyfile" > "$FRONT/Caddyfile.tmp"
  mv "$FRONT/Caddyfile.tmp" "$FRONT/Caddyfile"
  # pages d'avertissement mobile de l'asso (générée + personnalisation éventuelle)
  rm -f "$FRONT/pages/mobile-warning-$NAME.html" "$FRONT/pages/mobile-warning-$NAME.custom.html"
  ( cd "$FRONT" && docker compose up -d --force-recreate ) || true
fi

# 4. Retirer le client Dex de cette asso (fragment supprimé + broker régénéré)
if command -v dex_remove_client >/dev/null 2>&1; then
  echo ">> Retrait du client Dex 'inventree-$NAME' ..."
  dex_remove_client "$NAME" || true
fi

# 5. Effacer les données (définitif ; sudo car le dossier appartient à root via Docker)
sudo rm -rf "$DIR"

# 6. Réajuster le swap disque à la baisse : ne retire que nos chunks de 2 Go,
#    et seulement si l'évacuation est sûre.
if command -v manage_swap >/dev/null 2>&1; then manage_swap || true; fi

echo ">> Asso '$NAME' supprimée (Scannette + InvenTree + route frontale + client Dex + données)."
echo ">> Backup de sécurité conservé dans $BACKUP_DIR (immuable, purgé après $RETENTION_DAYS jours)."
echo ">> (Avec un wildcard DNS *.<domaine>, rien à changer côté DNS.)"
