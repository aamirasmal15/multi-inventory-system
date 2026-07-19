#!/usr/bin/env bash
# lib/swap.sh : dimensionnement dynamique du swap disque selon le nombre d'assos.
#
# Sourcé par create-asso.sh (fin de run) et delete-asso.sh (après suppression),
# ne s'exécute pas seul. À appeler via `manage_swap || true` : le `|| true`
# désactive `set -e` dans tout le corps de la fonction (règle bash), ce qui met
# ce code à l'abri des pièges arithmétique/grep sous `set -euo pipefail`.
#
# Principe (voir wiki, page Performance et mémoire) : on ne redimensionne JAMAIS
# un swapfile en place. Agrandir imposerait un `swapoff` qui rapatrie ses pages
# chaudes en RAM, d'où freeze sur une VM tendue (incident du 2026-07-08, où
# /swapfile portait déjà ~2,85 Go actifs). On se contente donc d'ajouter ou de
# retirer des chunks dédiés de 2 Go nommés /swapfile.auto.<K>, empilés au-dessus
# des swapfiles « socle » (/swapfile, /swapfile2…) qui, eux, ne sont jamais
# touchés : ils restent le plancher permanent.
#
# Cible (Go) selon N = nombre d'assos :  target = 2 x ceil( max(4, N+2) / 2 )
#   N=2:4   N=3:6   N=4:6   N=5:8   N=6:8   N=7:10   N=8:10   N=9:12
# soit ~1 Go par asso + 2 Go de socle, arrondi au chunk de 2 Go supérieur.
#
# Réduction à la suppression : on ne retire QUE nos chunks /swapfile.auto.*,
# et seulement si l'évacuation est sûre (assez de RAM + swap restant libres
# pour absorber le chunk). Sinon on conserve.

_swap_sudo() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }

SWAP_CHUNK_MB="${SWAP_CHUNK_MB:-2048}"                # taille d'un chunk dynamique (2 Go)
SWAP_DISK_RESERVE_MB="${SWAP_DISK_RESERVE_MB:-5120}" # refuse un chunk si / tomberait sous ~5 Go libres
SWAP_SHRINK_MARGIN_MB="${SWAP_SHRINK_MARGIN_MB:-1536}" # marge d'évacuation avant de retirer un chunk
# Tolérance de comparaison présent/cible : un swapfile « de 4 Go » pèse en réalité
# 4194300 Ko ≈ 4096 Mo -1 ; sans marge, 2 socles (8191 Mo) passeraient pour < 8192
# et on ajouterait un chunk inutile. Un vrai manque, lui, vaut au moins 1 chunk.
SWAP_TOLERANCE_MB="${SWAP_TOLERANCE_MB:-512}"

# Nombre d'assos = dossiers ~/assos/<nom>/ contenant un docker-compose.yml.
# Le compose de la Scannette est en profondeur 3 (…/scannette/) : -maxdepth 2 l'exclut.
_swap_count_assos() {
  local root="${DEPLOY_ROOT:-$HOME/assos}"
  [ -d "$root" ] || { echo 0; return; }
  find "$root" -maxdepth 2 -name docker-compose.yml 2>/dev/null | wc -l | tr -d ' '
}

# Cible en Mo pour N assos : 2 × ceil( max(4, N+2) / 2 ) Go.
_swap_target_mb() {
  local n="$1" base half
  base=$(( n + 2 )); [ "$base" -lt 4 ] && base=4   # max(4, N+2)
  half=$(( (base + 1) / 2 ))                        # ceil(base/2)
  echo $(( 2 * half * 1024 ))
}

# Total du swap DISQUE présent (Mo) : somme des tailles hors zram dans /proc/swaps.
_swap_disk_total_mb() {
  awk 'NR>1 && $1 !~ /zram/ { s += $3 } END { printf "%d", s/1024 }' /proc/swaps 2>/dev/null || echo 0
}

# Mo disponibles sur la partition de /.
_swap_root_free_mb() {
  df -Pm / 2>/dev/null | awk 'NR==2 {print $4}'
}

