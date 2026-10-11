/* ==========================================================================
   features/achat.js — Achat d'un article vendable via HelloAsso (plugin inventree-helloasso).

   - plugin absent ou non configuré (pas de /plugin/helloasso/config enabled)
     -> aucun bouton, la fiche reste inchangée ;
   - article vendable (part « Vendable » + prix de vente) -> bloc « Acheter »
     au-dessus du comptage : quantité + bouton, redirection vers HelloAsso ;
   - retour de HelloAsso sur ?achat=<pk> -> écran de résultat, le serveur
     vérifie le paiement auprès de HelloAsso avant de retirer le stock.
   Le prix affiché vient du serveur, qui le recalcule de toute façon au paiement.
   ========================================================================== */

const ACHAT = { enabled: false, sandbox: false };
let achatReadyResolve = null;
const achatReadyPromise = new Promise((r) => (achatReadyResolve = r));
let BUY_OFFER = null;

async function loadAchatConfig() {
  try {
    const c = await api("/plugin/helloasso/config");
    ACHAT.enabled = !!c.enabled;
    ACHAT.sandbox = c.env === "sandbox";
  } catch (_) {
    ACHAT.enabled = false; // plugin non installé : pas de bouton
  }
  achatReadyResolve();
}

function eur(s) {
  return String(s).replace(".", ",") + " €";
}

/* bloc « Acheter » de la fiche article (appelé par renderItem) */
async function applyBuyBlock(it) {
  const box = $("#buyBlock");
  box.style.display = "none";
  box.innerHTML = "";
  BUY_OFFER = null;
  await achatReadyPromise;
  if (!ACHAT.enabled || CURRENT !== it) return;
  if (it.part_detail && it.part_detail.trackable) return; // objets prêtés : jamais vendus
  let o;
  try {
    o = await api("/plugin/helloasso/item/" + it.pk);
  } catch (_) {
    return; // pas d'offre lisible : la fiche reste utilisable sans achat
  }
  if (CURRENT !== it || !o.buyable) return;
  BUY_OFFER = o;
  box.innerHTML =
    '<div class="buy-top"><span class="buy-title">' + esc(t("buy_title")) + "</span>" +
    (ACHAT.sandbox ? '<span class="pill">' + esc(t("buy_test")) + "</span>" : "") +
    '<span class="buy-price">' + esc(eur(o.unit_price)) + "</span></div>" +
    (o.max_quantity > 1
      ? '<div class="buy-qty"><button id="buyMinus">−</button><b id="buyQty">1</b><button id="buyPlus">+</button></div>'
      : "") +
    '<button class="btn btn-primary" id="buyBtn"></button>' +
    '<p class="buy-note">' + esc(t("buy_note")) + "</p>";
  box.style.display = "";
  const qtyEl = $("#buyQty");
  const sync = () => {
    const q = qtyEl ? parseInt(qtyEl.textContent, 10) : 1;
    $("#buyBtn").textContent = t("buy_btn", eur(((o.unit_cents * q) / 100).toFixed(2)));
  };
  if (qtyEl) {
    const stepQ = (d) => {
      const q = Math.min(o.max_quantity, Math.max(1, parseInt(qtyEl.textContent, 10) + d));
      qtyEl.textContent = q;
      sync();
    };
    $("#buyMinus").onclick = () => stepQ(-1);
    $("#buyPlus").onclick = () => stepQ(1);
  }
  $("#buyBtn").onclick = () => startBuy(it, qtyEl ? parseInt(qtyEl.textContent, 10) : 1);
  sync();
}

async function startBuy(it, qty) {
  const btn = $("#buyBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> ' + t("buy_redirect");
  try {
    const r = await api("/plugin/helloasso/checkout", {
      method: "POST",
      body: { stock_item: it.pk, quantity: qty },
    });
    // page de paiement HelloAsso, retour sur ?achat=<pk>
    window.location.href = r.redirect_url;
  } catch (e) {
    toast(e.message, "bad");
    btn.disabled = false;
    if (BUY_OFFER) btn.textContent = t("buy_btn", eur(((BUY_OFFER.unit_cents * qty) / 100).toFixed(2)));
  }
}

/* retour de HelloAsso : le paiement peut être confirmé avec quelques secondes
   de retard, on relit donc l'état plusieurs fois avant de conclure */
async function openPurchaseResult(pk) {
  show("#screen-item");
  $("#itemBody").style.display = "none";
  $("#chooseBody").style.display = "none";
  $("#done").classList.remove("show");
  toast(t("buy_checking"));
  let p = null;
  for (let i = 0; i < 5; i++) {
    try {
      p = await api("/plugin/helloasso/purchase/" + pk);
    } catch (e) {
      toast(e.message, "bad");
      gotoScan();
      return;
    }
    if (p.status === "paid") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const qty = fmt(p.quantity) + " · " + eur(p.amount);
  if (p.status === "paid") {
    showDone(t("buy_paid"), p.item_name, qty, p.warning || "");
    toast(t("buy_paid_toast"), "ok");
  } else {
    showDone(t("buy_unpaid"), p.item_name, qty, t("buy_unpaid_warn"));
  }
}
