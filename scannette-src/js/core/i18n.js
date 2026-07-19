/* ==========================================================================
   core/i18n.js — Langue de l'interface : dictionnaires fr/en, t(), application au DOM.

   La Scannette suit la langue du profil InvenTree de l'utilisateur
   (UserProfile.language, synchronisée après connexion par syncUserLang) :
   fr -> français, en -> anglais, toute AUTRE langue -> anglais (repli).
   Avant connexion : cookie eir_lang du dernier passage, sinon langue du
   navigateur, sinon la langue de l'instance (DEFAULT_LANG).

   Textes statiques d'index.html : data-i18n (textContent), data-i18n-html
   (innerHTML — valeurs du dictionnaire uniquement, jamais de saisie
   utilisateur), data-i18n-ph (placeholder), data-i18n-title (title),
   data-i18n-aria (aria-label).
   Textes dynamiques : t("clé", args...) dans les JS — les clés *_html
   attendent des arguments DÉJÀ échappés (esc) car le résultat part en
   innerHTML.
   ========================================================================== */

const DEFAULT_LANG = "fr"; // langue de l'instance (profil « défaut » et premier passage)

const I18N = {
  /* ---------------------------------------------------------------- FR --- */
  fr: {
    /* topbar + login */
    brand_sub: "Inventaire",
    brand_sub_login: "Inventaire · Scannette",
    acct_title: "Mon compte",
    theme: "Thème",
    logout: "Déconnexion",
    login_title: "Se connecter avec InvenTree",
    login_user: "Identifiant",
    login_user_ph: "identifiant",
    login_pass: "Mot de passe",
    login_btn: "Se connecter",
    login_or: "ou",
    login_eirb: "Se connecter avec EirbConnect",
    login_missing: "Renseignez votre identifiant et votre mot de passe.",
    login_unexpected: "Réponse inattendue du serveur.",
    login_bad: "Identifiant ou mot de passe incorrect.",
    login_connecting: "Connexion…",
    logout_btn: "Se déconnecter",
    /* écran en attente d'approbation */
    pending_title: "Compte en attente d'approbation",
    pending_p1: "Votre compte est en attente d'approbation.",
    pending_p2: "Contactez un admin si le problème persiste.",
    retry: "Réessayer",
    /* écran scan */
    scan_title: "Inventaire",
    mode_scan: "Scanner",
    mode_search: "Rechercher",
    search_ph: "Nom, référence… (ex. eth)",
    clear: "Effacer",
    scan_warn_html: "Plusieurs codes : ne visez qu'<b>un seul</b> code dans le carré",
    cam_enable: "Activer la caméra",
    or_type_code: "ou saisir le code",
    manual_ph: "Code-barres / QR…",
    create_nocode: "Créer un article sans code",
    cam_https: "La caméra nécessite HTTPS (ouvrez la page en https://…).",
    cam_noreader: "Lecteur caméra non chargé.",
    cam_tap: "Touchez pour activer la caméra.",
    cam_denied: "Accès caméra refusé : autorisez la caméra pour ce site, puis touchez ci-dessous.",
    cam_unavail: "Caméra indisponible. Touchez pour réessayer, ou utilisez la saisie.",
    cam_notstarted: "La caméra n'a pas démarré. Touchez pour réessayer.",
    searching_item: "Recherche de l'article…",
    /* API / session */
    net_get: "Connexion impossible : vérifiez le réseau et réessayez.",
    net_send:
      "Connexion perdue pendant l'envoi : vérifiez le réseau, puis contrôlez l'état de l'article avant de réessayer.",
    session_expired: "Session expirée, reconnectez-vous.",
    error_n: (n) => "Erreur " + n,
    /* modale de confirmation */
    confirm_q: "Confirmer ?",
    confirm: "Confirmer",
    back: "Retour",
    keep: "Garder",
    cancel: "Annuler",
    delete: "Supprimer",
    add: "Ajouter",
    loading: "Chargement…",
    close: "Fermer",
    filter_ph: "Filtrer…",
    back_to_top: "Remonter en haut",
    no_results: "Aucun résultat.",
    no_elements: "Aucun élément.",
    none_f: "— Aucune —",
    none_m: "— Aucun —",
    choose_btn: "— Choisir —",
    /* fiche article + quantité */
    item_crumb: "Article scanné",
    item_n: (pk) => "Article #" + pk,
    item_word: "Article",
    qty_in_stock: "Quantité en stock",
    comment_opt: "Commentaire (facultatif)",
    comment_ph: "ex. recomptage, casse, prêt…",
    save_qty: "Enregistrer la quantité",
    move: "Déplacer",
    add_elsewhere: "Ajouter ailleurs",
    scan_another: "Scanner un autre article",
    qty_invalid: "Quantité invalide.",
    saving: "Enregistrement…",
    stock_updated: "Stock mis à jour",
    stock_saved: "Stock enregistré",
    perm_stock_change: "Droit manquant (rôle Stock : change).",
    item_not_found: "Article introuvable.",
    /* liste de lots / exemplaires */
    choose_copy: (name, n) =>
      (name ? "« " + name + " » " : "Cet article ") +
      "existe en " + n + " exemplaires. Choisissez celui qui vous intéresse :",
    choose_batch: (name) =>
      (name ? "« " + name + " » " : "Cet article ") +
      "se trouve à plusieurs endroits. Choisissez le lot :",
    lot_n: (pk) => "Lot #" + pk,
    no_location: "Sans emplacement",
    out_of_stock_pill: "⚠ Stock épuisé",
    in_stock_suffix: " en stock",
    batch_pill: (b) => "lot " + b,
    st_free: "Disponible",
    st_res: "Réservé",
    st_out: "Emprunté",
    st_late: "En retard",
    /* recherche */
    catalog_loading: "Chargement du catalogue…",
    no_item_found: "Aucun article trouvé.",
    /* emplacements */
    loc_crumb: "Emplacement",
    loc_word: "Emplacement",
    loc_n: (pk) => "Emplacement #" + pk,
    loc_search_ph: "Rechercher une pièce…",
    loc_refuse_title: "On ne peut pas scanner cet emplacement",
    loc_refuse_msg_html: (structural) =>
      "C'est un emplacement " + (structural ? "structurel" : "parent") +
      ". Scannez plutôt un <b>rack</b>, le niveau juste au-dessus des pièces.",
    loc_count_sub: (n) =>
      n + " article" + (n > 1 ? "s" : "") + ", ajustez et validez chaque ligne",
    loc_empty: "Cet emplacement est vide.",
    stock_label: "stock : ",
    /* déplacement */
    move_to: "Déplacer vers…",
    moving: "Déplacement…",
    stock_merged: "Stock fusionné avec le lot existant",
    stock_moved: "Stock déplacé",
    /* QR généré */
    qr_created: "Article créé",
    qr_hint: "QR InvenTree de l'article : imprimez-le et collez-le sur l'objet.",
    qr_data: "Données du code",
    print: "Imprimer",
    done: "Terminé",
    popup_blocked: "Autorisez les pop-ups pour imprimer.",
    /* prêts : carte de statut */
    res_for_you: "pour vous",
    by_who: (who) => "par " + who,
    free_sub: "prêt à être emprunté",
    line_since: "Depuis",
    line_due: "Retour prévu",
    line_comment: "Commentaire",
    line_reason: "Motif",
    date_from: "Du",
    date_to: "Au",
    overdue_by: (n) => "En retard de " + n + (n > 1 ? " jours" : " jour"),
    loan_state_fail: "Impossible de charger l'état d'emprunt.",
    /* prêts : actions */
    confirm_loan: "Confirmer l'emprunt",
    confirm_loan_of: (who) => "Confirmer l'emprunt de " + who,
    borrow: "Emprunter",
    slot_reserved_hint_html: (who) =>
      "Pendant ce créneau, l'emprunt est réservé à <b>" + who + "</b> et aux admins.",
    return_reserved_hint_html: (who) =>
      "Le retour est réservé à <b>" + who + "</b> et aux admins.",
    return_early: "Rendre plus tôt",
    record_return: "Enregistrer le retour",
    record_return_of: (who) => "Enregistrer le retour de " + who,
    /* prêts : réservations */
    res_next_while_out: "Réservé ensuite",
    res_next: "Prochaine réservation",
    tab_status: "Suivi",
    tab_schedule: "Planning",
    tab_history: "Historique",
    cancel_my_resa: "Annuler ma réservation",
    cancel_resa_btn: "Annuler la réservation",
    book: "Réserver",
    book_slot: "Réserver un créneau",
    free_lbl: "Libre",
    free_bar: "libre",
    free_sub2: "empruntable ou réservable",
    lent_dot: (who) => "Emprunté · " + who,
    res_dot: (who) => "Réservé · " + who,
    slots_detail: "Détail des créneaux",
    until_d: (d) => "jusqu'au " + d,
    from_d: (d) => "à partir du " + d,
    due_back_on: (d) => "retour prévu le " + d,
    no_due: "sans échéance",
    /* prêts : historique */
    hist_none: "Aucun emprunt pour cet objet.",
    hist_lent: "Emprunté",
    hist_back: "Rendu",
    hist_late: "Rendu en retard",
    by_lend_html: (b) => "Emprunt enregistré par " + b,
    by_return_html: (b) => "Retour enregistré par " + b,
    see_more: (n) => "Voir plus (" + n + " emprunt" + (n > 1 ? "s" : "") + ")",
    hist_load_fail: "Impossible de charger l'historique.",
    /* prêts : formulaire d'emprunt */
    lend_crumb: "Emprunter l'objet",
    lend_who: "Emprunteur",
    lend_hint_self: "l'emprunt est enregistré à votre nom",
    lend_hint_behalf: (who) => "au nom de " + who + " (vous confirmez sa réservation)",
    lend_info_behalf: (who, range) =>
      "Réservation de " + who + " " + range +
      " : tout est prérempli à partir de sa réservation, vous pouvez modifier si besoin.",
    lend_info_current: (range) =>
      "Réservation en cours " + range +
      " : tout est prérempli à partir de votre réservation, vous pouvez modifier si besoin.",
    lend_info_mine: (range) =>
      "Vous avez réservé " + range +
      " : tout est prérempli à partir de votre réservation, vous pouvez modifier si besoin.",
    lend_warn_admin: (who, range) =>
      "Réservé par " + who + " " + range + ", en tant qu'admin vous pouvez passer outre.",
    lend_warn_limit: (who, range, d) =>
      "Réservé par " + who + " " + range + ", retour au plus tard le " + d + ".",
    for_opt: "Pour (facultatif)",
    for_ph: "asso, club…",
    lend_due: "Retour prévu",
    lend_notes_ph: "ex. pour la soirée de gala, rendu lundi…",
    lend_due_missing: "Indiquez la date de retour prévue.",
    lend_due_past: "La date de retour ne peut pas être avant aujourd'hui.",
    lend_due_max: (d) => "Retour au plus tard le " + d + " (réservation suivante).",
    lending: "Emprunt en cours…",
    loan_saved: "Emprunt enregistré",
    returning: "Retour en cours…",
    return_saved: "Retour enregistré",
    /* prêts : formulaire de réservation */
    resa_crumb: "Réserver l'objet",
    resa_who: "Réservé pour",
    resa_who_hint: "la réservation est enregistrée à votre nom",
    resa_notes_lbl: "Motif (facultatif)",
    resa_notes_ph: "ex. soirée de gala, tournage…",
    resa_confirm: "Confirmer la réservation",
    resa_dates_missing: "Indiquez les dates du créneau.",
    resa_dates_order: "La date de fin est avant la date de début.",
    reserving: "Réservation…",
    resa_saved: "Réservation enregistrée",
    /* prêts : annulation de réservation */
    cancel_my_resa_q: "Annuler votre réservation ?",
    cancel_my_resa_txt: "Elle sera définitivement supprimée.",
    cancel_resa_q: (who) => "Annuler la réservation de " + who + " ?",
    cancel_resa_txt: (who) =>
      "Elle sera définitivement supprimée et " + who + " sera prévenu(e) par e-mail.",
    cancel_reason_lbl: "Motif (obligatoire, envoyé dans l'e-mail)",
    cancel_reason_ph: "ex. objet indisponible, maintenance…",
    resa_cancelled: "Réservation annulée",
    /* création d'article */
    new_item_crumb: "Nouvel article",
    existing_item_crumb: "Article existant",
    create_title_unknown: "Code inconnu : créer l'article",
    create_title: "Créer un article",
    add_stock_title: "Ajouter du stock",
    add_elsewhere_title: "Ajouter à un autre emplacement",
    code_scanned: (c) => "Code scanné : " + c,
    badge_new_loc: "＋ Nouvel emplacement",
    sb_hint_out: (code) => "Ajoutez du stock à un emplacement" + (code ? " · code " + code : ""),
    sb_hint_add: "Ajoutez ce stock à un autre emplacement.",
    np_name_lbl: "Nom de l'article *",
    np_name_ph: "ex. Résistance 10kΩ 1/4W",
    np_img_lbl: "Image (facultatif)",
    prev: "Précédente",
    next: "Suivante",
    img_remove: "Retirer l'image",
    img_pick: "Importer depuis la galerie",
    img_url_ph: "ou coller l'URL d'une image",
    from_gallery: "depuis la galerie",
    np_cat_lbl: "Catégorie",
    np_type_lbl: "Type d'article",
    type_qty: "Stock en quantité",
    type_loan: "Objet à emprunter",
    type_loan_hint:
      "Objet unique suivi par emprunts (Disponible / Emprunté) au lieu d'une quantité.",
    qty_initial: "Quantité initiale *",
    qty_add: "Quantité à ajouter *",
    np_serial_lbl: "N° de série *",
    np_serial_ph: "ex. 1",
    np_serial_hint:
      "Indiquez le numéro de série ou tout autre identifiant permettant de distinguer l'objet.",
    np_loc_lbl: "Emplacement *",
    np_desc_lbl: "Description (facultatif)",
    np_desc_ph: "facultatif, peut rester vide",
    create_link: "Créer et lier au code",
    create_item: "Créer l'article",
    add_one: "Ajouter un exemplaire",
    add_stock: "Ajouter du stock",
    qty_invalid_min: "Quantité invalide (au moins un article en stock).",
    loc_required: "Choisissez un emplacement pour le stock.",
    name_required: "Le nom est obligatoire.",
    serial_required: "Indiquez le numéro de série de l'exemplaire.",
    serial_single: "Un seul numéro de série : les objets se créent un par un.",
    serial_next_fail:
      "Impossible de déterminer le prochain n° de série : ajoutez cet exemplaire depuis InvenTree.",
    adding: "Ajout…",
    creating: "Création…",
    linking: "Liaison…",
    unit_added: "Exemplaire ajouté",
    batch_restocked: "Lot réapprovisionné",
    stock_added: "Stock ajouté",
    stock_added_nolink: "Stock ajouté (code non lié)",
    perm_stock_add: "Votre compte n'a pas le droit d'ajouter du stock (rôle Stock:add requis).",
    perm_create: "Votre compte n'a pas le droit de créer (rôles Part:add et Stock:add requis).",
    link_fail_perm: "Code NON lié : droit « barcode » manquant sur votre compte.",
    link_fail: (msg) => "Code NON lié : " + msg,
    dup_exists: (name) => "Un article « " + name + " » existe déjà dans InvenTree.",
    dup_exists_link: (name) =>
      "Un article « " +
      name +
      " » existe déjà dans InvenTree. Pour lui rattacher le code scanné, utilisez le bouton en bas du formulaire.",
    link_code_to: (name) => "Lier le code à « " + name + " »",
    code_linked: "Code lié à l'article existant",
    loan_obj_qty: (s) => "Objet à emprunter · " + s,
    nothing_created: "Rien n'a été créé. ",
    half_created:
      "L'article a été créé SANS exemplaire : rescannez-le pour ajouter le stock. ",
    item_created_nolink: "Article créé (code non lié)",
    item_added: "Nouvel article ajouté à InvenTree",
    /* Mon compte */
    acct_notif_title: "Vos notifications arrivent sur",
    acct_mail_sub: "Touchez une adresse pour y recevoir rappels d'emprunt, réservations et alertes.",
    acct_mail_hint:
      "Toute nouvelle adresse reçoit un e-mail de confirmation ; elle devient sélectionnable une fois vérifiée.",
    acct_mail_sub_ro: "Adresse actuelle des notifications :",
    acct_mail_hint_ro: "La gestion des adresses n'est pas disponible sur cette instance.",
    acct_no_addr: "Aucune adresse enregistrée",
    acct_add_ph: "Ajouter une adresse…",
    acct_primary: "Reçoit les notifications",
    acct_verified: "Vérifiée",
    acct_blocked: "Déjà utilisée par un autre compte",
    acct_unverified: "À vérifier avant de pouvoir l'utiliser",
    acct_resend: "Renvoyer l'e-mail de confirmation",
    acct_del_title: "Supprimer cette adresse",
    acct_del_q: "Supprimer cette adresse ?",
    acct_del_txt: (mail) => mail + " ne pourra plus servir pour ce compte.",
    acct_bad_addr: "Adresse invalide.",
    acct_lang_title: "Langue",
    acct_lang_lbl: "Langue du compte",
    acct_lang_hint:
      "Utilisée pour la Scannette, le site InvenTree, les e-mails et les notifications. Enregistrée automatiquement.",
    lang_saved: (name) => "Langue enregistrée : " + name + ".",
    acct_back: "Retour au scan",
    /* gestion des utilisateurs (admins) */
    users_title: "Utilisateurs",
    users_sub: "Approuvez les nouvelles demandes et gérez les comptes des membres.",
    users_manage: "Gérer les membres",
    users_pending_t: "En attente d'approbation",
    users_pending_none: "Aucun compte en attente d'approbation.",
    users_pending_hint:
      "Approuver ajoute la personne au groupe des membres : elle peut aussitôt se connecter. Refuser supprime la demande (réinscription possible).",
    users_members_t: "Membres",
    users_search_ph: "Nom, identifiant, e-mail…",
    users_none_match: (q) => "Personne ne correspond à « " + q + " ».",
    users_approve: "Approuver",
    users_refuse: "Refuser",
    users_approved: (n) => n + " peut maintenant se connecter",
    users_refuse_q: (n) => "Refuser le compte de " + n + " ?",
    users_refuse_txt:
      "Le compte sera supprimé : il n'a encore ni accès ni historique. La personne pourra refaire une demande plus tard.",
    users_refused: (n) => "Demande de " + n + " refusée",
    users_email: "E-mail",
    users_group: "Groupe",
    users_admin: "Administrateur",
    users_admin_hint: "gère les utilisateurs, le stock et les réglages",
    users_you: "Vous",
    users_su_hint: "Compte superutilisateur : il se gère depuis InvenTree.",
    users_block: "Bloquer",
    users_blocked: "Bloqué",
    users_block_btn: "Bloquer le compte",
    users_unblock_btn: "Débloquer le compte",
    users_block_q: (n) => "Bloquer le compte de " + n + " ?",
    users_block_txt:
      "Cette personne ne pourra plus se connecter à l'inventaire ni à la Scannette. Ses emprunts et son historique restent enregistrés, et le blocage est réversible.",
    users_block_ok: (n) => "Compte de " + n + " bloqué",
    users_react_ok: (n) => n + " peut de nouveau se connecter",
    users_admin_on: (n) => n + " a maintenant les droits d'administration",
    users_admin_off: (n) => n + " n'a plus les droits d'administration",
    users_self_block: "Impossible de bloquer votre propre compte.",
    users_self_admin: "Impossible de retirer vos propres droits d'administration.",
    users_no_group: "Aucun groupe de membres sur cette instance.",
    /* footer */
    footer_sig: "Une solution EirSpace conçue par Aamir ASMAL 🚀",
  },

  /* ---------------------------------------------------------------- EN --- */
  en: {
    /* topbar + login */
    brand_sub: "Inventory",
    brand_sub_login: "Inventory · Scannette",
    acct_title: "My account",
    theme: "Theme",
    logout: "Log out",
    login_title: "Sign in with InvenTree",
    login_user: "Username",
    login_user_ph: "username",
    login_pass: "Password",
    login_btn: "Sign in",
    login_or: "or",
    login_eirb: "Sign in with EirbConnect",
    login_missing: "Enter your username and password.",
    login_unexpected: "Unexpected server response.",
    login_bad: "Incorrect username or password.",
    login_connecting: "Signing in…",
    logout_btn: "Log out",
    /* pending-approval screen */
    pending_title: "Account awaiting approval",
    pending_p1: "Your account is awaiting approval.",
    pending_p2: "Contact an admin if this persists.",
    retry: "Try again",
    /* scan screen */
    scan_title: "Inventory",
    mode_scan: "Scan",
    mode_search: "Search",
    search_ph: "Name, reference… (e.g. eth)",
    clear: "Clear",
    scan_warn_html: "Several codes: aim at just <b>one</b> code inside the square",
    cam_enable: "Turn on the camera",
    or_type_code: "or type the code",
    manual_ph: "Barcode / QR…",
    create_nocode: "Create an item without a code",
    cam_https: "The camera needs HTTPS (open the page over https://…).",
    cam_noreader: "Camera reader not loaded.",
    cam_tap: "Tap to turn on the camera.",
    cam_denied: "Camera access denied: allow the camera for this site, then tap below.",
    cam_unavail: "Camera unavailable. Tap to retry, or type the code.",
    cam_notstarted: "The camera didn't start. Tap to retry.",
    searching_item: "Looking up the item…",
    /* API / session */
    net_get: "Can't reach the server: check your connection and try again.",
    net_send:
      "Connection lost while sending: check your network, then verify the item's state before trying again.",
    session_expired: "Session expired — please sign in again.",
    error_n: (n) => "Error " + n,
    /* confirmation modal */
    confirm_q: "Confirm?",
    confirm: "Confirm",
    back: "Back",
    keep: "Keep",
    cancel: "Cancel",
    delete: "Delete",
    add: "Add",
    loading: "Loading…",
    close: "Close",
    filter_ph: "Filter…",
    back_to_top: "Back to top",
    no_results: "No results.",
    no_elements: "Nothing here.",
    none_f: "— None —",
    none_m: "— None —",
    choose_btn: "— Choose —",
    /* item view + quantity */
    item_crumb: "Scanned item",
    item_n: (pk) => "Item #" + pk,
    item_word: "Item",
    qty_in_stock: "Quantity in stock",
    comment_opt: "Comment (optional)",
    comment_ph: "e.g. recount, breakage, loan…",
    save_qty: "Save quantity",
    move: "Move",
    add_elsewhere: "Add elsewhere",
    scan_another: "Scan another item",
    qty_invalid: "Invalid quantity.",
    saving: "Saving…",
    stock_updated: "Stock updated",
    stock_saved: "Stock saved",
    perm_stock_change: "Missing permission (Stock: change role).",
    item_not_found: "Item not found.",
    /* batch / unit chooser */
    choose_copy: (name, n) =>
      (name ? "“" + name + "” comes" : "This item comes") +
      " in " + n + " units. Choose the one you want:",
    choose_batch: (name) =>
      (name ? "“" + name + "” " : "This item ") +
      "is stored in several places. Choose the batch:",
    lot_n: (pk) => "Batch #" + pk,
    no_location: "No location",
    out_of_stock_pill: "⚠ Out of stock",
    in_stock_suffix: " in stock",
    batch_pill: (b) => "batch " + b,
    st_free: "Available",
    st_res: "Reserved",
    st_out: "On loan",
    st_late: "Overdue",
    /* search */
    catalog_loading: "Loading the catalogue…",
    no_item_found: "No items found.",
    /* locations */
    loc_crumb: "Location",
    loc_word: "Location",
    loc_n: (pk) => "Location #" + pk,
    loc_search_ph: "Search for a part…",
    loc_refuse_title: "This location can't be scanned",
    loc_refuse_msg_html: (structural) =>
      "It's a " + (structural ? "structural" : "parent") +
      " location. Scan a <b>rack</b> instead — the level just above the parts.",
    loc_count_sub: (n) =>
      n + " item" + (n > 1 ? "s" : "") + " — adjust and save each line",
    loc_empty: "This location is empty.",
    stock_label: "stock: ",
    /* stock move */
    move_to: "Move to…",
    moving: "Moving…",
    stock_merged: "Stock merged into the existing batch",
    stock_moved: "Stock moved",
    /* generated QR */
    qr_created: "Item created",
    qr_hint: "The item's InvenTree QR code: print it and stick it on the object.",
    qr_data: "Code contents",
    print: "Print",
    done: "Done",
    popup_blocked: "Allow pop-ups to print.",
    /* loans: status card */
    res_for_you: "for you",
    by_who: (who) => "by " + who,
    free_sub: "ready to be borrowed",
    line_since: "Since",
    line_due: "Due back",
    line_comment: "Comment",
    line_reason: "Reason",
    date_from: "From",
    date_to: "To",
    overdue_by: (n) => "Overdue by " + n + (n > 1 ? " days" : " day"),
    loan_state_fail: "Couldn't load the loan status.",
    /* loans: actions */
    confirm_loan: "Confirm loan",
    confirm_loan_of: (who) => "Confirm " + who + "'s loan",
    borrow: "Borrow",
    slot_reserved_hint_html: (who) =>
      "During this slot, only <b>" + who + "</b> and admins can borrow it.",
    return_reserved_hint_html: (who) =>
      "Only <b>" + who + "</b> and admins can record the return.",
    return_early: "Return early",
    record_return: "Record the return",
    record_return_of: (who) => "Record " + who + "'s return",
    /* loans: reservations */
    res_next_while_out: "Reserved next",
    res_next: "Next reservation",
    tab_status: "Status",
    tab_schedule: "Schedule",
    tab_history: "History",
    cancel_my_resa: "Cancel my reservation",
    cancel_resa_btn: "Cancel the reservation",
    book: "Reserve",
    book_slot: "Reserve a slot",
    free_lbl: "Free",
    free_bar: "free",
    free_sub2: "available to borrow or reserve",
    lent_dot: (who) => "On loan · " + who,
    res_dot: (who) => "Reserved · " + who,
    slots_detail: "Slot details",
    until_d: (d) => "until " + d,
    from_d: (d) => "from " + d,
    due_back_on: (d) => "due back " + d,
    no_due: "no due date",
    /* loans: history */
    hist_none: "No loans for this item yet.",
    hist_lent: "Borrowed",
    hist_back: "Returned",
    hist_late: "Returned late",
    by_lend_html: (b) => "Loan recorded by " + b,
    by_return_html: (b) => "Return recorded by " + b,
    see_more: (n) => "Show more (" + n + " loan" + (n > 1 ? "s" : "") + ")",
    hist_load_fail: "Couldn't load the history.",
    /* loans: borrow form */
    lend_crumb: "Borrow this item",
    lend_who: "Borrower",
    lend_hint_self: "the loan is recorded in your name",
    lend_hint_behalf: (who) => "on behalf of " + who + " (you're confirming their reservation)",
    lend_info_behalf: (who, range) =>
      "Reservation for " + who + " (" + range +
      "): everything is pre-filled from it — adjust if needed.",
    lend_info_current: (range) =>
      "Your reservation is under way (" + range +
      "): everything is pre-filled from it — adjust if needed.",
    lend_info_mine: (range) =>
      "You have a reservation for " + range +
      ": everything is pre-filled from it — adjust if needed.",
    lend_warn_admin: (who, range) =>
      "Reserved by " + who + " (" + range + ") — as an admin you can override.",
    lend_warn_limit: (who, range, d) =>
      "Reserved by " + who + " (" + range + ") — return it by " + d + " at the latest.",
    for_opt: "For (optional)",
    for_ph: "club, society…",
    lend_due: "Due back",
    lend_notes_ph: "e.g. for the gala night, back on Monday…",
    lend_due_missing: "Enter the expected return date.",
    lend_due_past: "The return date can't be before today.",
    lend_due_max: (d) => "Return by " + d + " at the latest (next reservation).",
    lending: "Borrowing…",
    loan_saved: "Loan recorded",
    returning: "Recording the return…",
    return_saved: "Return recorded",
    /* loans: reservation form */
    resa_crumb: "Reserve this item",
    resa_who: "Reserved for",
    resa_who_hint: "the reservation is recorded in your name",
    resa_notes_lbl: "Reason (optional)",
    resa_notes_ph: "e.g. gala night, video shoot…",
    resa_confirm: "Confirm reservation",
    resa_dates_missing: "Enter the slot dates.",
    resa_dates_order: "The end date is before the start date.",
    reserving: "Reserving…",
    resa_saved: "Reservation recorded",
    /* loans: reservation cancelling */
    cancel_my_resa_q: "Cancel your reservation?",
    cancel_my_resa_txt: "It will be permanently deleted.",
    cancel_resa_q: (who) => "Cancel " + who + "'s reservation?",
    cancel_resa_txt: (who) =>
      "It will be permanently deleted and " + who + " will be notified by email.",
    cancel_reason_lbl: "Reason (required, sent in the email)",
    cancel_reason_ph: "e.g. item unavailable, maintenance…",
    resa_cancelled: "Reservation cancelled",
    /* item creation */
    new_item_crumb: "New item",
    existing_item_crumb: "Existing item",
    create_title_unknown: "Unknown code: create the item",
    create_title: "Create an item",
    add_stock_title: "Add stock",
    add_elsewhere_title: "Add to another location",
    code_scanned: (c) => "Scanned code: " + c,
    badge_new_loc: "＋ New location",
    sb_hint_out: (code) => "Add stock to a location" + (code ? " · code " + code : ""),
    sb_hint_add: "Add this stock to another location.",
    np_name_lbl: "Item name *",
    np_name_ph: "e.g. 10kΩ 1/4W resistor",
    np_img_lbl: "Image (optional)",
    prev: "Previous",
    next: "Next",
    img_remove: "Remove the image",
    img_pick: "Choose from the gallery",
    img_url_ph: "or paste an image URL",
    from_gallery: "from the gallery",
    np_cat_lbl: "Category",
    np_type_lbl: "Item type",
    type_qty: "Stock by quantity",
    type_loan: "Loanable item",
    type_loan_hint:
      "A unique item tracked through loans (Available / On loan) instead of a quantity.",
    qty_initial: "Initial quantity *",
    qty_add: "Quantity to add *",
    np_serial_lbl: "Serial no. *",
    np_serial_ph: "e.g. 1",
    np_serial_hint:
      "Enter the serial number or any identifier that tells this unit apart.",
    np_loc_lbl: "Location *",
    np_desc_lbl: "Description (optional)",
    np_desc_ph: "optional, can stay empty",
    create_link: "Create and link to the code",
    create_item: "Create the item",
    add_one: "Add a unit",
    add_stock: "Add stock",
    qty_invalid_min: "Invalid quantity (at least one in stock).",
    loc_required: "Choose a location for the stock.",
    name_required: "The name is required.",
    serial_required: "Enter the unit's serial number.",
    serial_single: "One serial number only: items are created one at a time.",
    serial_next_fail:
      "Couldn't work out the next serial number: add this unit from InvenTree.",
    adding: "Adding…",
    creating: "Creating…",
    linking: "Linking…",
    unit_added: "Unit added",
    batch_restocked: "Batch restocked",
    stock_added: "Stock added",
    stock_added_nolink: "Stock added (code not linked)",
    perm_stock_add: "Your account can't add stock (Stock:add role required).",
    perm_create: "Your account can't create items (Part:add and Stock:add roles required).",
    link_fail_perm: "Code NOT linked: your account is missing the “barcode” permission.",
    link_fail: (msg) => "Code NOT linked: " + msg,
    dup_exists: (name) => "An item “" + name + "” already exists in InvenTree.",
    dup_exists_link: (name) =>
      "An item “" +
      name +
      "” already exists in InvenTree. To attach the scanned code to it, use the button at the bottom of the form.",
    link_code_to: (name) => "Link the code to “" + name + "”",
    code_linked: "Code linked to the existing item",
    loan_obj_qty: (s) => "Loanable item · " + s,
    nothing_created: "Nothing was created. ",
    half_created:
      "The item was created WITHOUT a unit: rescan it to add the stock. ",
    item_created_nolink: "Item created (code not linked)",
    item_added: "New item added to InvenTree",
    /* My account */
    acct_notif_title: "Your notifications go to",
    acct_mail_sub: "Tap an address to receive loan reminders, reservations and alerts there.",
    acct_mail_hint:
      "Every new address gets a confirmation email; it becomes selectable once verified.",
    acct_mail_sub_ro: "Current notification address:",
    acct_mail_hint_ro: "Address management isn't available on this instance.",
    acct_no_addr: "No address on file",
    acct_add_ph: "Add an address…",
    acct_primary: "Receives notifications",
    acct_verified: "Verified",
    acct_blocked: "Already used by another account",
    acct_unverified: "Verify it before you can use it",
    acct_resend: "Resend the confirmation email",
    acct_del_title: "Delete this address",
    acct_del_q: "Delete this address?",
    acct_del_txt: (mail) => mail + " will no longer be usable with this account.",
    acct_bad_addr: "Invalid address.",
    acct_lang_title: "Language",
    acct_lang_lbl: "Account language",
    acct_lang_hint:
      "Used for the Scannette, the InvenTree site, emails and notifications. Saved automatically.",
    lang_saved: (name) => "Language saved: " + name + ".",
    acct_back: "Back to scanning",
    /* user management (admins) */
    users_title: "Users",
    users_sub: "Approve new requests and manage member accounts.",
    users_manage: "Manage members",
    users_pending_t: "Awaiting approval",
    users_pending_none: "No account awaiting approval.",
    users_pending_hint:
      "Approving adds the person to the members group: they can sign in right away. Refusing deletes the request (they can sign up again).",
    users_members_t: "Members",
    users_search_ph: "Name, username, email…",
    users_none_match: (q) => "No one matches “" + q + "”.",
    users_approve: "Approve",
    users_refuse: "Refuse",
    users_approved: (n) => n + " can now sign in",
    users_refuse_q: (n) => "Refuse " + n + "'s account?",
    users_refuse_txt:
      "The account will be deleted: it has no access and no history yet. The person can sign up again later.",
    users_refused: (n) => "Request from " + n + " refused",
    users_email: "Email",
    users_group: "Group",
    users_admin: "Administrator",
    users_admin_hint: "manages users, stock and settings",
    users_you: "You",
    users_su_hint: "Superuser account: it is managed from InvenTree.",
    users_block: "Block",
    users_blocked: "Blocked",
    users_block_btn: "Block account",
    users_unblock_btn: "Unblock account",
    users_block_q: (n) => "Block " + n + "'s account?",
    users_block_txt:
      "They will no longer be able to sign in to the inventory or the Scannette. Their loans and history remain on record, and blocking is reversible.",
    users_block_ok: (n) => n + "'s account blocked",
    users_react_ok: (n) => n + " can sign in again",
    users_admin_on: (n) => n + " now has administrator rights",
    users_admin_off: (n) => n + " no longer has administrator rights",
    users_self_block: "You can't block your own account.",
    users_self_admin: "You can't remove your own administrator rights.",
    users_no_group: "No members group on this instance.",
    /* footer */
    footer_sig: "An EirSpace solution designed by Aamir ASMAL 🚀",
  },
};

