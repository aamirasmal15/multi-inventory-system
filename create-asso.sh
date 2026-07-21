#!/usr/bin/env bash
#
# create-asso.sh : déploie (ou met à jour) une asso complète en une commande.
# InvenTree + Scannette + SSO EirbConnect, le tout derrière le Caddy frontal.
#
# Usage :
#   ./create-asso.sh <nom> [sous-domaine|tmp] [mot-de-passe-admin]
#   ./create-asso.sh --reconfigure     (ré-éditer domaine / version épinglée / SMTP)
#
#   <nom>           nom interne de l'asso (eirspace, bde, vost...)
#   [sous-domaine]  label du sous-domaine InvenTree. Absent : "inventaire" pour
#                   l'asso principale, "inventaire-<nom>" pour les autres.
#                   "tmp" : instance éphémère sur sslip.io, sans DNS ni SSO.
#   [mot-de-passe]  mot de passe superadmin (généré si absent)
#
# Exemples :
#   ./create-asso.sh eirspace                     -> https://inventaire.eirspace.fr
#   ./create-asso.sh vost                         -> https://inventaire-vost.eirspace.fr
#   ./create-asso.sh demo tmp                     -> https://demo.<ip>.sslip.io
#   INVENTREE_VERSION=1.5.0 ./create-asso.sh vost    met à jour CETTE asso seulement
#
# Relancer = mettre à jour : le .env est préservé, les blocs SSO et Caddy sont
# remplacés, jamais dupliqués. Tout vit dans ~/assos/<nom>/ (DEPLOY_ROOT pour
# changer d'emplacement). Le premier run sur un VPS neuf installe les prérequis
# (Docker, swap, zram, earlyoom) et demande une seule fois le domaine, les
# identifiants EirbConnect et le SMTP, stockés dans ~/.config/multi-inventory/.
#
# Variables utiles : WITH_SCANNETTE=0 (InvenTree seul), ENABLE_SSO=0,
# LOGO=/chemin (logo de l'asso, rangé une fois pour toutes), MAIN_ASSO,
# MAIN_SUBDOMAIN, MAIN_BRAND_NAME, BRAND_NAME, ADMIN_EMAIL, SCAN_HOST, SCAN_SRC.
# Le détail complet est dans le wiki (pages "Déployer une asso" et
# "Réglages et variables").
#
set -euo pipefail

# L'utilisateur a-t-il fixé domaine/version via l'environnement ? À noter AVANT
# de sourcer lib/sso.sh (qui pose des défauts) pour distinguer un override
# volontaire d'une valeur par défaut.
_DOMAIN_SET="${BASE_DOMAIN+1}"
_VER_SET="${INVENTREE_VERSION+1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$SCRIPT_DIR/templates"

# Tous les fichiers générés (compose, confs nginx, blocs Caddy...) viennent de
# templates/ : un seul endroit où les lire et les modifier.
require_template() {
  [ -f "$TEMPLATES_DIR/$1" ] || {
    echo "ERREUR : $TEMPLATES_DIR/$1 introuvable." >&2
    echo "         Récupère le dossier templates/ du repo (au même niveau que create-asso.sh)." >&2
    exit 1
  }
}

# Extrait une section d'un template multi-sections (scannette.tpl,
# caddy-blocks.conf), délimitée par une ligne "### <nom> ###".
extract_section() {
  local file="$1" name="$2"
  awk -v name="$name" '
    $0 == "### " name " ###" { in_section=1; next }
    /^### .* ###$/            { in_section=0 }
    in_section                { print }
  ' "$file"
}

# Fonctions partagées : Dex/SSO/SMTP (lib/sso.sh) + swap dynamique (lib/swap.sh).
if [ ! -f "$SCRIPT_DIR/lib/sso.sh" ]; then
  echo "ERREUR : $SCRIPT_DIR/lib/sso.sh introuvable. Récupère le dossier lib/ du repo." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/sso.sh"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/lib/swap.sh" ] && . "$SCRIPT_DIR/lib/swap.sh"

case "${1:-}" in
  --reconfigure|reconfigure)
    reconfigure_platform
    exit 0
    ;;
esac

# ====== Configuration ======
# Domaine + version InvenTree épinglée : chargés depuis settings.env (demandés
# au premier run). Un override d'environnement ponctuel reste respecté.
load_platform_settings "$_DOMAIN_SET" "$_VER_SET"
SCAN_SRC="${SCAN_SRC:-$SCRIPT_DIR/scannette-src}"
WITH_SCANNETTE="${WITH_SCANNETTE:-1}"

# L'asso principale a un sous-domaine FIXE ("inventaire", pas "inventaire-<nom>"),
# pour que `./create-asso.sh eirspace` retombe toujours sur la même URL.
MAIN_ASSO="${MAIN_ASSO:-eirspace}"
MAIN_SUBDOMAIN="${MAIN_SUBDOMAIN:-inventaire}"
MAIN_SCAN_SUBDOMAIN="${MAIN_SCAN_SUBDOMAIN:-scannette}"
# Graphie affichée de l'asso principale (lockup collab + MAIN_BRAND du front).
MAIN_BRAND_NAME="${MAIN_BRAND_NAME:-$(printf '%s' "$MAIN_ASSO" | tr '[:lower:]' '[:upper:]')}"

# ====== Branding : logos par asso ======
# Nommés <nom>-white.png / <nom>-black.png, résolus par nom dans cet ordre :
# magasin runtime ~/.config/multi-inventory/logos/ (déposé via LOGO=, prime sur
# tout), puis défaut versionné assets/logos/ ; à défaut un logo legacy déjà dans
# html/img/ de l'instance, sinon repli texte (initiale). Voir assets/logos/README.md.
LOGO_STORE="${LOGO_STORE:-$HOME/.config/multi-inventory/logos}"
LOGO_ASSETS="$SCRIPT_DIR/assets/logos"

# Résout le logo d'une asso -> BR_WHITE / BR_BLACK (chemins absolus, vides si
# aucun ; une seule variante trouvée sert pour les deux thèmes).
brand_src() {
  local a="$1" dir
  BR_WHITE=""; BR_BLACK=""
  for dir in "$LOGO_STORE" "$LOGO_ASSETS"; do
    if [ -z "$BR_WHITE" ] && [ -f "$dir/$a-white.png" ]; then BR_WHITE="$dir/$a-white.png"; fi
    if [ -z "$BR_BLACK" ] && [ -f "$dir/$a-black.png" ]; then BR_BLACK="$dir/$a-black.png"; fi
  done
  if [ -z "$BR_WHITE" ] && [ -n "$BR_BLACK" ]; then BR_WHITE="$BR_BLACK"; fi
  if [ -z "$BR_BLACK" ] && [ -n "$BR_WHITE" ]; then BR_BLACK="$BR_WHITE"; fi
}

# ====== EirbConnect (SSO OpenID Connect, via le broker Dex) ======
# Realm et hôte sont des constantes publiques d'Eirbware : rien à saisir,
# surchargeables par variable d'env si ça change un jour.
ENABLE_SSO="${ENABLE_SSO:-1}"
SSO_ENV_FILE="${SSO_ENV_FILE:-$HOME/.config/multi-inventory/eirbconnect.env}"
EIRBCONNECT_REALM="${EIRBCONNECT_REALM:-eirb}"
EIRBCONNECT_BASE_URL="${EIRBCONNECT_BASE_URL:-https://connect.vpn.eirb.fr}"
OIDC_PROVIDER_ID="${OIDC_PROVIDER_ID:-eirbconnect}"

# Email du compte admin (résolu plus bas : expéditeur SMTP si SSO, sinon admin@<nom>.local).
ADMIN_EMAIL="${ADMIN_EMAIL:-}"

