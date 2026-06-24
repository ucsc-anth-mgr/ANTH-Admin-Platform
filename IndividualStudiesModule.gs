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
//     time. Petition-specific facts not on the profile (phone, college,
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

  const QUARTERS = ['Fall', 'Winter', 'Spring', 'Summer'];

  const GRADE_OPTIONS = ['Letter', 'Pass/No Pass'];

  // The campus rule: more than 7 special-study credits in a term needs
  // department (advisor) authorization.
  const SPECIAL_STUDY_CREDIT_CAP = 7;

  const SOURCE_TYPE = 'individual_studies_petition';


  // ============================================================
  // STUDENT ACTIONS
  // ============================================================

  /**
   * Bootstrap data for the New Petition form: the course list, eligible
   * faculty sponsors, quarter/year options, grade options, the student's
   * profile prefill (identity read from Auth), and the 195S redirect
   * interceptor config.
   */
  function formData(payload, user, roles) {
    const profile = Auth.getProfile(user) || {};
    return {
      courses: COURSES.slice(),
      redirectCourses: REDIRECT_COURSES,
      quarters: QUARTERS.slice(),
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
   *   @param {string} payload.phone
   *   @param {string} payload.college
   *   @param {string} payload.majorStatus   - "Undeclared" or major name
   *   @param {string} payload.classLevel    - FR | SO | JR | SR
   *   @param {string} [payload.petitionId]  - present on resubmission
   */
  function submit(payload, user, roles) {
    payload = payload || {};
    const quarter = _requireOneOf(payload.quarter, QUARTERS, 'Quarter');
    const year    = _validYear(payload.year);
    const course  = _requireOneOf(payload.course, COURSES, 'Course');
    const sponsorEmail = String(payload.sponsorEmail || '').trim();
    const title   = String(payload.title || '').trim();
    const courseDescription = String(payload.courseDescription || '').trim();
    const workToBeSubmitted = String(payload.workToBeSubmitted || '').trim();

    if (!sponsorEmail) throw new Error('Select a faculty sponsor.');
    if (!title) throw new Error('Title and description of the proposed course is required.');
    if (!courseDescription) throw new Error('A description of the proposed course is required.');
    if (!workToBeSubmitted) throw new Error('A description of the work to be submitted is required.');
    if (!_isEligibleSponsor(sponsorEmail)) {
      throw new Error('That person is not currently eligible to sponsor an individual study.');
    }

    const profile = Auth.getProfile(user);
    if (!profile) throw new Error('Your profile could not be found.');
    if (!profile.studentId) {
      throw new Error('Your profile has no Student ID on file. Contact the department to add one before submitting.');
    }

    const fields = {
      Quarter: quarter, Year: year, Course: course, SponsorEmail: sponsorEmail,
      StudySiteAddress: String(payload.studySiteAddress || '').trim(),
      Title: title,
      CourseDescription: courseDescription,
      EvidenceOfPreparation: String(payload.evidenceOfPreparation || '').trim(),
      WorkToBeSubmitted: workToBeSubmitted,
      ReportRequired: _boolStr(payload.reportRequired),
      ReportDueDate: String(payload.reportDueDate || '').trim(),
      HoursWithSponsor: String(payload.hoursWithSponsor || '').trim(),
      HoursIndependent: String(payload.hoursIndependent || '').trim(),
      Phone: String(payload.phone || '').trim(),
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

      Tasks.resolveForSource(MODULE, existingId, { resolvedBy: user });
      _routeToSponsor(existingId, sponsorEmail, profile, course, /*resubmitted*/ true);
      EventBus.emit(MODULE + '.resubmitted', { recordId: existingId, sponsorEmail: sponsorEmail }, { user: user });
      return { petitionId: existingId, stage: STAGE.SUBMITTED, resubmitted: true };
    }

    // ── New petition: enforce the four-part duplicate key ──
    _assertNoDuplicate(user, quarter, year, sponsorEmail, course);

    const petitionId = DataService.generateId('IS');
    DataService.insert(SHEET(), TAB(), Object.assign({
      PetitionID: petitionId,
      StudentEmail: user,
      Stage: STAGE.SUBMITTED,
      // Sponsor fields (set at sponsor stage)
      Credits: '', GradeOption: '', SponsorComments: '',
      SponsorDecidedBy: '', SponsorDecidedAt: '',
      // Advisor fields (set at advisor stage)
      ClassNumber: '', ClassSection: '', ClassNumberSource: '',
      TotalSpecialStudyCredits: '', MajorAuthRequired: '', MajorAuthorized: '',
      AdvisorComments: '', AdvisorProcessedBy: '', AdvisorProcessedAt: '',
      // Drive (filled at COMPLETE)
      DriveFileID: '', DocumentLink: '', FileName: '',
      ReturnNote: '',
    }, fields));

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
   * Sponsor records the instructor-approval decision: credits + grade
   * option (and may revise the two description fields), then approves.
   * Advances to PENDING_ADVISOR.
   */
  function sponsorApprove(payload, user, roles) {
    const rec = _byId((payload || {}).petitionId);
    if (!rec) throw new Error('Petition not found.');
    _assertSponsor(rec, user, roles);
    if (rec.Stage !== STAGE.SUBMITTED) throw new Error('This petition is not awaiting a sponsor decision.');

    const credits = _validCredits(payload.credits);
    const gradeOption = _requireOneOf(payload.gradeOption, GRADE_OPTIONS, 'Grade option');

    // The sponsor may edit the two description fields; preserve existing
    // text when not supplied.
    const courseDescription = payload.courseDescription !== undefined
      ? String(payload.courseDescription || '').trim() : rec.CourseDescription;
    const workToBeSubmitted = payload.workToBeSubmitted !== undefined
      ? String(payload.workToBeSubmitted || '').trim() : rec.WorkToBeSubmitted;

    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
      Credits: String(credits),
      GradeOption: gradeOption,
      SponsorComments: String(payload.comments || '').trim(),
      CourseDescription: courseDescription,
      WorkToBeSubmitted: workToBeSubmitted,
      SponsorDecidedBy: user,
      SponsorDecidedAt: new Date().toISOString(),
      Stage: STAGE.PENDING_ADVISOR,
    });

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
    return _advisorContext(rec);
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
    EventBus.emit(MODULE + '.completed', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.COMPLETE, documentLink: pdf ? pdf.url : '' };
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
      Credits: '', GradeOption: '', SponsorComments: '',
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
      });
    }
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
      body: 'Your ' + rec.Course + ' petition was returned for revision.\n\n' +
            'What to revise: ' + note + '\n\n' +
            'Revise and resubmit in the portal: ' + _deepLink(petitionId),
    });
  }

  function _notifyComplete(rec, pdf) {
    const link = (pdf && pdf.url) ? pdf.url : (rec.DocumentLink || '');
    const lines = [
      'Your ' + rec.Course + ' individual-studies petition is complete.',
      '',
      'Class number: ' + (rec.ClassNumber || '(see portal)'),
      'Enroll in this course in MyUCSC using the class number above.',
    ];
    if (link) lines.push('', 'Your completed petition (PDF): ' + link);
    Notify.send({
      to: rec.StudentEmail,
      subject: 'Your individual-studies petition is complete',
      body: lines.join('\n'),
    });
  }


  // ============================================================
  // PRIVATE — advisor decision context (credit total + class-number options)
  // ============================================================

  function _advisorContext(rec) {
    const term = _termKey(rec.Quarter, rec.Year);

    // The student's individual-studies petitions for this term (this module
    // only — the grad/thesis credit picture is out of scope here).
    const studentTermPetitions = DataService.query(SHEET(), TAB(), 'StudentEmail', rec.StudentEmail)
      .filter(r => _termKey(r.Quarter, r.Year) === term && r.Stage !== STAGE.RETURNED);

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

    // Class-number options from the ClassSchedule service.
    let preassigned = null, pool = [], reassignableRows = [];
    try {
      // Sponsors with a petition this term that is NOT returned (submitted,
      // pending advisor, or complete all mean that faculty member is
      // sponsoring a study) — excluded from reassignment candidates so we
      // don't repurpose a number from someone actively sponsoring.
      const liveSponsors = _liveSponsorEmails(term);

      const pre = ClassSchedule.findPreassigned(term, rec.Course, rec.SponsorEmail);
      preassigned = pre ? _classRow(pre) : null;
      pool = ClassSchedule.availablePool(term, rec.Course).map(_classRow);
      reassignableRows = ClassSchedule.reassignable(term, rec.Course, liveSponsors).map(_classRow);
    } catch (e) {
      Logger.log('IndividualStudiesModule._advisorContext: ClassSchedule lookup failed: ' + e);
    }

    return {
      term: term,
      creditTotal: creditTotal,
      creditCap: SPECIAL_STUDY_CREDIT_CAP,
      overCap: creditTotal > SPECIAL_STUDY_CREDIT_CAP,
      otherPetitions: others,
      preassigned: preassigned,
      pool: pool,
      reassignable: reassignableRows,
    };
  }

  /** Emails of sponsors with a non-terminal, non-returned petition in term. */
  function _liveSponsorEmails(term) {
    const live = {};
    DataService.getAll(SHEET(), TAB()).forEach(r => {
      if (_termKey(r.Quarter, r.Year) !== term) return;
      if (r.Stage === STAGE.RETURNED) return;
      const e = _norm(r.SponsorEmail);
      if (e) live[e] = true;
    });
    return Object.keys(live);
  }

  function _classRow(r) {
    return {
      classNbr: r.ClassNbr, section: r.Section, course: r.Course,
      instructorRaw: r.InstructorRaw, instructorEmail: r.InstructorEmail,
      instructorName: r.InstructorEmail ? _facultyLabel(r.InstructorEmail) : (r.InstructorRaw || 'Staff'),
      matchMethod: r.MatchMethod,
    };
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
      params: { petitionId: rec.PetitionID, term: _termKey(rec.Quarter, rec.Year), course: rec.Course },
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
      +   row('Phone', e(rec.Phone))
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

  function _grantStudentViewer(fileId, studentEmail) {
    const id = String(fileId || '').trim();
    const email = String(studentEmail || '').trim();
    if (!id || !email) return;
    try {
      DriveApp.getFileById(id).addViewer(email);
    } catch (e) {
      Logger.log('IndividualStudiesModule._grantStudentViewer: could not share ' + id + ' with ' + email + ': ' + e);
    }
  }


  // ============================================================
  // PRIVATE — eligibility, duplicate guard, record shaping, helpers
  // ============================================================

  /** Eligible faculty sponsors: senate_faculty / lecturer (active). */
  function _eligibleSponsors() {
    return Auth.listUsers()
      .filter(u => u.active && (u.roles || []).some(r => r === 'senate_faculty' || r === 'lecturer'))
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
   * Blocks an exact (student, term, instructor, course) duplicate. A
   * RETURNED record on the same key is not a duplicate (the student should
   * resubmit it), so it is excluded.
   */
  function _assertNoDuplicate(student, quarter, year, sponsorEmail, course) {
    const term = _termKey(quarter, year);
    const dup = DataService.query(SHEET(), TAB(), 'StudentEmail', student).find(r =>
      _termKey(r.Quarter, r.Year) === term &&
      _norm(r.SponsorEmail) === _norm(sponsorEmail) &&
      String(r.Course).trim() === String(course).trim() &&
      r.Stage !== STAGE.RETURNED);
    if (dup) {
      throw new Error('You already have a ' + course + ' petition with this sponsor for ' +
        quarter + ' ' + year + '. Use it rather than filing a duplicate.');
    }
  }

  function _publicRecord(r) {
    return {
      petitionId: r.PetitionID,
      studentEmail: r.StudentEmail,
      studentName: _studentLabel(r.StudentEmail),
      quarter: r.Quarter, year: r.Year, term: _termKey(r.Quarter, r.Year),
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
      phone: r.Phone, college: r.College, majorStatus: r.MajorStatus, classLevel: r.ClassLevel,
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

  function _termKey(quarter, year) {
    return String(quarter || '').trim() + ' ' + String(year || '').trim();
  }

  function _requireOneOf(value, allowed, label) {
    const v = String(value || '').trim();
    if (allowed.indexOf(v) === -1) {
      throw new Error(label + ' must be one of: ' + allowed.join(', ') + '.');
    }
    return v;
  }

  function _validYear(year) {
    const y = String(year || '').trim();
    if (!/^\d{4}$/.test(y)) throw new Error('Year must be a 4-digit year.');
    return y;
  }

  function _validCredits(credits) {
    const n = Number(credits);
    if (!isFinite(n) || n <= 0) throw new Error('Enter the number of credits.');
    return n;
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


  return {
    // student
    formData, mine, get, submit, withdraw,
    // sponsor
    sponsorQueue, sponsored, sponsorApprove, sponsorReturn,
    // advisor
    advisorQueue, advisorContext, advisorComplete, advisorReturn,
    // import (advisor admin)
    importPreview, importResolve, importCommit, importHistory,
  };

})();