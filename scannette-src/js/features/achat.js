/* ==========================================================================
   features/achat.js — Achat d'un article vendable (plugin inventree-paiements).

   - plugin absent ou non configuré (pas de /plugin/paiements/config enabled)
     -> aucun bouton, la fiche reste inchangée ;
   - article vendable (part « Vendable » + prix de vente) -> bloc « Acheter »
     au-dessus du comptage : quantité + bouton Payer ;
   - SumUp : le formulaire de carte (Payment Widget, Apple Pay / Google Pay)
     s'ouvre DANS le bloc, sans quitter la Scannette ;
   - HelloAsso : redirection vers sa page, retour sur ?achat=<pk>.
   Dans tous les cas l'écran de résultat interroge le serveur, qui vérifie le
   paiement auprès du prestataire avant de retirer le stock. Le prix affiché
   vient du serveur, qui le recalcule de toute façon au paiement.
   ========================================================================== */

const ACHAT = { enabled: false, provider: "", test: false };
let achatReadyResolve = null;
const achatReadyPromise = new Promise((r) => (achatReadyResolve = r));
let BUY_OFFER = null;

const SUMUP_SDK = "https://gateway.sumup.com/gateway/ecom/card/v2/sdk.js";
let sumupSdkPromise = null;

async function loadAchatConfig() {
  try {
    const c = await api("/plugin/paiements/config");
    ACHAT.enabled = !!c.enabled;
    ACHAT.provider = c.provider || "";
    ACHAT.test = !!c.test;
  } catch (_) {
    ACHAT.enabled = false; // plugin non installé : pas de bouton
  }
  achatReadyResolve();
}

function eur(s) {
  return String(s).replace(".", ",") + " €";
}
function buyTotal(o, q) {
  return eur(((o.unit_cents * q) / 100).toFixed(2));
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
    o = await api("/plugin/paiements/item/" + it.pk);
  } catch (_) {
    return; // pas d'offre lisible : la fiche reste utilisable sans achat
  }
  if (CURRENT !== it || !o.buyable) return;
  BUY_OFFER = o;
  renderBuyOffer(it, o, 1);
}

function renderBuyOffer(it, o, q0) {
  const box = $("#buyBlock");
  box.innerHTML =
    '<div class="buy-top"><span class="buy-title">' + esc(t("buy_title")) + "</span>" +
    (ACHAT.test ? '<span class="pill">' + esc(t("buy_test")) + "</span>" : "") +
    '<span class="buy-price">' + esc(eur(o.unit_price)) + "</span></div>" +
    (o.max_quantity > 1
      ? '<div class="buy-qty"><button id="buyMinus">−</button><b id="buyQty">' + q0 +
        '</b><button id="buyPlus">+</button></div>'
      : "") +
    '<button class="btn btn-primary" id="buyBtn"></button>' +
    (ACHAT.provider === "helloasso" ? '<p class="buy-note">' + esc(t("buy_note_ha")) + "</p>" : "");
  box.style.display = "";
  const qtyEl = $("#buyQty");
  const qty = () => (qtyEl ? parseInt(qtyEl.textContent, 10) : 1);
  const sync = () => ($("#buyBtn").textContent = t("buy_btn", buyTotal(o, qty())));
  if (qtyEl) {
    const stepQ = (d) => {
      qtyEl.textContent = Math.min(o.max_quantity, Math.max(1, qty() + d));
      sync();
    };
    $("#buyMinus").onclick = () => stepQ(-1);
    $("#buyPlus").onclick = () => stepQ(1);
  }
  $("#buyBtn").onclick = () => startBuy(it, qty());
  sync();
}

async function startBuy(it, qty) {
  const btn = $("#buyBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> ' + t("buy_preparing");
  let r;
  try {
    r = await api("/plugin/paiements/checkout", {
      method: "POST",
      body: { stock_item: it.pk, quantity: qty },
    });
  } catch (e) {
    toast(e.message, "bad");
    btn.disabled = false;
    if (BUY_OFFER) btn.textContent = t("buy_btn", buyTotal(BUY_OFFER, qty));
    return;
  }
  if (r.redirect_url) {
    // HelloAsso : page de paiement externe, retour sur ?achat=<pk>
    window.location.href = r.redirect_url;
    return;
  }
  openSumupCard(it, qty, r);
}

/* ---- SumUp : formulaire de carte dans le bloc ---- */
function loadSumupSdk() {
  if (window.SumUpCard) return Promise.resolve();
  if (!sumupSdkPromise) {
    sumupSdkPromise = new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = SUMUP_SDK;
      s.onload = ok;
      s.onerror = () => {
        sumupSdkPromise = null; // nouvel essai possible au prochain clic
        ko(new Error(t("buy_sdk_fail")));
      };
      document.head.appendChild(s);
    });
  }
  return sumupSdkPromise;
}

async function openSumupCard(it, qty, r) {
  const box = $("#buyBlock");
  try {
    await loadSumupSdk();
  } catch (e) {
    toast(e.message, "bad");
    renderBuyOffer(it, BUY_OFFER, qty);
    return;
  }
  if (CURRENT !== it) return;
  box.innerHTML =
    '<div class="buy-top"><span class="buy-title">' + esc(t("buy_pay_title")) + "</span>" +
    '<span class="buy-price">' + esc(buyTotal(BUY_OFFER, qty)) + "</span></div>" +
    '<div id="sumupCard"></div>' +
    '<button class="btn btn-ghost btn-block" id="buyCancel">' + esc(t("cancel")) + "</button>";
  // le checkout non payé expire seul chez SumUp ; l'achat reste « en attente »
  $("#buyCancel").onclick = () => renderBuyOffer(it, BUY_OFFER, qty);
  let done = false;
  window.SumUpCard.mount({
    id: "sumupCard",
    checkoutId: r.checkout_id,
    locale: LANG === "fr" ? "fr-FR" : "en-GB",
    onResponse: (type) => {
      // success = SumUp a accepté ; le serveur le revérifie avant de retirer le stock
      if (type === "success" && !done) {
        done = true;
        openPurchaseResult(r.purchase);
      } else if (type === "fail" || type === "error") {
        toast(t("buy_refused"), "bad");
      }
    },
  });
}

/* écran de résultat : retour HelloAsso (?achat=<pk>) ou fin du formulaire
   SumUp. La confirmation du prestataire peut arriver avec quelques secondes
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
      p = await api("/plugin/paiements/purchase/" + pk);
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
