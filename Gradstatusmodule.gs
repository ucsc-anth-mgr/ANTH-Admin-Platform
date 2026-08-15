// ============================================================
// GradStatusModule.gs — Graduate Registration Status forms
// ============================================================
// Module key: 'grad_status'. Phase 1 ships the Leave of Absence (LOA)
// workflow end-to-end; withdrawal / part-time / in-absentia arrive in
// Phase 2 as FormType variants on the same GradStatus tab and stage
// machine. Design spec: grad-forms-spec.md (Draft 3).
//
// WORKFLOW (LOA):
//   SUBMITTED → advisor (per-record senate faculty) → PENDING_CHAIR →
//   department_chair → PENDING_STAFF → staff_grad Complete →
//     visa holder?  → PENDING_ISSP → staff records ISSP return →
//   READY_TO_SUBMIT → staff uploads via Grad Division's Google Form
//   (submission helper: copy panel + prefilled link) → Mark submitted →
//   SUBMITTED_TO_GRADDIV (final).
//   Any review stage can Return → RETURNED → student resubmits the
//   SAME record (audit trail stays in the decision columns).
//
// D16: the portal NEVER emails Grad Division. Its final act is the
// certified PDF; staff_grad uploads it through Grad Div's own intake
// and stamps the record. The only outbound external email is the ISSP
// packet (D11), sent when a visa holder's record enters the hold.
//
// PDF: the OFFICIAL campus LOA form (Rev. 7/2017), used as the
// template AS-IS — it already ships with fillable AcroForm fields, and
// the fill map below addresses them by the campus's own field names
// (verified by extraction from request-loa.pdf):
//   'Last Name', 'First', 'MI', 'ID', 'Email', 'Dept',
//   'Date 1' (date entered), 'Date 2' (expected graduation),
//   'Candidacy', 'Leave Quarter', 'Leave Yr', 'Rtn Quarter', 'Rtn Yr',
//   'Reason', 'Date 3' + 'Student signature',
//   'Text1' (REVIEW conditions box), 'Date 4' + 'Advisor signature',
//   'Date 5' + 'Dept chair signature', 'Date 6' + 'Department Assistant',
//   'Date 7' + 'ISSS signature' (left blank — ISSP signs out of band),
//   'Date 8' + 'Grad Div signature' (left blank — theirs, per D16).
// So: upload the official PDF to Drive unmodified and paste its file id
// into GradFormsSettings LOA_TEMPLATE_FILE_ID (UI-managed — a campus
// revision that keeps its field names is a drop-in id swap). Signature
// values are 'Name (electronic)'; each line's date goes in its paired
// Date field, keeping the narrow signature boxes from overflowing.
//
// ASYNC RULE: staffComplete / regeneratePdf await
// ReportService.fillTemplate (pdf-lib), so they are async and dispatch
// awaits them — same contract as IndividualStudiesModule's completes.
// ============================================================

