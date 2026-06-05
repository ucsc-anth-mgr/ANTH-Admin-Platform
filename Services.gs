// ============================================================
// AuditLog.gs — Append-only audit trail
// ============================================================

const AuditLog = (() => {

  /**
   * Writes an audit entry to the AuditLog sheet tab.
   *
   * @param {Object} entry - { user, module, action, payload, status, notes }
   */
  function write(entry) {
    try {
      const ss    = SpreadsheetApp.openById(CONFIG.SHEETS.AUDIT_LOG);
      const sheet = ss.getSheetByName(CONFIG.TABS.AUDIT)
                 || ss.insertSheet(CONFIG.TABS.AUDIT);

      // Ensure header row exists
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(['Timestamp', 'User', 'Module', 'Action', 'Payload', 'Status', 'Notes']);
        sheet.getRange(1, 1, 1, 7).setFontWeight('bold');
      }

      sheet.appendRow([
        new Date(),
        entry.user    || '',
        entry.module  || '',
        entry.action  || '',
        entry.payload ? JSON.stringify(entry.payload).substring(0, 500) : '',
        entry.status  || '',
        entry.notes   || '',
      ]);
    } catch (err) {
      // Audit failures should not break the main request
      Logger.log('AuditLog.write failed: ' + err);
    }
  }


  /**
   * Returns recent audit entries (newest first).
   * @param {number} limit - max rows to return
   */
  function recent(limit) {
    try {
      const ss    = SpreadsheetApp.openById(CONFIG.SHEETS.AUDIT_LOG);
      const sheet = ss.getSheetByName(CONFIG.TABS.AUDIT);
      if (!sheet || sheet.getLastRow() < 2) return [];

      const data = sheet.getDataRange().getValues();
      const rows = data.slice(1).reverse().slice(0, limit || 100);
      return rows.map(r => ({
        timestamp: r[0],
        user:      r[1],
        module:    r[2],
        action:    r[3],
        payload:   r[4],
        status:    r[5],
        notes:     r[6],
      }));
    } catch (err) {
      return [];
    }
  }


  return { write, recent };

})();


// ============================================================
// Utils.gs — Shared helpers
// ============================================================

const Utils = (() => {

  /** Formats a Date to a readable string */
  function formatDate(date, format) {
    if (!date) return '';
    return Utilities.formatDate(
      new Date(date),
      Session.getScriptTimeZone(),
      format || 'yyyy-MM-dd HH:mm'
    );
  }

  /** Sends a notification email */
  function sendEmail({ to, subject, body, htmlBody }) {
    GmailApp.sendEmail(to, subject, body, htmlBody ? { htmlBody } : {});
  }

  /** Safely parses JSON, returns null on failure */
  function parseJSON(str) {
    try { return JSON.parse(str); } catch(e) { return null; }
  }

  /** Strips HTML tags from a string */
  function stripHtml(str) {
    return String(str).replace(/<[^>]*>/g, '');
  }

  /** Returns true if str is a valid email address */
  function isValidEmail(str) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(str));
  }

  /** Deep-clones a plain object (no functions, no Date) */
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  return { formatDate, sendEmail, parseJSON, stripHtml, isValidEmail, clone };

})();