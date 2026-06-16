// ============================================================
// TranscriptModule_test.gs — editor-run harness (Layer 1)
// ============================================================
// TEMPORARY diagnostic scaffolding. Run these from the Apps Script
// editor (function dropdown → Run → read View ▸ Logs). They verify the
// ASSIST sync against LIVE data before the module is surfaced in the nav.
//
// None of these write to the Articulations / ArticulationReview sheets —
// they are read-and-inspect only (testSyncDryRun calls the module's
// `diagnose` action; testRealSync is the one that actually writes, and is
// clearly labelled). Delete this file once Layer 1 is verified.
//
// Why a harness instead of the UI: two ASSIST endpoints could not be
// confirmed offline — the feeder-list route (_assistGetSendingInstitutions)
// and receiving-course extraction from a real Major agreement. This proves
// them against the live API so the UI isn't built on unverified ground.
//
// Requires (in the project): TranscriptModule.gs, Config.gs with the
// CONFIG.TRANSCRIPT block. Does NOT require the Modules sheet row, the
// Transcript spreadsheet, or any UI — diagnose() touches no sheets.
// ============================================================

/**
 * STEP 1+2 DRY RUN — the main thing to run first.
 * Probes the feeder list, then for the first few colleges finds and parses
 * the UCSC Anthropology agreement. Writes nothing. Logs a readable report.
 *
 * Reading the output:
 *   step1.ok=true and a non-zero ccCount  → feeder-list route works.
 *   sampleTrusted shows "CABRILLO: ANTH 1 → ANTH 1 (Intro...)" with REAL
 *     UCSC course codes/titles  → receiving-course extraction works.
 *   If sampleTrusted rows have blank receiving codes, extraction needs a
 *     tweak — copy a sampleFlagged RawCell (see testDumpOneAgreement) so we
 *     can see where ASSIST nested the receiving course.
 */
function testSyncDryRun() {
  const roles = ['super_admin']; // editor-run; emulate an authorized caller
  const report = TranscriptModule.diagnose(
    { academicYearId: 76, maxColleges: 3, sampleRows: 8 }, // 76 = 2025-2026
    Session.getActiveUser().getEmail(),
    roles
  );
  Logger.log('=== Transcript sync DRY RUN (no writes) ===');
  Logger.log('Year: ' + report.academicYearCode);
  Logger.log('');
  Logger.log('STEP 1 — feeder list (CCCs with a UCSC agreement):');
  Logger.log('  ok: ' + report.step1_feederList.ok +
             '  |  CCC count: ' + report.step1_feederList.ccCount);
  if (report.step1_feederList.error) {
    Logger.log('  ERROR: ' + report.step1_feederList.error);
    Logger.log('  → the feeder-list route likely needs adjusting in ' +
               '_assistGetSendingInstitutions. Run testProbeFeederRoute().');
    return;
  }
  Logger.log('  sample: ' + report.step1_feederList.sample.join('  |  '));
  Logger.log('');
  Logger.log('STEP 2 — Anthropology agreements (first ' +
             report.step2_agreements.length + ' colleges):');
  report.step2_agreements.forEach(r => {
    Logger.log('  • ' + r.collegeName + '  [' + (r.anthroLabel || '?') + ']' +
               '  trusted=' + r.trusted + ' flagged=' + r.flagged +
               (r.error ? '  ERROR: ' + r.error : ''));
  });
  Logger.log('');
  Logger.log('SAMPLE TRUSTED (clean 1:1 — verify REAL UCSC codes appear):');
  report.sampleTrusted.forEach(s => Logger.log('  ' + s));
  if (!report.sampleTrusted.length) Logger.log('  (none — see flagged, or extraction needs a look)');
  Logger.log('');
  Logger.log('SAMPLE FLAGGED (for advisor review):');
  report.sampleFlagged.forEach(s => Logger.log('  ' + s));
  if (!report.sampleFlagged.length) Logger.log('  (none)');
  Logger.log('');
  Logger.log('=== End dry run.  Nothing was written to any sheet. ===');
}

/**
 * Isolates STEP 1 if the dry run reports a feeder-list error. Calls the
 * raw ASSIST route and dumps the first chunk of the response so the JSON
 * wrapper shape can be confirmed and _extractInstitutions adjusted.
 */
