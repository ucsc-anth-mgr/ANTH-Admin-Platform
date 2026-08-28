// ============================================================
// TestMode.gs — Platform test-mode service
// ============================================================
// Lets an authorized functional/test account walk a real workflow
// end-to-end without bothering real faculty or staff:
//
//   1. SUBSTITUTION AT WRITE TIME (the mechanism). The tester uses the
//      real selection UI (real sponsor dropdown, real PersonMatch), but
//      when the handler WRITES an assignee, TestMode.substitute() swaps
//      in the mapped functional account. From then on the record
//      GENUINELY routes to the functional account — tasks, mail, and
//      per-record permission checks all work with ZERO special cases,
//      because the record honestly says who the sponsor is. No test
//      logic ever touches a permission check.
//
//   2. MAIL POLICY (the backstop): DELIVER IF SAFE, REDIRECT IF NOT.
//      While a test execution is active, Notify hands every outbound
//      message to interceptMail. Mail whose recipients are ALL
//      test-safe (the tester, rostered accounts, mapped slot accounts)
//      is DELIVERED AS ADDRESSED with a [TEST] subject prefix — the
//      slot account's inbox sees exactly what a real sponsor's would.
//      Any unsafe recipient is STRIPPED, with the tester added and the
//      strip noted in the body; mail with no safe recipient at all is
//      fully redirected to the tester (role-pool notices, facilities
//      mail, CC mirrors — anything without a slot). If the tester
//      can't be determined, mail is DROPPED, never sent to real
//      people.
//
//   3. THE FLAG TRAVELS WITH THE RECORD. The submitting UI's checkbox
//      sends _test:true in the dispatch payload; the handler stamps
//      TestMode='TRUE' on the record. Later stages re-activate either
//      from the client re-attaching _test:true, or — belt and
//      suspenders — from the handler calling activateForRecord(rec)
//      after loading a record whose TestMode column is TRUE.
//
// SLOT MODEL — modules declare WORKFLOW POSITIONS, not roles:
//
//   const IndividualStudiesModule = (() => {
//     const TEST_SLOTS = [
//       { key: 'sponsor', label: 'Faculty Sponsor',
//         defaultRole: 'senate_faculty' },
//       { key: 'advisor', label: 'Undergraduate Advisor',
//         defaultRole: 'staff' },
//     ];
//     ...
//     return { TEST_SLOTS: TEST_SLOTS, submit: submit, ... };
//   })();
//
//   Code declares WHAT slots exist (structural, lives with the
//   workflow); the Admin → Testing tab assigns WHICH account fills
//   each slot (configuration, lives in a sheet) — the same
//   code-declares / sheet-configures split as TABS and the module
//   registry. defaultRole is both a UI hint and the GLOBAL-DEFAULT
//   lookup key (see resolution below).
//
// RESOLUTION (first match wins):
//   1. Per-module override row   (Scope = module key, Slot = slot key)
//   2. Global default row        (Scope = 'global',  Slot = the slot's
//                                 defaultRole — so any senate_faculty-
//                                 shaped slot inherits one account)
//   3. Unresolved → the module REFUSES test-mode submissions
//      (assertReady throws) — a half-intercepted test is how a real
//      professor still gets pinged.
//
// STORAGE — two tabs in the USERS_CONFIG (platform config) sheet,
// created by setUp(), edited only via Admin → Testing:
//   TestModeMap:      MapID | Scope | Slot | Account | Active | Notes
//   TestModeAccounts: Email | Active | Notes
//
// AUTHORIZATION — payload._test is HONORED only when the caller is a
// listed, active test account or a super_admin. From anyone else the
// flag is silently ignored and the call proceeds as a normal, real
// submission (real mail and all) — an unauthorized flag must never
// change behavior. UI hiding of the checkbox is convenience, not
// security.
//
// EXECUTION SCOPE — Apps Script evaluates globals fresh for every
// execution and runs each execution in isolation, so a module-level
// variable is a safe per-execution flag. dispatch() calls begin()
// before the handler and end() after; a leaked flag cannot survive
// into another user's execution.
//
// FAILURE POSTURE — reads never throw (a broken map degrades to
// "nothing resolves", which fails CLOSED: test mode refuses rather
// than routing to real people). Writes throw so the Admin UI can
// report save errors.
// ============================================================

