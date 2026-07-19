/* ==========================================================================
   features/create.js — Création d'article inconnu : formulaire, pickers catégorie/emplacement, suggestion d'image, liaison code-barres.
   ========================================================================== */

/* ---- create unknown article ---- */
let CATS = null,
  LOCS = null;
let NEW_TRACKABLE = false; // « Objet à emprunter » sélectionné dans le formulaire
/* bascule Stock en quantité / Objet à emprunter (part trackable) */
function setTrackable(on) {
  NEW_TRACKABLE = !!on;
  document.querySelectorAll("#trackSeg .seg-btn").forEach((b) =>
    b.classList.toggle("active", !!b.dataset.track === NEW_TRACKABLE),
  );
  // un objet à emprunter se crée À L'UNITÉ (on scanne un objet physique à la
  // fois) : pas de quantité, un seul n° de série
  const fq = $("#fldQty");
  if (fq && !STOCK_ONLY_PART) fq.style.display = NEW_TRACKABLE ? "none" : "";
  const hint = $("#trackHint");
  if (hint) hint.style.display = NEW_TRACKABLE ? "" : "none";
  // n° de série saisi par l'utilisateur : l'exemplaire est suivi
  // indépendamment (champ masqué en mode quantité et en ajout de stock)
  const fs = $("#fldSerial");
  if (fs) fs.style.display = NEW_TRACKABLE && !STOCK_ONLY_PART ? "" : "none";
  const si = $("#np_serial");
  if (NEW_TRACKABLE && si && !si.value.trim()) si.value = "1";
  segSync($("#trackSeg")); // le curseur coulisse vers le type choisi
}
/* compte best-effort des n° de série saisis : « 1-3 » = 3, « A1, A2 » = 2 ;
   null si la syntaxe avancée d'InvenTree est utilisée (le serveur tranchera) */
