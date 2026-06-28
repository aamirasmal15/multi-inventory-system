# Multi-inventory — InvenTree + Scanette + SSO EirbConnect, clé en main

Salut 👋

Ce repo, c'est l'outillage pour déployer une **plateforme d'inventaire multi-assos** sur un seul VPS :
une instance **InvenTree** isolée par association (chacune sur son sous-domaine), une **Scanette**
(app web de scan de codes-barres) par asso, et le **SSO de l'école (EirbConnect)** branché
automatiquement. Une commande crée tout, une autre supprime tout proprement.

```
./create-asso.sh eirspace        # -> https://inventaire.eirspace.fr  (+ /scan/, + bouton EirbConnect)
./delete-asso.sh  eirspace        # supprime tout (avec confirmation)
```

---

## La « magie » du montage

Chaque InvenTree veut son propre `redirect_uri` pour le SSO. Sauf qu'EirbConnect (le Keycloak de
l'école) n'autorise **qu'un seul callback**, et le faire changer côté Eirbware à chaque nouvelle
asso, c'est la galère. La solution : un **broker Dex** posé entre EirbConnect et tes InvenTree.

```
EirbConnect (Keycloak école)  ──(1 seul client + 1 seul callback)──►  Dex (auth.<domaine>/oauth2)
                                                                         │  redistribue l'identité
                                            ┌────────────────────────────┼────────────────────────────┐
                                            ▼                            ▼                            ▼
                                   InvenTree asso A             InvenTree asso B             Scanette (même origine,
                                   (client Dex propre)          (client Dex propre)          hérite la session InvenTree)
```

Astuce clé : Dex est monté sur l'issuer `…/oauth2`, donc son callback devient `…/oauth2/callback`
= **pile le seul callback déjà enregistré côté école**. Résultat : **plus jamais besoin d'Eirbware**
pour ajouter une asso. Chaque InvenTree obtient un client Dex à nous (callbacks libres).

---

## Ce que font les scripts

| Script | Rôle |
|---|---|
| `create-asso.sh <nom>` | crée / met à jour une asso **complète** : InvenTree + Scanette + SSO + SMTP, derrière le Caddy frontal. **Idempotent** (relancer = mettre à jour). |
| `create-asso.sh --reconfigure` | ré-édite **d'un coup** le domaine, la version InvenTree épinglée et le SMTP, et **repropage le SMTP** à toutes les assos. |
| `delete-asso.sh <nom>` | supprime tout pour une asso : conteneurs, route frontale, **client Dex**, et données. |
| `auth/bootstrap-dex.sh` | (optionnel) déploie le broker Dex tout seul, pour le tester avant de créer une asso. |

Toute la logique partagée (Dex, SSO InvenTree, SMTP, réglages) vit dans **`lib/sso.sh`**, sourcée
par les scripts.

---

## Structure du repo

```
inventree-scanette/
├── create-asso.sh          # créer / mettre à jour une asso
├── delete-asso.sh          # tout supprimer pour une asso (client Dex inclus)
├── lib/
│   └── sso.sh              # fonctions partagées (Dex + SSO + SMTP + réglages)
├── auth/
│   ├── bootstrap-dex.sh    # déploiement Dex standalone (optionnel)
│   └── INTEGRATION.md       # notes d'intégration
└── scanette-src/           # les fichiers de l'app Scanette (à déposer une fois)
    ├── index.html
    └── zxing_reader.wasm
```

### Où vivent les choses (hors repo, dans le home)

```
~/<nom>/                         # une asso déployée (ex: ~/eirspace/)
├── .env                         # identifiants + réglages (NE PAS committer)
├── docker-compose.yml           # InvenTree
├── Caddyfile                    # proxy interne InvenTree
├── <nom>-data/                  # données (Postgres, media, config.yaml…)  ← À SAUVEGARDER
└── scanette/                    # la Scanette de l'asso (Dockerfile, default.conf, html/…)

~/front/                         # le Caddy frontal partagé (auto-créé)
├── docker-compose.yml
└── Caddyfile                    # 1 bloc par asso + 1 bloc auth.<domaine> -> Dex

~/auth-dex/                      # le broker Dex (auto-généré)
├── docker-compose.yml
└── config.yaml                  # base + 1 staticClient par asso (régénéré depuis les fragments)

~/.config/multi-inventory/       # l'état/secrets partagés (hors repo, chmod 600)  ← À SAUVEGARDER
├── settings.env                 # BASE_DOMAIN + INVENTREE_VERSION (épinglée)
├── eirbconnect.env              # client_id + secret EirbConnect
├── smtp.env                     # réglages SMTP
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

### 2. Swap — filet de sécurité (recommandé)

```bash
sudo swapon --show || { sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile \
  && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab ; }
