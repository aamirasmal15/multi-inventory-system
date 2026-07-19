/* ==========================================================================
   features/loan.js — Emprunts et réservations des objets trackables (plugin inventree-prets).

   Un article dont le part est « trackable » dans InvenTree est un objet unique :
   sa fiche ne compte pas une quantité, elle affiche un bloc d'emprunt.
   - plugin absent (pas de /plugin/prets/config) -> fiche quantité classique ;
   - ENABLE_RESERVATIONS décoché -> fiche emprunt simple (statut + emprunter/rendre) ;
   - ENABLE_RESERVATIONS coché   -> fiche complète à onglets Suivi / Planning / Historique.

   L'emprunt est en self-service : c'est l'utilisateur connecté qui emprunte
   (champ grisé à son nom). Le retour et l'annulation d'une réservation sont
   réservés à leur auteur (et aux admins) — le serveur renvoie can_return /
   can_cancel, l'app se contente de masquer les boutons en conséquence.
   ========================================================================== */

/* ---- config du plugin + identité (lues une fois à l'entrée dans l'app) ---- */
const PRETS = { ready: false, ok: false, reservations: false, duration: 1, onBehalf: false, me: null };
let pretsReadyResolve = null;
const pretsReadyPromise = new Promise((r) => (pretsReadyResolve = r));

async function loadPretsConfig() {
  try {
    const c = await api("/plugin/prets/config");
    PRETS.ok = true;
    PRETS.reservations = !!c.reservations_enabled;
    PRETS.duration = parseInt(c.loan_duration_days, 10) || 1;
    PRETS.onBehalf = !!c.ask_on_behalf; // champ « Pour (asso/club) » facultatif
    // identité réelle de l'utilisateur (prénom + pk) pour le formulaire d'emprunt
    PRETS.me = await api("/api/user/me/").catch(() => null);
  } catch (_) {
    // plugin non installé / endpoints désactivés -> la fiche quantité reste seule
    PRETS.ok = false;
  }
  PRETS.ready = true;
  pretsReadyResolve();
}
function meName() {
  const m = PRETS.me;
  if (m) {
    const full = ((m.first_name || "") + " " + (m.last_name || "")).trim();
    if (full) return full;
  }
  // compte sans prénom (superadmin local) : le nom de l'asso plutôt qu'un login technique
  return (typeof BRAND === "string" && BRAND) || (m && m.username) || USERNAME;
}

/* ---- état de la fiche courante ---- */
let LOAN_STATE = null; // dernier payload /plugin/prets/item/<pk>
let LOAN_TAB = "suivi"; // onglet actif en fiche complète
let LOAN_PK = null; // pk de l'objet dont le bloc est rendu (reset des onglets)
let LOAN_HIST = null; // cache timeline paginée {pk, entries, offset, total, expanded, pending, error}
let LEND_ONBEHALF = null; // réservation d'autrui qu'un admin confirme au nom du bénéficiaire

/* ---- dates ---- */
function loanParseDate(s) {
  if (!s) return null;
  const str = String(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  // le tracking InvenTree renvoie "AAAA-MM-JJ HH:mm" : Safari refuse l'espace
  const d = new Date(str.replace(" ", "T"));
  return isNaN(d) ? null : d;
}
function frDate(s, withYear) {
  const d = loanParseDate(s);
  if (!d) return "";
  const o = { day: "numeric", month: "short" };
  if (withYear !== false) o.year = "numeric";
  // en-GB : jour avant le mois (« 12 Jul »), même lecture que le format français
  return d.toLocaleDateString(LANG === "fr" ? "fr-FR" : "en-GB", o);
}
function frDateTime(s) {
  // « 12 juil. · 14:32 » — l'année seulement si ce n'est pas celle en cours
  const d = loanParseDate(s);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return (
    frDate(s, d.getFullYear() !== new Date().getFullYear()) +
    " · " + p(d.getHours()) + ":" + p(d.getMinutes())
  );
}
function frDateAuto(s) {
  // « 12 juil. » — l'année seulement si ce n'est pas celle en cours
  const d = loanParseDate(s);
  return d ? frDate(s, d.getFullYear() !== new Date().getFullYear()) : "";
}
function isoPlus(days, from) {
  const t = from ? new Date(from.getTime()) : new Date();
  t.setDate(t.getDate() + (days || 0));
  const p = (n) => String(n).padStart(2, "0");
  return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate());
}
function dayDiff(a, b) {
  // nb de jours entre deux dates (b - a), sur des minuits locaux
  const da = loanParseDate(a),
    db = loanParseDate(b);
  if (!da || !db) return 0;
  da.setHours(0, 0, 0, 0);
  db.setHours(0, 0, 0, 0);
  return Math.round((db - da) / 864e5);
}

