// ============================================================
// Code.gs — Entry point, routing, and universal dispatcher
// ============================================================
// Reads the module registry via getModuleRegistry() (Sheet-backed).
// ============================================================


// ── Output-encoding helpers ───────────────────────────────────
// Two small utilities used by doGet/getModuleHTML. Both are global so
// templates can call them directly if a module ever needs to.

/**
 * Serializes a value for safe injection into a <script> block via <?!= ?>.
 * JSON.stringify does NOT escape '<', so a value containing "</script>"
 * would close the block early and let the rest run as markup. U+2028 and
 * U+2029 are valid JSON but illegal raw in JS source. Use this everywhere
 * JSON reaches a template — most importantly for anything derived from a
 * URL parameter (see initialFocus below).
 */
function jsonForScript(obj) {
  return JSON.stringify(obj === undefined ? null : obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}


/** HTML-escapes a value for inclusion in server-rendered markup. */
function escapeHtmlForPage(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


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
      reg.roles     = jsonForScript(Auth.listRoles());
      return reg.evaluate()
        .setTitle(CONFIG.APP_TITLE + ' — Request access')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1')
        // DEFAULT restricts framing to Google's own origins, which is all
        // Apps Script's nested userCodeAppPanel frame needs. ALLOWALL would
        // let any site frame the portal and clickjack a logged-in user into
        // one-click actions (complete, return, delete) that run with their
        // real roles. Nothing embeds this portal — it is linked to, never
        // iframed — so there is no reason to allow it.
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
    }

    const roles   = Auth.getRoles(user);
    const modules = Auth.getAuthorizedModules(roles);

    // Optional deep-link focus: a module key in `page` plus a record id in
    // `focus` (e.g. ?page=thesis&focus=THES_123) opens that module already
    // focused on the record. Generic — any module that reads window.__focus
    // can use it. sourceType is optional context for the module.
    //
    // NOTE: this is the one template value built from raw URL parameters,
    // so it is the one that most needs jsonForScript() below.
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
    tmpl.userRoles  = jsonForScript(roles);
    tmpl.modules    = modules;
    tmpl.tasks      = jsonForScript(tasks);
    tmpl.activePage = page;
    tmpl.initialFocus = jsonForScript(focus);
    // Public base URL for client-side deep-link cards (Links.gs is the
    // server-side equivalent). Blank when CONFIG.PUBLIC_BASE_URL is unset.
    tmpl.publicBaseUrl = CONFIG.PUBLIC_BASE_URL || '';

    return tmpl.evaluate()
      .setTitle(CONFIG.APP_TITLE)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      // DEFAULT — see the framing note in the registration branch above.
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);

  } catch (err) {
    // The detail goes to the log, NOT to the page: this branch renders for
    // unauthenticated/unprovisioned visitors, and err.message was both an
    // injection sink and an information leak. While developing you can
    // swap in escapeHtmlForPage(err.message) to see the real error.
    Logger.log('doGet error: ' + err);
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:2rem;color:#c0392b;">' +
      'Sorry — the portal could not load. Please try again, and contact the ' +
      'department administrator if this continues.</p>'
    );
  }
}


function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


/**
 * Universal server-side dispatcher.
 * Validates module + authorization, delegates to the handler, audits.
 *
 * Audit status is tri-state:
 *   'success' — handler returned normally
 *   'denied'  — refused before the handler ran (unknown/disabled module,
 *               failed role check, unregistered handler, unknown action)
 *   'error'   — handler ran and threw
 * Previously only 'success' was written, so every refusal was invisible.
 *
 * ASYNC-AWARE: dispatch is async and AWAITS the handler's result. This is
 * required for the async actions (IndividualStudiesModule.advisorComplete /
 * gradAdvisorComplete, which await pdf-lib PDF generation): without the
 * await, dispatch received a pending Promise, audited 'success', and
 * returned — Apps Script finalized the execution before the post-await
 * code (the DocumentLink write, Drive viewer grants, and the completion
 * email with its PDF attachment) ever ran. For the synchronous handlers
 * (everything else), awaiting a plain value is a no-op, so behavior is
 * unchanged. Two consequences worth knowing:
 *   - The 'success' audit row is now written AFTER the work finishes
 *     (a few seconds later for PDF actions) and never records a Promise.
 *   - A rejected Promise lands in the catch below and is audited as
 *     'error' with its real message, same as a synchronous throw.
 * google.script.run resolves the Promise dispatch returns, so the client
 * success callback receives the resolved value as before.
 */
