/* ==========================================================================
   features/achat.js — Achats (plugin inventree-paiements) : paiement, reçu, « Mes achats ».

   Socle commun au frigo (features/frigo.js, panier de plusieurs produits) et
   à la fiche article (bloc « Acheter » d'un article vendable) :
   - payCheckout(body) crée le paiement côté serveur (prix recalculés là-bas) ;
     SumUp : le formulaire de carte (Payment Widget, Apple Pay / Google Pay)
     s'ouvre dans une fenêtre par-dessus la Scannette ; HelloAsso : redirection
     vers sa page, retour sur ?achat=<pk> ;
   - openReceipt(pk) affiche le reçu : le serveur vérifie d'abord le paiement
     auprès du prestataire, retire le stock, envoie le reçu par e-mail ;
   - plugin absent ou non configuré -> aucun bouton, rien ne change.
   ========================================================================== */

const ACHAT = { enabled: false, provider: "", test: false, googlePay: null, fridge: null, admin: false };
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
    ACHAT.googlePay = c.google_pay || null;
    ACHAT.fridge = c.fridge || null;
    ACHAT.admin = !!c.admin;
  } catch (_) {
    ACHAT.enabled = false; // plugin non installé : pas de bouton
  }
  // raccourci « Frigo » de l'écran de scan
  const fb = $("#frigoOpenBtn");
  if (fb) fb.style.display = ACHAT.fridge ? "" : "none";
  achatReadyResolve();
}

function eur(s) {
  return String(s).replace(".", ",") + " €";
}
function eurCents(c) {
  return eur((c / 100).toFixed(2));
}

/* ---- bloc « Acheter » de la fiche article (appelé par renderItem) ---- */
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
  let q = 1;
  box.innerHTML =
    '<div class="buy-top"><span class="buy-title">' + esc(t("buy_title")) + "</span>" +
    (ACHAT.test ? '<span class="pill">' + esc(t("buy_test")) + "</span>" : "") +
    '<span class="buy-price">' + esc(eur(o.unit_price)) + "</span></div>" +
    (o.max_quantity > 1
      ? '<div class="buy-qty"><button id="buyMinus" aria-label="−">−</button><b id="buyQty">1</b><button id="buyPlus" aria-label="+">+</button></div>'
      : "") +
    '<button class="btn btn-primary" id="buyBtn"></button>' +
    (o.in_fridge && ACHAT.fridge
      ? '<button class="btn btn-ghost btn-block" id="buyFridgeBtn">' + esc(t("buy_open_fridge")) + "</button>"
      : "") +
    (ACHAT.provider === "helloasso" ? '<p class="buy-note">' + esc(t("buy_note_ha")) + "</p>" : "");
  box.style.display = "";
  const sync = () => {
    if ($("#buyQty")) $("#buyQty").textContent = q;
    $("#buyBtn").textContent = t("buy_btn", eurCents(o.unit_cents * q));
  };
  if ($("#buyMinus")) {
    $("#buyMinus").onclick = () => ((q = Math.max(1, q - 1)), sync());
    $("#buyPlus").onclick = () => ((q = Math.min(o.max_quantity, q + 1)), sync());
  }
  $("#buyBtn").onclick = async () => {
    const btn = $("#buyBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> ' + t("buy_preparing");
    await payCheckout({ lines: [{ stock_item: it.pk, quantity: q }] }, [
      { name: o.name, quantity: q, total: eurCents(o.unit_cents * q) },
    ]);
    if (CURRENT === it && $("#buyBtn")) {
      btn.disabled = false;
      sync();
    }
  };
  if ($("#buyFridgeBtn")) $("#buyFridgeBtn").onclick = () => openFrigo();
  sync();
}

/* ---- paiement ----
   body : panier pour POST /plugin/paiements/checkout ; recap : lignes à
   rappeler dans la fenêtre de paiement [{name, quantity, total}].
   Résout quand la fenêtre se ferme (payé -> le reçu a pris le relais). */
async function payCheckout(body, recap) {
  let r;
  try {
    r = await api("/plugin/paiements/checkout", { method: "POST", body });
  } catch (e) {
    toast(e.message, "bad");
    return false;
  }
  if (r.redirect_url) {
    // HelloAsso : page de paiement externe, retour sur ?achat=<pk>
    window.location.href = r.redirect_url;
    return new Promise(() => {}); // la page s'en va
  }
  try {
    await loadSumupSdk();
  } catch (e) {
    toast(e.message, "bad");
    return false;
  }
  return openPaySheet(r, recap);
}

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