/* ---- icônes (reprises des maquettes) ---- */
const LOAN_SVG = {
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  out:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>',
  warn:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  back:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a6 6 0 0 1 6 6v5"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  hist:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  move:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>',
  cal:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>',
  x:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

/* ---- bascule quantité / emprunt de la fiche article ---- */
function isLoanItem(it) {
  return PRETS.ok && !!(it && it.part_detail && it.part_detail.trackable);
}
async function applyItemMode(it) {
  await pretsReadyPromise;
  if (CURRENT !== it) return; // l'utilisateur a changé de fiche entre-temps
  const loanUI = isLoanItem(it);
  $("#qtyBlock").style.display = loanUI ? "none" : "";
  $("#loanBlock").style.display = loanUI ? "" : "none";
  if (!loanUI) return;
  if (LOAN_PK !== it.pk) {
    LOAN_TAB = "suivi";
    LOAN_HIST = null;
  }
  LOAN_PK = it.pk;
  await renderLoanBlock(it);
}

async function renderLoanBlock(it) {
  const box = $("#loanBlock");
  box.innerHTML = '<div class="skeleton">Chargement…</div>';
  let st;
  try {
    st = await api("/plugin/prets/item/" + it.pk);
  } catch (e) {
    if (CURRENT !== it) return;
    box.innerHTML =
      '<div class="err show" style="display:block">' +
      esc(e.message || t("loan_state_fail")) +
      '</div><button class="btn btn-ghost" id="loanRetryBtn">' + t("retry") + "</button>";
    $("#loanRetryBtn").onclick = () => renderLoanBlock(it);
    return;
  }
  if (CURRENT !== it) return;
  LOAN_STATE = st;
  if (PRETS.reservations) renderLoanFull(it, st);
  else renderLoanSimple(it, st);
}
function refreshLoanBlock() {
  LOAN_HIST = null;
  if (CURRENT) renderLoanBlock(CURRENT);
}

/* ---- helpers réservation ---- */
function meIsAdmin() {
  return !!(PRETS.me && (PRETS.me.is_staff || PRETS.me.is_superuser));
}
function resaIsMine(r) {
  return !!(PRETS.me && r.reserved_for_user === PRETS.me.pk);
}
function currentResa(st) {
  // réservation dont le créneau est en cours : l'objet est « Réservé »
  return ((st && st.reservations) || []).find((r) => r.is_active && r.is_current) || null;
}
/* ma réservation active la plus proche (en cours ou à venir) sur cet objet */
function myResa(st) {
  const mine = ((st && st.reservations) || []).filter((r) => r.is_active && resaIsMine(r));
  if (!mine.length) return null;
  return mine.reduce((m, r) => (r.start_date < m.start_date ? r : m), mine[0]);
}

/* ---- carte de statut (Disponible / Réservé / Emprunté / En retard) ---- */
function loanCard(st) {
  if (!st.active) {
    const cur = currentResa(st);
    if (cur) {
      return (
        '<div class="loan res"><div class="loan-top">' +
        '<span class="loan-ico">' + LOAN_SVG.cal + "</span>" +
        '<div><div class="loan-state">' + t("st_res") + "</div>" +
        '<div class="loan-when">' +
        (resaIsMine(cur) ? t("res_for_you") : t("by_who", esc(cur.reserved_for_label))) +
        "</div></div></div>" +
        '<div class="loan-lines">' +
        '<div class="loan-line"><span>' + t("date_from") + "</span><b>" + esc(frDate(cur.start_date)) + "</b></div>" +
        '<div class="loan-line"><span>' + t("date_to") + "</span><b>" + esc(frDate(cur.end_date)) + "</b></div>" +
        (cur.notes
          ? '<div class="loan-line"><span>' + t("line_reason") + "</span><b>" + esc(cur.notes) + "</b></div>"
          : "") +
        "</div></div>"
      );
    }
    return (
      '<div class="loan ok"><div class="loan-top">' +
      '<span class="loan-ico">' + LOAN_SVG.check + "</span>" +
      '<div><div class="loan-state">' + t("st_free") + "</div>" +
      '<div class="loan-when">' + t("free_sub") + "</div></div>" +
      "</div></div>"
    );
  }
  const l = st.loan;
  const late = !!l.is_overdue;
  let html =
    '<div class="loan ' + (late ? "late" : "out") + '"><div class="loan-top">' +
    '<span class="loan-ico">' + (late ? LOAN_SVG.warn : LOAN_SVG.out) + "</span>" +
    '<div><div class="loan-state">' + t("st_out") + "</div>" +
    '<div class="loan-when">' + t("by_who", esc(l.borrower_label)) + "</div></div>" +
    "</div>" +
    '<div class="loan-lines">' +
    '<div class="loan-line"><span>' + t("line_since") + "</span><b>" + esc(frDate(l.lent_at)) + "</b></div>" +
    (l.due_on
      ? '<div class="loan-line"><span>' + t("line_due") + "</span><b>" + esc(frDate(l.due_on)) + "</b></div>"
      : "") +
    (l.notes
      ? '<div class="loan-line"><span>' + t("line_comment") + "</span><b>" + esc(l.notes) + "</b></div>"
      : "") +
    "</div>";
  if (late && l.due_on) {
    const n = dayDiff(l.due_on, isoPlus(0));
    html +=
      '<span class="loan-flag">' + LOAN_SVG.clock + t("overdue_by", n) + "</span>";
  }
  return html + "</div>";
}

/* ---- boutons d'action ---- */
function loanActionButtons(st) {
  if (!st.active) {
    // objet réservé (créneau en cours) pour QUELQU'UN D'AUTRE
    const cur = currentResa(st);
    if (cur && !resaIsMine(cur)) {
      // un admin peut CONFIRMER la réservation au nom du bénéficiaire (le prêt
      // est enregistré à son nom, suivi correct) ; sinon l'emprunt lui est réservé
      if (meIsAdmin()) {
        return (
          '<button class="btn btn-primary" id="loanConfirmForBtn">' +
          t("confirm_loan_of", esc(cur.reserved_for_label)) + "</button>"
        );
      }
      return (
        '<p class="field-hint" style="margin:2px 2px 0">' +
        t("slot_reserved_hint_html", esc(cur.reserved_for_label)) +
        "</p>"
      );
    }
    // le bénéficiaire du créneau en cours CONFIRME sa réservation en empruntant
    const label = cur && resaIsMine(cur) ? t("confirm_loan") : t("borrow");
    return '<button class="btn btn-primary" id="loanLendBtn">' + label + "</button>";
  }
  // retour réservé à l'emprunteur (et aux admins) — l'emprunteur peut rendre
  // même quand un admin a confirmé le prêt à son nom
  if (st.loan && st.loan.can_return === false) {
    return (
      '<p class="field-hint" style="margin:2px 2px 0">' +
      t("return_reserved_hint_html", esc(st.loan.borrower_label)) +
      "</p>"
    );
  }
  // avant l'échéance, rendre = rendre plus tôt : l'objet redevient libre
  // immédiatement (et une réservation confirmée s'arrête par ce retour).
  // Si je rends AU NOM d'un autre (admin/enregistreur, pas l'emprunteur),
  // le bouton nomme la personne pour éviter les erreurs de manipulation.
  const early = st.loan && st.loan.due_on && st.loan.due_on > isoPlus(0);
  const mine = !!(PRETS.me && st.loan && st.loan.borrower_user === PRETS.me.pk);
  const label = mine
    ? early
      ? t("return_early")
      : t("record_return")
    : t("record_return_of", esc(st.loan.borrower_label));
  return (
    '<button class="btn btn-primary" id="loanReturnBtn">' + LOAN_SVG.back +
    label + "</button>"
  );
}
function bindLoanActions() {
  $("#loanLendBtn")?.addEventListener("click", () => openLendForm());
  $("#loanConfirmForBtn")?.addEventListener("click", () =>
    openLendForm(currentResa(LOAN_STATE)),
  );
  $("#loanReturnBtn")?.addEventListener("click", submitReturn);
  $("#loanMoveBtn")?.addEventListener("click", moveStock);
  $("#loanBookBtn")?.addEventListener("click", openReserveForm);
}

/* ---- réservations : aperçu (onglet Suivi) — la carte statut montre déjà
   le créneau en cours, ici seulement le prochain créneau à venir ---- */
function resaPreview(st) {
  const list = (st.reservations || []).filter((r) => r.is_active && !r.is_current);
  if (!list.length) return "";
  const r = list[0];
  return (
    '<div class="resa-title">' + LOAN_SVG.cal +
    (st.active ? t("res_next_while_out") : t("res_next")) + "</div>" +
    '<div class="resa-list">' + resaRow(r, false) + "</div>"
  );
}
/* Plage de dates lisible. FR : « du 20 au 22 juil. » si même mois (style
   maquette), « du 28 juin au 2 juil. » sinon, « le 12 juil. » sur une seule
   journée. EN : sans préposition (« 20 – 22 Jul », « 12 Jul ») pour se
   composer avec les phrases du dictionnaire (« for … », « (…) »). */
function frRange(a, b) {
  const da = frDate(a, false),
    db = frDate(b, false);
  const sameMonth = String(a).slice(0, 7) === String(b).slice(0, 7);
  const dayA = String(loanParseDate(a).getDate());
  if (LANG === "fr") {
    if (da === db) return "le " + da;
    return "du " + (sameMonth ? dayA : da) + " au " + db;
  }
  if (da === db) return da;
  return (sameMonth ? dayA : da) + " – " + db;
}
function resaRange(r) {
  return frRange(r.start_date, r.end_date);
}
function resaRow(r, cancellable) {
  return (
    '<div class="resa-row"><span class="dot book"></span>' +
    '<div style="min-width:0"><div class="resa-who">' + esc(r.reserved_for_label) + "</div>" +
    (r.notes ? '<div class="resa-when">' + esc(r.notes) + "</div>" : "") +
    "</div>" +
    '<div class="right">' + esc(resaRange(r)) + "</div>" +
    (cancellable && r.can_cancel
      ? '<button class="resa-x" data-resa="' + r.pk + '" data-who="' +
        esc(r.reserved_for_label) + '" title="' + t("cancel_resa_btn") + '">×</button>'
      : "") +
    "</div>"
  );
}

/* ==========================================================================
   MODE SIMPLE — réservations désactivées : statut + emprunter / rendre.
   ========================================================================== */
function renderLoanSimple(it, st) {
  const box = $("#loanBlock");
  let html = loanCard(st) + loanActionButtons(st);
  html +=
    '<div class="item-actions">' +
    (!st.active
      ? '<button class="btn btn-ghost" id="loanMoveBtn">' + LOAN_SVG.move + t("move") + "</button>"
      : "") +
    '<button class="btn btn-ghost" id="loanHistBtn">' + LOAN_SVG.hist + t("tab_history") + "</button>" +
    "</div>" +
    '<div id="loanHistWrap" style="display:none;margin-top:18px">' +
    '<div class="resa-title">' + LOAN_SVG.hist + t("tab_history") + "</div>" +
    '<div id="loanHistBody"></div></div>';
  box.innerHTML = html;
  bindLoanActions();
  $("#loanHistBtn")?.addEventListener("click", () => {
    const w = $("#loanHistWrap");
    const open = w.style.display !== "none";
    w.style.display = open ? "none" : "";
    if (!open) mountTimeline($("#loanHistBody"), it, () => $("#loanHistBody"));
  });
}

/* ==========================================================================
   MODE COMPLET — réservations activées : onglets Suivi / Planning / Historique.
   ========================================================================== */
function renderLoanFull(it, st) {
  const box = $("#loanBlock");
  const tab = (k, label) =>
    '<button type="button" class="seg-btn' + (LOAN_TAB === k ? " active" : "") +
    '" data-tab="' + k + '">' + label + "</button>";
  box.innerHTML =
    '<div class="seg" id="loanTabs">' +
    tab("suivi", t("tab_status")) + tab("planning", t("tab_schedule")) + tab("historique", t("tab_history")) +
    "</div>" +
    '<div id="loanPanel"></div>';
  const tabs = box.querySelector("#loanTabs");
  segSync(tabs); // positionne le curseur glissant sur l'onglet actif
  box.querySelectorAll("#loanTabs .seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      if (LOAN_TAB === b.dataset.tab) return; // déjà sur cet onglet
      LOAN_TAB = b.dataset.tab;
      box.querySelectorAll("#loanTabs .seg-btn").forEach((x) =>
        x.classList.toggle("active", x === b),
      );
      segSync(tabs); // le curseur coulisse vers l'onglet touché
      renderLoanTab(it, st);
    });
  });
  renderLoanTab(it, st);
}

