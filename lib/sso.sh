#!/usr/bin/env bash
# lib/sso.sh — fonctions partagées : broker Dex (EirbConnect) + SSO InvenTree + SMTP.
#
# Sourcé par create-asso.sh et delete-asso.sh. NE S'EXÉCUTE PAS seul.
# Hérite des variables de create-asso.sh quand sourcé (BASE_DOMAIN, EIRBCONNECT_*, etc.) ;
# défauts fournis ci-dessous pour un usage standalone (auth/bootstrap-dex.sh).
#
# État runtime (hors repo) :
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
SMTP_ENV_FILE="${SMTP_ENV_FILE:-$MIC_DIR/smtp.env}"
DEX_CLIENTS_DIR="$MIC_DIR/dex-clients"
DEX_DIR="${DEX_DIR:-$HOME/auth-dex}"
FRONT="${FRONT:-$HOME/front}"
AUTH_DOMAIN="${AUTH_DOMAIN:-auth.$BASE_DOMAIN}"
DEX_ISSUER="https://$AUTH_DOMAIN/oauth2"
MSS_CLAMP="${MSS_CLAMP:-1240}"           # clamp MSS pour fiabiliser la route VPS->EirbConnect

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

# ------------------------------------------------------------------ SMTP (une fois)
load_smtp_credentials() {
  mkdir -p "$MIC_DIR"
  [ -f "$SMTP_ENV_FILE" ] && . "$SMTP_ENV_FILE"
  if [ -z "${SMTP_HOST:-}" ] || [ -z "${SMTP_USER:-}" ] || [ -z "${SMTP_PASS:-}" ]; then
    if [ -t 0 ]; then
      echo ">> Réglages email SMTP (une seule fois, stockés HORS du repo)"
      read -rp  "   Serveur SMTP  [ssl0.ovh.net] : " _h; SMTP_HOST="${_h:-ssl0.ovh.net}"
      read -rp  "   Port          [587]          : " _p; SMTP_PORT="${_p:-587}"
      read -rp  "   Identifiant (adresse complète, ex: contact@$BASE_DOMAIN) : " SMTP_USER
      read -rsp "   Mot de passe de la BOÎTE mail : " SMTP_PASS; echo
      read -rp  "   Expéditeur    [$SMTP_USER]    : " _s; SMTP_SENDER="${_s:-$SMTP_USER}"
      ( umask 077; cat > "$SMTP_ENV_FILE" <<EOF
SMTP_HOST='$SMTP_HOST'
SMTP_PORT='$SMTP_PORT'
SMTP_USER='$SMTP_USER'
SMTP_PASS='$SMTP_PASS'
SMTP_SENDER='$SMTP_SENDER'
EOF
      ); chmod 600 "$SMTP_ENV_FILE"
      echo ">> Enregistrés dans $SMTP_ENV_FILE (chmod 600, non versionné)"
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
  # 4) recrée server+worker -> relit le .env (SMTP) ET config.yaml (SSO) en une fois
  #    (restart seul ne relit PAS le .env ; up -d simple ne recrée pas sur un simple
  #     changement de config.yaml -> on force la recréation des 2 services concernés)
  ( cd "$dir" && docker compose up -d --force-recreate inventree-server inventree-worker >/dev/null 2>&1 ) || true
  # 5) toggles SSO + email admin (base)
  inventree_post_db "$dir" "admin_$name" "${ADMIN_EMAIL:-$SMTP_SENDER}"
  echo ">> SSO prêt : bouton EirbConnect sur https://$host (auto-création -> compte sans groupe -> tu assignes un groupe)."
}
