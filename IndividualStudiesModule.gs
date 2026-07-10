// ============================================================
// IndividualStudiesModule.gs — Undergraduate Individual Studies (server)
// ============================================================
// A two-hop workflow module for the UCSC Anthropology petition for
// undergraduate individual studies (ANTH 197/197F/198/198F/198G/199/199F).
// One petition per (student, term, instructor, course):
//
//   SUBMITTED ─ sponsor ─┬─ Approve ──────────► PENDING_ADVISOR
//                        └─ Return ───────────► RETURNED
//   PENDING_ADVISOR ─ advisor ─┬─ Complete ───► COMPLETE   (terminal; PDF generated)
//                              └─ Return ──────► SUBMITTED  (to sponsor; decision cleared)
//   RETURNED ─ student resubmits ─────────────► SUBMITTED  (same record)
//
// Returns to the STUDENT happen only at the sponsor stage; the advisor
// returns to the SPONSOR, never directly to the student. Mirrors the
// Thesis module's correction-loop shape, minus the honors/reader branch.
//
// DESIGN NOTES (platform contracts honored here):
//   - Identity is NOT copied onto the record. StudentEmail / SponsorEmail
//     are routing keys; names and Student ID are read from Auth at display
//     time. Petition-specific facts not on the profile (college,
//     major status, class level) ARE stored on the record — they are not
//     platform identity.
//   - One study per petition; a student may file several. Duplicate guard
//     is the four-part key (student, term, instructor, course): an exact
//     collision is blocked.
//   - Class numbers come from the ClassSchedule SERVICE (findPreassigned /
//     availablePool / reassignable). The advisor confirms an auto-prefilled
//     pre-assignment, or assigns from the pool, or reassigns a
//     non-sponsoring instructor's number (with confirmation).
//   - The >7-credit "Major Department Approval" is the advisor's: the credit
//     total is computed ACROSS the student's individual-studies petitions
//     for the term, surfaced at the advisor stage.
//   - The canonical PDF is generated ONCE, at COMPLETE, via ReportService
//     (campus-form layout, name/email/timestamp in lieu of signatures). No
//     upload anywhere. The student is granted document-level view on the
//     archived file; folder-level faculty/advisor access is managed in Drive
//     outside the module.
//   - Cross-cutting concerns go through platform services: Tasks, Notify,
//     EventBus, Auth, DataService, ReportService. No SpreadsheetApp here.
//   - Every privileged action allows super_admin.
//
// REGISTRATION (Code.gs): add IndividualStudiesModule to getModuleHandler()
//   and getRegisteredHandlers(), and add the Modules-sheet row (Admin →
//   Modules). Keep both commented until this file ships.
// ============================================================

