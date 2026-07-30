// ============================================================
// GradIndividualStudies.gs — Graduate Individual Studies (server)
// ============================================================
// The GRADUATE audience of the Individual Studies module. NOT a
// separate registered module: every action here is exposed through
// IndividualStudiesModule's return object as a grad-prefixed
// delegation (gradSubmit -> GradIndividualStudies.submit, etc.), so
// the module key stays 'individual_studies', one Modules-sheet row,
// one audit trail. Kept in its own file so the working undergraduate
// code is never edited beyond the small delegation/TABS patch.
//
// WORKFLOW (same two-hop shape as the undergraduate flow):
//
//   SUBMITTED ─ sponsor ─┬─ Approve ──────────► PENDING_ADVISOR
//                        └─ Return ───────────► RETURNED
//   PENDING_ADVISOR ─ coordinator ─┬─ Complete ─► COMPLETE (terminal; PDF)
//                                  └─ Return ───► SUBMITTED (to sponsor)
//   RETURNED ─ student resubmits ──────────────► SUBMITTED (same record)
//
// WHAT'S DIFFERENT FROM THE UNDERGRADUATE AUDIENCE (per the paper
// "Anthropology Graduate Independent Study Petition"):
//   - Units are FIXED BY COURSE CHOICE (297A/298A/299A = 5,
//     B = 10, C = 15) — no student-entered credits, no schedule-derived
//     credits, and NO special-study credit cap / major-authorization
//     branch (297C alone is 15 units; a different regime entirely).
//   - No grade option. No college / class level / major status.
//   - Fields: Study Site, Subject, Work Outline (typed AND/OR attached
//     as a document — the form explicitly allows attachment), Weekly
//     Contact Hours (one number; no SR760 split), Final Paper yes/no.
//   - DEADLINE (warn, never block): the form's "end of the fifth day
//     of instruction" rule is anchored to the Calendar module's
//     explicit "Graduate Student Enrollment and Fee Payment" deadline
//     entry, found by a configurable title pattern (GradSettings
//     DEADLINE_PATTERN). Submissions after the resolved date proceed
//     with LateSubmission=TRUE, surfaced in every queue. No calendar
//     entry / calendar failure -> no warning, no flag (log-and-continue).
//   - Sponsor eligibility role: grad_individual_studies_sponsor.
//     Coordinator (advisor-stage) role: staff_grad.
//
// SHARED SERVICES / CONTRACTS HONORED HERE:
//   - Identity is NOT copied onto the record; StudentEmail/SponsorEmail
//     are routing keys, names/IDs read from Auth at display time.
//   - Class numbers come from ClassSchedule (findPreassigned / pool /
//     reassignable). Grad course tokens may appear in the registrar
//     export either with the letter suffix ("ANTH 297A") or as the
//     base course ("ANTH 297") with per-section units — the lookup
//     tries the exact token first, then the base token filtered to the
//     petition's fixed units.
//   - The canonical PDF is generated ONCE at COMPLETE via ReportService
//     (campus-form layout mirroring the paper petition; name/email/
//     timestamp in lieu of signatures). Student gets document-level
//     view on the archived file.
//   - Tasks / Notify / EventBus / Auth / DataService only — the ONLY
//     direct Drive/Spreadsheet calls are (a) outline-file storage,
//     (b) grant-view on the completed PDF, and (c) the Google-Sheet
//     schedule export, each of which CREATES/permissions a new Drive
//     artifact rather than touching service storage.
//   - Every value returned to the client is a STRING/number/bool —
//     never a Date object (google.script.run rejects Dates silently;
//     see the importHistory fix in Classschedule.gs).
//   - Every privileged action allows super_admin.
//
// ALSO IN THIS FILE (shared, not grad-specific): the quarterly
// class-schedule EXPORT (CSV data + Google Sheet), admitting BOTH
// coordinator roles (staff_undergrad, staff_grad) + super_admin.
//
// STORAGE (all in the existing INDIVIDUAL_STUDIES spreadsheet; tabs
// created by setUp() via the Setup.gs patch):
//   GradPetitions  (CONFIG.TABS.GRAD_INDIVIDUAL_STUDIES)
//   GradTemplates  (CONFIG.TABS.GRAD_INDIVIDUAL_STUDIES_TEMPLATES)
//   GradSettings   (CONFIG.TABS.GRAD_INDIVIDUAL_STUDIES_SETTINGS)
//
// REGISTRATION: no new Modules-sheet row and no new handler name.
// Apply the two paste-in patches to IndividualStudiesModule.gs
// (TABS additions + return-object delegations — see the install
// notes shipped with this file), plus the Config.gs / Setup.gs
// patches, then run setUp() and publish a new deployment version.
// Finally add graduate_student, grad_individual_studies_sponsor,
// and staff_grad to the module's Roles list in Admin -> Modules.
// ============================================================