function renderLoanTab(it, st) {
  const p = $("#loanPanel");
  if (LOAN_TAB === "suivi") {
    // créneau en cours réservé POUR MOI : je confirme l'emprunt ou j'annule ma
    // réservation — Réserver un autre créneau ou Déplacer n'ont pas leur place
    const cur = !st.active ? currentResa(st) : null;
    const mine = !!(cur && resaIsMine(cur));
    p.innerHTML =
      loanCard(st) + resaPreview(st) + loanActionButtons(st) +
      '<div class="item-actions">' +
      (mine
        ? cur.can_cancel
          ? '<button class="btn btn-outline-danger" id="loanCancelResaBtn">' +
            LOAN_SVG.x + t("cancel_my_resa") + "</button>"
          : ""
        : !st.active
          ? '<button class="btn btn-ghost book" id="loanBookBtn">' + LOAN_SVG.cal + t("book") + "</button>" +
            '<button class="btn btn-ghost" id="loanMoveBtn">' + LOAN_SVG.move + t("move") + "</button>"
          : "") +
      "</div>";
    bindLoanActions();
    $("#loanCancelResaBtn")?.addEventListener("click", () =>
      cancelReservation(cur.pk, cur.reserved_for_label, true),
    );
  } else if (LOAN_TAB === "planning") {
    p.innerHTML = planningHtml(st) +
      '<button class="btn btn-ghost book" id="loanBookBtn">' + LOAN_SVG.cal + t("book_slot") + "</button>";
    fitPlanLabels(p); // libellés de la frise ajustés à la place réelle
    $("#loanBookBtn")?.addEventListener("click", openReserveForm);
    p.querySelectorAll(".resa-x").forEach((b) =>
      b.addEventListener("click", () =>
        cancelReservation(b.dataset.resa, b.dataset.who, b.dataset.mine === "1"),
      ),
    );
  } else {
    // le rendu n'écrit dans #loanPanel que si l'onglet Historique est resté actif
    mountTimeline(p, it, () => (LOAN_TAB === "historique" ? $("#loanPanel") : null));
  }
}

