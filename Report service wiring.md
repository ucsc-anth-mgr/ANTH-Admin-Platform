# ReportService — platform wiring

Three small edits wire `Reportservice.gs` into the platform. None touches a
module. Apply in this order, then run the smoke test.

---

## 1. Config.gs — add `CONFIG.REPORTS` and the tab name

Inside `CONFIG`, alongside `SETUP_FOLDER_ID`:

```js
  // ── Report archive (ReportService) ─────────────────────────
  // ARCHIVE_FOLDER_ID: Drive folder where generated reports are
  //   filed (one auto-created subfolder per module). Required before
  //   the first archived report.
  // LOGO_FILE_ID: Drive file id of the department logo (PNG with
  //   transparency, ~600px wide). Blank = reports render without it;
  //   a broken id is logged and skipped, never fatal.
  // ORG_LINE: second line of the letterhead band.
  REPORTS: {
    ARCHIVE_FOLDER_ID: '',
    LOGO_FILE_ID:      '',
    ORG_LINE:          'Department of Anthropology · UC Santa Cruz',
  },
```

Inside `CONFIG.TABS`:

```js
    REPORTS:     'Reports',
```

---

## 2. Setup.gs — add the Reports tab to SETUP_SCHEMA

Goes in the **PLATFORM** spreadsheet group (same spreadsheet as Tasks —
ReportService is the second platform-services tenant). Add to `SETUP_SCHEMA`:

```js
  REPORTS: {
    tab: 'Reports',
    headers: ['ReportID', 'Module', 'ReportKey', 'SourceID', 'Title', 'Params',
              'DriveFileID', 'URL', 'FileName', 'GeneratedBy',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
```

Make sure this def is included wherever setUp() iterates the PLATFORM sheet's
tabs (mirror however the TASKS def is grouped). Then run `setUp()` — it only
creates the missing tab, existing tabs are untouched.

Column notes:
- `SourceID` is what makes fetch-or-create work (`findArchived(module,
  reportKey, sourceId)`) — for thesis reports it holds the thesisId.
- `Params` is the JSON of inputs/filters, capped at 1000 chars, so any
  archived report is reproducible.
- `GeneratedBy` is written explicitly from the dispatch user; the
  `CreatedAt/CreatedBy` meta pair is filled by DataService.insert as usual.

---

## 3. Notify.gs — optional `attachments`, `replyTo`, `senderName`

Backward-compatible: existing callers change nothing. Two edits inside
`Notify`:

**(a)** In `send(p)`, where the message object is assembled, pass the new
options through. Replace the `_deliver({...})` call with:

```js
      _deliver({ to: to.join(','), subject: subject, body: p.body || '',
                 htmlBody: p.htmlBody, cc: opts.cc,
                 attachments: _collectBlobs(p.attachments),
                 replyTo: _dedupeEmails(_collect(p.replyTo)).join(','),
                 senderName: String(p.senderName || '').trim() });
```

**(b)** Replace `_deliver` and add the blob collector beneath it:

```js
  /**
   * Low-level send. Goes straight to GmailApp whenever cc, attachments,
   * replyTo, or senderName are present (Utils.sendEmail's signature
   * doesn't carry them); otherwise routes through Utils.sendEmail.
   *
   * NOTE on senderName: GmailApp cannot send FROM another account —
   * the sending address is always the deploying/portal account. The
   * `name` option only changes the DISPLAY name shown in the inbox
   * (e.g. "Prof. Lucia Navarro (UCSC Anthropology)"). replyTo controls
   * where a reply actually goes.
   */
  function _deliver(msg) {
    const hasExtras = !!msg.cc || !!msg.replyTo || !!msg.senderName ||
                      (msg.attachments && msg.attachments.length);
    if (hasExtras) {
      const opts = {};
      if (msg.htmlBody)   opts.htmlBody = msg.htmlBody;
      if (msg.cc)         opts.cc = msg.cc;
      if (msg.replyTo)    opts.replyTo = msg.replyTo;
      if (msg.senderName) opts.name = msg.senderName;
      if (msg.attachments && msg.attachments.length) opts.attachments = msg.attachments;
      GmailApp.sendEmail(msg.to, msg.subject, msg.body || '', opts);
    } else {
      Utils.sendEmail({ to: msg.to, subject: msg.subject, body: msg.body, htmlBody: msg.htmlBody });
    }
  }

  /** Normalizes attachments input into an array of blobs (or []). */
  function _collectBlobs(v) {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr.filter(b => b && typeof b.getBytes === 'function');
  }
```

Also update the `send` JSDoc params list:

```
   *   @param {Blob|Blob[]} [p.attachments] - file attachment(s), e.g. a
   *                          certificate PDF from ReportService.generate().blob
   *   @param {string|string[]} [p.replyTo] - reply-to address(es); normalized
   *                          and deduped like to/cc
   *   @param {string} [p.senderName] - inbox display name only; the sending
   *                          ADDRESS is always the deploying account
```

---

## 4. Smoke test (run once from the editor, then delete or keep)

Add temporarily to any .gs file, run from the editor, check the log and the
archive folder. This validates the whole pipeline — conversion, table
fidelity, logo embedding, landscape, footer, archive filing, and the log row:

```js
function testReportService() {
  const out = ReportService.generate({
    module: 'platform-test',
    reportKey: 'smoke',
    title: 'ReportService smoke test',
    sourceId: 'TEST-001',
    params: { purpose: 'pipeline check' },
    html: '<p>Body paragraph with <b>bold</b> and <i>italics</i>.</p>'
        + '<table width="100%" cellpadding="6" cellspacing="0">'
        + '<tr style="background-color:#003C6C;color:#ffffff;">'
        + '<th align="left">Col A</th><th align="left">Col B</th></tr>'
        + '<tr><td>cell</td><td>cell</td></tr>'
        + '<tr style="background-color:#f4f6f8;"><td>zebra</td><td>row</td></tr>'
        + '</table>'
        + ReportService.logoTag(48),
  }, Session.getActiveUser().getEmail());
  Logger.log(JSON.stringify({ reportId: out.reportId, fileId: out.fileId, url: out.url }));
}
```

What to verify in the resulting PDF:
1. Navy letterhead band with the gold rule survived conversion.
2. The table header row is navy with white text and the zebra row is shaded
   (if not, the converter on this domain is stripping cell backgrounds —
   tell me and the templates shift to border-based styling).
3. The logo rendered (only if LOGO_FILE_ID is set).
4. The footer line repeats at the bottom of the page.
5. A `platform-test/` subfolder appeared in the archive folder with the PDF,
   and the Reports tab gained one row.

Run a second variant with `orientation: 'landscape', letterhead: false` and a
trivial `html` to confirm landscape before the certificate template lands.

---

## Two honest limitations (by design, not bugs)

1. **No dynamic page numbers.** DocumentApp cannot insert a "Page X of Y"
   field, so the repeated footer is static text (report id + scope line).
   The mockups' "Page 1 of 1" corner is dropped from the real templates.
2. **Print templates must be table-based.** The Drive HTML→Doc converter does
   not understand flexbox/grid/floats. The mockups were design references;
   the real templates (next step, in ThesisModule) are rebuilt as tables —
   same look, converter-safe markup.
