/* ==========================================================================
   features/account.js — Mon compte : identité, adresse des notifications (bascule
   1-tap entre adresses e-mail), langue (seg FR/EN). Ouvert depuis le chip
   utilisateur ; la flèche retour ramène à l'écran d'origine (closeAccount).

   Les adresses passent par l'API du plugin E-mails (/plugin/emails/addresses/,
   auth token — le headless allauth est session-only, hors de portée d'une
   Scannette token-only). Plugin absent/inactif : repli lecture seule sur
   l'adresse de /api/user/me/. La langue passe par /api/user/me/profile/.
   ========================================================================== */

let ACCT_ME = null; // /api/user/me/ (identité + profil)
let ACCT_EMAILS = null; // liste du plugin, ou null si indisponible
let ACCT_BUSY = false; // une action (adresse ou langue) à la fois
let ACCT_BACK = null; // entrée scan_view de l'écran d'origine (retour contextuel)
let ACCT_BACK_LIVE = ""; // id de l'écran-formulaire encore en vie (même session)

/* Écrans dont l'état vit dans le DOM (saisie en cours) : au retour on les
   réaffiche tels quels au lieu de les réinitialiser — un détour par Mon compte
   ne vide pas le formulaire. screen-create couvre aussi l'ajout de stock
   (offerAddStock réutilise cet écran). Les écrans de données (fiche, liste,
   emplacement) sont au contraire rechargés : leur contenu a pu bouger. */
const ACCT_LIVE_SCREENS = ["screen-create", "screen-lend", "screen-reserve"];

async function openAccount() {
  if (typeof stopCamera === "function") stopCamera();
  // d'où vient-on ? la flèche retour ramènera à cet écran plutôt qu'au scan.
  // Embarqué dans scan_view pour survivre au refresh ; si on est DÉJÀ sur
  // Mon compte (refresh, re-clic sur le chip), on garde le retour mémorisé.
  // « Gérer les membres » (users) est un ENFANT de Mon compte (seul chemin
  // d'accès, sa flèche revient toujours ici) : au retour de cet écran on ne
  // recalcule PAS l'origine — sinon la flèche de Mon compte pointerait sur
  // users et closeAccount rouvrirait users, en boucle sans fin (jamais de
  // retour au scan). On garde alors ACCT_BACK / ACCT_BACK_LIVE tels quels.
  const prev = readView();
  if (!prev || prev.t !== "users") {
    ACCT_BACK = prev && prev.t === "account" ? prev.back || null : prev;
    const live = document.querySelector(".screen.active");
    if (!live || live.id !== "screen-account")
      ACCT_BACK_LIVE = live && ACCT_LIVE_SCREENS.indexOf(live.id) >= 0 ? live.id : "";
  }
  rememberView("account", null, ACCT_BACK ? { back: ACCT_BACK } : null);
  // "drop" : l'écran descend depuis le chip utilisateur de la topbar
  show("#screen-account", "drop");
  hideErr($("#acctErr"));
  $("#acctBody").style.display = "none";
  $("#acctLoading").style.display = "";
  try {
    // les deux appels en parallèle : l'échec du plugin (404/403 = pas déployé
    // sur cette instance) ne casse pas l'écran, il le passe en lecture seule
    const [me, mails] = await Promise.all([
      api("/api/user/me/"),
      api("/plugin/emails/addresses/").catch(() => null),
    ]);
    ACCT_ME = me || {};
    ACCT_EMAILS = mails && Array.isArray(mails.addresses) ? mails : null;
    renderAccount();
  } catch (e) {
    $("#acctLoading").style.display = "none";
    showErr($("#acctErr"), e.message);
  }
}

function renderAccount() {
  $("#acctLoading").style.display = "none";
  $("#acctBody").style.display = "";
  renderAcctHead();
  renderAcctMails();
  // langue : le segment actif reflète le profil (locale régionale fr-fr
  // ramenée au code court) ; profil sans langue = langue courante de la
  // Scannette (LANG), il n'y a plus d'état « défaut » affiché
  acctLangPaint(normLang(ACCT_ME.profile && ACCT_ME.profile.language) || LANG);
  // le bouton du bas suit la flèche : retour contextuel ou retour au scan
  $("#acctBackLbl").textContent =
    ACCT_BACK || ACCT_BACK_LIVE ? t("back") : t("acct_back");
  // entrée « Gérer les membres » au pied de la carte d'identité : admins
  // seulement (l'API n'accorde de toute façon l'écriture qu'aux staff) ;
  // la pastille des demandes en attente se rafraîchit en arrière-plan
  const ub = $("#acctUsersBtn");
  if (ub) {
    const adm = !!(ACCT_ME.is_staff || ACCT_ME.is_superuser);
    ub.style.display = adm ? "" : "none";
    if (adm) usersBadgeRefresh();
  }
}

