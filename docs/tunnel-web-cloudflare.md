# Exposition publique via Cloudflare Tunnel — runbook

> Écrit lors de la mise en place réelle (12/08/2026) sur un serveur derrière le
> NAT d'un campus, **sans aucun port entrant**. Version générique : remplacez
> `<domaine>` et `<ID-du-tunnel>` par vos valeurs. Les identifiants concrets de
> chaque serveur (IDs de tunnels, historique DNS) se notent HORS dépôt — ce
> dépôt est public (par ex. `~/tunnel-web/NOTES-<serveur>.md`).
>
> Le choix du mode d'exposition est intégré à `create-asso.sh` (variable
> `EDGE`, demandée au premier run) : voir §6. La page wiki « Exposition
> publique » donne la vue d'ensemble des deux modes.

## 1. Le problème que ce montage résout

Un serveur derrière un NAT (campus, box…) n'accepte aucune connexion entrante.
Si les sous-domaines sont proxifiés par Cloudflare mais que rien ne relie
l'edge à la machine, on observe :

- **HTTP 522** pour tout le monde (navigateurs compris) : l'edge n'a aucune
  route vers l'origine ;
- **HTTP 403 « error code: 1010 »** pour les clients non-navigateur
  (python-urllib, parfois curl) : le Bot Fight Mode de Cloudflare refuse leur
  User-Agent *avant* même le 522. C'est ce qui faisait échouer le provisioning
  quand il passait par le domaine public — d'où la règle, valable dans TOUS les
  modes : **le provisioning parle toujours à l'API InvenTree en local** (voir
  `api_url()` dans `create-asso.sh`), jamais via le domaine.

## 2. L'architecture

Un **tunnel Cloudflare dédié au web**, séparé de tout tunnel SSH. cloudflared
établit des connexions **sortantes** vers l'edge (rien à ouvrir côté réseau) et
livre le trafic à `front-caddy`, qui dispatche par nom d'hôte.

```
Internet ──HTTPS──> edge Cloudflare (TLS public, cert *.« domaine »)
                        │ tunnel « web » (sortant depuis le serveur, http2/TCP 443)
                        ▼
              conteneur cloudflared-web  (~/tunnel-web/, réseau inventree-front)
                        │ http://front-caddy:80  (wildcard *.« domaine »)
                        ▼
                   front-caddy (HTTP simple, dispatch par Host)
                    ├─ inventaire[-asso].<domaine> → <asso>-proxy:80 → InvenTree
                    ├─ scannette[-asso].<domaine>  → <asso>-scan:80
                    └─ auth.<domaine>              → dex:5556
```

Pourquoi un wildcard : **une nouvelle asso ne demande plus aucune action** côté
tunnel ni DNS. `create-asso.sh` ajoute son bloc Caddy, et `*.« domaine »` couvre
le nouveau sous-domaine (DNS + certificat edge Universal SSL, premier niveau
uniquement).

## 3. Règles d'or (serveur administré à distance)

1. **Si l'accès SSH passe lui aussi par un tunnel Cloudflare, ce tunnel-là est
   la ligne de vie** : il vit dans son propre service (systemd +
   `/etc/cloudflared/`) et son propre record DNS. On ne le modifie, ne le
   redémarre, ne le « fusionne » JAMAIS avec le web. Si le tunnel web casse, on
   perd le site ; si le tunnel SSH casse, on perd la machine.
2. Le tunnel web est **jetable** : conteneur Docker indépendant, on peut le
   détruire/recréer sans conséquence sur l'accès à la machine.
3. Toute modification DNS se fait record par record, **sans toucher au record
   du SSH**.

## 4. Mise en place — automatique via le script

En mode `EDGE=cloudflare-tunnel`, **tout ce chapitre est exécuté par
`create-asso.sh` (lib/tunnel.sh)** au premier run : création du tunnel,
fichiers, conteneur, route DNS (best effort). La seule étape humaine est
l'autorisation du compte dans le navigateur — et seulement si aucun
`cert.pem` n'existe déjà sur la machine. Les étapes ci-dessous servent de
référence (comprendre, déboguer, ou faire à la main sur un hôte sans Docker).

