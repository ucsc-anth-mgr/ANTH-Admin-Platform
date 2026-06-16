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

  // Faculty eligible to sponsor or read are resolved at runtime from the
  // ThesisEligibility config (Admin → Roles → faculty roster), not from a
  // hard-coded role list — see ThesisEligibility.eligibleFor / isEligible.

  // The undergraduate advisor is whoever holds this role. Zero, one, or
  // several people may hold it; all holders share the advisor queue and are
  // notified. Identity is role-derived, not a stored email setting.
  const ADVISOR_ROLE = 'staff_undergrad';

  // Quarters offered at submission (term half of the filename prefix).
  const QUARTERS = ['Fall', 'Winter', 'Spring', 'Summer'];


  // ── Public actions (callable via dispatch) ─────────────────

  /**
   * Users eligible for a thesis capability, shaped { email, name } for a
   * dropdown. Resolved from the ThesisEligibility config so the set is
   * admin-managed, never hard-coded.
   * @param {Object} payload - { capability: 'sponsor' | 'reader' }
   */
  function listEligible(payload) {
    const capability = String((payload || {}).capability || 'sponsor');
    return ThesisEligibility.eligibleFor(capability);
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
    if (!ThesisEligibility.isEligible('sponsor', sponsorEmail)) {
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
      ReaderEmail: '', HonorsDecision: '', ReaderComments: '', ReaderDecidedBy: '', ReaderDecidedAt: '',
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
    const comments = String(payload.comments || '').trim();
    if (!comments) throw new Error('Comments are required with your decision.');
    const now = new Date();

    const updates = {
      SponsorDecision: decision, SponsorComments: comments,
      SponsorDecidedBy: user, SponsorDecidedAt: now,
      ReturnNote: '',   // clear any advisor re-review note once re-decided
    };

    Tasks.resolveForSource('thesis', rec.ThesisID, { resolvedBy: user });

    if (decision === SPONSOR.HONORS) {
      const readerEmail = String(payload.readerEmail || '').trim();
      if (!readerEmail) throw new Error('Select a faculty reader for honors review.');
      if (!ThesisEligibility.isEligible('reader', readerEmail)) {
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
   * Faculty reader records the honors decision on a PENDING_HONORS thesis.
   * Either outcome advances to the advisor for final processing.
   * @param {Object} payload - { thesisId, decision, comments }
   */
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
    const comments = String(payload.comments || '').trim();
    if (!comments) throw new Error('Comments are required to approve honors.');

    Tasks.resolveForSource('thesis', rec.ThesisID, { resolvedBy: user });
    DataService.update(CONFIG.SHEETS.THESIS, TAB, 'ThesisID', rec.ThesisID, {
      HonorsDecision: HONORS.APPROVED, ReaderComments: comments,
      ReaderDecidedBy: user, ReaderDecidedAt: new Date(),
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
      try { DriveApp.getFileById(fileId).setTrashed(true); }
      catch (err) { Logger.log('deleteThesis: could not trash file ' + fileId + ' (' + err + ')'); }
    }

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
    DataService.update(CONFIG.SHEETS.THESIS, TAB, 'ThesisID', rec.ThesisID, {
      Stage: STAGE.SUBMITTED, ReturnNote: note,
      SponsorDecision: '', SponsorComments: '', SponsorDecidedBy: '', SponsorDecidedAt: '',
      ReaderEmail: '', HonorsDecision: '', ReaderComments: '', ReaderDecidedBy: '', ReaderDecidedAt: '',
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
      sponsorDecidedAt: r.SponsorDecidedAt ? Utils.formatDate(r.SponsorDecidedAt) : '',
      readerEmail:  r.ReaderEmail,
      readerName:   r.ReaderEmail ? _facultyLabel(r.ReaderEmail) : '',
      honorsDecision: r.HonorsDecision,
      readerComments: r.ReaderComments,
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
      pub.readerEmail = ''; pub.readerName = '';
      pub.honorsDecision = ''; pub.readerComments = ''; pub.readerDecidedAt = '';
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
    let base = '';
    try { base = ScriptApp.getService().getUrl() || ''; } catch (e) { base = ''; }
    if (!base) return '';
    const sep = base.indexOf('?') === -1 ? '?' : '&';
    return base + sep + 'page=thesis&focus=' + encodeURIComponent(thesisId);
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


  return {
    listEligible, listCountries, submit, mySubmissions, sponsored, queue, get,
    sponsorDecision, readerDecision, advisorComplete, returnToStudent, returnToSponsor,
    gradQueue, remindResponsible, repairAdvisorTasks, deleteThesis,
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