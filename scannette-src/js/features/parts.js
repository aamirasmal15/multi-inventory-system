/* ==========================================================================
   features/parts.js — Articles : chargement depuis un code, recherche texte, ouverture d'une fiche.
   ========================================================================== */

/* Part du dernier écran « choisis le lot / l'exemplaire » affiché : la flèche
   retour de la fiche ramène à cette liste (re-fetch) au lieu du scanner.
   Remis à null à chaque nouveau flux (scan, lien profond, part mono-lot). */
let CHOOSE_PART = null;
let CHOOSE_SEQ = 0; // invalide les pastilles d'état arrivées après un changement d'écran
/* La famille d'un modèle (VARIANT_PARENT, écran variantes) vit dans
   features/variants.js. */

/* opts : { from } modèle d'où l'on descend — la flèche retour y remontera ;
   { ownStock } n'ouvre PAS la famille d'un modèle mais les lots qu'il porte
   lui-même (carte « stock du modèle »). */
async function loadFromPart(pk, opts) {
  opts = opts || {};
  CHOOSE_PART = null;
  VARIANT_PARENT = opts.from != null ? opts.from : null;
  const seq = ++CHOOSE_SEQ;
  /* Un modèle ne porte pas le stock : celui-ci vit sur ses variantes. Or
     /api/stock/?part= remonte PAR DÉFAUT les lots des variantes (filtre
     include_variants) — d'où une liste de lots mélangés, sans dire duquel des
     jus d'orange il s'agit. On coupe le rabattage et on traite le modèle à
     part (écran famille, features/variants.js), comme le fait InvenTree. */
  const stockQ =
    "/api/stock/?part=" + pk + "&include_variants=false&part_detail=true&location_detail=true";
  const [part, first] = await Promise.all([
    api("/api/part/" + pk + "/").catch(() => null),
    api(stockQ),
  ]);
  if (part && part.pk) cachePart(part); // la pastille « Variante de … » s'en sert
  let items = first.results || first;
  if (part && part.is_template && !opts.ownStock) {
    // le stock est sur les variantes : on montre la famille, pas une fiche vide
    await openVariants(part, items, opts.from);
    return;
  }
  if (!items || !items.length) {
    await new Promise((r) => setTimeout(r, 450));
    const list = await api(stockQ);
    items = list.results || list;
  }
  if (!items || !items.length) {
    if (part && part.pk) offerAddStock(part);
    else offerCreate(PENDING_CODE, part);
    return;
  }
  const total = items.reduce((s, x) => s + (Number(x.quantity) || 0), 0);
  if (total <= 0) {
    const pd0 = items[0].part_detail || {};
    offerAddStock(
      {
        pk: items[0].part || pd0.pk || pk,
        name: pd0.full_name || pd0.name || "",
        thumbnail: pd0.thumbnail,
        image: pd0.image,
        trackable: !!pd0.trackable,
      },
      { depleted: true },
    );
    return;
  }
  if (items.length === 1) {
    renderItem(items[0]);
    return;
  }
  showChooseList(pk, items, seq);
}

/* Liste « choisis le lot / l'exemplaire ». Partagée par le flux normal et par
   les lots posés sur un modèle lui-même (openPart avec ownStock). */
