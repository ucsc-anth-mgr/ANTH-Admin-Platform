// ============================================================
// Setup.gs — One-time Google Sheets setup
// ============================================================
// Run setUp() once from the Apps Script editor to create every
// tab the platform needs, with correct headers and seed data.
//
// HOW TO RUN:
//   1. Open the Apps Script editor
//   2. Select "setUp" in the function dropdown (top toolbar)
//   3. Click Run, and authorize when prompted
//   4. Read the log (View > Logs, or the execution output):
//      - If your CONFIG.SHEETS IDs were still placeholders, this
//        creates new spreadsheets and logs their IDs — paste those
//        IDs into Config.gs, then you're done.
//      - If your IDs were already filled in, it sets up tabs inside
//        those existing spreadsheets.
//
// SAFE TO RE-RUN: existing tabs and data are never overwritten.
// Missing tabs/headers are added; present ones are left alone.
//
// FOLDER PLACEMENT: if CONFIG.SETUP_FOLDER_ID is set, newly created
// spreadsheets are moved into that Drive folder. Otherwise they're
// created in your My Drive root. (Moving files requires authorizing
// Drive access the first time you run setUp.)
// ============================================================

// Tab definitions: name -> header row
const SETUP_SCHEMA = {
  USERS: {
    tab: 'Users',
    headers: ['Email', 'FirstName', 'LastName', 'AltNames', 'Roles', 'StudentID', 'EmployeeID', 'Active', 'Notes'],
    seed: [],   // first super-admin is handled via CONFIG.SUPER_ADMINS
  },
  ROLES: {
    tab: 'Roles',
    headers: ['Role', 'Description'],
    seed: [
      ['super_admin',           'Full system access; protected'],
      ['staff',                 'Department staff'],
      ['senate_faculty',        'Senate faculty members'],
      ['lecturer',              'Lecturers and teaching faculty'],
      ['graduate_student',      'Graduate students'],
      ['undergraduate_student', 'Undergraduate students'],
      ['visitor',               'Visitors and limited-access users'],
    ],
  },
  MODULES: {
    tab: 'Modules',
    headers: ['Key', 'Label', 'Icon', 'Roles', 'Handler', 'Include', 'Order', 'Enabled'],
    seed: [
      ['admin', 'Admin', 'ti-settings', 'super_admin', 'AdminModule', 'admin', 0, 'TRUE'],
      ['submissions', 'Submissions', 'ti-file-text',
       'super_admin, staff, senate_faculty, lecturer, graduate_student, undergraduate_student',
       'SubmissionsModule', 'submissions', 1, 'TRUE'],
      ['users', 'User Management', 'ti-users', 'super_admin, staff', 'UserManagerModule', 'users', 2, 'TRUE'],
    ],
  },
  AUDIT: {
    tab: 'AuditLog',
    headers: ['Timestamp', 'User', 'Module', 'Action', 'Payload', 'Status', 'Notes'],
    seed: [],
  },
  REQUESTS: {
    tab: 'Requests',
    headers: ['RequestID', 'Email', 'FirstName', 'LastName', 'IDType', 'IDNumber', 'RequestedRole', 'Note', 'Status', 'SubmittedAt', 'DecidedBy', 'DecidedAt', 'DecisionNote'],
    seed: [],
  },
  IMPORT_POLICY: {
    tab: 'ImportPolicy',
    headers: ['ImporterRole', 'AssignableRoles'],
    seed: [],
  },
  NOTIFY_RULES: {
    tab: 'NotifyRules',
    headers: ['RequestedRole', 'NotifyEmails', 'Note'],
    seed: [
      ['undergraduate_student', '', 'Comma-separated emails notified when this role is requested (super admins are always notified)'],
      ['graduate_student', '', ''],
      ['visitor', '', ''],
    ],
  },
};


/**
 * Main entry point. Run this once from the editor.
 */
