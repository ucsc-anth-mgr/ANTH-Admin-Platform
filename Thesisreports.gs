// ============================================================
// Thesisreports.gs — Completion records + acceptance certificates
// ============================================================
// Companion to ThesisModule (same family as ThesisSettings /
// ThesisEligibility): owns the two thesis PDF documents and the
// student-facing acceptance email. ThesisModule decides WHEN
// (workflow triggers + permission-checked actions) and passes the
// raw thesis record in; this file owns WHAT — templates, wording,
// filing, and delivery. ReportService owns HOW (HTML→PDF, archive,
// log). Notify owns the send.
//
// The two documents:
//   COMPLETION RECORD — internal evidence, generated at
//     advisorComplete on the APPROVED path only (per department
//     decision, No Pass closeouts produce no record). Append-only
//     snapshots: every (re)generation is a new archive file.
//   CERTIFICATE — student-facing, issued when the thesis routes to
//     PENDING_ADVISOR with a passing outcome. Fetch-or-create:
//     resending reuses the SAME archived file, never mints a new
//     one (also guards the honors path against double-issue).
//
// WORDING RULE (deliberate): an honors DENIAL still means the
// thesis passed. The student-facing certificate and email for that
// path use the plain "Accepted" variant and never mention the
// honors review. The INTERNAL completion record documents the
// denied review fully — it is evidence, and evidence is complete.
//
// Templates are TABLE-BASED on purpose: the Drive HTML→Doc
// converter does not understand flexbox/grid (see ReportService
// header). Sizes are in pt for print.
// ============================================================

