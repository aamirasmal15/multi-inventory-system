/* ==========================================================================
   features/frigo.js — Le frigo : catalogue de l'emplacement frigo, panier, paiement, gestion du stock.

   Entrée : QR collé sur la porte -> /frigo -> /scannette/?frigo=1 (redirection
   du Caddy de l'instance) ; boot.js mémorise la demande, la page de connexion
   passe en « mode frigo » (features ci-dessous), puis enterApp ouvre le frigo.
   Aussi : bouton « Frigo » de l'écran de scan, scan du QR de l'emplacement.

   - Acheter : un produit = un part (stock cumulé de ses articles rangés dans
     le frigo), quantités au panier, barre de paiement en bas ; « Scanner »
     ajoute au panier l'article dont on scanne le code-barres.
   - Gérer (admins) : comptage direct de chaque article du frigo, produits
     sans prix signalés (invisibles des membres tant qu'il n'y en a pas).
   Le panier survit au rafraîchissement et à l'aller-retour SSO (sessionStorage) ;
   le serveur revalide prix et disponibilité au paiement.
   ========================================================================== */

let FRIGO = null; // dernière réponse de /plugin/paiements/fridge
let FRIGO_MODE = "buy"; // "buy" | "manage"
let FRIGO_SCAN = false; // l'écran de scan alimente le panier du frigo

/* ---- panier { partPk: quantité } ---- */
function frigoCart() {
  try {
    return JSON.parse(sessionStorage.getItem("frigo_cart") || "{}") || {};
  } catch (_) {
    return {};
  }
}
function frigoCartSave(c) {
  try {
    sessionStorage.setItem("frigo_cart", JSON.stringify(c));
  } catch (_) {}
}
function frigoCartClear() {
  frigoCartSave({});
}
function frigoProduct(pk) {
  return ((FRIGO && FRIGO.products) || []).find((p) => p.part === Number(pk)) || null;
}
/* lignes du panier encore valides (produit en vente, quantité bornée au stock) */
function frigoCartLines() {
  const c = frigoCart(),
    out = [];
  let changed = false;
  for (const k in c) {
    const p = frigoProduct(k);
    const q = p && p.buyable ? Math.min(c[k], p.available) : 0;
    if (q !== c[k]) changed = true;
    if (q > 0) out.push({ p, q });
    else delete c[k];
  }
  if (changed) frigoCartSave(Object.assign({}, ...out.map((l) => ({ [l.p.part]: l.q }))));
  return out;
}
function frigoSetQty(pk, q) {
  const c = frigoCart();
  if (q > 0) c[pk] = q;
  else delete c[pk];
  frigoCartSave(c);
}

/* ---- ouverture ---- */
async function openFrigo() {
  stopCamera();
  FRIGO_SCAN = false;
  rememberView("frigo");
  show("#screen-frigo");
  await achatReadyPromise;
  if (!ACHAT.fridge) {
    toast(t("frigo_off"), "bad");
    gotoScan();
    return;
  }
  $("#frigoTitle").textContent = ACHAT.fridge.name;
  const seg = $("#frigoModeSeg");
  seg.style.display = ACHAT.admin ? "" : "none";
  if (!ACHAT.admin) FRIGO_MODE = "buy";
  seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === FRIGO_MODE));
  segSync(seg);
  if (!FRIGO) $("#frigoList").innerHTML = '<div class="skeleton">' + esc(t("loading")) + "</div>";
  await frigoLoad();
}
async function frigoLoad() {
  try {
    FRIGO = await api("/plugin/paiements/fridge");
  } catch (e) {
    $("#frigoList").innerHTML = '<div class="skeleton">' + esc(e.message) + "</div>";
    frigoPaintCart();
    return;
  }
  frigoRender();
}
function frigoSetMode(m) {
  FRIGO_MODE = m;
  const seg = $("#frigoModeSeg");
  seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  segSync(seg);
  frigoRender();
}

function frigoThumb(p, cls) {
  return p.thumbnail
    ? '<img class="' + cls + ' zoomable" src="' + esc(mediaUrl(p.thumbnail)) + '" data-full="' +
        esc(mediaUrl(p.image || "")) + '" alt="' + esc(p.name) + '" onerror="thumbErr(this,\'loc\')" onclick="openLightbox(this)">'
    : '<div class="' + cls + ' fr-ph">' + locBox().innerHTML + "</div>";
}

function frigoRender() {
  if (!FRIGO) return;
  const q = ($("#frigoSearch").value || "").trim().toLowerCase();
  const all = FRIGO.products || [];
  $("#frigoTools").style.display = all.length ? "" : "none";
  $("#frigoSearch").style.display = all.length > 6 ? "" : "none";
  const list = q ? all.filter((p) => p.name.toLowerCase().includes(q)) : all;
  const box = $("#frigoList");
  if (FRIGO_MODE === "manage") frigoRenderManage(box, list);
  else frigoRenderBuy(box, list);
  frigoPaintCart();
}