```

### 3. DNS — wildcard vers le VPS

Le plus simple : un enregistrement **A** wildcard, qui couvre **tous** les sous-domaines
(y compris `auth.<domaine>` pour le broker SSO).

| Sous-domaine | Cible (IPv4) | Effet |
|---|---|---|
| `*` | l'IP du VPS (`curl -4 -s ifconfig.me`) | tous les sous-domaines pointent vers le VPS → **plus jamais** à toucher au DNS |

Vérifie avant de déployer :
```bash
dig inventaire.<ton-domaine> +short      # doit renvoyer l'IP du VPS
dig auth.<ton-domaine>      +short        # idem (pour le SSO)
```
> Pas de domaine ? Mode **`tmp`** (sslip.io) : `./create-asso.sh demo tmp` — aucune entrée DNS,
> mais **sans SSO** (le callback ne serait pas autorisable côté école).

### 4. Clamp MSS permanent (fiabilité de la route vers EirbConnect)

Le script applique tout seul un clamp MSS (sinon ~10 % des handshakes TLS vers l'école échouent),
mais **il saute au reboot**. Rends-le permanent une fois :
```bash
sudo apt install -y iptables-persistent
sudo netfilter-persistent save
```

### 5. Les fichiers de l'app Scanette

Dépose `index.html` + `zxing_reader.wasm` (+ logos optionnels) dans `scanette-src/`.

---

## Premier démarrage

```bash
git clone <url-de-ton-repo> ~/inventree-scanette
cd ~/inventree-scanette
chmod +x create-asso.sh delete-asso.sh auth/bootstrap-dex.sh

# déposer index.html + zxing_reader.wasm dans scanette-src/ (scp depuis ton PC, par ex.)

./create-asso.sh eirspace
```

Au **tout premier run**, le script te demande (une seule fois, stocké hors repo en `chmod 600`) :

1. **ton nom de domaine** → mémorisé dans `~/.config/multi-inventory/settings.env` ;
2. les **identifiants EirbConnect** (client_id + secret) → `eirbconnect.env` ;
3. les **réglages SMTP** (serveur, port, identifiant, mot de passe de la **boîte**, expéditeur) → `smtp.env`.

Ensuite : **plus aucune question**. Chaque asso sort branchée EirbConnect, SMTP configuré, email
admin posé, et le SSO activé en base. La seule action manuelle qui reste : **assigner un groupe**
à un nouveau membre.

> Astuce prompts : pour les réglages SMTP, tape **Entrée** pour garder la valeur proposée
> `[entre crochets]`.

---

## `create-asso.sh` — créer / mettre à jour

```bash
./create-asso.sh <nom> [sous-domaine|tmp] [mot-de-passe-admin]
```

| Argument | Détail |
|---|---|
| `<nom>` | nom interne (dossier + conteneurs), ex. `eirspace`, `pixeirb`. `[a-z0-9-]`. |
| `[sous-domaine]` | label du sous-domaine. `tmp` → instance **éphémère** (sslip.io, sans DNS, sans SSO). Absent → `inventaire.<domaine>` pour l'asso principale (`eirspace`), sinon `inventaire-<nom>.<domaine>`. |
| `[mot-de-passe]` | mot de passe admin (généré aléatoirement si absent). |

```bash
./create-asso.sh eirspace                      # https://inventaire.eirspace.fr
./create-asso.sh pixeirb  inventaire-pixeirb   # https://inventaire-pixeirb.eirspace.fr
./create-asso.sh vost                          # https://inventaire-vost.eirspace.fr
```

> Relancer `./create-asso.sh eirspace` = **mettre à jour** (identifiants inchangés, app rebuild,
> SSO/Dex/Caddy recâblés). C'est aussi comme ça qu'on **met à jour la Scanette** après avoir
> changé `index.html` dans `scanette-src/`.

---

## Version InvenTree épinglée (1.4.0)

Le système est **validé sur InvenTree 1.4.0**. Pour éviter qu'une nouvelle release casse tout,
le `.env` épingle `INVENTREE_TAG=1.4.0` (au lieu de `stable`). Une asso ne change donc **jamais**
de version toute seule.

```bash
# tester / mettre à jour UNE asso vers une autre version (migrations jouées automatiquement)
INVENTREE_VERSION=1.5.0 ./create-asso.sh vost