function setUp() {
  Logger.log('=== UCSC Anthropology Portal — Sheet setup ===');

  // Resolve (or create) the three spreadsheets
  const usersSS  = _resolveSpreadsheet(CONFIG.SHEETS.USERS_CONFIG,  'Portal Config (Users, Roles, Modules)', 'USERS_CONFIG');
  const auditSS  = _resolveSpreadsheet(CONFIG.SHEETS.AUDIT_LOG,     'Portal Audit Log',                      'AUDIT_LOG');
  const submitSS = _resolveSpreadsheet(CONFIG.SHEETS.SUBMISSIONS,   'Portal Submissions',                    'SUBMISSIONS');

  // Config spreadsheet gets Users, Roles, Modules, Requests tabs
  _setupTab(usersSS, SETUP_SCHEMA.USERS);
  _setupTab(usersSS, SETUP_SCHEMA.ROLES);
  _setupTab(usersSS, SETUP_SCHEMA.MODULES);
  _setupTab(usersSS, SETUP_SCHEMA.REQUESTS);
  _setupTab(usersSS, SETUP_SCHEMA.IMPORT_POLICY);
  _setupTab(usersSS, SETUP_SCHEMA.NOTIFY_RULES);

  // Audit spreadsheet gets the AuditLog tab
  _setupTab(auditSS, SETUP_SCHEMA.AUDIT);

  // Submissions spreadsheet: tabs are created per form type on demand,
  // so we just ensure the spreadsheet exists and remove the default
  // empty "Sheet1" only if it's untouched.
  _tidyDefaultSheet(submitSS);

  // Ensure the current runner is a usable super-admin
  _ensureSuperAdminNote();

  Logger.log('');
  Logger.log('=== Setup complete ===');
  Logger.log('If any IDs were created above, paste them into CONFIG.SHEETS in Config.gs.');
  Logger.log('Then deploy/redeploy and open the web app.');
}


/**
 * Returns a Spreadsheet for the given configured ID. If the ID is
 * still a placeholder (or invalid), creates a new spreadsheet and
 * logs its ID so the admin can paste it into Config.gs.
 */
function _resolveSpreadsheet(configuredId, newName, configKey) {
  const looksPlaceholder = !configuredId
    || configuredId.indexOf('YOUR_') === 0
    || configuredId.length < 20;

  if (!looksPlaceholder) {
    try {
      const ss = SpreadsheetApp.openById(configuredId);
      Logger.log('• ' + configKey + ': using existing sheet "' + ss.getName() + '"');
      return ss;
    } catch (e) {
      Logger.log('• ' + configKey + ': ID "' + configuredId + '" could not be opened — creating a new sheet instead.');
    }
  }

  const ss = SpreadsheetApp.create(newName);
  _moveToFolder(ss.getId(), newName, configKey);
  Logger.log('• ' + configKey + ': CREATED new sheet "' + newName + '"');
  Logger.log('    → set CONFIG.SHEETS.' + configKey + " = '" + ss.getId() + "'");
  return ss;
}


/**
 * Moves a newly created file into CONFIG.SETUP_FOLDER_ID, if set.
 * SpreadsheetApp.create() always places files in My Drive root, so
 * we relocate afterward. Silently no-ops (stays in root) if no folder
 * is configured; logs a warning if the folder ID is invalid.
 */
function _moveToFolder(fileId, name, configKey) {
  const folderId = (CONFIG.SETUP_FOLDER_ID || '').trim();
  if (!folderId) {
    Logger.log('    • ' + configKey + ': placed in My Drive root (no SETUP_FOLDER_ID set)');
    return;
  }
  try {
    const folder = DriveApp.getFolderById(folderId);
    const file   = DriveApp.getFileById(fileId);
    file.moveTo(folder);   // moveTo relocates (not just adds) the file
    Logger.log('    ✓ ' + configKey + ': moved into folder "' + folder.getName() + '"');
  } catch (e) {
    Logger.log('    ⚠ ' + configKey + ': could not move into SETUP_FOLDER_ID "' + folderId
               + '" (' + e.message + '). File remains in My Drive root.');
  }
}


