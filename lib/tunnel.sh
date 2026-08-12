#!/usr/bin/env bash
# lib/tunnel.sh : mise en place automatique du tunnel Cloudflare « web »
# (mode EDGE=cloudflare-tunnel de create-asso.sh).
#
# Idempotent et volontairement myope : il ne connaît QUE le tunnel nommé « web »
# et le dossier ~/tunnel-web. Il ne liste, ne modifie, ne supprime JAMAIS un
# autre tunnel du compte — si l'accès SSH au serveur passe lui-même par un
# tunnel Cloudflare (ligne de vie), rien ici ne peut le toucher.
#
# Tout passe par l'image docker cloudflare/cloudflared : rien à installer sur
# l'hôte. Le HOME du conteneur est pointé sur ~/tunnel-web/cloudflared/, où
# vivent cert.pem (autorisation du compte, obtenue une fois via le navigateur)
# et <ID>.json (credentials du tunnel, secret).

TUNNEL_WEB_DIR="${TUNNEL_WEB_DIR:-$HOME/tunnel-web}"

# cloudflared jetable dans docker ; _CF_TTY=-t pour les commandes interactives
_cf() {
  docker run --rm -i ${_CF_TTY:-} --user "$(id -u):$(id -g)" -e HOME=/hh \
    -v "$TUNNEL_WEB_DIR/cloudflared:/hh/.cloudflared" \
    cloudflare/cloudflared:latest "$@"
}

setup_cloudflare_tunnel() {  # $1 = un host de l'asso (le wildcard en dérive)
  local host="$1" wildcard tid
  wildcard="*.${host#*.}"
  mkdir -p "$TUNNEL_WEB_DIR/cloudflared"

  # Déjà en place ? On s'assure juste que le conteneur tourne, et c'est tout.
  if [ -f "$TUNNEL_WEB_DIR/cloudflared/config.yml" ] && [ -f "$TUNNEL_WEB_DIR/docker-compose.yml" ]; then
    ( cd "$TUNNEL_WEB_DIR" && docker compose up -d >/dev/null 2>&1 ) || true
    return 0
  fi

  echo ">> Tunnel Cloudflare « web » : mise en place automatique (une seule fois) ..."

  # 1) Autorisation du compte (cert.pem). Réutilisée si un cloudflared de
  #    l'hôte a déjà fait son login ; sinon login interactif : cloudflared
  #    affiche une URL, à ouvrir dans le navigateur (compte qui gère le domaine).
  if [ ! -f "$TUNNEL_WEB_DIR/cloudflared/cert.pem" ]; then
    if [ -f "$HOME/.cloudflared/cert.pem" ]; then
      cp "$HOME/.cloudflared/cert.pem" "$TUNNEL_WEB_DIR/cloudflared/cert.pem"
    elif [ -t 0 ]; then
      echo ">>   Autorisation Cloudflare : ouvre l'URL qui va s'afficher dans ton navigateur,"
      echo ">>   connecte-toi au compte qui gère le domaine et choisis-le."
      _CF_TTY=-t _cf tunnel login || {
        echo "!! Autorisation échouée/refusée : tunnel à poser à la main (wiki « Exposition publique »)."
        return 1
      }
    else
      echo "!! Pas d'autorisation Cloudflare (cert.pem) et pas de terminal pour la demander :"
      echo "!!   relance './create-asso.sh <nom>' dans un terminal interactif."
      return 1
    fi
    chmod 600 "$TUNNEL_WEB_DIR/cloudflared/cert.pem" 2>/dev/null || true
  fi

  # 2) Le tunnel « web » : réutilisé s'il existe déjà sur le compte.
  tid="$(_cf tunnel list 2>/dev/null | awk '$2 == "web" {print $1; exit}')"
  if [ -z "$tid" ]; then
    _cf tunnel create web >/dev/null 2>&1 || true
    tid="$(_cf tunnel list 2>/dev/null | awk '$2 == "web" {print $1; exit}')"
  fi
  if [ -z "$tid" ]; then
    echo "!! Création du tunnel « web » impossible (autorisation ? réseau ?) : voir le wiki."
    return 1
  fi
  echo ">>   tunnel « web » : $tid"

  # 'tunnel create' écrit les credentials dans le ~/.cloudflared du conteneur,
  # c'est-à-dire directement dans $TUNNEL_WEB_DIR/cloudflared/. Un tunnel « web »
  # préexistant SANS credentials locales ne peut pas tourner d'ici : on le dit
  # plutôt que d'échouer en silence au démarrage du conteneur.
  if [ ! -f "$TUNNEL_WEB_DIR/cloudflared/$tid.json" ]; then
    echo "!! Le tunnel « web » existe déjà sur le compte, mais ses credentials ne sont pas"
    echo "!!   sur ce serveur ($TUNNEL_WEB_DIR/cloudflared/$tid.json manquant)."
    echo "!!   Récupère-les depuis la machine d'origine, ou supprime ce tunnel côté"
    echo "!!   Cloudflare et relance (un neuf sera créé). Wiki « Exposition publique »."
    return 1
  fi
  chmod 600 "$TUNNEL_WEB_DIR/cloudflared/$tid.json" 2>/dev/null || true

  # 3) Fichiers : config du tunnel + compose (template, uid substitué).
  cat > "$TUNNEL_WEB_DIR/cloudflared/config.yml" <<EOF
# Tunnel Cloudflare « web » — généré par create-asso.sh (lib/tunnel.sh).
# Un éventuel tunnel SSH reste séparé (ligne de vie) : ne pas fusionner.
tunnel: $tid
credentials-file: /etc/cloudflared/$tid.json
protocol: http2          # QUIC/UDP souvent filtré (campus) : http2 = TCP 443
ingress:
  - hostname: "$wildcard"
    service: http://front-caddy:80
  - service: http_status:404
EOF
  require_template "tunnel-web-docker-compose.yml"
  sed "s/__UID__/$(id -u)/g; s/__GID__/$(id -g)/g" \
    "$TEMPLATES_DIR/tunnel-web-docker-compose.yml" > "$TUNNEL_WEB_DIR/docker-compose.yml"

  # 4) Démarrage + route DNS (best effort : on n'écrase JAMAIS un record
  #    existant — le DNS d'une zone peut porter d'autres choses).
  docker network create inventree-front 2>/dev/null || true
  ( cd "$TUNNEL_WEB_DIR" && docker compose up -d )
  if _cf tunnel route dns web "$wildcard" >/dev/null 2>&1; then
    echo ">>   DNS : $wildcard routé vers le tunnel."
  else
    echo "!!   Route DNS à finir à la main (record '*' déjà existant, ou wildcard refusé en CLI) :"
    echo "!!   dashboard Cloudflare -> DNS -> '*' CNAME $tid.cfargotunnel.com, Proxied (nuage orange)."
  fi
  echo ">>   Tunnel web en place ($TUNNEL_WEB_DIR). Logs : docker logs cloudflared-web"
}