# quand une version est validée comme bonne, la passer en défaut PARTOUT (futures créations)
./create-asso.sh --reconfigure
```

- `INVENTREE_VERSION=x.y.z ./create-asso.sh <nom>` ne touche **que cette asso** : il met à jour son
  tag, tire l'image, joue `invoke update` (migrations), recrée les conteneurs. Les autres ne bougent pas.
- Relancer en 1.4.0 ne change rien (idempotent).

---

## `--reconfigure` — changer domaine / version / SMTP d'un coup

```bash
./create-asso.sh --reconfigure
```

Te repropose le **domaine**, la **version épinglée** et le **SMTP** (avec les valeurs actuelles en
défaut), puis **réapplique le SMTP** au `.env` de **chaque** asso et relance les conteneurs.

- **SMTP** : la modif est propagée à toutes les assos d'un coup.
- **Domaine** : la nouvelle valeur s'applique aux **prochaines** créations. Les assos **déjà en
  ligne gardent leur sous-domaine** (changer le domaine d'une asso vivante = la relancer
  `./create-asso.sh <nom>`, ce qui lui refait certif + route + client Dex).

---

## `delete-asso.sh` — tout supprimer pour une asso

```bash
./delete-asso.sh <nom>      # demande de taper "oui" pour confirmer
```

Arrête/supprime les conteneurs **Scanette + InvenTree**, retire la route frontale, **retire le
client Dex** (fragment + régénération du broker), puis efface `~/<nom>/`.

> ⚠️ **DÉFINITIF** : sauvegarde avant (section suivante). Les autres assos, le broker Dex et le
> réseau partagé ne sont pas touchés.

---

## Sauvegarde / restauration

**Ce qu'il faut sauvegarder :**

1. **Les données de chaque asso** → `~/<nom>/<nom>-data/` (Postgres + les images/media + `config.yaml`)
   **et** son `~/<nom>/.env` (il contient le mot de passe Postgres, indispensable pour relire les données).
2. **Les secrets partagés** → `~/.config/multi-inventory/` (domaine, EirbConnect, SMTP, clients Dex).

Le reste (`~/front`, `~/auth-dex`) est **régénéré automatiquement** par les scripts, pas besoin de
le sauvegarder.

### Sauvegarder (méthode simple, recommandée)

Le dossier `<nom>-data/` appartient à `root` (via Docker) → les commandes utilisent `sudo`.
On arrête l'asso le temps de la copie pour une **base Postgres cohérente**, puis on la relance.

```bash
NOM=eirspace

# 1) arrêter l'asso (cohérence Postgres)
cd ~/$NOM && docker compose down
( cd ~/$NOM/scanette && docker compose down ) 2>/dev/null || true

# 2) archiver les données + le .env
sudo tar czf ~/backup-$NOM-$(date +%F).tgz -C ~ "$NOM/$NOM-data" "$NOM/.env"

# 3) relancer l'asso
cd ~/$NOM && docker compose up -d
( cd ~/$NOM/scanette && docker compose up -d ) 2>/dev/null || true
```

Et **une fois** (ou quand ils changent), les secrets partagés :
```bash
tar czf ~/backup-config-$(date +%F).tgz -C ~ .config/multi-inventory
```

> Récupère ensuite les `.tgz` sur ton PC (`scp debian@<IP>:~/backup-*.tgz .`) ou pousse-les sur un
> stockage externe. Ne les laisse pas uniquement sur le VPS.

### Sauvegarder **sans interruption** (option, base seule)

Si tu ne veux pas couper l'asso, fais un export logique de la base à chaud (les images sont à
archiver à part) :
```bash
NOM=eirspace
cd ~/$NOM
docker compose exec -T inventree-db pg_dump -U "$NOM" "$NOM" | gzip > ~/backup-$NOM-db-$(date +%F).sql.gz
sudo tar czf ~/backup-$NOM-media-$(date +%F).tgz -C ~/$NOM/$NOM-data media
```

### Restaurer (même VPS, ou VPS tout neuf)

L'astuce : `create-asso.sh` **préserve** un `.env` existant et est **idempotent**. Donc on remet
les données + le `.env`, puis on relance `create-asso.sh` qui **reconstruit la stack autour**
(migrations, SSO, Caddy, Dex) sans rien écraser.

```bash
NOM=eirspace

# 0) (VPS neuf uniquement) prérequis Docker + réseau + repo + secrets partagés
git clone <url-de-ton-repo> ~/inventree-scanette
cd ~/inventree-scanette && chmod +x create-asso.sh delete-asso.sh auth/bootstrap-dex.sh
docker network create inventree-front 2>/dev/null || true
tar xzf ~/backup-config-AAAA-MM-JJ.tgz -C ~            # restaure ~/.config/multi-inventory
# (redépose aussi index.html + zxing_reader.wasm dans scanette-src/)

# 1) restaurer les données + le .env de l'asso
sudo tar xzf ~/backup-$NOM-AAAA-MM-JJ.tgz -C ~

