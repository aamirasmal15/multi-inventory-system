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
  // Retour d'une étape 3-D Secure SumUp en pleine page : ?achat=<pk> (même mémorisation)
  const dlBuy = new URLSearchParams(window.location.search).get("achat");
  if (dlBuy && /^\d+$/.test(dlBuy)) sessionStorage.setItem("achat_open", dlBuy);
  // retour de l'appli SumUp (Tap to Pay) : code de la transaction, revérifié par le serveur
  const dlTx = new URLSearchParams(window.location.search).get("smp-tx-code");
  if (dlBuy && dlTx && /^[A-Za-z0-9]{4,40}$/.test(dlTx)) sessionStorage.setItem("achat_tx", dlTx);
  // QR de la porte du frigo : /frigo -> ?frigo=1 (même mémorisation). La
  // connexion passe en mode frigo tant que la demande est en attente.
  if (new URLSearchParams(window.location.search).has("frigo")) sessionStorage.setItem("frigo_open", "1");
  if (sessionStorage.getItem("frigo_open")) applyFrigoLogin();

  // Garde-fou : on ne mint un token depuis une session (et on ne coupe cette session)
  // QUE si on revient vraiment d'un login Scannette (?sso=1). Sinon une session
  // InvenTree web ouverte par ailleurs ne doit pas etre touchee -> systemes independants.
  const backFromSso = /[?&]sso=1(?:&|$)/.test(window.location.search);
  if (!(TOKEN && USERNAME) && backFromSso) {
    await trySsoBootstrap();
    history.replaceState(null, "", BASE); // nettoie l'URL (retire ?sso=1) sans sortir de la base
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
