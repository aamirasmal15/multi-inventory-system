# InvenTree + Scanette — déploiement multi-assos en 1 commande

Déploie, sur **un seul VPS**, autant d'**instances InvenTree indépendantes** (bases,
comptes et données séparés) que d'assos, chacune sur son **sous-domaine HTTPS**, avec
sa **Scanette** (app web mobile de scan QR / codes-barres) servie sur `/scan` — et les
**réglages mémoire** qui divisent par ~2,5 la consommation de chaque instance.

```
Instance InvenTree                         Scanette
https://inventaire.eirspace.fr             https://inventaire.eirspace.fr/scan
https://inventaire-pixeirb.eirspace.fr     https://inventaire-pixeirb.eirspace.fr/scan
```

**Deux scripts, c'est tout :**

| Script | Rôle |
|---|---|
| `./create-asso.sh <nom> [sous-domaine\|tmp] [mdp]` | Déploie **InvenTree + Scanette** d'une asso (idempotent : relancer = mettre à jour) |
| `./delete-asso.sh <nom>` | Supprime **tout** (Scanette + InvenTree + données + route frontale) |

---

## Architecture

```
Internet ──443──► Caddy frontal (~/front)   ← HTTPS Let's Encrypt, 1 bloc par asso
                       │   inventaire.eirspace.fr {
                       │       @scan path /scan /scan/*
                       │       handle @scan { reverse_proxy eirspace-scan:80 }   ← Scanette
                       │       handle       { reverse_proxy eirspace-proxy:80 }  ← InvenTree
                       │   }
        ┌──────────────┴───────────────┐        (réseau Docker partagé : inventree-front)
        ▼                               ▼
  eirspace-scan (nginx)         eirspace-proxy (Caddy interne InvenTree)
   • sert l'app sur /scan/          │
   • proxy /scan/api/  ─────────────┤  même origine → pas de CORS
   • proxy /scan/media/ ────────────┘
   • sert /scan/zxing_reader.wasm
```

- Un **Caddy frontal unique** occupe les ports 80/443 et route chaque sous-domaine
  vers le bon conteneur. Le script l'installe tout seul à la première asso.
- Chaque asso garde son **InvenTree complet et isolé** (Postgres + cache + serveur +
  worker + Caddy interne).
- La **Scanette** (nginx) sert l'app et **proxifie** l'API/les médias vers l'InvenTree
  de la même asso en réécrivant l'`Host` → **same-origin**, donc `index.html` ne change
  jamais d'une asso à l'autre.

---

## Structure du repo

```
.
├── README.md
├── create-asso.sh          # déploie InvenTree + Scanette d'une asso
├── delete-asso.sh          # supprime tout pour une asso
└── scanette-src/           # fichiers source de l'app (à déposer une fois)
    ├── README.md           # ce qu'il faut y mettre
    ├── index.html          # ← à ajouter (l'app)
    └── zxing_reader.wasm   # ← à ajouter (décodeur de codes-barres)
```

> ⚠️ `index.html` et `zxing_reader.wasm` **ne sont pas fournis** dans ce dépôt : ce
> sont **tes** fichiers d'app. Dépose-les dans `scanette-src/` avant le premier
> déploiement (voir [`scanette-src/README.md`](scanette-src/README.md)). Les logos
> (`logo-black.png`, `logo-white.png`) sont optionnels.

### Où vivent les données ?

Le repo contient seulement l'outillage. Chaque asso déployée est créée dans le **home**
de l'utilisateur, **hors du repo** :

```
~/<nom>/                 # ex: ~/eirspace/
├── .env                 # identifiants + réglages (NE PAS committer)
├── docker-compose.yml   # InvenTree
├── Caddyfile            # proxy interne InvenTree
├── <nom>-data/          # données (Postgres, media, config.yaml…)  ← à sauvegarder
└── scanette/            # la Scanette de l'asso (Dockerfile, default.conf, html/…)

~/front/                 # le Caddy frontal partagé (créé automatiquement)
├── docker-compose.yml
└── Caddyfile            # 1 bloc par asso, géré par les scripts
```