/* fenêtre de paiement SumUp : récap du panier + formulaire de carte */
function openPaySheet(r, recap) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "modal-ov pay-ov";
    ov.innerHTML =
      '<div class="modal-card pay-sheet" role="dialog" aria-modal="true">' +
      '<div class="pay-head"><h3>' + esc(t("buy_pay_title")) + "</h3>" +
      '<button class="iconbtn" id="payClose" aria-label="' + esc(t("cancel")) + '">✕</button></div>' +
      '<div class="pay-recap">' +
      recap
        .map(
          (l) =>
            '<div class="pay-line"><span><b>' + l.quantity + " ×</b> " + esc(l.name) +
            "</span><span>" + esc(l.total) + "</span></div>",
        )
        .join("") +
      '<div class="pay-line pay-total"><span>' + esc(t("buy_total")) + "</span><span>" +
      esc(r.total) + "</span></div></div>" +
      '<div id="sumupCard"></div>' +
      '<p class="buy-note">🔒 ' + esc(t("buy_secure")) + "</p></div>";
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    let closed = false;
    const close = (paid) => {
      if (closed) return;
      closed = true;
      document.body.style.overflow = prevOverflow;
      ov.classList.add("closing");
      setTimeout(() => ov.remove(), 180);
      try {
        window.SumUpCard && window.SumUpCard.unmount && window.SumUpCard.unmount();
      } catch (_) {}
      resolve(paid);
    };
    // fermer sans payer : le checkout expire seul chez SumUp, l'achat reste
    // « en attente » et ne retire rien
    ov.querySelector("#payClose").onclick = () => close(false);
    document.body.appendChild(ov);
    const opts = {
      id: "sumupCard",
      checkoutId: r.checkout_id,
      locale: LANG === "fr" ? "fr-FR" : "en-GB",
      onResponse: (type) => {
        // success = SumUp a accepté ; le serveur le revérifie avant de retirer le stock
        if (type === "success") {
          close(true);
          openReceipt(r.purchase, true);
        } else if (type === "fail" || type === "error") {
          toast(t("buy_refused"), "bad");
        }
      },
    };
    // Google Pay : bouton ajouté seulement si un identifiant marchand Google est
    // réglé. Apple Pay n'a pas d'option : SumUp l'affiche dans Safari dès que le
    // domaine est validé dans le profil SumUp (fichier .well-known publié).
    if (ACHAT.googlePay) opts.googlePay = ACHAT.googlePay;
    window.SumUpCard.mount(opts);
  });
}

/* ---- reçu ----
   fresh : on sort du paiement à l'instant -> la confirmation du prestataire
   peut avoir quelques secondes de retard, on relit l'état plusieurs fois */
