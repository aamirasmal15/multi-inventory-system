#!/usr/bin/env bash
# lib/sso.sh — fonctions partagées : broker Dex (EirbConnect) + SSO InvenTree + SMTP + réglages plateforme.
#
# Sourcé par create-asso.sh et delete-asso.sh. NE S'EXÉCUTE PAS seul.
# Hérite des variables de create-asso.sh quand sourcé (BASE_DOMAIN, EIRBCONNECT_*, etc.) ;
# défauts fournis ci-dessous pour un usage standalone (auth/bootstrap-dex.sh).
#
# État runtime (hors repo) :
#   ~/.config/multi-inventory/settings.env      domaine + version InvenTree épinglée (partagés)
#   ~/.config/multi-inventory/eirbconnect.env   creds EirbConnect (déjà gérés par create-asso.sh)
#   ~/.config/multi-inventory/smtp.env          creds SMTP (demandés une fois ici)
#   ~/.config/multi-inventory/dex-clients/*.yaml 1 fragment de staticClient Dex par asso
#   ~/auth-dex/                                 broker Dex généré (config.yaml + docker-compose.yml)

# ------------------------------------------------------------------ constantes
: "${BASE_DOMAIN:=eirspace.fr}"
: "${EIRBCONNECT_REALM:=eirb}"
: "${EIRBCONNECT_BASE_URL:=https://connect.vpn.eirb.fr}"
: "${OIDC_PROVIDER_ID:=eirbconnect}"
: "${SSO_ENV_FILE:=$HOME/.config/multi-inventory/eirbconnect.env}"

MIC_DIR="$HOME/.config/multi-inventory"
SETTINGS_ENV_FILE="${SETTINGS_ENV_FILE:-$MIC_DIR/settings.env}"
SMTP_ENV_FILE="${SMTP_ENV_FILE:-$MIC_DIR/smtp.env}"
DEX_CLIENTS_DIR="$MIC_DIR/dex-clients"
DEX_DIR="${DEX_DIR:-$HOME/auth-dex}"
FRONT="${FRONT:-$HOME/front}"
AUTH_DOMAIN="${AUTH_DOMAIN:-auth.$BASE_DOMAIN}"
DEX_ISSUER="https://$AUTH_DOMAIN/oauth2"
MSS_CLAMP="${MSS_CLAMP:-1240}"           # clamp MSS pour fiabiliser la route VPS->EirbConnect

# Version InvenTree épinglée par défaut (le système est validé sur 1.4.0).
: "${INVENTREE_PINNED_DEFAULT:=1.4.0}"

# ============================================================ RÉGLAGES PLATEFORME
# settings.env = source unique du domaine ET de la version InvenTree épinglée.
# Édités d'un coup via `./create-asso.sh --reconfigure`.

_save_platform_settings() {
  mkdir -p "$MIC_DIR"
  ( umask 077; cat > "$SETTINGS_ENV_FILE" <<EOF
# Réglages partagés de la plateforme (édités via ./create-asso.sh --reconfigure)
BASE_DOMAIN='${BASE_DOMAIN}'
INVENTREE_VERSION='${INVENTREE_VERSION:-$INVENTREE_PINNED_DEFAULT}'
EOF
  ); chmod 600 "$SETTINGS_ENV_FILE"
}

# Charge BASE_DOMAIN + INVENTREE_VERSION.
# Priorité : override d'environnement (variable settée, même vide) > settings.env > saisie (1er run) > défaut.
# $1 / $2 = "1" si la variable a été fixée par l'utilisateur AVANT le source de la lib
#           (sinon la lib lui aura déjà collé un défaut, on ne saurait plus distinguer).
load_platform_settings() {
  local domain_was_set="${1:-}" version_was_set="${2:-}"
  mkdir -p "$MIC_DIR"
  local saved_domain="" saved_ver=""
  if [ -f "$SETTINGS_ENV_FILE" ]; then
    saved_domain="$(sed -n "s/^BASE_DOMAIN='\(.*\)'$/\1/p" "$SETTINGS_ENV_FILE" | head -1)"
    saved_ver="$(sed -n "s/^INVENTREE_VERSION='\(.*\)'$/\1/p" "$SETTINGS_ENV_FILE" | head -1)"
  fi

  # --- Domaine ---
  if [ -z "$domain_was_set" ]; then            # pas d'override utilisateur -> settings / saisie
    if [ -n "$saved_domain" ]; then
      BASE_DOMAIN="$saved_domain"
    elif [ -t 0 ]; then
      echo ">> Premier lancement : quel est TON nom de domaine ?"
      echo "   (les assos sortent en sous-domaines, ex: inventaire.<domaine> ; le broker SSO sur auth.<domaine>)"
      read -rp  "   Domaine [eirspace.fr] : " _d; BASE_DOMAIN="${_d:-eirspace.fr}"
    else
      BASE_DOMAIN="${saved_domain:-eirspace.fr}"
    fi
  fi

  # --- Version InvenTree épinglée ---
  if [ -z "$version_was_set" ]; then
    INVENTREE_VERSION="${saved_ver:-$INVENTREE_PINNED_DEFAULT}"
  fi

  # Re-dérive les domaines dépendants (le domaine vient peut-être d'être saisi/chargé).
  AUTH_DOMAIN="auth.$BASE_DOMAIN"
  DEX_ISSUER="https://$AUTH_DOMAIN/oauth2"

  _save_platform_settings
}

