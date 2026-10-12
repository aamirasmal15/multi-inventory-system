# inventree-paiements : le frigo

Plugin InvenTree : page **/frigo** de la Scannette. On choisit ses boissons
dans le frigo et on paie avec son **portefeuille** (solde rechargé à
l'avance) ou directement par carte, via **SumUp** (carte, Apple Pay, Google
Pay, sans quitter la page). Reçu PDF (format ticket) à télécharger ou par e-mail.

## Mettre un article en vente

1. Ranger l'article dans l'emplacement **Frigo** (réglage `FRIDGE_LOCATION`),
   depuis la Scannette (« Déplacer ») ou InvenTree. Il est coché « Vendable »
   automatiquement.
2. Lui donner un prix : Scannette, page frigo, onglet **Gérer** (admins). Une
   variante sans prix propre hérite de celui de son modèle.

Sans prix, un article du frigo reste invisible des membres. Les articles
trackables (prêts) ne sont jamais vendus.

## Portefeuille

SumUp refuse tout paiement par carte sous 1 €, or une canette coûte moins.
Chaque membre a donc un portefeuille :

- **recharge** par carte, 1 € minimum, sans plafond (2, 5, 10, 20 € proposés), créditée une
  fois le paiement confirmé par SumUp ;
- **achat** : le panier est déduit du solde, à n'importe quel prix, sans
  carte ; débit et retrait du stock dans la même transaction ;
- le solde **ne passe jamais sous zéro** : ligne verrouillée et solde vérifié
  avant chaque débit (deux achats simultanés ne passent pas sur un seul solde).

Le bouton de paiement du frigo choisit tout seul : portefeuille s'il suffit,
sinon carte si le panier atteint 1 €, sinon recharge.
Sans paiement par carte configuré, le portefeuille marche quand même (recharge
en espèces auprès du trésorier).

Chaque mouvement est journalisé (`WalletEntry` : recharge, achat, correction).

## Trésorerie (admins)

Bouton **Trésorerie** en tête du mode Gérer du frigo :

- **Portefeuilles** : total dû aux membres, solde de chacun ; corriger un
  solde (crédit d'espèces reçues, remboursement), note obligatoire, auteur
  journalisé, jamais sous zéro ;
- **Achats** : achats et recharges de tous, par période et par membre,
  totaux encaissé par carte / vendu au portefeuille ;
- **Export CSV** de la sélection, corrections comprises (Excel FR : `;`,
  virgule décimale).

## Tap to Pay (admins)

Un admin encaisse la recharge d'un membre sur son téléphone :
feuille du portefeuille (ou fiche du membre dans la Trésorerie) → **Encaisser
une recharge** → membre + montant → l'appli SumUp s'ouvre avec le montant
(lien `sumupmerchant://`, « Payment Switch » de SumUp) → le membre pose sa
carte ou son téléphone → retour sur `/scannette/?achat=<pk>`.

Le retour de l'appli n'est pas cru sur parole : la transaction est retrouvée
chez SumUp par notre référence (`foreign_transaction_id`), statut, montant et
devise vérifiés, puis le portefeuille est crédité (journal : « encaissée par »).

Prérequis : appli SumUp sur le téléphone, connectée au compte de l'asso, Tap to
Pay activé ; clé affiliate SumUp dans les réglages. Seuls les admins peuvent
encaisser. SumUp documente ce lien depuis
une page web sur Android ; sur iPhone, à vérifier.

## Réglages du plugin

Le strict nécessaire :

- **Emplacement du frigo**.
- **SumUp** : clé API secrète (`sup_sk_…`) et code marchand. 1 € minimum par
  paiement, 2,5 %.
- **Tap to Pay** (facultatif) : clé affiliate SumUp (et son identifiant
  d'application si SumUp en a demandé un).
- **Google Pay** (facultatif) : identifiant marchand Google.
- **Envoi du reçu par e-mail** automatique (désactivé par défaut : l'acheteur
  peut toujours se l'envoyer).

Rien à remplir pour le reçu : il prend le nom de l'instance InvenTree et le
logo de la Scannette.

Apple Pay (SumUp) : déclarer le domaine `inventaire-<asso>.eirspace.fr` dans le
profil SumUp et publier le fichier fourni sous
`/.well-known/apple-developer-merchantid-domain-association`.

## Parcours d'un paiement par carte

1. QR sur la porte : `/frigo` redirige vers `/scannette/?frigo=1` (Caddy de
   l'instance) ; connexion (EirbConnect), puis la page frigo.
2. `POST /plugin/paiements/checkout` (panier) ou `/wallet/topup` (recharge) :
   prix et disponibilité recalculés côté serveur, achat *en attente*, paiement
   créé chez SumUp au montant exact.
3. Formulaire SumUp dans la Scannette.
4. `GET /plugin/paiements/purchase/<pk>`, le webhook `…/webhook/sumup` et une
   tâche toutes les 10 min relisent le paiement chez SumUp. Confirmé : stock prélevé dans le frigo (plus anciens
   d'abord) ou portefeuille crédité, une seule fois.

## Endpoints (`/plugin/paiements/`)

| Chemin | Usage |
|---|---|
| `config`, `fridge`, `fridge/price` | réglages vus par la Scannette, catalogue, prix (admins) |
| `checkout`, `purchase/<pk>`, `purchases` | paiement par carte, état d'un achat, « Mes achats » (`?all=1` : tous, admins) |
| `purchase/<pk>/receipt.pdf`, `purchase/<pk>/email` | reçu |
| `wallet`, `wallet/topup`, `wallet/pay` | solde et mouvements, recharge, achat au portefeuille |
| `wallet/admin` | admins : soldes de tous (`?user=<pk>` : mouvements), correction (POST) |
| `treso/export.csv` | admins : export (`?from=AAAA-MM-JJ&to=…&user=<pk>`) |
| `tap/members`, `tap/start` | admins : recharge en Tap to Pay (lien `sumupmerchant://`) |
| `webhook/sumup` | notification SumUp (anonyme, jamais crue sur parole) |

Achats et portefeuilles sont aussi consultables, en lecture, dans l'admin
Django (*Achats*, *Portefeuilles*).