/* ---- Acheter : grille de produits ---- */
function frigoRenderBuy(box, list) {
  box.className = "frigo-grid";
  if (!FRIGO.enabled) {
    box.innerHTML = '<div class="skeleton fr-span">' + esc(t("frigo_off")) + "</div>";
    return;
  }
  const buyable = list.filter((p) => p.buyable);
  if (!buyable.length) {
    box.innerHTML = '<div class="skeleton fr-span">' + esc(t("frigo_empty")) + "</div>";
    return;
  }
  const cart = frigoCart();
  box.innerHTML = "";
  buyable.forEach((p) => {
    const card = document.createElement("div");
    const inCart = cart[p.part] || 0;
    card.className = "fr-card" + (p.available ? "" : " out") + (inCart ? " in" : "");
    card.innerHTML =
      frigoThumb(p, "fr-img") +
      '<div class="fr-body"><div class="fr-name">' + esc(p.name) + "</div>" +
      '<div class="fr-meta"><span class="fr-price">' + esc(eur(p.unit_price)) + "</span>" +
      '<span class="fr-left">' + esc(p.available ? t("frigo_left", p.available) : t("frigo_soldout")) + "</span></div>" +
      '<div class="fr-ctrl"></div></div>';
    const ctrl = card.querySelector(".fr-ctrl");
    const paint = () => {
      const n = frigoCart()[p.part] || 0;
      card.classList.toggle("in", n > 0);
      if (!p.available) {
        ctrl.innerHTML = '<button class="fr-add" disabled>' + esc(t("frigo_soldout")) + "</button>";
      } else if (!n) {
        ctrl.innerHTML = '<button class="fr-add">+ ' + esc(t("frigo_add")) + "</button>";
        ctrl.firstChild.onclick = () => (frigoSetQty(p.part, 1), paint(), frigoPaintCart());
      } else {
        ctrl.innerHTML =
          '<div class="fr-step"><button class="mini" aria-label="−">−</button><b>' + n +
          '</b><button class="mini" aria-label="+"' + (n >= p.available ? " disabled" : "") + ">+</button></div>";
        const [minus, plus] = ctrl.querySelectorAll("button");
        minus.onclick = () => (frigoSetQty(p.part, n - 1), paint(), frigoPaintCart());
        plus.onclick = () => (frigoSetQty(p.part, Math.min(p.available, n + 1)), paint(), frigoPaintCart());
      }
    };
    paint();
    box.appendChild(card);
  });
}

/* barre du panier, collée en bas de l'écran */
function frigoPaintCart() {
  const bar = $("#frigoCartBar");
  const lines = FRIGO_MODE === "buy" && FRIGO && FRIGO.enabled ? frigoCartLines() : [];
  if (!lines.length) {
    bar.classList.remove("show");
    return;
  }
  const n = lines.reduce((s, l) => s + l.q, 0);
  const cents = lines.reduce((s, l) => s + l.q * l.p.unit_cents, 0);
  $("#frigoCartInfo").innerHTML =
    "<b>" + esc(t("frigo_cart_n", n)) + "</b><span>" +
    esc(lines.map((l) => (l.q > 1 ? l.q + "× " : "") + l.p.name).join(", ")) + "</span>";
  $("#frigoPayBtn").textContent = t("buy_btn", eurCents(cents));
  bar.classList.add("show");
}

async function frigoPay() {
  const lines = frigoCartLines();
  if (!lines.length) return;
  const btn = $("#frigoPayBtn"),
    html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  const paid = await payCheckout(
    { source: "frigo", lines: lines.map((l) => ({ part: l.p.part, quantity: l.q })) },
    lines.map((l) => ({ name: l.p.name, quantity: l.q, total: eurCents(l.q * l.p.unit_cents) })),
  );
  btn.disabled = false;
  btn.innerHTML = html;
  // refusé côté serveur (stock parti entre-temps, prix changé) : on relit le frigo
  if (paid === false && $("#screen-frigo").classList.contains("active")) frigoLoad();
}

