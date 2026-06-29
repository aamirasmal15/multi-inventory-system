#!/usr/bin/env bash
#
# create-asso.sh — Déploie une asso COMPLÈTE en une seule commande :
#                  InvenTree (optimisé mémoire) + Scanette + SSO EirbConnect, derrière le Caddy frontal.
#
# Tout est rangé dans ~/<nom>/ :
#   ~/<nom>/
#   ├── .env                 identifiants + réglages (généré une fois, préservé ensuite)
#   ├── docker-compose.yml   InvenTree (db, cache, serveur, worker, proxy)
#   ├── Caddyfile            proxy interne InvenTree (HTTP)
#   ├── <nom>-data/          données InvenTree (Postgres, media, config.yaml…)
#   └── scanette/            la Scanette de CETTE asso (nginx)
#       ├── Dockerfile
#       ├── default.conf
#       ├── docker-compose.yml
#       └── html/            fichiers de l'app, copiés depuis ./scanette-src/
#
#   InvenTree -> https://<domaine>        Scanette -> https://scanette[-<nom>].<BASE_DOMAIN>
#   (la Scanette a désormais SON PROPRE sous-domaine ; elle proxifie InvenTree en same-origin)
#
# Usage :
#   ./create-asso.sh <nom> [sous-domaine|tmp] [mot-de-passe-admin]
#
#   <nom>          nom interne de l'asso (eirspace, pixeirb, vost)   [obligatoire]
#   [sous-domaine] label du sous-domaine (ex: inventaire, inventaire-pixeirb)
#                    - "tmp"  -> instance ÉPHÉMÈRE sur sslip.io (<nom>.<ip>.sslip.io, sans DNS)
#                    - absent + asso principale (eirspace) -> inventaire.<BASE_DOMAIN>
#                    - absent + autre asso                 -> inventaire-<nom>.<BASE_DOMAIN>
#                    - (BASE_DOMAIN vide -> sslip.io)
#   [mot-de-passe] mot de passe admin (généré automatiquement si absent)
#
# Réglages partagés (demandés au 1er run, stockés dans ~/.config/multi-inventory/settings.env,
# ré-éditables d'un coup avec `./create-asso.sh --reconfigure`) :
#   BASE_DOMAIN        ton domaine. DEMANDÉ au tout premier lancement puis mémorisé.
#                        (surchargeable ponctuellement : BASE_DOMAIN=mondom.fr ./create-asso.sh ...
#                         vide "" => sslip.io, tests sans domaine)
#   INVENTREE_VERSION  version InvenTree ÉPINGLÉE (défaut: 1.4.0). Le système est validé sur 1.4.0 :
#                        on reste dessus pour ne pas qu'une update casse tout. Pour tester/passer
#                        UNE asso sur une autre version : INVENTREE_VERSION=1.5.0 ./create-asso.sh <nom>
#                        (migrations jouées automatiquement). Pour changer le défaut partout : --reconfigure.
#
# Variables d'environnement (optionnelles) :
#   SCAN_SRC       dossier source de l'app Scanette (défaut: <repo>/scanette-src)
#   WITH_SCANETTE  1 (défaut) = déploie aussi la Scanette ; 0 = InvenTree seul
#   MAIN_ASSO      asso principale au sous-domaine fixe (défaut: eirspace)
#   MAIN_SUBDOMAIN sous-domaine fixe de l'asso principale (défaut: inventaire)
#   ADMIN_EMAIL    email du compte admin (défaut: l'expéditeur SMTP ; admin@<nom>.local sans SSO)
#
#   --- EirbConnect (SSO OpenID Connect, via le broker Dex) ---
#   ENABLE_SSO     1 (défaut) = branche EirbConnect ; 0 = pas de SSO
#                    (auto-désactivé pour les instances éphémères sslip.io)
#
#   Le SSO passe par un broker Dex (https://auth.<domaine>/oauth2), auto-déployé au
#   premier run. Un SEUL client est enregistré côté Eirbware ; Dex redistribue l'identité
#   à chaque InvenTree, donc plus jamais besoin d'Eirbware pour une nouvelle asso.
#
#   Identifiants demandés UNE SEULE FOIS puis stockés hors repo (~/.config/multi-inventory/) :
#     - EirbConnect : client_id + secret     -> eirbconnect.env
#     - SMTP        : serveur/identifiant/mdp -> smtp.env   (requis pour l'auto-création)
#
#   Modèle d'accès : auto-création + en attente. Un membre inconnu se connecte -> son
#   compte est créé SANS groupe -> l'admin lui assigne un groupe = approuvé. L'identité
#   est le 'sub' OIDC (pas l'email) -> insensible aux multiples adresses de l'école.
#
#   Détails : lib/sso.sh (fonctions) et auth/INTEGRATION.md.
#   Surcharges éventuelles : AUTH_DOMAIN (défaut auth.<BASE_DOMAIN>), SMTP_ENV_FILE,
#   SSO_ENV_FILE, EIRBCONNECT_REALM, EIRBCONNECT_BASE_URL, OIDC_PROVIDER_ID.
#
# Exemples :
#   ./create-asso.sh eirspace                     -> https://inventaire.eirspace.fr  (asso principale)
#   ./create-asso.sh eirspace inventaire          -> https://inventaire.eirspace.fr  (identique, explicite)
#   ./create-asso.sh pixeirb  inventaire-pixeirb  -> https://inventaire-pixeirb.eirspace.fr
#   ./create-asso.sh vost                         -> https://inventaire-vost.eirspace.fr
#   ./create-asso.sh demo     tmp                 -> https://demo.<ip>.sslip.io  (éphémère, sans SSO)
#   ENABLE_SSO=0 ./create-asso.sh vost            -> sans SSO
#   ./create-asso.sh --reconfigure                -> ré-éditer domaine + version + SMTP (et propager le SMTP)
#   INVENTREE_VERSION=1.5.0 ./create-asso.sh vost -> mettre à jour CETTE asso vers 1.5.0 (test/upgrade manuel)
#
# Idempotent : relancer = mettre à jour (l'.env est préservé, l'app rebuild, le frontal
#              recharge, le bloc SSO du config.yaml + le client Dex sont remplacés, pas dupliqués).
#
set -euo pipefail