/**
 * Ensures a tab exists with the given headers and seed rows.
 * - Creates the tab if missing.
 * - Adds the header row if the tab is empty.
 * - Adds seed rows only if the tab has just a header (no data yet).
 * Never overwrites existing data.
 */
function _setupTab(ss, def) {
  let sheet = ss.getSheetByName(def.tab);
  let created = false;

  if (!sheet) {
    sheet = ss.insertSheet(def.tab);
    created = true;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow === 0) {
    // Empty tab — add headers
    sheet.appendRow(def.headers);
    sheet.getRange(1, 1, 1, def.headers.length)
         .setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);

    // Seed rows (only for a fresh tab)
    if (def.seed && def.seed.length) {
      def.seed.forEach(row => sheet.appendRow(row));
      Logger.log('    ✓ ' + def.tab + ': created with headers + ' + def.seed.length + ' seed row(s)');
    } else {
      Logger.log('    ✓ ' + def.tab + ': created with headers');
    }
  } else {
    Logger.log('    • ' + def.tab + ': already has ' + (lastRow - 1) + ' data row(s) — left unchanged'
               + (created ? ' (tab was just created)' : ''));
  }

  // Auto-size columns for readability
  sheet.autoResizeColumns(1, def.headers.length);
}


/**
 * Removes the default "Sheet1" from a newly created spreadsheet if it's
 * empty and there is at least one other sheet, to keep things tidy.
 */
function _tidyDefaultSheet(ss) {
  const sheets = ss.getSheets();
  if (sheets.length <= 1) {
    Logger.log('    • Submissions: ready (form-type tabs are created on first submission)');
    return;
  }
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && sheets.length > 1) {
    ss.deleteSheet(def);
    Logger.log('    ✓ Submissions: removed empty default Sheet1');
  }
}


/**
 * Logs guidance about the super-admin. Does not modify the Users tab,
 * since super-admins are recognized via CONFIG.SUPER_ADMINS regardless.
 */
function _ensureSuperAdminNote() {
  const me = Session.getActiveUser().getEmail();
  const admins = CONFIG.SUPER_ADMINS.map(a => a.toLowerCase());
  if (admins.indexOf(me.toLowerCase()) === -1) {
    Logger.log('');
    Logger.log('⚠ You (' + me + ') are NOT in CONFIG.SUPER_ADMINS.');
    Logger.log('  Add your email to SUPER_ADMINS in Config.gs so you can reach the Admin area,');
    Logger.log('  or add a row in the Users tab: ' + me + ' | (name) | super_admin | | | TRUE | Initial admin');
  } else {
    Logger.log('• Super-admin confirmed: ' + me);
  }
}


/**
 * Optional helper: prints the current configured sheet IDs and whether
 * each opens successfully. Handy for verifying Config after setup.
 */
function checkSetup() {
  const checks = [
    ['USERS_CONFIG', CONFIG.SHEETS.USERS_CONFIG, [SETUP_SCHEMA.USERS.tab, SETUP_SCHEMA.ROLES.tab, SETUP_SCHEMA.MODULES.tab]],
    ['AUDIT_LOG',    CONFIG.SHEETS.AUDIT_LOG,    [SETUP_SCHEMA.AUDIT.tab]],
    ['SUBMISSIONS',  CONFIG.SHEETS.SUBMISSIONS,  []],
  ];
  Logger.log('=== Config check ===');
  checks.forEach(([key, id, tabs]) => {
    try {
      const ss = SpreadsheetApp.openById(id);
      const present = ss.getSheets().map(s => s.getName());
      const missing = tabs.filter(t => present.indexOf(t) === -1);
      Logger.log('• ' + key + ': OK ("' + ss.getName() + '")'
                 + (missing.length ? ' — MISSING tabs: ' + missing.join(', ') : ''));
    } catch (e) {
      Logger.log('• ' + key + ': CANNOT OPEN id="' + id + '" — ' + e.message);
    }
  });
}