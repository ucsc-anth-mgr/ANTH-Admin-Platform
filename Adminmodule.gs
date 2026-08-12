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
  // The FULL list of handler names registered in code — for validating a
  // module row's Handler value. Distinct from availableHandlers(), which
  // returns only the registered handlers NOT yet configured in the sheet
  // (i.e. available to add). Validating against availableHandlers() falsely
  // warns on every already-configured module; validation must use this.
  function registeredHandlers()      { return getRegisteredHandlers(); }
  function upsertModule(p)           { return ModuleManager.upsert(p); }
  function setModuleEnabled(p)       { return ModuleManager.setEnabled(p.key, p.enabled); }
  function removeModule(p)           { return ModuleManager.remove(p.key); }

  // ── Tab visibility (per-module, per-role — TabRegistry) ────
  // Which roles see each tab inside a module. Backed by the ModuleTabs
  // sheet; defaults come from each handler's code-declared TABS manifest.
  // VISIBILITY ONLY — every action keeps its own permission check in its
  // handler regardless of tab configuration.
  function listModuleTabs(p)         { return TabRegistry.listForModule(String((p || {}).key || '')); }
  function saveModuleTabs(p)         { p = p || {}; return TabRegistry.saveForModule(p.key, p.tabs); }

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

  // ── Notification addresses (per-module, platform Settings store) ───────
  // The reply-to and CC addresses applied to a module's notification
  // emails. One row per ENABLED module, read from the registry so any
  // future module gets both settings with no extra wiring. Reply-to falls
  // back to CONFIG.DEFAULT_REPLY_TO at send time (surfaced here as
  // `defaultReplyTo` so the panel can show the effective fallback); CC has
  // NO fallback — unset means no CC. Backed by Settings.gs.

  // A module whose audiences need different addresses declares a CHANNELS
  // manifest on its handler ([{ key, label }], like TABS) — e.g. Individual
  // Studies' undergraduate vs graduate petitions. Each channel gets its own
  // reply-to + CC row here; a module with no manifest implicitly has just
  // 'default' (the bare 'replyTo'/'cc' keys — existing config untouched).
  // Named channels store 'replyTo:<channel>' / 'cc:<channel>'. Resolution
  // at send time (Settings.gs): reply-to cascades channel → module default
  // → platform default; CC deliberately does NOT cascade across channels.

  /** Storage key for (base, channel): bare key for 'default', 'base:channel' otherwise. */
  function _channelSettingKey(base, channel) {
    return (!channel || channel === 'default') ? base : (base + ':' + channel);
  }

  /**
   * The CHANNELS manifest of a module's handler, normalized — mirrors
   * TabRegistry.manifest(). Always returns at least [{ key:'default' }];
   * never throws (a broken manifest degrades to the single default
   * channel). Channel keys must be simple tokens: the ':' separator,
   * whitespace, and quotes are rejected; duplicates are dropped; 'default'
   * is added first when the manifest omits it.
   * @param {Object} modEntry - a getModuleRegistry() entry
   * @returns {Array<{key:string,label:string}>}
   */
  function _channelManifest(modEntry) {
    const DEFAULT_ONLY = [{ key: 'default', label: '' }];
    try {
      const handler = getModuleHandler(modEntry && modEntry.handler);
      const raw = handler && handler.CHANNELS;
      if (!Array.isArray(raw)) return DEFAULT_ONLY;
      const seen = {};
      const channels = raw
        .filter(c => c && String(c.key || '').trim())
        .map(c => ({ key: String(c.key).trim(), label: String(c.label || '').trim() }))
        .filter(c => !/[:\s'"]/.test(c.key))
        .filter(c => (seen[c.key] ? false : (seen[c.key] = true)));
      if (!channels.length) return DEFAULT_ONLY;
      if (!channels.some(c => c.key === 'default')) channels.unshift({ key: 'default', label: '' });
      return channels;
    } catch (e) {
      Logger.log('AdminModule._channelManifest failed: ' + e);
      return DEFAULT_ONLY;
    }
  }

  /**
   * Returns the per-module notification-address configuration for the panel:
   *   { defaultReplyTo,
   *     modules: [{ key, label,
   *                 channels: [{ channel, channelLabel, replyTo, cc }] }] }
   * `replyTo` and `cc` are the CONFIGURED values ('' when unset), per
   * channel. Single-channel modules carry one 'default' entry, so the
   * panel renders them exactly as before. `modules` lists every ENABLED
   * module from the registry, ordered by its menu order.
   */
  function getModuleReplyTos() {
    const registry = getModuleRegistry();
    const modules = Object.keys(registry)
      .filter(key => registry[key] && registry[key].enabled)
      .map(key => ({
        key: key,
        label: (registry[key].label || key),
        order: (registry[key].order != null ? registry[key].order : 99),
        channels: _channelManifest(registry[key]).map(c => ({
          channel: c.key,
          channelLabel: c.label,
          replyTo: Settings.get(key, _channelSettingKey('replyTo', c.key), ''),
          cc: Settings.get(key, _channelSettingKey('cc', c.key), ''),
        })),
      }))
      .sort((a, b) => (a.order - b.order) || String(a.label).localeCompare(String(b.label)))
      .map(m => ({ key: m.key, label: m.label, channels: m.channels }));

    return {
      defaultReplyTo: (CONFIG && CONFIG.DEFAULT_REPLY_TO) || '',
      modules: modules,
    };
  }

  /**
   * Sets (or clears) a module's notification reply-to address. A blank value
   * clears the setting, so the module falls back to CONFIG.DEFAULT_REPLY_TO
   * (for a named channel: to the module's default-channel value first). A
   * non-blank value must be a valid email address (rejected otherwise, so a
   * typo can't silently route replies to the fallback). The module key must
   * be a real, enabled module in the registry; the channel (optional,
   * ''/'default' = the module's main address) must be declared in the
   * handler's CHANNELS manifest.
   * @param {Object} p - { key, replyTo, [channel] }
   * @returns {{ key, channel, replyTo, effective }}
   */
  function saveModuleReplyTo(p) {
    p = p || {};
    const key = String(p.key || '').trim();
    if (!key) throw new Error('Module key is required.');

    const registry = getModuleRegistry();
    if (!registry[key]) throw new Error('Unknown module: ' + key);

    const channel = String(p.channel == null ? '' : p.channel).trim() || 'default';
    if (!_channelManifest(registry[key]).some(c => c.key === channel)) {
      throw new Error('Unknown notification channel for ' + key + ': ' + channel);
    }

    const value = String(p.replyTo == null ? '' : p.replyTo).trim();
    if (value && !Utils.isValidEmail(value)) {
      throw new Error('"' + value + '" is not a valid email address.');
    }

    Settings.set(key, _channelSettingKey('replyTo', channel), value);
    const effective = Settings.replyTo(key, channel);
    return { key: key, channel: channel, replyTo: value, effective: effective };
  }

  /**
   * Sets (or clears) a module's notification CC address list. A blank value
   * clears the setting — no CC (there is deliberately no platform fallback,
   * unlike reply-to, and a named channel's CC never falls back to the
   * module's default-channel CC either). A non-blank value may hold
   * MULTIPLE comma- or semicolon-separated addresses; each is validated
   * individually (rejected on any invalid entry, so a typo can't silently
   * drop the mirror), then stored normalized as a comma-joined list. The
   * module key must be a real, enabled module in the registry; the channel
   * (optional, ''/'default' = the module's main list) must be declared in
   * the handler's CHANNELS manifest.
   * @param {Object} p - { key, cc, [channel] }
   * @returns {{ key, channel, cc }}
   */
  function saveModuleCc(p) {
    p = p || {};
    const key = String(p.key || '').trim();
    if (!key) throw new Error('Module key is required.');

    const registry = getModuleRegistry();
    if (!registry[key]) throw new Error('Unknown module: ' + key);

    const channel = String(p.channel == null ? '' : p.channel).trim() || 'default';
    if (!_channelManifest(registry[key]).some(c => c.key === channel)) {
      throw new Error('Unknown notification channel for ' + key + ': ' + channel);
    }

    const raw = String(p.cc == null ? '' : p.cc).trim();
    const addresses = raw.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    addresses.forEach(a => {
      if (!Utils.isValidEmail(a)) {
        throw new Error('"' + a + '" is not a valid email address.');
      }
    });

    const value = addresses.join(', ');
    Settings.set(key, _channelSettingKey('cc', channel), value);
    return { key: key, channel: channel, cc: value };
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
    listModules, availableHandlers, registeredHandlers, upsertModule, setModuleEnabled, removeModule, iconChoices,
    listModuleTabs, saveModuleTabs,
    listRolesDetailed, upsertRole, removeRole, roleUsage,
    listPendingRequests, listAllRequests, approveRequest, rejectRequest,
    listImportPolicy, upsertImportPolicy, removeImportPolicy,
    listNotifyRules, upsertNotifyRule, removeNotifyRule,
    getNotifySettings, saveNotifySettings,
    getModuleReplyTos, saveModuleReplyTo, saveModuleCc,
  };

})();