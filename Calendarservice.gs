// ============================================================
// Calendarservice.gs — Platform calendar service (Phase 3.5)
// ============================================================
// The KEEPER of department dates. Owns the CALENDAR spreadsheet;
// nothing else reads or writes its tabs. Two module faces consume it
// (the viewing Calendar module now; an Events production module later),
// and future modules (Facilities) query it through this API only.
//
// NAMED CalendarService (not Calendar) deliberately: enabling the
// Advanced Calendar API service — planned for the Phase 2 Registrar
// feed import — defines a global `Calendar`, which would collide.
//
// Phase 1 scope:
//   - Deadlines: full CRUD, multi-date create, duplicate-to-date,
//     pin-respecting edits (see PIN SEMANTICS below).
//   - Events: READ ONLY (listRange renders any rows present, with
//     restricted-visibility filtering). Event creation, categories,
//     and conflict checking arrive with the Events module.
//   - Sources tab: created by setUp now so the spreadsheet never needs
//     a second bootstrap; the import machinery that uses it is Phase 2.
//
// Phase 2 scope — THE IMPORT LAYER:
//   - Sources registry (CalendarSources): UI-managed rows naming what to
//     import. Type 'gcal' is live (Advanced Calendar API — must be
//     enabled in the editor: Services (+) -> Google Calendar API);
//     'html'/'gsheet' rows are accepted but skip refresh until their
//     Phase 3 extractors ship.
//   - Nightly refresh (Scheduler): fetches each enabled source, diffs
//     against imported deadlines by ExternalUID (honoring pins), and
//     wholesale-rewrites that source's OPEN rows in CalendarPending.
//     NEVER auto-commits — humans commit through the preview.
//   - Review plumbing: a staff-pool Task per source with open pendings
//     (created once, resolved on commit/dismiss of the last row), plus a
//     Notify email only when a new/changed deadline lands within
//     CONFIG.CALENDAR.NEAR_TERM_DAYS (fail-loud emails always fire on
//     fetch errors).
//   - Paste-a-URL harvest: a generic date sweep over any page, feeding
//     the same human curation; committed rows carry Origin 'harvested'
//     (no UID, no refresh).
//
// Phase 2.1 — REFRESH PERFORMANCE:
//   A first fetch of a busy campus calendar produces hundreds of pending
//   rows. Row-at-a-time inserts and per-row cleanup made that take
//   minutes (and risked the 6-minute execution ceiling on re-fetch).
//   Now: pending rows are written in ONE batch setValues, and a re-diff
//   SUPERSEDES the source's prior open rows with one column write
//   instead of deleting them row by row (Status gains a fourth value,
//   'superseded' — kept rows double as refresh history). These are the
//   only two places this service touches its sheet directly instead of
//   through DataService; both read columns by header name, per
//   convention, and exist purely because DataService has no batch path.
//
// Phase 3 — DEDICATED HTML EXTRACTORS:
//   The PARSERS registry maps a ParserKey (a column on the source row,
//   mirroring the Modules sheet's Handler column) to an extractor
//   function with one contract: take raw fetched HTML, return normalized
//   candidates [{uid, title, date, detail, link, audience?}] — or THROW.
//   A throw marks the source stale and emails the pool (fail loudly,
//   never silently serve drift). HTML sources with no/unknown ParserKey
//   are skipped with a message naming the available keys.
//   First extractor: apo_call_calendar (the APO Call Calendar page).
//   First extractor: apo_call_calendar (the APO Call Calendar page).
//
// Phase 3.1 — TRANSPORT HARDENING (field-driven):
//   Campus hosts intermittently drop Apps Script's fetches (rotating
//   Google egress IPs vs the campus edge — same URL, different luck per
//   request; observed live during verification). _fetchWithRetry makes
//   three attempts with backoff, retrying ONLY transport-flavored
//   failures (Address unavailable / timeout / DNS / HTTP 5xx); real
//   4xx errors fail immediately. UrlFetchApp offers no timeout option,
//   so a dropped attempt can take ~100s — worst case per source is a
//   few minutes, isolated by the nightly job's per-source try/catch.
//   Also fixed here: the APO call-year heading is now sought in the
//   WHOLE document's text, not the first 20KB of raw HTML (WordPress
//   front-matter pushed the real heading past that mark — caught by
//   testApoExtractor doing exactly its job).
//
// Phase 3.2 — CURRICULUM EXTRACTOR + PERENNIAL SEMANTICS:
//   Second extractor: curriculum_deadlines (the Registrar's Curriculum
//   & Scheduling page — Course Approval Deadlines and Program Statement
//   tables, per-table audience suggestions). Its dates are YEARLESS and
//   explicitly the same every year, which finally gives the Perennial
//   flag its behavior, implemented in the diff engine for ANY source:
//   a perennial row's identity is its MONTH+DAY. The nightly refresh
//   rolls the year forward SILENTLY (that is the definition of annual,
//   not a change of fact) and raises a 'changed' pending only when the
//   month/day itself moves — the real signal, as this very page's
//   footnote (a Senate deadline revised one year) demonstrates. Pinned
//   rows are never auto-rolled and are flagged only on month/day drift.
//   Perennial candidates carry the uid prefix 'perennial|'; commit
//   derives the flag from it (no pending-schema change needed).
//   derives the flag from it (no pending-schema change needed).
//
// Phase 3.3 — SPLIT RETRY PROFILES + PATIENT ALERTING (agreed):
//   Manual fetches keep quick retries (1.5s/3s) — a human is watching,
//   fail fast and let THEM re-click, which samples Google's egress IP
//   pool better than in-run retries anyway. The nightly job uses a
//   patient ladder (10s/30s). Fail-loud email now fires only when a
//   source's CONSECUTIVE nightly failures reach 3 (and every 3rd
//   after), tracked in the FailStreak column and reset on any success;
//   the stale marking in the Imports tab stays immediate. Also here:
//   probePublishedSheetCsv + probeSchedulingSheet, the survey tools for
//   the future gsheet extractor (the Course Scheduling Calendar).
//   probePublishedSheetCsv + probeSchedulingSheet, the survey tools for
//   the future gsheet extractor (the Course Scheduling Calendar).
//
// Phase 3.4 — COURSE SCHEDULING SHEET (gsheet extractor, probe-settled):
//   Parsers now declare their content type ('html' | 'csv'); the fetch
//   routing feeds each the right shape. The scheduling source stores the
//   docs.google.com CSV URL DIRECTLY (Google-to-Google — no flaky campus
//   hop; a Registrar republish rotates the token, which surfaces as a
//   loud stale source and a one-field URL edit). Sheet policy, agreed:
//   import owner Dept/Col and Both rows only (Reg = Registrar's own
//   work; FYI duplicates the gcal feed); a date RANGE means the window
//   CLOSE is the deadline; unparseable cells (TBD, missing years, the
//   sheet's typos) skip per-cell and are counted, never guessed; cells
//   more than 30 days past skip silently — which retires historical term
//   columns without hardcoding terms. UIDs bake in the TERM (these are
//   dated facts, not perennials), so "(estimated)" dates hardening into
//   confirmed ones surface as changed-pendings — this source's whole
//   point.
//   confirmed ones surface as changed-pendings — this source's whole
//   point.
//
// Phase 3.5 — CLOSURES, COLOR, AND THE PERSONNEL CONTRACT:
//   Kind column: 'deadline' (default) | 'closure'. Closures are
//   non-working days; the Registrar feed's holiday entries — dismissed
//   as noise since Phase 2 — are now committed AS closures (bulk
//   commit-as-closures on the pending screen). Excluded from deadline
//   queries; rendered as a day wash, not a chip.
//   Color column: optional per-entry palette key; like audience, it is
//   OUR metadata on THEIR fact — never pins.
//   Service face for the Academic Personnel scheduler (read-only,
//   server-side consumption — the Auth pattern, no dispatch involved):
//     findDeadlines(filter)        -> committed active deadline shapes
//     getDeadlineById(id)          -> shape incl. removed rows, or null
//     listClosures(fromISO, toISO) -> sorted 'yyyy-MM-dd' strings
//   Personnel stores chosen DeadlineIDs in its own per-cycle config and
//   reads by immutable id at compute time; titles are upstream's words
//   and are never a join key.
//   Extractors may suggest a per-item audience; suggestions ride the
//   pending row (SuggestedAudience) and apply on commit unless the
//   reviewer overrides — suggestion as default, human as final word.
//
// Phase 1.1 addition — DUPLICATE GUARD:
//   A deadline's natural key is (normalized title, date): same title on
//   the same date is never a legitimate duplicate. Normalization is
//   case-insensitive with whitespace collapsed. createDeadlines SKIPS
//   dates whose key already exists (reported back, never an error) —
//   this closes the double-click race at the server, where a disabled
//   button alone cannot, and also catches a human re-entering last
//   year's deadline. duplicateDeadline and a title/date edit that would
//   collide with ANOTHER row throw instead, since those are single
//   deliberate actions.
//
// PIN SEMANTICS (deadline edit rules, agreed design):
//   Deadlines are externally owned facts. On an IMPORTED row:
//     - audience roles / description / source / link are always
//       editable — they are OUR metadata layered on THEIR fact;
//     - editing Title or Date sets Pinned=TRUE. A pinned row is never
//       overwritten by a Phase 2 refresh; upstream divergence is
//       reported as informational instead.
//   Manual rows edit freely and never pin. Duplicating any row
//   produces a MANUAL row (a human decision, whatever the ancestry).
//
// DATES: Sheets stores real Date values; google.script.run cannot
// serialize Date objects, so every public shape carries strings —
// 'yyyy-MM-dd' for deadline dates, "yyyy-MM-dd'T'HH:mm" for event
// start/end — normalized in the script time zone.
//
// Storage contract (Config.gs / Setup.gs): now woven into the full
// replacement Config/Setup files; documented in Calendarmodule.gs.
// ============================================================

