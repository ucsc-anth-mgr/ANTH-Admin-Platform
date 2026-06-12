// ============================================================
// Code.gs — Entry point, routing, and universal dispatcher
// ============================================================
// Reads the module registry via getModuleRegistry() (Sheet-backed).
// ============================================================

function doGet(e) {
  try {
    const user    = Session.getActiveUser().getEmail();
    const profile = Auth.getProfile(user);
    const page    = e.parameter.page || 'dashboard';

    // Unprovisioned (or deactivated) users see the registration screen,
    // not the portal — unless they're a super-admin (always provisioned).
    const provisioned = !!(profile && profile.active);
    if (!provisioned) {
      const reg = HtmlService.createTemplateFromFile('Register');
      reg.appTitle  = CONFIG.APP_TITLE;
      reg.brandNavy = CONFIG.BRAND.NAVY;
      reg.brandGold = CONFIG.BRAND.GOLD;
      reg.userEmail = user;
      reg.roles     = JSON.stringify(Auth.listRoles());
      return reg.evaluate()
        .setTitle(CONFIG.APP_TITLE + ' — Request access')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }

    const roles   = Auth.getRoles(user);
    const modules = Auth.getAuthorizedModules(roles);

    // Optional deep-link focus: a module key in `page` plus a record id in
    // `focus` (e.g. ?page=thesis&focus=THES_123) opens that module already
    // focused on the record. Generic — any module that reads window.__focus
    // can use it. sourceType is optional context for the module.
    const focus = e.parameter.focus
      ? { sourceType: e.parameter.focusType || '', sourceId: e.parameter.focus, taskId: '' }
      : null;

    // Tasks needing this user's attention, surfaced on the dashboard at
    // login. Failure here must never block login, so fall back to [].
    let tasks = [];
    try {
      tasks = Tasks.forUser(user, roles);
    } catch (taskErr) {
      Logger.log('doGet: Tasks.forUser failed (continuing with none): ' + taskErr);
    }

    const tmpl = HtmlService.createTemplateFromFile('Index');
    tmpl.appTitle   = CONFIG.APP_TITLE;
    tmpl.brandNavy  = CONFIG.BRAND.NAVY;
    tmpl.brandGold  = CONFIG.BRAND.GOLD;
    tmpl.userEmail  = user;
    tmpl.userName   = profile.name || user;
    tmpl.userRoles  = JSON.stringify(roles);
    tmpl.modules    = modules;
    tmpl.tasks      = JSON.stringify(tasks);
    tmpl.activePage = page;
    tmpl.initialFocus = JSON.stringify(focus);

    return tmpl.evaluate()
      .setTitle(CONFIG.APP_TITLE)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  } catch (err) {
    Logger.log('doGet error: ' + err);
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:2rem;color:#c0392b;">Error loading app: ' + err.message + '</p>'
    );
  }
}


function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


/**
 * Universal server-side dispatcher.
 * Validates module + authorization, delegates to the handler, audits.
 */
function dispatch(module, action, payload) {
  const user     = Session.getActiveUser().getEmail();
  const roles    = Auth.getRoles(user);
  const registry = getModuleRegistry();

  const modConfig = registry[module];
  if (!modConfig)            throw new Error('Unknown module: ' + module);
  if (!modConfig.enabled)    throw new Error('Module is disabled: ' + module);
  if (!Auth.isAuthorized(roles, modConfig.roles)) {
    throw new Error('Access denied to module: ' + module);
  }

  const handler = getModuleHandler(modConfig.handler);
  if (typeof handler[action] !== 'function') {
    throw new Error('Unknown action "' + action + '" on module "' + module + '"');
  }

  const result = handler[action](payload, user, roles);
  AuditLog.write({ user, module, action, payload, status: 'success' });
  return result;
}


/**
 * Self-registration endpoint, callable WITHOUT module authorization.
 * This is the one action an unprovisioned user is allowed to perform.
 * It only ever creates a pending request — it never grants access.
 */
function submitAccessRequest(payload) {
  const user = Session.getActiveUser().getEmail();
  const result = RequestManager.submitRequest(payload, user);
  AuditLog.write({ user: user, module: 'registration', action: 'submitRequest',
                   payload: payload, status: 'success' });
  return result;
}