# Retirer un chunk est SÛR si, une fois ce chunk enlevé, il reste au moins
# SWAP_SHRINK_MARGIN_MB de capacité libre entre la RAM dispo et le swap restant :
#   (MemAvailable + SwapFree) − taille_chunk ≥ marge
_swap_evac_ok() {
  local chunk_mb="$1" avail swapfree
  avail=$(awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
  swapfree=$(awk '/^SwapFree:/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
  [ $(( avail + swapfree - chunk_mb )) -ge "$SWAP_SHRINK_MARGIN_MB" ]
}

# Nos chunks dynamiques actifs, triés par index croissant.
_swap_auto_active() {
  awk 'NR>1 && $1 ~ /\/swapfile\.auto\./ {print $1}' /proc/swaps 2>/dev/null | sort -t. -k3 -n
}

# Crée + active un chunk de 2 Go au prochain index libre. 0 si OK, 1 sinon.
_swap_add_chunk() {
  local k=1 f
  while :; do
    f="/swapfile.auto.$k"
    { [ ! -e "$f" ] && ! grep -q "^$f " /proc/swaps 2>/dev/null; } && break
    k=$(( k + 1 ))
  done
  echo ">>   Swap : +$(( SWAP_CHUNK_MB / 1024 )) Go ($f) ..."
  if ! _swap_sudo fallocate -l "${SWAP_CHUNK_MB}M" "$f" 2>/dev/null; then
    _swap_sudo dd if=/dev/zero of="$f" bs=1M count="$SWAP_CHUNK_MB" status=none
  fi
  _swap_sudo chmod 600 "$f"
  _swap_sudo mkswap "$f" >/dev/null
  if ! _swap_sudo swapon "$f" 2>/dev/null; then
    # fichier « à trous » (fallocate sur certains FS) : on recrée plein avec dd
    _swap_sudo rm -f "$f"
    _swap_sudo dd if=/dev/zero of="$f" bs=1M count="$SWAP_CHUNK_MB" status=none
    _swap_sudo chmod 600 "$f" && _swap_sudo mkswap "$f" >/dev/null && _swap_sudo swapon "$f" || {
      echo ">>   Swap : activation de $f impossible (ignoré)."; _swap_sudo rm -f "$f"; return 1; }
  fi
  grep -q "^$f " /etc/fstab || echo "$f none swap sw 0 0" | _swap_sudo tee -a /etc/fstab >/dev/null
  return 0
}

# Désactive + supprime un chunk (et sa ligne fstab). 0 si OK, 1 si swapoff refusé.
_swap_remove_chunk() {
  local f="$1"
  echo ">>   Swap : -$(( SWAP_CHUNK_MB / 1024 )) Go ($f) ..."
  if _swap_sudo swapoff "$f" 2>/dev/null; then
    _swap_sudo rm -f "$f"
    _swap_sudo sed -i "\#^$f #d" /etc/fstab
    return 0
  fi
  echo ">>   Swap : swapoff de $f refusé, chunk conservé."
  return 1
}

# Point d'entrée : ajuste le swap disque à la cible pour N assos.
manage_swap() {
  [ -r /proc/swaps ] || return 0   # conteneur / OS sans swap exposé : on ne touche à rien
  local n target present free chunk
  n="$(_swap_count_assos)"
  target="$(_swap_target_mb "$n")"
  present="$(_swap_disk_total_mb)"
  echo ">> Swap disque : $n asso(s) -> cible $(( target / 1024 )) Go (présent $(( present / 1024 )) Go)."

  # --- Croissance : empiler des chunks de 2 Go tant qu'il manque plus que la
  #     tolérance (swapon seul, zéro éviction, donc aucun risque de freeze) ---
  while [ $(( target - present )) -gt "$SWAP_TOLERANCE_MB" ]; do
    free="$(_swap_root_free_mb)"
    if [ -z "$free" ] || [ $(( free - SWAP_CHUNK_MB )) -lt "$SWAP_DISK_RESERVE_MB" ]; then
      echo ">>   Swap : disque insuffisant (garde ${SWAP_DISK_RESERVE_MB} Mo libres sur /), ajout stoppé."
      break
    fi
    _swap_add_chunk || break
    present=$(( present + SWAP_CHUNK_MB ))
  done

  # --- Réduction gardée : ne retirer QUE nos chunks, du plus récent au plus ancien,
  #     jamais sous la cible, et uniquement si l'évacuation est sûre. Les swapfiles
  #     socle (/swapfile, /swapfile2…) sont intouchables : ils sont le plancher. ---
  if [ $(( present - target )) -gt "$SWAP_TOLERANCE_MB" ]; then
    for chunk in $(_swap_auto_active | tac); do
      # retirer ce chunk ne doit pas faire passer sous la cible (à la tolérance près)
      [ $(( present - SWAP_CHUNK_MB )) -ge $(( target - SWAP_TOLERANCE_MB )) ] || break
      if _swap_evac_ok "$SWAP_CHUNK_MB" && _swap_remove_chunk "$chunk"; then
        present=$(( present - SWAP_CHUNK_MB ))
      else
        echo ">>   Swap : réduction stoppée (évacuation risquée)."
        break
      fi
    done
  fi
}