/* ---- Gérer (admins) : comptage direct, produits sans prix signalés ---- */
function frigoRenderManage(box, list) {
  box.className = "card frigo-manage";
  box.innerHTML =
    '<div class="fr-hint">' + t("frigo_manage_hint_html") + "</div>" +
    (list.length ? "" : '<div class="skeleton">' + esc(t("frigo_empty_manage")) + "</div>");
  list.forEach((p) => {
    const row = document.createElement("div");
    row.className = "loc-row fr-mrow";
    row.innerHTML =
      frigoThumb(p, "lthumb") +
      '<div class="lmain"><div class="t">' + esc(p.name) + "</div>" +
      '<div class="s">' +
      (p.buyable
        ? esc(eur(p.unit_price)) + " · " + esc(t("frigo_total_stock", fmt(p.quantity) + (p.units ? " " + p.units : "")))
        : '<span class="pill pill-warn">' + esc(t("frigo_no_price")) + "</span>") +
      "</div></div>";
    const main = row.querySelector(".lmain");
    (p.items || []).forEach((it) => main.appendChild(frigoCountRow(p, it)));
    box.appendChild(row);
  });
  const restock = document.createElement("button");
  restock.className = "btn btn-ghost btn-block";
  restock.textContent = t("frigo_restock");
  restock.onclick = () => gotoScan();
  box.appendChild(restock);
}
/* une ligne de comptage par article de stock (mêmes contrôles que les Lieux) */
function frigoCountRow(p, it) {
  const w = document.createElement("div");
  w.className = "fr-count";
  w.innerHTML =
    (p.items.length > 1 || it.batch
      ? '<div class="fr-batch">' + esc(it.batch ? t("batch_pill", it.batch) : t("item_n", it.pk)) + "</div>"
      : "") +
    '<div class="loc-ctrl"><button class="mini minus">−</button><input type="text" inputmode="decimal">' +
    '<button class="mini plus">+</button><button class="loc-save">' + CHECK + "</button>" +
    '<button class="mini fr-open" title="' + esc(t("frigo_open_item")) + '">›</button></div>';
  const input = w.querySelector("input"),
    save = w.querySelector(".loc-save");
  const val = () => parseFloat(input.value.replace(",", "."));
  const refresh = () => save.classList.toggle("on", !isNaN(val()) && val() >= 0 && val() !== Number(it.quantity));
  input.value = fmt(it.quantity);
  w.querySelector(".minus").onclick = () => ((input.value = fmt(Math.max(0, (val() || 0) - 1))), refresh());
  w.querySelector(".plus").onclick = () => ((input.value = fmt((val() || 0) + 1)), refresh());
  input.oninput = refresh;
  w.querySelector(".fr-open").onclick = () => {
    CHOOSE_PART = null;
    loadItem(it.pk);
  };
  save.onclick = async () => {
    const v = val();
    if (isNaN(v) || v < 0) return;
    const h = save.innerHTML;
    save.classList.remove("on");
    save.innerHTML = '<span class="spin" style="width:15px;height:15px;border-width:2px"></span>';
    try {
      await api("/api/stock/count/", { method: "POST", body: { items: [{ pk: it.pk, quantity: v }], notes: "Frigo" } });
      toast(p.name + " : " + fmt(v), "ok");
      await frigoLoad(); // stock cumulé, disponibilités et panier à jour
    } catch (e) {
      save.innerHTML = h;
      save.classList.add("on");
      toast(e.status === 403 ? t("perm_stock_change") : e.message, "bad");
    }
  };
  return w;
}

/* ---- Scanner -> panier ---- */
function openFrigoScan() {
  gotoScan();
  FRIGO_SCAN = true;
  $("#frigoScanBanner").style.display = "flex";
}
async function frigoScanned(code) {
  let pk = null;
  try {
    const r = await resolveBarcode(code);
    if (r && r.stocklocation && ACHAT.fridge && r.stocklocation.pk === ACHAT.fridge.location) {
      openFrigo(); // QR du frigo lui-même
      return;
    }
    if (r && r.stockitem && r.stockitem.pk) pk = (await api("/api/stock/" + r.stockitem.pk + "/")).part;
    else if (r && r.part && r.part.pk) pk = r.part.pk;
    else if (r && r.supplierpart && r.supplierpart.pk) pk = (await api("/api/company/part/" + r.supplierpart.pk + "/")).part;
  } catch (e) {
    toast(e.message, "bad");
  }
  await openFrigo();
  const p = pk != null ? frigoProduct(pk) : null;
  if (!p || !p.buyable || !p.available) {
    toast(t("frigo_not_sold"), "bad");
    return;
  }
  const n = frigoCart()[p.part] || 0;
  if (n >= p.available) {
    toast(t("frigo_left", p.available), "bad");
    return;
  }
  frigoSetQty(p.part, n + 1);
  frigoRender();
  toast(t("frigo_added", p.name), "ok");
}

/* ---- page de connexion en mode frigo (avant authentification) ---- */
function applyFrigoLogin() {
  document.body.classList.add("frigo-mode");
}