# On note si l'utilisateur a fixé le domaine / la version via l'environnement, AVANT de sourcer
# la lib (qui pose un défaut). Sert à distinguer "override volontaire" de "valeur par défaut".
_DOMAIN_SET="${BASE_DOMAIN+1}"
_VER_SET="${INVENTREE_VERSION+1}"

# ====== Emplacement du repo (pour trouver scanette-src/ et lib/) ======
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ====== Fonctions SSO / Dex / SMTP (broker partagé) ======
if [ ! -f "$SCRIPT_DIR/lib/sso.sh" ]; then
  echo "ERREUR : $SCRIPT_DIR/lib/sso.sh introuvable. Récupère le dossier lib/ du repo." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$SCRIPT_DIR/lib/sso.sh"

# ====== Mode reconfiguration : ./create-asso.sh --reconfigure ======
# Ré-édite domaine + version InvenTree épinglée + SMTP, et REPROPAGE le SMTP à toutes les assos.
case "${1:-}" in
  --reconfigure|reconfigure)
    reconfigure_platform
    exit 0
    ;;
esac

# ====== Configuration ======
# Domaine + version InvenTree épinglée : chargés depuis settings.env (demandés au 1er run).
# Respecte un override d'env ponctuel (BASE_DOMAIN=... / INVENTREE_VERSION=...).
load_platform_settings "$_DOMAIN_SET" "$_VER_SET"
SCAN_SRC="${SCAN_SRC:-$SCRIPT_DIR/scanette-src}"
WITH_SCANETTE="${WITH_SCANETTE:-1}"

# Exception "asso principale" : son sous-domaine est FIXE ("inventaire", pas
# "inventaire-<nom>"). Ainsi `./create-asso.sh eirspace` (sans 2e argument)
# retombe toujours sur https://inventaire.eirspace.fr — même après réinstallation.
MAIN_ASSO="${MAIN_ASSO:-eirspace}"
MAIN_SUBDOMAIN="${MAIN_SUBDOMAIN:-inventaire}"
# Sous-domaine FIXE de la Scanette de l'asso principale (les autres -> scanette-<nom>).
MAIN_SCAN_SUBDOMAIN="${MAIN_SCAN_SUBDOMAIN:-scanette}"

