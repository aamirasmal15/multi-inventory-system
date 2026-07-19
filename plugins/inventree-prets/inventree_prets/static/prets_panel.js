/* Panneau "Prêts" injecte sur la fiche d'un article de stock (StockItem).
   Charge par le systeme de plugins InvenTree via get_ui_panels du plugin.

   Bilingue : les libelles suivent la langue de l'utilisateur, fournie par
   InvenTree dans data.locale (francais si fr*, anglais sinon).

   L'historique est une replique du tableau de suivi de stock natif
   (InvenTreeTable / mantine-datatable, verifie dans le code source 1.4.1) :
   toolbar (recherche debouncee, Rafraichir / Filtres / Exporter), filtres du
   tracking (date min, date max, utilisateur), tableau raye avec bordures de
   colonnes et mini-tableau Details, pied de page avec pagination. */

const PRETS_CSS = `
.prets-root{
  --prets-border: var(--mantine-color-gray-3);
  --prets-striped: var(--mantine-color-gray-0);
  --prets-hover: var(--mantine-color-gray-1);
  width:100%;color:var(--mantine-color-text);
  font-size:var(--mantine-font-size-sm);line-height:var(--mantine-line-height,1.55)
}
[data-mantine-color-scheme=dark] .prets-root{
  --prets-border: var(--mantine-color-dark-4);
  --prets-striped: var(--mantine-color-dark-6);
  --prets-hover: var(--mantine-color-dark-5)
}
.prets-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.prets-card{border:1px solid var(--prets-border);border-radius:var(--mantine-radius-default,4px);padding:14px 16px;margin-bottom:16px}
.prets-card.accent-blue{border-left:4px solid var(--mantine-primary-color-filled)}
.prets-card.accent-red{border-left:4px solid var(--mantine-color-red-filled)}
.prets-card.accent-green{border-left:4px solid var(--mantine-color-green-filled)}
.prets-card.accent-violet{border-left:4px solid var(--mantine-color-violet-filled)}
.prets-card.accent-orange{border-left:4px solid var(--mantine-color-orange-filled)}
.prets-badge{display:inline-flex;align-items:center;height:20px;padding:0 10px;border-radius:32px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap}
.prets-badge.blue{background:var(--mantine-color-blue-light);color:var(--mantine-color-blue-light-color)}
.prets-badge.green{background:var(--mantine-color-green-light);color:var(--mantine-color-green-light-color)}
.prets-badge.red{background:var(--mantine-color-red-light);color:var(--mantine-color-red-light-color)}
.prets-badge.gray{background:var(--mantine-color-gray-light);color:var(--mantine-color-gray-light-color)}
.prets-badge.violet{background:var(--mantine-color-violet-light);color:var(--mantine-color-violet-light-color)}
.prets-badge.orange{background:var(--mantine-color-orange-light);color:var(--mantine-color-orange-light-color)}
.prets-title{font-weight:600;font-size:15px}
.prets-dim{color:var(--mantine-color-dimmed)}
.prets-italic{font-style:italic}
.prets-spacer{flex:1}
.prets-btn{display:inline-flex;align-items:center;justify-content:center;height:calc(2.25rem * var(--mantine-scale,1));padding:0 calc(1.125rem * var(--mantine-scale,1));border:none;border-radius:var(--mantine-radius-default,4px);font-family:inherit;font-size:var(--mantine-font-size-sm);font-weight:600;cursor:pointer;white-space:nowrap;background:var(--mantine-primary-color-filled);color:var(--mantine-color-white,#fff);transition:background-color .1s ease}
.prets-btn:hover:not(:disabled){background:var(--mantine-primary-color-filled-hover)}
.prets-btn:disabled{opacity:.55;cursor:not-allowed}
.prets-btn.green{background:var(--mantine-color-green-filled)}
.prets-btn.green:hover:not(:disabled){background:var(--mantine-color-green-filled-hover)}
.prets-btn.violet{background:var(--mantine-color-violet-filled)}
.prets-btn.violet:hover:not(:disabled){background:var(--mantine-color-violet-filled-hover)}
.prets-res-row{display:flex;align-items:center;gap:10px;padding:7px 0}
.prets-res-row:not(:last-of-type){border-bottom:1px solid var(--prets-border)}
.prets-res-row .who{font-weight:600;font-size:14px}
.prets-plan{margin:2px 0 14px}
.prets-plan-bar{display:flex;height:30px;border-radius:var(--mantine-radius-default,4px);overflow:hidden;border:1px solid var(--prets-border)}
.prets-plan-seg{display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;min-width:0;overflow:hidden;white-space:nowrap;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.25)}
.prets-plan-seg.free{background:var(--mantine-color-green-light);color:var(--mantine-color-green-light-color);text-shadow:none}
.prets-plan-seg.lent{background-color:var(--mantine-color-orange-filled);background-image:repeating-linear-gradient(-45deg,rgba(255,255,255,.28) 0 5px,transparent 5px 10px)}
.prets-plan-seg.book{background-color:var(--mantine-color-violet-filled);background-image:repeating-linear-gradient(-45deg,rgba(255,255,255,.28) 0 5px,transparent 5px 10px)}
.prets-plan-scale{display:flex;justify-content:space-between;font-size:var(--mantine-font-size-xs);color:var(--mantine-color-dimmed);margin-top:4px}
.prets-xbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;background:transparent;color:var(--mantine-color-red-filled,#e03131);cursor:pointer;border-radius:var(--mantine-radius-default,4px);padding:0;flex-shrink:0}
.prets-xbtn:hover{background:var(--mantine-color-red-light)}
.prets-field{display:flex;flex-direction:column;min-width:180px}
.prets-field.grow{flex:1}
.prets-field.compact{min-width:140px}
.prets-label{font-size:var(--mantine-font-size-sm);font-weight:500;margin-bottom:4px}
.prets-input{height:calc(2.25rem * var(--mantine-scale,1));padding:0 12px;border:calc(.0625rem * var(--mantine-scale,1)) solid var(--mantine-color-default-border);border-radius:var(--mantine-radius-default,4px);background:var(--mantine-color-default);color:var(--mantine-color-text);font-size:var(--mantine-font-size-sm);font-family:inherit;outline:none;transition:border-color .1s ease}
.prets-input:focus{border-color:var(--mantine-primary-color-filled)}
.prets-input:disabled{background:var(--mantine-color-gray-1);color:var(--mantine-color-dimmed);cursor:not-allowed;opacity:.8}
[data-mantine-color-scheme=dark] .prets-input:disabled{background:var(--mantine-color-dark-5)}
.prets-error{color:var(--mantine-color-red-filled,#e03131);font-size:13px;margin-top:10px}
.prets-h{font-weight:600;font-size:15px;margin:0}
.prets-toolbar{display:flex;align-items:center;gap:8px;margin:4px 0 10px}
.prets-search{position:relative;width:230px}
.prets-search input{width:100%;height:34px;padding:0 30px 0 34px;border:1px solid var(--mantine-color-default-border);border-radius:var(--mantine-radius-default,4px);background:var(--mantine-color-default);color:var(--mantine-color-text);font-size:var(--mantine-font-size-sm);font-family:inherit;outline:none;transition:border-color .1s ease}
.prets-search input:focus{border-color:var(--mantine-primary-color-filled)}
.prets-search .ic{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--mantine-color-dimmed);display:flex;pointer-events:none}
.prets-search .clear{position:absolute;right:5px;top:50%;transform:translateY(-50%);border:none;background:none;color:var(--mantine-color-dimmed);cursor:pointer;display:none;padding:2px;border-radius:3px}
.prets-search .clear:hover{background:var(--prets-hover)}
.prets-aicon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;background:transparent;color:var(--mantine-color-text);cursor:pointer;border-radius:var(--mantine-radius-default,4px);position:relative;padding:0}
.prets-aicon:hover{background:var(--prets-hover)}
.prets-aicon .cnt{position:absolute;top:-4px;right:-4px;min-width:15px;height:15px;border-radius:15px;background:var(--mantine-primary-color-filled);color:#fff;font-size:9.5px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 3px}
.prets-filterbar{display:none;align-items:end;gap:12px;flex-wrap:wrap;border:1px dashed var(--prets-border);border-radius:var(--mantine-radius-default,4px);padding:10px 12px;margin-bottom:10px}
.prets-filterbar.open{display:flex}
.prets-clearlink{border:none;background:none;color:var(--mantine-primary-color-filled);cursor:pointer;font-size:var(--mantine-font-size-sm);padding:0 4px;height:34px;font-family:inherit}
.prets-clearlink:hover{text-decoration:underline}
.prets-dt{overflow-x:auto;border:calc(.0625rem * var(--mantine-scale,1)) solid var(--prets-border)}
.prets-dt-table{width:100%;table-layout:fixed;border-collapse:collapse;border-spacing:0;line-height:var(--mantine-line-height);font-size:var(--mantine-font-size-sm);border:none}
.prets-dt-table th,.prets-dt-table td{padding:7px var(--mantine-spacing-xs,10px);text-align:left;background:inherit;overflow-wrap:break-word;vertical-align:top}
/* Largeurs stables (layout fixe, posées par l'en-tête), calées sur le tableau
   de suivi de stock natif : Description à 200px (le minWidth natif), Date
   compacte, Utilisateur à l'aise, Détails et Notes se partagent le reste.
   Sans ça, chaque page de l'historique redimensionnait les colonnes autrement. */
.prets-dt-table thead th{white-space:nowrap}
.prets-dt-table thead th:nth-child(1){width:96px}
.prets-dt-table thead th:nth-child(2){width:200px}
.prets-dt-table thead th:nth-child(3){width:36%}
.prets-dt-table thead th:nth-child(5){width:172px}
.prets-dt-table td:first-child{white-space:nowrap}
.prets-dt-table th:not(:first-child),.prets-dt-table td:not(:first-child){border-inline-start:calc(.0625rem * var(--mantine-scale,1)) solid var(--prets-border)}
.prets-dt-table thead th{background:var(--mantine-color-body);box-shadow:inset 0 -1px 0 var(--prets-border)}
.prets-dt-table > tbody > tr{background:var(--mantine-color-body)}
.prets-dt-table > tbody > tr:nth-of-type(odd){background:var(--prets-striped)}
.prets-dt-table > tbody > tr:hover{background:var(--prets-hover)}
.prets-dt-table > tbody > tr:not(:last-of-type) > td{border-bottom:calc(.0625rem * var(--mantine-scale,1)) solid var(--prets-border)}
.prets-dt-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 10px;border-top:calc(.0625rem * var(--mantine-scale,1)) solid var(--prets-border);background:var(--mantine-color-body);font-size:var(--mantine-font-size-sm)}
.prets-psize{display:flex;align-items:center;gap:6px;color:var(--mantine-color-dimmed);font-size:var(--mantine-font-size-xs)}
.prets-psize select{height:28px;padding:0 6px;border:1px solid var(--mantine-color-default-border);border-radius:var(--mantine-radius-default,4px);background:var(--mantine-color-default);color:var(--mantine-color-text);font-size:var(--mantine-font-size-xs);font-family:inherit;outline:none;cursor:pointer}
.prets-pg{display:flex;gap:4px}
.prets-pg-btn{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:0 5px;border:1px solid var(--mantine-color-default-border);border-radius:var(--mantine-radius-default,4px);background:var(--mantine-color-default);color:var(--mantine-color-text);font-size:var(--mantine-font-size-xs);cursor:pointer;font-family:inherit}
.prets-pg-btn:hover:not(:disabled):not(.active){background:var(--prets-hover)}
.prets-pg-btn.active{background:var(--mantine-primary-color-filled);border-color:var(--mantine-primary-color-filled);color:#fff;cursor:default}
.prets-pg-btn:disabled{opacity:.4;cursor:not-allowed}
.prets-pg-dots{display:inline-flex;align-items:center;padding:0 2px;color:var(--mantine-color-dimmed)}
/* Mini-tableau Détails : colonne des libellés à largeur FIXE pour que le
   filet vertical (hérité de .prets-dt-table td:not(:first-child)) s'aligne
   d'une ligne de l'historique à l'autre, sans gaspiller d'espace à gauche. */
.prets-subtable{width:100%;table-layout:fixed;border-collapse:collapse;border-spacing:0;font-size:var(--mantine-font-size-sm);line-height:var(--mantine-line-height);border:none}
.prets-subtable td{padding:7px 10px;text-align:left;overflow-wrap:break-word}
.prets-subtable td:first-child{width:150px;white-space:nowrap;color:var(--mantine-color-dimmed)}
.prets-subtable tr:nth-of-type(odd){background:var(--prets-striped)}
.prets-user{display:inline-flex;align-items:center;gap:8px}
.prets-user .xs{font-size:var(--mantine-font-size-xs)}
.prets-modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px;z-index:1000}
.prets-modal{background:var(--mantine-color-body);color:var(--mantine-color-text);border-radius:var(--mantine-radius-md,8px);box-shadow:0 10px 40px rgba(0,0,0,.35);padding:20px 22px;max-width:400px;width:100%}
.prets-modal h4{margin:0 0 6px;font-size:var(--mantine-font-size-md);font-weight:600}
.prets-modal p{margin:0 0 16px;color:var(--mantine-color-dimmed);font-size:var(--mantine-font-size-sm)}
.prets-modal-field{min-width:0;margin:-6px 0 16px}
.prets-modal-actions{display:flex;gap:10px;justify-content:flex-end}
.prets-btn.gray{background:var(--mantine-color-default);color:var(--mantine-color-text);border:1px solid var(--mantine-color-default-border)}
.prets-btn.red{background:var(--mantine-color-red-filled,#fa5252)}
`;

