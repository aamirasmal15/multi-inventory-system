/* ==========================================================================
   core/helpers.js — Utilitaires de base : cookies, thème clair/sombre, sélecteur $, écrans, toasts, formats.
   ========================================================================== */

/* ---- cookies ---- */
function setCookie(n, v, d) {
  let e = "";
  if (d) {
    const t = new Date();
    t.setTime(t.getTime() + d * 864e5);
    e = "; expires=" + t.toUTCString();
  }
  document.cookie =
    n +
    "=" +
    encodeURIComponent(v) +
    e +
    "; path=/; SameSite=Strict" +
    (location.protocol === "https:" ? "; Secure" : "");
}
function getCookie(n) {
  return document.cookie.split("; ").reduce((r, c) => {
    const [k, v] = c.split("=");
    return k === n ? decodeURIComponent(v) : r;
  }, "");
}
function delCookie(n) {
  document.cookie = n + "=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
}

let TOKEN = getCookie("eir_token"),
  USERNAME = getCookie("eir_user");

/* ---- collab ---- */
/* Révèle le lockup « EIRSPACE × <asso> » du login quand l'asso n'est pas l'asso
   principale. Les éléments .collab-only sont masqués par défaut dans le CSS :
   l'asso principale ne voit donc jamais flasher le duo. */
if (typeof COLLAB !== "undefined" && COLLAB) document.documentElement.classList.add("collab");

/* ---- theme ---- */
/* Par défaut le thème SUIT le système : posé avant le rendu par le script inline
   d'index.html, puis mis à jour en direct par l'écouteur ci-dessous. Le cookie
   eir_theme n'est posé que sur un choix EXPLICITE (bouton) : il fige alors le thème. */
function applyTheme(t, persist) {
  document.documentElement.setAttribute("data-theme", t);
  if (persist) setCookie("eir_theme", t, 365);
  const ic = t === "dark" ? SUN : MOON;
  const a = $("#themeBtn"),
    b = $("#themeBtnLogin");
  if (a) a.innerHTML = ic;
  if (b) b.innerHTML = ic;
  /* swap des logos selon le thème : logo de l'asso (LOGO_WHITE/LOGO_BLACK) et, sur le lockup
     collab, logo de l'asso principale (MAIN_LOGO_WHITE/BLACK, data-logo="main") — cf. config.js */
  const suf = t === "dark" ? "black" : "white";
  document.querySelectorAll(".logo-box img").forEach((img) => {
    /* asso principale (COLLAB=false) : son logo est servi via MAIN_LOGO_* (que create-asso.sh
       pointe sur img/<asso principale>-*.png, résolus depuis assets/logos/ ou le magasin) */
    const isMain = img.dataset.logo === "main" || (typeof COLLAB !== "undefined" && !COLLAB);
    const lf = isMain
      ? suf === "black" ? MAIN_LOGO_BLACK : MAIN_LOGO_WHITE
      : suf === "black" ? LOGO_BLACK : LOGO_WHITE;
    if (img.getAttribute("src") !== lf) img.src = lf;
  });
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark", true);
}
/* tant qu'aucun choix explicite n'a été fait, suivre les bascules jour/nuit du système */
if (window.matchMedia) {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!getCookie("eir_theme")) applyTheme(e.matches ? "dark" : "light");
  });
}

/* ---- helpers ---- */
const $ = (s) => document.querySelector(s);
/* Affiche un écran. "drop" : Mon compte descend depuis le chip de la topbar
   (seule animation directionnelle conservée) ; sinon fondu neutre de base. */
function show(id, dir) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active", "anim-drop"));
  const el = $(id);
  if (dir === "drop") el.classList.add("anim-drop");
  el.classList.add("active");
}
/* Aligne le curseur glissant d'un segmented control (.seg::before) sur son
   bouton actif — à appeler après tout changement d'actif ou (re)création. */
