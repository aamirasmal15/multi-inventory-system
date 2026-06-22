# scanette-src/ — fichiers source de l'app Scanette

Dépose **ici** les fichiers de l'application web Scanette. Ils sont copiés tels
quels dans l'image nginx de **chaque** asso au moment du déploiement
(`create-asso.sh <nom>` → `~/<nom>/scanette/html/`).

## Fichiers attendus

| Fichier | Obligatoire | Rôle |
|---|---|---|
| `index.html` | ✅ oui | L'app complète (single-file : ZXing, zxing-wasm, qrcode-generator inclus) |
| `zxing_reader.wasm` | ✅ oui | Décodeur de codes-barres WebAssembly |
| `logo-black.png` | optionnel | Logo (thème clair) |
| `logo-white.png` | optionnel | Logo (thème sombre) |
| *(tout autre asset)* | optionnel | Favicon, images… copiés automatiquement |

> Tout fichier déposé ici (sauf les `*.md` et `.gitkeep`) est embarqué dans l'app.
> Les logos sont facultatifs : sans eux l'app fonctionne, seul le logo s'affiche en « cassé ».

## Préfixe API

L'app appelle l'API InvenTree via le préfixe **`/scan`** (constante en haut du
script dans `index.html`). C'est ce qui permet au **même `index.html`** de servir
toutes les assos sans modification (proxy same-origin → pas de CORS).

## Mettre à jour l'app

1. Remplace `index.html` (et/ou les autres fichiers) dans ce dossier.
2. Relance le déploiement de l'asso : `./create-asso.sh <nom>` (rebuild + reload).
3. Sur le téléphone : `https://<domaine-instance>/scan/?v=N` (incrémente `N` à
   chaque mise à jour, sinon le navigateur garde l'ancienne version en cache).

> Astuce : avant de pousser un nouvel `index.html`, vérifie sa syntaxe en extrayant
> le dernier `<script>` applicatif et en lançant `node --check`.
