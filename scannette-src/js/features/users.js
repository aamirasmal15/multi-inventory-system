/* ==========================================================================
   features/users.js — Gestion des utilisateurs (admins) : approbation des
   nouvelles demandes et fiches des membres (compte actif, droits admin).

   Entrée : bouton « Gérer les membres » au bas de la carte d'identité de
   Mon compte, affiché aux seuls admins (is_staff) — l'API InvenTree ne
   donne de toute façon l'écriture qu'aux staff (StaffRolePermissionOrReadOnly),
   lecture seule pour les autres.

   En attente = compte sans groupe : même critère que l'écran « en attente
   d'approbation » à la connexion (pas de groupe -> pas de rôles).
   Approuver = poser le groupe des membres (PATCH group_ids), comme le fait
   finalize.py à la création de l'instance ; is_staff reste le verrou admin.
   Refuser = supprimer le compte (aucun accès ni historique à ce stade).
   Les membres approuvés, eux, ne se suppriment JAMAIS d'ici : au pire on
   désactive (réversible) — la suppression définitive reste dans InvenTree.
   ========================================================================== */

let USERS_ME = null; // /api/user/me/ (guards anti auto-rétrogradation)
let USERS_LIST = null; // dernière liste chargée (/api/user/)
let USERS_GROUP = null; // pk du groupe des membres (cible d'approbation)
let USERS_OPEN = {}; // fiches dépliées (pk -> true), conservées au re-rendu
let USERS_FRESH = 0; // pk à surligner en vert (vient d'être approuvé)
let USERS_BUSY = false; // une action serveur à la fois
let USERS_Q = ""; // filtre de la recherche membres

function userPending(u) {
  return !(u.groups || []).length && !u.is_staff && !u.is_superuser;
}
function userName(u) {
  return (((u.first_name || "") + " " + (u.last_name || "")).trim()) || u.username || "?";
}
function userInitials(u) {
  const ab = ((u.first_name || "")[0] || "") + ((u.last_name || "")[0] || "");
  return (ab || (u.username || "?")[0]).toUpperCase();
}

async function openUsers() {
  rememberView("users");
  show("#screen-users");
  hideErr($("#usersErr"));
  $("#usersBody").style.display = "none";
  $("#usersLoading").style.display = "";
  try {
    await usersLoad();
    $("#usersLoading").style.display = "none";
    $("#usersBody").style.display = "";
    renderUsers();
  } catch (e) {
    $("#usersLoading").style.display = "none";
    showErr($("#usersErr"), e.message);
  }
}

async function usersLoad() {
  const [me, users, groups] = await Promise.all([
    USERS_ME ? Promise.resolve(USERS_ME) : api("/api/user/me/"),
    api("/api/user/"),
    api("/api/user/group/"),
  ]);
  USERS_ME = me || null;
  USERS_LIST = (Array.isArray(users) && users) || (users && users.results) || [];
  const gl = (Array.isArray(groups) && groups) || (groups && groups.results) || [];
  // groupe cible : membres_* de préférence (convention create-asso), sinon le premier
  const g = gl.find((x) => /^membres/i.test(x.name || "")) || gl[0];
  USERS_GROUP = g ? g.pk : null;
  usersBadgePaint();
}

/* recharge silencieuse après une erreur d'action : l'état serveur fait foi */
async function usersReload() {
  try {
    await usersLoad();
    renderUsers();
  } catch (_) {}
}

function renderUsers() {
  const sorted = (USERS_LIST || [])
    .slice()
    .sort((a, b) => userName(a).localeCompare(userName(b), undefined, { sensitivity: "base" }));
  renderPendingUsers(sorted.filter(userPending));
  renderMemberUsers(sorted.filter((u) => !userPending(u)));
  usersBadgePaint(); // les pastilles (chip, Mon compte) suivent chaque action
  USERS_FRESH = 0; // le surlignage vert ne joue qu'au rendu qui suit l'approbation
}

