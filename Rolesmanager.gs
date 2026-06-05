// ============================================================
// RolesManager.gs — Read/write the Roles sheet tab
// ============================================================
// Powers the Roles tab in the Admin module. Lets admins define
// identity roles (staff, senate_faculty, etc.) without editing
// the sheet by hand.
//
// Deletion is BLOCKED while a role is still in use — by any user
// (Users tab) or any module (module registry). super_admin is
// protected and can never be deleted.
// ============================================================

const RolesManager = (() => {

  const HEADERS = ['Role', 'Description'];
  const PROTECTED = ['super_admin'];   // cannot be deleted


  /**
   * Returns all roles with description and a usage count
   * (how many users + modules reference each).
   */
  function list() {
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    const usage = _usageMap();

    return data.slice(1)
      .filter(row => String(row[0]).trim())
      .map(row => {
        const role = String(row[0]).trim();
        const u = usage[role] || { users: 0, modules: 0 };
        return {
          role,
          description: String(row[1] || '').trim(),
          userCount:   u.users,
          moduleCount: u.modules,
          protected:   PROTECTED.includes(role),
        };
      });
  }


  /**
   * Adds or updates a role (keyed by Role name).
   * Validates: non-empty, lowercase, no spaces, no duplicates on add.
   */
  function upsert(payload) {
    const role = String(payload.role || '').trim();
    const description = String(payload.description || '').trim();

    if (!role) throw new Error('Role name is required.');
    if (/\s/.test(role)) throw new Error('Role name cannot contain spaces. Use underscores, e.g. senate_faculty.');
    if (role !== role.toLowerCase()) throw new Error('Role name must be lowercase.');
    if (!/^[a-z0-9_]+$/.test(role)) throw new Error('Use only lowercase letters, numbers, and underscores.');

    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === role) {
        // Update description only
        sheet.getRange(i + 1, 2).setValue(description);
        return { status: 'updated', role };
      }
    }
    sheet.appendRow([role, description]);
    return { status: 'created', role };
  }


  /**
   * Deletes a role — only if nothing uses it and it isn't protected.
   * Throws a descriptive error listing what still references it.
   */
  function remove(payload) {
    const role = String(payload.role || '').trim();
    if (!role) throw new Error('Role name is required.');
    if (PROTECTED.includes(role)) throw new Error('The "' + role + '" role is protected and cannot be deleted.');

    // Usage check — block if anything references it
    const usage = _usageMap()[role] || { users: 0, modules: 0 };
    if (usage.users > 0 || usage.modules > 0) {
      const parts = [];
      if (usage.users > 0)   parts.push(usage.users + ' user' + (usage.users === 1 ? '' : 's'));
      if (usage.modules > 0) parts.push(usage.modules + ' module' + (usage.modules === 1 ? '' : 's'));
      throw new Error('Cannot delete "' + role + '": still used by ' + parts.join(' and ') +
                      '. Remove it from them first, then delete the role.');
    }

    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === role) {
        sheet.deleteRow(i + 1);
        return { status: 'deleted', role };
      }
    }
    throw new Error('Role not found: ' + role);
  }


  /**
   * Returns, for a given role, the specific users and modules that
   * reference it — so the UI can show the admin exactly what to clean up.
   */
  function usageDetail(payload) {
    const role = String(payload.role || '').trim();
    const users = Auth.listUsers()
      .filter(u => String(u.roles).split(',').map(r => r.trim()).includes(role))
      .map(u => u.email);

    const registry = getModuleRegistry();
    const modules = Object.entries(registry)
      .filter(([, m]) => (m.roles || []).includes(role))
      .map(([key, m]) => m.label || key);

    return { role, users, modules };
  }


  // ── Private helpers ────────────────────────────────────────

  /**
   * Builds a map of role -> { users, modules } usage counts in one pass.
   */
  function _usageMap() {
    const map = {};
    const bump = (role, kind) => {
      const r = String(role).trim();
      if (!r) return;
      if (!map[r]) map[r] = { users: 0, modules: 0 };
      map[r][kind]++;
    };

    // Count user references
    Auth.listUsers().forEach(u => {
      String(u.roles).split(',').forEach(r => bump(r, 'users'));
    });

    // Count module references
    const registry = getModuleRegistry();
    Object.values(registry).forEach(m => {
      (m.roles || []).forEach(r => bump(r, 'modules'));
    });

    return map;
  }

  function _ensureSheet() {
    const ss = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
    let sheet = ss.getSheetByName(CONFIG.TABS.ROLES);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.TABS.ROLES);
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#e8eaed');
      sheet.setFrozenRows(1);
      // Seed with the department's identity roles
      [
        ['super_admin',           'Full system access; protected'],
        ['staff',                 'Department staff'],
        ['senate_faculty',        'Senate faculty members'],
        ['lecturer',              'Lecturers and teaching faculty'],
        ['graduate_student',      'Graduate students'],
        ['undergraduate_student', 'Undergraduate students'],
        ['visitor',               'Visitors and limited-access users'],
      ].forEach(r => sheet.appendRow(r));
    }
    return sheet;
  }


  return { list, upsert, remove, usageDetail };

})();