/* fr -> fr, en -> en, toute autre langue -> en (repli), vide -> "" (défaut) */
function normLang(l) {
  l = String(l || "").toLowerCase().split("-")[0];
  if (!l) return "";
  return l === "fr" ? "fr" : "en";
}

let LANG = normLang(getCookie("eir_lang")) || normLang(navigator.language) || DEFAULT_LANG;

/* t("clé", args...) : chaîne traduite (les valeurs-fonctions reçoivent args) */
function t(key) {
  const d = I18N[LANG] || I18N[DEFAULT_LANG];
  let v = d[key];
  if (v === undefined) v = I18N[DEFAULT_LANG][key];
  if (v === undefined) return key; // clé manquante : on affiche la clé plutôt que rien
  return typeof v === "function" ? v.apply(null, Array.prototype.slice.call(arguments, 1)) : v;
}

/* applique la langue courante aux textes statiques (index.html) */
function applyI18nDom(root) {
  document.documentElement.lang = LANG;
  const r = root || document;
  r.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  r.querySelectorAll("[data-i18n-html]").forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml)));
  r.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  r.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  r.querySelectorAll("[data-i18n-aria]").forEach((el) =>
    el.setAttribute("aria-label", t(el.dataset.i18nAria)),
  );
}

/* change la langue courante (et la mémorise pour l'écran de login) */
function setLang(l, persist) {
  l = normLang(l) || DEFAULT_LANG;
  if (persist) setCookie("eir_lang", l, 365);
  if (l !== LANG) {
    LANG = l;
    applyI18nDom();
  }
}

/* après connexion : la langue du profil InvenTree fait foi (« défaut » = instance) */
async function syncUserLang() {
  try {
    const me = await api("/api/user/me/");
    setLang((me && me.profile && me.profile.language) || DEFAULT_LANG, true);
  } catch (_) {} // hors ligne / token mort : on garde la langue mémorisée
}

applyI18nDom(); // langue mémorisée appliquée dès le chargement (écran de login)