# Identifiants EirbConnect : env > fichier local (hors repo) > saisie (une seule fois).
load_sso_credentials() {
  if [ -f "$SSO_ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$SSO_ENV_FILE"
  fi
  if [ -z "${EIRBCONNECT_CLIENT_ID:-}" ] || [ -z "${EIRBCONNECT_SECRET:-}" ]; then
    if [ -t 0 ]; then
      echo ">> Identifiants EirbConnect (demandés une seule fois, stockés HORS du repo)"
      [ -z "${EIRBCONNECT_CLIENT_ID:-}" ] && read -rp  "   Client ID     : " EIRBCONNECT_CLIENT_ID
      [ -z "${EIRBCONNECT_SECRET:-}" ]    && { read -rsp "   Client secret : " EIRBCONNECT_SECRET; echo; }
      mkdir -p "$(dirname "$SSO_ENV_FILE")"
      ( umask 077; cat > "$SSO_ENV_FILE" <<EOF
EIRBCONNECT_CLIENT_ID='$EIRBCONNECT_CLIENT_ID'
EIRBCONNECT_SECRET='$EIRBCONNECT_SECRET'
EOF
      )
      chmod 600 "$SSO_ENV_FILE"
      echo ">> Enregistrés dans $SSO_ENV_FILE (non versionné, chmod 600)"
    fi
  fi
}

# Mot de passe superadmin : 12 caractères, au moins une majuscule, une minuscule,
# un chiffre et un spécial. Jeu de spéciaux restreint (!%+=_-) exprès : pas de
# $ ` " ' \ # ni espace, pour ne rien casser dans le .env (docker compose y
# interpole $VAR), les sed qui le retouchent, ni le Basic auth de lib/finalize.py.
gen_admin_pw() {
  local pw
  while :; do
    pw="$(LC_ALL=C tr -dc 'A-Za-z0-9!%+=_-' < /dev/urandom | head -c 12)"
    [[ "$pw" =~ [A-Z] ]] && [[ "$pw" =~ [a-z] ]] \
      && [[ "$pw" =~ [0-9] ]] && [[ "$pw" =~ [!%+=_-] ]] && break
  done
  printf '%s' "$pw"
}

# ====== Arguments ======
NAME="${1:?Usage: ./create-asso.sh <nom> [sous-domaine|tmp] [mot-de-passe-admin]}"
SUBDOMAIN="${2:-}"
ADMIN_PW="${3:-$(gen_admin_pw)}"
DB_PW="$(openssl rand -hex 16)"   # jamais montré à un humain : l'hex suffit

# ====== Emplacement : ~/assos/<nom> (surchargeable via DEPLOY_ROOT) ======
DEPLOY_ROOT="${DEPLOY_ROOT:-$HOME/assos}"
mkdir -p "$DEPLOY_ROOT"
DIR="$DEPLOY_ROOT/$NAME"

# Migration automatique d'une asso encore à l'ancien emplacement ~/<nom>/ :
# on arrête ses conteneurs (ils retiennent les anciens chemins des volumes),
# on déplace le dossier, et le run continue normalement.
OLD_DIR="$HOME/$NAME"
if [ "$OLD_DIR" != "$DIR" ] && [ -d "$OLD_DIR" ] && [ ! -d "$DIR" ] \
   && [ -f "$OLD_DIR/docker-compose.yml" ] && [ -f "$OLD_DIR/.env" ]; then
  echo ">> Asso '$NAME' trouvée à l'ancien emplacement ($OLD_DIR) : migration vers $DIR ..."
  if [ -d "$OLD_DIR/scannette" ]; then
    ( cd "$OLD_DIR/scannette" && docker compose down ) || true
  fi
  if [ -d "$OLD_DIR/scanette" ]; then
    ( cd "$OLD_DIR/scanette" && docker compose down ) || true
  fi
  ( cd "$OLD_DIR" && docker compose down ) || true
  mv "$OLD_DIR" "$DIR"
  echo ">> Migration terminée : $DIR"
fi

ADMIN_USER="superadmin_$NAME"
FRONT="$HOME/front"

# ====== Prérequis système : bootstrap automatique (premier run sur VPS neuf) ======
# Docker, swap disque, zram et earlyoom sont installés s'ils manquent (il faut
# juste sudo). Chaque brique vérifie l'état réel du système : sur un hôte déjà
# configuré, cette section est un no-op de quelques millisecondes.
_sudo() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

# --- Docker (+ plugin compose), depuis le dépôt officiel ---
if ! command -v docker >/dev/null 2>&1; then
  echo ">> Docker absent : installation (une seule fois, dépôt officiel) ..."
  _sudo apt-get update -qq
  _sudo apt-get install -y -qq ca-certificates curl gnupg wget openssl dnsutils
  _sudo install -m 0755 -d /etc/apt/keyrings
  _OS_ID="$(. /etc/os-release && echo "$ID")"                 # debian ou ubuntu
  _OS_CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  curl -fsSL "https://download.docker.com/linux/$_OS_ID/gpg" \
    | _sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  _sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$_OS_ID $_OS_CODENAME stable" \
    | _sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  _sudo apt-get update -qq
  _sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  _sudo systemctl enable --now docker >/dev/null 2>&1 || true
fi
# Si l'utilisateur vient d'être ajouté au groupe docker, le shell courant ne le
# sait pas encore : on reprend le script sous ce groupe (sg), une seule fois
# (_BOOTSTRAP_SG garde contre toute boucle).
if ! docker ps >/dev/null 2>&1; then
  if [ "$(id -u)" != 0 ] && [ "${_BOOTSTRAP_SG:-}" != 1 ]; then
    id -nG | grep -qw docker || { echo ">> Ajout de $USER au groupe docker ..."; _sudo usermod -aG docker "$USER"; }
    echo ">> Reprise du script avec le groupe docker (pas besoin de te reconnecter) ..."
    export _BOOTSTRAP_SG=1
    exec sg docker -c "$(printf '%q ' "$SCRIPT_DIR/$(basename "$0")" "$@")"
  fi
  echo "ERREUR : le démon Docker ne répond pas (docker ps). Vérifie : systemctl status docker" >&2
  exit 1
fi

# --- Swap disque 4 Go (/swapfile) : filet de sécurité sous zram ---
# Sauté si un swap disque existe déjà (fourni par le VPS, ou déjà créé).
if [ ! -f /swapfile ] && ! awk 'NR>1 && $1 !~ /zram/ {found=1} END{exit !found}' /proc/swaps 2>/dev/null; then
  echo ">> Aucun swap disque : création de /swapfile (4 Go, une seule fois) ..."
  _sudo fallocate -l 4G /swapfile 2>/dev/null || _sudo dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
  _sudo chmod 600 /swapfile
  _sudo mkswap /swapfile >/dev/null
  if ! _sudo swapon /swapfile 2>/dev/null; then
    # fichier « à trous » (fallocate sur certains FS) : on recrée plein, avec dd
    _sudo rm -f /swapfile
    _sudo dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
    _sudo chmod 600 /swapfile && _sudo mkswap /swapfile >/dev/null && _sudo swapon /swapfile
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | _sudo tee -a /etc/fstab >/dev/null
fi

# --- zram : swap compressé en RAM (voir wiki, page Performance et mémoire) ---
# Configuré à l'installation du paquet seulement : une config retouchée à la
# main ensuite n'est jamais écrasée par les re-runs.
if ! dpkg -s zram-tools >/dev/null 2>&1; then
  echo ">> zram absent : installation (zstd, capacité 100 % de la RAM) ..."
  _sudo apt-get update -qq
  _sudo apt-get install -y -qq zram-tools
  for _kv in ALGO=zstd PERCENT=100 PRIORITY=100; do
    _k="${_kv%%=*}"
    if grep -q "^#\?\s*$_k=" /etc/default/zramswap 2>/dev/null; then
      _sudo sed -i "s/^#\?\s*$_k=.*/$_kv/" /etc/default/zramswap
    else
      echo "$_kv" | _sudo tee -a /etc/default/zramswap >/dev/null
    fi
  done
  # un simple restart ne réapplique PAS la config si le module tourne déjà
  _sudo systemctl stop zramswap 2>/dev/null || true
  _sudo rmmod zram 2>/dev/null || true
  _sudo systemctl enable --now zramswap
  echo 'vm.swappiness=100' | _sudo tee /etc/sysctl.d/99-zram.conf >/dev/null
  _sudo sysctl -q -p /etc/sysctl.d/99-zram.conf
fi

# --- earlyoom : garde-fou anti-freeze (indispensable avec beaucoup de swap) ---
if ! dpkg -s earlyoom >/dev/null 2>&1; then
  echo ">> earlyoom absent : installation (garde-fou anti-freeze) ..."
  _sudo apt-get update -qq
  _sudo apt-get install -y -qq earlyoom
  # seuils calés sur l'incident du 2026-07-08 : <8 % RAM dispo ET <35 % swap libre
  printf 'EARLYOOM_ARGS="-m 8 -s 35 -r 3600 --avoid \x27(^|/)(sshd|systemd.*|dockerd|containerd|journald)$\x27"\n' \
    | _sudo tee /etc/default/earlyoom >/dev/null
  _sudo systemctl restart earlyoom
fi

# ====== Réseau partagé ======
docker network create inventree-front 2>/dev/null || true

# ====== Templates requis à chaque run ======
require_template "inventree-docker-compose.yml"
require_template "caddy-blocks.conf"

# ====== Caddy frontal : créé s'il manque (une seule fois) ======
if [ ! -f "$FRONT/docker-compose.yml" ]; then
  echo ">> Caddy frontal absent : création de ~/front ..."
  mkdir -p "$FRONT"
  require_template "front-docker-compose.yml"
  cp "$TEMPLATES_DIR/front-docker-compose.yml" "$FRONT/docker-compose.yml"
  touch "$FRONT/Caddyfile"
fi

# ====== Pages statiques du front (interstitiel mobile) ======
# Un front déployé avant cette fonctionnalité n'a pas le mount pages/ : on
# l'injecte dans son docker-compose.yml (le force-recreate final le prendra).
mkdir -p "$FRONT/pages"
if ! grep -q "pages:/srv/pages" "$FRONT/docker-compose.yml"; then
  echo ">> Front existant sans le mount pages/ : ajout dans $FRONT/docker-compose.yml"
  sed -i 's|- ./Caddyfile:/etc/caddy/Caddyfile:ro|&\n      - ./pages:/srv/pages:ro|' "$FRONT/docker-compose.yml"
fi

# ====== Scannette demandée : vérifier les sources AVANT de tout déployer ======
if [ "$WITH_SCANNETTE" = "1" ]; then
  [ -f "$SCAN_SRC/index.html" ] || {
    echo "ERREUR : $SCAN_SRC/index.html manquant." >&2
    echo "         Dépose les fichiers de l'app dans scannette-src/ (voir scannette-src/README.md)," >&2
    echo "         ou déploie InvenTree seul : WITH_SCANNETTE=0 ./create-asso.sh $NAME ..." >&2
    exit 1
  }
  [ -f "$SCAN_SRC/zxing_reader.wasm" ] || {
    echo "ERREUR : $SCAN_SRC/zxing_reader.wasm manquant (décodeur de codes-barres)." >&2
    exit 1
  }
  [ -f "$SCAN_SRC/js/boot.js" ] || {
    echo "ERREUR : $SCAN_SRC/js/boot.js manquant : l'arborescence de la Scannette est incomplète." >&2
    echo "         Attendu : index.html + css/ + js/ (voir scannette-src/README.md)." >&2
    exit 1
  }
  [ -f "$SCRIPT_DIR/templates/mobile-warning.html" ] || {
    echo "ERREUR : $SCRIPT_DIR/templates/mobile-warning.html manquant (page d'avertissement mobile)." >&2
    echo "         Récupère le dossier templates/ du repo (au même niveau que create-asso.sh)," >&2
    echo "         ou déploie InvenTree seul : WITH_SCANNETTE=0 ./create-asso.sh $NAME ..." >&2
    exit 1
  }
  require_template "scannette.tpl"
fi

# ====== Calcul des URL (InvenTree + Scannette sur sous-domaine dédié) ======
_SCAN_SET="${SCAN_HOST+1}"
if [ "$SUBDOMAIN" = "tmp" ] || [ -z "$BASE_DOMAIN" ]; then
  IP="$(curl -4 -s ifconfig.me)"; HOST="$NAME.${IP//./-}.sslip.io"   # éphémère / sans domaine
  [ -n "$_SCAN_SET" ] || SCAN_HOST="scannette-$NAME.${IP//./-}.sslip.io"
elif [ -n "$SUBDOMAIN" ]; then
  HOST="$SUBDOMAIN.$BASE_DOMAIN"            # sous-domaine InvenTree explicite (gagne toujours)
  if [ -z "$_SCAN_SET" ]; then             # ... mais la Scannette suit la convention par nom
    if [ "$NAME" = "$MAIN_ASSO" ]; then SCAN_HOST="$MAIN_SCAN_SUBDOMAIN.$BASE_DOMAIN"
    else                                    SCAN_HOST="scannette-$NAME.$BASE_DOMAIN"; fi
  fi
elif [ "$NAME" = "$MAIN_ASSO" ]; then
  HOST="$MAIN_SUBDOMAIN.$BASE_DOMAIN"       # asso principale -> inventaire.eirspace.fr
  [ -n "$_SCAN_SET" ] || SCAN_HOST="$MAIN_SCAN_SUBDOMAIN.$BASE_DOMAIN"
else
  HOST="inventaire-$NAME.$BASE_DOMAIN"
  [ -n "$_SCAN_SET" ] || SCAN_HOST="scannette-$NAME.$BASE_DOMAIN"
fi

echo ">> Asso '$NAME'  ->  https://$HOST"
[ "$WITH_SCANNETTE" = "1" ] && echo ">>   Scannette    ->  https://$SCAN_HOST"
mkdir -p "$DIR" && cd "$DIR"

# ====== SSO : identifiants prêts ? (demandés en amont du long 'invoke update') ======
SSO_READY=0
if [ "$ENABLE_SSO" = "1" ]; then
  if [[ "$HOST" == *.sslip.io ]]; then
    echo ">> SSO ignoré (instance éphémère sslip.io : la redirect URI ne serait pas autorisable côté Keycloak)."
  else
    load_sso_credentials
    if [ -n "${EIRBCONNECT_CLIENT_ID:-}" ] && [ -n "${EIRBCONNECT_SECRET:-}" ] && [ -n "${EIRBCONNECT_REALM:-}" ]; then
      SSO_READY=1
      # SMTP requis pour l'auto-création de comptes SSO (demandé une seule fois).
      load_smtp_credentials
      [ -z "$ADMIN_EMAIL" ] && ADMIN_EMAIL="${SMTP_SENDER:-admin@$NAME.local}"
    else
      echo ">> SSO demandé mais identifiants EirbConnect manquants (mode non interactif ?) : on continue SANS SSO." >&2
    fi
  fi
fi

# ====== Caddyfile interne InvenTree (HTTP simple, TLS terminé par le frontal) ======
wget -q https://raw.githubusercontent.com/inventree/InvenTree/stable/contrib/container/Caddyfile -O Caddyfile
sed -i 's|^{$INVENTREE_SITE_URL:"http://, https://"} {|:80 {|' Caddyfile
# trusted_proxies : sans ça, ce Caddy interne réécrit les X-Forwarded-* en http
# et Django génère des liens http:// dans les e-mails (connexion, activation,
# réinitialisation). Le bloc d'options global doit être le PREMIER du Caddyfile.
printf '{\n\tservers {\n\t\ttrusted_proxies static private_ranges\n\t}\n}\n\n' | cat - Caddyfile > Caddyfile.tmp && mv Caddyfile.tmp Caddyfile

# ====== .env (préservé s'il existe : les mots de passe ne changent pas) ======
UPGRADING=0
if [ -f .env ]; then
  KEEP_ENV=1
  echo ">> .env existant conservé (identifiants inchangés)"
  # Si la version demandée diffère du tag actuel : mise à jour du tag.
  CUR_TAG="$(sed -n 's/^INVENTREE_TAG=//p' .env | head -1)"
  if [ -n "${INVENTREE_VERSION:-}" ] && [ "$CUR_TAG" != "$INVENTREE_VERSION" ]; then
    echo ">> MISE À JOUR InvenTree : '$CUR_TAG' -> '$INVENTREE_VERSION' (migrations jouées par 'invoke update')."
    sed -i "s/^INVENTREE_TAG=.*/INVENTREE_TAG=$INVENTREE_VERSION/" .env
    UPGRADING=1
  fi
else
  KEEP_ENV=0
  # Bloc email : SMTP réel si SSO, sinon gabarit commenté.
  if [ "$SSO_READY" = "1" ]; then
    EMAIL_BLOCK="$(smtp_env_block)"
    ADMIN_EMAIL_LINE="INVENTREE_ADMIN_EMAIL=${ADMIN_EMAIL:-$SMTP_SENDER}"
  else
    ADMIN_EMAIL_LINE="INVENTREE_ADMIN_EMAIL=admin@$NAME.local"
    EMAIL_BLOCK="# --- Email/SMTP non configuré (SSO désactivé). Active le SSO pour le renseigner. ---
#INVENTREE_EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend
#INVENTREE_EMAIL_HOST=
#INVENTREE_EMAIL_PORT=587
#INVENTREE_EMAIL_USERNAME=
#INVENTREE_EMAIL_PASSWORD=
#INVENTREE_EMAIL_TLS=True
#INVENTREE_EMAIL_SENDER=noreply@$NAME.local"
  fi
  cat > .env <<EOF
COMPOSE_PROJECT_NAME=$NAME
INVENTREE_TAG=$INVENTREE_VERSION
INVENTREE_SITE_URL="https://$HOST"
INVENTREE_WEB_PORT=8000
INVENTREE_EXT_VOLUME=./$NAME-data
INVENTREE_USE_X_FORWARDED_HOST=True
INVENTREE_USE_X_FORWARDED_PORT=True
INVENTREE_USE_X_FORWARDED_PROTO=True
INVENTREE_BACKGROUND_WORKERS=1
INVENTREE_GUNICORN_WORKERS=1
INVENTREE_ADMIN_USER=$ADMIN_USER
INVENTREE_ADMIN_PASSWORD=$ADMIN_PW
$ADMIN_EMAIL_LINE
$EMAIL_BLOCK
INVENTREE_DB_ENGINE=postgresql
INVENTREE_DB_NAME=$NAME
INVENTREE_DB_HOST=inventree-db
INVENTREE_DB_PORT=5432
INVENTREE_DB_USER=$NAME
INVENTREE_DB_PASSWORD=$DB_PW
INVENTREE_CACHE_ENABLED=True
INVENTREE_CACHE_HOST=inventree-cache
INVENTREE_CACHE_PORT=6379
EOF
fi
# secrets lisibles par le seul propriétaire, appliqué à chaque run
chmod 600 .env

# ====== Origines CSRF de confiance (réécrit à chaque run) ======
# La Scannette vit sur un autre sous-domaine : ses POST/PATCH arrivent avec
# Origin=https://$SCAN_HOST, que Django doit connaître. ALLOWED_HOSTS reste
# sur '*' (config.yaml) pour les appels internes (worker, health-checks).
if [ "$WITH_SCANNETTE" = "1" ]; then
  TRUSTED_ORIGINS="https://$HOST,https://$SCAN_HOST"
else
  TRUSTED_ORIGINS="https://$HOST"
fi
sed -i '/^INVENTREE_TRUSTED_ORIGINS=/d' .env
echo "INVENTREE_TRUSTED_ORIGINS=$TRUSTED_ORIGINS" >> .env

# Langue par défaut de l'interface ET des notifications hors requête (tâche
# quotidienne du plugin Prêts). Ajoutée si absente : un choix manuel est respecté.
grep -q '^INVENTREE_LANGUAGE=' .env || echo "INVENTREE_LANGUAGE=fr" >> .env

# Fuseau horaire d'affichage. Sans lui InvenTree reste en UTC et les heures
# écrites dans les e-mails (notifications de compte allauth) sont décalées.
grep -q '^INVENTREE_TIMEZONE=' .env || echo "INVENTREE_TIMEZONE=Europe/Paris" >> .env

# ====== docker-compose.yml InvenTree ======
sed "s/__NAME__/$NAME/g" "$TEMPLATES_DIR/inventree-docker-compose.yml" > docker-compose.yml
docker compose config >/dev/null && echo ">> YAML InvenTree OK"

# Upgrade : récupérer la nouvelle image AVANT les migrations.
if [ "$UPGRADING" = "1" ]; then
  echo ">> Téléchargement de l'image InvenTree $INVENTREE_VERSION ..."
  docker compose pull inventree-server inventree-worker || true
fi

# ====== Branding : range le logo fourni via LOGO= dans le magasin ======
# LOGO = un dossier (white.png/black.png ou <nom>-white.png/<nom>-black.png,
# extensions png/jpg/jpeg/webp) ou un fichier unique (= les deux thèmes).
# LOGO= fait autorité : chaque thème fourni ÉCRASE le magasin, donc relancer
# avec un dossier enrichi (ex. on ajoute un black.png après coup) met bien le
# magasin à jour. On ne fabrique PAS ici le thème manquant : brand_src duplique
# à la pose si un seul thème existe — fabriquer un slot ici bloquerait l'ajout
# ultérieur du vrai thème. Sans LOGO=, on ne touche pas au magasin.
SW="$LOGO_STORE/$NAME-white.png"; SB="$LOGO_STORE/$NAME-black.png"
if [ -n "${LOGO:-}" ]; then
  if [ -d "$LOGO" ]; then
    mkdir -p "$LOGO_STORE"
    # premier nommage trouvé gagne PAR thème (_gotW/_gotB), et écrase le magasin.
    _gotW=""; _gotB=""
    for e in png jpg jpeg webp PNG JPG JPEG; do
      if [ -z "$_gotW" ] && [ -f "$LOGO/white.$e" ];        then cp -f "$LOGO/white.$e" "$SW"; _gotW=1; fi
      if [ -z "$_gotW" ] && [ -f "$LOGO/$NAME-white.$e" ];  then cp -f "$LOGO/$NAME-white.$e" "$SW"; _gotW=1; fi
      if [ -z "$_gotB" ] && [ -f "$LOGO/black.$e" ];        then cp -f "$LOGO/black.$e" "$SB"; _gotB=1; fi
      if [ -z "$_gotB" ] && [ -f "$LOGO/$NAME-black.$e" ];  then cp -f "$LOGO/$NAME-black.$e" "$SB"; _gotB=1; fi
    done
    if [ -z "$_gotW" ] && [ -z "$_gotB" ]; then
      _one="$(find "$LOGO" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' \) | sort | head -1)"
      if [ -n "$_one" ]; then cp -f "$_one" "$SW"; cp -f "$_one" "$SB"; fi
    fi
  elif [ -f "$LOGO" ]; then
    mkdir -p "$LOGO_STORE"; cp -f "$LOGO" "$SW"; cp -f "$LOGO" "$SB"
  else
    echo "!! LOGO=$LOGO introuvable (ni dossier ni fichier) : branding ignoré." >&2
  fi
  if [ -f "$SW" ] || [ -f "$SB" ]; then echo ">> Branding : logo de '$NAME' rangé dans le magasin ($LOGO_STORE)."; fi
fi

# ====== Initialisation / migration de la base (le -T évite un crash de TTY) ======
echo ">> invoke update (création/màj de la base, quelques minutes)..."
docker compose run --rm -T inventree-server invoke update

# Un seul background worker, sinon chaque worker supplémentaire coûte ~1 Go de RAM.
echo ">> Réglage background workers=1"
sudo sed -i '/^background:/,/^[^[:space:]]/ s/^\(\s*workers:\).*/\1 1/' "$DIR/$NAME-data/config.yaml"

# ====== Démarrage InvenTree ======
# (Le bloc SSO du config.yaml est injecté plus bas par setup_asso_sso, qui relance proprement.)
docker compose up -d

# ====== Scannette ======
if [ "$WITH_SCANNETTE" = "1" ]; then
  SCANDIR="$DIR/scannette"
  UPSTREAM="http://$NAME-proxy:80"
  echo ">> Build de la Scannette ($SCANDIR) ..."
  mkdir -p "$SCANDIR/html"

  # Copie récursive de l'app (index.html + css/ + js/ + wasm), sans les notes du
  # dossier source. tar écrase mais ne supprime rien : les fichiers propres à
  # l'asso déjà dans html/ (ex. logos déposés à la main) sont conservés.
  tar -C "$SCAN_SRC" \
      --exclude='README*' --exclude='*.md' --exclude='.gitkeep' \
      -cf - . | tar -C "$SCANDIR/html" -xf -

  # Logos résolus (magasin -> défaut repo) posés dans html/img/ :
  # celui de CETTE asso, puis celui de l'asso principale (lockup collab).
  # cp -f à CHAQUE run : ajouter/changer un logo dans assets/logos/ (ou via
  # LOGO=) puis relancer ./create-asso.sh <nom> suffit à repropager les deux
  # thèmes (Scannette) et le clair (InvenTree, plus bas). Un thème sombre ajouté
  # après coup est pris ici sans rien d'autre à faire.
  mkdir -p "$SCANDIR/html/img"
  brand_src "$NAME"
  if [ -n "$BR_WHITE" ]; then cp -f "$BR_WHITE" "$SCANDIR/html/img/$NAME-white.png"; echo ">> Logo '$NAME' thème clair  <- $BR_WHITE"; fi
  if [ -n "$BR_BLACK" ]; then cp -f "$BR_BLACK" "$SCANDIR/html/img/$NAME-black.png"; echo ">> Logo '$NAME' thème sombre <- $BR_BLACK"; fi
  if [ -z "$BR_WHITE" ] && [ -z "$BR_BLACK" ]; then echo ">> Logo '$NAME' : aucun trouvé (magasin + assets/logos vides) -> repli sur l'initiale."; fi
  brand_src "$MAIN_ASSO"
  if [ -n "$BR_WHITE" ]; then cp -f "$BR_WHITE" "$SCANDIR/html/img/$MAIN_ASSO-white.png"; fi
  if [ -n "$BR_BLACK" ]; then cp -f "$BR_BLACK" "$SCANDIR/html/img/$MAIN_ASSO-black.png"; fi

  # config.js : graphie et logos de l'asso principale, réinjectés à chaque run
  # (le tar vient de remettre les valeurs du repo). Rend l'asso principale
  # renommable sans toucher au front ; no-op pour MAIN_ASSO=eirspace.
  if ! printf '%s' "$MAIN_BRAND_NAME" | grep -Eq "^[A-Za-z0-9 ._'ÀÂÄÇÉÈÊËÎÏÔÖÙÛÜàâäçéèêëîïôöùûüœŒ-]+\$"; then
    echo "ERREUR : MAIN_BRAND_NAME contient des caractères non supportés : $MAIN_BRAND_NAME" >&2
    exit 1
  fi
  _cfg="$SCANDIR/html/js/core/config.js"
  sed -i "s|^const MAIN_BRAND = \"[^\"]*\";|const MAIN_BRAND = \"$MAIN_BRAND_NAME\";|" "$_cfg"
  sed -i "s|^const MAIN_LOGO_WHITE = \"[^\"]*\";|const MAIN_LOGO_WHITE = \"img/$MAIN_ASSO-white.png\";|" "$_cfg"
  sed -i "s|^const MAIN_LOGO_BLACK = \"[^\"]*\";|const MAIN_LOGO_BLACK = \"img/$MAIN_ASSO-black.png\";|" "$_cfg"
  # src initial du logo collab dans index.html (évite un flash 404 si renommée)
  sed -i "s|img/eirspace-white\.png|img/$MAIN_ASSO-white.png|g" "$SCANDIR/html/index.html"

  # BRAND = nom de cette asso, injecté à chaque run. C'est BRAND != MAIN_BRAND
  # qui déclenche le lockup collab « EIRSPACE × <asso> » au login. Pour l'asso
  # principale on ne touche rien. BRAND_NAME (env) surcharge la graphie.
  if [ "$NAME" != "$MAIN_ASSO" ]; then
    BRAND_VALUE="${BRAND_NAME:-$(printf '%s' "$NAME" | tr '[:lower:]' '[:upper:]')}"
    if ! printf '%s' "$BRAND_VALUE" | grep -Eq "^[A-Za-z0-9 ._'ÀÂÄÇÉÈÊËÎÏÔÖÙÛÜàâäçéèêëîïôöùûüœŒ-]+\$"; then
      echo "ERREUR : BRAND_NAME contient des caractères non supportés : $BRAND_VALUE" >&2
      exit 1
    fi
    sed -i "s|^const BRAND = \"[^\"]*\";|const BRAND = \"$BRAND_VALUE\";|" \
      "$SCANDIR/html/js/core/config.js"
    grep -q "^const BRAND = \"$BRAND_VALUE\";" "$SCANDIR/html/js/core/config.js" || {
      echo "ERREUR : injection de BRAND=\"$BRAND_VALUE\" dans config.js échouée." >&2
      exit 1
    }
    echo ">> Scannette : BRAND=\"$BRAND_VALUE\" injecté (lockup collab actif)."
  fi

  # Logos effectivement présents dans html/img/ (résolus ci-dessus ou déposés à
  # la main). Deux nommages acceptés, le premier trouvé gagne ; LOGO_WHITE /
  # LOGO_BLACK resservent plus bas pour l'interstitiel mobile.
  LOGO_WHITE=""; LOGO_BLACK=""
  for _cand in "$NAME-white.png" "logo-white.png"; do
    if [ -f "$SCANDIR/html/img/$_cand" ]; then LOGO_WHITE="$_cand"; break; fi
  done
  for _cand in "$NAME-black.png" "logo-black.png"; do
    if [ -f "$SCANDIR/html/img/$_cand" ]; then LOGO_BLACK="$_cand"; break; fi
  done
  # une seule variante : elle sert pour les deux thèmes
  if [ -z "$LOGO_WHITE" ] && [ -n "$LOGO_BLACK" ]; then
    LOGO_WHITE="$LOGO_BLACK"
    echo ">> Scannette : pas de variante white, $LOGO_BLACK servira pour les deux thèmes."
  fi
  if [ -z "$LOGO_BLACK" ] && [ -n "$LOGO_WHITE" ]; then
    LOGO_BLACK="$LOGO_WHITE"
    echo ">> Scannette : pas de variante black, $LOGO_WHITE servira pour les deux thèmes."
  fi
  # L'app charge img/logo-*.png par défaut : si le fichier résolu porte un autre
  # nom, on l'injecte dans config.js et dans index.html pour le white (sinon
  # flash 404 avant le swap d'applyTheme).
  if [ -n "$LOGO_WHITE" ] && [ "$LOGO_WHITE" != "logo-white.png" ]; then
    sed -i "s|^const LOGO_WHITE = \"[^\"]*\";|const LOGO_WHITE = \"img/$LOGO_WHITE\";|" \
      "$SCANDIR/html/js/core/config.js"
    sed -i "s|img/logo-white\.png|img/$LOGO_WHITE|g" "$SCANDIR/html/index.html"
    echo ">> Scannette : logo white = img/$LOGO_WHITE injecté."
  fi
  if [ -n "$LOGO_BLACK" ] && [ "$LOGO_BLACK" != "logo-black.png" ]; then
    sed -i "s|^const LOGO_BLACK = \"[^\"]*\";|const LOGO_BLACK = \"img/$LOGO_BLACK\";|" \
      "$SCANDIR/html/js/core/config.js"
    echo ">> Scannette : logo black = img/$LOGO_BLACK injecté."
  fi

  # ====== Le même logo pour InvenTree (customize.logo, PUI) ======
  # Copié vers static/img/custom_logo.png (servi public via /static/, pas /media/
  # qui est token-gated). À refaire à chaque run : 'invoke update' passe un
  # collectstatic --clear qui vide static/img aux upgrades. Pas de favicon (choix).
  if [ -n "$LOGO_WHITE" ] && [ -f "$SCANDIR/html/img/$LOGO_WHITE" ]; then
    IT_STATIC="$DIR/$NAME-data/static/img"
    sudo mkdir -p "$IT_STATIC"
    sudo cp -f "$SCANDIR/html/img/$LOGO_WHITE" "$IT_STATIC/custom_logo.png"
    # active customize.logo dans config.yaml (idempotent ; fichier root -> sudo)
    sudo python3 - "$DIR/$NAME-data/config.yaml" <<'PY'
import re, sys
p = sys.argv[1]
lines = open(p, encoding='utf-8').read().splitlines()
active_i = next((i for i, l in enumerate(lines)
                 if l.startswith('customize:') and not l.lstrip().startswith('#')), None)
if active_i is None:
    anchor = '#   splash: img/custom_splash.jpg'
    block = ['', '# --- Personnalisation : logo InvenTree (create-asso.sh) ---',
             'customize:', '  logo: img/custom_logo.png']
    i = lines.index(anchor) + 1 if anchor in lines else len(lines)
    lines[i:i] = block
    print('customize.logo activé dans config.yaml')
elif not any(re.match(r'\s+logo:\s', l) for l in lines[active_i + 1:]):
    lines[active_i + 1:active_i + 1] = ['  logo: img/custom_logo.png']
    print('logo: ajouté au bloc customize existant')
else:
    sys.exit(0)  # déjà en place : rien à faire
open(p, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
PY
    echo ">> InvenTree : logo perso = static/img/custom_logo.png (customize.logo)."
    # Le serveur doit redémarrer pour relire customize.logo. Avec SSO,
    # setup_asso_sso force-recrée le serveur juste après : inutile ici.
    if [ "$SSO_READY" != "1" ]; then docker compose restart inventree-server >/dev/null 2>&1 || true; fi
  fi

  # nginx : sert la Scannette à la racine du sous-domaine et proxifie InvenTree
  # en same-origin (Host forcé à $SCAN_HOST : session InvenTree propre à ce
  # sous-domaine, et le redirect_uri OIDC d'allauth pointe sur $SCAN_HOST,
  # enregistré côté Dex par lib/sso.sh).
  SCAN_TPL="$TEMPLATES_DIR/scannette.tpl"
  extract_section "$SCAN_TPL" nginx-conf \
    | sed "s|__UPSTREAM__|$UPSTREAM|g; s|__SCAN_HOST__|$SCAN_HOST|g" > "$SCANDIR/default.conf"
  extract_section "$SCAN_TPL" dockerfile > "$SCANDIR/Dockerfile"
  extract_section "$SCAN_TPL" docker-compose | sed "s/__NAME__/$NAME/g" > "$SCANDIR/docker-compose.yml"

  ( cd "$SCANDIR" && docker compose up -d --build )
fi

# ====== Blocs Caddy frontaux (on retire les anciens, on réécrit les bons) ======
# Supprime tout bloc de cette asso : InvenTree ("$NAME-proxy:80") et Scannette
# ("$NAME-scan:80"), y compris l'ancien bloc combiné qui contenait les deux.
if [ -f "$FRONT/Caddyfile" ]; then
  awk -v a1="$NAME-proxy:80" -v a2="$NAME-scan:80" \
    'BEGIN{RS="";ORS="\n\n"} $0 !~ a1 && $0 !~ a2' \
    "$FRONT/Caddyfile" > "$FRONT/Caddyfile.tmp" && mv "$FRONT/Caddyfile.tmp" "$FRONT/Caddyfile"
fi
# Bloc InvenTree. Avec la Scannette vient l'interstitiel mobile : une page
# d'avertissement par asso (générée depuis templates/mobile-warning.html vers
# ~/front/pages/), servie aux navigations mobiles sur la racine (/ et /web)
# seulement : les liens profonds (e-mails, fiches, callbacks OIDC) passent
# toujours. Un cookie de 5 min (bouton « continuer quand même ») laisse passer.
# NB : pas de ligne vide DANS un bloc Caddy, sinon le nettoyage awk (RS="") le couperait en deux.
WARN_TPL="$SCRIPT_DIR/templates/mobile-warning.html"
WARN_PAGE="$FRONT/pages/mobile-warning-$NAME.html"
WARN_CUSTOM="$FRONT/pages/mobile-warning-$NAME.custom.html"
CADDY_TPL="$TEMPLATES_DIR/caddy-blocks.conf"
if [ "$WITH_SCANNETTE" = "1" ]; then
  ASSO_UPPER="$(printf '%s' "$NAME" | tr '[:lower:]' '[:upper:]')"
  # Logos de la page : aucune copie, le frontal relaie /img/* vers le nginx de
  # la Scannette qui sert déjà html/img/ (source unique, à jour sans re-run).
  if [ -n "$LOGO_WHITE" ]; then
    echo ">> Logo white : $LOGO_WHITE (servi via la Scannette, sans copie)"
  else
    echo "!! Logo white INTROUVABLE dans $SCANDIR/html/img/ (cherché : $NAME-white.png puis logo-white.png)" >&2
    echo "!!   -> la page mobile affichera l'initiale '${ASSO_UPPER:0:1}' à la place." >&2
  fi
  if [ -n "$LOGO_BLACK" ]; then
    echo ">> Logo black : $LOGO_BLACK (servi via la Scannette, sans copie)"
  else
    echo "!! Logo black INTROUVABLE dans $SCANDIR/html/img/ (cherché : $NAME-black.png puis logo-black.png)" >&2
    echo "!!   -> la page mobile affichera l'initiale '${ASSO_UPPER:0:1}' à la place." >&2
  fi
  if [ -f "$WARN_CUSTOM" ]; then
    # Page personnalisée de l'asso (runtime uniquement, jamais dans le repo) :
    # jamais touchée par les runs, elle gagne sur le template.
    echo ">> Page mobile personnalisée trouvée ($WARN_CUSTOM) : utilisée telle quelle"
    cp "$WARN_CUSTOM" "$WARN_PAGE"
  else
    sed -e "s|__SCAN_HOST__|$SCAN_HOST|g" \
        -e "s|__LOGO_WHITE__|$LOGO_WHITE|g" \
        -e "s|__LOGO_BLACK__|$LOGO_BLACK|g" \
        -e "s|__ASSO__|$ASSO_UPPER|g" \
        -e "s|__ASSO_INITIAL__|${ASSO_UPPER:0:1}|g" \
        "$WARN_TPL" > "$WARN_PAGE"
  fi
  extract_section "$CADDY_TPL" mobile \
    | sed "s/__HOST__/$HOST/g; s/__NAME__/$NAME/g" >> "$FRONT/Caddyfile"
else
  extract_section "$CADDY_TPL" simple \
    | sed "s/__HOST__/$HOST/g; s/__NAME__/$NAME/g" >> "$FRONT/Caddyfile"
fi
# Bloc Scannette (sous-domaine dédié) si demandée. Le mot ayant deux graphies,
# la variante à un seul n (scanette-...) est aussi servie, en redirection 301
# vers l'hôte canonique. Un seul bloc pour les deux hosts : Caddy gère les deux
# certificats, et le nettoyage idempotent ci-dessus matche sans modification.
# Seule l'orthographe canonique fait du OAuth (la redirection a lieu avant).
if [ "$WITH_SCANNETTE" = "1" ]; then
  SCAN_HOST_ALT="${SCAN_HOST/scannette/scanette}"
  if [ "$SCAN_HOST_ALT" != "$SCAN_HOST" ]; then
    extract_section "$CADDY_TPL" scannette-alias \
      | sed "s/__SCAN_HOST_ALT__/$SCAN_HOST_ALT/g; s/__SCAN_HOST__/$SCAN_HOST/g; s/__NAME__/$NAME/g" \
      >> "$FRONT/Caddyfile"
  else
    # SCAN_HOST personnalisé sans "scannette" dedans : pas d'alias à créer.
    extract_section "$CADDY_TPL" scannette \
      | sed "s/__SCAN_HOST__/$SCAN_HOST/g; s/__NAME__/$NAME/g" >> "$FRONT/Caddyfile"
  fi
fi
( cd "$FRONT" && docker compose up -d --force-recreate )

# ====== SSO EirbConnect (broker Dex) : tout automatisé ======
# Déploie/maj Dex, enregistre le client de cette asso, injecte le bloc OIDC dans
# config.yaml, recrée serveur+worker et active les toggles SSO en base (lib/sso.sh).
if [ "$SSO_READY" = "1" ]; then
  if [ "$WITH_SCANNETTE" = "1" ]; then
    setup_asso_sso "$NAME" "$HOST" "$DIR" "$SCAN_HOST"
  else
    setup_asso_sso "$NAME" "$HOST" "$DIR"
  fi
fi

# ====== Finalisation InvenTree (réglages + groupe membre) : non bloquant ======
# Via l'API REST avec le compte admin (lib/finalize.py, stdlib uniquement).
# À la création seulement (FORCE_SETTINGS=1 pour forcer sur une asso existante).
if [ "$KEEP_ENV" = "0" ] || [ "${FORCE_SETTINGS:-0}" = "1" ]; then
  if [ -f "$SCRIPT_DIR/lib/finalize.py" ] && command -v python3 >/dev/null 2>&1; then
    echo ">> Finalisation InvenTree via l'API (réglages + groupe membre + spotlight) ..."
    python3 "$SCRIPT_DIR/lib/finalize.py" \
      --url "https://$HOST" \
      --user "$(sed -n 's/^INVENTREE_ADMIN_USER=//p' .env | head -1)" \
      --password "$(sed -n 's/^INVENTREE_ADMIN_PASSWORD=//p' .env | head -1)" \
      --name "$NAME" \
      --settings-file "${SETTINGS_CONF:-$SCRIPT_DIR/inventree-settings.conf}" \
      || echo "!! Finalisation en échec : réglages à vérifier dans l'UI."
  else
    echo "!! lib/finalize.py ou python3 introuvable : finalisation sautée (à faire dans l'UI)."
  fi
else
  echo ">> Finalisation InvenTree : asso existante -> réglages non retouchés (FORCE_SETTINGS=1 pour forcer)."
fi

# ====== Plugin Prêts (plugins/inventree-prets) : emprunts & réservations ======
# Installé à chaque run (idempotent, SKIP_PRETS_PLUGIN=1 pour sauter), dans un
# venv PERSISTANT sur le volume de données (INVENTREE_PY_ENV) : l'installation
# survit aux recreate. Piège vérifié : le gunicorn du système a un shebang
# python absolu et ne verrait pas le venv, on installe donc gunicorn DANS le
# venv (--ignore-installed) pour qu'il passe devant dans le PATH. Les migrations
# du plugin sont jouées au démarrage du serveur (INVENTREE_AUTO_UPDATE), jamais
# par 'invoke migrate' qui ne charge pas les apps de plugins.
PLUGIN_SRC="$SCRIPT_DIR/plugins/inventree-prets"
if [ "${SKIP_PRETS_PLUGIN:-0}" != "1" ] && [ -d "$PLUGIN_SRC" ]; then
  PLG_VENV_BIN="/home/inventree/data/env/bin"
  PLG_SRC_VER="$(sed -n 's/^PLUGIN_VERSION = "\(.*\)"/\1/p' "$PLUGIN_SRC/inventree_prets/__init__.py")"

  # Clés .env (idempotent : migre aussi les assos déjà déployées)
  sed -i '/^INVENTREE_PLUGINS_ENABLED=/d;/^INVENTREE_AUTO_UPDATE=/d;/^INVENTREE_PY_ENV=/d' .env
  {
    echo "INVENTREE_PLUGINS_ENABLED=True"
    echo "INVENTREE_AUTO_UPDATE=True"
    echo "INVENTREE_PY_ENV=/home/inventree/data/env"
  } >> .env

  # Upgrade d'image : le venv est lié au python de l'ancienne image (symlinks),
  # on le jette puis on force un boot : seul l'entrypoint recrée le venv, et le
  # serveur déjà lancé (qui garde l'ancien code en mémoire) ne le referait
  # jamais tout seul, l'installation serait sautée.
  if [ "$UPGRADING" = "1" ] && [ -d "./$NAME-data/env" ]; then
    echo ">> Plugin Prêts : upgrade InvenTree -> venv persistant recréé."
    docker run --rm -v "$(pwd)/$NAME-data:/data" "inventree/inventree:$INVENTREE_VERSION" rm -rf /data/env
    docker compose up -d --force-recreate inventree-server inventree-worker
  else
    # Applique le .env (recrée les conteneurs si l'env a changé, sinon no-op)
    docker compose up -d inventree-server inventree-worker
  fi

  # Version installée dans le venv (vide = pas installé). `pip show` sort en
  # code 1 quand le paquet est absent : sans le `|| true`, set -e tuerait le
  # script ici même à la première install.
  PLG_CUR_VER="$(docker exec "$NAME-server" "$PLG_VENV_BIN/pip" show inventree-prets 2>/dev/null | sed -n 's/^Version: //p' || true)"
  # Première install : les défauts d'instance ne sont posés qu'à ce moment,
  # jamais réécrits ensuite (un réglage changé par un admin est respecté).
  [ -z "$PLG_CUR_VER" ] && PLG_FRESH=1 || PLG_FRESH=0

  # Étape 1 : (ré)installer le code dans le venv, seulement si absent ou version
  # différente. Le venv vit sur le volume de données : le code survit aux
  # restores de base, rien à faire dans ce cas.
  PLG_INSTALLED_NOW=0
  if [ -n "$PLG_CUR_VER" ] && [ "$PLG_CUR_VER" = "$PLG_SRC_VER" ]; then
    echo ">> Plugin Prêts v$PLG_SRC_VER : code déjà présent dans le venv."
  else
    echo ">> Plugin Prêts : installation v${PLG_SRC_VER:-?} dans le venv persistant ..."
    # attend le venv (créé par l'entrypoint ; au tout premier boot les
    # migrations passent avant, ça peut prendre quelques minutes)
    PLG_OK=0
    for _i in $(seq 1 60); do
      if docker exec "$NAME-server" test -x "$PLG_VENV_BIN/pip" 2>/dev/null; then PLG_OK=1; break; fi
      sleep 3
    done
    if [ "$PLG_OK" != "1" ]; then
      echo "!! Plugin Prêts : venv absent après 3 min, installation sautée (relance le script)."
    else
      # gunicorn DANS le venv (une fois), puis le plugin depuis le repo
      docker exec "$NAME-server" test -x "$PLG_VENV_BIN/gunicorn" 2>/dev/null \
        || docker exec "$NAME-server" "$PLG_VENV_BIN/pip" install -q --root-user-action=ignore --ignore-installed gunicorn
      tar -C "$PLUGIN_SRC" --exclude='__pycache__' -cf - . \
        | docker exec -i "$NAME-server" sh -c 'rm -rf /tmp/prets-src && mkdir -p /tmp/prets-src && tar -C /tmp/prets-src -xf -'
      docker exec "$NAME-server" "$PLG_VENV_BIN/pip" install -q --no-build-isolation --no-deps --root-user-action=ignore /tmp/prets-src
      docker restart "$NAME-server" >/dev/null   # le registre redécouvre le plugin
      PLG_INSTALLED_NOW=1
    fi
  fi

  # Étape 2 : activer, idempotent à chaque run. C'est ce qui répare un restore
  # de base : les interrupteurs ENABLE_PLUGINS_* et le flag « actif » vivent en
  # base (pas dans le venv), un vieux dump les éteint alors que le code est là.
  # On ne redémarre que si quelque chose a bougé.
  PLG_ADMIN_U="$(sed -n 's/^INVENTREE_ADMIN_USER=//p' .env | head -1)"
  PLG_ADMIN_P="$(sed -n 's/^INVENTREE_ADMIN_PASSWORD=//p' .env | head -1)"
  PLG_TOK=""
  for _i in $(seq 1 60); do
    PLG_TOK="$(curl -su "$PLG_ADMIN_U:$PLG_ADMIN_P" "https://$HOST/api/user/token/" 2>/dev/null \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)"
    [ -n "$PLG_TOK" ] && break
    sleep 5
  done
  if [ -z "$PLG_TOK" ]; then
    echo "!! Plugin Prêts : API injoignable, activation à finir à la main (Réglages > Plugins)."
  else
    # Les 4 flags sont-ils déjà à true, et le plugin actif ?
    # (l'API renvoie les booléens sans guillemets : "value":true)
    PLG_NEED=$PLG_INSTALLED_NOW
    for _k in ENABLE_PLUGINS_APP ENABLE_PLUGINS_URL ENABLE_PLUGINS_SCHEDULE ENABLE_PLUGINS_INTERFACE; do
      _v="$(curl -s -H "Authorization: Token $PLG_TOK" "https://$HOST/api/settings/global/$_k/" \
        | sed -n 's/.*"value":\(true\|false\).*/\1/p' || true)"
      [ "$_v" = "true" ] || PLG_NEED=1
    done
    curl -s -H "Authorization: Token $PLG_TOK" "https://$HOST/api/plugins/prets/" \
      | grep -q '"active":true' || PLG_NEED=1

    if [ "$PLG_NEED" != "1" ]; then
      echo ">> Plugin Prêts v${PLG_CUR_VER:-?} : déjà actif et intégrations en place, rien à faire."
    else
      echo ">> Plugin Prêts : (ré)activation des intégrations globales + du plugin ..."
      for _k in ENABLE_PLUGINS_APP ENABLE_PLUGINS_URL ENABLE_PLUGINS_SCHEDULE ENABLE_PLUGINS_INTERFACE; do
        curl -s -o /dev/null -X PATCH -H "Authorization: Token $PLG_TOK" -H "Content-Type: application/json" \
          -d '{"value":"True"}' "https://$HOST/api/settings/global/$_k/"
      done
      curl -s -o /dev/null -X PATCH -H "Authorization: Token $PLG_TOK" -H "Content-Type: application/json" \
        -d '{"active":true}' "https://$HOST/api/plugins/prets/activate/"
      # Titre d'instance = préfixe des sujets d'e-mails de notification et titre
      # d'onglet. Posé seulement s'il vaut encore le défaut « InvenTree ».
      INST_TITLE="${BRAND_NAME:-$(printf '%s' "$NAME" | tr '[:lower:]' '[:upper:]')}"
      INST_CUR="$(curl -s -H "Authorization: Token $PLG_TOK" "https://$HOST/api/settings/global/INVENTREE_INSTANCE/" \
        | sed -n 's/.*"value":"\([^"]*\)".*/\1/p' || true)"
      if [ "$INST_CUR" = "InvenTree" ]; then
        curl -s -o /dev/null -X PATCH -H "Authorization: Token $PLG_TOK" -H "Content-Type: application/json" \
          -d "{\"value\":\"$INST_TITLE\"}" "https://$HOST/api/settings/global/INVENTREE_INSTANCE/"
      fi
      # Défauts posés à la première install seulement : noms complets affichés
      # (DISPLAY_FULL_NAMES) et purge du suivi de stock à 1 an. L'historique des
      # prêts est purgé par le réglage du plugin lui-même (DELETE_OLD_HISTORY,
      # défaut ON). Réservations et champ « pour l'asso » restent OFF.
      if [ "$PLG_FRESH" = "1" ]; then
        for _kv in "DISPLAY_FULL_NAMES:True" "STOCK_TRACKING_DELETE_OLD_ENTRIES:True"; do
          curl -s -o /dev/null -X PATCH -H "Authorization: Token $PLG_TOK" -H "Content-Type: application/json" \
            -d "{\"value\":\"${_kv#*:}\"}" "https://$HOST/api/settings/global/${_kv%%:*}/"
        done
        echo ">>   Défauts posés : noms complets affichés + purge du suivi de stock à 1 an."
      fi
      # statiques du panneau avant le redémarrage (WhiteNoise scanne au boot) ;
      # les migrations du plugin sont jouées à ce boot-là (auto-update)
      docker exec "$NAME-server" sh -c \
        "cd /home/inventree/src/backend/InvenTree && $PLG_VENV_BIN/python manage.py collectplugins" >/dev/null 2>&1 || true
      docker restart "$NAME-server" "$NAME-worker" >/dev/null
      echo ">> Plugin Prêts v${PLG_SRC_VER:-?} installé et actif."
      echo ">>   (réservations & champ « pour l'asso » : Réglages > Plugins > Prêts)"
      # Étalement de la tâche quotidienne : un créneau fixe de 10 min par asso
      # la nuit (02:MM UTC, ~4h Paris), sinon toutes les instances réveilleraient
      # leurs workers au même instant (pic de décompression zram simultané).
      # L'ordre est figé par nom : supprimer/recréer une asso ne décale pas les
      # autres. InvenTree ne réécrit jamais next_run d'une tâche existante, le
      # décalage survit donc aux redémarrages. Une asso hors liste retombe après
      # les autres (03:xx), à ajouter ici pour un créneau propre.
      case "$NAME" in
        eirspace) STAGGER_IDX=0 ;;
        bde)      STAGGER_IDX=1 ;;
        eirbot)   STAGGER_IDX=2 ;;
        essaim)   STAGGER_IDX=3 ;;
        laruche)  STAGGER_IDX=4 ;;
        vost)     STAGGER_IDX=5 ;;
        *)        STAGGER_IDX=$(( 6 + $(printf '%s' "$NAME" | cksum | cut -d' ' -f1) % 6 )) ;;
      esac
      STAGGER_TOTAL=$((STAGGER_IDX * 10))   # minutes depuis 02:00 UTC
      for _i in $(seq 1 30); do
        OUT=$(printf 'from django_q.models import Schedule\nfrom django.utils import timezone\nimport datetime\ns=Schedule.objects.filter(name="plugin.prets.daily_checks").first()\nif s:\n    now=timezone.now()\n    t=now.replace(hour=2,minute=0,second=0,microsecond=0)+datetime.timedelta(minutes=%s)\n    if t<=now: t+=datetime.timedelta(days=1)\n    s.next_run=t; s.save(); print("STAGGER_OK", t.strftime("%%H:%%M"))\n' "$STAGGER_TOTAL" \
          | docker exec -i "$NAME-server" sh -c "cd /home/inventree/src/backend/InvenTree && $PLG_VENV_BIN/python manage.py shell" 2>/dev/null)
        if printf '%s' "$OUT" | grep -q STAGGER_OK; then
          echo ">>   Tâche quotidienne calée à $(printf '%s' "$OUT" | sed -n 's/.*STAGGER_OK //p') UTC (10 min par asso, anti-collision zram)."
          break
        fi
        sleep 4
      done
    fi
  fi
