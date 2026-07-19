# inventree-prets

Plugin InvenTree de gestion des emprunts d'objets **trackables** : emprunter
un objet, enregistrer son retour, garder l'historique, et prévenir en cas
d'échéance proche ou de retard. Un système de **réservation** par créneaux
(optionnel, flag `ENABLE_RESERVATIONS`) complète les emprunts.
Il forme un tout avec la [Scannette](../../scannette-src/) : les deux
interfaces parlent aux mêmes endpoints et partagent les mêmes règles.

Testé contre InvenTree 1.4.2. Auteur : Aamir ASMAL.

**Bilingue** : toute l'interface (réglages, messages d'erreur, notifications,
panneau, widget) suit la langue de l'utilisateur : français ou anglais.
Sources en anglais, traduction française dans `inventree_prets/locale/fr/`
(gettext côté Django, dictionnaire choisi via `data.locale` côté JS).

## Installation

**Dans ce système (multi-inventory-system) : rien à faire.** `create-asso.sh`
installe et active le plugin automatiquement pour chaque asso (création comme
re-run) : venv persistant sur le volume de données (`INVENTREE_PY_ENV`,
partagé serveur + worker, survit aux `--force-recreate`), pip depuis ce
dossier, activation et intégrations via l'API, migrations au redémarrage
(`INVENTREE_AUTO_UPDATE`). Pour sauter l'étape : `SKIP_PRETS_PLUGIN=1`.

Pour un InvenTree **hors de ce système**, via pip :

```
pip install "git+https://github.com/aamirasmal15/multi-inventory-system.git#subdirectory=plugins/inventree-prets"
```

Ensuite :

1. Activer le plugin dans Réglages > Plugins ("Prêts").
2. Activer "Enable app integration" (le plugin ajoute une table),
   "Enable URL integration" (les endpoints) et "Enable schedule integration"
   (la tâche quotidienne).
3. Lancer la migration : `invoke update` ou `INVENTREE_AUTO_UPDATE=True`.
4. Vérifier que les plugins de notification builtin (UI, Email) sont actifs.

## Réglages

| Réglage | Défaut | Description |
| --- | --- | --- |
| `LOAN_DURATION_DAYS` | 1 | Durée de prêt appliquée si aucune échéance n'est fournie |
| `REMINDER_ENABLED` | oui | Rappel à l'emprunteur avant l'échéance |
| `REMINDER_DAYS_BEFORE` | 1 | Jours avant l'échéance pour le rappel |
| `CHECK_OVERDUE` | oui | Alerte de retard aux administrateurs (comptes staff **et** superusers), **sauf** le tout premier superuser créé (compte bootstrap partagé entre assos). Une seule alerte par prêt |
| `NOTIFY_BORROWER` | oui | Rappel **quotidien par email** à l'emprunteur (membre) tant que l'objet n'est pas rendu |
| `USE_STOCK_STATUS` | oui | Poser un badge de statut « Emprunté » sur l'objet pendant le prêt (voir plus bas) |
| `ENABLE_RESERVATIONS` | non | Système de réservation par créneaux (fiche complète côté Scannette, endpoints `reserve`/`reservations`) |
| `ASK_ON_BEHALF` | non | Champ facultatif « Pour (asso/club) » sur les emprunts et réservations ; l'emprunteur s'affiche avec l'asso entre parenthèses (ex. « Aamir ASMAL (EirSpace) ») |
| `DELETE_OLD_HISTORY` | non | Purge automatique du vieil historique (prêts rendus, réservations passées) ; jamais un prêt en cours ni une réservation encore valable |
| `HISTORY_DELETE_DAYS` | 365 | Nombre de jours au-delà duquel l'historique terminé est supprimé (minimum 30) |

## Endpoints

Montés sous `/plugin/prets/`, authentification par token InvenTree.

- `POST /plugin/prets/lend` : prêter. Corps : `stock_item` (pk, requis),
  `borrower_user` (pk) ou `borrower_name` (texte), `due_on` (AAAA-MM-JJ,
  optionnel), `notes` (optionnel), `on_behalf` (asso/club, optionnel).
  Refus si le part n'est pas trackable (400) ou si l'objet est déjà prêté (409).
