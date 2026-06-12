// ============================================================
// ReportService.gs — Platform PDF report generation + archive
// ============================================================
// ReportService owns the MECHANISM, not the CONTENT — the same
// split Notify draws. A module composes the report body (HTML it
// alone knows how to write, from data it alone owns) and calls
// generate(); this service owns everything generic:
//
//   • HTML → PDF conversion (HTML → temp Google Doc via the
//     Advanced Drive Service → PDF export → temp Doc trashed)
//   • the branded letterhead wrapper (optional, like htmlWrap)
//   • page setup: orientation, margins, repeated footer
//   • archive filing: <ARCHIVE_FOLDER>/<module>/<file>.pdf
//   • the Reports log tab (PLATFORM sheet — second tenant after
//     Tasks): the queryable index that makes the archive a real
//     backup, and the lookup that powers fetch-or-create
//     (certificates re-send the SAME file, never mint a new one)
//
// WHAT REPORTSERVICE DOES NOT DO: it never reads module data,
// never decides when a report happens, and never picks recipients.
// Triggers, queries, wording, and delivery decisions live in the
// calling module. Adding a module's reports must never require
// editing this file.
//
// REQUIRES: Advanced Drive Service enabled (Services → Drive API)
// — already on in this project for the thesis upload path. The
// HTML→Doc conversion has no DriveApp equivalent, so generate()
// fails loudly (not silently) if the service is missing.
//
// TEMPLATE FIDELITY WARNING for module authors: the Drive HTML→Doc
// converter understands tables, inline styles, background colors,
// bold/italic, and images (as base64 data URIs) — it does NOT
// understand flexbox, grid, or floats. Build print templates with
// <table> layout and simple inline styles, or the page will not
// look like your HTML.
// ============================================================