function showChooseList(pk, items, seq) {
  CHOOSE_PART = pk;
  rememberView("part", pk); // rouvre la liste de sélection après un refresh
  show("#screen-item");
  $("#itemBody").style.display = "none";
  $("#done").classList.remove("show");
  $("#chooseBody").style.display = "block";
  const pd0 = (items[0] && items[0].part_detail) || {};
  const pname = pd0.name || "";
  const sub = $("#chooseBody").querySelector(".subtitle");
  // objets à emprunter : on choisit QUEL exemplaire (n° de série), pas un
  // emplacement — le libellé « plusieurs endroits » n'a de sens qu'en stock
  if (sub)
    sub.textContent = pd0.trackable
      ? t("choose_copy", pname, items.length)
      : t("choose_batch", pname);
  const wrap = $("#chooseList");
  wrap.innerHTML = "";
  items.forEach((it) => {
    const pd = it.part_detail || {},
      ld = it.location_detail || null;
    const thumb = pd.thumbnail || pd.image || "";
    const units = (pd.units || "").trim();
    const path = ld ? ld.pathstring || ld.name || "" : "";
    const last = path ? path.split("/").pop().trim() : t("no_location");
    const tree =
      path && path.includes("/")
        ? '<div class="loc-tree">' +
          path
            .split("/")
            .map(
              (s, i, a) =>
                '<span class="' +
                (i === a.length - 1 ? "crumb-last" : "") +
                '">' +
                esc(s.trim()) +
                "</span>",
            )
            .join('<span class="crumb-sep">›</span>') +
          "</div>"
        : "";
    const nm = pd.full_name || pd.name || t("lot_n", it.pk);
    const empty = (Number(it.quantity) || 0) <= 0;
    // objet sérialisé (part trackable) : le n° de série identifie l'exemplaire
    const qpill = it.serial
      ? '<span class="pill pill-serial">' + esc(it.serial) + "</span>"
      : empty
        ? '<span class="pill pill-empty">' + t("out_of_stock_pill") + "</span>"
        : '<span class="pill pill-q">' +
          fmt(it.quantity) +
          (units ? " " + esc(units) : t("in_stock_suffix")) +
          "</span>";
    const d = document.createElement("div");
    d.className = "card item-head choose-card";
    d.dataset.pk = it.pk;
    d.innerHTML =
      (thumb
        ? '<img class="thumb" src="' +
          esc(mediaUrl(thumb)) +
          '" data-full="' +
          esc(mediaUrl(pd.image || "")) +
          '" alt="" onerror="thumbErr(this)">'
        : boxIcon().outerHTML) +
      '<div style="min-width:0;flex:1"><p class="name">' +
      esc(nm) +
      '</p><div class="sub"><span class="pill">📍 ' +
      esc(last) +
      "</span>" +
      qpill +
      (it.batch ? '<span class="pill">' + t("batch_pill", esc(it.batch)) + "</span>" : "") +
      "</div>" +
      tree +
      "</div>";
    d.onclick = () => renderItem(it);
    wrap.appendChild(d);
  });
  // objets à emprunter : pastille d'état (Disponible / Réservé / Emprunté /
  // En retard) sur chaque exemplaire, sans retarder l'affichage de la liste
  if (pd0.trackable) applyChoosePins(seq);
}

/* Pose l'état d'emprunt sur les cartes de la liste d'exemplaires. Deux appels
   globaux (prêts en cours + réservations actives) plutôt qu'un par exemplaire ;
   tout objet absent des deux listes est disponible. */
async function applyChoosePins(seq) {
  await pretsReadyPromise;
  if (!PRETS.ok) return;
  let loans, resas;
  try {
    [loans, resas] = await Promise.all([
      api("/plugin/prets/active"),
      PRETS.reservations ? api("/plugin/prets/reservations") : [],
    ]);
  } catch (_) {
    return; // pas de pastilles, la liste reste utilisable telle quelle
  }
  if (seq !== CHOOSE_SEQ) return; // l'écran a changé pendant le chargement
  const state = {};
  (loans.results || loans || []).forEach((l) => {
    state[l.stock_item] = l.is_overdue ? "late" : "out";
  });
  (resas.results || resas || []).forEach((r) => {
    if (r.is_active && r.is_current && !state[r.stock_item]) state[r.stock_item] = "res";
  });
  const LBL = { free: t("st_free"), res: t("st_res"), out: t("st_out"), late: t("st_late") };
  $("#chooseList")
    .querySelectorAll(".choose-card")
    .forEach((card) => {
      const sub = card.querySelector(".sub");
      if (!sub || sub.querySelector(".pill-loan")) return;
      const k = state[card.dataset.pk] || "free";
      sub.insertAdjacentHTML(
        "beforeend",
        '<span class="pill pill-loan pill-loan-' + k + '">' + LBL[k] + "</span>",
      );
    });
}
async function loadItem(pk) {
  renderItem(await api("/api/stock/" + pk + "/?part_detail=true&location_detail=true"));
}