/* ---- planning : créneaux occupés (emprunt en cours + réservations) et trous libres ---- */
function loanSlots(st) {
  const today = isoPlus(0);
  const events = [];
  if (st.active && st.loan) {
    events.push({
      kind: "lent",
      who: st.loan.borrower_label,
      sub: st.loan.due_on ? t("due_back_on", frDate(st.loan.due_on, false)) : t("no_due"),
      from: today,
      to: st.loan.due_on && st.loan.due_on > today ? st.loan.due_on : today,
    });
  }
  (st.reservations || []).forEach((r) => {
    events.push({
      kind: "book",
      who: r.reserved_for_label,
      sub: r.notes || "",
      from: r.start_date > today ? r.start_date : today,
      to: r.end_date,
      pk: r.pk,
      canCancel: !!r.can_cancel,
      mine: resaIsMine(r),
    });
  });
  events.sort((a, b) => (a.from < b.from ? -1 : 1));
  // horizon : au moins 14 jours, au plus tard la fin du dernier créneau
  let horizon = isoPlus(14);
  events.forEach((e) => {
    if (e.to > horizon) horizon = e.to;
  });
  // trous libres entre les créneaux
  const slots = [];
  let cursor = today;
  events.forEach((e) => {
    if (e.from > cursor) slots.push({ kind: "free", from: cursor, to: isoPlus(-1, loanParseDate(e.from)) });
    slots.push(e);
    const next = isoPlus(1, loanParseDate(e.to));
    if (next > cursor) cursor = next;
  });
  if (cursor <= horizon) slots.push({ kind: "free", from: cursor, to: horizon, open: true });
  return { slots, today, horizon };
}

/* ---- libellés de la frise : la plus longue variante qui TIENT dans le
   segment — « Aamir ASMAL (EirSpace) » puis « Aamir ASMAL » puis « Aamir »
   puis rien. Jamais de texte coupé : on mesure après le rendu. ---- */
