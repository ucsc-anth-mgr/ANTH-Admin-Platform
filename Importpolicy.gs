// ============================================================
// ImportPolicy.gs — Who may import, and which roles they may assign
// ============================================================
// Maps an IMPORTER ROLE -> the set of roles that importer may assign
// via batch upload. A user's effective allowlist is the UNION of the
// assignable-sets for every importer role they hold.
//
// ImportPolicy tab columns:
//   ImporterRole | AssignableRoles
//   e.g.  registrar     | undergraduate_student, graduate_student
//         dept_manager  | staff, lecturer, visitor
//
// Rules:
//   - super_admin bypasses everything (handled in BatchImport).
//   - super_admin can NEVER be granted as an assignable role here.
//   - A role appearing as an ImporterRole is what grants import access.
// ============================================================

const ImportPolicy = (() => {

  const HEADERS = ['ImporterRole', 'AssignableRoles'];


  /**
   * Returns the full policy as [{ importerRole, assignableRoles[] }].
   */
  function list() {
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    return data.slice(1)
      .filter(row => String(row[0]).trim())
      .map(row => ({
        importerRole:    String(row[0]).trim().toLowerCase(),
        assignableRoles: _parseList(row[1]),
      }));
  }


  /**
   * True if any of the user's roles is configured as an importer role.
   */
  function canImport(userRoles) {
    const policy = list();
    const importerRoles = policy.map(p => p.importerRole);
    return (userRoles || []).some(r => importerRoles.indexOf(r) !== -1);
  }


  /**
   * Returns the union of assignable roles for all importer roles the
   * user holds. super_admin gets everything except super_admin itself.
   */
  function assignableFor(userRoles) {
    if ((userRoles || []).includes('super_admin')) {
      return Auth.listRoles().filter(r => r !== 'super_admin');
    }
    const policy = list();
    const set = {};
    policy.forEach(p => {
      if (userRoles.indexOf(p.importerRole) !== -1) {
        p.assignableRoles.forEach(r => { if (r !== 'super_admin') set[r] = true; });
      }
    });
    return Object.keys(set);
  }


  /**
   * Adds or updates a policy entry (keyed by importer role).
   * Strips super_admin from the assignable set defensively.
   * @param {Object} p - { importerRole, assignableRoles[] }
   */
  function upsert(p) {
    const importerRole = String(p.importerRole || '').trim().toLowerCase();
    if (!importerRole) throw new Error('Importer role is required.');
    if (importerRole === 'super_admin') throw new Error('super_admin already has full import rights.');

    const validRoles = Auth.listRoles();
    if (validRoles.indexOf(importerRole) === -1) {
      throw new Error('Unknown importer role: ' + importerRole);
    }

    let assignable = (Array.isArray(p.assignableRoles) ? p.assignableRoles : [])
      .map(r => String(r).trim().toLowerCase())
      .filter(Boolean)
      .filter(r => r !== 'super_admin');             // never grant super_admin
    const unknown = assignable.filter(r => validRoles.indexOf(r) === -1);
    if (unknown.length) throw new Error('Unknown assignable role(s): ' + unknown.join(', '));

    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === importerRole) {
        sheet.getRange(i + 1, 2).setValue(assignable.join(', '));
        return { status: 'updated', importerRole: importerRole };
      }
    }
    sheet.appendRow([importerRole, assignable.join(', ')]);
    return { status: 'created', importerRole: importerRole };
  }


  /**
   * Removes an importer-role policy entirely (revokes their import access).
   */
  function remove(p) {
    const importerRole = String(p.importerRole || '').trim().toLowerCase();
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim().toLowerCase() === importerRole) {
        sheet.deleteRow(i + 1);
        return { status: 'deleted', importerRole: importerRole };
      }
    }
    throw new Error('Policy not found: ' + importerRole);
  }


  // ── Private ────────────────────────────────────────────────

  function _parseList(raw) {
    return String(raw || '').split(/[,;]/).map(r => r.trim().toLowerCase()).filter(Boolean);
  }

  function _ensureSheet() {
    const ss = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
    let sheet = ss.getSheetByName(CONFIG.TABS.IMPORT_POLICY);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.TABS.IMPORT_POLICY);
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
    }
    return sheet;
  }


  return { list, canImport, assignableFor, upsert, remove };

})();