const GradStatusModule = (() => {

  const MODULE = 'grad_status';
  const SHEET        = function () { return CONFIG.SHEETS.GRAD; };
  const TAB          = function () { return (CONFIG.TABS && CONFIG.TABS.GRAD_STATUS) || 'GradStatus'; };
  const SETTINGS_TAB = function () { return (CONFIG.TABS && CONFIG.TABS.GRAD_FORMS_SETTINGS) || 'GradFormsSettings'; };

  const SOURCE_TYPE = 'grad_status_form';

  // ── Roles ──────────────────────────────────────────────────
  const STUDENT_ROLE = 'graduate_student';
  const STAFF_ROLE   = 'staff_grad';          // Department Assistant / Grad Coordinator
  const CHAIR_ROLE   = 'department_chair';    // existing platform role
  const ADVISOR_POOL = 'senate_faculty';      // advisor picker population
  const VISA_ROLE    = 'visa_holder';         // identity flag; drives the ISSP hold
  const ISSP_ROLE    = 'issp_staff';          // ISSP reviewers working IN the portal (optional;
                                              // with no active holders the email-packet path runs)

  // ── Stages ─────────────────────────────────────────────────
  const STAGE = {
    SUBMITTED:            'SUBMITTED',
    PENDING_CHAIR:        'PENDING_CHAIR',
    PENDING_STAFF:        'PENDING_STAFF',
    PENDING_ISSP:         'PENDING_ISSP',
    READY_TO_SUBMIT:      'READY_TO_SUBMIT',
    SUBMITTED_TO_GRADDIV: 'SUBMITTED_TO_GRADDIV',
    RETURNED:             'RETURNED',
    WITHDRAWN:            'WITHDRAWN',
  };
  const OPEN_STAGES = [STAGE.SUBMITTED, STAGE.PENDING_CHAIR, STAGE.PENDING_STAFF,
                       STAGE.PENDING_ISSP, STAGE.READY_TO_SUBMIT, STAGE.RETURNED];

  const FORM_TYPES = { LOA: 'LOA' };   // Phase 2 adds WDR / PTS / IAB

  // The LOA form's eight "I understand that" items, rendered as eight
  // required checkboxes (D13 — portal-only; no marks on the PDF).
  const ACK_ITEMS = [
    'A Leave of Absence is granted for sound educational reasons, health reasons, financial problems, or family responsibilities and is valid for no more than one year, but may be extended if there is sufficient justification.',
    'Use of University facilities is restricted while on leave. Library access is permitted as determined by Library policy.',
    'All financial aid (GSA, TA, Fellowship) terminates on the effective date of this leave.',
    'Any University employment, staff or academic, must be reported to Graduate Studies.',
    'Readmission is contingent upon any conditions set by my Department or the Graduate Dean.',
    'Readmission will automatically be effective for the quarter of return I have indicated, provided that my total leave time is three quarters or less. The Registrar\'s Office will email a registration bill to my UCSC email address. I may be required to re-establish CA residency with the Registrar if on leave for more than one quarter.',
    'Students who are advanced to candidacy and take a leave of absence forfeit eligibility for any future In-Candidacy Fee Offset Grant (ICFOG).',
    'Students who fail to reestablish contact with their department within thirty days following the expiration of an approved Leave will be administratively withdrawn from the University.',
  ];

  // Mirrors the Grad Div intake form's options VERBATIM (prefill values
  // must match their choice strings exactly).
  const EMPLOYMENT_OPTIONS = ['Yes', 'No', "I don't know"];

  const QUARTER_ORDER = ['Winter', 'Spring', 'Summer', 'Fall'];

  // ── UI-managed settings (GradFormsSettings tab) ────────────
  // The GRADDIV_FORM_LOA mapping was captured from the live Grad Div
  // Google Form (Aug 2026). Sources are tokens resolved server-side in
  // submissionHelper; 'entry' powers the prefilled link. When Grad Div
  // revises their form, staff edit this JSON in the Settings tab — no
  // deployment. File-upload questions cannot be prefilled and are
  // deliberately absent from the mapping.
  const SETTINGS_DEFAULTS = {
    NOTIFY_LOA_SUBMITTED: 'Your Leave of Absence request has been submitted to Graduate Division.',
    NOTIFY_LOA_RETURNED:  'Your Leave of Absence request was returned for revision.',
    NOTIFY_LOA_COMPLETE:  'Your Leave of Absence request has completed department review.',
    ISSP_EMAIL:           '',   // ISSP functional address (required before the first visa-holder record completes)
    DEPT_GRAD_EMAIL:      '',   // department grad functional address (prefills Grad Div's "Department Email")
    LOA_TEMPLATE_FILE_ID: '',   // Drive id of the blank LOA AcroForm (field names in the header comment)
    GRADDIV_FORM_LOA: JSON.stringify({
      url: 'https://docs.google.com/forms/d/e/1FAIpQLSeX2CotWDv2a_e-qeoiSVCctugSWxUpPB3c_RxnYLPeDC4phg/viewform',
      fields: [
        { label: 'Department Email',                     entry: '849158862',  source: 'deptEmail' },
        { label: 'Student Name (Last, First)',           entry: '1761401845', source: 'nameLastFirst' },
        { label: 'Student Identification Number (SID)',  entry: '1695927213', source: 'sid' },
        { label: 'Student Email',                        entry: '583502417',  source: 'studentEmail' },
        { label: 'Program',                              entry: '1055536673', source: 'program' },
        { label: 'Quarter their leave will begin',       entry: '2106043247', source: 'beginQuarter' },
        { label: 'Quarter returning from leave',         entry: '1409972918', source: 'returnQuarter' },
        { label: 'On medical/employment leave?',         entry: '280760850',  source: 'employmentLeave' },
      ],
    }),
  };

  // DegreeObjective (GradProgress) → Grad Div Program dropdown value.
  // Must match their option strings VERBATIM for prefill to take.
  const PROGRAM_MAP = {
    'PhD': 'ANTHPHD Anthropology PhD',
    'MA':  'ANTHMA Anthropology MA',
  };

  // ============================================================
  // Tab manifest — consumed by TabRegistry (Admin → Modules → Tabs)
  // ============================================================
  const TABS = [
    { key: 'forms', label: 'Forms', icon: 'ti-file-plus',
      roles: [STUDENT_ROLE],
      actions: ['formData', 'submit'] },
    { key: 'myforms', label: 'My Requests', icon: 'ti-list',
      roles: [STUDENT_ROLE],
      actions: ['mine', 'get', 'withdraw'] },
    { key: 'advisor', label: 'Advisor Review', icon: 'ti-gavel',
      roles: [ADVISOR_POOL],
      actions: ['advisorQueue', 'advisorApprove', 'advisorReturn', 'get'] },
    { key: 'issp', label: 'ISSP Review', icon: 'ti-world',
      roles: [ISSP_ROLE],
      actions: ['isspQueue', 'isspApprove', 'isspReturn', 'get'] },
    { key: 'department', label: 'Department Review', icon: 'ti-clipboard-check',
      roles: [STAFF_ROLE, CHAIR_ROLE],
      actions: ['departmentQueue', 'chairApprove', 'chairReturn', 'staffComplete',
                'staffReturn', 'recordIsspReturn', 'markSubmitted', 'submissionHelper',
                'regeneratePdf', 'allRecords', 'get', 'deleteRecord', 'attachReceipt'] },
    { key: 'progress', label: 'Progress Records', icon: 'ti-timeline',
      roles: [STAFF_ROLE], floor: STAFF_ROLE,
      actions: ['progressList', 'progressSave', 'progressDelete'] },
    { key: 'settings', label: 'Settings', icon: 'ti-settings',
      roles: [], floor: 'super_admin',
      actions: ['getSettings', 'saveSettings'] },
  ];

  const CHANNELS = [ { key: 'default', label: 'Graduate registration status' } ];

  // ============================================================
  // ACTIONS map — consumed by ActionPolicy (dispatch's second gate)
  // ============================================================
  const ACTIONS = {
    formData:         [STUDENT_ROLE],
    submit:           [STUDENT_ROLE],
    mine:             [STUDENT_ROLE],
    withdraw:         [STUDENT_ROLE],
    get:              ['*'],                       // record-level check inside
    advisorQueue:     [ADVISOR_POOL],
    advisorApprove:   [ADVISOR_POOL],
    advisorReturn:    [ADVISOR_POOL],
    departmentQueue:  [STAFF_ROLE, CHAIR_ROLE],
    chairApprove:     [CHAIR_ROLE],
    chairReturn:      [CHAIR_ROLE],
    staffComplete:    [STAFF_ROLE],
    staffReturn:      [STAFF_ROLE],
    recordIsspReturn: [STAFF_ROLE],
    isspQueue:        [ISSP_ROLE],
    isspApprove:      [ISSP_ROLE],
    isspReturn:       [ISSP_ROLE],
    markSubmitted:    [STAFF_ROLE],
    attachReceipt:    [STAFF_ROLE],
    submissionHelper: [STAFF_ROLE],
    regeneratePdf:    [STAFF_ROLE],
    allRecords:       [STAFF_ROLE],
    progressList:     [STAFF_ROLE],
    progressSave:     [STAFF_ROLE],
    getSettings:      [],                          // super_admin only
    saveSettings:     [],
    deleteRecord:     [],                          // super_admin only
    progressDelete:   [],
  };

  // ============================================================
  // STUDENT ACTIONS
  // ============================================================

  /**
   * Bootstrap for the student form: advisor picker (active senate
   * faculty), GradProgress prefills, visa flag, quarter options,
   * acknowledgment items. Editable-if-blank prefills self-heal the
   * progress record on submit (spec §5.0).
   */
  function formData(payload, user, roles) {
    const profile  = Auth.getProfile(user) || {};
    const progress = GradProgress.milestoneSummary(user);
    return {
      me: { email: user, name: profile.name || user,
            nameLastFirst: profile.nameLastFirst || '', studentId: profile.studentId || '' },
      advisors: _advisorOptions(),
      progress: progress,
      isVisaHolder: (roles || []).indexOf(VISA_ROLE) !== -1,
      ackItems: ACK_ITEMS,
      employmentOptions: EMPLOYMENT_OPTIONS,
      beginQuarters:  _quarterOptions(1, 6),   // next quarter … +6
      returnQuarters: _quarterOptions(2, 9),
      quarters:       QUARTER_ORDER,            // for the quarter+year selectors
      currentYear:    new Date().getFullYear(),
    };
  }

  /**
   * Submits (or resubmits) an LOA request. payload:
   *   advisorEmail, beginQuarter, beginYear, returnQuarter, returnYear,
   *   reason, employmentLeave, acknowledged (bool[8]),
   *   dateEntered / expectedGraduation / advancedToCandidacy
   *     (editable-if-blank prefills, written back to GradProgress),
   *   recordId (present = resubmission of a RETURNED record)
   */
  function submit(payload, user, roles) {
    payload = payload || {};
    const profile = Auth.getProfile(user) || {};

    // ── Validation ──
    const advisorEmail = _norm(payload.advisorEmail);
    const advisorOk = _advisorOptions().some(function (a) { return _norm(a.email) === advisorEmail; });
    if (!advisorOk) throw new Error('Select your faculty advisor from the list.');

    const bq = String(payload.beginQuarter || '').trim(),  by = String(payload.beginYear || '').trim();
    const rq = String(payload.returnQuarter || '').trim(), ry = String(payload.returnYear || '').trim();
    if (QUARTER_ORDER.indexOf(bq) === -1 || !/^\d{4}$/.test(by)) throw new Error('Select the quarter your leave will begin.');
    if (QUARTER_ORDER.indexOf(rq) === -1 || !/^\d{4}$/.test(ry)) throw new Error('Select the quarter you will return from leave.');
    const span = _quarterSpan(bq, by, rq, ry);
    if (span < 0) throw new Error('The return quarter must be after the quarter your leave begins.');

    const reason = String(payload.reason || '').trim();
    if (!reason) throw new Error('Enter the reason for requesting a Leave of Absence.');

    const employmentLeave = String(payload.employmentLeave || '').trim();
    if (EMPLOYMENT_OPTIONS.indexOf(employmentLeave) === -1) {
      throw new Error('Answer the employment-leave question.');
    }

    const acks = Array.isArray(payload.acknowledged) ? payload.acknowledged : [];
    const allAcked = acks.length === ACK_ITEMS.length && acks.every(function (a) { return a === true; });
    if (!allAcked) throw new Error('Read and check each of the ' + ACK_ITEMS.length + ' acknowledgment items.');

    const isVisa = (roles || []).indexOf(VISA_ROLE) !== -1;
    const warning = span > 3
      ? 'This request spans ' + span + ' countable quarters (Summer excluded). A Leave of Absence is valid for no more than one year (three quarters); longer requests require resubmission at the end of the approved term.'
      : '';

    // ── Self-healing progress writeback (advisor always; dates if blank) ──
    // Quarter+year fields are format-verified and normalized first, so
    // the progress record (and everything downstream) never stores drift.
    GradProgress.absorb(user, {
      AdvisorEmail:        advisorEmail,
      DateEntered:         _checkQuarterYear('Date entered', payload.dateEntered),
      ExpectedGraduation:  _checkQuarterYear('Expected graduation', payload.expectedGraduation),
      AdvancedToCandidacy: _checkQuarterYear('Advanced to candidacy', payload.advancedToCandidacy),
    }, user);
    const progress = GradProgress.get(user) || {};

    const fields = {
      FormType:            FORM_TYPES.LOA,
      StudentEmail:        user,
      StudentName:         profile.name || user,
      AdvisorEmail:        advisorEmail,
      Stage:               STAGE.SUBMITTED,
      SubmittedAt:         new Date(),
      LeaveBeginQuarter:   bq,  LeaveBeginYear: by,
      ReturnQuarter:       rq,  ReturnYear:     ry,
      LeaveSpanQuarters:   span,
      Reason:              reason,
      EmploymentLeave:     employmentLeave,
      AcknowledgedAt:      new Date(),
      VisaHolderAtSubmit:  isVisa ? 'TRUE' : 'FALSE',
      DateEntered:         String(progress.DateEntered || ''),
      ExpectedGraduation:  String(progress.ExpectedGraduation || ''),
      AdvancedToCandidacy: String(progress.AdvancedToCandidacy || ''),
    };

    // ── Resubmission of a RETURNED record (same record; D-audit) ──
    const existingId = String(payload.recordId || '').trim();
    if (existingId) {
      const rec = _byId(existingId);
      if (!rec) throw new Error('Record not found: ' + existingId);
      if (_norm(rec.StudentEmail) !== _norm(user)) throw new Error('You can only resubmit your own request.');
      if (rec.Stage !== STAGE.RETURNED) throw new Error('Only a returned request can be resubmitted.');
      DataService.update(SHEET(), TAB(), 'RecordID', existingId, fields);
      Tasks.resolveForSource(MODULE, existingId);
      _routeToAdvisor(existingId, fields, profile, true);
      return { recordId: existingId, stage: STAGE.SUBMITTED, resubmitted: true, warning: warning };
    }

    const recordId = DataService.generateId('LOA');
    fields.RecordID = recordId;
    DataService.insert(SHEET(), TAB(), fields);
    _routeToAdvisor(recordId, fields, profile, false);
    return { recordId: recordId, stage: STAGE.SUBMITTED, warning: warning };
  }

  /** The student's own records, newest first. */
  function mine(payload, user, roles) {
    return DataService.query(SHEET(), TAB(), 'StudentEmail', user)
      .map(function (r) { return _publicShape(r); })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  /** One record, for the detail modal. Record-level visibility check. */
  function get(payload, user, roles) {
    const rec = _byId(payload && payload.recordId);
    if (!rec) throw new Error('Record not found.');
    if (!_canView(rec, user, roles)) throw new Error('You do not have access to this record.');
    return _publicShape(rec, true);
  }

  /** Student cancels an open request that has not completed review. */
  function withdraw(payload, user, roles) {
    const rec = _byId(payload && payload.recordId);
    if (!rec) throw new Error('Record not found.');
    if (_norm(rec.StudentEmail) !== _norm(user)) throw new Error('You can only withdraw your own request.');
    if ([STAGE.SUBMITTED, STAGE.PENDING_CHAIR, STAGE.PENDING_STAFF, STAGE.RETURNED].indexOf(rec.Stage) === -1) {
      throw new Error('This request can no longer be withdrawn — contact the graduate program coordinator.');
    }
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID, { Stage: STAGE.WITHDRAWN });
    Tasks.resolveForSource(MODULE, rec.RecordID);
    return { recordId: rec.RecordID, stage: STAGE.WITHDRAWN };
  }

  // ============================================================
  // ADVISOR ACTIONS (per-record: user must BE the selected advisor)
  // ============================================================

  function advisorQueue(payload, user, roles) {
    return DataService.query(SHEET(), TAB(), 'AdvisorEmail', _norm(user))
      .filter(function (r) { return r.Stage === STAGE.SUBMITTED; })
      .map(function (r) { return _publicShape(r); });
  }

  function advisorApprove(payload, user, roles) {
    const rec = _assertAdvisorRecord(payload, user, roles, STAGE.SUBMITTED);
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID, {
      Stage: STAGE.PENDING_CHAIR,
      AdvisorDecidedBy: user, AdvisorDecidedAt: new Date(),
      AdvisorNote: String((payload && payload.note) || '').trim(),
    });
    Tasks.resolveForSource(MODULE, rec.RecordID);
    _routeToChair(rec);
    return { recordId: rec.RecordID, stage: STAGE.PENDING_CHAIR };
  }

  function advisorReturn(payload, user, roles) {
    const rec = _assertAdvisorRecord(payload, user, roles, STAGE.SUBMITTED);
    return _returnToStudent(rec, user, payload, 'AdvisorDecidedBy', 'AdvisorDecidedAt');
  }

  // ============================================================
  // DEPARTMENT ACTIONS (chair + staff)
  // ============================================================

  /**
   * The department queues, shaped per role: the chair sees
   * PENDING_CHAIR; staff sees PENDING_STAFF, PENDING_ISSP, and
   * READY_TO_SUBMIT. One action so the tab loads in one call.
   */
  function departmentQueue(payload, user, roles) {
    const all = DataService.getAll(SHEET(), TAB());
    const isChair = (roles || []).indexOf(CHAIR_ROLE) !== -1 || (roles || []).indexOf('super_admin') !== -1;
    const isStaff = (roles || []).indexOf(STAFF_ROLE) !== -1 || (roles || []).indexOf('super_admin') !== -1;
    return {
      chair: isChair ? all.filter(function (r) { return r.Stage === STAGE.PENDING_CHAIR; }).map(function (r) { return _publicShape(r); }) : [],
      staff: isStaff ? all.filter(function (r) { return r.Stage === STAGE.PENDING_STAFF; }).map(function (r) { return _publicShape(r); }) : [],
      issp:  isStaff ? all.filter(function (r) { return r.Stage === STAGE.PENDING_ISSP; }).map(function (r) { return _publicShape(r); }) : [],
      ready: isStaff ? all.filter(function (r) { return r.Stage === STAGE.READY_TO_SUBMIT; }).map(function (r) { return _publicShape(r); }) : [],
    };
  }

  function chairApprove(payload, user, roles) {
    const rec = _assertStage(payload, STAGE.PENDING_CHAIR);
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID, {
      Stage: STAGE.PENDING_STAFF,
      ChairDecidedBy: user, ChairDecidedAt: new Date(),
      ChairNote: String((payload && payload.note) || '').trim(),
      ConditionsForReadmission: String((payload && payload.conditions) || rec.ConditionsForReadmission || '').trim(),
    });
    Tasks.resolveForSource(MODULE, rec.RecordID);
    _routeToStaff(rec);
    return { recordId: rec.RecordID, stage: STAGE.PENDING_STAFF };
  }

  function chairReturn(payload, user, roles) {
    const rec = _assertStage(payload, STAGE.PENDING_CHAIR);
    return _returnToStudent(rec, user, payload, 'ChairDecidedBy', 'ChairDecidedAt');
  }

  /**
   * Staff completes department review. Generates the certified PDF,
   * then branches: visa holder → PENDING_ISSP (packet emailed to the
   * ISSP functional address, requesting return of the signed form to
   * the department); otherwise → READY_TO_SUBMIT (task: upload via
   * Grad Div's form). ASYNC — dispatch awaits the pdf-lib fill.
   * payload: recordId, note?, conditions?, employmentLeave?
   */
  async function staffComplete(payload, user, roles) {
    const rec = _assertStage(payload, STAGE.PENDING_STAFF);

    const updates = {
      StaffDecidedBy: user, StaffDecidedAt: new Date(),
      StaffNote: String((payload && payload.note) || '').trim(),
      // Fresh hold: clear any in-portal ISSP decision from a previous
      // round so the regenerated PDF never carries a stale ISSS signature.
      ISSPDecidedBy: '', ISSPDecidedAt: '',
    };
    if (payload && String(payload.conditions || '').trim() !== '') {
      updates.ConditionsForReadmission = String(payload.conditions).trim();
    }
    if (payload && EMPLOYMENT_OPTIONS.indexOf(String(payload.employmentLeave || '')) !== -1) {
      updates.EmploymentLeave = String(payload.employmentLeave);   // staff may correct (spec §5.1)
    }
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID, updates);

    const fresh = _byId(rec.RecordID);
    const pdf = await _generatePdf(fresh, user);
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID,
      { PDFFileID: pdf.fileId, PDFUrl: pdf.url });
    _grantViewers(pdf.fileId, _fileAudience(fresh));
    Tasks.resolveForSource(MODULE, rec.RecordID);

    const isVisa = _isTrue(fresh.VisaHolderAtSubmit);
    if (isVisa) {
      _enterIsspHold(fresh, pdf);
      return { recordId: rec.RecordID, stage: STAGE.PENDING_ISSP, pdfUrl: pdf.url };
    }
    _enterReadyToSubmit(fresh, pdf.url);
    return { recordId: rec.RecordID, stage: STAGE.READY_TO_SUBMIT, pdfUrl: pdf.url };
  }

  function staffReturn(payload, user, roles) {
    const rec = _assertStage(payload, STAGE.PENDING_STAFF);
    return _returnToStudent(rec, user, payload, 'StaffDecidedBy', 'StaffDecidedAt');
  }

  // ── ISSP in-portal review (records at PENDING_ISSP) ────────
  // Runs when ISSP staff hold the issp_staff role and work in the
  // portal. The staff "Record ISSP return" below remains the fallback
  // for the email-packet path — both can coexist on one record's life.

  function isspQueue(payload, user, roles) {
    return DataService.getAll(SHEET(), TAB())
      .filter(function (r) { return r.Stage === STAGE.PENDING_ISSP; })
      .map(function (r) { return _publicShape(r); });
  }

  /**
   * ISSP approves: their electronic signature lands on the form's
   * 'ISSS signature' / 'Date 7' lines via a PDF regeneration, and the
   * record moves to READY_TO_SUBMIT. ASYNC — awaits the pdf-lib fill.
   */
  async function isspApprove(payload, user, roles) {
    const rec = _assertStage(payload, STAGE.PENDING_ISSP);
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID, {
      ISSPDecidedBy: user, ISSPDecidedAt: new Date(),
      ISSPNote: String((payload && payload.note) || '').trim(),
      ISSPClearedAt: new Date(), ISSPClearedBy: user,
    });
    const fresh = _byId(rec.RecordID);
    const pdf = await _generatePdf(fresh, user);
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID,
      { PDFFileID: pdf.fileId, PDFUrl: pdf.url });
    _grantViewers(pdf.fileId, _fileAudience(fresh));
    Tasks.resolveForSource(MODULE, rec.RecordID);
    _enterReadyToSubmit(_byId(rec.RecordID), pdf.url);
    return { recordId: rec.RecordID, stage: STAGE.READY_TO_SUBMIT, pdfUrl: pdf.url };
  }

  /**
   * ISSP sends the record back to DEPARTMENT STAFF (not the student) —
   * ISSP-stage problems are administrative. Staff address the note and
   * Complete again, which re-enters the hold with a clean decision.
   */
  function isspReturn(payload, user, roles) {
    const rec = _assertStage(payload, STAGE.PENDING_ISSP);
    const note = String((payload && payload.note) || '').trim();
    if (!note) throw new Error('Enter a note telling department staff what needs attention.');
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID, {
      Stage: STAGE.PENDING_STAFF,
      ISSPDecidedBy: user, ISSPDecidedAt: new Date(),
      ISSPNote: note,
    });
    Tasks.resolveForSource(MODULE, rec.RecordID);
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: rec.RecordID,
      label: 'ISSP returned a Leave of Absence — ' + rec.StudentName,
      assignedRole: STAFF_ROLE,
    });
    const to = Notify.resolveRecipients({ superAdmins: [], explicit: _roleEmails(STAFF_ROLE) });
    if (to.length) {
      Notify.send({
        to: to,
        subject: 'ISSP returned a Leave of Absence — ' + rec.StudentName,
        body: 'ISSP reviewed ' + rec.StudentName + '\u2019s Leave of Absence and returned it to the department:\n\n' +
          note + '\n\nAddress the note and complete review again in the portal: ' + _deepLink(rec.RecordID),
        replyTo: Settings.replyTo(MODULE),
        cc: Settings.cc(MODULE),
      });
    }
    return { recordId: rec.RecordID, stage: STAGE.PENDING_STAFF };
  }

  /**
   * Staff records ISSP's return of the signed form and (optionally)
   * attaches the ISSP-signed PDF, which becomes the copy uploaded to
   * Grad Div. payload: recordId, note, pdfBase64?, pdfName?
   */
  function recordIsspReturn(payload, user, roles) {
    const rec = _assertStage(payload, STAGE.PENDING_ISSP);
    const updates = {
      Stage: STAGE.READY_TO_SUBMIT,
      ISSPClearedAt: new Date(), ISSPClearedBy: user,
      ISSPNote: String((payload && payload.note) || '').trim(),
    };
    const b64 = String((payload && payload.pdfBase64) || '').trim();
    if (b64) {
      const saved = _saveUpload(rec, b64,
        String((payload && payload.pdfName) || ('ISSP-signed-' + rec.RecordID + '.pdf')));
      updates.FinalPDFFileID = saved.fileId;
      updates.FinalPDFUrl    = saved.url;
      _grantViewers(saved.fileId, _fileAudience(rec));
    }
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID, updates);
    Tasks.resolveForSource(MODULE, rec.RecordID);
    _enterReadyToSubmit(_byId(rec.RecordID), updates.FinalPDFUrl || rec.PDFUrl);
    return { recordId: rec.RecordID, stage: STAGE.READY_TO_SUBMIT };
  }

  /**
   * Everything the submission-helper panel needs for one READY_TO_SUBMIT
   * record: the Grad Div form URL, a prefilled link, the copy-panel
   * field list (label + value + entry id), and the PDF(s) to attach.
   */
  function submissionHelper(payload, user, roles) {
    const rec = _byId(payload && payload.recordId);
    if (!rec) throw new Error('Record not found.');
    if (rec.Stage !== STAGE.READY_TO_SUBMIT && rec.Stage !== STAGE.SUBMITTED_TO_GRADDIV) {
      throw new Error('The submission helper is available once department review is complete.');
    }
    let mapping = null;
    try { mapping = JSON.parse(_setting('GRADDIV_FORM_LOA')); } catch (e) { mapping = null; }
    if (!mapping || !mapping.url) {
      return { formUrl: '', prefillUrl: '', fields: [],
               pdfUrl: String(rec.FinalPDFUrl || rec.PDFUrl || ''),
               note: 'No Grad Div form mapping is configured (Settings → GRADDIV_FORM_LOA).' };
    }
    const values = _prefillValues(rec);
    const fields = (mapping.fields || []).map(function (f) {
      return { label: String(f.label || ''), entry: String(f.entry || ''),
               value: values[String(f.source || '')] || '' };
    });
    const params = fields
      .filter(function (f) { return f.entry && f.value; })
      .map(function (f) { return 'entry.' + encodeURIComponent(f.entry) + '=' + encodeURIComponent(f.value); });
    const prefillUrl = mapping.url + (mapping.url.indexOf('?') === -1 ? '?' : '&') +
      'usp=pp_url' + (params.length ? '&' + params.join('&') : '');
    return {
      formUrl: mapping.url,
      prefillUrl: prefillUrl,
      fields: fields,
      pdfUrl: String(rec.FinalPDFUrl || rec.PDFUrl || ''),
      pdfIsIsspSigned: !!String(rec.FinalPDFUrl || '').trim(),
      note: '',
    };
  }

  /**
   * Staff stamps the record after uploading through Grad Div's system.
   * Google Forms emails the submitter a receipt (a copy of the
   * responses); it can be attached here, or later via attachReceipt
   * once the email arrives — the record isn't held open waiting for it.
   */
  function markSubmitted(payload, user, roles) {
    const rec = _assertStage(payload, STAGE.READY_TO_SUBMIT);
    const updates = {
      Stage: STAGE.SUBMITTED_TO_GRADDIV,
      SubmittedToGradDivAt: new Date(), SubmittedToGradDivBy: user,
      SubmissionNote: String((payload && payload.note) || '').trim(),
    };
    const b64 = String((payload && payload.receiptBase64) || '').trim();
    if (b64) {
      const saved = _saveUpload(rec, b64,
        String((payload && payload.receiptName) || ('GradDiv-receipt-' + rec.RecordID + '.pdf')),
        String((payload && payload.receiptMime) || ''));
      updates.ReceiptFileID = saved.fileId;
      updates.ReceiptFileUrl = saved.url;
      _grantViewers(saved.fileId, _fileAudience(rec));
    }
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID, updates);
    Tasks.resolveForSource(MODULE, rec.RecordID);
    _notifyStudentSubmitted(_byId(rec.RecordID));
    return { recordId: rec.RecordID, stage: STAGE.SUBMITTED_TO_GRADDIV };
  }

  /**
   * Attaches (or replaces) the Grad Div submission receipt on an
   * already-submitted record. The prior receipt file, if any, is left
   * in Drive (evidence posture) — only the record's pointer moves.
   */
  function attachReceipt(payload, user, roles) {
    const rec = _byId(payload && payload.recordId);
    if (!rec) throw new Error('Record not found.');
    if (rec.Stage !== STAGE.SUBMITTED_TO_GRADDIV) {
      throw new Error('Receipts attach to records already marked submitted; use Mark submitted to attach one at submission time.');
    }
    const b64 = String((payload && payload.receiptBase64) || '').trim();
    if (!b64) throw new Error('Choose the receipt file to attach.');
    const saved = _saveUpload(rec, b64,
      String((payload && payload.receiptName) || ('GradDiv-receipt-' + rec.RecordID + '.pdf')),
      String((payload && payload.receiptMime) || ''));
    _grantViewers(saved.fileId, _fileAudience(rec));
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID, {
      ReceiptFileID: saved.fileId, ReceiptFileUrl: saved.url,
      SubmissionNote: String((payload && payload.note) || rec.SubmissionNote || '').trim(),
    });
    return { recordId: rec.RecordID, receiptUrl: saved.url };
  }

  /** Regenerates the portal PDF (corrections before submission). ASYNC. */
  async function regeneratePdf(payload, user, roles) {
    const rec = _byId(payload && payload.recordId);
    if (!rec) throw new Error('Record not found.');
    if ([STAGE.PENDING_ISSP, STAGE.READY_TO_SUBMIT].indexOf(rec.Stage) === -1) {
      throw new Error('The PDF can be regenerated after staff completion, before submission.');
    }
    const pdf = await _generatePdf(rec, user);
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID,
      { PDFFileID: pdf.fileId, PDFUrl: pdf.url });
    _grantViewers(pdf.fileId, _fileAudience(rec));
    return { recordId: rec.RecordID, pdfUrl: pdf.url };
  }

  /** Every record (staff oversight list on the Department tab). */
  function allRecords(payload, user, roles) {
    return DataService.getAll(SHEET(), TAB()).map(function (r) { return _publicShape(r); })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  /**
   * SUPER ADMIN: permanently deletes a status record (any stage) —
   * primarily for clearing test data. The row is removed (not staged),
   * its open tasks are resolved, and any generated/uploaded PDFs are
   * deliberately LEFT in Drive and the Reports index (documents are
   * evidence; remove them by hand if they too are test artifacts).
   * ActionPolicy declares this [] (super_admin only); the explicit
   * check below is the handler-level floor that holds even with the
   * policy in shadow mode.
   */
  function deleteRecord(payload, user, roles) {
    if ((roles || []).indexOf('super_admin') === -1) {
      throw new Error('Only a super admin can delete records.');
    }
    const rec = _byId(payload && payload.recordId);
    if (!rec) throw new Error('Record not found.');
    Tasks.resolveForSource(MODULE, rec.RecordID);
    DataService.remove(SHEET(), TAB(), 'RecordID', rec.RecordID);
    return { recordId: rec.RecordID, deleted: true };
  }

  /** SUPER ADMIN: permanently deletes one GradProgress row (test cleanup). */
  function progressDelete(payload, user, roles) {
    if ((roles || []).indexOf('super_admin') === -1) {
      throw new Error('Only a super admin can delete progress records.');
    }
    return GradProgress.remove(payload && payload.studentEmail, user);
  }

  // ============================================================
  // PROGRESS TAB (staff — the shared record's UI home)
  // ============================================================

  function progressList(payload, user, roles) {
    return GradProgress.listAll().map(_serializable);
  }

  /**
   * Staff upsert of one progress row. payload: studentEmail + any of
   * the writable fields. Notes preserved unless supplied (service
   * contract).
   */
  function progressSave(payload, user, roles) {
    const email = _norm(payload && payload.studentEmail);
    if (!email) throw new Error('Student email is required.');
    const patch = {};
    ['AdvisorEmail', 'DateEntered', 'DegreeObjective', 'ExpectedGraduation',
     'AdvancedToCandidacy', 'QEPassedDate', 'LanguageFulfilledDate', 'Notes']
      .forEach(function (f) {
        if (payload && Object.prototype.hasOwnProperty.call(payload, f)) patch[f] = payload[f];
      });
    // Quarter+year fields are format-verified here too, so staff edits
    // can't reintroduce format drift (same rule as student submission).
    if (patch.DateEntered)         patch.DateEntered         = _checkQuarterYear('Date entered', patch.DateEntered);
    if (patch.ExpectedGraduation)  patch.ExpectedGraduation  = _checkQuarterYear('Expected graduation', patch.ExpectedGraduation);
    if (patch.AdvancedToCandidacy) patch.AdvancedToCandidacy = _checkQuarterYear('Advanced to candidacy', patch.AdvancedToCandidacy);
    return _serializable(GradProgress.upsert(email, patch, user));
  }

  // ============================================================
  // SETTINGS (super_admin)
  // ============================================================

  function getSettings(payload, user, roles) {
    const out = {};
    Object.keys(SETTINGS_DEFAULTS).forEach(function (k) { out[k] = _setting(k); });
    return out;
  }

  function saveSettings(payload, user, roles) {
    const values = (payload && payload.values) || {};
    let saved = 0;
    Object.keys(SETTINGS_DEFAULTS).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(values, k)) {
        _saveSetting(k, String(values[k] == null ? '' : values[k]));
        saved++;
      }
    });
    return { saved: saved };
  }

  // ============================================================
  // PRIVATE — validation / lookup
  // ============================================================

  function _norm(e) { return String(e || '').trim().toLowerCase(); }
  function _isTrue(v) { return String(v).trim().toUpperCase() === 'TRUE'; }

  /**
   * Makes a sheet row safe to return through google.script.run, which
   * rejects Date objects anywhere in the payload: every Date value is
   * formatted to a string; everything else passes through.
   */
  function _serializable(row) {
    const out = {};
    Object.keys(row || {}).forEach(function (k) {
      out[k] = (row[k] instanceof Date) ? _fmtDate(row[k]) : row[k];
    });
    return out;
  }

  function _byId(recordId) {
    const id = String(recordId || '').trim();
    if (!id) return null;
    const found = DataService.query(SHEET(), TAB(), 'RecordID', id);
    return found && found.length ? found[0] : null;
  }

  function _assertStage(payload, stage) {
    const rec = _byId(payload && payload.recordId);
    if (!rec) throw new Error('Record not found.');
    if (rec.Stage !== stage) throw new Error('This record is not awaiting that action (stage: ' + rec.Stage + ').');
    return rec;
  }

  function _assertAdvisorRecord(payload, user, roles, stage) {
    const rec = _assertStage(payload, stage);
    if ((roles || []).indexOf('super_admin') !== -1) return rec;
    if (_norm(rec.AdvisorEmail) !== _norm(user)) {
      throw new Error('Only the selected faculty advisor can act on this request.');
    }
    return rec;
  }

  function _canView(rec, user, roles) {
    if ((roles || []).indexOf('super_admin') !== -1) return true;
    if ((roles || []).indexOf(STAFF_ROLE) !== -1) return true;
    if ((roles || []).indexOf(CHAIR_ROLE) !== -1) return true;
    if ((roles || []).indexOf(ISSP_ROLE) !== -1 && _isTrue(rec.VisaHolderAtSubmit)) return true;
    const me = _norm(user);
    return _norm(rec.StudentEmail) === me || _norm(rec.AdvisorEmail) === me;
  }

  function _advisorOptions() {
    // Auth.usersWithRole already filters to ACTIVE holders and returns
    // { email, name } sorted by display name — use it as-is. (Filtering
    // on a nonexistent u.active here was emptying the advisor list.)
    return Auth.usersWithRole(ADVISOR_POOL);
  }

  function _roleEmails(role) {
    return Auth.usersWithRole(role).map(function (u) { return u.email; });
  }

  /** Next `count` quarters starting `offset` quarters from now. */
  function _quarterOptions(offset, count) {
    const now = new Date();
    let qi = Math.floor(now.getMonth() / 3);   // 0..3 ≈ Winter..Fall
    let year = now.getFullYear();
    const out = [];
    for (let i = 0; i < offset + count; i++) {
      if (i >= offset) out.push({ quarter: QUARTER_ORDER[qi], year: String(year) });
      qi++;
      if (qi === QUARTER_ORDER.length) { qi = 0; year++; }
    }
    return out;
  }

  /**
   * Format verification for the "Quarter YYYY" academic-date fields
   * (Date entered / Expected graduation / Advanced to candidacy).
   * Blank is allowed (the fields are optional); a non-blank value must
   * be a real quarter plus a sane 4-digit year. Returns the normalized
   * string, so downstream (PDF, GradProgress, Grad Div prefill) always
   * sees the one canonical form.
   */
  function _checkQuarterYear(label, value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return '';
    const m = s.match(/^(Winter|Spring|Summer|Fall)\s+(\d{4})$/);
    if (!m || Number(m[2]) < 1990 || Number(m[2]) > 2099) {
      throw new Error(label + ' must be a quarter and a 4-digit year (e.g. "Fall 2024").');
    }
    return m[1] + ' ' + m[2];
  }

  function _rawQuarterIndex(q, y) { return Number(y) * 4 + QUARTER_ORDER.indexOf(q); }

  /**
   * COUNTABLE quarters on leave: begin (inclusive) through return
   * (exclusive), EXCLUDING Summer — summer is not a regular term and
   * does not count toward the one-year (three-quarter) leave limit.
   * So Fall 2026 → Fall 2027 spans Fall/Winter/Spring (+ an uncounted
   * Summer) = 3, exactly one year. Returns -1 when the return quarter
   * is not after the begin quarter (ordering error; a Summer-only
   * leave legitimately counts 0).
   */
  function _quarterSpan(bq, by, rq, ry) {
    const a = _rawQuarterIndex(bq, by);
    const b = _rawQuarterIndex(rq, ry);
    if (b <= a) return -1;
    let n = 0;
    for (let i = a; i < b; i++) {
      if (QUARTER_ORDER[i % QUARTER_ORDER.length] !== 'Summer') n++;
    }
    return n;
  }

  function _fmtDate(d) {
    const dt = (d instanceof Date) ? d : (d ? new Date(d) : new Date());
    return Utilities.formatDate(dt, Session.getScriptTimeZone(), 'M/d/yyyy');
  }

  function _eSig(name) {
    if (!String(name || '').trim()) return '';
    return String(name || '') + ' (electronic)';
  }

  function _deepLink(recordId) {
    return Links.deepLink(MODULE, recordId || '');
  }

  function _publicShape(rec, withDetail) {
    const out = {
      recordId:      rec.RecordID,
      formType:      rec.FormType,
      studentEmail:  rec.StudentEmail,
      studentName:   rec.StudentName,
      advisorEmail:  rec.AdvisorEmail,
      stage:         rec.Stage,
      beginQuarter:  String(rec.LeaveBeginQuarter || '') + ' ' + String(rec.LeaveBeginYear || ''),
      returnQuarter: String(rec.ReturnQuarter || '') + ' ' + String(rec.ReturnYear || ''),
      spanQuarters:  rec.LeaveSpanQuarters,
      visaHolder:    _isTrue(rec.VisaHolderAtSubmit),
      submittedAt:   rec.SubmittedAt ? _fmtDate(rec.SubmittedAt) : '',
      // Epoch ms, NOT the raw Date: google.script.run cannot serialize
      // Date objects — one anywhere in a return value fails the whole
      // call into the client's failure handler.
      createdAt:     rec.CreatedAt ? new Date(rec.CreatedAt).getTime() : 0,
      pdfUrl:        String(rec.PDFUrl || ''),
      finalPdfUrl:   String(rec.FinalPDFUrl || ''),
    };
    if (withDetail) {
      out.reason               = String(rec.Reason || '');
      out.employmentLeave      = String(rec.EmploymentLeave || '');
      out.dateEntered          = String(rec.DateEntered || '');
      out.expectedGraduation   = String(rec.ExpectedGraduation || '');
      out.advancedToCandidacy  = String(rec.AdvancedToCandidacy || '');
      out.conditions           = String(rec.ConditionsForReadmission || '');
      out.returnedNote         = String(rec.ReturnedNote || '');
      out.advisorDecidedBy     = String(rec.AdvisorDecidedBy || '');
      out.advisorDecidedAt     = rec.AdvisorDecidedAt ? _fmtDate(rec.AdvisorDecidedAt) : '';
      out.chairDecidedBy       = String(rec.ChairDecidedBy || '');
      out.chairDecidedAt       = rec.ChairDecidedAt ? _fmtDate(rec.ChairDecidedAt) : '';
      out.staffDecidedBy       = String(rec.StaffDecidedBy || '');
      out.staffDecidedAt       = rec.StaffDecidedAt ? _fmtDate(rec.StaffDecidedAt) : '';
      out.isspSentAt           = rec.ISSPSentAt ? _fmtDate(rec.ISSPSentAt) : '';
      out.isspClearedAt        = rec.ISSPClearedAt ? _fmtDate(rec.ISSPClearedAt) : '';
      out.isspNote             = String(rec.ISSPNote || '');
      out.isspDecidedBy        = String(rec.ISSPDecidedBy || '');
      out.isspDecidedAt        = rec.ISSPDecidedAt ? _fmtDate(rec.ISSPDecidedAt) : '';
      out.submittedToGradDivAt = rec.SubmittedToGradDivAt ? _fmtDate(rec.SubmittedToGradDivAt) : '';
      out.submissionNote       = String(rec.SubmissionNote || '');
      out.receiptUrl           = String(rec.ReceiptFileUrl || '');
    }
    return out;
  }

  // ============================================================
  // PRIVATE — routing (Tasks + Notify)
  // ============================================================

  function _routeToAdvisor(recordId, rec, studentProfile, resubmitted) {
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: recordId,
      label: 'Leave of Absence awaiting advisor review',
      assignedTo: rec.AdvisorEmail,
    });
    const studentName = (studentProfile && (studentProfile.name || studentProfile.email)) || 'A graduate student';
    Notify.send({
      to: rec.AdvisorEmail,
      subject: 'Leave of Absence request awaiting your review',
      body: (resubmitted ? studentName + ' has revised and resubmitted' : studentName + ' has submitted') +
        ' a Leave of Absence request (' + rec.LeaveBeginQuarter + ' ' + rec.LeaveBeginYear +
        ' through ' + rec.ReturnQuarter + ' ' + rec.ReturnYear + ').\n\n' +
        'Review it in the portal: ' + _deepLink(recordId),
      replyTo: Settings.replyTo(MODULE),
      cc: Settings.cc(MODULE),
    });
  }

  function _routeToChair(rec) {
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: rec.RecordID,
      label: 'Leave of Absence awaiting department chair approval',
      assignedRole: CHAIR_ROLE,
    });
    const to = Notify.resolveRecipients({ superAdmins: [], explicit: _roleEmails(CHAIR_ROLE) });
    if (to.length) {
      Notify.send({
        to: to,
        subject: 'Leave of Absence awaiting chair approval',
        body: rec.StudentName + '\u2019s Leave of Absence request has been approved by their advisor ' +
          'and awaits your approval.\n\nReview it in the portal: ' + _deepLink(rec.RecordID),
        replyTo: Settings.replyTo(MODULE),
        cc: Settings.cc(MODULE),
      });
    }
  }

  function _routeToStaff(rec) {
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: rec.RecordID,
      label: 'Leave of Absence awaiting staff review',
      assignedRole: STAFF_ROLE,
    });
    const to = Notify.resolveRecipients({ superAdmins: [], explicit: _roleEmails(STAFF_ROLE) });
    if (to.length) {
      Notify.send({
        to: to,
        subject: 'Leave of Absence awaiting staff review',
        body: rec.StudentName + '\u2019s Leave of Absence request has been approved by the chair ' +
          'and awaits final department review.\n\nProcess it in the portal: ' + _deepLink(rec.RecordID),
        replyTo: Settings.replyTo(MODULE),
        cc: Settings.cc(MODULE),
      });
    }
  }

  function _returnToStudent(rec, user, payload, decidedByCol, decidedAtCol) {
    const note = String((payload && payload.note) || '').trim();
    if (!note) throw new Error('Enter a note telling the student what to revise.');
    const updates = { Stage: STAGE.RETURNED, ReturnedNote: note };
    updates[decidedByCol] = user;
    updates[decidedAtCol] = new Date();
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID, updates);
    Tasks.resolveForSource(MODULE, rec.RecordID);
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: rec.RecordID,
      label: 'Your Leave of Absence request needs revisions',
      assignedTo: rec.StudentEmail,
    });
    Notify.send({
      to: rec.StudentEmail,
      subject: 'Your Leave of Absence request was returned',
      body: _setting('NOTIFY_LOA_RETURNED') + '\n\n' +
        'What to revise: ' + note + '\n\n' +
        'Revise and resubmit in the portal: ' + _deepLink(rec.RecordID),
      replyTo: Settings.replyTo(MODULE),
      cc: Settings.cc(MODULE),
    });
    return { recordId: rec.RecordID, stage: STAGE.RETURNED };
  }

  /**
   * D11: the ISSP hold. Two transports, one stage:
   *   - PORTAL: active issp_staff holders exist — they get the task and
   *     a deep-link email, and act via the ISSP Review tab.
   *   - EMAIL (fallback/default): no holders — the packet goes to the
   *     ISSP functional address and department staff hold the task,
   *     recording the signed return manually.
   */
  function _enterIsspHold(rec, pdf) {
    DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID,
      { Stage: STAGE.PENDING_ISSP, ISSPSentAt: new Date() });

    const isspHolders = _roleEmails(ISSP_ROLE);
    if (isspHolders.length) {
      Tasks.create({
        module: MODULE, sourceType: SOURCE_TYPE, sourceId: rec.RecordID,
        label: 'ISSP review — Leave of Absence for ' + rec.StudentName,
        assignedRole: ISSP_ROLE,
      });
      Notify.send({
        to: isspHolders,
        subject: 'Leave of Absence awaiting ISSP review — ' + rec.StudentName,
        body: 'The Anthropology Department has completed review of a Leave of Absence for ' +
          rec.StudentName + ' (' + rec.StudentEmail + '), who holds a visa.\n\n' +
          'Leave: ' + rec.LeaveBeginQuarter + ' ' + rec.LeaveBeginYear + ' through ' +
          rec.ReturnQuarter + ' ' + rec.ReturnYear + '.\n\n' +
          'Review and sign it in the portal: ' + _deepLink(rec.RecordID),
        attachments: (pdf && pdf.blob) ? [pdf.blob] : [],
        replyTo: Settings.replyTo(MODULE),
        cc: Settings.cc(MODULE),
      });
      _notifyStudentDeptComplete(rec, true);
      return;
    }

    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: rec.RecordID,
      label: 'Awaiting ISSP return — Leave of Absence for ' + rec.StudentName,
      assignedRole: STAFF_ROLE,
    });
    const isspEmail = String(_setting('ISSP_EMAIL') || '').trim();
    if (isspEmail) {
      Notify.send({
        to: isspEmail,
        subject: 'Graduate Leave of Absence — ISSP review requested (' + rec.StudentName + ')',
        body: 'The Anthropology Department has completed review of a Leave of Absence request for ' +
          rec.StudentName + ' (' + rec.StudentEmail + '), who our records indicate holds a visa.\n\n' +
          'The signed department form is attached. Please review, sign the ISSP line, and return ' +
          'the signed form to the department so we can file it with the Division of Graduate Studies.\n\n' +
          'Leave: ' + rec.LeaveBeginQuarter + ' ' + rec.LeaveBeginYear + ' through ' +
          rec.ReturnQuarter + ' ' + rec.ReturnYear + '.',
        attachments: (pdf && pdf.blob) ? [pdf.blob] : [],
        replyTo: Settings.replyTo(MODULE),
        cc: Settings.cc(MODULE),
      });
    } else {
      // No address configured: hold still applies; staff are warned via
      // their task and can send manually, then record the return.
      Logger.log('GradStatusModule: ISSP_EMAIL is not configured — packet for ' +
        rec.RecordID + ' was NOT emailed. Configure it in the Settings tab.');
    }
    _notifyStudentDeptComplete(rec, true);
  }

  function _enterReadyToSubmit(rec, pdfUrl) {
    if (rec.Stage !== STAGE.READY_TO_SUBMIT) {
      DataService.update(SHEET(), TAB(), 'RecordID', rec.RecordID, { Stage: STAGE.READY_TO_SUBMIT });
    }
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: rec.RecordID,
      label: 'Submit Leave of Absence to Grad Division — ' + rec.StudentName,
      assignedRole: STAFF_ROLE,
    });
    const to = Notify.resolveRecipients({ superAdmins: [], explicit: _roleEmails(STAFF_ROLE) });
    if (to.length) {
      Notify.send({
        to: to,
        subject: 'Ready to submit: Leave of Absence for ' + rec.StudentName,
        body: 'Department review is complete. Download the PDF and submit it through the Graduate ' +
          'Division form, then mark the record submitted.\n\n' +
          (pdfUrl ? 'PDF: ' + pdfUrl + '\n\n' : '') +
          'Open the submission helper: ' + _deepLink(rec.RecordID),
        replyTo: Settings.replyTo(MODULE),
        cc: Settings.cc(MODULE),
      });
    }
    if (!_isTrue(rec.VisaHolderAtSubmit)) _notifyStudentDeptComplete(rec, false);
  }

  function _notifyStudentDeptComplete(rec, viaIssp) {
    Notify.send({
      to: rec.StudentEmail,
      subject: 'Your Leave of Absence request — department review complete',
      body: _setting('NOTIFY_LOA_COMPLETE') + '\n\n' +
        (viaIssp
          ? 'Because you hold a visa, the signed form has been routed to International Student ' +
            'Services and Programs for their review before it is filed with the Division of ' +
            'Graduate Studies. No action is needed from you.'
          : 'The department will file it with the Division of Graduate Studies, and you will ' +
            'receive a confirmation when that is done.') + '\n\n' +
        'Track it in the portal: ' + _deepLink(rec.RecordID),
      replyTo: Settings.replyTo(MODULE),
      cc: Settings.cc(MODULE),
    });
  }

  function _notifyStudentSubmitted(rec) {
    Notify.send({
      to: rec.StudentEmail,
      subject: 'Your Leave of Absence request has been submitted to Graduate Division',
      body: _setting('NOTIFY_LOA_SUBMITTED') + '\n\n' +
        'The Division of Graduate Studies will process it and determine the effective date. ' +
        'Track the record in the portal: ' + _deepLink(rec.RecordID),
      replyTo: Settings.replyTo(MODULE),
      cc: Settings.cc(MODULE),
    });
  }

  // ============================================================
  // PRIVATE — PDF + uploads + prefill
  // ============================================================

  async function _generatePdf(rec, user) {
    const templateId = String(_setting('LOA_TEMPLATE_FILE_ID') || '').trim();
    if (!templateId) {
      throw new Error('The LOA PDF template is not configured. Create the fillable AcroForm in ' +
        'Drive and paste its file id into the Settings tab (LOA_TEMPLATE_FILE_ID).');
    }
    const profile = Auth.getProfile(rec.StudentEmail) || {};
    const fileName = String(rec.LeaveBeginYear || '') + '-' + String(rec.LeaveBeginQuarter || '') +
      '_' + String(profile.studentId || 'SID') + '-LOA_' +
      String(profile.lastName || 'Last') + '-' + String(profile.firstName || 'First') + '.pdf';
    return ReportService.fillTemplate({
      module: MODULE,
      reportKey: 'loa',
      title: 'Leave of Absence — ' + (rec.StudentName || rec.StudentEmail),
      sourceId: rec.RecordID,
      templateFileId: templateId,
      fileName: fileName,
      returnBase64: false,
      // Field names are the OFFICIAL campus form's own (see header).
      values: {
        'Last Name':            String(profile.lastName || ''),
        'First':                String(profile.firstName || ''),
        'ID':                   String(profile.studentId || ''),
        'Email':                String(rec.StudentEmail || ''),
        'Dept':                 'Anthropology',
        'Date 1':               String(rec.DateEntered || ''),
        'Date 2':               String(rec.ExpectedGraduation || ''),
        'Candidacy':            String(rec.AdvancedToCandidacy || ''),
        'Leave Quarter':        String(rec.LeaveBeginQuarter || ''),
        'Leave Yr':             String(rec.LeaveBeginYear || ''),
        'Rtn Quarter':          String(rec.ReturnQuarter || ''),
        'Rtn Yr':               String(rec.ReturnYear || ''),
        'Reason':               String(rec.Reason || ''),
        'Text1':                String(rec.ConditionsForReadmission || ''),
        'Student signature':    _eSig(rec.StudentName),
        'Date 3':               _fmtDate(rec.SubmittedAt),
        'Advisor signature':    _eSig(_displayName(rec.AdvisorDecidedBy)),
        'Date 4':               rec.AdvisorDecidedAt ? _fmtDate(rec.AdvisorDecidedAt) : '',
        'Dept chair signature': _eSig(_displayName(rec.ChairDecidedBy)),
        'Date 5':               rec.ChairDecidedAt ? _fmtDate(rec.ChairDecidedAt) : '',
        'Department Assistant': _eSig(_displayName(rec.StaffDecidedBy)),
        'Date 6':               rec.StaffDecidedAt ? _fmtDate(rec.StaffDecidedAt) : '',
        // Filled only by an IN-PORTAL ISSP approval (ISSPDecidedBy);
        // the email-packet path leaves these blank — the uploaded
        // ISSP-signed copy (FinalPDF) carries that signature instead.
        'ISSS signature':       _eSig(_displayName(rec.ISSPDecidedBy)),
        'Date 7':               rec.ISSPDecidedAt ? _fmtDate(rec.ISSPDecidedAt) : '',
      },
    }, user);
  }

  function _displayName(email) {
    if (!String(email || '').trim()) return '';
    const p = Auth.getProfile(email);
    return (p && p.name) || String(email);
  }

  /** Saves an uploaded document to the module's Drive folder. */
  function _saveUpload(rec, b64, name, mime) {
    const folderId = (CONFIG.GRAD_STATUS && CONFIG.GRAD_STATUS.DRIVE_FOLDER_ID) || '';
    if (!folderId) {
      throw new Error('No document folder is configured for this module ' +
        '(CONFIG.GRAD_STATUS.DRIVE_FOLDER_ID). Create a Drive folder and paste its id into Config.gs.');
    }
    const blob = Utilities.newBlob(Utilities.base64Decode(b64),
      String(mime || 'application/pdf'), String(name || 'upload.pdf'));
    const file = DriveApp.getFolderById(folderId).createFile(blob);
    return { fileId: file.getId(), url: file.getUrl() };
  }

  /** Values for the Grad Div prefill sources (submissionHelper). */
  function _prefillValues(rec) {
    const profile  = Auth.getProfile(rec.StudentEmail) || {};
    const progress = GradProgress.get(rec.StudentEmail) || {};
    return {
      deptEmail:       String(_setting('DEPT_GRAD_EMAIL') || '').trim(),
      nameLastFirst:   String(profile.nameLastFirst || rec.StudentName || ''),
      sid:             String(profile.studentId || ''),
      studentEmail:    String(rec.StudentEmail || ''),
      program:         PROGRAM_MAP[String(progress.DegreeObjective || '').trim()] || '',
      beginQuarter:    String(rec.LeaveBeginQuarter || '') + ' ' + String(rec.LeaveBeginYear || ''),
      returnQuarter:   String(rec.ReturnQuarter || '') + ' ' + String(rec.ReturnYear || ''),
      employmentLeave: String(rec.EmploymentLeave || ''),
    };
  }

  // ============================================================
  // PRIVATE — Drive viewer grants (the Coursework/IS pattern)
  // ============================================================
  // Generated and uploaded PDFs live in Drive owned by the deploying
  // account; without grants, the links in emails and the portal 404 for
  // everyone else. Per-file audience = the record's student + the
  // record's advisor + every staff_grad and department_chair holder —
  // so a student can only ever open their OWN file, while the review
  // roles can open all of them.

  function _fileAudience(rec) {
    return [rec.StudentEmail, rec.AdvisorEmail]
      .concat(_roleEmails(STAFF_ROLE))
      .concat(_roleEmails(CHAIR_ROLE))
      .concat(_isTrue(rec.VisaHolderAtSubmit) ? _roleEmails(ISSP_ROLE) : []);
  }

  /**
   * Grants read access on a file to several people (deduped
   * case-insensitively, blanks dropped). Each grant is best-effort and
   * silent; one failure never blocks the others or the workflow.
   */
  function _grantViewers(fileId, emails) {
    const seen = {};
    (emails || []).forEach(function (e) {
      const email = String(e || '').trim();
      if (!email) return;
      const key = email.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      _grantViewer(fileId, email);
    });
  }

  /**
   * Grants one person read access without a notification email. Uses
   * the Advanced Drive Service when available (v3 then v2 shapes);
   * falls back to DriveApp.addViewer (which does notify — harmless).
   * Best-effort, never throws. Idempotent.
   */
  function _grantViewer(fileId, email) {
    const id = String(fileId || '').trim();
    const who = String(email || '').trim();
    if (!id || !who) return;
    try {
      if (typeof Drive !== 'undefined' && Drive && Drive.Permissions) {
        if (typeof Drive.Permissions.create === 'function') {          // v3
          Drive.Permissions.create(
            { role: 'reader', type: 'user', emailAddress: who },
            id, { sendNotificationEmail: false });
          return;
        }
        if (typeof Drive.Permissions.insert === 'function') {          // v2
          Drive.Permissions.insert(
            { role: 'reader', type: 'user', value: who },
            id, { sendNotificationEmails: false });
          return;
        }
      }
      DriveApp.getFileById(id).addViewer(who);   // last resort: does notify
    } catch (e) {
      Logger.log('GradStatusModule._grantViewer: could not share ' + id + ' with ' + who + ': ' + e);
    }
  }

  // ============================================================
  // PRIVATE — settings (key/value tab, defaults above)
  // ============================================================

  function _setting(key) {
    try {
      const rows = DataService.query(SHEET(), SETTINGS_TAB(), 'Key', key);
      if (rows && rows.length) {
        const v = String(rows[0].Value == null ? '' : rows[0].Value);
        if (v.trim() !== '') return v;
      }
    } catch (e) { /* tab missing → defaults */ }
    return SETTINGS_DEFAULTS[key] !== undefined ? SETTINGS_DEFAULTS[key] : '';
  }

  function _saveSetting(key, value) {
    const rows = DataService.query(SHEET(), SETTINGS_TAB(), 'Key', key);
    if (rows && rows.length) {
      DataService.update(SHEET(), SETTINGS_TAB(), 'Key', key, { Value: value });
    } else {
      DataService.insert(SHEET(), SETTINGS_TAB(), { Key: key, Value: value });
    }
  }

  // ============================================================
  return {
    ACTIONS: ACTIONS, TABS: TABS, CHANNELS: CHANNELS,
    formData: formData, submit: submit, mine: mine, get: get, withdraw: withdraw,
    advisorQueue: advisorQueue, advisorApprove: advisorApprove, advisorReturn: advisorReturn,
    departmentQueue: departmentQueue, chairApprove: chairApprove, chairReturn: chairReturn,
    staffComplete: staffComplete, staffReturn: staffReturn,
    recordIsspReturn: recordIsspReturn, markSubmitted: markSubmitted,
    isspQueue: isspQueue, isspApprove: isspApprove, isspReturn: isspReturn,
    attachReceipt: attachReceipt,
    submissionHelper: submissionHelper, regeneratePdf: regeneratePdf,
    allRecords: allRecords,
    progressList: progressList, progressSave: progressSave,
    deleteRecord: deleteRecord, progressDelete: progressDelete,
    getSettings: getSettings, saveSettings: saveSettings,
  };

})();


