/* ==========================================================================
   features/location.js — Emplacements : scan d'un rack, liste des articles, correction rapide des stocks.
   ========================================================================== */

/* ---- location view (scan d'un emplacement) ---- */
async function loadLocation(pk) {
  rememberView("loc", pk); // rouvre l'emplacement après un rafraîchissement
  show("#screen-location");
  $("#locTitle").textContent = t("loc_word"); // pas de titre périmé pendant le chargement
  $("#locSub").textContent = "";
  $("#locSearch").style.display = "none";
  $("#locList").innerHTML = '<div class="skeleton">' + t("loading") + "</div>";
  try {
    const loc = await api("/api/stock/location/" + pk + "/").catch(() => null);
    let subCount = 0;
    try {
      const s = await api("/api/stock/location/?parent=" + pk + "&limit=1");
      subCount = s && s.count != null ? s.count : ((s && (s.results || s)) || []).length;
    } catch (_) {}
    const structural = loc && loc.structural;
    if (structural || subCount > 0) {
      locationRefused(loc ? loc.name || "#" + pk : "#" + pk, !!structural);
      return;
    }
    const r = await api("/api/stock/?location=" + pk + "&cascade=false&part_detail=true&limit=200");
    const items = r.results || r;
    renderLocationItems(loc ? loc.name || t("loc_n", pk) : t("loc_n", pk), items);
  } catch (e) {
    gotoScan();
    showErr($("#scanErr"), e.message);
  }
}
function locationRefused(name, structural) {
  show("#screen-location");
  $("#locSearch").style.display = "none";
  $("#locTitle").textContent = name;
  $("#locSub").textContent = "";
  $("#locList").innerHTML =
    '<div class="loc-refuse"><div class="lr-emoji">🚫</div><div class="lr-t">' +
    t("loc_refuse_title") +
    '</div><div class="lr-s">' +
    t("loc_refuse_msg_html", structural) +
    "</div></div>";
}
function locBox() {
  const d = document.createElement("div");
  d.className = "lthumb";
  d.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7L12 12l8.7-5M12 22V12"/></svg>';
  return d;
}
function renderLocationItems(locName, items) {
  show("#screen-location");
  $("#locTitle").textContent = locName;
  $("#locSub").textContent = items.length ? t("loc_count_sub", items.length) : "";
  const wrap = $("#locList");
  wrap.innerHTML = "";
  const sb = $("#locSearch");
  sb.value = "";
  sb.style.display = items.length ? "block" : "none";
  if (!items.length) {
    wrap.innerHTML = '<div class="skeleton">' + t("loc_empty") + "</div>";
    return;
  }
  items.forEach((it) => {
    const pd = it.part_detail || {};
    const units = (pd.units || "").trim();
    const thumb = pd.thumbnail || pd.image;
    const row = document.createElement("div");
    row.className = "loc-row";
    row.dataset.name = ((pd.full_name || pd.name || "") + " " + (pd.IPN || "")).toLowerCase();
    row.innerHTML =
      (thumb
        ? '<img class="lthumb" src="' +
          esc(mediaUrl(thumb)) +
          '" data-full="' +
          esc(mediaUrl(pd.image || "")) +
          '" alt="" onerror="thumbErr(this,\'loc\')">'
        : locBox().outerHTML) +
      '<div class="lmain"><div class="t">' +
      esc(pd.full_name || pd.name || t("item_n", it.pk)) +
      "</div>" +
      '<div class="s"></div>' +
      '<div class="loc-ctrl"><button class="mini minus">−</button><input type="text" inputmode="decimal"><button class="mini plus">+</button><button class="loc-save">' +
      CHECK +
      "</button></div></div>";
    const input = row.querySelector("input"),
      save = row.querySelector(".loc-save"),
      sub = row.querySelector(".s");
    function paintSub() {
      sub.textContent =
        (it.batch ? t("batch_pill", it.batch) + " · " : "") +
        t("stock_label") +
        fmt(it.quantity) +
        (units ? " " + units : "");
    }
    function refresh() {
      const v = parseFloat(input.value.replace(",", "."));
      save.classList.toggle("on", !isNaN(v) && v >= 0 && v !== Number(it.quantity));
    }
    input.value = fmt(it.quantity);
    paintSub();
    row.querySelector(".minus").onclick = () => {
      let v = parseFloat(input.value.replace(",", ".")) || 0;
      v = Math.max(0, v - 1);
      input.value = fmt(v);
      refresh();
    };
    row.querySelector(".plus").onclick = () => {
      let v = parseFloat(input.value.replace(",", ".")) || 0;
      input.value = fmt(v + 1);
      refresh();
    };
    input.oninput = refresh;
    save.onclick = async () => {
      const v = parseFloat(input.value.replace(",", "."));
      if (isNaN(v) || v < 0) return;
      const h = save.innerHTML;
      save.classList.remove("on");
      save.innerHTML = '<span class="spin" style="width:15px;height:15px;border-width:2px"></span>';
      try {
        await api("/api/stock/count/", {
          method: "POST",
          body: { items: [{ pk: it.pk, quantity: v }], notes: "" },
        });
        it.quantity = v;
        paintSub();
        save.innerHTML = h;
        refresh();
        toast((pd.name || t("item_word")) + " : " + fmt(v), "ok");
      } catch (e) {
        save.innerHTML = h;
        save.classList.add("on");
        toast(e.status === 403 ? t("perm_stock_change") : e.message, "bad");
      }
    };
    wrap.appendChild(row);
  });
}