/* pose le segment actif du seg de langue et y fait glisser le curseur */
function acctLangPaint(lang) {
  const seg = $("#acctLangSeg");
  seg
    .querySelectorAll(".seg-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
  segSync(seg);
}

/* Flèche retour (et bouton du bas) : revient à l'écran d'où Mon compte a été
   ouvert, au scan à défaut. Écran-formulaire encore en vie : réaffiché tel
   quel (saisie intacte), avec scan_view remis sur l'entrée d'origine. Fiche :
   rechargée SANS passer par openDeepLinkItem, pour préserver CHOOSE_PART —
   ouverte depuis la liste « choisis l'exemplaire », sa flèche y ramène encore. */
function closeAccount() {
  if (ACCT_BACK_LIVE && $("#" + ACCT_BACK_LIVE)) {
    if (ACCT_BACK) rememberView(ACCT_BACK.t, ACCT_BACK.pk, ACCT_BACK);
    else forgetView();
    show("#" + ACCT_BACK_LIVE);
    return;
  }
  if (!ACCT_BACK) {
    gotoScan();
    return;
  }
  if (ACCT_BACK.t === "item") {
    loadItem(parseInt(ACCT_BACK.pk, 10)).catch(() => {
      toast(t("item_not_found"), "bad");
      gotoScan();
    });
  } else openView(ACCT_BACK);
}

function renderAcctHead() {
  const head = $("#acctHead");
  head.innerHTML = "";
  const first = ACCT_ME.first_name || "",
    last = ACCT_ME.last_name || "",
    uname = ACCT_ME.username || USERNAME || "";
  const av = document.createElement("div");
  av.className = "avatar";
  av.textContent = (
    ((first[0] || "") + (last[0] || "")).toUpperCase() ||
    (uname[0] || "?").toUpperCase()
  );
  const box = document.createElement("div");
  const nm = document.createElement("div");
  nm.className = "id-name";
  nm.textContent = (first + " " + last).trim() || uname;
  const un = document.createElement("div");
  un.className = "id-sub";
  un.textContent = uname;
  box.append(nm, un);
  if (ACCT_ME.is_staff || ACCT_ME.is_superuser) {
    const pills = document.createElement("div");
    pills.className = "id-pills";
    const p = document.createElement("span");
    p.className = "pill pill-admin";
    p.textContent = "Admin";
    pills.appendChild(p);
    box.appendChild(pills);
  }
  head.append(av, box);
}

function renderAcctMails() {
  const card = $("#acctMailCard");
  // positions des lignes AVANT le re-rendu : sert à animer l'échange quand on
  // change l'adresse principale (la nouvelle remonte en tête, l'ancienne
  // redescend — cf. flipAcctRows). Vide au premier rendu : rien à animer.
  const prev = new Map();
  card
    .querySelectorAll(".acct-row")
    .forEach((r) => prev.set(r.dataset.email, r.getBoundingClientRect().top));
  card.innerHTML = "";
  // plugin indisponible : adresse actuelle en lecture seule, sans promesses
  if (!ACCT_EMAILS) {
    $("#acctMailSub").textContent = t("acct_mail_sub_ro");
    $("#acctMailHint").textContent = t("acct_mail_hint_ro");
    const ro = document.createElement("div");
    ro.className = "acct-ro";
    const a = document.createElement("div");
    a.className = "acct-addr";
    a.textContent = ACCT_ME.email || t("acct_no_addr");
    ro.appendChild(a);
    card.appendChild(ro);
    return;
  }
  $("#acctMailSub").textContent = t("acct_mail_sub");
  $("#acctMailHint").textContent = t("acct_mail_hint");
  ACCT_EMAILS.addresses.forEach((ad) => card.appendChild(acctRow(ad)));
  // ajout d'une adresse (masqué si le plafond est atteint)
  if (ACCT_EMAILS.addresses.length < (ACCT_EMAILS.max || 5)) {
    const add = document.createElement("div");
    add.className = "acct-add";
    const inp = document.createElement("input");
    inp.type = "text"; // type=text pour hériter des styles de l'app ; clavier e-mail via inputmode
    inp.inputMode = "email";
    inp.id = "acctNewMail";
    inp.placeholder = t("acct_add_ph");
    inp.autocomplete = "off";
    inp.autocapitalize = "off";
    inp.setAttribute("autocorrect", "off");
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = t("add");
    btn.addEventListener("click", acctAddMail);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        acctAddMail();
      }
    });
    add.append(inp, btn);
    card.appendChild(add);
  }
  flipAcctRows(card, prev);
}

/* Anime l'échange de lignes après un changement d'adresse principale (FLIP) :
   chaque ligne repart de sa position d'avant le re-rendu et glisse vers sa
   nouvelle place. Quand on sélectionne une adresse vérifiée, le serveur la
   remet en tête (tri -primary) : on voit la nouvelle principale monter et
   l'ancienne descendre — les deux cases s'échangent. Une ligne nouvellement
   ajoutée (absente de prev) ou immobile ne bouge pas. */
function flipAcctRows(card, prev) {
  if (!prev || !prev.size) return;
  card.querySelectorAll(".acct-row").forEach((row) => {
    const old = prev.get(row.dataset.email);
    if (old == null) return;
    const dy = old - row.getBoundingClientRect().top;
    if (!dy) return;
    row.style.transform = "translateY(" + dy + "px)";
    row.style.transition = "none";
    // frame suivante : on relâche vers la place réelle, la transition joue
    requestAnimationFrame(() => {
      row.style.transition = "transform .32s var(--ease-spring)";
      row.style.transform = "";
    });
    row.addEventListener("transitionend", function te() {
      row.style.transition = "";
      row.style.transform = "";
      row.removeEventListener("transitionend", te);
    });
  });
}