function planLabelVariants(label) {
  const l = String(label || "").trim();
  if (!l) return [""];
  const out = [l];
  const noOrg = l.replace(/\s*\([^)]*\)\s*$/, "").trim(); // sans « (Asso) »
  if (noOrg && noOrg !== l) out.push(noOrg);
  const first = noOrg.split(/\s+/)[0]; // prénom seul
  if (first && first !== noOrg) out.push(first);
  out.push("");
  return out;
}
function fitPlanLabels(root) {
  (root || document).querySelectorAll("[data-plan-label]").forEach((el) => {
    const span = el.firstElementChild;
    if (!span) return;
    const max = el.clientWidth - 6; // petit respirateur de chaque côté
    for (const v of planLabelVariants(el.dataset.planLabel)) {
      span.textContent = v;
      if (!v || span.offsetWidth <= max) return;
    }
  });
}
// rotation d'écran / redimensionnement : on réajuste les libellés visibles
window.addEventListener("resize", () => {
  if (document.querySelector("[data-plan-label]")) fitPlanLabels(document);
});

function planningHtml(st) {
  const { slots, today, horizon } = loanSlots(st);
  const total = Math.max(1, dayDiff(today, horizon) + 1);
  // frise
  let bar = "";
  slots.forEach((s) => {
    const days = Math.max(1, dayDiff(s.from, s.to) + 1);
    const label = s.kind === "free" ? t("free_bar") : s.who;
    bar +=
      '<div class="seg-p ' + s.kind + '" style="flex:' + days + '" title="' +
      esc(label + " · " + frRange(s.from, s.to)) + '" data-plan-label="' +
      esc(label) + '"><span></span></div>';
  });
  const mid = isoPlus(Math.floor(total / 2), loanParseDate(today));
  let html =
    '<div class="plan"><div class="plan-bar">' + bar + "</div>" +
    '<div class="plan-scale"><span>' + esc(frDate(today, false)) + "</span><span>" +
    esc(frDate(mid, false)) + "</span><span>" + esc(frDate(horizon, false)) + "</span></div></div>";
  // détail
  html += '<div class="resa-title">' + t("slots_detail") + '</div><div class="resa-list">';
  slots.forEach((s) => {
    if (s.kind === "free") {
      html +=
        '<div class="resa-row"><span class="dot free"></span>' +
        '<div style="min-width:0"><div class="resa-who">' + t("free_lbl") + "</div>" +
        '<div class="resa-when">' + t("free_sub2") + "</div></div>" +
        '<div class="right">' +
        esc(s.open ? t("from_d", frDate(s.from, false)) : frRange(s.from, s.to)) +
        "</div></div>";
    } else if (s.kind === "lent") {
      html +=
        '<div class="resa-row"><span class="dot lent"></span>' +
        '<div style="min-width:0"><div class="resa-who">' + t("lent_dot", esc(s.who)) + "</div>" +
        '<div class="resa-when">' + esc(s.sub) + "</div></div>" +
        '<div class="right">' + esc(t("until_d", frDate(s.to, false))) + "</div></div>";
    } else {
      html +=
        '<div class="resa-row"><span class="dot book"></span>' +
        '<div style="min-width:0"><div class="resa-who">' + t("res_dot", esc(s.who)) + "</div>" +
        (s.sub ? '<div class="resa-when">' + esc(s.sub) + "</div>" : "") +
        "</div>" +
        '<div class="right">' + esc(frRange(s.from, s.to)) + "</div>" +
        (s.canCancel
          ? '<button class="resa-x" data-resa="' + s.pk + '" data-who="' + esc(s.who) +
            '" data-mine="' + (s.mine ? "1" : "") + '" title="' +
            (s.mine ? t("cancel_my_resa") : t("cancel_resa_btn")) + '">×</button>'
          : "") +
        "</div>";
    }
  });
  return html + "</div>";
}

/* ==========================================================================
   HISTORIQUE — timeline des emprunts : quand c'est pris, quand c'est rendu.
   Une première page s'affiche, « Voir plus » entame le reste : la suite se
   charge ensuite toute seule au fil du scroll, page par page (limit/offset).
   Simple, identique sur les deux modes de fiche (avec et sans réservation).
   ========================================================================== */
const LOAN_HIST_PAGE = 15; // prêts par page (jusqu'à 2 lignes chacun)

/* Deux mentions par prêt, pas plus : Emprunté et Rendu, chacune avec la
   date et l'heure, la personne, et le motif du prêt s'il y en a un.
   Un retour après l'échéance devient « Rendu en retard » (en rouge), avec
   la date de retour initialement prévue en rappel. */

/* « Emprunt/Retour enregistré par X » seulement quand X n'est pas
   l'emprunteur : le cas courant reste vierge, seul l'agir-au-nom-d'un-autre
   est signalé (mêmes libellés que le panneau PC et le reçu par e-mail). */
function recordedBy(detail, l) {
  if (!detail || !detail.pk || !l.borrower_user || detail.pk === l.borrower_user) return "";
  return ((detail.first_name || "") + " " + (detail.last_name || "")).trim() || detail.username;
}