# Reconfiguration globale : domaine + version + SMTP, puis propagation du SMTP à TOUTES les assos.
reconfigure_platform() {
  mkdir -p "$MIC_DIR"
  [ -f "$SETTINGS_ENV_FILE" ] && . "$SETTINGS_ENV_FILE"
  : "${BASE_DOMAIN:=eirspace.fr}"; : "${INVENTREE_VERSION:=$INVENTREE_PINNED_DEFAULT}"

  echo "================ Reconfiguration de la plateforme ================"
  echo "Tape Entrée pour garder la valeur [entre crochets]."
  echo ""
  read -rp "  Domaine de base               [$BASE_DOMAIN] : " _d
  BASE_DOMAIN="${_d:-$BASE_DOMAIN}"
  read -rp "  Version InvenTree épinglée    [$INVENTREE_VERSION] : " _v
  INVENTREE_VERSION="${_v:-$INVENTREE_VERSION}"
  AUTH_DOMAIN="auth.$BASE_DOMAIN"; DEX_ISSUER="https://$AUTH_DOMAIN/oauth2"
  _save_platform_settings
  echo ">> settings.env mis à jour : domaine=$BASE_DOMAIN, version InvenTree=$INVENTREE_VERSION"
  echo ""

  echo "------------------------- SMTP -------------------------"
  load_smtp_credentials 1            # 1 = force la ressaisie (montre les valeurs actuelles en défaut)
  echo ""

  echo "------------- Propagation du SMTP aux assos -------------"
  apply_smtp_to_all_assos
  echo ""

  echo "================================================================="
  echo ">> Domaine : les assos DÉJÀ déployées gardent leur sous-domaine actuel."
  echo ">>   Le nouveau domaine ne s'applique qu'aux PROCHAINES créations."
  echo ">>   (migrer une asso existante vers le nouveau domaine = la relancer : ./create-asso.sh <nom>)"
  echo ">> Version : pour mettre à jour UNE asso : INVENTREE_VERSION=x.y.z ./create-asso.sh <nom>"
  echo ">>   Le défaut ($INVENTREE_VERSION) ne touche que les futures créations / re-runs sans surcharge."
}

# ------------------------------------------------------- creds EirbConnect (réutilise SSO_ENV_FILE)
_load_eirbconnect() {
  [ -f "$SSO_ENV_FILE" ] && . "$SSO_ENV_FILE"
  if [ -z "${EIRBCONNECT_CLIENT_ID:-}" ] || [ -z "${EIRBCONNECT_SECRET:-}" ]; then
    if [ -t 0 ]; then
      echo ">> Identifiants EirbConnect (une seule fois, stockés HORS du repo)"
      [ -z "${EIRBCONNECT_CLIENT_ID:-}" ] && read -rp  "   Client ID     : " EIRBCONNECT_CLIENT_ID
      [ -z "${EIRBCONNECT_SECRET:-}" ]    && { read -rsp "   Client secret : " EIRBCONNECT_SECRET; echo; }
      mkdir -p "$MIC_DIR"
      ( umask 077; cat > "$SSO_ENV_FILE" <<EOF
EIRBCONNECT_CLIENT_ID='$EIRBCONNECT_CLIENT_ID'
EIRBCONNECT_SECRET='$EIRBCONNECT_SECRET'
EOF
      ); chmod 600 "$SSO_ENV_FILE"
    else
      echo "!! creds EirbConnect manquants et pas de terminal." >&2; return 1
    fi
  fi
}