- `POST /plugin/prets/return` : retour. Corps : `loan` (pk) ou `stock_item` (pk).
  Réservé à la personne qui a enregistré le prêt et aux admins (staff ou
  superuser), 403 sinon. Les serializers exposent `can_return` (calculé pour
  l'utilisateur de la requête) pour que les clients masquent le bouton.
  Le retour laisse une **trace en base** : `returned_at` et `returned_by`
  (l'emprunteur, le prêteur ou l'admin qui l'a enregistré). `returned_by` est
  **volontairement absent du serializer**, comme `cancelled_by` : lisible dans
  l'admin Django (`/admin/inventree_prets/loan/`), jamais dans la Scannette ni
  le panneau.
- `GET /plugin/prets/active` : prêts en cours.
- `GET /plugin/prets/overdue` : prêts en retard.
- `GET /plugin/prets/item/<pk>` : prêt actif, historique et réservations d'un
  objet, `{active: bool, loan?: {...}, history: [...], reservations: [...]}`
  (`reservations` : créneaux à venir ou en cours, vide si le système est
  désactivé).
- `GET /plugin/prets/config` : réglages publics pour les clients (Scannette) :
  `{reservations_enabled: bool, loan_duration_days: int}`.

Note : `due_on` ne peut pas être antérieure à la date du jour (400 sinon).

### Réservations (si `ENABLE_RESERVATIONS`)

- `POST /plugin/prets/reserve` : réserver un créneau. Corps : `stock_item`
  (pk, requis), `reserved_for_user` (pk) ou `reserved_for_name` (texte),
  `start_date` et `end_date` (AAAA-MM-JJ, requis), `notes` (optionnel).
  Refus si le part n'est pas trackable (400), si les dates sont invalides
  (400) ou si le créneau chevauche une autre réservation active (409).
- `POST /plugin/prets/reservation/cancel` : annuler. Corps : `reservation` (pk),
  `reason` (motif, facultatif). Si l'annulation vient de quelqu'un d'autre que
  le bénéficiaire (créateur ou admin), celui-ci est prévenu (cloche + email,
  dans sa langue), motif inclus s'il est donné.
  Réservé à la personne qui a créé la réservation et aux admins, 403 sinon
  (champ `can_cancel` exposé par le serializer).
  L'annulation laisse une **trace en base** : `cancelled_at`, `cancelled_by`
  et `cancel_reason` (motif, tronqué à 500 caractères). `cancelled_by` et
  `cancel_reason` sont **volontairement absents du serializer** : la trace
  n'est lisible que dans l'admin Django (`/admin/inventree_prets/reservation/`),
  jamais dans la Scannette ni le panneau. Elle existe pour pouvoir être
  exposée un jour sans avoir perdu l'historique d'ici là, mais elle part
  avec la purge `DELETE_OLD_HISTORY` (1 an par défaut) comme le reste.
- `GET /plugin/prets/reservations?stock_item=<pk>` : réservations actives
  (à venir ou en cours). Avec `&all=1` : tout l'historique (annulées,
  honorées, passées), pour l'onglet Historique de la Scannette.

Cycle de vie : une réservation est active tant qu'elle n'est ni annulée, ni
honorée, ni expirée. **Pendant son créneau, l'objet est « Réservé »** : seul
le bénéficiaire peut l'emprunter, ce qui confirme sa réservation (reliée
au prêt via `loan`), et un retour anticipé libère l'objet. Les autres
membres sont refusés (409 « Réservé par X jusqu'au … ») ; les **admins**
(staff/superuser) passent outre. Une réservation non confirmée expire
d'elle-même à la fin de son créneau.

Un emprunt (`lend`) dont la période [aujourd'hui, retour] mord sur une
réservation active **de quelqu'un d'autre** est refusé (409 « Réservé par X du
… au … : le retour doit être avant le … ») : l'objet doit revenir avant le
créneau réservé. Les créneaux du propre emprunteur sont confirmés par le prêt.
Le bénéficiaire peut aussi prendre l'objet **avant** son créneau : son emprunt
vaut confirmation si le retour couvre la réservation. Double envoi de `lend`
par le même emprunteur → 200 avec l'emprunt existant (idempotent).

## Interface web InvenTree

Le plugin ajoute deux éléments à l'interface React (nécessite le réglage global
`ENABLE_PLUGINS_INTERFACE`, et la collecte des fichiers statiques du plugin via
`invoke static`) :

- **Panneau « Prêts »** sur la fiche d'un article de stock : badge d'état
  (Disponible / Emprunté / En retard), carte de prêt en cours (« Emprunté par X,
  retour prévu le… »), formulaire de prêt (la date de retour est préremplie
  et ne peut pas être antérieure à aujourd'hui), et historique des prêts présenté
  comme le tableau de suivi de stock natif : un prêt rendu après son échéance y
  porte une pastille rouge **« Rendu en retard »** (le retour prévu initial reste
  affiché dans les détails), dans le tableau comme dans l'export CSV. Si `ENABLE_RESERVATIONS` est actif,
  une carte **Réservations** s'ajoute : **frise du planning** (aujourd'hui →
  horizon, libre en vert / emprunté en orange hachuré / réservé en violet
  hachuré, comme la Scannette), créneaux à venir (bénéficiaire, dates,
  motif, créateur), annulation (croix visible seulement si `can_cancel` ; la
  modale de confirmation propose un **motif facultatif** quand on annule la
  réservation de quelqu'un d'autre ; il part dans l'email envoyé au
  bénéficiaire) et
  formulaire de réservation (bénéficiaire, du/au, motif). Le bouton de retour
  n'apparaît que si `can_return`. Le style utilise les variables CSS
  de Mantine : le panneau suit le thème clair/sombre d'InvenTree. Le JS appelle
  les endpoints ci-dessus via le client API authentifié fourni par InvenTree.
- **Widgets dashboard** : « Prêts en cours » (retards en premier) et, si les
  réservations sont actives, « Réservations à venir » (en cours d'abord, puis
  par date de début), lignes cliquables vers la fiche de l'objet.
- **Badge « Emprunté »** dans la colonne Statut du tableau de stock (réglage
  `USE_STOCK_STATUS`). InvenTree 1.4 ne permet pas à un plugin de modifier les
  colonnes d'un tableau ; le badge passe donc par un *état de stock personnalisé*
  posé sur `StockItem.status_custom_key` pendant le prêt. Le statut précédent est
  sauvegardé sur le prêt et restauré au retour. À noter : si le plugin est
  désinstallé alors que des objets sont encore prêtés, l'état personnalisé et le
  statut restent sur ces objets (mettre `USE_STOCK_STATUS` à faux pour ne jamais
  toucher au statut).

**Format des dates.** Toutes les dates affichées par le panneau et les widgets
(historique, réservations, planning, exports CSV) suivent le réglage InvenTree
**« Format de date »** (`DATE_DISPLAY_FORMAT`) du compte connecté : changer le
format dans ses réglages d'affichage change aussi les dates du plugin. Au
démarrage, le plugin remplace en plus le défaut de ce réglage (`YYYY-MM-DD` en
dur dans InvenTree) par **`DD-MM-YYYY`** (« 22-02-2022 ») : tout compte qui n'a
jamais choisi de format (notamment les nouveaux comptes SSO) l'affiche donc en
jour-mois-année, dans le plugin comme dans le reste d'InvenTree, et reste libre
d'en changer ensuite (voir `apps.py`).

## Tâche quotidienne et notifications

Une tâche planifiée (`plugin.prets.daily_checks`) tourne chaque jour :

- rappel à l'emprunteur membre quand l'échéance tombe dans la fenêtre
  `[aujourd'hui, aujourd'hui + REMINDER_DAYS_BEFORE]` (une seule fois par prêt) ;
- alerte de retard aux administrateurs (comptes staff et superusers, sauf le
  compte bootstrap), une seule fois par prêt ;
- si `NOTIFY_BORROWER` : rappel **quotidien par email** à l'emprunteur membre
  tant que l'objet reste en retard (email seul, pas de cloche empilée) ;
- si `ENABLE_RESERVATIONS` : signal au bénéficiaire (membre) quand son créneau
  démarre, tant qu'il n'a pas encore emprunté l'objet (une seule fois par
  réservation, jamais après la fin du créneau) ;
