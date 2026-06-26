// ============================================================
// AdminModule.gs — Admin module server side (v2)
// ============================================================
// Adds Module Manager actions on top of user/role/audit management.
// ============================================================

const AdminModule = (() => {

  // ── Users & roles ──────────────────────────────────────────
  function listUsers()        { return Auth.listUsers(); }
  function listRoles()        { return Auth.listRoles(); }
  function upsertUser(p) {
    if (!p.email) throw new Error('Email is required.');
    return Auth.upsertUser({
      email:    p.email,
      firstName: p.firstName,
      lastName:  p.lastName,
      roles:    Array.isArray(p.roles) ? p.roles : [p.roles],
      studentId:  p.studentId,
      employeeId: p.employeeId,
      active:   p.active,
      notes:    p.notes,
    });
  }

  // ── Audit ──────────────────────────────────────────────────
  function recentAudit()      { return AuditLog.recent(50); }

  // ── Module Manager ─────────────────────────────────────────
  function listModules()             { return ModuleManager.list(); }
  function availableHandlers()       { return ModuleManager.availableHandlers(); }
  function upsertModule(p)           { return ModuleManager.upsert(p); }
  function setModuleEnabled(p)       { return ModuleManager.setEnabled(p.key, p.enabled); }
  function removeModule(p)           { return ModuleManager.remove(p.key); }

  // ── Roles Manager ──────────────────────────────────────────
  function listRolesDetailed()       { return RolesManager.list(); }
  function upsertRole(p)             { return RolesManager.upsert(p); }
  function removeRole(p)             { return RolesManager.remove(p); }
  function roleUsage(p)              { return RolesManager.usageDetail(p); }

  // ── Access Requests (self-registration) ────────────────────
  function listPendingRequests()     { return RequestManager.listPending(); }
  function listAllRequests()         { return RequestManager.listAll(); }
  function approveRequest(p, user)   { return RequestManager.approve(p, user); }
  function rejectRequest(p, user)    { return RequestManager.reject(p, user); }

  // ── Import policy governance (super-admin manages who may import) ──
  function listImportPolicy()        { return ImportPolicy.list(); }
  function upsertImportPolicy(p)     { return ImportPolicy.upsert(p); }
  function removeImportPolicy(p)     { return ImportPolicy.remove(p); }

  // ── Request notification rules ─────────────────────────────
  function listNotifyRules()         { return NotifyRules.list(); }
  function upsertNotifyRule(p)       { return NotifyRules.upsert(p); }
  function removeNotifyRule(p)       { return NotifyRules.remove(p); }
  function getNotifySettings()       { return NotifyRules.getSettings(); }
  function saveNotifySettings(p)     { return NotifyRules.saveSettings(p); }

  // ── Thesis operational settings ────────────────────────────
  // MOVED: thesis NOTIFY_ON_HANDOFF / SEND_CERTIFICATE settings are now owned
  // by the Thesis module itself (thesis.getSettings / thesis.saveSettings,
  // gated advisor + super_admin), surfaced in a Settings tab inside that
  // module — mirroring how the Transcript module owns its own settings. The
  // backing ThesisSettings store is unchanged; only the UI/dispatch path
  // moved out of Admin. Sponsor/reader and individual-studies sponsor
  // eligibility remain plain identity ROLES assigned per-user in
  // Admin → Users (thesis_sponsor, thesis_reader, individual_studies_sponsor),
  // read directly by the consuming modules via Auth.usersWithRole().

  // ── Notification reply-to (per-module, platform Settings store) ────────
  // The reply-to address applied to a module's notification emails. One
  // field per ENABLED module, read from the registry so any future module
  // gets a reply-to setting with no extra wiring. An unset module falls back
  // to CONFIG.DEFAULT_REPLY_TO at send time (surfaced here as `defaultReplyTo`
  // so the panel can show the effective fallback). Backed by Settings.gs.

  /**
   * Returns the per-module reply-to configuration for the panel:
   *   { defaultReplyTo, modules: [{ key, label, replyTo }] }
   * `replyTo` is the module's configured value ('' when unset). `modules`
   * lists every ENABLED module from the registry, ordered by its menu order.
   */
  function getModuleReplyTos() {
    const registry = getModuleRegistry();
    const modules = Object.keys(registry)
      .filter(key => registry[key] && registry[key].enabled)
      .map(key => ({
        key: key,
        label: (registry[key].label || key),
        order: (registry[key].order != null ? registry[key].order : 99),
        replyTo: Settings.get(key, 'replyTo', ''),
      }))
      .sort((a, b) => (a.order - b.order) || String(a.label).localeCompare(String(b.label)))
      .map(m => ({ key: m.key, label: m.label, replyTo: m.replyTo }));

    return {
      defaultReplyTo: (CONFIG && CONFIG.DEFAULT_REPLY_TO) || '',
      modules: modules,
    };
  }

  /**
   * Sets (or clears) a module's notification reply-to address. A blank value
   * clears the setting, so the module falls back to CONFIG.DEFAULT_REPLY_TO.
   * A non-blank value must be a valid email address (rejected otherwise, so a
   * typo can't silently route replies to the fallback). The module key must
   * be a real, enabled module in the registry.
   * @param {Object} p - { key, replyTo }
   * @returns {{ key, replyTo, effective }}
   */
  function saveModuleReplyTo(p) {
    p = p || {};
    const key = String(p.key || '').trim();
    if (!key) throw new Error('Module key is required.');

    const registry = getModuleRegistry();
    if (!registry[key]) throw new Error('Unknown module: ' + key);

    const value = String(p.replyTo == null ? '' : p.replyTo).trim();
    if (value && !Utils.isValidEmail(value)) {
      throw new Error('"' + value + '" is not a valid email address.');
    }

    Settings.set(key, 'replyTo', value);
    const effective = value || ((CONFIG && CONFIG.DEFAULT_REPLY_TO) || '');
    return { key: key, replyTo: value, effective: effective };
  }

  // Icons offered in the picker (Tabler outline names)
  function iconChoices() {
    return [
      'ti-settings','ti-file-text','ti-users','ti-user','ti-folder','ti-calendar',
      'ti-clipboard','ti-chart-bar','ti-mail','ti-bell','ti-book','ti-school',
      'ti-certificate','ti-briefcase','ti-building','ti-cash','ti-checklist',
      'ti-clipboard-check','ti-id','ti-license','ti-notebook','ti-presentation',
    ];
  }

  return {
    listUsers, listRoles, upsertUser, recentAudit,
    listModules, availableHandlers, upsertModule, setModuleEnabled, removeModule, iconChoices,
    listRolesDetailed, upsertRole, removeRole, roleUsage,
    listPendingRequests, listAllRequests, approveRequest, rejectRequest,
    listImportPolicy, upsertImportPolicy, removeImportPolicy,
    listNotifyRules, upsertNotifyRule, removeNotifyRule,
    getNotifySettings, saveNotifySettings,
    getModuleReplyTos, saveModuleReplyTo,
  };

})();