function loanEvents(l) {
  const e = [
    {
      d: l.lent_at, kind: "lent", ev: t("hist_lent"), who: l.borrower_label,
      sub: l.notes || "", by: recordedBy(l.lent_by_detail, l), byKey: "by_lend_html",
    },
  ];
  if (l.returned_at) {
    const late = !!(l.due_on && dayDiff(l.due_on, l.returned_at) > 0);
    e.unshift({
      d: l.returned_at,
      kind: late ? "late" : "back",
      ev: late ? t("hist_late") : t("hist_back"),
      who: l.borrower_label,
      sub: l.notes || "",
      due: late ? l.due_on : null,
      by: recordedBy(l.returned_by_detail, l),
      byKey: "by_return_html",
    });
  }
  return e;
}

/* Charge la page suivante de l'historique dans le cache LOAN_HIST.
   L'API sert les prêts du plus récent au plus ancien ; un objet ne se prête
   qu'à une personne à la fois, donc les événements arrivent eux aussi en
   ordre chronologique inverse : on ajoute à la suite, sans re-trier ce qui
   est déjà à l'écran. */
function loanHistoryMore(pk) {
  let h = LOAN_HIST;
  if (!h || h.pk !== pk) {
    h = LOAN_HIST = { pk, entries: [], offset: 0, total: null, expanded: false, pending: null, error: "" };
  }
  if (h.pending) return h.pending; // requête déjà en vol : on s'y greffe
  if (h.total !== null && h.offset >= h.total) return Promise.resolve(h);
  h.pending = (async () => {
    try {
      const r = await api(
        "/plugin/prets/loans?stock_item=" + pk + "&limit=" + LOAN_HIST_PAGE + "&offset=" + h.offset,
      );
      const loans = (r && r.results) || r || [];
      loans.forEach((l) => h.entries.push(...loanEvents(l)));
      h.offset += loans.length;
      // count = pagination DRF ; réponse non paginée (liste nue) = tout est là
      h.total = r && typeof r.count === "number" ? r.count : h.offset;
      h.error = "";
    } catch (e) {
      h.error = e.message || t("hist_load_fail");
      throw e;
    } finally {
      h.pending = null;
    }
    return h;
  })();
  return h.pending;
}

function timelineHtml(h) {
  if (!h.entries.length && h.total !== null && h.offset >= h.total) {
    return '<p class="subtitle" style="margin:4px 2px">' + t("hist_none") + "</p>";
  }
  let html = '<div class="tl">';
  h.entries.forEach((x) => {
    html +=
      '<div class="tl-item"><span class="tl-dot ' + x.kind + '"></span>' +
      '<div class="tl-line"><span class="tl-ev ' + x.kind + '">' + esc(x.ev) + "</span>" +
      '<span class="tl-date">' + esc(frDateTime(x.d)) + "</span></div>" +
      '<div class="tl-who">' + esc(x.who) + "</div>" +
      (x.due ? '<div class="tl-due">' + esc(t("due_back_on", frDateAuto(x.due))) + "</div>" : "") +
      (x.sub ? '<div class="tl-sub">' + esc(x.sub) + "</div>" : "") +
      (x.by ? '<div class="tl-by">' + t(x.byKey, "<b>" + esc(x.by) + "</b>") + "</div>" : "") +
      "</div>";
  });
  html += "</div>";
  // Pied de liste tant qu'il reste des prêts côté serveur : « Voir plus »
  // avant le déroulé, sentinelle « Chargement… » pendant (le scroll fait le
  // reste — voir mountTimeline), « Réessayer » si une page a échoué.
  const left = h.total === null ? 0 : h.total - h.offset;
  if (left > 0) {
    let inner;
    if (h.error) {
      inner = '<button class="btn btn-ghost tl-more" id="tlMoreBtn">' + t("retry") + "</button>";
    } else if (h.pending || (h.expanded && window.IntersectionObserver)) {
      inner = '<div class="skeleton">' + t("loading") + "</div>";
    } else {
      // aussi le repli des vieux navigateurs sans IntersectionObserver :
      // le bouton recharge alors page par page
      inner =
        '<button class="btn btn-ghost tl-more" id="tlMoreBtn">' + t("see_more", left) + "</button>";
    }
    html += '<div class="tl-foot" id="tlFoot">' + inner + "</div>";
  }
  return html;
}

/* Monte la timeline dans un conteneur. `alive()` redonne le conteneur si le
   rendu est encore attendu (même fiche, même onglet), null sinon — évite
   d'écraser un autre onglet ou la fiche d'un autre objet après le fetch. */
async function mountTimeline(box, it, alive) {
  // première visite de la fiche : charge la première page (cache ensuite)
  if (!(LOAN_HIST && LOAN_HIST.pk === it.pk && LOAN_HIST.total !== null)) {
    box.innerHTML = '<div class="skeleton">' + t("loading") + "</div>";
    try {
      await loanHistoryMore(it.pk);
    } catch (e) {
      if (CURRENT === it && alive()) box.innerHTML = '<div class="err show" style="display:block">' + esc(e.message) + "</div>";
      return;
    }
  }
  const h = LOAN_HIST;
  let io = null; // sentinelle de scroll du rendu courant
  const more = () => {
    if (h.pending) return;
    const p = loanHistoryMore(it.pk).catch(() => {}); // l'échec s'affiche via h.error
    draw(); // pied en « Chargement… » pendant la requête
    p.then(draw);
  };
  const draw = () => {
    if (io) { io.disconnect(); io = null; }
    const target = CURRENT === it ? alive() : null;
    if (!target) return;
    target.innerHTML = timelineHtml(h);
    const btn = target.querySelector("#tlMoreBtn");
    if (btn) {
      btn.addEventListener("click", () => {
        h.expanded = true;
        more();
      });
      return;
    }
    // mode déroulé : dès que le pied de liste approche de l'écran (600 px
    // d'avance), la page suivante part — le scroll charge tout seul
    const foot = target.querySelector("#tlFoot");
    if (foot && window.IntersectionObserver) {
      io = new IntersectionObserver(
        (es) => { if (es.some((x) => x.isIntersecting)) more(); },
        { rootMargin: "600px 0px" },
      );
      io.observe(foot);
    }
  };
  draw();
}