const CalendarService = (() => {

  function SHEET()        { return CONFIG.SHEETS.CALENDAR; }
  function EVENTS_TAB()   { return (CONFIG.TABS && CONFIG.TABS.CALENDAR_EVENTS)    || 'CalendarEvents'; }
  function DEADLINES_TAB(){ return (CONFIG.TABS && CONFIG.TABS.CALENDAR_DEADLINES) || 'CalendarDeadlines'; }
  function SOURCES_TAB()  { return (CONFIG.TABS && CONFIG.TABS.CALENDAR_SOURCES)   || 'CalendarSources'; }
  function PENDING_TAB()  { return (CONFIG.TABS && CONFIG.TABS.CALENDAR_PENDING)   || 'CalendarPending'; }

  const MODULE_KEY = 'calendar';
  const MANAGER_SETTING = 'deadlineManagerRoles';
  const MANAGER_DEFAULT = 'staff';          // super_admin always passes regardless
  const MAX_DATES_PER_CREATE = 40;          // multi-date guard


  // ── Permissions (Settings-driven, per agreed design) ───────

  /** Roles permitted to manage deadlines, from the platform Settings
   *  store (Admin-free: editable in the module's own Settings tab by a
   *  super_admin). Unset falls back to 'staff'. */
  function managerRoles() {
    return _splitRoles(Settings.get(MODULE_KEY, MANAGER_SETTING, MANAGER_DEFAULT));
  }

  function setManagerRoles(rolesList) {
    const clean = _splitRoles((rolesList || []).join(','))
      .filter(r => r !== 'super_admin');   // implicit, never stored
    Settings.set(MODULE_KEY, MANAGER_SETTING, clean.join(', '));
    return managerRoles();
  }

  /** true if this role set may manage deadlines. */
  function canManage(userRoles) {
    const r = userRoles || [];
    if (r.includes('super_admin')) return true;
    const allowed = managerRoles();
    return r.some(x => allowed.includes(String(x).toLowerCase()));
  }


  // ── Range query (the viewing face) ─────────────────────────

  /**
   * Events and deadlines within [start, end] inclusive, as public
   * shapes. Restricted events are visible only when the viewer's roles
   * intersect the event's audience (or super_admin). Deadlines are
   * never restricted — visibility filtering ("aimed at me") is a
   * client-side display concern.
   *
   * @param {{start: string, end: string}} p - 'yyyy-MM-dd' bounds
   * @param {string[]} viewerRoles
   * @returns {{events: Object[], deadlines: Object[]}}
   */
  function listRange(p, viewerRoles) {
    p = p || {};
    const start = _dateOnly(p.start);
    const end   = _dateOnly(p.end);
    if (!start || !end) throw new Error('A start and end date are required.');
    if (end < start)    throw new Error('The end date is before the start date.');

    const deadlines = DataService.getAll(SHEET(), DEADLINES_TAB())
      .map(_publicDeadline)
      .filter(d => d.date && d.date >= start && d.date <= end && d.status !== 'removed')
      .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));

    const isSuper = (viewerRoles || []).includes('super_admin');
    const events = DataService.getAll(SHEET(), EVENTS_TAB())
      .map(_publicEvent)
      .filter(e => {
        if (!e.startDate) return false;
        const endDate = e.endDate || e.startDate;
        if (endDate < start || e.startDate > end) return false;      // no overlap
        if (String(e.status || 'published') === 'cancelled') return false;
        if (!e.restricted) return true;
        if (isSuper) return true;
        return _intersects(viewerRoles, e.audienceRoles);
      })
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));

    return { events: events, deadlines: deadlines };
  }


  // ── Deadlines: read ────────────────────────────────────────

  /** Every deadline (management table), date-ascending. */
  function listAllDeadlines() {
    return DataService.getAll(SHEET(), DEADLINES_TAB())
      .map(_publicDeadline)
      .filter(d => d.status !== 'removed')
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.title.localeCompare(b.title));
  }


  // ── Deadlines: write ───────────────────────────────────────

  /**
   * Creates one deadline per date in `input.dates` (multi-date create:
   * "Grad LOA petition" × three quarterly dates in one pass). All
   * instances share the other fields. Origin is 'manual'.
   *
   * DUPLICATE GUARD: any date whose (normalized title, date) key
   * already exists on the calendar is SKIPPED and reported in
   * `skipped`, not created and not an error. This makes create
   * idempotent under double-clicks and re-entry.
   *
   * @param {{title, description, source, link, audienceRoles, dates, perennial}} input
   * @returns {{created: Object[], skipped: Array<{date: string, reason: string}>}}
   */
  function createDeadlines(input) {
    input = input || {};
    const base  = _validateDeadlineFields(input);
    const dates = _validateDates(input.dates);

    // Existing (normalized title, date) keys — read once, then also
    // grown as we insert, so the same request can't duplicate itself.
    const existing = {};
    DataService.getAll(SHEET(), DEADLINES_TAB()).forEach(r => {
      existing[_dupKey(r.Title, r.Date)] = true;
    });

    const created = [];
    const skipped = [];

    dates.forEach(d => {
      const key = _dupKey(base.title, d);
      if (existing[key]) {
        skipped.push({ date: d, reason: 'Already on the calendar' });
        return;
      }
      const rec = {
        DeadlineID:    DataService.generateId('DL'),
        Title:         base.title,
        Description:   base.description,
        Date:          d,
        AudienceRoles: base.audienceRoles,
        Source:        base.source,
        Link:          base.link,
        Origin:        'manual',
        SourceKey:     '',
        ExternalUID:   '',
        Perennial:     input.perennial === true ? 'TRUE' : 'FALSE',
        Pinned:        'FALSE',
        Status:        'active',
        LastSeenAt:    '',
        Kind:          _validateKind(input.kind),
        Color:         _validateColor(input.color),
      };
      DataService.insert(SHEET(), DEADLINES_TAB(), rec);
      existing[key] = true;
      created.push(_publicDeadline(rec));
    });

    return { created: created, skipped: skipped };
  }

  /**
   * Updates one deadline. Only supplied fields change. Pin rule: on an
   * imported row, a Title or Date change sets Pinned=TRUE (the Phase 2
   * refresh will then report upstream divergence instead of proposing
   * an overwrite). A title/date change that would collide with ANOTHER
   * row's (normalized title, date) key throws. Returns the updated
   * shape plus `pinApplied` so the UI can tell the user what happened.
   */
  function updateDeadline(deadlineId, changes) {
    const id = String(deadlineId || '').trim();
    if (!id) throw new Error('Deadline not found.');
    changes = changes || {};

    const rows = DataService.query(SHEET(), DEADLINES_TAB(), 'DeadlineID', id);
    if (!rows.length) throw new Error('Deadline not found.');
    const current = rows[0];

    const fields = {};
    let pinApplied = false;

    if (changes.title !== undefined) {
      const t = String(changes.title).trim();
      if (!t) throw new Error('Title is required.');
      if (t !== String(current.Title).trim()) {
        fields.Title = t;
        if (_isImported(current) && !_isPinned(current)) pinApplied = true;
      }
    }
    if (changes.date !== undefined) {
      const d = _dateOnly(changes.date);
      if (!d) throw new Error('"' + changes.date + '" is not a valid date (use YYYY-MM-DD).');
      if (d !== _dateOnly(current.Date)) {
        fields.Date = d;
        if (_isImported(current) && !_isPinned(current)) pinApplied = true;
      }
    }

    // Collision check when the natural key is changing: the resulting
    // (normalized title, date) must not match a DIFFERENT row.
    if (fields.Title !== undefined || fields.Date !== undefined) {
      const nextKey = _dupKey(
        fields.Title !== undefined ? fields.Title : current.Title,
        fields.Date  !== undefined ? fields.Date  : current.Date);
      const clash = DataService.getAll(SHEET(), DEADLINES_TAB()).some(r =>
        String(r.DeadlineID) !== id && _dupKey(r.Title, r.Date) === nextKey);
      if (clash) throw new Error('An identical deadline already exists on that date.');
    }

    // Always-editable metadata (never pins): ours, layered on their fact.
    if (changes.description   !== undefined) fields.Description   = String(changes.description).trim();
    if (changes.source        !== undefined) fields.Source        = String(changes.source).trim();
    if (changes.link          !== undefined) fields.Link          = _validateLink(changes.link);
    if (changes.audienceRoles !== undefined) fields.AudienceRoles = _splitRoles((changes.audienceRoles || []).join(',')).join(', ');
    if (changes.perennial     !== undefined) fields.Perennial     = changes.perennial === true ? 'TRUE' : 'FALSE';
    if (changes.kind          !== undefined) fields.Kind          = _validateKind(changes.kind);
    if (changes.color         !== undefined) fields.Color         = _validateColor(changes.color);

    if (pinApplied) fields.Pinned = 'TRUE';
    if (!Object.keys(fields).length) return { updated: false, pinApplied: false, deadline: _publicDeadline(current) };

    DataService.update(SHEET(), DEADLINES_TAB(), 'DeadlineID', id, fields);
    const after = Object.assign({}, current, fields);
    return { updated: true, pinApplied: pinApplied, deadline: _publicDeadline(after) };
  }

  /** Deletes a deadline outright. Deliberate and audited via dispatch. */
  function deleteDeadline(deadlineId) {
    const id = String(deadlineId || '').trim();
    if (!id) throw new Error('Deadline not found.');
    const removed = DataService.remove(SHEET(), DEADLINES_TAB(), 'DeadlineID', id);
    if (!removed) throw new Error('Deadline not found.');
    return { deadlineId: id, deleted: true };
  }

  /**
   * Copies a deadline to a new date — the annual re-entry convenience.
   * The copy is a MANUAL row (fresh id, no external identity, no pin):
   * duplicating is a human decision regardless of the original's origin.
   * Throws if the target (normalized title, date) already exists — a
   * duplicate of a duplicate is never intended.
   */
  function duplicateDeadline(deadlineId, newDate) {
    const id = String(deadlineId || '').trim();
    if (!id) throw new Error('Deadline not found.');
    const d = _dateOnly(newDate);
    if (!d) throw new Error('"' + newDate + '" is not a valid date (use YYYY-MM-DD).');

    const rows = DataService.query(SHEET(), DEADLINES_TAB(), 'DeadlineID', id);
    if (!rows.length) throw new Error('Deadline not found.');
    const src = rows[0];

    const key = _dupKey(src.Title, d);
    const clash = DataService.getAll(SHEET(), DEADLINES_TAB()).some(r =>
      _dupKey(r.Title, r.Date) === key);
    if (clash) {
      throw new Error('"' + String(src.Title).trim() + '" is already on the calendar for ' + d + '.');
    }

    const rec = {
      DeadlineID:    DataService.generateId('DL'),
      Title:         String(src.Title || '').trim(),
      Description:   String(src.Description || '').trim(),
      Date:          d,
      AudienceRoles: String(src.AudienceRoles || '').trim(),
      Source:        String(src.Source || '').trim(),
      Link:          String(src.Link || '').trim(),
      Origin:        'manual',
      SourceKey:     '',
      ExternalUID:   '',
      Perennial:     String(src.Perennial).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE',
      Pinned:        'FALSE',
      Status:        'active',
      LastSeenAt:    '',
      Kind:          _validateKind(src.Kind),
      Color:         _validateColor(src.Color),
    };
    DataService.insert(SHEET(), DEADLINES_TAB(), rec);
    return { created: _publicDeadline(rec) };
  }


  // ── Validation helpers ─────────────────────────────────────

  function _validateDeadlineFields(input) {
    const title = String(input.title || '').trim();
    if (!title) throw new Error('Title is required.');
    return {
      title:         title,
      description:   String(input.description || '').trim(),
      source:        String(input.source || '').trim(),
      link:          _validateLink(input.link),
      audienceRoles: _splitRoles((input.audienceRoles || []).join(',')).join(', '),
    };
  }

  function _validateDates(dates) {
    const list = Array.isArray(dates) ? dates : (dates ? [dates] : []);
    if (!list.length) throw new Error('At least one date is required.');
    if (list.length > MAX_DATES_PER_CREATE) {
      throw new Error('At most ' + MAX_DATES_PER_CREATE + ' dates per create.');
    }
    const seen = {};
    const out = [];
    list.forEach(raw => {
      const d = _dateOnly(raw);
      if (!d) throw new Error('"' + raw + '" is not a valid date (use YYYY-MM-DD).');
      if (!seen[d]) { seen[d] = true; out.push(d); }
    });
    return out.sort();
  }

  const COLOR_KEYS = ['gold', 'navy', 'teal', 'plum', 'rust', 'forest', 'slate', 'rose'];
  const KINDS = ['deadline', 'closure'];

  function _validateKind(kind) {
    const k = String(kind == null ? '' : kind).trim().toLowerCase();
    if (!k) return 'deadline';
    if (KINDS.indexOf(k) === -1) throw new Error('Kind must be one of: ' + KINDS.join(', '));
    return k;
  }

  function _validateColor(color) {
    const c = String(color == null ? '' : color).trim().toLowerCase();
    if (!c) return '';
    if (COLOR_KEYS.indexOf(c) === -1) throw new Error('Color must be one of: ' + COLOR_KEYS.join(', '));
    return c;
  }

  function _validateLink(link) {
    const s = String(link == null ? '' : link).trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) {
      throw new Error('Links must start with http:// or https://');
    }
    return s;
  }

  /**
   * The natural key of a deadline: normalized title + date. Title is
   * lowercased with whitespace collapsed, so "GRE Deadline" and
   * " gre  deadline " on the same day are the same deadline.
   */
  function _dupKey(title, date) {
    const t = String(title == null ? '' : title)
      .toLowerCase().replace(/\s+/g, ' ').trim();
    return _dateOnly(date) + '|' + t;
  }


  // ── Public shapes ──────────────────────────────────────────

  function _publicDeadline(r) {
    return {
      deadlineId:    String(r.DeadlineID || ''),
      title:         String(r.Title || '').trim(),
      description:   String(r.Description || '').trim(),
      date:          _dateOnly(r.Date),
      audienceRoles: _splitRoles(r.AudienceRoles),
      source:        String(r.Source || '').trim(),
      link:          String(r.Link || '').trim(),
      origin:        String(r.Origin || 'manual').trim().toLowerCase() || 'manual',
      sourceKey:     String(r.SourceKey || '').trim(),
      perennial:     String(r.Perennial).toUpperCase() === 'TRUE',
      pinned:        String(r.Pinned).toUpperCase() === 'TRUE',
      status:        String(r.Status || 'active').trim().toLowerCase() || 'active',
      kind:          String(r.Kind || 'deadline').trim().toLowerCase() || 'deadline',
      color:         String(r.Color || '').trim().toLowerCase(),
    };
  }

  function _publicEvent(r) {
    const start = _dateTime(r.Start);
    const end   = _dateTime(r.End);
    return {
      eventId:       String(r.EventID || ''),
      title:         String(r.Title || '').trim(),
      description:   String(r.Description || '').trim(),
      start:         start,
      end:           end,
      startDate:     start ? start.slice(0, 10) : '',
      endDate:       end   ? end.slice(0, 10)   : '',
      locationLabel: String(r.LocationLabel || '').trim(),
      audienceRoles: _splitRoles(r.AudienceRoles),
      restricted:    String(r.Restricted).toUpperCase() === 'TRUE',
      status:        String(r.Status || 'published').trim().toLowerCase() || 'published',
    };
  }


  // ── Date / role plumbing ───────────────────────────────────

  /** Any date-ish value → 'yyyy-MM-dd' in the script TZ, or ''. */
  function _dateOnly(v) {
    if (v instanceof Date && !isNaN(v)) {
      return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (isNaN(d)) return '';
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  /** Any datetime-ish value → "yyyy-MM-dd'T'HH:mm" in the script TZ, or ''. */
  function _dateTime(v) {
    if (v instanceof Date && !isNaN(v)) {
      return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm");
    }
    const s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T00:00';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16);
    const d = new Date(s);
    if (isNaN(d)) return '';
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm");
  }

  function _splitRoles(raw) {
    return String(raw == null ? '' : raw)
      .split(',').map(r => r.trim().toLowerCase()).filter(Boolean)
      .filter((r, i, a) => a.indexOf(r) === i);
  }

  function _intersects(a, b) {
    const set = (b || []).map(x => String(x).toLowerCase());
    return (a || []).some(x => set.includes(String(x).toLowerCase()));
  }



  // ============================================================
  // PHASE 2 — Import sources, nightly refresh, pending review,
  // and the paste-a-URL harvester.
  // ============================================================

  const SOURCE_TYPES = ['gcal', 'html', 'gsheet'];

  // ── Sources registry ───────────────────────────────────────

  function listSources() {
    const pendingCounts = {};
    _openPendings().forEach(p => {
      const k = String(p.SourceKey || '');
      pendingCounts[k] = (pendingCounts[k] || 0) + 1;
    });
    return DataService.getAll(SHEET(), SOURCES_TAB())
      .filter(r => String(r.SourceKey || '').trim())
      .map(r => _publicSource(r, pendingCounts))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Insert or update a source (keyed by sourceKey; new rows get a slug
   *  of the label). gcal needs CalendarID; html/gsheet need URL. */
  function saveSource(p) {
    p = p || {};
    const label = String(p.label || '').trim();
    if (!label) throw new Error('A source label is required.');
    const type = String(p.type || '').trim().toLowerCase();
    if (SOURCE_TYPES.indexOf(type) === -1) {
      throw new Error('Source type must be one of: ' + SOURCE_TYPES.join(', '));
    }
    const calendarId = String(p.calendarId || '').trim();
    const url        = String(p.url || '').trim();
    if (type === 'gcal' && !calendarId) throw new Error('A Google Calendar ID is required for a gcal source.');
    if (type !== 'gcal' && !url)        throw new Error('A URL is required for an ' + type + ' source.');
    if (url && !/^https?:\/\//i.test(url)) throw new Error('URLs must start with http:// or https://');

    const existingKey = String(p.sourceKey || '').trim();
    const rows = DataService.getAll(SHEET(), SOURCES_TAB());

    const fields = {
      Label: label, Type: type, URL: url, CalendarID: calendarId,
      ParserKey: String(p.parserKey || '').trim(),
      Enabled: p.enabled === false ? 'FALSE' : 'TRUE',
    };

    if (existingKey) {
      const hit = rows.some(r => String(r.SourceKey) === existingKey);
      if (!hit) throw new Error('Source not found.');
      DataService.update(SHEET(), SOURCES_TAB(), 'SourceKey', existingKey, fields);
      return { sourceKey: existingKey, saved: true };
    }

    // New row: unique slug from the label.
    let key = _slug(label) || DataService.generateId('SRC').toLowerCase();
    const taken = {};
    rows.forEach(r => { taken[String(r.SourceKey)] = true; });
    let candidate = key, n = 2;
    while (taken[candidate]) { candidate = key + '-' + n; n++; }

    DataService.insert(SHEET(), SOURCES_TAB(), Object.assign({
      SourceKey: candidate, LastFetchedAt: '', LastSuccessAt: '', LastResult: '',
    }, fields));
    return { sourceKey: candidate, saved: true };
  }

  /** Removes a source, its open pending rows, and its open task. Already-
   *  imported deadlines are KEPT — they simply stop refreshing. */
  function deleteSource(sourceKey) {
    const key = String(sourceKey || '').trim();
    if (!key) throw new Error('Source not found.');
    const removed = DataService.remove(SHEET(), SOURCES_TAB(), 'SourceKey', key);
    if (!removed) throw new Error('Source not found.');
    _clearOpenPendings(key);
    try { Tasks.resolveForSource('calendar', key, { note: 'Source deleted' }); } catch (e) {}
    return { sourceKey: key, deleted: true };
  }

  // ── Refresh (manual "Fetch now" and the nightly job) ───────

  /**
   * Fetches one source, diffs against its imported deadlines, rewrites
   * its OPEN pending rows, and syncs the review Task + near-term Notify.
   * Throws on fetch/parse failure — callers decide how loud to be.
   */
  function refreshSource(sourceKey, opts) {
    const patient = !!(opts && opts.patient);
    const key = String(sourceKey || '').trim();
    const src = _sourceByKey(key);
    if (!src) throw new Error('Source not found.');

    const type = String(src.Type).toLowerCase();
    let fetchFn;
    if (type === 'gcal') {
      fetchFn = () => _fetchGcal(src);
    } else if (type === 'html' || type === 'gsheet') {
      const parser = PARSERS[String(src.ParserKey || '').trim()];
      if (!parser) {
        const msg = 'Skipped: set a Parser for this source. Available: '
          + Object.keys(PARSERS).join(', ') + '.';
        DataService.update(SHEET(), SOURCES_TAB(), 'SourceKey', key, {
          LastFetchedAt: new Date(), LastResult: msg,
        });
        return { sourceKey: key, skipped: true, reason: msg };
      }
      // Feed each parser the content shape it declares: raw HTML, or
      // parsed CSV rows for published-sheet parsers.
      fetchFn = () => parser.fn(
        parser.content === 'csv'
          ? Utilities.parseCsv(_fetchHtml(src, patient))
          : _fetchHtml(src, patient),
        src);
    } else {
      DataService.update(SHEET(), SOURCES_TAB(), 'SourceKey', key, {
        LastFetchedAt: new Date(),
        LastResult: 'Skipped: no ' + src.Type + ' parser yet.',
      });
      return { sourceKey: key, skipped: true, reason: 'No ' + src.Type + ' parser yet.' };
    }

    let summary;
    try {
      const candidates = fetchFn();
      const diff = _diffAndQueue(src, candidates);
      summary = candidates.length + ' fetched; ' + diff.total + ' pending ('
        + diff.added + ' new, ' + diff.changed + ' changed, ' + diff.vanished
        + ' vanished' + (diff.pinnedDiverged ? ', ' + diff.pinnedDiverged + ' pinned-diverged' : '') + ')'
        + (diff.rolled ? '; ' + diff.rolled + ' annual rolled forward' : '')
        + (diff.manualDup ? '; ' + diff.manualDup + ' already on calendar' : '');
      DataService.update(SHEET(), SOURCES_TAB(), 'SourceKey', key, {
        LastFetchedAt: new Date(), LastSuccessAt: new Date(), LastResult: summary,
        FailStreak: 0,   // any success resets the alerting streak
      });
      _syncTaskAndNotify(src, diff);
      return Object.assign({ sourceKey: key, fetched: candidates.length, summary: summary }, diff);
    } catch (err) {
      DataService.update(SHEET(), SOURCES_TAB(), 'SourceKey', key, {
        LastFetchedAt: new Date(), LastResult: 'ERROR: ' + (err && err.message ? err.message : err),
      });
      throw err;
    }
  }

  /**
   * The nightly Scheduler job body: refresh every ENABLED source.
   * A failing source is reported loudly (Notify to the task pool) and
   * skipped — it can never break the other sources or the job.
   */
  function nightlyRefreshAll(context) {
    const results = [];
    DataService.getAll(SHEET(), SOURCES_TAB())
      .filter(r => String(r.SourceKey || '').trim())
      .filter(r => String(r.Enabled).toUpperCase() !== 'FALSE')
      .forEach(src => {
        const key = String(src.SourceKey);
        try {
          const r = refreshSource(key, { patient: true });
          results.push(key + ': ' + (r.skipped ? r.reason : r.summary));
        } catch (err) {
          const msg = (err && err.message) ? err.message : String(err);
          const streak = (Number(src.FailStreak) || 0) + 1;
          DataService.update(SHEET(), SOURCES_TAB(), 'SourceKey', key, { FailStreak: streak });
          results.push(key + ': ERROR (' + streak + ' consecutive) ' + msg);
          // Campus transport is demonstrably flaky (single-night misses
          // self-heal on the next run), so the email waits for a streak
          // of 3 — then repeats every 3rd failure so a dead source never
          // goes permanently silent. Stale marking is immediate as ever.
          if (streak >= 3 && streak % 3 === 0) {
            _notifyPool(
              'Calendar source failing repeatedly: ' + (src.Label || key),
              'The nightly calendar refresh has failed ' + streak + ' nights in a row for "'
              + (src.Label || key) + '".\n\n'
              + 'Latest error: ' + msg + '\n\n'
              + 'Deadlines from this source were last successfully refreshed: '
              + (_dateTime(src.LastSuccessAt) || 'never') + '.\n'
              + 'The source is marked stale in the Calendar module (Imports tab).');
          }
        }
      });
    Logger.log('Calendar nightlyRefresh: ' + (results.join(' | ') || 'no enabled sources'));
    return { results: results };
  }

  /** Advanced Calendar API fetch: now → +FETCH_MONTHS_AHEAD months. */
  function _fetchGcal(src) {
    if (typeof Calendar === 'undefined' || !Calendar.Events || !Calendar.Events.list) {
      throw new Error('The Google Calendar advanced service is not enabled. '
        + 'In the Apps Script editor: Services (+) -> Google Calendar API -> Add.');
    }
    const calId = String(src.CalendarID || '').trim();
    const months = (CONFIG.CALENDAR && CONFIG.CALENDAR.FETCH_MONTHS_AHEAD) || 18;
    const timeMin = new Date();
    const timeMax = new Date(timeMin.getFullYear(), timeMin.getMonth() + months, timeMin.getDate());

    const out = [];
    const seen = {};
    let pageToken = null;
    do {
      const resp = Calendar.Events.list(calId, {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        showDeleted: false,
        maxResults: 2500,
        pageToken: pageToken || undefined,
      });
      (resp.items || []).forEach(it => {
        const uid = String(it.id || '').trim();
        const title = String(it.summary || '').replace(/\s+/g, ' ').trim();
        if (!uid || !title || seen[uid]) return;
        const start = it.start || {};
        const date = start.date ? String(start.date)
                   : (start.dateTime ? String(start.dateTime).slice(0, 10) : '');
        if (!date) return;
        seen[uid] = true;
        out.push({
          uid: uid, title: title, date: date,
          detail: String(it.description || '').replace(/\s+/g, ' ').trim().slice(0, 500),
          link: String(it.htmlLink || ''),
        });
      });
      pageToken = resp.nextPageToken;
    } while (pageToken);
    return out;
  }

  /**
   * The diff engine. Wholesale-replaces the source's OPEN pending rows
   * (idempotent under nightly re-runs), comparing candidates to imported
   * deadlines by ExternalUID:
   *   absent UID + no manual (title,date) twin -> 'new'
   *   present, title/date differ, unpinned     -> 'changed'
   *   present, differ, PINNED                  -> 'pinned_diverged' (info)
   *   imported future row whose UID vanished   -> 'vanished'
   */
  function _diffAndQueue(src, candidates) {
    const key = String(src.SourceKey);
    const today = _dateOnly(new Date());

    const imported = DataService.getAll(SHEET(), DEADLINES_TAB())
      .filter(r => _isImported(r) && String(r.SourceKey) === key
                && String(r.Status || 'active').toLowerCase() !== 'removed');
    const byUID = {};
    imported.forEach(r => { const u = String(r.ExternalUID || '').trim(); if (u) byUID[u] = r; });

    const dupKeys = {};
    DataService.getAll(SHEET(), DEADLINES_TAB()).forEach(r => {
      if (String(r.Status || 'active').toLowerCase() === 'removed') return;
      dupKeys[_dupKey(r.Title, r.Date)] = true;
    });

    _clearOpenPendings(key);

    const pendings = [];
    const nearTerm = [];
    let added = 0, changed = 0, vanished = 0, pinnedDiverged = 0, manualDup = 0, rolled = 0;
    const candSet = {};

    candidates.forEach(c => {
      candSet[c.uid] = true;
      const row = byUID[c.uid];
      if (!row) {
        if (dupKeys[_dupKey(c.title, c.date)]) { manualDup++; return; }
        pendings.push(_pendingRec(key, 'new', c.uid, '', c.title, c.date, '', '', c.detail, c.link, c.audience));
        added++;
        if (_withinNearTerm(c.date, today)) nearTerm.push('NEW ' + c.date + ' — ' + c.title);
        return;
      }
      const curTitle = String(row.Title || '').trim();
      const curDate  = _dateOnly(row.Date);
      if (curTitle === c.title && curDate === c.date) return;   // unchanged

      // PERENNIAL SEMANTICS (Phase 3.2, agreed design): identity is
      // month+day. Same month/day + same title but a different year is
      // the definition of annual, not a change of fact — roll forward
      // silently (never on pinned rows). Only month/day drift or a
      // retitle falls through to the pending queue below.
      const isPerennial = c.perennial === true || String(c.uid).indexOf('perennial|') === 0
        || String(row.Perennial).toUpperCase() === 'TRUE';
      if (isPerennial && curTitle === c.title
          && curDate && c.date && curDate.slice(5) === c.date.slice(5)) {
        if (!_isPinned(row) && curDate !== c.date) {
          DataService.update(SHEET(), DEADLINES_TAB(), 'DeadlineID', String(row.DeadlineID), {
            Date: c.date, LastSeenAt: new Date(),
          });
          rolled++;
        }
        return;   // pinned + same month/day: their pin holds, nothing to flag
      }

      if (_isPinned(row)) {
        pendings.push(_pendingRec(key, 'pinned_diverged', c.uid, String(row.DeadlineID),
          c.title, c.date, curTitle, curDate, c.detail, c.link));
        pinnedDiverged++;
        return;
      }
      pendings.push(_pendingRec(key, 'changed', c.uid, String(row.DeadlineID),
        c.title, c.date, curTitle, curDate, c.detail, c.link));
      changed++;
      if (_withinNearTerm(c.date, today) || _withinNearTerm(curDate, today)) {
        nearTerm.push('CHANGED — ' + curTitle + ': ' + curDate + ' -> ' + c.date);
      }
    });

    imported.forEach(r => {
      const uid = String(r.ExternalUID || '').trim();
      const d = _dateOnly(r.Date);
      if (!uid || candSet[uid] || !d || d < today) return;   // past rows age out
      pendings.push(_pendingRec(key, 'vanished', uid, String(r.DeadlineID),
        '', '', String(r.Title || '').trim(), d, '', ''));
      vanished++;
    });

    _batchInsertPendings(pendings);

    return { added: added, changed: changed, vanished: vanished,
             pinnedDiverged: pinnedDiverged, manualDup: manualDup, rolled: rolled,
             total: pendings.length, nearTerm: nearTerm };
  }

  function _pendingRec(key, kind, uid, deadlineId, title, date, oldTitle, oldDate, detail, link, suggestedAudience) {
    return {
      PendingID: DataService.generateId('PEND'), SourceKey: key, Kind: kind,
      ExternalUID: uid, DeadlineID: deadlineId,
      Title: title, Date: date, OldTitle: oldTitle, OldDate: oldDate,
      Detail: detail, Link: link,
      SuggestedAudience: _splitRoles((suggestedAudience || []).join(',')).join(', '),
      Status: 'open', DecidedBy: '', DecidedAt: '',
    };
  }

  /** One open review Task per source; resolve it when the queue empties.
   *  Notify the pool only for near-term changes (middle-path rule). */
  function _syncTaskAndNotify(src, diff) {
    const key = String(src.SourceKey);
    try {
      if (diff.total > 0) {
        if (!Tasks.openForSource('calendar', key).length) {
          Tasks.create({
            module: 'calendar', sourceType: 'calendar_source', sourceId: key,
            label: (src.Label || key) + ': imported deadline changes to review',
            assignedRole: (CONFIG.CALENDAR && CONFIG.CALENDAR.REFRESH_TASK_ROLE) || 'staff',
          });
        }
      } else {
        Tasks.resolveForSource('calendar', key, { note: 'Refresh found nothing to review' });
      }
    } catch (err) {
      Logger.log('CalendarService task sync failed for ' + key + ': ' + err);
    }
    if (diff.nearTerm && diff.nearTerm.length) {
      _notifyPool(
        'Calendar deadlines changing within 30 days: ' + (src.Label || key),
        'The calendar refresh found upstream changes to deadlines in the next '
        + ((CONFIG.CALENDAR && CONFIG.CALENDAR.NEAR_TERM_DAYS) || 30) + ' days:\n\n'
        + diff.nearTerm.join('\n')
        + '\n\nReview and commit them in the Calendar module -> Imports tab.');
    }
  }

  function _withinNearTerm(dateStr, todayStr) {
    if (!dateStr) return false;
    const days = (CONFIG.CALENDAR && CONFIG.CALENDAR.NEAR_TERM_DAYS) || 30;
    const d = new Date(dateStr + 'T12:00:00');
    const t = new Date(todayStr + 'T12:00:00');
    const diff = (d - t) / 86400000;
    return diff >= 0 && diff <= days;
  }

  function _notifyPool(subject, body) {
    try {
      const role = (CONFIG.CALENDAR && CONFIG.CALENDAR.REFRESH_TASK_ROLE) || 'staff';
      const pool = Auth.usersWithRole(role).map(u => u.email);
      const to = Notify.resolveRecipients({ superAdmins: CONFIG.SUPER_ADMINS, explicit: pool });
      Notify.send({ to: to, subject: subject, body: body });
    } catch (err) {
      Logger.log('CalendarService notify failed: ' + err);
    }
  }

  // ── Pending review: list / commit / dismiss ────────────────

  function listPending(sourceKey) {
    const key = String(sourceKey || '').trim();
    return _openPendings()
      .filter(p => !key || String(p.SourceKey) === key)
      .map(p => ({
        pendingId: String(p.PendingID), sourceKey: String(p.SourceKey),
        kind: String(p.Kind), deadlineId: String(p.DeadlineID || ''),
        title: String(p.Title || '').trim(), date: _dateOnly(p.Date),
        oldTitle: String(p.OldTitle || '').trim(), oldDate: _dateOnly(p.OldDate),
        detail: String(p.Detail || '').trim(), link: String(p.Link || '').trim(),
        suggestedAudience: _splitRoles(p.SuggestedAudience),
      }))
      .sort((a, b) => (a.date || a.oldDate).localeCompare(b.date || b.oldDate));
  }

  /**
   * Applies selected pending rows. items: [{pendingId, audienceRoles?}].
   * 'new' inserts an imported deadline (audience from the reviewer);
   * 'changed' updates the target's title/date WITHOUT pinning (this is
   * the upstream fact arriving, not a human override) and stamps
   * LastSeenAt; 'vanished' marks the deadline Status='removed' (kept for
   * audit; hidden from every view); 'pinned_diverged' is informational
   * and is simply cleared. Resolves the source Task when its queue empties.
   */
  function commitPending(items, user) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) throw new Error('Nothing selected.');
    const sources = {};
    DataService.getAll(SHEET(), SOURCES_TAB()).forEach(r => { sources[String(r.SourceKey)] = r; });

    // One read of the pending tab for the whole batch (Phase 2.1).
    const pendingById = {};
    DataService.getAll(SHEET(), PENDING_TAB()).forEach(p => { pendingById[String(p.PendingID)] = p; });

    const results = [];
    const touchedSources = {};
    list.forEach(item => {
      const id = String((item || {}).pendingId || '').trim();
      const p = pendingById[id];
      if (!p || String(p.Status) !== 'open') {
        results.push({ pendingId: id, status: 'skipped', reason: 'Not an open pending item' });
        return;
      }
      const kind = String(p.Kind);
      const srcRow = sources[String(p.SourceKey)] || {};
      try {
        if (kind === 'new') {
          const title = String(p.Title || '').trim();
          const date  = _dateOnly(p.Date);
          const existing = DataService.getAll(SHEET(), DEADLINES_TAB()).some(r =>
            String(r.Status || 'active').toLowerCase() !== 'removed'
            && _dupKey(r.Title, r.Date) === _dupKey(title, date));
          if (existing) {
            results.push({ pendingId: id, status: 'skipped', reason: 'Already on the calendar' });
          } else {
            DataService.insert(SHEET(), DEADLINES_TAB(), {
              DeadlineID: DataService.generateId('DL'),
              Title: title, Description: String(p.Detail || '').trim(), Date: date,
              // Reviewer's shared-picker choice overrides; otherwise the
              // extractor's per-item suggestion applies (Phase 3).
              AudienceRoles: (((item || {}).audienceRoles || []).length
                ? _splitRoles(item.audienceRoles.join(','))
                : _splitRoles(p.SuggestedAudience)).join(', '),
              Source: String(srcRow.Label || p.SourceKey || '').trim(),
              Link: String(p.Link || '').trim(),
              Origin: 'imported', SourceKey: String(p.SourceKey),
              ExternalUID: String(p.ExternalUID || ''),
              // uid prefix 'perennial|' is our own scheme — deriving the
              // flag from it avoids a pending-schema change (Phase 3.2).
              Perennial: String(p.ExternalUID || '').indexOf('perennial|') === 0 ? 'TRUE' : 'FALSE',
              Pinned: 'FALSE', Status: 'active', LastSeenAt: new Date(),
              // Per-item kind (Phase 3.5): lets the reviewer commit the
              // Registrar feed's holiday entries AS closures.
              Kind: _validateKind((item || {}).kind), Color: '',
            });
            results.push({ pendingId: id, status: 'committed' });
          }
        } else if (kind === 'changed') {
          const target = DataService.query(SHEET(), DEADLINES_TAB(), 'DeadlineID', String(p.DeadlineID));
          if (!target.length) {
            results.push({ pendingId: id, status: 'skipped', reason: 'Target deadline no longer exists' });
          } else if (_isPinned(target[0])) {
            results.push({ pendingId: id, status: 'skipped', reason: 'Deadline is pinned' });
          } else {
            DataService.update(SHEET(), DEADLINES_TAB(), 'DeadlineID', String(p.DeadlineID), {
              Title: String(p.Title || '').trim(), Date: _dateOnly(p.Date), LastSeenAt: new Date(),
            });
            results.push({ pendingId: id, status: 'committed' });
          }
        } else if (kind === 'vanished') {
          DataService.update(SHEET(), DEADLINES_TAB(), 'DeadlineID', String(p.DeadlineID), {
            Status: 'removed', LastSeenAt: new Date(),
          });
          results.push({ pendingId: id, status: 'committed' });
        } else {   // pinned_diverged — informational only
          results.push({ pendingId: id, status: 'dismissed' });
        }
        DataService.update(SHEET(), PENDING_TAB(), 'PendingID', id, {
          Status: (kind === 'pinned_diverged') ? 'dismissed' : 'committed',
          DecidedBy: String(user || ''), DecidedAt: new Date(),
        });
        touchedSources[String(p.SourceKey)] = true;
      } catch (err) {
        results.push({ pendingId: id, status: 'error', reason: (err && err.message) || String(err) });
      }
    });
    Object.keys(touchedSources).forEach(_maybeResolveTask);
    return { results: results };
  }

  function dismissPending(pendingIds, user) {
    const ids = Array.isArray(pendingIds) ? pendingIds : [];
    if (!ids.length) throw new Error('Nothing selected.');
    let n = 0;
    const touched = {};
    ids.forEach(id => {
      const rows = DataService.query(SHEET(), PENDING_TAB(), 'PendingID', String(id));
      if (!rows.length || String(rows[0].Status) !== 'open') return;
      DataService.update(SHEET(), PENDING_TAB(), 'PendingID', String(id), {
        Status: 'dismissed', DecidedBy: String(user || ''), DecidedAt: new Date(),
      });
      touched[String(rows[0].SourceKey)] = true;
      n++;
    });
    Object.keys(touched).forEach(_maybeResolveTask);
    return { dismissed: n };
  }

  function _maybeResolveTask(sourceKey) {
    const stillOpen = _openPendings().some(p => String(p.SourceKey) === sourceKey);
    if (!stillOpen) {
      try { Tasks.resolveForSource('calendar', sourceKey, { note: 'Pending review cleared' }); }
      catch (e) { Logger.log('CalendarService resolve task failed: ' + e); }
    }
  }


  // ── Batch sheet plumbing (Phase 2.1) ───────────────────────
  // The ONLY direct sheet access in this service. DataService has no
  // batch operations, and the refresh path writes/updates hundreds of
  // rows at once — one setValues call instead of N appendRows.

  function _pendingSheet() {
    return SpreadsheetApp.openById(SHEET()).getSheetByName(PENDING_TAB());
  }

  function _actor() {
    try { return Session.getActiveUser().getEmail() || 'scheduler'; }
    catch (e) { return 'scheduler'; }
  }

  /** Appends records to the pending tab in one write, aligning values
   *  to the live header row by name (never by position). */
  function _batchInsertPendings(recs) {
    if (!recs.length) return;
    const sheet = _pendingSheet();
    if (!sheet) throw new Error('CalendarPending tab is missing — run setUp().');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(h => String(h).trim());
    const now = new Date();
    const who = _actor();
    const rows = recs.map(rec => headers.map(h => {
      if (h === 'CreatedAt') return now;
      if (h === 'CreatedBy') return who;
      return rec[h] !== undefined ? rec[h] : '';
    }));
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  }

  function _openPendings() {
    return DataService.getAll(SHEET(), PENDING_TAB())
      .filter(p => String(p.Status || '').trim() === 'open');
  }

  /** Marks the source's OPEN pending rows 'superseded' in a single
   *  column write (a fresh diff replaces them). Superseded rows are
   *  kept as refresh history; every reader filters on Status='open'. */
  function _clearOpenPendings(sourceKey) {
    const sheet = _pendingSheet();
    if (!sheet || sheet.getLastRow() < 2) return;
    const data = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
    const headers = data[0].map(h => String(h).trim());
    const iStatus = headers.indexOf('Status');
    const iKey    = headers.indexOf('SourceKey');
    if (iStatus < 0 || iKey < 0) return;
    let changed = false;
    const col = [];
    for (let r = 1; r < data.length; r++) {
      let v = data[r][iStatus];
      if (String(v).trim() === 'open' && String(data[r][iKey]).trim() === String(sourceKey)) {
        v = 'superseded';
        changed = true;
      }
      col.push([v]);
    }
    if (changed) sheet.getRange(2, iStatus + 1, col.length, 1).setValues(col);
  }

  function _sourceByKey(key) {
    const rows = DataService.query(SHEET(), SOURCES_TAB(), 'SourceKey', key);
    return rows.length ? rows[0] : null;
  }

  function _publicSource(r, pendingCounts) {
    return {
      sourceKey: String(r.SourceKey), label: String(r.Label || '').trim(),
      type: String(r.Type || '').trim().toLowerCase(),
      url: String(r.URL || '').trim(), calendarId: String(r.CalendarID || '').trim(),
      parserKey: String(r.ParserKey || '').trim(),
      enabled: String(r.Enabled).toUpperCase() !== 'FALSE',
      lastFetchedAt: _dateTime(r.LastFetchedAt), lastSuccessAt: _dateTime(r.LastSuccessAt),
      lastResult: String(r.LastResult || '').trim(),
      openPending: (pendingCounts || {})[String(r.SourceKey)] || 0,
    };
  }

  function _slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }



  // ── Read-only service face for other modules (Phase 3.5) ───
  // The Auth pattern: consumed SERVER-SIDE by other modules' handlers
  // (Academic Personnel's scheduler is the first customer) — never via
  // dispatch. Only committed rows are visible here; the pending queue
  // does not exist as far as consumers are concerned.

  /**
   * Search committed deadlines. All filter fields optional:
   *   titleContains (case-insensitive), sourceKey, origin, kind
   *   ('deadline' default — pass 'closure' or 'any' to widen),
   *   from / to ('yyyy-MM-dd', inclusive).
   * Returns public deadline shapes, active only, date-ascending.
   * Feeds anchor-pickers; consumers should STORE the deadlineId they
   * choose and read by id at compute time (titles are upstream's words
   * and get reworded; ids are immutable).
   */
  function findDeadlines(filter) {
    filter = filter || {};
    const needle = String(filter.titleContains || '').trim().toLowerCase();
    const srcKey = String(filter.sourceKey || '').trim();
    const origin = String(filter.origin || '').trim().toLowerCase();
    const kind   = String(filter.kind || 'deadline').trim().toLowerCase();
    const from   = _dateOnly(filter.from);
    const to     = _dateOnly(filter.to);
    return DataService.getAll(SHEET(), DEADLINES_TAB())
      .map(_publicDeadline)
      .filter(d => d.status === 'active')
      .filter(d => kind === 'any' || d.kind === kind)
      .filter(d => !needle || d.title.toLowerCase().indexOf(needle) !== -1)
      .filter(d => !srcKey || d.sourceKey === srcKey)
      .filter(d => !origin || d.origin === origin)
      .filter(d => !from || (d.date && d.date >= from))
      .filter(d => !to || (d.date && d.date <= to))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  /**
   * One deadline by its immutable id, or null. Removed rows ARE
   * returned (status: 'removed') so a consumer can detect that its
   * stored anchor vanished upstream and flag instead of computing on
   * a ghost.
   */
  function getDeadlineById(deadlineId) {
    const id = String(deadlineId || '').trim();
    if (!id) return null;
    const rows = DataService.query(SHEET(), DEADLINES_TAB(), 'DeadlineID', id);
    return rows.length ? _publicDeadline(rows[0]) : null;
  }

  /**
   * Non-working days (Kind='closure') within [fromISO, toISO]
   * inclusive, as a sorted, de-duplicated array of 'yyyy-MM-dd'
   * strings. Weekend-skipping is the CONSUMER's own arithmetic —
   * this face supplies only the closure facts.
   */
  function listClosures(fromISO, toISO) {
    const from = _dateOnly(fromISO);
    const to   = _dateOnly(toISO);
    if (!from || !to) throw new Error('listClosures needs from and to dates (yyyy-MM-dd).');
    const seen = {};
    return DataService.getAll(SHEET(), DEADLINES_TAB())
      .map(_publicDeadline)
      .filter(d => d.kind === 'closure' && d.status === 'active'
                && d.date && d.date >= from && d.date <= to)
      .map(d => d.date)
      .filter(d => (seen[d] ? false : (seen[d] = true)))
      .sort();
  }

  // ── Phase 3: parser registry + dedicated extractors ────────

  /** ParserKey -> extractor. Adding a page = one function + one entry
   *  here + a ParserKey on the source row (UI-managed). */
  const PARSERS = {
    apo_call_calendar:       { label: 'APO Call Calendar', fn: _parseApoCallCalendar, content: 'html' },
    curriculum_deadlines:    { label: 'Curriculum & Program Statement Deadlines', fn: _parseCurriculumDeadlines, content: 'html' },
    course_scheduling_sheet: { label: 'Course Scheduling Calendar (published sheet)', fn: _parseCourseSchedulingSheet, content: 'csv' },
  };

  /** For the source-form dropdown. */
  function listParsers() {
    return Object.keys(PARSERS).map(k => ({ key: k, label: PARSERS[k].label }));
  }

  /** Fetch with retry for flaky transport. Retries only failures that
   *  smell like the network (the campus edge dropping a Google egress
   *  IP), never genuine 4xx responses. */
  const RETRY_QUICK   = { attempts: 3, waits: [1500, 3000] };      // manual: human watching
  const RETRY_PATIENT = { attempts: 3, waits: [10000, 30000] };    // nightly: time to spare

  function _fetchWithRetry(url, profile) {
    profile = profile || RETRY_QUICK;
    const attempts = profile.attempts || 3;
    let lastMsg = '';
    for (let i = 1; i <= attempts; i++) {
      try {
        const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
        const code = resp.getResponseCode();
        if (code >= 500) throw new Error('HTTP ' + code);          // retryable
        if (code >= 400) throw new Error('NORETRY:The page returned HTTP ' + code + '.');
        return resp.getContentText() || '';
      } catch (err) {
        lastMsg = String((err && err.message) || err);
        if (lastMsg.indexOf('NORETRY:') === 0) throw new Error(lastMsg.slice(8));
        const retryable = /Address unavailable|timed?\s*out|Timeout|DNS|HTTP 5\d\d/i.test(lastMsg);
        if (!retryable || i === attempts) {
          throw new Error(lastMsg + (i > 1 ? ' (after ' + i + ' attempts)' : ''));
        }
        Utilities.sleep((profile.waits || [1500, 3000])[i - 1] || 3000);   // fresh attempt, likely fresh egress IP
      }
    }
    throw new Error(lastMsg);
  }

  function _fetchHtml(src, patient) {
    const url = String(src.URL || '').trim();
    if (!url) throw new Error('The source has no URL.');
    return _fetchWithRetry(url, patient ? RETRY_PATIENT : RETRY_QUICK);
  }

  /** Strip tags, decode the common entities, collapse whitespace. */
  function _cellText(html) {
    return String(html || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&#8217;|&rsquo;|&#39;/g, "'").replace(/&#8216;|&lsquo;/g, "'")
      .replace(/&#8211;|&ndash;/g, '-').replace(/&#8212;|&mdash;/g, '-')
      .replace(/&quot;|&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();
  }

  const FULL_MONTHS = { january:0, february:1, march:2, april:3, may:4, june:5,
                        july:6, august:7, september:8, october:9, november:10, december:11 };

  /** First "Month D, YYYY" in a cell -> {date:'yyyy-MM-dd', rest: qualifier}. */
  function _firstFullDate(cell) {
    const re = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i;
    const m = re.exec(cell);
    if (!m) return null;
    const d = new Date(Number(m[3]), FULL_MONTHS[m[1].toLowerCase()], Number(m[2]));
    if (isNaN(d)) return null;
    const rest = (cell.slice(0, m.index) + cell.slice(m.index + m[0].length))
      .replace(/\s+/g, ' ').trim().replace(/^\(/, '').replace(/\)$/, '').trim();
    return { date: Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'), rest: rest };
  }

  /** Yearless "October 5" / "Nov. 17*" -> NEXT occurrence from today,
   *  plus any leftover qualifier text and whether it carried a footnote
   *  asterisk. Accepts full or abbreviated month names. */
  function _nextOccurrence(cell) {
    const s = String(cell || '');
    const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(s);
    if (!m) return null;
    const MONTHS3 = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
                      jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    const mo = MONTHS3[m[1].toLowerCase().slice(0, 3)];
    const day = Number(m[2]);
    const today = new Date();
    let d = new Date(today.getFullYear(), mo, day);
    if (d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
      d = new Date(today.getFullYear() + 1, mo, day);
    }
    return {
      date: Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      rest: s.replace(m[0], '').replace(/\*/g, '').replace(/\s+/g, ' ').trim(),
      starred: s.indexOf('*') !== -1,
    };
  }

  /** All tables in document order as arrays of cell-text rows. */
  function _parseTables(html) {
    const out = [];
    const tableRe = /<table[\s\S]*?<\/table>/gi;
    let t;
    while ((t = tableRe.exec(html)) !== null) {
      const rows = [];
      const trRe = /<tr[\s\S]*?<\/tr>/gi;
      let tr;
      while ((tr = trRe.exec(t[0])) !== null) {
        const cells = [];
        const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let cd;
        while ((cd = cellRe.exec(tr[0])) !== null) cells.push(_cellText(cd[1]));
        if (cells.length) rows.push(cells);
      }
      if (rows.length) out.push(rows);
    }
    return out;
  }

  /** djb2 hash, hex — disambiguates UIDs whose slugs would collide
   *  (two long titles sharing an 80-char prefix). */
  function _titleHash(s) {
    let h = 5381;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  /** Roles that actually exist, for filtering extractor suggestions. */
  function _liveRoleSet() {
    try {
      const set = {};
      RolesManager.list().forEach(r => { set[String(r.role).trim().toLowerCase()] = true; });
      return set;
    } catch (e) { return null; }   // null = can't verify; pass suggestions through
  }

  function _filterSuggestion(rolesArr) {
    const live = _liveRoleSet();
    const clean = _splitRoles((rolesArr || []).join(','));
    return live ? clean.filter(r => live[r]) : clean;
  }

  /**
   * APO Call Calendar extractor (design settled in the Phase 3 prototype):
   *   - Call year lifted from the "NNNN-NN Call" heading; baked into every
   *     title and UID, so a new call cycle arrives as NEW rows, never as a
   *     storm of false "changed" flags.
   *   - Walks headings and tables in document order, carrying section
   *     context (Senate vs Non-Senate; Appointment vs Advancement).
   *   - Appointment Files tables are SKIPPED for now (deferred by
   *     decision; delete the subsection check to include them later).
   *   - Action|Deadline tables: title verbatim + " (YYYY-YY Call)";
   *     first full date in the deadline cell is the date; any remaining
   *     cell text (e.g. "or by earlier deadline established by
   *     department") becomes detail.
   *   - Effective|Due tables (the two-date trap): the DUE date is the
   *     deadline; the effective date is meaning and lives in the title:
   *     "Non-senate actions effective July 1, 2026 — files due to APO".
   *   - UID = callYear | slug(section+title, 80 chars) | djb2(title) —
   *     the hash exists because two long external-reviewer rows collide
   *     at any reasonable slug length (caught in the prototype).
   *   - Audience suggestions: Senate rows -> senate_faculty +
   *     staff_manager + department_chair; Non-Senate rows -> lecturer +
   *     staff_manager + department_chair (filtered to roles that exist).
   *   - Throws if the call year or ANY candidates cannot be found —
   *     parser drift must surface as a stale source, never as silence.
   */
  function _parseApoCallCalendar(html, src) {
    // Search the WHOLE document's text (scripts/styles stripped) — the
    // heading sits well past WordPress's front-matter (Phase 3.1 fix).
    const pageText = _cellText(html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' '));
    const yearMatch = /(\d{4})\s*[-\u2013]\s*(\d{2})\s+Call\b/i.exec(pageText);
    if (!yearMatch) throw new Error('APO parser: could not find the "NNNN-NN Call" heading — page structure may have changed.');
    const callYear = yearMatch[1] + '-' + yearMatch[2];
    const url = String(src.URL || '').trim();

    const SENATE_AUD    = ['senate_faculty', 'staff_manager', 'department_chair'];
    const NONSENATE_AUD = ['lecturer', 'staff_manager', 'department_chair'];

    let section = '';      // 'senate' | 'nonsenate'
    let subsection = '';   // 'appointment' | 'advancement' | ''
    const out = [];

    const tokenRe = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>|<table[\s\S]*?<\/table>/gi;
    let tok;
    while ((tok = tokenRe.exec(html)) !== null) {
      if (tok[1]) {   // a heading: update context
        const t = _cellText(tok[2]).toLowerCase();
        if (t.indexOf('non-senate') !== -1 || t.indexOf('non senate') !== -1) { section = 'nonsenate'; subsection = ''; }
        else if (t.indexOf('senate') !== -1) { section = 'senate'; subsection = ''; }
        if (t.indexOf('appointment') !== -1) subsection = 'appointment';
        else if (t.indexOf('advancement') !== -1) subsection = 'advancement';
        continue;
      }

      // A table: classify by its first row's cells.
      const rows = [];
      const trRe = /<tr[\s\S]*?<\/tr>/gi;
      let tr;
      while ((tr = trRe.exec(tok[0])) !== null) {
        const cells = [];
        const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let cd;
        while ((cd = cellRe.exec(tr[0])) !== null) cells.push(_cellText(cd[1]));
        if (cells.length) rows.push(cells);
      }
      if (rows.length < 2) continue;
      const head = rows[0].map(c => c.toLowerCase());
      const isActionDeadline = head.some(c => c.indexOf('action') !== -1) && head.some(c => c.indexOf('deadline') !== -1);
      const isEffectiveDue   = head.some(c => c.indexOf('effective') !== -1);
      if (!isActionDeadline && !isEffectiveDue) continue;
      if (subsection === 'appointment') continue;   // deferred by decision

      const sectionLabel = section === 'nonsenate' ? 'Non-Senate Academics' : 'Senate Faculty';
      const audience = _filterSuggestion(section === 'nonsenate' ? NONSENATE_AUD : SENATE_AUD);

      rows.slice(1).forEach(cells => {
        if (cells.length < 2 || !cells[0]) return;
        if (isActionDeadline) {
          const parsed = _firstFullDate(cells[1]);
          if (!parsed) return;   // a row without a real date (blank/TBD) is not a deadline
          const rawTitle = cells[0];
          const title = rawTitle + ' (' + callYear + ' Call)';
          out.push({
            uid: callYear + '|' + _slug(sectionLabel + ' ' + rawTitle).slice(0, 80) + '|' + _titleHash(sectionLabel + rawTitle),
            title: title, date: parsed.date,
            detail: [sectionLabel + (subsection ? ' \u00b7 ' + subsection.charAt(0).toUpperCase() + subsection.slice(1) + ' Files' : ''),
                     parsed.rest].filter(Boolean).join(' \u2014 '),
            link: url, audience: audience,
          });
        } else {
          const eff = _firstFullDate(cells[0]);
          const due = _firstFullDate(cells[1]);
          if (!eff || !due) return;
          out.push({
            uid: callYear + '|nonsenate-effective-' + eff.date,
            title: 'Non-senate actions effective ' + cells[0] + ' \u2014 files due to APO (' + callYear + ' Call)',
            date: due.date,
            detail: 'Non-Senate Academics \u00b7 all actions not delegated to deans',
            link: url, audience: audience,
          });
        }
      });
    }

    if (!out.length) throw new Error('APO parser: found the page but extracted zero deadlines — page structure may have changed.');
    return out;
  }


  /**
   * Curriculum & Scheduling page extractor (Phase 3.2 prototype-settled):
   * two tables, one parser, per-table audience suggestions.
   *   - COURSE APPROVALS (header row mentions CCI): yearless perennial
   *     dates. The DIVISION date (column 2) is the department's deadline;
   *     the Division-to-CCI date is folded into detail as context — the
   *     CCI deadline is the Division's problem, not ours (agreed call).
   *   - PROGRAM STATEMENTS (header row mentions "final deadline"):
   *     the Final Deadline column when it parses; the review period rides
   *     as detail. Rows with no/fuzzy final deadline ("Late June",
   *     release-date-only rows) are SKIPPED by design — harvest or manual
   *     entry covers them.
   *   - All candidates are PERENNIAL: uid prefix 'perennial|' (no year),
   *     next-occurrence year inference at fetch time, silent year
   *     roll-forward handled by the diff engine.
   *   - Footnote asterisks attach the page's revision note to detail.
   *   - Throws on zero candidates (parser drift must surface loudly).
   */
  function _parseCurriculumDeadlines(html, src) {
    const url = String(src.URL || '').trim();
    const pageText = _cellText(html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' '));
    const noteMatch = /Senate deadline revised[^.]*?academic year/i.exec(pageText);
    const footnote = noteMatch ? noteMatch[0].trim() : '';

    const APPROVALS_AUD  = _filterSuggestion(['super_admin', 'staff', 'staff_manager', 'department_chair', 'senate_faculty']);
    const STATEMENTS_AUD = _filterSuggestion(['super_admin', 'staff', 'department_chair', 'undergrad_director', 'grad_director']);

    const out = [];
    _parseTables(html).forEach(rows => {
      const head = rows[0].map(c => c.toLowerCase());
      const headJoined = head.join(' ');

      if (headJoined.indexOf('cci') !== -1) {
        // ── Course Approval Deadlines ──
        rows.slice(1).forEach(cells => {
          if (cells.length < 2 || !cells[0]) return;
          const div = _nextOccurrence(cells[1]);
          if (!div) return;                       // no Division date = not a deadline row
          const cci = cells.length > 2 ? _nextOccurrence(cells[2]) : null;
          const action = cells[0];
          out.push({
            uid: 'perennial|' + _slug('course-approvals ' + action).slice(0, 80) + '|' + _titleHash(action),
            title: action, date: div.date, perennial: true,
            detail: 'Course approval deadline \u00b7 due to Division in CAT'
              + (cci ? '; Division submits to CCI by ' + String(cells[2]).replace(/\*/g, '').trim() : '')
              + ((div.starred || (cci && cci.starred)) && footnote ? ' \u2014 ' + footnote : ''),
            link: url, audience: APPROVALS_AUD,
          });
        });

      } else if (headJoined.indexOf('final deadline') !== -1) {
        // ── Program Statement deadlines: locate columns by header name ──
        const iFinal  = head.findIndex(c => c.indexOf('final') !== -1);
        const iPeriod = head.findIndex(c => c.indexOf('period') !== -1 || c.indexOf('review') !== -1);
        rows.slice(1).forEach(cells => {
          if (!cells[0] || iFinal < 0 || cells.length <= iFinal) return;
          const fin = _nextOccurrence(cells[iFinal]);
          if (!fin) return;                       // fuzzy/absent final deadline: skipped by design
          const process = cells[0];
          const period = iPeriod >= 0 && cells[iPeriod] ? String(cells[iPeriod]).replace(/\*/g, '').trim() : '';
          out.push({
            uid: 'perennial|' + _slug('program-statements ' + process).slice(0, 80) + '|' + _titleHash(process),
            title: process + ' \u2014 ' + String(cells[iFinal]).replace(/\*/g, '').trim(),
            date: fin.date, perennial: true,
            detail: 'Catalog program statements' + (period ? ' \u00b7 review period: ' + period : '')
              + (fin.starred && footnote ? ' \u2014 ' + footnote : ''),
            link: url, audience: STATEMENTS_AUD,
          });
        });
      }
    });

    if (!out.length) throw new Error('Curriculum parser: extracted zero deadlines — page structure may have changed.');
    return out;
  }


  /**
   * Course Scheduling Calendar extractor (Phase 3.4, probe-settled).
   * Input is parsed CSV rows of the published sheet — a MATRIX: term
   * columns ("Fall 2026 (…)"), one process per row, an owner column
   * (Dept / Col | Reg | Both | FYI), and hand-maintained cells full of
   * ranges, estimates, typos, and TBDs. Policy (all agreed):
   *   - Header row = first row with 2+ "Season YYYY" cells.
   *   - Owner filter: Dept/Col and Both only. Reg is the Registrar's
   *     own work; FYI rows duplicate the Registrar gcal feed.
   *   - Cell dates via a tolerant scanner (named or numeric, glued
   *     weekdays tolerated, years sanity-checked 2020–2035 so typos
   *     like "7/7/260" self-discard). A range's LATEST date is the
   *     deadline (window close = actionable cutoff); the cleaned cell
   *     text rides in detail so estimated/confirmed/window context
   *     survives verbatim.
   *   - Unparseable non-empty cells skip and are COUNTED in the log;
   *     cells more than 30 days past skip silently.
   *   - uid = 'sched|<term>|slug|hash' — term-specific dated facts;
   *     estimate-to-confirmed date moves surface as changed-pendings.
   */
  function _parseCourseSchedulingSheet(rows, src) {
    const url = String(src.URL || '').trim();
    const AUD = _filterSuggestion(['super_admin', 'staff', 'department_chair', 'senate_faculty']);
    const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const termRe = /(Fall|Winter|Spring|Summer)\s+(\d{4})/i;

    // Locate the header row and its term/owner columns.
    let headerIdx = -1, termCols = [], ownerCol = -1, phaseCol = -1;
    for (let r = 0; r < Math.min(rows.length, 6); r++) {
      const cols = [];
      (rows[r] || []).forEach((cell, i) => { if (termRe.test(String(cell))) cols.push(i); });
      if (cols.length >= 2) {
        headerIdx = r;
        termCols = cols.map(i => {
          const m = termRe.exec(String(rows[r][i]));
          return { idx: i, term: m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2] };
        });
        (rows[r] || []).forEach((cell, i) => {
          const t = String(cell).toLowerCase();
          if (t.indexOf('primary work') !== -1) ownerCol = i;
          if (t.indexOf('what phase') !== -1)   phaseCol = i;
        });
        break;
      }
    }
    if (headerIdx < 0) throw new Error('Scheduling-sheet parser: no header row with term columns found — sheet structure may have changed (or the publish URL now points at a different tab).');
    if (ownerCol < 0)  throw new Error('Scheduling-sheet parser: no "Primary Work" owner column found — sheet structure may have changed.');

    const today = new Date();
    const grace = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30);
    const graceStr = Utilities.formatDate(grace, Session.getScriptTimeZone(), 'yyyy-MM-dd');

    const out = [];
    let skippedUnparseable = 0, skippedPast = 0, skippedOwner = 0;

    rows.slice(headerIdx + 1).forEach(row => {
      const title = clean(row[0]);
      if (!title) return;
      const owner = clean(row[ownerCol]).toLowerCase();
      const isDept = owner.indexOf('dept') !== -1 || owner.indexOf('both') !== -1;
      if (!isDept) { if (owner) skippedOwner++; return; }
      const phase = phaseCol >= 0 ? clean(row[phaseCol]) : '';

      termCols.forEach(tc => {
        const rawCell = clean(row[tc.idx]);
        if (!rawCell || rawCell === '--' || /^n\/?a$/i.test(rawCell)) return;
        const dates = _scanCellDates(rawCell);
        if (!dates.length) { skippedUnparseable++; return; }   // TBD, missing years, prose, typos
        const deadline = dates.sort().pop();                    // range close = the cutoff
        if (deadline < graceStr) { skippedPast++; return; }     // retires historical columns
        out.push({
          uid: 'sched|' + tc.term + '|' + _slug(title).slice(0, 60) + '|' + _titleHash(title),
          title: title + ' \u2014 ' + tc.term,
          date: deadline,
          detail: (phase && phase.toLowerCase() !== 'n/a' ? phase + ' \u00b7 ' : '')
            + 'sheet entry: ' + rawCell.slice(0, 140),
          link: url, audience: AUD,
        });
      });
    });

    Logger.log('Scheduling sheet: ' + out.length + ' candidates; skipped '
      + skippedUnparseable + ' unparseable cell(s), ' + skippedPast + ' past, '
      + skippedOwner + ' non-department row(s).');
    if (!out.length) throw new Error('Scheduling-sheet parser: extracted zero deadlines — sheet structure may have changed.');
    return out;
  }

  /** Every plausible date in a hand-maintained cell -> ['yyyy-MM-dd'].
   *  Tolerates glued weekdays ("Saturday11/1/2025") and rejects
   *  implausible years, so the sheet's typos self-discard. */
  function _scanCellDates(cell) {
    const s = String(cell || '');
    const found = [];
    const push = (y, mo, d) => {
      if (y < 2020 || y > 2035 || mo < 0 || mo > 11 || d < 1 || d > 31) return;
      const dt = new Date(y, mo, d);
      if (!isNaN(dt)) found.push(Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd'));
    };
    const MONTHS3 = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
                      jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    let m;
    const named = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2}),?\s*(\d{4})/gi;
    while ((m = named.exec(s)) !== null) push(Number(m[3]), MONTHS3[m[1].toLowerCase()], Number(m[2]));
    const numeric = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
    while ((m = numeric.exec(s)) !== null) {
      let y = Number(m[3]); if (y >= 20 && y < 100) y += 2000;
      push(y, Number(m[1]) - 1, Number(m[2]));
    }
    return found;
  }

  /**
   * Survey tool for the future gsheet extractor (Phase 3.3): given a
   * page that EMBEDS a published Google Sheet, finds the pubhtml URL,
   * derives its CSV export, fetches it, and returns dimensions plus a
   * sample — the structural facts the matrix-pivot design needs.
   * Read-only; touches no data.
   */
  function probePublishedSheetCsv(pageUrl) {
    const page = _fetchWithRetry(String(pageUrl || '').trim());
    const m = /https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/([A-Za-z0-9_-]+)\/pubhtml/.exec(page);
    if (!m) throw new Error('No embedded published Google Sheet found on that page.');
    const csvUrl = 'https://docs.google.com/spreadsheets/d/e/' + m[1] + '/pub?output=csv';
    const rows = Utilities.parseCsv(_fetchWithRetry(csvUrl));
    return {
      csvUrl: csvUrl,
      rowCount: rows.length,
      colCount: rows.length ? rows[0].length : 0,
      sample: rows.slice(0, 30).map(r => r.map(c => String(c).slice(0, 40)).join(' | ').slice(0, 300)),
      note: 'CSV export returns the FIRST tab only; other tabs need a gid parameter (survey step two if needed).',
    };
  }

  /** Diagnostic face for the editor test function: fetch a URL and run a
   *  parser against it WITHOUT touching sources, pendings, or deadlines. */
  function testParse(url, parserKey) {
    const parser = PARSERS[String(parserKey || '').trim()];
    if (!parser) throw new Error('Unknown parser: ' + parserKey + '. Available: ' + Object.keys(PARSERS).join(', '));
    const fakeSrc = { URL: url };
    const raw = _fetchHtml(fakeSrc);
    const candidates = parser.fn(parser.content === 'csv' ? Utilities.parseCsv(raw) : raw, fakeSrc);
    return { url: url, parserKey: parserKey, count: candidates.length, candidates: candidates };
  }

  // ── Paste-a-URL harvest (generic date sweep) ───────────────

  const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6,
                   aug:7, sep:8, oct:9, nov:10, dec:11 };

  /**
   * Best-effort date harvest from any server-rendered page. Returns
   * candidates {date, title, context} for the reviewer to curate —
   * wrongness is harmless because a human confirms every row. Dates in
   * the past (beyond 30 days) are dropped.
   */
  function harvestPreview(url) {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) throw new Error('Enter a full URL starting with http:// or https://');
    const html = _fetchWithRetry(u);

    const textOnly = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'")
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&ndash;|&mdash;/g, '-')
      .replace(/\s+/g, ' ');

    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    const out = [];
    const seen = {};

    const push = (y, mo, d, idx, matchLen) => {
      const dt = new Date(y, mo, d);
      if (isNaN(dt) || dt < cutoff || out.length >= 80) return;
      const ds = Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      const before = textOnly.slice(Math.max(0, idx - 110), idx).trim();
      const after  = textOnly.slice(idx + matchLen, idx + matchLen + 60).trim();
      const context = (before + ' [' + textOnly.substr(idx, matchLen) + '] ' + after).trim();
      const title = (before.split(/[.!?•|]/).pop() || '').trim().slice(-90) || 'Untitled deadline';
      const k = ds + '|' + title.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push({ date: ds, title: title, context: context.slice(0, 240) });
    };

    const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:\s*[-\u2013\u2014]\s*\d{1,2})?,?\s+(\d{4})\b/gi;
    let m;
    while ((m = named.exec(textOnly)) !== null) {
      push(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]), m.index, m[0].length);
    }
    const numeric = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
    while ((m = numeric.exec(textOnly)) !== null) {
      let y = Number(m[3]); if (y < 100) y += 2000;
      push(y, Number(m[1]) - 1, Number(m[2]), m.index, m[0].length);
    }

    return { url: u, candidates: out };
  }

  /**
   * Commits curated harvest candidates as Origin='harvested' deadlines
   * (no UID, never refreshed; provenance kept in Link/Source). The
   * duplicate guard skips (title, date) twins.
   * items: [{title, date, description, link, audienceRoles}]
   */
  function createHarvested(items, url) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) throw new Error('Nothing selected.');
    let host = '';
    try { host = String(url || '').replace(/^https?:\/\//i, '').split('/')[0]; } catch (e) {}

    const dupKeys = {};
    DataService.getAll(SHEET(), DEADLINES_TAB()).forEach(r => {
      if (String(r.Status || 'active').toLowerCase() === 'removed') return;
      dupKeys[_dupKey(r.Title, r.Date)] = true;
    });

    const created = [];
    const skipped = [];
    list.forEach(item => {
      item = item || {};
      const title = String(item.title || '').trim();
      const date  = _dateOnly(item.date);
      if (!title || !date) { skipped.push({ title: title, date: String(item.date || ''), reason: 'Missing title or date' }); return; }
      const k = _dupKey(title, date);
      if (dupKeys[k]) { skipped.push({ title: title, date: date, reason: 'Already on the calendar' }); return; }
      DataService.insert(SHEET(), DEADLINES_TAB(), {
        DeadlineID: DataService.generateId('DL'),
        Title: title, Description: String(item.description || '').trim(), Date: date,
        AudienceRoles: _splitRoles((item.audienceRoles || []).join(',')).join(', '),
        Source: host, Link: String(item.link || url || '').trim(),
        Origin: 'harvested', SourceKey: '', ExternalUID: '',
        Perennial: 'FALSE', Pinned: 'FALSE', Status: 'active', LastSeenAt: '',
      });
      dupKeys[k] = true;
      created.push({ title: title, date: date });
    });
    return { created: created, skipped: skipped };
  }


  function _isImported(row) { return String(row.Origin || '').trim().toLowerCase() === 'imported'; }
  function _isPinned(row)   { return String(row.Pinned).toUpperCase() === 'TRUE'; }


  return {
    // permissions
    managerRoles, setManagerRoles, canManage,
    // viewing face
    listRange,
    // deadlines
    listAllDeadlines, createDeadlines, updateDeadline, deleteDeadline, duplicateDeadline,
    // Phase 2: sources + refresh
    listSources, saveSource, deleteSource, refreshSource, nightlyRefreshAll,
    // Phase 2: pending review
    listPending, commitPending, dismissPending,
    // Phase 2: harvest
    harvestPreview, createHarvested,
    // Phase 3: dedicated extractors
    listParsers, testParse, probePublishedSheetCsv,
    // Phase 3.5: read-only face for other modules (Personnel scheduler)
    findDeadlines, getDeadlineById, listClosures,
  };

})();