/**
 * DIAGNOSTIC (safe to leave in; run from the editor's function dropdown,
 * then read the execution log). Prints exactly what the LOA form's
 * bootstrap would receive: how many active senate_faculty holders the
 * advisor list resolves, the first few names, whether the Graduate Forms
 * spreadsheet id is configured, and whether formData completes at all.
 */
/**
 * DIAGNOSTIC: verifies the configured LOA template end to end. Run from
 * the editor dropdown and read the log:
 *   - the Drive file's name and MIME type ("application/pdf" required —
 *     "application/vnd.google-apps.document" means Drive converted it
 *     to a Google Doc: re-upload the .pdf with conversion off)
 *   - whether the bytes start with %PDF (the "No PDF header found" test)
 *   - every AcroForm field name in the PDF, checked against the names
 *     the module fills, with missing/extra names called out.
 */
async function debugGradLoaTemplate() {
  const EXPECTED = ['Last Name', 'First', 'ID', 'Email', 'Dept',
    'Date 1', 'Date 2', 'Candidacy',
    'Leave Quarter', 'Leave Yr', 'Rtn Quarter', 'Rtn Yr',
    'Reason', 'Text1', 'Student signature', 'Date 3',
    'Advisor signature', 'Date 4', 'Dept chair signature', 'Date 5',
    'Department Assistant', 'Date 6'];
  const id = String((function () {
    try {
      const rows = DataService.query(CONFIG.SHEETS.GRAD,
        (CONFIG.TABS && CONFIG.TABS.GRAD_FORMS_SETTINGS) || 'GradFormsSettings',
        'Key', 'LOA_TEMPLATE_FILE_ID');
      return rows && rows.length ? rows[0].Value : '';
    } catch (e) { return ''; }
  })() || '').trim();
  Logger.log('LOA_TEMPLATE_FILE_ID = "' + (id || '(blank)') + '"');
  if (!id) { Logger.log('Configure it in the module Settings tab first.'); return; }
  const f = DriveApp.getFileById(id);
  const b = f.getBlob();
  const bytes = b.getBytes();
  const head = bytes.slice(0, 5).map(function (x) { return String.fromCharCode(x < 0 ? x + 256 : x); }).join('');
  Logger.log('File: "' + f.getName() + '" | MIME: ' + f.getMimeType() + ' | size: ' + bytes.length);
  Logger.log('First bytes: "' + head + '" → ' + (head === '%PDF-' ? 'real PDF ✓' : 'NOT a PDF ✗ (re-upload as .pdf without conversion)'));
  if (head !== '%PDF-') return;
  const doc = await PDFLib.PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false });
  const names = doc.getForm().getFields().map(function (fl) { return fl.getName(); });
  Logger.log('AcroForm fields (' + names.length + '): ' + names.join(', '));
  const missing = EXPECTED.filter(function (n) { return names.indexOf(n) === -1; });
  const extra   = names.filter(function (n) { return EXPECTED.indexOf(n) === -1; });
  Logger.log(missing.length ? 'MISSING (module fills these; add them): ' + missing.join(', ') : 'All expected fields present ✓');
  if (extra.length) Logger.log('Extra fields (harmless, left blank): ' + extra.join(', '));
}


function debugGradStatusFormData() {
  const me = Session.getActiveUser().getEmail();
  Logger.log('CONFIG.SHEETS.GRAD = "' + (CONFIG.SHEETS.GRAD || '(blank)') + '"');
  const advisors = Auth.usersWithRole('senate_faculty');
  Logger.log('Auth.usersWithRole(senate_faculty): ' + advisors.length + ' holder(s)');
  advisors.slice(0, 5).forEach(function (a) { Logger.log('  ' + a.name + ' <' + a.email + '>'); });
  try {
    const fd = GradStatusModule.formData({}, me, Auth.getRoles(me));
    Logger.log('formData OK — advisors in payload: ' + fd.advisors.length +
      ', quarters: ' + fd.beginQuarters.length + '/' + fd.returnQuarters.length);
  } catch (e) {
    Logger.log('formData THREW: ' + e);
  }
}