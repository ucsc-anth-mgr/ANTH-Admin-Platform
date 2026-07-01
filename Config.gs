// ============================================================
// Config.gs — Global config + Sheet-backed module registry
// ============================================================
// The module registry now lives in a Google Sheet tab ("Modules")
// so non-developers can manage modules through the Admin UI.
//
// IMPORTANT: A web UI can configure module METADATA (label, icon,
// roles, order, enabled). It cannot create a module's code. The
// handler .gs object and the .html UI file must still exist in the
// project and be registered in getModuleHandler() in Code.gs.
// ============================================================

const CONFIG = {
  APP_TITLE: 'UCSC Anthropology Portal',
  APP_VERSION: '2.0.0',

  // Public alias the portal is reached through (DNS/redirect → this app's
  // /exec URL). Used by Links.gs to build deep links that show the friendly
  // host instead of the raw script.google.com URL. Blank it ('') to revert
  // every deep link to the raw web-app URL. The alias must forward the full
  // query string for focus deep links to land correctly.
  PUBLIC_BASE_URL: 'https://anthroadmin.ucsc.edu/portal',

  // Brand (official UCSC colors)
  BRAND: {
    NAVY:  '#003C6C',   // UCSC Primary Blue
    GOLD:  '#FDC700',   // UCSC Primary Yellow
  },

  SHEETS: {
    USERS_CONFIG:  '1VdiwRD4Dp75a86jdqPid_XCrwGEOp3ix5c2wTisHwMs',       // Tabs: Users, Roles, Modules, Requests, ImportPolicy, NotifyRules, Settings
    AUDIT_LOG:     '1Jog3zXwu5dpAuWuJ8I-VPjbqH4ybRlc3yl1zUzh1HxE',        // Tab: AuditLog
    SUBMISSIONS:   '1zacvd0FhWcjKldhKt9Fan3lWY0QkRAZ3Ol45wobBZl4',  // Tab per form type
    // Senior Thesis module — its OWN spreadsheet (per-module storage tier).
    THESIS:        '16MiWlHY0mTFuBioI5mc1nV3mmiIEbgBssG3h7jO4tBc',
    // Transcript / ASSIST-articulation module — its OWN spreadsheet
    // (per-module storage tier). Tabs: Articulations, ArticulationReview,
    // Transcripts, TranscriptSettings.
    TRANSCRIPT:    '1CPid5jHFa46nZvqdJYQXmAKbtGDRrwG42KcIhn-Hmls',
    // Platform-services operational data (owned by platform-wide services,
    // not by any single module). Tenants: Tasks, Reports.
    PLATFORM:      '1CyVapaV52tFWDGOC4fI7RNyVrcExevQeV7_gR_mpTNg',
    // Class schedule service — its OWN spreadsheet (per-tier storage).
    // Tabs: ClassSchedule, ClassScheduleImports. Blank until setUp()
    // creates it and logs the id to paste back here.
    CLASS_SCHEDULE: '1ioSQAEqax-dEROzHMaXvszFatp1FmABFt39QH7xFpzE',
    // Undergraduate Individual Studies module — its OWN spreadsheet
    // (per-module storage tier). Tab: Petitions. Blank until setUp()
    // creates it and logs the id to paste back here.
    INDIVIDUAL_STUDIES: '1YXEdMiRUhFILSKDSg-Y_IwETsNy7k3B3o03lgAz84Fo',
    // Academic Personnel module — its OWN spreadsheet (per-module storage
    // tier). Tabs: PersonAttributes (person-attribute extension table) and
    // Cases (review cases from the Call).
    PERSONNEL:     '1MEE2WYjHddPfEVo7SEOU7tbNp1CFbUM90sFIFkbdPh0',
  },

  // Optional: Drive folder where setUp() creates new spreadsheets.
  // Paste a folder ID from its Drive URL:
  //   https://drive.google.com/drive/folders/THIS_PART_IS_THE_ID
  // Leave blank ('') to create them in your My Drive root.
  SETUP_FOLDER_ID: '1JAT55kWeYmjM8i0DuRPh1m_vulOMR5d8',

  // ── Report archive (ReportService) ─────────────────────────
  // ARCHIVE_FOLDER_ID: Drive folder where generated reports are filed
  //   (one auto-created subfolder per module). Required before the
  //   first archived report — paste a folder ID, as above.
  // LOGO_FILE_ID: Drive file id of the department logo (PNG with
  //   transparency, ~600px wide prints crisply). Blank = reports render
  //   without it; a broken id is logged and skipped, never fatal.
  // ORG_LINE: second line of the letterhead band.
  REPORTS: {
    ARCHIVE_FOLDER_ID: '1h5jgba27YO5hUO4FiDkTlNln7eJvdu1_',
    LOGO_FILE_ID:      '1dzrvLQYF8rUmNBF4j3N28UXg8wVpSrY3',
    ORG_LINE:          'Department of Anthropology · UC Santa Cruz',
  },

  TABS: {
    USERS:       'Users',
    ROLES:       'Roles',
    MODULES:     'Modules',
    AUDIT:       'AuditLog',
    REQUESTS:    'Requests',
    IMPORT_POLICY: 'ImportPolicy',
    NOTIFY_RULES: 'NotifyRules',
    // Platform-wide, module-keyed settings (Settings.gs). Lives in
    // USERS_CONFIG with the other config tabs. Machine-managed via the
    // Admin UI — not intended for hand editing.
    SETTINGS:    'Settings',
    TASKS:       'Tasks',
    REPORTS:     'Reports',
    THESIS_ELIGIBILITY: 'ThesisEligibility',
    THESIS_SETTINGS: 'ThesisSettings',
    // Transcript / ASSIST-articulation module tabs (live in SHEETS.TRANSCRIPT)
    ARTICULATIONS:        'Articulations',
    ARTICULATION_REVIEW:  'ArticulationReview',
    TRANSCRIPTS:          'Transcripts',
    TRANSCRIPT_SETTINGS:  'TranscriptSettings',
    // Class schedule service tabs (live in SHEETS.CLASS_SCHEDULE)
    CLASS_SCHEDULE:         'ClassSchedule',
    CLASS_SCHEDULE_IMPORTS: 'ClassScheduleImports',
    // Undergraduate Individual Studies module tab (lives in SHEETS.INDIVIDUAL_STUDIES)
    INDIVIDUAL_STUDIES:     'Petitions',
    // Sponsor-owned petition templates (same spreadsheet as Petitions)
    INDIVIDUAL_STUDIES_TEMPLATES: 'Templates',
    // Academic Personnel module tabs (live in SHEETS.PERSONNEL)
    PERSON_ATTRIBUTES: 'PersonAttributes',
    CASES:             'Cases',
  },

  // ── Storage convention (three tiers) ───────────────────────
  // 1. CONFIG sheet  (USERS_CONFIG): platform identity + registry —
  //    Users, Roles, Modules, ImportPolicy, NotifyRules, Requests,
  //    Settings. Stable, constantly read, small.
  // 2. PLATFORM sheet: operational data owned by platform-wide services
  //    (Tasks, Reports, and later anything cross-cutting). Hot /
  //    high-churn; kept separate so it never contends with config reads.
  // 3. PER-MODULE sheets: each module's own operational data in its own
  //    spreadsheet (Submissions; Thesis when it ships). A module never
  //    holds another module's spreadsheet ID — the data-layer expression
  //    of loose coupling.
  // AuditLog currently has its own dedicated sheet (AUDIT_LOG) and
  // Requests lives in the config sheet; both may be consolidated into
  // PLATFORM later as a deliberate, separate change — not required now.

  DEFAULT_ROLE: 'visitor',

  SUPER_ADMINS: [
    'anth_mgr@ucsc.edu',
  ],

  // Platform-wide fallback Reply-To for module notification emails.
  // Settings.gs (Admin → module settings) overrides this PER MODULE via
  // the 'replyTo' key; this value applies only to a module that has no
  // reply-to configured. Kept as a constant (not UI-managed) because it
  // is the last-resort floor, deliberately the department manager address.
  DEFAULT_REPLY_TO: 'anth_mgr@ucsc.edu',

  // Friendly inbox DISPLAY name on portal notification mail, applied at the
  // single send chokepoint (Notify.send) so every module's email shows it.
  // This masks the sending account's label (e.g. "anth_mgr") with a readable
  // name; it does NOT change the sending ADDRESS, which GmailApp locks to the
  // deploying account. A module may still override per-message via senderName.
  NOTIFY_FROM_NAME: 'UCSC Anthropology Portal',

  // ── Thesis module settings ─────────────────────────────────
  THESIS: {
    // The undergraduate advisor is whoever holds the 'staff_undergrad'
    // role (assign in Admin → Users), not a fixed address. These two
    // constants are retained only as a legacy reference and are no
    // longer read by the module.
    UNDERGRAD_ADVISOR_EMAIL: 'anthugra@ucsc.edu',
    UNDERGRAD_ADVISOR_NAME:  'Undergraduate Advisor',
    // Default for the UI-managed NOTIFY_ON_HANDOFF setting. ThesisSettings
    // reads this only as a fallback until a value is saved in Admin.
    NOTIFY_ON_HANDOFF: true,
    // Default for the UI-managed SEND_CERTIFICATE setting: whether an
    // acceptance certificate is automatically emailed to the student when
    // a thesis routes to final processing with a passing outcome. The
    // advisor's explicit "Resend certificate" action always works,
    // regardless of this toggle.
    SEND_CERTIFICATE: true,
    // Drive folder where submitted thesis PDFs are stored. In-place
    // resubmission (keeping the same file ID) also requires the Advanced
    // Drive Service enabled: Apps Script editor → Services (+) → Drive API.
    // Without it, resubmission still works but creates a new file ID.
    DRIVE_FOLDER_ID: '1KZ62caXh6IO-fLghGzaPJAC1b-qI50he',
  },

  // ── Transcript / ASSIST articulation module ────────────────
  // Set-once infrastructure constants for the articulation sync. These are
  // the kind of stable pointers that stay in Config.gs (like the Thesis
  // Drive/spreadsheet ids); they are NOT UI-managed settings.
  TRANSCRIPT: {
    // UCSC's ASSIST receiving-institution id. Verified from the ASSIST
    // institutions API (id 132 = "University of California, Santa Cruz").
    // Stable; will not change. Used to query agreements for which UCSC is
    // the receiving institution.
    UCSC_INSTITUTION_ID: 132,
    // Case-insensitive substring used to identify Anthropology Major
    // agreements among a college's UCSC agreements. Matched against the
    // agreement label; a visible match report surfaces what was matched.
    ANTHRO_MATCH_SUBSTRING: 'anthropolog',
    // ASSIST public API base. Unofficial but stable; no API key needed for
    // the routes this module uses. The stored Articulations tables are a
    // durable snapshot, so an API change degrades sync without breaking
    // already-stored data.
    ASSIST_API_BASE: 'https://prod.assistng.org',
    // Only equivalencies whose RECEIVING (UCSC) course is in this list are
    // stored — everything else from a matched agreement is dropped, so the
    // table holds exactly the Anthropology prerequisites we clear. Matched
    // case-insensitively on "PREFIX NUMBER" (e.g. "ANTH 1"). This is the
    // scope lever: add a course here (Config edit, no code change) if UCSC
    // ever adds a prerequisite. Applies to BOTH trusted and flagged rows —
    // a flagged ANTH 1 still goes to review, it is not dropped.
    RECEIVING_COURSE_ALLOWLIST: ['ANTH 1', 'ANTH 2', 'ANTH 3'],
    // Human-readable titles for the allowlisted prerequisites, keyed by the
    // same "PREFIX NUMBER" code. Display-only — shown on the student upload
    // form so the student recognizes the course. Kept here, next to the
    // allowlist, so a course change is a single Config edit; a code with no
    // entry here simply shows without a title (never an error).
    RECEIVING_COURSE_TITLES: {
      'ANTH 1': 'Introduction to Biological Anthropology',
      'ANTH 2': 'Introduction to Cultural Anthropology',
      'ANTH 3': 'Introduction to Archaeology',
    },
    // Drive folder where uploaded student transcript PDFs are stored
    // (Layer 2). Replace-in-place on resubmission (keeping the same file ID)
    // also requires the Advanced Drive Service enabled: Apps Script editor →
    // Services (+) → Drive API. Without it, resubmission still works but
    // creates a new file ID.
    DRIVE_FOLDER_ID: '1dbJnmVURcoUS7hePNG-fV16LDmtnuX7L',
  },

  // ── Undergraduate Individual Studies module ────────────────
  // Drive folder for module documents: uploaded syllabi and the generated
  // petition PDFs. Replace-in-place on syllabus re-upload benefits from the
  // Advanced Drive Service (Apps Script editor -> Services (+) -> Drive API),
  // but works without it.
  INDIVIDUAL_STUDIES: {
    DRIVE_FOLDER_ID: '1goPXXH3b0v4k4Pn_qyonPJHZW67jOfLn',
  },

  // ── Academic Personnel module ──────────────────────────────
  // raw rank title (as it appears in the rank/step report) -> { series, tier }.
  // series drives component templates (later phase); tier drives Bylaw 55
  // voting eligibility (later phase). Adding a title is ONE Config edit, no
  // code change. The keys MUST match the exact strings in the report's rank
  // column, or those rows skip with "Unrecognized rank title".
  //
  // SCOPE: this module reviews the ladder (Professor), Teaching Professor,
  // and Lecturer series ONLY. Other working titles that appear in a campus
  // roster export — Professor Emeritus, Recall Faculty, Project Scientist,
  // Postdoc, GSR, TA, Visiting Scholar, etc. — are intentionally NOT mapped,
  // so the importer skips them with "Unrecognized rank title". That is the
  // correct behavior: they are not personnel-review subjects here.
  //
  // Lecturers are candidates-only in this module: they are reviewed but never
  // vote or serve, so every Lecturer-family title carries series 'lecturer'
  // and an EMPTY tier (they are never in any voting roster). The Lecturer
  // career stage (Pre-Six / Continuing / Senior Continuing) is NOT encoded in
  // the series — it lives in the action a case carries and in the Unit 18
  // point-scale salary math. All Lecturer working titles collapse to one
  // 'lecturer' series here.
  PERSONNEL: {
    // CruzID -> campus email expansion. The rank/step report identifies
    // people by CruzID (the username, e.g. "jsmith"); the importer expands
    // it to the campus email "<cruzid>@EMAIL_DOMAIN" and matches on email
    // (PersonMatch's primary key). A value that already contains "@" is
    // treated as a full email and used as-is. One Config edit changes the
    // domain; no code change.
    EMAIL_DOMAIN: 'ucsc.edu',

    // ── Case review types ──────────────────────────────────────
    // The canonical review types a case can carry. The type drives the
    // calculator engine and authority later; it is SUGGESTED from the Call
    // Action string at import (see CALL_ACTION_MAP) but is a candidate/dept
    // ELECTION, so the super admin can override it per case. Reappointment
    // is NOT a type here — it is a derived flag (true when subjectRank is an
    // Assistant-level rank). Mandatory is a timing flag, not a type.
    //   engine  — which salary calculator this routes to (later phase)
    //   votable — whether the review carries a Bylaw 55 ballot
    //   major   — whether it is a "major" (heavier) review
    REVIEW_TYPES: {
      merit:                { label: 'Merit increase',        engine: 'ssp',       votable: true,  major: false },
      salary_increase_only: { label: 'Salary increase only',  engine: 'threshold', votable: true,  major: false },
      promotion:            { label: 'Promotion',             engine: 'ssp',       votable: true,  major: true  },
      midcareer:            { label: 'Mid-career appraisal',  engine: 'ssp',       votable: true,  major: true  },
    },

    // Raw Call Action string -> suggested review type key. Matched
    // case-insensitively (exact first, then a normalized contains). These
    // are only DEFAULTS — the super admin confirms/overrides per case at
    // import, reflecting the candidate's election. Add strings here as the
    // department's Call vocabulary grows (one Config edit, no code change).
    CALL_ACTION_MAP: {
      'merit increase':                        'merit',
      'mandatory review/merit increase':       'merit',
      'promotion':                             'promotion',
      'reappt with salary increase':           'salary_increase_only',
      'reappointment/salaryincr/midcareer':    'midcareer',
    },

    // Ranks considered "Assistant-level" — a case at one of these ranks
    // carries isReappointment=true (reappointment rides along with the
    // Assistant review; it is never a standalone type). Matched against the
    // case's subjectRank. Keep in sync with RANK_MAP's Assistant titles.
    ASSISTANT_RANKS: ['Assistant Professor', 'Assistant Teaching Professor'],

    // Case status values.
    //   open     — a live review in progress.
    //   deferred — the candidate elected to postpone this cycle (they were
    //              eligible; chose not to proceed). Retains its review type.
    //   closed   — the case will not proceed for another reason: not eligible,
    //              listed on the Call in error, withdrawn, or otherwise
    //              resolved without a review. Terminal, like deferred, but a
    //              distinct outcome (not a postponement).
    // Workflow states (forwarded, complete, …) are added in a later phase.
    STATUSES: ['open', 'deferred', 'closed'],

    RANK_MAP: {
      // Ladder (Professor) series
      'Assistant Professor':           { series: 'ladder',   tier: 'assistant' },
      'Associate Professor':           { series: 'ladder',   tier: 'associate' },
      'Professor':                     { series: 'ladder',   tier: 'full' },
      // Teaching Professor series (mirrors ladder tiers for voting)
      'Assistant Teaching Professor':  { series: 'teaching', tier: 'assistant' },
      'Associate Teaching Professor':  { series: 'teaching', tier: 'associate' },
      'Teaching Professor':            { series: 'teaching', tier: 'full' },
      // Lecturer (Unit 18) series — candidates only; all stages -> 'lecturer'
      'Lecturer':                      { series: 'lecturer', tier: '' },
      'Lecturer Continuing':           { series: 'lecturer', tier: '' },
      'Lecturer Senior Continuing':    { series: 'lecturer', tier: '' },
    },
  },

};