/* ---- recherche texte d'un article ---- */
function esc(s) {
  return (s || "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}
function norm(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
function mediaUrl(u) {
  if (!u) return "";
  if (/^(https?:|data:|blob:)/i.test(u)) return u;
  if (u.indexOf(API + "/") === 0) return u;
  return API + (u[0] === "/" ? u : "/" + u);
}
window.srBox = function () {
  const s = document.createElement("span");
  s.className = "sr-box";
  s.textContent = "📦";
  return s;
};
let searchTimer = null,
  searchReqId = 0;
let PARTS = null,
  partsLoading = null;
async function loadParts(force) {
  if (PARTS && !force) return PARTS;
  if (partsLoading) return partsLoading;
  partsLoading = (async () => {
    const all = [];
    for (let off = 0; off < 6000; off += 500) {
      const r = await api("/api/part/?limit=500&offset=" + off);
      const items = r.results || r;
      all.push(...items);
      if (!r || !r.next || items.length < 500) break;
    }
    PARTS = all.map((p) => ({
      pk: p.pk,
      name: p.name,
      full: p.full_name || p.name,
      ipn: p.IPN || "",
      thumb: p.thumbnail || p.image || "",
      img: p.image || "",
      tpl: !!p.is_template, // modèle : ouvre la liste des variantes
      of: p.variant_of || null, // variante : modèle dont elle relève
      _n: norm([p.full_name || p.name, p.IPN, p.description, p.keywords].filter(Boolean).join(" ")),
    }));
    partsLoading = null;
    return PARTS;
  })();
  return partsLoading;
}
function scoreP(p, q) {
  const n = norm(p.full),
    ipn = norm(p.ipn);
  let s = 0;
  if (n === q) s = 100;
  else if (n.startsWith(q)) s = 85;
  else if (new RegExp("\\b" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(n)) s = 65;
  else if (n.includes(q)) s = 45;
  if (ipn === q) s = Math.max(s, 90);
  else if (ipn.startsWith(q)) s = Math.max(s, 55);
  else if (ipn.includes(q)) s = Math.max(s, 35);
  return s;
}
async function searchParts() {
  const raw = $("#partSearch").value;
  const q = norm(raw);
  $("#partSearchClear").style.display = raw.trim() ? "flex" : "none";
  const box = $("#searchResults");
  if (q.length < 2) {
    box.innerHTML = "";
    return;
  }
  const id = ++searchReqId;
  if (!PARTS) box.innerHTML = '<div class="sr-empty">' + t("catalog_loading") + "</div>";
  let list;
  try {
    list = await loadParts();
  } catch (e) {
    if (id === searchReqId) box.innerHTML = '<div class="sr-empty">' + esc(e.message) + "</div>";
    return;
  }
  if (id !== searchReqId) return;
  const res = list
    .filter((p) => p._n.includes(q))
    .sort((a, b) => scoreP(b, q) - scoreP(a, q))
    .slice(0, 40);
  if (!res.length) {
    box.innerHTML = '<div class="sr-empty">' + t("no_item_found") + "</div>";
    return;
  }
  box.innerHTML = "";
  res.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sr-item";
    /* La famille se lit AVANT d'ouvrir : sans ça, chercher « jus d'orange »
       renvoie sept lignes presque identiques (le modèle et ses variantes)
       sans dire laquelle est le générique. Compté dans le catalogue déjà en
       mémoire — aucun appel réseau de plus. */
    const nv = p.tpl ? PARTS.filter((x) => x.of === p.pk).length : 0;
    const parent = p.of ? PARTS.find((x) => x.pk === p.of) : null;
    const sub = p.tpl
      ? t("tpl_variants_n", nv)
      : parent
        ? t("sr_variant_html", esc(parent.full || parent.name))
        : "";
    b.innerHTML =
      (p.thumb
        ? '<img class="sr-thumb" src="' +
          esc(mediaUrl(p.thumb)) +
          '" data-full="' +
          esc(mediaUrl(p.img)) +
          '" alt="" onerror="thumbErr(this,\'sr\')">'
        : '<span class="sr-box">📦</span>') +
      '<span style="min-width:0"><span class="sr-name">' +
      esc(p.full || p.name) +
      (p.tpl ? '<span class="sr-badge">' + t("tpl_badge") + "</span>" : "") +
      "</span>" +
      (p.ipn || sub
        ? '<span class="sr-sub">' +
          [p.ipn ? esc(p.ipn) : "", sub].filter(Boolean).join(" · ") +
          "</span>"
        : "") +
      "</span>";
    b.onclick = () => openPart(p.pk);
    box.appendChild(b);
  });
}
function clearSearch() {
  $("#partSearch").value = "";
  $("#searchResults").innerHTML = "";
  $("#partSearchClear").style.display = "none";
}
/* opts (facultatif) : voir loadFromPart — { from } pour une descente depuis un
   modèle, { ownStock } pour ses lots à lui. Sans opts, c'est un nouveau flux :
   la flèche retour repart du scanner. */
function openPart(pk, opts) {
  clearSearch();
  PENDING_CODE = "";
  stopCamera();
  show("#screen-item");
  $("#itemBody").style.display = "none";
  $("#chooseBody").style.display = "none";
  $("#done").classList.remove("show");
  $("#screen-item")
    .querySelectorAll(".skeleton")
    .forEach((e) => e.remove());
  $("#screen-item").insertAdjacentHTML(
    "beforeend",
    '<div class="skeleton" id="loader">' + t("loading") + "</div>",
  );
  loadFromPart(pk, opts)
    .catch((e) => {
      gotoScan();
      showErr($("#scanErr"), e.message);
    })
    .finally(() => $("#loader")?.remove());
}
