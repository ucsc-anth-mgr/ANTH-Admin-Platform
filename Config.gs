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

  // Brand (official UCSC colors)
  BRAND: {
    NAVY:  '#003C6C',   // UCSC Primary Blue
    GOLD:  '#FDC700',   // UCSC Primary Yellow
  },

  SHEETS: {
    USERS_CONFIG:  '1VdiwRD4Dp75a86jdqPid_XCrwGEOp3ix5c2wTisHwMs',       // Tabs: Users, Roles, Modules
    AUDIT_LOG:     '1Jog3zXwu5dpAuWuJ8I-VPjbqH4ybRlc3yl1zUzh1HxE',        // Tab: AuditLog
    SUBMISSIONS:   '1zacvd0FhWcjKldhKt9Fan3lWY0QkRAZ3Ol45wobBZl4',  // Tab per form type
    // Senior Thesis module — its OWN spreadsheet (per-module storage tier).
    THESIS:        '16MiWlHY0mTFuBioI5mc1nV3mmiIEbgBssG3h7jO4tBc',
    // Platform-services operational data (owned by platform-wide services,
    // not by any single module). Tenants: Tasks, Reports.
    PLATFORM:      '1CyVapaV52tFWDGOC4fI7RNyVrcExevQeV7_gR_mpTNg',
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
    TASKS:       'Tasks',
    REPORTS:     'Reports',
    THESIS_ELIGIBILITY: 'ThesisEligibility',
    THESIS_SETTINGS: 'ThesisSettings',
  },

  // ── Storage convention (three tiers) ───────────────────────
  // 1. CONFIG sheet  (USERS_CONFIG): platform identity + registry —
  //    Users, Roles, Modules, ImportPolicy, NotifyRules, Requests.
  //    Stable, constantly read, small.
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