async function dispatch(module, action, payload) {
  const user     = Session.getActiveUser().getEmail();
  const roles    = Auth.getRoles(user);
  const registry = getModuleRegistry();

  // Audits the refusal, then throws. Every early exit goes through here.
  function _deny(msg) {
    AuditLog.write({ user: user, module: module, action: action,
                     payload: payload, status: 'denied', notes: msg });
    throw new Error(msg);
  }

  const modConfig = registry[module];
  if (!modConfig)         _deny('Unknown module: ' + module);
  if (!modConfig.enabled) _deny('Module is disabled: ' + module);
  if (!Auth.isAuthorized(roles, modConfig.roles)) {
    _deny('Access denied to module: ' + module);
  }

  let handler;
  try {
    handler = getModuleHandler(modConfig.handler);
  } catch (err) {
    // Registry names a handler that isn't wired in getModuleHandler().
    // Reported as a denial rather than surfacing the raw lookup error.
    _deny('Handler not registered for module "' + module + '": ' + modConfig.handler);
  }

  if (typeof handler[action] !== 'function') {
    _deny('Unknown action "' + action + '" on module "' + module + '"');
  }

  // Per-action authorization (ActionPolicy.gs). Module entry answered
  // "may they open the module"; this answers "may they invoke THIS
  // action". Shadow mode logs would_deny and proceeds; enforce denies.
  const policyMode = ActionPolicy.mode();
  if (policyMode !== 'off') {
    const verdict = ActionPolicy.check(handler, action, roles);
    if (!verdict.allowed) {
      if (policyMode === 'enforce') {
        _deny('Action not permitted: ' + module + '.' + action);
      }
      // shadow: record what enforcement WOULD have blocked, with enough
      // context (roles + reason) to fix the declaration or confirm the
      // hole, then let the call proceed unchanged.
      AuditLog.write({ user: user, module: module, action: action,
                       payload: payload, status: 'would_deny',
                       notes: verdict.reason + ' | roles: ' + roles.join(',') });
    }
  }

  let result;
  try {
    result = await handler[action](payload, user, roles);
  } catch (err) {
    AuditLog.write({ user: user, module: module, action: action,
                     payload: payload, status: 'error',
                     notes: String((err && err.message) || err) });
    throw err;   // rethrow unchanged — the client still sees the real message
  }

  AuditLog.write({ user: user, module: module, action: action,
                   payload: payload, status: 'success' });
  return result;
}


/**
 * Self-registration endpoint, callable WITHOUT module authorization.
 * This is the one action an unprovisioned user is allowed to perform.
 * It only ever creates a pending request — it never grants access.
 *
 * Because it is the one endpoint reachable by an unprovisioned caller,
 * its failures are audited too: repeated errors here are the signal you
 * would want if someone were probing it.
 */