Séparation de sécurité posée par le script : `~/tunnel-web/account/` porte le
`cert.pem` (credential de **compte**, capable de gérer tous les tunnels et le
DNS) et n'est **jamais monté** dans le conteneur exposé ; `~/tunnel-web/cloudflared/`
ne contient que la config et le `<ID>.json` du seul tunnel web.

### 4.1 Créer le tunnel (une fois)

```bash
# le certificat de compte vient d'un « cloudflared tunnel login » déjà fait
export TUNNEL_ORIGIN_CERT=~/.cloudflared/cert.pem
cloudflared tunnel create web            # → <ID-du-tunnel> + credentials JSON
mkdir -p ~/tunnel-web/cloudflared
cp ~/.cloudflared/<ID-du-tunnel>.json ~/tunnel-web/cloudflared/
chmod 600 ~/tunnel-web/cloudflared/<ID-du-tunnel>.json
```

`~/tunnel-web/cloudflared/config.yml` :

```yaml
tunnel: <ID-du-tunnel>
credentials-file: /etc/cloudflared/<ID-du-tunnel>.json
protocol: http2          # QUIC/UDP souvent filtré (campus) : http2 = TCP 443
ingress:
  - hostname: "*.<domaine>"
    service: http://front-caddy:80
  - service: http_status:404
```

`~/tunnel-web/docker-compose.yml` :

```yaml
services:
  cloudflared-web:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared-web
    restart: unless-stopped
    # l'image tourne en uid 65532 (nonroot), incapable de lire le
    # credentials-file en 600 : on aligne le conteneur sur l'uid propriétaire
    user: "1000:1000"
    command: tunnel --no-autoupdate --config /etc/cloudflared/config.yml run
    volumes:
      - ./cloudflared:/etc/cloudflared:ro
    networks:
      - inventree-front

networks:
  inventree-front:
    external: true
```

```bash
cd ~/tunnel-web && docker compose up -d
cloudflared tunnel info web        # doit lister des connexions (les points d'edge)
```

### 4.2 Le Caddy frontal sert en HTTP simple

C'est ce que fait `create-asso.sh` en mode `cloudflare-tunnel` (§6) : blocs de
site en `http://` et bloc global `trusted_proxies static private_ranges` en
tête de `~/front/Caddyfile`. Sans le `http://`, Caddy exige un certificat
(ACME impossible sans port entrant) et répond 308 vers https → boucle infinie
avec l'edge. Sans le `trusted_proxies`, Caddy réécrit `X-Forwarded-Proto` en
`http` et Django génère des liens `http://` dans les e-mails.

**Piège vécu** : le conteneur monte `./Caddyfile` en bind-mount de FICHIER. Un
`mv`/`sed -i` change l'inode → le conteneur continue de voir l'ANCIEN contenu,
et `caddy reload` recharge l'ancienne config sans broncher. Après une
modification manuelle : `docker restart front-caddy`.

Vérification locale (depuis un conteneur du réseau) :

```bash
docker exec <asso>-proxy wget -q -O /dev/null --header "Host: inventaire.<domaine>" \
  http://front-caddy:80/ --server-response   # attendu : 302 (redirection /web), PAS 308
```

### 4.3 DNS — deux records contrôlent tout

