// ============================================================
// Settings.gs — Platform-wide, module-keyed settings store
// ============================================================
// A small key/value store scoped BY MODULE, for PLATFORM concerns that
// every module shares through a common service — currently the reply-to
// address applied to that module's notification emails.
//
// WHY THIS EXISTS SEPARATELY from per-module settings stores
// (ThesisSettings, TranscriptModule's own settings tab): those hold a
// module's DOMAIN/operational flags (NOTIFY_ON_HANDOFF, SEND_CERTIFICATE,
// ASSIST sync config). Reply-to is not a domain flag — it is a property
// of the shared Notify pathway, meaningful for ANY module that sends
// mail. Keeping it in one platform store means a new module gets a
// configurable reply-to for free, and there is exactly one place the
// Admin UI reads/writes it. Domain flags stay where they are.
//
// Storage: a "Settings" tab in the Users/Config spreadsheet
// (CONFIG.SHEETS.USERS_CONFIG — alongside Users, Roles, Modules), with
// columns:  Module | Key | Value  (read by header name, per convention).
//
// Resolution: get() returns the stored value when present and non-blank,
// otherwise the caller's supplied default. replyTo() layers the platform
// fallback (CONFIG.DEFAULT_REPLY_TO) under an empty/unset module value,
// so notifications always carry SOME reply-to even before anyone
// configures one in the UI.
//
// Failure posture: reads degrade to the default (never throw), so a
// missing/!unreadable Settings tab can never break a notification or an
// action that resolves a setting. Writes do throw on genuine failure so
// the Admin UI can surface a save error.
//
// Mirrors the ImportPolicy / ThesisSettings / ModuleManager patterns:
// an IIFE, sheet I/O by header name, an _ensureSheet bootstrap.
// ============================================================

const Settings = (() => {

  const HEADERS = ['Module', 'Key', 'Value'];

  // The platform settings tab lives beside Users/Roles/Modules in the
  // config spreadsheet. Prefer a CONFIG.TABS entry if one is defined, so
  // the tab name stays UI/config-managed like the other tabs; fall back
  // to the literal 'Settings' otherwise.
  function _tabName() {
    return (CONFIG.TABS && CONFIG.TABS.SETTINGS) || 'Settings';
  }


  /**
   * Effective value for (module, key): the stored Value if a matching row
   * exists with a non-blank Value, else `dflt`. Never throws — on any
   * read failure it returns `dflt`, so a settings problem cannot break a
   * caller (e.g. a notification send).
   *
   * @param {string} module - module key (e.g. 'thesis', 'transcript')
   * @param {string} key    - setting name (e.g. 'replyTo')
   * @param {*}      [dflt]  - value to return when unset/blank/unreadable
   * @returns {*} stored string value, or `dflt`
   */
  function get(module, key, dflt) {
    if (dflt === undefined) dflt = '';
    try {
      const row = _find(String(module || '').trim(), String(key || '').trim());
      if (!row) return dflt;
      const val = String(row.Value == null ? '' : row.Value).trim();
      return val === '' ? dflt : val;
    } catch (err) {
      Logger.log('Settings.get(' + module + ',' + key + ') failed: ' + err);
      return dflt;
    }
  }


  /**
   * Sets (module, key) = value, inserting or updating the single matching
   * row. A blank value is allowed and is stored as '' — semantically
   * "unset", so get() falls through to its default. Throws on a real
   * write failure so the Admin UI can report it.
   *
   * @param {string} module
   * @param {string} key
   * @param {string} value
   * @returns {{ module: string, key: string, value: string }}
   */
  function set(module, key, value) {
    const mod = String(module || '').trim();
    const k   = String(key || '').trim();
    if (!mod) throw new Error('Settings.set: module is required.');
    if (!k)   throw new Error('Settings.set: key is required.');
    const val = String(value == null ? '' : value).trim();

    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim());
    const cMod = headers.indexOf('Module');
    const cKey = headers.indexOf('Key');
    const cVal = headers.indexOf('Value');

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][cMod]).trim() === mod &&
          String(data[i][cKey]).trim() === k) {
        sheet.getRange(i + 1, cVal + 1).setValue(val);
        return { module: mod, key: k, value: val };
      }
    }
    // No existing row — append one in header order.
    const rowValues = [];
    rowValues[cMod] = mod;
    rowValues[cKey] = k;
    rowValues[cVal] = val;
    // Fill any gaps (defensive, in case of extra columns) with ''.
    for (let c = 0; c < headers.length; c++) {
      if (rowValues[c] === undefined) rowValues[c] = '';
    }
    sheet.appendRow(rowValues);
    return { module: mod, key: k, value: val };
  }


  /**
   * The reply-to address for a module's notifications: the module's
   * configured 'replyTo' setting if set, else the platform default
   * (CONFIG.DEFAULT_REPLY_TO). Always returns a non-empty address as long
   * as the platform default is configured.
   *
   * This is the single helper notification code should call; it keeps the
   * key name ('replyTo') and the fallback in one place.
   *
   * @param {string} module - module key
   * @returns {string} a reply-to address
   */
  function replyTo(module) {
    const fallback = (CONFIG && CONFIG.DEFAULT_REPLY_TO) || '';
    return get(module, 'replyTo', fallback);
  }


  /**
   * All settings for a module as a plain { key: value } map (non-blank
   * rows only). Convenience for an Admin settings panel. Never throws.
   *
   * @param {string} module
   * @returns {Object<string,string>}
   */
  function getAll(module) {
    const out = {};
    const mod = String(module || '').trim();
    try {
      const sheet = _ensureSheet();
      const data  = sheet.getDataRange().getValues();
      if (data.length < 2) return out;
      const headers = data[0].map(h => String(h).trim());
      const cMod = headers.indexOf('Module');
      const cKey = headers.indexOf('Key');
      const cVal = headers.indexOf('Value');
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][cMod]).trim() !== mod) continue;
        const k = String(data[i][cKey]).trim();
        if (!k) continue;
        out[k] = String(data[i][cVal] == null ? '' : data[i][cVal]).trim();
      }
    } catch (err) {
      Logger.log('Settings.getAll(' + module + ') failed: ' + err);
    }
    return out;
  }


  // ── Private ──────────────────────────────────────────────

  /** Finds the single row for (module, key), or null. Reads by header. */
  function _find(mod, key) {
    if (!mod || !key) return null;
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    if (data.length < 2) return null;
    const headers = data[0].map(h => String(h).trim());
    const cMod = headers.indexOf('Module');
    const cKey = headers.indexOf('Key');
    const cVal = headers.indexOf('Value');
    if (cMod === -1 || cKey === -1 || cVal === -1) return null;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][cMod]).trim() === mod &&
          String(data[i][cKey]).trim() === key) {
        return { Module: data[i][cMod], Key: data[i][cKey], Value: data[i][cVal] };
      }
    }
    return null;
  }

  /** Returns the Settings sheet, creating it with headers if absent. */
  function _ensureSheet() {
    const ss = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
    let sheet = ss.getSheetByName(_tabName());
    if (!sheet) {
      sheet = ss.insertSheet(_tabName());
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    } else if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    return sheet;
  }


  return { get, set, replyTo, getAll };

})();
