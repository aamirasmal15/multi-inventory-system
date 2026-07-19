/* Widget dashboard "Prêts en cours" : liste des objets actuellement prêtés,
   retards en premier. Charge par get_ui_dashboard_items du plugin.

   Bilingue : les libelles suivent data.locale (preference utilisateur).
   Meme DA que le panneau : variables CSS Mantine (theme clair/sombre). */

const PRETS_DASH_CSS = `
.prets-dash{
  --prets-border: var(--mantine-color-gray-3);
  --prets-hover: var(--mantine-color-gray-1);
  width:100%;height:100%;overflow-y:auto;color:var(--mantine-color-text);
  font-size:var(--mantine-font-size-sm);line-height:var(--mantine-line-height,1.55)
}
[data-mantine-color-scheme=dark] .prets-dash{
  --prets-border: var(--mantine-color-dark-4);
  --prets-hover: var(--mantine-color-dark-5)
}
.prets-dash-head{display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:8px}
.prets-dash-count{display:inline-flex;align-items:center;height:18px;padding:0 8px;border-radius:32px;font-size:11px;font-weight:700;background:var(--mantine-color-blue-light);color:var(--mantine-color-blue-light-color)}
.prets-dash-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--mantine-radius-default,4px);text-decoration:none;color:inherit}
.prets-dash-row:hover{background:var(--prets-hover)}
.prets-dash-row:not(:last-child){border-bottom:1px solid var(--prets-border)}
.prets-dash-badge{display:inline-flex;align-items:center;height:18px;padding:0 8px;border-radius:32px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap;flex-shrink:0}
.prets-dash-badge.blue{background:var(--mantine-color-blue-light);color:var(--mantine-color-blue-light-color)}
.prets-dash-badge.red{background:var(--mantine-color-red-light);color:var(--mantine-color-red-light-color)}
.prets-dash-badge.violet{background:var(--mantine-color-violet-light);color:var(--mantine-color-violet-light-color)}
.prets-dash-badge.green{background:var(--mantine-color-green-light);color:var(--mantine-color-green-light-color)}
.prets-dash-badge.orange{background:var(--mantine-color-orange-light);color:var(--mantine-color-orange-light-color)}
.prets-dash-item{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prets-dash-who{color:var(--mantine-color-dimmed);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.prets-dash-due{color:var(--mantine-color-dimmed);white-space:nowrap;font-size:var(--mantine-font-size-xs)}
.prets-dash-due.late{color:var(--mantine-color-red-filled,#e03131);font-weight:600}
.prets-dash-dim{color:var(--mantine-color-dimmed)}
.prets-dash-error{color:var(--mantine-color-red-filled,#e03131)}
`;

const PRETS_DASH_I18N = {
  fr: {
    loading: "Chargement…",
    title: "Prêts en cours",
    overdue: (n) => n + " en retard",
    late: "Retard",
    lent: "Prêté",
    none: "Aucun prêt en cours.",
    err: "Impossible de charger les prêts : ",
    item: "Objet #",
    resTitle: "Réservations à venir",
    resBadge: "Réservé",
    resCurrent: "En cours",
    resNone: "Aucune réservation à venir.",
    resErr: "Impossible de charger les réservations : ",
    resRange: (a, b) => "du " + a + " au " + b,
  },
  en: {
    loading: "Loading…",
    title: "Active loans",
    overdue: (n) => n + " overdue",
    late: "Overdue",
    lent: "On loan",
    none: "No active loan.",
    err: "Could not load loans: ",
    item: "Item #",
    resTitle: "Upcoming reservations",
    resBadge: "Reserved",
    resCurrent: "Current",
    resNone: "No upcoming reservation.",
    resErr: "Could not load reservations: ",
    resRange: (a, b) => a + " to " + b,
  },
};

function pretsDashStyles() {
  if (!document.getElementById("prets-dash-css")) {
    const s = document.createElement("style");
    s.id = "prets-dash-css";
    s.textContent = PRETS_DASH_CSS;
    document.head.appendChild(s);
  }
}

function pretsDashEsc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* Formate une date ISO selon le réglage InvenTree DATE_DISPLAY_FORMAT de
   l'utilisateur (transmis par le plugin dans data.context.date_format). */
