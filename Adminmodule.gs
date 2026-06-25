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
  // NOTE: sponsor/reader and individual-studies sponsor eligibility are now
  // plain identity ROLES (thesis_sponsor, thesis_reader,
  // individual_studies_sponsor) assigned per-user in Admin → Users. There is
  // no separate eligibility roster here anymore — the consuming modules read
  // the roles directly via Auth.usersWithRole().
  function getThesisSettings()       { return ThesisSettings.get(); }
  function saveThesisSettings(p)     { return ThesisSettings.save(p); }

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
    getThesisSettings, saveThesisSettings,
  };

})();