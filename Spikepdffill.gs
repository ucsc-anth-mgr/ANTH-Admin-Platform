// ============================================================
// SpikePdfFill.gs — THROWAWAY pdf-lib runtime spike
// ============================================================
// Proves the whole fill pipeline inside the real Apps Script
// runtime before any module code exists:
//
//   Drive template bytes → PDFLib.load → list fields →
//   fill (text + both radio groups) → flatten → save → Drive
//
// HOW TO RUN: in the Apps Script editor, select spikeGispFill in
// the function dropdown and Run. First run will prompt for Drive
// authorization. Check the execution log for the field list and
// the output file URL, then open the file and eyeball it.
//
// REQUIRES: PdfLib.gs in the project (defines the PDFLib global)
// and CONFIG.GRAD_INDIVIDUAL_STUDIES.TEMPLATE_FILE_ID set.
//
// NOTES for the real ReportService.fillTemplate later:
//   - async/await works in Apps Script V8; the runtime drains the
//     microtask queue before the execution ends, so an async
//     function run from the editor (or from dispatch) completes
//     normally.
//   - DriveApp.getBytes() returns SIGNED bytes; new Uint8Array(..)
//     wraps them mod 256, which is exactly the conversion needed.
//   - parseSpeed / objectsPerTick = Infinity skip pdf-lib's
//     browser-yield machinery entirely (PdfLib.gs also shims
//     setTimeout as the safety net — see its header).
//   - Radio groups are selected by OPTION NAME ('297A'…'299C',
//     'Yes'/'No'); pdf-lib maps names to appearance states itself.
//
// DELETE THIS FILE once fillTemplate ships.
// ============================================================

async function spikeGispFill() {
  if (typeof PDFLib === 'undefined') {
    throw new Error('PDFLib global missing — is PdfLib.gs in the project?');
  }
  const { PDFDocument, ParseSpeeds } = PDFLib;

  // 1. Template bytes from Drive.
  const templateId = CONFIG.GRAD_INDIVIDUAL_STUDIES.TEMPLATE_FILE_ID;
  const blob = DriveApp.getFileById(templateId).getBlob();
  const doc = await PDFDocument.load(new Uint8Array(blob.getBytes()), {
    parseSpeed: ParseSpeeds.Fastest,
  });
  const form = doc.getForm();

  // 2. Verify we are holding the right template: log every field.
  const names = form.getFields().map(f =>
    f.constructor.name + ': ' + f.getName());
  Logger.log('Fields (' + names.length + '):\n' + names.join('\n'));

  // 3. Fill one of everything.
  form.getTextField('ClassNumber').setText('63421');
  form.getRadioGroup('Course').select('299B');
  form.getTextField('StudentName').setText('Spike Test');
  form.getTextField('Quarter').setText('Spring');
  form.getTextField('Year').setText('2026');
  form.getTextField('StudentEmail').setText('spike@ucsc.edu');
  form.getTextField('StudyOutline').setText(
    'Multiline spike: line one of the outline.\n' +
    'Line two, confirming wrapping and the multiline flag survive the round trip.');
  form.getRadioGroup('FinalPaperRequired').select('Yes');
  form.getTextField('StudentSignature').setText(
    'Spike Test (electronic, ' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + ')');

  // 4. Flatten (fields become static page content) and save.
  form.flatten();
  const outBytes = await doc.save({ objectsPerTick: Infinity });

  // 5. Back to Drive. Throwaway output — lands in My Drive root.
  const outBlob = Utilities.newBlob(
    Array.from(outBytes), 'application/pdf', 'SPIKE_gisp_fill.pdf');
  const file = DriveApp.createFile(outBlob);
  Logger.log('Wrote ' + outBytes.length + ' bytes → ' + file.getUrl());
  return file.getUrl();
}