function submitAccessRequest(payload) {
  const user = Session.getActiveUser().getEmail();
  try {
    const result = RequestManager.submitRequest(payload, user);
    AuditLog.write({ user: user, module: 'registration', action: 'submitRequest',
                     payload: payload, status: 'success' });
    return result;
  } catch (err) {
    AuditLog.write({ user: user, module: 'registration', action: 'submitRequest',
                     payload: payload, status: 'error',
                     notes: String((err && err.message) || err) });
    throw err;
  }
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


/**
 * Serves a module's HTML partial. This is a SECOND gateway alongside
 * dispatch() — it performs its own registry lookup and role check, and
 * is directly callable from the client via google.script.run.
 *
 * NOTE: deliberately NOT audited. It fires on every module load, so
 * logging it would add one audit row per navigation click. If you later
 * want visibility into denied template loads specifically, log only the
 * failure branches rather than every call.
 */
function getModuleHTML(moduleKey) {
  const user     = Session.getActiveUser().getEmail();
  const roles    = Auth.getRoles(user);
  const registry = getModuleRegistry();

  const modConfig = registry[moduleKey];
  if (!modConfig)         throw new Error('Unknown module: ' + moduleKey);
  if (!modConfig.enabled) throw new Error('Module is disabled.');
  if (!Auth.isAuthorized(roles, modConfig.roles)) throw new Error('Access denied.');

  const tmpl = HtmlService.createTemplateFromFile(modConfig.include);
  tmpl.currentUser = user;
  tmpl.userRoles   = jsonForScript(roles);
  // Per-role tab visibility (TabRegistry): the resolved tab list for THIS
  // user, as JSON, for converted templates to loop over with <?!= ?>.
  // A module whose handler declares no TABS manifest gets '[]' and simply
  // never references the variable — unconverted modules are unaffected.
  try {
    tmpl.visibleTabs = jsonForScript(TabRegistry.visibleTabs(moduleKey, roles));
  } catch (e) {
    tmpl.visibleTabs = '[]';
  }
  return tmpl.evaluate().getContent();
}


/**
 * Maps handler names (strings from the registry) to code objects.
 * THIS is where a developer registers a new module's handler.
 * Adding a module to the Modules sheet without a matching entry
 * here will surface a friendly "handler not registered" warning
 * in the Module Manager.
 *
 * NOTE: CalendarModule is registered ACTIVE below — the files
 * Calendarservice.gs and Calendarmodule.gs must be in the project
 * BEFORE this Code.gs is saved, or the app fails with
 * "CalendarModule is not defined".
 *
 * NOTE: CourseworkPetitionModule is likewise ACTIVE — save
 * CourseworkPetitionModule.gs (and coursework_petition.html) BEFORE
 * saving this Code.gs, or the app fails with
 * "CourseworkPetitionModule is not defined".
 */
function getModuleHandler(name) {
  const handlers = {
    AdminModule:       AdminModule,
    SubmissionsModule: SubmissionsModule,
    UserManagerModule: UserManagerModule,
    ThesisModule:      ThesisModule,
    TranscriptModule:  TranscriptModule,
    IndividualStudiesModule: IndividualStudiesModule,
    PersonnelModule:   PersonnelModule,
    ServiceModule:     ServiceModule,
    CalendarModule:    CalendarModule,
    CourseworkPetitionModule: CourseworkPetitionModule,
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
  return ['AdminModule', 'SubmissionsModule', 'UserManagerModule', 'ThesisModule', 'TranscriptModule', 'IndividualStudiesModule', 'PersonnelModule', 'ServiceModule', 'CalendarModule', 'CourseworkPetitionModule'];
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
 * A listener that throws is logged/audited and skipped — it can never break
 * the action that emitted the event.
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


/**
 * SCHEDULED JOB REGISTRY — append-only, mirrors getEventListeners().
 *
 * Maps a frequency to the jobs the Scheduler service runs on that
 * cadence. This is the ONE place recurring jobs are wired. A module adds
 * a scheduled job by ADDING an entry here — never by creating its own
 * trigger. The platform installs a single trigger per frequency
 * (installScheduledTriggers(), run once from the editor) that fans out
 * to every job registered below.
 *
 * Shape:
 *   { daily: [ { name: 'LabelForLogs', fn: SomeModule.someDailyJob }, ... ] }
 *
 * Each job fn is called as fn(context), where context carries
 * { frequency, runAt }. A job that throws is logged and audited by
 * Scheduler, then skipped — it can never break the other jobs.
 *
 * Read lazily by Scheduler on run (NOT at file-load time), so .gs
 * evaluation order does not matter; every handler object referenced
 * below is fully defined by the time a run actually happens.
 *
 * Supported frequencies are Scheduler.FREQUENCIES (currently: daily).
 * Example:
 *
 *   return {
 *     daily: [
 *       { name: 'Transcript:dailyDigest', fn: TranscriptModule.dailyDigest },
 *     ],
 *   };
 */
function getScheduledJobs() {
  return {
    daily: [
      { name: 'Transcript:dailyDigest', fn: TranscriptModule.dailyDigest },
      // Calendar Phase 2: nightly import-source refresh. Fetches each
      // enabled source, diffs against imported deadlines (honoring pins),
      // writes the pending review queue, and creates a staff-pool Task
      // when there is something to review. Never auto-commits.
      { name: 'Calendar:nightlyRefresh', fn: CalendarModule.nightlyRefresh },
    ],
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

function debugAnthworkTasks() {
  Logger.log(JSON.stringify(Tasks.forUser('anthwork@ucsc.edu', Auth.getRoles('anthwork@ucsc.edu')), null, 2));
}


/**
 * DEBUG (temporary — delete once the PDF flow is confirmed): fills the
 * graduate petition AcroForm directly, bypassing dispatch and the module,
 * to isolate the PDF mechanism. Run from the editor (select debugGradFill
 * in the function dropdown, press Run) and read the log:
 *   "RESULT: fileId=… url=…"  → the mechanism works end to end
 *   an error                  → the exact reason PDF generation fails
 */
async function debugGradFill() {
  const out = await ReportService.fillTemplate({
    module: 'individual_studies',
    reportKey: 'debug',
    title: 'Debug grad fill',
    templateFileId: CONFIG.GRAD_INDIVIDUAL_STUDIES.TEMPLATE_FILE_ID,
    values: { Course: '299B', Quarter: 'Fall', Year: '2026' },
    fileName: 'debug-grad-fill.pdf',
  }, Session.getActiveUser().getEmail());
  Logger.log('RESULT: fileId=' + out.fileId + ' url=' + out.url);
}

function debugTemplateBytes() {
  const f = DriveApp.getFileById(CONFIG.GRAD_INDIVIDUAL_STUDIES.TEMPLATE_FILE_ID);
  const b = f.getBlob();
  Logger.log(f.getName() + ' | mime=' + f.getMimeType() +
    ' | firstBytes=' + b.getBytes().slice(0, 5).join(','));
}