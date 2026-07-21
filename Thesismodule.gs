// ============================================================
// ThesisModule.gs — Senior Thesis submission & review (server)
// ============================================================
// A multi-stage workflow module. One thesis record per student per
// term (Quarter + Year) moves through:
//
//   SUBMITTED ─ sponsor ─┬─ Pass ──────────────► PENDING_ADVISOR
//                        ├─ No Pass ───────────► PENDING_ADVISOR (failed)
//                        ├─ Review for Honors ─► PENDING_HONORS
//                        └─ Return ────────────► RETURNED
//   PENDING_HONORS ─ reader ─┬─ Approve honors ─► PENDING_ADVISOR
//                            └─ Return to sponsor ─► SUBMITTED
//   PENDING_ADVISOR ─ advisor ─┬─ Complete ─────► COMPLETE   (terminal)
//                              └─ Return to sponsor ─► SUBMITTED
//   RETURNED ─ student resubmits ──────────────► SUBMITTED  (same record;
//                                                Drive file replaced in place)
//
// Returns to the STUDENT happen only at the sponsor stage. The advisor
// cannot send a thesis back to the student — but can return it to the
// SPONSOR for re-decision (clearing the recorded decisions), keeping the
// correction loop inside faculty/staff. The student never sees a thesis
// bounce after faculty approval.
//
// The module also owns ANTH 195S ENROLLMENT — the front half of the
// thesis lifecycle (see the ENROLLMENT section below), a two-hop
// petition mirroring the Individual Studies module.
//
// DESIGN NOTES (platform contracts honored here):
//   - Identity is NOT copied onto the record. Student name/ID and faculty
//     names are read from Auth.getProfile at read time. StudentEmail and
//     SponsorEmail/ReaderEmail are the only identity fields stored — they
//     are routing keys, not display copies.
//   - The thesis lives in its OWN spreadsheet (CONFIG.SHEETS.THESIS). The
//     PDF lives in CONFIG.THESIS.DRIVE_FOLDER_ID. DriveFileID is stored so
//     resubmission replaces the file in place; DocumentLink is the file's
//     viewable URL, captured automatically (no student input).
//   - Cross-cutting concerns go through platform services: Tasks for the
//     attention queue, Notify for email, EventBus for fan-out, Auth for
//     identity, DataService for sheet CRUD. No SpreadsheetApp here.
//   - Every privileged action allows super_admin.
// ============================================================