/* ---- file d'attente ---- */
function renderPendingUsers(pend) {
  const card = $("#pendingCard");
  $("#pendingCnt").textContent = pend.length;
  card.classList.toggle("waiting", pend.length > 0);
  card.innerHTML = "";
  if (!pend.length) {
    const empty = document.createElement("div");
    empty.className = "p-empty";
    empty.innerHTML = CHECK;
    const s = document.createElement("span");
    s.textContent = t("users_pending_none");
    empty.appendChild(s);
    card.appendChild(empty);
    return;
  }
  pend.forEach((u) => card.appendChild(pendingUserRow(u)));
}

function pendingActBtn(cls, label, name, html, onTap) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = label;
  b.setAttribute("aria-label", label + " " + name);
  b.innerHTML = html;
  b.addEventListener("click", onTap);
  return b;
}

function pendingUserRow(u) {
  const row = document.createElement("div");
  row.className = "p-row";
  const av = document.createElement("span");
  av.className = "avatar pa";
  av.textContent = userInitials(u);
  const main = document.createElement("div");
  main.className = "p-main";
  const nm = document.createElement("div");
  nm.className = "p-name";
  nm.textContent = userName(u);
  const ml = document.createElement("div");
  ml.className = "p-mail";
  ml.textContent = u.email || u.username || "";
  main.append(nm, ml);
  const acts = document.createElement("div");
  acts.className = "p-act";
  const name = userName(u);
  acts.append(
    pendingActBtn("p-yes", t("users_approve"), name, CHECK, () => approveUser(u, row)),
    pendingActBtn("p-no", t("users_refuse"), name, "×", () => refuseUser(u, row)),
  );
  row.append(av, main, acts);
  return row;
}

/* repli animé d'une ligne de la file (approbation ou refus) */
function collapseUserRow(row) {
  return new Promise((done) => {
    row.style.height = row.offsetHeight + "px";
    requestAnimationFrame(() => {
      row.classList.add("leaving");
      row.style.height = "0px";
      row.style.paddingTop = "0px";
      row.style.paddingBottom = "0px";
    });
    setTimeout(done, 300);
  });
}

async function approveUser(u, row) {
  if (USERS_BUSY) return;
  if (!USERS_GROUP) {
    toast(t("users_no_group"), "bad");
    return;
  }
  USERS_BUSY = true;
  row.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    const r = await api("/api/user/" + u.pk + "/", {
      method: "PATCH",
      body: { group_ids: [USERS_GROUP] },
    });
    await collapseUserRow(row);
    u.groups = (r && r.groups) || [{ pk: USERS_GROUP }];
    USERS_FRESH = u.pk;
    renderUsers();
    toast(t("users_approved", userName(u)), "ok");
  } catch (e) {
    toast(e.message, "bad");
    usersReload();
  } finally {
    USERS_BUSY = false;
  }
}

async function refuseUser(u, row) {
  if (USERS_BUSY) return;
  const ok = await appConfirm({
    title: t("users_refuse_q", userName(u)),
    text: t("users_refuse_txt"),
    confirmLabel: t("users_refuse"),
    danger: true,
  });
  if (!ok) return;
  USERS_BUSY = true;
  row.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    await api("/api/user/" + u.pk + "/", { method: "DELETE" });
    await collapseUserRow(row);
    USERS_LIST = USERS_LIST.filter((x) => x.pk !== u.pk);
    renderUsers();
    toast(t("users_refused", userName(u)), "ok");
  } catch (e) {
    toast(e.message, "bad");
    usersReload();
  } finally {
    USERS_BUSY = false;
  }
}

/* ---- membres ---- */
function usersSetQuery(q) {
  USERS_Q = q || "";
  $("#userSearchClear").style.display = USERS_Q ? "" : "none";
  renderMemberUsers(
    (USERS_LIST || [])
      .slice()
      .sort((a, b) => userName(a).localeCompare(userName(b), undefined, { sensitivity: "base" }))
      .filter((u) => !userPending(u)),
  );
}

