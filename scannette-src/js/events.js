/* ==========================================================================
   events.js — Branchement de TOUS les écouteurs d'événements + application du nom d'asso (BRAND).
   ========================================================================== */

/* ---- camera helpers above ---- */

/* ---- events ---- */
applyTheme(document.documentElement.getAttribute("data-theme") || "light");
$("#themeBtn")?.addEventListener("click", toggleTheme);
$("#themeBtnLogin")?.addEventListener("click", toggleTheme);
$("#loginBtn")?.addEventListener("click", login);
$("#pass")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") login();
});
$("#logoutBtn")?.addEventListener("click", () => logout(false));
/* écran Mon compte (chip utilisateur de la topbar) : la flèche et le bouton
   du bas ramènent à l'écran d'où on vient (closeAccount), pas toujours au scan */
$("#userChip")?.addEventListener("click", openAccount);
$("#backBtnAcct")?.addEventListener("click", closeAccount);
$("#acctBackBtn")?.addEventListener("click", closeAccount);
/* gestion des utilisateurs (admins) : entrée depuis Mon compte, la flèche
   retour ramène toujours à Mon compte (seul chemin d'accès) */
$("#acctUsersBtn")?.addEventListener("click", openUsers);
$("#backBtnUsers")?.addEventListener("click", openAccount);
$("#userSearch")?.addEventListener("input", () => usersSetQuery($("#userSearch").value));
$("#userSearchClear")?.addEventListener("click", () => {
  $("#userSearch").value = "";
  usersSetQuery("");
  $("#userSearch").focus();
});
/* seg de langue FR/EN : un appui enregistre et bascule la Scannette */
document.querySelectorAll("#acctLangSeg .seg-btn").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.classList.contains("active")) return; // déjà la langue courante
    acctSaveLang(b.dataset.lang);
  });
});
$("#manualInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const v = e.target.value;
    e.target.value = "";
    processBarcode(v);
  }
});
$("#goBtn")?.addEventListener("click", () => {
  const v = $("#manualInput").value;
  $("#manualInput").value = "";
  processBarcode(v);
});
$("#partSearch")?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchParts, 200);
});
$("#partSearchClear")?.addEventListener("click", clearSearch);
$("#createNoCodeBtn")?.addEventListener("click", createNoCode);
$("#camBtn")?.addEventListener("click", startCamera);
$("#backBtn")?.addEventListener("click", () => {
  stopCamera();
  // fiche ouverte depuis la liste « choisis le lot / l'exemplaire » : la
  // flèche ramène à cette liste (re-fetch, les états ont pu changer) — le
  // scanner n'est qu'un cran plus haut. Depuis la liste elle-même (ou après
  // une confirmation), retour au scanner comme avant.
  if (CHOOSE_PART && $("#itemBody").style.display !== "none") openPart(CHOOSE_PART);
  else gotoScan();
});
$("#backBtn2")?.addEventListener("click", () => {
  gotoScan();
});
$("#backBtn3")?.addEventListener("click", () => {
  gotoScan();
});
$("#locSearch")?.addEventListener("input", () => {
  const q = $("#locSearch").value.trim().toLowerCase();
  document.querySelectorAll("#locList .loc-row").forEach((r) => {
    r.style.display = !q || (r.dataset.name || "").includes(q) ? "" : "none";
  });
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !scanActive()) return;
  const track = camStream && camStream.getVideoTracks ? camStream.getVideoTracks()[0] : null;
  if (!camStream || (track && track.readyState === "ended")) {
    blackRetried = false;
    blackSince = 0;
    restartCamera();
  } else {
    const v = $("#camvideo");
    if (v && v.play) v.play().catch(() => {});
  }
});
$("#againBtn")?.addEventListener("click", gotoScan);
$("#minus")?.addEventListener("click", () => step(-1));
$("#plus")?.addEventListener("click", () => step(1));
$("#submitBtn")?.addEventListener("click", submitAdjust);
$("#createBtn")?.addEventListener("click", createArticle);
$("#linkExistingBtn")?.addEventListener("click", linkToExisting);
$("#np_name")?.addEventListener("input", () => {
  if (imgDismissed) return;
  clearTimeout(imgTimer);
  imgTimer = setTimeout(() => suggestImage($("#np_name").value.trim()), 650);
});
$("#imgRemove")?.addEventListener("click", () => {
  NEW_IMG = "";
  NEW_IMG_FILE = null;
  imgDismissed = true;
  imgReqId++;
  $("#np_img_file").value = "";
  $("#np_img_url").value = "";
  hideImgPrev();
});
$("#pickImgBtn")?.addEventListener("click", () => $("#np_img_file").click());
$("#np_img_file")?.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) {
    $("#np_img_url").value = "";
    showFilePreview(f);
  }
});
$("#imgPrevBtn")?.addEventListener("click", () => imgStep(-1));
$("#imgNextBtn")?.addEventListener("click", () => imgStep(1));
$("#np_cat")?.addEventListener("change", () => {
  if (!imgDismissed) suggestImage();
});
$("#np_img_url")?.addEventListener("input", () => {
  const u = $("#np_img_url").value.trim();
  if (/^https?:\/\/\S+/i.test(u)) {
    NEW_IMG_FILE = null;
    $("#np_img_file").value = "";
    imgDismissed = false;
    IMG_LIST = [u];
    IMG_IDX = 0;
    renderImg();
  } else if (!u) {
    IMG_LIST = [];
    hideImgPrev();
  }
});

