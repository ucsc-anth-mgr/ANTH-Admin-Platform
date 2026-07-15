// ============================================================
// Calendarmodule.gs — Calendar module handler (Phase 3)
// ============================================================
// The dispatch face of CalendarService: per-action permission checks
// wrapping the service. The module's registry Roles list admits every
// role that should SEE the calendar (recommended: all except visitor);
// deadline MANAGEMENT is refined here per action against the
// Settings-driven role list ('calendar' / 'deadlineManagerRoles',
// default 'staff'; super_admin always passes).
//
// Registration (only after this file and Calendarservice.gs ship):
//   Code.gs getModuleHandler():      CalendarModule: CalendarModule,
//   Code.gs getRegisteredHandlers(): 'CalendarModule'
//   Admin → Modules row:             key 'calendar', include 'calendar'
// ============================================================

const CalendarModule = (() => {

  // ── Tab manifest (TabRegistry) ─────────────────────────────
  // Declares this module's tabs for per-role visibility, edited in
  // Admin → Modules → Tabs. Visibility only: deadline-management
  // AUTHORITY stays with the Settings-driven manager list
  // (_assertManager via CalendarService.canManage). The manage/imports
  // defaults below mirror that list's 'staff' default — if a
  // super_admin changes the manager roles in the module's Settings
  // tab, mirror the change in Admin → Modules → Tabs so the tabs
  // follow the authority. bootstrap is the shared loader and
  // nightlyRefresh is the Scheduler's entry — both stay unlisted.
  const TABS = [
    { key: 'view',     label: 'Calendar',         icon: 'ti-calendar',       roles: ['*'],
      actions: ['listRange'] },
    { key: 'manage',   label: 'Manage Deadlines', icon: 'ti-flag',           roles: ['staff'],
      actions: ['listDeadlines', 'createDeadline', 'updateDeadline',
                'deleteDeadline', 'duplicateDeadline'] },
    { key: 'imports',  label: 'Imports',          icon: 'ti-cloud-download', roles: ['staff'],
      actions: ['listSources', 'saveSource', 'deleteSource', 'refreshSource',
                'listPending', 'commitPending', 'dismissPending',
                'harvestPreview', 'harvestCommit'] },
    { key: 'settings', label: 'Settings',         icon: 'ti-settings',       roles: [], floor: 'super_admin',
      actions: ['getSettings', 'saveSettings'] },
  ];


  // ── Action: bootstrap ──────────────────────────────────────
  // Everything the UI needs to draw itself once: role vocabulary for
  // pickers, the viewer's own roles, and management flags.
  function bootstrap(p, user, roles) {
    return {
      userEmail:    user,
      userRoles:    roles,
      canManage:    CalendarService.canManage(roles),
      isSuperAdmin: roles.includes('super_admin'),
      managerRoles: CalendarService.managerRoles(),
      allRoles:     _allRoles(),
      pendingCount: CalendarService.canManage(roles) ? CalendarService.listPending().length : 0,
      parsers:      CalendarService.listParsers(),
      today:        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    };
  }


  // ── Action: listRange (everyone in the module) ─────────────
  function listRange(p, user, roles) {
    return CalendarService.listRange(p || {}, roles);
  }


  // ── Deadline management (Settings-gated) ───────────────────

  function listDeadlines(p, user, roles) {
    _assertManager(roles);
    return CalendarService.listAllDeadlines();
  }

  function createDeadline(p, user, roles) {
    _assertManager(roles);
    return CalendarService.createDeadlines(p || {});
  }

  function updateDeadline(p, user, roles) {
    _assertManager(roles);
    p = p || {};
    return CalendarService.updateDeadline(p.deadlineId, p);
  }

  function deleteDeadline(p, user, roles) {
    _assertManager(roles);
    return CalendarService.deleteDeadline((p || {}).deadlineId);
  }

  function duplicateDeadline(p, user, roles) {
    _assertManager(roles);
    p = p || {};
    return CalendarService.duplicateDeadline(p.deadlineId, p.newDate);
  }




  // ── Phase 2: import sources (manager-gated) ────────────────

  function listSources(p, user, roles) {
    _assertManager(roles);
    return CalendarService.listSources();
  }

  function saveSource(p, user, roles) {
    _assertManager(roles);
    return CalendarService.saveSource(p || {});
  }

  function deleteSource(p, user, roles) {
    _assertManager(roles);
    return CalendarService.deleteSource((p || {}).sourceKey);
  }

  /** Manual "Fetch now" — same engine the nightly job runs. */
  function refreshSource(p, user, roles) {
    _assertManager(roles);
    return CalendarService.refreshSource((p || {}).sourceKey);
  }

  // ── Phase 2: pending review (manager-gated) ────────────────

  function listPending(p, user, roles) {
    _assertManager(roles);
    return CalendarService.listPending((p || {}).sourceKey);
  }

  function commitPending(p, user, roles) {
    _assertManager(roles);
    return CalendarService.commitPending((p || {}).items, user);
  }

  function dismissPending(p, user, roles) {
    _assertManager(roles);
    return CalendarService.dismissPending((p || {}).pendingIds, user);
  }

  // ── Phase 2: paste-a-URL harvest (manager-gated) ───────────

  function harvestPreview(p, user, roles) {
    _assertManager(roles);
    return CalendarService.harvestPreview((p || {}).url);
  }

  function harvestCommit(p, user, roles) {
    _assertManager(roles);
    return CalendarService.createHarvested((p || {}).items, (p || {}).url);
  }

  // ── Phase 2: the nightly Scheduler job ─────────────────────
  // Registered in getScheduledJobs() as Calendar:nightlyRefresh. When the
  // Scheduler calls it, the argument is a job context ({frequency, runAt})
  // and no roles are supplied. It is also dispatch-reachable (it must be
  // exported to be registrable), so when a roles array IS present — i.e.
  // a person invoked it through dispatch — the manager gate applies.
  function nightlyRefresh(contextOrPayload, user, roles) {
    if (roles !== undefined) _assertManager(roles);
    return CalendarService.nightlyRefreshAll(contextOrPayload);
  }

  // ── Settings (super_admin only) ────────────────────────────

  function getSettings(p, user, roles) {
    _assertSuperAdmin(roles);
    return { managerRoles: CalendarService.managerRoles(), allRoles: _allRoles() };
  }

  function saveSettings(p, user, roles) {
    _assertSuperAdmin(roles);
    p = p || {};
    const requested = Array.isArray(p.managerRoles) ? p.managerRoles : [];
    // Only roles that actually exist may be stored.
    const known = _allRoles();
    const unknown = requested
      .map(r => String(r).trim().toLowerCase())
      .filter(r => r && r !== 'super_admin' && !known.includes(r));
    if (unknown.length) throw new Error('Unknown role(s): ' + unknown.join(', '));
    return { managerRoles: CalendarService.setManagerRoles(requested) };
  }


  // ── Guards ─────────────────────────────────────────────────

  function _assertManager(roles) {
    if (!CalendarService.canManage(roles)) {
      throw new Error('You do not have permission to manage deadlines.');
    }
  }

  function _assertSuperAdmin(roles) {
    if (!(roles || []).includes('super_admin')) {
      throw new Error('Only a super admin can change calendar settings.');
    }
  }

  /** The role vocabulary for pickers, from the Roles tab. */
  function _allRoles() {
    try {
      return RolesManager.list().map(r => String(r.role).trim().toLowerCase()).filter(Boolean);
    } catch (err) {
      Logger.log('CalendarModule._allRoles fell back to Auth: ' + err);
      try {
        const viaAuth = Auth.listRoles();
        return (viaAuth || []).map(r =>
          String((r && r.role) !== undefined ? r.role : r).trim().toLowerCase()).filter(Boolean);
      } catch (err2) {
        Logger.log('CalendarModule._allRoles failed entirely: ' + err2);
        return [];
      }
    }
  }


  // Only these names are dispatchable (TABS is the tab manifest).
  return {
    TABS: TABS,
    bootstrap, listRange,
    listDeadlines, createDeadline, updateDeadline, deleteDeadline, duplicateDeadline,
    listSources, saveSource, deleteSource, refreshSource,
    listPending, commitPending, dismissPending,
    harvestPreview, harvestCommit,
    nightlyRefresh,
    getSettings, saveSettings,
  };

})();


