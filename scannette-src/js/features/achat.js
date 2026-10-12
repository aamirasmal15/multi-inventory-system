/* ==========================================================================
   features/achat.js — Paiement SumUp du panier du frigo, reçu, « Mes achats » (plugin inventree-paiements).

   - payCheckout(body) crée le paiement côté serveur (prix recalculés là-bas)
     et ouvre la feuille de paiement : formulaire SumUp (Payment Widget,
     Apple Pay / Google Pay) dans la Scannette ;
   - openReceipt(pk) affiche le reçu : le serveur vérifie d'abord le paiement
     auprès de SumUp, retire le stock, envoie le reçu par e-mail. Aussi
     appelé au retour d'une étape 3-D Secure en pleine page (?achat=<pk>) ;
   - portefeuille : SumUp refuse la carte sous 1 €, d'où un solde rechargé par
     carte (1 € min.) puis débité à chaque achat, jamais négatif (verrou
     serveur). payChoice() choisit : portefeuille s'il suffit, sinon carte si
     le panier fait 1 € ou plus, sinon recharge (openWalletSheet) ;
   - plugin absent ou non configuré -> le frigo l'annonce, rien d'autre ne change.
   ========================================================================== */

const ACHAT = {
  enabled: false, // frigo ouvert (achat au portefeuille possible)
  card: false, // paiement par carte configuré (achat direct, recharge)
  googlePay: null,
  fridge: null,
  admin: false,
  wallet: 0,
  minCard: 100,
  topupMin: 100,
  topupMax: 99999,
  provider: "sumup", // "sumup" : formulaire dans la Scannette ; "helloasso" : page HelloAsso
  canTap: false, // encaisser des recharges en Tap to Pay (bureau, treso.js)
};
let achatReadyResolve = null;
const achatReadyPromise = new Promise((r) => (achatReadyResolve = r));

const SUMUP_SDK = "https://gateway.sumup.com/gateway/ecom/card/v2/sdk.js";
let sumupSdkPromise = null;

async function loadAchatConfig() {
  try {
    const c = await api("/plugin/paiements/config");
    ACHAT.enabled = !!c.enabled;
    ACHAT.card = !!c.card;
    ACHAT.googlePay = c.google_pay || null;
    ACHAT.fridge = c.fridge || null;
    ACHAT.admin = !!c.admin;
    ACHAT.minCard = c.min_card_cents || 100;
    ACHAT.topupMin = c.topup_min_cents || 100;
    ACHAT.topupMax = c.topup_max_cents || 99999;
    ACHAT.provider = c.provider || "sumup";
    ACHAT.canTap = !!c.can_tap;
  } catch (_) {
    ACHAT.enabled = false; // plugin non installé
  }
  // raccourci « Le frigo » en bas de l'écran principal
  const fb = $("#frigoOpenBtn");
  if (fb) fb.style.display = ACHAT.fridge ? "" : "none";
  achatReadyResolve();
}

/* verrou du défilement pendant une feuille (paiement, prix) : overflow:hidden
   ne suffit pas sur iOS, la page derrière défile quand même. On fige le body
   à sa position (position:fixed + top négatif) puis on la rend à la fermeture. */
let SCROLL_LOCK = null;
function lockScroll() {
  if (SCROLL_LOCK) return;
  const y = window.scrollY || 0;
  const b = document.body.style;
  SCROLL_LOCK = { y, prev: { position: b.position, top: b.top, left: b.left, right: b.right, width: b.width, overflow: b.overflow } };
  Object.assign(b, { position: "fixed", top: -y + "px", left: "0", right: "0", width: "100%", overflow: "hidden" });
}
function unlockScroll() {
  if (!SCROLL_LOCK) return;
  Object.assign(document.body.style, SCROLL_LOCK.prev);
  window.scrollTo(0, SCROLL_LOCK.y);
  SCROLL_LOCK = null;
}

function eur(s) {
  return String(s).replace(".", ",") + " €";
}
function eurCents(c) {
  return eur((c / 100).toFixed(2));
}

/* ---- portefeuille ---- */
function setWallet(cents) {
  ACHAT.wallet = Number(cents) || 0;
  document.querySelectorAll("[data-wallet-bal]").forEach((el) => (el.textContent = eurCents(ACHAT.wallet)));
}
async function walletRefresh() {
  try {
    const w = await api("/plugin/paiements/wallet");
    setWallet(w.balance_cents);
    return w;
  } catch (_) {
    return null;
  }
}