fi

# ====== Plugin E-mails (plugins/inventree-emails) : habillage des e-mails ======
# Surcharge les templates des e-mails natifs d'InvenTree et des e-mails de
# compte allauth aux couleurs de la Scannette (le chargeur de templates de
# plugin passe avant les natifs). Même venv persistant que Prêts ; aucune
# migration ni statique : installer + activer suffit. SKIP_EMAILS_PLUGIN=1 pour sauter.
EMAILS_SRC="$SCRIPT_DIR/plugins/inventree-emails"
if [ "${SKIP_EMAILS_PLUGIN:-0}" != "1" ] && [ -d "$EMAILS_SRC" ]; then
  EMAILS_VENV_BIN="/home/inventree/data/env/bin"
  EMAILS_SRC_VER="$(sed -n 's/^PLUGIN_VERSION = "\(.*\)"/\1/p' "$EMAILS_SRC/inventree_emails/__init__.py")"

  # Clés .env normalement posées par Prêts ; remises si Prêts a été sauté.
  if ! grep -q '^INVENTREE_PLUGINS_ENABLED=' .env; then
    {
      echo "INVENTREE_PLUGINS_ENABLED=True"
      echo "INVENTREE_AUTO_UPDATE=True"
      echo "INVENTREE_PY_ENV=/home/inventree/data/env"
    } >> .env
    docker compose up -d inventree-server inventree-worker
  fi

  # même piège que PLG_CUR_VER : `|| true` obligatoire (pip show sort en code 1)
  EMAILS_CUR_VER="$(docker exec "$NAME-server" "$EMAILS_VENV_BIN/pip" show inventree-emails 2>/dev/null | sed -n 's/^Version: //p' || true)"
  if [ -n "$EMAILS_CUR_VER" ] && [ "$EMAILS_CUR_VER" = "$EMAILS_SRC_VER" ]; then
    echo ">> Plugin E-mails v$EMAILS_SRC_VER : déjà installé (venv persistant), rien à faire."
  else
    echo ">> Plugin E-mails : installation v${EMAILS_SRC_VER:-?} dans le venv persistant ..."
    EMAILS_OK=0
    for _i in $(seq 1 60); do
      if docker exec "$NAME-server" test -x "$EMAILS_VENV_BIN/pip" 2>/dev/null; then EMAILS_OK=1; break; fi
      sleep 3
    done
    if [ "$EMAILS_OK" != "1" ]; then
      echo "!! Plugin E-mails : venv absent après 3 min, installation sautée (relance le script)."
    else
      tar -C "$EMAILS_SRC" --exclude='__pycache__' -cf - . \
        | docker exec -i "$NAME-server" sh -c 'rm -rf /tmp/emails-src && mkdir -p /tmp/emails-src && tar -C /tmp/emails-src -xf -'
      docker exec "$NAME-server" "$EMAILS_VENV_BIN/pip" install -q --no-build-isolation --no-deps --root-user-action=ignore /tmp/emails-src

      # redémarre pour que le registre découvre le plugin, puis active via l'API
      docker restart "$NAME-server" >/dev/null
      EMAILS_ADMIN_U="$(sed -n 's/^INVENTREE_ADMIN_USER=//p' .env | head -1)"
      EMAILS_ADMIN_P="$(sed -n 's/^INVENTREE_ADMIN_PASSWORD=//p' .env | head -1)"
      EMAILS_TOK=""
      for _i in $(seq 1 60); do
        EMAILS_TOK="$(curl -su "$EMAILS_ADMIN_U:$EMAILS_ADMIN_P" "https://$HOST/api/user/token/" 2>/dev/null \
          | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true)"
        [ -n "$EMAILS_TOK" ] && break
        sleep 5
      done
      if [ -z "$EMAILS_TOK" ]; then
        echo "!! Plugin E-mails : API injoignable, activation à finir à la main (Réglages > Plugins)."
      else
        curl -s -o /dev/null -X PATCH -H "Authorization: Token $EMAILS_TOK" -H "Content-Type: application/json" \
          -d '{"value":"True"}' "https://$HOST/api/settings/global/ENABLE_PLUGINS_APP/"
        curl -s -o /dev/null -X PATCH -H "Authorization: Token $EMAILS_TOK" -H "Content-Type: application/json" \
          -d '{"active":true}' "https://$HOST/api/plugins/emails/activate/"
        docker restart "$NAME-server" "$NAME-worker" >/dev/null
        echo ">> Plugin E-mails v${EMAILS_SRC_VER:-?} installé et actif (e-mails aux couleurs de la Scannette)."
      fi
    fi
  fi
