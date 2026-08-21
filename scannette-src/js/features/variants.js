/* ==========================================================================
   features/variants.js — Modèles et variantes : famille d'un article modèle,
   stock cumulé, choix de la variante réellement en main.

   InvenTree permet de déclarer un article « modèle » (is_template) et de lui
   rattacher des variantes (variant_of) : même produit, marques ou formats
   différents (jus d'orange Metro / Aro / Rioba…). Le stock vit sur les
   VARIANTES, pas sur le modèle : ouvrir un modèle n'a donc aucun lot à
   afficher. Au lieu de proposer d'y ajouter du stock — ce qui poserait un lot
   sur un article que personne n'a jamais en main — on montre la FAMILLE :
   total cumulé en tête, une carte par variante avec son stock, comme le fait
   l'onglet « Variants » d'InvenTree.
   ========================================================================== */

/* Modèle d'où l'on vient (pk) : la flèche retour d'une fiche, d'une liste de
   lots ou d'une sous-famille ouverte depuis la famille y ramène, au lieu de
   repartir du scanner. Toujours « le cran juste au-dessus ». Remis à null par
   tout nouveau flux (scan, recherche, lien profond). */
let VARIANT_PARENT = null;
let VAR_SEQ = 0; // invalide un rendu dont les données arrivent après un changement d'écran

/* Fiches d'articles déjà chargées (pk -> part). Sert les libellés (nom du
   modèle dans la pastille « Variante de … ») sans re-solliciter l'API à
   chaque aller-retour. Les QUANTITÉS d'un cache peuvent être périmées : tout
   ce qui affiche du stock passe par un appel frais (force / liste variantes). */
const PART_CACHE = {};
function cachePart(p) {
  if (p && p.pk != null) PART_CACHE[p.pk] = p;
  return p;
}
async function getPart(pk, force) {
  if (!force && PART_CACHE[pk]) return PART_CACHE[pk];
  // null en cas d'échec : tous les appelants sont décoratifs et savent faire sans
  return api("/api/part/" + pk + "/")
    .then(cachePart)
    .catch(() => null);
}

/* Ouvre la famille d'un modèle connu par son seul pk (pastille « Variante de
   … » d'une fiche, reprise après rafraîchissement). Stock TOUJOURS refetché. */
async function openVariantsByPk(pk, from) {
  const p = await getPart(pk, true);
  if (!p || !p.pk) {
    gotoScan();
    showErr($("#scanErr"), t("item_not_found"));
    return;
  }
  return openVariants(p, null, from);
}

/* Écran famille.
   part     : la fiche du modèle (annotée total_in_stock / in_stock par l'API)
   ownItems : ses éventuels lots à lui, déjà chargés par loadFromPart. Un
              modèle ne DEVRAIT pas en porter, mais rien ne l'interdit côté
              InvenTree : sans cette carte, ce stock deviendrait invisible et
              inatteignable depuis la Scannette.
   from     : modèle parent à rouvrir avec la flèche retour (sous-famille). */
async function openVariants(part, ownItems, from) {
  const seq = ++VAR_SEQ;
  CHOOSE_PART = null;
  VARIANT_PARENT = from != null ? from : null;
  PENDING_CODE = "";
  stopCamera();
  cachePart(part);
  rememberView("variants", part.pk); // rouvre la famille après un rafraîchissement
  show("#screen-variants");
  paintVariantHead(part, null);
  $("#varSub").textContent = t("variants_sub");
  const wrap = $("#varList");
  wrap.innerHTML = '<div class="skeleton">' + t("loading") + "</div>";
  let vars;
  try {
    const r = await api("/api/part/?variant_of=" + part.pk + "&limit=250");
    vars = r.results || r;
  } catch (e) {
    if (seq !== VAR_SEQ) return;
    wrap.innerHTML = '<div class="skeleton">' + esc(e.message) + "</div>";
    return;
  }
  if (seq !== VAR_SEQ) return; // l'utilisateur est parti ailleurs entre-temps
  /* En stock d'abord (c'est ce qu'on cherche quand on a la caisse devant soi),
     puis par ordre alphabétique — les variantes épuisées descendent en bas. */
  vars.sort(
    (a, b) =>
      Number(b.total_in_stock || 0) - Number(a.total_in_stock || 0) ||
      (a.full_name || a.name || "").localeCompare(b.full_name || b.name || ""),
  );
  paintVariantHead(part, vars.length);
  wrap.innerHTML = "";
  const own = (ownItems || []).reduce((s, x) => s + (Number(x.quantity) || 0), 0);
  if (own > 0) wrap.appendChild(variantCard(part, part, { own: own }));
  vars.forEach((v) => wrap.appendChild(variantCard(v, part)));
  if (!vars.length && own <= 0)
    wrap.innerHTML = '<div class="skeleton">' + t("variants_none") + "</div>";
}