function renderMemberUsers(members) {
  const card = $("#memberCard");
  $("#memberCnt").textContent = members.length;
  const q = USERS_Q.trim().toLowerCase();
  const list = q
    ? members.filter((u) =>
        (userName(u) + " " + (u.username || "") + " " + (u.email || ""))
          .toLowerCase()
          .includes(q),
      )
    : members;
  card.innerHTML = "";
  if (!list.length) {
    // sans filtre la liste n'est jamais vide (l'admin qui regarde en fait partie)
    if (q) {
      const empty = document.createElement("div");
      empty.className = "sr-empty";
      empty.textContent = t("users_none_match", USERS_Q.trim());
      card.appendChild(empty);
    }
    return;
  }
  list.forEach((u) => card.appendChild(memberUserRow(u)));
}

function userPill(cls, label) {
  const p = document.createElement("span");
  p.className = "pill " + cls;
  p.textContent = label;
  return p;
}

function memberUserRow(u) {
  const isMe = USERS_ME && u.pk === USERS_ME.pk;
  const open = !!USERS_OPEN[u.pk];
  const it = document.createElement("div");
  it.className =
    "u-item" + (open ? " open" : "") + (u.is_active ? "" : " inactive") +
    (USERS_FRESH === u.pk ? " flash" : "");
  const row = document.createElement("button");
  row.type = "button";
  row.className = "u-row";
  row.setAttribute("aria-expanded", open ? "true" : "false");
  const av = document.createElement("span");
  av.className = "avatar" + (u.is_active ? "" : " off");
  av.textContent = userInitials(u);
  const main = document.createElement("span");
  main.className = "u-main";
  const nm = document.createElement("span");
  nm.className = "u-name";
  nm.textContent = userName(u);
  if (isMe) nm.appendChild(userPill("pill-you", t("users_you")));
  if (u.is_staff || u.is_superuser) nm.appendChild(userPill("pill-admin", "Admin"));
  if (!u.is_active) nm.appendChild(userPill("pill-off", t("users_blocked")));
  const sub = document.createElement("span");
  sub.className = "u-sub";
  sub.textContent = u.username || "";
  main.append(nm, sub);
  const chev = document.createElement("span");
  chev.className = "u-chev";
  chev.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  row.append(av, main, chev);
  row.addEventListener("click", () => {
    USERS_OPEN[u.pk] = !USERS_OPEN[u.pk];
    renderUsers();
  });
  it.appendChild(row);
  if (open) it.appendChild(memberUserDetail(u, isMe));
  return it;
}

function userLine(label, value) {
  const l = document.createElement("div");
  l.className = "u-line";
  const s = document.createElement("span");
  s.textContent = label;
  const b = document.createElement("b");
  b.className = "mono";
  b.textContent = value || "—";
  l.append(s, b);
  return l;
}

function userToggle(title, hint, on, violet, disabled, onTap) {
  const tg = document.createElement("div");
  tg.className = "u-tog";
  const txt = document.createElement("div");
  txt.className = "u-tog-txt";
  const b = document.createElement("b");
  b.textContent = title;
  const s = document.createElement("small");
  s.textContent = hint;
  txt.append(b, s);
  const sw = document.createElement("button");
  sw.type = "button";
  sw.className = "sw" + (violet ? " violet" : "") + (on ? " on" : "");
  sw.setAttribute("aria-pressed", on ? "true" : "false");
  sw.setAttribute("aria-label", title);
  if (disabled) sw.disabled = true;
  else sw.addEventListener("click", onTap);
  tg.append(txt, sw);
  return tg;
}