async function openReceipt(pk, fresh) {
  rememberView("receipt", pk);
  show("#screen-receipt");
  const box = $("#receiptBody");
  box.innerHTML = '<div class="skeleton">' + esc(t("buy_checking")) + "</div>";
  let p = null;
  for (let i = 0; i < (fresh ? 6 : 1); i++) {
    try {
      p = await api("/plugin/paiements/purchase/" + pk);
    } catch (e) {
      toast(e.message, "bad");
      gotoScan();
      return;
    }
    if (p.status === "paid") break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (p.status === "paid") {
    // le panier du frigo a été payé : on le vide
    if (p.source === "frigo") frigoCartClear();
    if (fresh) toast(t("buy_paid_toast"), "ok");
  }
  renderReceipt(p);
  // reçu e-mail envoyé en tâche de fond : on rafraîchit la mention une fois
  if (p.status === "paid" && !p.receipt_sent_to)
    setTimeout(async () => {
      try {
        const q = await api("/plugin/paiements/purchase/" + pk);
        if (q.receipt_sent_to && $("#rcptMail")) $("#rcptMail").textContent = t("rcpt_sent", q.receipt_sent_to);
      } catch (_) {}
    }, 5000);
}

function renderReceipt(p) {
  const paid = p.status === "paid";
  const box = $("#receiptBody");
  box.innerHTML =
    '<div class="rcpt-hero ' + (paid ? "ok" : "wait") + '">' +
    '<div class="ring">' + (paid ? CHECK : "…") + "</div>" +
    "<h2>" + esc(paid ? t("rcpt_thanks") : t("buy_unpaid")) + "</h2>" +
    "<p>" + esc(paid ? t("rcpt_show") : t("buy_unpaid_warn")) + "</p></div>" +
    '<div class="card rcpt">' +
    '<div class="rcpt-top"><div><div class="rcpt-no">' + esc(t("rcpt_no", p.pk)) + "</div>" +
    '<div class="rcpt-meta">' + esc(t("rcpt_when", p.date, p.time)) + "</div>" +
    '<div class="rcpt-meta">' + esc(p.buyer) + "</div></div>" +
    '<span class="rcpt-badge ' + (paid ? "ok" : "wait") + '">' + esc(paid ? t("rcpt_paid") : t("rcpt_pending")) + "</span></div>" +
    '<div class="rcpt-lines">' +
    p.lines
      .map(
        (l) =>
          '<div class="rcpt-line"><span class="q">' + l.quantity + "×</span><span class=\"n\">" + esc(l.name) +
          '</span><span class="p">' + esc(l.total) + "</span></div>",
      )
      .join("") +
    "</div>" +
    '<div class="rcpt-total"><span>' + esc(t("buy_total")) + "</span><span>" + esc(p.total) + "</span></div>" +
    '<div class="rcpt-pay">' + esc(p.provider) + (p.payment_ref ? " · " + esc(p.payment_ref) : "") + "</div>" +
    (p.warning ? '<div class="rcpt-warn">⚠ ' + esc(p.warning) + "</div>" : "") +
    "</div>" +
    (paid
      ? '<button class="btn btn-primary btn-block" id="rcptPdf">' + esc(t("rcpt_download")) + "</button>" +
        '<button class="btn btn-ghost btn-block" id="rcptMailBtn">' + esc(t("rcpt_resend")) + "</button>" +
        '<p class="rcpt-mail" id="rcptMail">' +
        esc(p.receipt_sent_to ? t("rcpt_sent", p.receipt_sent_to) : t("rcpt_sending")) + "</p>"
      : '<button class="btn btn-ghost btn-block" id="rcptRetry">' + esc(t("retry")) + "</button>") +
    (p.source === "frigo" && ACHAT.fridge
      ? '<button class="btn btn-ghost btn-block" id="rcptFridge">' + esc(t("rcpt_back_fridge")) + "</button>"
      : '<button class="btn btn-ghost btn-block" id="rcptScan">' + esc(t("scan_another")) + "</button>");
  if ($("#rcptPdf")) $("#rcptPdf").onclick = () => downloadReceipt(p.pk, $("#rcptPdf"));
  if ($("#rcptMailBtn")) $("#rcptMailBtn").onclick = () => resendReceipt(p.pk, $("#rcptMailBtn"));
  if ($("#rcptRetry")) $("#rcptRetry").onclick = () => openReceipt(p.pk, true);
  if ($("#rcptFridge")) $("#rcptFridge").onclick = () => openFrigo();
  if ($("#rcptScan")) $("#rcptScan").onclick = () => gotoScan();
}

/* le PDF est protégé par le token : téléchargement via fetch + blob */
async function downloadReceipt(pk, btn) {
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  try {
    const res = await fetch(API + "/plugin/paiements/purchase/" + pk + "/receipt.pdf", {
      headers: TOKEN ? { Authorization: "Token " + TOKEN } : {},
    });
    if (!res.ok) throw new Error(t("error_n", res.status));
    const blob = await res.blob();
    const m = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : "recu-" + pk + ".pdf";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
  } catch (e) {
    toast(e.message || t("net_get"), "bad");
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}

async function resendReceipt(pk, btn) {
  btn.disabled = true;
  try {
    const r = await api("/plugin/paiements/purchase/" + pk + "/email", { method: "POST" });
    toast(t("rcpt_sent", r.sent_to), "ok");
    if ($("#rcptMail")) $("#rcptMail").textContent = t("rcpt_sent", r.sent_to);
  } catch (e) {
    toast(e.message, "bad");
  } finally {
    btn.disabled = false;
  }
}

/* ---- « Mes achats » ---- */
async function openPurchases() {
  rememberView("purchases");
  show("#screen-purchases");
  const box = $("#purchasesList");
  box.innerHTML = '<div class="skeleton">' + esc(t("loading")) + "</div>";
  let list;
  try {
    list = await api("/plugin/paiements/purchases");
  } catch (e) {
    box.innerHTML = '<div class="skeleton">' + esc(e.message) + "</div>";
    return;
  }
  if (!list.length) {
    box.innerHTML = '<div class="skeleton">' + esc(t("purch_empty")) + "</div>";
    return;
  }
  box.innerHTML = "";
  list.forEach((p) => {
    const row = document.createElement("button");
    row.className = "purch-row";
    row.innerHTML =
      '<div class="pm"><div class="t">' + esc(t("rcpt_no", p.pk)) + " · " + esc(p.date) + " " + esc(p.time) +
      '</div><div class="s">' +
      esc(p.lines.map((l) => (l.quantity > 1 ? l.quantity + "× " : "") + l.name).join(", ")) +
      '</div></div><div class="pt">' + esc(p.total) + "</div>";
    row.onclick = () => openReceipt(p.pk, false);
    box.appendChild(row);
  });
}
