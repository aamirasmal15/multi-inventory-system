# inventree-helloasso

Plugin InvenTree : achat, depuis la Scannette, des articles **vendables**,
payés via [HelloAsso Checkout](https://dev.helloasso.com/docs/int%C3%A9grer-le-paiement-sur-votre-site).

## Rendre un article achetable

Dans InvenTree, sur le part : cocher **Vendable**, puis *Tarification > Prix de
vente* : un palier de quantité 1, en EUR. Une variante sans prix propre hérite
de celui de son modèle. Les articles trackables (prêts) ne sont jamais vendus.

## Réglages du plugin

Environnement (sandbox / production), slug de l'association, Client ID et
Client Secret (back-office HelloAsso > Intégrations et API).

URL de notification à déclarer chez HelloAsso :
`https://<inventaire>/plugin/helloasso/webhook`

## Parcours

1. La Scannette appelle `POST /plugin/helloasso/checkout` : le prix est
   recalculé côté serveur, un achat *en attente* est créé, puis le
   checkout-intent HelloAsso.
2. L'utilisateur paie sur la page HelloAsso, puis revient sur
   `/scannette/?achat=<pk>`.
3. `GET /plugin/helloasso/purchase/<pk>` (et le webhook) relisent le checkout
   auprès de l'API : la commande n'y figure qu'une fois le paiement autorisé.
   Le stock est alors retiré, une seule fois.

Les achats sont consultables dans l'admin Django (*Achats HelloAsso*).