const IndividualStudiesModule = (() => {

  const MODULE = 'individual_studies';
  const TAB    = function () { return CONFIG.TABS.INDIVIDUAL_STUDIES || 'Petitions'; };
  const SHEET  = function () { return CONFIG.SHEETS.INDIVIDUAL_STUDIES; };
  const TPL_TAB = function () { return CONFIG.TABS.INDIVIDUAL_STUDIES_TEMPLATES || 'Templates'; };
  const SETTINGS_TAB = function () { return CONFIG.TABS.INDIVIDUAL_STUDIES_SETTINGS || 'PetitionSettings'; };

  // Student-notification message templates (UI-managed in the Settings tab,
  // stored key/value in PetitionSettings — mirrors TranscriptSettings).
  // The template is the MESSAGE ONLY; the structural, load-bearing lines
  // (class number + enrollment instructions, advisor note, PDF link, return
  // note, portal links) are appended in code and cannot be edited away.
  // Tokens {FirstName} and {Course} are filled at send time. These defaults
  // reproduce the module's original wording and also serve as the fallback
  // when the settings tab doesn't exist yet or a value is blank.
  const NOTIFY_DEFAULTS = {
    NOTIFY_COMPLETE: 'Your {Course} individual-studies petition is complete.',
    NOTIFY_RETURNED: 'Your {Course} petition was returned for revision.',
  };

  const STAGE = {
    SUBMITTED:       'SUBMITTED',
    PENDING_ADVISOR: 'PENDING_ADVISOR',
    RETURNED:        'RETURNED',
    COMPLETE:        'COMPLETE',
  };

  // The undergraduate advisor role — the shared-pool assignee for the
  // advisor stage and the major-approval owner. Role-derived, not a fixed
  // address (zero, one, or several holders).
  const ADVISOR_ROLE = 'staff_undergrad';

  // A sponsor can request room/lab-space access for any petition (at approval
  // or later from the detail view); facilities staff are tasked + emailed so
  // they can program access. Role-resolved, not a fixed address.
  const FACILITIES_ROLE = 'staff_facilities';

  // Identity role whose active holders may sponsor an individual study.
  // Assigned per-instructor in Admin -> Users (faculty status alone does
  // not qualify), mirroring the thesis module's role-based eligibility.
  const SPONSOR_ROLE = 'individual_studies_sponsor';

  // Roles that may enter the module as petition-filing students.
  const STUDENT_ROLES = ['undergraduate_student', 'undergraduate_non_major'];

  // Undergraduate individual-studies courses this module handles. 195S is
  // deliberately excluded (it belongs to the Thesis module). Units are not
  // hard-coded — the course's credit value is read from the petition.
  const COURSES = ['ANTH 197', 'ANTH 197F', 'ANTH 198', 'ANTH 198F', 'ANTH 198G', 'ANTH 199', 'ANTH 199F'];

  // Course handled elsewhere — used by the UI interceptor (see formData).
  const REDIRECT_COURSES = {
    'ANTH 195S': { module: 'thesis', label: 'Senior Thesis (ANTH 195S) is handled in the Thesis module.' },
  };

  const GRADE_OPTIONS = ['Letter', 'Pass/No Pass'];

  // The campus rule: more than 7 special-study credits in a term needs
  // department (advisor) authorization.
  const SPECIAL_STUDY_CREDIT_CAP = 7;

  const SOURCE_TYPE = 'individual_studies_petition';

  // Senate Regulation 760: 1 credit = 30 hours of work over the term. Weekly
  // load = (30 x credits) / weeks. Regular quarters run 10 weeks; summer is
  // compressed to 5. The total is fixed by policy — students and sponsors
  // only set the split (with-sponsor vs. independent); independent is the
  // remainder. Summer is detected from the term code's quarter digit.
  const SR760_HOURS_PER_CREDIT = 30;
  function _termWeeks(termCode) {
    try { return ClassSchedule.decodeTermCode(termCode).quarter === 'Summer' ? 5 : 10; }
    catch (e) { return 10; }
  }
  function _weeklyHoursTotal(credits, termCode) {
    const c = Number(credits);
    if (!isFinite(c) || c <= 0) return 0;
    const weeks = _termWeeks(termCode);
    return Math.round((SR760_HOURS_PER_CREDIT * c) / weeks);   // 3*cr normal, 6*cr summer
  }
  /**
   * Validates and normalizes the hours split against the SR 760 total.
   * Returns { withSponsor, independent } where independent = total - withSponsor.
   * Throws if with-sponsor is negative or exceeds the policy total.
   */
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

  // Room-access tasks use a distinct source type + id suffix so the normal
  // workflow's Tasks.resolveForSource(petitionId) calls never resolve them.
  const ROOM_ACCESS_SOURCE_TYPE = 'individual_studies_room_access';
  function _roomAccessSourceId(petitionId) { return String(petitionId) + ':room'; }


  // ============================================================
  // STUDENT ACTIONS
  // ============================================================

  /**
   * Bootstrap data for the New Petition form. Term-first and schedule-
   * driven: the only terms offered are those with an imported schedule, and
   * each term's courses (with their credit values) come from that schedule —
   * a student can only file for a term/course the registrar has published
   * and the advisor has imported. Also returns eligible sponsors, grade
   * options, the student's identity prefill, and the 195S redirect config.
   *
   * Shape:
   *   terms:   [{ term: '2258', label: 'Fall 2025', quarter, year,
   *               courses: [{ course:'ANTH 198', credits:5 }, ...] }]
   */
  function formData(payload, user, roles) {
    const profile = Auth.getProfile(user) || {};
    let terms = [];
    try {
      terms = ClassSchedule.availableTerms().map(t => {
        const courses = ClassSchedule.coursesForTerm(t.term, { allowlist: COURSES })
          // Drop courses with no resolvable credit value (nothing to file against).
          .filter(c => c.credits !== null && c.credits !== undefined)
          // Attach the catalog URL, derived from the course number.
          .map(c => Object.assign({}, c, { catalogUrl: _catalogUrl(c.course) }));
        return {
          term: t.term, label: t.label, quarter: t.quarter, year: t.year,
          weeks: _termWeeks(t.term), isSummer: _termWeeks(t.term) === 5,
          hoursPerCredit: SR760_HOURS_PER_CREDIT,
          courses: courses,
        };
      // Only offer terms that actually have at least one undergrad course.
      }).filter(t => t.courses.length);
    } catch (e) {
      Logger.log('IndividualStudiesModule.formData: schedule lookup failed: ' + e);
      terms = [];
    }
    return {
      terms: terms,
      redirectCourses: REDIRECT_COURSES,
      gradeOptions: GRADE_OPTIONS.slice(),
      sponsors: _eligibleSponsors(),
      profile: {
        name: profile.name || '',
        email: profile.email || user,
        studentId: profile.studentId || '',
        hasStudentId: !!(profile.studentId),
      },
    };
  }

  /** The caller's own petitions, newest first. Students see their own list. */
  function mine(payload, user, roles) {
    return DataService.query(SHEET(), TAB(), 'StudentEmail', user)
      .map(_publicRecord)
      .sort(_byCreatedDesc);
  }

  /**
   * Fetch one petition for the detail modal. Visible to the student who
   * owns it, the sponsor on it, any advisor, or super_admin.
   */
  function get(payload, user, roles) {
    const rec = _byId((payload || {}).petitionId);
    if (!rec) throw new Error('Petition not found.');
    if (!_canView(rec, user, roles)) throw new Error('You do not have access to this petition.');
    const pub = _publicRecord(rec);
    if (_isAdvisor(roles) || roles.includes('super_admin')) {
      pub.advisorContext = _advisorContext(rec);
    }
    return pub;
  }

  /**
   * Submit a NEW petition, or resubmit one currently RETURNED.
   *
   * @param {Object} payload
   *   @param {string} payload.quarter
   *   @param {string} payload.year          - 4-digit
   *   @param {string} payload.course        - one of COURSES
   *   @param {string} payload.sponsorEmail
   *   @param {string} payload.studySiteAddress
   *   @param {string} payload.title         - title & description of course
   *   @param {string} payload.courseDescription
   *   @param {string} payload.evidenceOfPreparation
   *   @param {string} payload.workToBeSubmitted
   *   @param {boolean} payload.reportRequired
   *   @param {string} [payload.reportDueDate]
   *   @param {string} payload.hoursWithSponsor
   *   @param {string} payload.hoursIndependent
   *   @param {string} payload.college
   *   @param {string} payload.majorStatus   - "Undeclared" or major name
   *   @param {string} payload.classLevel    - FR | SO | JR | SR
   *   @param {string} [payload.petitionId]  - present on resubmission
   */
  function submit(payload, user, roles) {
    payload = payload || {};
    const termCode = String(payload.termCode || payload.term || '').trim();
    if (!termCode) throw new Error('Select a term.');
    const course  = String(payload.course || '').trim();
    if (!course) throw new Error('Select a course.');
    const sponsorEmail = String(payload.sponsorEmail || '').trim();
    const title   = String(payload.title || '').trim();
    const courseDescription = String(payload.courseDescription || '').trim();
    const workToBeSubmitted = String(payload.workToBeSubmitted || '').trim();

    if (!sponsorEmail) throw new Error('Select a faculty sponsor.');
    if (!courseDescription) throw new Error('A description of the proposed course is required.');
    if (!workToBeSubmitted) throw new Error('A description of the work to be submitted is required.');
    if (!_isEligibleSponsor(sponsorEmail)) {
      throw new Error('That person is not currently eligible to sponsor an individual study.');
    }
    // Grade option is the student's choice, set at submission.
    const gradeOption = _requireOneOf(payload.gradeOption, GRADE_OPTIONS, 'Grade option');

    // The term must have an imported schedule, and the course must be one of
    // this module's undergrad courses present in that term's schedule. The
    // course's credit value comes from the schedule — not typed, not coded.
    const offered = _coursesForTerm(termCode);
    const match = offered.find(c => String(c.course).trim().toUpperCase() === course.toUpperCase());
    if (!match) {
      throw new Error('That course is not available for the selected term. The schedule may not be imported yet.');
    }
    const credits = match.credits;            // intrinsic to the course (from schedule)
    const decoded = ClassSchedule.decodeTermCode(termCode);

    // SR 760: total weekly hours are fixed by credits + term length; the
    // student sets only the with-sponsor portion, the rest is independent.
    const _hoursSplit = _resolveHoursSplit(payload.hoursWithSponsor, credits, termCode);

    const profile = Auth.getProfile(user);
    if (!profile) throw new Error('Your profile could not be found.');
    if (!profile.studentId) {
      throw new Error('Your profile has no Student ID on file. Contact the department to add one before submitting.');
    }

    const fields = {
      TermCode: termCode,
      Quarter: decoded.quarter, Year: decoded.year,   // derived, for display
      Course: course,
      Credits: String(credits),                       // derived from the course
      SponsorEmail: sponsorEmail,
      StudySiteAddress: String(payload.studySiteAddress || '').trim(),
      Title: title,
      CourseDescription: courseDescription,
      EvidenceOfPreparation: String(payload.evidenceOfPreparation || '').trim(),
      WorkToBeSubmitted: workToBeSubmitted,
      GradeOption: gradeOption,
      ReportRequired: _boolStr(payload.reportRequired),
      ReportDueDate: String(payload.reportDueDate || '').trim(),
      HoursWithSponsor: String(_hoursSplit.withSponsor),
      HoursIndependent: String(_hoursSplit.independent),
      College: String(payload.college || '').trim(),
      MajorStatus: String(payload.majorStatus || '').trim(),
      ClassLevel: String(payload.classLevel || '').trim(),
    };

    const existingId = String(payload.petitionId || '').trim();

    // ── Resubmission: must be the caller's own RETURNED record ──
    if (existingId) {
      const rec = _byId(existingId);
      if (!rec) throw new Error('Petition not found: ' + existingId);
      if (_norm(rec.StudentEmail) !== _norm(user)) {
        throw new Error('You can only resubmit your own petition.');
      }
      if (rec.Stage !== STAGE.RETURNED) {
        throw new Error('This petition is not awaiting resubmission.');
      }

      DataService.update(SHEET(), TAB(), 'PetitionID', existingId, Object.assign({}, fields, {
        Stage: STAGE.SUBMITTED,
        ReturnNote: '',
      }));

      // Optional syllabus (replace-in-place keeps the same Drive file id).
      _maybeSaveSyllabus(existingId, payload, user);

      Tasks.resolveForSource(MODULE, existingId, { resolvedBy: user });
      _routeToSponsor(existingId, sponsorEmail, profile, course, /*resubmitted*/ true);
      EventBus.emit(MODULE + '.resubmitted', { recordId: existingId, sponsorEmail: sponsorEmail }, { user: user });
      return { petitionId: existingId, stage: STAGE.SUBMITTED, resubmitted: true };
    }

    // ── New petition: enforce the four-part duplicate key ──
    _assertNoDuplicate(user, termCode, sponsorEmail, course);

    const petitionId = DataService.generateId('IS');
    DataService.insert(SHEET(), TAB(), Object.assign({
      PetitionID: petitionId,
      StudentEmail: user,
      Stage: STAGE.SUBMITTED,
      // Sponsor fields (set at sponsor stage; Credits is course-derived and
      // GradeOption is student-chosen, both supplied via fields below)
      SponsorComments: '',
      SponsorDecidedBy: '', SponsorDecidedAt: '',
      // Advisor fields (set at advisor stage)
      ClassNumber: '', ClassSection: '', ClassNumberSource: '',
      TotalSpecialStudyCredits: '', MajorAuthRequired: '', MajorAuthorized: '',
      AdvisorComments: '', AdvisorProcessedBy: '', AdvisorProcessedAt: '',
      // Drive (filled at COMPLETE)
      DriveFileID: '', DocumentLink: '', FileName: '',
      // Syllabus (optional, set below if supplied)
      SyllabusFileID: '', SyllabusLink: '', SyllabusName: '',
      ReturnNote: '',
    }, fields));

    // Optional syllabus upload.
    _maybeSaveSyllabus(petitionId, payload, user);

    _routeToSponsor(petitionId, sponsorEmail, profile, course, /*resubmitted*/ false);
    EventBus.emit(MODULE + '.submitted', { recordId: petitionId, sponsorEmail: sponsorEmail }, { user: user });
    return { petitionId: petitionId, stage: STAGE.SUBMITTED };
  }

  /** Student withdraws their own non-terminal petition. */
  function withdraw(payload, user, roles) {
    const rec = _byId((payload || {}).petitionId);
    if (!rec) throw new Error('Petition not found.');
    const isSuper = roles.includes('super_admin');
    if (!isSuper && _norm(rec.StudentEmail) !== _norm(user)) {
      throw new Error('You can only withdraw your own petition.');
    }
    if (rec.Stage === STAGE.COMPLETE) {
      throw new Error('A completed petition cannot be withdrawn. Contact the undergraduate advisor.');
    }
    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user, note: 'Withdrawn' });
    DataService.remove(SHEET(), TAB(), 'PetitionID', rec.PetitionID);
    EventBus.emit(MODULE + '.withdrawn', { recordId: rec.PetitionID }, { user: user });
    return { withdrawn: true };
  }

  /**
   * Permanently deletes a petition: resolves its open tasks, trashes its
   * generated PDF and its syllabus (both best-effort), and removes the row.
   * super_admin only, any stage. Built for clearing test/mistaken records;
   * irreversible, so the UI confirms before calling. Audit-log entries are
   * deliberately left intact (append-only history).
   */
  function deletePetition(payload, user, roles) {
    if (roles.indexOf('super_admin') === -1) {
      throw new Error('Only a super admin can delete a petition.');
    }
    const rec = _byId(String((payload || {}).petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');

    // Clear dashboard pointers first so nothing references a gone record.
    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    // The room-access task uses a distinct source id; resolve it too.
    Tasks.resolveForSource(MODULE, _roomAccessSourceId(rec.PetitionID), { resolvedBy: user });

    // Trash both Drive files if present; a missing file must not block deletion.
    [rec.DriveFileID, rec.SyllabusFileID].forEach(fid => {
      const id = String(fid || '').trim();
      if (!id) return;
      try { DriveApp.getFileById(id).setTrashed(true); }
      catch (err) { Logger.log('deletePetition: could not trash file ' + id + ' (' + err + ')'); }
    });

    const removed = DataService.remove(SHEET(), TAB(), 'PetitionID', rec.PetitionID);
    if (!removed) throw new Error('Delete failed — the record could not be removed.');

    EventBus.emit(MODULE + '.deleted', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, deleted: true };
  }


  // ============================================================
  // SPONSOR ACTIONS
  // ============================================================

  /** Petitions awaiting the caller's sponsor decision (SUBMITTED, theirs). */
  function sponsorQueue(payload, user, roles) {
    const isSuper = roles.includes('super_admin');
    return DataService.query(SHEET(), TAB(), 'Stage', STAGE.SUBMITTED)
      .filter(r => isSuper || _norm(r.SponsorEmail) === _norm(user))
      .map(_publicRecord)
      .sort(_byCreatedDesc);
  }

  /** Petitions the caller has sponsored, at any stage, newest first. */
  function sponsored(payload, user, roles) {
    return DataService.query(SHEET(), TAB(), 'SponsorEmail', user)
      .map(_publicRecord)
      .sort(_byCreatedDesc);
  }

  /**
   * Sponsor records the instructor-approval decision: grade option (and may
   * revise the two description fields, and optionally attach a syllabus),
   * then approves. Credits are NOT set here — they are intrinsic to the
   * course (from the schedule) and were recorded at submission. Advances to
   * PENDING_ADVISOR.
   */
  function sponsorApprove(payload, user, roles) {
    const rec = _byId((payload || {}).petitionId);
    if (!rec) throw new Error('Petition not found.');
    _assertSponsor(rec, user, roles);
    if (rec.Stage !== STAGE.SUBMITTED) throw new Error('This petition is not awaiting a sponsor decision.');

    // The sponsor may edit the two description fields; preserve existing
    // text when not supplied. Grade option is the student's choice and is
    // not changed here; credits are intrinsic to the course.
    const courseDescription = payload.courseDescription !== undefined
      ? String(payload.courseDescription || '').trim() : rec.CourseDescription;
    const workToBeSubmitted = payload.workToBeSubmitted !== undefined
      ? String(payload.workToBeSubmitted || '').trim() : rec.WorkToBeSubmitted;

    // The sponsor may adjust the hours split (with-sponsor vs independent);
    // the SR 760 total stays locked to the course credits + term. If they
    // don't supply a value, the student's split is kept.
    const hoursPatch = {};
    if (payload.hoursWithSponsor !== undefined) {
      const split = _resolveHoursSplit(payload.hoursWithSponsor, rec.Credits, rec.TermCode);
      hoursPatch.HoursWithSponsor = String(split.withSponsor);
      hoursPatch.HoursIndependent = String(split.independent);
    }

    // The written-report requirement is the sponsor's to set (the student
    // never sees it; it first appears on the completed PDF). If a template
    // carried a value onto the petition, it's pre-checked for the sponsor.
    const reportPatch = {};
    if (payload.reportRequired !== undefined) {
      const req = payload.reportRequired === true || payload.reportRequired === 'true';
      reportPatch.ReportRequired = req ? 'TRUE' : '';
      reportPatch.ReportDueDate = req ? String(payload.reportDueDate || '').trim() : '';
    }

    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, Object.assign({
      SponsorComments: String(payload.comments || '').trim(),
      CourseDescription: courseDescription,
      WorkToBeSubmitted: workToBeSubmitted,
      SponsorDecidedBy: user,
      SponsorDecidedAt: new Date().toISOString(),
      Stage: STAGE.PENDING_ADVISOR,
    }, hoursPatch, reportPatch));

    // Sponsor may attach/replace the syllabus as part of their review.
    _maybeSaveSyllabus(rec.PetitionID, payload, user);

    // Sponsor may request room/lab-space access at approval (checkbox + room).
    if (payload.requestRoomAccess === true) {
      _fireRoomAccessRequest(_byId(rec.PetitionID), user, payload.roomAccessRoom, payload.roomAccessNote);
    }

    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    _routeToAdvisor(rec.PetitionID, rec);
    EventBus.emit(MODULE + '.sponsor_approved', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.PENDING_ADVISOR };
  }

  /** Sponsor returns the petition to the student for revision. */
  function sponsorReturn(payload, user, roles) {
    const rec = _byId((payload || {}).petitionId);
    if (!rec) throw new Error('Petition not found.');
    _assertSponsor(rec, user, roles);
    if (rec.Stage !== STAGE.SUBMITTED) throw new Error('This petition is not awaiting a sponsor decision.');

    const note = String((payload || {}).note || '').trim();
    if (!note) throw new Error('Add a note telling the student what to revise.');

    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
      Stage: STAGE.RETURNED,
      ReturnNote: note,
    });

    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    _routeToStudent(rec.PetitionID, rec, note);
    EventBus.emit(MODULE + '.returned', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.RETURNED };
  }

  /**
   * Sponsor requests (or updates) room/lab-space access for a petition,
   * from the detail view, at any stage. Re-requesting replaces the prior
   * facilities task and re-notifies with the corrected room. super_admin
   * may also trigger it. The room/space is required so facilities can act.
   */
  function requestRoomAccess(payload, user, roles) {
    const rec = _byId((payload || {}).petitionId);
    if (!rec) throw new Error('Petition not found.');
    if (roles.indexOf('super_admin') === -1 && _norm(rec.SponsorEmail) !== _norm(user)) {
      throw new Error('Only the petition\'s faculty sponsor can request room access.');
    }
    const room = String((payload || {}).roomAccessRoom || '').trim();
    if (!room) throw new Error('Enter the room or lab space access is needed for.');
    _fireRoomAccessRequest(rec, user, room, (payload || {}).roomAccessNote);
    return { petitionId: rec.PetitionID, roomAccessRequested: true, room: room };
  }


  // ============================================================
  // ADVISOR ACTIONS
  // ============================================================

  /** Petitions awaiting advisor processing (PENDING_ADVISOR). */
  function advisorQueue(payload, user, roles) {
    _assertAdvisor(roles);
    return DataService.query(SHEET(), TAB(), 'Stage', STAGE.PENDING_ADVISOR)
      .map(_publicRecord)
      .sort(_byCreatedDesc);
  }

  /**
   * Every petition at any stage, newest first — the undergraduate advisor's
   * (staff_undergrad) management/history view, and where super_admin reaches
   * completed petitions to delete. Search/filter/sort happen client-side on
   * this full list. Advisor role-holders and super_admin only.
   */
  function allPetitions(payload, user, roles) {
    _assertAdvisor(roles);
    return DataService.getAll(SHEET(), TAB())
      .map(_publicRecord)
      .sort(_byCreatedDesc);
  }

  /**
   * Advisor (or super_admin) nudges whoever a petition is currently waiting
   * on: the sponsor (SUBMITTED), the undergraduate advisor pool
   * (PENDING_ADVISOR), or the student (RETURNED). A deliberate manual
   * reminder always goes out. Mirrors the thesis module's remindResponsible.
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
      subject: 'Reminder: individual study awaiting your action',
      body: 'A reminder from ' + who + ': the ' + rec.Course + ' individual-studies petition for ' +
        _studentLabel(rec.StudentEmail) + ' is waiting for you to ' + ask + '.\n\n' +
        'Open it in the portal: ' + _deepLink(rec.PetitionID),
      replyTo: Settings.replyTo('individual_studies'),   // module reply-to (Admin → settings); falls back to CONFIG.DEFAULT_REPLY_TO
    });
    EventBus.emit(MODULE + '.reminded', { recordId: rec.PetitionID, remindedTo: to }, { user: user });
    return { petitionId: rec.PetitionID, remindedTo: to };
  }

  /**
   * Decision-support context for one petition at the advisor stage:
   *   - the auto-prefilled pre-assigned class number (sponsor+course match)
   *   - the unassigned pool and reassignable numbers if no pre-assignment
   *   - the student's other individual-studies petitions this term, the
   *     running special-study credit total, and the >7 flag
   */
  function advisorContext(payload, user, roles) {
    _assertAdvisor(roles);
    const rec = _byId((payload || {}).petitionId);
    if (!rec) throw new Error('Petition not found.');
    return _advisorContext(rec, String((payload || {}).course || '').trim());
  }

  /**
   * Advisor completes the petition: records the class number (confirmed
   * prefill, pool pick, or reassignment), the major-authorization decision
   * if required, generates the canonical PDF, and marks COMPLETE.
   *
   * @param {Object} payload
   *   @param {string} payload.petitionId
   *   @param {string} payload.classNumber       - the assigned/relayed number
   *   @param {string} [payload.classSection]     - the source section, if any
   *   @param {string} [payload.classNumberSource]- preassigned|pool|reassigned
   *   @param {boolean} [payload.confirmReassign] - required for a reassignment
   *   @param {boolean} [payload.majorAuthorized] - required when total > 7
   *   @param {string} [payload.comments]
   */
  function advisorComplete(payload, user, roles) {
    _assertAdvisor(roles);
    payload = payload || {};
    const rec = _byId(payload.petitionId);
    if (!rec) throw new Error('Petition not found.');
    if (rec.Stage !== STAGE.PENDING_ADVISOR) throw new Error('This petition is not awaiting advisor processing.');

    const classNumber = String(payload.classNumber || '').trim();
    if (!classNumber) throw new Error('A class number is required to complete the petition.');

    const source = String(payload.classNumberSource || '').trim();
    if (source === 'reassigned' && payload.confirmReassign !== true) {
      throw new Error('Reassigning a class number listed under another instructor requires confirmation.');
    }

    // Optional course correction (e.g. a field study filed as a tutorial and
    // not caught by the sponsor). The credit level is the anchor: only a
    // course offered this term at the petition's credit value may be
    // substituted, so credits, the SR 760 hours split, and the over-cap math
    // are all unchanged. A credit-level change is a return to the sponsor,
    // not a correction. The change itself is traced by the audit log (the
    // dispatch payload) and a courtesy email to the sponsor below.
    const originalCourse = String(rec.Course || '').trim();
    let course = String(payload.course || '').trim() || originalCourse;
    const courseChanged = course.toUpperCase() !== originalCourse.toUpperCase();
    if (courseChanged) {
      const allowed = _sameCreditCourses(_recTerm(rec), _toNum(rec.Credits), originalCourse)
        .find(c => String(c.course).trim().toUpperCase() === course.toUpperCase());
      if (!allowed) {
        throw new Error('That course is not offered this term at ' + rec.Credits +
          ' credits. To change the credit level, return the petition to the sponsor.');
      }
      course = String(allowed.course).trim();   // canonical casing from the schedule
      // The corrected course must not collide with another of the student's
      // petitions on the (student, term, sponsor, course) duplicate key.
      const dup = DataService.query(SHEET(), TAB(), 'StudentEmail', rec.StudentEmail).find(r =>
        String(r.PetitionID) !== String(rec.PetitionID) &&
        _recTerm(r) === _recTerm(rec) &&
        _norm(r.SponsorEmail) === _norm(rec.SponsorEmail) &&
        String(r.Course).trim().toUpperCase() === course.toUpperCase() &&
        r.Stage !== STAGE.RETURNED);
      if (dup) {
        throw new Error('The student already has a ' + course + ' petition with this sponsor this term. ' +
          'Resolve that petition instead of correcting this one\'s course.');
      }
    }

    // Major-department authorization: compute the term total ACROSS the
    // student's petitions (this one's credits already recorded by the
    // sponsor). If over the cap, the advisor must authorize.
    const ctx = _advisorContext(rec);
    const overCap = ctx.creditTotal > SPECIAL_STUDY_CREDIT_CAP;
    if (overCap && payload.majorAuthorized !== true) {
      throw new Error('This student has ' + ctx.creditTotal + ' special-study credits this term (over ' +
        SPECIAL_STUDY_CREDIT_CAP + '). Department authorization is required to complete.');
    }

    const now = new Date().toISOString();
    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
      Course: course,
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

    // Generate the canonical PDF now that every block is filled. Failure
    // to generate must not strand the record in a half-completed state, so
    // it is best-effort and logged; the record is COMPLETE regardless and
    // the PDF can be regenerated.
    const finalRec = _byId(rec.PetitionID);
    let pdf = null;
    try {
      pdf = _generatePetitionPdf(finalRec, user);
      if (pdf && pdf.fileId) {
        DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
          DriveFileID: pdf.fileId, DocumentLink: pdf.url || '', FileName: pdf.fileName || '',
        });
        _grantStudentViewer(pdf.fileId, finalRec.StudentEmail);
      }
    } catch (e) {
      Logger.log('IndividualStudiesModule: PDF generation failed for ' + rec.PetitionID + ': ' + e);
    }

    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    _notifyComplete(finalRec, pdf);
    if (courseChanged) _notifySponsorCourseChanged(finalRec, originalCourse, user);
    EventBus.emit(MODULE + '.completed',
      { recordId: rec.PetitionID, courseChangedFrom: courseChanged ? originalCourse : '' }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.COMPLETE, documentLink: pdf ? pdf.url : '',
             course: course, courseChanged: courseChanged };
  }

  /** Advisor returns the petition to the sponsor, clearing the decision. */
  function advisorReturn(payload, user, roles) {
    _assertAdvisor(roles);
    const rec = _byId((payload || {}).petitionId);
    if (!rec) throw new Error('Petition not found.');
    if (rec.Stage !== STAGE.PENDING_ADVISOR) throw new Error('This petition is not awaiting advisor processing.');

    const note = String((payload || {}).note || '').trim();
    if (!note) throw new Error('Add a note telling the sponsor what to reconsider.');

    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
      Stage: STAGE.SUBMITTED,
      SponsorComments: '',
      SponsorDecidedBy: '', SponsorDecidedAt: '',
      ReturnNote: note,
    });

    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    _routeToSponsor(rec.PetitionID, rec.SponsorEmail, Auth.getProfile(rec.StudentEmail) || {}, rec.Course, /*resubmitted*/ false, note);
    EventBus.emit(MODULE + '.advisor_returned', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.SUBMITTED };
  }


  // ============================================================
  // CLASS-SCHEDULE IMPORT (advisor admin) — thin wrappers over the service
  // ============================================================

  function importPreview(payload, user, roles) {
    _assertAdvisor(roles);
    return ClassSchedule.parsePreview(payload);
  }

  function importResolve(payload, user, roles) {
    _assertAdvisor(roles);
    return ClassSchedule.resolveUnmatched(payload);
  }

  function importCommit(payload, user, roles) {
    _assertAdvisor(roles);
    return ClassSchedule.commit(payload, user);
  }

  function importHistory(payload, user, roles) {
    _assertAdvisor(roles);
    return ClassSchedule.importHistory();
  }


  // ============================================================
  // PRIVATE — routing (Tasks + Notify)
  // ============================================================

  function _routeToSponsor(petitionId, sponsorEmail, studentProfile, course, resubmitted, advisorNote) {
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: petitionId,
      label: 'Individual study awaiting sponsor review',
      assignedTo: sponsorEmail,
    });
    const studentName = studentProfile && (studentProfile.name || studentProfile.email) || 'A student';
    const lines = [
      (resubmitted ? studentName + ' has revised and resubmitted' : studentName + ' has submitted') +
        ' an individual-studies petition for ' + course + '.',
    ];
    if (advisorNote) lines.push('', 'Advisor note: ' + advisorNote);
    lines.push('', 'Review it in the portal: ' + _deepLink(petitionId));
    Notify.send({
      to: sponsorEmail,
      subject: 'Individual study awaiting your review',
      body: lines.join('\n'),
      replyTo: Settings.replyTo('individual_studies'),   // module reply-to (Admin → settings); falls back to CONFIG.DEFAULT_REPLY_TO
    });
  }

  function _routeToAdvisor(petitionId, rec) {
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: petitionId,
      label: 'Individual study awaiting class number',
      assignedRole: ADVISOR_ROLE,
    });
    const to = Notify.resolveRecipients({
      superAdmins: [], explicit: _advisorEmails(),
    });
    if (to.length) {
      Notify.send({
        to: to,
        subject: 'Individual study awaiting class number',
        body: 'A ' + rec.Course + ' petition has been approved by its sponsor and is ready for a class number.\n\n' +
              'Process it in the portal: ' + _deepLink(petitionId),
        replyTo: Settings.replyTo('individual_studies'),   // module reply-to (Admin → settings); falls back to CONFIG.DEFAULT_REPLY_TO
      });
    }
  }

  /**
   * Records a room-access request on the petition and notifies facilities.
   * Idempotent on re-request: resolves any prior room-access task for this
   * petition first (distinct source id, so the workflow's own task is
   * untouched), then creates a fresh one and re-emails with the current
   * room. Best-effort — a notify failure must not break the calling action.
   */
  function _fireRoomAccessRequest(rec, user, room, note) {
    room = String(room || '').trim();
    note = String(note || '').trim();
    try {
      DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
        RoomAccessRequested: 'TRUE',
        RoomAccessRoom: room,
        RoomAccessNote: note,
        RoomAccessRequestedBy: user,
        RoomAccessRequestedAt: new Date().toISOString(),
      });

      const sourceId = _roomAccessSourceId(rec.PetitionID);
      // Replace any prior request task so a re-request doesn't stack.
      Tasks.resolveForSource(MODULE, sourceId, { resolvedBy: user, note: 'Superseded by updated request' });
      Tasks.create({
        module: MODULE, sourceType: ROOM_ACCESS_SOURCE_TYPE, sourceId: sourceId,
        label: 'Room access requested: ' + rec.Course + (room ? ' — ' + room : ''),
        assignedRole: FACILITIES_ROLE,
      });

      const to = Notify.resolveRecipients({ superAdmins: [], explicit: _facilitiesEmails() });
      if (to.length) {
        const student = _studentLabel(rec.StudentEmail);
        const lines = [
          'A faculty sponsor has requested room/lab-space access for an individual study.',
          '',
          'Student: ' + student,
          'Course: ' + rec.Course,
          'Term: ' + _termLabel(rec),
          'Space: ' + (room || '(not specified)'),
        ];
        if (note) lines.push('Note: ' + note);
        if (rec.ClassNumber) lines.push('Class number: ' + rec.ClassNumber);
        lines.push('Requested by: ' + (_facultyLabel(user) || user));
        lines.push('', 'Petition: ' + _deepLink(rec.PetitionID));
        Notify.send({ to: to, subject: 'Room access requested — ' + rec.Course, body: lines.join('\n'), replyTo: Settings.replyTo('individual_studies') });
      }
    } catch (e) {
      Logger.log('IndividualStudiesModule._fireRoomAccessRequest failed for ' + rec.PetitionID + ': ' + e);
    }
  }

  /** Active staff_facilities holders' emails. */
  function _facilitiesEmails() {
    return Auth.listUsers()
      .filter(u => u.active && (u.roles || []).indexOf(FACILITIES_ROLE) !== -1)
      .map(u => u.email);
  }


  function _routeToStudent(petitionId, rec, note) {
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: petitionId,
      label: 'Your individual study needs revisions',
      assignedTo: rec.StudentEmail,
    });
    Notify.send({
      to: rec.StudentEmail,
      subject: 'Your individual-studies petition was returned',
      body: _fillNotifyTokens(_notifyTemplate('NOTIFY_RETURNED'), rec) + '\n\n' +
            'What to revise: ' + note + '\n\n' +
            'Revise and resubmit in the portal: ' + _deepLink(petitionId),
      replyTo: Settings.replyTo('individual_studies'),   // module reply-to (Admin → settings); falls back to CONFIG.DEFAULT_REPLY_TO
    });
  }

  function _notifyComplete(rec, pdf) {
    const link = (pdf && pdf.url) ? pdf.url : (rec.DocumentLink || '');
    const lines = [
      _fillNotifyTokens(_notifyTemplate('NOTIFY_COMPLETE'), rec),
      '',
      'Class number: ' + (rec.ClassNumber || '(see portal)'),
      'Enroll in this course in MyUCSC using the class number above.',
    ];
    if (String(rec.AdvisorComments || '').trim()) {
      lines.push('', 'Note from the undergraduate advisor:', String(rec.AdvisorComments).trim());
    }
    if (link) lines.push('', 'Your completed petition (PDF): ' + link);
    Notify.send({
      to: rec.StudentEmail,
      subject: 'Your individual-studies petition is complete',
      body: lines.join('\n'),
      replyTo: Settings.replyTo('individual_studies'),   // module reply-to (Admin → settings); falls back to CONFIG.DEFAULT_REPLY_TO
    });
  }

  // ── Notification-template plumbing (Settings tab) ──

  /** The effective template for a key: saved value, else the default. */
  function _notifyTemplate(key) {
    const v = String(_readSettings()[key] || '').trim();
    return v || NOTIFY_DEFAULTS[key] || '';
  }

  /** Fills {FirstName} and {Course} from the petition + profile. */
  function _fillNotifyTokens(tmpl, rec) {
    const profile = Auth.getProfile(rec.StudentEmail);
    const firstName = profile ? (profile.firstName || profile.name || '') : '';
    return String(tmpl || '')
      .replace(/\{FirstName\}/g, firstName)
      .replace(/\{Course\}/g, rec.Course || '');
  }

  /** Key/value read with defaults — works even before the tab exists. */
  function _readSettings() {
    const out = {};
    Object.keys(NOTIFY_DEFAULTS).forEach(k => { out[k] = NOTIFY_DEFAULTS[k]; });
    try {
      DataService.getAll(SHEET(), SETTINGS_TAB()).forEach(r => {
        const k = String(r.Key || '').trim();
        if (k) out[k] = String(r.Value != null ? r.Value : '');
      });
    } catch (e) { Logger.log('IndividualStudiesModule._readSettings failed: ' + e); }
    return out;
  }

  function _writeSetting(key, value) {
    const existing = DataService.query(SHEET(), SETTINGS_TAB(), 'Key', key);
    if (existing.length) {
      DataService.update(SHEET(), SETTINGS_TAB(), 'Key', key, { Value: value });
    } else {
      DataService.insert(SHEET(), SETTINGS_TAB(), { Key: key, Value: value });
    }
  }

  /** Settings for the advisor's Settings tab. Advisor or super_admin. */
  function getSettings(payload, user, roles) {
    _assertAdvisor(roles);
    return _readSettings();
  }

  /** Saves the notification templates. Only known keys are written; a key
   *  absent from the payload is left untouched. Advisor or super_admin. */
  function saveSettings(payload, user, roles) {
    _assertAdvisor(roles);
    payload = payload || {};
    Object.keys(NOTIFY_DEFAULTS).forEach(key => {
      if (payload[key] === undefined) return;
      _writeSetting(key, String(payload[key]));
    });
    return _readSettings();
  }

  /**
   * Courtesy note to the sponsor when the advisor corrected the course at
   * completion. Their approval is on the record, so they should know what
   * it now says. Best-effort — a notify failure must never break the
   * completion (Notify.send already never throws, but keep the guard).
   */
  function _notifySponsorCourseChanged(rec, fromCourse, user) {
    try {
      Notify.send({
        to: rec.SponsorEmail,
        subject: 'Course corrected on a completed individual study',
        body: 'While completing the individual-studies petition for ' + _studentLabel(rec.StudentEmail) +
          ', the undergraduate advisor corrected the course from ' + fromCourse + ' to ' + rec.Course + '.\n\n' +
          'Credits, grade option, and weekly hours are unchanged.\n\n' +
          'Corrected by: ' + (_facultyLabel(user) || user) + '\n' +
          'Petition: ' + _deepLink(rec.PetitionID),
        replyTo: Settings.replyTo('individual_studies'),
      });
    } catch (e) {
      Logger.log('IndividualStudiesModule._notifySponsorCourseChanged failed for ' + rec.PetitionID + ': ' + e);
    }
  }


  // ============================================================
  // PRIVATE — advisor decision context (credit total + class-number options)
  // ============================================================

  /**
   * @param {Object} rec - the petition row
   * @param {string} [courseOverride] - a candidate corrected course; the
   *   section/preassignment lookups run against it so the advisor can
   *   preview a correction before completing. Credits always stay the
   *   petition's own (corrections are credit-matched by design).
   */
  function _advisorContext(rec, courseOverride) {
    const term = _recTerm(rec);
    const credits = _toNum(rec.Credits);
    const course = String(courseOverride || '').trim() || rec.Course;

    // The student's individual-studies petitions for this term (this module
    // only — the grad/thesis credit picture is out of scope here).
    const studentTermPetitions = DataService.query(SHEET(), TAB(), 'StudentEmail', rec.StudentEmail)
      .filter(r => _recTerm(r) === term && r.Stage !== STAGE.RETURNED);

    let creditTotal = 0;
    const others = [];
    studentTermPetitions.forEach(r => {
      const c = _toNum(r.Credits);
      creditTotal += c;
      if (String(r.PetitionID) !== String(rec.PetitionID)) {
        others.push({
          petitionId: r.PetitionID, course: r.Course, credits: c,
          stage: r.Stage, sponsorName: _facultyLabel(r.SponsorEmail),
        });
      }
    });

    // Class-number options from the ClassSchedule service, for the
    // EFFECTIVE course (the petition's own, or the candidate correction).
    let preassigned = null, allSections = [], sectionsMatchedCredits = true;
    try {
      const pre = ClassSchedule.findPreassigned(term, course, rec.SponsorEmail);
      preassigned = pre ? _classRow(pre) : null;

      // The authoritative menu: every section for this course at the
      // petition's credit value, unassigned (Staff) sections first/
      // highlighted. Falls back to all course sections (flagged) if none
      // match the credit value, so the advisor is never stuck.
      const res = ClassSchedule.sectionsForCourse(term, course, { units: credits });
      sectionsMatchedCredits = res.matchedCredits;
      allSections = (res.sections || []).map(_sectionRow);
    } catch (e) {
      Logger.log('IndividualStudiesModule._advisorContext: ClassSchedule lookup failed: ' + e);
    }

    return {
      term: term,
      termLabel: _termLabel(rec),
      credits: credits,
      course: course,
      courseOptions: _sameCreditCourses(term, credits, rec.Course),
      creditTotal: creditTotal,
      creditCap: SPECIAL_STUDY_CREDIT_CAP,
      overCap: creditTotal > SPECIAL_STUDY_CREDIT_CAP,
      otherPetitions: others,
      preassigned: preassigned,
      sections: allSections,
      sectionsMatchedCredits: sectionsMatchedCredits,
    };
  }

  function _classRow(r) {
    return {
      classNbr: r.ClassNbr, section: r.Section, course: r.Course,
      instructorRaw: r.InstructorRaw, instructorEmail: r.InstructorEmail,
      instructorName: r.InstructorEmail ? _facultyLabel(r.InstructorEmail) : (r.InstructorRaw || 'Staff'),
      matchMethod: r.MatchMethod,
    };
  }

  /**
   * Shape an annotated section (from ClassSchedule.sectionsForCourse) for
   * the advisor's unified pick list. isStaff/isAssigned drive the UI
   * highlight (unassigned = ready to take; assigned = relay/reassign).
   */
  function _sectionRow(s) {
    return {
      classNbr: s.classNbr, section: s.section, units: s.units,
      instructorRaw: s.instructorRaw, instructorEmail: s.instructorEmail,
      instructorName: s.instructorEmail ? _facultyLabel(s.instructorEmail) : (s.instructorRaw || 'Staff'),
      isStaff: s.isStaff, isAssigned: s.isAssigned,
      matchMethod: s.matchMethod,
    };
  }

  /**
   * Courses the advisor may correct this petition to: those offered in the
   * term (module allowlist) with at least one section at the petition's
   * credit value. The petition's own course is always included. The credit
   * level is the anchor by design — same credits means the SR 760 hours
   * split and the over-cap math are untouched; changing the credit level
   * is a return-to-sponsor, not a correction.
   */
  function _sameCreditCourses(term, credits, currentCourse) {
    const cur = String(currentCourse || '').trim().toUpperCase();
    return _coursesForTerm(term).filter(c => {
      const name = String(c.course || '').trim();
      if (name.toUpperCase() === cur) return true;
      try {
        return ClassSchedule.sectionsForCourse(term, name, { units: credits }).matchedCredits === true;
      } catch (e) {
        return false;
      }
    }).map(c => ({ course: c.course, title: c.title || '' }));
  }


  // ============================================================
  // PRIVATE — PDF generation (campus form layout, at COMPLETE)
  // ============================================================

  function _generatePetitionPdf(rec, user) {
    const student = Auth.getProfile(rec.StudentEmail) || {};
    const html = _petitionHtml(rec, student);
    const fileName = _buildFileName(rec, student);
    return ReportService.generate({
      module: MODULE,
      reportKey: 'petition',
      title: 'Individual Studies Petition — ' + (student.name || rec.StudentEmail),
      sourceId: rec.PetitionID,
      params: { petitionId: rec.PetitionID, term: _recTerm(rec), course: rec.Course },
      html: html,
      fileName: fileName,
      orientation: 'portrait',
      letterhead: false,        // self-contained campus-form layout
      footerText: '',
    }, user);
  }

  /**
   * Filename: <Year>-<Quarter>_<StudentID>-IS-<CourseToken>_Last-First.pdf
   * e.g. 2025-Fall_1234567-IS-ANTH199_Oelze... no — Last-First is the student.
   */
  function _buildFileName(rec, student) {
    const courseToken = String(rec.Course || '').replace(/\s+/g, '');
    const last = (student.lastName || '').trim() || 'Student';
    const first = (student.firstName || '').trim() || '';
    const who = first ? (last + '-' + first) : last;
    return rec.Year + '-' + rec.Quarter + '_' + (student.studentId || 'NOID') +
           '-IS-' + courseToken + '_' + who + '.pdf';
  }

  /**
   * Renders the petition as HTML mirroring the campus form's structure:
   * student block, course block, the three approval blocks (instructor /
   * course-sponsoring-agency / major-department), with name/email/timestamp
   * in lieu of each signature. Single populated line per approval block
   * (one study per petition). Table-based layout for the HTML->Doc->PDF
   * pipeline (ReportService notes nested layout tables are fragile, so this
   * keeps top-level tables simple).
   */
  function _petitionHtml(rec, student) {
    const navy = (CONFIG.BRAND && CONFIG.BRAND.NAVY) || '#003C6C';
    const e = _esc;
    const studentName = student.name || rec.StudentEmail;
    const sponsorName = _facultyLabel(rec.SponsorEmail);
    const advisorName = rec.AdvisorProcessedBy ? _facultyLabel(rec.AdvisorProcessedBy) : '';

    const row = (label, value) =>
      '<tr><td style="padding:3px 10px 3px 0;color:#555;white-space:nowrap;vertical-align:top;">' + e(label) +
      '</td><td style="padding:3px 0;vertical-align:top;">' + (value || '&mdash;') + '</td></tr>';

    const sig = (who, email, at) => {
      if (!who && !email) return '&mdash;';
      return e(who || email) + (email ? ' &lt;' + e(email) + '&gt;' : '') +
             (at ? '<br><span style="color:#777;font-size:9pt;">Approved ' + e(_fmtDate(at)) + '</span>' : '');
    };

    return ''
      + '<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:10pt;line-height:1.4;">'
      + '<div style="border-bottom:3px solid ' + navy + ';padding-bottom:8px;margin-bottom:12px;">'
      +   '<div style="font-size:9pt;color:#555;">University of California, Santa Cruz · Department of Anthropology</div>'
      +   '<div style="font-size:15pt;font-weight:bold;color:' + navy + ';">Petition for Undergraduate Individual Studies Course</div>'
      +   '<div style="font-size:8.5pt;color:#777;">Academic Senate, Santa Cruz Regulation 6.5, 9.1</div>'
      + '</div>'

      // Student / context block
      + '<table style="width:100%;border-collapse:collapse;margin-bottom:10px;">'
      +   row('Name', e(studentName))
      +   row('Student ID', e(student.studentId || ''))
      +   row('Email', e(rec.StudentEmail))
      +   row('College', e(rec.College))
      +   row('Status', e(rec.MajorStatus) + (rec.ClassLevel ? ' · ' + e(rec.ClassLevel) : ''))
      +   row('Quarter / Year', e(rec.Quarter) + ' ' + e(rec.Year))
      +   row('Course', e(rec.Course))
      +   row('Course sponsoring agency', 'Anthropology')
      +   row('Faculty sponsor', e(sponsorName))
      +   row('Study site address', e(rec.StudySiteAddress))
      + '</table>'

      // Proposed course
      + _block('Title and description of proposed course', e(rec.Title) +
          (rec.CourseDescription ? '<br><br>' + e(rec.CourseDescription) : ''))
      + _block('Evidence of preparation for special study', e(rec.EvidenceOfPreparation))
      + _block('Description of work to be submitted', e(rec.WorkToBeSubmitted))
      + (String(rec.SyllabusLink || '').trim()
          ? _block('Syllabus', '<a href="' + e(rec.SyllabusLink) + '">' +
              e(rec.SyllabusName || 'View syllabus') + '</a>')
          : '')

      + '<table style="width:100%;border-collapse:collapse;margin-bottom:10px;">'
      +   row('Written report required', _isTrueStr(rec.ReportRequired) ? 'Yes' : 'No')
      +   (_isTrueStr(rec.ReportRequired) && rec.ReportDueDate ? row('Report due', e(rec.ReportDueDate)) : '')
      +   row('Hours per week — with faculty sponsor', e(rec.HoursWithSponsor))
      +   row('Hours per week — independently', e(rec.HoursIndependent))
      + '</table>'

      // Student signature
      + _approvalBlock('Student', sig(studentName, rec.StudentEmail, rec.CreatedAt))

      // Instructor (sponsor) approval — credits + grade option
      + _approvalBlock('Instructor approval (faculty sponsor)',
          '<table style="width:100%;border-collapse:collapse;">'
          + row('Credits', e(rec.Credits))
          + row('Grade option', e(rec.GradeOption))
          + (rec.SponsorComments ? row('Comments', e(rec.SponsorComments)) : '')
          + row('Signed', sig(sponsorName, rec.SponsorEmail, rec.SponsorDecidedAt))
          + '</table>')

      // Course sponsoring agency approval — class number (advisor)
      + _approvalBlock('Course sponsoring agency approval',
          '<table style="width:100%;border-collapse:collapse;">'
          + row('Class number', e(rec.ClassNumber))
          + row('Course ID', e(rec.Course) + (rec.ClassSection ? ' · sec ' + e(rec.ClassSection) : ''))
          + row('Signed', sig(advisorName, rec.AdvisorProcessedBy, rec.AdvisorProcessedAt))
          + '</table>')

      // Major department approval — only meaningful when over the cap
      + _approvalBlock('Major department approval',
          '<table style="width:100%;border-collapse:collapse;">'
          + row('Total special-study credits', e(rec.TotalSpecialStudyCredits))
          + row('Authorization required', _isTrueStr(rec.MajorAuthRequired) ? 'Yes (over ' + SPECIAL_STUDY_CREDIT_CAP + ' credits)' : 'No')
          + (_isTrueStr(rec.MajorAuthRequired)
              ? row('Authorized by', sig(advisorName, rec.AdvisorProcessedBy, rec.AdvisorProcessedAt))
              : '')
          + '</table>')

      + '</div>';
  }

  function _block(label, value) {
    const navy = (CONFIG.BRAND && CONFIG.BRAND.NAVY) || '#003C6C';
    return '<div style="margin-bottom:10px;">'
      + '<div style="font-size:9pt;font-weight:bold;color:' + navy + ';text-transform:uppercase;letter-spacing:0.4px;">' + _esc(label) + '</div>'
      + '<div style="padding:4px 0;">' + (value || '&mdash;') + '</div>'
      + '</div>';
  }

  function _approvalBlock(label, innerHtml) {
    const navy = (CONFIG.BRAND && CONFIG.BRAND.NAVY) || '#003C6C';
    return '<div style="border:1px solid #ccc;border-left:3px solid ' + navy + ';padding:8px 10px;margin-bottom:8px;">'
      + '<div style="font-size:9pt;font-weight:bold;color:' + navy + ';text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">' + _esc(label) + '</div>'
      + innerHtml
      + '</div>';
  }


  // ============================================================
  // PRIVATE — Drive student viewer grant (mirrors TranscriptModule)
  // ============================================================

  /**
   * Grants the student read access on a generated file WITHOUT Drive's own
   * "shared with you" email — the module's completion email already links
   * the PDF, so the extra Drive notification was noise. Uses the Advanced
   * Drive Service (already required by ReportService), handling both the
   * v3 (create/sendNotificationEmail) and v2 (insert/sendNotificationEmails)
   * shapes; falls back to DriveApp.addViewer (which does email) only if the
   * advanced service is somehow unavailable. Best-effort, never throws.
   */
  function _grantStudentViewer(fileId, studentEmail) {
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
      Logger.log('IndividualStudiesModule._grantStudentViewer: could not share ' + id + ' with ' + email + ': ' + e);
    }
  }


  // ============================================================
  // PRIVATE — eligibility, duplicate guard, record shaping, helpers
  // ============================================================

  /** Eligible sponsors: active holders of the SPONSOR_ROLE. Implemented
   *  with Auth.listUsers() (Auth exposes no usersWithRole helper). */
  function _eligibleSponsors() {
    return Auth.listUsers()
      .filter(u => u.active && (u.roles || []).indexOf(SPONSOR_ROLE) !== -1)
      .map(u => ({ email: u.email, name: u.nameLastFirst || u.name || u.email }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function _isEligibleSponsor(email) {
    const key = _norm(email);
    return _eligibleSponsors().some(s => _norm(s.email) === key);
  }

  /** Advisor (staff_undergrad) emails, active holders. */
  function _advisorEmails() {
    return Auth.listUsers()
      .filter(u => u.active && (u.roles || []).indexOf(ADVISOR_ROLE) !== -1)
      .map(u => u.email);
  }

  /**
   * Blocks an exact (student, term, instructor, course) duplicate, keyed on
   * the canonical term code. A RETURNED record on the same key is not a
   * duplicate (the student should resubmit it), so it is excluded.
   */
  function _assertNoDuplicate(student, termCode, sponsorEmail, course) {
    const dup = DataService.query(SHEET(), TAB(), 'StudentEmail', student).find(r =>
      _recTerm(r) === String(termCode).trim() &&
      _norm(r.SponsorEmail) === _norm(sponsorEmail) &&
      String(r.Course).trim() === String(course).trim() &&
      r.Stage !== STAGE.RETURNED);
    if (dup) {
      const label = ClassSchedule.decodeTermCode(termCode).label;
      throw new Error('You already have a ' + course + ' petition with this sponsor for ' +
        label + '. Use it rather than filing a duplicate.');
    }
  }

  function _publicRecord(r) {
    return {
      petitionId: r.PetitionID,
      studentEmail: r.StudentEmail,
      studentName: _studentLabel(r.StudentEmail),
      termCode: _recTerm(r),
      quarter: r.Quarter, year: r.Year,
      term: _termLabel(r),                 // human label for display
      course: r.Course,
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
      credits: r.Credits, gradeOption: r.GradeOption, sponsorComments: r.SponsorComments,
      sponsorDecidedAt: r.SponsorDecidedAt ? _fmtDate(r.SponsorDecidedAt) : '',
      classNumber: r.ClassNumber, classSection: r.ClassSection,
      totalSpecialStudyCredits: r.TotalSpecialStudyCredits,
      majorAuthRequired: _isTrueStr(r.MajorAuthRequired),
      majorAuthorized: _isTrueStr(r.MajorAuthorized),
      advisorComments: r.AdvisorComments,
      advisorName: r.AdvisorProcessedBy ? _facultyLabel(r.AdvisorProcessedBy) : '',
      advisorProcessedAt: r.AdvisorProcessedAt ? _fmtDate(r.AdvisorProcessedAt) : '',
      stage: r.Stage,
      documentLink: r.DocumentLink || '',
      syllabusLink: r.SyllabusLink || '',
      syllabusName: r.SyllabusName || '',
      roomAccessRequested: _isTrueStr(r.RoomAccessRequested),
      roomAccessRoom: r.RoomAccessRoom || '',
      roomAccessNote: r.RoomAccessNote || '',
      returnNote: r.ReturnNote || '',
      createdAt: r.CreatedAt ? _fmtDate(r.CreatedAt) : '',
      _created: r.CreatedAt ? new Date(r.CreatedAt).getTime() : 0,
    };
  }

  function _canView(rec, user, roles) {
    if (roles.includes('super_admin')) return true;
    if (_isAdvisor(roles)) return true;
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
    if (!_isAdvisor(roles)) throw new Error('Only the undergraduate advisor can perform this action.');
  }

  function _isAdvisor(roles) { return (roles || []).indexOf(ADVISOR_ROLE) !== -1; }

  function _byId(petitionId) {
    const id = String(petitionId || '').trim();
    if (!id) return null;
    const found = DataService.query(SHEET(), TAB(), 'PetitionID', id);
    return found && found.length ? found[0] : null;
  }

  function _studentLabel(email) {
    const p = Auth.getProfile(email);
    return p ? (p.nameLastFirst || p.name || email) : email;
  }

  function _facultyLabel(email) {
    if (!email) return '';
    const p = Auth.getProfile(email);
    return p ? (p.nameLastFirst || p.name || email) : email;
  }

  function _deepLink(petitionId) {
    let base = '';
    try { base = ScriptApp.getService().getUrl() || ''; } catch (e) { base = ''; }
    if (!base) return '(open the portal)';
    const sep = base.indexOf('?') === -1 ? '?' : '&';
    return base + sep + 'page=' + MODULE + '&focus=' + encodeURIComponent(petitionId);
  }

  // ── Term helpers (canonical key is the registrar term code) ──

  /** The record's canonical term code. Falls back to deriving from
   *  Quarter/Year for any legacy row written before TermCode existed. */
  function _recTerm(r) {
    const code = String(r.TermCode || '').trim();
    if (code) return code;
    return _encodeTermCode(r.Quarter, r.Year);   // legacy fallback
  }

  /** Human label for a record: prefer stored Quarter/Year, else decode. */
  function _termLabel(r) {
    const q = String(r.Quarter || '').trim();
    const y = String(r.Year || '').trim();
    if (q && y) return q + ' ' + y;
    return ClassSchedule.decodeTermCode(_recTerm(r)).label;
  }

  /** Encode Quarter/Year back to a term code (legacy-row fallback only). */
  function _encodeTermCode(quarter, year) {
    const q = { 'winter': '0', 'spring': '2', 'summer': '4', 'fall': '8' };
    const qd = q[String(quarter || '').trim().toLowerCase()];
    const y = String(year || '').trim();
    if (!qd || !/^\d{4}$/.test(y)) return '';
    return '2' + y.slice(2) + qd;     // 2025 -> "25", prefixed with century 2
  }

  /** Undergrad courses (with credits) offered in a term, from the schedule. */
  /**
   * Builds the UCSC catalog URL for a course from its token. The catalog
   * pages follow a fixed pattern keyed by the level band (the hundreds
   * bucket of the number) and the lowercased course slug, e.g.
   *   ANTH 197F -> .../courses/anth-anthropology/100/anth-197f
   *   ANTH 297  -> .../courses/anth-anthropology/200/anth-297
   * The F/G suffixes have their own catalog pages, so the slug is just the
   * full course number lowercased. Returns '' if the number can't be read.
   */
  function _catalogUrl(course) {
    const s = String(course || '').trim();
    const m = s.match(/^ANTH\s+(\d+)([A-Z]*)$/i);
    if (!m) return '';
    const band = Math.floor(Number(m[1]) / 100) * 100;
    const slug = 'anth-' + m[1] + (m[2] || '').toLowerCase();
    return 'https://catalog.ucsc.edu/en/current/general-catalog/courses/anth-anthropology/'
      + band + '/' + slug;
  }

  /** This module's undergrad courses present in a term's schedule, each with
   *  credits (and title) from the schedule. Empty if the term isn't imported. */
  function _coursesForTerm(termCode) {
    try {
      return ClassSchedule.coursesForTerm(termCode, { allowlist: COURSES })
        .filter(c => c.credits !== null && c.credits !== undefined);
    } catch (e) {
      Logger.log('IndividualStudiesModule._coursesForTerm failed: ' + e);
      return [];
    }
  }

  // ── Syllabus (optional supporting document) ──

  /**
   * Save an optional syllabus upload onto a petition, if one is present in
   * the payload (payload.syllabusBase64 + payload.syllabusName). Replace-in-
   * place: a re-upload reuses the existing Drive file id. Grants the student
   * viewer on the file. Best-effort — a syllabus failure never blocks the
   * submit/approve it rides along with; it is logged.
   */
  function _maybeSaveSyllabus(petitionId, payload, user) {
    const b64 = String((payload && payload.syllabusBase64) || '').trim();
    if (!b64) return;     // no syllabus supplied — nothing to do
    try {
      const rec = _byId(petitionId);
      if (!rec) return;
      const folderId = (CONFIG.INDIVIDUAL_STUDIES && CONFIG.INDIVIDUAL_STUDIES.DRIVE_FOLDER_ID) || '';
      if (!folderId) { Logger.log('IndividualStudiesModule: no syllabus folder configured.'); return; }

      const name = String(payload.syllabusName || ('syllabus-' + petitionId + '.pdf')).trim();
      const bytes = Utilities.base64Decode(b64);
      const blob = Utilities.newBlob(bytes, payload.syllabusMimeType || 'application/pdf', name);

      const existingId = String(rec.SyllabusFileID || '').trim();
      let file;
      if (existingId) {
        // Replace contents in place, keep the same file id.
        try {
          file = DriveApp.getFileById(existingId);
          file.setContent('');                 // clear; then overwrite via Drive
        } catch (e) { file = null; }
      }
      if (!file) {
        const folder = DriveApp.getFolderById(folderId);
        file = folder.createFile(blob);
      } else {
        // Overwrite by creating anew in the same folder and trashing the old,
        // since DriveApp can't replace bytes directly without Advanced Drive.
        const folder = DriveApp.getFolderById(folderId);
        const fresh = folder.createFile(blob);
        try { file.setTrashed(true); } catch (e) {}
        file = fresh;
      }
      file.setName(name);
      const fileId = file.getId();
      const link = 'https://drive.google.com/file/d/' + fileId + '/view';

      DataService.update(SHEET(), TAB(), 'PetitionID', petitionId, {
        SyllabusFileID: fileId, SyllabusLink: link, SyllabusName: name,
      });
      _grantStudentViewer(fileId, rec.StudentEmail);
    } catch (e) {
      Logger.log('IndividualStudiesModule._maybeSaveSyllabus failed for ' + petitionId + ': ' + e);
    }
  }

  function _requireOneOf(value, allowed, label) {
    const v = String(value || '').trim();
    if (allowed.indexOf(v) === -1) {
      throw new Error(label + ' must be one of: ' + allowed.join(', ') + '.');
    }
    return v;
  }

  function _byCreatedDesc(a, b) { return (b._created || 0) - (a._created || 0); }

  function _toNum(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function _boolStr(v) { return (v === true || v === 'true' || v === 'TRUE') ? 'TRUE' : 'FALSE'; }
  function _isTrueStr(v) { return String(v).toUpperCase() === 'TRUE'; }
  function _norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

  function _fmtDate(v) {
    if (!v) return '';
    const d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMM d, yyyy');
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Sponsor-owned templates ───────────────────────
  // A sponsor saves recurring study fields; on the New Petition form the
  // student picks a sponsor and that sponsor's templates appear, with the
  // IsDefault one auto-applied. super_admin may author on a sponsor's
  // behalf (transitional). Templates live in a sibling tab; credits/title
  // still resolve from the schedule at apply time.

  const TEMPLATE_FIELDS = ['Course', 'Title', 'CourseDescription', 'WorkToBeSubmitted',
    'EvidenceOfPreparation', 'GradeOption', 'HoursWithSponsor',
    'ReportRequired', 'ReportDueText', 'RoomAccessRoom'];

  function _templateRecord(r) {
    return {
      templateId: r.TemplateID,
      sponsorEmail: r.SponsorEmail,
      sponsorName: _facultyLabel(r.SponsorEmail) || r.SponsorEmail,
      name: r.Name || '(untitled)',
      isDefault: _isTrueStr(r.IsDefault),
      course: r.Course || '',
      title: r.Title || '',
      courseDescription: r.CourseDescription || '',
      workToBeSubmitted: r.WorkToBeSubmitted || '',
      evidenceOfPreparation: r.EvidenceOfPreparation || '',
      gradeOption: r.GradeOption || '',
      hoursWithSponsor: r.HoursWithSponsor || '',
      reportRequired: _isTrueStr(r.ReportRequired),
      reportDueText: r.ReportDueText || '',
      roomAccessRoom: r.RoomAccessRoom || '',
      active: _isTrueStr(r.Active),
    };
  }

  function _templateById(id) {
    const rows = DataService.query(SHEET(), TPL_TAB(), 'TemplateID', String(id || '').trim());
    return rows && rows.length ? rows[0] : null;
  }

  /** Owner check: the template's sponsor, or super_admin. */
  function _assertTemplateOwner(tplRow, user, roles) {
    if (roles.indexOf('super_admin') === -1 && _norm(tplRow.SponsorEmail) !== _norm(user)) {
      throw new Error('You can only manage your own templates.');
    }
  }

  /**
   * Lists templates. A sponsor sees their own; super_admin sees all (or one
   * sponsor's, if payload.sponsorEmail is given). Active and inactive both
   * returned so the owner can manage them.
   */
  function myTemplates(payload, user, roles) {
    const isSuper = roles.indexOf('super_admin') === -1 ? false : true;
    const all = DataService.getAll(SHEET(), TPL_TAB());
    let rows;
    if (isSuper) {
      const filter = _norm((payload || {}).sponsorEmail);
      rows = filter ? all.filter(r => _norm(r.SponsorEmail) === filter) : all;
    } else {
      if (roles.indexOf(SPONSOR_ROLE) === -1) {
        throw new Error('Only a faculty sponsor can manage templates.');
      }
      rows = all.filter(r => _norm(r.SponsorEmail) === _norm(user));
    }
    return rows.map(_templateRecord)
      .sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0)
        || String(a.name).localeCompare(String(b.name)));
  }

  /**
   * Active templates for one sponsor, for the student's New Petition form.
   * Read-only; any signed-in user may call it (they're choosing a sponsor).
   * Default first.
   */
  function templatesForSponsor(payload, user, roles) {
    const sponsor = _norm((payload || {}).sponsorEmail);
    if (!sponsor) return [];
    return DataService.getAll(SHEET(), TPL_TAB())
      .filter(r => _norm(r.SponsorEmail) === sponsor && _isTrueStr(r.Active))
      .map(_templateRecord)
      .sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0)
        || String(a.name).localeCompare(String(b.name)));
  }

  /**
   * Creates or updates a template from the management form. Sponsors own
   * theirs; super_admin may set SponsorEmail to assign it to an instructor.
   * If isDefault is set, clears the flag on that sponsor's other templates.
   */
  function saveTemplate(payload, user, roles) {
    payload = payload || {};
    const isSuper = roles.indexOf('super_admin') !== -1;
    const isSponsor = roles.indexOf(SPONSOR_ROLE) !== -1;
    if (!isSuper && !isSponsor) throw new Error('Only a faculty sponsor can save templates.');

    // Determine the owner. Sponsors always own their own; super_admin may
    // assign to a chosen instructor (must be an eligible sponsor).
    let owner;
    if (isSuper && payload.sponsorEmail) {
      owner = String(payload.sponsorEmail).trim();
      if (!_isEligibleSponsor(owner)) {
        throw new Error('That person is not an eligible individual-studies sponsor.');
      }
    } else {
      owner = user;
    }

    const name = String(payload.name || '').trim();
    if (!name) throw new Error('Give the template a name.');

    const fields = {
      SponsorEmail: owner,
      Name: name,
      Course: String(payload.course || '').trim(),
      Title: String(payload.title || '').trim(),
      CourseDescription: String(payload.courseDescription || '').trim(),
      WorkToBeSubmitted: String(payload.workToBeSubmitted || '').trim(),
      EvidenceOfPreparation: String(payload.evidenceOfPreparation || '').trim(),
      GradeOption: String(payload.gradeOption || '').trim(),
      HoursWithSponsor: String(payload.hoursWithSponsor || '').trim(),
      ReportRequired: _boolStr(payload.reportRequired),
      ReportDueText: String(payload.reportDueText || '').trim(),
      RoomAccessRoom: String(payload.roomAccessRoom || '').trim(),
      Active: 'TRUE',
    };

    let templateId;
    if (payload.templateId) {
      const existing = _templateById(payload.templateId);
      if (!existing) throw new Error('Template not found.');
      _assertTemplateOwner(existing, user, roles);
      // Keep the original owner unless super_admin explicitly reassigns.
      if (!(isSuper && payload.sponsorEmail)) fields.SponsorEmail = existing.SponsorEmail;
      DataService.update(SHEET(), TPL_TAB(), 'TemplateID', existing.TemplateID, fields);
      templateId = existing.TemplateID;
    } else {
      templateId = DataService.generateId('TPL');
      DataService.insert(SHEET(), TPL_TAB(), Object.assign({ TemplateID: templateId, IsDefault: '' }, fields));
    }

    if (payload.isDefault === true || payload.isDefault === 'true') {
      _applyDefault(fields.SponsorEmail, templateId);
    }
    return { templateId: templateId, saved: true };
  }

  /**
   * Saves an existing petition's reusable fields as a new template owned by
   * the petition's sponsor (or, for super_admin, the petition's sponsor).
   * Asks for a name; may flag default.
   */
  function saveAsTemplate(payload, user, roles) {
    payload = payload || {};
    const rec = _byId(String(payload.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    if (roles.indexOf('super_admin') === -1 && _norm(rec.SponsorEmail) !== _norm(user)) {
      throw new Error('Only the petition\'s sponsor can save it as a template.');
    }
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('Give the template a name.');

    const templateId = DataService.generateId('TPL');
    DataService.insert(SHEET(), TPL_TAB(), {
      TemplateID: templateId,
      SponsorEmail: rec.SponsorEmail,
      Name: name,
      IsDefault: '',
      Course: rec.Course || '',
      Title: rec.Title || '',
      CourseDescription: rec.CourseDescription || '',
      WorkToBeSubmitted: rec.WorkToBeSubmitted || '',
      EvidenceOfPreparation: rec.EvidenceOfPreparation || '',
      GradeOption: rec.GradeOption || '',
      HoursWithSponsor: rec.HoursWithSponsor || '',
      ReportRequired: _boolStr(_isTrueStr(rec.ReportRequired)),
      ReportDueText: rec.ReportDueDate || '',
      RoomAccessRoom: rec.RoomAccessRoom || '',
      Active: 'TRUE',
    });
    if (payload.isDefault === true || payload.isDefault === 'true') {
      _applyDefault(rec.SponsorEmail, templateId);
    }
    return { templateId: templateId, saved: true };
  }

  /** Flags one template as the sponsor's default, clearing the others. */
  function setDefaultTemplate(payload, user, roles) {
    const tpl = _templateById((payload || {}).templateId);
    if (!tpl) throw new Error('Template not found.');
    _assertTemplateOwner(tpl, user, roles);
    _applyDefault(tpl.SponsorEmail, tpl.TemplateID);
    return { templateId: tpl.TemplateID, isDefault: true };
  }

  function _applyDefault(sponsorEmail, defaultId) {
    DataService.getAll(SHEET(), TPL_TAB())
      .filter(r => _norm(r.SponsorEmail) === _norm(sponsorEmail))
      .forEach(r => {
        const shouldBe = String(r.TemplateID) === String(defaultId) ? 'TRUE' : '';
        if ((r.IsDefault || '') !== shouldBe) {
          DataService.update(SHEET(), TPL_TAB(), 'TemplateID', r.TemplateID, { IsDefault: shouldBe });
        }
      });
  }

  /** Deletes (hard-removes) a template. Owner or super_admin. */
  function deleteTemplate(payload, user, roles) {
    const tpl = _templateById((payload || {}).templateId);
    if (!tpl) throw new Error('Template not found.');
    _assertTemplateOwner(tpl, user, roles);
    DataService.remove(SHEET(), TPL_TAB(), 'TemplateID', tpl.TemplateID);
    return { templateId: tpl.TemplateID, deleted: true };
  }


  return {
    // student
    formData, mine, get, submit, withdraw, deletePetition,
    // sponsor
    sponsorQueue, sponsored, sponsorApprove, sponsorReturn, requestRoomAccess,
    // advisor
    advisorQueue, allPetitions, remindResponsible, advisorContext, advisorComplete, advisorReturn,
    // import (advisor admin)
    importPreview, importResolve, importCommit, importHistory,
    // settings (advisor)
    getSettings, saveSettings,
    // templates (sponsor-owned)
    myTemplates, templatesForSponsor, saveTemplate, saveAsTemplate, setDefaultTemplate, deleteTemplate,
  };

})();