function pretsDashDate(s, fmt, locale) {
  const iso = String(s || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-");
  // MMM avant MM : « MMM DD YYYY » ne doit pas voir son mois écrasé
  return (fmt || "DD-MM-YYYY")
    .replace("YYYY", y)
    .replace("MMM", new Date(+y, +m - 1, +d).toLocaleDateString(locale, { month: "short" }))
    .replace("MM", m)
    .replace("DD", d);
}

export function renderPretsDashboard(target, data) {
  if (!target) {
    console.error("renderPretsDashboard: pas de cible");
    return;
  }

  pretsDashStyles();

  const fr = String(data.locale || "").toLowerCase().startsWith("fr");
  const T = fr ? PRETS_DASH_I18N.fr : PRETS_DASH_I18N.en;
  const dashFmt = (data.context && data.context.date_format) || "DD-MM-YYYY";
  const dashLoc = fr ? "fr" : "en";

  const api = data.api;

  target.innerHTML =
    '<div class="prets-dash"><span class="prets-dash-dim">' + T.loading + "</span></div>";

  api
    .get("/plugin/prets/active")
    .then((resp) => {
      const loans = Array.isArray(resp.data) ? resp.data : resp.data.results || [];

      // Retards en premier, puis par echeance la plus proche
      loans.sort((a, b) => {
        if (a.is_overdue !== b.is_overdue) return a.is_overdue ? -1 : 1;
        return String(a.due_on || "9999").localeCompare(String(b.due_on || "9999"));
      });

      const overdueCount = loans.filter((l) => l.is_overdue).length;

      let html = '<div class="prets-dash">';
      html +=
        '<div class="prets-dash-head">' + T.title + " " +
        '<span class="prets-dash-count">' + loans.length + "</span>" +
        (overdueCount
          ? '<span class="prets-dash-badge red">' + T.overdue(overdueCount) + "</span>"
          : "") +
        "</div>";

      if (!loans.length) {
        html += '<span class="prets-dash-dim">' + T.none + "</span>";
      } else {
        loans.forEach((l) => {
          html +=
            '<a class="prets-dash-row" href="/web/stock/item/' + l.stock_item + '">' +
            '<span class="prets-dash-badge ' + (l.is_overdue ? "red" : "orange") + '">' +
            (l.is_overdue ? T.late : T.lent) +
            "</span>" +
            '<span class="prets-dash-item">' +
            pretsDashEsc(l.item_label || (T.item + l.stock_item)) + "</span>" +
            '<span class="prets-dash-who">' + pretsDashEsc(l.borrower_label) + "</span>" +
            (l.due_on
              ? '<span class="prets-dash-due' + (l.is_overdue ? " late" : "") + '">' +
                pretsDashEsc(pretsDashDate(l.due_on, dashFmt, dashLoc)) + "</span>"
              : "") +
            "</a>";
        });
      }

      html += "</div>";
      target.innerHTML = html;
    })
    .catch((err) => {
      target.innerHTML =
        '<div class="prets-dash"><span class="prets-dash-error">' +
        T.err + pretsDashEsc(err && err.message) + "</span></div>";
    });
}

export function renderResasDashboard(target, data) {
  if (!target) {
    console.error("renderResasDashboard: pas de cible");
    return;
  }

  pretsDashStyles();

  const fr = String(data.locale || "").toLowerCase().startsWith("fr");
  const T = fr ? PRETS_DASH_I18N.fr : PRETS_DASH_I18N.en;
  const dashFmt = (data.context && data.context.date_format) || "DD-MM-YYYY";
  const dashLoc = fr ? "fr" : "en";

  const api = data.api;

  target.innerHTML =
    '<div class="prets-dash"><span class="prets-dash-dim">' + T.loading + "</span></div>";

  api
    .get("/plugin/prets/reservations")
    .then((resp) => {
      const resas = Array.isArray(resp.data) ? resp.data : resp.data.results || [];

      // En cours d'abord, puis par debut de creneau le plus proche
      resas.sort((a, b) => {
        if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
        return String(a.start_date).localeCompare(String(b.start_date));
      });

      let html = '<div class="prets-dash">';
      html +=
        '<div class="prets-dash-head">' + T.resTitle + " " +
        '<span class="prets-dash-count">' + resas.length + "</span></div>";

      if (!resas.length) {
        html += '<span class="prets-dash-dim">' + T.resNone + "</span>";
      } else {
        resas.forEach((r) => {
          html +=
            '<a class="prets-dash-row" href="/web/stock/item/' + r.stock_item + '">' +
            '<span class="prets-dash-badge ' + (r.is_current ? "green" : "violet") + '">' +
            (r.is_current ? T.resCurrent : T.resBadge) +
            "</span>" +
            '<span class="prets-dash-item">' +
            pretsDashEsc(r.item_label || (T.item + r.stock_item)) + "</span>" +
            '<span class="prets-dash-who">' + pretsDashEsc(r.reserved_for_label) + "</span>" +
            '<span class="prets-dash-due">' +
            pretsDashEsc(T.resRange(
              pretsDashDate(r.start_date, dashFmt, dashLoc),
              pretsDashDate(r.end_date, dashFmt, dashLoc),
            )) +
            "</span>" +
            "</a>";
        });
      }

      html += "</div>";
      target.innerHTML = html;
    })
    .catch((err) => {
      target.innerHTML =
        '<div class="prets-dash"><span class="prets-dash-error">' +
        T.resErr + pretsDashEsc(err && err.message) + "</span></div>";
    });
}
