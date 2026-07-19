/* ==========================================================================
   features/item.js — Fiche article : rendu, quantité, ajustement de stock, écran de confirmation.
   ========================================================================== */

/* ---- item view ---- */
let CURRENT = null;
function renderItem(it) {
  CURRENT = it;
  // mémorise la fiche courante pour la rouvrir après un rafraîchissement
  // (nettoyée quand on revient au scan ou qu'on se déconnecte)
  if (it && it.pk != null) rememberView("item", it.pk);
  show("#screen-item");
  $("#chooseBody").style.display = "none";
  $("#done").classList.remove("show");
  $("#itemBody").style.display = "block";
  const pd = it.part_detail || {};
  const thumb = pd.thumbnail || pd.image;
  const ld = it.location_detail || null;
  const units = (pd.units || "").trim();
  const path = ld ? ld.pathstring || ld.name || "" : "";
  const locShort = ld ? ld.name || t("loc_word") : t("no_location");
  const trackable = !!pd.trackable;
  // Même présentation de l'emplacement pour tous les objets, empruntables ou
  // non : la puce « 📍 emplacement » (dernier maillon) toujours affichée, et
  // l'arborescence complète en dessous quand l'objet est dans une sous-location.
  // Le trackable ajoute juste sa pill n° de série en tête.
  const locPill = '<span class="pill">📍 ' + esc(locShort) + "</span>";
  const pills = trackable
    ? (it.serial ? '<span class="pill pill-serial">' + esc(it.serial) + "</span>" : "") +
      (pd.IPN ? '<span class="pill">' + esc(pd.IPN) + "</span>" : "") +
      locPill
    : locPill +
      (pd.IPN ? '<span class="pill">' + esc(pd.IPN) + "</span>" : "") +
      (it.batch ? '<span class="pill">' + t("batch_pill", esc(it.batch)) + "</span>" : "");
  $("#itemHead").innerHTML =
    (thumb
      ? '<img class="thumb" src="' +
        esc(mediaUrl(thumb)) +
        '" data-full="' +
        esc(mediaUrl(pd.image || "")) +
        '" alt="" onerror="thumbErr(this)">'
      : boxIcon().outerHTML) +
    '<div style="min-width:0"><p class="name">' +
    esc(pd.full_name || pd.name || t("item_n", it.pk)) +
    '</p><div class="sub">' +
    pills +
    "</div>" +
    (path && path.includes("/")
      ? '<div class="loc-tree">' +
        path
          .split("/")
          .map(
            (s, i, a) =>
              '<span class="' +
              (i === a.length - 1 ? "crumb-last" : "") +
              '">' +
              esc(s.trim()) +
              "</span>",
          )
          .join('<span class="crumb-sep">›</span>') +
        "</div>"
      : "") +
    "</div>";
  $("#qtyInput").value = fmt(it.quantity);
  $(".qty-label").textContent = t("qty_in_stock") + (units ? " (" + units + ")" : "");
  $("#comment").value = "";
  // objet trackable + plugin prêts actif -> bloc prêt à la place de la quantité
  applyItemMode(it);
}
function boxIcon() {
  const d = document.createElement("div");
  d.className = "thumb";
  d.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/></svg>';
  return d;
}
function step(d) {
  let v = parseFloat($("#qtyInput").value.replace(",", ".")) || 0;
  v = Math.max(0, v + d);
  $("#qtyInput").value = fmt(v);
}

async function submitAdjust() {
  if (!CURRENT) return;
  const v = parseFloat($("#qtyInput").value.replace(",", "."));
  if (isNaN(v) || v < 0) {
    toast(t("qty_invalid"), "bad");
    return;
  }
  const notes = $("#comment").value.trim();
  const btn = $("#submitBtn"),
    html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> ' + t("saving");
  try {
    await api("/api/stock/count/", {
      method: "POST",
      body: { items: [{ pk: CURRENT.pk, quantity: v }], notes },
    });
    const pd = CURRENT.part_detail || {};
    showDone(
      t("stock_updated"),
      pd.full_name || pd.name || t("item_n", CURRENT.pk),
      fmt(v) + (pd.units || "" ? " " + pd.units : ""),
    );
    toast(t("stock_saved"), "ok");
  } catch (e) {
    toast(e.status === 403 ? t("perm_stock_change") : e.message, "bad");
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}
function showDone(title, name, qty, warn) {
  // écran terminal (seule action : « Scanner un autre ») : un refresh ici
  // repart du scan — surtout pas du formulaire de création dont le code
  // scanné vient d'être lié (risque de doublon)
  forgetView();
  $("#doneTitle").textContent = title;
  $("#doneName").textContent = name;
  $("#doneQty").textContent = qty;
  const w = $("#doneWarn");
  if (warn) {
    w.textContent = warn;
    w.style.display = "block";
  } else {
    w.style.display = "none";
  }
  $("#itemBody").style.display = "none";
  $("#chooseBody").style.display = "none";
  show("#screen-item");
  $("#done").classList.add("show");
}
