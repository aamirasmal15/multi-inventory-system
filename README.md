# Multi-inventory : InvenTree + Scannette + SSO EirbConnect, clé en main

> 🙏 **Ce projet repose entièrement sur [InvenTree](https://inventree.org)**, l'excellent logiciel
> **libre** de gestion d'inventaire. Tout le cœur « inventaire » (pièces, stock, commandes, API,
> interface…) vient de chez eux, un grand merci à ses auteurs et à sa communauté. Ce dépôt n'est
> qu'une **couche d'outillage** posée par-dessus pour l'auto-déployer en multi-assos.

Ce dépôt permet d'héberger sur **un seul serveur** une gestion d'inventaire pour **plusieurs
associations**. Chaque asso repart avec **deux services isolés** (base, comptes et données
séparés) :

- **son InvenTree**, un site d'inventaire complet, sur `https://inventaire[-<asso>].<domaine>` ;
- **sa Scannette**, une app web **mobile** pour scanner les codes-barres / QR et gérer le stock
  depuis un téléphone, sur `https://scannette[-<asso>].<domaine>`.

Le tout branché au **SSO de l'école (EirbConnect)** : les membres se connectent avec leur compte
habituel. Une commande déploie une asso complète, une autre la supprime proprement.

## Les deux commandes

```bash
./create-asso.sh eirspace     # déploie / met à jour  → https://inventaire.eirspace.fr + https://scannette.eirspace.fr
./delete-asso.sh eirspace     # supprime tout (nom exact à retaper + backup auto immuable, gardé 30 j)
```

`create-asso.sh` est **idempotent** : le relancer = mettre à jour.

## Démarrage

```bash
# VPS Debian vierge : installer git (absent par défaut au tout premier run)
sudo apt update
sudo apt install git -y

git clone <url-de-ton-repo> ~/multi-inventory-system
cd ~/multi-inventory-system

./create-asso.sh eirspace
```

Sur un VPS neuf, ce premier run installe tout seul ce qui manque (Docker, swap, zram, earlyoom) et
demande **une seule fois** le domaine, les identifiants EirbConnect et le SMTP. La **seule chose à
faire à la main** au préalable : un enregistrement **DNS A wildcard** `*` pointant vers l'IP du VPS
(il couvre `inventaire`, `scannette` et `auth` d'un coup).

Détails pas-à-pas → **[Installation](https://github.com/aamirasmal15/multi-inventory-system/wiki/Installation)**.

## 📖 Documentation complète → le wiki

Toute la doc opérationnelle est dans le **[wiki](https://github.com/aamirasmal15/multi-inventory-system/wiki)** :

**Comprendre & installer**
- [Architecture](https://github.com/aamirasmal15/multi-inventory-system/wiki/Architecture) : le broker Dex, les sous-domaines séparés, où vivent les fichiers
- [Installation](https://github.com/aamirasmal15/multi-inventory-system/wiki/Installation) : prérequis (DNS, réseau) et premier démarrage

**Gérer les assos**
- [Déployer une asso](https://github.com/aamirasmal15/multi-inventory-system/wiki/Déployer-une-asso) : `create-asso.sh`, version épinglée, interstitiel mobile
- [Branding et logos](https://github.com/aamirasmal15/multi-inventory-system/wiki/Branding-et-logos) : logo et nom affiché d'une asso (magasin `LOGO=`)
- [Supprimer une asso](https://github.com/aamirasmal15/multi-inventory-system/wiki/Supprimer-une-asso) : `delete-asso.sh`, backups automatiques immuables
- [Sauvegarde et restauration](https://github.com/aamirasmal15/multi-inventory-system/wiki/Sauvegarde-et-restauration) : les trois mécanismes
- [SSO et accès membres](https://github.com/aamirasmal15/multi-inventory-system/wiki/SSO-et-accès-membres) : EirbConnect/Dex et l'approbation des membres

**Configuration**
- [Réglages et variables](https://github.com/aamirasmal15/multi-inventory-system/wiki/Réglages-et-variables) : réglages InvenTree, variables d'environnement, mots de passe

**Composants**
- [La Scannette](https://github.com/aamirasmal15/multi-inventory-system/wiki/La-Scannette) : l'app web mobile de scan
- [Plugin Prêts](https://github.com/aamirasmal15/multi-inventory-system/wiki/Plugin-Prêts) : emprunts et réservations d'objets trackables
- [Plugin E-mails](https://github.com/aamirasmal15/multi-inventory-system/wiki/Plugin-E-mails) : habillage des e-mails InvenTree

**Infrastructure**
- [Performance et mémoire](https://github.com/aamirasmal15/multi-inventory-system/wiki/Performance-et-mémoire) : dimensionnement, zram, earlyoom, tests de charge
- [Dépannage](https://github.com/aamirasmal15/multi-inventory-system/wiki/Dépannage) : symptômes courants et commandes utiles

## Structure du dépôt

```
multi-inventory-system/
├── create-asso.sh            # créer / mettre à jour une asso
├── delete-asso.sh            # tout supprimer pour une asso (client Dex inclus)
├── inventree-settings.conf   # réglages InvenTree posés à la création
├── lib/                      # sso.sh (Dex + SSO + SMTP) · finalize.py (réglages + groupe membre) · swap.sh (swap disque dynamique)
├── templates/                # gabarits des fichiers générés (jetons __NOM__ substitués au run)
├── auth/                     # bootstrap-dex.sh (Dex standalone) · INTEGRATION.md
├── assets/logos/             # logos par asso, défauts versionnés (<nom>-white/black.png)
├── plugins/                  # inventree-prets · inventree-emails
└── scannette-src/            # l'app Scannette complète (SPA statique, sans build)
```

Tout ce qui est **déployé** ou **secret** vit hors du dépôt (`~/assos/`, `~/.config/multi-inventory/`,
`~/front/`, `~/auth-dex/`) et n'est jamais committé, voir
[Architecture](https://github.com/aamirasmal15/multi-inventory-system/wiki/Architecture).

> **« Scannette », avec deux n ?** Le mot n'est dans aucun dictionnaire ; on a gardé l'orthographe
> qui colle à « scanner ». `scanette-…` redirige vers `scannette-…` : tapez ce que vous voulez.