# ------------------------------------------------------------------ SMTP
# $1 = "1" -> force la ressaisie même si déjà configuré (pour --reconfigure).
load_smtp_credentials() {
  local force="${1:-0}"
  mkdir -p "$MIC_DIR"
  [ -f "$SMTP_ENV_FILE" ] && . "$SMTP_ENV_FILE"

  if [ "$force" = "1" ] || [ -z "${SMTP_HOST:-}" ] || [ -z "${SMTP_USER:-}" ] || [ -z "${SMTP_PASS:-}" ]; then
    if [ -t 0 ]; then
      if [ "$force" = "1" ]; then
        echo ">> Reconfiguration SMTP (sera réappliquée à TOUTES les assos)."
      else
        echo ">> Réglages email SMTP — demandés UNE SEULE FOIS, stockés hors repo (chmod 600)."
      fi
      echo "   Tape simplement Entrée pour garder la valeur proposée [entre crochets]."
      local d_host="${SMTP_HOST:-ssl0.ovh.net}" d_port="${SMTP_PORT:-587}"
      local d_user="${SMTP_USER:-contact@$BASE_DOMAIN}" d_send="${SMTP_SENDER:-${SMTP_USER:-}}"
      read -rp  "   Serveur SMTP                     [$d_host] : " _h; SMTP_HOST="${_h:-$d_host}"
      read -rp  "   Port (587 STARTTLS / 465 SSL)    [$d_port] : " _p; SMTP_PORT="${_p:-$d_port}"
      read -rp  "   Identifiant = adresse mail complète [$d_user] : " _u; SMTP_USER="${_u:-$d_user}"
      if [ -n "${SMTP_PASS:-}" ]; then
        read -rsp "   Mot de passe de la BOÎTE mail (Entrée = inchangé) : " _pw; echo
        [ -n "$_pw" ] && SMTP_PASS="$_pw"
      else
        read -rsp "   Mot de passe de la BOÎTE mail (le mdp du webmail, pas le compte OVH) : " SMTP_PASS; echo
      fi
      read -rp  "   Expéditeur affiché (From)        [$d_send] : " _s; SMTP_SENDER="${_s:-$d_send}"
      ( umask 077; cat > "$SMTP_ENV_FILE" <<EOF
SMTP_HOST='$SMTP_HOST'
SMTP_PORT='$SMTP_PORT'
SMTP_USER='$SMTP_USER'
SMTP_PASS='$SMTP_PASS'
SMTP_SENDER='$SMTP_SENDER'
EOF
      ); chmod 600 "$SMTP_ENV_FILE"
      echo ">> SMTP enregistré dans $SMTP_ENV_FILE (chmod 600, non versionné)."
    else
      echo "!! SMTP non configuré et pas de terminal -> l'auto-création SSO sera bloquée." >&2
    fi
  fi
  : "${SMTP_PORT:=587}"; : "${SMTP_SENDER:=${SMTP_USER:-}}"
}

# Lignes INVENTREE_EMAIL_* à coller dans un .env (port 465 -> SSL, sinon STARTTLS).
smtp_env_block() {
  local tls=True ssl=False
  [ "${SMTP_PORT:-587}" = "465" ] && { tls=False; ssl=True; }
  cat <<EOF
INVENTREE_EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend
INVENTREE_EMAIL_HOST=${SMTP_HOST}
INVENTREE_EMAIL_PORT=${SMTP_PORT}
INVENTREE_EMAIL_USERNAME=${SMTP_USER}
INVENTREE_EMAIL_PASSWORD=${SMTP_PASS}
INVENTREE_EMAIL_TLS=${tls}
INVENTREE_EMAIL_SSL=${ssl}
INVENTREE_EMAIL_SENDER=${SMTP_SENDER}
EOF
}

