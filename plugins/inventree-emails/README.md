# inventree-emails : habillage des e-mails

Plugin InvenTree **de templates uniquement** : il restyle tous les e-mails
envoyés par InvenTree aux couleurs de la Scannette / EirSpace, sans toucher au
code d'InvenTree ni à celui d'allauth.

Il reprend la direction artistique du plugin **Prêts**
(`inventree-prets`, template `prets/email/notification.html`) : page grise,
carte blanche à liseré d'accent, pastille d'état, sous-tableau de détails, pied
« Une solution EirSpace conçue par Aamir ASMAL 🚀 ». HTML d'e-mail = tables +
styles inline uniquement, **aucune image distante** (bloquée par les clients
mail derrière « afficher les images externes »).

## Ce que le plugin habille

**Objectif : aucun e-mail InvenTree laissé de côté.** Tout ce qui peut partir
d'une instance est repris, HTML et repli texte.

**Base & notifications de stock** (`templates/email/`) :

| Template | E-mail |
| --- | --- |
| `email.html` | **Base de tous les e-mails HTML** : la restyler restyle tous ses enfants d'un coup |
| `low_stock_notification.html` | **Stock bas** (accent ambre) |
| `stale_stock_notification.html` | **Péremption proche** (ambre, dépassé en rouge) |
| `part_event_notification.html` | Événement sur une pièce / catégorie suivie |
| `test_email.html` | E-mail de **test SMTP** (n'héritait même pas de la base à l'origine) |

**E-mails de commande** (`templates/email/`, via `_order_base.html`) : pastille,
sous-tableau et bouton ; les retards en rouge :
`purchase_order_received`, `return_order_received`, `new_order_assigned`,
`canceled_order_assigned`, `build_order_completed`, `build_order_required_stock`,
`overdue_purchase_order`, `overdue_sales_order`, `overdue_return_order`,
`overdue_build_order`.

**E-mails de compte** (allauth, `templates/account/email/`) : HTML + texte,
`_account_base.html` (salutation) et `_code_base.html` (pastille de code) en socle :
mot de passe oublié (`password_reset_key`), confirmation d'adresse
(`email_confirmation` + `_signup`, lien **ou** code), compte inconnu
(`unknown_account`), compte existant (`account_already_exists`), connexion par
code (`login_code`), réinitialisation par code (`password_reset_code`).

**Avis de sécurité** (allauth, via `base_notification.html/.txt`) : mot de passe
modifié / défini / réinitialisé, adresse changée / confirmée / retirée
(`password_changed`, `password_set`, `password_reset`, `email_changed`,
`email_confirm`, `email_deleted`).

**Double authentification** (`templates/mfa/email/`) : activation / désactivation
d'appli d'authentification, ajout / retrait de clé de sécurité, génération de
codes de secours.

**Lien de connexion par e-mail** (`templates/InvenTree/user_simple_login.txt`
+ `.html`) : seul e-mail qui demande du **code** en plus des templates :
InvenTree l'envoie nativement en texte seul, sans jamais rendre de HTML.
`apps.py` (AppMixin) remplace la fonction d'envoi (`send_simple_login_email`)
par une version qui joint la carte HTML ; si InvenTree change, le repli est
l'envoi natif texte, rien ne casse.