const PRETS_SVG = {
  search:
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/></svg>',
  refresh:
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/></svg>',
  filter:
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227z"/></svg>',
  download:
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4l0 12"/></svg>',
  x:
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>',
  user:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/><path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/></svg>',
};

const PRETS_PAGE_SIZES = [10, 15, 20, 25, 50, 100, 500];

/* Libelles bilingues : la langue vient de data.locale (preference utilisateur) */
const PRETS_I18N = {
  fr: {
    loading: "Chargement…",
    errLoad: "Impossible de charger les prêts : ",
    errHist: "Impossible de charger l'historique : ",
    unknownErr: "erreur inconnue",
    onLoan: "Emprunté",
    overdue: "En retard",
    available: "Disponible",
    returned: "Rendu",
    returnedLate: "Rendu en retard",
    active: "En cours",
    lentTo: "Emprunté par",
    lentAt: "Prêté le",
    dueOn: "Retour prévu le",
    canLend: "Cet objet peut être emprunté.",
    borrower: "Emprunteur",
    borrowerPh: "Nom de l'emprunteur",
    lend: "Emprunter",
    confirmLend: "Confirmer l'emprunt",
    confirmLendFor: (who) => "Confirmer l'emprunt de " + who,
    doReturnEarly: "Rendre plus tôt",
    doReturnFor: (who) => "Enregistrer le retour de " + who,
    lending: "Emprunt en cours…",
    forOrg: "Pour",
    forOrgPh: "asso, club… (facultatif)",
    doReturn: "Enregistrer le retour",
    returning: "Retour en cours…",
    notes: "Notes",
    notesPh: "Optionnel : motif, caution, état de l'objet…",
    needBorrower: "Indique le nom de l'emprunteur.",
    datePast: "La date de retour ne peut pas être antérieure à aujourd'hui.",
    lendFail: "Échec du prêt : ",
    returnFail: "Échec du retour : ",
    history: "Historique des prêts",
    search: "Rechercher",
    refresh: "Rafraîchir les données",
    filters: "Filtres du tableau",
    exportData: "Exporter les données",
    clear: "Effacer",
    minDate: "Date minimum",
    maxDate: "Date maximum",
    user: "Utilisateur",
    all: "Tous",
    clearFilters: "Effacer les filtres",
    colDate: "Date",
    colDesc: "Description",
    colDetails: "Détails",
    colNotes: "Notes",
    colUser: "Utilisateur",
    status: "Statut",
    expected: "Retour prévu",
    returnedAt: "Rendu le",
    loanRecordedBy: "Emprunt enregistré par",
    returnRecordedBy: "Retour enregistré par",
    loanWord: "Prêt",
    noUser: "Aucune information utilisateur",
    noMatch: "Aucun prêt ne correspond à la recherche.",
    noLoans: "Aucun prêt enregistré pour cet objet.",
    perPage: "Éléments par page",
    csvName: "prets_objet_",
    resTitle: "Réservations",
    resBadge: "Réservé",
    resNone: "Aucune réservation à venir : cet objet peut être réservé.",
    resFor: "Réservé pour",
    resForPh: "Nom, club, équipe…",
    resFrom: "Du",
    resTo: "Au",
    resNotesPh: "Optionnel : événement, projet…",
    reserve: "Réserver",
    reserving: "Réservation…",
    resNeedWho: "Indique pour qui est la réservation.",
    resNeedDates: "Indique les dates du créneau.",
    resEndBefore: "La date de fin est avant la date de début.",
    resFail: "Échec de la réservation : ",
    resCancelTitle: "Annuler la réservation",
    resCancelTitleMine: "Annuler ma réservation",
    resCancelConfirm: "Annuler la réservation de {who} ?",
    resCancelConfirmMine: "Annuler votre réservation ?",
    resCancelText: "Elle sera définitivement supprimée.",
    resCancelTextOther:
      "Elle sera définitivement supprimée et {who} sera prévenu(e) par email.",
    resCancelReason: "Motif (obligatoire, envoyé dans l'email)",
    resCancelReasonPh: "ex. objet indisponible, maintenance…",
    resCancelKeep: "Garder",
    resCancelDo: "Annuler la réservation",
    resCancelDoMine: "Annuler ma réservation",
    resCancelFail: "Échec de l'annulation : ",
    resCreatedBy: "créée par",
    resRange: (a, b) => (a === b ? "le " + a : "du " + a + " au " + b),
    resNow: (who, end) => "Réservé par " + who + " jusqu'au " + end + ".",
    resNowMine: (end) => "Réservé pour vous jusqu'au " + end + ".",
    selfService: "enregistré à votre nom",
    onBehalfHint: "vous confirmez sa réservation (enregistré à son nom)",
    planFree: "libre",
    planLent: "emprunté",
  },
  en: {
    loading: "Loading…",
    errLoad: "Could not load loans: ",
    errHist: "Could not load history: ",
    unknownErr: "unknown error",
    onLoan: "On loan",
    overdue: "Overdue",
    available: "Available",
    returned: "Returned",
    returnedLate: "Returned late",
    active: "Active",
    lentTo: "On loan to",
    lentAt: "Lent on",
    dueOn: "Due back on",
    canLend: "This item can be borrowed.",
    borrower: "Borrower",
    borrowerPh: "Borrower name",
    lend: "Borrow",
    confirmLend: "Confirm the borrowing",
    confirmLendFor: (who) => "Confirm the loan for " + who,
    doReturnEarly: "Return early",
    doReturnFor: (who) => "Record return for " + who,
    lending: "Borrowing…",
    forOrg: "For",
    forOrgPh: "association, club… (optional)",
    doReturn: "Record return",
    returning: "Returning…",
    notes: "Notes",
    notesPh: "Optional: reason, deposit, item condition…",
    needBorrower: "Enter the borrower's name.",
    datePast: "The return date cannot be before today.",
    lendFail: "Lend failed: ",
    returnFail: "Return failed: ",
    history: "Loan history",
    search: "Search",
    refresh: "Refresh data",
    filters: "Table filters",
    exportData: "Export data",
    clear: "Clear",
    minDate: "Minimum date",
    maxDate: "Maximum date",
    user: "User",
    all: "All",
    clearFilters: "Clear filters",
    colDate: "Date",
    colDesc: "Description",
    colDetails: "Details",
    colNotes: "Notes",
    colUser: "User",
    status: "Status",
    expected: "Due back",
    returnedAt: "Returned at",
    loanRecordedBy: "Loan recorded by",
    returnRecordedBy: "Return recorded by",
    loanWord: "Loan",
    noUser: "No user information",
    noMatch: "No loan matches the search.",
    noLoans: "No loan recorded for this item.",
    perPage: "Records per page",
    csvName: "loans_item_",
    resTitle: "Reservations",
    resBadge: "Reserved",
    resNone: "No upcoming reservation: this item can be reserved.",
    resFor: "Reserved for",
    resForPh: "Name, club, team…",
    resFrom: "From",
    resTo: "To",
    resNotesPh: "Optional: event, project…",
    reserve: "Reserve",
    reserving: "Reserving…",
    resNeedWho: "Enter who the reservation is for.",
    resNeedDates: "Enter the slot dates.",
    resEndBefore: "The end date is before the start date.",
    resFail: "Reservation failed: ",
    resCancelTitle: "Cancel the reservation",
    resCancelTitleMine: "Cancel my reservation",
    resCancelConfirm: "Cancel the reservation of {who}?",
    resCancelConfirmMine: "Cancel your reservation?",
    resCancelText: "It will be permanently deleted.",
    resCancelTextOther:
      "It will be permanently deleted and {who} will be notified by email.",
    resCancelReason: "Reason (required, sent in the email)",
    resCancelReasonPh: "e.g. item unavailable, maintenance…",
    resCancelKeep: "Keep it",
    resCancelDo: "Cancel the reservation",
    resCancelDoMine: "Cancel my reservation",
    resCancelFail: "Cancellation failed: ",
    resCreatedBy: "created by",
    resRange: (a, b) => (a === b ? "on " + a : a + " to " + b),
    resNow: (who, end) => "Reserved by " + who + " until " + end + ".",
    resNowMine: (end) => "Reserved for you until " + end + ".",
    selfService: "recorded in your name",
    onBehalfHint: "you are confirming their reservation (recorded in their name)",
    planFree: "free",
    planLent: "on loan",
  },
};

