/* ==========================================================================
   features/qr.js — QR code généré après création sans code-barres : rendu + impression.
   ========================================================================== */

/* ---- QR généré après création sans code ---- */
function makeQR(text) {
  for (let t = 0; t <= 12; t++) {
    try {
      const qr = qrcode(t, "M");
      qr.addData(text);
      qr.make();
      return qr.createDataURL(6, 10);
    } catch (_) {}
  }
  return "";
}
async function showCreatedQR(pk, name) {
  // rouvre l'écran QR après un refresh (le QR est régénéré via l'API,
  // seul le nom affiché est mémorisé)
  rememberView("qr", pk, { name: name || "" });
  let data = '{"part": ' + pk + "}";
  try {
    const g = await api("/api/barcode/generate/", {
      method: "POST",
      body: { model: "part", pk: pk },
    });
    if (g && g.barcode)
      data = typeof g.barcode === "string" ? g.barcode : JSON.stringify(g.barcode);
  } catch (_) {}
  LINKED[(data || "").trim()] = pk; // rescan immédiat fiable
  $("#qrName").textContent = name;
  $("#qrData").textContent = data;
  const url = makeQR(data);
  if (url) $("#qrImg").src = url;
  else $("#qrImg").removeAttribute("src");
  show("#screen-qr");
}
function printQR() {
  const img = $("#qrImg").src,
    data = esc($("#qrData").textContent),
    name = esc($("#qrName").textContent);
  const w = window.open("", "_blank");
  if (!w) {
    toast(t("popup_blocked"), "bad");
    return;
  }
  w.document.write(
    "<html><head><title>QR " +
      name +
      '</title></head><body style="text-align:center;font-family:sans-serif;padding:24px">' +
      "<h3>" +
      name +
      '</h3><img src="' +
      img +
      '" style="width:260px;height:260px;image-rendering:pixelated"><p style="font-family:monospace;font-size:11px;word-break:break-all">' +
      data +
      "</p>" +
      "<script>window.onload=function(){window.print();}<\/script></body></html>",
  );
  w.document.close();
}