function testProbeFeederRoute() {
  const base = (CONFIG.TRANSCRIPT && CONFIG.TRANSCRIPT.ASSIST_API_BASE) || 'https://prod.assistng.org';
  const ucsc = CONFIG.TRANSCRIPT && CONFIG.TRANSCRIPT.UCSC_INSTITUTION_ID;
  const url = base + '/articulation/api/Agreements/Published/from/' + ucsc;
  Logger.log('Probing: ' + url);
  const resp = UrlFetchApp.fetch(url, {
    method: 'get', headers: { accept: 'application/json' },
    muteHttpExceptions: true, followRedirects: true,
  });
  Logger.log('HTTP ' + resp.getResponseCode());
  Logger.log(resp.getContentText().slice(0, 1500));
}

/**
 * Dumps ONE college's Anthropology agreement raw articulations JSON, so the
 * receiving-course nesting can be confirmed if extraction looks off.
 * Defaults to Cabrillo (id 41). Change sendingId to probe another.
 */
function testDumpOneAgreement() {
  const base = (CONFIG.TRANSCRIPT && CONFIG.TRANSCRIPT.ASSIST_API_BASE) || 'https://prod.assistng.org';
  const ucsc = CONFIG.TRANSCRIPT && CONFIG.TRANSCRIPT.UCSC_INSTITUTION_ID;
  const sendingId = 41; // Cabrillo
  const year = 76;

  const listUrl = base + '/articulation/api/Agreements/Published/for/' +
                  ucsc + '/to/' + sendingId + '/in/' + year + '?types=Major';
  const listResp = UrlFetchApp.fetch(listUrl, {
    method: 'get', headers: { accept: 'application/json' }, muteHttpExceptions: true,
  });
  Logger.log('List HTTP ' + listResp.getResponseCode() + ' — ' + listUrl);
  const reports = (JSON.parse(listResp.getContentText()).result || {}).reports || [];
  Logger.log('Agreements found: ' + reports.map(r => r.label).join(' | '));

  const anthro = reports.filter(r => String(r.label).toLowerCase().indexOf('anthropolog') !== -1)[0];
  if (!anthro) { Logger.log('No Anthropology agreement for sendingId ' + sendingId); return; }

  const agUrl = base + '/articulation/api/Agreements?key=' + encodeURIComponent(anthro.key);
  const agResp = UrlFetchApp.fetch(agUrl, {
    method: 'get', headers: { accept: 'application/json' }, muteHttpExceptions: true,
  });
  Logger.log('Agreement HTTP ' + agResp.getResponseCode());
  const result = JSON.parse(agResp.getContentText()).result || {};
  Logger.log('Agreement name: ' + result.name);
  // articulations is a JSON string; pretty-print the first cell so the
  // receiving-course location is visible.
  let artics = result.articulations;
  try { artics = JSON.parse(artics); } catch (e) {}
  Logger.log('Cell count: ' + (artics && artics.length));
  Logger.log('FIRST CELL (inspect where the UCSC course identity lives):');
  Logger.log(JSON.stringify(artics && artics[0], null, 2).slice(0, 3000));
}

/**
 * THE REAL SYNC — WRITES to the Articulations / ArticulationReview sheets.
 * Run this ONLY after the dry run looks correct AND CONFIG.SHEETS.TRANSCRIPT
 * is set (run setUp() first). Logs the full match report.
 */
function testRealSync() {
  if (!CONFIG.SHEETS.TRANSCRIPT) {
    Logger.log('CONFIG.SHEETS.TRANSCRIPT is blank. Run setUp() first and paste the id.');
    return;
  }
  const report = TranscriptModule.syncArticulations(
    { academicYearId: 76, academicYearCode: '2025-2026' },
    Session.getActiveUser().getEmail(),
    ['super_admin']
  );
  Logger.log('=== REAL SYNC complete (sheets written) ===');
  Logger.log('Year: ' + report.academicYearCode);
  Logger.log('Institutions checked: ' + report.institutionsChecked);
  Logger.log('With Anthropology agreement: ' + report.collegesWithAnthroAgreement.length);
  Logger.log('Without: ' + report.collegesWithoutAnthroAgreement.length);
  Logger.log('Trusted rows: ' + report.trustedRowCount +
             '  |  Flagged rows: ' + report.flaggedRowCount);
  if (report.fetchFailures.length) {
    Logger.log('FETCH FAILURES:');
    report.fetchFailures.forEach(f => Logger.log('  • ' + f.college + ': ' + f.error));
  }
  Logger.log('Colleges without an Anthropology agreement:');
  report.collegesWithoutAnthroAgreement.forEach(c => Logger.log('  - ' + c));
}