# ====== EirbConnect (SSO OpenID Connect) ======
ENABLE_SSO="${ENABLE_SSO:-1}"
SSO_ENV_FILE="${SSO_ENV_FILE:-$HOME/.config/multi-inventory/eirbconnect.env}"
# Constantes EirbConnect issues de la doc Eirbware (realm + hôte). Publiques et fixes :
# tu n'as donc PAS à les saisir. Surchargeables par variable d'env si Eirbware change.
EIRBCONNECT_REALM="${EIRBCONNECT_REALM:-eirb}"
EIRBCONNECT_BASE_URL="${EIRBCONNECT_BASE_URL:-https://connect.vpn.eirb.fr}"
OIDC_PROVIDER_ID="${OIDC_PROVIDER_ID:-eirbconnect}"

# Email du compte admin (résolu plus bas : expéditeur SMTP si SSO, sinon admin@<nom>.local).
ADMIN_EMAIL="${ADMIN_EMAIL:-}"

# Charge les identifiants EirbConnect.
# Priorité : variables d'environnement > fichier local (hors repo) > saisie interactive.
# La saisie n'a lieu qu'une fois : ensuite les valeurs sont relues depuis SSO_ENV_FILE.
load_sso_credentials() {
  if [ -f "$SSO_ENV_FILE" ]; then
    # shellcheck source=/dev/null
    . "$SSO_ENV_FILE"
  fi
  # On ne demande QUE le client_id et le secret (le realm et l'hôte sont des constantes).
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

# ====== Arguments ======
NAME="${1:?Usage: ./create-asso.sh <nom> [sous-domaine|tmp] [mot-de-passe-admin]}"
SUBDOMAIN="${2:-}"
ADMIN_PW="${3:-$(openssl rand -hex 12)}"
DB_PW="$(openssl rand -hex 16)"
DIR="$HOME/$NAME"
ADMIN_USER="admin_$NAME"
FRONT="$HOME/front"

# ====== Vérif accès Docker ======
if ! docker ps >/dev/null 2>&1; then
  echo "ERREUR : Docker inaccessible. Fais 'sudo usermod -aG docker \$USER' puis reconnecte-toi (ou 'newgrp docker')." >&2
  exit 1
fi

# ====== Réseau partagé (créé s'il n'existe pas encore) ======
docker network create inventree-front 2>/dev/null || true

# ====== Caddy frontal : bootstrap automatique si absent (une seule fois) ======
if [ ! -f "$FRONT/docker-compose.yml" ]; then
  echo ">> Caddy frontal absent : création de ~/front ..."
  mkdir -p "$FRONT"
  cat > "$FRONT/docker-compose.yml" <<'EOF'
services:
  caddy:
    image: caddy:alpine
    container_name: front-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    networks:
      - inventree-front

volumes:
  caddy-data:
  caddy-config:

networks:
  inventree-front:
    external: true
EOF
  touch "$FRONT/Caddyfile"
fi

# ====== Si Scanette demandée : vérifier les fichiers source AVANT de tout déployer ======
if [ "$WITH_SCANETTE" = "1" ]; then
  [ -f "$SCAN_SRC/index.html" ] || {
    echo "ERREUR : $SCAN_SRC/index.html manquant." >&2
    echo "         Dépose les fichiers de l'app dans scanette-src/ (voir scanette-src/README.md)," >&2
    echo "         ou déploie InvenTree seul : WITH_SCANETTE=0 ./create-asso.sh $NAME ..." >&2
    exit 1
  }
  [ -f "$SCAN_SRC/zxing_reader.wasm" ] || {
    echo "ERREUR : $SCAN_SRC/zxing_reader.wasm manquant (décodeur de codes-barres)." >&2
    exit 1
  }
fi

# ====== Calcul des URL (InvenTree + Scanette sur sous-domaine dédié) ======
# SCAN_HOST surchargeable ponctuellement : SCAN_HOST=monscan.dom ./create-asso.sh ...
_SCAN_SET="${SCAN_HOST+1}"
if [ "$SUBDOMAIN" = "tmp" ] || [ -z "$BASE_DOMAIN" ]; then
  IP="$(curl -4 -s ifconfig.me)"; HOST="$NAME.${IP//./-}.sslip.io"   # éphémère / sans domaine
  [ -n "$_SCAN_SET" ] || SCAN_HOST="scanette-$NAME.${IP//./-}.sslip.io"
elif [ -n "$SUBDOMAIN" ]; then
  HOST="$SUBDOMAIN.$BASE_DOMAIN"            # sous-domaine InvenTree explicite (gagne toujours)
  if [ -z "$_SCAN_SET" ]; then             # ... mais la Scanette suit la convention par nom
    if [ "$NAME" = "$MAIN_ASSO" ]; then SCAN_HOST="$MAIN_SCAN_SUBDOMAIN.$BASE_DOMAIN"
    else                                    SCAN_HOST="scanette-$NAME.$BASE_DOMAIN"; fi
  fi
elif [ "$NAME" = "$MAIN_ASSO" ]; then
  HOST="$MAIN_SUBDOMAIN.$BASE_DOMAIN"       # asso principale -> inventaire.eirspace.fr
  [ -n "$_SCAN_SET" ] || SCAN_HOST="$MAIN_SCAN_SUBDOMAIN.$BASE_DOMAIN"   # -> scanette.eirspace.fr
else
  HOST="inventaire-$NAME.$BASE_DOMAIN"      # défaut -> inventaire-<nom>.eirspace.fr
  [ -n "$_SCAN_SET" ] || SCAN_HOST="scanette-$NAME.$BASE_DOMAIN"         # -> scanette-<nom>.eirspace.fr
fi

echo ">> Asso '$NAME'  ->  https://$HOST"
[ "$WITH_SCANETTE" = "1" ] && echo ">>   Scanette    ->  https://$SCAN_HOST"
mkdir -p "$DIR" && cd "$DIR"

# ====== SSO : identifiants prêts ? (on demande EN AMONT du long 'invoke update') ======
SSO_READY=0
if [ "$ENABLE_SSO" = "1" ]; then
  if [[ "$HOST" == *.sslip.io ]]; then
    echo ">> SSO ignoré (instance éphémère sslip.io : la redirect URI ne serait pas autorisable côté Keycloak)."
  else
    load_sso_credentials
    if [ -n "${EIRBCONNECT_CLIENT_ID:-}" ] && [ -n "${EIRBCONNECT_SECRET:-}" ] && [ -n "${EIRBCONNECT_REALM:-}" ]; then
      SSO_READY=1
      # SMTP demandé une seule fois (requis pour l'auto-création de comptes SSO).
      load_smtp_credentials
      [ -z "$ADMIN_EMAIL" ] && ADMIN_EMAIL="${SMTP_SENDER:-admin@$NAME.local}"
    else
      echo ">> SSO demandé mais identifiants EirbConnect manquants (mode non interactif ?) : on continue SANS SSO." >&2
    fi
  fi
fi

# ====== Caddyfile interne InvenTree (HTTP simple) ======
wget -q https://raw.githubusercontent.com/inventree/InvenTree/stable/contrib/container/Caddyfile -O Caddyfile
sed -i 's|^{$INVENTREE_SITE_URL:"http://, https://"} {|:80 {|' Caddyfile

# ====== .env (préservé s'il existe déjà, pour ne pas changer les mots de passe) ======
UPGRADING=0
if [ -f .env ]; then
  KEEP_ENV=1
  echo ">> .env existant conservé (identifiants inchangés)"
  # Pinning / upgrade : si la version demandée diffère du tag actuel, on met à jour le tag.
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

# ====== Origines CSRF de confiance (InvenTree + Scanette) — idempotent, à CHAQUE run ======
# La Scanette est sur un sous-domaine distinct : tout POST/PATCH (login SSO + écritures
# de stock) arrive avec Origin=https://$SCAN_HOST. Django rejette le CSRF si cette origine
# n'est pas dans CSRF_TRUSTED_ORIGINS. On la déclare donc ici (en plus de $HOST, déjà couvert
# par INVENTREE_SITE_URL mais ré-affirmé par clarté). ALLOWED_HOSTS reste sur '*' (config.yaml)
# pour ne pas casser les appels internes (inventree-server, worker, health-checks).
# Réécrit à chaque run -> migre aussi les assos déjà déployées vers le modèle sous-domaine.
if [ "$WITH_SCANETTE" = "1" ]; then
  TRUSTED_ORIGINS="https://$HOST,https://$SCAN_HOST"
else
  TRUSTED_ORIGINS="https://$HOST"
fi
sed -i '/^INVENTREE_TRUSTED_ORIGINS=/d' .env
echo "INVENTREE_TRUSTED_ORIGINS=$TRUSTED_ORIGINS" >> .env

# ====== docker-compose.yml InvenTree (conteneurs renommés, ports retirés, réseau partagé) ======
cat > docker-compose.yml <<'INVTPL'
services:
    inventree-db:
        image: postgres:17
        container_name: __NAME__-db
        expose:
            - ${INVENTREE_DB_PORT:-5432}/tcp
        environment:
            - PGDATA=/var/lib/postgresql/data/pgdb
            - POSTGRES_USER=${INVENTREE_DB_USER:?Missing INVENTREE_DB_USER}
            - POSTGRES_PASSWORD=${INVENTREE_DB_PASSWORD:?Missing INVENTREE_DB_PASSWORD}
            - POSTGRES_DB=${INVENTREE_DB_NAME:?Missing INVENTREE_DB_NAME}
        volumes:
            - ${INVENTREE_EXT_VOLUME:?Missing INVENTREE_EXT_VOLUME}:/var/lib/postgresql/data/:z
        restart: unless-stopped

    inventree-cache:
        image: redis:7-alpine
        container_name: __NAME__-cache
        env_file:
            - .env
        expose:
            - ${INVENTREE_CACHE_PORT:-6379}
        volumes:
            - ${INVENTREE_EXT_VOLUME}/redis:/data
        restart: always

    inventree-server:
        image: inventree/inventree:${INVENTREE_TAG:-stable}
        container_name: __NAME__-server
        expose:
            - ${INVENTREE_WEB_PORT:-8000}
        depends_on:
            - inventree-db
            - inventree-cache
        env_file:
            - .env
        environment:
          INVENTREE_SERVER: http://inventree-server:${INVENTREE_WEB_PORT}
        volumes:
            - ${INVENTREE_EXT_VOLUME}:/home/inventree/data:z
        restart: unless-stopped

    inventree-worker:
        image: inventree/inventree:${INVENTREE_TAG:-stable}
        container_name: __NAME__-worker
        command: invoke worker
        depends_on:
            - inventree-server
        env_file:
            - .env
        volumes:
            - ${INVENTREE_EXT_VOLUME}:/home/inventree/data:z
        restart: unless-stopped

    inventree-proxy:
        container_name: __NAME__-proxy
        image: caddy:alpine
        restart: always
        depends_on:
            - inventree-server
        env_file:
            - .env
        volumes:
            - ./Caddyfile:/etc/caddy/Caddyfile:ro,z
            - ${INVENTREE_EXT_VOLUME}/static:/var/www/static:z
            - ${INVENTREE_EXT_VOLUME}/media:/var/www/media:z
            - ${INVENTREE_EXT_VOLUME}:/var/log:z
            - ${INVENTREE_EXT_VOLUME}:/data:z
            - ${INVENTREE_EXT_VOLUME}:/config:z
        networks:
            default: {}
            inventree-front:
                aliases:
                    - __NAME__-proxy

networks:
    inventree-front:
        external: true
INVTPL
sed -i "s/__NAME__/$NAME/g" docker-compose.yml

# ====== Validation YAML ======
docker compose config >/dev/null && echo ">> YAML InvenTree OK"

# ====== Upgrade : récupérer la nouvelle image AVANT les migrations ======
if [ "$UPGRADING" = "1" ]; then
  echo ">> Téléchargement de l'image InvenTree $INVENTREE_VERSION ..."
  docker compose pull inventree-server inventree-worker || true
fi

# ====== Initialisation / migration de la base (le -T évite un crash de TTY) ======
echo ">> invoke update (création/màj de la base, quelques minutes)..."
docker compose run --rm -T inventree-server invoke update

# ====== Correction worker=1 dans config.yaml (sinon plusieurs workers => +1 Go) ======
echo ">> Réglage background workers=1"
sudo sed -i '/^background:/,/^[^[:space:]]/ s/^\(\s*workers:\).*/\1 1/' "$DIR/$NAME-data/config.yaml"

# ====== Démarrage InvenTree ======
# (Le bloc SSO du config.yaml est injecté plus bas par setup_asso_sso, qui relance proprement.)
docker compose up -d

# ====== Scanette ======
if [ "$WITH_SCANETTE" = "1" ]; then
  SCANDIR="$DIR/scanette"
  UPSTREAM="http://$NAME-proxy:80"
  echo ">> Build de la Scanette ($SCANDIR) ..."
  mkdir -p "$SCANDIR/html"

  # Copie de TOUS les fichiers de l'app (hors notes/README du dossier source)
  find "$SCAN_SRC" -maxdepth 1 -type f \
       ! -iname 'README*' ! -name '*.md' ! -name '.gitkeep' \
       -exec cp -f {} "$SCANDIR/html/" \;

  # nginx : sert la Scanette à la RACINE du sous-domaine, et proxifie InvenTree (same-origin).
  # Clé du modèle : on force Host = $SCAN_HOST vers InvenTree. Du coup, vu du navigateur, tout
  # (app + API + callbacks SSO) vit sur https://$SCAN_HOST -> session InvenTree propre à ce
  # sous-domaine, et le redirect_uri OIDC qu'allauth construit pointe sur $SCAN_HOST (callback
  # à enregistrer côté Dex, fait par lib/sso.sh).
  cat > "$SCANDIR/default.conf" <<'CONF'
server {
    listen 80;
    server_name _;
    resolver 127.0.0.11 valid=30s ipv6=off;

    set $inv_upstream "__UPSTREAM__";
    set $inv_host     "__SCAN_HOST__";

    client_max_body_size 25m;

    # En-têtes communs pour tout ce qui part vers InvenTree (hérités par les location proxy).
    proxy_http_version 1.1;
    proxy_set_header Host              $inv_host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host  $inv_host;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Real-IP         $remote_addr;

    # --- App Scanette (single-file) servie à la racine ---
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }
    # Décodeur WebAssembly servi avec le bon type MIME
    location = /zxing_reader.wasm {
        default_type application/wasm;
        alias /usr/share/nginx/html/zxing_reader.wasm;
    }

    # --- InvenTree, proxifié en same-origin (pas de CORS, session partagée avec l'app) ---
    #   /api/      : API REST + endpoints headless allauth (/api/auth/v1/...)
    #   /accounts/ : callback OIDC (allauth monte /accounts/<provider>/login/callback/ même en headless)
    #   /static/ /media/ : assets servis par le Caddy interne d'InvenTree
    location /api/      { proxy_pass $inv_upstream; }
    location /accounts/ { proxy_pass $inv_upstream; }
    location /static/   { proxy_pass $inv_upstream; }
    location /media/    { proxy_pass $inv_upstream; }
}
CONF
  sed -i "s|__UPSTREAM__|$UPSTREAM|g; s|__SCAN_HOST__|$SCAN_HOST|g" "$SCANDIR/default.conf"

  # Dockerfile : on copie tout le dossier html/ (donc index.html, wasm, logos, etc.)
  cat > "$SCANDIR/Dockerfile" <<'DOCK'
