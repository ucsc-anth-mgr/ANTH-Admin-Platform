// ============================================================
// ModuleManager.gs — Read/write the Modules sheet tab
// ============================================================
// Powers the Module Manager UI in the Admin module. Lets non-devs
// edit module metadata (label, icon, roles, order, enabled) without
// touching code. Does NOT create handler/UI code — that's a dev task.
// ============================================================

const ModuleManager = (() => {

  const HEADERS = ['Key', 'Label', 'Icon', 'Roles', 'Handler', 'Include', 'Order', 'Enabled'];


  /**
   * Returns all module rows from the Modules tab, each annotated with
   * whether its Handler is actually registered in code (handlerOk) and
   * whether its Include template name looks present (best-effort).
   */
  function list() {
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    const registeredHandlers = getRegisteredHandlers();

    return data.slice(1)
      .filter(row => String(row[0]).trim())
      .map(row => {
        const rec = _rowToRecord(row);
        rec.handlerOk = registeredHandlers.includes(rec.handler);
        return rec;
      })
      .sort((a, b) => a.order - b.order);
  }


  /**
   * Returns handler names registered in code but NOT yet present in the
   * Modules sheet — i.e. modules a dev has prepared that an admin can
   * now "activate and configure".
   */
  function availableHandlers() {
    const inSheet = list().map(m => m.handler);
    return getRegisteredHandlers().filter(h => !inSheet.includes(h));
  }


  /**
   * Adds or updates a module row, keyed by Key.
   * @param {Object} mod - { key, label, icon, roles[], handler, include, order, enabled }
   */
  function upsert(mod) {
    if (!mod.key)     throw new Error('Module key is required.');
    if (!mod.label)   throw new Error('Label is required.');
    if (!mod.handler) throw new Error('Handler is required.');
    if (!mod.include) throw new Error('Include (UI file name) is required.');

    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    const rolesStr = Array.isArray(mod.roles) ? mod.roles.join(', ') : String(mod.roles);
    const rowValues = [
      mod.key, mod.label, mod.icon || 'ti-box', rolesStr,
      mod.handler, mod.include,
      Number(mod.order) || 99,
      mod.enabled === false ? 'FALSE' : 'TRUE',
    ];

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === mod.key) {
        sheet.getRange(i + 1, 1, 1, HEADERS.length).setValues([rowValues]);
        clearModuleRegistryCache();
        return { status: 'updated', key: mod.key };
      }
    }
    sheet.appendRow(rowValues);
    clearModuleRegistryCache();
    return { status: 'created', key: mod.key };
  }


  /**
   * Toggles a module's enabled flag.
   */
  function setEnabled(key, enabled) {
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    const col   = HEADERS.indexOf('Enabled') + 1;

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === key) {
        sheet.getRange(i + 1, col).setValue(enabled ? 'TRUE' : 'FALSE');
        clearModuleRegistryCache();
        return { status: 'ok', key, enabled };
      }
    }
    throw new Error('Module not found: ' + key);
  }


  /**
   * Removes a module row entirely. The Admin module cannot be deleted.
   */
  function remove(key) {
    if (key === 'admin') throw new Error('The Admin module cannot be removed.');
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === key) {
        sheet.deleteRow(i + 1);
        clearModuleRegistryCache();
        return { status: 'deleted', key };
      }
    }
    throw new Error('Module not found: ' + key);
  }


  // ── Private helpers ────────────────────────────────────────

  /**
   * Ensures the Modules tab exists with headers and a seed Admin row.
   */
  function _ensureSheet() {
    const ss = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
    let sheet = ss.getSheetByName(CONFIG.TABS.MODULES);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.TABS.MODULES);
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#e8eaed');
      sheet.setFrozenRows(1);
      // Seed default rows so a fresh install has working modules
      sheet.appendRow(['admin',       'Admin',       'ti-settings',  'super_admin',                 'AdminModule',       'admin',       0, 'TRUE']);
      sheet.appendRow(['submissions', 'Submissions', 'ti-file-text', 'super_admin, staff, senate_faculty, lecturer, graduate_student, undergraduate_student', 'SubmissionsModule', 'submissions', 1, 'TRUE']);
      sheet.appendRow(['users',       'User Management', 'ti-users',   'super_admin, staff',        'UserManagerModule', 'users',       2, 'TRUE']);
    }
    return sheet;
  }

  function _rowToRecord(row) {
    return {
      key:     String(row[0]).trim(),
      label:   String(row[1]).trim(),
      icon:    String(row[2]).trim(),
      roles:   String(row[3]).split(',').map(r => r.trim()).filter(Boolean),
      handler: String(row[4]).trim(),
      include: String(row[5]).trim(),
      order:   Number(row[6]) || 99,
      enabled: String(row[7]).trim().toUpperCase() !== 'FALSE',
    };
  }


  return { list, availableHandlers, upsert, setEnabled, remove };

})();