// ============================================================
// MODULE REGISTRY — now loaded from the "Modules" sheet tab
// ============================================================
// Modules tab columns (exact order):
//   Key | Label | Icon | Roles | Handler | Include | Order | Enabled
//
// Example row:
//   submissions | Submissions | ti-file-text | staff,viewer | SubmissionsModule | submissions | 1 | TRUE
// ============================================================

// Execution-scoped cache so we read the sheet at most once per request
let _moduleRegistryCache = null;


/**
 * Returns the full module registry as an object keyed by module key,
 * matching the shape the rest of the platform expects.
 * Reads from the Modules sheet tab; falls back to a minimal hardcoded
 * registry if the sheet is missing, empty, or unreadable — this
 * guarantees an admin can always reach the Admin module to fix things.
 */
function getModuleRegistry() {
  if (_moduleRegistryCache) return _moduleRegistryCache;

  try {
    const ss    = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
    const sheet = ss.getSheetByName(CONFIG.TABS.MODULES);
    if (!sheet || sheet.getLastRow() < 2) {
      _moduleRegistryCache = _fallbackRegistry();
      return _moduleRegistryCache;
    }

    const data    = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim());
    const idx = name => headers.indexOf(name);

    const registry = {};
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const key = String(row[idx('Key')]).trim();
      if (!key) continue;

      registry[key] = {
        label:   String(row[idx('Label')]).trim(),
        icon:    String(row[idx('Icon')]).trim() || 'ti-box',
        roles:   String(row[idx('Roles')]).split(',').map(r => r.trim().toLowerCase()).filter(Boolean),
        handler: String(row[idx('Handler')]).trim(),
        include: String(row[idx('Include')]).trim(),
        order:   Number(row[idx('Order')]) || 99,
        enabled: String(row[idx('Enabled')]).trim().toUpperCase() !== 'FALSE',
      };
    }

    // Always guarantee an Admin module exists so the registry is manageable
    if (!registry.admin) {
      Object.assign(registry, _fallbackRegistry());
    }

    _moduleRegistryCache = registry;
    return registry;

  } catch (err) {
    Logger.log('getModuleRegistry error, using fallback: ' + err);
    _moduleRegistryCache = _fallbackRegistry();
    return _moduleRegistryCache;
  }
}


/**
 * Minimal hardcoded registry — the safety net.
 * Contains only the Admin module so a broken Modules sheet can
 * never lock an admin out of the management UI.
 */
function _fallbackRegistry() {
  return {
    admin: {
      label:   'Admin',
      icon:    'ti-settings',
      roles:   ['super_admin'],
      handler: 'AdminModule',
      include: 'admin',
      order:   0,
      enabled: true,
    },
  };
}


/**
 * Clears the registry cache. Call after editing modules so the
 * next read reflects changes within the same execution.
 */
function clearModuleRegistryCache() {
  _moduleRegistryCache = null;
}