/**
 * Returns the current user's open tasks (urgency-sorted), for the
 * dashboard to refresh in place without a full page reload. Resolves
 * the user from the session, like submitAccessRequest — it is NOT a
 * module action and does not go through dispatch (the dashboard is part
 * of the shell, not a registry module). Returns [] on any failure so the
 * dashboard degrades to "no tasks" rather than erroring.
 */
function getMyTasks() {
  try {
    const user  = Session.getActiveUser().getEmail();
    const roles = Auth.getRoles(user);
    return Tasks.forUser(user, roles);
  } catch (err) {
    Logger.log('getMyTasks failed: ' + err);
    return [];
  }
}


function getModuleHTML(moduleKey) {  const user     = Session.getActiveUser().getEmail();
  const roles    = Auth.getRoles(user);
  const registry = getModuleRegistry();

  const modConfig = registry[moduleKey];
  if (!modConfig)         throw new Error('Unknown module: ' + moduleKey);
  if (!modConfig.enabled) throw new Error('Module is disabled.');
  if (!Auth.isAuthorized(roles, modConfig.roles)) throw new Error('Access denied.');

  const tmpl = HtmlService.createTemplateFromFile(modConfig.include);
  tmpl.currentUser = user;
  tmpl.userRoles   = JSON.stringify(roles);
  return tmpl.evaluate().getContent();
}


/**
 * Maps handler names (strings from the registry) to code objects.
 * THIS is where a developer registers a new module's handler.
 * Adding a module to the Modules sheet without a matching entry
 * here will surface a friendly "handler not registered" warning
 * in the Module Manager.
 */
function getModuleHandler(name) {
  const handlers = {
    AdminModule:       AdminModule,
    SubmissionsModule: SubmissionsModule,
    UserManagerModule: UserManagerModule,
    ThesisModule:      ThesisModule,
    // HRModule:       HRModule,
  };
  if (!handlers[name]) throw new Error('Handler not found: ' + name);
  return handlers[name];
}


/**
 * Returns the list of handler names registered in code.
 * Used by the Module Manager to validate sheet entries.
 */
function getRegisteredHandlers() {
  return ['AdminModule', 'SubmissionsModule', 'UserManagerModule', 'ThesisModule'];
}


/**
 * EVENT LISTENER REGISTRY — append-only, mirrors getRegisteredHandlers().
 *
 * Maps an event name to the listeners that should run when EventBus.emit()
 * fires it. This is the ONE place listeners are wired. A new module reacts
 * to an existing event by ADDING an entry here — never by modifying the
 * module that emits the event. That is the loose-coupling contract.
 *
 * Shape:
 *   { 'event.name': [ { name: 'LabelForLogs', fn: SomeModule.someHandler }, ... ] }
 *
 * Each listener fn is called as fn(data, eventName, context), where context
 * carries { user } (the acting user) plus any ambient info the emitter added.
 * A listener that throws is logged and audited by EventBus, then skipped —
 * it can never break the action that emitted the event.
 *
 * Read lazily by EventBus on the first emit() of a request, so the order in
 * which .gs files are evaluated at load does not matter; every handler object
 * referenced below is fully defined by the time an emit() actually runs.
 *
 * The Thesis module now EMITS events (thesis.submitted, thesis.resubmitted,
 * thesis.sponsor_decided, thesis.honors_decided, thesis.returned,
 * thesis.completed), but nothing LISTENS yet — Thesis calls Tasks and Notify
 * directly. Add listener entries here when a future module needs to react to
 * a thesis event, without modifying the Thesis module. Examples:
 *
 *   return {
 *     'thesis.submitted': [
 *       { name: 'SomeModule:onThesisSubmitted', fn: SomeModule.onThesisSubmitted },
 *     ],
 *   };
 */
function getEventListeners() {
  return {
    // (append event -> listener entries here as modules ship)
  };
}

function testCertificateRender() {
  const me = Session.getActiveUser().getEmail();
  const out = ThesisReports.issueCertificate({
    ThesisID:        'TEST-CERT-003',
    StudentEmail:    'anthwork@ucsc.edu',
    SponsorEmail:    'fdeakin@ucsc.edu',
    SponsorDecision: 'Pass',
    SponsorDecidedBy: 'fdeakin@ucsc.edu',
    SponsorDecidedAt: new Date(),
    Quarter: 'Spring',
    Year:    '2026',
    Title:   'LAYOUT TEST v2 — title passed through verbatim',
  }, { force: true });
  Logger.log(JSON.stringify(out));
}