# 2) reconstruire la stack autour des données restaurées
cd ~/inventree-scanette
./create-asso.sh $NOM
```

C'est tout : le `.env` restauré (donc le mot de passe Postgres) colle aux données restaurées,
`invoke update` migre si besoin, et le SSO/Caddy/Dex sont recâblés.

> **Restaurer un `pg_dump`** (si tu as pris l'option « sans interruption ») est plus manuel
> (recréer la base puis `psql` / `pg_restore`). Pour rester simple, privilégie la méthode tar
> ci-dessus, qui restaure base + media + config en une fois.

---

## Modèle d'accès

Auto-création + en attente d'approbation. Un membre inconnu se connecte via EirbConnect → son
compte InvenTree est **créé sans groupe** (il est connecté mais ne voit rien). Tu l'approuves en
lui **assignant un groupe** (Admin Center → Users). L'identité repose sur le `sub` OIDC (pas
l'email) → insensible aux multiples adresses de l'école.

> ⚠️ Ne **jamais renommer** en prod le provider `eirbconnect` ni l'id du connecteur Dex : ça
> changerait tous les `sub` et casserait les liens de compte.

---

## Réglages & variables

| Réglage | Où | Défaut | Effet |
|---|---|---|---|
| `BASE_DOMAIN` | `settings.env` (demandé au 1er run) | (saisi) | ton domaine ; surchargeable ponctuellement `BASE_DOMAIN=… ./create-asso.sh …` |
| `INVENTREE_VERSION` | `settings.env` | `1.4.0` | version InvenTree épinglée ; surcharge par asso `INVENTREE_VERSION=… ./create-asso.sh <nom>` |
| `WITH_SCANETTE` | env | `1` | `0` = InvenTree seul |
| `ENABLE_SSO` | env | `1` | `0` = pas de SSO |
| `MAIN_ASSO` / `MAIN_SUBDOMAIN` | env | `eirspace` / `inventaire` | l'asso principale au sous-domaine fixe |
| `ADMIN_EMAIL` | env | expéditeur SMTP | email du compte admin |

---

## Dépannage

| Symptôme | Piste |
|---|---|
| `permission denied … docker.sock` | `sudo usermod -aG docker $USER` + reconnexion (ou `newgrp docker`) |
| Caddy n'obtient pas le certificat | `dig <sous-domaine> +short` doit renvoyer l'IP du VPS ; attendre la propagation DNS |
| Page sans CSS / erreur CSRF | vérifier `INVENTREE_SITE_URL` + les 3 `USE_X_FORWARDED_*=True` dans `~/<nom>/.env` |
| `502` sur une URL | l'instance n'est pas démarrée → `cd ~/<nom> && docker compose up -d` |
| **Toutes** les URLs tombent | `front-caddy` arrêté → `cd ~/front && docker compose up -d` |
| `/scan` renvoie 502 | conteneur Scanette arrêté → `cd ~/<nom>/scanette && docker compose up -d` |
| Bouton EirbConnect en erreur / `redirect_uri` | vérifier que Dex tourne : `cd ~/auth-dex && docker compose logs --tail=15 dex` ; discovery : `curl -s https://auth.<domaine>/oauth2/.well-known/openid-configuration | head -c 120` |
| Login SSO refuse de créer un compte (`signup_closed`) | SMTP manquant/incorrect → `docker exec <nom>-server printenv INVENTREE_EMAIL_HOST` doit afficher ton serveur ; sinon `./create-asso.sh --reconfigure` |
| `~10 %` des logins SSO échouent au reboot | clamp MSS non permanent → `sudo netfilter-persistent save` |

### Commandes utiles

```bash
docker stats --no-stream                       # mémoire/CPU par conteneur
free -h                                         # mémoire + swap
docker ps                                        # conteneurs qui tournent
cat ~/front/Caddyfile                            # routes du frontal
ls ~/.config/multi-inventory/dex-clients/        # 1 fragment par asso SSO
cd ~/auth-dex && docker compose logs --tail=15 dex

# redémarrage après reboot complet : instances d'abord, frontal en dernier
for d in eirspace pixeirb vost; do (cd ~/$d && docker compose up -d); done
cd ~/auth-dex && docker compose up -d
cd ~/front && docker compose up -d

# changer un mot de passe admin
docker compose -f ~/<nom>/docker-compose.yml exec inventree-server \
  python3 manage.py changepassword admin_<nom>
```

---

## Pourquoi « optimisé mémoire » ?

Deux réglages divisent par ~3 la conso d'une instance (de ~2 Go à ~700 Mo–1 Go) :
**worker de fond = 1** (corrigé à la fois dans `.env` *et* dans `config.yaml`, sinon il est écrasé)
et **worker web gunicorn = 1**. Réversible (`=2`) un jour de pointe. Chaque asso ayant son propre
worker, les assos ne se ralentissent pas entre elles.
