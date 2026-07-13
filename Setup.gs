// ============================================================
// Setup.gs — One-time Google Sheets setup
// ============================================================
// Run setUp() once from the Apps Script editor to create every
// tab the platform needs, with correct headers and seed data.
//
// HOW TO RUN:
//   1. Open the Apps Script editor
//   2. Select "setUp" in the function dropdown (top toolbar)
//   3. Click Run, and authorize when prompted
//   4. Read the log (View > Logs, or the execution output):
//      - If your CONFIG.SHEETS IDs were still placeholders, this
//        creates new spreadsheets and logs their IDs — paste those
//        IDs into Config.gs, then you're done.
//      - If your IDs were already filled in, it sets up tabs inside
//        those existing spreadsheets.
//
// SAFE TO RE-RUN: existing tabs and data are never overwritten.
// Missing tabs/headers are added; present ones are left alone.
//
// FOLDER PLACEMENT: if CONFIG.SETUP_FOLDER_ID is set, newly created
// spreadsheets are moved into that Drive folder. Otherwise they're
// created in your My Drive root. (Moving files requires authorizing
// Drive access the first time you run setUp.)
// ============================================================

// Tab definitions: name -> header row
const SETUP_SCHEMA = {
  USERS: {
    tab: 'Users',
    headers: ['Email', 'FirstName', 'LastName', 'AltNames', 'Roles', 'StudentID', 'EmployeeID', 'Active', 'Notes'],
    seed: [],   // first super-admin is handled via CONFIG.SUPER_ADMINS
  },
  ROLES: {
    tab: 'Roles',
    headers: ['Role', 'Description'],
    seed: [
      ['super_admin',           'Full system access; protected'],
      ['staff',                 'Department staff'],
      ['senate_faculty',        'Senate faculty members'],
      ['lecturer',              'Lecturers and teaching faculty'],
      ['graduate_student',      'Graduate students'],
      ['undergraduate_student', 'Undergraduate students'],
      ['visitor',               'Visitors and limited-access users'],
    ],
  },
  MODULES: {
    tab: 'Modules',
    headers: ['Key', 'Label', 'Icon', 'Roles', 'Handler', 'Include', 'Order', 'Enabled'],
    seed: [
      ['admin', 'Admin', 'ti-settings', 'super_admin', 'AdminModule', 'admin', 0, 'TRUE'],
      ['submissions', 'Submissions', 'ti-file-text',
       'super_admin, staff, senate_faculty, lecturer, graduate_student, undergraduate_student',
       'SubmissionsModule', 'submissions', 1, 'TRUE'],
      ['users', 'User Management', 'ti-users', 'super_admin, staff', 'UserManagerModule', 'users', 2, 'TRUE'],
    ],
  },
  AUDIT: {
    tab: 'AuditLog',
    headers: ['Timestamp', 'User', 'Module', 'Action', 'Payload', 'Status', 'Notes'],
    seed: [],
  },
  REQUESTS: {
    tab: 'Requests',
    headers: ['RequestID', 'Email', 'FirstName', 'LastName', 'IDType', 'IDNumber', 'RequestedRole', 'Note', 'Status', 'SubmittedAt', 'DecidedBy', 'DecidedAt', 'DecisionNote'],
    seed: [],
  },
  IMPORT_POLICY: {
    tab: 'ImportPolicy',
    headers: ['ImporterRole', 'AssignableRoles'],
    seed: [],
  },
  NOTIFY_RULES: {
    tab: 'NotifyRules',
    headers: ['RequestedRole', 'NotifyEmails', 'Note'],
    seed: [
      ['undergraduate_student', '', 'Comma-separated emails notified when this role is requested (super admins are always notified)'],
      ['graduate_student', '', ''],
      ['visitor', '', ''],
    ],
  },
  THESIS_ELIGIBILITY: {
    tab: 'ThesisEligibility',
    // Who may sponsor / read senior theses. Roles is the base set; the
    // per-person Allow/Deny lists are exceptions managed via the Admin
    // faculty roster. super_admin is always eligible regardless.
    headers: ['Capability', 'Roles', 'AllowEmails', 'DenyEmails'],
    seed: [
      ['sponsor', 'senate_faculty, lecturer', '', ''],
      ['reader',  'senate_faculty, lecturer', '', ''],
    ],
  },
  THESIS_SETTINGS: {
    tab: 'ThesisSettings',
    // UI-managed operational settings (key/value). Seeded from the
    // CONFIG.THESIS defaults; the sheet overrides them once saved.
    headers: ['Key', 'Value'],
    seed: [
      ['NOTIFY_ON_HANDOFF', 'TRUE'],
      ['SEND_CERTIFICATE',  'TRUE'],
    ],
  },
  SETTINGS: {
    tab: 'Settings',
    // Platform-wide, module-keyed settings (Settings.gs). One row per
    // (Module, Key); currently holds each module's notification reply-to
    // under the 'replyTo' key. No seed: values are configured per module
    // in the Admin UI, and an unset module falls back to
    // CONFIG.DEFAULT_REPLY_TO at send time. Machine-managed — not intended
    // for hand editing.
    headers: ['Module', 'Key', 'Value'],
    seed: [],
  },
  TASKS: {
    tab: 'Tasks',
    // Pointer-only "needs attention" queue. SourceID references the
    // authoritative record in the owning module's own sheet; no business
    // data is stored here. Created/Resolved/Updated meta columns are
    // written by DataService and the Tasks service.
    //
    // Time fields:
    //   DueAt          — hard deadline, supplied by the module/workflow
    //                    (domain knowledge). Blank = no deadline.
    //   StaleAfterDays — neglect threshold in days, supplied by the
    //                    module/workflow. Blank = never flagged stale.
    //   LastActivityAt — owned by the Tasks service; stamped on create
    //                    and bumped on resolve/update/touch. Drives the
    //                    staleness computation. NOT a workflow field.
    headers: ['TaskID', 'Module', 'SourceType', 'SourceID', 'Label',
              'AssignedTo', 'AssignedRole', 'Status', 'Note',
              'DueAt', 'StaleAfterDays', 'LastActivityAt',
              'CreatedAt', 'CreatedBy', 'ResolvedAt', 'ResolvedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  REPORTS: {
    tab: 'Reports',
    // Archived-report log (ReportService) — the PLATFORM sheet's second
    // tenant after Tasks. One row per archived PDF: the queryable index
    // that makes the report archive a real backup, and the lookup behind
    // fetch-or-create (certificates re-send the SAME file, never a new
    // one). SourceID references the documented record in the owning
    // module's own sheet (e.g. a ThesisID); Params is the JSON of
    // inputs/filters so any archived report is reproducible. GeneratedBy
    // is written explicitly from the dispatch user; the CreatedAt/By
    // meta pair is filled by DataService.insert as usual.
    headers: ['ReportID', 'Module', 'ReportKey', 'SourceID', 'Title', 'Params',
              'DriveFileID', 'URL', 'FileName', 'GeneratedBy',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  THESIS: {
    tab: 'Thesis',
    // Senior thesis records (one per student per term). Identity is NOT
    // copied here — StudentEmail/SponsorEmail/ReaderEmail are routing keys;
    // names and Student ID are read from Auth at display time. DriveFileID
    // is the stored PDF (replaced in place on resubmission); DocumentLink is
    // its viewable URL, captured automatically at upload.
    headers: ['ThesisID', 'StudentEmail', 'Quarter', 'Year', 'ShareConsent',
              'Title', 'Abstract', 'Regions', 'SponsorEmail', 'DriveFileID', 'FileName', 'DocumentLink',
              'Stage',
              'SponsorDecision', 'SponsorComments', 'SponsorCommentFileID', 'SponsorCommentLink',
              'SponsorDecidedBy', 'SponsorDecidedAt',
              'ReaderEmail', 'HonorsDecision', 'ReaderComments', 'ReaderCommentFileID', 'ReaderCommentLink',
              'ReaderDecidedBy', 'ReaderDecidedAt',
              'AdvisorProcessedBy', 'AdvisorProcessedAt', 'MilestoneEntered', 'ReturnNote',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  ARTICULATIONS: {
    tab: 'Articulations',
    // Trusted, clean 1:1 UCSC Anthropology articulations, one row per
    // (catalog year, sending college, sending course). Both the human-
    // readable course code and ASSIST's stable courseIdentifierParentId
    // are kept: the code for advisor display + transcript matching, the
    // id as the durable identifier across catalog-year renumbers.
    // Lower-division only. Meta columns are filled by DataService.
    headers: ['CatalogYear', 'SendingCollege', 'SendingCollegeId',
              'SendingPrefix', 'SendingNumber', 'SendingCourseId', 'SendingTitle',
              'ReceivingPrefix', 'ReceivingNumber', 'ReceivingCourseId', 'ReceivingTitle',
              'SyncedDate',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  ARTICULATION_REVIEW: {
    tab: 'ArticulationReview',
    // Anything the sync could NOT confirm as a clean 1:1 (multiple course
    // groups, internal AND, OR between groups, denied courses, advisement,
    // no-articulation, or a parse failure). Reason explains why; RawCell
    // holds the raw ASSIST template-cell JSON so an advisor sees exactly
    // what ASSIST returned. Fail-safe: uncertain cells land here, never in
    // the trusted table.
    headers: ['CatalogYear', 'SendingCollege', 'SendingCollegeId',
              'ReceivingPrefix', 'ReceivingNumber', 'ReceivingCourseId', 'ReceivingTitle',
              'Reason', 'RawCell', 'SyncedDate',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  TRANSCRIPTS: {
    tab: 'Transcripts',
    // Layer 2: one row per uploaded student transcript. Identity is a
    // routing key (StudentEmail); name/StudentID are read from Auth at
    // display time, not copied here. The PDF lives in Drive
    // (CONFIG.TRANSCRIPT.DRIVE_FOLDER_ID); DriveFileID is replaced in place
    // on resubmission, DocumentLink is its viewable URL captured at upload.
    //
    // ClaimedPrereqs: the UCSC ANTH prereqs the student says this transcript
    // satisfies (subset of the allowlist), stored normalized as a sorted
    // comma list e.g. "ANTH 1, ANTH 3". It is the advisor's anchor and the
    // hook 2b's auto-match will use.
    //
    // Replacement key: an upload REPLACES an existing row in place (same
    // DriveFileID) only when StudentEmail + SendingCollegeId + ClaimedPrereqs
    // ALL match exactly (claim set compared order-independently). Any
    // difference — including overlapping-but-not-identical prereqs — is a
    // NEW transcript. A replacement resets Status to 'Pending Review' and
    // clears the prior review fields (fresh submission needs fresh review).
    //
    // Status: 'Pending Review' (on upload) -> 'Processed' or
    // 'No Articulation' (both terminal; either fires the student email).
    // ReviewNote is the advisor's optional per-case note — it is BOTH the
    // internal record and the addendum appended to the student email.
    headers: ['TranscriptID', 'StudentEmail', 'SendingCollege', 'SendingCollegeId',
              'ClaimedPrereqs', 'Status', 'ReviewNote',
              'DriveFileID', 'FileName', 'DocumentLink', 'UploadedAt',
              'ReviewedBy', 'ReviewedAt',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  TRANSCRIPT_SETTINGS: {
    tab: 'TranscriptSettings',
    // UI-managed operational settings (key/value), mirroring ThesisSettings.
    // Edited in the module's admin tab; the sheet overrides these seeded
    // defaults once saved. The two NOTIFY_* values are the student-email
    // templates per terminal status; tokens {FirstName} and {College} are
    // filled at send time, and the advisor's review note (if any) is
    // appended below the template. DIGEST_ENABLED toggles the morning
    // advisor digest (Scheduler job). NOTIFY_ON_UPLOAD toggles the
    // per-upload email to advisors when a student submits a transcript
    // (fires on both new uploads and resubmissions).
    headers: ['Key', 'Value'],
    seed: [
      ['DIGEST_ENABLED', 'TRUE'],
      ['NOTIFY_ON_UPLOAD', 'TRUE'],
      ['NOTIFY_PROCESSED',
       'Hello {FirstName},\n\nYour transcript from {College} has been processed. '
       + 'Your prerequisite credit is being handled through the appropriate campus '
       + 'process. No further action is needed from you at this time.\n\n'
       + '— UCSC Anthropology Department'],
      ['NOTIFY_NO_ARTICULATION',
       'Hello {FirstName},\n\nWe reviewed your transcript from {College}. The '
       + 'course(s) you submitted do not have an established articulation to the '
       + 'required UCSC Anthropology prerequisite, so they cannot be applied as '
       + 'prerequisite credit. Please contact the Anthropology undergraduate '
       + 'advising office to discuss your options.\n\n'
       + '— UCSC Anthropology Department'],
    ],
  },
  CLASS_SCHEDULE: {
    tab: 'ClassSchedule',
    // Class schedule service: one row per real individual-studies section
    // parsed from the registrar's Schedule of Classes export. Term-wide
    // (all courses admitted) so any consumer reads its own course slice.
    // InstructorRaw is the verbatim report spelling; InstructorEmail is the
    // resolved profile (blank for Staff/unmatched). Wholesale-replaced per
    // term on re-import. Meta columns filled by DataService.
    headers: ['RowID', 'Term', 'Course', 'Title', 'Section', 'ClassNbr', 'Units',
              'Component', 'InstructorRaw', 'InstructorEmail', 'MatchMethod',
              'IsStaffPlaceholder',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  CLASS_SCHEDULE_IMPORTS: {
    tab: 'ClassScheduleImports',
    // Class schedule service: one row per committed import, for
    // auditability — when a term's table was (re)built, by whom, and the
    // matched/unmatched/staff counts. ReplacedExisting records whether the
    // commit overwrote a prior table for the term.
    headers: ['ImportID', 'Term', 'RowCount', 'MatchedCount', 'UnmatchedCount',
              'StaffCount', 'ImportedBy', 'ReplacedExisting',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  INDIVIDUAL_STUDIES: {
    tab: 'Petitions',
    // Undergraduate Individual Studies petitions (one study per record;
    // identity key is student + term + instructor + course). StudentEmail /
    // SponsorEmail are routing keys — names and Student ID are read from
    // Auth at display time. Petition-specific facts not on the profile
    // (Phone, College, MajorStatus, ClassLevel) ARE stored here. The
    // canonical PDF is generated at COMPLETE via ReportService; DriveFileID
    // / DocumentLink are filled then. Meta columns filled by DataService.
    // TermCode is the canonical registrar term key (e.g. "2258"); Quarter/
    // Year are the human-readable labels derived from it for display. The
    // course list and a course's Credits both come from the imported
    // schedule (ClassSchedule), not from code. Syllabus* hold an optional
    // supporting document (student or sponsor supplied); the canonical
    // petition PDF is generated at COMPLETE (DriveFileID/DocumentLink).
    headers: ['PetitionID', 'StudentEmail', 'TermCode', 'Quarter', 'Year', 'Course', 'SponsorEmail',
              'StudySiteAddress', 'Title', 'CourseDescription', 'EvidenceOfPreparation',
              'WorkToBeSubmitted', 'ReportRequired', 'ReportDueDate',
              'HoursWithSponsor', 'HoursIndependent',
              'Phone', 'College', 'MajorStatus', 'ClassLevel',
              'Stage',
              'Credits', 'GradeOption', 'SponsorComments', 'SponsorDecidedBy', 'SponsorDecidedAt',
              'ClassNumber', 'ClassSection', 'ClassNumberSource',
              'TotalSpecialStudyCredits', 'MajorAuthRequired', 'MajorAuthorized',
              'AdvisorComments', 'AdvisorProcessedBy', 'AdvisorProcessedAt',
              'SyllabusFileID', 'SyllabusLink', 'SyllabusName',
              'RoomAccessRequested', 'RoomAccessRoom', 'RoomAccessNote',
              'RoomAccessRequestedBy', 'RoomAccessRequestedAt',
              'DriveFileID', 'FileName', 'DocumentLink', 'ReturnNote',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },

  INDIVIDUAL_STUDIES_TEMPLATES: {
    tab: 'Templates',
    // Sponsor-owned petition templates. A sponsor (or super_admin authoring
    // on their behalf) saves recurring study fields here; on the New Petition
    // form, choosing that sponsor surfaces their templates and the one flagged
    // IsDefault auto-applies. SponsorEmail is the owner/routing key. Course is
    // stored as a default; credits/title still resolve from the term schedule
    // at apply time. ReportRequired/ReportDueText are sponsor-owned and ride
    // silently onto the petition at submit. Lives in the same spreadsheet as
    // Petitions. Meta columns filled by DataService.
    headers: ['TemplateID', 'SponsorEmail', 'Name', 'IsDefault',
              'Course', 'Title', 'CourseDescription', 'WorkToBeSubmitted',
              'EvidenceOfPreparation', 'GradeOption', 'HoursWithSponsor',
              'ReportRequired', 'ReportDueText', 'RoomAccessRoom', 'Active',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },

  PERSON_ATTRIBUTES: {
    tab: 'PersonAttributes',
    // Academic Personnel module — tall, namespaced person-attribute table.
    // The hybrid profile model: core identity (name/IDs/roles) stays wide in
    // Auth's Users tab; module-specific EXTENSION attributes live here, one
    // row per (Email, Namespace, Key). Phase 1 stores the 'personnel'
    // namespace keys rank / step / series / tier, supplied by the rank/step
    // import. A future platform-wide profile module can absorb these rows.
    //
    // Identity of a row is (Email, Namespace, Key) — single-valued per key
    // (the current value). AttrID is a stable unique id so a value can be
    // superseded in place without touching a sibling attribute of the same
    // person. EffectiveDate stamps when the value was last set. Email is the
    // join key (lowercased), resolved to a profile via PersonMatch at import
    // time. Meta columns filled by DataService.
    headers: ['AttrID', 'Email', 'Namespace', 'Key', 'Value', 'EffectiveDate',
              'Notes', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  CASES: {
    tab: 'Cases',
    // Academic Personnel — one row per review case: a candidate up for a
    // given review in a given academic year. Identity is
    // (CandidateEmail, AcademicYear, ReviewType) — a person can have at most
    // one case of each review type per year. CandidateEmail is a routing key;
    // the name is read from Auth at display time, not copied here.
    //
    //   ReviewType     — canonical type (merit / salary_increase_only /
    //                    promotion / midcareer). Suggested from the Call at
    //                    import, overridable (candidate election).
    //   SubjectRank    — the rank the case concerns (from the Call).
    //   Step           — the step the case concerns.
    //   CallActionRaw  — the verbatim Call Action string, preserved as the
    //                    original record even when ReviewType is overridden.
    //   OAFlag         — on/above-scale flag from the Call (o/a).
    //   YrsRank/YrsStep/Qtrs — time-in-grade context from the Call.
    //   IsReappointment— derived: true when SubjectRank is Assistant-level.
    //   IsMandatory    — timing flag parsed from the Call string.
    //   Status         — open / in_progress / deferred / closed / completed.
    //   IsElected      — TRUE when the candidate ELECTED this review rather
    //                    than being listed on the Call. Covers faculty at
    //                    indefinite steps (Professor 5+), who are only
    //                    automatically called at the five-year mandatory but
    //                    may elect a review once normative time is served; and
    //                    accelerations (a review sought before the normative
    //                    interval is complete). Manually-added cases; the
    //                    CallActionRaw is empty for these.
    //   EffectiveDate  — the date the action takes (or took) effect,
    //                    'yyyy-MM-dd', typically a July 1. Set for in-progress
    //                    cases (the anticipated reset) and completed ones (the
    //                    actual reset). The eligibility clock keys on this,
    //                    not on when the paperwork concluded.
    //   Cycle key note — AcademicYear like "2026-27".
    headers: ['CaseID', 'CandidateEmail', 'AcademicYear', 'ReviewType',
              'SubjectRank', 'Step', 'CallActionRaw', 'OAFlag',
              'YrsRank', 'YrsStep', 'Qtrs',
              'IsReappointment', 'IsMandatory', 'IsElected',
              'Status', 'EffectiveDate', 'Notes',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  CYCLES: {
    tab: 'Cycles',
    // Academic Personnel — one row per review cycle (academic year), holding
    // the SCHEDULER ANCHORS: the calendar DeadlineIDs this cycle's schedule is
    // computed from. Anchors are cycle-wide (all cases in the year share them).
    //
    // We store the calendar's immutable DeadlineID, never a title or a date —
    // titles are upstream's words and dates move. At compute time the id is
    // resolved via CalendarService.getDeadlineById(), which also reports a
    // REMOVED anchor so a vanished deadline is flagged rather than silently
    // producing a stale schedule.
    //
    // The Division sets TWO submission deadlines, split by how heavy the review
    // is — so a cycle carries both, and a case's review type decides which one
    // anchors its schedule (see CONFIG.PERSONNEL.DIVISION_DEADLINE_BY_TYPE):
    //   MeritDeadlineID  — "Merit files due to Division". Anchors merit and
    //                      salary-increase-only cases.
    //   MajorDeadlineID  — "Files with external reviewer letters (Promotion and
    //                      Initial Above Scale), Step 6, and Mid-Career files
    //                      due to Division". Anchors promotion and mid-career
    //                      cases — the heavier reviews, with an earlier date.
    //   LettersDueDeadlineID — external letters due (promotions); the forward
    //                      anchor for the early candidate-review window. Often
    //                      blank: letters are due to the department on Nov 1 by
    //                      standing practice rather than a published calendar
    //                      entry (see CONFIG.PERSONNEL.LETTERS_DUE_DEFAULT).
    //   LettersDueDate   — an explicit letters-due date ('yyyy-MM-dd') that
    //                      overrides both the calendar entry and the Nov 1
    //                      default. Blank unless someone types one.
    //
    // Resolution order for letters-due: LettersDueDate (typed) →
    // LettersDueDeadlineID (calendar) → Nov 1 of the cycle's first year.
    //
    // AutoMatched — 'TRUE' when the division anchors were filled in by the
    //   automatic title match rather than chosen by hand. A hand-picked anchor
    //   is never overwritten by a later auto-match.
    headers: ['CycleID', 'AcademicYear', 'MeritDeadlineID', 'MajorDeadlineID',
              'LettersDueDeadlineID', 'LettersDueDate', 'AutoMatched',
              'Notes', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  PERSONNEL_SETTINGS: {
    tab: 'Settings',
    // Academic Personnel — module settings as key/value rows. Currently the
    // scheduler's gap parameters (business-day spacing between the internal
    // deadlines), editable in the Settings tab so the department can tune its
    // process without a code change. A missing key falls back to the CONFIG
    // default, so an empty tab behaves exactly as before.
    headers: ['Key', 'Value', 'Notes', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  REVIEW_HISTORY: {
    tab: 'ReviewHistory',
    // Academic Personnel — one row per completed review in a person's
    // history. Seeded by a one-time import of the APO action ledger
    // (review-coded rows only, matched to the roster by CruzID) and
    // APPENDED to going forward when a case is marked Completed, so the
    // ledger self-maintains. Read by the eligibility logic (the
    // mandatory-review 5-year clock resets at the most recent entry) and
    // shown as a per-person timeline.
    //   PersonEmail   — routing key (name read from Auth at display time).
    //   ReviewDate    — effective date of the action ('yyyy-MM-dd').
    //   ReviewCode    — action code (IAP/MI/PR/SI/REMI/RESI/MD/MA).
    //   TitleAtTime   — appointment title on the action row (context).
    //   StepAtTime    — step on the action row (context).
    //   AcademicYear  — the report's academic-year label, if present.
    //   Source        — 'imported' (ledger backfill) or 'case' (completed
    //                    case appended it); CaseID set when Source='case'.
    //   CaseID        — the case that produced this entry (Source='case').
    headers: ['ReviewID', 'PersonEmail', 'ReviewDate', 'ReviewCode',
              'TitleAtTime', 'StepAtTime', 'AcademicYear', 'Source', 'CaseID',
              'Notes', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
};


/**
 * Main entry point. Run this once from the editor.
 */
function setUp() {
  Logger.log('=== UCSC Anthropology Portal — Sheet setup ===');

  // Resolve (or create) the spreadsheets
  const usersSS  = _resolveSpreadsheet(CONFIG.SHEETS.USERS_CONFIG,  'Portal Config (Users, Roles, Modules)', 'USERS_CONFIG');
  const auditSS  = _resolveSpreadsheet(CONFIG.SHEETS.AUDIT_LOG,     'Portal Audit Log',                      'AUDIT_LOG');
  const submitSS = _resolveSpreadsheet(CONFIG.SHEETS.SUBMISSIONS,   'Portal Submissions',                    'SUBMISSIONS');
  const platformSS = _resolveSpreadsheet(CONFIG.SHEETS.PLATFORM,    'Portal Platform Services',              'PLATFORM');
  const thesisSS = _resolveSpreadsheet(CONFIG.SHEETS.THESIS,        'Portal Senior Thesis',                  'THESIS');
  const transcriptSS = _resolveSpreadsheet(CONFIG.SHEETS.TRANSCRIPT, 'Portal Transcript / Articulations',    'TRANSCRIPT');
  const classScheduleSS = _resolveSpreadsheet(CONFIG.SHEETS.CLASS_SCHEDULE, 'Portal Class Schedule',         'CLASS_SCHEDULE');
  const indStudiesSS = _resolveSpreadsheet(CONFIG.SHEETS.INDIVIDUAL_STUDIES, 'Portal Individual Studies',     'INDIVIDUAL_STUDIES');
  const personnelSS = _resolveSpreadsheet(CONFIG.SHEETS.PERSONNEL,  'Portal Academic Personnel',             'PERSONNEL');

  // Config spreadsheet gets Users, Roles, Modules, Requests tabs
  _setupTab(usersSS, SETUP_SCHEMA.USERS);
  _setupTab(usersSS, SETUP_SCHEMA.ROLES);
  _setupTab(usersSS, SETUP_SCHEMA.MODULES);
  _setupTab(usersSS, SETUP_SCHEMA.REQUESTS);
  _setupTab(usersSS, SETUP_SCHEMA.IMPORT_POLICY);
  _setupTab(usersSS, SETUP_SCHEMA.NOTIFY_RULES);
  _setupTab(usersSS, SETUP_SCHEMA.THESIS_ELIGIBILITY);
  _setupTab(usersSS, SETUP_SCHEMA.THESIS_SETTINGS);
  _setupTab(usersSS, SETUP_SCHEMA.SETTINGS);

  // Audit spreadsheet gets the AuditLog tab
  _setupTab(auditSS, SETUP_SCHEMA.AUDIT);

  // Platform-services spreadsheet: Tasks (first tenant) + Reports
  // (ReportService's archive log, the second tenant)
  _setupTab(platformSS, SETUP_SCHEMA.TASKS);
  _setupTab(platformSS, SETUP_SCHEMA.REPORTS);

  // Senior Thesis spreadsheet gets the Thesis tab
  _setupTab(thesisSS, SETUP_SCHEMA.THESIS);
  _tidyDefaultSheet(thesisSS);

  // Transcript / ASSIST-articulation spreadsheet gets its tabs
  _setupTab(transcriptSS, SETUP_SCHEMA.ARTICULATIONS);
  _setupTab(transcriptSS, SETUP_SCHEMA.ARTICULATION_REVIEW);
  _setupTab(transcriptSS, SETUP_SCHEMA.TRANSCRIPTS);
  _setupTab(transcriptSS, SETUP_SCHEMA.TRANSCRIPT_SETTINGS);
  _tidyDefaultSheet(transcriptSS);

  // Class schedule service spreadsheet gets its two tabs
  _setupTab(classScheduleSS, SETUP_SCHEMA.CLASS_SCHEDULE);
  _setupTab(classScheduleSS, SETUP_SCHEMA.CLASS_SCHEDULE_IMPORTS);
  _tidyDefaultSheet(classScheduleSS);

  // Individual Studies module spreadsheet gets the Petitions tab
  _setupTab(indStudiesSS, SETUP_SCHEMA.INDIVIDUAL_STUDIES);
  _setupTab(indStudiesSS, SETUP_SCHEMA.INDIVIDUAL_STUDIES_TEMPLATES);
  _tidyDefaultSheet(indStudiesSS);

  // Academic Personnel module spreadsheet gets the PersonAttributes + Cases tabs
  _setupTab(personnelSS, SETUP_SCHEMA.PERSON_ATTRIBUTES);
  _setupTab(personnelSS, SETUP_SCHEMA.CASES);
  _setupTab(personnelSS, SETUP_SCHEMA.REVIEW_HISTORY);
  _setupTab(personnelSS, SETUP_SCHEMA.CYCLES);
  _setupTab(personnelSS, SETUP_SCHEMA.PERSONNEL_SETTINGS);
  _tidyDefaultSheet(personnelSS);

  // Submissions spreadsheet: tabs are created per form type on demand,
  // so we just ensure the spreadsheet exists and remove the default
  // empty "Sheet1" only if it's untouched.
  _tidyDefaultSheet(submitSS);

  // Ensure the current runner is a usable super-admin
  _ensureSuperAdminNote();

  Logger.log('');
  Logger.log('=== Setup complete ===');
  Logger.log('If any IDs were created above, paste them into CONFIG.SHEETS in Config.gs.');
  Logger.log('Then deploy/redeploy and open the web app.');
}


/**
 * Returns a Spreadsheet for the given configured ID. If the ID is
 * still a placeholder (or invalid), creates a new spreadsheet and
 * logs its ID so the admin can paste it into Config.gs.
 */
function _resolveSpreadsheet(configuredId, newName, configKey) {
  const looksPlaceholder = !configuredId
    || configuredId.indexOf('YOUR_') === 0
    || configuredId.length < 20;

  if (!looksPlaceholder) {
    try {
      const ss = SpreadsheetApp.openById(configuredId);
      Logger.log('• ' + configKey + ': using existing sheet "' + ss.getName() + '"');
      return ss;
    } catch (e) {
      Logger.log('• ' + configKey + ': ID "' + configuredId + '" could not be opened — creating a new sheet instead.');
    }
  }

  const ss = SpreadsheetApp.create(newName);
  _moveToFolder(ss.getId(), newName, configKey);
  Logger.log('• ' + configKey + ': CREATED new sheet "' + newName + '"');
  Logger.log('    → set CONFIG.SHEETS.' + configKey + " = '" + ss.getId() + "'");
  return ss;
}


/**
 * Moves a newly created file into CONFIG.SETUP_FOLDER_ID, if set.
 * SpreadsheetApp.create() always places files in My Drive root, so
 * we relocate afterward. Silently no-ops (stays in root) if no folder
 * is configured; logs a warning if the folder ID is invalid.
 */
function _moveToFolder(fileId, name, configKey) {
  const folderId = (CONFIG.SETUP_FOLDER_ID || '').trim();
  if (!folderId) {
    Logger.log('    • ' + configKey + ': placed in My Drive root (no SETUP_FOLDER_ID set)');
    return;
  }
  try {
    const folder = DriveApp.getFolderById(folderId);
    const file   = DriveApp.getFileById(fileId);
    file.moveTo(folder);   // moveTo relocates (not just adds) the file
    Logger.log('    ✓ ' + configKey + ': moved into folder "' + folder.getName() + '"');
  } catch (e) {
    Logger.log('    ⚠ ' + configKey + ': could not move into SETUP_FOLDER_ID "' + folderId
               + '" (' + e.message + '). File remains in My Drive root.');
  }
}


/**
 * Ensures a tab exists with the given headers and seed rows.
 * - Creates the tab if missing.
 * - Adds the header row if the tab is empty.
 * - Adds seed rows only if the tab has just a header (no data yet).
 * Never overwrites existing data.
 */
function _setupTab(ss, def) {
  let sheet = ss.getSheetByName(def.tab);
  let created = false;

  if (!sheet) {
    sheet = ss.insertSheet(def.tab);
    created = true;
  }

  const lastRow = sheet.getLastRow();

  if (lastRow === 0) {
    // Empty tab — add headers
    sheet.appendRow(def.headers);
    sheet.getRange(1, 1, 1, def.headers.length)
         .setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);

    // Seed rows (only for a fresh tab)
    if (def.seed && def.seed.length) {
      def.seed.forEach(row => sheet.appendRow(row));
      Logger.log('    ✓ ' + def.tab + ': created with headers + ' + def.seed.length + ' seed row(s)');
    } else {
      Logger.log('    ✓ ' + def.tab + ': created with headers');
    }
  } else {
    Logger.log('    • ' + def.tab + ': already has ' + (lastRow - 1) + ' data row(s) — left unchanged'
               + (created ? ' (tab was just created)' : ''));
  }

  // Auto-size columns for readability. Only resize columns that actually
  // exist on the sheet: an existing tab may have FEWER physical columns
  // than def.headers (e.g. the schema gained columns since the tab was
  // first created). Resizing beyond the sheet's width throws
  // "Those columns are out of bounds." Missing columns are added later by
  // addMissingColumns(), not here — setUp never modifies an existing tab.
  const physicalCols = sheet.getLastColumn();
  const resizeCount = Math.min(def.headers.length, physicalCols);
  if (resizeCount > 0) {
    sheet.autoResizeColumns(1, resizeCount);
  }
}


/**
 * Removes the default "Sheet1" from a newly created spreadsheet if it's
 * empty and there is at least one other sheet, to keep things tidy.
 */
function _tidyDefaultSheet(ss) {
  const sheets = ss.getSheets();
  if (sheets.length <= 1) {
    Logger.log('    • Submissions: ready (form-type tabs are created on first submission)');
    return;
  }
  const def = ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && sheets.length > 1) {
    ss.deleteSheet(def);
    Logger.log('    ✓ Submissions: removed empty default Sheet1');
  }
}


/**
 * Logs guidance about the super-admin. Does not modify the Users tab,
 * since super-admins are recognized via CONFIG.SUPER_ADMINS regardless.
 */
function _ensureSuperAdminNote() {
  const me = Session.getActiveUser().getEmail();
  const admins = CONFIG.SUPER_ADMINS.map(a => a.toLowerCase());
  if (admins.indexOf(me.toLowerCase()) === -1) {
    Logger.log('');
    Logger.log('⚠ You (' + me + ') are NOT in CONFIG.SUPER_ADMINS.');
    Logger.log('  Add your email to SUPER_ADMINS in Config.gs so you can reach the Admin area,');
    Logger.log('  or add a row in the Users tab: ' + me + ' | (name) | super_admin | | | TRUE | Initial admin');
  } else {
    Logger.log('• Super-admin confirmed: ' + me);
  }
}


/**
 * Optional helper: prints the current configured sheet IDs and whether
 * each opens successfully. Handy for verifying Config after setup.
 */
function checkSetup() {
  const checks = [
    ['USERS_CONFIG', CONFIG.SHEETS.USERS_CONFIG, [SETUP_SCHEMA.USERS.tab, SETUP_SCHEMA.ROLES.tab, SETUP_SCHEMA.MODULES.tab, SETUP_SCHEMA.SETTINGS.tab]],
    ['AUDIT_LOG',    CONFIG.SHEETS.AUDIT_LOG,    [SETUP_SCHEMA.AUDIT.tab]],
    ['SUBMISSIONS',  CONFIG.SHEETS.SUBMISSIONS,  []],
    ['PLATFORM',     CONFIG.SHEETS.PLATFORM,     [SETUP_SCHEMA.TASKS.tab, SETUP_SCHEMA.REPORTS.tab]],
    ['THESIS',       CONFIG.SHEETS.THESIS,       [SETUP_SCHEMA.THESIS.tab]],
    ['TRANSCRIPT',   CONFIG.SHEETS.TRANSCRIPT,   [SETUP_SCHEMA.ARTICULATIONS.tab, SETUP_SCHEMA.ARTICULATION_REVIEW.tab, SETUP_SCHEMA.TRANSCRIPTS.tab, SETUP_SCHEMA.TRANSCRIPT_SETTINGS.tab]],
    ['CLASS_SCHEDULE', CONFIG.SHEETS.CLASS_SCHEDULE, [SETUP_SCHEMA.CLASS_SCHEDULE.tab, SETUP_SCHEMA.CLASS_SCHEDULE_IMPORTS.tab]],
    ['INDIVIDUAL_STUDIES', CONFIG.SHEETS.INDIVIDUAL_STUDIES, [SETUP_SCHEMA.INDIVIDUAL_STUDIES.tab, SETUP_SCHEMA.INDIVIDUAL_STUDIES_TEMPLATES.tab]],
    ['PERSONNEL',    CONFIG.SHEETS.PERSONNEL,    [SETUP_SCHEMA.PERSON_ATTRIBUTES.tab, SETUP_SCHEMA.CASES.tab, SETUP_SCHEMA.REVIEW_HISTORY.tab, SETUP_SCHEMA.CYCLES.tab, SETUP_SCHEMA.PERSONNEL_SETTINGS.tab]],
  ];
  Logger.log('=== Config check ===');
  checks.forEach(([key, id, tabs]) => {
    try {
      const ss = SpreadsheetApp.openById(id);
      const present = ss.getSheets().map(s => s.getName());
      const missing = tabs.filter(t => present.indexOf(t) === -1);
      Logger.log('• ' + key + ': OK ("' + ss.getName() + '")'
                 + (missing.length ? ' — MISSING tabs: ' + missing.join(', ') : ''));
    } catch (e) {
      Logger.log('• ' + key + ': CANNOT OPEN id="' + id + '" — ' + e.message);
    }
  });
}


/**
 * Maps each schema tab to the CONFIG.SHEETS key whose spreadsheet holds
 * it. Single source of truth for "which tab lives in which spreadsheet,"
 * used by the non-destructive migration helper below. Mirrors the
 * placement that setUp() performs.
 */
function _schemaPlacement() {
  return [
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.USERS },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.ROLES },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.MODULES },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.REQUESTS },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.IMPORT_POLICY },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.NOTIFY_RULES },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.THESIS_ELIGIBILITY },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.THESIS_SETTINGS },
    { sheetKey: 'USERS_CONFIG', def: SETUP_SCHEMA.SETTINGS },
    { sheetKey: 'AUDIT_LOG',    def: SETUP_SCHEMA.AUDIT },
    { sheetKey: 'PLATFORM',     def: SETUP_SCHEMA.TASKS },
    { sheetKey: 'PLATFORM',     def: SETUP_SCHEMA.REPORTS },
    { sheetKey: 'THESIS',       def: SETUP_SCHEMA.THESIS },
    { sheetKey: 'TRANSCRIPT',   def: SETUP_SCHEMA.ARTICULATIONS },
    { sheetKey: 'TRANSCRIPT',   def: SETUP_SCHEMA.ARTICULATION_REVIEW },
    { sheetKey: 'TRANSCRIPT',   def: SETUP_SCHEMA.TRANSCRIPTS },
    { sheetKey: 'TRANSCRIPT',   def: SETUP_SCHEMA.TRANSCRIPT_SETTINGS },
    { sheetKey: 'CLASS_SCHEDULE', def: SETUP_SCHEMA.CLASS_SCHEDULE },
    { sheetKey: 'CLASS_SCHEDULE', def: SETUP_SCHEMA.CLASS_SCHEDULE_IMPORTS },
    { sheetKey: 'INDIVIDUAL_STUDIES', def: SETUP_SCHEMA.INDIVIDUAL_STUDIES },
    { sheetKey: 'INDIVIDUAL_STUDIES', def: SETUP_SCHEMA.INDIVIDUAL_STUDIES_TEMPLATES },
    { sheetKey: 'PERSONNEL',    def: SETUP_SCHEMA.PERSON_ATTRIBUTES },
    { sheetKey: 'PERSONNEL',    def: SETUP_SCHEMA.CASES },
    { sheetKey: 'PERSONNEL',    def: SETUP_SCHEMA.REVIEW_HISTORY },
    { sheetKey: 'PERSONNEL',    def: SETUP_SCHEMA.CYCLES },
    { sheetKey: 'PERSONNEL',    def: SETUP_SCHEMA.PERSONNEL_SETTINGS },
  ];
}


/**
 * Non-destructive schema migration: for every existing tab, appends any
 * header columns present in SETUP_SCHEMA but missing from the live sheet.
 *
 * SAFETY — this ONLY ever ADDS columns to the right:
 *   - never deletes a column, never renames one, never reorders;
 *   - never touches data rows;
 *   - skips tabs that don't exist yet (that's setUp()'s job);
 *   - skips a spreadsheet whose CONFIG id is blank/unopenable.
 * Because the platform reads columns BY HEADER NAME, appending at the end
 * is fully sufficient — position never matters to the code.
 *
 * Run this from the editor after adding fields to a SETUP_SCHEMA tab
 * (e.g. the Tasks time columns) instead of deleting and recreating a tab.
 * Safe to re-run: a tab already matching the schema is left untouched.
 */
function addMissingColumns() {
  Logger.log('=== addMissingColumns (non-destructive) ===');
  let totalAdded = 0;

  _schemaPlacement().forEach(({ sheetKey, def }) => {
    const id = CONFIG.SHEETS[sheetKey];
    if (!id) {
      Logger.log('• ' + def.tab + ': skipped — CONFIG.SHEETS.' + sheetKey + ' is blank.');
      return;
    }

    let ss;
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (e) {
      Logger.log('• ' + def.tab + ': skipped — cannot open ' + sheetKey + ' (' + e.message + ').');
      return;
    }

    const sheet = ss.getSheetByName(def.tab);
    if (!sheet) {
      Logger.log('• ' + def.tab + ': skipped — tab does not exist yet (run setUp to create it).');
      return;
    }

    // Read the current header row. An empty tab has no headers to compare;
    // leave it for setUp() rather than half-populating it here.
    const lastCol = sheet.getLastColumn();
    if (sheet.getLastRow() === 0 || lastCol === 0) {
      Logger.log('• ' + def.tab + ': skipped — tab is empty (run setUp to add headers).');
      return;
    }

    const liveHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
      .map(h => String(h).trim());
    const missing = def.headers.filter(h => liveHeaders.indexOf(h) === -1);

    if (!missing.length) {
      Logger.log('• ' + def.tab + ': up to date (' + liveHeaders.length + ' columns).');
      return;
    }

    // Append missing headers to the right of the existing ones.
    const startCol = lastCol + 1;
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
    sheet.getRange(1, startCol, 1, missing.length)
         .setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
    sheet.autoResizeColumns(1, startCol + missing.length - 1);

    totalAdded += missing.length;
    Logger.log('    ✓ ' + def.tab + ': added ' + missing.length
               + ' column(s) → ' + missing.join(', '));
  });

  Logger.log('');
  Logger.log(totalAdded === 0
    ? '=== All tabs already match the schema. ==='
    : '=== Done: added ' + totalAdded + ' column(s) total. ===');
}