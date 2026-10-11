# inventree-paiements

Plugin InvenTree : achat, depuis la Scannette, des articles **vendables**,
payés via **SumUp** (formulaire de carte intégré, Apple Pay / Google Pay) ou
**HelloAsso Checkout** (redirection vers la page HelloAsso).

## Rendre un article achetable

Dans InvenTree, sur le part : cocher **Vendable**, puis *Tarification > Prix de
vente* : un palier de quantité 1, en EUR. Une variante sans prix propre hérite
de celui de son modèle (le modèle doit alors être coché Vendable lui aussi :
InvenTree n'accepte un prix de vente que sur un part vendable). Les articles
trackables (prêts) ne sont jamais vendus.

## Réglages du plugin

- **Prestataire** : SumUp ou HelloAsso.
- **SumUp** : clé API secrète (`sup_sk_…`) et code marchand. La clé d'un compte
  marchand *sandbox* (paramètres développeur SumUp) donne des paiements de test.
- **HelloAsso** : environnement (sandbox / production), slug de l'association,
  Client ID et Client Secret (back-office > Intégrations et API). En sandbox,
  l'association de test doit être validée par HelloAsso (sinon
  `404 ResourceNotFound: form` à la création du checkout).

Webhooks (facultatifs, le retour sur la Scannette vérifie aussi) :
`https://<inventaire>/plugin/paiements/webhook/sumup` (passé automatiquement à
chaque checkout) et `https://<inventaire>/plugin/paiements/webhook/helloasso`
(à déclarer dans le back-office HelloAsso).

## Parcours

1. La Scannette appelle `POST /plugin/paiements/checkout` : le prix est
   recalculé côté serveur, un achat *en attente* est créé, puis le checkout
   chez le prestataire.
2. SumUp : le formulaire s'affiche dans la Scannette. HelloAsso : redirection
   vers sa page, puis retour sur `/scannette/?achat=<pk>`.
3. `GET /plugin/paiements/purchase/<pk>` (et les webhooks) relisent le checkout
   auprès de l'API du prestataire. Le stock n'est retiré qu'une fois le
   paiement confirmé, une seule fois.

Les achats sont consultables dans l'admin Django (*Achats*).
