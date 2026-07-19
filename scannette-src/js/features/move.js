/* ==========================================================================
   features/move.js — Déplacement de stock vers un autre emplacement.
   ========================================================================== */

/* ---- déplacement de stock ---- */
async function moveStock() {
  if (!CURRENT) return;
  await ensureLocs();
  const cur = CURRENT.location_detail ? CURRENT.location_detail.pk : CURRENT.location || "";
  openTreePicker(
    t("move_to"),
    LOCS || [],
    cur,
    async (pk) => {
      if (!pk || String(pk) === String(cur)) return;
      const mb = $("#moveBtn"),
        h = mb.innerHTML;
      mb.disabled = true;
      mb.innerHTML = '<span class="spin"></span> ' + t("moving");
      try {
        // un lot du même article existe déjà à destination ? -> fusion (quantités
        // additionnées) au lieu de créer un doublon au même emplacement
        let target = null;
        if (!CURRENT.serial) {
          const ex = await api(
            "/api/stock/?part=" + CURRENT.part + "&location=" + Number(pk) + "&cascade=false",
          ).catch(() => null);
          const list = ex ? ex.results || ex : [];
          const cands = (Array.isArray(list) ? list : []).filter(
            (s) => !s.serial && s.pk !== CURRENT.pk,
          );
          target =
            cands.find((s) => (s.batch || "") === (CURRENT.batch || "")) || cands[0] || null;
        }
        let merged = false;
        if (target) {
          // le 1er item de la liste sert de base : c'est le lot déjà en place qui survit
          await api("/api/stock/merge/", {
            method: "POST",
            body: {
              items: [{ item: target.pk }, { item: CURRENT.pk }],
              location: Number(pk),
              notes: "Fusionné via Scannette",
              allow_mismatched_suppliers: true,
              allow_mismatched_status: true,
            },
          })
            .then(() => (merged = true))
            .catch(() => {}); // fusion refusée (lots incompatibles) -> déplacement simple
        }
        if (!merged) {
          await api("/api/stock/transfer/", {
            method: "POST",
            body: {
              items: [{ pk: CURRENT.pk, quantity: CURRENT.quantity }],
              location: Number(pk),
              notes: "Déplacé via Scannette",
            },
          });
        }
        toast(merged ? t("stock_merged") : t("stock_moved"), "ok");
        if (merged) await loadItem(target.pk);
        else await loadItem(CURRENT.pk);
      } catch (e) {
        toast(e.status === 403 ? t("perm_stock_change") : e.message, "bad");
      } finally {
        mb.disabled = false;
        mb.innerHTML = h;
      }
    },
    { allowNone: false },
  );
}