FROM nginx:1.27-alpine
COPY default.conf /etc/nginx/conf.d/default.conf
COPY html/        /usr/share/nginx/html/
EXPOSE 80
DOCK

  # docker-compose.yml : projet ET conteneur uniques par asso (évite toute collision)
  cat > "$SCANDIR/docker-compose.yml" <<'SCANTPL'
name: __NAME__-scan
services:
  scanette:
    build: .
    container_name: __NAME__-scan
    restart: unless-stopped
    networks:
      - inventree-front

networks:
  inventree-front:
    external: true
SCANTPL
  sed -i "s/__NAME__/$NAME/g" "$SCANDIR/docker-compose.yml"

  ( cd "$SCANDIR" && docker compose up -d --build )
fi

# ====== Blocs Caddy frontaux (idempotent : on retire les anciens, on réécrit les bons) ======
# On supprime TOUT bloc de cette asso : l'InvenTree (contient "$NAME-proxy:80") ET la Scanette
# (contient "$NAME-scan:80"). Couvre aussi l'ancien bloc combiné `@scan` (il contenait les deux).
if [ -f "$FRONT/Caddyfile" ]; then
  awk -v a1="$NAME-proxy:80" -v a2="$NAME-scan:80" \
    'BEGIN{RS="";ORS="\n\n"} $0 !~ a1 && $0 !~ a2' \
    "$FRONT/Caddyfile" > "$FRONT/Caddyfile.tmp" && mv "$FRONT/Caddyfile.tmp" "$FRONT/Caddyfile"
