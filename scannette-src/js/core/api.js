/* ==========================================================================
   core/api.js — Client API InvenTree : fetch + token, gestion d'erreurs.
   ========================================================================== */

/* ---- API ---- */
async function api(path, { method = "GET", body = null, basic = null } = {}) {
  const h = {};
  if (basic) h["Authorization"] = "Basic " + btoa(basic);
  else if (TOKEN) h["Authorization"] = "Token " + TOKEN;
  if (body) h["Content-Type"] = "application/json";
  // Timeout dur : sans lui, un réseau qui « pend » (wifi limite, 4G en cave)
  // laisse le bouton en sablier pour toujours. En cas de coupure, on ne sait
  // pas si le serveur a reçu la requête : le message invite à VÉRIFIER l'état
  // avant de refaire l'action, plutôt que de réessayer à l'aveugle.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: h,
      body: body ? JSON.stringify(body) : null,
      signal: ctl.signal,
    });
  } catch (_) {
    const err = new Error(method === "GET" ? t("net_get") : t("net_send"));
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 && !basic) {
    logout(true);
    throw new Error(t("session_expired"));
  }
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  if (!res.ok) {
    let detail =
      data && (data.detail || data.error || (data.non_field_errors && data.non_field_errors[0]));
    if (!detail && data && typeof data === "object") {
      const k = Object.keys(data)[0];
      if (k) detail = k + " : " + (Array.isArray(data[k]) ? data[k][0] : data[k]);
    }
    const err = new Error(detail || t("error_n", res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}
