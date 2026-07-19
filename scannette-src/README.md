# Scannette : source

Application web mobile de scan d'inventaire (SPA statique, sans build).
Une instance est déployée par association ; elle parle à l'InvenTree de
l'asso via nginx qui proxifie `/api`, `/accounts`, `/plugin`, `/static`,
`/media` en same-origin.

## Arborescence

```
scannette-src/
├── index.html            page unique : les 9 écrans (sections) + chargement des scripts
├── zxing_reader.wasm     décodeur WASM (reste à la racine, voir « Personnaliser » point 4)
├── css/
│   └── styles.css        tout le style (thème clair/sombre via [data-theme])
└── js/
    ├── vendor/           librairies tierces telles quelles (minifiées, ne pas éditer)
    │   ├── zxing.js          @zxing/library (UMD)  -> global ZXing   (fallback décodage JS)
    │   ├── zxing-wasm.js     zxing-wasm 2.1.0      -> global ZXingWASM (décodage WASM, iPhone)
    │   └── qrcode.js         qrcode-generator      -> global qrcode  (génération de QR)
    ├── core/
    │   ├── config.js     API, BRAND, MAIN_BRAND/COLLAB ; BRAND est injecté par create-asso.sh (ne pas éditer le fichier déployé)
    │   ├── icons.js      icônes SVG partagées (SUN, MOON, CHECK)
    │   ├── helpers.js    cookies, thème, $, gestion d'écrans, toasts, formats
    │   ├── i18n.js       langue fr/en : dictionnaires, t(), data-i18n (voir « Langue »)
    │   └── api.js        client API InvenTree (fetch + token + erreurs)
    ├── auth/
    │   ├── login.js      login local + bouton EirbConnect (POST provider/redirect)
    │   └── sso.js        retour SSO : session -> token, droits, écran "en attente", logout
    ├── features/
    │   ├── scanner.js    caméra + décodage (natif / WASM / JS) + résolution des codes
    │   ├── parts.js      articles : recherche, ouverture depuis un code
    │   ├── location.js   scan d'un emplacement : liste + correction rapide des stocks
    │   ├── item.js       fiche article : quantité, ajustement, confirmation
    │   ├── loan.js       prêts / réservations des objets trackables (plugin inventree-prets)
    │   ├── create.js     création d'article inconnu (pickers, image, liaison code)
    │   ├── qr.js         QR généré après création sans code + impression
    │   └── move.js       déplacement de stock
    ├── events.js         branche TOUS les écouteurs (chargé après les features)
    └── boot.js           point d'entrée (chargé en DERNIER)
```

## Comment ça se charge (important)

Scripts **classiques** ordonnés, **pas** de modules ES : tout le code partage
le scope global (les `onclick=` du HTML appellent directement des fonctions,
et l'état (`TOKEN`, `camStream`, `CURRENT`, `PARTS`…) est partagé entre
fichiers). L'ordre des `<script>` dans `index.html` est donc significatif :

```
vendor -> core -> auth/login -> features -> events -> auth/sso -> boot
```

Règles si tu ajoutes un fichier :
- une nouvelle *feature* se place avant `events.js` (qui branche ses boutons) ;
- `boot.js` reste toujours en dernier ;
- pas d'`import`/`export` : déclare tes fonctions, elles sont globales.

## Animations

Parti pris **sobre** : fondu de base sur les écrans, et **rien d'autre** sauf quatre animations voulues. Tout le reste (glissements directionnels d'écrans, `slideIn` des panneaux, fondus de blocs re-rendus, décalé des listes...) a été retiré.