const ReportService = (() => {

  const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

  // US Letter in points. Used for explicit orientation control on
  // the temp Doc before export.
  const PAGE = { SHORT: 612, LONG: 792, MARGIN: 36 };   // 36pt = 0.5"


  // ── Public: generate ───────────────────────────────────────

  /**
   * Generates a PDF report and (by default) archives it.
   *
   * @param {Object} p
   *   @param {string}  p.module      - owning module key (archive subfolder + log)
   *   @param {string}  p.reportKey   - report type within the module
   *                                    (e.g. 'completion-record', 'certificate')
   *   @param {string}  p.title       - human title (Doc name + log column)
   *   @param {string}  p.html        - module-composed body or full page (see letterhead)
   *   @param {string}  [p.sourceId]  - id of the record this report documents
   *                                    (e.g. thesisId); enables findArchived()
   *   @param {Object}  [p.params]    - filters/inputs used, logged as JSON so
   *                                    the report is reproducible
   *   @param {string}  [p.fileName]  - explicit filename; default is
   *                                    yyyy-MM-dd_HHmm_<module>_<reportKey>.pdf
   *   @param {string}  [p.orientation='portrait'] - 'portrait' | 'landscape'
   *   @param {boolean} [p.letterhead=true] - wrap html in the branded shell.
   *                                    Pass false when the module supplies a
   *                                    complete page (e.g. the certificate).
   *   @param {string}  [p.footerText] - repeated page footer; '' suppresses it.
   *                                    Default: app title + report id + scope line.
   *   @param {boolean} [p.archive=true]      - file in the archive + log a row
   *   @param {boolean} [p.returnBase64=false]- include dataBase64 for a client
   *                                    download (the only way to get the PDF
   *                                    out when archive is false)
   * @param {string} user - acting user's email (from dispatch; printed on the
   *                        letterhead and logged as GeneratedBy)
   * @returns {{ reportId: string|null, fileId: string|null, url: string|null,
   *             fileName: string, blob: Blob, dataBase64: string|null }}
   *          blob is for SERVER-SIDE use only (e.g. a Notify attachment) —
   *          modules must never pass it through to the client.
   */
  function generate(p, user) {
    p = p || {};
    const module    = String(p.module || '').trim();
    const reportKey = String(p.reportKey || '').trim();
    const title     = String(p.title || '').trim();
    if (!module)    throw new Error('ReportService.generate: module is required.');
    if (!reportKey) throw new Error('ReportService.generate: reportKey is required.');
    if (!title)     throw new Error('ReportService.generate: title is required.');
    if (!p.html)    throw new Error('ReportService.generate: html is required.');

    const archive      = (p.archive !== false);
    const returnBase64 = (p.returnBase64 === true);
    if (!archive && !returnBase64) {
      throw new Error('ReportService.generate: with archive:false, set returnBase64:true or the PDF goes nowhere.');
    }

    const now      = new Date();
    const reportId = DataService.generateId('RPT');
    const fileName = _safeFileName(p.fileName) ||
      (_stamp(now, 'yyyy-MM-dd_HHmm') + '_' + _slug(module) + '_' + _slug(reportKey) + '.pdf');

    const html = (p.letterhead === false)
      ? String(p.html)
      : _wrapLetterhead({
          title: title, html: String(p.html),
          generatedBy: String(user || ''), generatedAt: now,
          params: p.params,
        });

    const footerText = (p.footerText === '') ? '' :
      (p.footerText || (_appTitle() + ' v' + (CONFIG.APP_VERSION || '') +
        '  ·  Report ' + reportId + '  ·  Internal department use'));

    const pdf = _htmlToPdf(html, title, fileName, {
      orientation: (p.orientation === 'landscape') ? 'landscape' : 'portrait',
      footerText: footerText,
    });

    let fileId = null, url = null, loggedId = null;
    if (archive) {
      const folder  = _moduleFolder(module);
      const created = folder.createFile(pdf);
      fileId = created.getId();
      url    = created.getUrl();
      DataService.insert(CONFIG.SHEETS.PLATFORM, CONFIG.TABS.REPORTS, {
        ReportID:    reportId,
        Module:      module,
        ReportKey:   reportKey,
        SourceID:    String(p.sourceId || '').trim(),
        Title:       title,
        Params:      p.params ? JSON.stringify(p.params).substring(0, 1000) : '',
        DriveFileID: fileId,
        URL:         url,
        FileName:    fileName,
        GeneratedBy: String(user || ''),
        // CreatedAt / CreatedBy are filled by DataService.insert.
      });
      loggedId = reportId;
    }

    return {
      reportId:   loggedId,
      fileId:     fileId,
      url:        url,
      fileName:   fileName,
      blob:       pdf,
      dataBase64: returnBase64 ? Utilities.base64Encode(pdf.getBytes()) : null,
    };
  }


  // ── Public: archive lookups (fetch-or-create, browse) ──────

  /**
   * Returns the NEWEST archived report for (module, reportKey, sourceId),
   * or null. This is the fetch half of certificate fetch-or-create:
   * re-sending must reuse the existing file, never mint a duplicate.
   */
  function findArchived(module, reportKey, sourceId) {
    const matches = listArchived(module, reportKey).filter(r =>
      String(r.SourceID) === String(sourceId || ''));
    return matches.length ? matches[matches.length - 1] : null;
  }

  /**
   * Returns archived-report log rows for a module (optionally one
   * reportKey), oldest first. Raw log records — UI shaping is the
   * caller's job.
   */
  function listArchived(module, reportKey) {
    const all = DataService.query(CONFIG.SHEETS.PLATFORM, CONFIG.TABS.REPORTS, 'Module', module);
    return reportKey ? all.filter(r => String(r.ReportKey) === String(reportKey)) : all;
  }

  /**
   * Re-fetches an archived PDF as a blob (for re-sending as an email
   * attachment). Throws if the Drive file is gone — the caller decides
   * whether to regenerate.
   */
  function fetchPdf(driveFileId) {
    const id = String(driveFileId || '').trim();
    if (!id) throw new Error('ReportService.fetchPdf: file id is required.');
    return DriveApp.getFileById(id).getBlob();
  }

  /**
   * Deletes every archived report for (module, sourceId): trashes the
   * Drive PDFs (best-effort) and removes the matching Reports log rows.
   * Built for owning-module record deletion (e.g. thesis test cleanup)
   * so the archive never holds documents for records that no longer
   * exist. Requires a non-empty sourceId — there is deliberately no way
   * to bulk-delete a module's whole archive through this API.
   * @returns {number} log rows removed
   */
  function deleteArchived(module, sourceId) {
    const sid = String(sourceId || '').trim();
    if (!sid) return 0;
    const matches = listArchived(module).filter(r => String(r.SourceID) === sid);
    let removed = 0;
    matches.forEach(r => {
      if (r.DriveFileID) {
        try { DriveApp.getFileById(r.DriveFileID).setTrashed(true); }
        catch (e) { Logger.log('ReportService.deleteArchived: could not trash ' + r.DriveFileID + ' (' + e + ')'); }
      }
      try {
        if (DataService.remove(CONFIG.SHEETS.PLATFORM, CONFIG.TABS.REPORTS, 'ReportID', r.ReportID)) removed++;
      } catch (e) {
        Logger.log('ReportService.deleteArchived: could not remove log row ' + r.ReportID + ' (' + e + ')');
      }
    });
    return removed;
  }


  // ── Public: template helpers (offered, not forced) ─────────

  /**
   * Returns an <img> tag for the configured department logo as an
   * inline base64 data URI (the only image form that reliably
   * survives the Drive HTML→Doc conversion), or '' when no logo is
   * configured / the file is unreachable. A missing logo must never
   * fail a report.
   */
  function logoTag(heightPx) {
    const id = String((CONFIG.REPORTS && CONFIG.REPORTS.LOGO_FILE_ID) || '').trim();
    if (!id) return '';
    try {
      const blob = DriveApp.getFileById(id).getBlob();
      const src  = 'data:' + blob.getContentType() + ';base64,' +
                   Utilities.base64Encode(blob.getBytes());
      const h = (isFinite(Number(heightPx)) && Number(heightPx) > 0) ? Number(heightPx) : 72;
      return '<img src="' + src + '" style="height:' + h + 'px;" alt="">';
    } catch (err) {
      Logger.log('ReportService.logoTag: logo unavailable (' + err + '); rendering without it.');
      return '';
    }
  }

  /** HTML-escapes a value for safe inclusion in a report template. */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Formats a date for report display, e.g. "Jun 11, 2026 2:32 PM". */
  function formatStamp(date) {
    if (!date) return '';
    const d = (date instanceof Date) ? date : new Date(date);
    if (isNaN(d.getTime())) return String(date);
    return _stamp(d, 'MMM d, yyyy h:mm a');
  }


  // ── Private: HTML → Doc → PDF pipeline ─────────────────────

  /**
   * Converts an HTML page to a PDF blob via a temporary Google Doc.
   * The temp Doc is always trashed, even when a later step throws.
   */
  function _htmlToPdf(html, title, fileName, opts) {
    const htmlBlob = Utilities.newBlob(html, 'text/html', title + '.html');
    const tmpId = _createDocFromHtml(htmlBlob, '[tmp report] ' + title);

    try {
      _applyPageSetup(tmpId, opts);
      const pdf = DriveApp.getFileById(tmpId).getAs('application/pdf');
      pdf.setName(fileName);
      return pdf;
    } finally {
      try { DriveApp.getFileById(tmpId).setTrashed(true); }
      catch (e) { Logger.log('ReportService: could not trash temp doc ' + tmpId + ' (' + e + ')'); }
    }
  }

  /**
   * Creates a Google Doc from an HTML blob via the Advanced Drive
   * Service, handling both the v3 (create/name) and v2 (insert/title)
   * shapes so the project's enabled version just works.
   */
  function _createDocFromHtml(htmlBlob, docName) {
    if (typeof Drive === 'undefined' || !Drive || !Drive.Files) {
      throw new Error('ReportService requires the Advanced Drive Service (Services → Drive API).');
    }
    if (typeof Drive.Files.create === 'function') {           // v3
      const f = Drive.Files.create({ name: docName, mimeType: GOOGLE_DOC_MIME }, htmlBlob);
      return f.id;
    }
    if (typeof Drive.Files.insert === 'function') {           // v2
      const f = Drive.Files.insert({ title: docName, mimeType: GOOGLE_DOC_MIME }, htmlBlob);
      return f.id;
    }
    throw new Error('ReportService: Advanced Drive Service is present but has no create/insert method.');
  }

  /**
   * Sets page size/orientation and margins on the temp Doc, and adds
   * the repeated footer. NOTE: Apps Script's DocumentApp cannot insert
   * a dynamic "Page X of Y" field — the footer here is static text
   * (report id, scope line) that repeats on every page. Dynamic page
   * numbers are simply not available in this pipeline.
   */
  function _applyPageSetup(docId, opts) {
    opts = opts || {};
    try {
      const doc  = DocumentApp.openById(docId);
      const body = doc.getBody();

      if (opts.orientation === 'landscape') {
        body.setPageWidth(PAGE.LONG).setPageHeight(PAGE.SHORT);
      } else {
        body.setPageWidth(PAGE.SHORT).setPageHeight(PAGE.LONG);
      }
      body.setMarginTop(PAGE.MARGIN).setMarginBottom(PAGE.MARGIN)
          .setMarginLeft(PAGE.MARGIN).setMarginRight(PAGE.MARGIN);

      // Stretch top-level tables to the printable width. The HTML→Doc
      // converter fixes table column widths against the DEFAULT page
      // (portrait, 1" margins) at conversion time, so without this step
      // landscape content occupies only the upper-left of the page and
      // even portrait letterhead bands stop short of the 0.5" margins.
      // Columns are scaled proportionally; nested tables are left alone
      // (they size to content). Templates should avoid nested layout
      // tables for anything that must span the page.
      const printable = ((opts.orientation === 'landscape') ? PAGE.LONG : PAGE.SHORT)
                        - (2 * PAGE.MARGIN);
      for (let i = 0; i < body.getNumChildren(); i++) {
        const child = body.getChild(i);
        if (child.getType() !== DocumentApp.ElementType.TABLE) continue;
        const t = child.asTable();
        if (!t.getNumRows()) continue;
        const cols = t.getRow(0).getNumCells();
        let total = 0;
        const widths = [];
        for (let c = 0; c < cols; c++) {
          const w = t.getColumnWidth(c) || 0;
          widths.push(w);
          total += w;
        }
        for (let c = 0; c < cols; c++) {
          t.setColumnWidth(c, total > 0
            ? Math.max(18, (widths[c] / total) * printable)
            : printable / cols);
        }
      }

      if (opts.footerText) {
        const footer = doc.getFooter() || doc.addFooter();
        const para = footer.appendParagraph(String(opts.footerText));
        para.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
        const t = para.editAsText();
        t.setFontSize(8);
        t.setForegroundColor('#888888');
      }

      doc.saveAndClose();
    } catch (err) {
      // Page setup is dressing; the content is already converted. A
      // setup failure degrades the look, it must not lose the report.
      Logger.log('ReportService._applyPageSetup: ' + err + ' (continuing with converter defaults)');
    }
  }


  // ── Private: letterhead wrapper ────────────────────────────

  /**
   * Wraps a module's body HTML in the standard branded page: navy
   * band with gold rule, optional logo, title, and the generated-by /
   * generated-at / filters meta strip. Table-based layout on purpose —
   * see the fidelity warning in the file header.
   */
  function _wrapLetterhead(p) {
    const navy = (CONFIG.BRAND && CONFIG.BRAND.NAVY) || '#003C6C';
    const gold = (CONFIG.BRAND && CONFIG.BRAND.GOLD) || '#FDC700';
    const org  = String((CONFIG.REPORTS && CONFIG.REPORTS.ORG_LINE) || '').trim();
    const logo = logoTag(40);

    const paramsText = p.params
      ? Object.keys(p.params).map(k => escapeHtml(k) + ' = ' + escapeHtml(p.params[k])).join(' · ')
      : '—';

    return '<html><body style="font-family:Arial,Helvetica,sans-serif;color:#222222;font-size:10pt;margin:0;">'
      + '<table width="100%" cellpadding="0" cellspacing="0" style="background-color:' + navy + ';border-bottom:4px solid ' + gold + ';">'
      +   '<tr><td style="padding:12px 18px;">'
      +     (logo ? '<table cellpadding="0" cellspacing="0"><tr><td style="padding-right:12px;">' + logo + '</td><td>' : '')
      +     '<span style="color:#ffffff;font-size:12pt;font-weight:bold;">' + escapeHtml(_appTitle()) + '</span>'
      +     (org ? '<br><span style="color:#b8cde0;font-size:8pt;">' + escapeHtml(org) + '</span>' : '')
      +     (logo ? '</td></tr></table>' : '')
      +   '</td></tr>'
      + '</table>'
      + '<h1 style="font-size:15pt;font-weight:bold;color:#1a1a1a;margin:16px 0 4px;">' + escapeHtml(p.title) + '</h1>'
      + '<table width="100%" cellpadding="6" cellspacing="0" style="background-color:#f4f6f8;border-left:3px solid ' + navy + ';font-size:8pt;margin:8px 0 14px;">'
      +   '<tr>'
      +     '<td><span style="color:#777777;">Generated by</span><br>' + escapeHtml(p.generatedBy || '—') + '</td>'
      +     '<td><span style="color:#777777;">Generated on</span><br>' + escapeHtml(formatStamp(p.generatedAt)) + '</td>'
      +     '<td><span style="color:#777777;">Filters</span><br>' + paramsText + '</td>'
      +   '</tr>'
      + '</table>'
      + p.html
      + '</body></html>';
  }


  // ── Private: archive folders + small helpers ───────────────

  /**
   * Returns the archive subfolder for a module, creating it on first
   * use (self-healing; no setup step). Throws with a clear message if
   * the platform archive folder itself is not configured.
   */
  function _moduleFolder(moduleKey) {
    const rootId = String((CONFIG.REPORTS && CONFIG.REPORTS.ARCHIVE_FOLDER_ID) || '').trim();
    if (!rootId) {
      throw new Error('Report archive folder is not configured (CONFIG.REPORTS.ARCHIVE_FOLDER_ID).');
    }
    const root = DriveApp.getFolderById(rootId);
    const existing = root.getFoldersByName(moduleKey);
    return existing.hasNext() ? existing.next() : root.createFolder(moduleKey);
  }

  function _appTitle() {
    return (typeof CONFIG !== 'undefined' && CONFIG.APP_TITLE) || 'Portal';
  }

  function _stamp(date, format) {
    return Utilities.formatDate(date, Session.getScriptTimeZone(), format);
  }

  /** Lowercase, alphanumeric + hyphens — for default filename parts. */
  function _slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /** Keeps caller-supplied filenames Drive-safe; '' when not supplied. */
  function _safeFileName(name) {
    const n = String(name || '').trim();
    if (!n) return '';
    const cleaned = n.replace(/[\\\/:*?"<>|]+/g, '_');
    return /\.pdf$/i.test(cleaned) ? cleaned : cleaned + '.pdf';
  }


  return { generate, findArchived, listArchived, fetchPdf, deleteArchived, logoTag, escapeHtml, formatStamp };

})();