/* ==========================================================================
   FORMULAIRES — mini-fiche, suggestions de membres, emprunt, retour, réservation.
   ========================================================================== */
function renderMiniHead(el, it) {
  const pd = it.part_detail || {};
  const thumb = pd.thumbnail || pd.image;
  el.innerHTML =
    (thumb
      ? '<img class="thumb" src="' + esc(mediaUrl(thumb)) + '" data-full="' +
        esc(mediaUrl(pd.image || "")) + '" alt="" onerror="thumbErr(this)">'
      : boxIcon().outerHTML) +
    '<div style="min-width:0"><p class="name">' + esc(pd.full_name || pd.name || t("item_n", it.pk)) +
    '</p><div class="sub">' +
    (it.serial ? '<span class="pill pill-serial">' + esc(it.serial) + "</span>" : "") +
    "</div></div>";
}

/* ---- emprunter (self-service : l'emprunt est au nom de l'utilisateur connecté) ---- */
/* première réservation active de quelqu'un d'autre : elle borne la date de retour
   (le serveur refuse de toute façon un emprunt qui mord sur un créneau d'autrui) */
function nextForeignResa() {
  const mepk = PRETS.me && PRETS.me.pk;
  const resas = ((LOAN_STATE && LOAN_STATE.reservations) || []).filter(
    (r) => r.is_active && !(mepk && r.reserved_for_user === mepk),
  );
  if (!resas.length) return null;
  return resas.reduce((m, r) => (r.start_date < m.start_date ? r : m), resas[0]);
}
/* onBehalf : réservation d'autrui qu'un ADMIN confirme AU NOM du bénéficiaire
   (le prêt sera enregistré à son nom). Sinon, emprunt/confirmation self-service. */
function openLendForm(onBehalf) {
  if (!CURRENT) return;
  LEND_ONBEHALF = onBehalf || null;
  renderMiniHead($("#lendHead"), CURRENT);
  const due = $("#lendDue");
  due.min = isoPlus(0);

  // au nom d'autrui (admin) : la réservation confirmée est celle du bénéficiaire ;
  // sinon MA réservation (en cours ou à venir) préremplit le formulaire
  const resa = onBehalf || myResa(LOAN_STATE);
  $("#lendWho").value = onBehalf ? onBehalf.reserved_for_label : meName();
  $("#lendWhoHint").textContent = onBehalf
    ? t("lend_hint_behalf", onBehalf.reserved_for_label)
    : t("lend_hint_self");

  const info = $("#lendInfo");
  if (resa) {
    $("#lendInfoTxt").textContent = onBehalf
      ? t("lend_info_behalf", onBehalf.reserved_for_label, resaRange(onBehalf))
      : resa.is_current
        ? t("lend_info_current", resaRange(resa))
        : t("lend_info_mine", resaRange(resa));
    info.classList.add("show");
    due.value = resa.end_date;
  } else {
    info.classList.remove("show");
    due.value = isoPlus(PRETS.duration);
  }

  // borne : retour au plus tard la veille du prochain créneau d'autrui
  // (les admins passent outre, le serveur les laisse faire)
  const clash = nextForeignResa();
  if (clash && !meIsAdmin()) {
    const maxIso = isoPlus(-1, loanParseDate(clash.start_date));
    due.max = maxIso;
    if (due.value > maxIso) due.value = maxIso;
  } else {
    due.removeAttribute("max");
  }

  // champ « Pour (asso/club) » facultatif, selon le réglage du plugin —
  // confirmer une réservation reprend son asso et son motif (modifiables)
  $("#lendForField").style.display = PRETS.onBehalf ? "" : "none";
  $("#lendFor").value = (resa && resa.on_behalf) || "";

  $("#lendNotes").value = (resa && resa.notes) || "";
  hideErr($("#lendErr"));
  updateLendWarn();
  show("#screen-lend");
}
/* rappelle la borne quand une réservation d'autrui limite la durée d'emprunt */
function updateLendWarn() {
  const warn = $("#lendWarn");
  if (!warn) return;
  const clash = nextForeignResa();
  if (clash) {
    $("#lendWarnTxt").textContent = meIsAdmin()
      ? t("lend_warn_admin", clash.reserved_for_label, resaRange(clash))
      : t(
          "lend_warn_limit",
          clash.reserved_for_label,
          resaRange(clash),
          frDate(isoPlus(-1, loanParseDate(clash.start_date)), false),
        );
    warn.classList.add("show");
  } else warn.classList.remove("show");
}
async function submitLend() {
  if (!CURRENT) return;
  // tout est vérifié AVANT l'envoi : date présente, ni passée, ni au-delà de
  // la borne posée par une réservation d'autrui (le serveur revalide de toute façon)
  const due = $("#lendDue").value;
  if (!due) {
    showErr($("#lendErr"), t("lend_due_missing"));
    return;
  }
  if (due < isoPlus(0)) {
    showErr($("#lendErr"), t("lend_due_past"));
    return;
  }
  const dueMax = $("#lendDue").max;
  if (dueMax && due > dueMax) {
    showErr($("#lendErr"), t("lend_due_max", frDate(dueMax, false)));
    return;
  }
  hideErr($("#lendErr"));
  const body = { stock_item: CURRENT.pk };
  // self-service, ou confirmation par un admin AU NOM du bénéficiaire
  if (LEND_ONBEHALF) body.borrower_user = LEND_ONBEHALF.reserved_for_user;
  else if (PRETS.me && PRETS.me.pk) body.borrower_user = PRETS.me.pk;
  else body.borrower_name = meName();
  body.due_on = due;
  const notes = $("#lendNotes").value.trim();
  if (notes) body.notes = notes;
  const forOrg = $("#lendFor").value.trim();
  if (PRETS.onBehalf && forOrg) body.on_behalf = forOrg;
  const btn = $("#lendConfirmBtn"),
    html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> ' + t("lending");
  try {
    await api("/plugin/prets/lend", { method: "POST", body });
    toast(t("loan_saved"), "ok");
    show("#screen-item");
    refreshLoanBlock();
  } catch (e) {
    showErr($("#lendErr"), e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}

/* ---- rendre ---- */
async function submitReturn() {
  if (!CURRENT) return;
  const btn = $("#loanReturnBtn"),
    html = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> ' + t("returning");
  }
  try {
    await api("/plugin/prets/return", { method: "POST", body: { stock_item: CURRENT.pk } });
    toast(t("return_saved"), "ok");
    refreshLoanBlock();
  } catch (e) {
    toast(e.message, "bad");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = html;
    }
  }
}