function segSync(seg) {
  if (!seg) return;
  const btns = seg.querySelectorAll(".seg-btn");
  seg.style.setProperty("--segn", btns.length);
  let i = 0;
  btns.forEach((b, k) => {
    if (b.classList.contains("active")) i = k;
  });
  seg.style.setProperty("--segi", i);
}

/* ---- reprise après rafraîchissement ----
   Mémorise l'écran où on se trouve pour le rouvrir au boot au lieu de
   repartir du scan. sessionStorage : survit au refresh, pas à la fermeture
   de l'onglet. { t, pk?, ...extra } avec t : "item" | "part" | "loc" |
   "account" | "create" (extra.code) | "addstock" (extra.code, extra.depleted)
   | "qr" (extra.name). Le contenu des formulaires, lui, ne survit pas. */
function rememberView(type, pk, extra) {
  try {
    const v = Object.assign({ t: type }, extra || {});
    if (pk != null) v.pk = String(pk);
    sessionStorage.setItem("scan_view", JSON.stringify(v));
  } catch (_) {}
}
function forgetView() {
  try {
    sessionStorage.removeItem("scan_view");
  } catch (_) {}
}
function readView() {
  try {
    const v = JSON.parse(sessionStorage.getItem("scan_view") || "null");
    if (!v || !v.t) return null;
    // account, create et users n'ont pas de pk ; tous les autres exigent un entier
    if (v.t === "account" || v.t === "create" || v.t === "users") return v;
    return /^\d+$/.test(String(v.pk)) ? v : null;
  } catch (_) {
    return null;
  }
}
/* Rouvre l'écran décrit par une entrée scan_view — partagé entre la reprise
   après rafraîchissement (login.js) et la flèche retour de Mon compte
   (account.js). Les fonctions visées vivent dans les features : elles sont
   toutes chargées avant le moindre appel (jamais appelé au chargement). */
function openView(v) {
  if (v.t === "loc") loadLocation(Number(v.pk));
  else if (v.t === "part") openPart(Number(v.pk));
  else if (v.t === "account") openAccount();
  else if (v.t === "users") openUsers();
  else if (v.t === "create") offerCreate(v.code || "");
  else if (v.t === "addstock") reopenAddStock(v);
  else if (v.t === "qr") showCreatedQR(Number(v.pk), v.name || "");
  else openDeepLinkItem(v.pk);
}
function showErr(el, m) {
  el.textContent = m;
  el.classList.add("show");
  ensureVisible(el);
}
function hideErr(el) {
  el.classList.remove("show");
}
/* Ramène un élément dans la zone visible s'il est masqué par la topbar
   collante ou hors de l'écran. Un message d'erreur vit en tête de formulaire :
   quand on valide depuis un bouton situé plus bas (création d'article,
   emprunt, réservation…), il apparaît hors du champ de vision — on le fait
   défiler jusqu'en haut pour que l'erreur ne passe jamais inaperçue. On ne
   bouge QUE si l'élément est réellement caché (pas de saut intempestif). */
