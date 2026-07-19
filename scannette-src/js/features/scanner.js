/* ==========================================================================
   features/scanner.js — Écran scan : caméra (BarcodeDetector natif / ZXing WASM / ZXing JS), décodage, résolution des codes.
   ========================================================================== */

/* ---- scan ---- */
let scanLock = false;
function gotoScan() {
  hideErr($("#scanErr"));
  $("#manualInput").value = "";
  if ($("#partSearch")) clearSearch();
  forgetView(); // de retour au scan : plus d'écran à rouvrir au refresh
  scanLock = false;
  setWarn(false);
  blackRetried = false;
  blackSince = 0;
  show("#screen-scan");
  startCamera();
}

/* ---- camera (natif si dispo, sinon ZXing) ---- */
let camStream = null,
  scanTimer = null,
  zreader = null,
  scanCv = null,
  scanCx = null;
let nativeDet = null,
  wasmReady = false,
  decReady = false,
  detBusy = false;
/* anti-erreur de lecture : un code 1D doit être lu plusieurs fois à l'identique */
const SCAN_CONFIRM = 2; // nb de lectures identiques requises (codes 1D)
let confVal = "",
  confCount = 0;
function resetConfirm() {
  confVal = "";
  confCount = 0;
}
function is2D(fmt) {
  fmt = String(fmt || "").toLowerCase();
  return /qr|datamatrix|data_matrix|aztec|pdf417|maxicode/.test(fmt);
}
function showCamStart(msg) {
  if (camStream) {
    return;
  }
  $("#reader").style.display = "none";
  const s = $("#camStart");
  s.style.display = "block";
  $("#camMsg").textContent = msg || "";
}
function ensureCanvas() {
  if (!scanCv) {
    scanCv = document.createElement("canvas");
    scanCx = scanCv.getContext("2d", { willReadFrequently: true });
  }
}
function ensureReader() {
  if (!zreader) {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    zreader = new ZXing.BrowserMultiFormatReader(hints);
  }
  return zreader;
}
async function initDetector() {
  if (decReady) return;
  decReady = true;
  if ("BarcodeDetector" in window) {
    try {
      nativeDet = new window.BarcodeDetector();
    } catch (_) {
      nativeDet = null;
    }
  }
  // iPhone (pas de natif) : précharge ZXing-C++ WASM, bien plus rapide que le JS
  if (!nativeDet && typeof ZXingWASM !== "undefined") {
    try {
      ZXingWASM.prepareZXingModule({
        overrides: { locateFile: (p) => API + "/" + p },
        fireImmediately: true,
      })
        .then(() => {
          wasmReady = true;
        })
        .catch(() => {
          wasmReady = false;
        });
    } catch (_) {}
  }
}
let camStarting = false,
  blackWd = null,
  blackRetried = false,
  blackSince = 0;