const GradIndividualStudies = (() => {

  const MODULE = 'individual_studies';          // shared module key (dispatch + tasks + audit)
  const SOURCE_TYPE = 'grad_individual_studies_petition';
  const ID_PREFIX = 'GIS';                      // record ids: GIS-… (routes deep links + tasks)

  const TAB = function () { return (CONFIG.TABS && CONFIG.TABS.GRAD_INDIVIDUAL_STUDIES) || 'GradPetitions'; };
  const TPL_TAB = function () { return (CONFIG.TABS && CONFIG.TABS.GRAD_INDIVIDUAL_STUDIES_TEMPLATES) || 'GradTemplates'; };
  const SETTINGS_TAB = function () { return (CONFIG.TABS && CONFIG.TABS.GRAD_INDIVIDUAL_STUDIES_SETTINGS) || 'GradSettings'; };
  const SHEET = function () { return CONFIG.SHEETS.INDIVIDUAL_STUDIES; };

  const STAGE = {
    SUBMITTED:       'SUBMITTED',
    PENDING_ADVISOR: 'PENDING_ADVISOR',
    RETURNED:        'RETURNED',
    COMPLETE:        'COMPLETE',
  };

  // Roles. The coordinator ("Graduate Coordinator" on the paper form)
  // is whoever holds staff_grad — role-derived, zero/one/many holders,
  // mirroring staff_undergrad on the undergraduate side.
  const STUDENT_ROLE   = 'graduate_student';
  const SPONSOR_ROLE   = 'grad_individual_studies_sponsor';
  const ADVISOR_ROLE   = 'staff_grad';
  const FACILITIES_ROLE = 'staff_facilities';

  // The nine graduate courses with their FIXED units, straight from the
  // paper form. Units come from here, never from student input and never
  // from the schedule.
  const COURSES = [
    { course: 'ANTH 297A', units: 5,  family: 'Independent study' },
    { course: 'ANTH 297B', units: 10, family: 'Independent study' },
    { course: 'ANTH 297C', units: 15, family: 'Independent study' },
    { course: 'ANTH 298A', units: 5,  family: 'Lab apprenticeship' },
    { course: 'ANTH 298B', units: 10, family: 'Lab apprenticeship' },
    { course: 'ANTH 298C', units: 15, family: 'Lab apprenticeship' },
    { course: 'ANTH 299A', units: 5,  family: 'Thesis research' },
    { course: 'ANTH 299B', units: 10, family: 'Thesis research' },
    { course: 'ANTH 299C', units: 15, family: 'Thesis research' },
  ];

  // Settings keys (GradSettings tab, key/value). NOTIFY_* are the
  // student-email MESSAGE templates ({FirstName}/{Course} tokens); the
  // structural lines (class number + enrollment instructions, notes,
  // PDF/portal links) are appended in code and cannot be edited away —
  // same contract as the undergraduate PetitionSettings.
  const SETTINGS_DEFAULTS = {
    NOTIFY_GRAD_COMPLETE: 'Your {Course} graduate independent-study petition is complete.',
    NOTIFY_GRAD_RETURNED: 'Your {Course} graduate independent-study petition was returned for revision.',
    DEADLINE_PATTERN:     'graduate student enrollment',
  };


  // ============================================================
  // STUDENT FACE
  // ============================================================

  /**
   * Form bootstrap: terms with an imported schedule (each carrying its
   * resolved calendar deadline, if any), the fixed course list, and the
   * eligible sponsor list. Admits students, sponsors, the coordinator,
   * and super_admin (the sponsor list also feeds the template editor).
   */
  function formData(payload, user, roles) {
    _assertAny(roles, [STUDENT_ROLE, SPONSOR_ROLE, ADVISOR_ROLE]);

    let terms = [];
    try {
      terms = (ClassSchedule.availableTerms() || []).map(t => {
        const dl = _resolveDeadline(t.term, t.label);
        return {
          term: String(t.term),
          quarter: t.quarter, year: t.year, label: t.label,
          deadline: dl,                      // {date, title, matchedBy} | null
          pastDeadline: !!(dl && _todayISO() > dl.date),
        };
      });
    } catch (e) {
      Logger.log('GradIndividualStudies.formData: availableTerms failed: ' + e);
    }

    return {
      terms: terms,
      courses: COURSES.map(c => ({ course: c.course, units: c.units, family: c.family })),
      sponsors: _usersWithRole(SPONSOR_ROLE).map(p => ({
        email: p.email, name: p.nameLastFirst || p.name || p.email,
      })),
    };
  }

  /**
   * Student submits (or resubmits a RETURNED petition in place when
   * payload.petitionId is present). One study per petition; the
   * duplicate guard is (student, term, sponsor, course). The deadline
   * check WARNS (LateSubmission=TRUE) and never blocks.
   */
  function submit(payload, user, roles) {
    payload = payload || {};
    _assertAny(roles, [STUDENT_ROLE]);

    const termCode = String(payload.termCode || '').trim();
    const course   = String(payload.course || '').trim();
    const sponsorEmail = String(payload.sponsorEmail || '').trim();
    const studySite = String(payload.studySite || '').trim();
    const subject   = String(payload.subject || '').trim();
    const workOutline = String(payload.workOutline || '').trim();
    const hours     = String(payload.weeklyContactHours || '').trim();
    const finalPaper = String(payload.finalPaperRequired || '').trim();  // 'Yes' | 'No'
    const hasNewOutlineFile = !!String(payload.outlineBase64 || '').trim();

    if (!termCode) throw new Error('Choose a term.');
    const courseDef = COURSES.find(c => c.course === course);
    if (!courseDef) throw new Error('Choose one of the graduate independent-study courses.');
    if (!sponsorEmail) throw new Error('Select a faculty sponsor.');
    if (!_holdsRole(sponsorEmail, SPONSOR_ROLE)) {
      throw new Error('That instructor is not currently eligible to sponsor graduate independent studies.');
    }
    if (!subject) throw new Error('Enter the subject of the proposed course.');
    const hoursNum = Number(hours);
    if (hours === '' || !isFinite(hoursNum) || hoursNum < 0) {
      throw new Error('Enter the average weekly contact hours with your faculty sponsor.');
    }
    if (finalPaper !== 'Yes' && finalPaper !== 'No') {
      throw new Error('Indicate whether a final paper will be required.');
    }

    const decoded = ClassSchedule.decodeTermCode(termCode);

    // Resubmission path: same record, must be the student's own RETURNED petition.
    const resubmitId = String(payload.petitionId || '').trim();
    let existing = null;
    if (resubmitId) {
      existing = _byId(resubmitId);
      if (!existing) throw new Error('Petition not found.');
      if (_norm(existing.StudentEmail) !== _norm(user) && !roles.includes('super_admin')) {
        throw new Error('Only the petition\'s student can resubmit it.');
      }
      if (existing.Stage !== STAGE.RETURNED) {
        throw new Error('Only a returned petition can be resubmitted.');
      }
    }

    // Work outline: typed text OR attached document (the paper form
    // allows either). Required unless a document is (or stays) attached.
    const keepsOldOutlineFile = !!(existing && String(existing.OutlineFileID || '').trim() && !hasNewOutlineFile);
    if (!workOutline && !hasNewOutlineFile && !keepsOldOutlineFile) {
      throw new Error('Outline the planned work, or attach the outline as a document.');
    }

    // Duplicate guard: exact (student, term, sponsor, course) collision.
    const clash = DataService.getAll(SHEET(), TAB()).find(r =>
      _norm(r.StudentEmail) === _norm(user) &&
      String(r.TermCode) === termCode &&
      _norm(r.SponsorEmail) === _norm(sponsorEmail) &&
      String(r.Course) === course &&
      String(r.PetitionID) !== resubmitId);
    if (clash) {
      throw new Error('You already have a ' + course + ' petition with this sponsor for ' +
        (decoded.label || termCode) + '. Open it under My Petitions instead of filing a duplicate.');
    }

    // Deadline (warn-only). Log-and-continue on any calendar problem.
    let late = false, deadlineDate = '';
    try {
      const dl = _resolveDeadline(termCode, decoded.label);
      if (dl && dl.date) { deadlineDate = dl.date; late = _todayISO() > dl.date; }
    } catch (e) {
      Logger.log('GradIndividualStudies.submit: deadline resolution failed: ' + e);
    }

    // Optional outline document (replaces any prior one on resubmit).
    let outline = null;
    if (hasNewOutlineFile) {
      outline = _storeOutline(payload, user);
      if (existing && String(existing.OutlineFileID || '').trim()) {
        try { DriveApp.getFileById(existing.OutlineFileID).setTrashed(true); }
        catch (e) { Logger.log('GradIndividualStudies.submit: could not trash old outline: ' + e); }
      }
    }

    const fields = {
      StudentEmail: existing ? existing.StudentEmail : user,
      TermCode: termCode,
      Quarter: decoded.quarter || '',
      Year: decoded.year || '',
      Course: course,
      Units: courseDef.units,
      SponsorEmail: sponsorEmail,
      StudySite: studySite,
      Subject: subject,
      WorkOutline: workOutline,
      WeeklyContactHours: hoursNum,
      FinalPaperRequired: finalPaper === 'Yes' ? 'TRUE' : 'FALSE',
      LateSubmission: late ? 'TRUE' : 'FALSE',
      DeadlineDate: deadlineDate,
      Stage: STAGE.SUBMITTED,
      // Clear any prior decision trail on resubmit:
      SponsorComments: '', SponsorDecidedBy: '', SponsorDecidedAt: '',
      ReturnNote: '',
    };
    if (outline) {
      fields.OutlineFileID = outline.fileId;
      fields.OutlineLink = outline.url;
      fields.OutlineName = outline.name;
    }

    let petitionId;
    if (existing) {
      petitionId = existing.PetitionID;
      DataService.update(SHEET(), TAB(), 'PetitionID', petitionId, fields);
      Tasks.resolveForSource(MODULE, petitionId, { resolvedBy: user });
    } else {
      petitionId = DataService.generateId(ID_PREFIX);
      fields.PetitionID = petitionId;
      DataService.insert(SHEET(), TAB(), fields);
    }

    _routeToSponsor(petitionId, sponsorEmail, user, course, !!existing, late);
    EventBus.emit(MODULE + (existing ? '.grad_resubmitted' : '.grad_submitted'),
      { recordId: petitionId, sponsorEmail: sponsorEmail }, { user: user });

    return { petitionId: petitionId, resubmitted: !!existing, lateSubmission: late };
  }

  /** The student's own petitions, newest first. */
  function mine(payload, user, roles) {
    return DataService.getAll(SHEET(), TAB())
      .filter(r => _norm(r.StudentEmail) === _norm(user))
      .map(_pub)
      .sort((a, b) => b._created - a._created);
  }

  /** One petition, visibility-checked (student, sponsor, coordinator, super). */
  function get(payload, user, roles) {
    const rec = _byId(String((payload || {}).petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    if (!_canView(rec, user, roles)) throw new Error('You do not have access to this petition.');
    return _pub(rec);
  }

  /**
   * Student withdraws a not-yet-complete petition: the record, its
   * tasks, and any attached outline are removed.
   */
  function withdraw(payload, user, roles) {
    const rec = _byId(String((payload || {}).petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    if (_norm(rec.StudentEmail) !== _norm(user) && !roles.includes('super_admin')) {
      throw new Error('Only the petition\'s student can withdraw it.');
    }
    if (rec.Stage === STAGE.COMPLETE) {
      throw new Error('A completed petition cannot be withdrawn — contact the graduate coordinator.');
    }
    _removeRecordArtifacts(rec, user, /*includePdf*/ false);
    DataService.remove(SHEET(), TAB(), 'PetitionID', rec.PetitionID);
    EventBus.emit(MODULE + '.grad_withdrawn', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, withdrawn: true };
  }

  /** super_admin test cleanup: delete at any stage (record, tasks, files, archive). */
  function deletePetition(payload, user, roles) {
    if (!roles.includes('super_admin')) throw new Error('Only a super admin can delete a petition.');
    const rec = _byId(String((payload || {}).petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    _removeRecordArtifacts(rec, user, /*includePdf*/ true);
    DataService.remove(SHEET(), TAB(), 'PetitionID', rec.PetitionID);
    EventBus.emit(MODULE + '.grad_deleted', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, deleted: true };
  }


  // ============================================================
  // SPONSOR FACE
  // ============================================================

  /** Petitions awaiting THIS sponsor's review. */
  function sponsorQueue(payload, user, roles) {
    _assertAny(roles, [SPONSOR_ROLE]);
    return DataService.getAll(SHEET(), TAB())
      .filter(r => r.Stage === STAGE.SUBMITTED && _norm(r.SponsorEmail) === _norm(user))
      .map(_pub)
      .sort((a, b) => a._created - b._created);
  }

  /** Everything this sponsor has ever sponsored (any stage). */
  function sponsored(payload, user, roles) {
    _assertAny(roles, [SPONSOR_ROLE]);
    return DataService.getAll(SHEET(), TAB())
      .filter(r => _norm(r.SponsorEmail) === _norm(user))
      .map(_pub)
      .sort((a, b) => b._created - a._created);
  }

  /**
   * Sponsor approves: optional revisions to subject/outline/hours,
   * comments, and an optional room/lab access request. Advances to the
   * coordinator (role-pool task, staff_grad).
   */
  function sponsorApprove(payload, user, roles) {
    payload = payload || {};
    const rec = _byId(String(payload.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    _assertSponsor(rec, user, roles);
    if (rec.Stage !== STAGE.SUBMITTED) throw new Error('This petition is not awaiting sponsor review.');

    const updates = {
      Stage: STAGE.PENDING_ADVISOR,
      SponsorComments: String(payload.comments || '').trim(),
      SponsorDecidedBy: user,
      SponsorDecidedAt: _nowStamp(),
      ReturnNote: '',
    };
    if (payload.subject !== undefined && String(payload.subject).trim()) {
      updates.Subject = String(payload.subject).trim();
    }
    if (payload.workOutline !== undefined) {
      updates.WorkOutline = String(payload.workOutline).trim();
    }
    if (payload.weeklyContactHours !== undefined && String(payload.weeklyContactHours).trim() !== '') {
      const h = Number(payload.weeklyContactHours);
      if (!isFinite(h) || h < 0) throw new Error('Weekly contact hours must be a number.');
      updates.WeeklyContactHours = h;
    }
    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, updates);

    if (payload.requestRoomAccess === true) {
      _recordRoomAccess(rec.PetitionID,
        String(payload.roomAccessRoom || '').trim(),
        String(payload.roomAccessNote || '').trim(), user);
    }

    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    _routeToAdvisor(rec.PetitionID, Object.assign({}, rec, updates), user);
    EventBus.emit(MODULE + '.grad_sponsor_approved', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.PENDING_ADVISOR };
  }

  /** Sponsor returns to the STUDENT with a required note. */
  function sponsorReturn(payload, user, roles) {
    payload = payload || {};
    const rec = _byId(String(payload.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    _assertSponsor(rec, user, roles);
    if (rec.Stage !== STAGE.SUBMITTED) throw new Error('This petition is not awaiting sponsor review.');
    const note = String(payload.note || '').trim();
    if (!note) throw new Error('A note is required to return a petition.');

    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
      Stage: STAGE.RETURNED, ReturnNote: note,
    });
    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });

    // Task FIRST, email second (matching _routeToSponsor/_routeToAdvisor):
    // the dashboard pointer is workflow-critical; the email is best-effort.
    // With the old order a notify failure silently killed the task.
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: rec.PetitionID,
      label: 'Grad independent study returned — revise and resubmit (' + rec.Course + ')',
      assignedTo: rec.StudentEmail,
    });
    try {
      _notifyStudent(rec, 'NOTIFY_GRAD_RETURNED',
        'Your sponsor\'s note: ' + note + '\n\n' +
        'Revise and resubmit from My Petitions in the portal: ' + _deepLink(rec.PetitionID),
        'Your ' + rec.Course + ' petition was returned');
    } catch (e) {
      Logger.log('GradIndividualStudies.sponsorReturn: notify failed (task already created): ' + e);
    }
    EventBus.emit(MODULE + '.grad_sponsor_returned', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.RETURNED, studentName: _studentLabel(rec.StudentEmail) };
  }

  /**
   * Room/lab access request (sponsor or super_admin), at approval or
   * later from the detail view. Re-requesting updates and re-notifies.
   */
  function requestRoomAccess(payload, user, roles) {
    payload = payload || {};
    const rec = _byId(String(payload.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    _assertSponsor(rec, user, roles);
    const room = String(payload.roomAccessRoom || '').trim();
    if (!room) throw new Error('Enter the room or space access is needed for.');
    _recordRoomAccess(rec.PetitionID, room, String(payload.roomAccessNote || '').trim(), user);
    return { petitionId: rec.PetitionID, roomAccessRequested: true };
  }


  // ============================================================
  // COORDINATOR (ADVISOR-STAGE) FACE
  // ============================================================

  /** Petitions awaiting a class number, oldest first. */
  function advisorQueue(payload, user, roles) {
    _assertAdvisor(roles);
    return DataService.getAll(SHEET(), TAB())
      .filter(r => r.Stage === STAGE.PENDING_ADVISOR)
      .map(_pub)
      .sort((a, b) => a._created - b._created);
  }

  /** Every grad petition (the Grad Settings tab's oversight table). */
  function allPetitions(payload, user, roles) {
    _assertAdvisor(roles);
    return DataService.getAll(SHEET(), TAB())
      .map(_pub)
      .sort((a, b) => b._created - a._created);
  }

  /**
   * Class-number decision support for one petition: the sponsor's
   * pre-assigned section (if any), the unassigned pool, and
   * reassignable named sections — for the petition's course at its
   * fixed units. Grad course tokens are looked up with a suffix
   * fallback (exact "ANTH 297A", else base "ANTH 297" at 5/10/15
   * units), since registrar exports vary in how they list them.
   */
  function advisorContext(payload, user, roles) {
    _assertAdvisor(roles);
    const rec = _byId(String((payload || {}).petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    return _advisorContext(rec);
  }

  /**
   * Coordinator completes: records the class number, generates the
   * canonical PDF (campus-form layout), marks COMPLETE, notifies the
   * student (with the class number + enrollment instructions appended
   * structurally), and grants the student view on the archived file.
   */
  function advisorComplete(payload, user, roles) {
    payload = payload || {};
    _assertAdvisor(roles);
    const rec = _byId(String(payload.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    if (rec.Stage !== STAGE.PENDING_ADVISOR) throw new Error('This petition is not awaiting the coordinator.');

    const classNumber = String(payload.classNumber || '').trim();
    if (!classNumber) throw new Error('Enter or select a class number.');
    const source = String(payload.classNumberSource || '').trim() || 'manual';
    if (source === 'reassigned' && payload.confirmReassign !== true) {
      throw new Error('This class number is listed under another instructor — confirm the reassignment.');
    }

    const updates = {
      Stage: STAGE.COMPLETE,
      ClassNumber: classNumber,
      ClassSection: String(payload.classSection || '').trim(),
      ClassNumberSource: source,
      AdvisorComments: String(payload.comments || '').trim(),
      AdvisorProcessedBy: user,
      AdvisorProcessedAt: _nowStamp(),
    };
    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, updates);
    const done = Object.assign({}, rec, updates);

    // Canonical PDF (once, at COMPLETE). A PDF failure must not lose
    // the completion — log, continue, and leave the links blank.
    let pdfUrl = '';
    try {
      const pdf = _generatePdf(done, user);
      DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
        DriveFileID: pdf.fileId || '',
        FileName: pdf.fileName || '',
        DocumentLink: pdf.url || '',
      });
      pdfUrl = pdf.url || '';
      done.DocumentLink = pdfUrl;
      if (pdf.fileId) {
        try { DriveApp.getFileById(pdf.fileId).addViewer(rec.StudentEmail); }
        catch (e) { Logger.log('GradIndividualStudies.advisorComplete: addViewer failed: ' + e); }
      }
    } catch (e) {
      Logger.log('GradIndividualStudies.advisorComplete: PDF generation failed: ' + e);
    }

    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });

    const enrollLines =
      'Your class number for ' + done.Course + ' (' + done.Units + ' units) is: ' + classNumber +
      (updates.ClassSection ? ' (section ' + updates.ClassSection + ')' : '') + '\n' +
      'Enroll through your student portal using this class number.' +
      (updates.AdvisorComments ? '\n\nNote from the graduate coordinator: ' + updates.AdvisorComments : '') +
      (pdfUrl ? '\n\nYour completed petition (PDF): ' + pdfUrl : '') +
      '\n\nView it in the portal: ' + _deepLink(rec.PetitionID);
    _notifyStudent(done, 'NOTIFY_GRAD_COMPLETE', enrollLines,
      'Your ' + done.Course + ' petition is complete');

    EventBus.emit(MODULE + '.grad_completed', { recordId: rec.PetitionID, classNumber: classNumber }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.COMPLETE, classNumber: classNumber, documentLink: pdfUrl };
  }

  /** Coordinator returns to the SPONSOR (never directly to the student). */
  function advisorReturn(payload, user, roles) {
    payload = payload || {};
    _assertAdvisor(roles);
    const rec = _byId(String(payload.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    if (rec.Stage !== STAGE.PENDING_ADVISOR) throw new Error('This petition is not awaiting the coordinator.');
    const note = String(payload.note || '').trim();
    if (!note) throw new Error('Add a note telling the sponsor what to reconsider.');

    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
      Stage: STAGE.SUBMITTED,
      SponsorComments: '', SponsorDecidedBy: '', SponsorDecidedAt: '',
      ReturnNote: note,
    });
    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    _routeToSponsor(rec.PetitionID, rec.SponsorEmail, rec.StudentEmail, rec.Course,
      /*resubmitted*/ false, _isTrueStr(rec.LateSubmission), note);
    EventBus.emit(MODULE + '.grad_advisor_returned', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.SUBMITTED };
  }

  /**
   * Manual reminder to whoever the petition is waiting on — mirrors the
   * undergraduate remindResponsible.
   */
  function remindResponsible(payload, user, roles) {
    _assertAdvisor(roles);
    const rec = _byId(String((payload || {}).petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');

    let to, ask;
    if (rec.Stage === STAGE.SUBMITTED) {
      to = [rec.SponsorEmail]; ask = 'review it as the faculty sponsor';
    } else if (rec.Stage === STAGE.PENDING_ADVISOR) {
      to = _advisorEmails(); ask = 'assign a class number and complete it';
    } else if (rec.Stage === STAGE.RETURNED) {
      to = [rec.StudentEmail]; ask = 'revise and resubmit it';
    } else {
      throw new Error('This petition is not waiting on anyone to remind.');
    }
    to = (to || []).filter(e => String(e || '').trim());
    if (!to.length) throw new Error('No one is assigned at this stage to remind.');

    const who = _facultyLabel(user) || user;
    Notify.send({
      to: to,
      subject: 'Reminder: graduate independent study awaiting your action',
      body: 'A reminder from ' + who + ': the ' + rec.Course + ' graduate independent-study petition for ' +
        _studentLabel(rec.StudentEmail) + ' is waiting for you to ' + ask + '.\n\n' +
        'Open it in the portal: ' + _deepLink(rec.PetitionID),
      replyTo: _replyTo(),
    });
    EventBus.emit(MODULE + '.grad_reminded', { recordId: rec.PetitionID, remindedTo: to }, { user: user });
    return { petitionId: rec.PetitionID, remindedTo: to };
  }


  // ============================================================
  // SETTINGS (coordinator)
  // ============================================================

  /**
   * Grad settings + the deadline preview: for every imported term, the
   * calendar entry the DEADLINE_PATTERN currently resolves to (or a
   * "nothing matched" note), so the coordinator can verify the anchor
   * before the enrollment window opens.
   */
  function getSettings(payload, user, roles) {
    _assertAdvisor(roles);
    const out = {};
    Object.keys(SETTINGS_DEFAULTS).forEach(k => { out[k] = _setting(k); });

    out.deadlinePreview = [];
    try {
      (ClassSchedule.availableTerms() || []).forEach(t => {
        const dl = _resolveDeadline(t.term, t.label);
        out.deadlinePreview.push({
          term: String(t.term), label: t.label,
          resolved: !!dl,
          date: dl ? dl.date : '',
          title: dl ? dl.title : '',
          matchedBy: dl ? dl.matchedBy : '',
        });
      });
    } catch (e) {
      Logger.log('GradIndividualStudies.getSettings: deadline preview failed: ' + e);
    }
    return out;
  }

  function saveSettings(payload, user, roles) {
    _assertAdvisor(roles);
    payload = payload || {};
    Object.keys(SETTINGS_DEFAULTS).forEach(k => {
      if (payload[k] === undefined) return;
      _setSetting(k, String(payload[k]));
    });
    return getSettings({}, user, roles);
  }


  // ============================================================
  // TEMPLATES (sponsor-owned, grad field set, GradTemplates tab)
  // ============================================================

  /** This sponsor's templates (super_admin sees all, with owners). */
  function myTemplates(payload, user, roles) {
    _assertAny(roles, [SPONSOR_ROLE]);
    const all = DataService.getAll(SHEET(), TPL_TAB()).map(_pubTemplate);
    if (roles.includes('super_admin')) return all;
    return all.filter(t => _norm(t.sponsorEmail) === _norm(user));
  }

  /** Templates offered to a student who picked this sponsor. */
  function templatesForSponsor(payload, user, roles) {
    const sponsorEmail = String((payload || {}).sponsorEmail || '').trim();
    if (!sponsorEmail) return [];
    return DataService.getAll(SHEET(), TPL_TAB())
      .filter(t => _norm(t.SponsorEmail) === _norm(sponsorEmail))
      .map(_pubTemplate);
  }

  /** Create or update a template (owner, or super_admin on their behalf). */
  function saveTemplate(payload, user, roles) {
    _assertAny(roles, [SPONSOR_ROLE]);
    payload = payload || {};
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('Give the template a name.');

    let owner = user;
    if (roles.includes('super_admin') && String(payload.sponsorEmail || '').trim()) {
      owner = String(payload.sponsorEmail).trim();
    }

    const fields = {
      SponsorEmail: owner,
      Name: name,
      Course: String(payload.course || '').trim(),
      Subject: String(payload.subject || '').trim(),
      WorkOutline: String(payload.workOutline || '').trim(),
      WeeklyContactHours: String(payload.weeklyContactHours || '').trim(),
      RoomAccessRoom: String(payload.roomAccessRoom || '').trim(),
      IsDefault: payload.isDefault === true ? 'TRUE' : 'FALSE',
    };

    const id = String(payload.templateId || '').trim();
    if (id) {
      const tpl = _templateById(id);
      if (!tpl) throw new Error('Template not found.');
      _assertTemplateOwner(tpl, user, roles);
      if (fields.IsDefault === 'TRUE') _clearDefaults(tpl.SponsorEmail, id);
      DataService.update(SHEET(), TPL_TAB(), 'TemplateID', id, fields);
      return { templateId: id, saved: true };
    }
    const newId = DataService.generateId('GTPL');
    if (fields.IsDefault === 'TRUE') _clearDefaults(owner, '');
    fields.TemplateID = newId;
    DataService.insert(SHEET(), TPL_TAB(), fields);
    return { templateId: newId, saved: true };
  }

  /** Snapshot a petition's fields as a reusable template. */
  function saveAsTemplate(payload, user, roles) {
    payload = payload || {};
    const rec = _byId(String(payload.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    _assertSponsor(rec, user, roles);
    return saveTemplate({
      name: String(payload.name || '').trim(),
      sponsorEmail: rec.SponsorEmail,
      course: rec.Course,
      subject: rec.Subject,
      workOutline: rec.WorkOutline,
      weeklyContactHours: rec.WeeklyContactHours,
      roomAccessRoom: rec.RoomAccessRoom || '',
      isDefault: payload.isDefault === true,
    }, user, roles);
  }

  function setDefaultTemplate(payload, user, roles) {
    const tpl = _templateById(String((payload || {}).templateId || '').trim());
    if (!tpl) throw new Error('Template not found.');
    _assertTemplateOwner(tpl, user, roles);
    _clearDefaults(tpl.SponsorEmail, tpl.TemplateID);
    DataService.update(SHEET(), TPL_TAB(), 'TemplateID', tpl.TemplateID, { IsDefault: 'TRUE' });
    return { templateId: tpl.TemplateID, isDefault: true };
  }

  function deleteTemplate(payload, user, roles) {
    const tpl = _templateById(String((payload || {}).templateId || '').trim());
    if (!tpl) throw new Error('Template not found.');
    _assertTemplateOwner(tpl, user, roles);
    DataService.remove(SHEET(), TPL_TAB(), 'TemplateID', tpl.TemplateID);
    return { templateId: tpl.TemplateID, deleted: true };
  }


  // ============================================================
  // CLASS-SCHEDULE EXPORT (shared: both coordinators + super)
  // ============================================================

  /** Terms available to export — the imported-term list, shaped. */
  function exportTerms(payload, user, roles) {
    _assertExporter(roles);
    return (ClassSchedule.availableTerms() || []).map(t => ({
      term: String(t.term), label: t.label,
    }));
  }

  /**
   * The term's schedule with resolved instructor identity, shaped for a
   * client-side CSV download: registrar columns plus Resolved Instructor
   * / Resolved Email / Match Method (blank for Staff/unmatched rows).
   */
  function exportData(payload, user, roles) {
    _assertExporter(roles);
    const term = String((payload || {}).term || '').trim();
    if (!term) throw new Error('Choose a term to export.');
    const shaped = _exportRows(term);
    if (!shaped.rows.length) throw new Error('No schedule rows found for that term.');
    return shaped;
  }

  /**
   * Same data written to a NEW Google Sheet in Drive (named with the
   * term label + date). The acting user is added as an editor so the
   * file is reachable regardless of which account executes the web app.
   */
  function exportSheet(payload, user, roles) {
    _assertExporter(roles);
    const term = String((payload || {}).term || '').trim();
    if (!term) throw new Error('Choose a term to export.');
    const shaped = _exportRows(term);
    if (!shaped.rows.length) throw new Error('No schedule rows found for that term.');

    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const name = 'Class Schedule — ' + (shaped.label || term) + ' (exported ' + stamp + ')';
    const ss = SpreadsheetApp.create(name);
    const sheet = ss.getSheets()[0];
    sheet.setName('Schedule');

    const grid = [shaped.columns].concat(shaped.rows.map(r => shaped.columns.map(c => r[c])));
    sheet.getRange(1, 1, grid.length, shaped.columns.length).setValues(grid);
    sheet.getRange(1, 1, 1, shaped.columns.length)
      .setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, shaped.columns.length);

    try { ss.addEditor(user); }
    catch (e) { Logger.log('GradIndividualStudies.exportSheet: addEditor failed: ' + e); }

    return { url: ss.getUrl(), name: name, rowCount: shaped.rows.length, term: term, label: shaped.label };
  }

  function _exportRows(term) {
    const decoded = ClassSchedule.decodeTermCode(term);
    const columns = ['Term', 'Course', 'Title', 'Section', 'Class Nbr', 'Units', 'Component',
                     'Instructor (as reported)', 'Resolved Instructor', 'Resolved Email', 'Match Method'];
    const rows = (ClassSchedule.sectionsForTerm(term) || [])
      .map(r => {
        const email = String(r.InstructorEmail || '').trim();
        let resolvedName = '';
        if (email) {
          const p = Auth.getProfile(email);
          resolvedName = p ? (p.nameLastFirst || p.name || email) : '';
        }
        return {
          'Term': String(r.Term || ''),
          'Course': String(r.Course || ''),
          'Title': String(r.Title || ''),
          'Section': String(r.Section || ''),
          'Class Nbr': String(r.ClassNbr || ''),
          'Units': String(r.Units || ''),
          'Component': String(r.Component || ''),
          'Instructor (as reported)': String(r.InstructorRaw || ''),
          'Resolved Instructor': resolvedName,
          'Resolved Email': email,
          'Match Method': String(r.MatchMethod || ''),
        };
      })
      .sort((a, b) =>
        String(a.Course).localeCompare(String(b.Course), undefined, { numeric: true, sensitivity: 'base' }) ||
        String(a.Section).localeCompare(String(b.Section), undefined, { numeric: true, sensitivity: 'base' }));
    return { term: term, label: decoded.label || term, columns: columns, rows: rows };
  }

  function _assertExporter(roles) {
    if (roles.includes('super_admin')) return;
    if (roles.includes('staff_undergrad') || roles.includes(ADVISOR_ROLE)) return;
    throw new Error('Only a department coordinator can export the class schedule.');
  }


  // ============================================================
  // PRIVATE — deadline resolution (Calendar module anchor)
  // ============================================================

  /**
   * Resolves the term's submission deadline from the Calendar module:
   * active deadlines whose title contains DEADLINE_PATTERN
   * (case-insensitive; default 'graduate student enrollment').
   * Preference order:
   *   1. a match whose title contains the term label (e.g. "Fall 2026")
   *   2. the match whose date is nearest to today
   * Returns { date:'yyyy-MM-dd', title, deadlineId, matchedBy } or null.
   * Any calendar failure returns null (warn feature degrades, never blocks).
   */
  function _resolveDeadline(termCode, termLabel) {
    let candidates = [];
    try {
      candidates = CalendarService.findDeadlines({
        titleContains: _setting('DEADLINE_PATTERN'),
      }) || [];
    } catch (e) {
      Logger.log('GradIndividualStudies._resolveDeadline: calendar read failed: ' + e);
      return null;
    }
    candidates = candidates.filter(d => d && d.date);
    if (!candidates.length) return null;

    const label = String(termLabel || '').trim().toLowerCase();
    if (label) {
      const byLabel = candidates.find(d => String(d.title).toLowerCase().indexOf(label) !== -1);
      if (byLabel) {
        return { date: byLabel.date, title: byLabel.title, deadlineId: byLabel.deadlineId, matchedBy: 'term label' };
      }
    }
    const today = new Date(_todayISO() + 'T00:00:00').getTime();
    let best = null, bestDist = Infinity;
    candidates.forEach(d => {
      const t = new Date(d.date + 'T00:00:00').getTime();
      const dist = Math.abs(t - today);
      if (dist < bestDist) { bestDist = dist; best = d; }
    });
    return best
      ? { date: best.date, title: best.title, deadlineId: best.deadlineId, matchedBy: 'nearest date' }
      : null;
  }


  // ============================================================
  // PRIVATE — class-number lookup (with grad course-token fallback)
  // ============================================================

  /** ["ANTH 297A", "ANTH 297"] — exact token first, base token second. */
  function _courseTokens(course) {
    const c = String(course || '').trim();
    const m = c.match(/^(.*\d)\s*([A-Za-z])$/);
    return (m && m[1]) ? [c, m[1].trim()] : [c];
  }

  function _advisorContext(rec) {
    const term = String(rec.TermCode || '').trim();
    const units = Number(rec.Units || 0);
    const tokens = _courseTokens(rec.Course);

    let preassigned = null, sections = [], matchedCredits = true, tokenUsed = tokens[0];
    try {
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const pre = ClassSchedule.findPreassigned(term, token, rec.SponsorEmail);
        const res = ClassSchedule.sectionsForCourse(term, token, { units: units });
        const secs = (res.sections || []);
        if (pre || secs.length) {
          tokenUsed = token;
          matchedCredits = res.matchedCredits;
          if (pre) {
            preassigned = {
              classNbr: String(pre.ClassNbr || ''), section: String(pre.Section || ''),
              units: String(pre.Units || ''),
              instructorName: pre.InstructorEmail ? _facultyLabel(pre.InstructorEmail) : (pre.InstructorRaw || 'Staff'),
            };
          }
          sections = secs.map(s => ({
            classNbr: String(s.classNbr || ''), section: String(s.section || ''),
            units: String(s.units || ''),
            instructorName: s.instructorEmail ? _facultyLabel(s.instructorEmail) : (s.instructorRaw || 'Staff'),
            isStaff: !!s.isStaff, isAssigned: !!s.isAssigned,
          }));
          break;
        }
      }
    } catch (e) {
      Logger.log('GradIndividualStudies._advisorContext: schedule lookup failed: ' + e);
    }

    return {
      petitionId: rec.PetitionID,
      term: term,
      termLabel: _termLabel(rec),
      course: rec.Course,
      units: units,
      scheduleToken: tokenUsed,
      preassigned: preassigned,
      sections: sections,
      sectionsMatchedCredits: matchedCredits,
      lateSubmission: _isTrueStr(rec.LateSubmission),
      deadlineDate: String(rec.DeadlineDate || ''),
    };
  }


  // ============================================================
  // PRIVATE — routing (Tasks + Notify), room access, PDF
  // ============================================================

  function _routeToSponsor(petitionId, sponsorEmail, studentEmail, course, resubmitted, late, advisorNote) {
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: petitionId,
      label: 'Grad independent study awaiting sponsor review' + (late ? ' (late submission)' : ''),
      assignedTo: sponsorEmail,
    });
    const studentName = _studentLabel(studentEmail);
    const lines = [
      (advisorNote
        ? 'The graduate coordinator has returned ' + studentName + '\'s ' + course + ' petition for your re-review.'
        : (resubmitted ? studentName + ' has revised and resubmitted' : studentName + ' has submitted') +
          ' a graduate independent-study petition for ' + course + '.'),
    ];
    if (late) lines.push('NOTE: this petition was submitted AFTER the enrollment deadline on the department calendar.');
    if (advisorNote) lines.push('Coordinator\'s note: ' + advisorNote);
    lines.push('Review it in the portal: ' + _deepLink(petitionId));
    Notify.send({
      to: [sponsorEmail],
      subject: (advisorNote ? 'Returned for re-review: ' : 'Grad independent study to review: ') +
        course + ' — ' + studentName,
      body: lines.join('\n\n'),
      replyTo: _replyTo(),
    });
  }

  function _routeToAdvisor(petitionId, rec, user) {
    const studentName = _studentLabel(rec.StudentEmail);
    const late = _isTrueStr(rec.LateSubmission);
    // ONE shared task assigned to the coordinator ROLE pool (assignedRole,
    // not assignedTo) — every staff_grad holder sees it; resolution by any
    // holder clears it for all. Self-heals if the role is granted later.
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: petitionId,
      label: 'Grad independent study awaiting class number: ' + studentName + ' — ' + rec.Course +
        (late ? ' (late submission)' : ''),
      assignedRole: ADVISOR_ROLE,
    });
    const body =
      'A graduate independent-study petition has been approved by its sponsor and needs a class number.\n\n' +
      'Student: ' + studentName + '\nCourse: ' + rec.Course + ' (' + rec.Units + ' units)\nTerm: ' + _termLabel(rec) +
      (late ? '\n\nNOTE: this petition was submitted after the enrollment deadline.' : '') +
      '\n\nComplete it in the portal: ' + _deepLink(petitionId);
    const advisors = _advisorEmails();
    if (advisors.length) {
      Notify.send({
        to: advisors,
        subject: 'Grad independent study ready for a class number: ' + studentName,
        body: body,
        replyTo: _replyTo(),
      });
    } else {
      // No coordinator right now: the role-pool task above self-heals, but
      // warn super_admins so someone assigns staff_grad (or acts directly).
      Notify.send({
        to: (CONFIG.SUPER_ADMINS || []).slice(),
        subject: 'Grad independent study waiting — no graduate coordinator assigned',
        body: 'A petition is ready for a class number, but no one currently holds the "' + ADVISOR_ROLE +
          '" role. Assign it in Admin -> Users (the task will appear on their dashboard automatically), ' +
          'or complete the petition yourself.\n\n' + body,
        replyTo: _replyTo(),
      });
    }
  }

  function _recordRoomAccess(petitionId, room, note, user) {
    DataService.update(SHEET(), TAB(), 'PetitionID', petitionId, {
      RoomAccessRequested: 'TRUE',
      RoomAccessRoom: room,
      RoomAccessNote: note,
      RoomAccessRequestedBy: user,
      RoomAccessRequestedAt: _nowStamp(),
    });
    const rec = _byId(petitionId);
    Tasks.create({
      module: MODULE, sourceType: 'grad_individual_studies_room_access', sourceId: petitionId,
      label: 'Room access needed: ' + room + ' (' + _studentLabel(rec.StudentEmail) + ', ' + rec.Course + ')',
      assignedRole: FACILITIES_ROLE,
    });
    const facilities = _usersWithRole(FACILITIES_ROLE).map(p => p.email);
    const to = facilities.length ? facilities : (CONFIG.SUPER_ADMINS || []).slice();
    if (to.length) {
      Notify.send({
        to: to,
        subject: 'Room access request — graduate independent study',
        body: 'Access to "' + room + '" is requested for a graduate independent study.\n\n' +
          'Student: ' + _studentLabel(rec.StudentEmail) + '\nCourse: ' + rec.Course +
          '\nTerm: ' + _termLabel(rec) + '\nRequested by: ' + _facultyLabel(user) +
          (note ? '\nNote: ' + note : '') +
          '\n\nPetition: ' + _deepLink(petitionId),
        replyTo: _replyTo(),
      });
    }
  }

  /** Student notification: saved template (or default) + structural lines. */
  function _notifyStudent(rec, templateKey, structuralLines, subject) {
    const student = Auth.getProfile(rec.StudentEmail) || {};
    const msg = _setting(templateKey)
      .replace(/\{FirstName\}/g, student.firstName || 'student')
      .replace(/\{Course\}/g, rec.Course || 'independent study');
    Notify.send({
      to: [rec.StudentEmail],
      subject: subject,
      body: msg + '\n\n' + structuralLines,
      replyTo: _replyTo(),
    });
  }

  // ── PDF: campus-form layout mirroring the paper petition ───
  // Table layout + inline styles only (the Drive HTML->Doc converter
  // ignores flexbox/grid/floats — see the ReportService fidelity note).

  function _generatePdf(rec, user) {
    const student = Auth.getProfile(rec.StudentEmail) || {};
    return ReportService.generate({
      module: MODULE,
      reportKey: 'grad-petition',
      title: 'Graduate Independent Study Petition — ' + (student.name || rec.StudentEmail),
      sourceId: rec.PetitionID,
      params: { petitionId: rec.PetitionID, term: rec.TermCode, course: rec.Course },
      html: _pdfHtml(rec, student),
      fileName: _pdfFileName(rec, student),
      orientation: 'portrait',
      letterhead: false,               // self-contained campus-form layout
      footerText: '',
    }, user);
  }

  /** <Year>-<Quarter>_<StudentID>-GIS-<Course>_Last-First.pdf */
  function _pdfFileName(rec, student) {
    const last = String(student.lastName || '').trim() || 'Student';
    const first = String(student.firstName || '').trim();
    const who = (first ? (last + '-' + first) : last).replace(/[^A-Za-z0-9-]+/g, '');
    const courseTag = String(rec.Course || '').replace(/[^A-Za-z0-9]+/g, '');
    return rec.Year + '-' + rec.Quarter + '_' + (student.studentId || 'NOID') +
      '-GIS-' + courseTag + '_' + who + '.pdf';
  }

  function _pdfHtml(rec, student) {
    const esc = ReportService.escapeHtml;
    const box = on => on ? '( X )' : '(&nbsp;&nbsp;&nbsp;)';
    const courseCell = c => box(rec.Course === c.course) + '&nbsp;&nbsp;' +
      esc(c.course.replace('ANTH ', '') + ' \u2013 ' + c.units + ' units');
    const famRow = (label, fam) => {
      const three = COURSES.filter(c => c.family === fam);
      return '<tr>'
        + '<td style="width:26%;padding:4px 6px;"><b>' + esc(label) + ':</b></td>'
        + three.map(c => '<td style="width:24%;padding:4px 6px;">' + courseCell(c) + '</td>').join('')
        + '</tr>';
    };
    const field = (label, value) =>
      '<tr><td style="width:26%;padding:5px 6px;color:#444444;"><b>' + esc(label) + '</b></td>'
      + '<td style="padding:5px 6px;border-bottom:1px solid #999999;">' + (value || '&mdash;') + '</td></tr>';
    const sigBlock = (roleLabel, name, email, stamp) =>
      '<td style="width:50%;padding:10px 6px;vertical-align:top;">'
      + '<b>' + esc(roleLabel) + '</b><br>'
      + esc(name || '\u2014') + '<br>'
      + '<span style="font-size:8pt;color:#555555;">' + esc(email || '') + '</span><br>'
      + '<span style="font-size:8pt;color:#555555;">Recorded via the Anthropology Portal'
      + (stamp ? ' \u00B7 ' + esc(stamp) : '') + '</span>'
      + '</td>';

    const outlineHtml = rec.WorkOutline
      ? esc(String(rec.WorkOutline)).replace(/\n/g, '<br>')
      : (rec.OutlineName
          ? 'See attached outline document: ' + esc(rec.OutlineName) +
            (rec.OutlineLink ? ' (' + esc(rec.OutlineLink) + ')' : '')
          : '&mdash;');

    return '<html><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:10pt;margin:0;">'
      + '<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:4px 0 2px;">'
      +   '<span style="font-size:9pt;color:#555555;">Class Number: <b>' + esc(rec.ClassNumber || '\u2014')
      +   (rec.ClassSection ? ' (section ' + esc(rec.ClassSection) + ')' : '') + '</b>'
      +   ' &nbsp;\u2014&nbsp; provided by the Graduate Coordinator upon completion of this form</span>'
      + '</td></tr><tr><td style="text-align:center;padding:6px 0 10px;">'
      +   '<span style="font-size:13pt;font-weight:bold;">ANTHROPOLOGY GRADUATE INDEPENDENT STUDY PETITION</span>'
      + '</td></tr></table>'
      + '<p style="font-size:8.5pt;color:#444444;margin:0 0 10px;">Any graduate student requesting an '
      + 'individual/research study course in Anthropology must complete this form by the end of the fifth day '
      + 'of instruction in any quarter. Upon approval by the Faculty Sponsor and submission to the Anthropology '
      + 'Department Office, the student is issued a schedule number.</p>'
      + '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #999999;font-size:9pt;">'
      +   famRow('Independent study', 'Independent study')
      +   famRow('Lab apprenticeship', 'Lab apprenticeship')
      +   famRow('Thesis research', 'Thesis research')
      + '</table>'
      + '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;font-size:9.5pt;">'
      +   field('Name', esc(_studentLabel(rec.StudentEmail)))
      +   field('Email', esc(rec.StudentEmail))
      +   field('Quarter / Year', esc((rec.Quarter || '') + ' ' + (rec.Year || '')))
      +   field('Study site', esc(rec.StudySite || ''))
      +   field('Subject of proposed course', esc(rec.Subject || ''))
      + '</table>'
      + '<p style="margin:12px 0 4px;font-size:9.5pt;"><b>Outline of the work planned for this independent study:</b></p>'
      + '<table width="100%" cellpadding="8" cellspacing="0" style="border:1px solid #999999;font-size:9.5pt;">'
      +   '<tr><td>' + outlineHtml + '</td></tr>'
      + '</table>'
      + '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;font-size:9.5pt;">'
      +   field('Average weekly contact with the faculty sponsor',
          esc(String(rec.WeeklyContactHours || '0')) + ' hours')
      +   field('Final paper required', _isTrueStr(rec.FinalPaperRequired)
          ? box(true) + ' Yes &nbsp; ' + box(false) + ' No'
          : box(false) + ' Yes &nbsp; ' + box(true) + ' No')
      + '</table>'
      + (rec.SponsorComments
        ? '<p style="margin:10px 0 2px;font-size:9pt;"><b>Sponsor comments:</b> ' + esc(rec.SponsorComments) + '</p>' : '')
      + (_isTrueStr(rec.LateSubmission)
        ? '<p style="margin:8px 0 2px;font-size:8.5pt;color:#8a5a00;"><b>Note:</b> submitted after the '
          + 'enrollment deadline' + (rec.DeadlineDate ? ' (' + esc(rec.DeadlineDate) + ')' : '') + '.</p>' : '')
      + '<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;border-top:1px solid #999999;"><tr>'
      +   sigBlock('Student', _studentLabel(rec.StudentEmail), rec.StudentEmail, _fmtDate(rec.CreatedAt))
      +   sigBlock('Faculty Sponsor', _facultyLabel(rec.SponsorEmail), rec.SponsorEmail, _fmtDate(rec.SponsorDecidedAt))
      + '</tr><tr>'
      +   sigBlock('Graduate Coordinator', _facultyLabel(rec.AdvisorProcessedBy), rec.AdvisorProcessedBy, _fmtDate(rec.AdvisorProcessedAt))
      +   '<td style="width:50%;"></td>'
      + '</tr></table>'
      + '</body></html>';
  }


  // ============================================================
  // PRIVATE — outline document storage
  // ============================================================

  /**
   * Stores an uploaded outline document. Folder: GradSettings
   * OUTLINE_FOLDER_ID if set; otherwise a "Grad Individual Studies —
   * Outlines" folder is created once and its id saved back (self-healing,
   * no setup step). The Drive artifact is new — service storage untouched.
   */
  function _storeOutline(payload, user) {
    const b64 = String(payload.outlineBase64 || '').trim();
    if (!b64) return null;
    const name = String(payload.outlineName || 'outline.pdf').trim() || 'outline.pdf';
    const mime = String(payload.outlineMimeType || 'application/pdf').trim() || 'application/pdf';

    let folder;
    const folderId = _setting('OUTLINE_FOLDER_ID');
    if (folderId) {
      try { folder = DriveApp.getFolderById(folderId); } catch (e) { folder = null; }
    }
    if (!folder) {
      const it = DriveApp.getFoldersByName('Grad Individual Studies — Outlines');
      folder = it.hasNext() ? it.next() : DriveApp.createFolder('Grad Individual Studies — Outlines');
      _setSetting('OUTLINE_FOLDER_ID', folder.getId());
    }

    const blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, name);
    const file = folder.createFile(blob);
    return { fileId: file.getId(), url: file.getUrl(), name: name };
  }

  function _removeRecordArtifacts(rec, user, includePdf) {
    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    if (String(rec.OutlineFileID || '').trim()) {
      try { DriveApp.getFileById(rec.OutlineFileID).setTrashed(true); }
      catch (e) { Logger.log('GradIndividualStudies: could not trash outline: ' + e); }
    }
    if (includePdf) {
      if (String(rec.DriveFileID || '').trim()) {
        try { DriveApp.getFileById(rec.DriveFileID).setTrashed(true); }
        catch (e) { Logger.log('GradIndividualStudies: could not trash PDF: ' + e); }
      }
      try { ReportService.deleteArchived(MODULE, rec.PetitionID); }
      catch (e) { Logger.log('GradIndividualStudies: deleteArchived failed: ' + e); }
    }
  }


  // ============================================================
  // PRIVATE — settings, shapes, permissions, small helpers
  // ============================================================

  function _setting(key) {
    let v = '';
    try {
      const rows = DataService.query(SHEET(), SETTINGS_TAB(), 'Key', key);
      if (rows && rows.length) v = String(rows[0].Value != null ? rows[0].Value : '').trim();
    } catch (e) { /* tab may not exist yet; fall through to default */ }
    return v || SETTINGS_DEFAULTS[key] || '';
  }

  function _setSetting(key, value) {
    try {
      const rows = DataService.query(SHEET(), SETTINGS_TAB(), 'Key', key);
      if (rows && rows.length) {
        DataService.update(SHEET(), SETTINGS_TAB(), 'Key', key, { Value: value });
      } else {
        DataService.insert(SHEET(), SETTINGS_TAB(), { Key: key, Value: value });
      }
    } catch (e) {
      Logger.log('GradIndividualStudies._setSetting(' + key + ') failed: ' + e);
      throw new Error('Could not save the setting — has setUp() been run to create the GradSettings tab?');
    }
  }

  /** Public shape — every value a string/number/bool, NEVER a Date. */
  function _pub(r) {
    return {
      petitionId: String(r.PetitionID || ''),
      studentEmail: String(r.StudentEmail || ''),
      studentName: _studentLabel(r.StudentEmail),
      termCode: String(r.TermCode || ''),
      term: _termLabel(r),
      course: String(r.Course || ''),
      units: String(r.Units || ''),
      sponsorEmail: String(r.SponsorEmail || ''),
      sponsorName: _facultyLabel(r.SponsorEmail),
      studySite: String(r.StudySite || ''),
      subject: String(r.Subject || ''),
      workOutline: String(r.WorkOutline || ''),
      weeklyContactHours: String(r.WeeklyContactHours || ''),
      finalPaperRequired: _isTrueStr(r.FinalPaperRequired),
      lateSubmission: _isTrueStr(r.LateSubmission),
      deadlineDate: String(r.DeadlineDate || ''),
      stage: String(r.Stage || ''),
      sponsorComments: String(r.SponsorComments || ''),
      sponsorDecidedBy: r.SponsorDecidedBy ? _facultyLabel(r.SponsorDecidedBy) : '',
      sponsorDecidedAt: _fmtDate(r.SponsorDecidedAt),
      classNumber: String(r.ClassNumber || ''),
      classSection: String(r.ClassSection || ''),
      advisorComments: String(r.AdvisorComments || ''),
      advisorProcessedBy: r.AdvisorProcessedBy ? _facultyLabel(r.AdvisorProcessedBy) : '',
      advisorProcessedAt: _fmtDate(r.AdvisorProcessedAt),
      outlineLink: String(r.OutlineLink || ''),
      outlineName: String(r.OutlineName || ''),
      documentLink: String(r.DocumentLink || ''),
      roomAccessRequested: _isTrueStr(r.RoomAccessRequested),
      roomAccessRoom: String(r.RoomAccessRoom || ''),
      roomAccessNote: String(r.RoomAccessNote || ''),
      returnNote: String(r.ReturnNote || ''),
      createdAt: _fmtDate(r.CreatedAt),
      _created: r.CreatedAt ? new Date(r.CreatedAt).getTime() : 0,
    };
  }

  function _pubTemplate(t) {
    return {
      templateId: String(t.TemplateID || ''),
      sponsorEmail: String(t.SponsorEmail || ''),
      sponsorName: _facultyLabel(t.SponsorEmail),
      name: String(t.Name || '') || '(untitled)',
      course: String(t.Course || ''),
      subject: String(t.Subject || ''),
      workOutline: String(t.WorkOutline || ''),
      weeklyContactHours: String(t.WeeklyContactHours || ''),
      roomAccessRoom: String(t.RoomAccessRoom || ''),
      isDefault: _isTrueStr(t.IsDefault),
    };
  }

  function _templateById(id) {
    if (!id) return null;
    const found = DataService.query(SHEET(), TPL_TAB(), 'TemplateID', id);
    return found && found.length ? found[0] : null;
  }

  function _clearDefaults(sponsorEmail, exceptId) {
    DataService.getAll(SHEET(), TPL_TAB())
      .filter(t => _norm(t.SponsorEmail) === _norm(sponsorEmail) &&
                   _isTrueStr(t.IsDefault) && String(t.TemplateID) !== String(exceptId))
      .forEach(t => DataService.update(SHEET(), TPL_TAB(), 'TemplateID', t.TemplateID, { IsDefault: 'FALSE' }));
  }

  function _assertTemplateOwner(tpl, user, roles) {
    if (roles.includes('super_admin')) return;
    if (_norm(tpl.SponsorEmail) !== _norm(user)) {
      throw new Error('Only the template\'s owner can change it.');
    }
  }

  function _byId(petitionId) {
    const id = String(petitionId || '').trim();
    if (!id) return null;
    const found = DataService.query(SHEET(), TAB(), 'PetitionID', id);
    return found && found.length ? found[0] : null;
  }

  function _canView(rec, user, roles) {
    if (roles.includes('super_admin')) return true;
    if (roles.includes(ADVISOR_ROLE)) return true;
    const me = _norm(user);
    return _norm(rec.StudentEmail) === me || _norm(rec.SponsorEmail) === me;
  }

  function _assertSponsor(rec, user, roles) {
    if (roles.includes('super_admin')) return;
    if (_norm(rec.SponsorEmail) !== _norm(user)) {
      throw new Error('Only the petition\'s faculty sponsor can act on it.');
    }
  }

  function _assertAdvisor(roles) {
    if (roles.includes('super_admin')) return;
    if (!roles.includes(ADVISOR_ROLE)) {
      throw new Error('Only the graduate coordinator can perform this action.');
    }
  }

  function _assertAny(roles, allowed) {
    if (roles.includes('super_admin')) return;
    if (!(allowed || []).some(r => roles.includes(r))) {
      throw new Error('You do not have access to this action.');
    }
  }

  function _holdsRole(email, role) {
    const p = Auth.getProfile(email);
    return !!(p && p.active !== false && (p.roles || []).some(r => _norm(r) === role));
  }

  function _usersWithRole(role) {
    return Auth.listUsers().filter(u =>
      u.active !== false && (u.roles || []).some(r => _norm(r) === role));
  }

  function _advisorEmails() {
    return _usersWithRole(ADVISOR_ROLE).map(p => p.email);
  }

  function _studentLabel(email) {
    const p = Auth.getProfile(email);
    return p ? (p.nameLastFirst || p.name || email) : String(email || '');
  }

  function _facultyLabel(email) {
    if (!email) return '';
    const p = Auth.getProfile(email);
    return p ? (p.nameLastFirst || p.name || email) : String(email);
  }

  function _termLabel(r) {
    const q = String(r.Quarter || '').trim();
    const y = String(r.Year || '').trim();
    if (q && y) return q + ' ' + y;
    return ClassSchedule.decodeTermCode(String(r.TermCode || '')).label;
  }

  function _replyTo() {
    try { return Settings.replyTo(MODULE); } catch (e) { return (CONFIG.DEFAULT_REPLY_TO || ''); }
  }

  function _deepLink(petitionId) {
    let base = '';
    try { base = ScriptApp.getService().getUrl() || ''; } catch (e) { base = ''; }
    if (!base) return '(open the portal)';
    const sep = base.indexOf('?') === -1 ? '?' : '&';
    return base + sep + 'page=' + MODULE + '&focus=' + encodeURIComponent(petitionId);
  }

  function _todayISO() {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  function _nowStamp() {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }

  function _fmtDate(v) {
    if (!v) return '';
    if (v instanceof Date) {
      return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    }
    const d = new Date(v);
    if (isNaN(d)) return String(v);
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }

  function _isTrueStr(v) { return String(v).toUpperCase() === 'TRUE'; }
  function _norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }


  return {
    // student
    formData, submit, mine, get, withdraw, deletePetition,
    // sponsor
    sponsorQueue, sponsored, sponsorApprove, sponsorReturn, requestRoomAccess,
    // coordinator
    advisorQueue, allPetitions, advisorContext, advisorComplete, advisorReturn, remindResponsible,
    // settings
    getSettings, saveSettings,
    // templates
    myTemplates, templatesForSponsor, saveTemplate, saveAsTemplate, setDefaultTemplate, deleteTemplate,
    // schedule export (shared with the undergraduate coordinator)
    exportTerms, exportData, exportSheet,
  };

})();