function acctRow(ad) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "acct-row" + (ad.primary ? " sel" : "") + (ad.verified ? "" : " unv");
  row.dataset.email = ad.email; // clé de l'animation d'échange (FLIP) au re-rendu
  const radio = document.createElement("span");
  radio.className = "acct-radio";
  radio.innerHTML = CHECK;
  const main = document.createElement("span");
  main.className = "acct-main";
  const addr = document.createElement("span");
  addr.className = "acct-addr";
  addr.textContent = ad.email; // adresses = saisie utilisateur : jamais en innerHTML
  main.appendChild(addr);
  if (ad.verified) {
    const st = document.createElement("span");
    st.className = "acct-state";
    st.textContent = ad.primary ? t("acct_primary") : t("acct_verified");
    main.appendChild(st);
    row.addEventListener("click", (e) => {
      if (e.target.closest(".acct-x")) return;
      if (!ad.primary) acctAction("primary", ad.email);
    });
  } else if (ad.blocked) {
    // adresse revendiquée par un autre compte : la vérification n'aboutira
    // jamais (allauth UNIQUE_EMAIL) — on le dit, il ne reste qu'à supprimer
    const tag = document.createElement("span");
    tag.className = "acct-tag bad";
    tag.textContent = t("acct_blocked");
    main.appendChild(tag);
  } else {
    const tag = document.createElement("span");
    tag.className = "acct-tag";
    tag.textContent = t("acct_unverified");
    const acts = document.createElement("span");
    acts.className = "acct-acts";
    const resend = document.createElement("button");
    resend.type = "button";
    resend.className = "acct-link";
    resend.textContent = t("acct_resend");
    resend.addEventListener("click", (e) => {
      e.stopPropagation();
      acctAction("resend", ad.email);
    });
    acts.appendChild(resend);
    main.append(tag, acts);
  }
  row.append(radio, main);
  // la principale ne se supprime pas (le serveur refuse aussi) : pas de croix
  if (!ad.primary) {
    const x = document.createElement("span");
    x.className = "acct-x";
    x.setAttribute("role", "button");
    x.title = t("acct_del_title");
    x.textContent = "×";
    x.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await appConfirm({
        title: t("acct_del_q"),
        text: t("acct_del_txt", ad.email),
        confirmLabel: t("delete"),
        danger: true,
      });
      if (ok) acctAction("remove", ad.email);
    });
    row.appendChild(x);
  }
  return row;
}

async function acctAddMail() {
  const inp = $("#acctNewMail");
  if (!inp) return;
  const v = inp.value.trim();
  if (!v || v.indexOf("@") < 1) {
    toast(t("acct_bad_addr"), "bad");
    return;
  }
  await acctAction("add", v);
}

async function acctAction(action, email) {
  if (ACCT_BUSY) return;
  ACCT_BUSY = true;
  const card = $("#acctMailCard");
  card.style.opacity = ".55";
  card.style.pointerEvents = "none";
  try {
    const r = await api("/plugin/emails/addresses/", {
      method: "POST",
      body: { action, email },
    });
    if (r && Array.isArray(r.addresses)) ACCT_EMAILS = r;
    renderAcctMails();
    if (r && r.detail) toast(r.detail, "ok");
  } catch (e) {
    toast(e.message, "bad");
    // l'état a pu bouger malgré l'erreur (ex. 400 après un doublon) : on recharge
    try {
      const fresh = await api("/plugin/emails/addresses/");
      if (fresh && Array.isArray(fresh.addresses)) {
        ACCT_EMAILS = fresh;
        renderAcctMails();
      }
    } catch (_) {}
  } finally {
    ACCT_BUSY = false;
    card.style.opacity = "";
    card.style.pointerEvents = "";
  }
}

async function acctSaveLang(v) {
  if (ACCT_BUSY) return;
  ACCT_BUSY = true;
  const seg = $("#acctLangSeg");
  seg.style.pointerEvents = "none";
  acctLangPaint(v); // le curseur glisse tout de suite ; marche arrière si échec
  try {
    const p = await api("/api/user/me/profile/", {
      method: "PATCH",
      body: { language: v },
    });
    if (ACCT_ME && p) ACCT_ME.profile = p;
    // la Scannette bascule immédiatement dans la langue choisie — textes
    // statiques via applyI18nDom (setLang), écran re-rendu pour les dynamiques
    setLang(v, true);
    renderAccount();
    toast(t("lang_saved", v === "fr" ? "Français" : "English"), "ok");
  } catch (e) {
    toast(e.message, "bad");
    // on remet la langue du profil (l'enregistrement a échoué)
    acctLangPaint(normLang(ACCT_ME.profile && ACCT_ME.profile.language) || LANG);
  } finally {
    ACCT_BUSY = false;
    seg.style.pointerEvents = "";
  }
}