// ============================================================
// Run-once verification (Phase 3): fetches the LIVE APO Call
// Calendar page from this environment — the raw bytes UrlFetchApp
// actually receives — runs the extractor, and logs every candidate.
// Read the log; if titles/dates/audiences look right, wire the
// source in the Imports tab. Touches no data. Delete-safe to keep.
// ============================================================
function testApoExtractor() {
  const result = CalendarService.testParse(
    'https://academicpersonnel.ucsc.edu/academic-advancement/campus-call-information/call-calendar/',
    'apo_call_calendar');
  Logger.log('Extracted ' + result.count + ' candidates:');
  result.candidates.forEach(c => {
    Logger.log(c.date + '  ' + c.title + '\n    detail: ' + c.detail
      + '\n    audience: ' + (c.audience || []).join(', ') + '\n    uid: ' + c.uid);
  });
}


// ============================================================
// Run-once verification (Phase 3.4): fetches the LIVE scheduling
// sheet's CSV (Google-to-Google — no campus hop, no roulette), runs
// the course_scheduling_sheet extractor, and logs every candidate
// plus the skip counters. When wiring the source, use THIS CSV URL
// as the source's URL, type gsheet, parser course_scheduling_sheet.
// ============================================================
function testSchedulingExtractor() {
  const result = CalendarService.testParse(
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vTkqbOggxbEONYsEpEdM3UGGpK7_E5FPFC30y27eDI7mkfWz42g1VEFU8Q1npD0H0EdtUFQQq3rB6mX/pub?output=csv',
    'course_scheduling_sheet');
  Logger.log('Extracted ' + result.count + ' candidates:');
  result.candidates.forEach(c => {
    Logger.log(c.date + '  ' + c.title
      + '\n    detail: ' + c.detail
      + '\n    audience: ' + (c.audience || []).join(', ') + '\n    uid: ' + c.uid);
  });
}