- `show(id, "drop")` (`core/helpers.js`) → *Mon compte* descend du chip topbar (`.screen.anim-drop`) ; sans `dir` (ou tout autre valeur), fondu neutre de base ;
- `segSync(seg)` (`core/helpers.js`) → curseur glissant `.seg::before` des sélecteurs segmentés (Scanner/Rechercher, type d'article, onglets Prêts) ; à rappeler après tout changement d'actif **et** à la (re)création d'un `.seg` ;
- `flipAcctRows()` (`features/account.js`) → les lignes d'adresses e-mail **s'échangent** quand la principale change (FLIP : positions mesurées avant/après re-rendu, clé `data-email`) ;
- `appConfirm()` (`core/helpers.js`) → les fenêtres de confirmation entrent en fondu + léger zoom et sortent via la classe `.closing` (keyframes `ovIn`/`pkSheetIn`/`pkFadeOut`/`pkSheetOut`, partagés avec le picker).

La règle globale `prefers-reduced-motion` (CSS) rend le tout instantané si l'OS le demande. **Ne pas** réintroduire de fondu de base sur un bloc piloté en JS (effet « ça refresh deux fois »).

## Langue (fr / en)

L'interface est bilingue, pilotée par `core/i18n.js` :

- **quelle langue ?** celle du profil InvenTree de l'utilisateur
  (`/api/user/me/` → `profile.language`, synchronisée à l'entrée dans l'app
  et depuis l'écran Mon compte) : `fr` → français, `en` → anglais, **toute
  autre langue → anglais** (repli), « défaut » → langue de l'instance
  (`DEFAULT_LANG`, `"fr"`). Avant connexion : cookie `eir_lang` du dernier
  passage, sinon langue du navigateur ;
- **textes statiques** d'`index.html` : attributs `data-i18n` (textContent),
  `data-i18n-html` (innerHTML, valeurs du dictionnaire uniquement),
  `data-i18n-ph` (placeholder), `data-i18n-title` (title), appliqués par
  `applyI18nDom()` au chargement et à chaque changement de langue. Le HTML
  garde le français en dur comme valeur par défaut ;
- **textes dynamiques** : `t("clé", args…)` dans les JS. Les clés `*_html`
  attendent des arguments déjà passés par `esc()` (le résultat part en
  innerHTML). Les dates des prêts suivent aussi la langue (`fr-FR`/`en-GB`) ;
- **pages autonomes** (`404.html`, `verify-email.html`) : mêmes règles, en
  mini (cookie `eir_lang` sinon navigateur), dictionnaires inline ;
- **ajouter un texte** = ajouter la clé dans `I18N.fr` **et** `I18N.en`
  (mêmes clés dans les deux, sinon la clé brute s'affiche) ; vouvoiement
  côté français, partout.

## Personnaliser pour une asso

1. **Rien à éditer dans le code** : `BRAND` est injecté automatiquement par
   `create-asso.sh` dans le `config.js` **déployé** (nom de l'asso en MAJUSCULES,
   graphie surchargeable : `BRAND_NAME="BDE Eirb" ./create-asso.sh bde`). Toute
   édition manuelle du `config.js` déployé serait écrasée au re-run. `API` reste
   `""` (l'app est servie à la racine de son sous-domaine).
2. **Lockup collab** : si `BRAND != MAIN_BRAND`, l'écran de login affiche
   « <PRINCIPALE> × \<asso\> » (les deux logos + ×) ; l'écran « compte en attente
   d'approbation » n'affiche, lui, que le logo de l'asso. L'asso principale garde
   son logo seul, sans ×. `MAIN_BRAND` et le logo principal (`MAIN_LOGO_*`) sont
   injectés par `create-asso.sh` (rien n'est codé « eirspace » en dur).
3. **Logos de l'asso** : gérés hors de ce dossier, voir
   [`/assets/logos/`](../assets/logos/README.md). Le cas simple : déposer
   `assets/logos/<nom>-white.png` / `<nom>-black.png` (sans path). `create-asso.sh`
   les résout par nom et injecte `LOGO_WHITE`/`LOGO_BLACK` dans le `config.js`
   déployé. Une seule variante → elle sert pour les deux thèmes ; aucun logo →
   repli texte (initiale de `BRAND`).
4. `zxing_reader.wasm` doit rester à la **racine** du site : l'app force son
   URL via `locateFile` (voir `initDetector` dans `features/scanner.js`).

## Création d'article : règles de robustesse

Le formulaire « Créer l'article » ne lance **aucun appel réseau tant que tout
n'est pas valide** : nom, quantité (> 0, entière pour un objet à emprunter) et
**emplacement obligatoire** (plus de stock « sans emplacement » par oubli).
La création classique passe par **un seul appel atomique**
(`POST /api/part/` avec `initial_stock`) : une coupure réseau ne peut pas
laisser un article sans stock. Pour un **objet à emprunter** (sélecteur « Type
d'article », visible si le plugin prêts est actif) le part est créé
`trackable` puis ses exemplaires sont sérialisés avec les **n° de série
saisis** dans le formulaire (un par exemplaire, plage « 1-3 » ou liste,
compte vérifié avant envoi) ; si
ce 2ᵉ appel échoue, le part tout juste créé est **annulé** (désactivé puis
supprimé) pour ne rien laisser à moitié créé. « Ajouter du stock » à un
article à emprunter existant crée des exemplaires numérotés à la suite
(`GET /api/part/<pk>/serial-numbers/` → prochain n° libre), jamais un lot en
vrac. Enfin, `api()` a un **timeout de 25 s** et des messages réseau clairs :
en cas de coupure pendant un envoi, le message invite à vérifier l'état avant
de réessayer (le serveur a pu recevoir la requête).

Deux détails d'ergonomie du formulaire :

- **article déjà existant** : quand un article du même nom existe déjà, le
  message le signale, mais le bouton **« Lier le code à … »** n'apparaît que
  si un code a réellement été **scanné**. En création « sans code » (bouton
  central, aucun code-barres à rattacher), on affiche seulement le constat,
  sans bouton ;
- **erreur toujours visible** : le bandeau d'erreur vit en tête de formulaire.
  Quand on valide depuis un bouton situé plus bas (création, emprunt,
  réservation…), `ensureVisible()` (dans `core/helpers.js`) fait défiler la
  page pour l'amener sous la topbar collante, mais **seulement s'il est
  réellement hors champ**, pas de saut intempestif sinon.

## Prêts et réservations (objets trackables)

Si l'InvenTree de l'asso a le plugin [inventree-prets](../plugins/inventree-prets/)
(installé automatiquement par `create-asso.sh`) actif, la fiche d'un article
dont le part est **trackable** ne
compte plus une quantité : c'est un objet unique (n° de série), la Scannette
affiche un **bloc de prêt** à la place (`features/loan.js`). Trois modes,
décidés à l'entrée dans l'app via `GET /plugin/prets/config` :

- **plugin absent** (404 sur `/config`) → fiche quantité classique, comme avant ;
- **`ENABLE_RESERVATIONS` décoché** dans les réglages du plugin → fiche emprunt
  simple : statut (Disponible / Emprunté / En retard), Emprunter, Enregistrer le
  retour, Déplacer, Historique repliable ;
- **`ENABLE_RESERVATIONS` coché** → fiche complète à onglets **Suivi**
  (statut + prochaine réservation + actions Emprunter / Réserver / Déplacer ;
  quand le créneau en cours est réservé POUR l'utilisateur, les actions
  deviennent Confirmer l'emprunt + **Annuler la réservation**, bouton à
  contour rouge), **Planning** (frise hachurée + détail des créneaux +
  réserver / annuler), **Historique** (timeline des emprunts, hachurée ambre).
  Annuler la réservation de quelqu'un d'autre le prévient par email : la
  modale de confirmation propose alors un **motif facultatif**, transmis dans
  cet email par le plugin.

Détails d'implémentation :

- code couleur : le vert/rouge existants + `--amber` (emprunté dans les
  temps) et `--violet` (réservé), déclinés clair/sombre dans `styles.css` ;
  les créneaux réservés/empruntés (frise du planning, liserés de la timeline)
  sont **hachurés** dans ces couleurs ; InvenTree utilise les mêmes codes
  (badge « Emprunté » orange, réservations en violet) ;
- **tout est en self-service** : champs Emprunteur / Réservé pour grisés, au
  nom réel de l'utilisateur connecté (`GET /api/user/me/`, repli sur `BRAND`
  pour un compte sans prénom) ; la date de retour est préremplie avec
  `loan_duration_days` du plugin ;
- **une réservation est un verrou** : pendant son créneau, la fiche affiche
  « Réservé » (violet) et seul le bénéficiaire (ou un admin) peut emprunter ;
  il **confirme** ainsi sa réservation, page d'emprunt préremplie à la fin de
  son créneau (bandeau explicite, date modifiable). Emprunter avec un retour
  qui mord sur le créneau d'autrui est refusé par le serveur (409) et le
  sélecteur de date est borné en conséquence ;
- **permissions** : le retour n'est proposé qu'à la personne qui a enregistré
  l'emprunt, l'annulation d'une réservation qu'à sa créatrice, et aux admins.
  Le serveur renvoie `can_return` / `can_cancel`, l'app masque les boutons
  (et le plugin refuse en 403 de toute façon) ;
- l'historique est **strictement celui des emprunts** (pris / rendu, 10
  derniers + « Voir plus »), via `/plugin/prets/loans` ; un retour après
  l'échéance s'affiche **« Rendu en retard » en rouge**, avec la date de
  retour initialement prévue en rappel ;
- nginx doit proxifier **`/plugin/`** vers InvenTree (présent dans
  `templates/scannette.tpl` ; re-générer le `default.conf` des instances
  déployées avant d'utiliser la fonctionnalité).

## Débogage rapide

- Un écran ne réagit pas -> vérifier `events.js` (tous les bindings y sont).
- Problème de connexion -> `auth/login.js` (aller) puis `auth/sso.js` (retour
  `?sso=1`, échange session -> token, `checkAuthorized`).
- Caméra/scan -> `features/scanner.js` : cascade `BarcodeDetector` natif,
  puis `ZXingWASM`, puis `ZXing` JS. Chaque étage est optionnel.
- Appels API -> `core/api.js` (une seule fonction `api()`, tout passe par là).

## Déploiement

Copié tel quel dans l'image nginx de chaque asso par `create-asso.sh`
(copie **récursive** requise : le dossier contient des sous-répertoires).
Aucune étape de build : ce dossier EST le site.
