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
  THESIS_ELIGIBILITY: {
    tab: 'ThesisEligibility',
    // Who may sponsor / read senior theses. Roles is the base set; the
    // per-person Allow/Deny lists are exceptions managed via the Admin
    // faculty roster. super_admin is always eligible regardless.
    headers: ['Capability', 'Roles', 'AllowEmails', 'DenyEmails'],
    seed: [
      ['sponsor', 'senate_faculty, lecturer', '', ''],
      ['reader',  'senate_faculty, lecturer', '', ''],
    ],
  },
  THESIS_SETTINGS: {
    tab: 'ThesisSettings',
    // UI-managed operational settings (key/value). Seeded from the
    // CONFIG.THESIS defaults; the sheet overrides them once saved.
    headers: ['Key', 'Value'],
    seed: [
      ['NOTIFY_ON_HANDOFF', 'TRUE'],
    ],
  },
  TASKS: {
    tab: 'Tasks',
    // Pointer-only "needs attention" queue. SourceID references the
    // authoritative record in the owning module's own sheet; no business
    // data is stored here. Created/Resolved/Updated meta columns are
    // written by DataService and the Tasks service.
    //
    // Time fields:
    //   DueAt          — hard deadline, supplied by the module/workflow
    //                    (domain knowledge). Blank = no deadline.
    //   StaleAfterDays — neglect threshold in days, supplied by the
    //                    module/workflow. Blank = never flagged stale.
    //   LastActivityAt — owned by the Tasks service; stamped on create
    //                    and bumped on resolve/update/touch. Drives the
    //                    staleness computation. NOT a workflow field.
    headers: ['TaskID', 'Module', 'SourceType', 'SourceID', 'Label',
              'AssignedTo', 'AssignedRole', 'Status', 'Note',
              'DueAt', 'StaleAfterDays', 'LastActivityAt',
              'CreatedAt', 'CreatedBy', 'ResolvedAt', 'ResolvedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  THESIS: {
    tab: 'Thesis',
    // Senior thesis records (one per student per term). Identity is NOT
    // copied here — StudentEmail/SponsorEmail/ReaderEmail are routing keys;
    // names and Student ID are read from Auth at display time. DriveFileID
    // is the stored PDF (replaced in place on resubmission); DocumentLink is
    // its viewable URL, captured automatically at upload.
    headers: ['ThesisID', 'StudentEmail', 'Quarter', 'Year', 'ShareConsent',
              'Title', 'Abstract', 'Regions', 'SponsorEmail', 'DriveFileID', 'FileName', 'DocumentLink',
              'Stage',
              'SponsorDecision', 'SponsorComments', 'SponsorDecidedBy', 'SponsorDecidedAt',
              'ReaderEmail', 'HonorsDecision', 'ReaderComments', 'ReaderDecidedBy', 'ReaderDecidedAt',
              'AdvisorProcessedBy', 'AdvisorProcessedAt', 'MilestoneEntered', 'ReturnNote',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
};


/**
 * Main entry point. Run this once from the editor.
 */
function setUp() {
  Logger.log('=== UCSC Anthropology Portal — Sheet setup ===');

  // Resolve (or create) the spreadsheets
  const usersSS  = _resolveSpreadsheet(CONFIG.SHEETS.USERS_CONFIG,  'Portal Config (Users, Roles, Modules)', 'USERS_CONFIG');
  const auditSS  = _resolveSpreadsheet(CONFIG.SHEETS.AUDIT_LOG,     'Portal Audit Log',                      'AUDIT_LOG');
  const submitSS = _resolveSpreadsheet(CONFIG.SHEETS.SUBMISSIONS,   'Portal Submissions',                    'SUBMISSIONS');
  const platformSS = _resolveSpreadsheet(CONFIG.SHEETS.PLATFORM,    'Portal Platform Services',              'PLATFORM');
  const thesisSS = _resolveSpreadsheet(CONFIG.SHEETS.THESIS,        'Portal Senior Thesis',                  'THESIS');

  // Config spreadsheet gets Users, Roles, Modules, Requests tabs
  _setupTab(usersSS, SETUP_SCHEMA.USERS);
  _setupTab(usersSS, SETUP_SCHEMA.ROLES);
  _setupTab(usersSS, SETUP_SCHEMA.MODULES);
  _setupTab(usersSS, SETUP_SCHEMA.REQUESTS);
  _setupTab(usersSS, SETUP_SCHEMA.IMPORT_POLICY);
  _setupTab(usersSS, SETUP_SCHEMA.NOTIFY_RULES);
  _setupTab(usersSS, SETUP_SCHEMA.THESIS_ELIGIBILITY);
  _setupTab(usersSS, SETUP_SCHEMA.THESIS_SETTINGS);

  // Audit spreadsheet gets the AuditLog tab
  _setupTab(auditSS, SETUP_SCHEMA.AUDIT);

  // Platform-services spreadsheet gets the Tasks tab (its first tenant)
  _setupTab(platformSS, SETUP_SCHEMA.TASKS);

  // Senior Thesis spreadsheet gets the Thesis tab
  _setupTab(thesisSS, SETUP_SCHEMA.THESIS);
  _tidyDefaultSheet(thesisSS);

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

  // Auto-size columns for readability. Only resize columns that actually
  // exist on the sheet: an existing tab may have FEWER physical columns
  // than def.headers (e.g. the schema gained columns since the tab was
  // first created). Resizing beyond the sheet's width throws
  // "Those columns are out of bounds." Missing columns are added later by
  // addMissingColumns(), not here — setUp never modifies an existing tab.
  const physicalCols = sheet.getLastColumn();
  const resizeCount = Math.min(def.headers.length, physicalCols);
  if (resizeCount > 0) {
    sheet.autoResizeColumns(1, resizeCount);
  }
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
    ['PLATFORM',     CONFIG.SHEETS.PLATFORM,     [SETUP_SCHEMA.TASKS.tab]],
    ['THESIS',       CONFIG.SHEETS.THESIS,       [SETUP_SCHEMA.THESIS.tab]],
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


/**
 * Maps each schema tab to the CONFIG.SHEETS key whose spreadsheet holds
 * it. Single source of truth for "which tab lives in which spreadsheet,"
 * used by the non-destructive migration helper below. Mirrors the
 * placement that setUp() performs.
 */
function _schemaPlacement() {
  return [
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.USERS },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.ROLES },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.MODULES },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.REQUESTS },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.IMPORT_POLICY },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.NOTIFY_RULES },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.THESIS_ELIGIBILITY },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.THESIS_SETTINGS },
    { sheetKey: 'AUDIT_LOG',    def: SETUP_SCHEMA.AUDIT },
    { sheetKey: 'PLATFORM',     def: SETUP_SCHEMA.TASKS },
    { sheetKey: 'THESIS',       def: SETUP_SCHEMA.THESIS },
  ];
}