# Réapplique le SMTP courant au .env de CHAQUE asso InvenTree puis recrée le conteneur.
# (Ne touche pas à INVENTREE_ADMIN_EMAIL.)
apply_smtp_to_all_assos() {
  load_smtp_credentials            # s'assure que les valeurs sont chargées
  local count=0 env d
  for env in "$HOME"/*/.env; do
    [ -f "$env" ] || continue
    grep -q '^INVENTREE_DB_ENGINE=' "$env" || continue   # marqueur "asso InvenTree"
    d="$(dirname "$env")"
    sed -i '/^#\?[[:space:]]*INVENTREE_EMAIL_/d' "$env"
    smtp_env_block >> "$env"
    ( cd "$d" && docker compose up -d >/dev/null 2>&1 ) || true
    count=$((count+1))
    echo "   - $(basename "$d") : SMTP réappliqué + conteneur relancé."
  done
  echo ">> SMTP propagé à $count asso(s)."
}

# ------------------------------------------------------------------ Dex : infra
_dex_apply_mss_clamp() {
  local r=(-p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "$MSS_CLAMP")
  if ! sudo iptables -t mangle -C FORWARD "${r[@]}" 2>/dev/null; then
    sudo iptables -t mangle -A FORWARD "${r[@]}" 2>/dev/null \
      && echo ">> clamp MSS $MSS_CLAMP ajouté (route VPS->EirbConnect)" || true
    echo ">> (rends-le permanent : 'sudo apt install iptables-persistent' puis 'sudo netfilter-persistent save')"
  fi
}

_dex_ensure_front_route() {
  mkdir -p "$FRONT"; [ -f "$FRONT/Caddyfile" ] || touch "$FRONT/Caddyfile"
  if ! grep -qE "^${AUTH_DOMAIN}[[:space:]]*\{" "$FRONT/Caddyfile" 2>/dev/null; then
    cat >> "$FRONT/Caddyfile" <<EOF

$AUTH_DOMAIN {
    reverse_proxy dex:5556
}
EOF
    ( cd "$FRONT" && docker compose up -d --force-recreate >/dev/null 2>&1 ) || true
    echo ">> route frontale $AUTH_DOMAIN -> dex ajoutée"
  fi
}

# Prépare l'infra Dex (compose, clamp, route frontale). NE démarre PAS Dex (cf. dex_render_and_reload).
dex_ensure_up() {
  _load_eirbconnect || return 1
  mkdir -p "$DEX_DIR" "$DEX_CLIENTS_DIR"
  if [ ! -f "$DEX_DIR/docker-compose.yml" ]; then
    cat > "$DEX_DIR/docker-compose.yml" <<'EOF'
services:
  dex:
    image: ghcr.io/dexidp/dex:latest
    container_name: dex
    restart: unless-stopped        # si un blip EirbConnect au boot -> Docker relance Dex tout seul
    command: ["dex", "serve", "/etc/dex/config.yaml"]
    volumes:
      - ./config.yaml:/etc/dex/config.yaml:ro
    networks: [front]
networks:
  front:
    external: true
    name: inventree-front
EOF
  fi
  _dex_apply_mss_clamp
  _dex_ensure_front_route
}

# (Re)génère ~/auth-dex/config.yaml = base (issuer + connecteur EirbConnect) + tous les fragments, puis relance Dex.
dex_render_and_reload() {
  _load_eirbconnect || return 1
  local cfg="$DEX_DIR/config.yaml"
  {
    cat <<EOF
issuer: $DEX_ISSUER
storage:
  type: memory
web:
  http: 0.0.0.0:5556
oauth2:
  skipApprovalScreen: true
connectors:
  - type: oidc
    id: $OIDC_PROVIDER_ID
    name: EirbConnect
    config:
      issuer: $EIRBCONNECT_BASE_URL/realms/$EIRBCONNECT_REALM
      clientID: '$EIRBCONNECT_CLIENT_ID'
      clientSecret: '$EIRBCONNECT_SECRET'
      redirectURI: $DEX_ISSUER/callback
      scopes: [openid, profile, email]
      getUserInfo: true
      insecureSkipEmailVerified: true
      claimMapping:
        preferred_username: uid
EOF
    if ls "$DEX_CLIENTS_DIR"/*.yaml >/dev/null 2>&1; then
      echo "staticClients:"
      cat "$DEX_CLIENTS_DIR"/*.yaml
    else
      echo "staticClients: []"
    fi
  } > "$cfg"
  chmod 644 "$cfg"
  ( cd "$DEX_DIR" && docker compose up -d --force-recreate >/dev/null 2>&1 ) || true
  echo ">> Dex (re)généré : $(ls -1 "$DEX_CLIENTS_DIR"/*.yaml 2>/dev/null | wc -l | tr -d ' ') client(s)"
}

# Écrit/maj le fragment de client Dex de l'asso. Préserve le secret existant. Renvoie le secret sur stdout.
dex_register_client() {
  local name="$1" host="$2" frag secret=""
  mkdir -p "$DEX_CLIENTS_DIR"
  frag="$DEX_CLIENTS_DIR/$name.yaml"
  if [ -f "$frag" ]; then
    secret="$(grep -m1 'secret:' "$frag" 2>/dev/null | sed -E "s/.*secret: *'([^']*)'.*/\1/")" || true
  fi
  [ -n "$secret" ] || secret="$(openssl rand -hex 24)"
  cat > "$frag" <<EOF
  - id: inventree-$name
    name: InvenTree $name
    secret: '$secret'
    redirectURIs:
      - http://$host/accounts/$OIDC_PROVIDER_ID/login/callback/
      - https://$host/accounts/$OIDC_PROVIDER_ID/login/callback/
      - http://$host/accounts/oidc/$OIDC_PROVIDER_ID/login/callback/
      - https://$host/accounts/oidc/$OIDC_PROVIDER_ID/login/callback/
EOF
  echo "$secret"
}

