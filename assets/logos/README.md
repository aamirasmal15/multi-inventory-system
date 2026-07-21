# assets/logos/ : logos par asso

Tous les logos, à plat, nommés **`<nom>-white.png` / `<nom>-black.png`**, exactement le nom
qu'ils portent une fois déployés dans le `html/img/` de la Scannette (aucun renommage).
create-asso.sh les résout **par nom d'asso**, sans cas particulier (l'asso principale est une
asso comme une autre).

```
assets/logos/
├── eirspace-white.png    logo eirspace, thème CLAIR
├── eirspace-black.png    logo eirspace, thème SOMBRE
├── bde-white.png         (exemple asso partenaire)
└── bde-black.png
```

Convention : `*-white.png` = thème **CLAIR** (encre foncée, ou badge autoportant) ;
`*-black.png` = thème **SOMBRE** (encre claire). Une seule variante suffit : elle sert pour les
deux thèmes. Le `.png` est conventionnel (un JPEG déposé sous ce nom est servi sans souci).

## Ajouter le logo d'une asso : le cas simple

Dépose les deux fichiers ici, puis déploie. **Aucun path à spécifier.**

```bash
cp mon-logo-clair.png  assets/logos/bde-white.png
cp mon-logo-sombre.png assets/logos/bde-black.png
./create-asso.sh bde
```

## Mettre à jour / ajouter un thème après coup

La résolution est refaite **à chaque run**, **par thème** (clair et sombre indépendamment),
puis reposée d'un `cp -f`. Il suffit donc de **relancer `./create-asso.sh <nom>`** :

- clair seul au départ, tu ajoutes `<nom>-black.png` → le **thème sombre** de la Scannette
  se met à jour, le clair reste ;
- aucun logo, tu ajoutes `<nom>-white.png` → Scannette (clair + sombre) et InvenTree (clair)
  prennent le nouveau logo ;
- tu remplaces un fichier → le nouveau logo remplace l'ancien partout (image Docker de la
  Scannette rebâtie, `custom_logo.png` d'InvenTree ré-copié).

Le run affiche la source retenue par thème (`>> Logo '<nom>' thème clair <- …` / `thème sombre <- …`) ;
mêmes deux fichiers = un seul thème existe, il sert pour les deux.

## Où le logo apparaît

Un même logo alimente **deux** cibles à chaque déploiement :
- **Scannette** : `html/img/<nom>-{white,black}.png` (en-tête, login, interstitiel mobile) ;
- **InvenTree** (PUI) : `static/img/custom_logo.png` + `customize.logo` (navbar, après connexion,
  servi public via `/static/`). Pas de favicon (on garde celui d'InvenTree).

Pour une asso **partenaire** (nom ≠ `MAIN_ASSO`), le login de la Scannette affiche en plus le
lockup collab « <PRINCIPALE> × <ASSO> » : le logo de l'asso principale est recopié dans chaque
instance.

## Ordre de résolution (deux couches)

1. **Magasin runtime** `~/.config/multi-inventory/logos/<nom>-{white,black}.png` : **prime** s'il
   existe (résolu **par thème**). Alimenté par l'option `LOGO=/chemin ./create-asso.sh <nom>`
   (un dossier `white.png`/`black.png`, ou un seul fichier) : utile pour un logo qu'on ne veut
   **pas committer** (ex. logo d'un partenaire), ou pour surcharger le défaut sans toucher au repo.
   `LOGO=` fait autorité : chaque thème fourni **écrase** le magasin (on peut donc y ajouter un
   thème après coup), un thème absent n'est pas touché, et le thème manquant n'est pas fabriqué
   ici (la pose duplique si un seul thème existe).
2. **Défaut versionné** `assets/logos/<nom>-*.png` (ici) : le cas simple ci-dessus, en git.
3. legacy : un logo déjà présent dans `html/img/` de l'instance (rétrocompat).
4. sinon : repli texte (initiale de la graphie de l'asso).

## Asso principale

`MAIN_ASSO` (défaut `eirspace`) désigne l'asso principale ; sa graphie = `MAIN_BRAND_NAME`
(défaut = `MAIN_ASSO` en MAJUSCULES). Son logo se résout comme les autres via
`assets/logos/<MAIN_ASSO>-*.png`. Pour renommer la principale : `MAIN_ASSO=xxx` +
`assets/logos/xxx-*.png`.