Le socle `account/email/base_message.txt` est aussi surchargé (version propre,
sans « Bonjour, c'est X ! ») : tout template allauth qui l'étend, présent ou
futur, hérite du bon habillage.

## Comment ça marche

InvenTree charge les templates via une chaîne dont le **`PluginTemplateLoader`
passe en premier** (`plugin.template.PluginTemplateLoader`, avant les templates
natifs et ceux d'allauth). Ce chargeur scanne le dossier `templates/` de
**chaque plugin actif**. Il suffit donc de fournir un fichier **au même chemin**
que le template d'origine pour le remplacer :

- `email/email.html` remplace la base native d'InvenTree ;
- `account/email/*_message.html` s'ajoute à côté des `.txt` d'allauth, qui
  déclenche l'envoi multipart (`allauth.account.adapter.render_mail`).

Le plugin **n'apporte aucun modèle, url ni tâche** : pas de migration, pas de
statique, pas de réglage. Une seule exception à la logique « templates seuls » :
le patch du lien de connexion (voir ci-dessus), porté par `AppMixin`
(`ENABLE_PLUGINS_APP` requis, déjà posé par `create-asso.sh`).

## Ce qu'il ne change PAS

- **Le message.** Chaque e-mail dit exactement ce que disait l'original : même
  information, même intention, rien d'ajouté ni de retiré. Seuls l'habillage et
  la formulation française changent (voir « Langue »).
- **Le repli texte existe toujours.** L'e-mail reste multipart : un client qui
  n'affiche pas l'HTML lit toujours le message. Ses `.txt` sont en revanche
  surchargés eux aussi (voir plus bas), pour dire exactement la même chose que
  l'HTML.
- **Les e-mails du plugin Prêts**, qui gardent leur propre template
  (`prets/email/notification.html`) : les deux plugins cohabitent sans conflit.

## Ton : on vouvoie (choix délibéré)

Ces e-mails **vouvoient** : « vous », jamais « tu ».

C'est un choix explicite, et il **diverge du reste de la plateforme** : la
Scannette et les e-mails du plugin Prêts tutoient (« Tu peux venir
emprunter… », « Ta réservation a été annulée »). Ne pas « corriger » ce
vouvoiement en croyant à un oubli.

Le HTML **et** le repli texte sont désormais tous les deux à nous, donc le ton
est libre : pour tout tutoyer un jour, il suffit de reprendre les `.html` et
les `.txt` de `templates/account/email/` ensemble (rien d'autre ne contraint).

## Langue

Les textes de la partie HTML sont écrits en **français littéral**, pas en
`{% trans %}`.

La première version réutilisait les chaînes traduites d'allauth et d'InvenTree
(gratuit et multilingue). En pratique le résultat était mauvais :

- des phrases **sans traduction FR** dans le catalogue InvenTree (celles de
  l'e-mail de péremption, vérifié sur 1.4.1) retombaient en **anglais au milieu
  d'un e-mail français** ;
- InvenTree traduit *part* par « **partie** » dans ces phrases et « **pièce** »
  ailleurs : les deux se retrouvaient dans le même e-mail, de même que
  « Catégorie de **composant** » à côté de « **Pièce** » ;
- la traduction FR d'allauth pour la confirmation d'adresse parle de « code de
  **connexion** » alors qu'il s'agit de vérifier une **adresse** (contresens) ;
- allauth écrit « cliquez sur le **lien** ci-dessous » alors que l'habillage
  affiche un **bouton**.

Écrire les phrases nous-mêmes donne un texte cohérent et fidèle au message
d'origine. Le prix : ces e-mails sont francophones (les instances visées le
sont toutes, et l'habillage (pastilles, boutons, pied EirSpace) l'était déjà,
comme le pied français du plugin Prêts). Pour du multilingue, il faudrait
ajouter un catalogue `locale/` au plugin et y traduire ces phrases.

## Salutation : « Bonjour, » sur les e-mails de compte

Les e-mails de **compte** (allauth : mot de passe, confirmation, changements)
ouvrent sur **« Bonjour, »**. Les e-mails de **notification** (stock bas,
péremption, événement pièce) n'en ont pas.

C'est le comportement d'origine d'InvenTree : les e-mails allauth ouvraient sur
« Hello from {instance}! » (rendu « Bonjour, c'est EIRSPACE ! » en FR, voir
plus bas), les notifications non. On garde la distinction, en remplaçant juste
la salutation par un simple « Bonjour, ».

Mise en œuvre : la salutation vit dans `account/email/_account_base.html`
(base commune des e-mails de compte), **pas** dans `email/email.html`, donc
les notifications, qui héritent directement de cette dernière, n'en ont pas.
Sans prénom : les notifications sont de toute façon rendues une seule fois pour
tous les destinataires (`core_notifications.py`), et on garde la même
salutation côté compte pour l'uniformité.

### Le repli texte aussi

Les `.txt` d'allauth sont surchargés au même titre que les `.html`, et disent
la même chose (seule différence : le lien y est en clair, faute de bouton).

Sans ça, le repli affichait l'habillage FR d'allauth, traduction littérale de
« Hello from X! » / « Thank you for using X! » :

```
Bonjour, c'est EIRSPACE !
...
Merci d'utiliser EIRSPACE !
```

Aucun autre e-mail de la plateforme ne dit bonjour, ni ceux du plugin Prêts,
ni les versions HTML d'ici. Le repli était le seul endroit, et il jurait.

## Nom affiché en en-tête

Le bandeau reprend le réglage d'instance **`INVENTREE_INSTANCE`**, que
`create-asso.sh` positionne au nom de l'asso (« EIRSPACE », « BDE »…) tant
qu'il vaut encore le défaut. Si une instance affiche « InvenTree » dans ses
e-mails, c'est que ce réglage est resté au défaut (Réglages > Serveur, ou un
nouveau run de `create-asso.sh`).

## Expéditeur affiché (From)

À distinguer du bandeau : c'est le **nom de l'expéditeur** dans la boîte du
destinataire (« De : … »). Il n'est **pas géré par ce plugin** : il vient du
**SMTP** et s'applique donc à *tous* les e-mails (y compris ceux du plugin
Prêts). `create-asso.sh` compose le `From` au format `Nom <adresse>` à partir de
`~/.config/multi-inventory/smtp.env` :

- **`SMTP_SENDER`** : l'**adresse** (ex. `contact@eirspace.fr`), gardée **nue**
  car elle sert aussi d'`INVENTREE_ADMIN_EMAIL` ;
- **`SMTP_FROM_NAME`** : le **nom affiché** (défaut `Inventaire`) → le
  destinataire voit `Inventaire <contact@eirspace.fr>` au lieu de « contact ».

Django passe cet expéditeur tel quel à `DEFAULT_FROM_EMAIL`. Changer le nom
partout : `./create-asso.sh --reconfigure`. Un `SMTP_FROM_NAME` vide retombe sur
l'adresse nue.

## Installation

Automatique via `create-asso.sh` (bloc « Plugin E-mails ») : installé dans le
même venv persistant que le plugin Prêts, puis activé par l'API. Passer
`SKIP_EMAILS_PLUGIN=1` pour sauter.

Manuellement, dans le venv d'une instance :

```sh
pip install /chemin/vers/plugins/inventree-emails
# redémarrer le serveur, puis Réglages > Plugins > activer « E-mails »
```

Un serveur SMTP doit être configuré côté InvenTree pour que les e-mails partent.

## Personnalisation

Les couleurs d'accent sont surchargeables par e-mail via des blocs dédiés dans
`email/email.html` : `card_accent` (liseré gauche), `pill_fg` / `pill_bg`
(pastille), `pill` (libellé), `section` (surtitre). Palette reprise de la
Scannette : ambre `#f08c00` (avertissement), rouge `#e03131` (urgent/retard),
bleu `#228be6` (information), violet `#7048e8` (réservation).