/* ---- bindings ajoutés (mode recherche, déplacement, QR, pickers) ---- */
/* bascule Scanner / Rechercher */
document.querySelectorAll("#scanModeSeg .seg-btn").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.classList.contains("active")) return; // déjà sur ce mode
    const search = b.dataset.mode === "search";
    document
      .querySelectorAll("#scanModeSeg .seg-btn")
      .forEach((x) => x.classList.toggle("active", x === b));
    segSync($("#scanModeSeg")); // le curseur coulisse vers le segment touché
    const ms = $("#modeSearch"),
      mc = $("#modeScan");
    if (ms) ms.style.display = search ? "" : "none";
    if (mc) mc.style.display = search ? "none" : "";
    const cb = $("#createNoCodeBtn");
    if (cb) cb.style.display = search ? "none" : "";
    if (search) {
      stopCamera();
      if (typeof loadParts === "function") loadParts().catch(() => {});
      setTimeout(() => $("#partSearch") && $("#partSearch").focus(), 120);
    } else {
      if (typeof clearSearch === "function") clearSearch();
      startCamera();
    }
  });
});
segSync($("#scanModeSeg"));
/* emprunts / réservations (objets trackables) : écrans Emprunter et Réserver */
$("#backBtnLend")?.addEventListener("click", () => show("#screen-item"));
$("#lendCancelBtn")?.addEventListener("click", () => show("#screen-item"));
$("#lendConfirmBtn")?.addEventListener("click", submitLend);
$("#lendDue")?.addEventListener("change", updateLendWarn);
$("#backBtnResa")?.addEventListener("click", () => show("#screen-item"));
$("#resaCancelBtn")?.addEventListener("click", () => show("#screen-item"));
$("#resaConfirmBtn")?.addEventListener("click", submitReserve);
/* déplacement de stock */
$("#moveBtn")?.addEventListener("click", moveStock);
$("#addElsewhereBtn")?.addEventListener("click", () => {
  if (!CURRENT) return;
  const pd = CURRENT.part_detail || {};
  const part = {
    pk: CURRENT.part || pd.pk,
    name: pd.full_name || pd.name || "",
    thumbnail: pd.thumbnail,
    image: pd.image,
    trackable: !!pd.trackable,
  };
  if (!part.pk) return;
  PENDING_CODE = "";
  offerAddStock(part, { depleted: false });
});
/* écran QR après création */
$("#qrPrintBtn")?.addEventListener("click", printQR);
$("#qrDoneBtn")?.addEventListener("click", () => {
  gotoScan();
});
/* pickers catégorie / emplacement (hiérarchiques) */
$("#np_cat_btn")?.addEventListener("click", async () => {
  await fillSelects();
  openTreePicker(
    t("np_cat_lbl"),
    CATS || [],
    $("#np_cat_btn").dataset.value,
    (pk, label) => setPick("#np_cat_btn", pk, pk ? label : t("none_f")),
    { noneLabel: t("none_f") },
  );
});
$("#np_loc_btn")?.addEventListener("click", async () => {
  await ensureLocs();
  // l'emplacement est obligatoire à la création : pas d'option « Aucun »
  openTreePicker(
    t("loc_word"),
    LOCS || [],
    $("#np_loc_btn").dataset.value,
    (pk, label) => setPick("#np_loc_btn", pk, pk ? label : t("choose_btn")),
    { allowNone: false },
  );
});
/* type d'article : stock en quantité / objet à emprunter (trackable) */
document.querySelectorAll("#trackSeg .seg-btn").forEach((b) => {
  b.addEventListener("click", () => setTrackable(!!b.dataset.track));
});
$("#pickerClose")?.addEventListener("click", closePicker);
$("#pickerSearch")?.addEventListener("input", () =>
  (pickerRender || renderPicker)($("#pickerSearch").value),
);
/* le menu suit la zone visible quand le clavier s'ouvre */
if (window.visualViewport) {
  visualViewport.addEventListener("resize", fitPicker);
  visualViewport.addEventListener("scroll", fitPicker);
}
/* applique le nom de l'asso (BRAND) partout sans toucher au footer signature */
document.title = BRAND + " · Scannette";
document.querySelectorAll(".bn").forEach((e) => (e.textContent = BRAND));
document.querySelectorAll(".logo-box img").forEach((img) => {
  if (img.dataset.logo !== "main") img.setAttribute("alt", BRAND);
  /* si un logo finit par charger (retry de logoFallback, swap de thème),
     on retire le repli lettre — voir logoFallback dans core/helpers.js */
  img.addEventListener("load", () => {
    delete img.dataset.retry;
    img.parentElement.classList.remove("logo-fallback");
  });
});
/* flèche « remonter en haut » : apparaît dès qu'on a bien défilé (historiques
   longs des fiches, notamment), disparaît près du haut de page */
const scrollTopBtn = $("#scrollTopBtn");
if (scrollTopBtn) {
  window.addEventListener(
    "scroll",
    () => scrollTopBtn.classList.toggle("show", window.scrollY > 400),
    { passive: true },
  );
  scrollTopBtn.addEventListener("click", () =>
    window.scrollTo({ top: 0, behavior: "smooth" }),
  );
}
/* appui sur la caméra = forcer la mise au point */
$("#reader")?.addEventListener("click", tapFocus);
/* empêche le fond de défiler, mais laisse la liste défiler */
$("#picker")?.addEventListener(
  "touchmove",
  (e) => {
    if (!e.target.closest("#pickerList")) e.preventDefault();
  },
  { passive: false },
);