dex_remove_client() {
  local name="$1"
  rm -f "$DEX_CLIENTS_DIR/$name.yaml"
  [ -d "$DEX_DIR" ] && dex_render_and_reload || true
}

# ------------------------------------------------------------------ InvenTree
# Injecte le bloc OIDC (-> Dex) dans config.yaml entre marqueurs (idempotent : remplace, ne duplique pas).
inventree_inject_sso() {
  local name="$1" host="$2" cfg="$3" secret="$4"
  sudo sed -i '/# >>> EIRBCONNECT-SSO >>>/,/# <<< EIRBCONNECT-SSO <<</d' "$cfg"
  sudo tee -a "$cfg" >/dev/null <<EOF

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
        client_id: 'inventree-$name'
        secret: '$secret'
        settings:
          server_url: '$DEX_ISSUER/.well-known/openid-configuration'
          oauth_pkce_enabled: true
          fetch_userinfo: true
# <<< EIRBCONNECT-SSO <<<
EOF
}

# Active les toggles SSO en base + pose l'email admin. Attend que le serveur soit up (retry ~60s).
inventree_post_db() {
  local dir="$1" admin="$2" email="$3" tries=0
  local py="from common.models import InvenTreeSetting as S
for k in ('LOGIN_ENABLE_SSO','LOGIN_ENABLE_SSO_REG','LOGIN_SIGNUP_SSO_AUTO'):
    S.set_setting(k, True, None)
from django.contrib.auth import get_user_model
u = get_user_model().objects.filter(username='$admin').first()
if u and not u.email:
    u.email = '$email'; u.save()
print('SSO_DB_OK')"
  ( cd "$dir"
    until docker compose exec -T inventree-server python3 manage.py shell -c "$py" 2>/dev/null | grep -q SSO_DB_OK; do
      tries=$((tries+1)); [ "$tries" -ge 12 ] && exit 1; sleep 5
    done
  ) && echo ">> Toggles SSO activés (Enable SSO + registration + auto-fill) + email admin posé." \
    || echo "!! À activer à la main : Admin Center > Settings > Login (Enable SSO + Enable SSO registration)."
}

# ============================================================ ENTRÉE PRINCIPALE
# Tout le SSO d'une asso en une fonction. À appeler en FIN de create-asso.sh (stack démarrée).
#   setup_asso_sso <nom> <host> <dir>
setup_asso_sso() {
  local name="$1" host="$2" dir="$3"
  local cfg="$dir/$name-data/config.yaml" secret
  echo ">> SSO EirbConnect (via Dex) pour '$name' ..."
  # 1) SMTP + email admin dans le .env (idempotent) — requis pour l'auto-création
  load_smtp_credentials
  sed -i '/^#\?[[:space:]]*INVENTREE_EMAIL_/d; /^INVENTREE_ADMIN_EMAIL=/d' "$dir/.env"
  { smtp_env_block; echo "INVENTREE_ADMIN_EMAIL=${ADMIN_EMAIL:-$SMTP_SENDER}"; } >> "$dir/.env"
  # 2) broker Dex + client de cette asso
  dex_ensure_up
  secret="$(dex_register_client "$name" "$host")"
  dex_render_and_reload
  # 3) bloc OIDC InvenTree -> Dex
  inventree_inject_sso "$name" "$host" "$cfg" "$secret"
  # 4) recrée le conteneur -> relit le .env (SMTP) + config.yaml (SSO)
  ( cd "$dir" && docker compose up -d >/dev/null 2>&1 ) || true
  # 5) toggles SSO + email admin (base)
  inventree_post_db "$dir" "admin_$name" "${ADMIN_EMAIL:-$SMTP_SENDER}"
  echo ">> SSO prêt : bouton EirbConnect sur https://$host (auto-création -> compte sans groupe -> tu assignes un groupe)."
}