fi

# ====== Swap disque : ajusté au nombre d'assos (chunks de 2 Go, additif) ======
# `|| true` : ne bloque jamais la fin d'un déploiement réussi.
if command -v manage_swap >/dev/null 2>&1; then manage_swap || true; fi

# ====== Fiches PUI : champs date affichés en ISO brut (bugs InvenTree) ======
# Des champs de fiche sont déclarés "string"/"text" au lieu de "date" : l'ISO
# brut de l'API s'affiche au lieu de suivre DATE_DISPLAY_FORMAT comme partout
# ailleurs. Balayage exhaustif du source 1.4.2 : seuls deux champs visibles.
#   - fiche article, creation_date ("string", cassé jusqu'à leur master) ;
#   - fiche stock, updated ("text", corrigé sur master, en attendant ici).
# Retouche des bundles collectés, à refaire à chaque run : collectstatic
# --clear les écrase aux upgrades. Chaque patch s'auto-désactive quand le
# motif disparaît (fix upstream livré). Redémarrage requis après patch :
# whitenoise fige taille/ETag des statiques au boot du serveur.
PATCHED_BUNDLE=0
for spec in \
  'PartDetail-*.js|{type:"string",name:"creation_date"|{type:"date",name:"creation_date"' \
  'StockDetail-*.js|{type:"text",name:"updated"|{type:"date",name:"updated"'