fi
# Bloc InvenTree (toujours)
cat >> "$FRONT/Caddyfile" <<EOF

$HOST {
    reverse_proxy $NAME-proxy:80
}
EOF
# Bloc Scanette (sous-domaine dédié) si demandée
if [ "$WITH_SCANETTE" = "1" ]; then
  cat >> "$FRONT/Caddyfile" <<EOF

$SCAN_HOST {
    reverse_proxy $NAME-scan:80
}
EOF
fi
( cd "$FRONT" && docker compose up -d --force-recreate )

# ====== SSO EirbConnect (broker Dex) : tout automatisé ======
# Déploie/maj Dex, enregistre le client de cette asso, injecte le bloc OIDC dans config.yaml,
# relit le .env (SMTP) + config.yaml, et active les toggles SSO en base. (cf. lib/sso.sh)
if [ "$SSO_READY" = "1" ]; then
  if [ "$WITH_SCANETTE" = "1" ]; then
    setup_asso_sso "$NAME" "$HOST" "$DIR" "$SCAN_HOST"
  else
    setup_asso_sso "$NAME" "$HOST" "$DIR"
  fi
fi

# ====== Récap ======
echo ""
echo ">> ============================================================"
echo ">>  Asso '$NAME' prête !"
echo ">>    InvenTree : https://$HOST   (version épinglée: $INVENTREE_VERSION)"
[ "$WITH_SCANETTE" = "1" ] && echo ">>    Scanette  : https://$SCAN_HOST   (recharge avec ?v=N pour casser le cache)"
if [ "$KEEP_ENV" = "1" ]; then
  echo ">>    Identifiants : inchangés (voir ~/$NAME/.env)"
else
  echo ">>    Admin     : $ADMIN_USER"
  echo ">>    Password  : $ADMIN_PW   (modifiable après connexion)"
fi
if [ "$SSO_READY" = "1" ]; then
  echo ">> ------------------------------------------------------------"
  echo ">>  EirbConnect (SSO) : prêt, tout est automatique."
  echo ">>    - bouton 'EirbConnect' sur https://$HOST"
  [ "$WITH_SCANETTE" = "1" ] && echo ">>      (et sur la Scanette : https://$SCAN_HOST)"
  echo ">>    - un membre inconnu se connecte -> son compte est créé SANS groupe"
  echo ">>    - tu l'approuves : Admin Center -> Users -> (lui assigner un groupe)"
fi
echo ">> ============================================================"
echo ">>  Version InvenTree épinglée sur $INVENTREE_VERSION (les futures '$INVENTREE_VERSION' ne bougent pas tout seules)."
echo ">>    - mettre à jour CETTE asso (test/upgrade) : INVENTREE_VERSION=x.y.z ./create-asso.sh $NAME"
echo ">>    - changer domaine / version / SMTP partout : ./create-asso.sh --reconfigure"
echo ">>  Contrôle : docker stats --no-stream  ;  free -h"