/* moyen de paiement d'un montant : "wallet" | "card" | "topup" ; sans carte
   configurée, seul le portefeuille existe ("topup" mène alors au trésorier) */
function payChoice(cents) {
  if (ACHAT.wallet >= cents) return "wallet";
  if (ACHAT.card && cents >= ACHAT.minCard) return "card";
  return "topup";
}
/* libellé du bouton principal pour ce montant */
function payLabel(cents) {
  const c = payChoice(cents);
  return c === "wallet" ? t("wal_pay_btn", eurCents(cents)) : c === "card" ? t("buy_btn", eurCents(cents)) : t("wal_topup_btn");
}

/* achat d'articles du frigo par le meilleur moyen : lines [{part, quantity}],
   recap [{name, quantity, total}], opts.cart (panier : vidé une fois payé),
   opts.via pour forcer "card" ou "topup". */
async function fridgeBuy(lines, recap, cents, opts) {
  opts = opts || {};
  const via = opts.via || payChoice(cents);
  if (via === "topup") return openWalletSheet(Math.max(0, cents - ACHAT.wallet));
  if (via === "card") return payCheckout({ source: "frigo", lines }, recap, opts);
  try {
    const r = await api("/plugin/paiements/wallet/pay", { method: "POST", body: { lines } });
    setWallet(r.wallet_cents);
    if (opts.cart) frigoCartClear();
    toast(t("wal_paid_toast", eurCents(r.wallet_cents)), "ok");
    openReceipt(r.purchase, false);
    return true;
  } catch (e) {
    toast(e.message, "bad");
    walletRefresh();
    return false;
  }
}

/* feuille « Mon portefeuille » : solde, montants rapides, montant libre,
   recharge par carte. need : ce qui manque pour le panier (centimes). */
const TOPUP_CHIPS = [200, 500, 1000, 2000];
function openWalletSheet(need) {
  need = need || 0;
  const min = ACHAT.topupMin,
    max = ACHAT.topupMax;
  // montant proposé : le plus petit raccourci qui couvre le panier
  const pre = TOPUP_CHIPS.find((c) => c >= Math.max(need, min)) || TOPUP_CHIPS[TOPUP_CHIPS.length - 1];
  const fmtC = (c) => (c / 100).toFixed(2).replace(".", ",");
  // sans paiement par carte : pas de formulaire, recharge en espèces auprès du trésorier
  const form = ACHAT.card
    ? '<div class="ps-steplbl wal-k">' + esc(t("wal_topup_how")) + "</div>" +
      '<div class="price-chips wal-chips">' +
      TOPUP_CHIPS.map((c) => '<button type="button" class="price-chip" data-v="' + fmtC(c) + '">' + c / 100 + " €</button>").join("") +
      "</div>" +
      '<div class="ps-amount"><label class="ps-field"><input id="walInput" type="text" inputmode="decimal" autocomplete="off" placeholder="0,00"><span>€</span></label></div>' +
      '<div class="ps-steplbl">' + esc(t("wal_range", eurCents(min))) + "</div>" +
      '<button class="btn btn-primary btn-block" data-go disabled></button>' +
      '<p class="ps-note wal-note">' + esc(t("wal_explain", ACHAT.provider === "helloasso" ? "HelloAsso" : "SumUp")) + "</p>"
    : '<p class="ps-note wal-note">' + esc(t("wal_nocard")) + "</p>";
  const ov = document.createElement("div");
  ov.className = "modal-ov sheet-ov";
  ov.innerHTML =
    '<div class="ps-sheet" role="dialog" aria-modal="true" aria-label="' + esc(t("wal_title")) + '">' +
    '<div class="ps-grab" aria-hidden="true"></div>' +
    '<div class="ps-head"><div class="ps-name"><div class="t">👛 ' + esc(t("wal_title")) + '</div><div class="s">' +
    esc(t("wal_balance_lbl")) + ' <b data-wallet-bal>' + esc(eurCents(ACHAT.wallet)) + "</b></div></div>" +
    '<button class="iconbtn" data-x aria-label="' + esc(t("cancel")) + '">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>' +
    (need > 0 ? '<p class="wal-need">' + esc(t("wal_missing", eurCents(need))) + "</p>" : "") +
    form +
    // bureau : encaisser la recharge d'un membre sur ce téléphone (Tap to Pay)
    (ACHAT.canTap ? '<button type="button" class="btn btn-ghost btn-block tap-open" data-tap>📲 ' + esc(t("tap_title")) + "</button>" : "") +
    "</div>";
  lockScroll();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
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
  const tap = ov.querySelector("[data-tap]");
  if (tap)
    tap.onclick = () => {
      close();
      openTapSheet(null);
    };
  document.body.appendChild(ov);
  if (ACHAT.card) armTopupForm(ov, close, fmtC(pre), min, max);
  // solde à jour (une recharge a pu aboutir ailleurs)
  walletRefresh();
  return Promise.resolve(false);
}