do
  B_GLOB="${spec%%|*}"; rest="${spec#*|}"
  B_FROM="${rest%%|*}"; B_TO="${rest#*|}"
  B_FILE="$(sudo sh -c "ls '$DIR/$NAME-data/static/web/assets/'$B_GLOB 2>/dev/null | head -1" || true)"
  if [ -n "$B_FILE" ] && sudo grep -qF "$B_FROM" "$B_FILE"; then
    sudo python3 - "$B_FILE" "$B_FROM" "$B_TO" <<'PY'
import sys
p, a, b = sys.argv[1:4]
s = open(p, encoding="utf-8").read()
open(p, "w", encoding="utf-8").write(s.replace(a, b, 1))
PY
    PATCHED_BUNDLE=1
    echo ">> InvenTree : patch bundle $(basename "$B_FILE") (champ date affiché au format de l'utilisateur)."
  fi
done
if [ "$PATCHED_BUNDLE" = "1" ]; then
  docker restart "$NAME-server" >/dev/null 2>&1 || true
fi

# ====== Récap ======
echo ""
echo ">> ============================================================"
echo ">>  Asso '$NAME' prête !"
echo ">>    InvenTree : https://$HOST   (version épinglée: $INVENTREE_VERSION)"
[ "$WITH_SCANNETTE" = "1" ] && echo ">>    Scannette  : https://$SCAN_HOST   (recharge avec ?v=N pour casser le cache)"
if [ "$WITH_SCANNETTE" = "1" ]; then
  if [ -f "$FRONT/pages/mobile-warning-$NAME.html" ] && grep -q "@mobile" "$FRONT/Caddyfile"; then
    echo ">>    Interstitiel mobile : ACTIF ($FRONT/pages/mobile-warning-$NAME.html)"
  else
    echo ">>    Interstitiel mobile : INACTIF (template manquant, voir avertissement ci-dessus)"
  fi
