// ============================================================
// NotifyRules.gs — Request notification rules
// ============================================================
// Maps a REQUESTED ROLE -> extra email recipients notified when an
// access request for that role is submitted. Super admins are notified
// based on a configurable toggle (see getSettings/saveSettings); these
// rules ADD role-specific recipients (e.g. the undergraduate/graduate
// advisors for student and visitor requests).
//
// NotifyRules tab columns:  RequestedRole | NotifyEmails | Note
// Managed in Admin → Roles → "Request notifications".
//
// Reserved row: RequestedRole = "__settings__"
//   NotifyEmails column holds JSON: { "notifySuperAdmins": true|false }
//   This row is excluded from list() and never shown in the UI table.
// ============================================================

const NotifyRules = (() => {

  const HEADERS      = ['RequestedRole', 'NotifyEmails', 'Note'];
  const SETTINGS_KEY = '__settings__';


  /** Returns all rules as [{ requestedRole, emails[], note }].
   *  Reserved rows (starting with '__') are excluded. */
  function list() {
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    return data.slice(1)
      .filter(row => {
        const key = String(row[0]).trim();
        return key && !key.startsWith('__');
      })
      .map(row => ({
        requestedRole: String(row[0]).trim().toLowerCase(),
        emails: _parseEmails(row[1]),
        note: String(row[2] || '').trim(),
      }));
  }


  /** Extra recipients for a requested role ([] if none/blank). */
  function recipientsFor(requestedRole) {
    const role = String(requestedRole || '').trim().toLowerCase();
    if (!role) return [];
    try {
      const found = list().find(r => r.requestedRole === role);
      return found ? found.emails : [];
    } catch (e) {
      Logger.log('NotifyRules lookup failed: ' + e);
      return [];
    }
  }


  /**
   * Returns the global notification settings.
   * Defaults to { notifySuperAdmins: true } if no settings row exists,
   * preserving existing behavior for portals that have never set this.
   * @returns {{ notifySuperAdmins: boolean }}
   */
  function getSettings() {
    try {
      const sheet = _ensureSheet();
      const data  = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]).trim() === SETTINGS_KEY) {
          const raw = String(data[i][1] || '').trim();
          if (!raw) break;
          const parsed = JSON.parse(raw);
          return {
            notifySuperAdmins: parsed.notifySuperAdmins !== false,
          };
        }
      }
    } catch (e) {
      Logger.log('NotifyRules.getSettings failed: ' + e);
    }
    return { notifySuperAdmins: true };
  }


  /**
   * Persists global notification settings.
   * @param {Object} p - { notifySuperAdmins: boolean }
   * @returns {{ status: string, notifySuperAdmins: boolean }}
   */
  function saveSettings(p) {
    const notifySuperAdmins = p.notifySuperAdmins !== false;
    const value = JSON.stringify({ notifySuperAdmins: notifySuperAdmins });

    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === SETTINGS_KEY) {
        sheet.getRange(i + 1, 2).setValue(value);
        sheet.getRange(i + 1, 3).setValue('portal settings — do not edit manually');
        return { status: 'updated', notifySuperAdmins: notifySuperAdmins };
      }
    }
    sheet.appendRow([SETTINGS_KEY, value, 'portal settings — do not edit manually']);
    return { status: 'created', notifySuperAdmins: notifySuperAdmins };
  }


  /**
   * Adds or updates a rule (keyed by requested role).
   * @param {Object} p - { requestedRole, emails: "a@x, b@y" or [..] , note? }
   */
  function upsert(p) {
    const role = String(p.requestedRole || '').trim().toLowerCase();
    if (!role) throw new Error('Choose the requested role.');
    if (role.startsWith('__')) throw new Error('Invalid role name.');
    const validRoles = Auth.listRoles();
    if (validRoles.indexOf(role) === -1) throw new Error('Unknown role: ' + role);

    const emails = Array.isArray(p.emails) ? p.emails : _parseEmails(p.emails);
    if (!emails.length) throw new Error('Enter at least one notification email.');
    const bad = emails.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (bad.length) throw new Error('Invalid email(s): ' + bad.join(', '));

    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === role) {
        sheet.getRange(i + 1, 2).setValue(emails.join(', '));
        if (p.note !== undefined) sheet.getRange(i + 1, 3).setValue(p.note || '');
        return { status: 'updated', requestedRole: role };
      }
    }
    sheet.appendRow([role, emails.join(', '), p.note || '']);
    return { status: 'created', requestedRole: role };
  }


  /** Removes the rule for a requested role. */
  function remove(p) {
    const role = String(p.requestedRole || '').trim().toLowerCase();
    if (role.startsWith('__')) throw new Error('Cannot remove reserved settings row.');
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === role) {
        sheet.deleteRow(i + 1);
        return { status: 'deleted', requestedRole: role };
      }
    }
    throw new Error('No rule found for: ' + role);
  }


  // ── Private ────────────────────────────────────────────────

  function _parseEmails(raw) {
    return String(raw || '').split(/[,;]/).map(e => e.trim()).filter(Boolean);
  }

  function _ensureSheet() {
    const ss = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
    let sheet = ss.getSheetByName(CONFIG.TABS.NOTIFY_RULES);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.TABS.NOTIFY_RULES);
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
    }
    return sheet;
  }


  return { list, recipientsFor, getSettings, saveSettings, upsert, remove };

})();