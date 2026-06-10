// ============================================================
// ThesisSettings.gs — UI-managed operational settings for Thesis
// ============================================================
// Currently holds a single setting, NOTIFY_ON_HANDOFF (whether the
// module emails the next party at each workflow stage change). The
// panel exists as the home for future UI-managed thesis settings.
//
// Storage: a ThesisSettings tab (key/value) in the config spreadsheet.
// The sheet is the source of truth, but if a key is missing or blank
// (e.g. fresh deployment, before anyone saves), get() falls back to the
// CONFIG.THESIS constant so the module keeps working. The constants are
// effectively the seed/default; the sheet overrides them once set.
//
// NOT stored here (deliberately):
//   - Advisor identity — derived from the staff_undergrad
//     role, not a setting (manage in Admin → Users).
//   - DRIVE_FOLDER_ID / spreadsheet ID — set-once infrastructure pointers
//     that stay as Config.gs constants.
//
// Mirrors the ImportPolicy / NotifyRules / ThesisEligibility pattern.
// ============================================================

const ThesisSettings = (() => {

  const HEADERS = ['Key', 'Value'];
  const KEY_NOTIFY = 'NOTIFY_ON_HANDOFF';

  /**
   * Effective settings: sheet value if present, else the CONFIG.THESIS
   * fallback. Returns booleans already coerced.
   * @returns {{ notifyOnHandoff: boolean }}
   */
  function get() {
    const stored = _readMap();
    return {
      notifyOnHandoff: _bool(
        Object.prototype.hasOwnProperty.call(stored, KEY_NOTIFY)
          ? stored[KEY_NOTIFY]
          : (CONFIG.THESIS && CONFIG.THESIS.NOTIFY_ON_HANDOFF)
      ),
    };
  }

  /**
   * Saves settings from the Admin panel.
   * @param {Object} p - { notifyOnHandoff: boolean }
   */
  function save(p) {
    p = p || {};
    const notify = (p.notifyOnHandoff === true || p.notifyOnHandoff === 'true');
    _writeKey(KEY_NOTIFY, notify ? 'TRUE' : 'FALSE');
    return get();
  }


  // ── Private ────────────────────────────────────────────────

  function _readMap() {
    const map = {};
    try {
      const sheet = _ensureSheet();
      const data = sheet.getDataRange().getValues();
      const headers = data[0].map(h => String(h).trim());
      const ki = headers.indexOf('Key'), vi = headers.indexOf('Value');
      for (let i = 1; i < data.length; i++) {
        const k = String(data[i][ki] || '').trim();
        if (k) map[k] = data[i][vi];
      }
    } catch (err) {
      Logger.log('ThesisSettings._readMap failed (using Config fallback): ' + err);
    }
    return map;
  }

  function _writeKey(key, value) {
    const sheet = _ensureSheet();
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim());
    const ki = headers.indexOf('Key'), vi = headers.indexOf('Value');
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][ki] || '').trim() === key) {
        sheet.getRange(i + 1, vi + 1).setValue(value);
        return;
      }
    }
    const row = [];
    row[ki] = key; row[vi] = value;
    sheet.appendRow(row);
  }

  function _ensureSheet() {
    const ss = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
    let sheet = ss.getSheetByName(CONFIG.TABS.THESIS_SETTINGS);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.TABS.THESIS_SETTINGS);
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#e8eaed');
      sheet.setFrozenRows(1);
      // Seed from the current Config default so the sheet starts coherent.
      const dflt = (CONFIG.THESIS && CONFIG.THESIS.NOTIFY_ON_HANDOFF) ? 'TRUE' : 'FALSE';
      sheet.appendRow([KEY_NOTIFY, dflt]);
    }
    return sheet;
  }

  function _bool(v) {
    if (v === true) return true;
    if (v === false || v == null) return false;
    return String(v).trim().toLowerCase() === 'true';
  }

  return { get: get, save: save };

})();