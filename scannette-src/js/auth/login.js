/* ==========================================================================
   auth/login.js — Connexion : identifiants locaux + bouton EirbConnect (SSO), entrée dans l'app.
   ========================================================================== */

// --- INTEGRATION EIRBCONNECT (SSO via session InvenTree) ---
// InvenTree tourne en HEADLESS_ONLY : les pages /accounts/.../login/ n'existent
// PAS. Le login SSO passe par l'API headless d'allauth (celle que la PUI utilise) :
//   POST /api/auth/v1/auth/provider/redirect   -> 302 direct vers Dex -> EirbConnect.
// On reproduit donc le clic du bouton EirbConnect de la page de login InvenTree :
// un form POST (provider + callback_url + CSRF). Le navigateur suit le 302 et file
// droit sur le portail Eirbware. Au retour sur la Scannette (/), InvenTree a pose une session
// same-origin ; le boot l'echange contre un token (trySsoBootstrap) puis verifie les droits.
async function loginEirbConnect() {
  // amorce le cookie CSRF (le GET headless pose 'csrftoken', lisible en JS)
  try {
    await fetch(API + "/api/auth/v1/auth/session", { credentials: "same-origin" });
  } catch (_) {}
  const csrf = getCookie("csrftoken");
  const f = document.createElement("form");
  f.method = "POST";
  f.action = API + "/api/auth/v1/auth/provider/redirect";
  const add = (n, v) => {
    const i = document.createElement("input");
    i.type = "hidden";
    i.name = n;
    i.value = v;
    f.appendChild(i);
  };
  add("provider", "eirbconnect"); // = provider_id cote InvenTree (ne jamais renommer)
  add("callback_url", "/?sso=1"); // retour same-origin marque (garde-fou cote boot)
  add("process", "login");
  if (csrf) add("csrfmiddlewaretoken", csrf);
  document.body.appendChild(f);
  f.submit();
}
(function () {
  const btn = document.getElementById("eirbConnectBtn");
  if (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      btn.disabled = true;
      loginEirbConnect();
    });
  }
})();

/* ---- login ---- */
async function login() {
  const u = $("#user").value.trim(),
    p = $("#pass").value;
  if (!u || !p) {
    showErr($("#loginErr"), t("login_missing"));
    return;
  }
  hideErr($("#loginErr"));
  const btn = $("#loginBtn"),
    html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> ' + t("login_connecting");
  try {
    const data = await api("/api/user/token/", { basic: u + ":" + p });
    if (!data || !data.token) throw new Error(t("login_unexpected"));
    TOKEN = data.token;
    USERNAME = u;
    setCookie("eir_token", TOKEN, 30);
    setCookie("eir_user", USERNAME, 30);
    // Compte sans aucun rôle (fraîchement créé, pas encore mis dans un groupe) :
    // écran « en attente d'approbation », comme au retour du SSO (boot.js).
    if ((await checkAuthorized()) === "pending") {
      showPending();
      return;
    }
    enterApp();
  } catch (e) {
    showErr(
      $("#loginErr"),
      e.status === 401 || /invalid|inattendue|unexpected/i.test(e.message)
        ? t("login_bad")
        : e.message,
    );
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}
function logout(silent) {
  TOKEN = "";
  USERNAME = "";
  delCookie("eir_token");
  delCookie("eir_user");
  forgetView(); // pas de réouverture d'écran après une déconnexion
  $("#topbar").style.display = "none";
  $("#pass").value = "";
  show("#screen-login");
  if (silent) showErr($("#loginErr"), t("session_expired"));
}
function enterApp() {
  $("#topbar").style.display = "flex";
  // USERNAME vient d'un cookie (posable par un autre sous-domaine du même
  // domaine parent) : jamais en innerHTML, toujours en textContent.
  // Le chevron signale que le chip ouvre l'écran Mon compte (account.js).
  $("#userChip").innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 14 0v1"/></svg><b></b>' +
    '<span class="chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>';
  $("#userChip").querySelector("b").textContent = USERNAME;
  // langue du profil InvenTree (fr/en, autre -> en) — non bloquant, les écrans
  // statiques sont re-traduits dès la réponse (voir core/i18n.js)
  syncUserLang();
  // réglages du plugin prêts (mode de la fiche des objets trackables) — non bloquant
  loadPretsConfig();
  // lien profond (email → article) : si un objet est en attente, on l'ouvre
  // directement au lieu de l'écran de scan
  const pending = sessionStorage.getItem("prets_open");
  if (pending) {
    sessionStorage.removeItem("prets_open");
    openDeepLinkItem(pending);
    return;
  }
  // reprise après un rafraîchissement de page : on rouvre l'écran qu'on
  // consultait (fiche, liste de sélection, emplacement, Mon compte, création,
  // ajout de stock, QR) au lieu de repartir du scan. Chaque flux retombe
  // seul sur le scan si l'objet a disparu.
  const v = readView();
  if (v) {
    openView(v);
    return;
  }
  gotoScan();
}
async function openDeepLinkItem(pk) {
  CHOOSE_PART = null; // flux direct (email -> objet) : pas de liste d'exemplaires derrière
  try {
    await loadItem(parseInt(pk, 10)); // renderItem depuis /api/stock/<pk>/
  } catch (_) {
    toast(t("item_not_found"), "bad");
    gotoScan();
  }
}