/* Dictionnaire actif, choisi au rendu selon data.locale */
let T = PRETS_I18N.en;

/* Format d'affichage des dates : le réglage InvenTree DATE_DISPLAY_FORMAT
   de l'utilisateur (transmis par le plugin dans data.context.date_format).
   Repli DD-MM-YYYY = le défaut posé par le plugin côté serveur (apps.py). */
let PRETS_DATE_FMT = "DD-MM-YYYY";
let PRETS_DATE_LOCALE = "en";

function pretsLang(locale) {
  return String(locale || "").toLowerCase().startsWith("fr")
    ? PRETS_I18N.fr
    : PRETS_I18N.en;
}

function pretsEnsureStyles() {
  if (!document.getElementById("prets-panel-css")) {
    const s = document.createElement("style");
    s.id = "prets-panel-css";
    s.textContent = PRETS_CSS;
    document.head.appendChild(s);
  }
}

function pretsEsc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function pretsParse(s) {
  if (!s) return null;
  const str = String(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(str.replace(" ", "T"));
  return isNaN(d) ? null : d;
}

function pretsFmtDate(s) {
  const d = pretsParse(s);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  // MMM avant MM : « MMM DD YYYY » ne doit pas voir son mois écrasé
  return PRETS_DATE_FMT
    .replace("YYYY", String(d.getFullYear()))
    .replace("MMM", d.toLocaleDateString(PRETS_DATE_LOCALE, { month: "short" }))
    .replace("MM", p(d.getMonth() + 1))
    .replace("DD", p(d.getDate()));
}

function pretsFmtDateTime(s) {
  const d = pretsParse(s);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return pretsFmtDate(s) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function pretsIso(plus) {
  const t = new Date();
  t.setDate(t.getDate() + (plus || 0));
  const p = (n) => String(n).padStart(2, "0");
  return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate());
}

function pretsBadge(kind, label) {
  return '<span class="prets-badge ' + kind + '">' + pretsEsc(label) + "</span>";
}

/* Confirmation en modale (à la place du confirm() du navigateur) :
   overlay + carte aux variables Mantine, Échap / clic dehors = annuler.
   Avec promptLabel (et promptPlaceholder), la modale ajoute un champ texte
   facultatif et résout {ok:true, value} au lieu de true — false inchangé. */
function pretsConfirm(opts) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "prets-modal-ov";
    ov.innerHTML =
      '<div class="prets-modal" role="dialog" aria-modal="true">' +
      "<h4>" + pretsEsc(opts.title) + "</h4>" +
      "<p>" + pretsEsc(opts.text) + "</p>" +
      (opts.promptLabel
        ? '<div class="prets-field prets-modal-field">' +
          '<label class="prets-label">' + pretsEsc(opts.promptLabel) + "</label>" +
          '<input class="prets-input" data-prompt maxlength="200" placeholder="' +
          pretsEsc(opts.promptPlaceholder || "") + '">' +
          "</div>"
        : "") +
      '<div class="prets-modal-actions">' +
      '<button type="button" class="prets-btn gray" data-act="no">' +
      pretsEsc(opts.cancelLabel) + "</button>" +
      '<button type="button" class="prets-btn red" data-act="yes"' +
      (opts.promptRequired ? " disabled" : "") + ">" +
      pretsEsc(opts.confirmLabel) + "</button>" +
      "</div></div>";
    const input = ov.querySelector("input[data-prompt]");
    // motif obligatoire : bouton de confirmation bloqué tant que c'est vide
    if (input && opts.promptRequired) {
      const yesBtn = ov.querySelector('button[data-act="yes"]');
      input.addEventListener("input", () => {
        yesBtn.disabled = !input.value.trim();
      });
    }
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
    };
    // scroll de la page bloqué tant que la modale est ouverte
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const done = (v) => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      ov.remove();
      resolve(v);
    };
    ov.addEventListener("click", (e) => {
      if (e.target === ov) {
        done(false);
        return;
      }
      const b = e.target.closest("button[data-act]");
      if (b) {
        if (b.dataset.act !== "yes") done(false);
        else done(input ? { ok: true, value: input.value.trim() } : true);
      }
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
    ov.querySelector('button[data-act="no"]').focus();
  });
}