/* formulaire de recharge de la feuille : montant (raccourcis ou libre), puis
   paiement par carte (feuille SumUp ou page HelloAsso) */
function armTopupForm(ov, close, preset, min, max) {
  const input = ov.querySelector("#walInput"),
    go = ov.querySelector("[data-go]");
  const cents = () => {
    const v = input.value.trim().replace(",", ".");
    return /^\d{1,3}(\.\d{1,2})?$/.test(v) ? Math.round(parseFloat(v) * 100) : NaN;
  };
  const sync = () => {
    input.style.width = Math.max(4, (input.value || input.placeholder).length) + 0.3 + "ch";
    const c = cents();
    const ok = c >= min && c <= max;
    go.disabled = !ok;
    go.textContent = ok ? t("wal_topup_x", eurCents(c)) : t("wal_topup_btn");
  };
  input.value = preset;
  armPriceChips(ov, input, sync);
  input.addEventListener("input", sync);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !go.disabled) go.click();
  });
  go.onclick = async () => {
    const c = cents();
    const h = go.innerHTML;
    go.disabled = true;
    go.innerHTML = '<span class="spin"></span>';
    let r;
    try {
      r = await api("/plugin/paiements/wallet/topup", { method: "POST", body: { amount_cents: c } });
    } catch (e) {
      go.disabled = false;
      go.innerHTML = h;
      toast(e.message, "bad");
      return;
    }
    close();
    if (r.redirect_url) return goHelloAsso(r);
    openPaySheet(r, [{ name: t("wal_topup_line"), quantity: 1, total: r.total }]);
  };
  ov.querySelectorAll(".price-chip").forEach((x) => x.classList.toggle("on", x.dataset.v === input.value));
  sync();
}

/* ---- paiement ----
   body : panier pour POST /plugin/paiements/checkout ; recap : lignes à
   rappeler dans la feuille de paiement [{name, quantity, total}].
   Résout quand la feuille se ferme (payé -> le reçu a pris le relais). */
async function payCheckout(body, recap, opts) {
  let r;
  try {
    r = await api("/plugin/paiements/checkout", { method: "POST", body });
  } catch (e) {
    toast(e.message, "bad");
    return false;
  }
  // achat du panier : son reçu payé videra le panier (même après un
  // rechargement 3-D Secure) ; un achat depuis une fiche n'y touche pas
  try {
    if (opts && opts.cart) sessionStorage.setItem("frigo_cart_purchase", String(r.purchase));
  } catch (_) {}
  // la feuille s'ouvre tout de suite ; le formulaire s'y monte dès que le
  // script SumUp est là (préchargé à l'ouverture du frigo / de la fiche)
  if (r.redirect_url) return goHelloAsso(r);
  return openPaySheet(r, recap);
}

/* préchargement silencieux du script SumUp à l'ouverture du frigo */
function prefetchSumup() {
  if (ACHAT.card && ACHAT.provider === "sumup") loadSumupSdk().catch(() => {});
}

/* HelloAsso : paiement sur sa page, en pleine page. Retour sur ?achat=<pk>
   (boot.js -> reçu, qui relit le paiement) ; abandon -> ?frigo=1, panier
   intact (sessionStorage, même onglet). */