/* ---- réserver (self-service : la réservation est au nom de l'utilisateur connecté) ---- */
function openReserveForm() {
  if (!CURRENT) return;
  renderMiniHead($("#resaHead"), CURRENT);
  $("#resaWho").value = meName();
  const s = $("#resaStart"),
    e = $("#resaEnd");
  // Objet actuellement emprunté : le créneau doit commencer après le retour
  // prévu (après aujourd'hui si le prêt est en retard). Même règle que le
  // serveur, qui reste juge en dernier ressort (409 sinon).
  let minIso = isoPlus(0);
  const cur = LOAN_STATE && LOAN_STATE.active ? LOAN_STATE.loan : null;
  if (cur && cur.due_on) {
    const limit = cur.due_on < minIso ? minIso : cur.due_on;
    minIso = isoPlus(1, loanParseDate(limit));
  }
  s.min = minIso;
  e.min = minIso;
  s.value = minIso;
  e.value = minIso;
  // champ « Pour (asso/club) » facultatif, selon le réglage du plugin
  $("#resaForField").style.display = PRETS.onBehalf ? "" : "none";
  $("#resaFor").value = "";
  $("#resaNotes").value = "";
  hideErr($("#resaErr"));
  show("#screen-reserve");
}
async function submitReserve() {
  if (!CURRENT) return;
  const s = $("#resaStart").value,
    e = $("#resaEnd").value;
  if (!s || !e) {
    showErr($("#resaErr"), t("resa_dates_missing"));
    return;
  }
  if (e < s) {
    showErr($("#resaErr"), t("resa_dates_order"));
    return;
  }
  hideErr($("#resaErr"));
  const body = { stock_item: CURRENT.pk, start_date: s, end_date: e };
  if (PRETS.me && PRETS.me.pk) body.reserved_for_user = PRETS.me.pk;
  else body.reserved_for_name = meName();
  const notes = $("#resaNotes").value.trim();
  if (notes) body.notes = notes;
  const forOrg = $("#resaFor").value.trim();
  if (PRETS.onBehalf && forOrg) body.on_behalf = forOrg;
  const btn = $("#resaConfirmBtn"),
    html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> ' + t("reserving");
  try {
    await api("/plugin/prets/reserve", { method: "POST", body });
    toast(t("resa_saved"), "ok");
    show("#screen-item");
    refreshLoanBlock();
  } catch (e2) {
    showErr($("#resaErr"), e2.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}
async function cancelReservation(pk, whoLabel, mine) {
  // modale en propre plutôt que le confirm() du navigateur. Annuler la
  // réservation de quelqu'un d'autre le prévient par email : la modale
  // exige alors un motif (obligatoire), transmis dans cet email.
  const ok = await appConfirm(
    mine
      ? {
          title: t("cancel_my_resa_q"),
          text: t("cancel_my_resa_txt"),
          confirmLabel: t("cancel_my_resa"),
          cancelLabel: t("keep"),
          danger: true,
        }
      : {
          title: t("cancel_resa_q", whoLabel),
          text: t("cancel_resa_txt", whoLabel),
          confirmLabel: t("cancel_resa_btn"),
          cancelLabel: t("keep"),
          danger: true,
          promptLabel: t("cancel_reason_lbl"),
          promptPlaceholder: t("cancel_reason_ph"),
          promptRequired: true,
        },
  );
  if (!ok) return;
  const body = { reservation: pk };
  if (ok.value) body.reason = ok.value;
  try {
    await api("/plugin/prets/reservation/cancel", { method: "POST", body });
    toast(t("resa_cancelled"), "ok");
    refreshLoanBlock();
  } catch (e) {
    toast(e.message, "bad");
  }
}