// ============================================================
// Survey (Phase 3.3): logs the structure of the Course Scheduling
// Calendar's published sheet — dimensions and the first 30 rows —
// which is the raw material for designing the gsheet extractor.
// Run it, paste the log into the design conversation. Touches no data.
// ============================================================
function probeSchedulingSheet() {
  const r = CalendarService.probePublishedSheetCsv(
    'https://registrar.ucsc.edu/calendars-resources/academic-calendar/curriculum-scheduling-calendars/');
  Logger.log('CSV: ' + r.csvUrl);
  Logger.log('Dimensions: ' + r.rowCount + ' rows x ' + r.colCount + ' cols. ' + r.note);
  r.sample.forEach((line, i) => Logger.log((i + 1) + ': ' + line));
}


// ============================================================
// Run-once verification (Phase 3.2): fetches the LIVE Curriculum &
// Scheduling page, runs the curriculum_deadlines extractor, and logs
// every candidate. Expect ~12: seven course-approval rows (Division
// dates, CCI context in detail) and ~five program-statement rows;
// "Late June" and release-only rows are absent by design. Touches no
// data. Transport roulette applies — re-run on "Address unavailable".
// ============================================================
function testCurriculumExtractor() {
  const result = CalendarService.testParse(
    'https://registrar.ucsc.edu/calendars-resources/academic-calendar/curriculum-scheduling-calendars/',
    'curriculum_deadlines');
  Logger.log('Extracted ' + result.count + ' candidates:');
  result.candidates.forEach(c => {
    Logger.log(c.date + (c.perennial ? ' [annual]' : '') + '  ' + c.title
      + '\n    detail: ' + c.detail
      + '\n    audience: ' + (c.audience || []).join(', ') + '\n    uid: ' + c.uid);
  });
}