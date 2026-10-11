/* ==========================================================================
   features/achat.js — Paiement SumUp du panier du frigo, reçu, « Mes achats » (plugin inventree-paiements).

   - payCheckout(body) crée le paiement côté serveur (prix recalculés là-bas)
     et ouvre la feuille de paiement : formulaire SumUp (Payment Widget,
     Apple Pay / Google Pay) dans la Scannette ;
   - openReceipt(pk) affiche le reçu : le serveur vérifie d'abord le paiement
     auprès de SumUp, retire le stock, envoie le reçu par e-mail. Aussi
     appelé au retour d'une étape 3-D Secure en pleine page (?achat=<pk>) ;
   - plugin absent ou non configuré -> le frigo l'annonce, rien d'autre ne change.
   ========================================================================== */

const ACHAT = { enabled: false, googlePay: null, fridge: null, admin: false };
let achatReadyResolve = null;
const achatReadyPromise = new Promise((r) => (achatReadyResolve = r));

const SUMUP_SDK = "https://gateway.sumup.com/gateway/ecom/card/v2/sdk.js";
let sumupSdkPromise = null;

async function loadAchatConfig() {
  try {
    const c = await api("/plugin/paiements/config");
    ACHAT.enabled = !!c.enabled;
    ACHAT.googlePay = c.google_pay || null;
    ACHAT.fridge = c.fridge || null;
    ACHAT.admin = !!c.admin;
  } catch (_) {
    ACHAT.enabled = false; // plugin non installé
  }
  achatReadyResolve();
}

function eur(s) {
  return String(s).replace(".", ",") + " €";
}
function eurCents(c) {
  return eur((c / 100).toFixed(2));
}

/* ---- paiement ----
   body : panier pour POST /plugin/paiements/checkout ; recap : lignes à
   rappeler dans la feuille de paiement [{name, quantity, total}].
   Résout quand la feuille se ferme (payé -> le reçu a pris le relais). */
async function payCheckout(body, recap) {
  let r;
  try {
    r = await api("/plugin/paiements/checkout", { method: "POST", body });
  } catch (e) {
    toast(e.message, "bad");
    return false;
  }
  // la feuille s'ouvre tout de suite ; le formulaire s'y monte dès que le
  // script SumUp est là (préchargé à l'ouverture du frigo / de la fiche)
  return openPaySheet(r, recap);
}

/* préchargement silencieux du script SumUp à l'ouverture du frigo */
function prefetchSumup() {
  if (ACHAT.enabled) loadSumupSdk().catch(() => {});
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

/* feuille de paiement SumUp : montant en tête, détail du panier repliable,
   formulaire de carte (Payment Widget) dans sa propre carte. Plein écran sur
   téléphone (glisse du bas), fenêtre centrée sur grand écran. */
function openPaySheet(r, recap) {
  return new Promise((resolve) => {
    const n = recap.reduce((s, l) => s + l.quantity, 0);
    const ov = document.createElement("div");
    ov.className = "modal-ov pay-ov";
    ov.innerHTML =
      '<div class="pay-sheet" role="dialog" aria-modal="true" aria-label="' + esc(t("buy_pay_title")) + '">' +
      '<div class="pay-head">' +
      '<div><div class="pay-k">' + esc(t("buy_pay_title")) + "</div>" +
      '<div class="pay-amt">' + esc(r.total) + "</div></div>" +
      '<button class="iconbtn" id="payClose" aria-label="' + esc(t("cancel")) + '">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>' +
      '<details class="pay-recap"' + (recap.length <= 2 ? " open" : "") + ">" +
      "<summary><span>" + esc(t("frigo_cart_n", n)) + '</span><span class="pay-more">' + esc(t("buy_details")) + "</span></summary>" +
      recap
        .map(
          (l) =>
            '<div class="pay-line"><span class="q">' + l.quantity + '×</span><span class="nm">' + esc(l.name) +
            '</span><span class="pr">' + esc(l.total) + "</span></div>",
        )
        .join("") +
      "</details>" +
      '<div class="pay-widget"><div id="sumupCard"><div class="skeleton">' + esc(t("loading")) + "</div></div></div>" +
      '<p class="pay-note">' + esc(t("buy_secure")) + "</p></div>";
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    let closed = false;
    const close = (paid) => {
      if (closed) return;
      closed = true;
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      ov.classList.add("closing");
      setTimeout(() => ov.remove(), 220);
      try {
        window.SumUpCard && window.SumUpCard.unmount && window.SumUpCard.unmount();
      } catch (_) {}
      resolve(paid);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
    };
    // fermer sans payer : le checkout expire seul chez SumUp, l'achat reste
    // « en attente » et ne retire rien
    ov.querySelector("#payClose").onclick = () => close(false);
    ov.addEventListener("click", (e) => {
      if (e.target === ov) close(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
    const opts = {
      id: "sumupCard",
      checkoutId: r.checkout_id,
      locale: LANG === "fr" ? "fr-FR" : "en-GB",
      // le bouton du formulaire affiche le montant (« Payer 2,00 € »)
      amount: (r.amount_cents / 100).toFixed(2),
      currency: "EUR",
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
    // Google Pay : identifiant marchand Google réglé dans le plugin (sinon le
    // réglage SumUp par défaut). Apple Pay n'a pas d'option : SumUp l'affiche dans Safari dès que le
    // domaine est validé dans le profil SumUp (fichier .well-known publié).
    if (ACHAT.googlePay) opts.googlePay = ACHAT.googlePay;
    loadSumupSdk()
      .then(() => {
        if (closed) return;
        $("#sumupCard").innerHTML = "";
        window.SumUpCard.mount(opts);
      })
      .catch((e) => {
        toast(e.message, "bad");
        close(false);
      });
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
    frigoCartClear(); // le panier a été payé : on le vide
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
    '<button class="btn btn-ghost btn-block" id="rcptFridge">' + esc(t("rcpt_back_fridge")) + "</button>";
  if ($("#rcptPdf")) $("#rcptPdf").onclick = () => downloadReceipt(p.pk, $("#rcptPdf"));
  if ($("#rcptMailBtn")) $("#rcptMailBtn").onclick = () => resendReceipt(p.pk, $("#rcptMailBtn"));
  if ($("#rcptRetry")) $("#rcptRetry").onclick = () => openReceipt(p.pk, true);
  $("#rcptFridge").onclick = () => openFrigo();
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
