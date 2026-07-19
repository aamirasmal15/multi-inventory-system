/* ==========================================================================
   auth/sso.js — SSO EirbConnect : échange session -> token, contrôle des droits, écran 'en attente', déconnexion.
   ========================================================================== */

/* ---- SSO : echange une session EirbConnect contre un token InvenTree ---- */
async function trySsoBootstrap() {
  try {
    // si EirbConnect a pose une session same-origin, /api/user/token/ la renvoie en token
    const res = await fetch(API + "/api/user/token/", { credentials: "same-origin" });
    if (res.status !== 200) return false;
    const data = await res.json().catch(() => null);
    if (!data || !data.token) return false;
    TOKEN = data.token;
    let uname = "";
    try {
      const me = await fetch(API + "/api/user/me/", {
        headers: { Authorization: "Token " + TOKEN },
      });
      if (me.ok) {
        const m = await me.json();
        uname = (m && (m.username || (m.user && m.user.username))) || "";
      }
    } catch (_) {}
    USERNAME = uname || "EirbConnect";
    setCookie("eir_token", TOKEN, 30);
    setCookie("eir_user", USERNAME, 30);
    // DECOUPLAGE : on a le token -> on coupe la session Django partagee, sinon son
    // cookie (meme origine que la Scannette) lierait Scannette et InvenTree. Desormais la
    // Scannette ne marche QU'au token (Authorization: Token) -> les 2 sont independants.
    try {
      const csrf = getCookie("csrftoken");
      await fetch(API + "/api/auth/v1/auth/session", {
        method: "DELETE",
        credentials: "same-origin",
        headers: csrf ? { "X-CSRFToken": csrf } : {},
      });
    } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

/* ---- verifie l'autorisation : "ok" | "pending" | "unauth" ---- */
async function checkAuthorized() {
  let res;
  try {
    res = await fetch(API + "/api/user/roles/", {
      headers: TOKEN ? { Authorization: "Token " + TOKEN } : {},
      credentials: "same-origin",
    });
  } catch (_) {
    return "ok";
  } // erreur reseau : on laisse api() gerer les vrais 401
  if (res.status === 401 || res.status === 403) return "unauth";
  if (!res.ok) return "ok";
  const data = await res.json().catch(() => null);
  if (!data) return "ok";
  if (data.is_staff || data.is_superuser) {
    // admin : pastille « demandes en attente » sur le chip dès le boot
    usersBadgeRefresh();
    return "ok";
  }
  const roles = data.roles || {};
  for (const k in roles) {
    const v = roles[k];
    if (Array.isArray(v) ? v.length > 0 : !!v) return "ok";
  }
  return "pending"; // authentifie mais aucun groupe/role -> en attente
}

/* ---- ecran "compte en attente d'approbation" ---- */
function showPending() {
  const tb = $("#topbar");
  if (tb) tb.style.display = "none";
  show("#screen-pending");
}

/* ---- logout : coupe la session InvenTree (headless) + cookies Scannette ---- */
async function ssoLogout() {
  try {
    await fetch(API + "/api/auth/v1/auth/session", { credentials: "same-origin" });
  } catch (_) {}
  const csrf = getCookie("csrftoken");
  try {
    await fetch(API + "/api/auth/v1/auth/session", {
      method: "DELETE",
      credentials: "same-origin",
      headers: csrf ? { "X-CSRFToken": csrf } : {},
    });
  } catch (_) {} // 401 attendu (deconnecte) -> on ignore
  delCookie("eir_token");
  delCookie("eir_user");
  TOKEN = "";
  USERNAME = "";
  window.location.href = "/";
}