function serialCount(s) {
  let n = 0;
  for (const part of String(s).split(",")) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10),
        b = parseInt(m[2], 10);
      if (b < a) return -1; // plage inversée : invalide
      n += b - a + 1;
    } else if (/[+~-]/.test(t)) {
      return null; // syntaxe avancée (10+, A-…) : laissée au serveur
    } else n += 1;
  }
  return n;
}
async function offerCreate(code, part) {
  PENDING_CODE = code || "";
  // rouvre le formulaire (vierge, mais code scanné conservé) après un refresh
  rememberView("create", null, { code: PENDING_CODE });
  EXISTING_PART = null;
  STOCK_ONLY_PART = null;
  NEW_IMG = "";
  NEW_IMG_FILE = null;
  imgDismissed = false;
  imgReqId++;
  hideImgPrev();
  show("#screen-create");
  hideErr($("#createErr"));
  $("#linkExistingBtn").style.display = "none";
  $("#fldImg").style.display = "";
  $("#fldCat").style.display = "";
  $("#fldDesc").style.display = "";
  // « Objet à emprunter » seulement si le plugin prêts est actif sur l'instance
  await pretsReadyPromise;
  $("#fldTrack").style.display = PRETS.ok ? "" : "none";
  setTrackable(false);
  $("#np_name").readOnly = false;
  $("#np_name").classList.remove("ro");
  const sb = $("#addStockBanner");
  if (sb) sb.style.display = "none";
  const lq = $("#lblQty");
  if (lq) lq.textContent = t("qty_initial");
  const ct = $("#createCrumb");
  if (ct) ct.textContent = t("new_item_crumb");
  const tag = $("#newCode");
  const tt = $("#createTitle");
  if (PENDING_CODE) {
    tag.style.display = "";
    tag.textContent = t("code_scanned", PENDING_CODE);
    $("#createBtnLbl").textContent = t("create_link");
    if (tt) tt.textContent = t("create_title_unknown");
  } else {
    tag.style.display = "none";
    $("#createBtnLbl").textContent = t("create_item");
    if (tt) tt.textContent = t("create_title");
  }
  $("#np_name").value = part ? part.name || "" : "";
  $("#np_desc").value = "";
  $("#np_qty").value = "1";
  $("#np_serial").value = "1";
  $("#np_img_url").value = "";
  $("#np_img_file").value = "";
  NEW_IMG_FILE = null;
  await fillSelects();
  setTimeout(() => $("#np_name").focus(), 250);
}
function createNoCode() {
  offerCreate("");
}
/* article existant mais 0 stock : ne PAS proposer de le créer, mais d'ajouter du stock */
async function offerAddStock(part, opts) {
  opts = opts || {};
  const depleted = opts.depleted !== false; // défaut : stock épuisé (rouge)
  // rouvre l'écran d'ajout après un refresh (part refetchée, code conservé)
  if (part.pk != null)
    rememberView("addstock", part.pk, { code: PENDING_CODE || "", depleted: depleted });
  STOCK_ONLY_PART = part;
  EXISTING_PART = null;
  NEW_IMG = "";
  NEW_IMG_FILE = null;
  imgDismissed = false;
  imgReqId++;
  hideImgPrev();
  show("#screen-create");
  hideErr($("#createErr"));
  $("#linkExistingBtn").style.display = "none";
  const tag = $("#newCode");
  tag.style.display = "none";
  const thumb = part.thumbnail || part.image || "";
  const ban = $("#addStockBanner");
  ban.style.display = "flex";
  ban.className = "stock-banner" + (depleted ? "" : " add");
  const badge = depleted
    ? '<span class="badge-red">' + t("out_of_stock_pill") + "</span>"
    : '<span class="badge-green">' + t("badge_new_loc") + "</span>";
  const hint = depleted ? t("sb_hint_out", esc(PENDING_CODE)) : t("sb_hint_add");
  ban.innerHTML =
    (thumb
      ? '<img class="thumb" src="' +
        esc(mediaUrl(thumb)) +
        '" data-full="' +
        esc(mediaUrl(part.image || "")) +
        '" alt="" onerror="thumbErr(this)">'
      : boxIcon().outerHTML) +
    '<div style="min-width:0;flex:1">' +
    badge +
    '<p class="name">' +
    esc(part.name || "") +
    '</p><p class="sb-hint">' +
    hint +
    "</p></div>";
  const tt = $("#createTitle");
  if (tt) tt.textContent = depleted ? t("add_stock_title") : t("add_elsewhere_title");
  const cc = $("#createCrumb");
  if (cc) cc.textContent = t("existing_item_crumb");
  const lq = $("#lblQty");
  if (lq) lq.textContent = t("qty_add");
  $("#fldImg").style.display = "none";
  $("#fldCat").style.display = "none";
  $("#fldDesc").style.display = "none";
  // le type (quantité / objet à emprunter) est celui du part existant : pas de choix
  $("#fldTrack").style.display = "none";
  setTrackable(false);
  // objet à emprunter : un exemplaire à la fois, pas de case quantité (le
  // serveur attribue le prochain n° de série libre)
  $("#fldQty").style.display = part.trackable ? "none" : "";
  $("#np_name").value = part.name || "";
  $("#np_name").readOnly = true;
  $("#np_name").classList.add("ro");
  $("#np_qty").value = "1";
  $("#createBtnLbl").textContent = part.trackable ? t("add_one") : t("add_stock");
  await fillSelects();
}
/* reprise après un rafraîchissement sur l'écran d'ajout de stock : la part
   est rechargée depuis l'API (nom/vignette/type à jour) et le code scanné
   éventuel restauré pour que le lien code-barres se fasse bien à l'envoi */
