#!/usr/bin/env bash
#
# create-asso.sh — Déploie une asso COMPLÈTE en une seule commande :
#                  InvenTree (optimisé mémoire) + Scanette, derrière le Caddy frontal.
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
#   InvenTree -> https://<domaine>        Scanette -> https://<domaine>/scan/
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
# Variables d'environnement (optionnelles) :
#   BASE_DOMAIN    ton domaine (défaut: eirspace.fr ; vide "" => sslip.io, tests sans domaine)
#   SCAN_SRC       dossier source de l'app Scanette (défaut: <repo>/scanette-src)
#   WITH_SCANETTE  1 (défaut) = déploie aussi la Scanette ; 0 = InvenTree seul
#   MAIN_ASSO      asso principale au sous-domaine fixe (défaut: eirspace)
#   MAIN_SUBDOMAIN sous-domaine fixe de l'asso principale (défaut: inventaire)
#
#   --- EirbConnect (SSO OpenID Connect) ---
#   ENABLE_SSO     1 (défaut) = branche EirbConnect ; 0 = pas de SSO
#                    (auto-désactivé pour les instances éphémères sslip.io)
#   SSO_ENV_FILE   fichier des identifiants EirbConnect, HORS du repo
#                    (défaut: ~/.config/multi-inventory/eirbconnect.env, chmod 600)
#   EIRBCONNECT_CLIENT_ID / EIRBCONNECT_SECRET
#                    LES SEULES infos à toi : si absentes (env + fichier), elles sont
#                    DEMANDÉES une seule fois puis enregistrées dans SSO_ENV_FILE (jamais committé).
#   EIRBCONNECT_REALM     realm Keycloak EirbConnect — constante PUBLIQUE (défaut: eirb)
#   EIRBCONNECT_BASE_URL  hôte Keycloak EirbConnect — constante (défaut: https://connect.vpn.eirb.fr)
#                          (realm + hôte viennent de la doc Eirbware ; tu n'as PAS à les saisir)
#   OIDC_PROVIDER_ID      id interne du provider (défaut: eirbconnect ; sert aussi
#                          dans l'URL de callback /accounts/oidc/<id>/login/callback/)
#
# Exemples :
#   ./create-asso.sh eirspace                     -> https://inventaire.eirspace.fr  (asso principale)
#   ./create-asso.sh eirspace inventaire          -> https://inventaire.eirspace.fr  (identique, explicite)
#   ./create-asso.sh pixeirb  inventaire-pixeirb  -> https://inventaire-pixeirb.eirspace.fr
#   ./create-asso.sh vost                         -> https://inventaire-vost.eirspace.fr
#   ./create-asso.sh demo     tmp                 -> https://demo.<ip>.sslip.io  (éphémère)
#   ENABLE_SSO=0 ./create-asso.sh vost            -> sans SSO
#
# Idempotent : relancer = mettre à jour (l'.env est préservé, l'app rebuild, le frontal
#              recharge, le bloc SSO du config.yaml est remplacé et non dupliqué).
#
set -euo pipefail

# ====== Emplacement du repo (pour trouver scanette-src/) ======
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ====== Configuration ======
BASE_DOMAIN="${BASE_DOMAIN:-eirspace.fr}"          # vide ("") => sslip.io
SCAN_SRC="${SCAN_SRC:-$SCRIPT_DIR/scanette-src}"
WITH_SCANETTE="${WITH_SCANETTE:-1}"

# Exception "asso principale" : son sous-domaine est FIXE ("inventaire", pas
# "inventaire-<nom>"). Ainsi `./create-asso.sh eirspace` (sans 2e argument)
# retombe toujours sur https://inventaire.eirspace.fr — même après réinstallation.
MAIN_ASSO="${MAIN_ASSO:-eirspace}"
MAIN_SUBDOMAIN="${MAIN_SUBDOMAIN:-inventaire}"

# ====== EirbConnect (SSO OpenID Connect) ======
ENABLE_SSO="${ENABLE_SSO:-1}"
SSO_ENV_FILE="${SSO_ENV_FILE:-$HOME/.config/multi-inventory/eirbconnect.env}"
# Constantes EirbConnect issues de la doc Eirbware (realm + hôte). Publiques et fixes :
# tu n'as donc PAS à les saisir. Surchargeables par variable d'env si Eirbware change.
EIRBCONNECT_REALM="${EIRBCONNECT_REALM:-eirb}"
EIRBCONNECT_BASE_URL="${EIRBCONNECT_BASE_URL:-https://connect.vpn.eirb.fr}"
OIDC_PROVIDER_ID="${OIDC_PROVIDER_ID:-eirbconnect}"

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

# ====== Calcul de l'URL ======
if [ "$SUBDOMAIN" = "tmp" ] || [ -z "$BASE_DOMAIN" ]; then
  IP="$(curl -4 -s ifconfig.me)"; HOST="$NAME.${IP//./-}.sslip.io"   # éphémère / sans domaine