/**
 * Non-destructive schema migration: for every existing tab, appends any
 * header columns present in SETUP_SCHEMA but missing from the live sheet.
 *
 * SAFETY — this ONLY ever ADDS columns to the right:
 *   - never deletes a column, never renames one, never reorders;
 *   - never touches data rows;
 *   - skips tabs that don't exist yet (that's setUp()'s job);
 *   - skips a spreadsheet whose CONFIG id is blank/unopenable.
 * Because the platform reads columns BY HEADER NAME, appending at the end
 * is fully sufficient — position never matters to the code.
 *
 * Run this from the editor after adding fields to a SETUP_SCHEMA tab
 * (e.g. the Tasks time columns) instead of deleting and recreating a tab.
 * Safe to re-run: a tab already matching the schema is left untouched.
 */
function addMissingColumns() {
  Logger.log('=== addMissingColumns (non-destructive) ===');
  let totalAdded = 0;

  _schemaPlacement().forEach(({ sheetKey, def }) => {
    const id = CONFIG.SHEETS[sheetKey];
    if (!id) {
      Logger.log('• ' + def.tab + ': skipped — CONFIG.SHEETS.' + sheetKey + ' is blank.');
      return;
    }

    let ss;
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (e) {
      Logger.log('• ' + def.tab + ': skipped — cannot open ' + sheetKey + ' (' + e.message + ').');
      return;
    }

    const sheet = ss.getSheetByName(def.tab);
    if (!sheet) {
      Logger.log('• ' + def.tab + ': skipped — tab does not exist yet (run setUp to create it).');
      return;
    }

    // Read the current header row. An empty tab has no headers to compare;
    // leave it for setUp() rather than half-populating it here.
    const lastCol = sheet.getLastColumn();
    if (sheet.getLastRow() === 0 || lastCol === 0) {
      Logger.log('• ' + def.tab + ': skipped — tab is empty (run setUp to add headers).');
      return;
    }

    const liveHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(h => String(h).trim());
    const missing = def.headers.filter(h => liveHeaders.indexOf(h) === -1);

    if (!missing.length) {
      Logger.log('• ' + def.tab + ': up to date (' + liveHeaders.length + ' columns).');
      return;
    }

    // Append missing headers to the right of the existing ones.
    const startCol = lastCol + 1;
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
    sheet.getRange(1, startCol, 1, missing.length)
         .setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
    sheet.autoResizeColumns(1, startCol + missing.length - 1);

    totalAdded += missing.length;
    Logger.log('    ✓ ' + def.tab + ': added ' + missing.length
               + ' column(s) → ' + missing.join(', '));
  });

  Logger.log('');
  Logger.log(totalAdded === 0
    ? '=== All tabs already match the schema. ==='
    : '=== Done: added ' + totalAdded + ' column(s) total. ===');
}