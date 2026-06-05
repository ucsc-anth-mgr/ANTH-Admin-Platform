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

    const tmpl = HtmlService.createTemplateFromFile('Index');
    tmpl.appTitle   = CONFIG.APP_TITLE;
    tmpl.brandNavy  = CONFIG.BRAND.NAVY;
    tmpl.brandGold  = CONFIG.BRAND.GOLD;
    tmpl.userEmail  = user;
    tmpl.userName   = profile.name || user;
    tmpl.userRoles  = JSON.stringify(roles);
    tmpl.modules    = modules;
    tmpl.activePage = page;

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
    // ThesisModule:   ThesisModule,   // add back when ThesisModule.gs is deployed
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
  return ['AdminModule', 'SubmissionsModule', 'UserManagerModule'];  // add 'ThesisModule' when its file is deployed
}