elif [ -n "$SUBDOMAIN" ]; then
  HOST="$SUBDOMAIN.$BASE_DOMAIN"            # sous-domaine explicite (gagne toujours)
elif [ "$NAME" = "$MAIN_ASSO" ]; then
  HOST="$MAIN_SUBDOMAIN.$BASE_DOMAIN"       # asso principale -> inventaire.eirspace.fr
else
  HOST="inventaire-$NAME.$BASE_DOMAIN"      # défaut -> inventaire-<nom>.eirspace.fr
fi

echo ">> Asso '$NAME'  ->  https://$HOST"
[ "$WITH_SCANETTE" = "1" ] && echo ">>   Scanette    ->  https://$HOST/scan/"
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
    else
      echo ">> SSO demandé mais identifiants EirbConnect manquants (mode non interactif ?) : on continue SANS SSO." >&2
    fi
  fi
fi

# ====== Caddyfile interne InvenTree (HTTP simple) ======
wget -q https://raw.githubusercontent.com/inventree/InvenTree/stable/contrib/container/Caddyfile -O Caddyfile
sed -i 's|^{$INVENTREE_SITE_URL:"http://, https://"} {|:80 {|' Caddyfile

# ====== .env (préservé s'il existe déjà, pour ne pas changer les mots de passe) ======
if [ -f .env ]; then
  KEEP_ENV=1
  echo ">> .env existant conservé (identifiants inchangés)"
else
  KEEP_ENV=0
  cat > .env <<EOF
COMPOSE_PROJECT_NAME=$NAME
INVENTREE_TAG=stable
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
INVENTREE_ADMIN_EMAIL=admin@$NAME.local
# --- Email : requis pour ACTIVER le SSO côté InvenTree. Décommente + remplis ton SMTP,
# --- sinon le toggle "Enable SSO" peut refuser de s'allumer. (Le login SSO lui-même
# --- n'envoie pas d'email : il rattache juste un compte existant par son adresse.)
#INVENTREE_EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend
#INVENTREE_EMAIL_HOST=
#INVENTREE_EMAIL_PORT=587
#INVENTREE_EMAIL_USERNAME=
#INVENTREE_EMAIL_PASSWORD=
#INVENTREE_EMAIL_TLS=True
#INVENTREE_EMAIL_SENDER=noreply@$NAME.local
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

# ====== Initialisation / migration de la base (le -T évite un crash de TTY) ======
echo ">> invoke update (création/màj de la base, quelques minutes)..."
docker compose run --rm -T inventree-server invoke update

# ====== Correction worker=1 dans config.yaml (sinon plusieurs workers => +1 Go) ======
echo ">> Réglage background workers=1"
sudo sed -i '/^background:/,/^[^[:space:]]/ s/^\(\s*workers:\).*/\1 1/' "$DIR/$NAME-data/config.yaml"

# ====== Injection EirbConnect (SSO OIDC) dans config.yaml ======
# config.yaml vient d'être généré par 'invoke update'. On y ajoute, ENTRE MARQUEURS
# (donc idempotent : un re-run remplace le bloc au lieu de le dupliquer), le provider
# OpenID Connect d'EirbConnect.
#   EMAIL_AUTHENTICATION: true  => un login SSO se rattache au compte InvenTree qui a le
#   MÊME email. C'est ta whitelist : seuls les comptes pré-créés (avec l'email renvoyé par
#   EirbConnect) peuvent entrer ; les autres tombent sur "sign up closed".
#   (Sûr ici car l'IdP est le Keycloak de l'école, de confiance, qui maîtrise les emails.)
CONFIG_YAML="$DIR/$NAME-data/config.yaml"
if [ "$SSO_READY" = "1" ]; then
  echo ">> Injection EirbConnect (OIDC) dans config.yaml"
  SSO_SERVER_URL="$EIRBCONNECT_BASE_URL/realms/$EIRBCONNECT_REALM/.well-known/openid-configuration"
  # retire un éventuel ancien bloc (re-run), puis réécrit le bloc courant
  sudo sed -i '/# >>> EIRBCONNECT-SSO >>>/,/# <<< EIRBCONNECT-SSO <<</d' "$CONFIG_YAML"
  sudo tee -a "$CONFIG_YAML" >/dev/null <<EOF
# >>> EIRBCONNECT-SSO >>>
social_backends:
  - 'allauth.socialaccount.providers.openid_connect'
social_providers:
  openid_connect:
    OAUTH_PKCE_ENABLED: true
    EMAIL_AUTHENTICATION: true
    APPS:
      - provider_id: $OIDC_PROVIDER_ID
        name: EirbConnect
        client_id: '$EIRBCONNECT_CLIENT_ID'
        secret: '$EIRBCONNECT_SECRET'
        settings:
          server_url: '$SSO_SERVER_URL'
# <<< EIRBCONNECT-SSO <<<
EOF
fi

# ====== Démarrage InvenTree ======
docker compose up -d