---

## Prérequis (une seule fois, sur le VPS)

### 1. Docker

```bash
sudo apt update && sudo apt install -y ca-certificates curl gnupg wget openssl dnsutils
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update && sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER     # puis : déconnexion / reconnexion SSH (ou `newgrp docker`)
```
*(Ubuntu : remplace `debian` par `ubuntu` dans les deux URLs.)*

### 2. Swap — filet de sécurité (recommandé)

```bash
sudo swapon --show || { sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile \
  && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab ; }
```
Le swap absorbe les pics ; il ne remplace pas la RAM (~1000× plus lent).

### 3. DNS — pointer les sous-domaines vers le VPS

Le plus simple : un **wildcard**. Dans la zone DNS de ton domaine, ajoute un
enregistrement **A** :

| Sous-domaine | Cible (IPv4) | Effet |
|---|---|---|
| `*` | l'IP du VPS (`curl -4 -s ifconfig.me`) | tous les sous-domaines pointent vers le VPS → **plus jamais** à toucher au DNS |

Vérifie avant de déployer (doit renvoyer l'IP du VPS) :
```bash
dig inventaire.<ton-domaine> +short
```

> Pas de domaine ? Utilise le mode **`tmp`** (sslip.io), aucune entrée DNS nécessaire.

### 4. Les fichiers de l'app Scanette

Dépose `index.html` + `zxing_reader.wasm` (+ logos optionnels) dans `scanette-src/`.

---

## Démarrage

```bash
# 1. Récupérer le repo sur le VPS et rendre les scripts exécutables
git clone <url-de-ton-repo> ~/inventree-scanette
cd ~/inventree-scanette
chmod +x create-asso.sh delete-asso.sh

# 2. (une fois) déposer index.html + zxing_reader.wasm dans scanette-src/
#    depuis ton PC, par ex. :  scp index.html zxing_reader.wasm debian@<IP_VPS>:~/inventree-scanette/scanette-src/

# 3. Déployer une asso (InvenTree + Scanette en une commande)
./create-asso.sh eirspace                   # -> https://inventaire.eirspace.fr  (+ /scan/)  [asso principale]
```

À la fin, le script affiche l'URL, l'identifiant admin (`admin_<nom>`) et le mot de
passe généré. **Note-les** (modifiable ensuite depuis l'interface).

> Le domaine par défaut est `eirspace.fr`. Change-le via `BASE_DOMAIN` :
> `BASE_DOMAIN=mondomaine.fr ./create-asso.sh ...` (ou édite la valeur en tête du script).

---

## `create-asso.sh` — créer / mettre à jour une asso

```bash
./create-asso.sh <nom> [sous-domaine|tmp] [mot-de-passe-admin]
```

| Argument | Détail |
|---|---|
| `<nom>` | nom interne de l'asso (dossier + conteneurs), ex. `eirspace`, `pixeirb`. Utilise `[a-z0-9-]`. |
| `[sous-domaine]` | label du sous-domaine. `tmp` → instance **éphémère** (sslip.io, sans DNS). Absent → `inventaire.<domaine>` pour l'**asso principale** (`eirspace`), sinon `inventaire-<nom>.<domaine>`. |
| `[mot-de-passe]` | mot de passe admin (généré aléatoirement si absent). |

**Exemples**
```bash
./create-asso.sh eirspace                      # https://inventaire.eirspace.fr  (asso principale)
./create-asso.sh eirspace inventaire           # https://inventaire.eirspace.fr  (identique, explicite)
./create-asso.sh pixeirb  inventaire-pixeirb   # https://inventaire-pixeirb.eirspace.fr
./create-asso.sh vost                          # https://inventaire-vost.eirspace.fr  (défaut auto)
./create-asso.sh demo     tmp                  # https://demo.<ip>.sslip.io  (éphémère, sans DNS)
```

> **Asso principale (`eirspace`).** Son sous-domaine est **fixe** : `inventaire.<domaine>`
> (et non `inventaire-eirspace`). Donc `./create-asso.sh eirspace` **seul** redonne
> toujours exactement `https://inventaire.eirspace.fr` — pratique pour réinstaller sans
> se retrouver sur une URL différente. Configurable via `MAIN_ASSO` / `MAIN_SUBDOMAIN`.

**Variables d'environnement**

| Variable | Défaut | Effet |
|---|---|---|
| `BASE_DOMAIN` | `eirspace.fr` | ton domaine (vide `""` → sslip.io) |
| `SCAN_SRC` | `<repo>/scanette-src` | dossier source de l'app |
| `WITH_SCANETTE` | `1` | `0` = déployer **InvenTree seul** (sans Scanette) |
| `MAIN_ASSO` | `eirspace` | asso principale au sous-domaine fixe |
| `MAIN_SUBDOMAIN` | `inventaire` | sous-domaine fixe de l'asso principale |

Le script, **idempotent**, fait tout : vérif Docker, réseau partagé, **bootstrap du
Caddy frontal** si absent, calcul de l'URL, `.env` (préservé en cas de re-run),
`docker-compose.yml` InvenTree, `invoke update`, réglage **worker=1** dans
`config.yaml`, démarrage, build de la **Scanette** (`~/<nom>/scanette/`), puis ajout/maj
du **bloc Caddy frontal** (route `/scan` → Scanette, reste → InvenTree) et rechargement.

> Relancer `./create-asso.sh eirspace` = **mettre à jour** (identifiants inchangés,
> app rebuild, frontal rechargé). C'est aussi comme ça qu'on **met à jour la Scanette**
> après avoir changé `index.html` dans `scanette-src/`.

---

## `delete-asso.sh` — tout supprimer pour une asso

```bash
./delete-asso.sh <nom>      # demande de taper "oui" pour confirmer
```

Arrête/supprime les conteneurs **Scanette + InvenTree**, retire la route frontale de
l'asso, recharge le frontal, puis efface `~/<nom>/`.

> ⚠️ **DÉFINITIF** : toutes les données de l'asso sont perdues. **Sauvegarde avant** :
> `cp -r ~/<nom>/<nom>-data ~/backup-<nom>`. Les **autres** assos et le réseau partagé
> ne sont pas touchés. Avec un wildcard DNS, rien à changer côté DNS.

---

## Pourquoi « optimisé » ? (les 2 réglages qui font tout)

1. **Worker de fond = 1.** Par défaut InvenTree lance plusieurs process django-q,
   chacun rechargeant tout InvenTree (~230 Mo pièce) → jusqu'à ~1 Go. La variable
   `INVENTREE_BACKGROUND_WORKERS=1` ne suffit pas : elle est **écrasée** par
   `config.yaml`. Le script corrige les **deux** (worker ~1 Go → ~230 Mo).
2. **Worker web gunicorn = 1** (`INVENTREE_GUNICORN_WORKERS=1`, lu depuis `.env`) :
   serveur ~625 Mo → ~350 Mo.

Résultat : une instance passe de **~2 Go** à **~700 Mo–1 Go** une fois stabilisée
(−65 %). Réversible (`=2`) un jour de pointe. Chaque asso ayant son propre worker,
les assos ne se ralentissent pas entre elles.

---

## Commandes utiles

```bash
docker stats --no-stream            # mémoire/CPU par conteneur (laisser reposer ~5-10 min)
free -h                             # mémoire + swap de la machine
docker ps                           # conteneurs qui tournent
docker ps | grep -- -scan           # juste les Scanettes
docker logs -f <nom>-scan           # logs nginx d'une Scanette
docker logs -f <nom>-server         # logs InvenTree
cat ~/front/Caddyfile               # blocs/routes du frontal
cd ~/front && docker compose logs -f   # logs du Caddy frontal (TLS, routage)
curl -I https://<domaine>/scan/     # test rapide de la Scanette (depuis le VPS)

# Changer un mot de passe admin (si accès perdu)
docker compose -f ~/<nom>/docker-compose.yml exec inventree-server \
  python3 manage.py changepassword admin_<nom>

# Redémarrage après reboot complet : instances d'abord, frontal en dernier
for d in eirspace pixeirb vost; do (cd ~/$d && docker compose up -d); done
cd ~/front && docker compose up -d
```

---

## Dépannage

| Symptôme | Piste |
|---|---|
| `permission denied ... docker.sock` | `sudo usermod -aG docker $USER` + reconnexion (ou `newgrp docker`) |
| `index.html manquant` au déploiement | déposer les fichiers dans `scanette-src/` (ou `WITH_SCANETTE=0`) |
| Caddy n'obtient pas le certificat | `dig <sous-domaine> +short` doit renvoyer l'IP du VPS ; attendre la propagation DNS |
| Page sans CSS / erreur CSRF | vérifier `INVENTREE_SITE_URL` exact + les 3 `USE_X_FORWARDED_*=True` dans `~/<nom>/.env` |
| `502` sur une URL | l'instance n'est pas démarrée → `cd ~/<nom> && docker compose up -d` |
| **Toutes** les URLs tombent | `front-caddy` arrêté → `cd ~/front && docker compose up -d` |
| `/scan` renvoie 502 | conteneur Scanette arrêté → `cd ~/<nom>/scanette && docker compose up -d` |
| `/scan` part vers InvenTree (404) | route `/scan` absente du frontal → relancer `./create-asso.sh <nom>` |
| L'app ne se met pas à jour sur le tél. | incrémenter `?v=N` ; sinon vider le cache du navigateur |
| Images d'articles « cassées » | vérifier le proxy `/scan/media/` et que l'article a une image |
| 403 à la création / l'ajout de stock | le compte InvenTree doit avoir les rôles **Part:add** / **Stock:add** (+ **barcode**) |
| Worker reste à ~1 Go | `workers: 1` dans `~/<nom>/<nom>-data/config.yaml` + `cd ~/<nom> && docker compose up -d --force-recreate inventree-worker` |
| OOM-kill (conteneur `Exited`) | RAM saturée → éteindre une instance, ou plus de RAM ; garder le swap |
| Caméra noire (iPhone) | recharger ; autoriser la caméra ; HTTPS obligatoire (OK via Caddy) |

---

## Dimensionnement (mesuré en réel)

| Machine | Instances en confort réel |
|---|---|
| 4 Go / 2 cœurs | 1, à la limite 2-3 en usage **très léger** (swap obligatoire) |
| 8 Go / 2 cœurs | RAM pour 4-5, mais le **CPU** bride à 2-3 actives en même temps |
| **8 Go / 4 cœurs** | **4-5 instances** à l'aise (usage sporadique) |
| 16 Go / 4-6 cœurs | 4-6 large |

Plancher incompressible : ~600-700 Mo par instance (2 process Python). L'optimisation
rend le multi-instance possible pour un **usage léger/sporadique** sur petite machine ;
elle ne crée pas de RAM pour un usage lourd simultané. Au-delà : **Oracle Cloud Always
Free** (12 Go ARM, gratuit) ou un VPS 8 Go / 4 cœurs.

---

## Sauvegarde

Copier régulièrement les dossiers `~/<nom>/<nom>-data/` **hors du VPS** (rsync/scp) — un
VPS peut être perdu. Documenter les accès (compte VPS, domaine, mots de passe admin) pour
la transmission entre promos.

```bash
# exemple : sauvegarde locale rapide d'une asso
cp -r ~/eirspace/eirspace-data ~/backup-eirspace-$(date +%F)
```
