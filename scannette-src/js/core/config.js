/* ==========================================================================
   core/config.js — Configuration par association — LES SEULES LIGNES À ÉDITER lors d'un déploiement.
   ========================================================================== */

const API = ""; // app servie à la RACINE du sous-domaine Scannette ; nginx proxifie /api /accounts /static /media vers InvenTree en same-origin

/* Base de déploiement, détectée à l'exécution : "/" sur l'hôte Scannette dédié,
   "/scannette/" quand l'app est montée sous l'origine InvenTree
   (inventaire[-x].eirspace.fr/scannette/ — le frontal strippe le préfixe).
   Porte les chemins PROPRES à l'app : wasm, retour SSO, replaceState, logout.
   Les appels /api /plugin /media restent sur API ("") : natifs sur les 2 origines. */
const BASE = location.pathname.startsWith("/scannette/") ? "/scannette/" : "/";
/* Origine partagée avec InvenTree : la session Django appartient alors à l'UI
   web InvenTree, la Scannette ne doit pas la couper (voir auth/sso.js). */
const SHARED_ORIGIN = BASE !== "/";
/* ====== Personnalisation par asso : change UNIQUEMENT cette ligne ====== */
const BRAND = "EIRSPACE"; // nom affiché (onglet + en-tête + login). Logos : voir LOGO_WHITE / LOGO_BLACK ci-dessous.

/* Logos de l'asso (en-tête + login). Valeurs par défaut du repo ; create-asso.sh les
   remplace par img/<nom>-white.png / img/<nom>-black.png si ces fichiers existent dans
   html/img/ de l'instance — même convention de nommage que l'interstitiel mobile.
   Une seule variante déposée : elle est injectée dans les DEUX constantes (mêmes logos
   sur les deux thèmes plutôt qu'un repli initiale sur le thème orphelin). */
const LOGO_WHITE = "img/logo-white.png";
const LOGO_BLACK = "img/logo-black.png";

/* Asso principale. create-asso.sh injecte MAIN_BRAND (graphie, défaut EIRSPACE) et le chemin
   du logo principal MAIN_LOGO_WHITE/BLACK (défaut img/eirspace-*.png, pointés sur img/<asso
   principale>-*.png si elle est renommée). Si BRAND diffère de MAIN_BRAND, l'écran de login
   affiche le lockup collab « <principale> × <asso> » : logo de l'asso principale + logo de
   l'asso. Pour l'asso principale : logo seul, sans ×. */
const MAIN_BRAND = "EIRSPACE";
const MAIN_LOGO_WHITE = "img/eirspace-white.png";
const MAIN_LOGO_BLACK = "img/eirspace-black.png";
const COLLAB = BRAND.trim().toUpperCase() !== MAIN_BRAND;
