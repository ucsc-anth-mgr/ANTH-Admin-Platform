// ============================================================
// DiagnoseCoursework.gs — TEMPORARY diagnostic (delete after use)
// ============================================================
// Two functions, run from the Apps Script editor (function dropdown):
//
//   1. diagnoseCoursework() — checks every id and resource the
//      coursework module's delete path touches, one step at a time,
//      and logs OK/FAIL per step. The first FAIL line names the
//      exact broken piece.
//
//   2. deleteCourseworkPetitionById() — paste the PetitionID into
//      the constant below, then run it. Performs the real delete
//      through the module (files, items, tasks, header row).
//
// The editor executes your SAVED code — the same code /dev serves —
// so if everything here passes but the web page still throws
// "Invalid argument: id", the page is running a stale /exec
// deployment and the fix is Deploy → Manage deployments → Edit →
// New version.
// ============================================================

function diagnoseCoursework() {
  const step = (label, fn) => {
    try {
      const v = fn();
      Logger.log('OK   — ' + label + (v !== undefined ? ' → ' + v : ''));
      return v;
    } catch (e) {
      Logger.log('FAIL — ' + label + ' → ' + e);
      return null;
    }
  };

  Logger.log('=== Coursework delete-path diagnostic ===');
  Logger.log('Running as: ' + Session.getActiveUser().getEmail());

  step('CONFIG.SHEETS.COURSEWORK is set', () => {
    const id = String((CONFIG.SHEETS && CONFIG.SHEETS.COURSEWORK) || '').trim();
    if (!id) throw new Error('blank/missing — the live Config.gs lacks the id');
    return id;
  });

  step('Coursework spreadsheet opens', () =>
    SpreadsheetApp.openById(CONFIG.SHEETS.COURSEWORK).getName());

  step('Coursework tabs present', () => {
    const ss = SpreadsheetApp.openById(CONFIG.SHEETS.COURSEWORK);
    return [CONFIG.TABS.COURSEWORK_PETITIONS, CONFIG.TABS.COURSEWORK_ITEMS,
            CONFIG.TABS.COURSEWORK_INSTITUTIONS, CONFIG.TABS.COURSEWORK_SETTINGS]
      .map(t => t + '=' + (ss.getSheetByName(t) ? 'yes' : 'MISSING'))
      .join(', ');
  });

  step('Uploads folder opens (CONFIG.COURSEWORK.DRIVE_FOLDER_ID)', () =>
    DriveApp.getFolderById(String((CONFIG.COURSEWORK || {}).DRIVE_FOLDER_ID || '')).getName());

  step('PLATFORM spreadsheet opens (Tasks live here)', () =>
    SpreadsheetApp.openById(CONFIG.SHEETS.PLATFORM).getName());

  step('AUDIT_LOG spreadsheet opens (dispatch writes here)', () =>
    SpreadsheetApp.openById(CONFIG.SHEETS.AUDIT_LOG).getName());

  step('Module handler is registered', () => {
    const h = getModuleHandler('CourseworkPetitionModule');
    if (typeof h.deletePetition !== 'function') throw new Error('deletePetition missing from handler');
    return 'deletePetition present';
  });

  const rows = step('Petitions readable via DataService', () =>
    DataService.getAll(CONFIG.SHEETS.COURSEWORK, CONFIG.TABS.COURSEWORK_PETITIONS));
  if (rows) {
    Logger.log('      ' + rows.length + ' petition(s):');
    rows.forEach(r => {
      Logger.log('      • ' + r.PetitionID + '  [' + r.Stage + ']  ' + r.StudentEmail
        + (String(r.DriveFileID || '').trim() ? '  (has PDF file)' : ''));
      const items = DataService.query(CONFIG.SHEETS.COURSEWORK,
        CONFIG.TABS.COURSEWORK_ITEMS, 'PetitionID', r.PetitionID);
      items.forEach(it => {
        Logger.log('          - ' + it.ItemID + '  ' + (it.CourseID || '')
          + '  transcriptFile=' + (String(it.TranscriptFileID || '').trim() || 'none')
          + '  syllabusFile=' + (String(it.SyllabusFileID || '').trim() || 'none'));
      });
    });
    // Verify each referenced Drive file id actually resolves (a corrupt
    // stored id is the one way real data could produce an id error).
    rows.forEach(r => {
      const ids = [];
      if (String(r.DriveFileID || '').trim()) ids.push(['PDF ' + r.PetitionID, r.DriveFileID]);
      DataService.query(CONFIG.SHEETS.COURSEWORK, CONFIG.TABS.COURSEWORK_ITEMS,
        'PetitionID', r.PetitionID).forEach(it => {
          if (String(it.TranscriptFileID || '').trim()) ids.push(['transcript ' + it.ItemID, it.TranscriptFileID]);
          if (String(it.SyllabusFileID || '').trim()) ids.push(['syllabus ' + it.ItemID, it.SyllabusFileID]);
        });
      ids.forEach(([label, id]) =>
        step('Drive file resolves: ' + label, () => DriveApp.getFileById(String(id).trim()).getName()));
    });
  }

  Logger.log('=== If every line is OK: the saved code is healthy. ===');
  Logger.log('=== Then a failing web page means a stale /exec deployment: ===');
  Logger.log('=== Deploy → Manage deployments → Edit → New version.       ===');
  Logger.log('=== To delete a petition from here: paste its id into        ===');
  Logger.log('=== deleteCourseworkPetitionById() below and run it.         ===');
}


function deleteCourseworkPetitionById() {
  const PETITION_ID = 'CWP-MSP1MC9P-Z0OT';   // e.g. 'CWP-XXXXXXX-XXXX'

  if (PETITION_ID.indexOf('PASTE') === 0) {
    Logger.log('Edit this function first: paste the PetitionID from the diagnostic listing.');
    return;
  }
  const me = Session.getActiveUser().getEmail();
  const result = CourseworkPetitionModule.deletePetition(
    { petitionId: PETITION_ID }, me, ['super_admin']);
  Logger.log('Deleted: ' + JSON.stringify(result));
}