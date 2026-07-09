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
    //   Status         — 'open' or 'deferred' (candidate postponed).
    //   Cycle key note — AcademicYear like "2026-27".
    headers: ['CaseID', 'CandidateEmail', 'AcademicYear', 'ReviewType',
              'SubjectRank', 'Step', 'CallActionRaw', 'OAFlag',
              'YrsRank', 'YrsStep', 'Qtrs',
              'IsReappointment', 'IsMandatory', 'Status', 'Notes',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  SERVICE_CATALOG: {
    tab: 'ServiceCatalog',
    // Department Service — the catalog of service positions/committees.
    // Replaces the legacy app's Settings sheet AND its hardcoded category
    // lists: display behavior is driven by attributes (IsQuarterly,
    // DefaultRole, IsLeadership, SortWeight; NominationEligible is used by
    // the Phase 2 self-nomination cycle). Key is a permanent slug —
    // assignment rows reference it — while Label stays editable. Categories
    // in use are deactivated, never deleted. No seed: the legacy import
    // auto-creates entries, and staff add/tune them via the module UI.
    headers: ['Key', 'Label', 'Active', 'IsQuarterly', 'DefaultRole',
              'IsLeadership', 'SortWeight', 'NominationEligible', 'AutoAssigns',
              'Notes',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  SERVICE_ASSIGNMENTS: {
    tab: 'ServiceAssignments',
    // Department Service — one row per service assignment (person ×
    // category × role × academic year × quarter). Identity is NOT copied:
    // PersonEmail is the routing key and names are read from Auth at
    // display time. RawName is kept ONLY for historical people with no
    // portal profile (21 years of legacy data includes retired/departed
    // faculty); matching a record to a profile clears it — never both.
    // Year is "YYYY-YY"; Quarter is blank, 'AY', or slash-joined quarters
    // (e.g. "Fall/Winter"). Odd legacy Quarter values are shunted into
    // Notes at import. Meta columns filled by DataService.
    headers: ['AssignmentID', 'PersonEmail', 'RawName', 'CategoryKey',
              'Role', 'Year', 'Quarter', 'Notes',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  SERVICE_CORRECTIONS: {
    tab: 'ServiceCorrections',
    // Department Service — correction requests against the service record.
    // This row is the AUTHORITATIVE record; the staff-pool Task created
    // alongside it is a pointer (Tasks stores routing, never business
    // data). Replaces the legacy write-only Corrections sheet: requests
    // now surface on staff dashboards and are resolved explicitly.
    // CategoryLabel is the requester's free text; CategoryKey is filled
    // only when it resolves to a catalog entry. Resolving a request is
    // separate from making the actual record fix (a deliberate
    // add/edit/delete of an assignment). Meta columns via DataService.
    headers: ['CorrectionID', 'PersonEmail', 'Year', 'CategoryKey',
              'CategoryLabel', 'Role', 'Quarter', 'Note', 'Status',
              'ResolvedBy', 'ResolvedAt', 'ResolutionNote',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  SERVICE_NOMINATIONS: {
    tab: 'ServiceNominations',
    // Department Service — ranked self-nomination preferences for a target
    // academic year. All-authenticated (PersonEmail only; no RawName path).
    // Priority is the person's own ranking (1 = first choice) among their
    // OPEN nominations for that year; it informs the super admin's
    // assignment decisions but is NOT a guarantee. Status: OPEN →
    // WITHDRAWN (by the nominator while the window is open) or ACCEPTED /
    // DECLINED (super admin; accepting creates the proposed next-year
    // assignment). DecisionNote is internal — never shown to the
    // nominator. Meta columns filled by DataService.
    headers: ['NominationID', 'PersonEmail', 'Year', 'CategoryKey', 'Role',
              'Quarter', 'Priority', 'Note', 'Status',
              'DecidedBy', 'DecidedAt', 'DecisionNote',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  SERVICE_SETTINGS: {
    tab: 'ServiceSettings',
    // Department Service — UI-managed operational settings (key/value),
    // mirroring ThesisSettings / TranscriptSettings. NOMINATIONS_OPEN is
    // the staff-facing window toggle (super_admin-controlled in this
    // module); NOMINATION_YEAR is the target academic year locked in when
    // the window is opened, so a window that straddles July 1 keeps
    // targeting the year it was opened for.
    headers: ['Key', 'Value'],
    seed: [
      ['NOMINATIONS_OPEN', 'FALSE'],
    ],
  },
  CALENDAR_EVENTS: {
    tab: 'CalendarEvents',
    // Calendar service (CalendarService.gs) — timed department events.
    // Phase 1 renders these read-only; creation arrives with the Events
    // module. LocationKey stays blank until a Facilities module exists
    // (free-text LocationLabel carries the venue until then); Attendees
    // is reserved for future person-collision checking. Restricted TRUE
    // hides the event from viewers whose roles don't intersect
    // AudienceRoles (super_admin always sees). Meta via DataService.
    headers: ['EventID', 'Title', 'Description', 'Start', 'End',
              'LocationKey', 'LocationLabel', 'AudienceRoles',
              'Restricted', 'Attendees', 'Status',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  CALENDAR_DEADLINES: {
    tab: 'CalendarDeadlines',
    // Calendar service — externally set deadlines the department tracks
    // centrally. Origin: manual | harvested | imported. SourceKey /
    // ExternalUID / LastSeenAt are Phase 2 import provenance. Pinned
    // marks a human-edited imported row that a refresh must never
    // overwrite (it reports divergence instead). Perennial marks a
    // same-date-every-year deadline. AudienceRoles filters display
    // ("aimed at me"), never visibility. Meta via DataService.
    // Kind (Phase 3.5): 'deadline' (default) | 'closure'. Closures are
    // non-working days (holidays, campus closures) — rendered as a
    // day-state wash on the calendar, excluded from deadline queries,
    // and served to the Personnel scheduler via listClosures(). The
    // Registrar feed's holiday entries are committed AS closures.
    // Color (Phase 3.5): optional per-entry palette key ('' = kind
    // default). Reviewer metadata — never pins an imported row.
    headers: ['DeadlineID', 'Title', 'Description', 'Date',
              'AudienceRoles', 'Source', 'Link', 'Origin',
              'SourceKey', 'ExternalUID', 'Perennial', 'Pinned',
              'Status', 'LastSeenAt', 'Kind', 'Color',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  CALENDAR_SOURCES: {
    tab: 'CalendarSources',
    // Calendar service — Phase 2 import-source registry (created now so
    // setUp runs once). Type: gcal | gsheet | html. ParserKey maps a
    // source to its extractor function, mirroring how the Modules sheet's
    // Handler column maps to code. LastFetchedAt vs LastSuccessAt lets a
    // broken scraper surface as stale instead of silently serving old
    // data. Meta via DataService.
    // FailStreak (Phase 3.3): consecutive nightly-refresh failures.
    // The fail-loud email fires at streak 3 (and every 3rd after), so
    // one night of campus transport roulette doesn't cry wolf at 6 AM;
    // the stale marking in the UI remains immediate. Reset on success.
    headers: ['SourceKey', 'Label', 'Type', 'URL', 'CalendarID',
              'ParserKey', 'Enabled', 'LastFetchedAt',
              'LastSuccessAt', 'LastResult', 'FailStreak',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    seed: [],
  },
  CALENDAR_PENDING: {
    tab: 'CalendarPending',
    // Calendar service — the nightly refresh's REVIEW QUEUE. One row per
    // proposed change from an import source, awaiting a human's
    // commit/dismiss in the module's Imports tab. The refresh wholesale-
    // replaces a source's OPEN rows each run (idempotent); committed/
    // dismissed rows are kept as the review audit trail.
    //   Kind: new | changed | vanished | pinned_diverged
    //   DeadlineID: the existing imported deadline a changed/vanished/
    //     pinned_diverged row targets (blank for new).
    //   Old*/New* pairs let the UI show a side-by-side diff.
    //   Status: open | committed | dismissed.
    // SuggestedAudience (Phase 3): per-item audience roles proposed by a
    // dedicated extractor (e.g. senate rows -> senate_faculty). Applied
    // on commit unless the reviewer overrides via the shared picker.
    headers: ['PendingID', 'SourceKey', 'Kind', 'ExternalUID', 'DeadlineID',
              'Title', 'Date', 'OldTitle', 'OldDate', 'Detail', 'Link',
              'SuggestedAudience',
              'Status', 'DecidedBy', 'DecidedAt',
              'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
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
  const serviceSS = _resolveSpreadsheet(CONFIG.SHEETS.SERVICE,      'Portal Department Service',             'SERVICE');
  const calendarSS = _resolveSpreadsheet(CONFIG.SHEETS.CALENDAR,    'Portal Calendar',                       'CALENDAR');

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
  _tidyDefaultSheet(personnelSS);

  // Department Service module spreadsheet gets its three tabs
  _setupTab(serviceSS, SETUP_SCHEMA.SERVICE_CATALOG);
  _setupTab(serviceSS, SETUP_SCHEMA.SERVICE_ASSIGNMENTS);
  _setupTab(serviceSS, SETUP_SCHEMA.SERVICE_CORRECTIONS);
  _setupTab(serviceSS, SETUP_SCHEMA.SERVICE_NOMINATIONS);
  _setupTab(serviceSS, SETUP_SCHEMA.SERVICE_SETTINGS);
  _tidyDefaultSheet(serviceSS);

  // Calendar service spreadsheet gets its three tabs (CalendarSources is
  // Phase 2 machinery, created now so setUp runs once)
  _setupTab(calendarSS, SETUP_SCHEMA.CALENDAR_EVENTS);
  _setupTab(calendarSS, SETUP_SCHEMA.CALENDAR_DEADLINES);
  _setupTab(calendarSS, SETUP_SCHEMA.CALENDAR_SOURCES);
  _setupTab(calendarSS, SETUP_SCHEMA.CALENDAR_PENDING);
  _tidyDefaultSheet(calendarSS);

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
    ['PERSONNEL',    CONFIG.SHEETS.PERSONNEL,    [SETUP_SCHEMA.PERSON_ATTRIBUTES.tab, SETUP_SCHEMA.CASES.tab]],
    ['SERVICE',      CONFIG.SHEETS.SERVICE,      [SETUP_SCHEMA.SERVICE_CATALOG.tab, SETUP_SCHEMA.SERVICE_ASSIGNMENTS.tab, SETUP_SCHEMA.SERVICE_CORRECTIONS.tab, SETUP_SCHEMA.SERVICE_NOMINATIONS.tab, SETUP_SCHEMA.SERVICE_SETTINGS.tab]],
    ['CALENDAR',     CONFIG.SHEETS.CALENDAR,     [SETUP_SCHEMA.CALENDAR_EVENTS.tab, SETUP_SCHEMA.CALENDAR_DEADLINES.tab, SETUP_SCHEMA.CALENDAR_SOURCES.tab, SETUP_SCHEMA.CALENDAR_PENDING.tab]],
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
    { sheetKey: 'SERVICE',      def: SETUP_SCHEMA.SERVICE_CATALOG },
    { sheetKey: 'SERVICE',      def: SETUP_SCHEMA.SERVICE_ASSIGNMENTS },
    { sheetKey: 'SERVICE',      def: SETUP_SCHEMA.SERVICE_CORRECTIONS },
    { sheetKey: 'SERVICE',      def: SETUP_SCHEMA.SERVICE_NOMINATIONS },
    { sheetKey: 'SERVICE',      def: SETUP_SCHEMA.SERVICE_SETTINGS },
    { sheetKey: 'CALENDAR',     def: SETUP_SCHEMA.CALENDAR_EVENTS },
    { sheetKey: 'CALENDAR',     def: SETUP_SCHEMA.CALENDAR_DEADLINES },
    { sheetKey: 'CALENDAR',     def: SETUP_SCHEMA.CALENDAR_SOURCES },
    { sheetKey: 'CALENDAR',     def: SETUP_SCHEMA.CALENDAR_PENDING },
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