const ThesisReports = (() => {

  // Keep in sync with ThesisModule.ADVISOR_ROLE.
  const ADVISOR_ROLE = 'staff_undergrad';

  const NAVY = '#003C6C';
  const GOLD = '#FDC700';

  const KEY_CERT   = 'certificate';
  const KEY_RECORD = 'completion-record';


  // ── Public: certificate (issue / resend) ───────────────────

  /**
   * Issues the acceptance certificate to the student: generates (or
   * reuses) the archived PDF and emails it. Called by ThesisModule
   * when a thesis routes to PENDING_ADVISOR with a passing outcome,
   * and by the resendCertificate action.
   *
   * Never throws on delivery problems — returns { sent, reason } so a
   * certificate hiccup can't break the academic action. Genuinely
   * invalid calls (no record, not accepted) DO throw.
   *
   * @param {Object} rec - raw thesis sheet record
   * @param {Object} [opts]
   *   @param {boolean} [opts.force=false] - bypass the SEND_CERTIFICATE
   *     setting (the resend action passes true: an advisor explicitly
   *     clicking "resend" outranks the automation toggle)
   * @returns {{ sent: boolean, reused: boolean, fileId: ?string,
   *             url: ?string, reason: ?string }}
   */
  function issueCertificate(rec, opts) {
    opts = opts || {};
    if (!rec || !rec.ThesisID) throw new Error('ThesisReports.issueCertificate: thesis record required.');
    if (!_isAccepted(rec)) {
      throw new Error('This thesis has not reached a passing outcome — no certificate to issue.');
    }

    if (!opts.force && !_settingOn()) {
      return { sent: false, reused: false, fileId: null, url: null,
               reason: 'SEND_CERTIFICATE is off in Thesis settings' };
    }

    const student = Auth.getProfile(rec.StudentEmail);
    const sponsor = Auth.getProfile(rec.SponsorEmail);
    if (!student) {
      return { sent: false, reused: false, fileId: null, url: null,
               reason: 'no profile found for ' + rec.StudentEmail };
    }

    // Fetch-or-create: the certificate is a single durable artifact.
    let blob = null, fileId = null, url = null, reused = false;
    const existing = ReportService.findArchived('thesis', KEY_CERT, rec.ThesisID);
    if (existing && existing.DriveFileID) {
      try {
        blob = ReportService.fetchPdf(existing.DriveFileID);
        fileId = existing.DriveFileID;
        url = existing.URL || '';
        reused = true;
      } catch (e) {
        Logger.log('ThesisReports: archived certificate missing for ' + rec.ThesisID +
                   ' (' + e + '); regenerating.');
      }
    }
    if (!blob) {
      const out = ReportService.generate({
        module: 'thesis', reportKey: KEY_CERT,
        title: 'Certificate of Completion — ' + (student.name || rec.StudentEmail),
        sourceId: rec.ThesisID,
        params: { thesisId: rec.ThesisID },
        html: _certificateHtml(rec, student, sponsor),
        fileName: _docFileName(rec, student, 'THESCERT', false),
        orientation: 'landscape',
        letterhead: false,
        footerText: '',           // a certificate carries no operational footer
      }, rec.SponsorDecidedBy || rec.SponsorEmail || '');
      blob = out.blob; fileId = out.fileId; url = out.url;
    }

    const mail = _certificateEmail(rec, student, sponsor);
    const result = Notify.send({
      to: rec.StudentEmail,
      subject: mail.subject,
      body: mail.text,
      htmlBody: mail.html,
      attachments: [blob],
      prefixSubject: false,                     // celebratory, not workflow
      senderName: mail.senderName,              // display only; see Notify
      replyTo: _advisorEmails(),                // staff_undergrad holders
    });

    return { sent: !!result.sent, reused: reused, fileId: fileId, url: url,
             reason: result.sent ? null : (result.reason || 'send failed') };
  }


  // ── Public: completion record (archive-only, internal) ─────

  /**
   * Generates and archives the internal completion record. Approved
   * path only — callers must not invoke this for No Pass closeouts
   * (and it throws if they do, as a guard). Append-only: every call
   * archives a NEW dated snapshot.
   *
   * @param {Object} rec  - raw thesis sheet record (read AFTER the
   *                        advisorComplete update, so AdvisorProcessedBy/At
   *                        are populated)
   * @param {string} user - acting user's email (GeneratedBy)
   * @returns {{ reportId: string, fileId: string, url: string }}
   */
  function archiveCompletionRecord(rec, user) {
    if (!rec || !rec.ThesisID) throw new Error('ThesisReports.archiveCompletionRecord: thesis record required.');
    if (!_isAccepted(rec)) {
      throw new Error('Completion records are generated for passing outcomes only.');
    }

    const student = Auth.getProfile(rec.StudentEmail);
    const out = ReportService.generate({
      module: 'thesis', reportKey: KEY_RECORD,
      title: 'Senior thesis completion record — ' +
             ((student && (student.nameLastFirst || student.name)) || rec.StudentEmail),
      sourceId: rec.ThesisID,
      params: { thesisId: rec.ThesisID },
      html: _recordHtml(rec, student),
      fileName: _docFileName(rec, student, 'THESREC', true),
    }, user);

    return { reportId: out.reportId, fileId: out.fileId, url: out.url };
  }


  // ── Private: shared state helpers ──────────────────────────

  /** Passing outcome: sponsor Pass, or any recorded honors decision
   *  (approved or denied — denial still means the thesis passed). */
  function _isAccepted(rec) {
    if (rec.SponsorDecision === 'Pass') return true;
    return !!rec.HonorsDecision;        // either honors outcome = passed
  }

  function _isHonors(rec) {
    return rec.HonorsDecision === 'Honors approved';
  }

  /** Acceptance moment: the decision that routed it to the advisor. */
  function _acceptedAt(rec) {
    return rec.HonorsDecision ? rec.ReaderDecidedAt : rec.SponsorDecidedAt;
  }

  function _settingOn() {
    try { return ThesisSettings.get().sendCertificate !== false; }
    catch (e) { return true; }          // settings unreadable → default on
  }

  /** Active staff_undergrad holders' emails (may be empty). */
  function _advisorEmails() {
    try {
      return Auth.listUsers()
        .filter(u => u.active && (u.roles || [])
          .some(r => String(r).trim().toLowerCase() === ADVISOR_ROLE))
        .map(u => u.email);
    } catch (e) { return []; }
  }

  function _term(rec) { return rec.Quarter + ' ' + rec.Year; }

  function _esc(s) { return ReportService.escapeHtml(s); }

  function _when(v) { return ReportService.formatStamp(v); }

  function _personLabel(email) {
    const p = email ? Auth.getProfile(email) : null;
    return (p && p.name) ? p.name : (email || '—');
  }

  /** yyyy-Quarter_<StudentID>-<TAG>_Last-First[_yyyy-MM-dd].pdf —
   *  mirrors the thesis PDF convention so the archive reads alike.
   *  dated:true appends today (completion-record snapshots). */
  function _docFileName(rec, student, tag, dated) {
    const last  = _slug((student && student.lastName)  || 'Last');
    const first = _slug((student && student.firstName) || 'First');
    const sid   = (student && student.studentId) || 'NOID';
    let name = rec.Year + '-' + rec.Quarter + '_' + sid + '-' + tag + '_' + last + '-' + first;
    if (dated) {
      name += '_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    return name + '.pdf';
  }

  function _slug(s) {
    return String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '');
  }

  function _regionsText(rec) {
    const arr = Utils.parseJSON(rec.Regions);
    if (!arr || !arr.length) return '';
    return arr.map(r => r.locality ? (r.country + ' (' + r.locality + ')') : r.country).join(', ');
  }


  // ── Private: certificate template (landscape, full page) ───

  function _certificateHtml(rec, student, sponsor) {
    const honors = _isHonors(rec);
    const logo = ReportService.logoTag(72);
    const badge = 'Accepted' + (honors ? ' with Honors' : '') + ' \u00B7 ' + _esc(_term(rec));
    const sponsorName = (sponsor && sponsor.name) || rec.SponsorEmail;
    const acceptedDate = Utilities.formatDate(
      new Date(_acceptedAt(rec)), Session.getScriptTimeZone(), 'MMMM d, yyyy');

    // CONVERTER-TUNED LAYOUT. The Drive HTML→Doc converter has three
    // behaviors this template designs around (learned from real output):
    //   1. Table widths freeze at conversion time against the default
    //      portrait page — ReportService re-stretches TOP-LEVEL tables to
    //      the landscape page, so this is ONE table, with the double
    //      border done as navy table border + gold cell border (no nested
    //      tables, which would stay narrow and drift left).
    //   2. Any border style on a cell becomes a full box — so no
    //      border-top "signature lines"; the signature block is centered
    //      stacked text instead.
    //   3. align="center" on nested tables doesn't survive — so the
    //      divider ornament and badge are styled TEXT, which centers
    //      reliably, not boxed table cells.
    // Vertical balance comes from explicit pt margins (no flex in Docs).
    // Sizes below are tuned as a set: they total ≈525pt of vertical
    // content against the 540pt printable height of the landscape page
    // (792×612 minus 36pt margins), so the certificate fills the page
    // without spilling to a second one. Scale them together, not singly.
    return '<html><body style="margin:0;font-family:Georgia,\'Times New Roman\',serif;">'
      + '<table width="100%" border="0" cellpadding="0" cellspacing="0" style="border:3pt solid ' + NAVY + ';">'
      + '<tr><td align="center" style="border:1.5pt solid ' + GOLD + ';padding:30pt 56pt 28pt;">'
      +   (logo ? '<div>' + logo + '</div>' : '')
      +   '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11pt;letter-spacing:2.5pt;color:' + NAVY + ';margin-top:10pt;">University of California, Santa Cruz</div>'
      +   '<div style="font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;letter-spacing:1.5pt;color:#666666;margin-top:3pt;">Department of Anthropology</div>'
      +   '<div style="font-size:11pt;color:' + GOLD + ';margin-top:10pt;">&#9670;</div>'
      +   '<div style="font-size:28pt;color:' + NAVY + ';margin-top:10pt;">Certificate of Completion</div>'
      +   '<div style="font-size:12pt;color:#555555;font-style:italic;margin-top:16pt;">This certifies that</div>'
      +   '<div style="font-size:30pt;color:#1a1a1a;margin-top:6pt;">' + _esc((student && student.name) || rec.StudentEmail) + '</div>'
      +   '<div style="font-size:12pt;color:#555555;font-style:italic;margin-top:10pt;">has successfully completed and been granted acceptance of the senior thesis</div>'
      +   '<div style="font-size:16pt;color:#1a1a1a;font-style:italic;margin-top:8pt;">&ldquo;' + _esc(rec.Title) + '&rdquo;</div>'
      +   '<div style="font-family:Arial,Helvetica,sans-serif;font-size:12pt;letter-spacing:1.5pt;color:' + NAVY + ';margin-top:14pt;">' + badge + '</div>'
      +   '<div style="font-size:11pt;color:' + GOLD + ';margin-top:8pt;">&#9670;</div>'
      +   '<div style="font-size:14pt;color:#1a1a1a;margin-top:34pt;">' + _esc(sponsorName) + '</div>'
      +   '<div style="font-family:Arial,Helvetica,sans-serif;font-size:8.5pt;color:#777777;margin-top:2pt;">Faculty sponsor</div>'
      +   '<div style="font-size:12pt;color:#333333;margin-top:12pt;">' + _esc(acceptedDate) + '</div>'
      +   '<div style="font-family:Arial,Helvetica,sans-serif;font-size:8.5pt;color:#777777;margin-top:2pt;">Date of acceptance</div>'
      +   '<div style="font-family:Arial,Helvetica,sans-serif;font-size:7.5pt;color:#999999;margin-top:24pt;">Issued via the UCSC Anthropology Portal \u00B7 Thesis ' + _esc(rec.ThesisID) + '</div>'
      + '</td></tr></table>'
      + '</body></html>';
  }


  // ── Private: completion-record template (letterhead body) ──

  function _recordHtml(rec, student) {
    const honors = _isHonors(rec);
    const trail = _trailRows(rec, student);
    const comments = _commentBlocks(rec);
    const regions = _regionsText(rec);

    let html = ''
      // Student meta strip
      + '<table width="100%" cellpadding="6" cellspacing="0" style="background-color:#f4f6f8;border-left:3px solid ' + NAVY + ';font-size:8pt;">'
      +   '<tr>'
      +     '<td><span style="color:#777777;">Student</span><br><b>' + _esc((student && (student.nameLastFirst || student.name)) || rec.StudentEmail) + '</b></td>'
      +     '<td><span style="color:#777777;">Student ID</span><br>' + _esc((student && student.studentId) || '—') + '</td>'
      +     '<td><span style="color:#777777;">Email</span><br>' + _esc(rec.StudentEmail) + '</td>'
      +     '<td><span style="color:#777777;">Term</span><br>' + _esc(_term(rec)) + '</td>'
      +   '</tr>'
      + '</table>'

      // Thesis block
      + '<div style="font-size:7pt;color:#777777;letter-spacing:0.5pt;margin-top:12pt;">THESIS</div>'
      + '<div style="font-size:12pt;font-weight:bold;color:#1a1a1a;margin-top:2pt;">' + _esc(rec.Title) + '</div>'
      + '<div style="font-size:8pt;color:#444444;margin-top:3pt;">'
      +   (regions ? 'Regions: ' + _esc(regions) + ' · ' : '')
      +   'Public availability: ' + (String(rec.ShareConsent).toUpperCase() === 'TRUE' ? 'may be made public' : 'department only')
      + '</div>'
      + '<div style="font-size:8pt;color:#444444;margin-top:2pt;">Document: ' + _esc(rec.FileName || '')
      +   (rec.DriveFileID ? ' <span style="color:#888888;">(Drive ID ' + _esc(rec.DriveFileID) + ')</span>' : '') + '</div>';

    if (rec.Abstract) {
      html += '<div style="font-size:7pt;color:#777777;letter-spacing:0.5pt;margin-top:10pt;">ABSTRACT</div>'
        + '<div style="font-size:9pt;color:#333333;margin-top:3pt;text-align:justify;">' + _esc(rec.Abstract) + '</div>';
    }

    // Decision trail (signature table)
    html += '<div style="font-size:7pt;color:#777777;letter-spacing:0.5pt;margin-top:12pt;">DECISION TRAIL</div>'
      + '<table width="100%" cellpadding="5" cellspacing="0" style="font-size:8pt;margin-top:4pt;">'
      +   '<tr style="background-color:' + NAVY + ';color:#ffffff;">'
      +     '<th align="left" width="20%">Step</th><th align="left" width="22%">Decision</th>'
      +     '<th align="left">Signed by</th><th align="left" width="20%">Timestamp</th>'
      +   '</tr>'
      +   trail
      + '</table>'

      // Outcome badges
      + '<table cellpadding="0" cellspacing="0" style="margin-top:8pt;"><tr>'
      +   '<td style="background-color:' + NAVY + ';color:#ffffff;font-size:8pt;padding:3pt 10pt;">Outcome: ' + (honors ? 'Pass with Honors' : 'Pass') + '</td>'
      +   '<td width="8">&nbsp;</td>'
      +   '<td style="background-color:#f4f6f8;color:#1a1a1a;font-size:8pt;padding:3pt 10pt;">'
      +     (String(rec.MilestoneEntered).toUpperCase() === 'TRUE' ? 'Milestone entered in Degree Progress Report' : 'Milestone pending')
      +   '</td>'
      + '</tr></table>'

      + comments

      // Certification box
      + '<table width="100%" cellpadding="6" cellspacing="0" style="border:0.5pt solid #cccccc;margin-top:12pt;"><tr>'
      +   '<td style="font-size:7.5pt;color:#555555;font-style:italic;">'
      +     'This record was generated from the UCSC Anthropology Portal thesis database and reflects the official record as of '
      +     _esc(_when(new Date())) + '. Each step above was recorded through the named individual\'s authenticated portal session; '
      +     'the email shown is the signing account. All actions are independently logged in the platform audit trail.'
      +   '</td>'
      + '</tr></table>';

    return html;
  }

  function _trailRows(rec, student) {
    const rows = [];
    rows.push(_trailRow('Submission', 'Submitted',
      (student && student.name) || rec.StudentEmail, rec.StudentEmail, rec.CreatedAt, false));
    rows.push(_trailRow('Sponsor review', rec.SponsorDecision || '—',
      _personLabel(rec.SponsorDecidedBy || rec.SponsorEmail),
      rec.SponsorDecidedBy || rec.SponsorEmail, rec.SponsorDecidedAt, true));
    if (rec.HonorsDecision) {
      rows.push(_trailRow('Honors review', rec.HonorsDecision,
        _personLabel(rec.ReaderDecidedBy || rec.ReaderEmail),
        rec.ReaderDecidedBy || rec.ReaderEmail, rec.ReaderDecidedAt, false));
    }
    rows.push(_trailRow('Final processing', 'Complete',
      _personLabel(rec.AdvisorProcessedBy), rec.AdvisorProcessedBy,
      rec.AdvisorProcessedAt, rows.length % 2 === 1));
    return rows.join('');
  }

  function _trailRow(step, decision, name, email, when, shaded) {
    const bg = shaded ? ' style="background-color:#f4f6f8;"' : '';
    const signer = email
      ? _esc(name) + '<br><span style="color:#666666;">' + _esc(email) + '</span>'
      : '<span style="color:#888888;">recorded prior to signature tracking</span>';
    return '<tr' + bg + '>'
      + '<td style="border-bottom:0.5pt solid #e0e0e0;">' + _esc(step) + '</td>'
      + '<td style="border-bottom:0.5pt solid #e0e0e0;">' + _esc(decision) + '</td>'
      + '<td style="border-bottom:0.5pt solid #e0e0e0;">' + signer + '</td>'
      + '<td style="border-bottom:0.5pt solid #e0e0e0;">' + (when ? _esc(_when(when)) : '—') + '</td>'
      + '</tr>';
  }

  function _commentBlocks(rec) {
    const blocks = [];
    if (rec.SponsorComments) {
      blocks.push(_commentBlock('Sponsor — ' + _personLabel(rec.SponsorDecidedBy || rec.SponsorEmail),
        rec.SponsorDecidedAt, rec.SponsorComments));
    }
    if (rec.ReaderComments) {
      blocks.push(_commentBlock('Honors reader — ' + _personLabel(rec.ReaderDecidedBy || rec.ReaderEmail),
        rec.ReaderDecidedAt, rec.ReaderComments));
    }
    if (!blocks.length) return '';
    return '<div style="font-size:7pt;color:#777777;letter-spacing:0.5pt;margin-top:12pt;">REVIEWER COMMENTS</div>'
      + blocks.join('');
  }

  function _commentBlock(who, when, text) {
    return '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:5pt;"><tr>'
      + '<td width="3" style="background-color:' + GOLD + ';font-size:1pt;">&nbsp;</td>'
      + '<td style="padding:4pt 8pt;">'
      +   '<div style="font-size:7.5pt;color:#888888;">' + _esc(who) + (when ? ' · ' + _esc(_when(when)) : '') + '</div>'
      +   '<div style="font-size:9pt;color:#333333;margin-top:2pt;">' + _esc(text) + '</div>'
      + '</td>'
      + '</tr></table>';
  }


  // ── Private: certificate email composition ─────────────────

  function _certificateEmail(rec, student, sponsor) {
    const honors = _isHonors(rec);
    const firstName = (student && student.firstName) || 'there';
    const sponsorName = (sponsor && sponsor.name) || rec.SponsorEmail;
    const subject = 'Congratulations — your senior thesis has been accepted';
    const badge = 'Accepted' + (honors ? ' with Honors' : '') + ' · ' + _term(rec)
      + ' · Faculty sponsor: ' + sponsorName;

    const praise = honors
      ? 'Your faculty reviewers recognized this work as meeting the department\'s honors '
        + 'standard — an achievement that reflects sustained, serious scholarship. '
      : 'Your faculty sponsor has formally recommended the thesis for acceptance — the '
        + 'culmination of sustained, serious work. ';

    // No portal link in this email — students are deactivated in the
    // portal after graduation, so a "view your record" button would
    // eventually point somewhere they can't reach. The certificate
    // attachment is the durable artifact; the email stands alone.
    const nextSteps = 'Nothing further is needed from you at this time. The undergraduate '
      + 'advisor will complete final processing and enter the thesis milestone into your '
      + 'Degree Progress Report.';

    // Reviewer comments shared with the student — STRICT rule (department
    // decision): comments appear only on paths with nothing to reveal.
    //   • Direct sponsor Pass            → sponsor comments.
    //   • Honors approved                → sponsor + reader comments.
    //   • Honors DENIED                  → NO comments at all. The reader's
    //     are obviously withheld, but the sponsor's are too — a sponsor who
    //     recommended honors usually says so in their comments, which would
    //     betray the review on the denied path. Total silence, no drama.
    // NOTE the policy implication: this makes decision comments
    // student-facing on acceptance. The comment forms in thesis.html warn
    // reviewers accordingly.
    const remarks = [];
    const shareComments = !rec.HonorsDecision || honors;   // denied → false
    if (shareComments && rec.SponsorComments) {
      remarks.push({ who: 'Faculty sponsor \u2014 ' + sponsorName, text: rec.SponsorComments });
    }
    if (shareComments && honors && rec.ReaderComments) {
      remarks.push({ who: 'Honors reader \u2014 ' + _personLabel(rec.ReaderDecidedBy || rec.ReaderEmail),
                     text: rec.ReaderComments });
    }

    const remarksText = remarks.length
      ? '\nWhat your reviewers said:\n'
        + remarks.map(c => '\u2014 ' + c.who + ':\n"' + c.text + '"').join('\n\n') + '\n'
      : '';

    const remarksHtml = remarks.length
      ? '<p style="margin:0 0 6px;color:#1a1a1a;"><b>What your reviewers said</b></p>'
        + remarks.map(c =>
            '<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;"><tr>'
          + '<td width="3" style="background-color:' + GOLD + ';">&nbsp;</td>'
          + '<td style="background-color:#f4f6f8;padding:8px 14px;">'
          +   '<div style="font-size:11px;color:#888888;">' + _esc(c.who) + '</div>'
          +   '<div style="color:#333333;margin-top:3px;font-style:italic;">&ldquo;' + _esc(c.text) + '&rdquo;</div>'
          + '</td>'
          + '</tr></table>').join('')
        + '<div style="margin:0 0 6px;"></div>'
      : '';

    const text = 'Congratulations, ' + firstName + '!\n\n'
      + 'Your senior thesis has been formally accepted by the Department of Anthropology:\n\n'
      + '"' + rec.Title + '"\n' + badge + '\n\n'
      + praise + 'Your certificate of completion is attached to this email; it\'s yours to keep and share.\n'
      + remarksText
      + '\nWhat happens next: ' + nextSteps + '\n'
      + '\nWarm congratulations from all of us in the department,\nUCSC Anthropology';

    const html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#222222;font-size:13px;line-height:1.65;">'
      + '<div style="border-top:4px solid ' + NAVY + ';padding-top:16px;">'
      +   '<p style="margin:0 0 14px;font-size:16px;color:' + NAVY + ';"><b>Congratulations, ' + _esc(firstName) + '!</b></p>'
      +   '<p style="margin:0 0 12px;">Your senior thesis has been formally accepted by the Department of Anthropology:</p>'
      +   '<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;"><tr>'
      +     '<td width="3" style="background-color:' + GOLD + ';">&nbsp;</td>'
      +     '<td style="background-color:#f4f6f8;padding:10px 14px;">'
      +       '<div style="font-style:italic;color:#1a1a1a;">&ldquo;' + _esc(rec.Title) + '&rdquo;</div>'
      +       '<div style="font-size:12px;color:#555555;margin-top:4px;">' + _esc(badge) + '</div>'
      +     '</td>'
      +   '</tr></table>'
      +   '<p style="margin:0 0 12px;">' + praise
      +     'Your certificate of completion is attached to this email; it&rsquo;s yours to keep and share.</p>'
      +   remarksHtml
      +   '<p style="margin:0 0 6px;color:#1a1a1a;"><b>What happens next</b></p>'
      +   '<p style="margin:0 0 16px;">' + nextSteps + '</p>'
      +   '<p style="margin:0;color:#444444;">Warm congratulations from all of us in the department,<br>UCSC Anthropology</p>'
      + '</div>'
      + '<div style="margin-top:16px;font-size:11px;color:#888888;">'
      +   'UCSC Anthropology Portal — automated message. Questions about your thesis record? '
      +   'Reply to this email or contact the department office.'
      + '</div>'
      + '</div>';

    return {
      subject: subject,
      text: text,
      html: html,
      // Sender DISPLAY name (the address is always the deploying portal
      // account). Department decision: the celebration comes from the
      // Anthropology Undergraduate Advisor — the office that owns final
      // processing and the Reply-To — not the individual sponsor, whose
      // name still signs the certificate itself.
      senderName: 'Anthropology Undergraduate Advisor',
    };
  }

  return { issueCertificate, archiveCompletionRecord };

})();