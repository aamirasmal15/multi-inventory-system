# inventree-paiements : le frigo

Plugin InvenTree : page **/frigo** de la Scannette. On choisit ses boissons
dans le frigo, on paie avec **SumUp** (carte, Apple Pay, Google Pay) sans
quitter la page, et on reçoit un reçu PDF par e-mail.

## Mettre un article en vente

1. Ranger l'article dans l'emplacement **Frigo** (réglage `FRIDGE_LOCATION`),
   depuis la Scannette (« Déplacer ») ou InvenTree. Il est coché « Vendable »
   automatiquement.
2. Lui donner un prix : Scannette, page frigo, onglet **Gérer** (admins). Une
   variante sans prix propre hérite de celui de son modèle.

Sans prix, un article du frigo reste invisible des membres. Les articles
trackables (prêts) ne sont jamais vendus.

## Réglages du plugin

- **Emplacement du frigo**.
- **SumUp** : clé API secrète (`sup_sk_…`) et code marchand. La clé d'un
  compte marchand *sandbox* (paramètres développeur SumUp) donne des paiements
  de test.
- **Google Pay** (facultatif) : identifiant marchand Google ; **nom affiché**.
- **Reçu par e-mail** automatique (désactivé par défaut : l'acheteur peut
  toujours se l'envoyer depuis son reçu).

Apple Pay : déclarer le domaine `inventaire-<asso>.eirspace.fr` dans le profil
SumUp et publier le fichier fourni sous
`/.well-known/apple-developer-merchantid-domain-association`.

## Parcours

1. QR sur la porte : `/frigo` redirige vers `/scannette/?frigo=1` (Caddy de
   l'instance) ; connexion (EirbConnect), puis la page frigo.
2. Panier, puis `POST /plugin/paiements/checkout` : prix et disponibilité
   recalculés côté serveur, achat *en attente*, checkout SumUp dont la
   description est le panier exact (« Frigo · 2 × Coca, Jus d'orange »).
3. Formulaire SumUp dans la Scannette ; à la fin, `GET /plugin/paiements/purchase/<pk>`
   (et le webhook `…/webhook/sumup`) relisent le checkout chez SumUp. Statut
   PAID : stock prélevé dans le frigo (plus anciens d'abord), une seule fois,
   puis reçu envoyé par e-mail (tâche de fond).

Les achats sont consultables dans l'admin Django (*Achats*) et dans « Mes
achats » de la Scannette.