/* ============================================================
 * CONFIG / SETUP additions — applied separately to Config.gs and
 * Setup.gs (deliberate paste-in patches; this file does not create
 * them). Reproduced here so the module documents its own storage
 * contract, same as ClassSchedule and Service.
 *
 * Config.gs — CONFIG.SHEETS: add (leave blank; setUp creates + logs id)
 *     CALENDAR: '',   // Tabs: CalendarEvents, CalendarDeadlines, CalendarSources
 *
 * Config.gs — CONFIG.TABS: add
 *     CALENDAR_EVENTS:    'CalendarEvents',
 *     CALENDAR_DEADLINES: 'CalendarDeadlines',
 *     CALENDAR_SOURCES:   'CalendarSources',
 *
 * Setup.gs — SETUP_SCHEMA: add
 *     CALENDAR_EVENTS: {
 *       tab: 'CalendarEvents',
 *       // Phase 1 renders these read-only; creation arrives with the
 *       // Events module. LocationKey stays blank until Facilities
 *       // exists (free-text LocationLabel carries the venue until
 *       // then); Attendees is reserved for person-collision checking.
 *       headers: ['EventID', 'Title', 'Description', 'Start', 'End',
 *                 'LocationKey', 'LocationLabel', 'AudienceRoles',
 *                 'Restricted', 'Attendees', 'Status',
 *                 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
 *       seed: [],
 *     },
 *     CALENDAR_DEADLINES: {
 *       tab: 'CalendarDeadlines',
 *       // Origin: manual | harvested | imported. SourceKey/ExternalUID/
 *       // LastSeenAt are Phase 2 import provenance. Pinned marks a
 *       // human-edited imported row the refresh must not overwrite.
 *       // Perennial marks a same-date-every-year deadline.
 *       headers: ['DeadlineID', 'Title', 'Description', 'Date',
 *                 'AudienceRoles', 'Source', 'Link', 'Origin',
 *                 'SourceKey', 'ExternalUID', 'Perennial', 'Pinned',
 *                 'Status', 'LastSeenAt',
 *                 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
 *       seed: [],
 *     },
 *     CALENDAR_SOURCES: {
 *       tab: 'CalendarSources',
 *       // Phase 2 import registry (created now so setUp runs once).
 *       // Type: gcal | gsheet | html. ParserKey maps to an extractor,
 *       // mirroring the Modules sheet's Handler column.
 *       headers: ['SourceKey', 'Label', 'Type', 'URL', 'CalendarID',
 *                 'ParserKey', 'Enabled', 'LastFetchedAt',
 *                 'LastSuccessAt', 'LastResult',
 *                 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
 *       seed: [],
 *     },
 *
 * Setup.gs — setUp(): resolve the spreadsheet and create its tabs
 *     const calendarSS = _resolveSpreadsheet(
 *       CONFIG.SHEETS.CALENDAR, 'Portal Calendar', 'CALENDAR');
 *     _setupTab(calendarSS, SETUP_SCHEMA.CALENDAR_EVENTS);
 *     _setupTab(calendarSS, SETUP_SCHEMA.CALENDAR_DEADLINES);
 *     _setupTab(calendarSS, SETUP_SCHEMA.CALENDAR_SOURCES);
 *     _tidyDefaultSheet(calendarSS);
 *
 * Setup.gs — _schemaPlacement(): add
 *     { sheetKey: 'CALENDAR', def: SETUP_SCHEMA.CALENDAR_EVENTS },
 *     { sheetKey: 'CALENDAR', def: SETUP_SCHEMA.CALENDAR_DEADLINES },
 *     { sheetKey: 'CALENDAR', def: SETUP_SCHEMA.CALENDAR_SOURCES },
 *
 * Setup.gs — checkSetup() (optional): add
 *     ['CALENDAR', CONFIG.SHEETS.CALENDAR,
 *      [SETUP_SCHEMA.CALENDAR_EVENTS.tab, SETUP_SCHEMA.CALENDAR_DEADLINES.tab,
 *       SETUP_SCHEMA.CALENDAR_SOURCES.tab]],
 *
 * Code.gs — registration (uncomment ONLY when both .gs files are in):
 *     getModuleHandler():      // CalendarModule: CalendarModule,
 *     getRegisteredHandlers(): // 'CalendarModule'
 *
 * Admin → Modules row (after registration):
 *     Key: calendar   Label: Calendar   Icon: ti-calendar
 *     Roles: super_admin, staff, senate_faculty, lecturer,
 *            graduate_student, undergraduate_student
 *            (visitor deliberately omitted; add later via Module
 *             Manager if a visitor use-case appears)
 *     Handler: CalendarModule   Include: calendar   Enabled: TRUE
 *
 * Phase 2 additions: the CalendarPending tab (schema in Setup.gs),
 * CONFIG.CALENDAR constants and CONFIG.TABS.CALENDAR_PENDING in
 * Config.gs, and the scheduled-job registration in Code.gs:
 *     getScheduledJobs() daily:
 *       { name: 'Calendar:nightlyRefresh', fn: CalendarModule.nightlyRefresh },
 * Requires the Google Calendar advanced service (editor: Services (+)
 * -> Google Calendar API) for gcal sources, and installScheduledTriggers()
 * run once from the editor if not already installed.
 *
 * Settings: none required. Deadline managers default to 'staff'
 * (+ implicit super_admin); a super_admin adjusts this in the
 * module's own Settings tab, which writes the platform Settings row
 * ('calendar' / 'deadlineManagerRoles').
 * ============================================================ */