async function reopenAddStock(v) {
  try {
    const p = await api("/api/part/" + Number(v.pk) + "/");
    PENDING_CODE = v.code || "";
    await offerAddStock(p, { depleted: v.depleted !== false });
  } catch (_) {
    gotoScan();
  }
}
async function addStockExisting() {
  const part = STOCK_ONLY_PART;
  if (!part) return;
  const trackable = !!part.trackable;
  // objet à emprunter : toujours UN exemplaire à la fois (pas de case quantité)
  const qty = trackable ? 1 : parseFloat($("#np_qty").value.replace(",", "."));
  if (isNaN(qty) || qty <= 0) {
    showErr($("#createErr"), t("qty_invalid"));
    return;
  }
  const loc = $("#np_loc_btn").dataset.value;
  if (!loc) {
    showErr($("#createErr"), t("loc_required"));
    return;
  }
  hideErr($("#createErr"));
  const btn = $("#createBtn"),
    html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> ' + t("adding");
  try {
    let target = null; // lot existant réapprovisionné (articles en quantité)
    if (trackable) {
      // objet à emprunter : l'exemplaire est un item numéroté, jamais de
      // lot en vrac — le serveur donne le prochain n° de série libre du part
      const sn = await api("/api/part/" + part.pk + "/serial-numbers/").catch(() => null);
      const serials = sn && sn.next != null ? String(sn.next).trim() : "";
      if (!serials) {
        showErr($("#createErr"), t("serial_next_fail"));
        return;
      }
      await api("/api/stock/", {
        method: "POST",
        body: {
          part: part.pk,
          quantity: 1,
          location: Number(loc),
          serial_numbers: serials,
        },
      });
    } else {
      // un lot de cet article existe-t-il déjà à CET emplacement précis ? -> on l'incrémente
      const ex = await api(
        "/api/stock/?part=" + part.pk + "&location=" + Number(loc) + "&cascade=false",
      ).catch(() => null);
      const exItems = ex ? ex.results || ex : [];
      target = Array.isArray(exItems) ? exItems.find((s) => !s.serial) : null;
      if (target) {
        await api("/api/stock/add/", {
          method: "POST",
          body: { items: [{ pk: target.pk, quantity: qty }], notes: "Réappro via Scannette" },
        });
      } else {
        await api("/api/stock/", {
          method: "POST",
          body: { part: part.pk, quantity: qty, location: Number(loc) },
        });
      }
    }
    const okMsg = trackable
      ? t("unit_added")
      : target
        ? t("batch_restocked")
        : t("stock_added");
    if (PENDING_CODE) {
      const warn = await linkBarcode(part.pk);
      toast(warn ? t("stock_added_nolink") : okMsg, warn ? "bad" : "ok");
    } else toast(okMsg, "ok");
    STOCK_ONLY_PART = null;
    $("#np_name").readOnly = false;
    await loadFromPart(part.pk);
  } catch (e) {
    showErr($("#createErr"), e.status === 403 ? t("perm_stock_add") : e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}
async function fillSelects() {
  // une liste VIDE est retentée : un échec réseau ne doit pas laisser les
  // pickers sans choix pour toute la session (cache [] sinon indélogeable)
  try {
    if (!CATS || !CATS.length) {
      const r = await api("/api/part/category/?limit=500");
      CATS = r.results || r;
    }
    if (!LOCS || !LOCS.length) {
      const r = await api("/api/stock/location/?limit=500");
      LOCS = r.results || r;
    }
  } catch (_) {
    CATS = CATS || [];
    LOCS = LOCS || [];
  }
  setPick("#np_cat_btn", "", t("none_f"));
  setPick("#np_loc_btn", "", t("choose_btn"));
}
function setPick(sel, val, label) {
  const b = $(sel);
  if (b) {
    b.dataset.value = val || "";
    b.textContent = label;
  }
}
async function ensureLocs() {
  if (!LOCS || !LOCS.length) {
    try {
      const r = await api("/api/stock/location/?limit=500");
      LOCS = r.results || r;
    } catch (_) {
      LOCS = LOCS || [];
    }
  }
  return LOCS;
}
/* ---- sélecteur cherchable (picker) ---- */
let pickerCb = null,
  pickerItems = [],
  pickerCur = "";
function openPicker(title, items, current, cb) {
  pickerCb = cb;
  pickerItems = items;
  pickerCur = String(current || "");
  $("#pickerTitle").textContent = title;
  $("#pickerSearch").value = "";
  renderPicker("");
  showPicker();
}
function fitPicker() {
  const ov = $("#picker");
  if (!ov || ov.style.display === "none") return;
  const vv = window.visualViewport;
  if (!vv) return;
  ov.style.top = vv.offsetTop + "px";
  ov.style.left = vv.offsetLeft + "px";
  ov.style.width = vv.width + "px";
  ov.style.height = vv.height + "px";
  ov.style.bottom = "auto";
  ov.style.right = "auto";
  const sheet = ov.querySelector(".picker-sheet");
  if (sheet) sheet.style.maxHeight = Math.max(200, vv.height - 32) + "px";
}
function showPicker() {
  const ov = $("#picker");
  ov.style.display = "flex";
  ov.classList.remove("closing");
  document.body.classList.add("noscroll");
  const sheet = ov.querySelector(".picker-sheet");
  if (sheet) {
    sheet.classList.remove("pk-open");
    void sheet.offsetWidth;
    sheet.classList.add("pk-open");
  }
  fitPicker();
}
function closePicker() {
  const ov = $("#picker");
  document.body.classList.remove("noscroll");
  pickerCb = null;
  ov.classList.add("closing");
  setTimeout(() => {
    ov.style.display = "none";
    ov.classList.remove("closing");
    ov.style.top =
      ov.style.left =
      ov.style.width =
      ov.style.height =
      ov.style.bottom =
      ov.style.right =
        "";
    const sheet = ov.querySelector(".picker-sheet");
    if (sheet) sheet.style.maxHeight = "";
  }, 150);
}
function renderPicker(q) {
  const nq = norm(q),
    list = $("#pickerList");
  list.innerHTML = "";
  const none = document.createElement("button");
  none.type = "button";
  none.className = "pick-item" + (pickerCur === "" ? " cur" : "");
  none.textContent = t("none_m");
  none.onclick = () => {
    if (pickerCb) pickerCb("", "");
    closePicker();
  };
  list.appendChild(none);
  pickerItems
    .filter((it) => !nq || norm(it.label).includes(nq))
    .slice(0, 300)
    .forEach((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pick-item" + (String(it.pk) === pickerCur ? " cur" : "");
      b.textContent = it.label;
      b.onclick = () => {
        if (pickerCb) pickerCb(String(it.pk), it.label);
        closePicker();
      };
      list.appendChild(b);
    });
  if (list.children.length === 1) {
    const e = document.createElement("div");
    e.className = "sr-empty";
    e.style.padding = "14px 16px";
    e.textContent = t("no_results");
    list.appendChild(e);
  }
}
function catItems() {
  return (CATS || []).map((c) => ({ pk: c.pk, label: c.pathstring || c.name }));
}
function locItems() {
  return (LOCS || []).map((l) => ({ pk: l.pk, label: l.pathstring || l.name }));
}
let pickerRender = renderPicker;
/* ---- picker hiérarchique (catégories / emplacements) ---- */
let treeChildren = {},
  treeById = {},
  treeStack = [],
  treeCb = null,
  treeCur = "",
  treeAllowNone = true,
  treeNoneLabel = "— Aucune —",
  treeAnim = "";
function openTreePicker(title, nodes, current, cb, opts) {
  opts = opts || {};
  treeCb = cb;
  treeCur = String(current || "");
  treeAllowNone = opts.allowNone !== false;
  treeNoneLabel = opts.noneLabel || t("none_m");
  treeChildren = {};
  treeById = {};
  (nodes || []).forEach((n) => {
    treeById[String(n.pk)] = n;
    const pv = n.parent && typeof n.parent === "object" ? n.parent.pk : n.parent;
    const p = pv == null ? "root" : String(pv);
    (treeChildren[p] = treeChildren[p] || []).push(n);
  });
  for (const k in treeChildren)
    treeChildren[k].sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  treeStack = [];
  pickerRender = renderTree;
  $("#pickerTitle").textContent = title;
  $("#pickerSearch").value = "";
  renderTree("");
  showPicker();
}
function treePick(n) {
  if (treeCb) treeCb(String(n.pk), n.pathstring || n.name);
  closePicker();
}
function pickFlash(btn, n) {
  if (btn) btn.classList.add("picked");
  setTimeout(() => treePick(n), 130);
}
function renderTree(q) {
  const list = $("#pickerList");
  list.innerHTML = "";
  const nq = norm(q);
  if (nq) {
    const all = Object.keys(treeById).map((k) => treeById[k]);
    const matches = all
      .filter((n) => norm(n.pathstring || n.name).includes(nq))
      .sort((a, b) => norm(a.pathstring || a.name).localeCompare(norm(b.pathstring || b.name)))
      .slice(0, 300);
    if (!matches.length) {
      treeEmpty(list);
      return;
    }
    matches.forEach((n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pick-item" + (String(n.pk) === treeCur ? " cur" : "");
      b.innerHTML = '<span class="pi-txt">' + esc(n.pathstring || n.name) + "</span>";
      b.onclick = () => pickFlash(b, n);
      list.appendChild(b);
    });
    return;
  }
  const parentPk = treeStack.length ? treeStack[treeStack.length - 1] : null;
  if (parentPk === null) {
    if (treeAllowNone) {
      const none = document.createElement("button");
      none.type = "button";
      none.className = "pick-item" + (treeCur === "" ? " cur" : "");
      none.innerHTML = '<span class="pi-txt">' + esc(treeNoneLabel) + "</span>";
      none.onclick = () => {
        none.classList.add("picked");
        setTimeout(() => {
          if (treeCb) treeCb("", "");
          closePicker();
        }, 130);
      };
      list.appendChild(none);
    }
  } else {
    const cur = treeById[parentPk];
    const back = document.createElement("button");
    back.type = "button";
    back.className = "pick-back";
    back.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg> ' +
      t("back");
    back.onclick = () => {
      treeStack.pop();
      $("#pickerSearch").value = "";
      treeAnim = "back";
      renderTree("");
      $("#pickerList").scrollTop = 0;
    };
    list.appendChild(back);
    const path = document.createElement("div");
    path.className = "pick-path";
    path.textContent = cur.pathstring || cur.name;
    list.appendChild(path);
  }
  const kids = treeChildren[parentPk == null ? "root" : String(parentPk)] || [];
  kids.forEach((n) => {
    const hasKids = !!(treeChildren[String(n.pk)] || []).length;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pick-item" + (String(n.pk) === treeCur && !hasKids ? " cur" : "");
    b.innerHTML =
      '<span class="pi-txt">' +
      esc(n.name) +
      "</span>" +
      (hasKids
        ? '<span class="pi-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></span>'
        : "");
    b.onclick = () => {
      if (hasKids) {
        treeStack.push(String(n.pk));
        $("#pickerSearch").value = "";
        treeAnim = "fwd";
        renderTree("");
        $("#pickerList").scrollTop = 0;
      } else {
        pickFlash(b, n);
      }
    };
    list.appendChild(b);
  });
  if (list.children.length === 0) treeEmpty(list);
  if (treeAnim) {
    list.classList.remove("anim-fwd", "anim-back");
    void list.offsetWidth;
    list.classList.add(treeAnim === "back" ? "anim-back" : "anim-fwd");
    treeAnim = "";
  } else {
    list.classList.remove("anim-fwd", "anim-back");
  }
}
function treeEmpty(list) {
  const e = document.createElement("div");
  e.className = "sr-empty";
  e.style.padding = "14px 16px";
  e.textContent = t("no_elements");
  list.appendChild(e);
}
let EXISTING_PART = null;
let STOCK_ONLY_PART = null; // article existant sans stock -> mode « ajouter du stock »
let NEW_IMG = "",
  NEW_IMG_FILE = null,
  imgDismissed = false,
  imgTimer = null,
  imgReqId = 0,
  IMG_LIST = [],
  IMG_IDX = 0;
function hideImgPrev() {
  $("#imgPrev").style.display = "none";
  IMG_LIST = [];
  IMG_IDX = 0;
  NEW_IMG = "";
  NEW_IMG_FILE = null;
}
function showFilePreview(file) {
  NEW_IMG_FILE = file;
  NEW_IMG = "";
  IMG_LIST = [];
  imgDismissed = false;
  $("#imgPrevImg").src = URL.createObjectURL(file);
  $("#imgCap").textContent = t("from_gallery");
  $("#imgPrevBtn").style.display = "none";
  $("#imgNextBtn").style.display = "none";
  $("#imgPrev").style.display = "block";
}
function renderImg() {
  if (!IMG_LIST.length) {
    $("#imgPrev").style.display = "none";
    NEW_IMG = "";
    return;
  }
  IMG_IDX = (IMG_IDX + IMG_LIST.length) % IMG_LIST.length;
  NEW_IMG = IMG_LIST[IMG_IDX];
  $("#imgPrevImg").src = NEW_IMG;
  $("#imgCap").textContent = IMG_IDX + 1 + " / " + IMG_LIST.length;
  const multi = IMG_LIST.length > 1;
  $("#imgPrevBtn").style.display = multi ? "grid" : "none";
  $("#imgNextBtn").style.display = multi ? "grid" : "none";
  $("#imgPrev").style.display = "block";
}
function imgStep(d) {
  if (IMG_LIST.length) {
    IMG_IDX += d;
    renderImg();
  }
}
async function uploadPartImage(pk, src) {
  let blob = null;
  if (src instanceof Blob) {
    blob = src;
  } else if (typeof src === "string" && src) {
    try {
      const resp = await fetch(src, { mode: "cors" });
      if (resp.ok) blob = await resp.blob();
    } catch (_) {}
  }
  if (blob && blob.size > 0) {
    try {
      const ext = ((blob.type || "").split("/")[1] || "jpg").split("+")[0].replace("jpeg", "jpg");
      const fd = new FormData();
      fd.append("image", blob, "item." + ext);
      const r = await fetch(API + "/api/part/" + pk + "/", {
        method: "PATCH",
        headers: { Authorization: "Token " + TOKEN },
        body: fd,
      });
      if (r.ok) return true;
    } catch (_) {}
  }
  if (typeof src === "string" && src) {
    try {
      await api("/api/part/" + pk + "/", { method: "PATCH", body: { remote_image: src } });
      return true;
    } catch (_) {}
  }
  return false;
}
function catName() {
  const b = $("#np_cat_btn");
  if (!b || !b.dataset.value) return "";
  return (b.textContent || "").split("/").pop().trim();
}
function imgQuery() {
  const n = $("#np_name").value.trim();
  const c = catName();
  return c ? n + " " + c : n;
}
function okImg(u) {
  return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u) || /openverse|wikimedia/i.test(u);
}
async function fetchImages(q) {
  const urls = [];
  try {
    const r = await fetch(
      "https://api.openverse.org/v1/images/?q=" + encodeURIComponent(q) + "&page_size=12",
      { headers: { Accept: "application/json" } },
    );
    if (r.ok) {
      const j = await r.json();
      (j.results || []).forEach((it) => {
        const u = it.thumbnail || it.url;
        if (u) urls.push(u);
      });
    }
  } catch (_) {}
  try {
    const u =
      "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=" +
      encodeURIComponent(q) +
      "&gsrlimit=8&prop=imageinfo&iiprop=url&iiurlwidth=500&format=json&origin=*";
    const r = await fetch(u);
    const j = await r.json();
    const pages = j.query && j.query.pages;
    if (pages) {
      for (const k in pages) {
        const ii = pages[k].imageinfo;
        if (ii && ii[0] && ii[0].thumburl && okImg(ii[0].thumburl)) urls.push(ii[0].thumburl);
      }
    }
  } catch (_) {}
  return [...new Set(urls)].slice(0, 20);
}
async function suggestImage() {
  return; // recherche auto désactivée : on utilise le collage d'URL manuel (cohérent)
}
async function findPartByName(name) {
  try {
    const r = await api("/api/part/?search=" + encodeURIComponent(name) + "&limit=25");
    const items = r.results || r;
    return (
      items.find((p) => (p.name || "").trim().toLowerCase() === name.trim().toLowerCase()) || null
    );
  } catch (_) {
    return null;
  }
}
async function linkBarcode(partPk) {
  try {
    await api("/api/barcode/link/", {
      method: "POST",
      body: { barcode: PENDING_CODE, part: partPk },
    });
    if (PENDING_CODE) LINKED[(PENDING_CODE || "").trim()] = partPk;
    return "";
  } catch (le) {
    return le.status === 403 ? t("link_fail_perm") : t("link_fail", le.message);
  }
}
function showDuplicate(name) {
  const b = $("#linkExistingBtn");
  // « Lier le code » n'a de sens que si un code a été scanné : en création
  // « sans code » (bouton central), il n'y a aucun code-barres à rattacher,
  // donc pas de bouton — juste le constat que l'article existe déjà.
  if (PENDING_CODE) {
    showErr($("#createErr"), t("dup_exists_link", name));
    b.querySelector(".lx-label").textContent = t("link_code_to", name);
    b.style.display = "flex";
  } else {
    showErr($("#createErr"), t("dup_exists", name));
    b.style.display = "none";
  }
}
async function linkToExisting() {
  if (!EXISTING_PART) return;
  const b = $("#linkExistingBtn"),
    html = b.innerHTML;
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span> ' + t("linking");
  const warn = await linkBarcode(EXISTING_PART.pk);
  b.disabled = false;
  b.innerHTML = html;
  if (warn) {
    showErr($("#createErr"), warn);
    return;
  }
  b.style.display = "none";
  hideErr($("#createErr"));
  toast(t("code_linked"), "ok");
  await loadFromPart(EXISTING_PART.pk);
}
async function createArticle() {
  if (STOCK_ONLY_PART) return addStockExisting();
  // TOUT est validé AVANT le moindre appel réseau : si une info manque ou est
  // invalide, rien ne part vers le serveur (pas d'article à moitié créé).
  const name = $("#np_name").value.trim();
  if (!name) {
    showErr($("#createErr"), t("name_required"));
    return;
  }
  // objet à emprunter : toujours UN exemplaire (pas de case quantité, on
  // scanne un objet physique à la fois) ; article classique : quantité saisie
  const qty = NEW_TRACKABLE ? 1 : parseFloat($("#np_qty").value.replace(",", "."));
  if (isNaN(qty) || qty <= 0) {
    showErr($("#createErr"), t("qty_invalid_min"));
    return;
  }
  // objet à emprunter : le n° de série est SAISI, et un seul
  let serials = "";
  if (NEW_TRACKABLE) {
    serials = $("#np_serial").value.trim();
    if (!serials) {
      showErr($("#createErr"), t("serial_required"));
      return;
    }
    // serialCount null = n° exotique avec tiret (« ABC-12 ») : le serveur
    // tranchera pour quantity 1 ; en revanche plage/liste = plusieurs -> refus
    const cnt = serialCount(serials);
    if (cnt !== null && cnt !== 1) {
      showErr($("#createErr"), t("serial_single"));
      return;
    }
  }
  const loc = $("#np_loc_btn").dataset.value;
  if (!loc) {
    showErr($("#createErr"), t("loc_required"));
    return;
  }
  hideErr($("#createErr"));
  $("#linkExistingBtn").style.display = "none";
  const cat = $("#np_cat_btn").dataset.value,
    desc = $("#np_desc").value.trim();
  const btn = $("#createBtn"),
    html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> ' + t("creating");
  try {
    const partBody = { name, description: desc, active: true };
    if (cat) partBody.category = Number(cat);
    if (NEW_TRACKABLE) partBody.trackable = true;
    // Article classique : part + stock initial en UN SEUL appel (transaction
    // atomique côté InvenTree) — une coupure réseau ne peut pas laisser un
    // article sans stock. L'exemplaire numéroté d'un objet à emprunter
    // passe par /api/stock/ (serial_numbers) en 2e appel, annulé si échec.
    if (!NEW_TRACKABLE)
      partBody.initial_stock = { quantity: qty, location: Number(loc) };
    let part;
    try {
      part = await api("/api/part/", { method: "POST", body: partBody });
    } catch (pe) {
      if (/uniqu|already exists|ensemble unique/i.test(pe.message)) {
        EXISTING_PART = await findPartByName(name);
        if (EXISTING_PART) {
          showDuplicate(name);
          return;
        }
      }
      throw pe;
    }
    if (NEW_TRACKABLE) {
      try {
        await api("/api/stock/", {
          method: "POST",
          body: {
            part: part.pk,
            quantity: qty,
            location: Number(loc),
            serial_numbers: serials,
          },
        });
      } catch (se) {
        // le stock a échoué APRÈS la création du part : on annule le part
        // (désactivation puis suppression, possible car sans stock) pour ne
        // rien laisser à moitié créé ; si l'annulation échoue aussi, on le dit.
        const cleaned = await api("/api/part/" + part.pk + "/", {
          method: "PATCH",
          body: { active: false },
        })
          .then(() => api("/api/part/" + part.pk + "/", { method: "DELETE" }))
          .then(() => true)
          .catch(() => false);
        throw new Error((cleaned ? t("nothing_created") : t("half_created")) + se.message);
      }
    }
    if (NEW_IMG_FILE || NEW_IMG) {
      await uploadPartImage(part.pk, NEW_IMG_FILE || NEW_IMG);
    }
    PARTS = null; // le catalogue a changé -> on rechargera à la prochaine recherche
    const qtyLabel = NEW_TRACKABLE
      ? t("loan_obj_qty", serials)
      : fmt(qty) + t("in_stock_suffix");
    if (PENDING_CODE) {
      const warn = await linkBarcode(part.pk);
      toast(warn ? t("item_created_nolink") : t("item_added"), warn ? "bad" : "ok");
      showDone(t("qr_created"), name, qtyLabel, warn);
    } else {
      toast(t("item_added"), "ok");
      await showCreatedQR(part.pk, name);
    }
  } catch (e) {
    showErr($("#createErr"), e.status === 403 ? t("perm_create") : e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}