function ensureVisible(el) {
  if (!el) return;
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    if (!r.height && !r.width) return; // élément non affiché : rien à faire
    const tb = $("#topbar");
    const tbr = tb ? tb.getBoundingClientRect() : null;
    const top = tbr && tbr.height ? tbr.bottom : 0; // bas de la topbar collante
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.top < top + 8 || r.bottom > vh) {
      const y = window.scrollY + r.top - top - 14; // juste sous la topbar
      window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    }
  });
}
let toastTimer;
function toast(m, k) {
  const t = $("#toast");
  t.textContent = m;
  t.className = "toast show " + (k || "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

/* ---- confirmation en modale (à la place du confirm() du navigateur) ----
   appConfirm({title, text, confirmLabel, cancelLabel, danger}) -> Promise<bool>.
   Avec promptLabel (et promptPlaceholder), la modale ajoute un champ texte
   facultatif et résout {ok:true, value} au lieu de true — false inchangé.
   Échap ou clic sur le fond = annuler. Contenu posé en textContent (pas d'HTML). */
function appConfirm(opts) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    const card = document.createElement("div");
    card.className = "modal-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    const h = document.createElement("h3");
    h.textContent = opts.title || t("confirm_q");
    const p = document.createElement("p");
    p.textContent = opts.text || "";
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const no = document.createElement("button");
    no.className = "btn btn-ghost";
    no.textContent = opts.cancelLabel || t("back");
    const yes = document.createElement("button");
    yes.className = "btn " + (opts.danger ? "btn-danger" : "btn-primary");
    yes.textContent = opts.confirmLabel || t("confirm");
    actions.append(no, yes);
    let input = null;
    if (opts.promptLabel) {
      const field = document.createElement("div");
      field.className = "field";
      const lbl = document.createElement("label");
      lbl.className = "lbl";
      lbl.textContent = opts.promptLabel;
      input = document.createElement("input");
      input.type = "text";
      input.maxLength = 200;
      input.placeholder = opts.promptPlaceholder || "";
      field.append(lbl, input);
      card.append(h, p, field, actions);
      // motif obligatoire : bouton de confirmation bloqué tant que le champ
      // est vide (le libellé indique déjà « obligatoire »)
      if (opts.promptRequired) {
        yes.disabled = true;
        input.addEventListener("input", () => {
          yes.disabled = !input.value.trim();
        });
      }
    } else {
      card.append(h, p, actions);
    }
    ov.appendChild(card);
    const onKey = (e) => {
      if (e.key === "Escape") done(false);
    };
    // scroll de la page bloqué tant que la modale est ouverte
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const done = (v) => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // sortie animée (cf. .modal-ov.closing) — la promesse, elle, est résolue
      // tout de suite : l'action de l'utilisateur ne poireaute pas
      ov.classList.add("closing");
      setTimeout(() => ov.remove(), 180);
      resolve(v);
    };
    ov.addEventListener("click", (e) => {
      if (e.target === ov) done(false);
    });
    no.addEventListener("click", () => done(false));
    yes.addEventListener("click", () =>
      done(input ? { ok: true, value: input.value.trim() } : true),
    );
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
    // un champ motif à saisir : le curseur va dedans ; sinon focus « Retour »
    (input || no).focus();
  });
}
function logoFallback(img) {
  /* échec de chargement (course avec le swap d'applyTheme, réseau instable, fichier
     absent...) : on ne détruit PAS l'<img> — le CSS affiche l'initiale via ::after
     (data-letter) et on retente une fois. Dès qu'un chargement réussit (retry ou
     swap de thème), le listener "load" d'events.js retire le repli : le logo
     reprend sa place tout seul, plus de logo qui disparaît jusqu'au refresh. */
  const p = img.parentElement;
  /* logo principal (data-logo="main") -> initiale de MAIN_BRAND ; logo de l'asso -> BRAND */
  const src =
    img.dataset.logo === "main" && typeof MAIN_BRAND === "string" ? MAIN_BRAND : BRAND;
  p.dataset.letter = ((typeof src === "string" && src.trim()[0]) || "E").toUpperCase();
  p.classList.add("logo-fallback");
  if (!img.dataset.retry) {
    img.dataset.retry = "1";
    setTimeout(() => {
      img.src = img.getAttribute("src").split("?")[0] + "?r=" + Date.now();
    }, 700);
  }
}
/* échec de chargement d'une miniature d'article : InvenTree ne génère pas toujours
   le fichier .thumbnail — on retente une fois avec l'image pleine taille (data-full)
   avant de replier sur l'icône (kind : "sr" recherche, "loc" emplacement, défaut fiche). */
function thumbErr(img, kind) {
  const full = img.dataset.full || "";
  if (full && !img.dataset.retry && img.src !== full) {
    img.dataset.retry = "1";
    img.src = full;
    return;
  }
  img.replaceWith(kind === "sr" ? srBox() : kind === "loc" ? locBox() : boxIcon());
}
function fmt(n) {
  n = Number(n);
  return Number.isInteger(n) ? n.toString() : n.toFixed(2).replace(/\.?0+$/, "");
}