const ThesisModule = (() => {

  const TAB = 'Thesis';

  const STAGE = {
    SUBMITTED:       'SUBMITTED',
    PENDING_HONORS:  'PENDING_HONORS',
    PENDING_ADVISOR: 'PENDING_ADVISOR',
    RETURNED:        'RETURNED',
    COMPLETE:        'COMPLETE',
  };

  // Sponsor decision values (mirror the paper form's checkboxes).
  const SPONSOR = { PASS: 'Pass', NO_PASS: 'No Pass', HONORS: 'Review for Honors' };
  // Reader (honors) outcome. There is deliberately NO "denied" value: a
  // reader who is not convinced returns the thesis to the sponsor instead,
  // and the sponsor records a plain Pass — so a negative honors outcome
  // never exists on the record and the student's view needs no rewriting.
  const HONORS  = { APPROVED: 'Honors approved' };

  // Faculty eligible to sponsor or read are the active users holding the
  // 'thesis_sponsor' / 'thesis_reader' identity roles (assigned in
  // Admin → Users), resolved at runtime via Auth.usersWithRole — not a
  // hard-coded list. See listEligible / _holdsRole below.

  // The undergraduate advisor is whoever holds this role. Zero, one, or
  // several people may hold it; all holders share the advisor queue and are
  // notified. Identity is role-derived, not a stored email setting.
  const ADVISOR_ROLE = 'staff_undergrad';

  // Quarters offered at submission (term half of the filename prefix).
  const QUARTERS = ['Fall', 'Winter', 'Spring', 'Summer'];

  // ── Tab manifest (TabRegistry) ─────────────────────────────
  // Declares this module's tabs for per-role visibility, edited in
  // Admin → Modules → Tabs. NOTE: the Submit tab is additionally
  // DATA-gated client-side — even when visible by role, init() only
  // reveals it while the student has no thesis on record; the Enroll
  // tab is likewise revealed only while no 195S enrollment is in
  // flight. Modal and shared actions (get, sponsorDecision,
  // readerDecision, returnToStudent, returnToSponsor, deleteThesis,
  // repairAdvisorTasks, listEligible, listCountries, enrollGet,
  // enrollWithdraw, enrollDelete, enrollmentPrefill) stay unlisted —
  // each is guarded inside its own handler.
  const TABS = [
    { key: 'submit',    label: 'Submit a thesis',  icon: 'ti-file-upload',
      roles: ['undergraduate_student'], actions: ['submit'] },
    { key: 'mine',      label: 'My theses',        icon: 'ti-list',
      roles: ['undergraduate_student'], actions: ['mySubmissions'] },
    { key: 'enroll',    label: 'Enroll in 195S',   icon: 'ti-file-plus',
      roles: ['undergraduate_student'],
      actions: ['enrollFormData', 'enrollSubmit'] },
    { key: 'myenroll',  label: 'My enrollment',    icon: 'ti-list-check',
      roles: ['undergraduate_student'],
      actions: ['enrollMine'] },
    { key: 'queue',     label: 'Review queue',     icon: 'ti-inbox',
      roles: ['senate_faculty', 'lecturer', 'staff', 'staff_undergrad'],
      actions: ['queue'] },
    { key: 'sponsored', label: 'Sponsored theses', icon: 'ti-user-check',
      roles: ['senate_faculty', 'lecturer'], actions: ['sponsored'] },
    { key: 'enrollqueue', label: 'Enrollment queue', icon: 'ti-gavel',
      roles: ['thesis_sponsor'],
      actions: ['enrollSponsorQueue', 'enrollSponsorApprove', 'enrollSponsorReturn'] },
    { key: 'enrolladvisor', label: 'Enrollment advisor', icon: 'ti-clipboard-check',
      roles: [ADVISOR_ROLE], floor: ADVISOR_ROLE,
      actions: ['enrollAdvisorQueue', 'enrollAdvisorComplete', 'enrollAdvisorReturn', 'enrollRemind'] },
    { key: 'grad',      label: 'Graduation queue', icon: 'ti-school',
      roles: [ADVISOR_ROLE], floor: ADVISOR_ROLE,
      actions: ['gradQueue', 'advisorComplete', 'remindResponsible'] },
    { key: 'settings',  label: 'Settings',         icon: 'ti-settings',
      roles: [ADVISOR_ROLE], floor: ADVISOR_ROLE,
      actions: ['getSettings', 'saveSettings'] },
  ];

  // Optional decision-comment PDFs (sponsor + reader) live in their OWN Drive
  // folder, separate from the thesis PDFs. Every workflow participant is
  // granted viewer access to a comment file when it is attached. When a
  // decision comes in with a file but an empty comment box, the comment text
  // defaults to this string so the required-comments contract still holds.
  const COMMENT_FOLDER_ID = '1QUZTBfhLV2BXjsHHI55G6_O8PpeHwT_2';
  const COMMENT_SEE_ATTACHED = 'see attached document';


  // ── Public actions (callable via dispatch) ─────────────────

  /**
   * Users eligible for a thesis capability, shaped { email, name } for a
   * dropdown. Eligibility is a plain identity role — capability 'sponsor'
   * maps to the 'thesis_sponsor' role, 'reader' to 'thesis_reader' —
   * assigned per-user in Admin → Users.
   * @param {Object} payload - { capability: 'sponsor' | 'reader' }
   */
  function listEligible(payload) {
    const capability = String((payload || {}).capability || 'sponsor');
    const role = capability === 'reader' ? 'thesis_reader' : 'thesis_sponsor';
    return Auth.usersWithRole(role);
  }


  /**
   * The controlled country list, grouped by continent, for the region
   * picker. Continent is presentation only — it is never stored.
   * @returns {Array<{continent, countries:string[]}>}
   */
  function listCountries() {
    return Countries.grouped();
  }


  /**
   * Submits a NEW thesis, or resubmits one currently in RETURNED.
   * A student may have ONE thesis, period — any existing record blocks a
   * new submission regardless of term (the advisor handles exceptions).
   *
   * @param {Object} payload
   *   @param {string} payload.quarter      - one of QUARTERS
   *   @param {string} payload.year         - 4-digit year
   *   @param {string} payload.title        - thesis title
   *   @param {string} [payload.abstract]   - abstract / description (required)
   *   @param {Array}  payload.regions      - [{ country, locality? }, ...]; >=1 required
   *   @param {boolean} payload.shareConsent- "Share" vs "Don't share"
   *   @param {string} payload.sponsorEmail - chosen faculty sponsor
   *   @param {Object} payload.file         - { dataBase64, mimeType } the PDF
   *   @param {string} [payload.thesisId]   - present on resubmission
   */
  function submit(payload, user) {
    payload = payload || {};
    const quarter = _requireOneOf(payload.quarter, QUARTERS, 'Quarter');
    const year    = _validYear(payload.year);
    const title   = String(payload.title || '').trim();
    const abstract = String(payload.abstract || '').trim();
    const regions = _parseRegions(payload.regions);
    const sponsorEmail = String(payload.sponsorEmail || '').trim();
    const shareConsent = payload.shareConsent === true || payload.shareConsent === 'true';

    if (!title)        throw new Error('Thesis title is required.');
    if (!abstract)     throw new Error('Thesis abstract is required.');
    if (!regions.length) throw new Error('Add at least one geographic region (country).');
    if (!sponsorEmail) throw new Error('Select a faculty sponsor.');
    if (!_holdsRole(sponsorEmail, 'thesis_sponsor')) {
      throw new Error('That person is not currently eligible to sponsor theses.');
    }

    const profile = Auth.getProfile(user);
    if (!profile) throw new Error('Your profile could not be found.');
    if (!profile.studentId) {
      throw new Error('Your profile has no Student ID on file. Contact the department to add one before submitting.');
    }

    const existingId = String(payload.thesisId || '').trim();

    // ── Resubmission path: must target the caller's own RETURNED record ──
    if (existingId) {
      const rec = _byId(existingId);
      if (!rec) throw new Error('Thesis not found: ' + existingId);
      if (_norm(rec.StudentEmail) !== _norm(user)) {
        throw new Error('You can only resubmit your own thesis.');
      }
      if (rec.Stage !== STAGE.RETURNED) {
        throw new Error('This thesis is not awaiting resubmission.');
      }

      const fileName = _buildFileName(quarter, year, profile);
      const replaced = _replacePdf(rec.DriveFileID, payload.file, fileName);
      _grantStudentView(replaced.fileId, rec.StudentEmail);

      DataService.update(CONFIG.SHEETS.THESIS, TAB, 'ThesisID', existingId, {
        Quarter: quarter, Year: year, Title: title, Abstract: abstract,
        Regions: JSON.stringify(regions),
        ShareConsent: shareConsent ? 'TRUE' : 'FALSE',
        SponsorEmail: sponsorEmail,
        DriveFileID: replaced.fileId, FileName: fileName, DocumentLink: replaced.url,
        Stage: STAGE.SUBMITTED,
        // Clear any prior return note so the record reads cleanly.
        ReturnNote: '',
      });

      _routeToSponsor(existingId, sponsorEmail, profile, title, user, /*resubmitted*/ true);
      return { thesisId: existingId, stage: STAGE.SUBMITTED, resubmitted: true };
    }

    // ── New submission: ONE thesis per student, period ──
    // Term is irrelevant: any existing record blocks a fresh submission.
    // (Previously this only blocked the same Quarter+Year, which let a
    // student file a second thesis under a different term.) A RETURNED
    // thesis must be revised via resubmission, not replaced; anything
    // else goes through the undergraduate advisor.
    const existing = DataService.query(CONFIG.SHEETS.THESIS, TAB, 'StudentEmail', user);
    if (existing.length) {
      const b = existing[0];
      const msg = b.Stage === STAGE.RETURNED
        ? 'Your ' + b.Quarter + ' ' + b.Year + ' thesis was returned for revision — use ' +
          '"Revise & resubmit" on it in My theses instead of submitting a new one.'
        : b.Stage === STAGE.COMPLETE
          ? 'Your ' + b.Quarter + ' ' + b.Year + ' thesis has already been processed. ' +
            'To submit another thesis, contact the undergraduate advisor.'
          : 'You already have a ' + b.Quarter + ' ' + b.Year + ' thesis under review. ' +
            'Multiple submissions are not permitted — contact the undergraduate advisor if you believe this is an error.';
      throw new Error(msg);
    }

    const thesisId = DataService.generateId('THES');
    const fileName = _buildFileName(quarter, year, profile);
    const link = _uploadPdf(payload.file, fileName);
    _grantStudentView(link.fileId, user);

    DataService.insert(CONFIG.SHEETS.THESIS, TAB, {
      ThesisID: thesisId,
      StudentEmail: user,
      Quarter: quarter, Year: year, Title: title, Abstract: abstract,
      Regions: JSON.stringify(regions),
      ShareConsent: shareConsent ? 'TRUE' : 'FALSE',
      SponsorEmail: sponsorEmail,
      DriveFileID: link.fileId, FileName: fileName, DocumentLink: link.url,
      Stage: STAGE.SUBMITTED,
      SponsorDecision: '', SponsorComments: '', SponsorDecidedBy: '', SponsorDecidedAt: '',
      SponsorCommentFileID: '', SponsorCommentLink: '',
      ReaderEmail: '', HonorsDecision: '', ReaderComments: '', ReaderDecidedBy: '', ReaderDecidedAt: '',
      ReaderCommentFileID: '', ReaderCommentLink: '',
      AdvisorProcessedBy: '', AdvisorProcessedAt: '', ReturnNote: '',
    });

    _routeToSponsor(thesisId, sponsorEmail, profile, title, user, /*resubmitted*/ false);
    return { thesisId: thesisId, stage: STAGE.SUBMITTED };
  }


  /** The caller's own theses, newest first, in the student's masked view
   *  (super_admin test accounts see truth). */
  function mySubmissions(payload, user, roles) {
    const isSuper = (roles || []).indexOf('super_admin') !== -1;
    return DataService.query(CONFIG.SHEETS.THESIS, TAB, 'StudentEmail', user)
      .map(r => isSuper ? _publicRecord(r) : _studentView(r))
      .sort(_byCreatedDesc);
  }


  /** Theses the caller has sponsored, at any stage (in progress and
   *  complete), newest first. The sponsor's history view. */
  function sponsored(payload, user) {
    return DataService.query(CONFIG.SHEETS.THESIS, TAB, 'SponsorEmail', user)
      .map(_publicRecord)
      .sort(_byCreatedDesc);
  }


  /**
   * The Review queue for the current user — a thesis stays visible to
   * every participant until it COMPLETES (the stage badge shows where it
   * sits), rather than only while actionable by them:
   *   - sponsors see every thesis they sponsor, at any non-complete stage;
   *   - readers see theirs from assignment through final processing;
   *   - advisors (and super_admin) see ALL non-complete theses — including
   *     PENDING_ADVISOR, which also appears in their Graduation queue
   *     (Review queue = visibility, Graduation queue = the work);
   *   - super_admin may pass { scope: 'all' } to include COMPLETE too.
   */
  function queue(payload, user, roles) {
    payload = payload || {};
    const isAdvisor = _isUndergradAdvisor(user) || roles.indexOf('super_admin') !== -1;

    if (payload.scope === 'all' && roles.indexOf('super_admin') !== -1) {
      return DataService.getAll(CONFIG.SHEETS.THESIS, TAB).map(_publicRecord).sort(_byCreatedDesc);
    }

    const all = DataService.getAll(CONFIG.SHEETS.THESIS, TAB);
    const mine = all.filter(r => {
      if (r.Stage === STAGE.COMPLETE) return false;
      if (_norm(r.SponsorEmail) === _norm(user)) return true;
      if (r.ReaderEmail && _norm(r.ReaderEmail) === _norm(user)) return true;
      if (isAdvisor) return true;
      return false;
    });
    return mine.map(_publicRecord).sort(_byCreatedDesc);
  }


  /** A single record (used by dashboard deep-linking). Visible to the
   *  student, the assigned sponsor/reader, the advisor, or super_admin. */
  function get(payload, user, roles) {
    const rec = _byId(String((payload || {}).thesisId || '').trim());
    if (!rec) throw new Error('Thesis not found.');
    const allowed = _norm(rec.StudentEmail) === _norm(user)
      || _norm(rec.SponsorEmail) === _norm(user)
      || _norm(rec.ReaderEmail) === _norm(user)
      || _isUndergradAdvisor(user)
      || roles.indexOf('super_admin') !== -1;
    if (!allowed) throw new Error('You do not have access to this thesis.');
    const isSuper = roles.indexOf('super_admin') !== -1;
    // The student gets the masked view of their own record (honors
    // referral invisible unless approved); privileged viewers see truth.
    if (_norm(user) === _norm(rec.StudentEmail) && !isSuper && !_isUndergradAdvisor(user)) {
      return _studentView(rec);
    }
    const pub = _publicRecord(rec);
    if (_isUndergradAdvisor(user) || isSuper) {
      _withAdvisorFields(pub, rec);
    }
    return pub;
  }


  /**
   * Faculty sponsor records a decision on a SUBMITTED thesis.
   * @param {Object} payload - { thesisId, decision, comments, readerEmail? }
   *   decision ∈ {Pass, No Pass, Review for Honors}
   *   readerEmail REQUIRED only when decision === 'Review for Honors'
   */
  function sponsorDecision(payload, user, roles) {
    payload = payload || {};
    const rec = _requireStage(payload.thesisId, STAGE.SUBMITTED);
    if (_norm(rec.SponsorEmail) !== _norm(user) && roles.indexOf('super_admin') === -1) {
      throw new Error('Only the assigned faculty sponsor can decide this thesis.');
    }

    const decision = _requireOneOf(payload.decision,
      [SPONSOR.PASS, SPONSOR.NO_PASS, SPONSOR.HONORS], 'Decision');

    // Optional comment PDF. When attached and the textarea is left blank,
    // the comment text defaults to "see attached document" so the required-
    // comments contract still holds (applied here, server-side, BEFORE the
    // required-check — a client default is convenience, this is the source
    // of truth). The textarea stays freely editable, so a sponsor may both
    // attach and write.
    let comments = String(payload.comments || '').trim();
    const hasCommentFile = _hasFile(payload.commentFile);
    if (!comments && hasCommentFile) comments = COMMENT_SEE_ATTACHED;
    if (!comments) throw new Error('Comments are required with your decision.');
    const now = new Date();

    // Upload the comment PDF (if any) to the comments folder and grant the
    // workflow participants viewer access. For an honors referral the reader
    // is added too. Best-effort grants — a sharing hiccup must not fail the
    // decision. Replace-in-place reuses any prior sponsor-comment file id.
    let sponsorCommentFile = { fileId: rec.SponsorCommentFileID || '', url: rec.SponsorCommentLink || '' };
    if (hasCommentFile) {
      const profileForName = Auth.getProfile(rec.StudentEmail) || {};
      const cfName = _commentFileName(rec, profileForName, 'SPONSOR');
      sponsorCommentFile = _saveCommentPdf(rec.SponsorCommentFileID, payload.commentFile, cfName);
      const viewers = [rec.SponsorEmail, rec.StudentEmail].concat(_advisors().map(a => a.email));
      if (decision === SPONSOR.HONORS) viewers.push(String(payload.readerEmail || '').trim());
      _grantCommentViewers(sponsorCommentFile.fileId, viewers);
    }

    const updates = {
      SponsorDecision: decision, SponsorComments: comments,
      SponsorDecidedBy: user, SponsorDecidedAt: now,
      SponsorCommentFileID: sponsorCommentFile.fileId,
      SponsorCommentLink: sponsorCommentFile.url,
      ReturnNote: '',   // clear any advisor re-review note once re-decided
    };

    Tasks.resolveForSource('thesis', rec.ThesisID, { resolvedBy: user });

    if (decision === SPONSOR.HONORS) {
      const readerEmail = String(payload.readerEmail || '').trim();
      if (!readerEmail) throw new Error('Select a faculty reader for honors review.');
      if (!_holdsRole(readerEmail, 'thesis_reader')) {
        throw new Error('That person is not currently eligible to be an honors reader.');
      }
      if (_norm(readerEmail) === _norm(user)) throw new Error('The honors reader must be someone other than the sponsor.');

      updates.ReaderEmail = readerEmail;
      updates.Stage = STAGE.PENDING_HONORS;
      DataService.update(CONFIG.SHEETS.THESIS, TAB, 'ThesisID', rec.ThesisID, updates);

      const student = Auth.getProfile(rec.StudentEmail);
      Tasks.create({
        module: 'thesis', sourceType: 'thesis_honors', sourceId: rec.ThesisID,
        label: 'Honors review: ' + _studentLabel(student) + ' — ' + rec.Title,
        assignedTo: readerEmail, staleAfterDays: 14,
      });
      const honorsRec = _byId(rec.ThesisID);  // reflects reader + new stage
      const honorsHeading = 'You have been named honors reader for a senior thesis. ' +
        'Sponsor: ' + _facultyLabel(user) + '.';
      _notify(readerEmail, 'Thesis honors review requested',
        honorsHeading + '\n\nStudent: ' + _studentLabel(student) + '\nTitle: ' + rec.Title +
        _actionTextFallback(rec.ThesisID, 'Review this thesis'),
        _summaryHtml(honorsRec, { heading: honorsHeading }) +
        _actionButtonHtml(rec.ThesisID, 'Review this thesis'));
      EventBus.emit('thesis.sponsor_decided',
        { thesisId: rec.ThesisID, decision: decision, readerEmail: readerEmail }, { user: user });
      return { thesisId: rec.ThesisID, stage: STAGE.PENDING_HONORS };
    }

    // Pass or No Pass — both flow to the advisor for final processing.
    updates.Stage = STAGE.PENDING_ADVISOR;
    DataService.update(CONFIG.SHEETS.THESIS, TAB, 'ThesisID', rec.ThesisID, updates);
    const decidedRec = _byId(rec.ThesisID);  // reflects the decision just recorded
    _routeToAdvisor(rec.ThesisID, decidedRec, user);
    if (decision === SPONSOR.PASS) {
      // The student learns of acceptance at the decision, not after the
      // advisor's internal final processing. (No Pass is not announced
      // here — the completion notice and the sponsor handle that.)
      const acceptHeading = 'Congratulations — your senior thesis has been accepted by your faculty sponsor.';
      const nextNote = 'The undergraduate advisor will now complete final processing; ' +
        'you will receive confirmation once it is recorded.';
      _notify(rec.StudentEmail, 'Your thesis has been accepted',
        acceptHeading + '\n\n' + nextNote + _actionTextFallback(rec.ThesisID, 'View your thesis'),
        _summaryHtml(decidedRec, { heading: acceptHeading, studentView: true }) +
        '<p style="margin:0 0 16px;">' + _esc(nextNote) + '</p>' +
        _actionButtonHtml(rec.ThesisID, 'View your thesis'));
    }
    EventBus.emit('thesis.sponsor_decided',
      { thesisId: rec.ThesisID, decision: decision }, { user: user });
    return { thesisId: rec.ThesisID, stage: STAGE.PENDING_ADVISOR };
  }


  /**
   * Honors reader APPROVES a thesis for honors (with required comments).
   * There is no denial: a reader who is not convinced uses returnToSponsor
   * instead, and the sponsor re-decides (typically a plain Pass).
   * @param {Object} payload - { thesisId, comments }
   */
  function readerDecision(payload, user, roles) {
    payload = payload || {};
    const rec = _requireStage(payload.thesisId, STAGE.PENDING_HONORS);
    if (_norm(rec.ReaderEmail) !== _norm(user) && roles.indexOf('super_admin') === -1) {
      throw new Error('Only the assigned faculty reader can decide this honors review.');
    }
    let comments = String(payload.comments || '').trim();
    const hasCommentFile = _hasFile(payload.commentFile);
    if (!comments && hasCommentFile) comments = COMMENT_SEE_ATTACHED;
    if (!comments) throw new Error('Comments are required to approve honors.');

    // Optional reader comment PDF → comments folder, with viewer access for
    // the workflow participants (reader, sponsor, advisors, student).
    // Best-effort grants; replace-in-place reuses any prior reader-comment id.
    let readerCommentFile = { fileId: rec.ReaderCommentFileID || '', url: rec.ReaderCommentLink || '' };
    if (hasCommentFile) {
      const profileForName = Auth.getProfile(rec.StudentEmail) || {};
      const cfName = _commentFileName(rec, profileForName, 'READER');
      readerCommentFile = _saveCommentPdf(rec.ReaderCommentFileID, payload.commentFile, cfName);
      const viewers = [rec.ReaderEmail, rec.SponsorEmail, rec.StudentEmail]
        .concat(_advisors().map(a => a.email));
      _grantCommentViewers(readerCommentFile.fileId, viewers);
    }

    Tasks.resolveForSource('thesis', rec.ThesisID, { resolvedBy: user });
    DataService.update(CONFIG.SHEETS.THESIS, TAB, 'ThesisID', rec.ThesisID, {
      HonorsDecision: HONORS.APPROVED, ReaderComments: comments,
      ReaderDecidedBy: user, ReaderDecidedAt: new Date(),
      ReaderCommentFileID: readerCommentFile.fileId,
      ReaderCommentLink: readerCommentFile.url,
      Stage: STAGE.PENDING_ADVISOR,
    });
    const decidedRec = _byId(rec.ThesisID);  // reflects the honors approval
    _routeToAdvisor(rec.ThesisID, decidedRec, user);

    const acceptHeading = 'Congratulations — your senior thesis has been accepted and approved for honors.';
    const nextNote = 'The undergraduate advisor will now complete final processing; ' +
      'you will receive confirmation once it is recorded.';
    _notify(rec.StudentEmail, 'Your thesis has been accepted with honors',
      acceptHeading + '\n\n' + nextNote + _actionTextFallback(rec.ThesisID, 'View your thesis'),
      _summaryHtml(decidedRec, { heading: acceptHeading, studentView: true }) +
      '<p style="margin:0 0 16px;">' + _esc(nextNote) + '</p>' +
      _actionButtonHtml(rec.ThesisID, 'View your thesis'));

    EventBus.emit('thesis.honors_decided',
      { thesisId: rec.ThesisID, decision: HONORS.APPROVED }, { user: user });
    return { thesisId: rec.ThesisID, stage: STAGE.PENDING_ADVISOR };
  }


  /**
   * Undergraduate advisor (or super_admin) finishes a PENDING_ADVISOR
   * thesis. The advisor must attest to having opened the thesis document.
   * For an APPROVED outcome they must also confirm the milestone is
   * entered in the Degree Progress Report; a No Pass is closed out
   * without a milestone (there is none to enter for a failed thesis).
   * @param {Object} payload - { thesisId, documentViewed: true,
   *                             milestoneEntered: true (approved only) }
   */
  function advisorComplete(payload, user, roles) {
    payload = payload || {};
    const rec = _requireStage(payload.thesisId, STAGE.PENDING_ADVISOR);
    if (!_isUndergradAdvisor(user) && roles.indexOf('super_admin') === -1) {
      throw new Error('Only the undergraduate advisor can complete a thesis.');
    }
    const viewed = payload.documentViewed === true || payload.documentViewed === 'true';
    if (!viewed) {
      throw new Error('Open the thesis document before completing.');
    }
    const approved = _isApproved(rec);
    const milestone = payload.milestoneEntered === true || payload.milestoneEntered === 'true';
    if (approved && !milestone) {
      throw new Error('Confirm the milestone has been entered into the Degree Progress Report.');
    }
    Tasks.resolveForSource('thesis', rec.ThesisID, { resolvedBy: user });
    DataService.update(CONFIG.SHEETS.THESIS, TAB, 'ThesisID', rec.ThesisID, {
      AdvisorProcessedBy: user, AdvisorProcessedAt: new Date(),
      MilestoneEntered: approved ? 'TRUE' : '',
      Stage: STAGE.COMPLETE,
    });

    // Public access: only now (completed), only if accepted, only with the
    // student's consent. A No Pass close-out is never published. Best-effort
    // — a sharing-policy hiccup must not fail completion.
    if (approved && String(rec.ShareConsent).toUpperCase() === 'TRUE') {
      _setPdfLinkSharing(rec.DriveFileID, true);
    }
    const student = Auth.getProfile(rec.StudentEmail);
    const doneRec = _byId(rec.ThesisID);
    // Outcome wording from the STUDENT's view — a denied honors referral
    // reads as a plain Pass here too.
    const sv = _studentView(doneRec);
    const svOutcome = (sv.sponsorDecision || '(no decision)') +
      (sv.honorsDecision ? ' → ' + sv.honorsDecision : '');
    const doneHeading = 'Your ' + rec.Quarter + ' ' + rec.Year + ' senior thesis "' + rec.Title +
      '" has completed review. Outcome: ' + svOutcome + '.';
    _notify(rec.StudentEmail, 'Your senior thesis has been processed',
      doneHeading + _actionTextFallback(rec.ThesisID, 'View your thesis'),
      _summaryHtml(doneRec, { heading: doneHeading, studentView: true }) +
      _actionButtonHtml(rec.ThesisID, 'View your thesis'));
    EventBus.emit('thesis.completed', { thesisId: rec.ThesisID }, { user: user });
    return { thesisId: rec.ThesisID, stage: STAGE.COMPLETE };
  }


  /**
   * The advisor's work queue: theses at PENDING_ADVISOR, both approved
   * (milestone entry + complete) and No Pass (close-out). Completing a
   * thesis removes it from this queue — there is no separate
   * "mark recorded" step; the milestone attestation IS the
   * graduation-records work. Advisor role-holders and super_admin only.
   */
  function gradQueue(payload, user, roles) {
    if (!_isUndergradAdvisor(user) && roles.indexOf('super_admin') === -1) {
      throw new Error('Only the undergraduate advisor can view the graduation queue.');
    }
    return DataService.getAll(CONFIG.SHEETS.THESIS, TAB)
      .filter(r => r.Stage === STAGE.PENDING_ADVISOR)
      .map(r => _withAdvisorFields(_publicRecord(r), r))
      .sort(_byCreatedDesc);
  }


  /**
   * Advisor (or super_admin) nudges whoever a thesis is currently waiting
   * on: the sponsor (SUBMITTED), the honors reader (PENDING_HONORS), or
   * the student (RETURNED). Sends regardless of the NOTIFY_ON_HANDOFF
   * setting — a deliberate manual reminder should always go out.
   * @param {Object} payload - { thesisId }
   */
  function remindResponsible(payload, user, roles) {
    if (!_isUndergradAdvisor(user) && roles.indexOf('super_admin') === -1) {
      throw new Error('Only the undergraduate advisor can send reminders.');
    }
    const rec = _byId(String((payload || {}).thesisId || '').trim());
    if (!rec) throw new Error('Thesis not found.');

    let to, ask;
    if (rec.Stage === STAGE.SUBMITTED) {
      to = rec.SponsorEmail; ask = 'review it as faculty sponsor';
    } else if (rec.Stage === STAGE.PENDING_HONORS) {
      to = rec.ReaderEmail; ask = 'complete the honors review';
    } else if (rec.Stage === STAGE.RETURNED) {
      to = rec.StudentEmail; ask = 'revise and resubmit it';
    } else {
      throw new Error('This thesis is not waiting on anyone to remind.');
    }
    if (!to) throw new Error('No one is assigned at this stage to remind.');

    const heading = 'A reminder from ' + _facultyLabel(user) +
      ': this senior thesis is waiting for you to ' + ask + '.';
    _notify(to, 'Reminder: senior thesis awaiting your action',
      heading + '\n\nTitle: ' + rec.Title +
      _actionTextFallback(rec.ThesisID, 'Open this thesis'),
      _summaryHtml(rec, { heading: heading, studentView: rec.Stage === STAGE.RETURNED }) +
      _actionButtonHtml(rec.ThesisID, 'Open this thesis'),
      /*force*/ true);
    EventBus.emit('thesis.reminded', { thesisId: rec.ThesisID, remindedTo: to }, { user: user });
    return { thesisId: rec.ThesisID, remindedTo: to };
  }


  /**
   * Maintenance: ensures every PENDING_ADVISOR thesis has exactly one
   * open, role-assigned dashboard task. Repairs theses that routed while
   * no one held the advisor role (whose tasks were unassigned and thus
   * invisible) or under the old per-person fan-out. Idempotent — safe to
   * run repeatedly. super_admin only.
   * @returns {{ repaired: number }}
   */
  function repairAdvisorTasks(payload, user, roles) {
    if (roles.indexOf('super_admin') === -1) {
      throw new Error('Only a super admin can repair advisor tasks.');
    }
    const pending = DataService.getAll(CONFIG.SHEETS.THESIS, TAB)
      .filter(r => r.Stage === STAGE.PENDING_ADVISOR);
    pending.forEach(r => {
      Tasks.resolveForSource('thesis', r.ThesisID, { resolvedBy: user });
      const student = Auth.getProfile(r.StudentEmail);
      Tasks.create({
        module: 'thesis', sourceType: 'thesis_final', sourceId: r.ThesisID,
        label: 'Thesis ready for final processing: ' + _studentLabel(student) + ' — ' + r.Title,
        assignedRole: ADVISOR_ROLE, staleAfterDays: 14,
      });
    });
    Logger.log('repairAdvisorTasks: rebuilt tasks for ' + pending.length + ' pending theses.');
    return { repaired: pending.length };
  }


  /**
   * Permanently deletes a thesis: resolves its open tasks, trashes its
   * Drive PDF (best-effort), and removes the sheet row. super_admin only.
   * Built for cleaning up test submissions — irreversible, so the UI
   * confirms before calling. Audit-log entries are deliberately left
   * intact (append-only history).
   * @param {Object} payload - { thesisId }
   */
  function deleteThesis(payload, user, roles) {
    if (roles.indexOf('super_admin') === -1) {
      throw new Error('Only a super admin can delete a thesis.');
    }
    const rec = _byId(String((payload || {}).thesisId || '').trim());
    if (!rec) throw new Error('Thesis not found.');

    // Clear dashboard pointers first so nothing references a gone record.
    Tasks.resolveForSource('thesis', rec.ThesisID, { resolvedBy: user });

    // Trash the PDF if it still exists; a missing file must not block deletion.
    const fileId = String(rec.DriveFileID || '').trim();
    if (fileId) {
      // Revoke any public link-sharing first, so a published thesis cannot
      // remain world-readable if the trash step is denied.
      _setPdfLinkSharing(fileId, false);
      try { DriveApp.getFileById(fileId).setTrashed(true); }
      catch (err) { Logger.log('deleteThesis: could not trash file ' + fileId + ' (' + err + ')'); }
    }

    // Trash any decision-comment PDFs too (best-effort).
    _trashCommentPdf(rec.SponsorCommentFileID);
    _trashCommentPdf(rec.ReaderCommentFileID);

    const removed = DataService.remove(CONFIG.SHEETS.THESIS, TAB, 'ThesisID', rec.ThesisID);
    if (!removed) throw new Error('Delete failed — the record could not be removed.');

    EventBus.emit('thesis.deleted', { thesisId: rec.ThesisID }, { user: user });
    return { thesisId: rec.ThesisID, deleted: true };
  }


  /**
   * Returns a thesis to the student for resubmission. Allowed ONLY from
   * SUBMITTED, by the assigned sponsor or super_admin. Once a decision is
   * recorded the outcome is final — the advisor's stage is pure filing
   * and cannot send a thesis back.
   * @param {Object} payload - { thesisId, note }
   */
  function returnToStudent(payload, user, roles) {
    payload = payload || {};
    const rec = _byId(String(payload.thesisId || '').trim());
    if (!rec) throw new Error('Thesis not found.');
    const note = String(payload.note || '').trim();
    if (!note) throw new Error('Add a note telling the student what to fix.');

    const isSuper = roles.indexOf('super_admin') !== -1;
    if (rec.Stage !== STAGE.SUBMITTED) {
      throw new Error('A thesis can only be returned before the sponsor decides.');
    }
    if (_norm(rec.SponsorEmail) !== _norm(user) && !isSuper) {
      throw new Error('Only the assigned faculty sponsor can return this thesis.');
    }

    Tasks.resolveForSource('thesis', rec.ThesisID, { resolvedBy: user });
    DataService.update(CONFIG.SHEETS.THESIS, TAB, 'ThesisID', rec.ThesisID, {
      Stage: STAGE.RETURNED, ReturnNote: note,
    });
    Tasks.create({
      module: 'thesis', sourceType: 'thesis_returned', sourceId: rec.ThesisID,
      label: 'Thesis returned — revise and resubmit: ' + rec.Title,
      assignedTo: rec.StudentEmail, staleAfterDays: 14,
    });
    const returnedRec = _byId(rec.ThesisID);
    const returnHeading = 'Your ' + rec.Quarter + ' ' + rec.Year + ' senior thesis "' + rec.Title +
      '" was returned by ' + _facultyLabel(user) + ' for revision.';
    _notify(rec.StudentEmail, 'Your senior thesis was returned for revision',
      returnHeading + '\n\nNote:\n' + note +
      _actionTextFallback(rec.ThesisID, 'Revise and resubmit'),
      _summaryHtml(returnedRec, { heading: returnHeading, studentView: true }) +
      '<p style="margin:0 0 16px;"><strong>Reviewer note:</strong><br>' + _esc(note) + '</p>' +
      _actionButtonHtml(rec.ThesisID, 'Revise and resubmit'));
    EventBus.emit('thesis.returned', { thesisId: rec.ThesisID }, { user: user });
    return { thesisId: rec.ThesisID, stage: STAGE.RETURNED };
  }


  /**
   * Sends a thesis back to the SPONSOR for re-decision. Allowed from:
   *   - PENDING_ADVISOR by an advisor role-holder (or super_admin)
   *   - PENDING_HONORS  by the assigned honors reader, an advisor
   *     role-holder (the unstick for an unresponsive reader), or super_admin
   * The recorded sponsor/reader decisions are cleared (the re-decision
   * starts fresh; history survives in the audit log), and the sponsor is
   * re-tasked and notified with the returner's note. The student is NOT
   * notified — this is an internal faculty/staff correction loop, and
   * only the sponsor can ever return a thesis to the student.
   * @param {Object} payload - { thesisId, note }
   */
  function returnToSponsor(payload, user, roles) {
    payload = payload || {};
    const rec = _byId(String(payload.thesisId || '').trim());
    if (!rec) throw new Error('Thesis not found.');
    const isSuper = roles.indexOf('super_admin') !== -1;

    const advisorReturn = (rec.Stage === STAGE.PENDING_ADVISOR || rec.Stage === STAGE.PENDING_HONORS) &&
      (_isUndergradAdvisor(user) || isSuper);
    const readerReturn = rec.Stage === STAGE.PENDING_HONORS &&
      _norm(rec.ReaderEmail) === _norm(user);
    if (!advisorReturn && !readerReturn) {
      throw new Error('You cannot return this thesis to the sponsor at its current stage.');
    }

    const note = String(payload.note || '').trim();
    if (!note) throw new Error('Add a note telling the sponsor what needs another look.');

    Tasks.resolveForSource('thesis', rec.ThesisID, { resolvedBy: user });
    // A cleared decision must not leave its comment attachment dangling:
    // trash both comment PDFs (best-effort) and clear their fields alongside
    // the decision fields they belong to.
    _trashCommentPdf(rec.SponsorCommentFileID);
    _trashCommentPdf(rec.ReaderCommentFileID);
    DataService.update(CONFIG.SHEETS.THESIS, TAB, 'ThesisID', rec.ThesisID, {
      Stage: STAGE.SUBMITTED, ReturnNote: note,
      SponsorDecision: '', SponsorComments: '', SponsorDecidedBy: '', SponsorDecidedAt: '',
      SponsorCommentFileID: '', SponsorCommentLink: '',
      ReaderEmail: '', HonorsDecision: '', ReaderComments: '', ReaderDecidedBy: '', ReaderDecidedAt: '',
      ReaderCommentFileID: '', ReaderCommentLink: '',
    });

    const student = Auth.getProfile(rec.StudentEmail);
    Tasks.create({
      module: 'thesis', sourceType: 'thesis_review', sourceId: rec.ThesisID,
      label: 'Thesis returned for re-review: ' + _studentLabel(student) + ' — ' + rec.Title,
      assignedTo: rec.SponsorEmail, staleAfterDays: 14,
    });
    const heading = _facultyLabel(user) + ' has returned this thesis to you for re-review. ' +
      'Your previous decision has been cleared — please review and decide again.';
    const freshRec = _byId(rec.ThesisID);  // decisions now cleared
    _notify(rec.SponsorEmail, 'Thesis returned for your re-review',
      heading + '\n\nNote:\n' + note +
      '\n\nStudent: ' + _studentLabel(student) + '\nTitle: ' + rec.Title +
      _actionTextFallback(rec.ThesisID, 'Re-review this thesis'),
      _summaryHtml(freshRec, { heading: heading }) +
      '<p style="margin:0 0 16px;"><strong>Note:</strong><br>' + _esc(note) + '</p>' +
      _actionButtonHtml(rec.ThesisID, 'Re-review this thesis'));
    EventBus.emit('thesis.returned_to_sponsor', { thesisId: rec.ThesisID }, { user: user });
    return { thesisId: rec.ThesisID, stage: STAGE.SUBMITTED };
  }


  // ── Routing helpers (workflow lives in the module, not in Tasks) ──

  function _routeToSponsor(thesisId, sponsorEmail, studentProfile, title, user, resubmitted) {
    Tasks.create({
      module: 'thesis', sourceType: 'thesis_review', sourceId: thesisId,
      label: 'Thesis awaiting sponsor review: ' + _studentLabel(studentProfile) + ' — ' + title,
      assignedTo: sponsorEmail, staleAfterDays: 14,
    });
    const heading = resubmitted
      ? 'A senior thesis has been resubmitted for your review.'
      : 'A senior thesis has been submitted for your review.';
    const sponsorRec = _byId(thesisId);
    _notify(sponsorEmail,
      resubmitted ? 'Thesis resubmitted for your review' : 'Thesis submitted for your review',
      heading + '\n\nStudent: ' + _studentLabel(studentProfile) + '\nTitle: ' + title +
      _actionTextFallback(thesisId, 'Review this thesis'),
      _summaryHtml(sponsorRec, { heading: heading }) +
      _actionButtonHtml(thesisId, 'Review this thesis'));

    // Receipt to the student: confirms the department has the thesis and
    // points them at My theses for status. (`user` is the submitting
    // student on both the fresh and resubmission paths.)
    const receiptHeading = resubmitted
      ? 'Your revised senior thesis has been received by the Anthropology Department and is back under review.'
      : 'Your senior thesis has been received by the Anthropology Department.';
    const statusNote = 'You can check its status anytime in the "My theses" tab of the Senior Thesis module — ' +
      'you will also be notified when review is complete.';
    _notify(user,
      resubmitted ? 'Your revised thesis has been received' : 'Your thesis has been received',
      receiptHeading + '\n\n' + statusNote +
      '\n\nTitle: ' + title +
      _actionTextFallback(thesisId, 'View your thesis'),
      _summaryHtml(sponsorRec, { heading: receiptHeading, studentView: true }) +
      '<p style="margin:0 0 16px;">' + _esc(statusNote) + '</p>' +
      _actionButtonHtml(thesisId, 'View your thesis'));

    EventBus.emit(resubmitted ? 'thesis.resubmitted' : 'thesis.submitted',
      { thesisId: thesisId, sponsorEmail: sponsorEmail }, { user: user });
  }

  function _routeToAdvisor(thesisId, rec, user) {
    const student = Auth.getProfile(rec.StudentEmail);
    const advisors = _advisors();
    const approved = _isApproved(rec);
    const subject = approved
      ? 'Thesis approved — ready for final processing'
      : 'Thesis No Pass — ready for final processing';
    const label = 'Thesis ready for final processing: ' + _studentLabel(student) + ' — ' + rec.Title;
    const heading = (approved
      ? 'A senior thesis has been approved and is ready for final processing.'
      : 'A senior thesis received a No Pass and is ready for final processing.');
    const textBody = heading +
      '\n\nStudent: ' + _studentLabel(student) + '\nTitle: ' + rec.Title +
      '\nOutcome: ' + _outcomeSummary(rec) +
      _actionTextFallback(thesisId, 'Complete this thesis');
    const htmlBody = _summaryHtml(rec, { heading: heading }) +
      _actionButtonHtml(thesisId, 'Complete this thesis');

    if (!advisors.length) {
      // No one holds the advisor role right now. The shared role-assigned
      // task below still gets created — it will appear on the dashboard of
      // whoever is granted the role later, so the situation self-heals.
      // Warn super_admins so someone assigns the role (or acts directly).
      const warnHeading = 'A senior thesis is ready for final processing, but no one currently holds the ' +
        '"' + ADVISOR_ROLE + '" role. Assign the role in Admin → Users (the task will appear on their ' +
        'dashboard automatically), or complete the thesis yourself.';
      (CONFIG.SUPER_ADMINS || []).forEach(admin => {
        _notify(admin, 'Thesis waiting — no undergraduate advisor assigned',
          warnHeading + '\n\nStudent: ' + _studentLabel(student) + '\nTitle: ' + rec.Title +
          _actionTextFallback(thesisId, 'Complete this thesis'),
          _summaryHtml(rec, { heading: warnHeading }) +
          _actionButtonHtml(thesisId, 'Complete this thesis'));
      });
    }

    // ONE shared task assigned to the advisor ROLE pool (assignedRole, not
    // assignedTo — Tasks matches roles against the AssignedRole field).
    // Every holder sees it on their dashboard, including people granted the
    // role after this thesis routed, so the dashboard always reflects the
    // graduation queue. Resolution by any holder clears it for all.
    Tasks.create({
      module: 'thesis', sourceType: 'thesis_final', sourceId: thesisId,
      label: label, assignedRole: ADVISOR_ROLE, staleAfterDays: 14,
    });

    // Notification emails still go to each current holder individually.
    advisors.forEach(adv => {
      _notify(adv.email, subject, textBody, htmlBody);
    });
  }


  // ── Drive helpers ──────────────────────────────────────────
  //
  // Access model: faculty and staff reach thesis PDFs through DIRECTORY-
  // level sharing on the configured Drive folder (managed in Drive, not by
  // this module — if a sponsor/reader/advisor ever cannot open a PDF, the
  // fix is folder sharing, not code). Students are deliberately NOT given
  // folder access (they would see everyone's theses), so each student is
  // granted explicit viewer access to THEIR OWN file on submission.

  /**
   * Best-effort: grant a student view access to their own thesis PDF.
   * Never throws — a sharing hiccup (non-Google address, domain sharing
   * policy) must not fail the submission; the access grant is secondary
   * to the record being saved. Idempotent: re-adding an existing viewer
   * is a no-op.
   */
  function _grantStudentView(fileId, studentEmail) {
    const id = String(fileId || '').trim();
    const email = String(studentEmail || '').trim();
    if (!id || !email) return;
    try {
      DriveApp.getFileById(id).addViewer(email);
    } catch (err) {
      Logger.log('ThesisModule._grantStudentView: could not grant ' + email +
                 ' on ' + id + ' (' + err + ')');
    }
  }

  /**
   * Sets (or revokes) "anyone with the link can view" on a thesis PDF.
   * Used to publish a completed, accepted, consented thesis. Best-effort
   * and never throws — a domain sharing policy may forbid link sharing,
   * which must not fail the completion that triggered it. Idempotent.
   * @param {string} fileId
   * @param {boolean} publicView - true to publish, false to revoke
   */
  function _setPdfLinkSharing(fileId, publicView) {
    const id = String(fileId || '').trim();
    if (!id) return;
    try {
      const f = DriveApp.getFileById(id);
      if (publicView) {
        f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } else {
        f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      }
    } catch (err) {
      Logger.log('ThesisModule._setPdfLinkSharing(' + publicView + '): could not update ' +
                 id + ' (' + err + ')');
    }
  }

  /** Uploads a new PDF to the configured folder. Returns { fileId, url }. */
  function _uploadPdf(file, fileName) {
    const blob = _toPdfBlob(file, fileName);
    const folder = _thesisFolder();
    const created = folder.createFile(blob);
    return { fileId: created.getId(), url: created.getUrl() };
  }

  /**
   * Replaces the contents of an existing Drive file IN PLACE, keeping the
   * same file ID (so the stored DriveFileID stays valid across resubmissions).
   *
   * Apps Script's DriveApp cannot overwrite binary content on a File object,
   * so this uses the Advanced Drive Service (Drive.Files.update), which must
   * be enabled in the project (Services → Drive API). If that service is not
   * available, or the stored file is gone, it degrades to a fresh upload and
   * returns a NEW file id — callers should persist whatever id is returned.
   *
   * @returns {{ fileId: string, url: string }}
   */
  function _replacePdf(fileId, file, fileName) {
    const id = String(fileId || '').trim();
    const blob = _toPdfBlob(file, fileName);

    // Preferred path: overwrite bytes in place via Advanced Drive Service.
    if (id && _hasAdvancedDrive()) {
      try {
        Drive.Files.update({ title: fileName, mimeType: 'application/pdf' }, id, blob);
        const f = DriveApp.getFileById(id);
        f.setName(fileName);
        return { fileId: id, url: f.getUrl() };
      } catch (err) {
        Logger.log('ThesisModule._replacePdf: in-place update failed (' + err + '); uploading fresh.');
      }
    }

    // Fallback: stored file unavailable or Advanced Drive not enabled.
    return _uploadPdf(file, fileName);
  }

  /** True if the Advanced Drive Service (Drive.Files) is enabled. */
  function _hasAdvancedDrive() {
    return (typeof Drive !== 'undefined') && Drive && Drive.Files && typeof Drive.Files.update === 'function';
  }

  function _toPdfBlob(file, fileName) {
    file = file || {};
    const b64 = String(file.dataBase64 || '').trim();
    if (!b64) throw new Error('Attach the thesis PDF.');
    const mime = String(file.mimeType || 'application/pdf');
    if (mime.indexOf('pdf') === -1) throw new Error('The thesis must be a PDF file.');
    const bytes = Utilities.base64Decode(b64);
    return Utilities.newBlob(bytes, 'application/pdf', fileName);
  }

  function _thesisFolder() {
    const id = String(CONFIG.THESIS.DRIVE_FOLDER_ID || '').trim();
    if (!id) throw new Error('Thesis Drive folder is not configured (CONFIG.THESIS.DRIVE_FOLDER_ID).');
    return DriveApp.getFolderById(id);
  }

  /** Filename convention: YYYY-Quarter_<StudentID>-THES_Last-First.pdf */
  function _buildFileName(quarter, year, profile) {
    const last  = _slug(profile.lastName)  || 'Last';
    const first = _slug(profile.firstName) || 'First';
    return year + '-' + quarter + '_' + profile.studentId + '-THES_' + last + '-' + first + '.pdf';
  }


  // ── Comment-PDF helpers (optional sponsor/reader decision attachments) ──
  //
  // Comment PDFs live in COMMENT_FOLDER_ID (separate from thesis PDFs). Every
  // workflow participant is granted viewer access when a file is attached.
  // Storage mirrors the thesis-PDF model: replace-in-place via the Advanced
  // Drive Service when a prior comment file exists, else a fresh upload.

  /** True when the payload carries an attached file (base64 present). */
  function _hasFile(file) {
    return !!(file && String(file.dataBase64 || '').trim());
  }

  /** Comment filename: <thesis filename minus .pdf>_<ROLE>-COMMENTS.pdf
   *  e.g. 2026-Spring_1234567-THES_Doe-Jane_SPONSOR-COMMENTS.pdf */
  function _commentFileName(rec, studentProfile, roleToken) {
    const base = _buildFileName(rec.Quarter, rec.Year, {
      lastName:  studentProfile.lastName  || '',
      firstName: studentProfile.firstName || '',
      studentId: studentProfile.studentId || (rec.StudentEmail || 'NOID'),
    }).replace(/\.pdf$/i, '');
    return base + '_' + roleToken + '-COMMENTS.pdf';
  }

  /** Builds a PDF blob for a comment attachment. Distinct from _toPdfBlob so
   *  the error wording is comment-specific (and never claims the thesis PDF
   *  is missing). Callers guard with _hasFile, so the empty case is defensive. */
  function _toCommentBlob(file, fileName) {
    file = file || {};
    const b64 = String(file.dataBase64 || '').trim();
    if (!b64) throw new Error('Attach the comment PDF.');
    const mime = String(file.mimeType || 'application/pdf');
    if (mime.indexOf('pdf') === -1) throw new Error('The comment attachment must be a PDF file.');
    const bytes = Utilities.base64Decode(b64);
    return Utilities.newBlob(bytes, 'application/pdf', fileName);
  }

  function _commentFolder() {
    const id = String(COMMENT_FOLDER_ID || '').trim();
    if (!id) throw new Error('Thesis comment Drive folder is not configured.');
    return DriveApp.getFolderById(id);
  }

  /**
   * Saves a comment PDF to the comments folder, replacing an existing file in
   * place when one is given (same id preserved). Falls back to a fresh upload
   * when no prior id exists, the stored file is gone, or Advanced Drive is not
   * enabled. Returns { fileId, url }.
   */
  function _saveCommentPdf(existingId, file, fileName) {
    const id = String(existingId || '').trim();
    const blob = _toCommentBlob(file, fileName);

    if (id && _hasAdvancedDrive()) {
      try {
        Drive.Files.update({ title: fileName, mimeType: 'application/pdf' }, id, blob);
        const f = DriveApp.getFileById(id);
        f.setName(fileName);
        return { fileId: id, url: f.getUrl() };
      } catch (err) {
        Logger.log('ThesisModule._saveCommentPdf: in-place update failed (' + err + '); uploading fresh.');
      }
    }
    const created = _commentFolder().createFile(blob);
    return { fileId: created.getId(), url: created.getUrl() };
  }

  /**
   * Grants viewer access on a comment file to each address in `emails`
   * (deduped, blanks dropped). Best-effort per address — a sharing hiccup on
   * one recipient must not fail the decision or block the others. Idempotent.
   */
  function _grantCommentViewers(fileId, emails) {
    const id = String(fileId || '').trim();
    if (!id) return;
    let f;
    try { f = DriveApp.getFileById(id); }
    catch (err) { Logger.log('ThesisModule._grantCommentViewers: file ' + id + ' missing (' + err + ')'); return; }
    const seen = {};
    (emails || []).forEach(e => {
      const email = String(e || '').trim();
      if (!email) return;
      const key = email.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      try { f.addViewer(email); }
      catch (err) { Logger.log('ThesisModule._grantCommentViewers: could not share ' + id + ' with ' + email + ' (' + err + ')'); }
    });
  }

  /** Best-effort trash of a comment PDF (used when its decision is cleared or
   *  the thesis is deleted). A missing file is not an error. */
  function _trashCommentPdf(fileId) {
    const id = String(fileId || '').trim();
    if (!id) return;
    try { DriveApp.getFileById(id).setTrashed(true); }
    catch (err) { Logger.log('ThesisModule._trashCommentPdf: could not trash ' + id + ' (' + err + ')'); }
  }


  // ── Read / shape / validate helpers ────────────────────────

  function _byId(thesisId) {
    if (!thesisId) return null;
    const found = DataService.query(CONFIG.SHEETS.THESIS, TAB, 'ThesisID', thesisId);
    return found && found.length ? found[0] : null;
  }

  function _requireStage(thesisId, stage) {
    const rec = _byId(String(thesisId || '').trim());
    if (!rec) throw new Error('Thesis not found.');
    if (rec.Stage !== stage) {
      throw new Error('This thesis is no longer at the expected stage (' + rec.Stage + ').');
    }
    return rec;
  }

  /** Display shape: attaches computed student/faculty names without
   *  storing them. Heavy fields (DriveFileID) pass through for the UI. */
  function _publicRecord(r) {
    const student = Auth.getProfile(r.StudentEmail);
    return {
      thesisId:     r.ThesisID,
      studentEmail: r.StudentEmail,
      studentName:  student ? student.nameLastFirst : r.StudentEmail,
      studentId:    student ? student.studentId : '',
      quarter:      r.Quarter,
      year:         r.Year,
      term:         (r.Year || '') + ' ' + (r.Quarter || ''),
      title:        r.Title,
      abstract:     r.Abstract,
      regions:      _regionsForDisplay(r.Regions),
      shareConsent: String(r.ShareConsent).toUpperCase() === 'TRUE',
      sponsorEmail: r.SponsorEmail,
      sponsorName:  _facultyLabel(r.SponsorEmail),
      documentLink: r.DocumentLink,
      fileName:     r.FileName,
      stage:        r.Stage,
      sponsorDecision: r.SponsorDecision,
      sponsorComments: r.SponsorComments,
      sponsorCommentLink: r.SponsorCommentLink || '',
      sponsorDecidedAt: r.SponsorDecidedAt ? Utils.formatDate(r.SponsorDecidedAt) : '',
      readerEmail:  r.ReaderEmail,
      readerName:   r.ReaderEmail ? _facultyLabel(r.ReaderEmail) : '',
      honorsDecision: r.HonorsDecision,
      readerComments: r.ReaderComments,
      readerCommentLink: r.ReaderCommentLink || '',
      readerDecidedAt: r.ReaderDecidedAt ? Utils.formatDate(r.ReaderDecidedAt) : '',
      advisorProcessedAt: r.AdvisorProcessedAt ? Utils.formatDate(r.AdvisorProcessedAt) : '',
      returnNote:   r.ReturnNote,
      createdAt:    r.CreatedAt ? Utils.formatDate(r.CreatedAt) : '',
      _created:     r.CreatedAt ? new Date(r.CreatedAt).getTime() : 0,
    };
  }


  /**
   * The STUDENT's view of their own record: a coarse, honest status
   * vocabulary instead of the internal workflow stage.
   *   UNDER_REVIEW — submitted, in honors review, or a No Pass awaiting
   *                  close-out (the sponsor addresses a No Pass outside
   *                  the portal; the recorded outcome appears at COMPLETE)
   *   RETURNED     — the student must revise and resubmit
   *   ACCEPTED     — passed (or honors-approved), in final processing
   *   COMPLETE     — done; the recorded outcome shows
   * Decision details (sponsor decision/comments, reader identity and
   * comments) are hidden until ACCEPTED/COMPLETE, and internal
   * return-to-sponsor notes are hidden except on an actual RETURNED
   * thesis. With no "honors denied" value in the system, nothing here
   * rewrites data — this is purely a presentation vocabulary.
   * Faculty/advisor/super_admin viewers never receive this view.
   */
  function _studentView(r) {
    const pub = _publicRecord(r);
    const settled = r.Stage === STAGE.COMPLETE ||
      (r.Stage === STAGE.PENDING_ADVISOR && _isApproved(r));

    if (r.Stage === STAGE.RETURNED)       pub.stage = STAGE.RETURNED;
    else if (r.Stage === STAGE.COMPLETE)  pub.stage = STAGE.COMPLETE;
    else if (settled)                     pub.stage = 'ACCEPTED';
    else                                  pub.stage = 'UNDER_REVIEW';

    if (!settled) {
      pub.sponsorDecision = ''; pub.sponsorComments = ''; pub.sponsorDecidedAt = '';
      pub.sponsorCommentLink = '';
      pub.readerEmail = ''; pub.readerName = '';
      pub.honorsDecision = ''; pub.readerComments = ''; pub.readerDecidedAt = '';
      pub.readerCommentLink = '';
    }
    if (r.Stage !== STAGE.RETURNED) pub.returnNote = '';
    return pub;
  }

  function _byCreatedDesc(a, b) { return (b._created || 0) - (a._created || 0); }

  /** Attaches advisor-internal fields to a public record. Only called for
   *  advisor / super_admin viewers — milestone bookkeeping is not shown
   *  to students or sponsors. */
  function _withAdvisorFields(pub, rec) {
    pub.milestoneEntered = String(rec.MilestoneEntered || '').toUpperCase() === 'TRUE';
    return pub;
  }

  function _outcomeSummary(rec) {
    let s = rec.SponsorDecision || '(no sponsor decision)';
    if (rec.HonorsDecision) s += ' → ' + rec.HonorsDecision;
    return s;
  }

  /** A thesis counts as approved unless the sponsor recorded No Pass.
   *  An honors DENIAL still means the thesis itself passed — denial only
   *  withholds the honors designation. */
  function _isApproved(rec) {
    return !!rec.SponsorDecision && rec.SponsorDecision !== SPONSOR.NO_PASS;
  }

  /** All active users holding the advisor role, as profiles. May be empty. */
  function _advisors() {
    return Auth.listUsers().filter(u =>
      u.active && (u.roles || []).some(r => _norm(r) === ADVISOR_ROLE));
  }

  /** True if `email` is an active holder of the advisor role. */
  function _isUndergradAdvisor(email) {
    const key = _norm(email);
    if (!key) return false;
    return _advisors().some(u => _norm(u.email) === key);
  }

  /** True if `email` belongs to an active user holding `role`. The
   *  role-based replacement for the old ThesisEligibility.isEligible
   *  check. Strict: a super_admin must actually hold the role to qualify
   *  (consistent with eligibility being a plain identity role now). */
  function _holdsRole(email, role) {
    const p = Auth.getProfile(email);
    return !!(p && p.active && (p.roles || []).some(r => _norm(r) === role));
  }

  function _studentLabel(profile) {
    return profile ? (profile.nameLastFirst || profile.name || profile.email) : '(unknown student)';
  }

  function _facultyLabel(email) {
    const p = Auth.getProfile(email);
    return p ? (p.nameLastFirst || p.name || email) : email;
  }

  // ── Email composition ──────────────────────────────────────

  /** The web app URL deep-linked to this thesis (opens the module focused
   *  on the record, after the normal portal login). */
  function _deepLink(thesisId) {
    return Links.deepLink('thesis', thesisId);
  }

  /** A formatted HTML summary of the submission for embedding in emails.
   *  `opts.heading` is the lead line; decisions render only once recorded.
   *  `opts.studentView` applies the student mask (use for every email
   *  addressed to the student). */
  function _summaryHtml(rec, opts) {
    opts = opts || {};
    const pub = opts.studentView ? _studentView(rec) : _publicRecord(rec);
    const rows = [];
    const row = (k, v) => { if (v) rows.push(
      '<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;white-space:nowrap;">' + k +
      '</td><td style="padding:4px 0;">' + v + '</td></tr>'); };

    row('Student', _esc(pub.studentName));
    row('Term', _esc(pub.term));
    row('Title', _esc(pub.title));
    row('Abstract', _esc(pub.abstract));
    if (pub.regions && pub.regions.length) {
      row('Regions', _esc(pub.regions.map(r =>
        (r.locality ? r.locality + ', ' : '') + r.country).join('; ')));
    }
    row('Sponsor', _esc(pub.sponsorName));
    if (pub.readerName)      row('Honors reader', _esc(pub.readerName));
    if (pub.sponsorDecision) row('Sponsor decision', _esc(pub.sponsorDecision));
    if (pub.honorsDecision)  row('Honors decision', _esc(pub.honorsDecision));
    if (pub.documentLink) {
      row('Document', '<a href="' + _esc(pub.documentLink) + '">Open thesis PDF</a>');
    }

    const heading = opts.heading
      ? '<p style="margin:0 0 12px;">' + _esc(opts.heading) + '</p>' : '';
    return heading +
      '<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px;">' +
      rows.join('') + '</table>';
  }

  /** A button that opens the portal on this thesis (authenticated). */
  function _actionButtonHtml(thesisId, label) {
    const url = _deepLink(thesisId);
    if (!url) return '';
    return '<p style="margin:16px 0;">' +
      '<a href="' + _esc(url) + '" ' +
      'style="display:inline-block;background:#13294b;color:#fff;text-decoration:none;' +
      'padding:10px 18px;border-radius:6px;font-size:14px;">' + _esc(label) + '</a></p>' +
      '<p style="margin:0;color:#888;font-size:12px;">You will be asked to sign in if you are not already. ' +
      'The thesis opens ready for your review.</p>';
  }

  /** Plain-text fallback mirroring the action button (for non-HTML clients). */
  function _actionTextFallback(thesisId, label) {
    const url = _deepLink(thesisId);
    return url ? ('\n\n' + label + ':\n' + url) : '\n\n(Open the Senior Thesis module in the portal to act.)';
  }

  /**
   * Sends a handoff email. `html` is the rich body (summary + button);
   * `text` is the plain-text fallback. Gated by the NOTIFY_ON_HANDOFF
   * setting unless `force` is true (manual reminders always send).
   * Falls back to wrapping text if no html is supplied.
   */
  function _notify(to, subject, text, html, force) {
    if (!force && !ThesisSettings.get().notifyOnHandoff) return;
    const recipients = Notify.resolveRecipients({ explicit: [to] });
    Notify.send({
      to: recipients, subject: subject, body: text,
      htmlBody: html || Notify.htmlWrap(text),
      replyTo: Settings.replyTo('thesis'),   // module reply-to (Admin → settings); falls back to CONFIG.DEFAULT_REPLY_TO
    });
  }

  function _norm(s) { return String(s || '').trim().toLowerCase(); }

  /** HTML-escape for safe embedding of record content in emails. */
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _slug(s) {
    return String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '');
  }

  function _requireOneOf(value, allowed, label) {
    const v = String(value || '').trim();
    if (allowed.indexOf(v) === -1) throw new Error(label + ' must be one of: ' + allowed.join(', ') + '.');
    return v;
  }

  function _validYear(year) {
    const y = String(year || '').trim();
    if (!/^\d{4}$/.test(y)) throw new Error('Year must be a 4-digit year.');
    return y;
  }

  /**
   * Validates and normalizes the regions payload into a clean array of
   * { country, locality }. Country must be a valid entry in the controlled
   * Countries list; locality is optional free text. Duplicates (same
   * country + locality, case-insensitive) are collapsed. Accepts either an
   * array of objects or a JSON string.
   */
  function _parseRegions(input) {
    let arr = input;
    if (typeof input === 'string') {
      try { arr = JSON.parse(input); } catch (e) { arr = []; }
    }
    if (!Array.isArray(arr)) return [];

    const out = [];
    const seen = {};
    arr.forEach(item => {
      if (!item) return;
      const country  = String(item.country || '').trim();
      const locality = String(item.locality || '').trim();
      if (!country) return;
      if (!Countries.isValid(country)) {
        throw new Error('Unknown country: "' + country + '". Pick one from the list.');
      }
      const key = (country + '||' + locality).toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ country: country, locality: locality });
    });
    return out;
  }

  /** Read path: parse stored Regions JSON and attach derived continent. */
  function _regionsForDisplay(raw) {
    let arr = [];
    if (raw) { try { arr = JSON.parse(raw); } catch (e) { arr = []; } }
    if (!Array.isArray(arr)) arr = [];
    return arr.map(r => ({
      country:   r.country || '',
      locality:  r.locality || '',
      continent: Countries.continentOf(r.country || ''),
    }));
  }


  // ============================================================
  // ANTH 195S ENROLLMENT (petition) — front half of the lifecycle
  // ============================================================
  // The petition to obtain a class number and enroll in ANTH 195S at the
  // start of the term, mirroring IndividualStudiesModule (which
  // deliberately excludes 195S and redirects here). Same two-hop shape:
  //
  //   SUBMITTED ─ sponsor ─┬─ Approve ─► PENDING_ADVISOR
  //                        └─ Return ──► RETURNED
  //   PENDING_ADVISOR ─ advisor ─┬─ Complete ─► COMPLETE (PDF generated)
  //                              └─ Return ───► SUBMITTED (to sponsor;
  //                                             decision + verification cleared)
  //   RETURNED ─ student resubmits ─► SUBMITTED (same record)
  //
  // Differences from Individual Studies, by design:
  //   - Course is FIXED (ANTH 195S), so the four-part duplicate key
  //     collapses to (student, term). Sponsor eligibility is the existing
  //     thesis_sponsor role — the person sponsoring the enrollment is the
  //     person who will sponsor the thesis.
  //   - Two REQUIRED attestations, enforced server-side and printed in
  //     the PDF's signature blocks: the student's 195S-vs-198 confirmation
  //     at submit, and the sponsor's completion verification at approve.
  //   - The >7-credit special-study total counts BOTH these enrollments
  //     and the Individual Studies petitions for the term (and IS counts
  //     these back — see IndividualStudiesModule._advisorContext).
  //   - The canonical PDF is generated at COMPLETE via ReportService and
  //     then FILED into CONFIG.THESIS.ENROLLMENT_DRIVE_FOLDER_ID. A Drive
  //     move keeps the file id, so the Reports archive index stays valid.
  //   - Notifications ride the module's _notify, so the Settings tab's
  //     handoff toggle governs enrollment mail too (default on).
  //   - Enrollment IDs use the 'ENR' prefix, so 'thesis'-module task
  //     resolution by sourceId never collides with thesis records, and
  //     the UI can route a deep link by prefix.

  const ENROLL_TAB = function () {
    return (CONFIG.TABS && CONFIG.TABS.THESIS_ENROLLMENT) || 'ThesisEnrollment';
  };
  const ENROLL_COURSE = 'ANTH 195S';
  const ENROLL_SOURCE_TYPE = 'thesis_enrollment';
  const ENROLL_SPONSOR_ROLE = 'thesis_sponsor';
  const ENROLL_GRADE_OPTIONS = ['Letter', 'Pass/No Pass'];

  // The campus rule: more than 7 special-study credits in a term needs
  // department (advisor) authorization. Shared with Individual Studies.
  const SPECIAL_STUDY_CREDIT_CAP = 7;

  // The two attestations, verbatim as they appear in the UI and on the
  // generated PDF. Server-enforced: enrollSubmit / enrollSponsorApprove
  // refuse without them.
  const ENROLL_STUDENT_CONFIRM_TEXT =
    'I confirm that I will finish and submit my final thesis this term, ' +
    'and I am ready to enroll in ANTH 195S.';
  const ENROLL_SPONSOR_VERIFY_TEXT =
    'By approving this petition, I verify that this student is prepared to ' +
    'complete and submit their final thesis by the end of this enrollment period.';

  // Senate Regulation 760: 1 credit = 30 hours of work over the term.
  // Weekly load = (30 x credits) / weeks; quarters run 10 weeks, summer 5.
  // The total is fixed by policy — students and sponsors only set the
  // split (with-sponsor vs. independent); independent is the remainder.
  const SR760_HOURS_PER_CREDIT = 30;
  function _termWeeks(termCode) {
    try { return ClassSchedule.decodeTermCode(termCode).quarter === 'Summer' ? 5 : 10; }
    catch (e) { return 10; }
  }
  function _weeklyHoursTotal(credits, termCode) {
    const c = Number(credits);
    if (!isFinite(c) || c <= 0) return 0;
    return Math.round((SR760_HOURS_PER_CREDIT * c) / _termWeeks(termCode));
  }
  function _resolveHoursSplit(withSponsorRaw, credits, termCode) {
    const total = _weeklyHoursTotal(credits, termCode);
    const ws = Number(String(withSponsorRaw == null ? '' : withSponsorRaw).trim() || 0);
    if (!isFinite(ws) || ws < 0) throw new Error('Enter a valid number of hours with the sponsor.');
    if (ws > total) {
      throw new Error('Hours with the sponsor (' + ws + ') cannot exceed the ' + total +
        ' hours/week total required for ' + credits + ' credits (Senate Regulation 760).');
    }
    return { withSponsor: ws, independent: total - ws, total: total };
  }


  // ── Student actions ────────────────────────────────────────

  /**
   * Bootstrap data for the enrollment form. Term-first and schedule-
   * driven, like Individual Studies: the only terms offered are those
   * whose imported schedule contains an ANTH 195S section with a credit
   * value. Also returns eligible sponsors (thesis_sponsor holders), grade
   * options, the student's identity prefill, and the confirmation text.
   */
  function enrollFormData(payload, user) {
    const profile = Auth.getProfile(user) || {};
    let terms = [];
    try {
      terms = ClassSchedule.availableTerms().map(t => {
        const match = ClassSchedule.coursesForTerm(t.term, { allowlist: [ENROLL_COURSE] })
          .filter(c => c.credits !== null && c.credits !== undefined)
          .find(c => String(c.course).trim().toUpperCase() === ENROLL_COURSE.toUpperCase());
        if (!match) return null;
        return {
          term: t.term, label: t.label, quarter: t.quarter, year: t.year,
          weeks: _termWeeks(t.term), isSummer: _termWeeks(t.term) === 5,
          hoursPerCredit: SR760_HOURS_PER_CREDIT,
          credits: match.credits, courseTitle: match.title || '',
        };
      }).filter(function (t) { return !!t; });
    } catch (e) {
      Logger.log('ThesisModule.enrollFormData: schedule lookup failed: ' + e);
      terms = [];
    }
    return {
      terms: terms,
      course: ENROLL_COURSE,
      gradeOptions: ENROLL_GRADE_OPTIONS.slice(),
      sponsors: Auth.usersWithRole(ENROLL_SPONSOR_ROLE),
      confirmText: ENROLL_STUDENT_CONFIRM_TEXT,
      profile: {
        name: profile.name || '',
        email: profile.email || user,
        studentId: profile.studentId || '',
        hasStudentId: !!(profile.studentId),
      },
    };
  }

  /** The caller's own enrollment petitions, newest first. */
  function enrollMine(payload, user, roles) {
    return DataService.query(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'StudentEmail', user)
      .map(_enrPublicRecord)
      .sort(_byCreatedDesc);
  }

  /**
   * One enrollment petition for the detail modal. Visible to the student
   * who owns it, the sponsor on it, any advisor, or super_admin. Advisor
   * and super_admin viewers get the decision-support context attached
   * (credit total across modules, class-number options).
   */
  function enrollGet(payload, user, roles) {
    const rec = _enrById((payload || {}).enrollmentId);
    if (!rec) throw new Error('Enrollment petition not found.');
    const isSuper = (roles || []).indexOf('super_admin') !== -1;
    const isAdvisor = (roles || []).indexOf(ADVISOR_ROLE) !== -1;
    const me = _norm(user);
    const allowed = isSuper || isAdvisor ||
      _norm(rec.StudentEmail) === me || _norm(rec.SponsorEmail) === me;
    if (!allowed) throw new Error('You do not have access to this enrollment petition.');
    const pub = _enrPublicRecord(rec);
    if (isAdvisor || isSuper) pub.advisorContext = _enrAdvisorContext(rec);
    return pub;
  }

  /**
   * Submit a NEW ANTH 195S enrollment petition, or resubmit one currently
   * RETURNED. The student's confirmation checkbox is REQUIRED on both
   * paths — the STOP warning is the point of this form.
   *
   * @param {Object} payload
   *   @param {string}  payload.termCode
   *   @param {string}  payload.sponsorEmail
   *   @param {boolean} payload.studentConfirmed  - REQUIRED true
   *   @param {string}  payload.studySiteAddress
   *   @param {string}  payload.title
   *   @param {string}  payload.courseDescription - required
   *   @param {string}  payload.evidenceOfPreparation
   *   @param {string}  payload.workToBeSubmitted - required
   *   @param {string}  payload.gradeOption       - Letter | Pass/No Pass
   *   @param {string}  payload.hoursWithSponsor
   *   @param {string}  payload.college / majorStatus / classLevel
   *   @param {string}  [payload.syllabusBase64/Name/MimeType] - optional
   *   @param {string}  [payload.enrollmentId]    - present on resubmission
   */
  function enrollSubmit(payload, user, roles) {
    payload = payload || {};

    // The attestation gate. A client checkbox is convenience; this is the
    // source of truth.
    if (payload.studentConfirmed !== true && payload.studentConfirmed !== 'true') {
      throw new Error('You must confirm that you will finish and submit your final thesis this term ' +
        'before requesting a class number for ANTH 195S. If you are still conducting research, ' +
        'enroll in ANTH 198 through the Individual Studies module instead.');
    }

    const termCode = String(payload.termCode || payload.term || '').trim();
    if (!termCode) throw new Error('Select a term.');
    const sponsorEmail = String(payload.sponsorEmail || '').trim();
    const courseDescription = String(payload.courseDescription || '').trim();
    const workToBeSubmitted = String(payload.workToBeSubmitted || '').trim();

    if (!sponsorEmail) throw new Error('Select a faculty sponsor.');
    if (!courseDescription) throw new Error('A description of the proposed thesis work is required.');
    if (!workToBeSubmitted) throw new Error('A description of the work to be submitted is required.');
    if (!_holdsRole(sponsorEmail, ENROLL_SPONSOR_ROLE)) {
      throw new Error('That person is not currently eligible to sponsor senior theses.');
    }
    const gradeOption = _requireOneOf(payload.gradeOption, ENROLL_GRADE_OPTIONS, 'Grade option');

    // The term must have an imported schedule containing ANTH 195S; its
    // credit value comes from the schedule — not typed, not coded.
    const match = _enrCourseForTerm(termCode);
    if (!match) {
      throw new Error('ANTH 195S is not available for the selected term. The schedule may not be imported yet.');
    }
    const credits = match.credits;
    const decoded = ClassSchedule.decodeTermCode(termCode);
    const hoursSplit = _resolveHoursSplit(payload.hoursWithSponsor, credits, termCode);

    const profile = Auth.getProfile(user);
    if (!profile) throw new Error('Your profile could not be found.');
    if (!profile.studentId) {
      throw new Error('Your profile has no Student ID on file. Contact the department to add one before submitting.');
    }

    const now = new Date().toISOString();
    const fields = {
      TermCode: termCode,
      Quarter: decoded.quarter, Year: decoded.year,
      Course: ENROLL_COURSE,
      Credits: String(credits),
      SponsorEmail: sponsorEmail,
      StudySiteAddress: String(payload.studySiteAddress || '').trim(),
      Title: String(payload.title || '').trim(),
      CourseDescription: courseDescription,
      EvidenceOfPreparation: String(payload.evidenceOfPreparation || '').trim(),
      WorkToBeSubmitted: workToBeSubmitted,
      GradeOption: gradeOption,
      ReportRequired: _boolStr(payload.reportRequired),
      ReportDueDate: String(payload.reportDueDate || '').trim(),
      HoursWithSponsor: String(hoursSplit.withSponsor),
      HoursIndependent: String(hoursSplit.independent),
      College: String(payload.college || '').trim(),
      MajorStatus: String(payload.majorStatus || '').trim(),
      ClassLevel: String(payload.classLevel || '').trim(),
      StudentConfirmed: 'TRUE',
      StudentConfirmedAt: now,
    };

    const existingId = String(payload.enrollmentId || '').trim();

    // ── Resubmission: must be the caller's own RETURNED record ──
    if (existingId) {
      const rec = _enrById(existingId);
      if (!rec) throw new Error('Enrollment petition not found: ' + existingId);
      if (_norm(rec.StudentEmail) !== _norm(user)) {
        throw new Error('You can only resubmit your own enrollment petition.');
      }
      if (rec.Stage !== STAGE.RETURNED) {
        throw new Error('This enrollment petition is not awaiting resubmission.');
      }

      DataService.update(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'EnrollmentID', existingId,
        Object.assign({}, fields, { Stage: STAGE.SUBMITTED, ReturnNote: '' }));

      _enrMaybeSaveSyllabus(existingId, payload);

      Tasks.resolveForSource('thesis', existingId, { resolvedBy: user });
      _enrRouteToSponsor(existingId, sponsorEmail, profile, /*resubmitted*/ true);
      EventBus.emit('thesis.enrollment_resubmitted',
        { enrollmentId: existingId, sponsorEmail: sponsorEmail }, { user: user });
      return { enrollmentId: existingId, stage: STAGE.SUBMITTED, resubmitted: true };
    }

    // ── New petition: ONE enrollment per (student, term). The course is
    // fixed, so IS's four-part key collapses to two. A RETURNED record is
    // not a duplicate (resubmit it instead); COMPLETE records in OTHER
    // terms are fine (a retake enrolls again next term).
    const dup = DataService.query(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'StudentEmail', user)
      .find(r => _enrRecTerm(r) === termCode && r.Stage !== STAGE.RETURNED);
    if (dup) {
      const label = decoded.label || (decoded.quarter + ' ' + decoded.year);
      throw new Error('You already have an ANTH 195S enrollment petition for ' + label +
        (dup.Stage === STAGE.COMPLETE ? ' (completed).' : ' (in progress).') +
        ' Contact the undergraduate advisor if you believe this is an error.');
    }

    const enrollmentId = DataService.generateId('ENR');
    DataService.insert(CONFIG.SHEETS.THESIS, ENROLL_TAB(), Object.assign({
      EnrollmentID: enrollmentId,
      StudentEmail: user,
      Stage: STAGE.SUBMITTED,
      SponsorVerified: '', SponsorComments: '', SponsorDecidedBy: '', SponsorDecidedAt: '',
      ClassNumber: '', ClassSection: '', ClassNumberSource: '',
      TotalSpecialStudyCredits: '', MajorAuthRequired: '', MajorAuthorized: '',
      AdvisorComments: '', AdvisorProcessedBy: '', AdvisorProcessedAt: '',
      SyllabusFileID: '', SyllabusLink: '', SyllabusName: '',
      DriveFileID: '', DocumentLink: '', FileName: '',
      ReturnNote: '',
    }, fields));

    _enrMaybeSaveSyllabus(enrollmentId, payload);

    _enrRouteToSponsor(enrollmentId, sponsorEmail, profile, /*resubmitted*/ false);
    EventBus.emit('thesis.enrollment_submitted',
      { enrollmentId: enrollmentId, sponsorEmail: sponsorEmail }, { user: user });
    return { enrollmentId: enrollmentId, stage: STAGE.SUBMITTED };
  }

  /** Student withdraws their own non-terminal enrollment petition
   *  (removes the row, mirroring Individual Studies withdraw). */
  function enrollWithdraw(payload, user, roles) {
    const rec = _enrById((payload || {}).enrollmentId);
    if (!rec) throw new Error('Enrollment petition not found.');
    const isSuper = (roles || []).indexOf('super_admin') !== -1;
    if (!isSuper && _norm(rec.StudentEmail) !== _norm(user)) {
      throw new Error('You can only withdraw your own enrollment petition.');
    }
    if (rec.Stage === STAGE.COMPLETE) {
      throw new Error('A completed enrollment cannot be withdrawn. Contact the undergraduate advisor.');
    }
    Tasks.resolveForSource('thesis', rec.EnrollmentID, { resolvedBy: user, note: 'Withdrawn' });
    DataService.remove(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'EnrollmentID', rec.EnrollmentID);
    EventBus.emit('thesis.enrollment_withdrawn', { enrollmentId: rec.EnrollmentID }, { user: user });
    return { withdrawn: true };
  }

  /**
   * Prefill for the thesis SUBMISSION form (the linkage between the two
   * halves): the student's most recent COMPLETE enrollment supplies
   * quarter/year and sponsor. Read-only; caller's own records only.
   */
  function enrollmentPrefill(payload, user) {
    const rows = DataService.query(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'StudentEmail', user)
      .filter(r => r.Stage === STAGE.COMPLETE)
      .sort(function (a, b) {
        return new Date(b.CreatedAt || 0).getTime() - new Date(a.CreatedAt || 0).getTime();
      });
    if (!rows.length) return { found: false };
    const r = rows[0];
    return {
      found: true,
      quarter: r.Quarter || '',
      year: String(r.Year || ''),
      sponsorEmail: r.SponsorEmail || '',
      sponsorName: _facultyLabel(r.SponsorEmail),
      term: (r.Quarter || '') + ' ' + (r.Year || ''),
    };
  }


  // ── Sponsor actions ────────────────────────────────────────

  /**
   * The sponsor's enrollment list: every petition naming them, at any
   * stage, newest first — SUBMITTED rows are the actionable ones.
   * super_admin sees all.
   */
  function enrollSponsorQueue(payload, user, roles) {
    const isSuper = (roles || []).indexOf('super_admin') !== -1;
    return DataService.getAll(CONFIG.SHEETS.THESIS, ENROLL_TAB())
      .filter(r => isSuper || _norm(r.SponsorEmail) === _norm(user))
      .map(_enrPublicRecord)
      .sort(_byCreatedDesc);
  }

  /**
   * Sponsor approves a SUBMITTED enrollment petition. The SPONSOR NOTICE
   * verification checkbox is REQUIRED — its statement is recorded and
   * printed in the instructor approval block of the PDF. The sponsor may
   * revise the two description fields, adjust the SR 760 hours split, and
   * set the written-report requirement (all mirroring Individual Studies).
   */
  function enrollSponsorApprove(payload, user, roles) {
    payload = payload || {};
    const rec = _enrById(payload.enrollmentId);
    if (!rec) throw new Error('Enrollment petition not found.');
    _enrAssertSponsor(rec, user, roles);
    if (rec.Stage !== STAGE.SUBMITTED) throw new Error('This petition is not awaiting a sponsor decision.');

    // The verification gate — see ENROLL_SPONSOR_VERIFY_TEXT.
    if (payload.sponsorVerified !== true && payload.sponsorVerified !== 'true') {
      throw new Error('Confirm the verification statement before approving: approve ANTH 195S only if ' +
        'the student will submit their completed final thesis by the end of this term. If they are ' +
        'still conducting research, return the petition and direct them to ANTH 198.');
    }

    const courseDescription = payload.courseDescription !== undefined
      ? String(payload.courseDescription || '').trim() : rec.CourseDescription;
    const workToBeSubmitted = payload.workToBeSubmitted !== undefined
      ? String(payload.workToBeSubmitted || '').trim() : rec.WorkToBeSubmitted;

    const hoursPatch = {};
    if (payload.hoursWithSponsor !== undefined) {
      const split = _resolveHoursSplit(payload.hoursWithSponsor, rec.Credits, _enrRecTerm(rec));
      hoursPatch.HoursWithSponsor = String(split.withSponsor);
      hoursPatch.HoursIndependent = String(split.independent);
    }

    const reportPatch = {};
    if (payload.reportRequired !== undefined) {
      const req = payload.reportRequired === true || payload.reportRequired === 'true';
      reportPatch.ReportRequired = req ? 'TRUE' : '';
      reportPatch.ReportDueDate = req ? String(payload.reportDueDate || '').trim() : '';
    }

    DataService.update(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'EnrollmentID', rec.EnrollmentID, Object.assign({
      SponsorVerified: 'TRUE',
      SponsorComments: String(payload.comments || '').trim(),
      CourseDescription: courseDescription,
      WorkToBeSubmitted: workToBeSubmitted,
      SponsorDecidedBy: user,
      SponsorDecidedAt: new Date().toISOString(),
      Stage: STAGE.PENDING_ADVISOR,
    }, hoursPatch, reportPatch));

    // Sponsor may attach/replace the syllabus as part of their review.
    _enrMaybeSaveSyllabus(rec.EnrollmentID, payload);

    Tasks.resolveForSource('thesis', rec.EnrollmentID, { resolvedBy: user });
    _enrRouteToAdvisor(rec.EnrollmentID, _enrById(rec.EnrollmentID));
    EventBus.emit('thesis.enrollment_sponsor_approved', { enrollmentId: rec.EnrollmentID }, { user: user });
    return { enrollmentId: rec.EnrollmentID, stage: STAGE.PENDING_ADVISOR };
  }

  /** Sponsor returns the enrollment petition to the student for revision. */
  function enrollSponsorReturn(payload, user, roles) {
    const rec = _enrById((payload || {}).enrollmentId);
    if (!rec) throw new Error('Enrollment petition not found.');
    _enrAssertSponsor(rec, user, roles);
    if (rec.Stage !== STAGE.SUBMITTED) throw new Error('This petition is not awaiting a sponsor decision.');

    const note = String((payload || {}).note || '').trim();
    if (!note) throw new Error('Add a note telling the student what to revise.');

    DataService.update(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'EnrollmentID', rec.EnrollmentID, {
      Stage: STAGE.RETURNED, ReturnNote: note,
    });

    Tasks.resolveForSource('thesis', rec.EnrollmentID, { resolvedBy: user });
    Tasks.create({
      module: 'thesis', sourceType: ENROLL_SOURCE_TYPE, sourceId: rec.EnrollmentID,
      label: 'Your ANTH 195S enrollment petition needs revisions',
      assignedTo: rec.StudentEmail, staleAfterDays: 14,
    });
    _notify(rec.StudentEmail, 'Your ANTH 195S enrollment petition was returned',
      'Your ANTH 195S enrollment petition was returned by ' + _facultyLabel(user) + ' for revision.\n\n' +
      'What to revise: ' + note + '\n\n' +
      'If you are still conducting research and will not finish the thesis this term, ' +
      'file for ANTH 198 in the Individual Studies module instead.' +
      _actionTextFallback(rec.EnrollmentID, 'Revise and resubmit'));
    EventBus.emit('thesis.enrollment_returned', { enrollmentId: rec.EnrollmentID }, { user: user });
    return { enrollmentId: rec.EnrollmentID, stage: STAGE.RETURNED };
  }


  // ── Advisor actions ────────────────────────────────────────

  /** Enrollment petitions awaiting a class number (PENDING_ADVISOR). */
  function enrollAdvisorQueue(payload, user, roles) {
    _enrAssertAdvisor(roles);
    return DataService.query(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'Stage', STAGE.PENDING_ADVISOR)
      .map(_enrPublicRecord)
      .sort(_byCreatedDesc);
  }

  /**
   * Advisor completes the enrollment: records the class number (confirmed
   * prefill, pool pick, or reassignment), the major-authorization decision
   * when over the cap, generates the canonical PDF, and marks COMPLETE.
   * @param {Object} payload - { enrollmentId, classNumber, classSection?,
   *   classNumberSource?, confirmReassign?, majorAuthorized?, comments? }
   */
  function enrollAdvisorComplete(payload, user, roles) {
    _enrAssertAdvisor(roles);
    payload = payload || {};
    const rec = _enrById(payload.enrollmentId);
    if (!rec) throw new Error('Enrollment petition not found.');
    if (rec.Stage !== STAGE.PENDING_ADVISOR) throw new Error('This petition is not awaiting advisor processing.');

    const classNumber = String(payload.classNumber || '').trim();
    if (!classNumber) throw new Error('A class number is required to complete the enrollment.');

    const source = String(payload.classNumberSource || '').trim();
    if (source === 'reassigned' && payload.confirmReassign !== true) {
      throw new Error('Reassigning a class number listed under another instructor requires confirmation.');
    }

    // Major-department authorization: the term total is computed ACROSS
    // this tab AND the Individual Studies petitions. Over the cap, the
    // advisor must authorize.
    const ctx = _enrAdvisorContext(rec);
    const overCap = ctx.creditTotal > SPECIAL_STUDY_CREDIT_CAP;
    if (overCap && payload.majorAuthorized !== true) {
      throw new Error('This student has ' + ctx.creditTotal + ' special-study credits this term (over ' +
        SPECIAL_STUDY_CREDIT_CAP + '). Department authorization is required to complete.');
    }

    const now = new Date().toISOString();
    DataService.update(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'EnrollmentID', rec.EnrollmentID, {
      ClassNumber: classNumber,
      ClassSection: String(payload.classSection || '').trim(),
      ClassNumberSource: source,
      TotalSpecialStudyCredits: String(ctx.creditTotal),
      MajorAuthRequired: _boolStr(overCap),
      MajorAuthorized: _boolStr(overCap ? true : false),
      AdvisorComments: String(payload.comments || '').trim(),
      AdvisorProcessedBy: user,
      AdvisorProcessedAt: now,
      Stage: STAGE.COMPLETE,
    });

    // Generate the canonical PDF. Best-effort — a generation failure must
    // not strand the record; it is COMPLETE regardless and regenerable.
    const finalRec = _enrById(rec.EnrollmentID);
    let pdf = null;
    try {
      pdf = _enrGeneratePdf(finalRec, user);
      if (pdf && pdf.fileId) {
        _enrFilePdf(pdf.fileId);   // move into the 195S folder (id survives)
        DataService.update(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'EnrollmentID', rec.EnrollmentID, {
          DriveFileID: pdf.fileId, DocumentLink: pdf.url || '', FileName: pdf.fileName || '',
        });
        _enrGrantViewerQuiet(pdf.fileId, finalRec.StudentEmail);
      }
    } catch (e) {
      Logger.log('ThesisModule.enrollAdvisorComplete: PDF generation failed for ' + rec.EnrollmentID + ': ' + e);
    }

    Tasks.resolveForSource('thesis', rec.EnrollmentID, { resolvedBy: user });

    const lines = [
      'Your ANTH 195S enrollment petition is complete.',
      '',
      'Class number: ' + classNumber,
      'Enroll in ANTH 195S in MyUCSC using the class number above.',
      '',
      'Reminder: to receive a passing grade in ANTH 195S, your final thesis must be finished ' +
        'and submitted (via the Senior Thesis module) by the end of this course.',
    ];
    if (String(finalRec.AdvisorComments || '').trim()) {
      lines.push('', 'Note from the undergraduate advisor:', String(finalRec.AdvisorComments).trim());
    }
    if (pdf && pdf.url) lines.push('', 'Your completed petition (PDF): ' + pdf.url);
    _notify(rec.StudentEmail, 'Your ANTH 195S enrollment is complete',
      lines.join('\n') + _actionTextFallback(rec.EnrollmentID, 'View your enrollment'));

    EventBus.emit('thesis.enrollment_completed', { enrollmentId: rec.EnrollmentID }, { user: user });
    return { enrollmentId: rec.EnrollmentID, stage: STAGE.COMPLETE,
             documentLink: pdf ? pdf.url : '' };
  }

  /** Advisor returns the enrollment to the SPONSOR, clearing the recorded
   *  approval (including the verification — a re-approval re-attests). */
  function enrollAdvisorReturn(payload, user, roles) {
    _enrAssertAdvisor(roles);
    const rec = _enrById((payload || {}).enrollmentId);
    if (!rec) throw new Error('Enrollment petition not found.');
    if (rec.Stage !== STAGE.PENDING_ADVISOR) throw new Error('This petition is not awaiting advisor processing.');

    const note = String((payload || {}).note || '').trim();
    if (!note) throw new Error('Add a note telling the sponsor what to reconsider.');

    DataService.update(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'EnrollmentID', rec.EnrollmentID, {
      Stage: STAGE.SUBMITTED,
      SponsorVerified: '', SponsorComments: '',
      SponsorDecidedBy: '', SponsorDecidedAt: '',
      ReturnNote: note,
    });

    Tasks.resolveForSource('thesis', rec.EnrollmentID, { resolvedBy: user });
    const profile = Auth.getProfile(rec.StudentEmail) || {};
    Tasks.create({
      module: 'thesis', sourceType: ENROLL_SOURCE_TYPE, sourceId: rec.EnrollmentID,
      label: 'ANTH 195S enrollment awaiting sponsor re-review: ' + _studentLabel(profile),
      assignedTo: rec.SponsorEmail, staleAfterDays: 14,
    });
    _notify(rec.SponsorEmail, 'ANTH 195S enrollment returned for your re-review',
      _facultyLabel(user) + ' has returned this enrollment petition to you for re-review. ' +
      'Your previous approval (including the completion verification) has been cleared — ' +
      'please review and decide again.\n\n' +
      'Note: ' + note + '\n\n' +
      'Student: ' + _studentLabel(profile) +
      _actionTextFallback(rec.EnrollmentID, 'Re-review this petition'));
    EventBus.emit('thesis.enrollment_advisor_returned', { enrollmentId: rec.EnrollmentID }, { user: user });
    return { enrollmentId: rec.EnrollmentID, stage: STAGE.SUBMITTED };
  }

  /**
   * Advisor (or super_admin) nudges whoever an enrollment is waiting on:
   * the sponsor (SUBMITTED), the advisor pool (PENDING_ADVISOR), or the
   * student (RETURNED). A deliberate manual reminder always sends.
   */
  function enrollRemind(payload, user, roles) {
    _enrAssertAdvisor(roles);
    const rec = _enrById(String((payload || {}).enrollmentId || '').trim());
    if (!rec) throw new Error('Enrollment petition not found.');

    let to, ask;
    if (rec.Stage === STAGE.SUBMITTED) {
      to = [rec.SponsorEmail]; ask = 'review it as the faculty sponsor';
    } else if (rec.Stage === STAGE.PENDING_ADVISOR) {
      to = _advisors().map(function (a) { return a.email; }); ask = 'assign a class number and complete it';
    } else if (rec.Stage === STAGE.RETURNED) {
      to = [rec.StudentEmail]; ask = 'revise and resubmit it';
    } else {
      throw new Error('This enrollment is not waiting on anyone to remind.');
    }
    to = (to || []).filter(function (e) { return String(e || '').trim(); });
    if (!to.length) throw new Error('No one is assigned at this stage to remind.');

    to.forEach(function (addr) {
      _notify(addr, 'Reminder: ANTH 195S enrollment awaiting your action',
        'A reminder from ' + _facultyLabel(user) + ': the ANTH 195S enrollment petition for ' +
        _facultyLabel(rec.StudentEmail) + ' is waiting for you to ' + ask + '.' +
        _actionTextFallback(rec.EnrollmentID, 'Open this petition'),
        null, /*force*/ true);
    });
    EventBus.emit('thesis.enrollment_reminded', { enrollmentId: rec.EnrollmentID, remindedTo: to }, { user: user });
    return { enrollmentId: rec.EnrollmentID, remindedTo: to };
  }

  /**
   * Permanently deletes an enrollment petition: resolves its tasks,
   * trashes its generated PDF and syllabus (best-effort), removes the
   * row. super_admin only — test cleanup; irreversible.
   */
  function enrollDelete(payload, user, roles) {
    if ((roles || []).indexOf('super_admin') === -1) {
      throw new Error('Only a super admin can delete an enrollment petition.');
    }
    const rec = _enrById(String((payload || {}).enrollmentId || '').trim());
    if (!rec) throw new Error('Enrollment petition not found.');

    Tasks.resolveForSource('thesis', rec.EnrollmentID, { resolvedBy: user });
    [rec.DriveFileID, rec.SyllabusFileID].forEach(function (fid) {
      const id = String(fid || '').trim();
      if (!id) return;
      try { DriveApp.getFileById(id).setTrashed(true); }
      catch (err) { Logger.log('enrollDelete: could not trash file ' + id + ' (' + err + ')'); }
    });

    const removed = DataService.remove(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'EnrollmentID', rec.EnrollmentID);
    if (!removed) throw new Error('Delete failed — the record could not be removed.');

    EventBus.emit('thesis.enrollment_deleted', { enrollmentId: rec.EnrollmentID }, { user: user });
    return { enrollmentId: rec.EnrollmentID, deleted: true };
  }


  // ── Enrollment: routing, context, PDF, helpers ─────────────

  function _enrRouteToSponsor(enrollmentId, sponsorEmail, studentProfile, resubmitted) {
    Tasks.create({
      module: 'thesis', sourceType: ENROLL_SOURCE_TYPE, sourceId: enrollmentId,
      label: 'ANTH 195S enrollment awaiting sponsor review: ' + _studentLabel(studentProfile),
      assignedTo: sponsorEmail, staleAfterDays: 14,
    });
    const studentName = (studentProfile && (studentProfile.name || studentProfile.email)) || 'A student';
    _notify(sponsorEmail,
      resubmitted ? 'ANTH 195S enrollment resubmitted for your review'
                  : 'ANTH 195S enrollment awaiting your review',
      (resubmitted ? studentName + ' has revised and resubmitted' : studentName + ' has submitted') +
      ' an ANTH 195S (senior thesis) enrollment petition naming you as faculty sponsor.\n\n' +
      'The student has confirmed they will finish and submit their final thesis this term. ' +
      'Before approving, please verify the project is at the writing stage — a student still ' +
      'conducting research belongs in ANTH 198 instead.' +
      _actionTextFallback(enrollmentId, 'Review this petition'));
  }

  function _enrRouteToAdvisor(enrollmentId, rec) {
    Tasks.create({
      module: 'thesis', sourceType: ENROLL_SOURCE_TYPE, sourceId: enrollmentId,
      label: 'ANTH 195S enrollment awaiting class number: ' + _facultyLabel(rec.StudentEmail),
      assignedRole: ADVISOR_ROLE, staleAfterDays: 14,
    });
    _advisors().forEach(function (adv) {
      _notify(adv.email, 'ANTH 195S enrollment awaiting class number',
        'An ANTH 195S enrollment petition has been approved by its sponsor and is ready for a class number.\n\n' +
        'Student: ' + _facultyLabel(rec.StudentEmail) +
        _actionTextFallback(enrollmentId, 'Process this petition'));
    });
  }

  /**
   * Decision-support context at the advisor stage: the special-study
   * credit total ACROSS BOTH this tab and the Individual Studies
   * petitions for the term (with the >7 flag), plus the class-number
   * options for ANTH 195S from the ClassSchedule service.
   */
  function _enrAdvisorContext(rec) {
    const term = _enrRecTerm(rec);
    const credits = _toNum(rec.Credits);

    let creditTotal = 0;
    const others = [];

    // This tab: the student's 195S enrollments for the term (normally just
    // this record — the duplicate guard allows one per term).
    DataService.query(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'StudentEmail', rec.StudentEmail)
      .filter(function (r) { return _enrRecTerm(r) === term && r.Stage !== STAGE.RETURNED; })
      .forEach(function (r) {
        const c = _toNum(r.Credits);
        creditTotal += c;
        if (String(r.EnrollmentID) !== String(rec.EnrollmentID)) {
          others.push({ recordId: r.EnrollmentID, course: r.Course || ENROLL_COURSE, credits: c,
            stage: r.Stage, sponsorName: _facultyLabel(r.SponsorEmail), module: 'thesis' });
        }
      });

    // Individual Studies: the student's petitions for the same term count
    // toward the same campus cap. Read via DataService against that
    // module's sheet; tolerant of the sheet/tab not existing yet.
    try {
      const isSheet = CONFIG.SHEETS.INDIVIDUAL_STUDIES;
      const isTab = (CONFIG.TABS && CONFIG.TABS.INDIVIDUAL_STUDIES) || 'Petitions';
      if (isSheet) {
        DataService.query(isSheet, isTab, 'StudentEmail', rec.StudentEmail)
          .filter(function (r) {
            const t = String(r.TermCode || '').trim();
            return t === term && r.Stage !== STAGE.RETURNED;
          })
          .forEach(function (r) {
            const c = _toNum(r.Credits);
            creditTotal += c;
            others.push({ recordId: r.PetitionID, course: r.Course, credits: c,
              stage: r.Stage, sponsorName: _facultyLabel(r.SponsorEmail), module: 'individual_studies' });
          });
      }
    } catch (e) {
      Logger.log('ThesisModule._enrAdvisorContext: Individual Studies lookup failed: ' + e);
    }

    // Class-number options for ANTH 195S from the ClassSchedule service.
    let preassigned = null, allSections = [], sectionsMatchedCredits = true;
    try {
      const pre = ClassSchedule.findPreassigned(term, ENROLL_COURSE, rec.SponsorEmail);
      preassigned = pre ? {
        classNbr: pre.ClassNbr, section: pre.Section, course: pre.Course,
        instructorRaw: pre.InstructorRaw, instructorEmail: pre.InstructorEmail,
        instructorName: pre.InstructorEmail ? _facultyLabel(pre.InstructorEmail) : (pre.InstructorRaw || 'Staff'),
        matchMethod: pre.MatchMethod,
      } : null;

      const res = ClassSchedule.sectionsForCourse(term, ENROLL_COURSE, { units: credits });
      sectionsMatchedCredits = res.matchedCredits;
      allSections = (res.sections || []).map(function (s) {
        return {
          classNbr: s.classNbr, section: s.section, units: s.units,
          instructorRaw: s.instructorRaw, instructorEmail: s.instructorEmail,
          instructorName: s.instructorEmail ? _facultyLabel(s.instructorEmail) : (s.instructorRaw || 'Staff'),
          isStaff: s.isStaff, isAssigned: s.isAssigned,
          matchMethod: s.matchMethod,
        };
      });
    } catch (e) {
      Logger.log('ThesisModule._enrAdvisorContext: ClassSchedule lookup failed: ' + e);
    }

    return {
      term: term,
      termLabel: _enrTermLabel(rec),
      credits: credits,
      course: ENROLL_COURSE,
      creditTotal: creditTotal,
      creditCap: SPECIAL_STUDY_CREDIT_CAP,
      overCap: creditTotal > SPECIAL_STUDY_CREDIT_CAP,
      otherPetitions: others,
      preassigned: preassigned,
      sections: allSections,
      sectionsMatchedCredits: sectionsMatchedCredits,
    };
  }

  // ── Enrollment: PDF (campus-form layout, at COMPLETE) ──

  function _enrGeneratePdf(rec, user) {
    const student = Auth.getProfile(rec.StudentEmail) || {};
    return ReportService.generate({
      module: 'thesis',
      reportKey: 'enrollment',
      title: 'ANTH 195S Enrollment Petition — ' + (student.name || rec.StudentEmail),
      sourceId: rec.EnrollmentID,
      params: { enrollmentId: rec.EnrollmentID, term: _enrRecTerm(rec), course: ENROLL_COURSE },
      html: _enrPdfHtml(rec, student),
      fileName: _enrBuildFileName(rec, student),
      orientation: 'portrait',
      letterhead: false,        // self-contained campus-form layout
      footerText: '',
    }, user);
  }

  /** Filename: <Year>-<Quarter>_<StudentID>-ENR-ANTH195S_Last-First.pdf */
  function _enrBuildFileName(rec, student) {
    const last = (student.lastName || '').trim() || 'Student';
    const first = (student.firstName || '').trim() || '';
    const who = first ? (last + '-' + first) : last;
    return rec.Year + '-' + rec.Quarter + '_' + (student.studentId || 'NOID') +
           '-ENR-ANTH195S_' + who + '.pdf';
  }

  /** Best-effort: file a generated enrollment PDF into the 195S folder.
   *  A Drive move keeps the file id, so the Reports archive index (and
   *  the stored DriveFileID) stay valid. */
  function _enrFilePdf(fileId) {
    const folderId = String((CONFIG.THESIS && CONFIG.THESIS.ENROLLMENT_DRIVE_FOLDER_ID) || '').trim();
    const id = String(fileId || '').trim();
    if (!folderId || !id) return;
    try {
      DriveApp.getFileById(id).moveTo(DriveApp.getFolderById(folderId));
    } catch (e) {
      Logger.log('ThesisModule._enrFilePdf: could not move ' + id + ' into ' + folderId + ' (' + e + ')');
    }
  }

  /**
   * Grants the student read access WITHOUT Drive's "shared with you"
   * email (the completion email already links the PDF). Mirrors the
   * Individual Studies / Transcript implementation. Best-effort.
   */
  function _enrGrantViewerQuiet(fileId, studentEmail) {
    const id = String(fileId || '').trim();
    const email = String(studentEmail || '').trim();
    if (!id || !email) return;
    try {
      if (typeof Drive !== 'undefined' && Drive && Drive.Permissions) {
        if (typeof Drive.Permissions.create === 'function') {          // v3
          Drive.Permissions.create(
            { role: 'reader', type: 'user', emailAddress: email },
            id, { sendNotificationEmail: false });
          return;
        }
        if (typeof Drive.Permissions.insert === 'function') {          // v2
          Drive.Permissions.insert(
            { role: 'reader', type: 'user', value: email },
            id, { sendNotificationEmails: false });
          return;
        }
      }
      DriveApp.getFileById(id).addViewer(email);   // last resort: does notify
    } catch (e) {
      Logger.log('ThesisModule._enrGrantViewerQuiet: could not share ' + id + ' with ' + email + ': ' + e);
    }
  }

  /**
   * Renders the enrollment petition as HTML mirroring the campus
   * individual-studies form (195S IS an individual-studies course):
   * student block, proposed-work blocks, and the approval blocks, with
   * name/email/timestamp in lieu of each signature. The two REQUIRED
   * attestations are printed inside the student and instructor blocks.
   */
  function _enrPdfHtml(rec, student) {
    const navy = (CONFIG.BRAND && CONFIG.BRAND.NAVY) || '#003C6C';
    const e = _esc;
    const studentName = student.name || rec.StudentEmail;
    const sponsorName = _facultyLabel(rec.SponsorEmail);
    const advisorName = rec.AdvisorProcessedBy ? _facultyLabel(rec.AdvisorProcessedBy) : '';

    const row = function (label, value) {
      return '<tr><td style="padding:3px 10px 3px 0;color:#555;white-space:nowrap;vertical-align:top;">' + e(label) +
        '</td><td style="padding:3px 0;vertical-align:top;">' + (value || '&mdash;') + '</td></tr>';
    };
    const sig = function (who, email, at) {
      if (!who && !email) return '&mdash;';
      return e(who || email) + (email ? ' &lt;' + e(email) + '&gt;' : '') +
             (at ? '<br><span style="color:#777;font-size:9pt;">Approved ' + e(_enrFmtDate(at)) + '</span>' : '');
    };
    const attest = function (text) {
      return '<div style="margin:0 0 6px;font-style:italic;color:#333;">&ldquo;' + e(text) + '&rdquo;</div>';
    };

    return ''
      + '<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:10pt;line-height:1.4;">'
      + '<div style="border-bottom:3px solid ' + navy + ';padding-bottom:8px;margin-bottom:12px;">'
      +   '<div style="font-size:9pt;color:#555;">University of California, Santa Cruz &middot; Department of Anthropology</div>'
      +   '<div style="font-size:15pt;font-weight:bold;color:' + navy + ';">Petition for Senior Thesis Enrollment &mdash; ANTH 195S</div>'
      +   '<div style="font-size:8.5pt;color:#777;">Academic Senate, Santa Cruz Regulation 6.5, 9.1</div>'
      + '</div>'

      // Student / context block
      + '<table style="width:100%;border-collapse:collapse;margin-bottom:10px;">'
      +   row('Name', e(studentName))
      +   row('Student ID', e(student.studentId || ''))
      +   row('Email', e(rec.StudentEmail))
      +   row('College', e(rec.College))
      +   row('Status', e(rec.MajorStatus) + (rec.ClassLevel ? ' &middot; ' + e(rec.ClassLevel) : ''))
      +   row('Quarter / Year', e(rec.Quarter) + ' ' + e(rec.Year))
      +   row('Course', e(rec.Course || ENROLL_COURSE))
      +   row('Course sponsoring agency', 'Anthropology')
      +   row('Faculty sponsor', e(sponsorName))
      +   row('Study site address', e(rec.StudySiteAddress))
      + '</table>'

      // Proposed work
      + _enrBlock('Thesis title and description', e(rec.Title) +
          (rec.CourseDescription ? '<br><br>' + e(rec.CourseDescription) : ''))
      + _enrBlock('Evidence of preparation for special study', e(rec.EvidenceOfPreparation))
      + _enrBlock('Description of work to be submitted', e(rec.WorkToBeSubmitted))
      + (String(rec.SyllabusLink || '').trim()
          ? _enrBlock('Syllabus', '<a href="' + e(rec.SyllabusLink) + '">' +
              e(rec.SyllabusName || 'View syllabus') + '</a>')
          : '')

      + '<table style="width:100%;border-collapse:collapse;margin-bottom:10px;">'
      +   row('Written report required', _isTrueStr(rec.ReportRequired) ? 'Yes' : 'No')
      +   (_isTrueStr(rec.ReportRequired) && rec.ReportDueDate ? row('Report due', e(rec.ReportDueDate)) : '')
      +   row('Hours per week &mdash; with faculty sponsor', e(rec.HoursWithSponsor))
      +   row('Hours per week &mdash; independently', e(rec.HoursIndependent))
      + '</table>'

      // Student signature — includes the 195S confirmation attestation.
      + _enrApprovalBlock('Student',
          attest(ENROLL_STUDENT_CONFIRM_TEXT)
          + sig(studentName, rec.StudentEmail, rec.StudentConfirmedAt || rec.CreatedAt))

      // Instructor approval — includes the sponsor verification.
      + _enrApprovalBlock('Instructor approval (faculty sponsor)',
          attest(ENROLL_SPONSOR_VERIFY_TEXT)
          + '<table style="width:100%;border-collapse:collapse;">'
          + row('Credits', e(rec.Credits))
          + row('Grade option', e(rec.GradeOption))
          + (rec.SponsorComments ? row('Comments', e(rec.SponsorComments)) : '')
          + row('Signed', sig(sponsorName, rec.SponsorEmail, rec.SponsorDecidedAt))
          + '</table>')

      // Course sponsoring agency approval — class number (advisor)
      + _enrApprovalBlock('Course sponsoring agency approval',
          '<table style="width:100%;border-collapse:collapse;">'
          + row('Class number', e(rec.ClassNumber))
          + row('Course ID', e(rec.Course || ENROLL_COURSE) + (rec.ClassSection ? ' &middot; sec ' + e(rec.ClassSection) : ''))
          + row('Signed', sig(advisorName, rec.AdvisorProcessedBy, rec.AdvisorProcessedAt))
          + '</table>')

      // Major department approval — only meaningful when over the cap
      + _enrApprovalBlock('Major department approval',
          '<table style="width:100%;border-collapse:collapse;">'
          + row('Total special-study credits', e(rec.TotalSpecialStudyCredits))
          + row('Authorization required', _isTrueStr(rec.MajorAuthRequired) ? 'Yes (over ' + SPECIAL_STUDY_CREDIT_CAP + ' credits)' : 'No')
          + (_isTrueStr(rec.MajorAuthRequired)
              ? row('Authorized by', sig(advisorName, rec.AdvisorProcessedBy, rec.AdvisorProcessedAt))
              : '')
          + '</table>')

      + '</div>';
  }

  function _enrBlock(label, value) {
    const navy = (CONFIG.BRAND && CONFIG.BRAND.NAVY) || '#003C6C';
    return '<div style="margin-bottom:10px;">'
      + '<div style="font-size:9pt;font-weight:bold;color:' + navy + ';text-transform:uppercase;letter-spacing:0.4px;">' + _esc(label) + '</div>'
      + '<div style="padding:4px 0;">' + (value || '&mdash;') + '</div>'
      + '</div>';
  }

  function _enrApprovalBlock(label, innerHtml) {
    const navy = (CONFIG.BRAND && CONFIG.BRAND.NAVY) || '#003C6C';
    return '<div style="border:1px solid #ccc;border-left:3px solid ' + navy + ';padding:8px 10px;margin-bottom:8px;">'
      + '<div style="font-size:9pt;font-weight:bold;color:' + navy + ';text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">' + _esc(label) + '</div>'
      + innerHtml
      + '</div>';
  }

  // ── Enrollment: syllabus (optional supporting document) ──

  /**
   * Saves an optional syllabus upload onto an enrollment petition, if one
   * is present in the payload (syllabusBase64 + syllabusName). Files go to
   * the 195S folder. Replace-in-place best effort; grants the student
   * viewer. Never blocks the submit/approve it rides along with.
   */
  function _enrMaybeSaveSyllabus(enrollmentId, payload) {
    const b64 = String((payload && payload.syllabusBase64) || '').trim();
    if (!b64) return;
    try {
      const rec = _enrById(enrollmentId);
      if (!rec) return;
      const folderId = String((CONFIG.THESIS && CONFIG.THESIS.ENROLLMENT_DRIVE_FOLDER_ID) || '').trim();
      if (!folderId) { Logger.log('ThesisModule: no 195S enrollment folder configured.'); return; }

      const name = String(payload.syllabusName || ('syllabus-' + enrollmentId + '.pdf')).trim();
      const bytes = Utilities.base64Decode(b64);
      const blob = Utilities.newBlob(bytes, payload.syllabusMimeType || 'application/pdf', name);
      const folder = DriveApp.getFolderById(folderId);

      // Replace: trash the prior file (if any) and create fresh, since
      // DriveApp can't overwrite bytes without Advanced Drive.
      const existingId = String(rec.SyllabusFileID || '').trim();
      if (existingId) {
        try { DriveApp.getFileById(existingId).setTrashed(true); } catch (e) {}
      }
      const file = folder.createFile(blob);
      file.setName(name);
      const fileId = file.getId();

      DataService.update(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'EnrollmentID', enrollmentId, {
        SyllabusFileID: fileId,
        SyllabusLink: 'https://drive.google.com/file/d/' + fileId + '/view',
        SyllabusName: name,
      });
      _enrGrantViewerQuiet(fileId, rec.StudentEmail);
    } catch (e) {
      Logger.log('ThesisModule._enrMaybeSaveSyllabus failed for ' + enrollmentId + ': ' + e);
    }
  }

  // ── Enrollment: record shaping + small helpers ──

  function _enrById(enrollmentId) {
    const id = String(enrollmentId || '').trim();
    if (!id) return null;
    const found = DataService.query(CONFIG.SHEETS.THESIS, ENROLL_TAB(), 'EnrollmentID', id);
    return found && found.length ? found[0] : null;
  }

  function _enrAssertSponsor(rec, user, roles) {
    if ((roles || []).indexOf('super_admin') !== -1) return;
    if (_norm(rec.SponsorEmail) !== _norm(user)) {
      throw new Error('Only the petition\'s faculty sponsor can act on it.');
    }
  }

  function _enrAssertAdvisor(roles) {
    if ((roles || []).indexOf('super_admin') !== -1) return;
    if ((roles || []).indexOf(ADVISOR_ROLE) === -1) {
      throw new Error('Only the undergraduate advisor can perform this action.');
    }
  }

  /** ANTH 195S (with credits) in a term's schedule, or null. */
  function _enrCourseForTerm(termCode) {
    try {
      return ClassSchedule.coursesForTerm(termCode, { allowlist: [ENROLL_COURSE] })
        .filter(function (c) { return c.credits !== null && c.credits !== undefined; })
        .find(function (c) {
          return String(c.course).trim().toUpperCase() === ENROLL_COURSE.toUpperCase();
        }) || null;
    } catch (e) {
      Logger.log('ThesisModule._enrCourseForTerm failed: ' + e);
      return null;
    }
  }

  /** Canonical term code of an enrollment record (always written on
   *  insert; the encode fallback mirrors IS for safety). */
  function _enrRecTerm(r) {
    const code = String(r.TermCode || '').trim();
    if (code) return code;
    const q = { 'winter': '0', 'spring': '2', 'summer': '4', 'fall': '8' };
    const qd = q[String(r.Quarter || '').trim().toLowerCase()];
    const y = String(r.Year || '').trim();
    if (!qd || !/^\d{4}$/.test(y)) return '';
    return '2' + y.slice(2) + qd;
  }

  function _enrTermLabel(r) {
    const q = String(r.Quarter || '').trim();
    const y = String(r.Year || '').trim();
    if (q && y) return q + ' ' + y;
    try { return ClassSchedule.decodeTermCode(_enrRecTerm(r)).label; } catch (e) { return ''; }
  }

  function _enrPublicRecord(r) {
    const student = Auth.getProfile(r.StudentEmail);
    return {
      enrollmentId: r.EnrollmentID,
      studentEmail: r.StudentEmail,
      studentName: student ? (student.nameLastFirst || student.name) : r.StudentEmail,
      studentId: student ? student.studentId : '',
      termCode: _enrRecTerm(r),
      quarter: r.Quarter, year: r.Year,
      term: _enrTermLabel(r),
      course: r.Course || ENROLL_COURSE,
      sponsorEmail: r.SponsorEmail,
      sponsorName: _facultyLabel(r.SponsorEmail),
      studySiteAddress: r.StudySiteAddress,
      title: r.Title,
      courseDescription: r.CourseDescription,
      evidenceOfPreparation: r.EvidenceOfPreparation,
      workToBeSubmitted: r.WorkToBeSubmitted,
      reportRequired: _isTrueStr(r.ReportRequired),
      reportDueDate: r.ReportDueDate,
      hoursWithSponsor: r.HoursWithSponsor,
      hoursIndependent: r.HoursIndependent,
      college: r.College, majorStatus: r.MajorStatus, classLevel: r.ClassLevel,
      credits: r.Credits, gradeOption: r.GradeOption,
      studentConfirmed: _isTrueStr(r.StudentConfirmed),
      sponsorVerified: _isTrueStr(r.SponsorVerified),
      sponsorComments: r.SponsorComments,
      sponsorDecidedAt: r.SponsorDecidedAt ? _enrFmtDate(r.SponsorDecidedAt) : '',
      classNumber: r.ClassNumber, classSection: r.ClassSection,
      totalSpecialStudyCredits: r.TotalSpecialStudyCredits,
      majorAuthRequired: _isTrueStr(r.MajorAuthRequired),
      majorAuthorized: _isTrueStr(r.MajorAuthorized),
      advisorComments: r.AdvisorComments,
      advisorName: r.AdvisorProcessedBy ? _facultyLabel(r.AdvisorProcessedBy) : '',
      advisorProcessedAt: r.AdvisorProcessedAt ? _enrFmtDate(r.AdvisorProcessedAt) : '',
      stage: r.Stage,
      documentLink: r.DocumentLink || '',
      syllabusLink: r.SyllabusLink || '',
      syllabusName: r.SyllabusName || '',
      returnNote: r.ReturnNote || '',
      createdAt: r.CreatedAt ? _enrFmtDate(r.CreatedAt) : '',
      _created: r.CreatedAt ? new Date(r.CreatedAt).getTime() : 0,
    };
  }

  function _toNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function _boolStr(v) { return (v === true || v === 'true' || v === 'TRUE') ? 'TRUE' : 'FALSE'; }
  function _isTrueStr(v) { return String(v).toUpperCase() === 'TRUE'; }

  function _enrFmtDate(v) {
    if (!v) return '';
    const d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMM d, yyyy');
  }


  // ── Operational settings (module-owned) ────────────────────
  // NOTIFY_ON_HANDOFF / SEND_CERTIFICATE live in the ThesisSettings store and
  // are surfaced through the module's own Settings tab — mirroring how the
  // Transcript module owns its settings, rather than the Admin module holding
  // a panel for them. Backed by the same ThesisSettings store _notify already
  // reads, so there is no data move: only the UI/dispatch path changed.
  // Gated advisor + super_admin (matching advisorComplete / gradQueue), since
  // the undergraduate advisor runs the workflow day-to-day.

  function _assertSettingsManager(user, roles) {
    if (_isUndergradAdvisor(user) || (roles || []).indexOf('super_admin') !== -1) return;
    throw new Error('Only the undergraduate advisor can change thesis settings.');
  }

  /** Returns the thesis operational settings for the Settings tab. */
  function getSettings(payload, user, roles) {
    _assertSettingsManager(user, roles);
    return ThesisSettings.get();
  }

  /** Saves the thesis operational settings from the Settings tab. */
  function saveSettings(payload, user, roles) {
    _assertSettingsManager(user, roles);
    return ThesisSettings.save(payload || {});
  }


  return {
    TABS: TABS,
    listEligible, listCountries, submit, mySubmissions, sponsored, queue, get,
    sponsorDecision, readerDecision, advisorComplete, returnToStudent, returnToSponsor,
    gradQueue, remindResponsible, repairAdvisorTasks, deleteThesis,
    getSettings, saveSettings,
    // ANTH 195S enrollment (front half of the lifecycle)
    enrollFormData, enrollMine, enrollGet, enrollSubmit, enrollWithdraw,
    enrollSponsorQueue, enrollSponsorApprove, enrollSponsorReturn,
    enrollAdvisorQueue, enrollAdvisorComplete, enrollAdvisorReturn,
    enrollRemind, enrollDelete, enrollmentPrefill,
  };

})();


/**
 * Editor-runnable wrapper for the one-time task repair: select this
 * function in the Apps Script editor's Run menu and execute it once.
 * Rebuilds the role-assigned dashboard task for every thesis currently
 * awaiting final processing. Check the execution log for the count.
 */
function repairThesisAdvisorTasks() {
  return ThesisModule.repairAdvisorTasks(
    {}, Session.getActiveUser().getEmail(), ['super_admin']);
}