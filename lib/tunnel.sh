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
# l'hôte. Deux dossiers aux rôles distincts, et c'est une frontière de
# SÉCURITÉ :
#   - account/    : cert.pem (credential de COMPTE : peut créer/supprimer
#                   n'importe quel tunnel et écrire le DNS) + credentials bruts.
#                   Sert aux opérations de gestion (login/create/route), n'est
#                   JAMAIS monté dans le conteneur qui tourne en permanence.
#   - cloudflared/: config.yml + le seul <ID>.json du tunnel web (ne permet QUE
#                   de faire tourner CE tunnel). C'est tout ce que voit le
#                   conteneur exposé — compromis, il ne donne pas le compte.

TUNNEL_WEB_DIR="${TUNNEL_WEB_DIR:-$HOME/tunnel-web}"

# cloudflared jetable pour la GESTION (home = account/) ; _CF_TTY=-t si interactif
_cf() {
  docker run --rm -i ${_CF_TTY:-} --user "$(id -u):$(id -g)" -e HOME=/hh \
    -v "$TUNNEL_WEB_DIR/account:/hh/.cloudflared" \
    cloudflare/cloudflared:latest "$@"
}

setup_cloudflare_tunnel() {  # $1 = un host de l'asso (le wildcard en dérive)
  local host="$1" wildcard tid
  wildcard="*.${host#*.}"
  mkdir -p "$TUNNEL_WEB_DIR/cloudflared" "$TUNNEL_WEB_DIR/account"
  chmod 700 "$TUNNEL_WEB_DIR/account"

  # Déjà en place ? (-s : un fichier VIDE d'un run raté ne compte pas.)
  # On s'assure juste que le conteneur tourne, et c'est tout.
  if [ -s "$TUNNEL_WEB_DIR/cloudflared/config.yml" ] && [ -s "$TUNNEL_WEB_DIR/docker-compose.yml" ]; then
    ( cd "$TUNNEL_WEB_DIR" && docker compose up -d >/dev/null 2>&1 ) || true
    return 0
  fi

  # Le template d'abord : mourir APRÈS avoir créé le tunnel côté compte serait
  # le pire moment. Pas de require_template ici : son exit 1 traverserait le
  # « || true » de l'appelant et tuerait tout le déploiement.
  if [ ! -s "${TEMPLATES_DIR:-/nonexistent}/tunnel-web-docker-compose.yml" ]; then
    echo "!! Template tunnel-web-docker-compose.yml introuvable (checkout partiel ?) :"
    echo "!!   tunnel non posé. Récupère le dossier templates/ du repo et relance."
    return 1
  fi

  echo ">> Tunnel Cloudflare « web » : mise en place automatique (une seule fois) ..."

  # 1) Autorisation du compte (cert.pem, rangé dans account/ : jamais monté
  #    dans le conteneur permanent). Réutilisée si un cloudflared de l'hôte a
  #    déjà fait son login ; sinon login interactif : cloudflared affiche une
  #    URL, à ouvrir dans le navigateur (compte qui gère le domaine).
  if [ ! -f "$TUNNEL_WEB_DIR/account/cert.pem" ]; then
    if [ -f "$HOME/.cloudflared/cert.pem" ]; then
      cp "$HOME/.cloudflared/cert.pem" "$TUNNEL_WEB_DIR/account/cert.pem"
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
    chmod 600 "$TUNNEL_WEB_DIR/account/cert.pem" 2>/dev/null || true
  fi

  # 2) Le tunnel « web » : réutilisé s'il existe déjà sur le compte.
  #    (stderr volontairement visible : « autorisation expirée », « nom déjà
  #    pris »... la vraie cause vaut mieux qu'un générique)
  tid="$(_cf tunnel list 2>/dev/null | awk '$2 == "web" {print $1; exit}')"
  if [ -z "$tid" ]; then
    _cf tunnel create web >/dev/null || true
    tid="$(_cf tunnel list 2>/dev/null | awk '$2 == "web" {print $1; exit}')"
  fi
  if [ -z "$tid" ]; then
    echo "!! Création du tunnel « web » impossible (cause ci-dessus) : voir le wiki."
    return 1
  fi
  echo ">>   tunnel « web » : $tid"

  # 'tunnel create' écrit les credentials dans account/ ; le conteneur n'a
  # besoin QUE de ce fichier-là -> copié dans cloudflared/ (le dossier monté).
  if [ -f "$TUNNEL_WEB_DIR/account/$tid.json" ]; then
    cp "$TUNNEL_WEB_DIR/account/$tid.json" "$TUNNEL_WEB_DIR/cloudflared/$tid.json"
  fi
  if [ ! -f "$TUNNEL_WEB_DIR/cloudflared/$tid.json" ]; then
    echo "!! Le tunnel « web » existe déjà sur le compte, mais ses credentials ne sont pas"
    echo "!!   sur ce serveur ($TUNNEL_WEB_DIR/cloudflared/$tid.json manquant)."
    echo "!!   Récupère-les depuis la machine d'origine, ou supprime ce tunnel côté"
    echo "!!   Cloudflare et relance (un neuf sera créé). Wiki « Exposition publique »."
    return 1
  fi
  chmod 600 "$TUNNEL_WEB_DIR/cloudflared/$tid.json" 2>/dev/null || true

  # 3) Fichiers : config du tunnel + compose (template, uid/gid substitués).
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
  sed "s/__UID__/$(id -u)/g; s/__GID__/$(id -g)/g" \
    "$TEMPLATES_DIR/tunnel-web-docker-compose.yml" > "$TUNNEL_WEB_DIR/docker-compose.yml"

  # 4) Démarrage (échec bloquant : pas de faux « en place ») + route DNS en
  #    best-effort : on n'écrase JAMAIS un record existant — la zone peut
  #    porter d'autres choses, la modification à faire est affichée.
  docker network create inventree-front 2>/dev/null || true
  if ! ( cd "$TUNNEL_WEB_DIR" && docker compose up -d ); then
    echo "!! Démarrage du conteneur cloudflared-web échoué (docker compose up ci-dessus) :"
    echo "!!   un autre conteneur du même nom tourne-t-il déjà ? 'docker ps -a | grep cloudflared'"
    return 1
  fi
  if _cf tunnel route dns web "$wildcard" >/dev/null 2>&1; then
    echo ">>   DNS : $wildcard routé vers le tunnel."
  else
    echo "!!   Route DNS à finir à la main (record '*' déjà existant, ou wildcard refusé en CLI) :"
    echo "!!   dashboard Cloudflare -> DNS -> '*' CNAME $tid.cfargotunnel.com, Proxied (nuage orange)."
  fi
  echo ">>   Tunnel web en place ($TUNNEL_WEB_DIR). Logs : docker logs cloudflared-web"
}
