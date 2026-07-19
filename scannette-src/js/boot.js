/* ==========================================================================
   boot.js — Point d'entrée : reprise SSO (?sso=1), vérification du token, choix de l'écran initial.
   ========================================================================== */

/* ---- boot ---- */
(async function boot() {
  // Lien profond (email → article) : ?item=<pk>. Mémorisé AVANT tout, car le
  // retour SSO nettoie l'URL. sessionStorage survit à l'aller-retour SSO
  // (redirection pleine page) ; l'ouverture se fait après connexion (enterApp).
  const dlItem = new URLSearchParams(window.location.search).get("item");
  if (dlItem && /^\d+$/.test(dlItem)) sessionStorage.setItem("prets_open", dlItem);

  // Garde-fou : on ne mint un token depuis une session (et on ne coupe cette session)
  // QUE si on revient vraiment d'un login Scannette (?sso=1). Sinon une session
  // InvenTree web ouverte par ailleurs ne doit pas etre touchee -> systemes independants.
  const backFromSso = /[?&]sso=1(?:&|$)/.test(window.location.search);
  if (!(TOKEN && USERNAME) && backFromSso) {
    await trySsoBootstrap();
    history.replaceState(null, "", "/"); // nettoie l'URL (retire ?sso=1)
  }
  if (TOKEN) {
    const st = await checkAuthorized();
    if (st === "ok") {
      enterApp();
      return;
    }
    if (st === "pending") {
      showPending();
      return;
    }
    // token invalide -> on nettoie et on retombe sur le login
    delCookie("eir_token");
    delCookie("eir_user");
    TOKEN = "";
    USERNAME = "";
  }
  show("#screen-login");
  setTimeout(() => {
    const u = $("#user");
    if (u) u.focus();
  }, 300);
})();
