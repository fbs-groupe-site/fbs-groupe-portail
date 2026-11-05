"use strict";

(() => {
  const config = window.FBS_SUPABASE_CONFIG;
  const view = document.getElementById("view");
  const modalRoot = document.getElementById("modal-root");
  const accountButton = document.getElementById("account-button");
  const navigation = document.getElementById("navigation");
  const supabaseLib = window.supabase;
  const state = {
    client: null,
    user: null,
    profile: null,
    view: "catalog",
    courses: [],
    sessions: [],
    enrollments: [],
    payments: [],
    documents: [],
    history: [],
    resources: [],
    announcements: [],
    filters: { search: "", status: "", course: "", dateFrom: "", dateTo: "" },
    category: "Toutes les formations",
    selectedCourse: "",
    selectedEnrollment: "",
    selectedBadges: new Set()
  };
  const statuses = ["Brouillon", "En attente", "Pièces à compléter", "Paiement à vérifier", "Inscrit", "Refusé", "Formation terminée", "Archivé"];
  const contactNumbers = ["+224 623 85 41 35", "+224 621 74 41 76", "+224 623 14 21 45"];

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function repairFrenchText(value) {
    const replacements = new Map([
      [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
      [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
      [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
      [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
      [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
      [0x017e, 0x9e], [0x0178, 0x9f]
    ]);
    let text = String(value ?? "");
    const brokenSequence = /(?:[ÃÂ][-ÿ€])+/g;
    for (let attempt = 0; attempt < 2 && /[ÃÂ]/.test(text); attempt += 1) {
      text = text.replace(brokenSequence, (sequence) => {
        try {
          const bytes = Array.from(sequence, (character) => {
            const code = character.codePointAt(0);
            return code <= 0xff ? code : replacements.get(code);
          });
          return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
        } catch {
          return sequence;
        }
      });
    }
    return text.replace(/â€™/g, "’").replace(/â€œ/g, "“").replace(/â€�/g, "”");
  }
  function currency(value) {
    return value == null ? "À confirmer" : `${Number(value).toLocaleString("fr-FR")} GNF`;
  }

  function dateLabel(value) {
    if (!value) return "Non défini";
    return new Date(`${value}T00:00:00`).toLocaleDateString("fr-GN", { dateStyle: "long" });
  }

  function toast(message, isError = false) {
    const region = document.getElementById("toast-region");
    const element = document.createElement("div");
    element.className = `toast${isError ? " toast--error" : ""}`;
    element.textContent = message;
    region.append(element);
    window.setTimeout(() => element.remove(), 5000);
  }

  function unwrap(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  function errorText(error) {
    return error?.message || "Une erreur inattendue est survenue. Réessayez ou contactez le centre.";
  }

  function showModal(title, subtitle, body, wide = false) {
    modalRoot.innerHTML = `<div class="modal-backdrop" data-action="backdrop-close">
      <section class="modal${wide ? " modal--wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal__head"><div><h2 id="modal-title">${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div>
          <button class="modal__close" type="button" aria-label="Fermer" data-action="close-modal">×</button></div>
        ${body}
      </section>
    </div>`;
  }

  function closeModal() {
    modalRoot.innerHTML = "";
  }

  function roleName(role) {
    return ({ student: "Étudiant", staff: "Personnel", admin: "Administrateur" })[role] || "Visiteur";
  }

  function isStaff() {
    return ["staff", "admin"].includes(state.profile?.role);
  }

  function isAdmin() {
    return state.profile?.role === "admin";
  }

  async function logActivity(action) {
    if (!state.user) return;
    unwrap(await state.client.from("activity_log").insert({ action, actor_id: state.user.id }));
  }

  async function createNotification(templateId, studentId, enrollmentId, variables = {}) {
    const template = unwrap(await state.client.from("notification_templates").select("*").eq("id", templateId).single());
    const templateBody = repairFrenchText(template.body);
    let message = templateBody.replace(/\{\{([a-z_]+)\}\}/gi, (_match, key) => String(variables[key] ?? ""));
    if (templateId === "paiement_valide" && (!variables.recu || variables.recu === "en préparation")) {
      message = `Votre paiement de ${repairFrenchText(variables.montant)} a été validé. Votre reçu sera disponible dans votre espace.`;
    }
    message = message.replace(/Le reçu disponible dans votre espace est disponible dans votre espace\.?/gi, "Votre reçu est disponible dans votre espace.");
    return unwrap(await state.client.from("notifications").insert({
      student_id: studentId, enrollment_id: enrollmentId || null, template_id: template.id,
      event_type: repairFrenchText(template.name), channel: repairFrenchText(template.channel), message: repairFrenchText(message),
      delivery_status: template.enabled ? "Fournisseur e-mail/SMS à configurer" : "Désactivée par le centre",
      created_by: state.user.id
    }));
  }

  function renderNavigation() {
    const links = [{ id: "catalog", label: "Catalogue", icon: "⌂" }];
    if (state.user && state.profile?.role === "student") {
      links.push({ id: "student", label: "Mon espace", icon: "◉" });
    }
    if (isStaff()) {
      links.push({ id: "staff", label: "Gestion des dossiers", icon: "▣" });
      links.push({ id: "courses", label: "Formations et annonces", icon: "▤" });
    }
    if (isAdmin()) links.push({ id: "admin", label: "Administration", icon: "⚙" });
    navigation.innerHTML = `<div class="nav-list">${links.map((link) =>
      `<a class="nav-link${state.view === link.id ? " nav-link--active" : ""}" href="#${link.id}" data-action="navigate" data-view="${link.id}">
        <span class="nav-icon" aria-hidden="true">${link.icon}</span>${link.label}</a>`
    ).join("")}</div>`;
    accountButton.textContent = state.user ? "Mon compte" : "Connexion";
    document.getElementById("current-year").textContent = new Date().getFullYear();
  }

  function heading(title, description, action = "") {
    return `<div class="page-heading"><div><div class="eyebrow">FBS GROUPE · KANKAN</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action ? `<div class="heading-actions">${action}</div>` : ""}</div>`;
  }

  function notice(message, type = "blue") {
    const icon = type === "red" ? "!" : type === "green" ? "✓" : "i";
    return `<div class="notice notice--${type}"><span class="notice__icon" aria-hidden="true">${icon}</span><span>${message}</span></div>`;
  }

  function openAuthModal(mode = "login") {
    const signup = mode === "signup";
    const body = `<div class="role-options">
      <button class="role-option" type="button" data-action="auth-mode" data-mode="login"><span class="role-option__icon">↪</span><span><strong>Se connecter</strong><small>Accédez à votre espace sécurisé.</small></span></button>
      <button class="role-option" type="button" data-action="auth-mode" data-mode="signup"><span class="role-option__icon">＋</span><span><strong>Créer un compte étudiant</strong><small>Inscrivez-vous avec une adresse e-mail personnelle.</small></span></button>
    </div>
    <form data-form="${signup ? "signup" : "login"}" class="section-card">
      ${signup ? `<div class="form-grid">
        <div class="field"><label for="auth-first-name">Prénom <span class="required">*</span></label><input id="auth-first-name" class="input" name="first_name" autocomplete="given-name" required></div>
        <div class="field"><label for="auth-last-name">Nom <span class="required">*</span></label><input id="auth-last-name" class="input" name="last_name" autocomplete="family-name" required></div>
        <div class="field field--wide"><label for="auth-phone">Téléphone <span class="required">*</span></label><input id="auth-phone" class="input" name="phone" type="tel" autocomplete="tel" required></div>
      </div>` : ""}
      <div class="field"><label for="auth-email">Adresse e-mail <span class="required">*</span></label><input id="auth-email" class="input" name="email" type="email" autocomplete="email" required></div>
      <div class="field" style="margin-top:12px"><label for="auth-password">Mot de passe <span class="required">*</span></label><input id="auth-password" class="input" name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="8" required></div>
      ${signup ? `<p class="field-help">Au moins 8 caractères. Une vérification par e-mail peut être demandée selon les paramètres du centre.</p>` : `<button class="text-button" type="button" data-action="reset-password" style="margin-top:10px">Mot de passe oublié ?</button>`}
      <div class="form-actions"><button class="button button--primary" type="submit">${signup ? "Créer mon compte" : "Se connecter"}</button></div>
    </form>`;
    showModal(signup ? "Créer un compte étudiant" : "Connexion", "L’accès au dossier est protégé par l’authentification Supabase.", body);
  }

  function renderCatalog() {
    const categories = ["Toutes les formations", ...new Set(state.courses.map((course) => course.category))];
    const visible = state.courses.filter((course) => state.category === "Toutes les formations" || course.category === state.category);
    view.innerHTML = `${heading("Découvrez nos formations", "Choisissez votre parcours. Les tarifs ou durées non confirmés sont affichés comme tels et peuvent être mis à jour par le personnel.")}
      <section class="hero"><div class="hero__copy"><div class="hero__brand"><img src="IMAGES/Logo.png" alt="Logo FBS GROUPE"><span>Centre de formation · Kankan</span></div><h1>Faites grandir vos compétences avec FBS GROUPE</h1>
      <p>Un accompagnement professionnel en bureautique, informatique, comptabilité, anglais et développement personnel.</p>
      <div class="hero__actions"><button type="button" class="button button--primary" data-action="scroll-catalog">Voir les formations</button><button type="button" class="button hero__secondary" data-action="account">S’inscrire</button><a class="button hero__tertiary" href="mailto:fbsgroupsarlu@gmail.com">Contacter le centre</a></div>
      </div><div class="hero__visual"><img src="IMAGES/FBS2.jpeg" alt="Espace de travail informatique"><div class="hero__image-caption">Kankan, Guinée · Entre l’UJNK et l’Hôtel Buffet de la Gare</div></div></section>
      <div class="trust-row"><div class="trust-card"><span class="trust-card__icon">✓</span><div><strong>Inscription suivie</strong><small>Suivez chaque étape de votre dossier.</small></div></div>
      <div class="trust-card"><span class="trust-card__icon">₲</span><div><strong>Paiements enregistrés au centre</strong><small>Aucun paiement en ligne n’est activé.</small></div></div>
      <div class="trust-card"><span class="trust-card__icon">▣</span><div><strong>Documents sécurisés</strong><small>Accès réservé à votre compte.</small></div></div></div>
      ${notice("Les paiements sont saisis et vérifiés par le personnel. Aucun prestataire de paiement en ligne n’est connecté. Les frais d’inscription et de badge (20 000 GNF) et l’échéancier 50/50 ne sont pas appliqués sans confirmation du centre.", "blue")}
      <div id="catalog-list" class="section-heading"><div><h2>Catalogue des formations</h2><p>${state.courses.length} formation(s) disponible(s)</p></div></div>
      <div class="category-row">${categories.map((category) => `<button class="chip${state.category === category ? " chip--active" : ""}" type="button" data-action="category" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("")}</div>
      <div class="course-grid">${visible.length ? visible.map((course) => `<article class="course-card">
        <div class="course-card__top"><span class="course-icon" aria-hidden="true">▤</span><span class="course-category">${escapeHtml(course.category)}</span></div>
        <h3>${escapeHtml(course.name)}</h3><p class="course-card__description">${escapeHtml(course.description || "Informations à confirmer auprès du centre.")}</p>
        ${course.prerequisites ? `<p class="course-card__description"><strong>Prérequis :</strong> ${escapeHtml(course.prerequisites)}</p>` : ""}
        <div class="course-card__meta"><span class="course-card__price">${currency(course.price)}</span><span class="course-card__duration">${escapeHtml(course.duration || "Durée à confirmer")}</span></div>
        <div class="course-card__footer"><span class="muted-label">${course.fee_confirmed ? `Frais : ${currency(course.registration_fee)}` : "Frais à confirmer"}</span><button class="button button--primary button--small" type="button" data-action="start-enrollment" data-course="${escapeHtml(course.id)}">S’inscrire</button></div>
      </article>`).join("") : `<div class="card">${state.courses.length ? "Aucune formation dans cette catégorie." : "Le catalogue est indisponible pour le moment."}</div>`}</div>
      <div class="section-heading"><div><h2>Conditions d’inscription</h2><p>Les conditions complètes sont présentées avant l’envoi de votre demande.</p></div></div>
      <div class="about-cards"><article class="condition-card"><h3>Étapes du dossier</h3><p>Créez un compte, choisissez une formation, complétez vos coordonnées et joignez une photo d’identité ainsi que les pièces requises.</p></article>
      <article class="condition-card"><h3>Paiement et non-remboursement</h3><p>Les paiements sont enregistrés par le centre. La règle applicable, les frais confirmés et les conditions de non-remboursement sont affichés pour acceptation avant l’envoi.</p></article></div>`;
  }

  async function loadCourses() {
    state.courses = unwrap(await state.client.from("courses").select("*").eq("active", true).eq("archived", false).order("category").order("name"));
  }

  function nextStepFor(status) {
    if (status === "Inscrit") return ["Votre inscription est confirmée", "Le personnel a validé votre dossier. Consultez vos documents et les annonces du centre."];
    if (status === "Pièces à compléter") return ["Complétez votre dossier", "Consultez les demandes de correction du personnel et ajoutez les pièces manquantes."];
    if (status === "Paiement à vérifier") return ["Paiement en cours de vérification", "Le personnel vérifiera le paiement enregistré avant de valider votre inscription."];
    if (status === "Refusé") return ["Consultez le centre", "Votre demande a été refusée. Contactez FBS GROUPE pour obtenir des précisions."];
    if (status === "Formation terminée") return ["Formation terminée", "Consultez vos attestations et les documents disponibles."];
    return ["Dossier en attente de vérification", "Le personnel examinera vos pièces et vous informera de la prochaine étape."];
  }

  async function renderStudent() {
    if (!state.user) {
      view.innerHTML = `${heading("Espace étudiant", "Connectez-vous pour consulter vos dossiers, paiements et documents.")}<div class="login-panel"><div class="card"><h2>Accès étudiant</h2><p>Les dossiers ne sont accessibles qu’au compte de l’étudiant concerné.</p><button class="button button--primary" data-action="account" type="button">Se connecter</button></div></div>`;
      return;
    }
    const [enrollments, documents, resources, announcements, notifications, payments] = await Promise.all([
      state.client.from("enrollments").select("*, courses(name,category,price), sessions(name,starts_at,ends_at,schedule)").eq("student_id", state.user.id).order("created_at", { ascending: false }),
      state.client.from("documents").select("*").eq("student_id", state.user.id).eq("visible_to_student", true).order("created_at", { ascending: false }),
      state.client.from("resources").select("*").order("created_at", { ascending: false }),
      state.client.from("announcements").select("*").eq("published", true).order("created_at", { ascending: false }),
      state.client.from("notifications").select("*").eq("student_id", state.user.id).order("created_at", { ascending: false }),
      state.client.from("payments").select("*").eq("student_id", state.user.id).order("paid_at", { ascending: false })
    ]);
    state.enrollments = unwrap(enrollments);
    state.documents = unwrap(documents);
    state.resources = unwrap(resources);
    state.announcements = unwrap(announcements);
    state.notifications = unwrap(notifications);
    state.payments = unwrap(payments);
    const current = state.enrollments[0];
    const [nextTitle, nextDescription] = nextStepFor(current?.status || "En attente");
    const validPayments = state.payments.filter((payment) =>
      payment.enrollment_id === current?.id && payment.status === "Validé"
    );
    const paidTotal = validPayments.reduce((sum, payment) => sum + payment.amount, 0);
    const totalDue = current?.course_price == null ? null : current.course_price + (current.registration_fee_confirmed ? current.registration_fee : 0);
    const balance = totalDue == null ? null : Math.max(0, totalDue - paidTotal);
    const course = current?.courses;
    view.innerHTML = `${heading(`Bonjour ${state.profile?.first_name || "étudiant"}`, "Votre espace personnel, accessible uniquement depuis votre compte.")}
      <div class="dashboard-grid"><section class="card"><div class="card__heading"><div><h2>Prochaine étape</h2><p>Votre suivi d’inscription</p></div><span class="pill">${escapeHtml(current?.status || "Aucune demande")}</span></div>
      <div class="next-step"><span class="next-step__number">1</span><div><strong>${escapeHtml(nextTitle)}</strong><p>${escapeHtml(nextDescription)}</p></div></div>
      ${current ? `<div class="balance-list" style="margin-top:18px"><div class="balance-row"><span>Formation</span><strong>${escapeHtml(course?.name || "Formation")}</strong></div>
      <div class="balance-row"><span>Session</span><strong>${escapeHtml(current.sessions?.name || "À définir")}</strong></div>
      <div class="balance-row"><span>Dates / horaires</span><strong>${escapeHtml(current.sessions?.starts_at ? `${dateLabel(current.sessions.starts_at)} · ${current.sessions.schedule || "Horaires à définir"}` : "À définir")}</strong></div>
      <div class="balance-row"><span>Prix de formation</span><strong>${currency(current.course_price)}</strong></div>
      <div class="balance-row"><span>Frais inscription et badge</span><strong>${current.registration_fee_confirmed ? currency(current.registration_fee) : "Non confirmés — non appliqués"}</strong></div>
      <div class="balance-row"><span>Total des paiements validés</span><strong>${currency(paidTotal)}</strong></div>
      <div class="balance-row balance-total"><span>Solde</span><strong>${currency(balance)}</strong></div>
      <div class="balance-row"><span>N° d’inscription</span><strong>${escapeHtml(current.enrollment_number)}</strong></div></div>` : `<p>Vous n’avez pas encore de demande d’inscription.</p><button class="button button--primary" data-action="navigate" data-view="catalog" type="button">Choisir une formation</button>`}
      <div class="form-actions"><button class="button" type="button" data-action="edit-profile">Modifier mon profil</button></div></section>
      <section class="card"><div class="card__heading"><div><h2>Accès rapides</h2><p>Vos informations et documents</p></div></div>
      <div class="shortcut-grid"><button class="shortcut" data-action="scroll-to" data-target="student-payments"><span class="shortcut__icon">₲</span>Mes reçus et paiements</button>
      <button class="shortcut" data-action="scroll-to" data-target="student-documents"><span class="shortcut__icon">▣</span>Mes attestations</button>
      <button class="shortcut" data-action="scroll-to" data-target="student-resources"><span class="shortcut__icon">▤</span>Mes ressources</button>
      <button class="shortcut" data-action="scroll-to" data-target="student-announcements"><span class="shortcut__icon">◉</span>Mes annonces</button></div>
      <div style="margin-top:16px">${notice("Notifications par e-mail et SMS non activées : les fournisseurs restent à configurer. L’état de chaque notification est consultable ci-dessous.", "blue")}</div></section></div>
      <section class="card section-card" id="student-payments"><div class="card__heading"><div><h2>Mes paiements et reçus</h2><p>Seuls les paiements validés sont comptés dans votre solde.</p></div></div>
      ${state.payments.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Montant</th><th>Mode</th><th>État</th><th>Reçu</th></tr></thead><tbody>${state.payments.map((payment) => `<tr><td>${dateLabel(payment.paid_at)}</td><td>${currency(payment.amount)}</td><td>${escapeHtml(payment.method)}</td><td><span class="pill${payment.status === "Validé" ? " pill--green" : payment.status === "Refusé" ? " pill--red" : " pill--amber"}">${escapeHtml(payment.status)}</span></td><td>${payment.status === "Validé" ? `<button class="text-button" data-action="receipt" data-payment="${payment.id}">${escapeHtml(payment.receipt_number || "Imprimer le reçu")}</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p>Aucun paiement enregistré.</p>`}</section>
      <section class="card section-card" id="student-documents"><div class="card__heading"><div><h2>Mes attestations et documents</h2><p>Documents autorisés pour votre compte</p></div><button class="button button--small" data-action="upload-student-document" type="button">Ajouter une pièce</button></div>
      ${renderDocumentList(state.documents)}</section>
      <section class="card section-card" id="student-resources"><div class="card__heading"><div><h2>Mes ressources</h2><p>Ressources partagées avec vous ou votre formation</p></div></div>${renderResourceList(state.resources)}</section>
      <section class="card section-card" id="student-announcements"><div class="card__heading"><div><h2>Annonces et notifications</h2><p>Communications enregistrées par le centre</p></div></div>
      ${renderAnnouncements(state.announcements)}
      <div class="document-list" style="margin-top:14px">${state.notifications.map((item) => `<div class="document-item"><div><strong>${escapeHtml(repairFrenchText(item.event_type))}</strong><small>${escapeHtml(repairFrenchText(item.message))} · ${escapeHtml(repairFrenchText(item.delivery_status))}</small></div><small>${dateLabel(item.created_at?.slice(0, 10))}</small></div>`).join("") || `<p>Aucune notification.</p>`}</div></section>`;
  }

  function renderDocumentList(documents) {
    if (!documents.length) return `<p>Aucun document publié pour le moment.</p>`;
    return `<div class="document-list">${documents.map((doc) => `<div class="document-item"><div><strong>${escapeHtml(doc.name)}</strong><small>${escapeHtml(doc.document_type)} · ${dateLabel(doc.created_at?.slice(0, 10))}</small></div>
      <button class="button button--small" type="button" data-action="download-document" data-document="${doc.id}">Ouvrir / télécharger</button></div>`).join("")}</div>`;
  }

  function renderResourceList(resources) {
    if (!resources.length) return `<p>Aucune ressource accessible pour le moment.</p>`;
    return `<div class="document-list">${resources.map((resource) => `<div class="document-item"><div><strong>${escapeHtml(resource.name)}</strong><small>${escapeHtml(resource.type)} · ${escapeHtml(resource.description || "Document du centre")}</small></div>
      <button class="button button--small" type="button" data-action="download-resource" data-resource="${resource.id}">Télécharger</button></div>`).join("")}</div>`;
  }

  function renderAnnouncements(items) {
    if (!items.length) return `<p>Aucune annonce publiée.</p>`;
    return items.map((item) => `<article class="announcement"><div class="announcement__top"><h3>${escapeHtml(item.title)}</h3></div><p>${escapeHtml(item.message)}</p><small>${dateLabel(item.created_at?.slice(0, 10))}</small></article>`).join("");
  }

  async function renderEnrollmentForm(courseId = state.selectedCourse, staffCreated = false) {
    const course = state.courses.find((item) => item.id === courseId) || state.courses[0];
    const formProfile = staffCreated ? {} : (state.profile || {});
    if (!course) {
      toast("Aucune formation active n’est disponible.", true);
      state.view = isStaff() ? "staff" : "catalog";
      await render();
      return;
    }
    state.selectedCourse = course.id;
    const sessions = unwrap(await state.client.from("sessions").select("*").eq("course_id", course.id).eq("active", true).order("starts_at"));
    const feeSummary = course.fee_confirmed ? currency(course.registration_fee) : "à confirmer et non appliqués tant que le centre ne les a pas confirmés";
    const terms = `<div class="condition-card"><h3>Conditions de paiement et de non-remboursement</h3><p>Les paiements sont reçus et enregistrés par le personnel. Aucun paiement en ligne n’est actif. Frais d’inscription et de badge : ${escapeHtml(feeSummary)}. L’échéancier de 50 % à l’inscription et 50 % pendant la formation ne s’applique que s’il est confirmé par le personnel. Les sommes versées ne sont pas remboursables, sauf décision écrite du centre selon ses règles en vigueur.</p></div>`;
    view.innerHTML = `${heading(staffCreated ? "Créer une inscription au centre" : "Demande d’inscription", "Les champs marqués d’un astérisque sont obligatoires.")}
      ${notice(`Formation choisie : <strong>${escapeHtml(course.name)}</strong> · Tarif : <strong>${currency(course.price)}</strong> · Durée : <strong>${escapeHtml(course.duration || "à confirmer")}</strong>.`, "blue")}
      <form class="card section-card" data-form="enrollment" data-staff="${staffCreated}">
      <div class="section-card__title">Coordonnées de l’étudiant</div><div class="form-grid">
      ${staffCreated ? `<div class="field field--wide"><label for="student-account-email">E-mail du compte étudiant <span class="required">*</span></label><input id="student-account-email" name="studentAccountEmail" type="email" class="input" required><small>Le dossier sera rattaché à un compte étudiant existant.</small></div>` : ""}
      <div class="field"><label for="enroll-first">Prénom <span class="required">*</span></label><input id="enroll-first" name="first_name" class="input" required value="${escapeHtml(formProfile.first_name || "")}"></div>
      <div class="field"><label for="enroll-last">Nom <span class="required">*</span></label><input id="enroll-last" name="last_name" class="input" required value="${escapeHtml(formProfile.last_name || "")}"></div>
      <div class="field"><label for="enroll-phone">Téléphone <span class="required">*</span></label><input id="enroll-phone" name="phone" type="tel" class="input" required value="${escapeHtml(formProfile.phone || "")}"></div>
      <div class="field"><label for="enroll-email">Adresse e-mail <span class="required">*</span></label><input id="enroll-email" name="email" type="email" class="input" required value="${escapeHtml(formProfile.email || "")}"></div>
      <div class="field"><label for="enroll-birth">Date de naissance</label><input id="enroll-birth" name="birth_date" type="date" class="input"></div>
      <div class="field"><label for="enroll-availability">Disponibilités</label><input id="enroll-availability" name="availability" class="input" placeholder="Jours / horaires préférés"></div>
      <div class="field field--wide"><label for="enroll-address">Adresse</label><input id="enroll-address" name="address" class="input"></div>
      <div class="field"><label for="enroll-emergency">Personne à contacter en cas d’urgence</label><input id="enroll-emergency" name="emergency_contact" class="input" placeholder="Nom et téléphone"></div>
      <div class="field"><label for="enroll-session">Session</label><select id="enroll-session" name="session_id" class="select"><option value="">Aucune session définie</option>${sessions.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} · ${dateLabel(item.starts_at)} · ${escapeHtml(item.schedule || "horaire à définir")}</option>`).join("")}</select></div>
      </div>
      <div class="section-card__title" style="margin-top:22px">Pièces justificatives</div>
      <div class="form-grid"><div class="field field--wide"><label for="enroll-photo">Photo d’identité (une seule photo) <span class="required">*</span></label><div class="upload"><span class="upload__icon">▣</span><input id="enroll-photo" type="file" name="photo" accept="image/jpeg,image/png,image/webp" required><small>JPEG, PNG ou WEBP · 3 Mo maximum</small></div></div>
      <div class="field field--wide"><label for="enroll-files">Autres pièces demandées</label><div class="upload"><input id="enroll-files" type="file" name="attachments" multiple accept="image/jpeg,image/png,image/webp,application/pdf,.doc,.docx"><small>${escapeHtml(course.required_documents || "Aucune autre pièce précise n’a été définie pour cette formation.")} · 3 Mo maximum par fichier</small></div></div></div>
      <div style="margin-top:18px">${terms}</div>
      <label class="check-row" style="margin-top:14px"><input type="checkbox" name="accepted_terms" required><span>Je confirme l’exactitude des informations, j’accepte les conditions de paiement et la règle de non-remboursement affichées ci-dessus, et je comprends que le dossier sera vérifié par le centre avant validation. <span class="required">*</span></span></label>
      <div class="form-actions"><button class="button" type="button" data-action="navigate" data-view="${staffCreated ? "staff" : "catalog"}">Annuler</button><button class="button button--primary" type="submit">Envoyer la demande</button></div></form>`;
  }

  async function saveEnrollment(form) {
    const data = new FormData(form);
    const course = state.courses.find((item) => item.id === state.selectedCourse);
    const photo = data.get("photo");
    const attachments = [...form.querySelector('[name="attachments"]').files];
    if (!photo || !photo.size || !["image/jpeg", "image/png", "image/webp"].includes(photo.type) || photo.size > 3 * 1024 * 1024) throw new Error("Une photo d’identité JPEG, PNG ou WEBP de 3 Mo maximum est obligatoire.");
    if (attachments.some((file) => file.size > 3 * 1024 * 1024)) throw new Error("Chaque pièce jointe doit faire 3 Mo maximum.");
    let studentId = state.user.id;
    if (form.dataset.staff === "true") {
      const email = String(data.get("studentAccountEmail") || "").trim().toLowerCase();
      const student = unwrap(await state.client.from("profiles").select("id,role").eq("email", email).single());
      if (student.role !== "student") throw new Error("L’adresse e-mail ne correspond pas à un compte étudiant.");
      studentId = student.id;
    }
    const enrollmentId = crypto.randomUUID();
    const files = [{ file: photo, document_type: "photo" }, ...attachments.map((file) => ({ file, document_type: "justificatif" }))];
    const uploaded = [];
    let enrollmentCreated = false;
    try {
      for (const item of files) {
        const safeName = item.file.name.replace(/[^\w.-]/g, "_");
        const path = `${studentId}/${enrollmentId}/${crypto.randomUUID()}-${safeName}`;
        unwrap(await state.client.storage.from("student-documents").upload(path, item.file, { contentType: item.file.type, upsert: false }));
        uploaded.push({ ...item, path });
      }
      unwrap(await state.client.from("enrollments").insert({
        id: enrollmentId, student_id: studentId, course_id: course.id,
        session_id: data.get("session_id") || null,
        first_name: String(data.get("first_name")).trim(), last_name: String(data.get("last_name")).trim(),
        phone: String(data.get("phone")).trim(), email: String(data.get("email")).trim().toLowerCase(),
        birth_date: data.get("birth_date") || null, address: String(data.get("address") || "").trim(),
        availability: String(data.get("availability") || "").trim(), emergency_contact: String(data.get("emergency_contact") || "").trim(),
        accepted_terms: data.get("accepted_terms") === "on", created_by: state.user.id, status: "En attente"
      }));
      enrollmentCreated = true;
      const documentRows = uploaded.map((item) => ({
        enrollment_id: enrollmentId, student_id: studentId, document_type: item.document_type,
        name: item.file.name, storage_path: item.path, mime_type: item.file.type || "application/octet-stream",
        visible_to_student: true, uploaded_by: state.user.id
      }));
      unwrap(await state.client.from("documents").insert(documentRows));
      } catch (error) {
        if (uploaded.length) {
          const cleanup = await state.client.storage.from("student-documents").remove(uploaded.map((item) => item.path));
          if (cleanup.error) throw new Error(`${errorText(error)} Les fichiers importés n’ont pas pu être nettoyés : ${cleanup.error.message}`);
        }
        if (enrollmentCreated) throw new Error(`Votre demande est enregistrée, mais les pièces jointes n’ont pas été associées au dossier : ${errorText(error)}. Contactez le centre pour compléter le dossier.`);
        throw error;
    }
    toast(form.dataset.staff === "true" ? "Demande créée et pièces enregistrées." : "Votre demande est envoyée et en attente de vérification.");
    closeModal();
    state.selectedCourse = "";
    state.view = form.dataset.staff === "true" ? "staff" : "student";
    await render();
  }

  function enrollmentMatches(enrollment) {
    const search = state.filters.search.toLocaleLowerCase("fr");
    const contact = `${enrollment.first_name} ${enrollment.last_name} ${enrollment.phone} ${enrollment.email} ${enrollment.enrollment_number}`.toLocaleLowerCase("fr");
    return (!search || contact.includes(search))
      && (!state.filters.status || enrollment.status === state.filters.status)
      && (!state.filters.course || enrollment.course_id === state.filters.course)
      && (!state.filters.dateFrom || enrollment.created_at.slice(0, 10) >= state.filters.dateFrom)
      && (!state.filters.dateTo || enrollment.created_at.slice(0, 10) <= state.filters.dateTo);
  }

  async function loadStaffData() {
    const [enrollments, payments, documents, history] = await Promise.all([
      state.client.from("enrollments").select("*, courses(*), sessions(name,starts_at,schedule)").order("created_at", { ascending: false }),
      state.client.from("payments").select("*").order("created_at", { ascending: false }),
      state.client.from("documents").select("*").order("created_at", { ascending: false }),
      state.client.from("enrollment_status_history").select("*").order("created_at", { ascending: false })
    ]);
    state.enrollments = unwrap(enrollments);
    state.payments = unwrap(payments);
    state.documents = unwrap(documents);
    state.history = unwrap(history);
  }

  async function renderStaff() {
    if (!isStaff()) {
      view.innerHTML = `${heading("Espace personnel", "Connectez-vous avec un compte habilité par l’administrateur.")}<div class="login-panel"><div class="card"><h2>Accès réservé au personnel</h2><button class="button button--primary" data-action="account" type="button">Connexion</button></div></div>`;
      return;
    }
    await loadStaffData();
    const rows = state.enrollments.filter(enrollmentMatches);
    const pending = state.enrollments.filter((item) => ["En attente", "Pièces à compléter"].includes(item.status)).length;
    const enrolled = state.enrollments.filter((item) => item.status === "Inscrit").length;
    const paymentsPending = state.payments.filter((item) => item.status === "À vérifier").length;
    const unknownPrices = state.enrollments.filter((item) => item.status === "Inscrit" && item.course_price == null).length;
    const overdueBalance = state.enrollments.filter((item) => item.status === "Inscrit").reduce((sum, enrollment) => {
      const paid = state.payments.filter((payment) => payment.enrollment_id === enrollment.id && payment.status === "Validé").reduce((total, payment) => total + payment.amount, 0);
      const due = enrollment.course_price == null ? 0 : enrollment.course_price + (enrollment.registration_fee_confirmed ? enrollment.registration_fee : 0);
      return sum + Math.max(0, due - paid);
    }, 0);
    const current = state.enrollments.find((item) => item.id === state.selectedEnrollment);
    const stats = [["Demandes à traiter", pending, "◷"], ["Inscriptions validées", enrolled, "✓"], ["Paiements à vérifier", paymentsPending, "₲"], ["Soldes restant dus", currency(overdueBalance), "↗"]];
    view.innerHTML = `${heading("Gestion des inscriptions", "Consultez les dossiers, vérifiez les paiements et publiez les documents.", `<button class="button" data-action="export-csv" type="button">Exporter en CSV</button><button class="button" data-action="print-badges" type="button"${state.selectedBadges.size !== 9 ? " disabled" : ""}>Imprimer 9 badges A4</button><button class="button button--primary" data-action="staff-enrollment" type="button">Créer une inscription</button>`)}
      <div class="stat-grid">${stats.map(([label, value, icon]) => `<div class="stat-card"><div><div class="stat-card__label">${label}</div><div class="stat-card__value">${value}</div></div><span class="stat-card__icon">${icon}</span></div>`).join("")}</div>
      ${unknownPrices ? notice(`${unknownPrices} inscription(s) ont un tarif à confirmer et ne sont pas incluses dans le total des soldes connus.`, "blue") : ""}
      ${notice("Les e-mails et SMS ne sont pas envoyés tant qu’aucun fournisseur n’est configuré. Après chaque action, l’application conserve l’état « fournisseur à configurer ».", "blue")}
      <section class="card section-card"><div class="card__heading"><div><h2>Demandes récentes</h2><p>Filtrez par nom, téléphone, e-mail, numéro, formation ou statut.</p></div></div>
      <div class="filters"><label class="search-field"><input class="input" id="staff-search" type="search" placeholder="Rechercher un étudiant" value="${escapeHtml(state.filters.search)}" aria-label="Rechercher un étudiant"></label>
      <select class="select filter-select" id="staff-course-filter" aria-label="Filtrer par formation"><option value="">Toutes les formations</option>${state.courses.map((course) => `<option value="${escapeHtml(course.id)}"${state.filters.course === course.id ? " selected" : ""}>${escapeHtml(course.name)}</option>`).join("")}</select>
      <select class="select filter-select" id="staff-status-filter" aria-label="Filtrer par statut"><option value="">Tous les statuts</option>${statuses.map((status) => `<option${state.filters.status === status ? " selected" : ""}>${escapeHtml(status)}</option>`).join("")}</select>
      <input class="input filter-select" id="staff-date-from" type="date" aria-label="Date de début" value="${escapeHtml(state.filters.dateFrom)}">
      <input class="input filter-select" id="staff-date-to" type="date" aria-label="Date de fin" value="${escapeHtml(state.filters.dateTo)}"></div>
      <p class="mobile-scroll-hint">Faites défiler le tableau horizontalement pour voir toutes les colonnes.</p>
      <div class="table-wrap"><table><thead><tr><th>N° dossier</th><th>Étudiant</th><th>Formation</th><th>Date</th><th>Statut</th><th>Action</th><th>Badge</th></tr></thead><tbody>
      ${rows.map((item) => {
        const hasPhoto = state.documents.some((doc) => doc.enrollment_id === item.id && doc.document_type === "photo");
        return `<tr><td>${escapeHtml(item.enrollment_number)}</td><td>${escapeHtml(`${item.first_name} ${item.last_name}`)}<small>${escapeHtml(item.phone)} · ${escapeHtml(item.email)}</small></td><td>${escapeHtml(item.courses?.name || "Formation")}</td><td>${dateLabel(item.created_at?.slice(0, 10))}</td><td><span class="pill">${escapeHtml(item.status)}</span></td><td><button class="button button--small" data-action="select-enrollment" data-enrollment="${item.id}" type="button">Ouvrir</button></td><td>${hasPhoto && item.status === "Inscrit" ? `<input type="checkbox" data-badge="${item.id}" aria-label="Sélectionner ${escapeHtml(item.first_name)} ${escapeHtml(item.last_name)}"${state.selectedBadges.has(item.id) ? " checked" : ""}>` : "—"}</td></tr>`;
      }).join("") || `<tr><td colspan="7">Aucun dossier correspondant.</td></tr>`}
      </tbody></table></div></section>
      ${current ? renderStaffEnrollment(current) : ""}
      <section class="card section-card"><div class="card__heading"><div><h2>Dernières opérations</h2><p>Historique de statuts et paiements.</p></div></div>
      <div class="document-list">${state.history.slice(0, 8).map((item) => `<div class="document-item"><div><strong>${escapeHtml(item.status)}</strong><small>${escapeHtml(item.comment || "Statut mis à jour")}</small></div><small>${new Date(item.created_at).toLocaleString("fr-GN")}</small></div>`).join("") || `<p>Aucune opération enregistrée.</p>`}</div></section>`;
  }

  function renderStaffEnrollment(enrollment) {
    const payments = state.payments.filter((item) => item.enrollment_id === enrollment.id);
    const docs = state.documents.filter((item) => item.enrollment_id === enrollment.id);
    const history = state.history.filter((item) => item.enrollment_id === enrollment.id);
    const paid = payments.filter((item) => item.status === "Validé").reduce((sum, item) => sum + item.amount, 0);
    const total = enrollment.course_price == null ? null : enrollment.course_price + (enrollment.registration_fee_confirmed ? enrollment.registration_fee : 0);
    const balance = total == null ? null : Math.max(0, total - paid);
    return `<section class="card section-card" id="selected-enrollment"><div class="card__heading"><div><h2>Dossier ${escapeHtml(enrollment.enrollment_number)}</h2><p>${escapeHtml(`${enrollment.first_name} ${enrollment.last_name}`)} · ${escapeHtml(enrollment.courses?.name || "Formation")}</p></div><span class="pill">${escapeHtml(enrollment.status)}</span></div>
      <div class="detail-grid"><div class="condition-card"><h3>Coordonnées</h3><p>Téléphone : ${escapeHtml(enrollment.phone)}<br>E-mail : ${escapeHtml(enrollment.email)}<br>Adresse : ${escapeHtml(enrollment.address || "Non renseignée")}<br>Date de naissance : ${dateLabel(enrollment.birth_date)}<br>Contact d’urgence : ${escapeHtml(enrollment.emergency_contact || "Non renseigné")}</p></div>
      <div class="condition-card"><h3>Montants</h3><p>Formation : ${currency(enrollment.course_price)}<br>Frais confirmés : ${enrollment.registration_fee_confirmed ? currency(enrollment.registration_fee) : "Non confirmés — non appliqués"}<br>Payé validé : ${currency(paid)}<br>Solde : ${currency(balance)}</p></div></div>
      <form class="card section-card" data-form="staff-student-info" data-enrollment="${enrollment.id}" style="margin-top:14px"><div class="section-card__title">Modifier les coordonnées du dossier</div>
      <div class="form-grid"><div class="field"><label>Prénom</label><input class="input" name="first_name" value="${escapeHtml(enrollment.first_name)}" required></div>
      <div class="field"><label>Nom</label><input class="input" name="last_name" value="${escapeHtml(enrollment.last_name)}" required></div>
      <div class="field"><label>Téléphone</label><input class="input" name="phone" type="tel" value="${escapeHtml(enrollment.phone)}" required></div>
      <div class="field"><label>E-mail</label><input class="input" name="email" type="email" value="${escapeHtml(enrollment.email)}" required></div>
      <div class="field"><label>Date de naissance</label><input class="input" name="birth_date" type="date" value="${escapeHtml(enrollment.birth_date || "")}"></div>
      <div class="field"><label>Disponibilités</label><input class="input" name="availability" value="${escapeHtml(enrollment.availability || "")}"></div>
      <div class="field field--wide"><label>Adresse</label><input class="input" name="address" value="${escapeHtml(enrollment.address || "")}"></div>
      <div class="field field--wide"><label>Personne à contacter en cas d’urgence</label><input class="input" name="emergency_contact" value="${escapeHtml(enrollment.emergency_contact || "")}"></div>
      <div class="field field--wide form-actions"><button class="button" type="submit">Enregistrer les coordonnées</button></div></div></form>
      <form data-form="change-status" data-enrollment="${enrollment.id}" class="section-card" style="margin-top:18px"><div class="section-card__title">Mettre à jour le statut</div>
      <div class="form-grid"><div class="field"><label for="new-status">Nouveau statut</label><select id="new-status" name="status" class="select">${statuses.map((status) => `<option${status === enrollment.status ? " selected" : ""}>${escapeHtml(status)}</option>`).join("")}</select></div>
      <div class="field"><label for="status-comment">Commentaire (facultatif)</label><input id="status-comment" name="comment" class="input" placeholder="Précision pour le dossier"></div></div>
      <label class="check-row" style="margin-top:12px"><input type="checkbox" name="inscription_confirmed"><span>Pour valider « Inscrit », je confirme avoir vérifié le dossier et le paiement requis selon les conditions confirmées par le centre.</span></label>
      <div class="form-actions"><button class="button button--primary" type="submit">Enregistrer le statut</button><button class="button" type="button" data-action="print-attestation" data-enrollment="${enrollment.id}"${enrollment.status !== "Inscrit" ? " disabled" : ""}>Imprimer l’attestation</button></div></form>
      <div class="section-card"><div class="section-card__title">Paiements enregistrés</div>
      ${payments.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Montant</th><th>Mode</th><th>État</th><th>Action</th></tr></thead><tbody>${payments.map((payment) => `<tr><td>${dateLabel(payment.paid_at)}</td><td>${currency(payment.amount)}</td><td>${escapeHtml(payment.method)}</td><td>${escapeHtml(payment.status)}</td><td>${payment.status === "À vérifier" ? `<button class="button button--small" data-action="validate-payment" data-payment="${payment.id}" type="button">Valider</button>` : payment.status === "Validé" ? `<button class="text-button" data-action="receipt-staff" data-payment="${payment.id}" type="button">${escapeHtml(payment.receipt_number || "Reçu")}</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>` : `<p>Aucun paiement.</p>`}
      <form class="form-grid" data-form="payment" data-enrollment="${enrollment.id}" style="margin-top:14px">
      <div class="field"><label>Montant reçu (GNF) <span class="required">*</span></label><input class="input" type="number" name="amount" min="1" step="1" required></div>
      <div class="field"><label>Date du paiement</label><input class="input" type="date" name="paid_at" value="${new Date().toISOString().slice(0, 10)}" required></div>
      <div class="field"><label>Mode de paiement <span class="required">*</span></label><select class="select" name="method" required><option value="">Choisir…</option><option>Espèces au centre</option><option>Mobile Money vérifié au centre</option><option>Virement confirmé</option><option>Autre</option></select></div>
      <div class="field"><label>Référence</label><input class="input" name="reference"></div>
      <div class="field field--wide"><label>Commentaire</label><input class="input" name="comment"></div>
      <div class="field field--wide"><label class="check-row"><input type="checkbox" name="checked"><span>J’ai vérifié la réception réelle de ce paiement au centre. Sinon, il restera « À vérifier ».</span></label></div>
      <div class="field field--wide form-actions"><button class="button button--primary" type="submit">Enregistrer le paiement</button></div></form></div>
      <div class="section-card"><div class="section-card__title">Documents du dossier</div>${renderStaffDocuments(docs)}
      <form class="form-grid" data-form="staff-document" data-enrollment="${enrollment.id}" style="margin-top:12px"><div class="field"><label>Type de document</label><select class="select" name="document_type"><option value="attestation">Attestation</option><option value="recu">Reçu téléversé</option><option value="autre">Autre document</option></select></div>
      <div class="field"><label>Fichier (3 Mo maximum)</label><input class="input" type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf,.doc,.docx" required></div>
      <div class="field field--wide"><label>Nom du document</label><input class="input" name="name" placeholder="Attestation de formation" required></div>
      <div class="field field--wide"><label class="check-row"><input type="checkbox" name="visible_to_student" checked><span>Rendre visible à l’étudiant</span></label></div>
      <div class="field field--wide form-actions"><button class="button" type="submit">Téléverser le document</button></div></form></div>
      <div class="section-card"><div class="section-card__title">Historique des statuts</div><div class="document-list">${history.map((item) => `<div class="document-item"><div><strong>${escapeHtml(item.status)}</strong><small>${escapeHtml(item.comment || "")}</small></div><small>${new Date(item.created_at).toLocaleString("fr-GN")}</small></div>`).join("") || `<p>Aucun historique disponible.</p>`}</div></div>
    </section>`;
  }

  function renderStaffDocuments(docs) {
    return docs.length ? `<div class="document-list">${docs.map((doc) => `<div class="document-item"><div><strong>${escapeHtml(doc.name)}</strong><small>${escapeHtml(doc.document_type)} · ${doc.visible_to_student ? "Visible par l’étudiant" : "Interne"}</small></div><button class="button button--small" data-action="download-document" data-document="${doc.id}" type="button">Ouvrir</button></div>`).join("")}</div>` : `<p>Aucun document pour ce dossier.</p>`;
  }

  async function renderCoursesManagement() {
    if (!isStaff()) return renderStaff();
    const courses = unwrap(await state.client.from("courses").select("*").order("category").order("name"));
    const announcements = unwrap(await state.client.from("announcements").select("*").order("created_at", { ascending: false }).limit(10));
    const sessions = unwrap(await state.client.from("sessions").select("*, courses(name)").order("starts_at", { ascending: true }));
    const notificationTemplates = unwrap(await state.client.from("notification_templates").select("*").order("name"));
    view.innerHTML = `${heading("Formations, sessions et annonces", "Mettez à jour le catalogue et les informations du centre. Les prix non confirmés restent modifiables.", `<button class="button button--primary" data-action="edit-course" type="button">Ajouter une formation</button>`)}
      ${notice("Les frais de 20 000 GNF et l’échéancier 50/50 restent désactivés tant qu’ils ne sont pas confirmés pour chaque formation.", "blue")}
      <section class="card section-card"><div class="card__heading"><div><h2>Catalogue administrable</h2><p>Les modifications sont enregistrées immédiatement dans la base partagée.</p></div></div>
      <div class="course-management">${courses.map((course) => `<div class="course-management__row"><div><strong>${escapeHtml(course.name)}</strong><small>${escapeHtml(course.category)} · ${currency(course.price)} · ${escapeHtml(course.duration || "Durée à confirmer")} · ${course.active ? "Active" : "Désactivée"}</small><small>Frais : ${course.fee_confirmed ? currency(course.registration_fee) : "à confirmer"} · Échéancier : ${course.payment_plan_confirmed ? `${course.deposit_percent}/${100 - course.deposit_percent}` : "non confirmé"}</small></div>
      <div class="resource-actions"><button class="button button--small" data-action="edit-course" data-course="${escapeHtml(course.id)}" type="button">Modifier</button><button class="button button--small" data-action="toggle-course" data-course="${escapeHtml(course.id)}" data-active="${course.active}" type="button">${course.active ? "Désactiver" : "Activer"}</button></div></div>`).join("")}</div></section>
      <section class="card section-card"><div class="card__heading"><div><h2>Sessions</h2><p>Dates, horaires et lieux par formation.</p></div></div>
      <form class="form-grid" data-form="session"><div class="field"><label>Formation</label><select class="select" name="course_id" required>${courses.filter((item) => item.active && !item.archived).map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Nom de la session</label><input class="input" name="name" required></div><div class="field"><label>Date de début</label><input class="input" name="starts_at" type="date" required></div>
      <div class="field"><label>Date de fin</label><input class="input" name="ends_at" type="date"></div><div class="field"><label>Horaires</label><input class="input" name="schedule"></div><div class="field"><label>Lieu</label><input class="input" name="location"></div>
      <div class="field field--wide form-actions"><button class="button button--primary" type="submit">Créer une session</button></div></form>
      <div class="document-list" style="margin-top:12px">${sessions.map((item) => `<div class="document-item"><div><strong>${escapeHtml(item.name)} — ${escapeHtml(item.courses?.name || "")}</strong><small>${dateLabel(item.starts_at)} · ${escapeHtml(item.schedule || "Horaires à définir")} · ${escapeHtml(item.location || "Lieu à définir")}</small></div><span class="pill">${item.active ? "Active" : "Inactive"}</span></div>`).join("") || `<p>Aucune session définie.</p>`}</div></section>
      <section class="card section-card"><div class="card__heading"><div><h2>Publier une ressource</h2><p>Partagez un support de cours avec une formation ou un étudiant.</p></div></div>
      <form class="form-grid" data-form="resource"><div class="field"><label>Nom</label><input class="input" name="name" required></div><div class="field"><label>Type</label><input class="input" name="type" value="Support de cours" required></div>
      <div class="field field--wide"><label>Description</label><textarea class="textarea" name="description"></textarea></div>
      <div class="field"><label>Formation</label><select class="select" name="course_id"><option value="">Aucune</option>${courses.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Session</label><select class="select" name="session_id"><option value="">Aucune</option>${sessions.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} — ${escapeHtml(item.courses?.name || "")}</option>`).join("")}</select></div>
      <div class="field"><label>Compte étudiant ciblé (e-mail, facultatif)</label><input class="input" name="student_email" type="email"></div>
      <div class="field field--wide"><label>Fichier (3 Mo maximum)</label><input class="input" name="file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf,.doc,.docx" required></div>
      <div class="field field--wide form-actions"><button class="button button--primary" type="submit">Publier la ressource</button></div></form></section>
      <section class="card section-card"><div class="card__heading"><div><h2>Annonces</h2><p>Annonce visible dans les espaces étudiants après publication.</p></div></div>
      <form class="form-grid" data-form="announcement"><div class="field"><label>Titre</label><input class="input" name="title" required></div><div class="field field--wide"><label>Message</label><textarea class="textarea" name="message" required></textarea></div>
      <div class="field field--wide form-actions"><button class="button button--primary" type="submit">Publier l’annonce</button></div></form>${renderAnnouncements(announcements)}</section>`;
    view.insertAdjacentHTML("beforeend", `<section class="card section-card"><div class="card__heading"><div><h2>Modèles de notifications</h2><p>Modèles en français modifiables. L’envoi e-mail/SMS reste à configurer.</p></div></div>
      <div class="admin-grid">${notificationTemplates.map((template) => `<form class="condition-card" data-form="template" data-template="${escapeHtml(template.id)}">
      <div class="card__heading"><h3>${escapeHtml(repairFrenchText(template.name))}</h3><span class="pill">${escapeHtml(repairFrenchText(template.channel))}</span></div>
      <div class="field"><label>Objet</label><input class="input" name="subject" value="${escapeHtml(repairFrenchText(template.subject))}"></div>
      <div class="field" style="margin-top:9px"><label>Message</label><textarea class="textarea" name="body" required>${escapeHtml(repairFrenchText(template.body))}</textarea></div>
      <p class="field-help">Variables : {{formation}}, {{statut}}, {{montant}}, {{recu}}, {{document}}, {{ressource}}, {{solde}}</p>
      <label class="check-row" style="margin-top:9px"><input type="checkbox" name="enabled"${template.enabled ? " checked" : ""}><span>Modèle activé</span></label>
      <div class="form-actions"><button class="button button--small" type="submit">Enregistrer le modèle</button></div></form>`).join("")}</div></section>`);
  }

  async function renderAdmin() {
    if (!isAdmin()) {
      view.innerHTML = `${heading("Administration", "Cette section est réservée à l’administrateur du centre.")}`;
      return;
    }
    const [profiles, activity] = await Promise.all([
      state.client.from("profiles").select("id,email,first_name,last_name,phone,role,active,created_at").order("created_at", { ascending: false }),
      state.client.from("activity_log").select("action,actor_id,created_at").order("created_at", { ascending: false }).limit(100)
    ]);
    const users = unwrap(profiles);
    const logs = unwrap(activity);
    view.innerHTML = `${heading("Administration et journal d’activité", "Gérez les rôles du personnel et contrôlez les opérations importantes.")}
      ${notice("N’accordez le rôle personnel ou administrateur qu’aux comptes du centre que vous avez vérifiés.", "red")}
      <section class="card section-card"><div class="card__heading"><div><h2>Comptes utilisateurs</h2><p>Les étudiants ne peuvent pas modifier leur rôle.</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>Nom</th><th>E-mail</th><th>Rôle</th><th>État</th><th>Action</th></tr></thead><tbody>${users.map((user) => `<tr><td>${escapeHtml(`${user.first_name} ${user.last_name}`)}</td><td>${escapeHtml(user.email)}</td><td>${roleName(user.role)}</td><td>${user.active ? "Actif" : "Désactivé"}</td><td><form data-form="user-role" data-user="${user.id}" class="resource-actions"><select class="select" name="role" aria-label="Rôle">${["student", "staff", "admin"].map((role) => `<option value="${role}"${user.role === role ? " selected" : ""}>${roleName(role)}</option>`).join("")}</select><button class="button button--small" type="submit">Appliquer</button></form></td></tr>`).join("") || `<tr><td colspan="5">Aucun compte.</td></tr>`}</tbody></table></div></section>
      <section class="card section-card"><div class="card__heading"><div><h2>Journal d’activité</h2><p>100 dernières opérations.</p></div></div>
      <div class="document-list">${logs.map((entry) => `<div class="document-item"><div><strong>${escapeHtml(entry.action)}</strong><small>Compte : ${escapeHtml(entry.actor_id || "Système")}</small></div><small>${new Date(entry.created_at).toLocaleString("fr-GN")}</small></div>`).join("") || `<p>Aucune opération enregistrée.</p>`}</div></section>`;
  }

  async function render() {
    renderNavigation();
    view.innerHTML = `<div class="card">Chargement sécurisé des données…</div>`;
    try {
      if (!state.courses.length) await loadCourses();
      if (state.view === "catalog") renderCatalog();
      else if (state.view === "student") await renderStudent();
      else if (state.view === "staff") await renderStaff();
      else if (state.view === "courses") await renderCoursesManagement();
      else if (state.view === "admin") await renderAdmin();
      else {
        state.view = "catalog";
        renderCatalog();
      }
      renderNavigation();
    } catch (error) {
      view.innerHTML = `${heading("Service temporairement indisponible", "Les données n’ont pas pu être chargées depuis le serveur.")}${notice(escapeHtml(errorText(error)), "red")}<button class="button" data-action="retry" type="button">Réessayer</button>`;
    }
  }

  function showProfileModal() {
    const profile = state.profile || {};
    showModal("Modifier mon profil", "Vos coordonnées sont utilisées pour le suivi du dossier.", `<form data-form="profile">
      <div class="form-grid"><div class="field"><label>Prénom</label><input class="input" name="first_name" value="${escapeHtml(profile.first_name)}" required></div>
      <div class="field"><label>Nom</label><input class="input" name="last_name" value="${escapeHtml(profile.last_name)}" required></div>
      <div class="field field--wide"><label>Téléphone</label><input class="input" name="phone" type="tel" value="${escapeHtml(profile.phone)}" required></div></div>
      <div class="form-actions"><button class="button button--primary" type="submit">Enregistrer</button><button class="button" type="button" data-action="signout">Se déconnecter</button></div></form>`);
  }

  async function startSignup(form) {
    const data = new FormData(form);
    const result = await state.client.auth.signUp({
      email: String(data.get("email")).trim().toLowerCase(),
      password: String(data.get("password")),
      options: { data: { first_name: String(data.get("first_name")).trim(), last_name: String(data.get("last_name")).trim(), phone: String(data.get("phone")).trim() } }
    });
    if (result.error) throw result.error;
    if (!result.data.session) {
      closeModal();
      toast("Compte créé. Vérifiez votre adresse e-mail si une confirmation est demandée avant la première connexion.");
      return;
    }
    state.user = result.data.user;
    await refreshProfile();
    closeModal();
    if (state.selectedCourse) state.view = "student";
    await render();
    if (state.selectedCourse) await renderEnrollmentForm(state.selectedCourse);
  }

  async function startLogin(form) {
    const data = new FormData(form);
    const result = await state.client.auth.signInWithPassword({ email: String(data.get("email")).trim().toLowerCase(), password: String(data.get("password")) });
    if (result.error) throw result.error;
    state.user = result.data.user;
    await refreshProfile();
    closeModal();
    if (state.selectedCourse) {
      state.view = "student";
      await render();
      await renderEnrollmentForm(state.selectedCourse);
    } else {
      state.view = state.profile?.role === "student" ? "student" : "staff";
      await render();
    }
  }

  async function refreshProfile() {
    if (!state.user) {
      state.profile = null;
      return;
    }
    state.profile = unwrap(await state.client.from("profiles").select("*").eq("id", state.user.id).single());
    if (!state.profile.active) {
      await state.client.auth.signOut();
      state.user = null;
      state.profile = null;
      throw new Error("Ce compte a été désactivé. Contactez l’administrateur du centre.");
    }
  }

  async function signedUrl(path) {
    const result = unwrap(await state.client.storage.from("student-documents").createSignedUrl(path, 3600));
    return result.signedUrl;
  }

  async function downloadDocument(id) {
    const document = state.documents.find((item) => item.id === id);
    if (!document) throw new Error("Document introuvable ou non autorisé.");
    const url = await signedUrl(document.storage_path);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function downloadResource(id) {
    const resource = state.resources.find((item) => item.id === id);
    if (!resource) throw new Error("Ressource introuvable ou non autorisée.");
    unwrap(await state.client.from("resource_downloads").insert({ resource_id: id, student_id: state.user.id }));
    const url = await signedUrl(resource.storage_path);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function printWindow(title, content, css = "", target = null) {
    target = target || window.open("", "_blank");
    if (!target) throw new Error("Autorisez les fenêtres contextuelles pour imprimer ce document.");
    target.document.open();
    target.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
      <base href="${escapeHtml(new URL(".", location.href).href)}"><style>@page{size:A4 portrait;margin:14mm}body{font-family:Arial,sans-serif;color:#142744;line-height:1.5}h1,h2{color:#102a56}.header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #d7a645;padding-bottom:14px}.header img{width:80px;height:60px;object-fit:contain}.center{text-align:center}.info{margin:24px 0;padding:16px;border:1px solid #ccd5e2;border-radius:8px}.photo{width:34mm;height:42mm;object-fit:cover;border:1px solid #aaa}.badge-sheet{display:grid;box-sizing:border-box;width:210mm;height:297mm;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);gap:4mm;padding:8mm}.student-badge{display:grid;grid-template-columns:25mm 1fr;gap:4mm;align-content:center;align-items:center;padding:5mm;border:1px solid #9aa8b8;border-radius:3mm}.student-badge img{width:25mm;height:31mm;object-fit:cover}.student-badge h2{margin:0 0 2mm;font-size:12pt}.student-badge p{margin:0;font-size:8pt;color:#34445a}@media print{.no-print{display:none}}${css}</style></head>
      <body><div class="no-print" style="text-align:right;margin-bottom:12px"><button onclick="window.print()">Imprimer / Enregistrer en PDF</button></div>${content}</body></html>`);
    target.document.close();
    target.focus();
  }

  async function printReceipt(paymentId, staffView = false, target = null) {
    const payment = state.payments.find((item) => item.id === paymentId);
    if (!payment || payment.status !== "Validé") throw new Error("Un reçu ne peut être généré que pour un paiement validé.");
    const enrollment = state.enrollments.find((item) => item.id === payment.enrollment_id)
      || unwrap(await state.client.from("enrollments").select("*, courses(name)").eq("id", payment.enrollment_id).single());
    const course = state.courses.find((item) => item.id === enrollment.course_id) || enrollment.courses;
    const html = `<header class="header"><img src="IMAGES/Logo.png" alt="Logo FBS GROUPE"><div><strong>FBS GROUPE SARLU</strong><br>Centre de formation · Kankan, Guinée<br>${contactNumbers.map(escapeHtml).join(" · ")}<br>fbsgroupsarlu@gmail.com</div></header>
      <div class="center"><h1>REÇU DE PAIEMENT</h1><h2>${escapeHtml(payment.receipt_number || "Numéro non disponible")}</h2></div>
      <section class="info"><p><strong>Étudiant :</strong> ${escapeHtml(`${enrollment.first_name} ${enrollment.last_name}`)}</p><p><strong>N° d’inscription :</strong> ${escapeHtml(enrollment.enrollment_number)}</p>
      <p><strong>Formation :</strong> ${escapeHtml(course?.name || "Formation")}</p><p><strong>Montant reçu :</strong> ${currency(payment.amount)}</p>
      <p><strong>Date :</strong> ${dateLabel(payment.paid_at)}</p><p><strong>Mode :</strong> ${escapeHtml(payment.method)}</p>
      <p><strong>Solde restant après paiement :</strong> ${currency(await balanceAfterPayment(enrollment, payment))}</p>
      <p><strong>Référence :</strong> ${escapeHtml(payment.reference || "—")}</p></section>
      <p>Ce reçu confirme uniquement le paiement enregistré ci-dessus.</p><p>Personne ayant enregistré l’opération : ${escapeHtml(staffView ? state.profile?.first_name || "Personnel FBS GROUPE" : "FBS GROUPE")}</p>
      <p style="margin-top:40px">Signature et cachet du centre : __________________________</p>`;
    printWindow(`Reçu ${payment.receipt_number || ""}`, html, "", target);
  }

  async function balanceAfterPayment(enrollment, payment) {
    const payments = state.payments.filter((item) => item.enrollment_id === enrollment.id && item.status === "Validé");
    const paid = payments.reduce((sum, item) => sum + item.amount, 0);
    const total = enrollment.course_price == null ? null : enrollment.course_price + (enrollment.registration_fee_confirmed ? enrollment.registration_fee : 0);
    return total == null ? null : Math.max(0, total - paid);
  }

  async function printAttestation(enrollmentId, target = null) {
    const enrollment = state.enrollments.find((item) => item.id === enrollmentId);
    if (!enrollment || enrollment.status !== "Inscrit") throw new Error("L’attestation est disponible après validation de l’inscription.");
    const photo = state.documents.find((item) => item.enrollment_id === enrollmentId && item.document_type === "photo");
    const photoUrl = photo ? await signedUrl(photo.storage_path) : "";
    const course = state.courses.find((item) => item.id === enrollment.course_id);
    const html = `<header class="header"><img src="IMAGES/Logo.png" alt="Logo FBS GROUPE"><div><strong>FBS GROUPE SARLU</strong><br>Centre de formation · Kankan, Guinée<br>Entre l’UJNK et l’Hôtel Buffet de la Gare<br>${contactNumbers.map(escapeHtml).join(" · ")} · fbsgroupsarlu@gmail.com</div></header>
      <div class="center"><h1>ATTESTATION D’INSCRIPTION</h1><p>N° ${escapeHtml(enrollment.enrollment_number)}</p></div>
      <section class="info" style="display:flex;gap:20px;align-items:center">${photoUrl ? `<img class="photo" src="${escapeHtml(photoUrl)}" alt="Photo de ${escapeHtml(enrollment.first_name)}">` : ""}
      <div><p>Nous attestons que <strong>${escapeHtml(`${enrollment.first_name} ${enrollment.last_name}`)}</strong></p><p>est inscrit(e) à la formation <strong>${escapeHtml(course?.name || "Formation")}</strong>.</p>
      <p>Statut : Inscrit · Date d’inscription : ${dateLabel(enrollment.created_at?.slice(0, 10))}</p>
      <p>Session : ${escapeHtml(enrollment.sessions?.name || "À définir")}</p></div></section>
      <p>La présente attestation est délivrée pour servir et valoir ce que de droit.</p><p>Fait à Kankan, le ${dateLabel(new Date().toISOString().slice(0, 10))}.</p>
      <p style="margin-top:48px;text-align:right">La Direction<br>Signature et cachet</p>
      <small>Document généré depuis le portail FBS GROUPE. Vérifiez son authenticité auprès du centre.</small>`;
    printWindow(`Attestation ${enrollment.enrollment_number}`, html, "", target);
  }

  async function printBadges(target = null) {
    const ids = [...state.selectedBadges];
    if (ids.length !== 9) throw new Error("Sélectionnez exactement 9 étudiants inscrits avec photo pour imprimer une planche A4.");
    const selected = ids.map((id) => state.enrollments.find((item) => item.id === id)).filter(Boolean);
    if (selected.length !== 9 || selected.some((item) => item.status !== "Inscrit")) throw new Error("Les 9 dossiers doivent être inscrits.");
    const badges = await Promise.all(selected.map(async (enrollment) => {
      const photo = state.documents.find((item) => item.enrollment_id === enrollment.id && item.document_type === "photo");
      if (!photo) throw new Error(`${enrollment.first_name} ${enrollment.last_name} n’a pas de photo enregistrée.`);
      return { enrollment, photoUrl: await signedUrl(photo.storage_path) };
    }));
    const html = `<header class="header"><img src="IMAGES/Logo.png" alt="Logo FBS GROUPE"><div><strong>FBS GROUPE SARLU</strong><br>Badges professionnels · Kankan, Guinée</div></header>
      <div class="badge-sheet">${badges.map(({ enrollment, photoUrl }) => `<article class="student-badge"><img src="${escapeHtml(photoUrl)}" alt=""><div><h2>FBS GROUPE</h2><p><strong>${escapeHtml(`${enrollment.first_name} ${enrollment.last_name}`)}</strong></p><p>${escapeHtml(enrollment.courses?.name || state.courses.find((item) => item.id === enrollment.course_id)?.name || "Formation")}</p><p>N° ${escapeHtml(enrollment.enrollment_number)}</p><p>Kankan · Guinée</p></div></article>`).join("")}</div>`;
    printWindow("Planche de 9 badges FBS GROUPE", html, "@page{size:A4 portrait;margin:0}.header{display:none}", target);
  }

  async function changeStatus(form) {
    const enrollmentId = form.dataset.enrollment;
    const enrollment = state.enrollments.find((item) => item.id === enrollmentId);
    const data = new FormData(form);
    const newStatus = String(data.get("status"));
    if (newStatus === "Inscrit") {
      if (data.get("inscription_confirmed") !== "on") throw new Error("Confirmez la vérification du dossier et du paiement requis.");
      const photoExists = state.documents.some((item) => item.enrollment_id === enrollmentId && item.document_type === "photo");
      if (!photoExists) throw new Error("Une photo d’identité doit être présente avant de valider l’inscription.");
      const paid = state.payments.filter((item) => item.enrollment_id === enrollmentId && item.status === "Validé").reduce((sum, item) => sum + item.amount, 0);
      const fee = enrollment.registration_fee_confirmed ? Number(enrollment.registration_fee || 0) : 0;
      let required = fee;
      if (enrollment.payment_plan_confirmed && enrollment.course_price != null) {
        required += Math.ceil(Number(enrollment.course_price) * Number(enrollment.deposit_percent || 0) / 100);
      }
      if (required > 0 && paid < required) throw new Error(`Le paiement validé est inférieur au minimum confirmé (${currency(required)}). Vérifiez le paiement avant de confirmer l’inscription.`);
    }
    const comment = String(data.get("comment") || "").trim();
    unwrap(await state.client.from("enrollments").update({ status: newStatus, status_comment: comment }).eq("id", enrollmentId));
    state.selectedBadges.clear();
    const courseName = enrollment?.courses?.name || "la formation";
    const templateId = newStatus === "Inscrit" ? "inscription_confirmee"
      : newStatus === "Pièces à compléter" ? "correction"
        : newStatus === "Refusé" ? "refus" : "statut";
    try {
      await createNotification(templateId, enrollment.student_id, enrollment.id, { formation: courseName, statut: newStatus });
    } catch (notificationError) {
      await render();
      throw new Error(`Le statut a été enregistré, mais la notification n’a pas pu être créée : ${errorText(notificationError)}`);
    }
    toast("Statut mis à jour. L’envoi e-mail/SMS reste à configurer.");
    await render();
  }

  async function savePayment(form) {
    const enrollment = state.enrollments.find((item) => item.id === form.dataset.enrollment);
    const data = new FormData(form);
    const checked = data.get("checked") === "on";
    const amount = Number(data.get("amount"));
    const validPaid = state.payments.filter((item) => item.enrollment_id === enrollment.id && item.status === "Validé").reduce((sum, item) => sum + item.amount, 0);
    const total = enrollment.course_price == null ? null : enrollment.course_price + (enrollment.registration_fee_confirmed ? enrollment.registration_fee : 0);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Saisissez un montant entier positif en GNF.");
    if (checked && total != null && amount > Math.max(0, total - validPaid)) throw new Error("Le montant dépasse le solde restant calculé pour cette inscription.");
    const inserted = unwrap(await state.client.from("payments").insert({
      enrollment_id: enrollment.id, student_id: enrollment.student_id, amount,
      paid_at: data.get("paid_at"), method: data.get("method"), reference: String(data.get("reference") || "").trim(),
      comment: String(data.get("comment") || "").trim(), status: checked ? "Validé" : "À vérifier",
      entered_by: state.user.id, validated_by: checked ? state.user.id : null, validated_at: checked ? new Date().toISOString() : null
    }).select("*").single());
    if (!checked && ["En attente", "Inscrit"].includes(enrollment.status)) {
      unwrap(await state.client.from("enrollments").update({
        status: "Paiement à vérifier",
        status_comment: "Paiement enregistré par le personnel; vérification en attente."
      }).eq("id", enrollment.id));
    }
    try {
      await createNotification(checked ? "paiement_valide" : "paiement_recu", enrollment.student_id, enrollment.id, {
        montant: currency(inserted.amount), recu: inserted.receipt_number || "en préparation"
      });
    } catch (notificationError) {
      toast(`Paiement enregistré, mais la notification n’a pas été créée : ${errorText(notificationError)}`, true);
    }
    toast(checked ? "Paiement validé. Le reçu est disponible à l’impression." : "Paiement enregistré à vérifier.");
    await render();
  }

  async function validatePayment(paymentId) {
    const payment = state.payments.find((item) => item.id === paymentId);
    if (!payment || payment.status !== "À vérifier") throw new Error("Ce paiement n’est plus en attente de vérification.");
    unwrap(await state.client.from("payments").update({ status: "Validé", validated_by: state.user.id, validated_at: new Date().toISOString() }).eq("id", paymentId));
    const enrollment = state.enrollments.find((item) => item.id === payment.enrollment_id);
    try {
      await createNotification("paiement_valide", payment.student_id, payment.enrollment_id, {
        montant: currency(payment.amount), recu: payment.receipt_number || "en préparation"
      });
    } catch (notificationError) {
      toast(`Paiement validé, mais notification non créée : ${errorText(notificationError)}`, true);
    }
    toast("Paiement validé. Le reçu peut être imprimé.");
    await render();
  }

  async function uploadStaffDocument(form) {
    const enrollment = state.enrollments.find((item) => item.id === form.dataset.enrollment);
    const data = new FormData(form);
    const file = data.get("file");
    if (!file || file.size > 3 * 1024 * 1024) throw new Error("Choisissez un fichier de 3 Mo maximum.");
    const path = `${enrollment.student_id}/${enrollment.id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]/g, "_")}`;
    unwrap(await state.client.storage.from("student-documents").upload(path, file, { contentType: file.type, upsert: false }));
    const inserted = await state.client.from("documents").insert({
      enrollment_id: enrollment.id, student_id: enrollment.student_id, document_type: data.get("document_type"),
      name: String(data.get("name")).trim(), storage_path: path, mime_type: file.type || "application/octet-stream",
      visible_to_student: data.get("visible_to_student") === "on", uploaded_by: state.user.id
    });
    if (inserted.error) {
      const cleanup = await state.client.storage.from("student-documents").remove([path]);
      throw new Error(cleanup.error ? `${inserted.error.message} Le fichier temporaire n’a pas pu être supprimé : ${cleanup.error.message}` : inserted.error.message);
    }
    if (data.get("visible_to_student") === "on") {
      try {
        await createNotification("document_disponible", enrollment.student_id, enrollment.id, { document: String(data.get("name")).trim() });
      } catch (notificationError) {
        toast(`Document publié, notification non créée : ${errorText(notificationError)}`, true);
      }
    }
    await logActivity(`Ajout du document ${String(data.get("name")).trim()} au dossier ${enrollment.enrollment_number}`);
    toast("Document téléversé.");
    await render();
  }

  async function uploadStudentDocument(form) {
    const enrollment = state.enrollments[0];
    if (!enrollment) throw new Error("Créez d’abord une demande d’inscription.");
    const file = new FormData(form).get("file");
    if (!file || file.size > 3 * 1024 * 1024) throw new Error("Choisissez un fichier de 3 Mo maximum.");
    const path = `${state.user.id}/${enrollment.id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]/g, "_")}`;
    unwrap(await state.client.storage.from("student-documents").upload(path, file, { contentType: file.type, upsert: false }));
    const result = await state.client.from("documents").insert({
      enrollment_id: enrollment.id, student_id: state.user.id, document_type: file.type.startsWith("image/") ? "justificatif" : "justificatif",
      name: file.name, storage_path: path, mime_type: file.type || "application/octet-stream", uploaded_by: state.user.id, visible_to_student: true
    });
    if (result.error) {
      const cleanup = await state.client.storage.from("student-documents").remove([path]);
      throw new Error(cleanup.error ? `${result.error.message} Le fichier temporaire n’a pas pu être supprimé : ${cleanup.error.message}` : result.error.message);
    }
    toast("Pièce justificative ajoutée à votre dossier.");
    await render();
  }

  async function saveCourse(form) {
    const data = new FormData(form);
    const id = String(data.get("id") || "").trim() || `course-${crypto.randomUUID()}`;
    const priceValue = String(data.get("price") || "").trim();
    const row = {
      id, name: String(data.get("name")).trim(), category: String(data.get("category")).trim(),
      price: priceValue === "" ? null : Number(priceValue), duration: String(data.get("duration") || "").trim(),
      description: String(data.get("description") || "").trim(), prerequisites: String(data.get("prerequisites") || "").trim(),
      required_documents: String(data.get("required_documents") || "").trim(),
      registration_fee: Number(data.get("registration_fee") || 0), fee_confirmed: data.get("fee_confirmed") === "on",
      deposit_percent: Number(data.get("deposit_percent") || 50), payment_plan_confirmed: data.get("payment_plan_confirmed") === "on",
      active: data.get("active") === "on", archived: false
    };
    unwrap(await state.client.from("courses").upsert(row));
    await logActivity(`Modification de la formation ${row.name}`);
    closeModal();
    state.courses = [];
    toast("Formation enregistrée.");
    await render();
  }

  function showCourseModal(courseId = "") {
    const course = state.courses.find((item) => item.id === courseId) || {};
    showModal(courseId ? "Modifier la formation" : "Ajouter une formation", "Les tarifs et conditions restent modifiables par le personnel.", `<form class="form-grid" data-form="course">
      <input type="hidden" name="id" value="${escapeHtml(course.id || "")}">
      <div class="field"><label>Nom</label><input class="input" name="name" value="${escapeHtml(course.name || "")}" required></div>
      <div class="field"><label>Catégorie</label><input class="input" name="category" value="${escapeHtml(course.category || "")}" required></div>
      <div class="field"><label>Tarif (GNF)</label><input class="input" name="price" type="number" min="0" step="1" value="${course.price ?? ""}"><small>Vide = tarif à confirmer.</small></div>
      <div class="field"><label>Durée</label><input class="input" name="duration" value="${escapeHtml(course.duration || "")}"></div>
      <div class="field field--wide"><label>Description</label><textarea class="textarea" name="description">${escapeHtml(course.description || "")}</textarea></div>
      <div class="field"><label>Prérequis</label><textarea class="textarea" name="prerequisites">${escapeHtml(course.prerequisites || "")}</textarea></div>
      <div class="field"><label>Pièces requises</label><textarea class="textarea" name="required_documents">${escapeHtml(course.required_documents || "")}</textarea></div>
      <div class="field"><label>Frais d’inscription et badge (GNF)</label><input class="input" name="registration_fee" type="number" min="0" value="${course.registration_fee ?? 20000}"></div>
      <div class="field"><label>Part à l’inscription (%)</label><input class="input" name="deposit_percent" type="number" min="0" max="100" value="${course.deposit_percent ?? 50}"></div>
      <div class="field field--wide"><label class="check-row"><input type="checkbox" name="fee_confirmed"${course.fee_confirmed ? " checked" : ""}><span>Confirmer les frais pour cette formation.</span></label></div>
      <div class="field field--wide"><label class="check-row"><input type="checkbox" name="payment_plan_confirmed"${course.payment_plan_confirmed ? " checked" : ""}><span>Confirmer l’échéancier de paiement pour cette formation.</span></label></div>
      <div class="field field--wide"><label class="check-row"><input type="checkbox" name="active"${course.active !== false ? " checked" : ""}><span>Formation active dans le catalogue.</span></label></div>
      <div class="field field--wide form-actions"><button class="button button--primary" type="submit">Enregistrer la formation</button></div></form>`, true);
  }

  async function saveSession(form) {
    const data = new FormData(form);
    unwrap(await state.client.from("sessions").insert({
      course_id: data.get("course_id"), name: String(data.get("name")).trim(),
      starts_at: data.get("starts_at"), ends_at: data.get("ends_at") || null,
      schedule: String(data.get("schedule") || "").trim(), location: String(data.get("location") || "").trim(),
      created_by: state.user.id
    }));
    await logActivity(`Création de la session ${String(data.get("name")).trim()}`);
    toast("Session créée.");
    await render();
  }

  async function saveResource(form) {
    const data = new FormData(form);
    const file = data.get("file");
    if (!file || file.size > 3 * 1024 * 1024) throw new Error("Choisissez un fichier de 3 Mo maximum.");
    const email = String(data.get("student_email") || "").trim().toLowerCase();
    const sessionId = data.get("session_id") || null;
    let targetStudentId = null;
    if (email) {
      const student = unwrap(await state.client.from("profiles").select("id,role").eq("email", email).single());
      if (student.role !== "student") throw new Error("L’adresse ne correspond pas à un compte étudiant.");
      targetStudentId = student.id;
    }
    const courseId = data.get("course_id") || null;
    if (!targetStudentId && !courseId && !sessionId) throw new Error("Choisissez une formation, une session ou un compte étudiant.");
    if (Number(Boolean(targetStudentId)) + Number(Boolean(courseId)) + Number(Boolean(sessionId)) !== 1) {
      throw new Error("Choisissez une seule cible : formation, session ou compte étudiant.");
    }
    const id = crypto.randomUUID();
    const path = `resources/${id}/${file.name.replace(/[^\w.-]/g, "_")}`;
    unwrap(await state.client.storage.from("student-documents").upload(path, file, { contentType: file.type, upsert: false }));
    const inserted = await state.client.from("resources").insert({
      id, name: String(data.get("name")).trim(), type: String(data.get("type")).trim(),
      description: String(data.get("description") || "").trim(), storage_path: path,
      course_id: targetStudentId || sessionId ? null : courseId, session_id: sessionId,
      target_student_id: targetStudentId, created_by: state.user.id
    });
    if (inserted.error) {
      const cleanup = await state.client.storage.from("student-documents").remove([path]);
      throw new Error(cleanup.error ? `${inserted.error.message} Le fichier temporaire n’a pas pu être supprimé : ${cleanup.error.message}` : inserted.error.message);
    }
    if (targetStudentId) {
      try {
        await createNotification("ressource_disponible", targetStudentId, null, { ressource: String(data.get("name")).trim() });
      } catch (notificationError) {
        toast(`Ressource publiée, notification non créée : ${errorText(notificationError)}`, true);
      }
    }
    await logActivity(`Publication de la ressource ${String(data.get("name")).trim()}`);
    toast("Ressource publiée avec accès contrôlé.");
    await render();
  }

  async function saveAnnouncement(form) {
    const data = new FormData(form);
    unwrap(await state.client.from("announcements").insert({
      title: String(data.get("title")).trim(), message: String(data.get("message")).trim(),
      published: true, created_by: state.user.id
    }));
    await logActivity(`Publication de l’annonce ${String(data.get("title")).trim()}`);
    toast("Annonce publiée.");
    await render();
  }

  async function saveTemplate(form) {
    const data = new FormData(form);
    unwrap(await state.client.from("notification_templates").update({
      subject: String(data.get("subject") || "").trim(),
      body: String(data.get("body") || "").trim(),
      enabled: data.get("enabled") === "on",
      updated_by: state.user.id,
      updated_at: new Date().toISOString()
    }).eq("id", form.dataset.template));
    await logActivity(`Modification du modèle de notification ${form.dataset.template}`);
    toast("Modèle de notification enregistré.");
  }

  async function saveProfile(form) {
    const data = new FormData(form);
    unwrap(await state.client.from("profiles").update({
      first_name: String(data.get("first_name")).trim(), last_name: String(data.get("last_name")).trim(),
      phone: String(data.get("phone")).trim()
    }).eq("id", state.user.id));
    await refreshProfile();
    closeModal();
    toast("Profil mis à jour.");
    await render();
  }

  async function saveStaffStudentInfo(form) {
    const data = new FormData(form);
    const enrollment = state.enrollments.find((item) => item.id === form.dataset.enrollment);
    unwrap(await state.client.from("enrollments").update({
      first_name: String(data.get("first_name")).trim(), last_name: String(data.get("last_name")).trim(),
      phone: String(data.get("phone")).trim(), email: String(data.get("email")).trim().toLowerCase(),
      birth_date: data.get("birth_date") || null, availability: String(data.get("availability") || "").trim(),
      address: String(data.get("address") || "").trim(), emergency_contact: String(data.get("emergency_contact") || "").trim()
    }).eq("id", enrollment.id));
    await logActivity(`Modification des coordonnées de ${enrollment.enrollment_number}`);
    toast("Coordonnées du dossier mises à jour.");
    await render();
  }

  async function handleSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const actions = {
        login: startLogin, signup: startSignup, enrollment: saveEnrollment,
        "change-status": changeStatus, payment: savePayment, "staff-document": uploadStaffDocument,
        "student-document": uploadStudentDocument, course: saveCourse, session: saveSession,
        resource: saveResource, announcement: saveAnnouncement, profile: saveProfile, template: saveTemplate,
        "staff-student-info": saveStaffStudentInfo
      };
      if (form.dataset.form === "user-role") {
        const data = new FormData(form);
        unwrap(await state.client.rpc("admin_set_user_role", { target_user_id: form.dataset.user, new_role: data.get("role") }));
        toast("Rôle mis à jour.");
        await render();
        return;
      }
      const action = actions[form.dataset.form];
      if (!action) throw new Error("Cette opération n’est pas disponible.");
      await action(form);
    } catch (error) {
      toast(errorText(error), true);
    } finally {
      if (submit?.isConnected) submit.disabled = false;
    }
  }

  async function handleClick(event) {
    const control = event.target.closest("[data-action]");
    if (!control) return;
    const action = control.dataset.action;
    try {
      if (action === "close-modal") closeModal();
      else if (action === "backdrop-close" && event.target === control) closeModal();
      else if (action === "account") state.user ? showProfileModal() : openAuthModal();
      else if (action === "auth-mode") openAuthModal(control.dataset.mode);
      else if (action === "reset-password") {
        const email = modalRoot.querySelector('[name="email"]')?.value?.trim();
        if (!email) throw new Error("Saisissez d’abord votre adresse e-mail.");
        unwrap(await state.client.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}${location.pathname}` }));
        toast("Si cette adresse est connue, un lien de réinitialisation lui sera envoyé.");
      } else if (action === "navigate") {
        state.view = control.dataset.view;
        if (state.view === "catalog") await loadCourses();
        document.getElementById("sidebar").classList.remove("sidebar--open");
        await render();
      } else if (action === "category") {
        state.category = control.dataset.category;
        renderCatalog();
      } else if (action === "start-enrollment") {
        state.selectedCourse = control.dataset.course;
        if (!state.user) openAuthModal();
        else if (state.profile?.role === "student") await renderEnrollmentForm(state.selectedCourse);
        else if (isStaff()) await renderEnrollmentForm(state.selectedCourse, true);
        else throw new Error("Ce compte n’est pas autorisé à déposer une demande étudiant.");
      } else if (action === "staff-enrollment") {
        if (!state.courses.length) await loadCourses();
        state.view = "staff";
        await renderEnrollmentForm("", true);
      } else if (action === "toggle-course") {
        const course = state.courses.find((item) => item.id === control.dataset.course);
        unwrap(await state.client.from("courses").update({ active: course.active ? false : true }).eq("id", course.id));
        await logActivity(`${course.active ? "Désactivation" : "Activation"} de la formation ${course.name}`);
        state.courses = [];
        await render();
      } else if (action === "edit-course") showCourseModal(control.dataset.course || "");
      else if (action === "select-enrollment") {
        state.selectedEnrollment = control.dataset.enrollment;
        await render();
        document.getElementById("selected-enrollment")?.scrollIntoView({ behavior: "smooth" });
      } else if (action === "validate-payment") await validatePayment(control.dataset.payment);
      else if (action === "download-document") await downloadDocument(control.dataset.document);
      else if (action === "download-resource") await downloadResource(control.dataset.resource);
      else if (action === "receipt" || action === "receipt-staff") {
        const target = window.open("", "_blank");
        await printReceipt(control.dataset.payment, action === "receipt-staff", target);
      } else if (action === "print-attestation") {
        const target = window.open("", "_blank");
        await printAttestation(control.dataset.enrollment, target);
      }
      else if (action === "export-csv") exportEnrollments();
      else if (action === "print-badges") {
        const target = window.open("", "_blank");
        await printBadges(target);
      }
      else if (action === "edit-profile") showProfileModal();
      else if (action === "upload-student-document") {
        showModal("Ajouter une pièce justificative", "Le fichier sera associé à votre demande la plus récente.", `<form data-form="student-document"><div class="field"><label>Fichier (3 Mo maximum)</label><input class="input" type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf,.doc,.docx" required></div><div class="form-actions"><button class="button button--primary" type="submit">Téléverser</button></div></form>`);
      } else if (action === "scroll-to") document.getElementById(control.dataset.target)?.scrollIntoView({ behavior: "smooth" });
      else if (action === "scroll-catalog") document.getElementById("catalog-list")?.scrollIntoView({ behavior: "smooth" });
      else if (action === "retry") await render();
      else if (action === "toggle-menu") {
        const sidebar = document.getElementById("sidebar");
        sidebar.classList.toggle("sidebar--open");
        control.setAttribute("aria-expanded", String(sidebar.classList.contains("sidebar--open")));
      } else if (action === "signout") {
        unwrap(await state.client.auth.signOut());
        state.user = null; state.profile = null; state.view = "catalog";
        await render();
      }
    } catch (error) {
      toast(errorText(error), true);
    }
  }

  function exportEnrollments() {
    const rows = state.enrollments.map((item) => [
      item.enrollment_number, item.first_name, item.last_name, item.phone, item.email,
      item.courses?.name || "", item.status, item.created_at?.slice(0, 10) || ""
    ]);
    const escapeCell = (value) => {
      let text = String(value ?? "");
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const csv = [["N° inscription", "Prénom", "Nom", "Téléphone", "E-mail", "Formation", "Statut", "Date"], ...rows]
      .map((row) => row.map(escapeCell).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = `inscriptions-fbs-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    URL.revokeObjectURL(url);
  }

  function updateStaffFilters() {
    if (state.view !== "staff") return;
    const search = document.getElementById("staff-search");
    const course = document.getElementById("staff-course-filter");
    const status = document.getElementById("staff-status-filter");
    const dateFrom = document.getElementById("staff-date-from");
    const dateTo = document.getElementById("staff-date-to");
    if (!search || !course || !status || !dateFrom || !dateTo) return;
    state.filters = { search: search.value, course: course.value, status: status.value, dateFrom: dateFrom.value, dateTo: dateTo.value };
    const rows = state.enrollments.filter(enrollmentMatches);
    const body = view.querySelector("tbody");
    if (!body) return;
    body.innerHTML = rows.map((item) => {
      const hasPhoto = state.documents.some((doc) => doc.enrollment_id === item.id && doc.document_type === "photo");
      return `<tr><td>${escapeHtml(item.enrollment_number)}</td><td>${escapeHtml(`${item.first_name} ${item.last_name}`)}<small>${escapeHtml(item.phone)} · ${escapeHtml(item.email)}</small></td><td>${escapeHtml(item.courses?.name || "Formation")}</td><td>${dateLabel(item.created_at?.slice(0, 10))}</td><td><span class="pill">${escapeHtml(item.status)}</span></td><td><button class="button button--small" data-action="select-enrollment" data-enrollment="${item.id}" type="button">Ouvrir</button></td><td>${hasPhoto && item.status === "Inscrit" ? `<input type="checkbox" data-badge="${item.id}" aria-label="Sélectionner ${escapeHtml(item.first_name)} ${escapeHtml(item.last_name)}"${state.selectedBadges.has(item.id) ? " checked" : ""}>` : "—"}</td></tr>`;
    }).join("") || `<tr><td colspan="7">Aucun dossier correspondant.</td></tr>`;
  }

  function handleInput(event) {
    if (["staff-search", "staff-course-filter", "staff-status-filter", "staff-date-from", "staff-date-to"].includes(event.target.id)) updateStaffFilters();
    if (event.target.matches("[data-badge]")) {
      if (event.target.checked) {
        if (state.selectedBadges.size >= 9) {
          event.target.checked = false;
          toast("Sélectionnez neuf personnes au maximum.", true);
          return;
        }
        state.selectedBadges.add(event.target.dataset.badge);
      } else state.selectedBadges.delete(event.target.dataset.badge);
      const button = view.querySelector('[data-action="print-badges"]');
      if (button) button.disabled = state.selectedBadges.size !== 9;
    }
  }

  async function initialize() {
    if (!config?.url || !config?.publishableKey || !supabaseLib?.createClient) {
      view.innerHTML = `${heading("Configuration requise", "La connexion sécurisée à la base de données n’est pas disponible.")}${notice("Vérifiez la configuration Supabase et le chargement de la bibliothèque de connexion. Aucune donnée locale de démonstration n’est utilisée.", "red")}`;
      return;
    }
    state.client = supabaseLib.createClient(config.url, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    document.getElementById("current-year").textContent = new Date().getFullYear();
    document.addEventListener("click", handleClick);
    document.addEventListener("submit", handleSubmit);
    document.addEventListener("input", handleInput);
    document.addEventListener("change", handleInput);
    const result = await state.client.auth.getSession();
    if (result.error) throw result.error;
    state.user = result.data.session?.user || null;
    if (state.user) await refreshProfile();
    state.client.auth.onAuthStateChange((_event, session) => {
      state.user = session?.user || null;
      window.setTimeout(async () => {
        try {
          await refreshProfile();
          await render();
        } catch (error) {
          toast(errorText(error), true);
        }
      }, 0);
    });
    await loadCourses();
    await render();
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      const registration = await navigator.serviceWorker.register("service-worker.js");
      registration.update().catch((error) => console.error("Mise à jour PWA impossible :", error));
    }
  }

  initialize().catch((error) => {
    view.innerHTML = `${heading("Connexion impossible", "L’application n’a pas pu se connecter aux services du centre.")}${notice(escapeHtml(errorText(error)), "red")}<button class="button" type="button" data-action="retry">Réessayer</button>`;
  });



})();
