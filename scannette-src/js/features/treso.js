/* ==========================================================================
   features/treso.js — Trésorerie du frigo (admins) : portefeuilles de tous les
   membres, tous les achats, export CSV (plugin inventree-paiements).

   Entrée : bouton « Trésorerie » en tête du mode Gérer du frigo.
   - Portefeuilles : total dû aux membres, solde de chacun ; un membre ->
     feuille de correction (crédit / débit, note obligatoire, journalisé avec
     l'auteur ; le serveur refuse tout solde négatif).
   - Achats : achats et recharges payés, filtrés par période et par membre ;
     totaux encaissé par carte / vendu au portefeuille ; export CSV de la même
     sélection (corrections de solde comprises).
   ========================================================================== */

let TRESO_TAB = "wallets"; // "wallets" | "purchases"
let TRESO_MEMBERS = null; // dernière liste /wallet/admin
const TRESO_F = { from: "", to: "", user: "" }; // filtres de l'onglet Achats

function tresoIso(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

async function openTreso() {
  rememberView("treso");
  show("#screen-treso");
  await achatReadyPromise;
  if (!ACHAT.admin) {
    toast(t("treso_admin_only"), "bad");
    openFrigo();
    return;
  }
  // période par défaut : le mois en cours
  if (!TRESO_F.from) {
    const now = new Date();
    TRESO_F.from = tresoIso(new Date(now.getFullYear(), now.getMonth(), 1));
    TRESO_F.to = tresoIso(now);
  }
  tresoSetTab(TRESO_TAB);
}

function tresoSetTab(tab) {
  TRESO_TAB = tab;
  const seg = $("#tresoSeg");
  seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  segSync(seg);
  if (tab === "purchases") tresoPurchases();
  else tresoWallets();
}

/* ---- onglet Portefeuilles ---- */
async function tresoWallets() {
  const box = $("#tresoBody");
  box.innerHTML = '<div class="card"><div class="skeleton">' + esc(t("loading")) + "</div></div>";
  let d;
  try {
    d = await api("/plugin/paiements/wallet/admin");
  } catch (e) {
    box.innerHTML = '<div class="card"><div class="skeleton">' + esc(e.message) + "</div></div>";
    return;
  }
  if (TRESO_TAB !== "wallets") return;
  TRESO_MEMBERS = d.members;
  box.innerHTML =
    '<div class="wal-card"><div class="wal-l"><div class="wal-k">👛 ' + esc(t("treso_total_k")) + "</div>" +
    '<div class="wal-amt">' + esc(eurCents(d.total_cents)) + "</div>" +
    '<div class="treso-sub">' + esc(t("treso_total_n", d.count)) + "</div></div></div>" +
    '<input type="text" id="tresoSearch" class="treso-search" placeholder="' + esc(t("treso_search")) + '" autocomplete="off">' +
    '<div class="card" id="tresoList"></div>';
  const list = $("#tresoList");
  const paint = () => {
    const q = $("#tresoSearch").value.trim().toLowerCase();
    const rows = d.members.filter((m) => !q || (m.name + " " + m.username).toLowerCase().includes(q));
    list.innerHTML = rows.length ? "" : '<div class="skeleton">' + esc(t("treso_none")) + "</div>";
    rows.slice(0, 200).forEach((m) => {
      const row = document.createElement("button");
      row.className = "purch-row";
      row.innerHTML =
        '<div class="pm"><div class="t">' + esc(m.name) + '</div><div class="s">@' + esc(m.username) + "</div></div>" +
        '<div class="pt' + (m.balance_cents ? "" : " zero") + '">' + esc(eurCents(m.balance_cents)) + "</div>";
      row.onclick = () => openWalletAdminSheet(m);
      list.appendChild(row);
    });
  };
  $("#tresoSearch").addEventListener("input", paint);
  paint();
}

/* feuille d'un membre : solde, correction, derniers mouvements */
function openWalletAdminSheet(m) {
  let sign = 1;
  const ov = document.createElement("div");
  ov.className = "modal-ov sheet-ov";
  ov.innerHTML =
    '<div class="ps-sheet" role="dialog" aria-modal="true" aria-label="' + esc(m.name) + '">' +
    '<div class="ps-grab" aria-hidden="true"></div>' +
    '<div class="ps-head"><div class="ps-name"><div class="t">' + esc(m.name) + '</div><div class="s">@' + esc(m.username) +
    " · " + esc(t("wal_balance_lbl")) + ' <b data-bal>' + esc(eurCents(m.balance_cents)) + "</b></div></div>" +
    '<button class="iconbtn" data-x aria-label="' + esc(t("cancel")) + '">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>' +
    '<div class="seg treso-sign"><button type="button" class="seg-btn active" data-s="1">' + esc(t("treso_credit")) +
    '</button><button type="button" class="seg-btn" data-s="-1">' + esc(t("treso_debit")) + "</button></div>" +
    '<div class="ps-amount"><label class="ps-field"><input id="taInput" type="text" inputmode="decimal" autocomplete="off" placeholder="0,00"><span>€</span></label></div>' +
    '<div class="field treso-note"><input type="text" id="taNote" maxlength="200" placeholder="' + esc(t("treso_note_ph")) + '"></div>' +
    '<button class="btn btn-primary btn-block" data-go disabled></button>' +
    '<details class="ps-hist" open><summary>' + esc(t("treso_moves")) + '</summary><div class="ps-hist-l"><div class="ps-empty">' +
    esc(t("loading")) + "</div></div></details></div>";
  const input = ov.querySelector("#taInput"),
    note = ov.querySelector("#taNote"),
    go = ov.querySelector("[data-go]"),
    seg = ov.querySelector(".treso-sign");
  const cents = () => {
    const v = input.value.trim().replace(",", ".");
    return /^\d{1,4}(\.\d{1,2})?$/.test(v) ? Math.round(parseFloat(v) * 100) : NaN;
  };
  const sync = () => {
    input.style.width = Math.max(4, (input.value || input.placeholder).length) + 0.3 + "ch";
    const c = cents();
    go.disabled = !(c > 0) || !note.value.trim();
    go.textContent = c > 0 ? t(sign > 0 ? "treso_credit_x" : "treso_debit_x", eurCents(c)) : t("treso_apply");
  };
  seg.querySelectorAll(".seg-btn").forEach((b) => {
    b.onclick = () => {
      sign = Number(b.dataset.s);
      seg.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
      segSync(seg);
      sync();
    };
  });
  input.addEventListener("input", sync);
  note.addEventListener("input", sync);
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
  const loadMoves = async () => {
    try {
      const w = await api("/plugin/paiements/wallet/admin?user=" + m.user);
      ov.querySelector("[data-bal]").textContent = eurCents(w.balance_cents);
      const l = ov.querySelector(".ps-hist-l");
      l.innerHTML = w.entries.length
        ? w.entries
            .map(
              (e) =>
                '<div class="ps-hrow"><span class="pr">' + esc(e.label || t("treso_kind_" + e.kind)) +
                (e.by ? '<br><small class="who">' + esc(t("treso_by", e.by)) + "</small>" : "") +
                '</span><span class="who"><b class="' + (e.amount_cents > 0 ? "plus" : "minus") + '">' +
                (e.amount_cents > 0 ? "+" : "−") + esc(eurCents(Math.abs(e.amount_cents))) + "</b><br>" + esc(e.date) + "</span></div>",
            )
            .join("")
        : '<div class="ps-empty">' + esc(t("treso_no_moves")) + "</div>";
    } catch (e) {
      ov.querySelector(".ps-hist-l").innerHTML = '<div class="ps-empty">' + esc(e.message) + "</div>";
    }
  };
  go.onclick = async () => {
    const c = cents();
    const h = go.innerHTML;
    go.disabled = true;
    go.innerHTML = '<span class="spin"></span>';
    try {
      const r = await api("/plugin/paiements/wallet/admin", {
        method: "POST",
        body: { user: m.user, amount_cents: sign * c, note: note.value.trim() },
      });
      toast(t("treso_done", m.name, eurCents(r.balance_cents)), "ok");
      m.balance_cents = r.balance_cents;
      input.value = "";
      note.value = "";
      go.innerHTML = h;
      sync();
      loadMoves();
      if (TRESO_TAB === "wallets" && $("#screen-treso").classList.contains("active")) tresoWallets();
    } catch (e) {
      go.disabled = false;
      go.innerHTML = h;
      toast(e.message, "bad");
    }
  };
  document.body.appendChild(ov);
  segSync(seg);
  sync();
  loadMoves();
}

/* ---- onglet Achats ---- */
function tresoQuery() {
  const p = new URLSearchParams();
  if (TRESO_F.from) p.set("from", TRESO_F.from);
  if (TRESO_F.to) p.set("to", TRESO_F.to);
  if (TRESO_F.user) p.set("user", TRESO_F.user);
  return p.toString();
}

async function tresoPurchases() {
  const box = $("#tresoBody");
  // la liste des membres sert au filtre : chargée une fois
  if (!TRESO_MEMBERS) {
    try {
      TRESO_MEMBERS = (await api("/plugin/paiements/wallet/admin")).members;
    } catch (_) {
      TRESO_MEMBERS = [];
    }
  }
  const members = TRESO_MEMBERS.slice().sort((a, b) => a.name.localeCompare(b.name));
  box.innerHTML =
    '<div class="treso-filters">' +
    '<label><span>' + esc(t("treso_from")) + '</span><input type="date" id="tfFrom" value="' + esc(TRESO_F.from) + '"></label>' +
    '<label><span>' + esc(t("treso_to")) + '</span><input type="date" id="tfTo" value="' + esc(TRESO_F.to) + '"></label>' +
    '<label class="wide"><span>' + esc(t("treso_member")) + '</span><select id="tfUser"><option value="">' + esc(t("treso_all")) + "</option>" +
    members.map((m) => '<option value="' + m.user + '"' + (String(m.user) === TRESO_F.user ? " selected" : "") + ">" + esc(m.name) + "</option>").join("") +
    "</select></label></div>" +
    '<div id="tresoSum"></div>' +
    '<button class="btn btn-ghost btn-block" id="tresoCsv">⬇ ' + esc(t("treso_csv")) + "</button>" +
    '<div class="card" id="tresoPList"><div class="skeleton">' + esc(t("loading")) + "</div></div>";
  const reload = () => {
    TRESO_F.from = $("#tfFrom").value;
    TRESO_F.to = $("#tfTo").value;
    TRESO_F.user = $("#tfUser").value;
    tresoPurchaseList();
  };
  ["#tfFrom", "#tfTo", "#tfUser"].forEach((s) => $(s).addEventListener("change", reload));
  $("#tresoCsv").onclick = () => tresoCsv($("#tresoCsv"));
  tresoPurchaseList();
}

async function tresoPurchaseList() {
  const list = $("#tresoPList");
  list.innerHTML = '<div class="skeleton">' + esc(t("loading")) + "</div>";
  let d;
  try {
    d = await api("/plugin/paiements/purchases?all=1&" + tresoQuery());
  } catch (e) {
    list.innerHTML = '<div class="skeleton">' + esc(e.message) + "</div>";
    return;
  }
  if (TRESO_TAB !== "purchases" || !$("#tresoPList")) return;
  // encaissé par carte (achats directs + recharges) / vendu au portefeuille
  let card = 0,
    wallet = 0;
  d.purchases.forEach((p) => {
    if (p.method === "wallet") wallet += p.amount_cents;
    else card += p.amount_cents;
  });
  $("#tresoSum").innerHTML =
    '<div class="treso-sum"><div><span>' + esc(t("treso_sum_card")) + "</span><b>" + esc(eurCents(card)) + "</b></div>" +
    "<div><span>" + esc(t("treso_sum_wallet")) + "</span><b>" + esc(eurCents(wallet)) + "</b></div>" +
    "<div><span>" + esc(t("treso_sum_n")) + "</span><b>" + d.count + "</b></div></div>" +
    (d.count > d.purchases.length ? '<p class="treso-more">' + esc(t("treso_more", d.purchases.length)) + "</p>" : "");
  if (!d.purchases.length) {
    list.innerHTML = '<div class="skeleton">' + esc(t("treso_no_purch")) + "</div>";
    return;
  }
  list.innerHTML = "";
  d.purchases.forEach((p) => {
    const topup = p.kind === "topup";
    const row = document.createElement("button");
    row.className = "purch-row";
    row.innerHTML =
      '<div class="pm"><div class="t">' + esc(p.buyer) + " · " + esc(p.date) + " " + esc(p.time) + '</div><div class="s">' +
      esc(t("rcpt_no", p.pk)) + " · " +
      esc(topup ? t("wal_topup_line") : p.lines.map((l) => (l.quantity > 1 ? l.quantity + "× " : "") + l.name).join(", ")) +
      " · " + esc(p.method === "wallet" ? t("wal_name") : t("treso_card")) +
      (p.warning ? " · ⚠" : "") + '</div></div><div class="pt' + (topup ? " plus" : "") + '">' + (topup ? "+" : "") + esc(p.total) + "</div>";
    row.onclick = () => openReceipt(p.pk, false);
    list.appendChild(row);
  });
}

/* export CSV de la sélection (protégé par le token : fetch + blob) */
async function tresoCsv(btn) {
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>';
  try {
    const res = await fetch(API + "/plugin/paiements/treso/export.csv?" + tresoQuery(), {
      headers: TOKEN ? { Authorization: "Token " + TOKEN } : {},
    });
    if (!res.ok) throw new Error(t("error_n", res.status));
    const blob = await res.blob();
    const m = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : "tresorerie-frigo.csv";
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
