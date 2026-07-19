# Intégration SSO dans le repo : pose et déploiement

> Note : cette intégration est déjà en place dans le repo (les scripts sourcent
> `lib/sso.sh` et appellent les hooks décrits ici). Ce fichier est conservé comme
> doc de référence sur le fonctionnement du SSO et son déploiement.


Ce dossier `auth/` + `lib/sso.sh` automatisent **tout** le SSO (broker Dex + OIDC InvenTree
+ SMTP + email admin + toggles). On déploie en même temps.

## 0. Arborescence à ajouter au repo
```
multi-inventory-system/
├── lib/
│   └── sso.sh              # ← nouveau (fonctions partagées)
├── auth/
│   ├── bootstrap-dex.sh    # ← nouveau (déploiement Dex standalone, optionnel)
│   └── INTEGRATION.md      # ← ce fichier
├── create-asso.sh          # ← 2 petites lignes à ajouter (ci-dessous)
└── delete-asso.sh          # ← 1 bloc à ajouter (ci-dessous)
```
```bash
chmod +x auth/bootstrap-dex.sh
```

## 1. Modifs dans `create-asso.sh` (2 ajouts, rien à supprimer)

### 1.a : Sourcer la lib
Juste **après** la ligne qui définit `SCRIPT_DIR` (tout en haut), ajoute :
```bash
# Fonctions SSO/Dex/SMTP partagées
. "$SCRIPT_DIR/lib/sso.sh"
```

### 1.b : Appeler le hook SSO en fin de script
Tout à la fin, **juste avant le bloc récap** (le `echo ">> =====..."`), ajoute :
```bash
# ====== SSO EirbConnect (broker Dex) : tout automatisé ======
if [ "${SSO_READY:-0}" = "1" ]; then
  setup_asso_sso "$NAME" "$HOST" "$DIR"
fi
```

> **Tu n'as PAS besoin de toucher** ton ancien bloc « Injection EirbConnect » : `setup_asso_sso`
> réécrit le bloc OIDC entre les **mêmes marqueurs**, donc il **écrase** l'ancien (qui pointait
> direct sur EirbConnect) par celui qui pointe sur Dex. Tu peux le laisser tel quel.

> Le récap de fin de `create-asso.sh` affiche déjà « EirbConnect (SSO) : prêt, tout est
> automatique » : plus aucune étape manuelle côté SSO, la seule action restante est
> d'approuver les nouveaux membres (Admin Center > Users > assigner un groupe).

## 2. Modif dans `delete-asso.sh` (retirer le client Dex)

Tout en haut, après `set -euo pipefail`, ajoute la détection du repo + la lib :
```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/lib/sso.sh"
```
Puis, **après** le bloc qui retire la route du Caddy frontal (le `awk ... Caddyfile`), ajoute :
```bash
# Retirer le client Dex de cette asso + régénérer le broker
dex_remove_client "$NAME" || true
```

## 3. Déploiement (idempotent)

```bash
cd ~/multi-inventory-system
git pull                      # ou copie lib/ et auth/ sur le VPS

# (optionnel) déployer/tester le broker Dex d'abord
./auth/bootstrap-dex.sh
curl -s https://auth.eirspace.fr/oauth2/.well-known/openid-configuration | head -c 120; echo

# créer/mettre à jour une asso : SSO + SMTP + branding gérés tout seuls
./create-asso.sh assotest
```
Au **1er run**, le script demande (une seule fois, stockés `chmod 600` hors repo) :
- les creds **EirbConnect** (`~/.config/multi-inventory/eirbconnect.env`), si pas déjà là ;
- les réglages **SMTP** (`~/.config/multi-inventory/smtp.env`) : serveur (défaut `ssl0.ovh.net`),
  port (587), identifiant = adresse complète, **mot de passe de la BOÎTE**, expéditeur.

Ensuite, **plus aucune question** : chaque asso sort avec EirbConnect branché, l'auto-création
active, l'email admin posé, et le SMTP configuré.

## 4. Vérifs rapides
```bash
# Dex tourne, 1 connecteur + N clients
cd ~/auth-dex && docker compose logs --tail=8 dex
# le SMTP est bien dans le conteneur de l'asso
docker exec <nom>-server printenv INVENTREE_EMAIL_HOST
# fragments Dex (1 par asso)
ls ~/.config/multi-inventory/dex-clients/
```

## Notes
- **Modèle d'accès** : auto-création + en attente. Inconnu -> compte créé sans groupe -> tu
  assignes un groupe = approuvé. L'identité est le `sub` (pas l'email) -> insensible aux emails
  multiples de l'école.
- **Ne jamais renommer** `OIDC_PROVIDER_ID` (`eirbconnect`) ni l'id du connecteur Dex en prod
  (ça casse les liens `sub`).
- **clamp MSS** : appliqué à chaque run (idempotent). Rends-le permanent une fois :
  `sudo apt install -y iptables-persistent && sudo netfilter-persistent save`.
- **Dex storage = memory** (simple, pas de perms à gérer). Un restart de Dex ne casse pas les
  sessions InvenTree établies (Dex n'est qu'un relais d'identité). Passe à `sqlite3` si tu veux
  persister les sessions Dex en cours.
- **Instances éphémères** (`tmp`/sslip.io) : SSO auto-désactivé (pas de `SSO_READY`), rien à faire.