function goHelloAsso(r) {
  toast(t("buy_redirect"), "ok");
  window.location.href = r.redirect_url;
  return new Promise(() => {}); // la page s'en va : le bouton reste en attente
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

/* bloc « paiement sécurisé » sous le formulaire de carte : ce qui protège
   vraiment le payeur (formulaire SumUp, 3-D Secure, prestataire agréé) */
function payTrustHtml() {
  const ic = (d) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + "</svg>";
  const row = (d, k) => '<li>' + ic(d) + "<span>" + esc(t(k)) + "</span></li>";
  return (
    '<div class="pay-trust">' +
    '<div class="pay-trust-h">' + ic('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>') +
    "<b>" + esc(t("trust_title")) + "</b></div><ul>" +
    row('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z"/><path d="m9 12 2 2 4-4"/>', "trust_card") +
    row('<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>', "trust_3ds") +
    row('<path d="M3 21h18M5 21V10M19 21V10M9 21v-6h6v6M12 3 3 8h18Z"/>', "trust_psp") +
    "</ul></div>"
  );
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
      payTrustHtml() +
      '<p class="pay-note">' + esc(t("buy_secure")) + "</p></div>";
    lockScroll();
    let closed = false;
    const close = (paid) => {
      if (closed) return;
      closed = true;
      unlockScroll();
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
    if (p.status === "paid" || p.failed) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (p.status === "paid" && p.wallet_cents != null) setWallet(p.wallet_cents);
  if (p.status === "paid") {
    // le panier a été payé : on le vide (jamais pour un achat depuis une fiche)
    if (frigoCartPaidBy(p.pk)) frigoCartClear();
    if (fresh) toast(t("buy_paid_toast"), "ok");
  }
  renderReceipt(p);
  // reçu e-mail envoyé en tâche de fond : on rafraîchit la mention une fois
  if (p.status === "paid" && p.receipt_auto && !p.receipt_sent_to)
    setTimeout(async () => {
      try {
        const q = await api("/plugin/paiements/purchase/" + pk);
        if (q.receipt_sent_to && $("#rcptMail")) $("#rcptMail").textContent = t("rcpt_sent", q.receipt_sent_to);
      } catch (_) {}
    }, 5000);
}

function renderReceipt(p) {
  const paid = p.status === "paid";
  const topup = p.kind === "topup";
  const st = paid ? "ok" : p.failed ? "bad" : "wait";
  const bal = eurCents(p.wallet_cents || 0);
  const okText = topup ? t("wal_topped_txt", bal) : p.method === "wallet" ? t("wal_paid_rcpt", bal) : t("rcpt_show");
  const box = $("#receiptBody");
  // payé : preuve lisible de loin par le bureau (montant, jour, heure, articles)
  // et « payé il y a … » qui vit : une capture d'écran, elle, ne bouge pas
  const proof = paid
    ? '<div class="rcpt-proof">' +
      '<div class="ring">' + CHECK + "</div>" +
      '<div class="rp-k">' + esc(topup ? t("rcpt_proof_topup") : t("rcpt_proof_paid")) + "</div>" +
      '<div class="rp-amt">' + esc(p.total) + "</div>" +
      '<div class="rp-when">' + esc(p.date) + " · " + esc(p.time) + "</div>" +
      '<div class="rp-live"><span class="dot"></span><span id="rcptAgo">' + esc(rcptAgo(p)) + "</span></div>" +
      '<div class="rp-who">' + esc(p.buyer) + "</div>" +
      '<p class="rp-note">' + esc(okText) + "</p></div>"
    : '<div class="rcpt-hero ' + st + '">' +
      '<div class="ring">' + (p.failed ? "✕" : "…") + "</div>" +
      "<h2>" + esc(p.failed ? t("buy_failed") : t("buy_unpaid")) + "</h2>" +
      "<p>" + esc(p.failed ? t("buy_failed_warn") : t("buy_unpaid_warn")) + "</p></div>";
  box.innerHTML =
    proof +
    '<div class="card rcpt' + (paid ? " big" : "") + '">' +
    '<div class="rcpt-top"><div><div class="rcpt-no">' + esc(t("rcpt_no", p.pk)) + "</div>" +
    // payé : date et acheteur sont déjà en grand au-dessus
    (paid ? "" : '<div class="rcpt-meta">' + esc(t("rcpt_when", p.date, p.time)) + "</div>" +
      '<div class="rcpt-meta">' + esc(p.buyer) + "</div>") +
    "</div>" +
    '<span class="rcpt-badge ' + st + '">' +
    esc(paid ? t("rcpt_paid") : p.failed ? t("rcpt_failed") : t("rcpt_pending")) + "</span></div>" +
    '<div class="rcpt-lines">' +
    p.lines
      .map(
        (l) =>
          '<div class="rcpt-line"><span class="q">' + l.quantity + "×</span><span class=\"n\">" + esc(topup ? t("wal_topup_line") : l.name) +
          '</span><span class="p">' + esc(l.total) + "</span></div>",
      )
      .join("") +
    "</div>" +
    '<div class="rcpt-total"><span>' + esc(t("buy_total")) + "</span><span>" + esc(p.total) + "</span></div>" +
    '<div class="rcpt-pay">' +
    esc(p.method === "wallet" ? t("wal_name") : p.channel === "tap" ? t("tap_rcpt", p.collected_by) : p.provider) + (p.payment_ref ? " · " + esc(p.payment_ref) : "") + "</div>" +
    (p.warning ? '<div class="rcpt-warn">⚠ ' + esc(p.warning) + "</div>" : "") +
    "</div>" +
    (paid
      ? '<button class="btn btn-primary btn-block" id="rcptPdf">' + esc(t("rcpt_download")) + "</button>" +
        '<button class="btn btn-ghost btn-block" id="rcptMailBtn">' +
        esc(p.receipt_sent_to ? t("rcpt_resend") : t("rcpt_send")) + "</button>" +
        '<p class="rcpt-mail" id="rcptMail">' +
        esc(p.receipt_sent_to ? t("rcpt_sent", p.receipt_sent_to) : p.receipt_auto ? t("rcpt_sending") : "") + "</p>"
      : p.failed
        ? ""
        : '<button class="btn btn-ghost btn-block" id="rcptRetry">' + esc(t("retry")) + "</button>") +
    '<button class="btn btn-ghost btn-block" id="rcptFridge">' + esc(t("rcpt_back_fridge")) + "</button>";
  if ($("#rcptPdf")) $("#rcptPdf").onclick = () => downloadReceipt(p.pk, $("#rcptPdf"));
  if ($("#rcptMailBtn")) $("#rcptMailBtn").onclick = () => resendReceipt(p.pk, $("#rcptMailBtn"));
  if ($("#rcptRetry")) $("#rcptRetry").onclick = () => openReceipt(p.pk, true);
  $("#rcptFridge").onclick = () => openFrigo();
  // « il y a … » rafraîchi tant que ce reçu est affiché
  clearInterval(RCPT_TICK);
  if (paid && p.paid_at)
    RCPT_TICK = setInterval(() => {
      const el = $("#rcptAgo");
      if (!el || !$("#screen-receipt").classList.contains("active")) return clearInterval(RCPT_TICK);
      el.textContent = rcptAgo(p);
    }, 15000);
}

let RCPT_TICK = null;
/* « payé à l'instant » / « il y a 3 min » / « il y a 2 h » / « le 12/10/2026 » */
function rcptAgo(p) {
  if (!p.paid_at) return t("rcpt_paid");
  const s = Math.max(0, (Date.now() - new Date(p.paid_at).getTime()) / 1000);
  if (s < 60) return t("rcpt_ago_now");
  if (s < 3600) return t("rcpt_ago_min", Math.floor(s / 60));
  if (s < 86400) return t("rcpt_ago_h", Math.floor(s / 3600));
  return t("rcpt_ago_day", p.date);
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
  // portefeuille en tête : solde + recharge
  const wc = $("#walletCard");
  if (wc) {
    wc.innerHTML =
      '<div class="wal-card"><div class="wal-l"><div class="wal-k">👛 ' + esc(t("wal_title")) + '</div>' +
      '<div class="wal-amt" data-wallet-bal>' + esc(eurCents(ACHAT.wallet)) + "</div></div>" +
      '<button class="btn btn-primary" id="walTopBtn">' + esc(t("wal_topup_short")) + "</button></div>";
    $("#walTopBtn").onclick = () => openWalletSheet(0);
    walletRefresh();
  }
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
      esc(
        p.kind === "topup"
          ? t("wal_topup_line")
          : p.lines.map((l) => (l.quantity > 1 ? l.quantity + "× " : "") + l.name).join(", ") +
              (p.method === "wallet" ? " · " + t("wal_name") : ""),
      ) +
      '</div></div><div class="pt' + (p.kind === "topup" ? " plus" : "") + '">' +
      (p.kind === "topup" ? "+" : "") + esc(p.total) + "</div>";
    row.onclick = () => openReceipt(p.pk, false);
    box.appendChild(row);
  });
}