function memberUserDetail(u, isMe) {
  const det = document.createElement("div");
  det.className = "u-det";
  const lines = document.createElement("div");
  lines.className = "u-lines";
  lines.appendChild(userLine(t("users_email"), u.email));
  lines.appendChild(
    userLine(t("users_group"), (u.groups || []).map((g) => g.name).join(", ")),
  );
  det.appendChild(lines);
  // superutilisateur : intouchable d'ici (l'API refuse aussi is_superuser)
  const locked = !!u.is_superuser;
  det.appendChild(
    userToggle(
      t("users_admin"),
      t("users_admin_hint"),
      !!(u.is_staff || u.is_superuser),
      true,
      locked,
      () => toggleUserAdmin(u, isMe),
    ),
  );
  if (locked) {
    const hint = document.createElement("p");
    hint.className = "field-hint";
    hint.style.margin = "8px 0 0";
    hint.textContent = t("users_su_hint");
    det.appendChild(hint);
  } else {
    // bloquer / débloquer : bouton explicite en pied de fiche (réversible,
    // les emprunts et l'historique restent) — remplace un toggle ambigu
    const acts = document.createElement("div");
    acts.className = "u-acts";
    const b = document.createElement("button");
    b.type = "button";
    if (u.is_active) {
      b.className = "btn btn-outline-danger";
      b.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/></svg>';
      b.addEventListener("click", () => blockUser(u, isMe));
    } else {
      b.className = "btn btn-ghost unblock";
      b.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
      b.addEventListener("click", () => unblockUser(u));
    }
    const lbl = document.createElement("span");
    lbl.textContent = t(u.is_active ? "users_block_btn" : "users_unblock_btn");
    b.appendChild(lbl);
    acts.appendChild(b);
    det.appendChild(acts);
  }
  return det;
}

/* bloquer un membre : il ne peut plus se connecter, ses emprunts et son
   historique restent ; réversible d'un appui (Débloquer). La suppression
   définitive, elle, ne se fait volontairement pas depuis la Scannette. */
async function blockUser(u, isMe) {
  if (USERS_BUSY) return;
  if (isMe) {
    toast(t("users_self_block"), "bad");
    return;
  }
  const ok = await appConfirm({
    title: t("users_block_q", userName(u)),
    text: t("users_block_txt"),
    confirmLabel: t("users_block"),
    danger: true,
  });
  if (!ok) return;
  USERS_BUSY = true;
  try {
    await userPatch(u, { is_active: false });
    toast(t("users_block_ok", userName(u)), "ok");
  } catch (e) {
    toast(e.message, "bad");
    usersReload();
  } finally {
    USERS_BUSY = false;
  }
}

async function unblockUser(u) {
  if (USERS_BUSY) return;
  USERS_BUSY = true;
  try {
    await userPatch(u, { is_active: true });
    toast(t("users_react_ok", userName(u)), "ok");
  } catch (e) {
    toast(e.message, "bad");
    usersReload();
  } finally {
    USERS_BUSY = false;
  }
}

async function userPatch(u, body) {
  const r = await api("/api/user/" + u.pk + "/", { method: "PATCH", body });
  if (r) {
    u.is_active = r.is_active;
    u.is_staff = r.is_staff;
    if (r.groups) u.groups = r.groups;
  }
  renderUsers();
}

async function toggleUserAdmin(u, isMe) {
  if (USERS_BUSY) return;
  if (isMe) {
    toast(t("users_self_admin"), "bad");
    return;
  }
  USERS_BUSY = true;
  try {
    await userPatch(u, { is_staff: !u.is_staff });
    toast(t(u.is_staff ? "users_admin_on" : "users_admin_off", userName(u)), "ok");
  } catch (e) {
    toast(e.message, "bad");
    usersReload();
  } finally {
    USERS_BUSY = false;
  }
}

/* ---- pastilles « demandes en attente » (chip topbar + bouton Mon compte) ----
   Peintes depuis la dernière liste connue ; rafraîchies au boot (staff
   seulement, cf. checkAuthorized) et à chaque ouverture de Mon compte. */
function usersBadgePaint() {
  const n = (USERS_LIST || []).filter(userPending).length;
  const chip = $("#userChip");
  if (chip) chip.classList.toggle("dot", n > 0);
  const c = $("#acctUsersCnt");
  if (c) {
    c.textContent = n;
    c.style.display = n ? "" : "none";
  }
}

async function usersBadgeRefresh() {
  try {
    const users = await api("/api/user/");
    USERS_LIST = (Array.isArray(users) && users) || (users && users.results) || [];
    usersBadgePaint();
  } catch (_) {}
}