Règle à connaître : **un record explicite gagne toujours sur le wildcard**.
C'est ce qui protège le record du SSH et les éventuels raccourcis/redirections
de la zone (les Redirect/Page Rules Cloudflare s'exécutent quant à elles à
l'edge, avant le tunnel : intouchées aussi).

Dans le dashboard Cloudflare (DNS > Records) :

1. `*` CNAME `<ID-du-tunnel>.cfargotunnel.com`, **Proxied (nuage orange
   obligatoire** — un CNAME « DNS only » vers cfargotunnel.com ne fonctionne
   pas**)**, TTL auto. Si un `*` existe déjà (pointant vers l'ancienne infra),
   l'ÉDITER — noter l'ancienne valeur hors dépôt avant.
2. Valider sans risque : tout sous-domaine SANS record propre passe déjà par le
   tunnel — `curl -s -o /dev/null -w '%{http_code}' https://nimportequoi.<domaine>/`
   → une réponse de Caddy (pas un 522) = chaîne edge → tunnel → front-caddy OK.
3. Supprimer les éventuels records explicites des hostnames web (ils
   masqueraient le wildcard). **Uniquement ceux-là** : ni le SSH, ni les
   raccourcis.

État final : un record pour le SSH (s'il y en a un), `*` pour le web. Chaque
future asso est couverte d'office.

Nota : le wildcard ne couvre que le premier niveau (`x.<domaine>`, pas
`y.x.<domaine>` — limite aussi du certificat edge Universal SSL), ni l'apex.

## 5. Exploitation courante

- **Nouvelle asso** : rien à faire (wildcard) — le script génère les bons blocs.
- **Logs du tunnel** : `docker logs cloudflared-web`
- **Redémarrer le tunnel web** : `cd ~/tunnel-web && docker compose restart` —
  sans danger, le SSH ne passe pas par là.
- **Mettre à jour cloudflared** : `docker compose pull && docker compose up -d`
- **État côté Cloudflare** : `TUNNEL_ORIGIN_CERT=~/.cloudflared/cert.pem cloudflared tunnel info web`

## 6. Le mode d'exposition dans create-asso.sh (EDGE)

Le script gère les deux mondes ; il pose la question **une seule fois** au
premier run et persiste la réponse dans `~/.config/multi-inventory/edge.env`
(surchargable ponctuellement par `EDGE=... ./create-asso.sh <nom>`).

| Mode | Pour qui | Ce que fait le script |
|---|---|---|
| `direct` (défaut) | VPS avec ports 80/443 ouverts (OVH…) | blocs Caddy classiques : Caddy obtient les certificats (ACME) et sert en HTTPS |
| `cloudflare-tunnel` | serveur sans port entrant (NAT campus…) | blocs en `http://` (fonction `apply_edge`) + bloc global `trusted_proxies` en tête du Caddyfile ; avertit si aucun conteneur cloudflared ne tourne |

Le tunnel lui-même est posé automatiquement au premier run en mode tunnel
(§4, lib/tunnel.sh) ; en fin de chaque déploiement, le bilan de santé
`edge_doctor` traverse l'edge comme un vrai visiteur (site + host SSO) et, sur
un symptôme connu (522, 1010, boucle, 502), affiche le diagnostic et le lien
wiki.

**Changer de mode après coup** : éditer `edge.env`, puis relancer
`./create-asso.sh <nom>` pour CHAQUE asso — les blocs des assos ET le bloc
`auth` (SSO) se régénèrent dans la forme du mode courant. En retour vers
`direct`, il reste trois gestes manuels : repointer le DNS (`*` en A vers l'IP
du serveur au lieu du CNAME cfargotunnel), arrêter le tunnel
(`cd ~/tunnel-web && docker compose down`), et retirer le bloc global
`trusted_proxies` du `~/front/Caddyfile` puis `docker restart front-caddy`.

## 7. Rollback (mode tunnel)

1. DNS : repointer le record `*` vers son ancienne valeur (notée hors dépôt).
2. Caddy : régénérer en mode direct (cf. « changer de mode » ci-dessus).
3. Tunnel : `cd ~/tunnel-web && docker compose down` puis
   `cloudflared tunnel delete web` (un tunnel SSH éventuel n'est jamais concerné).

## 8. Dépannage

| Symptôme | Cause | Remède |
|---|---|---|
| 522 partout | aucune route edge→origine (record DNS vers une IP injoignable) | router le wildcard vers le tunnel (§4.3) |
| 403 `error code: 1010` | Bot Fight Mode refuse le User-Agent (client non navigateur) | ne jamais provisionner via le domaine public ; exception WAF si besoin d'API externe |
| Boucle de redirections | un site Caddy encore en https (308) derrière l'edge | `EDGE=cloudflare-tunnel ./create-asso.sh <nom>` régénère les blocs, puis `docker restart front-caddy` |
| Modif Caddyfile « sans effet » | bind-mount de fichier : l'inode a changé (`mv`, `sed -i`) | `docker restart front-caddy` |
| Liens `http://` dans les e-mails | `trusted_proxies` absent du bloc global | §4.2 |
| `cloudflared-web` en boucle « permission denied » | credentials-file illisible (uid 65532 vs 1000) | `user: "1000:1000"` dans le compose |
| Tunnel web mort mais SSH vivant | c'est le design : conteneur indépendant | `docker compose up -d` dans `~/tunnel-web` |
| Le tunnel ne se connecte pas (timeout QUIC) | UDP 7844 filtré par le réseau | `protocol: http2` dans la config (déjà le défaut ici) |