async function tapFocus() {
  try {
    const track = camStream && camStream.getVideoTracks ? camStream.getVideoTracks()[0] : null;
    if (!track || !track.getCapabilities) return;
    const caps = track.getCapabilities() || {};
    const rd = $("#reader");
    if (rd) {
      rd.classList.add("focusing");
      setTimeout(() => rd.classList.remove("focusing"), 500);
    }
    if (caps.focusMode && caps.focusMode.includes("single-shot")) {
      await track.applyConstraints({ advanced: [{ focusMode: "single-shot" }] });
      if (caps.focusMode.includes("continuous"))
        setTimeout(() => {
          track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
        }, 1600);
    } else if (caps.focusMode && caps.focusMode.includes("continuous")) {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    }
  } catch (_) {}
}
async function startCamera() {
  if (camStream || camStarting) return;
  if (!window.isSecureContext) {
    showCamStart(t("cam_https"));
    return;
  }
  if (
    typeof ZXing === "undefined" &&
    typeof ZXingWASM === "undefined" &&
    !("BarcodeDetector" in window)
  ) {
    showCamStart(t("cam_noreader"));
    return;
  }
  camStarting = true;
  $("#camStart").style.display = "none";
  $("#reader").style.display = "block";
  const box = document.querySelector(".scanbox");
  if (box) box.classList.remove("hit");
  const video = $("#camvideo");
  video.setAttribute("playsinline", "true");
  video.setAttribute("autoplay", "true");
  video.muted = true;
  video.playsInline = true;
  try {
    await initDetector();
    ensureCanvas();
    // libère tout flux résiduel attaché à la vidéo
    try {
      const old = video.srcObject;
      if (old && old.getTracks) {
        old.getTracks().forEach((t) => t.stop());
      }
      video.srcObject = null;
    } catch (_) {}
    const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
    let stream = null;
    for (const fm of [
      { facingMode: { exact: "environment" } },
      { facingMode: { ideal: "environment" } },
      {},
    ]) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: Object.assign({}, fm, base) });
        break;
      } catch (_) {}
    }
    if (!stream) throw Object.assign(new Error("nocam"), { name: "NotFoundError" });
    camStream = stream;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (_) {}
    scanTimer = setInterval(decodeTick, nativeDet ? 70 : 90);
    armBlackWatchdog();
  } catch (e) {
    stopCamera();
    let m = t("cam_tap");
    if (e && e.name === "NotAllowedError") m = t("cam_denied");
    else if (e && e.name === "NotFoundError") m = t("cam_unavail");
    showCamStart(m);
  } finally {
    camStarting = false;
  }
}
function scanActive() {
  const s = $("#screen-scan");
  return s && s.classList.contains("active");
}
function armBlackWatchdog() {
  clearInterval(blackWd);
  blackSince = 0;
  blackWd = setInterval(() => {
    if (!scanActive()) {
      return;
    }
    if (scanLock) return;
    const v = $("#camvideo");
    const track = camStream && camStream.getVideoTracks ? camStream.getVideoTracks()[0] : null;
    const dead = !camStream || (track && track.readyState === "ended");
    const black = !v || !v.videoWidth;
    if (dead) {
      restartCamera();
      return;
    } // flux mort -> relance
    if (black) {
      if (!blackSince) blackSince = Date.now();
      else if (Date.now() - blackSince > 2400) {
        if (!blackRetried) {
          blackRetried = true;
          blackSince = 0;
          restartCamera();
        } else {
          stopCamera();
          showCamStart(t("cam_notstarted"));
        }
      }
    } else {
      blackSince = 0;
      blackRetried = false;
    }
  }, 1200);
}
let camBusy = false;
async function restartCamera() {
  if (camBusy) return;
  camBusy = true;
  stopCamera();
  await new Promise((r) => setTimeout(r, 300));
  camBusy = false;
  if (scanActive()) startCamera();
}
async function decodeTick() {
  if (scanLock || detBusy) return;
  const video = $("#camvideo");
  if (!video || !video.videoWidth) return;
  const vw = video.videoWidth,
    vh = video.videoHeight;
  const side = Math.floor(Math.min(vw, vh) * 0.62);
  const sx = Math.floor((vw - side) / 2),
    sy = Math.floor((vh - side) / 2);
  const out = 512;
  scanCv.width = out;
  scanCv.height = out;
  scanCx.drawImage(video, sx, sy, side, side, 0, 0, out, out);
  if (nativeDet) {
    detBusy = true;
    try {
      const codes = await nativeDet.detect(scanCv);
      handleCodes((codes || []).map((c) => ({ text: c.rawValue, format: c.format })));
    } catch (_) {
    } finally {
      detBusy = false;
    }
    return;
  }
  if (wasmReady && typeof ZXingWASM !== "undefined") {
    detBusy = true;
    try {
      const img = scanCx.getImageData(0, 0, out, out);
      const r = await ZXingWASM.readBarcodes(img, { tryHarder: true, maxNumberOfSymbols: 6 });
      handleCodes((r || []).map((x) => ({ text: x.text, format: x.format })));
    } catch (_) {
    } finally {
      detBusy = false;
    }
    return;
  }
  if (typeof ZXing !== "undefined") {
    try {
      const src = new ZXing.HTMLCanvasElementLuminanceSource(scanCv);
      const res = ensureReader().decodeBitmap(
        new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src)),
      );
      let fmt = "";
      try {
        fmt = ZXing.BarcodeFormat[res.getBarcodeFormat()];
      } catch (_) {}
      handleCodes([{ text: res.getText(), format: fmt }]);
    } catch (_) {
      handleCodes([]);
    }
  }
}
function setWarn(on) {
  const w = $("#scanWarn");
  if (w) w.style.display = on ? "flex" : "none";
}
function handleCodes(items) {
  const seen = new Set(),
    uniq = [];
  for (const it of items || []) {
    const t = it && it.text;
    if (t && !seen.has(t)) {
      seen.add(t);
      uniq.push(it);
    }
  }
  if (uniq.length > 1) {
    setWarn(true);
    resetConfirm();
    return;
  } // plusieurs codes -> on n'accède à rien
  setWarn(false);
  if (uniq.length !== 1) return; // rien ce frame (on ne réinitialise pas le compteur)
  const text = uniq[0].text,
    fmt = uniq[0].format;
  if (is2D(fmt)) {
    onScanned(text);
    return;
  } // QR / code 2D : fiable -> immédiat
  // code 1D : exiger SCAN_CONFIRM lectures identiques consécutives (anti-erreur)
  if (text === confVal) confCount++;
  else {
    confVal = text;
    confCount = 1;
  }
  if (confCount >= SCAN_CONFIRM) onScanned(text);
}
function onScanned(t) {
  if (scanLock || !t) return;
  scanLock = true;
  try {
    navigator.vibrate && navigator.vibrate(55);
  } catch (_) {}
  const box = document.querySelector(".scanbox");
  if (box) box.classList.add("hit");
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  setTimeout(() => {
    stopCamera();
    processBarcode(t);
  }, 240);
}
function stopCamera() {
  resetConfirm();
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (blackWd) {
    clearInterval(blackWd);
    blackWd = null;
  }
  if (camStream) {
    try {
      camStream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    camStream = null;
  }
  const v = $("#camvideo");
  if (v) {
    try {
      v.pause();
      v.srcObject = null;
    } catch (_) {}
  }
}

let PENDING_CODE = "";
const LINKED = {}; // code -> part.pk qu'on vient de lier (fiabilise le rescan immédiat)
async function resolveBarcode(code) {
  if (LINKED[code]) return { part: { pk: LINKED[code] } }; // on l'a lié nous-mêmes -> résolution immédiate
  for (let i = 0; i < 3; i++) {
    try {
      const r = await api("/api/barcode/", { method: "POST", body: { barcode: code } });
      if (r && (r.stockitem || r.stocklocation || r.part || r.supplierpart)) return r;
    } catch (e) {
      if (!(e.status === 400 || /no match|not.*found|introuvable|aucun/i.test(e.message))) throw e; // vraie erreur -> remonte
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 350 + i * 400)); // laisse le serveur indexer (création récente)
  }
  return null;
}
async function processBarcode(raw) {
  const code = (raw || "").trim();
  if (!code) return;
  stopCamera();
  // nouveau flux : la flèche retour de la fiche ne doit pas ramener vers la
  // liste d'exemplaires d'un scan précédent (loadFromPart la re-pose si besoin)
  CHOOSE_PART = null;
  hideErr($("#scanErr"));
  show("#screen-item");
  $("#itemBody").style.display = "none";
  $("#chooseBody").style.display = "none";
  $("#done").classList.remove("show");
  $("#screen-item")
    .querySelectorAll(".skeleton")
    .forEach((e) => e.remove());
  $("#screen-item").insertAdjacentHTML(
    "beforeend",
    '<div class="skeleton" id="loader">' + t("searching_item") + "</div>",
  );
  try {
    const r = await resolveBarcode(code);
    $("#loader")?.remove();
    if (r && r.stockitem && r.stockitem.pk) {
      await loadItem(r.stockitem.pk);
    } else if (r && r.stocklocation && r.stocklocation.pk) {
      await loadLocation(r.stocklocation.pk);
    } else if (r && r.part && r.part.pk) {
      await loadFromPart(r.part.pk);
    } else if (r && r.supplierpart && r.supplierpart.pk) {
      const sp = await api("/api/company/part/" + r.supplierpart.pk + "/");
      if (sp && sp.part) await loadFromPart(sp.part);
      else offerCreate(code);
    } else {
      offerCreate(code);
    }
  } catch (e) {
    $("#loader")?.remove();
    gotoScan();
    showErr($("#scanErr"), e.message);
  }
}