const TestMode = (() => {

  // Per-execution activation context. null = not a test execution.
  // { user, module, action, source: 'payload' | 'record' }
  let _ctx = null;

  const GLOBAL_SCOPE = 'global';

  function _sheetId() { return CONFIG.SHEETS.USERS_CONFIG; }
  function _mapTab() {
    return (CONFIG.TABS && CONFIG.TABS.TESTMODE_MAP) || 'TestModeMap';
  }
  function _accountsTab() {
    return (CONFIG.TABS && CONFIG.TABS.TESTMODE_ACCOUNTS) || 'TestModeAccounts';
  }


  // ============================================================
  // ACTIVATION — called by dispatch() and by handlers
  // ============================================================

  /**
   * Called by dispatch() before every handler invocation. Activates
   * test mode for THIS execution iff the payload carries _test === true
   * AND the caller is authorized. Unauthorized flags are ignored (the
   * call proceeds as real), never escalated.
   *
   * @returns {boolean} whether test mode is now active
   */
  function begin(module, action, payload, user, roles) {
    _ctx = null;
    try {
      if (!payload || payload._test !== true) return false;
      if (!isTestAccount(user, roles)) return false;
      _ctx = { user: String(user || ''), module: String(module || ''),
               action: String(action || ''), source: 'payload' };
      return true;
    } catch (err) {
      Logger.log('TestMode.begin failed (proceeding as real): ' + err);
      _ctx = null;
      return false;
    }
  }

  /** Called by dispatch() after the handler returns or throws. */
  function end() { _ctx = null; }

  /** Is the current execution a test? */
  function active() { return !!_ctx; }

  /** Read-only copy of the activation context (or null). */
  function context() {
    return _ctx ? { user: _ctx.user, module: _ctx.module,
                    action: _ctx.action, source: _ctx.source } : null;
  }

  /**
   * Belt-and-suspenders for later workflow stages: a handler that has
   * loaded a record whose TestMode column is TRUE calls this right
   * after the load. The record's flag is server-written data (stamped
   * only after begin() authorized the original submission), so no
   * account re-check is needed here. No-op when already active or when
   * the record isn't flagged.
   *
   * @param {Object} rec  - the loaded sheet record (TestMode column)
   * @param {string} user - the dispatch-injected caller (the tester)
   * @returns {boolean} whether test mode is active after the call
   */
  function activateForRecord(rec, user) {
    if (_ctx) return true;
    const flag = String((rec && rec.TestMode) || '').trim().toUpperCase();
    if (flag !== 'TRUE') return false;
    let who = String(user || '').trim();
    if (!who) {
      try { who = Session.getActiveUser().getEmail(); } catch (e) { who = ''; }
    }
    _ctx = { user: who, module: '', action: '', source: 'record' };
    return true;
  }

  /**
   * The value a handler stamps into its record's TestMode column at
   * create time: 'TRUE' during a test execution, '' otherwise.
   */
  function recordFlag() { return _ctx ? 'TRUE' : ''; }


  // ============================================================
  // AUTHORIZATION — who may invoke test mode
  // ============================================================

  /**
   * True when the email is a listed, ACTIVE test account, or the roles
   * include super_admin (the platform-wide privileged floor).
   * Never throws — a broken accounts tab means "not a test account".
   */
  function isTestAccount(email, roles) {
    if (Array.isArray(roles) && roles.indexOf('super_admin') !== -1) return true;
    const e = String(email || '').trim().toLowerCase();
    if (!e) return false;
    try {
      return _accountRows().some(a =>
        a.email.toLowerCase() === e && a.active);
    } catch (err) {
      Logger.log('TestMode.isTestAccount read failed: ' + err);
      return false;
    }
  }


  // ============================================================
  // SLOT MANIFESTS — code-declared, mirrors TabRegistry.manifest
  // ============================================================

  /**
   * The TEST_SLOTS manifest of a module's handler, normalized.
   * Returns [] when the module is unknown, its handler is missing,
   * or it declares no slots. Never throws.
   *
   * @param {string} moduleKey
   * @returns {Array<{key,label,defaultRole}>}
   */
  function slotManifest(moduleKey) {
    try {
      const registry = getModuleRegistry();
      const mod = registry[String(moduleKey || '').trim()];
      if (!mod) return [];
      const handler = getModuleHandler(mod.handler);
      const raw = handler && handler.TEST_SLOTS;
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(s => s && String(s.key || '').trim())
        .map(s => ({
          key: String(s.key).trim(),
          label: String(s.label || s.key),
          defaultRole: String(s.defaultRole || '').trim(),
        }));
    } catch (err) {
      Logger.log('TestMode.slotManifest(' + moduleKey + ') failed: ' + err);
      return [];
    }
  }


  // ============================================================
  // RESOLUTION — which account fills a slot
  // ============================================================

  /**
   * Resolves one slot: per-module override, else the global default
   * keyed by the slot's defaultRole, else unresolved.
   * Never throws — any read problem resolves to null (fail closed).
   *
   * @returns {{ account: string|null,
   *             source: 'override'|'global'|null,
   *             slot: {key,label,defaultRole}|null }}
   */
  function resolve(moduleKey, slotKey) {
    const mkey = String(moduleKey || '').trim();
    const skey = String(slotKey || '').trim();
    const slot = slotManifest(mkey).find(s => s.key === skey) || null;
    try {
      const rows = _mapRows();

      const override = rows.find(r =>
        r.scope === mkey && r.slot === skey && r.active && r.account);
      if (override) {
        return { account: override.account, source: 'override', slot: slot };
      }

      if (slot && slot.defaultRole) {
        const global = rows.find(r =>
          r.scope === GLOBAL_SCOPE && r.slot === slot.defaultRole &&
          r.active && r.account);
        if (global) {
          return { account: global.account, source: 'global', slot: slot };
        }
      }
    } catch (err) {
      Logger.log('TestMode.resolve(' + mkey + ',' + skey + ') failed: ' + err);
    }
    return { account: null, source: null, slot: slot };
  }

  /**
   * THE one-line handler hook. Outside a test execution, returns the
   * real selection unchanged — a permanent, harmless no-op. During a
   * test execution, returns the mapped functional account for the
   * slot, throwing if the slot is unresolved (assertReady should have
   * caught that at submission; this is the last line of defense
   * against routing a test to a real person).
   *
   * Call AFTER the real selection has passed its own validation
   * (eligibility, PersonMatch) so the test still exercises those.
   *
   * @param {string} moduleKey
   * @param {string} slotKey
   * @param {string} selectedEmail - the tester's real selection
   * @returns {string} the email to actually write on the record
   */
  function substitute(moduleKey, slotKey, selectedEmail) {
    if (!_ctx) return selectedEmail;
    const res = resolve(moduleKey, slotKey);
    if (!res.account) {
      throw new Error('Test mode: no test account is assigned for the "' +
        ((res.slot && res.slot.label) || slotKey) + '" slot of module "' +
        moduleKey + '". Assign one in Admin → Testing, or submit without ' +
        'test mode.');
    }
    return res.account;
  }

  /**
   * Readiness of one module: every declared slot must resolve.
   * @returns {{ ready: boolean, declared: boolean,
   *             unresolved: string[],  // slot labels
   *             slots: Array<{key,label,defaultRole,account,source}> }}
   */
  function readiness(moduleKey) {
    const man = slotManifest(moduleKey);
    const slots = man.map(s => {
      const res = resolve(moduleKey, s.key);
      return { key: s.key, label: s.label, defaultRole: s.defaultRole,
               account: res.account, source: res.source };
    });
    const unresolved = slots.filter(s => !s.account).map(s => s.label);
    return { ready: man.length > 0 && unresolved.length === 0,
             declared: man.length > 0,
             unresolved: unresolved, slots: slots };
  }

  /**
   * Throws (with a friendly, actionable message) unless every declared
   * slot of the module resolves. Handlers call this at the START of a
   * test-mode submission — refuse-if-unmapped, because a
   * half-intercepted test is how a real professor still gets pinged.
   * No-op outside a test execution.
   */
  function assertReady(moduleKey) {
    if (!_ctx) return;
    const r = readiness(moduleKey);
    if (!r.declared) {
      throw new Error('Test mode: module "' + moduleKey + '" does not ' +
        'declare test slots (TEST_SLOTS), so test submissions are not ' +
        'available for it yet.');
    }
    if (!r.ready) {
      throw new Error('Test mode unavailable: no test account assigned ' +
        'for ' + r.unresolved.join(', ') + '. Assign accounts in ' +
        'Admin → Testing, or submit without test mode.');
    }
  }


  // ============================================================
  // MAIL BACKSTOP — called by Notify.send during test executions
  // ============================================================

  /**
   * Test-mode mail policy: DELIVER IF SAFE, REDIRECT IF NOT.
   *
   * Substitution at write time means most test mail is already addressed
   * to functional accounts — and the realistic test is that mail landing
   * in the slot account's inbox, exactly as a real sponsor's would. So:
   *
   *   · every recipient is TEST-SAFE  → deliver AS ADDRESSED, with the
   *     [TEST] subject prefix and a one-line body banner (test mail must
   *     be unmistakable even when forwarded).
   *   · some recipients are unsafe    → strip them; deliver to the safe
   *     ones PLUS the tester, the banner naming who was stripped — the
   *     tester's inbox still records that the message fired and where
   *     it would have gone.
   *   · no recipient is safe          → full redirect to the tester with
   *     the original recipients in the banner (role-pool notices,
   *     facilities mail, CC mirrors — anything without a slot).
   *
   * TEST-SAFE = the tester, active roster accounts, and every account on
   * an active TestModeMap row (slot accounts are mapped, not necessarily
   * rostered — mapped counts). Super admins may RUN tests, but their
   * inboxes are NOT automatically safe: mail addressed to one is
   * stripped like anyone else's unless that account is also rostered or
   * mapped. If the tester cannot be determined, recipients come back
   * EMPTY — Notify then reports 'no valid recipients' and nothing is
   * sent. Dropped beats delivered-to-real-people, always.
   *
   * @param {Object} p - { to: string[], cc: string[], subject, body,
   *                       htmlBody }
   * @returns {Object}  { to, cc, subject, body, htmlBody, note }
   */
  function interceptMail(p) {
    p = p || {};
    const origTo = [].concat(p.to || []);
    const origCc = [].concat(p.cc || []);
    const orig = origTo.concat(origCc).join(', ') || '(none)';
    const tester = _ctx && String(_ctx.user || '').trim();

    if (!tester) {
      Logger.log('TestMode.interceptMail: active but no tester on record — mail suppressed. Original: ' + orig);
      return { to: [], cc: [], subject: String(p.subject || ''),
               body: String(p.body || ''), htmlBody: p.htmlBody,
               note: 'test mode: tester unknown, mail suppressed' };
    }

    const lower = function (e) { return String(e || '').trim().toLowerCase(); };
    const safe = _safeRecipients();
    const isSafe = function (e) { return safe.has(lower(e)); };
    const safeTo = origTo.filter(isSafe);
    const safeCc = origCc.filter(isSafe);
    const stripped = origTo.concat(origCc).filter(function (e) { return !isSafe(e); });

    let to, cc, bannerText, note;
    if (!stripped.length && (safeTo.length + safeCc.length) > 0) {
      // Every recipient is a test account: deliver exactly as addressed.
      to = safeTo; cc = safeCc;
      bannerText = 'TEST MODE — test mail, delivered as addressed (all recipients are test accounts).';
      note = 'test mode: delivered as addressed';
    } else if (safeTo.length || safeCc.length) {
      // Mixed: safe recipients keep it, the tester joins, unsafe are
      // stripped — the run's paper trail stays complete in the tester's
      // inbox without a single unsafe delivery.
      const seen = {};
      to = safeTo.concat([tester]).filter(function (e) {
        const k = lower(e); if (seen[k]) return false; seen[k] = true; return true;
      });
      cc = safeCc.filter(function (e) { return !seen[lower(e)]; });
      bannerText = 'TEST MODE — ' + stripped.length + ' recipient(s) stripped (not test accounts): '
        + stripped.join(', ') + '.\nOriginal recipients: ' + orig;
      note = 'test mode: stripped ' + stripped.join(', ');
    } else {
      // Nothing safe: full redirect to the tester (today's old behavior,
      // now the fallback rather than the rule).
      to = [tester]; cc = [];
      bannerText = 'TEST MODE — this message was redirected to you.\nOriginal recipients: ' + orig;
      note = 'redirected to ' + tester;
    }

    const out = {
      to: to,
      cc: cc,
      subject: '[TEST] ' + String(p.subject || ''),
      body: bannerText + '\n----------------------------------------\n\n' + String(p.body || ''),
      note: note,
    };
    if (p.htmlBody) {
      out.htmlBody =
        '<div style="background:#fff3cd;border:1px solid #ffc107;' +
        'border-radius:4px;padding:8px 12px;margin-bottom:12px;' +
        'font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#664d03;">' +
        '<strong>TEST MODE</strong> — ' +
        _escapeHtml(bannerText.replace(/^TEST MODE — /, '').replace(/\n/g, ' · ')) +
        '</div>' + p.htmlBody;
    }
    return out;
  }

  /**
   * The execution-cached set of test-safe inboxes (lowercased): the
   * tester, active roster accounts, and accounts on active TestModeMap
   * rows. Lazy, once per test execution — interceptMail can run several
   * times in one action (student + sponsor + advisor mail) and must not
   * re-read the sheets each time. Internal to the mail policy;
   * everything else resolves through slots, never through this set.
   */
  function _safeRecipients() {
    if (!_ctx) return new Set();
    if (!_ctx.safeSet) {
      const s = new Set();
      const add = function (e) {
        e = String(e || '').trim().toLowerCase();
        if (e) s.add(e);
      };
      add(_ctx.user);
      _accountRowsSafe().forEach(function (a) { if (a.active) add(a.email); });
      _mapRowsSafe().forEach(function (m) { if (m.active) add(m.account); });
      _ctx.safeSet = s;
    }
    return _ctx.safeSet;
  }


  // ============================================================
  // ADMIN — overview + CRUD (Admin → Testing; super_admin by module)
  // ============================================================

  /**
   * Everything the Admin Testing tab draws in one call:
   *   accounts — the test-account roster.
   *   roles    — every role used as a defaultRole by any manifest,
   *              with its effective global account (if set).
   *   modules  — one entry per registry module: declared slots with
   *              effective account + provenance, or declared:false.
   *   orphanGlobals — global rows whose role no manifest references
   *              (kept working, flagged for cleanup).
   */
  function overview() {
    const registry = getModuleRegistry();
    const rows = _mapRowsSafe();
    const accounts = _accountRowsSafe();

    const roleSet = {};
    const modules = Object.keys(registry).map(key => {
      const man = slotManifest(key);
      man.forEach(s => { if (s.defaultRole) roleSet[s.defaultRole] = true; });
      const r = readiness(key);
      return {
        moduleKey: key,
        label: registry[key].label || key,
        enabled: registry[key].enabled !== false,
        declared: r.declared,
        ready: r.ready,
        slots: r.slots,
      };
    });

    const globalRows = rows.filter(r => r.scope === GLOBAL_SCOPE);
    const roles = Object.keys(roleSet).sort().map(role => {
      const g = globalRows.find(r => r.slot === role && r.active);
      return { role: role, account: (g && g.account) || '',
               active: !!g };
    });

    const orphanGlobals = globalRows
      .filter(r => !roleSet[r.slot])
      .map(r => ({ role: r.slot, account: r.account, active: r.active }));

    return { accounts: accounts, roles: roles, modules: modules,
             orphanGlobals: orphanGlobals };
  }

  /**
   * Upserts one assignment row, keyed by (Scope, Slot).
   *   scope   - 'global' or a module key
   *   slot    - a role name (global scope) or a declared slot key
   *   account - the functional account email; BLANK clears via
   *             clearAssignment instead
   * Validates hard where being wrong breaks resolution (unknown
   * module/slot), and returns non-blocking WARNINGS where being wrong
   * breaks the test at run time (missing/inactive account, account not
   * admitted by the module) — warn loudly, let the admin decide.
   *
   * @returns {{ saved: boolean, warnings: string[] }}
   */
  function setAssignment(p) {
    p = p || {};
    const scope = String(p.scope || '').trim();
    const slot = String(p.slot || '').trim();
    const account = String(p.account || '').trim();
    const notes = String(p.notes || '').trim();
    if (!scope) throw new Error('Scope is required.');
    if (!slot) throw new Error('Slot is required.');
    if (!account) throw new Error('Account is required (use clear to remove an assignment).');

    const warnings = [];

    if (scope !== GLOBAL_SCOPE) {
      const registry = getModuleRegistry();
      if (!registry[scope]) throw new Error('Unknown module: ' + scope);
      const man = slotManifest(scope);
      if (!man.some(s => s.key === slot)) {
        throw new Error('Module "' + scope + '" does not declare a "' +
          slot + '" test slot.');
      }
      // Would the account even get in the module's front door?
      try {
        const acctRoles = Auth.getRoles(account);
        if (!Auth.isAuthorized(acctRoles, registry[scope].roles)) {
          warnings.push(account + ' does not hold a role admitted by the "' +
            scope + '" module — it will receive the task but be denied at ' +
            'the module door. Add a role in User Management.');
        }
      } catch (err) {
        warnings.push('Could not verify ' + account + '\'s roles: ' + err);
      }
    }

    // Does the account exist and hold the slot's expected role?
    try {
      const acctRoles = Auth.getRoles(account);
      if (!acctRoles || !acctRoles.length) {
        warnings.push(account + ' has no roles (or no active profile) — ' +
          'it likely cannot log in or act. Check User Management.');
      } else {
        const expected = (scope === GLOBAL_SCOPE)
          ? slot
          : ((slotManifest(scope).find(s => s.key === slot) || {}).defaultRole || '');
        if (expected && acctRoles.indexOf(expected) === -1 &&
            acctRoles.indexOf('super_admin') === -1) {
          warnings.push('This slot expects ' + expected + '; ' + account +
            ' does not hold that role. Per-action checks in the module ' +
            'may deny it.');
        }
      }
    } catch (err) {
      warnings.push('Could not verify ' + account + ': ' + err);
    }

    const existing = _mapRows().find(r => r.scope === scope && r.slot === slot);
    if (existing) {
      DataService.update(_sheetId(), _mapTab(), 'MapID', existing.mapId, {
        Account: account, Active: 'TRUE', Notes: notes,
      });
    } else {
      DataService.insert(_sheetId(), _mapTab(), {
        MapID: DataService.generateId('TMM'),
        Scope: scope, Slot: slot, Account: account,
        Active: 'TRUE', Notes: notes,
      });
    }
    return { saved: true, warnings: warnings };
  }

  /**
   * Removes one assignment row by (Scope, Slot). A cleared module
   * override falls back to the global default; a cleared global
   * default leaves its dependent slots unresolved (and their modules
   * will refuse test submissions — fail closed).
   */
  function clearAssignment(p) {
    p = p || {};
    const scope = String(p.scope || '').trim();
    const slot = String(p.slot || '').trim();
    if (!scope || !slot) throw new Error('Scope and slot are required.');
    const existing = _mapRows().find(r => r.scope === scope && r.slot === slot);
    if (!existing) return { removed: false };
    DataService.remove(_sheetId(), _mapTab(), 'MapID', existing.mapId);
    return { removed: true };
  }

  /** Adds or updates one test-account roster row (keyed by Email). */
  function upsertAccount(p) {
    p = p || {};
    const email = String(p.email || '').trim();
    if (!email) throw new Error('Email is required.');
    const active = p.active === false ? 'FALSE' : 'TRUE';
    const notes = String(p.notes || '').trim();

    const warnings = [];
    try {
      const acctRoles = Auth.getRoles(email);
      if (!acctRoles || !acctRoles.length) {
        warnings.push(email + ' has no portal profile or roles — add it ' +
          'in User Management before testing with it.');
      }
    } catch (err) {
      warnings.push('Could not verify ' + email + ': ' + err);
    }

    const existing = _accountRows().find(a =>
      a.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      DataService.update(_sheetId(), _accountsTab(), 'Email', existing.email, {
        Active: active, Notes: notes,
      });
    } else {
      DataService.insert(_sheetId(), _accountsTab(), {
        Email: email, Active: active, Notes: notes,
      });
    }
    return { saved: true, warnings: warnings };
  }

  /** Removes a test-account roster row entirely. */
  function removeAccount(p) {
    p = p || {};
    const email = String(p.email || '').trim();
    if (!email) throw new Error('Email is required.');
    const removed = DataService.remove(_sheetId(), _accountsTab(), 'Email', email);
    return { removed: removed };
  }


  // ============================================================
  // PRIVATE — sheet reads (by header name, via DataService only)
  // ============================================================

  function _mapRows() {
    return DataService.getAll(_sheetId(), _mapTab()).map(r => ({
      mapId: String(r.MapID || '').trim(),
      scope: String(r.Scope || '').trim(),
      slot: String(r.Slot || '').trim(),
      account: String(r.Account || '').trim(),
      active: String(r.Active || 'TRUE').trim().toUpperCase() !== 'FALSE',
      notes: String(r.Notes || '').trim(),
    })).filter(r => r.scope && r.slot);
  }

  function _mapRowsSafe() {
    try { return _mapRows(); }
    catch (err) { Logger.log('TestMode map read failed: ' + err); return []; }
  }

  function _accountRows() {
    return DataService.getAll(_sheetId(), _accountsTab()).map(r => ({
      email: String(r.Email || '').trim(),
      active: String(r.Active || 'TRUE').trim().toUpperCase() !== 'FALSE',
      notes: String(r.Notes || '').trim(),
    })).filter(r => r.email);
  }

  function _accountRowsSafe() {
    try { return _accountRows(); }
    catch (err) { Logger.log('TestMode accounts read failed: ' + err); return []; }
  }

  function _escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }


  return {
    // activation (dispatch + handlers)
    begin, end, active, context, activateForRecord, recordFlag,
    // authorization
    isTestAccount,
    // slots + resolution (handlers)
    slotManifest, resolve, substitute, readiness, assertReady,
    // mail backstop (Notify)
    interceptMail,
    // admin
    overview, setAssignment, clearAssignment, upsertAccount, removeAccount,
  };

})();