# Le serveur ne lit config.yaml qu'au DÉMARRAGE : si le SSO a été (re)injecté, on force un
# restart du serveur et du worker pour qu'ils prennent en compte EirbConnect (indispensable
# sur un re-run où les conteneurs tournaient déjà).
if [ "$SSO_READY" = "1" ]; then
  echo ">> Redémarrage server+worker pour appliquer le SSO"
  docker compose restart inventree-server inventree-worker
fi

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

  # nginx : SPA sur /scan/, proxy /scan/api/ et /scan/media/ vers l'InvenTree interne
  cat > "$SCANDIR/default.conf" <<'CONF'
server {
    listen 80;
    server_name _;
    resolver 127.0.0.11 valid=30s ipv6=off;

    set $inv_upstream "__UPSTREAM__";
    set $inv_host     "__HOST__";

    # App (single-file) servie sous /scan/
    location /scan/ {
        alias /usr/share/nginx/html/;
        try_files $uri $uri/ /usr/share/nginx/html/index.html;
        add_header Cache-Control "no-cache";
    }
    location = /     { return 301 /scan/; }
    location = /scan { return 301 /scan/; }

    # API InvenTree (proxy same-origin -> pas de CORS)
    location /scan/api/ {
        rewrite ^/scan(/.*)$ $1 break;
        proxy_pass $inv_upstream;
        proxy_set_header Host              $inv_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host  $inv_host;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_http_version 1.1;
        client_max_body_size 25m;
    }
    # Images / medias InvenTree
    location /scan/media/ {
        rewrite ^/scan(/.*)$ $1 break;
        proxy_pass $inv_upstream;
        proxy_set_header Host $inv_host;
        proxy_http_version 1.1;
    }
    # Décodeur WebAssembly servi avec le bon type MIME
    location = /scan/zxing_reader.wasm {
        default_type application/wasm;
        alias /usr/share/nginx/html/zxing_reader.wasm;
    }
}
CONF
  sed -i "s|__UPSTREAM__|$UPSTREAM|g; s|__HOST__|$HOST|g" "$SCANDIR/default.conf"

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

# ====== Bloc Caddy frontal (idempotent : on retire l'ancien, on réécrit le bon) ======
if [ -f "$FRONT/Caddyfile" ]; then
  awk -v alias="$NAME-proxy:80" 'BEGIN{RS="";ORS="\n\n"} $0 !~ alias' \
    "$FRONT/Caddyfile" > "$FRONT/Caddyfile.tmp" && mv "$FRONT/Caddyfile.tmp" "$FRONT/Caddyfile"
fi
if [ "$WITH_SCANETTE" = "1" ]; then
  cat >> "$FRONT/Caddyfile" <<EOF

$HOST {
    @scan path /scan /scan/*
    handle @scan {
        reverse_proxy $NAME-scan:80
    }
    handle {
        reverse_proxy $NAME-proxy:80
    }
}
EOF
else
  cat >> "$FRONT/Caddyfile" <<EOF

$HOST {
    reverse_proxy $NAME-proxy:80
}
EOF
fi
( cd "$FRONT" && docker compose up -d --force-recreate )

# ====== Récap ======
echo ""
echo ">> ============================================================"
echo ">>  Asso '$NAME' prête !"
echo ">>    InvenTree : https://$HOST"
[ "$WITH_SCANETTE" = "1" ] && echo ">>    Scanette  : https://$HOST/scan/   (recharge avec ?v=N pour casser le cache)"
if [ "$KEEP_ENV" = "1" ]; then
  echo ">>    Identifiants : inchangés (voir ~/$NAME/.env)"
else
  echo ">>    Admin     : $ADMIN_USER"
  echo ">>    Password  : $ADMIN_PW   (modifiable après connexion)"
fi
if [ "$SSO_READY" = "1" ]; then
  echo ">> ------------------------------------------------------------"
  echo ">>  EirbConnect (SSO) : 3 étapes manuelles restantes"
  echo ">>   1) Fais AUTORISER cette redirect URI côté Keycloak (Eirbware) :"
  echo ">>        https://$HOST/accounts/oidc/$OIDC_PROVIDER_ID/login/callback/"
  echo ">>      (selon la version d'allauth, elle peut être sans le segment"
  echo ">>       '$OIDC_PROVIDER_ID' -> vérifie via un login test le redirect_uri envoyé)"
  echo ">>   2) Connecte-toi (admin) -> Admin Center -> Login settings :"
  echo ">>        active 'Enable SSO'  +  DÉSACTIVE 'Enable SSO registration'"
  echo ">>        (si 'Enable SSO' refuse de s'allumer -> configure l'email dans ~/$NAME/.env)"
  echo ">>   3) Login test EirbConnect -> note l'email renvoyé -> crée les comptes membres"
  echo ">>        avec CET email (Users -> add user, sans mot de passe, + un groupe)"
fi
echo ">> ============================================================"
echo ">>  Contrôle : docker stats --no-stream  ;  free -h"
