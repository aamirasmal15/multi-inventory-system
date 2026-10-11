/* ==========================================================================
   features/frigo.js — Le frigo : catalogue de l'emplacement frigo, panier, paiement, gestion du stock.

   Seule entrée : QR collé sur la porte -> /frigo -> /scannette/?frigo=1
   (redirection du Caddy de l'instance) ; boot.js mémorise la demande, la page
   de connexion passe en « mode frigo » (applyFrigoLogin), puis enterApp
   ouvre le frigo. Le reste de la Scannette n'y mène pas.

   - Acheter : un produit = un part (stock cumulé de ses articles rangés dans
     le frigo), quantités au panier, barre de paiement en bas.
   - Gérer (admins) : comptage direct de chaque article du frigo, produits
     sans prix signalés (invisibles des membres tant qu'il n'y en a pas).
   Le panier survit au rafraîchissement et à l'aller-retour SSO (sessionStorage) ;
   le serveur revalide prix et disponibilité au paiement.
   ========================================================================== */

let FRIGO = null; // dernière réponse de /plugin/paiements/fridge
let FRIGO_MODE = "buy"; // "buy" | "manage"
let FRIGO_CART_PAYING = false; // le paiement en cours est celui du panier

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
  rememberView("frigo");
  show("#screen-frigo");
  await achatReadyPromise;
  if (!ACHAT.fridge) {
    toast(t("frigo_off"), "bad");
    gotoScan();
    return;
  }
  $("#frigoTitle").textContent = ACHAT.fridge.name;
  prefetchSumup(); // le formulaire de paiement sera prêt au moment de payer
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

/* vignette d'un produit ; zoom (lightbox) seulement en mode Gérer : en achat,
   toucher la carte ajoute au panier */
function frigoThumb(p, cls, zoom) {
  if (!p.thumbnail) return '<div class="' + cls + ' fr-ph">' + locBox().innerHTML + "</div>";
  return zoom
    ? '<img class="' + cls + ' zoomable" src="' + esc(mediaUrl(p.thumbnail)) + '" data-full="' +
        esc(mediaUrl(p.image || "")) + '" alt="' + esc(p.name) + '" onerror="thumbErr(this,\'loc\')" onclick="openLightbox(this)">'
    : '<img class="' + cls + '" src="' + esc(mediaUrl(p.thumbnail)) + '" alt="' + esc(p.name) + '" onerror="thumbErr(this,\'loc\')">';
}