/* En-tête de la famille : même carte que la fiche article (vignette + nom +
   pastilles). n = nombre de variantes, null tant qu'il n'est pas connu. */
function paintVariantHead(part, n) {
  const thumb = part.thumbnail || part.image || "";
  const units = (part.units || "").trim();
  const total = Number(part.total_in_stock || 0);
  const qpill =
    total > 0
      ? '<span class="pill pill-q">' +
        fmt(total) +
        (units ? " " + esc(units) : t("in_stock_suffix")) +
        "</span>"
      : '<span class="pill pill-empty">' + t("out_of_stock_pill") + "</span>";
  $("#varHead").innerHTML =
    (thumb
      ? '<img class="thumb zoomable" src="' +
        esc(mediaUrl(thumb)) +
        '" data-full="' +
        esc(mediaUrl(part.image || "")) +
        '" alt="' +
        esc(part.full_name || part.name || "") +
        '" onerror="thumbErr(this)" onclick="openLightbox(this)">'
      : boxIcon().outerHTML) +
    '<div style="min-width:0;flex:1"><p class="name">' +
    esc(part.full_name || part.name || "") +
    '</p><div class="sub"><span class="pill pill-tpl">' +
    t("tpl_badge") +
    "</span>" +
    qpill +
    (n != null ? '<span class="pill">' + t("tpl_variants_n", n) + "</span>" : "") +
    (part.IPN ? '<span class="pill">' + esc(part.IPN) + "</span>" : "") +
    "</div></div>";
}

/* Une carte de la liste : une variante, ou (opts.own) le stock que le modèle
   porte lui-même. Même carte cliquable que la liste « choisis le lot ». */
function variantCard(v, parent, opts) {
  opts = opts || {};
  const thumb = v.thumbnail || v.image || "";
  const units = (v.units || "").trim();
  const q = opts.own != null ? opts.own : Number(v.total_in_stock || 0);
  const d = document.createElement("div");
  d.className = "card item-head choose-card";
  d.innerHTML =
    (thumb
      ? '<img class="thumb" src="' +
        esc(mediaUrl(thumb)) +
        '" data-full="' +
        esc(mediaUrl(v.image || "")) +
        '" alt="" onerror="thumbErr(this)">'
      : boxIcon().outerHTML) +
    '<div style="min-width:0;flex:1"><p class="name">' +
    esc(opts.own != null ? t("variants_own") : v.full_name || v.name || "") +
    '</p><div class="sub">' +
    (q > 0
      ? '<span class="pill pill-q">' +
        fmt(q) +
        (units ? " " + esc(units) : t("in_stock_suffix")) +
        "</span>"
      : '<span class="pill pill-empty">' + t("out_of_stock_pill") + "</span>") +
    /* variante elle-même modèle : sous-famille, le tap descend d'un cran */
    (opts.own == null && v.is_template
      ? '<span class="pill pill-tpl">' + t("tpl_badge") + "</span>"
      : "") +
    (opts.own == null && v.IPN ? '<span class="pill">' + esc(v.IPN) + "</span>" : "") +
    "</div></div>";
  d.onclick = () =>
    opts.own != null
      ? openPart(v.pk, { from: parent.pk, ownStock: true })
      : openPart(v.pk, { from: parent.pk });
  return d;
}

/* Pastille « Variante de <modèle> » posée sur une fiche article, en différé :
   la fiche s'affiche tout de suite, la pastille arrive quand l'API a répondu.
   Un tap ouvre la famille — c'est le chemin de retour vers « toutes les
   marques équivalentes » depuis un article scanné au hasard d'un rayon. */
async function applyVariantPill(it) {
  const pk = it.part || (it.part_detail || {}).pk;
  if (!pk) return;
  const p = await getPart(pk);
  if (!p || !p.variant_of) return;
  const parent = await getPart(p.variant_of);
  if (!parent || CURRENT !== it) return; // la fiche affichée a changé entre-temps
  const sub = $("#itemHead") && $("#itemHead").querySelector(".sub");
  if (!sub || sub.querySelector(".pill-var")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pill pill-var";
  b.textContent = t("variant_of", parent.full_name || parent.name || "");
  b.onclick = () => openVariantsByPk(parent.pk);
  sub.appendChild(b);
}
