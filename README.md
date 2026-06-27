# InvenTree + Scanette — un inventaire par asso, en une commande

Salut 👋

Ce repo, c'est l'outillage qu'on s'est fait pour donner à **chaque asso de l'école son propre
inventaire** : une instance **InvenTree** isolée (base, comptes et données bien à elle), sur son
**sous-domaine HTTPS**, avec une **Scanette** (petite appli mobile de scan QR / codes-barres) servie
sur `/scan`, et la **connexion EirbConnect** (le SSO de l'école) déjà branchée. Le tout sur **un seul
VPS**, avec les réglages mémoire qui évitent de le faire exploser.

L'idée : tu lances **une commande**, et quelques minutes plus tard une nouvelle asso a son inventaire
en ligne, brandé, connecté au SSO, prêt à l'emploi. Et quand une promo passe le flambeau à la
suivante, tout est scripté et écrit ici — pas de magie noire à reconstituer. 🙂

```
Instance InvenTree                         Scanette                                    Connexion
https://inventaire.eirspace.fr             https://inventaire.eirspace.fr/scan         EirbConnect (SSO)
https://inventaire-pixeirb.eirspace.fr     https://inventaire-pixeirb.eirspace.fr/scan EirbConnect (SSO)
```

**Trois scripts, c'est tout :**

| Script | Rôle |
|---|---|
| `./create-asso.sh <nom> [sous-domaine\|tmp] [mdp]` | Déploie **InvenTree + Scanette + SSO** d'une asso (idempotent : relancer = mettre à jour) |
| `./delete-asso.sh <nom>` | Supprime **tout** (Scanette + InvenTree + données + route frontale + client SSO) |
| `./auth/bootstrap-dex.sh` | (optionnel) Déploie le **broker SSO Dex** tout seul — sinon `create-asso.sh` s'en charge à la 1ʳᵉ asso |

---

## La connexion EirbConnect, en deux mots (parce que c'est la partie maligne)

Le SSO de l'école (EirbConnect, un Keycloak géré par Eirbware) n'autorise **qu'une seule URL de
retour**, et la faire changer = ouvrir un ticket à chaque fois. Or on a *plein* d'instances, chacune
avec sa propre URL de retour… a priori coincé.

La pirouette : on met un **broker Dex** au milieu, sur `https://auth.<domaine>/oauth2`. Comme son
unique URL de retour vers l'école tombe **pile sur celle déjà autorisée**, Dex peut ensuite
redistribuer l'identité à **autant d'instances InvenTree qu'on veut**, sans jamais rien redemander à
Eirbware. Une porte d'entrée pour l'école, mille portes de sortie pour nous. 🔑

```
EirbConnect (Keycloak école)
      │  1 seul client, 1 seul callback déjà autorisé
      ▼
Dex (broker)  @ https://auth.<domaine>/oauth2     ← déployé tout seul, partagé par toutes les assos
      ├──► InvenTree asso A   (OIDC natif)
      ├──► InvenTree asso B   (OIDC natif)
      └──► … etc.
```

**Comment un membre entre, concrètement :** il clique « EirbConnect », se logge avec ses identifiants
scolaires, et **son compte InvenTree se crée tout seul** — mais **sans aucun groupe**, donc il ne voit
rien encore. Un admin lui **assigne un groupe** = il est approuvé. L'IdP dit *qui c'est*, toi tu dis
*il a accès à quoi*. Pas de gestion de mots de passe, pas de liste blanche à maintenir.

> Tu n'as **rien** à faire pour câbler tout ça : `create-asso.sh` déploie le broker, enregistre
> l'instance, injecte la config et active le SSO. La seule action humaine qui reste = donner un groupe
> aux nouveaux. (Et au tout premier lancement, il te demande **une fois** tes identifiants EirbConnect
> et tes réglages email — voir plus bas.)

---

## Architecture

```
Internet ──443──► Caddy frontal (~/front)   ← HTTPS Let's Encrypt, 1 bloc par asso + 1 bloc auth
                       │   auth.eirspace.fr           { reverse_proxy dex:5556 }        ← le broker SSO
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

- Un **Caddy frontal unique** occupe les ports 80/443 et route chaque sous-domaine vers le bon
  conteneur. Le script l'installe tout seul à la première asso.
- Le **broker Dex** vit à côté (`~/auth-dex/`), partagé par toutes les assos, sur `auth.<domaine>`.
- Chaque asso garde son **InvenTree complet et isolé** (Postgres + cache + serveur + worker + Caddy
  interne).
- La **Scanette** (nginx) sert l'app et **proxifie** l'API/les médias vers l'InvenTree de la même asso
  en réécrivant l'`Host` → **same-origin**. La Scanette hérite donc de la session InvenTree
  automatiquement (pas d'auth séparée), et `index.html` ne change jamais d'une asso à l'autre.

---

## Structure du repo

```
.
├── README.md
├── create-asso.sh          # déploie InvenTree + Scanette + SSO d'une asso
├── delete-asso.sh          # supprime tout pour une asso (+ son client SSO)
├── lib/
│   └── sso.sh              # fonctions partagées : broker Dex, OIDC InvenTree, SMTP
├── auth/
│   ├── bootstrap-dex.sh    # déploiement du broker Dex en standalone (optionnel)
│   └── INTEGRATION.md      # notes d'intégration / vérifs
└── scanette-src/           # fichiers source de l'app (à déposer une fois)
    ├── README.md           # ce qu'il faut y mettre
    ├── index.html          # ← à ajouter (l'app)
    └── zxing_reader.wasm   # ← à ajouter (décodeur de codes-barres)
```

> ⚠️ `index.html` et `zxing_reader.wasm` **ne sont pas fournis** : ce sont **tes** fichiers d'app.
> Dépose-les dans `scanette-src/` avant le premier déploiement (voir
> [`scanette-src/README.md`](scanette-src/README.md)). Les logos (`logo-black.png`, `logo-white.png`)
> sont optionnels.

### Où vivent les choses ?

Le repo, c'est juste l'outillage. Le reste est créé **hors du repo**, dans ton home :

```
~/<nom>/                          # ex: ~/eirspace/  — une asso déployée
├── .env                          # identifiants + réglages (NE PAS committer)
├── docker-compose.yml            # InvenTree
├── Caddyfile                     # proxy interne InvenTree
├── <nom>-data/                   # données (Postgres, media, config.yaml…)  ← à sauvegarder
└── scanette/                     # la Scanette de l'asso

~/front/                          # le Caddy frontal partagé (créé automatiquement)
├── docker-compose.yml
└── Caddyfile                     # 1 bloc par asso + 1 bloc "auth", gérés par les scripts

~/auth-dex/                       # le broker SSO Dex (créé automatiquement)
├── docker-compose.yml
└── config.yaml                   # généré : connecteur EirbConnect + 1 client par asso

~/.config/multi-inventory/        # tes secrets, HORS du repo (chmod 600)
├── eirbconnect.env               # identifiants EirbConnect (demandés 1 fois)
├── smtp.env                      # réglages email SMTP (demandés 1 fois)
└── dex-clients/<nom>.yaml        # 1 fragment de client Dex par asso
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

### 2. Swap — le filet de sécurité (vraiment recommandé)

```bash
sudo swapon --show || { sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile \
  && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab ; }
```
Le swap absorbe les pics ; il ne remplace pas la RAM (~1000× plus lent), mais il évite qu'un coup de
chaud tue un conteneur.

### 3. DNS — pointer les sous-domaines vers le VPS

Le plus simple : un **wildcard**. Dans la zone DNS de ton domaine, un enregistrement **A** :

| Sous-domaine | Cible (IPv4) | Effet |
|---|---|---|
| `*` | l'IP du VPS (`curl -4 -s ifconfig.me`) | tous les sous-domaines pointent vers le VPS → **plus jamais** à toucher au DNS |

Le wildcard couvre **aussi** `auth.<domaine>` (le broker SSO) — rien de spécial à ajouter. Vérifie
avant de déployer (doit renvoyer l'IP du VPS) :
```bash
dig inventaire.<ton-domaine> +short
dig auth.<ton-domaine> +short
```

> Pas de domaine ? Utilise le mode **`tmp`** (sslip.io), aucune entrée DNS — mais le SSO est alors
> désactivé (normal : l'école ne peut pas autoriser une URL éphémère).

### 4. Les fichiers de l'app Scanette

Dépose `index.html` + `zxing_reader.wasm` (+ logos optionnels) dans `scanette-src/`.

### 5. (Conseillé) Fiabiliser la route vers EirbConnect

Le VPS et le Keycloak de l'école ne s'entendent pas toujours parfaitement au niveau réseau (quelques
poignées de main TLS qui sautent). `create-asso.sh` applique tout seul un *clamp MSS* qui règle ça —
mais il saute au reboot. Pour le rendre permanent une bonne fois :
```bash
sudo apt install -y iptables-persistent && sudo netfilter-persistent save
```

---

## Démarrage

```bash
# 1. Récupérer le repo sur le VPS et rendre les scripts exécutables
git clone <url-de-ton-repo> ~/inventree-scanette
cd ~/inventree-scanette
chmod +x create-asso.sh delete-asso.sh auth/bootstrap-dex.sh

# 2. (une fois) déposer index.html + zxing_reader.wasm dans scanette-src/
#    depuis ton PC, par ex. :  scp index.html zxing_reader.wasm debian@<IP_VPS>:~/inventree-scanette/scanette-src/

# 3. Déployer une asso (InvenTree + Scanette + SSO en une commande)
./create-asso.sh eirspace                   # -> https://inventaire.eirspace.fr  (+ /scan/)  [asso principale]
```

**Au tout premier lancement**, le script te pose deux séries de questions (une seule fois, stockées
`chmod 600` hors du repo, jamais committées) :

- **Identifiants EirbConnect** (`Client ID` + `Client secret`) → `~/.config/multi-inventory/eirbconnect.env`
- **Réglages email SMTP** (serveur, port, identifiant = adresse complète, mot de passe **de la boîte
  mail**, expéditeur) → `~/.config/multi-inventory/smtp.env`. C'est requis pour que l'auto-création des
  comptes SSO fonctionne (et l'expéditeur sert d'email au compte admin). Pour OVH/Zimbra, les valeurs
  par défaut proposées (`ssl0.ovh.net`, port `587`) conviennent.

Ensuite, **plus aucune question** : chaque asso sort prête, SSO et email déjà branchés. À la fin, le
script affiche l'URL, l'identifiant admin (`admin_<nom>`) et le mot de passe généré — **note-les**
(modifiable ensuite depuis l'interface).

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
| `[sous-domaine]` | label du sous-domaine. `tmp` → instance **éphémère** (sslip.io, sans DNS, sans SSO). Absent → `inventaire.<domaine>` pour l'**asso principale** (`eirspace`), sinon `inventaire-<nom>.<domaine>`. |
| `[mot-de-passe]` | mot de passe admin (généré aléatoirement si absent). |

**Exemples**
```bash
./create-asso.sh eirspace                      # https://inventaire.eirspace.fr  (asso principale)
./create-asso.sh eirspace inventaire           # https://inventaire.eirspace.fr  (identique, explicite)
./create-asso.sh pixeirb  inventaire-pixeirb   # https://inventaire-pixeirb.eirspace.fr
./create-asso.sh vost                          # https://inventaire-vost.eirspace.fr  (défaut auto)
./create-asso.sh demo     tmp                  # https://demo.<ip>.sslip.io  (éphémère, sans DNS/SSO)
ENABLE_SSO=0 ./create-asso.sh vost             # sans SSO
```

> **Asso principale (`eirspace`).** Son sous-domaine est **fixe** : `inventaire.<domaine>` (et non
> `inventaire-eirspace`). Donc `./create-asso.sh eirspace` **seul** redonne toujours exactement
> `https://inventaire.eirspace.fr` — pratique pour réinstaller sans changer d'URL. Configurable via
> `MAIN_ASSO` / `MAIN_SUBDOMAIN`.

**Variables d'environnement**

| Variable | Défaut | Effet |
|---|---|---|
| `BASE_DOMAIN` | `eirspace.fr` | ton domaine (vide `""` → sslip.io) |
| `SCAN_SRC` | `<repo>/scanette-src` | dossier source de l'app |
| `WITH_SCANETTE` | `1` | `0` = déployer **InvenTree seul** (sans Scanette) |
| `ENABLE_SSO` | `1` | `0` = déployer **sans EirbConnect** |
| `MAIN_ASSO` | `eirspace` | asso principale au sous-domaine fixe |
| `MAIN_SUBDOMAIN` | `inventaire` | sous-domaine fixe de l'asso principale |

Le script, **idempotent**, fait tout dans l'ordre : vérif Docker, réseau partagé, bootstrap du Caddy
frontal si absent, (au besoin) questions une-fois EirbConnect + SMTP, calcul de l'URL, `.env`
(préservé en cas de re-run), `docker-compose.yml`, `invoke update`, réglage **worker=1**, démarrage,
build de la **Scanette**, bloc **Caddy frontal**, puis tout le **SSO** : broker Dex déployé/mis à jour,
client de l'asso enregistré, bloc OIDC injecté dans `config.yaml`, SMTP écrit dans le `.env`,
rechargement de l'instance, et **toggles SSO activés en base**.

> Relancer `./create-asso.sh eirspace` = **mettre à jour** (identifiants inchangés, app rebuild,
> frontal + Dex rechargés). C'est aussi comme ça qu'on **met à jour la Scanette** après avoir changé
> `index.html` dans `scanette-src/`.

---

## `delete-asso.sh` — tout supprimer pour une asso

```bash
./delete-asso.sh <nom>      # demande de taper "oui" pour confirmer
```

Arrête/supprime les conteneurs **Scanette + InvenTree**, retire la route frontale de l'asso, **retire
son client du broker Dex** (et régénère Dex), recharge le frontal, puis efface `~/<nom>/`.

> ⚠️ **DÉFINITIF** : toutes les données de l'asso sont perdues. **Sauvegarde avant** :
> `cp -r ~/<nom>/<nom>-data ~/backup-<nom>`. Les **autres** assos, le réseau partagé et le broker Dex
> ne sont pas touchés.

---

## Pourquoi « optimisé » ? (les 2 réglages qui font tout)

1. **Worker de fond = 1.** Par défaut InvenTree lance plusieurs process django-q, chacun rechargeant
   tout InvenTree (~230 Mo pièce) → jusqu'à ~1 Go. La variable `INVENTREE_BACKGROUND_WORKERS=1` ne
   suffit pas : elle est **écrasée** par `config.yaml`. Le script corrige les **deux** (~1 Go → ~230 Mo).
2. **Worker web gunicorn = 1** (`INVENTREE_GUNICORN_WORKERS=1`, lu depuis `.env`) : serveur ~625 Mo →
   ~350 Mo.

Résultat : une instance passe de **~2 Go** à **~700 Mo–1 Go** stabilisée (−65 %). Réversible (`=2`) un
jour de pointe. Chaque asso ayant son propre worker, les assos ne se ralentissent pas entre elles.
Le broker Dex, lui, ne consomme presque rien (quelques dizaines de Mo, partagé par tout le monde).

---

## Commandes utiles

```bash
docker stats --no-stream            # mémoire/CPU par conteneur (laisser reposer ~5-10 min)
free -h                             # mémoire + swap de la machine
docker ps                           # conteneurs qui tournent
docker ps | grep -- -scan           # juste les Scanettes
docker logs -f <nom>-server         # logs d'une instance InvenTree
docker logs -f <nom>-scan           # logs nginx d'une Scanette
cat ~/front/Caddyfile               # blocs/routes du frontal (assos + auth)
cd ~/front && docker compose logs -f   # logs du Caddy frontal (TLS, routage)
curl -I https://<domaine>/scan/     # test rapide de la Scanette (depuis le VPS)

# --- SSO / broker Dex ---
cd ~/auth-dex && docker compose logs --tail=10 dex            # le broker tourne ? (cherche "listening ... :5556")
curl -s https://auth.<domaine>/oauth2/.well-known/openid-configuration | head -c 120   # discovery (doit être du JSON)
ls ~/.config/multi-inventory/dex-clients/                     # 1 fragment par asso
docker exec <nom>-server printenv INVENTREE_EMAIL_HOST        # le SMTP est-il bien injecté ?

# Changer un mot de passe admin (si accès perdu)
docker compose -f ~/<nom>/docker-compose.yml exec inventree-server \
  python3 manage.py changepassword admin_<nom>

# Redémarrage après reboot complet : instances + broker d'abord, frontal en dernier
for d in eirspace pixeirb vost; do (cd ~/$d && docker compose up -d); done
cd ~/auth-dex && docker compose up -d
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
| Le bouton EirbConnect ne mène nulle part | broker Dex KO → `cd ~/auth-dex && docker compose logs --tail=20 dex` ; il se relance seul, attends ~10s |
| `auth.<domaine>` ne répond pas (JSON attendu) | route "auth" absente du frontal → relancer `./create-asso.sh <nom>` (réinjecte la route + recharge) |
| Compte SSO non créé / "sign up closed" | SMTP pas configuré → vérifier `docker exec <nom>-server printenv INVENTREE_EMAIL_HOST` |
| Un membre est connecté mais ne voit rien | normal : compte créé sans groupe → Admin Center → Users → lui assigner un groupe |
| L'app ne se met pas à jour sur le tél. | incrémenter `?v=N` ; sinon vider le cache du navigateur |
| 403 à la création / l'ajout de stock | le rôle du groupe doit avoir **Part:add** / **Stock:add** (+ **barcode**) |
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

Plancher incompressible : ~600-700 Mo par instance (2 process Python). L'optimisation rend le
multi-instance possible pour un **usage léger/sporadique** sur petite machine ; elle ne crée pas de RAM
pour un usage lourd simultané. Au-delà : **Oracle Cloud Always Free** (12 Go ARM, gratuit) ou un VPS
8 Go / 4 cœurs.

---

## Sauvegarde & transmission entre promos

Un VPS, ça se perd. Copie régulièrement **hors du VPS** (rsync/scp) :

- les données de chaque asso : `~/<nom>/<nom>-data/`
- tes secrets : `~/.config/multi-inventory/` (creds EirbConnect, SMTP, fragments Dex)

Et écris quelque part les accès qui ne se devinent pas (compte VPS, registrar du domaine, mots de passe
admin, à qui demander un nouveau client EirbConnect côté Eirbware). La prochaine équipe te dira merci. 🙏

```bash
# exemple : sauvegarde locale rapide d'une asso + des secrets
cp -r ~/eirspace/eirspace-data ~/backup-eirspace-$(date +%F)
cp -r ~/.config/multi-inventory ~/backup-secrets-$(date +%F)
```

---

## Bon à savoir (deux ou trois pièges qui font gagner des heures)

- **Ne renomme jamais** `OIDC_PROVIDER_ID` (`eirbconnect`) ni l'id du connecteur Dex en prod : l'identité
  des comptes est liée au `sub` du SSO, et renommer casse tous les liens → les gens perdent leur compte.
- **L'identité est le `sub`, pas l'email.** Du coup le bazar des multiples adresses de l'école
  (`@bordeaux-inp.fr`, `@ipb.fr`, `@enseirb-matmeca.fr`) n'a aucune importance.
- Pour appliquer un changement de `.env`, c'est **`docker compose up -d`** (qui recrée le conteneur),
  pas `docker compose restart` (qui ne relit pas le `.env`).
- Les logs InvenTree se font parfois spammer par des bots qui cherchent des secrets (`/.env`, etc.) :
  InvenTree répond `302`, rien ne fuit, c'est normal.