function frigoRender() {
  if (!FRIGO) return;
  const q = ($("#frigoSearch").value || "").trim().toLowerCase();
  const all = FRIGO.products || [];
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
  box.innerHTML = "";
  buyable.forEach((p) => {
    const card = document.createElement("div");
    card.className = "fr-card" + (p.available ? "" : " out");
    card.setAttribute("role", "button");
    card.tabIndex = p.available ? 0 : -1;
    card.innerHTML =
      '<span class="fr-check" aria-hidden="true">' + CHECK + "</span>" +
      frigoThumb(p, "fr-img", false) +
      '<div class="fr-body"><div class="fr-name">' + esc(p.name) + "</div>" +
      '<div class="fr-meta"><span class="fr-price">' + esc(eur(p.unit_price)) + "</span>" +
      '<span class="fr-left">' + esc(p.available ? t("frigo_left", p.available) : t("frigo_soldout")) + "</span></div>" +
      '<div class="fr-ctrl"></div></div>';
    const ctrl = card.querySelector(".fr-ctrl");
    const set = (n) => {
      frigoSetQty(p.part, n);
      paint();
      frigoPaintCart();
    };
    const paint = () => {
      const n = frigoCart()[p.part] || 0;
      card.classList.toggle("in", n > 0);
      card.setAttribute("aria-pressed", n > 0 ? "true" : "false");
      if (!p.available) {
        ctrl.innerHTML = '<span class="fr-hint-add">' + esc(t("frigo_soldout")) + "</span>";
      } else if (!n) {
        ctrl.innerHTML = '<span class="fr-hint-add">+ ' + esc(t("frigo_add")) + "</span>";
      } else {
        ctrl.innerHTML =
          '<div class="fr-step"><button class="mini" aria-label="−">−</button><b>' + n +
          '</b><button class="mini" aria-label="+"' + (n >= p.available ? " disabled" : "") + ">+</button></div>";
        const [minus, plus] = ctrl.querySelectorAll("button");
        minus.onclick = (e) => (e.stopPropagation(), set(n - 1));
        plus.onclick = (e) => (e.stopPropagation(), set(Math.min(p.available, n + 1)));
      }
    };
    // toute la carte : ajoute au panier, ou retire une carte déjà cochée
    const toggle = () => {
      if (!p.available) return;
      set(frigoCart()[p.part] ? 0 : 1);
    };
    card.onclick = toggle;
    card.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
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
  FRIGO_CART_PAYING = true; // le reçu videra le panier (pas un achat depuis une fiche)
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

/* ---- Gérer (admins) : prix et stock de chaque produit, en direct ----
   Ranger un article dans le frigo suffit à le mettre en vente (le plugin
   coche « Vendable » tout seul) : il ne lui manque qu'un prix, saisi ici
   dans une fenêtre dédiée (openPriceSheet), journalisée côté serveur. */
function frigoRenderManage(box, list) {
  box.className = "frigo-manage";
  box.innerHTML =
    '<p class="fr-help">' + esc(t("frigo_help_1")) + "</p>" +
    '<p class="fr-help">' + esc(t("frigo_help_2")) + "</p>";
  if (!list.length) {
    box.insertAdjacentHTML("beforeend", '<div class="card"><div class="skeleton">' + esc(t("frigo_empty_manage")) + "</div></div>");
    return;
  }
  const card = document.createElement("div");
  card.className = "card";
  list.forEach((p) => {
    const row = document.createElement("div");
    row.className = "loc-row fr-mrow";
    row.innerHTML = frigoThumb(p, "lthumb") + '<div class="lmain"><div class="t">' + esc(p.name) + "</div></div>";
    const main = row.querySelector(".lmain");
    // ligne « Prix » sobre, alignée sur « Stock » : valeur + bouton Modifier
    const pr = document.createElement("div");
    pr.className = "fr-field fr-pricerow" + (p.buyable ? "" : " none");
    pr.innerHTML =
      '<span class="fr-lbl">' + esc(t("frigo_price")) + "</span>" +
      '<span class="fr-pval">' +
      (p.buyable
        ? "<b>" + esc(eur(p.unit_price)) + "</b>" + (p.price_inherited ? "<small>" + esc(t("frigo_price_model_s")) + "</small>" : "")
        : "<em>" + esc(t("frigo_no_price_s")) + "</em>") +
      "</span>" +
      '<button type="button" class="fr-pedit">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
      esc(p.buyable ? t("frigo_price_edit_s") : t("frigo_price_add_s")) + "</button>";
    pr.onclick = () => openPriceSheet(p);
    main.appendChild(pr);
    (p.items || []).forEach((it) => main.appendChild(frigoCountRow(p, it)));
    card.appendChild(row);
  });
  box.appendChild(card);
}

/* montants proposés en un tap (fenêtre de prix, formulaire de création) */
const PRICE_CHIPS = ["0,50", "0,70", "1,00", "1,50", "2,00"];
function priceChipsHtml() {
  return (
    '<div class="price-chips">' +
    PRICE_CHIPS.map((c) => '<button type="button" class="price-chip" data-v="' + c + '">' + c + " €</button>").join("") +
    "</div>"
  );
}
function armPriceChips(root, input, after) {
  root.querySelectorAll(".price-chip").forEach((b) => {
    b.onclick = () => {
      input.value = b.dataset.v;
      root.querySelectorAll(".price-chip").forEach((x) => x.classList.toggle("on", x === b));
      if (after) after();
    };
  });
  input.addEventListener("input", () =>
    root.querySelectorAll(".price-chip").forEach((x) => x.classList.toggle("on", x.dataset.v === input.value.trim())),
  );
}

/* fenêtre de prix d'un produit : feuille qui glisse du bas, prix au centre
   avec −/+ 0,10 €, montants rapides sur une ligne, retrait de la vente en
   lien discret, historique repliable (qui a mis quel prix, quand) */
function openPriceSheet(p) {
  const own = p.buyable && !p.price_inherited;
  const now = p.buyable
    ? p.price_inherited
      ? t("frigo_now_model", eur(p.unit_price))
      : t("frigo_now", eur(p.unit_price))
    : t("frigo_no_price");
  const ov = document.createElement("div");
  ov.className = "modal-ov sheet-ov";
  ov.innerHTML =
    '<div class="ps-sheet" role="dialog" aria-modal="true" aria-label="' + esc(t("frigo_price_new")) + '">' +
    '<div class="ps-grab" aria-hidden="true"></div>' +
    '<div class="ps-head"><div class="ps-name"><div class="t">' + esc(p.name) + '</div><div class="s">' + esc(now) +
    '</div></div><button class="iconbtn" data-x aria-label="' + esc(t("cancel")) + '">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>' +
    '<div class="ps-amount">' +
    '<button type="button" class="ps-step" data-d="-10" aria-label="−0,10 €">−</button>' +
    '<label class="ps-field"><input id="psInput" type="text" inputmode="decimal" autocomplete="off" placeholder="0,00"><span>€</span></label>' +
    '<button type="button" class="ps-step" data-d="10" aria-label="+0,10 €">+</button></div>' +
    '<div class="ps-steplbl">' + esc(t("frigo_price_step")) + "</div>" +
    priceChipsHtml() +
    (p.price_inherited ? '<p class="ps-note">' + esc(t("frigo_price_inherited")) + "</p>" : "") +
    '<button class="btn btn-primary btn-block" data-save disabled></button>' +
    (own ? '<button type="button" class="ps-remove" data-remove>' + esc(t("frigo_price_remove")) + "</button>" : "") +
    '<details class="ps-hist"><summary>' + esc(t("frigo_price_history")) + '</summary><div class="ps-hist-l"><div class="ps-empty">' +
    esc(t("loading")) + "</div></div></details></div>";
  const input = ov.querySelector("#psInput"),
    save = ov.querySelector("[data-save]");
  const cents = () => {
    const v = input.value.trim().replace(",", ".");
    return /^\d{1,3}(\.\d{1,2})?$/.test(v) ? Math.round(parseFloat(v) * 100) : NaN;
  };
  const fmtC = (c) => (c / 100).toFixed(2).replace(".", ",");
  const sync = () => {
    // champ à la largeur du prix : « 1,10 € » reste centré entre − et +
    input.style.width = Math.max(4, (input.value || input.placeholder).length) + 0.3 + "ch";
    const c = cents();
    const ok = c > 0;
    save.disabled = !ok;
    save.textContent = ok ? t("frigo_price_save_x", eurCents(c)) : t("frigo_price_save");
    ov.querySelectorAll(".price-chip").forEach((x) => x.classList.toggle("on", ok && x.dataset.v === fmtC(c)));
  };
  input.value = own ? String(p.unit_price).replace(".", ",") : "";
  armPriceChips(ov, input, sync);
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !save.disabled) save.click();
  });
  ov.querySelectorAll(".ps-step").forEach((b) => {
    b.onclick = () => {
      const base = cents() > 0 ? cents() : p.unit_cents || 0;
      input.value = fmtC(Math.max(10, base + Number(b.dataset.d)));
      sync();
    };
  });
  lockScroll();
  const close = () => {
    unlockScroll();
    document.removeEventListener("keydown", onKey);
    ov.classList.add("closing");
    setTimeout(() => ov.remove(), 220);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  ov.addEventListener("click", (e) => {
    if (e.target === ov) close();
  });
  ov.querySelector("[data-x]").onclick = close;
  const send = async (price, btn) => {
    const h = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>';
    try {
      await api("/plugin/paiements/fridge/price", { method: "POST", body: { part: p.part, price } });
      toast(price ? t("frigo_price_saved", p.name, eur(price.replace(",", "."))) : t("frigo_price_removed", p.name), "ok");
      close();
      frigoLoad();
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = h;
      toast(e.message, "bad");
    }
  };
  save.onclick = () => cents() > 0 && send(fmtC(cents()), save);
  const rm = ov.querySelector("[data-remove]");
  if (rm) rm.onclick = () => send("", rm);
  document.body.appendChild(ov);
  sync();
  // historique des prix, chargé à l'ouverture (déplié à la demande)
  api("/plugin/paiements/fridge/price?part=" + p.part)
    .then((h) => {
      const l = ov.querySelector(".ps-hist-l");
      if (!l) return;
      ov.querySelector(".ps-hist summary").textContent = t("frigo_price_history") + (h.length ? " (" + h.length + ")" : "");
      const c = (x) => (x == null ? "—" : eurCents(x));
      l.innerHTML = h.length
        ? h
            .map(
              (x) =>
                '<div class="ps-hrow"><span class="pr">' + esc(c(x.old_cents)) + ' <span class="ar">→</span> <b>' +
                esc(c(x.new_cents)) + '</b></span><span class="who">' + esc(x.user) + "<br>" + esc(x.date) + "</span></div>",
            )
            .join("")
        : '<div class="ps-empty">' + esc(t("frigo_price_history_empty")) + "</div>";
    })
    .catch(() => {});
}

/* stock : une ligne par article de stock rangé dans le frigo, avec le
   dernier ajout (qui, quand) lu dans l'historique InvenTree */
function frigoCountRow(p, it) {
  const w = document.createElement("div");
  w.className = "fr-stock";
  const label = p.items.length > 1 && it.batch ? t("batch_pill", it.batch) : t("frigo_stock");
  w.innerHTML =
    '<div class="fr-field"><span class="fr-lbl">' + esc(label) + "</span>" +
    '<div class="loc-ctrl"><button class="mini minus" aria-label="−">−</button><input type="text" inputmode="decimal">' +
    '<button class="mini plus" aria-label="+">+</button></div>' +
    '<button class="loc-save" aria-label="✓">' + CHECK + "</button></div>" +
    (it.added ? '<div class="fr-added">' + esc(t("frigo_added_by", it.added.user, it.added.date)) + "</div>" : "");
  const input = w.querySelector("input"),
    save = w.querySelector(".loc-save");
  const initial = fmt(it.quantity);
  input.value = initial;
  // dès qu'on touche au stock : « Avant : 6 → 8 (+2) » sous la ligne
  const diff = document.createElement("div");
  diff.className = "fr-diff";
  w.querySelector(".fr-field").after(diff);
  const refresh = () => {
    const changed = input.value.trim() !== initial;
    save.classList.toggle("on", changed);
    const q = parseFloat(input.value.replace(",", "."));
    if (!changed || isNaN(q)) {
      diff.classList.remove("show");
      return;
    }
    const d = q - Number(it.quantity);
    diff.innerHTML =
      esc(t("frigo_stock_before")) + " <b>" + esc(initial) + "</b> → <b>" + esc(fmt(q)) + "</b> " +
      '<span class="' + (d >= 0 ? "up" : "down") + '">(' + (d >= 0 ? "+" : "−") + esc(fmt(Math.abs(d))) + ")</span>";
    diff.classList.add("show");
  };
  input.oninput = refresh;
  const step = (d) => {
    const q = parseFloat(input.value.replace(",", ".")) || 0;
    input.value = fmt(Math.max(0, q + d));
    refresh();
  };
  w.querySelector(".minus").onclick = () => step(-1);
  w.querySelector(".plus").onclick = () => step(1);
  input.onkeydown = (e) => {
    if (e.key === "Enter" && save.classList.contains("on")) save.click();
  };
  save.onclick = async () => {
    const q = parseFloat(input.value.replace(",", "."));
    if (isNaN(q) || q < 0) {
      toast(t("qty_invalid"), "bad");
      return;
    }
    const h = save.innerHTML;
    save.classList.remove("on");
    save.innerHTML = '<span class="spin" style="width:15px;height:15px;border-width:2px"></span>';
    try {
      await api("/api/stock/count/", { method: "POST", body: { items: [{ pk: it.pk, quantity: q }], notes: "Frigo" } });
      toast(p.name + " : " + initial + " → " + fmt(q), "ok");
      await frigoLoad();
    } catch (e) {
      save.innerHTML = h;
      save.classList.add("on");
      toast(e.status === 403 ? t("perm_stock_change") : e.message, "bad");
    }
  };
  return w;
}

/* ---- formulaire de création / ajout de stock : prix quand on range au frigo ----
   Visible pour un admin dès que l'emplacement choisi est le frigo (ou un de
   ses sous-emplacements). Vide = rien n'est changé. */
function isFridgeLoc(pk) {
  return !!(ACHAT.fridge && pk && (ACHAT.fridge.locations || [ACHAT.fridge.location]).includes(Number(pk)));
}

/* ---- verrou du frigo côté Scannette (le serveur refuse de toute façon) ----
   Pour un non-admin : le frigo n'apparaît dans aucune liste d'emplacements, et
   la fiche d'un article rangé dedans est en lecture seule. */
async function hideFridgeLocs(list) {
  await achatReadyPromise;
  if (ACHAT.admin || !ACHAT.fridge) return list;
  return (list || []).filter((l) => !isFridgeLoc(l.pk));
}
async function applyFridgeLock(it) {
  const note = $("#fridgeLockNote"),
    buy = $("#fridgeBuy");
  if (note) note.style.display = "none";
  if (buy) {
    buy.style.display = "none";
    buy.innerHTML = "";
  }
  await achatReadyPromise;
  await pretsReadyPromise; // applyItemMode a fini de régler le bloc quantité
  if (CURRENT !== it || !isFridgeLoc(it.location)) return;
  // non-admin : pas de section stock (les admins la gardent, sous l'achat)
  if (!ACHAT.admin) $("#qtyBlock").style.display = "none";
  // article du frigo scanné : achat direct, pour tout le monde
  let p = null;
  if (ACHAT.enabled) {
    try {
      const f = await api("/plugin/paiements/fridge");
      p = (f.products || []).find((x) => x.part === it.part && x.buyable) || null;
    } catch (_) {}
  }
  if (CURRENT !== it) return;
  if (!p || !p.available) {
    // pas en vente (pas de prix, épuisé) : simple mention pour un membre
    if (note && !ACHAT.admin) note.style.display = "";
    return;
  }
  renderFridgeBuy(buy, p);
  prefetchSumup();
}

/* bloc « Acheter » de la fiche d'un article du frigo : quantité prise, Payer */
function renderFridgeBuy(box, p) {
  let q = 1;
  box.innerHTML =
    '<div class="buy-top"><span class="buy-title">🧊 ' + esc(t("frigo_buy_title")) + "</span>" +
    '<span class="buy-price">' + esc(eur(p.unit_price)) + "</span></div>" +
    '<div class="buy-qlbl">' + esc(t("frigo_buy_qty")) + "</div>" +
    '<div class="buy-qty"><button type="button" data-d="-1" aria-label="−">−</button><b></b>' +
    '<button type="button" data-d="1" aria-label="+">+</button></div>' +
    '<button class="btn btn-primary" data-pay></button>' +
    '<div class="buy-left">' + esc(t("frigo_left", p.available)) + "</div>";
  const pay = box.querySelector("[data-pay]");
  const sync = () => {
    box.querySelector(".buy-qty b").textContent = q;
    box.querySelector('[data-d="-1"]').disabled = q <= 1;
    box.querySelector('[data-d="1"]').disabled = q >= p.available;
    pay.textContent = t("buy_btn", eurCents(p.unit_cents * q));
  };
  box.querySelectorAll(".buy-qty button").forEach((b) => {
    b.onclick = () => {
      q = Math.min(p.available, Math.max(1, q + Number(b.dataset.d)));
      sync();
    };
  });
  pay.onclick = async () => {
    pay.disabled = true;
    pay.innerHTML = '<span class="spin"></span>';
    await payCheckout({ lines: [{ part: p.part, quantity: q }] }, [
      { name: p.name, quantity: q, total: eurCents(p.unit_cents * q) },
    ]);
    pay.disabled = false;
    sync();
  };
  sync();
  box.style.display = "";
}
function syncCreatePrice() {
  const f = $("#fldPrice");
  if (!f) return;
  const on = ACHAT.admin && isFridgeLoc($("#np_loc_btn").dataset.value);
  f.style.display = on ? "" : "none";
  if (!on) $("#np_price").value = "";
  if (on && !f.dataset.armed) {
    f.dataset.armed = "1";
    $("#np_price_chips").innerHTML = priceChipsHtml();
    armPriceChips($("#np_price_chips"), $("#np_price"));
  }
}
/* après création / ajout : pose le prix saisi (échec signalé, jamais bloquant) */
async function saveCreatePrice(partPk) {
  const f = $("#fldPrice");
  const v = $("#np_price") ? $("#np_price").value.trim() : "";
  if (!f || f.style.display === "none" || !v) return;
  try {
    await api("/plugin/paiements/fridge/price", { method: "POST", body: { part: partPk, price: v } });
  } catch (e) {
    toast(t("frigo_price_fail", e.message), "bad");
  }
}

/* ---- page de connexion en mode frigo (avant authentification) ---- */
function applyFrigoLogin() {
  document.body.classList.add("frigo-mode");
}