function pretsIsoFrom(base, plus) {
  const t = pretsParse(base) || new Date();
  t.setDate(t.getDate() + (plus || 0));
  const p = (n) => String(n).padStart(2, "0");
  return t.getFullYear() + "-" + p(t.getMonth() + 1) + "-" + p(t.getDate());
}

function pretsDayDiff(a, b) {
  const da = pretsParse(a),
    db = pretsParse(b);
  if (!da || !db) return 0;
  da.setHours(0, 0, 0, 0);
  db.setHours(0, 0, 0, 0);
  return Math.round((db - da) / 864e5);
}

/* Libellés de la frise : la plus longue variante qui TIENT dans le segment —
   « Aamir ASMAL (EirSpace) » puis « Aamir ASMAL » puis « Aamir » puis rien.
   Jamais de texte coupé : on mesure après le rendu (même logique que la
   Scannette). */
function pretsPlanVariants(label) {
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
function pretsFitPlanLabels(root) {
  (root || document).querySelectorAll("[data-plan-label]").forEach((el) => {
    const span = el.firstElementChild;
    if (!span) return;
    const max = el.clientWidth - 6; // petit respirateur de chaque côté
    for (const v of pretsPlanVariants(el.dataset.planLabel)) {
      span.textContent = v;
      if (!v || span.offsetWidth <= max) return;
    }
  });
}
let pretsResizeBound = false;
function pretsBindPlanResize() {
  if (pretsResizeBound) return;
  pretsResizeBound = true;
  window.addEventListener("resize", () => {
    if (document.querySelector("[data-plan-label]")) pretsFitPlanLabels(document);
  });
}

/* Frise du planning : aujourd'hui -> horizon, créneaux emprunté (orange
   hachuré) / réservé (violet hachuré) / libre (vert). Même logique que le
   planning de la Scannette, en compact pour ne pas surcharger le panneau. */
function pretsPlanHtml(payload) {
  const today = pretsIso(0);
  const events = [];
  const loan = payload && payload.active ? payload.loan : null;
  if (loan) {
    events.push({
      kind: "lent",
      who: loan.borrower_label,
      from: today,
      to: loan.due_on && loan.due_on > today ? loan.due_on : today,
    });
  }
  ((payload && payload.reservations) || []).forEach((r) => {
    events.push({
      kind: "book",
      who: r.reserved_for_label,
      from: r.start_date > today ? r.start_date : today,
      to: r.end_date,
    });
  });
  events.sort((a, b) => (a.from < b.from ? -1 : 1));
  let horizon = pretsIso(14);
  events.forEach((e) => {
    if (e.to > horizon) horizon = e.to;
  });
  const slots = [];
  let cursor = today;
  events.forEach((e) => {
    if (e.from > cursor) slots.push({ kind: "free", from: cursor, to: pretsIsoFrom(e.from, -1) });
    slots.push(e);
    const next = pretsIsoFrom(e.to, 1);
    if (next > cursor) cursor = next;
  });
  if (cursor <= horizon) slots.push({ kind: "free", from: cursor, to: horizon });
  const total = Math.max(1, pretsDayDiff(today, horizon) + 1);
  let bar = "";
  slots.forEach((s) => {
    const days = Math.max(1, pretsDayDiff(s.from, s.to) + 1);
    const label = s.kind === "free" ? T.planFree : s.who || T.planLent;
    bar +=
      '<div class="prets-plan-seg ' + s.kind + '" style="flex:' + days + '" title="' +
      pretsEsc(label + " · " + pretsFmtDate(s.from) + " → " + pretsFmtDate(s.to)) +
      '" data-plan-label="' + pretsEsc(label) + '"><span></span></div>';
  });
  const mid = pretsIsoFrom(today, Math.floor(total / 2));
  return (
    '<div class="prets-plan"><div class="prets-plan-bar">' + bar + "</div>" +
    '<div class="prets-plan-scale"><span>' + pretsEsc(pretsFmtDate(today)) + "</span><span>" +
    pretsEsc(pretsFmtDate(mid)) + "</span><span>" + pretsEsc(pretsFmtDate(horizon)) + "</span></div></div>"
  );
}

function pretsUser(detail) {
  if (!detail) {
    return '<span class="prets-dim prets-italic">' + T.noUser + "</span>";
  }
  const full = ((detail.first_name || "") + " " + (detail.last_name || "")).trim();
  return (
    '<span class="prets-user">' +
    "<span>" + pretsEsc(detail.username) + "</span>" +
    (full ? '<span class="xs">' + pretsEsc(full) + "</span>" : "") +
    PRETS_SVG.user +
    "</span>"
  );
}

/* Rendu en retard : la date de retour effective dépasse l'échéance prévue
   (is_overdue ne couvre que les prêts encore actifs). */
function pretsLateReturn(h) {
  return !!(h.returned_at && h.due_on && pretsDayDiff(h.due_on, h.returned_at) > 0);
}

function pretsStatusOf(h) {
  if (h.returned_at) {
    return pretsLateReturn(h)
      ? pretsBadge("red", T.returnedLate)
      : pretsBadge("gray", T.returned);
  }
  if (h.is_overdue) return pretsBadge("red", T.overdue);
  return pretsBadge("orange", T.active);
}

/* L'acteur (qui a enregistre l'emprunt ou le retour) merite une ligne dans
   les details seulement quand ce n'est pas l'emprunteur lui-meme : le cas
   courant reste vierge, seul l'agir-au-nom-d'un-autre est signale. */
function pretsRecordedByOther(detail, h) {
  return detail && detail.pk && h.borrower_user && detail.pk !== h.borrower_user;
}

function pretsDetails(h) {
  const rows = [
    [T.status, pretsStatusOf(h)],
    [T.borrower, pretsEsc(h.borrower_label)],
    [T.expected, h.due_on ? pretsEsc(pretsFmtDate(h.due_on)) : null],
    [T.returnedAt, h.returned_at ? pretsEsc(pretsFmtDateTime(h.returned_at)) : null],
    [T.loanRecordedBy, pretsRecordedByOther(h.lent_by_detail, h) ? pretsUser(h.lent_by_detail) : null],
    [T.returnRecordedBy, pretsRecordedByOther(h.returned_by_detail, h) ? pretsUser(h.returned_by_detail) : null],
  ];

  let html = '<table class="prets-subtable"><tbody>';
  rows.forEach(([label, value]) => {
    if (value) html += "<tr><td>" + label + "</td><td>" + value + "</td></tr>";
  });
  html += "</tbody></table>";
  return html;
}

function pretsPageItems(cur, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const items = [1];
  if (cur > 3) items.push("...");
  for (let i = Math.max(2, cur - 1); i <= Math.min(total - 1, cur + 1); i++) {
    items.push(i);
  }
  if (cur < total - 2) items.push("...");
  items.push(total);
  return items;
}

export function renderPretsPanel(target, data) {
  if (!target) {
    console.error("renderPretsPanel: pas de cible");
    return;
  }

  pretsEnsureStyles();
  T = pretsLang(data.locale);
  PRETS_DATE_FMT = (data.context && data.context.date_format) || "DD-MM-YYYY";
  PRETS_DATE_LOCALE = String(data.locale || "").toLowerCase().startsWith("fr") ? "fr" : "en";

  const api = data.api;
  const itemId = data.id;
  const defaultDays =
    (data.context && parseInt(data.context.default_days, 10)) || 14;
  const resasEnabled = !!(data.context && data.context.reservations_enabled);
  const askOnBehalf = !!(data.context && data.context.ask_on_behalf);
  const me = (data.context && data.context.me) || null;
  // champ « Pour (asso/club) » facultatif, activé par le réglage ASK_ON_BEHALF
  const forField = (id, value) =>
    askOnBehalf
      ? '<div class="prets-field compact">' +
        '<label class="prets-label" for="' + id + '">' + T.forOrg + "</label>" +
        '<input id="' + id + '" class="prets-input" value="' + pretsEsc(value || "") +
        '" placeholder="' + T.forOrgPh + '">' +
        "</div>"
      : "";

  const st = {
    page: 1,
    pageSize: 25,
    search: "",
    fMin: "",
    fMax: "",
    fUser: "",
    filterOpen: false,
    users: null,
  };

  let searchTimer = null;

  target.innerHTML =
    '<div class="prets-root"><span class="prets-dim">' + T.loading + "</span></div>";

  function apiError(err) {
    return err && err.response && err.response.data && err.response.data.error
      ? err.response.data.error
      : (err && err.message) || T.unknownErr;
  }

  function historyParams() {
    const p = {
      stock_item: itemId,
      limit: st.pageSize,
      offset: (st.page - 1) * st.pageSize,
    };
    if (st.search) p.search = st.search;
    if (st.fMin) p.min_date = st.fMin;
    if (st.fMax) p.max_date = st.fMax;
    if (st.fUser) p.user = st.fUser;
    return p;
  }

  function loadAll() {
    api
      .get(`/plugin/prets/item/${itemId}`)
      .then((resp) => {
        renderShell(resp.data);
        fetchHistory();
      })
      .catch((err) => {
        target.innerHTML =
          '<div class="prets-root"><span class="prets-error">' +
          T.errLoad + pretsEsc(err && err.message) + "</span></div>";
      });
  }

  function fetchHistory() {
    const box = target.querySelector("#prets-hist");
    if (!box) return;
    api
      .get("/plugin/prets/loans", { params: historyParams() })
      .then((resp) => renderHistory(resp.data))
      .catch((err) => {
        box.innerHTML =
          '<span class="prets-error">' + T.errHist + pretsEsc(err && err.message) + "</span>";
      });
  }

  function loadUsers(select) {
    if (st.users) return;
    api
      .get("/api/user/", { params: { limit: 100 } })
      .then((resp) => {
        st.users = resp.data.results || resp.data || [];
        st.users.forEach((u) => {
          const o = document.createElement("option");
          o.value = u.pk;
          // prénom nom quand on l'a (plus lisible), repli sur le login
          const full = ((u.first_name || "") + " " + (u.last_name || "")).trim();
          o.textContent = full || u.username;
          select.appendChild(o);
        });
      })
      .catch(() => {
        const field = select.closest(".prets-field");
        if (field) field.style.display = "none";
      });
  }

  function exportCsv() {
    const p = historyParams();
    p.limit = 10000;
    p.offset = 0;
    api.get("/plugin/prets/loans", { params: p }).then((resp) => {
      const rows = resp.data.results || resp.data || [];
      const head = [T.colDate, T.status, T.borrower, T.expected, T.returnedAt, T.colNotes, T.colUser];
      const csv = [head.join(";")]
        .concat(
          rows.map((h) =>
            [
              pretsFmtDate(h.lent_at),
              h.returned_at
                ? pretsLateReturn(h)
                  ? T.returnedLate
                  : T.returned
                : h.is_overdue
                  ? T.overdue
                  : T.active,
              h.borrower_label,
              h.due_on ? pretsFmtDate(h.due_on) : "",
              h.returned_at ? pretsFmtDateTime(h.returned_at) : "",
              h.notes || "",
              h.lent_by_detail ? h.lent_by_detail.username : "",
            ]
              .map((v) => {
                let s = String(v == null ? "" : v);
                // notes/noms libres : neutralise les débuts de formule
                // (=, +, -, @, tabulation) qu'Excel exécuterait à l'ouverture
                if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
                return '"' + s.replace(/"/g, '""') + '"';
              })
              .join(";")
          )
        )
        .join("\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = T.csvName + itemId + ".csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  function filterCount() {
    return [st.fMin, st.fMax, st.fUser].filter(Boolean).length;
  }

  function renderShell(payload) {
    const loan = payload && payload.active ? payload.loan : null;

    let html = '<div class="prets-root">';

    // réservation dont le créneau est en cours : l'objet est « Réservé »
    const currentResa =
      resasEnabled && payload && payload.reservations
        ? payload.reservations.find((r) => r.is_current)
        : null;

    if (loan) {
      const overdue = loan.is_overdue;
      html +=
        '<div class="prets-card ' + (overdue ? "accent-red" : "accent-orange") + '">' +
        '<div class="prets-row">' +
        pretsBadge(overdue ? "red" : "orange", overdue ? T.overdue : T.onLoan) +
        "<div>" +
        '<div class="prets-title">' + T.lentTo + " " + pretsEsc(loan.borrower_label) + "</div>" +
        '<div class="prets-dim">' +
        T.lentAt + " " + pretsEsc(pretsFmtDateTime(loan.lent_at)) +
        (loan.due_on ? " · " + T.dueOn + " " + pretsEsc(pretsFmtDate(loan.due_on)) : "") +
        (loan.notes ? " · " + pretsEsc(loan.notes) : "") +
        "</div>" +
        "</div>" +
        '<div class="prets-spacer"></div>' +
        // retour réservé à qui a enregistré le prêt (et aux admins) ;
        // avant l'échéance, rendre = rendre plus tôt (l'objet redevient libre).
        // Si je rends AU NOM d'un autre (admin/enregistreur, pas l'emprunteur),
        // le bouton nomme la personne pour éviter les erreurs de manipulation.
        (loan.can_return !== false
          ? '<button id="prets-return" class="prets-btn">' +
            (me && loan.borrower_user === me.pk
              ? loan.due_on && loan.due_on > pretsIso(0)
                ? T.doReturnEarly
                : T.doReturn
              : T.doReturnFor(pretsEsc(loan.borrower_label))) +
            "</button>"
          : "") +
        "</div>" +
        '<div id="prets-return-err"></div>' +
        "</div>";
    } else {
      // mon créneau en cours : confirmer l'emprunt reprend les éléments de la
      // réservation (fin de créneau, asso, motif), modifiables avant l'envoi
      const mineResa =
        currentResa && me && currentResa.reserved_for_user === me.pk
          ? currentResa
          : null;
      // un ADMIN peut confirmer la réservation d'AUTRUI au nom du bénéficiaire
      // (le prêt est enregistré à son nom, suivi correct)
      const onBehalfResa =
        currentResa && !mineResa && me && me.is_admin ? currentResa : null;
      // réservation reprise par ce prêt (la mienne, ou celle que je confirme)
      const confirmResa = mineResa || onBehalfResa;
      html +=
        '<div class="prets-card ' + (currentResa ? "accent-violet" : "accent-green") + '">' +
        '<div class="prets-row" style="margin-bottom:12px">' +
        (currentResa
          ? pretsBadge("violet", T.resBadge) +
            '<span class="prets-dim">' +
            pretsEsc(
              mineResa
                ? T.resNowMine(pretsFmtDate(currentResa.end_date))
                : T.resNow(currentResa.reserved_for_label, pretsFmtDate(currentResa.end_date)),
            ) +
            "</span>"
          : pretsBadge("green", T.available) +
            '<span class="prets-dim">' + T.canLend + "</span>") +
        "</div>" +
        '<div class="prets-row">' +
        '<div class="prets-field grow">' +
        '<label class="prets-label" for="prets-borrower">' + T.borrower + "</label>" +
        // self-service au nom de l'utilisateur connecté (grisé), ou au nom du
        // bénéficiaire quand un admin confirme SA réservation
        '<input id="prets-borrower" class="prets-input" disabled value="' +
        pretsEsc(onBehalfResa ? onBehalfResa.reserved_for_label : (me ? me.name : "")) +
        '" title="' + (onBehalfResa ? T.onBehalfHint : T.selfService) + '">' +
        "</div>" +
        forField("prets-for", confirmResa && confirmResa.on_behalf) +
        '<div class="prets-field">' +
        '<label class="prets-label" for="prets-due">' + T.dueOn + "</label>" +
        '<input id="prets-due" class="prets-input" type="date" min="' +
        pretsIso(0) + '" value="' +
        (confirmResa ? confirmResa.end_date : pretsIso(defaultDays)) + '">' +
        "</div>" +
        '<div class="prets-field"><label class="prets-label">&nbsp;</label>' +
        // le bénéficiaire du créneau CONFIRME en empruntant ; un admin confirme
        // la réservation d'autrui au nom du bénéficiaire (data-borrower)
        '<button id="prets-lend" class="prets-btn"' +
        (onBehalfResa ? ' data-borrower="' + onBehalfResa.reserved_for_user + '"' : "") +
        ">" +
        (onBehalfResa
          ? T.confirmLendFor(onBehalfResa.reserved_for_label)
          : mineResa ? T.confirmLend : T.lend) +
        "</button></div>" +
        "</div>" +
        '<div class="prets-row" style="margin-top:10px">' +
        '<div class="prets-field grow">' +
        '<label class="prets-label" for="prets-notes">' + T.notes + "</label>" +
        '<input id="prets-notes" class="prets-input" value="' +
        pretsEsc((confirmResa && confirmResa.notes) || "") +
        '" placeholder="' + T.notesPh + '">' +
        "</div>" +
        "</div>" +
        '<div id="prets-lend-err"></div>' +
        "</div>";
    }

    // ---- Réservations (si activées dans les réglages du plugin) ----
    if (resasEnabled) {
      const resas = payload && payload.reservations ? payload.reservations : [];
      html += '<div class="prets-card accent-violet">';
      html +=
        '<div class="prets-row" style="margin-bottom:10px">' +
        '<span class="prets-h">' + T.resTitle + "</span></div>";

      // planning compact : la frise des créneaux à venir
      html += pretsPlanHtml(payload);

      if (!resas.length) {
        html +=
          '<div class="prets-dim" style="margin-bottom:12px">' + T.resNone + "</div>";
      } else {
        html += '<div style="margin-bottom:12px">';
        resas.forEach((r) => {
          html +=
            '<div class="prets-res-row">' +
            pretsBadge("violet", T.resBadge) +
            "<div>" +
            '<div class="who">' + pretsEsc(r.reserved_for_label) + "</div>" +
            '<div class="prets-dim">' +
            pretsEsc(T.resRange(pretsFmtDate(r.start_date), pretsFmtDate(r.end_date))) +
            (r.notes ? " · " + pretsEsc(r.notes) : "") +
            (r.created_by_detail
              ? " · " + T.resCreatedBy + " " + pretsEsc(r.created_by_detail.username)
              : "") +
            "</div>" +
            "</div>" +
            '<span class="prets-spacer"></span>' +
            // annulation réservée à qui a créé la réservation (et aux admins)
            (r.can_cancel
              ? '<button class="prets-xbtn" data-resa="' + r.pk +
                '" data-who="' + pretsEsc(r.reserved_for_label) +
                '" data-mine="' + (me && r.reserved_for_user === me.pk ? "1" : "") +
                '" title="' +
                (me && r.reserved_for_user === me.pk ? T.resCancelTitleMine : T.resCancelTitle) +
                '">' + PRETS_SVG.x + "</button>"
              : "") +
            "</div>";
        });
        html += "</div>";
      }

      // Objet actuellement emprunté : le créneau doit commencer après le
      // retour prévu (après aujourd'hui si le prêt est en retard). Même
      // règle que le serveur, qui reste juge en dernier ressort (409 sinon).
      let resMin = pretsIso(0);
      if (loan && loan.due_on) {
        const resLimit = loan.due_on < resMin ? resMin : loan.due_on;
        resMin = pretsIsoFrom(resLimit, 1);
      }

      html +=
        '<div class="prets-row">' +
        '<div class="prets-field grow">' +
        '<label class="prets-label" for="prets-res-who">' + T.resFor + "</label>" +
        // self-service : la réservation est au nom de l'utilisateur connecté (grisé)
        '<input id="prets-res-who" class="prets-input" disabled value="' +
        pretsEsc(me ? me.name : "") + '" title="' + T.selfService + '">' +
        "</div>" +
        forField("prets-res-for") +
        '<div class="prets-field compact">' +
        '<label class="prets-label" for="prets-res-from">' + T.resFrom + "</label>" +
        '<input id="prets-res-from" class="prets-input" type="date" min="' +
        resMin + '" value="' + resMin + '">' +
        "</div>" +
        '<div class="prets-field compact">' +
        '<label class="prets-label" for="prets-res-to">' + T.resTo + "</label>" +
        '<input id="prets-res-to" class="prets-input" type="date" min="' +
        resMin + '" value="' + resMin + '">' +
        "</div>" +
        '<div class="prets-field"><label class="prets-label">&nbsp;</label>' +
        '<button id="prets-reserve" class="prets-btn violet">' + T.reserve + "</button></div>" +
        "</div>" +
        '<div class="prets-row" style="margin-top:10px">' +
        '<div class="prets-field grow">' +
        '<label class="prets-label" for="prets-res-notes">' + T.notes + "</label>" +
        '<input id="prets-res-notes" class="prets-input" placeholder="' + T.resNotesPh + '">' +
        "</div>" +
        "</div>" +
        '<div id="prets-res-err"></div>' +
        "</div>";
    }

    html +=
      '<div class="prets-toolbar">' +
      '<span class="prets-h">' + T.history + "</span>" +
      '<span class="prets-spacer"></span>' +
      '<span class="prets-search"><span class="ic">' + PRETS_SVG.search + "</span>" +
      '<input id="prets-q" placeholder="' + T.search + '" aria-label="table-search-input">' +
      '<button class="clear" id="prets-q-clear" title="' + T.clear + '">' + PRETS_SVG.x + "</button></span>" +
      '<button class="prets-aicon" id="prets-refresh" title="' + T.refresh + '">' + PRETS_SVG.refresh + "</button>" +
      '<button class="prets-aicon" id="prets-filter" title="' + T.filters + '">' + PRETS_SVG.filter +
      '<span class="cnt" id="prets-fcount" style="display:none"></span></button>' +
      '<button class="prets-aicon" id="prets-export" title="' + T.exportData + '">' + PRETS_SVG.download + "</button>" +
      "</div>" +
      '<div class="prets-filterbar" id="prets-filterbar">' +
      '<div class="prets-field compact"><label class="prets-label">' + T.minDate + "</label>" +
      '<input id="prets-fmin" class="prets-input" type="date"></div>' +
      '<div class="prets-field compact"><label class="prets-label">' + T.maxDate + "</label>" +
      '<input id="prets-fmax" class="prets-input" type="date"></div>' +
      '<div class="prets-field compact"><label class="prets-label">' + T.user + "</label>" +
      '<select id="prets-fuser" class="prets-input"><option value="">' + T.all + "</option></select></div>" +
      '<button class="prets-clearlink" id="prets-fclear">' + T.clearFilters + "</button>" +
      "</div>" +
      '<div id="prets-hist"><span class="prets-dim">' + T.loading + "</span></div>";

    html += "</div>";
    target.innerHTML = html;

    // libellés de la frise ajustés à la place réelle de chaque segment —
    // ré-ajustés quand la frise change de taille (onglet monté caché,
    // barre latérale InvenTree repliée, fenêtre redimensionnée…)
    pretsFitPlanLabels(target);
    pretsBindPlanResize();
    const planBar = target.querySelector(".prets-plan-bar");
    if (planBar && window.ResizeObserver) {
      new ResizeObserver(() => pretsFitPlanLabels(target)).observe(planBar);
    }

    const lendBtn = target.querySelector("#prets-lend");
    if (lendBtn) {
      const lendLabel = lendBtn.textContent;
      lendBtn.addEventListener("click", () => {
        const errBox = target.querySelector("#prets-lend-err");
        errBox.innerHTML = "";
        const due = target.querySelector("#prets-due").value;
        if (due && due < pretsIso(0)) {
          errBox.innerHTML = '<div class="prets-error">' + T.datePast + "</div>";
          return;
        }
        lendBtn.disabled = true;
        lendBtn.textContent = T.lending;
        // self-service (au nom de l'utilisateur connecté), ou confirmation par
        // un admin AU NOM du bénéficiaire (data-borrower posé sur le bouton)
        const body = { stock_item: itemId };
        const onBehalfPk = lendBtn.dataset.borrower;
        if (onBehalfPk) body.borrower_user = Number(onBehalfPk);
        else if (me && me.pk) body.borrower_user = me.pk;
        else body.borrower_name = (me && me.name) || "?";
        if (due) body.due_on = due;
        const forOrg = target.querySelector("#prets-for");
        if (forOrg && forOrg.value.trim()) body.on_behalf = forOrg.value.trim();
        const notes = target.querySelector("#prets-notes").value.trim();
        if (notes) body.notes = notes;
        api
          .post("/plugin/prets/lend", body)
          .then(() => {
            st.page = 1;
            loadAll();
          })
          .catch((err) => {
            lendBtn.disabled = false;
            lendBtn.textContent = lendLabel;
            errBox.innerHTML =
              '<div class="prets-error">' + T.lendFail + pretsEsc(apiError(err)) + "</div>";
          });
      });
    }

    const returnBtn = target.querySelector("#prets-return");
    if (returnBtn) {
      const returnLabel = returnBtn.textContent;
      returnBtn.addEventListener("click", () => {
        const errBox = target.querySelector("#prets-return-err");
        errBox.innerHTML = "";
        returnBtn.disabled = true;
        returnBtn.textContent = T.returning;
        api
          .post("/plugin/prets/return", { stock_item: itemId })
          .then(() => {
            st.page = 1;
            loadAll();
          })
          .catch((err) => {
            returnBtn.disabled = false;
            returnBtn.textContent = returnLabel;
            errBox.innerHTML =
              '<div class="prets-error">' + T.returnFail + pretsEsc(apiError(err)) + "</div>";
          });
      });
    }

    const reserveBtn = target.querySelector("#prets-reserve");
    if (reserveBtn) {
      reserveBtn.addEventListener("click", () => {
        const errBox = target.querySelector("#prets-res-err");
        errBox.innerHTML = "";
        const from = target.querySelector("#prets-res-from").value;
        const to = target.querySelector("#prets-res-to").value;
        if (!from || !to) {
          errBox.innerHTML = '<div class="prets-error">' + T.resNeedDates + "</div>";
          return;
        }
        if (to < from) {
          errBox.innerHTML = '<div class="prets-error">' + T.resEndBefore + "</div>";
          return;
        }
        reserveBtn.disabled = true;
        reserveBtn.textContent = T.reserving;
        // self-service : la réservation est au nom de l'utilisateur connecté
        const body = { stock_item: itemId, start_date: from, end_date: to };
        if (me && me.pk) body.reserved_for_user = me.pk;
        else body.reserved_for_name = (me && me.name) || "?";
        const resFor = target.querySelector("#prets-res-for");
        if (resFor && resFor.value.trim()) body.on_behalf = resFor.value.trim();
        const notes = target.querySelector("#prets-res-notes").value.trim();
        if (notes) body.notes = notes;
        api
          .post("/plugin/prets/reserve", body)
          .then(() => loadAll())
          .catch((err) => {
            reserveBtn.disabled = false;
            reserveBtn.textContent = T.reserve;
            errBox.innerHTML =
              '<div class="prets-error">' + T.resFail + pretsEsc(apiError(err)) + "</div>";
          });
      });
    }

    target.querySelectorAll(".prets-xbtn[data-resa]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        // modale en propre plutôt que le confirm() du navigateur. Annuler la
        // réservation de quelqu'un d'autre le prévient par email : la modale
        // exige alors un motif (obligatoire), transmis dans cet email.
        const mine = btn.dataset.mine === "1";
        const ok = await pretsConfirm({
          title: mine
            ? T.resCancelConfirmMine
            : T.resCancelConfirm.replace("{who}", btn.dataset.who),
          text: mine
            ? T.resCancelText
            : T.resCancelTextOther.replace("{who}", btn.dataset.who),
          confirmLabel: mine ? T.resCancelDoMine : T.resCancelDo,
          cancelLabel: T.resCancelKeep,
          promptLabel: mine ? "" : T.resCancelReason,
          promptPlaceholder: T.resCancelReasonPh,
          promptRequired: !mine,
        });
        if (!ok) return;
        const errBox = target.querySelector("#prets-res-err");
        if (errBox) errBox.innerHTML = "";
        const body = { reservation: btn.dataset.resa };
        if (ok.value) body.reason = ok.value;
        api
          .post("/plugin/prets/reservation/cancel", body)
          .then(() => loadAll())
          .catch((err) => {
            if (errBox) {
              errBox.innerHTML =
                '<div class="prets-error">' + T.resCancelFail + pretsEsc(apiError(err)) + "</div>";
            }
          });
      });
    });

    const q = target.querySelector("#prets-q");
    const qClear = target.querySelector("#prets-q-clear");
    q.value = st.search;
    qClear.style.display = st.search ? "block" : "none";
    q.addEventListener("input", () => {
      qClear.style.display = q.value ? "block" : "none";
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        st.search = q.value.trim();
        st.page = 1;
        fetchHistory();
      }, 500);
    });
    qClear.addEventListener("click", () => {
      q.value = "";
      qClear.style.display = "none";
      st.search = "";
      st.page = 1;
      fetchHistory();
      q.focus();
    });

    target.querySelector("#prets-refresh").addEventListener("click", fetchHistory);
    target.querySelector("#prets-export").addEventListener("click", exportCsv);

    const fbar = target.querySelector("#prets-filterbar");
    const fbtn = target.querySelector("#prets-filter");
    const fmin = target.querySelector("#prets-fmin");
    const fmax = target.querySelector("#prets-fmax");
    const fuser = target.querySelector("#prets-fuser");
    fmin.value = st.fMin;
    fmax.value = st.fMax;
    if (st.filterOpen) fbar.classList.add("open");
    updateFilterCount();

    fbtn.addEventListener("click", () => {
      st.filterOpen = !st.filterOpen;
      fbar.classList.toggle("open", st.filterOpen);
      if (st.filterOpen) loadUsers(fuser);
    });

    function applyFilters() {
      st.fMin = fmin.value;
      st.fMax = fmax.value;
      st.fUser = fuser.value;
      st.page = 1;
      updateFilterCount();
      fetchHistory();
    }
    fmin.addEventListener("change", applyFilters);
    fmax.addEventListener("change", applyFilters);
    fuser.addEventListener("change", applyFilters);

    target.querySelector("#prets-fclear").addEventListener("click", () => {
      fmin.value = "";
      fmax.value = "";
      fuser.value = "";
      applyFilters();
    });

    function updateFilterCount() {
      const cnt = target.querySelector("#prets-fcount");
      const n = filterCount();
      cnt.style.display = n ? "flex" : "none";
      cnt.textContent = n;
    }
  }

  function renderHistory(payload) {
    const box = target.querySelector("#prets-hist");
    if (!box) return;

    const rows = payload.results || payload || [];
    const count = payload.count != null ? payload.count : rows.length;

    if (!count) {
      box.innerHTML =
        '<span class="prets-dim">' +
        (st.search || filterCount() ? T.noMatch : T.noLoans) +
        "</span>";
      return;
    }

    const totalPages = Math.max(1, Math.ceil(count / st.pageSize));
    if (st.page > totalPages) {
      st.page = totalPages;
      fetchHistory();
      return;
    }
    const from = (st.page - 1) * st.pageSize + 1;
    const to = Math.min(st.page * st.pageSize, count);

    let html =
      '<div class="prets-dt"><table class="prets-dt-table"><thead><tr>' +
      "<th>" + T.colDate + "</th><th>" + T.colDesc + "</th><th>" + T.colDetails +
      "</th><th>" + T.colNotes + "</th><th>" + T.colUser + "</th>" +
      "</tr></thead><tbody>";
    rows.forEach((h) => {
      html +=
        "<tr>" +
        "<td>" + pretsEsc(pretsFmtDate(h.lent_at)) + "</td>" +
        "<td>" + T.loanWord + "</td>" +
        "<td>" + pretsDetails(h) + "</td>" +
        "<td>" + (h.notes ? pretsEsc(h.notes) : "") + "</td>" +
        "<td>" + pretsUser(h.lent_by_detail) + "</td>" +
        "</tr>";
    });
    html += "</tbody></table>";

    html += '<div class="prets-dt-footer">';
    html += "<span>" + from + " - " + to + " / " + count + "</span>";
    html += '<span class="prets-spacer"></span>';
    html +=
      '<span class="prets-psize">' + T.perPage + ' <select id="prets-psize">' +
      PRETS_PAGE_SIZES.map(
        (n) =>
          '<option value="' + n + '"' + (n === st.pageSize ? " selected" : "") + ">" + n + "</option>"
      ).join("") +
      "</select></span>";

    if (totalPages > 1) {
      html += '<nav class="prets-pg">';
      html +=
        '<button class="prets-pg-btn" data-page="' + (st.page - 1) + '"' +
        (st.page <= 1 ? " disabled" : "") + ">&lsaquo;</button>";
      pretsPageItems(st.page, totalPages).forEach((it) => {
        if (it === "...") {
          html += '<span class="prets-pg-dots">…</span>';
        } else {
          html +=
            '<button class="prets-pg-btn' + (it === st.page ? " active" : "") +
            '" data-page="' + it + '">' + it + "</button>";
        }
      });
      html +=
        '<button class="prets-pg-btn" data-page="' + (st.page + 1) + '"' +
        (st.page >= totalPages ? " disabled" : "") + ">&rsaquo;</button>";
      html += "</nav>";
    }
    html += "</div></div>";

    box.innerHTML = html;

    box.querySelectorAll(".prets-pg-btn[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = parseInt(btn.dataset.page, 10);
        if (p >= 1 && p <= totalPages && p !== st.page) {
          st.page = p;
          fetchHistory();
        }
      });
    });

    const psize = box.querySelector("#prets-psize");
    psize.addEventListener("change", () => {
      st.pageSize = parseInt(psize.value, 10);
      st.page = 1;
      fetchHistory();
    });
  }

  loadAll();
}