fi
if [ "$KEEP_ENV" = "1" ]; then
  echo ">>    Identifiants : inchangés (voir $DIR/.env)"
else
  echo ">>    Admin     : $ADMIN_USER"
  echo ">>    Password  : $ADMIN_PW   (modifiable après connexion)"
fi
if [ "$SSO_READY" = "1" ]; then
  echo ">> ------------------------------------------------------------"
  echo ">>  EirbConnect (SSO) : prêt, tout est automatique."
  echo ">>    - bouton 'EirbConnect' sur https://$HOST"
  [ "$WITH_SCANNETTE" = "1" ] && echo ">>      (et sur la Scannette : https://$SCAN_HOST)"
  echo ">>    - un membre inconnu se connecte -> son compte est créé SANS groupe"
  echo ">>    - tu l'approuves : Admin Center -> Users -> (lui assigner un groupe)"
fi
echo ">> ============================================================"
echo ">>  Version InvenTree épinglée sur $INVENTREE_VERSION (les futures versions ne s'installent pas toutes seules)."
echo ">>    - mettre à jour CETTE asso (test/upgrade) : INVENTREE_VERSION=x.y.z ./create-asso.sh $NAME"
echo ">>    - changer domaine / version / SMTP partout : ./create-asso.sh --reconfigure"
echo ">>  Contrôle : docker stats --no-stream  ;  free -h"