- hors tâche quotidienne, en direct depuis l'API : quand une réservation est
  annulée par **quelqu'un d'autre** que son bénéficiaire (créateur ou admin),
  le bénéficiaire membre est prévenu immédiatement, avec le motif si
  l'annuleur en a donné un (s'annuler soi-même ne prévient personne) ;
- si `DELETE_OLD_HISTORY` : purge des prêts rendus et des réservations dont le
  créneau est passé depuis plus de `HISTORY_DELETE_DAYS` jours. Un prêt en cours
  et une réservation encore valable ne sont jamais supprimés, quel que soit
  leur âge.

Chaque notification part sur les deux canaux natifs d'InvenTree :

- la **cloche** (notification dans l'interface), dans tous les cas ;
- un **email**, si un serveur SMTP est configuré (`INVENTREE_EMAIL_*`) : gabarit
  aux couleurs de la Scannette (`templates/prets/email/notification.html`),
  en-tête texte au nom de l'instance (pas de logo : les clients mail bloquent
  les images distantes), carte à liseré d'accent
  (ambre rappel, rouge retard, violet réservation), message, bloc de détails
  (objet, emplacement, échéance ou créneau) et pied « Une solution EirSpace ».
  Pas de bouton d'action pour l'instant. Le destinataire doit avoir une adresse
  email sur son compte, et chacun peut couper ses emails via le réglage
  utilisateur « Allow email notifications ».

Chaque destinataire reçoit cloche et email **dans la langue de son profil
InvenTree** ; sans choix de langue, celle de l'instance (`INVENTREE_LANGUAGE`,
posée à `fr` par `create-asso.sh`).
