// ============================================================
// PersonnelModule.gs — Academic Personnel (departmental process)
// ============================================================
// Phase 0 + 1 ONLY: module skeleton + the profile-extension layer
// and rank/step/series ingestion. Cases, components, the calculator,
// designations, and the ballot are LATER phases and are intentionally
// absent here.
//
// Conventions (see README "module development"):
//   - This handler is an IIFE returning a (payload, user, roles) action
//     map. Only the names in the final `return {...}` are dispatchable.
//   - All sheet I/O goes through DataService (read/write by header name).
//   - Identity is read from Auth / matched via PersonMatch. This module
//     NEVER stores its own copy of a person's name or ID — it stores only
//     personnel-specific ATTRIBUTES (rank, step, series) keyed by email.
//   - Privileged actions check roles and ALWAYS allow super_admin.
//
// Storage (this module's own spreadsheet, CONFIG.SHEETS.PERSONNEL):
//   PersonAttributes — tall, namespaced person-attribute table. One row
//     per (Email, Namespace, Key). The hybrid model: core identity stays
//     wide in Auth; module-specific extensions live here. A future
//     platform-wide profile module can absorb these rows later.
//
// Registration: add 'personnel' to the Modules sheet (Admin -> Modules)
//   and add 'PersonnelModule' to BOTH getModuleHandler() and
//   getRegisteredHandlers() in Code.gs — but ONLY once this file is in
//   the project, or you get "PersonnelModule is not defined".
// ============================================================

const PersonnelModule = (() => {

  // ── Tab manifest (TabRegistry) ─────────────────────────────
  // Declares this module's tabs for the platform's per-role visibility
  // system (Admin → Modules → Tabs). Keys/labels/icons mirror the UI's
  // showTab views. DEFAULTS mirror the server-side gates: nearly every
  // action in this module is _requireSuperAdmin, so every tab except
  // Roster defaults to super_admin only (roles: []); Roster's reads
  // (listRoster, listRanks, getReviewHistory) are unguarded, so it
  // defaults to ['*'] — anyone the module itself admits. Widen a tab's
  // roles in the Tabs editor if the module ever admits non-admins who
  // should see more.
  // NOTE (Phase 1): `actions` and `floor` are declarative until the
  // dispatch gateway lands — a visible tab does NOT grant actions; the
  // in-module checks (_requireSuperAdmin, assignee checks) remain the
  // authority. Unlisted programmatic actions: ping, getAttributes,
  // getPersonSummary, computeCaseSchedule, listCycles.
  const TABS = [
    { key: 'roster', label: 'Roster', icon: 'ti-users', roles: ['*'],
      actions: ['listRoster', 'getReviewHistory', 'listRanks', 'updatePersonAttributes'] },
    { key: 'import', label: 'Import rank & step', icon: 'ti-file-upload',
      roles: [], floor: 'super_admin',
      actions: ['detectColumns', 'previewRankImport', 'commitRankImport',
                'detectHistoryColumns', 'previewHistoryImport', 'commitHistoryImport'] },
    { key: 'cases', label: 'Cases', icon: 'ti-clipboard-list',
      roles: [], floor: 'super_admin',
      actions: ['listCases', 'listReviewTypes', 'updateCase', 'createCase',
                'checkCaseEligibility', 'detectCallColumns', 'previewCallImport',
                'commitCallImport', 'computeScheduleForCase', 'listCaseComponents',
                'listCommitteeMembers', 'assignComponent', 'markComponentDrafted',
                'reopenComponent', 'committeeWorkload', 'exportWorkloadToSheet',
                'caseAssignments'] },
    { key: 'anticipated', label: 'Anticipated Call', icon: 'ti-crystal-ball',
      roles: [], floor: 'super_admin',
      actions: ['listAnticipatedCandidates', 'exportAnticipatedToSheet',
                'exportAnticipatedToCsv'] },
    { key: 'comms', label: 'Communications', icon: 'ti-mail',
      roles: [], floor: 'super_admin',
      actions: ['getCommTemplates', 'saveCommTemplate', 'previewCommunication',
                'sendCommunications', 'draftCommunications', 'logCopiedCommunication',
                'listCommunicationsLog', 'listPolicyDocs', 'savePolicyDocs'] },
    { key: 'settings', label: 'Calendar', icon: 'ti-calendar-cog',
      roles: [], floor: 'super_admin',
      actions: ['getSchedulerSettings', 'saveSchedulerSettings', 'getCycle',
                'setCycleAnchors', 'findCalendarDeadlines', 'computeCycleSchedule',
                'proposeDate', 'exportCycleScheduleToSheet'] },
  ];

  // ── Module-local config accessors ──────────────────────────
  // Resolved lazily so a missing CONFIG block fails loudly at call time
  // (not at file-load), matching how other modules read their config.

  function SHEET()        { return CONFIG.SHEETS.PERSONNEL; }
  function ATTR_TAB()     { return CONFIG.TABS.PERSON_ATTRIBUTES; }
  function NS()           { return 'personnel'; }
  function EMAIL_DOMAIN() { return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.EMAIL_DOMAIN) || 'ucsc.edu'; }

  // rank -> { tier, series }. Tier drives Bylaw 55 voting eligibility
  // (a LATER phase); series drives the component template (a LATER phase).
  // Stored in CONFIG so a new title is one config edit, never a code change.
  function RANK_MAP()     { return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.RANK_MAP) || {}; }

  // The attribute keys this phase manages, in the personnel namespace.
  const KEY_RANK     = 'rank';
  const KEY_STEP     = 'step';
  const KEY_SERIES   = 'series';    // derived from rank
  const KEY_TIER     = 'tier';      // derived from rank; stored for convenience
  const KEY_YRS_RANK = 'yrs_rank';  // raw imported: years at current rank
  const KEY_YRS_STEP = 'yrs_step';  // raw imported: years at current step
  const KEY_SALARY   = 'salary';    // current annual salary (editable)


  // ============================================================
  // Phase 0 — skeleton / health
  // ============================================================

  /**
   * Trivial reachability check so the module can be wired and opened
   * before any real feature exists. Returns identity + whether the
   * caller is a super_admin, with no side effects.
   */
  function ping(payload, user, roles) {
    return {
      ok: true,
      module: 'personnel',
      user: user,
      isSuperAdmin: roles.indexOf('super_admin') !== -1,
      phase: '0+1',
    };
  }


  // ============================================================
  // Phase 1 — profile-extension reads
  // ============================================================

  /**
   * Returns the personnel-namespace attributes for one person, folded
   * into a plain object: { rank, step, series, tier }. Missing keys are
   * simply absent. Reads the tall table and collapses the rows.
   *
   * @param {Object} payload - { email }
   */
  function getAttributes(payload, user, roles) {
    const email = _email(payload && payload.email);
    if (!email) throw new Error('email is required.');
    return _readAttrs(email);
  }

  /**
   * Returns { email, name, rank, step, series, tier } for one person,
   * joining Auth identity (name) with personnel attributes. Read-only
   * convenience for UI/preview. Name/ID always come from Auth, never
   * from this module's storage.
   *
   * @param {Object} payload - { email }
   */
  function getPersonSummary(payload, user, roles) {
    const email = _email(payload && payload.email);
    if (!email) throw new Error('email is required.');
    const profile = Auth.getProfile(email);
    if (!profile) throw new Error('No profile for ' + email + ' (create it via batch import first).');
    const attrs = _readAttrs(email);
    return {
      email:  profile.email,
      name:   profile.name || (profile.firstName + ' ' + profile.lastName),
      nameLastFirst: profile.nameLastFirst || '',
      rank:   attrs.rank   || '',
      step:   attrs.step   || '',
      series: attrs.series || '',
      tier:   attrs.tier   || '',
      yrsRank: attrs.yrs_rank || '',
      yrsStep: attrs.yrs_step || '',
      salary:  attrs.salary   || '',
    };
  }


  /**
   * Returns the personnel roster: one entry per person who has any
   * personnel-namespace attribute loaded, folded to
   *   { email, name, nameLastFirst, rank, step, series, tier, ...,
   *     active, updatedAt, updatedBy }
   * sorted by nameLastFirst.
   *
   * ACTIVE FILTERING: departed faculty are marked Active=FALSE in their
   * platform profile (User Management). By default they are EXCLUDED — they
   * should not appear in the roster, the anticipated Call, or any
   * forward-looking view. Their attributes and review history are RETAINED
   * (historical record), and `includeInactive` surfaces them when needed.
   * A person whose profile no longer exists at all is flagged noProfile.
   *
   * @param {Object} payload - { includeInactive? }
   */
  function listRoster(payload, user, roles) {
    const includeInactive = !!(payload && payload.includeInactive);
    const all = DataService.getAll(SHEET(), ATTR_TAB())
      .filter(r => String(r.Namespace) === NS());

    const byEmail = {};
    all.forEach(r => {
      const email = _email(r.Email);
      if (!email) return;
      if (!byEmail[email]) byEmail[email] = { attrs: {}, updatedAt: null, updatedBy: '' };
      byEmail[email].attrs[String(r.Key)] = r.Value;
      const ts = r.UpdatedAt || r.CreatedAt || null;
      if (ts && (!byEmail[email].updatedAt || ts > byEmail[email].updatedAt)) {
        byEmail[email].updatedAt = ts;
        byEmail[email].updatedBy = r.UpdatedBy || r.CreatedBy || '';
      }
    });

    const roster = [];
    let inactiveCount = 0;
    Object.keys(byEmail).forEach(email => {
      const a = byEmail[email].attrs;
      const profile = Auth.getProfile(email);
      const noProfile = !profile;
      // Auth returns active as a boolean (Active !== 'FALSE'). No profile at
      // all is treated as inactive for filtering purposes.
      const active = profile ? profile.active !== false : false;
      if (!active) inactiveCount++;
      if (!active && !includeInactive) return;
      roster.push({
        email:         email,
        name:          profile ? (profile.name || (profile.firstName + ' ' + profile.lastName)) : email,
        nameLastFirst: profile ? (profile.nameLastFirst || '') : email,
        noProfile:     noProfile,
        active:        active,
        rank:          a.rank   || '',
        step:          a.step   || '',
        series:        a.series || '',
        tier:          a.tier   || '',
        yrsRank:       a.yrs_rank || '',
        yrsStep:       a.yrs_step || '',
        salary:        a.salary   || '',
        updatedAt:     byEmail[email].updatedAt ? _isoDate(byEmail[email].updatedAt) : '',
        updatedBy:     byEmail[email].updatedBy || '',
      });
    });

    roster.sort((x, y) =>
      String(x.nameLastFirst || x.email).localeCompare(String(y.nameLastFirst || y.email)));

    return { roster: roster, count: roster.length, inactiveCount: inactiveCount };
  }


  /**
   * Returns the list of editable ranks (the RANK_MAP titles) for the edit
   * form's rank dropdown, each with its derived series/tier so the UI can
   * show the consequence live. Sorted for a stable menu.
   * @returns [ { rank, series, tier } ]
   */
  function listRanks(payload, user, roles) {
    const map = RANK_MAP();
    return Object.keys(map).map(rank => ({
      rank:   rank,
      series: map[rank].series || '',
      tier:   map[rank].tier   || '',
    }));
  }

  /**
   * Edit a person's rank/step/years/salary. Rank must be one of the mapped
   * titles; series and tier are RE-DERIVED from it (never set directly), so
   * the derived-attribute invariant holds. Years and salary are raw values.
   * Writes via the same supersede path as import. super_admin only.
   *
   * @param {Object} payload - {
   *     email, rank, step, yrsRank?, yrsStep?, salary?, note?
   *   }
   *   Any field left undefined is not written (existing value preserved);
   *   an explicitly empty string CLEARS that raw field. rank/step are
   *   required (rank drives the derivation).
   * @returns { email, rank, step, series, tier, yrsRank, yrsStep, salary }
   */
  function updatePersonAttributes(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const email = _email(p.email);
    if (!email) throw new Error('email is required.');

    const profile = Auth.getProfile(email);
    if (!profile) throw new Error('No profile for ' + email + '.');

    const rank = String(p.rank || '').trim();
    if (!rank) throw new Error('Rank is required.');
    const mapped = _mapRank(rank);
    if (!mapped) throw new Error('Unrecognized rank: "' + rank + '". Pick a listed rank.');

    const step = String(p.step == null ? '' : p.step).trim();
    if (!step) throw new Error('Step is required.');

    // Write rank + derived series/tier + step (always).
    _setAttr(email, KEY_RANK,   mapped.rank);
    _setAttr(email, KEY_STEP,   step);
    _setAttr(email, KEY_SERIES, mapped.series);
    // Tier may legitimately be '' (lecturers) — clear it in that case.
    _setAttr(email, KEY_TIER,   mapped.tier || '');

    // Raw optional fields: write when the caller supplied the key at all
    // (including '' to clear); skip when undefined (preserve existing).
    if (p.yrsRank !== undefined) _setAttr(email, KEY_YRS_RANK, String(p.yrsRank).trim());
    if (p.yrsStep !== undefined) _setAttr(email, KEY_YRS_STEP, String(p.yrsStep).trim());
    if (p.salary  !== undefined) _setAttr(email, KEY_SALARY,   _parseSalary(p.salary));

    const attrs = _readAttrs(email);
    return {
      email:   email,
      rank:    attrs.rank    || '',
      step:    attrs.step    || '',
      series:  attrs.series  || '',
      tier:    attrs.tier    || '',
      yrsRank: attrs.yrs_rank || '',
      yrsStep: attrs.yrs_step || '',
      salary:  attrs.salary   || '',
    };
  }



  // ============================================================
  // Mirrors BatchImport: the client sends raw CSV text; the server
  // parses it, auto-detects which column is which, and the UI confirms
  // the mapping before preview/commit.

  // Header variants for auto-detection (lowercased, trimmed). The standard
  // export headers (Cruzid, First Name, Last Name, Working Title, Step) all
  // match here, so the mapping auto-selects; the user can override any field.
  const COLUMN_HINTS = {
    cruzid:  ['cruzid', 'cruz id', 'username', 'user name', 'email', 'e-mail', 'campus email'],
    first:   ['first name', 'firstname', 'first', 'given name', 'given'],
    last:    ['last name', 'lastname', 'last', 'surname', 'family name'],
    rank:    ['working title', 'title', 'rank'],
    step:    ['step'],
    yrsRank: ['yrs rank', 'years at rank', 'years rank', 'yrs at rank', 'time at rank'],
    yrsStep: ['yrs step', 'years at step', 'years step', 'yrs at step', 'time at step'],
    salary:  ['salary', 'annual salary', 'base salary', 'current salary'],
  };

  /**
   * Parse the CSV header row and guess which column maps to each field.
   * @param {Object} p - { csv }
   * @returns { headers: [...], mapping: {cruzid,first,last,rank,step}, rowCount }
   *   mapping values are header names (or '' if not detected).
   */
  function detectColumns(p, user, roles) {
    _requireSuperAdmin(roles);
    const parsed = _parseCsv((p && p.csv) || '');
    if (!parsed.rows.length) throw new Error('No data rows found in the file.');

    const headers = parsed.headers;
    const mapping = {};
    Object.keys(COLUMN_HINTS).forEach(field => {
      mapping[field] = _guessHeader(headers, COLUMN_HINTS[field]);
    });
    return { headers: headers, mapping: mapping, rowCount: parsed.rows.length };
  }

  /**
   * Pick the first header whose normalized form matches any hint, or whose
   * normalized form CONTAINS the hint word. Returns the original header
   * spelling (so it round-trips through the mapping), or '' if none.
   */
  function _guessHeader(headers, hints) {
    const norm = s => String(s || '').trim().toLowerCase();
    // Exact normalized match first
    for (const h of headers) {
      if (hints.indexOf(norm(h)) !== -1) return h;
    }
    // Then a contains match (e.g. header "Preferred First Name" contains "first")
    for (const h of headers) {
      const nh = norm(h);
      if (hints.some(hint => nh.indexOf(hint) !== -1)) return h;
    }
    return '';
  }

  /**
   * Parse CSV text into { headers: [...], rows: [ {lowercasedHeader: value} ] }.
   * Handles quoted fields containing commas and escaped quotes (""), which
   * the salary export uses (e.g. "Hernandez Garavito"). Does NOT handle
   * newlines embedded inside quoted fields (the report has none). Blank
   * lines are skipped. Row keys are LOWERCASED headers so cell() lookups
   * are case-insensitive.
   */
  function _parseCsv(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const nonEmpty = lines.filter(l => l.trim() !== '');
    if (!nonEmpty.length) return { headers: [], rows: [] };

    // Detect the delimiter: if the header line contains a tab, treat the
    // data as tab-separated (a paste straight from a spreadsheet); otherwise
    // comma-separated (a CSV file or CSV text). One delimiter for the whole
    // parse, decided from the header row.
    const delim = nonEmpty[0].indexOf('\t') !== -1 ? '\t' : ',';

    const headers = _parseCsvLine(nonEmpty[0], delim).map(h => String(h).trim());
    const lowerHeaders = headers.map(h => h.toLowerCase());
    const rows = [];
    for (let i = 1; i < nonEmpty.length; i++) {
      const cells = _parseCsvLine(nonEmpty[i], delim);
      const row = {};
      lowerHeaders.forEach((h, c) => { row[h] = c < cells.length ? cells[c] : ''; });
      rows.push(row);
    }
    return { headers: headers, rows: rows };
  }

  /**
   * Split one line into fields on the given delimiter (',' or '\t'), honoring
   * double-quoted fields (which may contain the delimiter) and the "" escape
   * for a literal quote. Tab-separated pastes rarely use quotes, but handling
   * them is harmless and keeps one code path.
   */
  function _parseCsvLine(line, delim) {
    const d = delim || ',';
    const out = [];
    let field = '';
    let inQuotes = false;
    const s = String(line);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }   // escaped quote
          else { inQuotes = false; }
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') { inQuotes = true; }
        else if (ch === d) { out.push(field); field = ''; }
        else { field += ch; }
      }
    }
    out.push(field);
    return out.map(f => f.trim());
  }

  /**
   * Resolve a payload to parsed rows. Accepts { csv } (parsed here) or, for
   * backward compatibility with the smoke test, { rows } already parsed.
   */
  function _rowsFromPayload(payload) {
    const p = payload || {};
    if (Array.isArray(p.rows)) return p.rows;
    if (typeof p.csv === 'string') return _parseCsv(p.csv).rows;
    return [];
  }


  // ============================================================
  // Phase 1 — rank/step/series ingestion (preview, then commit)
  // ============================================================
  // Mirrors BatchImport's preview/commit discipline: resolve each row
  // to an existing person via PersonMatch, skip-with-reason on no-match
  // or conflict, and only WRITE on commit. This importer does NOT create
  // profiles — people must already exist (via batch import). An unmatched
  // row is reported, never silently created.

  /**
   * Dry-run: parse the uploaded CSV, evaluate each row against existing
   * profiles, and return a per-row plan (set | skip) without writing.
   *
   * @param {Object} payload - {
   *     csv: '<raw CSV text>',
   *     mapping: { cruzid, first, last, rank, step },
   *     source?: string
   *   }
   *
   * The rank/step report identifies people by CRUZID, which the importer
   * expands to "<cruzid>@ucsc.edu" and matches on email (the Cruzid column
   * may already contain a full @ucsc.edu email — handled either way). The
   * report's columns are: First Name, Last Name, Cruzid, Working Title,
   * Yrs Rank, Step, Yrs Step, Salary — so a typical mapping is
   *   { cruzid: 'Cruzid', first: 'First Name', last: 'Last Name',
   *     rank: 'Working Title', step: 'Step' }.
   * (Salary / Yrs Rank / Yrs Step are present but NOT stored as attributes
   * in this phase — current salary is entered per-case at calculation time.)
   * @returns { summary, willSet[], skipped[] }
   */
  function previewRankImport(payload, user, roles) {
    _requireSuperAdmin(roles);
    const rows = _rowsFromPayload(payload);
    const plan = _evaluateRankRows({ rows: rows, mapping: (payload || {}).mapping });
    return {
      summary: { willSet: plan.willSet.length, skipped: plan.skipped.length },
      willSet: plan.willSet,
      skipped: plan.skipped,
    };
  }

  /**
   * Commit: same evaluation as preview, but writes the resolved
   * rank/step/series/tier attributes for each matched row. Re-uses the
   * tall table's (Email, Namespace, Key) identity so a re-import
   * SUPERSEDES the prior value rather than duplicating it.
   *
   * @param {Object} payload - same shape as previewRankImport ({ csv, mapping })
   * @returns { summary, set[], skipped[] }
   */
  function commitRankImport(payload, user, roles) {
    _requireSuperAdmin(roles);
    const rows = _rowsFromPayload(payload);
    const plan = _evaluateRankRows({ rows: rows, mapping: (payload || {}).mapping });
    const set = [];
    const skipped = plan.skipped.slice();

    plan.willSet.forEach(item => {
      try {
        _setAttr(item.email, KEY_RANK,   item.rank);
        _setAttr(item.email, KEY_STEP,   item.step);
        if (item.series) _setAttr(item.email, KEY_SERIES, item.series);
        if (item.tier)   _setAttr(item.email, KEY_TIER,   item.tier);
        // Optional raw fields — write only when present, so a report missing
        // one of these columns doesn't blank an existing value.
        if (item.yrsRank !== '') _setAttr(item.email, KEY_YRS_RANK, item.yrsRank);
        if (item.yrsStep !== '') _setAttr(item.email, KEY_YRS_STEP, item.yrsStep);
        if (item.salary  !== '') _setAttr(item.email, KEY_SALARY,   item.salary);
        set.push(item);
      } catch (err) {
        item.action = 'skip';
        item.reason = 'Write failed: ' + err.message;
        skipped.push(item);
      }
    });

    return {
      summary: { set: set.length, skipped: skipped.length },
      set: set,
      skipped: skipped,
    };
  }


  // ── Row evaluation (shared by preview + commit) ────────────

  /**
   * Evaluate each uploaded row: map cells, resolve identity, derive
   * series/tier from rank, and decide set-or-skip. Read-only — no writes.
   */
  function _evaluateRankRows(payload) {
    const p       = payload || {};
    const rows    = Array.isArray(p.rows) ? p.rows : [];
    const mapping = p.mapping || {};
    const willSet = [];
    const skipped = [];

    const cell = (row, headerName) => {
      if (!headerName) return '';
      const key = String(headerName).trim().toLowerCase();
      return row.hasOwnProperty(key) ? String(row[key] || '').trim() : '';
    };

    rows.forEach((row, i) => {
      const lineNo = i + 1;
      const cruzidRaw = cell(row, mapping.cruzid);
      const rec = {
        email:   _cruzidToEmail(cruzidRaw),
        cruzid:  cruzidRaw,
        last:    cell(row, mapping.last),
        first:   cell(row, mapping.first),
        rankRaw: cell(row, mapping.rank),
        step:    cell(row, mapping.step),
        yrsRank: cell(row, mapping.yrsRank),
        yrsStep: cell(row, mapping.yrsStep),
        salary:  _parseSalary(cell(row, mapping.salary)),
      };
      const out = { line: lineNo, cruzid: rec.cruzid, email: rec.email,
                    rankRaw: rec.rankRaw, step: rec.step };

      // Need a CruzID (→ email) to resolve the person.
      if (!rec.email) {
        return _skip(skipped, out, 'No CruzID (cannot resolve the person)');
      }
      if (!rec.rankRaw) {
        return _skip(skipped, out, 'Missing rank (Working Title)');
      }

      // Map the raw rank title to a canonical rank + derived series/tier.
      const mapped = _mapRank(rec.rankRaw);
      if (!mapped) {
        return _skip(skipped, out, 'Unrecognized rank title: "' + rec.rankRaw + '"');
      }

      // Resolve to an existing profile by email (CruzID-derived).
      const rr = PersonMatch.resolve({
        email: rec.email,
        first: rec.first,
        last:  rec.last,
      });

      if (rr.status !== 'matched') {
        return _skip(skipped, out,
          'No matching profile (create the person via batch import first)');
      }
      if (rr.conflicts && rr.conflicts.length) {
        const what = rr.conflicts
          .map(c => c.field + ': stored "' + c.oldValue + '" vs row "' + c.newValue + '"')
          .join('; ');
        return _skip(skipped, out, 'Identity conflict — ' + what);
      }

      out.action = 'set';
      out.email  = rr.profile.email;          // canonical email from the profile
      out.name   = rr.profile.name || (rr.profile.firstName + ' ' + rr.profile.lastName);
      out.matchedBy = rr.matchedBy;
      out.rank    = mapped.rank;
      out.series  = mapped.series;
      out.tier    = mapped.tier;
      out.step    = rec.step;
      out.yrsRank = rec.yrsRank;
      out.yrsStep = rec.yrsStep;
      out.salary  = rec.salary;
      willSet.push(out);
    });

    return { willSet: willSet, skipped: skipped };
  }

  /**
   * Map a raw rank string (as it appears in the report) to a canonical
   * rank plus its derived series and voting tier, using CONFIG.PERSONNEL.RANK_MAP.
   * The map is keyed by the EXACT title; we also try a trimmed/cased match.
   * Returns null if unrecognized (caller skips with reason).
   */
  function _mapRank(rawRank) {
    const map = RANK_MAP();
    const raw = String(rawRank || '').trim();
    if (!raw) return null;

    // Exact key, then case-insensitive scan.
    if (map[raw]) return _rankEntry(raw, map[raw]);
    const lower = raw.toLowerCase();
    const hit = Object.keys(map).find(k => k.toLowerCase() === lower);
    return hit ? _rankEntry(hit, map[hit]) : null;
  }

  function _rankEntry(canonRank, entry) {
    return {
      rank:   canonRank,
      series: entry.series || '',
      tier:   entry.tier   || '',
    };
  }


  // ============================================================
  // Attribute storage helpers (tall table, via DataService)
  // ============================================================

  /**
   * Read all personnel-namespace attributes for an email and collapse
   * the tall rows into { rank, step, series, tier, ... }.
   */
  function _readAttrs(email) {
    const e = _email(email);
    const rows = DataService.query(SHEET(), ATTR_TAB(), 'Email', e)
      .filter(r => String(r.Namespace) === NS());
    const out = {};
    rows.forEach(r => { out[String(r.Key)] = r.Value; });
    return out;
  }

  /**
   * Set (insert or supersede) one attribute for a person. A row's identity
   * is (Email, Namespace, Key). If a row exists for that triple we UPDATE
   * its Value in place (keyed by the row's unique AttrID, so we never touch
   * a sibling attribute of the same person); otherwise we INSERT. The table
   * stays single-valued per key — the current value — which is all Bylaw 55
   * and the calculator need.
   *
   * Update-in-place (rather than remove+insert) preserves the row's
   * CreatedAt/CreatedBy and lets DataService stamp UpdatedAt/UpdatedBy,
   * giving a light audit trail of when an attribute last changed.
   */
  function _setAttr(email, key, value) {
    const e = _email(email);
    const matches = DataService.query(SHEET(), ATTR_TAB(), 'Email', e)
      .filter(r => String(r.Namespace) === NS() && String(r.Key) === key);

    if (matches.length) {
      // Update the canonical row by its unique AttrID. Any accidental
      // duplicate rows for the same triple are removed so the table
      // converges to one row per (Email, Namespace, Key).
      const keep = matches[0];
      if (!keep.AttrID) {
        throw new Error('PersonAttributes row is missing AttrID; cannot safely supersede.');
      }
      DataService.update(SHEET(), ATTR_TAB(), 'AttrID', keep.AttrID,
        { Value: value, EffectiveDate: new Date() });

      for (let i = 1; i < matches.length; i++) {
        if (matches[i].AttrID) {
          DataService.remove(SHEET(), ATTR_TAB(), 'AttrID', matches[i].AttrID);
        }
      }
      return;
    }

    DataService.insert(SHEET(), ATTR_TAB(), {
      AttrID:        DataService.generateId('PA'),
      Email:         e,
      Namespace:     NS(),
      Key:           key,
      Value:         value,
      EffectiveDate: new Date(),
    });
  }


  // ── Small utilities ────────────────────────────────────────

  function _email(v) { return String(v || '').trim().toLowerCase(); }

  /**
   * Parse a salary cell ("192900.00", "$192,900", "192900") to a clean
   * integer-ish number string, or '' if empty/unparseable. Stored as a
   * plain number string (e.g. "192900"); the UI formats it as currency.
   */
  function _parseSalary(v) {
    const s = String(v || '').replace(/[$,\s]/g, '').trim();
    if (!s) return '';
    const n = Number(s);
    if (isNaN(n)) return '';
    return String(Math.round(n));
  }

  /**
   * Format a Date (or date-like value) as a short local date string for
   * display. Returns '' for empty/unparseable input.
   */
  function _isoDate(v) {
    if (!v) return '';
    try {
      const d = (v instanceof Date) ? v : new Date(v);
      if (isNaN(d.getTime())) return String(v);
      return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    } catch (e) {
      return String(v);
    }
  }

  /**
   * Expand a CruzID to a campus email. A value already containing "@" is
   * treated as a full email (used as-is, lowercased); otherwise the
   * configured domain is appended. Empty in → empty out.
   */
  function _cruzidToEmail(cruzid) {
    const v = String(cruzid || '').trim();
    if (!v) return '';
    if (v.indexOf('@') !== -1) return v.toLowerCase();
    return (v + '@' + EMAIL_DOMAIN()).toLowerCase();
  }

  function _skip(bucket, out, reason) {
    out.action = 'skip';
    out.reason = reason;
    bucket.push(out);
    return out;
  }

  function _requireSuperAdmin(roles) {
    if (!roles || roles.indexOf('super_admin') === -1) {
      throw new Error('Only a super_admin may import rank/step data.');
    }
  }


  // ============================================================
  // Phase 2 — Cases (review cases from the departmental Call)
  // ============================================================
  // A case is one candidate up for one review type in one academic year,
  // keyed (CandidateEmail, AcademicYear, ReviewType). Cases are created from
  // the CALL report (batch) — which has NAMES but no CruzID, so identity is
  // resolved by matching names against the already-loaded roster, WITH the
  // super admin confirming each match in the preview. The review type is
  // SUGGESTED from the Call Action string and is overridable per case
  // (candidate election). Deferral is a status, not a type.

  function REVIEW_TYPES() { return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.REVIEW_TYPES) || {}; }
  function CALL_ACTION_MAP() { return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.CALL_ACTION_MAP) || {}; }
  function ASSISTANT_RANKS() { return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.ASSISTANT_RANKS) || []; }
  function STATUSES() { return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.STATUSES) || ['open', 'deferred']; }
  function CASES_TAB() { return CONFIG.TABS.CASES; }

  /**
   * Returns the review-type vocabulary for the UI: [{ key, label, engine,
   * votable, major }], plus the status list. Feeds the type dropdown and
   * the case forms.
   */
  function listReviewTypes(payload, user, roles) {
    const types = REVIEW_TYPES();
    return {
      reviewTypes: Object.keys(types).map(k => ({
        key: k, label: types[k].label, engine: types[k].engine,
        votable: !!types[k].votable, major: !!types[k].major,
      })),
      statuses: STATUSES(),
    };
  }

  /**
   * Suggest a review type from a raw Call Action string. Exact normalized
   * match first, then a normalized "contains" pass. Returns '' if no guess
   * (the super admin then picks in the preview).
   */
  function _suggestReviewType(callActionRaw) {
    const map = CALL_ACTION_MAP();
    const norm = String(callActionRaw || '').trim().toLowerCase();
    if (!norm) return '';
    if (map[norm]) return map[norm];
    const hit = Object.keys(map).find(k => norm.indexOf(k) !== -1 || k.indexOf(norm) !== -1);
    return hit ? map[hit] : '';
  }

  /** Is a rank Assistant-level? (drives the derived isReappointment flag) */
  function _isAssistantRank(rank) {
    const r = String(rank || '').trim().toLowerCase();
    return ASSISTANT_RANKS().some(a => String(a).toLowerCase() === r);
  }

  /** Does a Call string signal a mandatory review? (timing flag) */
  function _isMandatory(callActionRaw) {
    return /mandatory/i.test(String(callActionRaw || ''));
  }


  // ── Name matching against the loaded roster ────────────────
  // The Call has names only. We match against people who already have
  // personnel attributes loaded (the roster). Never silent: the preview
  // shows the proposed match (or asks the super admin to resolve).

  /**
   * Build a name-lookup index from the current roster: normalized
   * "last|first" -> [ {email, name} ]. Also indexes last-name-only for a
   * looser fallback. Multi-word surnames (e.g. "Hernandez Garavito") are
   * kept whole.
   */
  function _rosterNameIndex() {
    // Active faculty only — a Call row should never match a departed person.
    const roster = listRoster({ includeInactive: false }, null, ['super_admin']).roster;
    const byFull = {};
    const byLast = {};
    const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    roster.forEach(r => {
      const profile = Auth.getProfile(r.email);
      const first = profile ? norm(profile.firstName) : '';
      const last  = profile ? norm(profile.lastName) : '';
      const entry = { email: r.email, name: r.name, nameLastFirst: r.nameLastFirst };
      if (last && first) {
        const key = last + '|' + first;
        (byFull[key] = byFull[key] || []).push(entry);
      }
      if (last) (byLast[last] = byLast[last] || []).push(entry);
    });
    return { byFull, byLast, norm };
  }

  /**
   * Resolve one Call row's (last, first) against the roster index.
   * Returns { status: 'matched'|'ambiguous'|'none', email?, candidates? }.
   */
  function _matchName(idx, last, first) {
    const nlast = idx.norm(last), nfirst = idx.norm(first);
    const full = idx.byFull[nlast + '|' + nfirst];
    if (full && full.length === 1) return { status: 'matched', email: full[0].email, name: full[0].name };
    if (full && full.length > 1)   return { status: 'ambiguous', candidates: full };
    // Fallback: last-name-only (first name may be spelled/abbreviated differently)
    const byLast = idx.byLast[nlast];
    if (byLast && byLast.length === 1) return { status: 'matched', email: byLast[0].email, name: byLast[0].name };
    if (byLast && byLast.length > 1)   return { status: 'ambiguous', candidates: byLast };
    return { status: 'none', candidates: [] };
  }


  // ── Call import: detect, preview, commit ───────────────────

  /**
   * Detect columns in an uploaded Call CSV and auto-map them. The Call
   * columns are: Rank, Last Name, First Name, Step, O/A, Yrs Rank, Yrs Step,
   * Qtrs, Call Action.
   * @param {Object} p - { csv }
   */
  function detectCallColumns(p, user, roles) {
    _requireSuperAdmin(roles);
    const parsed = _parseCsv((p && p.csv) || '');
    if (!parsed.rows.length) throw new Error('No data rows found in the file.');
    const hints = {
      last:   ['last name', 'lastname', 'last', 'surname'],
      first:  ['first name', 'firstname', 'first', 'given'],
      rank:   ['rank', 'working title', 'title'],
      step:   ['step'],
      oa:     ['o/a', 'oa', 'on/above', 'scale'],
      yrsRank:['yrs rank', 'years at rank', 'years rank'],
      yrsStep:['yrs step', 'years at step', 'years step'],
      qtrs:   ['qtrs', 'quarters', 'qtr'],
      action: ['call action', 'action', 'review', 'review type'],
    };
    const mapping = {};
    Object.keys(hints).forEach(f => { mapping[f] = _guessHeader(parsed.headers, hints[f]); });
    return { headers: parsed.headers, mapping: mapping, rowCount: parsed.rows.length };
  }

  /**
   * Dry-run a Call import: for each row, resolve identity by name against
   * the roster, suggest a review type from the Call Action, and derive the
   * reappointment/mandatory flags. Writes nothing.
   * @param {Object} payload - { csv, mapping, academicYear }
   * @returns { summary, rows: [ per-row plan ] }
   */
  function previewCallImport(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const rows = _parseCsv(p.csv || '').rows;
    const mapping = p.mapping || {};
    const year = String(p.academicYear || '').trim();
    const idx = _rosterNameIndex();

    const cell = (row, h) => {
      if (!h) return '';
      const k = String(h).trim().toLowerCase();
      return row.hasOwnProperty(k) ? String(row[k] || '').trim() : '';
    };

    const out = rows.map((row, i) => {
      const last  = cell(row, mapping.last);
      const first = cell(row, mapping.first);
      const rank  = cell(row, mapping.rank);
      const step  = cell(row, mapping.step);
      const callAction = cell(row, mapping.action);
      const match = _matchName(idx, last, first);
      const suggested = _suggestReviewType(callAction);
      return {
        line: i + 1,
        last: last, first: first,
        displayName: (last && first) ? (last + ', ' + first) : (last || first),
        rank: rank, step: step,
        oa: cell(row, mapping.oa),
        yrsRank: cell(row, mapping.yrsRank),
        yrsStep: cell(row, mapping.yrsStep),
        qtrs: cell(row, mapping.qtrs),
        callActionRaw: callAction,
        suggestedType: suggested,
        isReappointment: _isAssistantRank(rank),
        isMandatory: _isMandatory(callAction),
        matchStatus: match.status,             // matched | ambiguous | none
        matchedEmail: match.email || '',
        matchedName: match.name || '',
        candidates: match.candidates || [],    // for ambiguous/none resolution
      };
    });

    const counts = { matched: 0, ambiguous: 0, none: 0 };
    out.forEach(r => { counts[r.matchStatus] = (counts[r.matchStatus] || 0) + 1; });
    return { summary: { total: out.length, academicYear: year, ...counts }, rows: out };
  }

  /**
   * Commit a Call import: create a case per confirmed row. The client sends
   * back the resolved rows (each with a confirmed candidateEmail + reviewType
   * + status), so identity and type are HUMAN-CONFIRMED, never guessed here.
   * Upsert by (CandidateEmail, AcademicYear, ReviewType): re-importing or
   * re-confirming updates the existing case rather than duplicating.
   * @param {Object} payload - { academicYear, cases: [ {candidateEmail,
   *     reviewType, subjectRank, step, callActionRaw, oa, yrsRank, yrsStep,
   *     qtrs, isReappointment, isMandatory, status} ] }
   * @returns { summary, created[], updated[], skipped[] }
   */
  function commitCallImport(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const year = String(p.academicYear || '').trim();
    if (!year) throw new Error('Academic year is required.');
    const items = Array.isArray(p.cases) ? p.cases : [];

    const created = [], updated = [], skipped = [];
    items.forEach(it => {
      const email = _email(it.candidateEmail);
      const type  = String(it.reviewType || '').trim();
      const out = { candidateEmail: email, reviewType: type,
                    displayName: it.displayName || email };
      if (!email)      { out.reason = 'No confirmed candidate'; return skipped.push(out); }
      if (!type)       { out.reason = 'No review type'; return skipped.push(out); }
      if (!REVIEW_TYPES()[type]) { out.reason = 'Unknown review type: ' + type; return skipped.push(out); }

      try {
        const res = _upsertCase({
          candidateEmail: email,
          academicYear:   year,
          reviewType:     type,
          subjectRank:    it.subjectRank || '',
          step:           it.step || '',
          callActionRaw:  it.callActionRaw || '',
          oaFlag:         it.oa || '',
          yrsRank:        it.yrsRank || '',
          yrsStep:        it.yrsStep || '',
          qtrs:           it.qtrs || '',
          isReappointment: !!it.isReappointment,
          isMandatory:     !!it.isMandatory,
          status:          it.status || 'open',
          effectiveDate:   it.effectiveDate || '',
        }, user);
        out.caseId = res.caseId;
        (res.action === 'created' ? created : updated).push(out);
      } catch (err) {
        out.reason = 'Write failed: ' + err.message;
        skipped.push(out);
      }
    });

    return { summary: { created: created.length, updated: updated.length, skipped: skipped.length },
             created: created, updated: updated, skipped: skipped };
  }


  // ── Case CRUD ──────────────────────────────────────────────

  /**
   * Insert or update a case by (CandidateEmail, AcademicYear, ReviewType).
   * Returns { action: 'created'|'updated', caseId }.
   */
  function _upsertCase(c, user) {
    const existing = DataService.query(SHEET(), CASES_TAB(), 'CandidateEmail', c.candidateEmail)
      .filter(r => String(r.AcademicYear) === c.academicYear
                && String(r.ReviewType) === c.reviewType);

    const fields = {
      CandidateEmail:  c.candidateEmail,
      AcademicYear:    c.academicYear,
      ReviewType:      c.reviewType,
      SubjectRank:     c.subjectRank,
      Step:            c.step,
      CallActionRaw:   c.callActionRaw,
      OAFlag:          c.oaFlag,
      YrsRank:         c.yrsRank,
      YrsStep:         c.yrsStep,
      Qtrs:            c.qtrs,
      IsReappointment: c.isReappointment ? 'TRUE' : 'FALSE',
      IsMandatory:     c.isMandatory ? 'TRUE' : 'FALSE',
      IsElected:       c.isElected ? 'TRUE' : 'FALSE',
      Status:          c.status,
      EffectiveDate:   c.effectiveDate || '',
    };
    if (c.notes !== undefined) fields.Notes = c.notes || '';

    if (existing.length) {
      const id = existing[0].CaseID;
      DataService.update(SHEET(), CASES_TAB(), 'CaseID', id, fields);
      return { action: 'updated', caseId: id };
    }
    const id = DataService.generateId('CASE');
    DataService.insert(SHEET(), CASES_TAB(), Object.assign({ CaseID: id }, fields));

    // A case is assessed in pieces, so give it its pieces straight away — a
    // ladder case is drafted on research and on teaching/service separately,
    // the other series as a whole. Never fatal: a case without components can
    // still be created, and they're generated on demand later.
    try {
      _ensureComponents(Object.assign({ CaseID: id }, fields), user);
    } catch (err) {
      Logger.log('_upsertCase: could not generate components for ' + id + ': ' + err);
    }

    return { action: 'created', caseId: id };
  }

  /**
   * List cases, most recent academic year first, then by candidate name.
   * Joins the candidate name from Auth. Optional filter by academicYear.
   * @param {Object} payload - { academicYear? }
   */
  function listCases(payload, user, roles) {
    const p = payload || {};
    const wantYear = String(p.academicYear || '').trim();
    let rows = DataService.getAll(SHEET(), CASES_TAB());
    if (wantYear) rows = rows.filter(r => String(r.AcademicYear) === wantYear);

    const types = REVIEW_TYPES();
    const cases = rows.map(r => {
      const email = _email(r.CandidateEmail);
      const profile = Auth.getProfile(email);
      return {
        caseId:        r.CaseID,
        candidateEmail: email,
        name:          profile ? (profile.nameLastFirst || profile.name) : email,
        academicYear:  r.AcademicYear,
        reviewType:    r.ReviewType,
        reviewLabel:   (types[r.ReviewType] && types[r.ReviewType].label) || r.ReviewType,
        subjectRank:   r.SubjectRank,
        step:          r.Step,
        callActionRaw: r.CallActionRaw,
        oaFlag:        r.OAFlag,
        yrsRank:       r.YrsRank,
        yrsStep:       r.YrsStep,
        qtrs:          r.Qtrs,
        isReappointment: String(r.IsReappointment).toUpperCase() === 'TRUE',
        isMandatory:     String(r.IsMandatory).toUpperCase() === 'TRUE',
        isElected:       String(r.IsElected).toUpperCase() === 'TRUE',
        notes:         r.Notes || '',
        status:        r.Status || 'open',
        effectiveDate: _histDate(r.EffectiveDate) || String(r.EffectiveDate || ''),
        updatedAt:     r.UpdatedAt ? _isoDate(r.UpdatedAt) : '',
        updatedBy:     r.UpdatedBy || '',
      };
    });

    cases.sort((a, b) => {
      if (a.academicYear !== b.academicYear) return String(b.academicYear).localeCompare(String(a.academicYear));
      return String(a.name).localeCompare(String(b.name));
    });
    return { cases: cases, count: cases.length };
  }

  /**
   * Update a single case's editable fields (review type, status, subjectRank,
   * step). Re-derives isReappointment from subjectRank if that changes.
   * super_admin only.
   * @param {Object} payload - { caseId, reviewType?, status?, subjectRank?, step? }
   */
  function updateCase(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const id = String(p.caseId || '').trim();
    if (!id) throw new Error('caseId is required.');
    const existing = DataService.query(SHEET(), CASES_TAB(), 'CaseID', id);
    if (!existing.length) throw new Error('Case not found: ' + id);

    const fields = {};
    if (p.reviewType !== undefined) {
      if (!REVIEW_TYPES()[p.reviewType]) throw new Error('Unknown review type: ' + p.reviewType);
      fields.ReviewType = p.reviewType;
    }
    if (p.status !== undefined) {
      if (STATUSES().indexOf(p.status) === -1) throw new Error('Unknown status: ' + p.status);
      fields.Status = p.status;
    }
    if (p.subjectRank !== undefined) {
      fields.SubjectRank = p.subjectRank;
      fields.IsReappointment = _isAssistantRank(p.subjectRank) ? 'TRUE' : 'FALSE';
    }
    if (p.step !== undefined) fields.Step = p.step;
    if (p.effectiveDate !== undefined) fields.EffectiveDate = String(p.effectiveDate || '').trim();

    DataService.update(SHEET(), CASES_TAB(), 'CaseID', id, fields);

    // When a case becomes 'completed', append it to the candidate's review
    // history (so the ledger self-maintains). Only on the transition INTO
    // completed, and only if it wasn't already completed, so re-saving a
    // completed case doesn't re-fire. _appendReviewForCase is idempotent
    // per CaseID as a second guard.
    if (fields.Status === 'completed' && String(existing[0].Status) !== 'completed') {
      const merged = Object.assign({}, existing[0], fields);
      try { _appendReviewForCase(merged); }
      catch (err) { Logger.log('Review-history append failed for case ' + id + ': ' + err); }
    }

    return { caseId: id, updated: Object.keys(fields) };
  }


  // ============================================================
  // Phase 3 — Workflow scheduler (deadlines from the Call cycle)
  // ============================================================
  // Computes a case's internal review deadlines by working BACKWARD from
  // the division submission deadline (reserving the mandatory 10-business-
  // day candidate review, the final voted letter, the vote, deliberation,
  // and drafts) and — for promotions — FORWARD from the external-letters-
  // due date (a second 10-business-day candidate review of the letters
  // before deliberation), flagging infeasible squeezes where they meet.
  //
  // Dates from the Calendar module come via CalendarService (the Auth
  // pattern — a server-side platform read, NOT dispatch). Personnel stores
  // chosen DeadlineIDs and reads by immutable id at compute time; closures
  // are read for the span and the business-day math (weekend-skipping) is
  // done here. All dates are 'yyyy-MM-dd' strings.

  function CYCLES_TAB()   { return CONFIG.TABS.CYCLES; }
  function SETTINGS_TAB() { return CONFIG.TABS.PERSONNEL_SETTINGS; }

  /** The gap parameter names, in the order the Settings UI presents them. */
  const GAP_KEYS = ['candidateReviewDays', 'letterToReviewGap', 'voteToLetterGap',
                    'deliberateToVoteGap', 'draftsToDeliberateGap', 'lateLetterBufferDays'];

  /**
   * Scheduler gap parameters: the CONFIG defaults, overlaid with any values
   * saved in the Settings tab. A missing or unparseable saved value falls back
   * to the default, so an empty Settings tab behaves exactly as before and a
   * bad edit can't produce a nonsense schedule.
   */
  function SCHEDULE_GAPS() {
    const defaults = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.SCHEDULE_GAPS) || {
      candidateReviewDays: 10, letterToReviewGap: 0, voteToLetterGap: 3,
      deliberateToVoteGap: 5, draftsToDeliberateGap: 3, lateLetterBufferDays: 5,
    };
    const gaps = Object.assign({}, defaults);
    try {
      DataService.getAll(SHEET(), SETTINGS_TAB()).forEach(r => {
        const k = String(r.Key || '').trim();
        if (GAP_KEYS.indexOf(k) === -1) return;
        const n = Number(r.Value);
        if (isFinite(n) && n >= 0) gaps[k] = Math.floor(n);
      });
    } catch (err) {
      Logger.log('SCHEDULE_GAPS: settings read failed, using defaults: ' + err);
    }
    return gaps;
  }

  // ── Date helpers (string <-> Date at UTC noon) ─────────────
  function _schParseISO(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0));
  }
  function _schFormatISO(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '';
    return d.getUTCFullYear() + '-'
      + String(d.getUTCMonth() + 1).padStart(2, '0') + '-'
      + String(d.getUTCDate()).padStart(2, '0');
  }
  function _schAddDays(iso, n) {
    const d = _schParseISO(iso);
    if (!d) return '';
    d.setUTCDate(d.getUTCDate() + n);
    return _schFormatISO(d);
  }
  function _schIsWeekend(iso) {
    const d = _schParseISO(iso);
    if (!d) return false;
    const w = d.getUTCDay();
    return w === 0 || w === 6;
  }
  function _schClosureSet(closures) {
    const set = {};
    (closures || []).forEach(c => { const s = String(c || '').trim(); if (s) set[s] = true; });
    return set;
  }
  function _schIsBusinessDay(iso, lookup) {
    if (!iso) return false;
    if (_schIsWeekend(iso)) return false;
    if (lookup && lookup[iso]) return false;
    return true;
  }

  /**
   * Step n business days from a start date (start never counted; move then
   * test). n positive; dir +1 forward / -1 backward. Skips weekends + the
   * closure list. Returns 'yyyy-MM-dd'.
   */
  function _schAddBusinessDays(startISO, n, closures, dir) {
    const step = dir < 0 ? -1 : 1;
    const lookup = _schClosureSet(closures);
    let count = 0, cur = startISO, guard = 0;
    while (count < n) {
      cur = _schAddDays(cur, step);
      if (_schIsBusinessDay(cur, lookup)) count++;
      if (++guard > 4000) throw new Error('addBusinessDays runaway (check dates).');
    }
    return cur;
  }

  /** Business days strictly between two ISO dates (exclusive both ends). */
  function _schBusinessDaysBetween(aISO, bISO, closures) {
    if (!aISO || !bISO) return 0;
    let lo = aISO, hi = bISO;
    if (_schParseISO(lo).getTime() > _schParseISO(hi).getTime()) { const t = lo; lo = hi; hi = t; }
    const lookup = _schClosureSet(closures);
    let count = 0, cur = _schAddDays(lo, 1), guard = 0;
    while (_schParseISO(cur).getTime() < _schParseISO(hi).getTime()) {
      if (_schIsBusinessDay(cur, lookup)) count++;
      cur = _schAddDays(cur, 1);
      if (++guard > 4000) throw new Error('businessDaysBetween runaway.');
    }
    return count;
  }

  // ── Calendar reads (CalendarService — the Auth pattern) ────
  // Thin wrappers so the calendar contract is touched in exactly one place;
  // if CalendarService's shape ever changes, only these adjust.

  /**
   * Resolve a stored anchor DeadlineID to { date, title, status, found }.
   * status 'removed' means the anchor vanished upstream — caller flags
   * rather than computing on a ghost. Missing/blank id -> found:false.
   */
  function _calendarDeadline(deadlineId) {
    const id = String(deadlineId || '').trim();
    if (!id) return { found: false, date: '', title: '', status: 'missing' };
    try {
      const d = CalendarService.getDeadlineById(id);
      if (!d) return { found: false, date: '', title: '', status: 'missing' };
      return { found: true, date: d.date || '', title: d.title || '', status: d.status || 'active' };
    } catch (err) {
      return { found: false, date: '', title: '', status: 'error', error: String(err) };
    }
  }

  /** Closures (non-working days) in [fromISO, toISO] as 'yyyy-MM-dd' strings. */
  function _calendarClosures(fromISO, toISO) {
    try {
      return CalendarService.listClosures(fromISO, toISO) || [];
    } catch (err) {
      return [];
    }
  }

  // ── Schedule computation ───────────────────────────────────

  // ── Instruction windows (classes in session) ───────────────
  // Committee members and faculty voters are only available while classes are
  // in session, so the deliberation and vote dates must land inside one of
  // these windows. They're derived from the calendar's paired "Instruction
  // Begins (Fall 2026)" / "Instruction Ends (Fall 2026)" entries, so nobody
  // maintains quarter dates by hand.

  /**
   * The instruction windows overlapping a date range, as [{start, end, term}]
   * sorted by start. Pairs "Instruction Begins" with the matching
   * "Instruction Ends" by the term in parentheses.
   */
  function _instructionWindows(fromISO, toISO) {
    const pat = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.INSTRUCTION_PATTERNS)
      || { begins: ['instruction begins'], ends: ['instruction ends'] };
    let list;
    try {
      list = CalendarService.findDeadlines({}) || [];
    } catch (err) {
      Logger.log('_instructionWindows: calendar read failed: ' + err);
      return [];
    }

    // "Instruction Begins (Fall 2026)" → term "fall 2026"
    const termOf = title => {
      const m = /\(([^)]+)\)/.exec(String(title || ''));
      return m ? m[1].trim().toLowerCase() : '';
    };
    const matches = (title, phrases) => {
      const t = String(title || '').toLowerCase();
      return phrases.some(p => t.indexOf(String(p).toLowerCase()) !== -1);
    };

    const begins = {}, ends = {};
    list.forEach(d => {
      if (!d.date) return;
      const term = termOf(d.title);
      if (!term) return;
      if (matches(d.title, pat.begins)) begins[term] = d.date;
      else if (matches(d.title, pat.ends)) ends[term] = d.date;
    });

    const windows = [];
    Object.keys(begins).forEach(term => {
      if (!ends[term]) return;                      // unpaired — skip
      windows.push({ term: term, start: begins[term], end: ends[term] });
    });
    windows.sort((a, b) => a.start.localeCompare(b.start));

    // Keep only those overlapping the range we care about (with slack).
    if (fromISO && toISO) {
      return windows.filter(w => !(w.end < fromISO || w.start > toISO));
    }
    return windows;
  }

  /** Is a date inside any instruction window? */
  function _isInSession(iso, windows) {
    if (!iso || !windows || !windows.length) return true;   // no data → don't block
    return windows.some(w => iso >= w.start && iso <= w.end);
  }

  /**
   * Move a date EARLIER onto the nearest day that is both a business day and
   * in session. We're working backward from a fixed deadline, so slipping
   * later is never an option.
   *
   * Two ways this fails, and both are reported rather than papered over:
   *   · the date is BEFORE every known window — no earlier session exists to
   *     retreat into, so the step simply cannot be scheduled;
   *   · it would have to slide further than `maxSlideDays`, which means it is
   *     being dragged into an unrelated earlier term rather than merely
   *     nudged out of a break.
   * @returns { date, moved, ok, reason? }
   */
  function _snapToInSession(iso, closures, windows, maxSlideDays) {
    if (!iso || !windows || !windows.length) return { date: iso, moved: 0, ok: true };
    const limit = maxSlideDays || 60;
    const lookup = _schClosureSet(closures);

    // Before every window: there is nothing earlier to fall back on.
    const earliest = windows.reduce((a, w) => (!a || w.start < a ? w.start : a), '');
    if (earliest && iso < earliest) {
      return { date: iso, moved: 0, ok: false,
               reason: 'falls before the first term in the calendar (' + earliest + ')' };
    }

    let cur = iso, moved = 0;
    while (!(_schIsBusinessDay(cur, lookup) && _isInSession(cur, windows))) {
      cur = _schAddDays(cur, -1);
      moved++;
      if (moved > limit) {
        return { date: iso, moved: 0, ok: false,
                 reason: 'no teaching day within ' + limit + ' days before ' + iso };
      }
    }
    return { date: cur, moved: moved, ok: true };
  }


  /** Day of week for an ISO date: 0 = Sunday … 6 = Saturday. */
  function _schDow(iso) {
    const d = _schParseISO(iso);
    return d ? d.getUTCDay() : -1;
  }

  /**
   * The vote date: the last day ON OR BEFORE `iso` that is the department's
   * voting weekday (Wednesday), falls while classes are in session, and isn't
   * a campus closure. All three must hold at once — a Wednesday inside winter
   * break is no good, and neither is a Wednesday that happens to be a holiday.
   *
   * Steps back a week at a time from the first candidate weekday, so it lands
   * on a real meeting day rather than merely a nearby one. Reports failure
   * rather than inventing a date.
   * @returns { date, moved, ok, reason? }
   */
  function _snapToVoteDay(iso, closures, windows, maxWeeksBack) {
    const want = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.VOTE_WEEKDAY);
    // No weekday rule configured → fall back to the plain in-session snap.
    if (want === null || want === undefined || want < 0) {
      return _snapToInSession(iso, closures, windows);
    }
    if (!iso) return { date: iso, moved: 0, ok: true };

    const limitWeeks = maxWeeksBack || 12;
    const lookup = _schClosureSet(closures);

    // Step back to the most recent instance of the voting weekday (on or
    // before the computed date), then keep stepping back a week at a time.
    let cur = iso;
    let back = (_schDow(cur) - want + 7) % 7;
    cur = _schAddDays(cur, -back);

    const earliest = (windows && windows.length)
      ? windows.reduce((a, w) => (!a || w.start < a ? w.start : a), '') : '';

    for (let i = 0; i <= limitWeeks; i++) {
      const closed = !!lookup[cur];
      const inSess = _isInSession(cur, windows);
      if (!closed && inSess) {
        return { date: cur, moved: _schDaysBetween(cur, iso), ok: true };
      }
      if (earliest && cur < earliest) {
        return { date: iso, moved: 0, ok: false,
                 reason: 'no meeting day falls before the first term in the calendar (' + earliest + ')' };
      }
      cur = _schAddDays(cur, -7);
    }
    return { date: iso, moved: 0, ok: false,
             reason: 'no in-session meeting day within ' + limitWeeks + ' weeks before ' + iso };
  }

  /** Whole days between two ISO dates (b - a), non-negative. */
  function _schDaysBetween(aISO, bISO) {
    const a = _schParseISO(aISO), b = _schParseISO(bISO);
    if (!a || !b) return 0;
    return Math.round(Math.abs(b - a) / (24 * 3600 * 1000));
  }


  function _computeBackward(submissionISO, closures, g, windows) {
    const lateReviewStart = _schAddBusinessDays(submissionISO, g.candidateReviewDays, closures, -1);
    const lateReviewEnd   = _schAddBusinessDays(submissionISO, 1, closures, -1);
    const letterFinal = g.letterToReviewGap > 0
      ? _schAddBusinessDays(lateReviewStart, g.letterToReviewGap, closures, -1)
      : lateReviewStart;

    // The vote and the deliberation need faculty in a room, so their dates
    // must land while classes are in session. Compute them normally, then
    // move each EARLIER onto the nearest in-session business day — working
    // backward from a fixed deadline, later is never an option.
    // The vote is taken at a department meeting — a Wednesday, in session,
    // not a holiday. Move back to the last day satisfying all three.
    const voteRaw = _schAddBusinessDays(letterFinal, g.voteToLetterGap, closures, -1);
    const voteSnap = _snapToVoteDay(voteRaw, closures, windows);
    const vote = voteSnap.date;

    // Deliberation precedes the vote and also needs faculty in session, but
    // isn't tied to a weekday.
    const deliberateRaw = _schAddBusinessDays(vote, g.deliberateToVoteGap, closures, -1);
    const deliberateSnap = _snapToInSession(deliberateRaw, closures, windows);
    const deliberateBy = deliberateSnap.date;

    // An in-session step that cannot be placed at all is a real scheduling
    // failure, not a date to fudge.
    const sessionProblems = [];
    if (!voteSnap.ok) sessionProblems.push('the faculty vote (' + voteRaw + ') — ' + voteSnap.reason);
    if (!deliberateSnap.ok) sessionProblems.push('committee deliberation (' + deliberateRaw + ') — ' + deliberateSnap.reason);

    // Drafts hang off the (possibly moved) deliberation date, so a vote pushed
    // back into the previous term drags the drafting deadline with it.
    const draftsDue = _schAddBusinessDays(deliberateBy, g.draftsToDeliberateGap, closures, -1);

    return {
      submission: submissionISO, lateReviewStart, lateReviewEnd,
      letterFinal, vote, deliberateBy, draftsDue,
      // How far each in-session step had to move, so the UI can explain it.
      voteMovedDays: voteSnap.moved,
      deliberateMovedDays: deliberateSnap.moved,
      voteRaw: voteRaw,
      deliberateRaw: deliberateRaw,
      sessionProblems: sessionProblems,
    };
  }

  function _computeForward(lettersDueISO, actualAddedISO, closures, g) {
    const useActual = !!actualAddedISO;
    const from   = useActual ? actualAddedISO : lettersDueISO;
    const buffer = useActual ? 0 : g.lateLetterBufferDays;
    const reviewStart = buffer > 0
      ? _schAddBusinessDays(from, buffer, closures, +1)
      : _schAddBusinessDays(from, 1, closures, +1);
    const reviewEnd = _schAddBusinessDays(reviewStart, g.candidateReviewDays, closures, +1);
    const earliestDeliberate = _schAddBusinessDays(reviewEnd, 1, closures, +1);
    return { basis: useActual ? 'actual' : 'planned', lettersDue: lettersDueISO,
             lettersAdded: actualAddedISO || '',
             earlyReviewStart: reviewStart, earlyReviewEnd: reviewEnd,
             earliestDeliberate };
  }

  /**
   * Compute a case's full schedule from resolved anchor dates.
   * @param {Object} c - { isPromotion, submissionISO, lettersDueISO?,
   *                        actualLettersAddedISO? }
   * @param {string[]} closures
   * @returns { backward, forward|null, feasible, warnings[] }
   */
  function _computeSchedule(c, closures, windows) {
    const g = SCHEDULE_GAPS();
    const backward = _computeBackward(c.submissionISO, closures, g, windows);
    const out = { backward: backward, forward: null, feasible: true, warnings: [] };

    // Say so when the vote or deliberation had to be pulled earlier to land
    // while classes are in session — it's the difference between a schedule
    // that looks comfortable and one that quietly isn't.
    const moved = [];
    if (backward.voteMovedDays) {
      moved.push('the vote moved to ' + backward.vote + ' (from ' + backward.voteRaw +
        ') — the last department meeting day in session');
    }
    if (backward.deliberateMovedDays) {
      moved.push('deliberation moved to ' + backward.deliberateBy + ' (from ' +
        backward.deliberateRaw + ') to stay in session');
    }
    if (moved.length) {
      out.warnings.push(moved.join('; ') + '. Drafts are due correspondingly earlier.');
    }
    if ((backward.sessionProblems || []).length) {
      out.feasible = false;
      out.warnings.push('Does not fit the teaching calendar: ' + backward.sessionProblems.join('; ') +
        '. Committee members and faculty voters are only available while classes are in session.');
    }
    if (c.isPromotion && c.lettersDueISO) {
      const forward = _computeForward(c.lettersDueISO, c.actualLettersAddedISO, closures, g);
      out.forward = forward;
      const earliest = _schParseISO(forward.earliestDeliberate).getTime();
      const mustBy   = _schParseISO(backward.deliberateBy).getTime();
      if (earliest > mustBy) {
        out.feasible = false;
        const short = _schBusinessDaysBetween(backward.deliberateBy, forward.earliestDeliberate, closures);
        out.warnings.push('Infeasible: the early candidate review of external letters can\'t '
          + 'finish in time. Earliest deliberation start (' + forward.earliestDeliberate + ') is '
          + 'after the latest it must be underway (' + backward.deliberateBy + ') to meet the '
          + 'division deadline — short by about ' + short + ' business day(s). '
          + (forward.basis === 'planned'
              ? 'Assumes letters arrive on time with the configured buffer; late letters worsen it.'
              : 'Based on the recorded letter-arrival date.'));
      }
    }
    return out;
  }

  // ── Dispatchable scheduler actions ─────────────────────────

  /**
   * Find candidate anchor deadlines for the cycle picker. A thin pass-through
   * to CalendarService.findDeadlines so the personnel UI can search without
   * knowing the calendar's internals.
   *
   * Only filters that actually carry a value are passed: an empty string is a
   * FILTER on emptiness, not the absence of a filter, and would match nothing.
   * @param {Object} payload - { titleContains?, sourceKey?, origin?, kind?, from?, to? }
   */
  function findCalendarDeadlines(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const filter = {};
    ['titleContains', 'sourceKey', 'origin', 'kind', 'from', 'to'].forEach(k => {
      const v = String(p[k] == null ? '' : p[k]).trim();
      if (v) filter[k] = v;
    });
    try {
      return { deadlines: CalendarService.findDeadlines(filter) || [] };
    } catch (err) {
      throw new Error('Calendar lookup failed: ' + err);
    }
  }

  /**
   * Compute a schedule from supplied anchor DeadlineIDs. (Per-cycle storage
   * of these IDs is the next slice; for now they're passed in so the whole
   * computation is testable end-to-end.) Resolves anchors via CalendarService,
   * reads closures over the spanning window, computes, and reports any
   * vanished-anchor or infeasibility warnings.
   *
   * @param {Object} payload - {
   *     isPromotion, submissionDeadlineId, lettersDueDeadlineId?,
   *     actualLettersAddedDate?   ('yyyy-MM-dd')
   *   }
   * @returns { resolved:{...}, schedule:{...}|null, warnings[] }
   */
  function computeCaseSchedule(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const warnings = [];

    const sub = _calendarDeadline(p.submissionDeadlineId);
    if (!sub.found) return { schedule: null, resolved: { submission: sub },
      warnings: ['No division submission deadline is set (or it could not be read).'] };
    if (sub.status === 'removed') warnings.push('The division submission deadline was removed upstream in the calendar — the date shown may be stale.');
    if (!sub.date) return { schedule: null, resolved: { submission: sub },
      warnings: ['The division submission deadline has no date.'] };

    // Letters-due may arrive as an already-resolved DATE (the usual case —
    // the standing Nov 1 default, or a typed override) or as a calendar
    // DeadlineID to resolve.
    let letters = { found: false, date: '', status: 'missing' };
    if (p.isPromotion) {
      const given = String(p.lettersDueDate || '').trim();
      if (given) {
        letters = { found: true, date: given, title: '', status: 'active' };
      } else if (p.lettersDueDeadlineId) {
        letters = _calendarDeadline(p.lettersDueDeadlineId);
        if (letters.status === 'removed') warnings.push('The external-letters-due deadline was removed upstream — the date shown may be stale.');
      }
      if (!letters.found) warnings.push('This is a promotion but no external-letters-due date is set — the early candidate-review window cannot be planned.');
    }

    // Closure window: from a bit before the earliest plausible start to the
    // submission deadline. Letters-due (promotions) can precede submission by
    // months, so span from min(anchors) minus a pad, to submission plus a pad.
    const anchorsMin = (p.isPromotion && letters.date)
      ? (_schParseISO(letters.date) < _schParseISO(sub.date) ? letters.date : sub.date)
      : sub.date;
    const from = _schAddDays(anchorsMin, -30);
    const to   = _schAddDays(sub.date, 5);
    const closures = _calendarClosures(from, to);
    // Instruction windows: the vote and deliberation must land inside one.
    // Look back further than the closures window — a vote pushed out of Fall
    // may have to land in the previous term.
    const windows = _instructionWindows(_schAddDays(anchorsMin, -240), to);

    const schedule = _computeSchedule({
      isPromotion: !!p.isPromotion,
      submissionISO: sub.date,
      lettersDueISO: (p.isPromotion && letters.date) ? letters.date : '',
      actualLettersAddedISO: p.actualLettersAddedDate || '',
    }, closures, windows);

    schedule.warnings = warnings.concat(schedule.warnings || []);
    if (!windows.length) {
      schedule.warnings.push('No instruction dates found in the calendar — the vote and deliberation were not checked against the academic term.');
    }
    return { schedule: schedule,
             resolved: { submission: sub, letters: letters,
                         closureCount: closures.length,
                         sessions: windows.map(w => w.term + ': ' + w.start + ' → ' + w.end) } };
  }


  // ============================================================
  // Phase 4 — Review history (the APO action-ledger backfill)
  // ============================================================
  // A per-person ledger of completed reviews. Seeded once from the APO
  // action-history report (review-coded rows, matched to the roster by
  // CruzID) and appended to when a case is marked Completed. The
  // mandatory-review 5-year clock and the anticipation view read the most
  // recent entry. Rows without a CruzID or not matching a loaded profile
  // are ignored (they aren't current faculty).

  function HISTORY_TAB() { return CONFIG.TABS.REVIEW_HISTORY; }
  function REVIEW_CODES() {
    return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.REVIEW_ACTION_CODES)
      || ['IAP', 'MI', 'PR', 'SI', 'REMI', 'RESI', 'MD', 'MA'];
  }
  function TYPE_TO_CODE() {
    return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.REVIEW_TYPE_TO_CODE)
      || { merit: 'MI', salary_increase_only: 'SI', promotion: 'PR', midcareer: 'MD' };
  }

  /** Normalize a date cell to 'yyyy-MM-dd', or '' if unparseable/blank. */
  function _histDate(v) {
    if (!v) return '';
    if (v instanceof Date && !isNaN(v.getTime())) {
      return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);   // M/D/YYYY
    if (m) return m[3] + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
    return '';
  }

  /**
   * Detect columns in the APO action-ledger report and auto-map them.
   * Columns: First Name, Last Name, Cruzid, Academic Year, Appointment
   * Title, Step, Yrs Rank, Yrs Step, Salary, Amount Off Scale, Effective
   * Date, Action Code.
   * @param {Object} p - { csv }
   */
  function detectHistoryColumns(p, user, roles) {
    _requireSuperAdmin(roles);
    const parsed = _parseCsv((p && p.csv) || '');
    if (!parsed.rows.length) throw new Error('No data rows found in the file.');
    const hints = {
      cruzid: ['cruzid', 'cruz id', 'email'],
      first:  ['first name', 'firstname', 'first'],
      last:   ['last name', 'lastname', 'last'],
      date:   ['effective date', 'date', 'effective'],
      code:   ['action code', 'action', 'code'],
      title:  ['appointment title', 'working title', 'title'],
      step:   ['step'],
      year:   ['academic year', 'year'],
    };
    const mapping = {};
    Object.keys(hints).forEach(f => { mapping[f] = _guessHeader(parsed.headers, hints[f]); });
    return { headers: parsed.headers, mapping: mapping, rowCount: parsed.rows.length };
  }

  /**
   * Preview the review-history import: parse the ledger, keep review-coded
   * rows with a date and a roster-matched CruzID, group by person, and
   * report what would be written. Writes nothing.
   * @param {Object} payload - { csv, mapping }
   */
  function previewHistoryImport(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const rows = _parseCsv(p.csv || '').rows;
    const mapping = p.mapping || {};
    const codes = REVIEW_CODES();
    const cell = (row, h) => {
      if (!h) return '';
      const k = String(h).trim().toLowerCase();
      return row.hasOwnProperty(k) ? String(row[k] || '').trim() : '';
    };

    let totalRows = 0, reviewRows = 0, noCode = 0, noDate = 0, noCruzid = 0, noProfile = 0;
    const byPerson = {};   // email -> [{date, code, title, step, year}]
    rows.forEach(row => {
      totalRows++;
      const code = cell(row, mapping.code).toUpperCase();
      if (codes.indexOf(code) === -1) { noCode++; return; }
      reviewRows++;
      const date = _histDate(cell(row, mapping.date));
      if (!date) { noDate++; return; }
      const cruzidRaw = cell(row, mapping.cruzid);
      if (!cruzidRaw) { noCruzid++; return; }
      const email = _cruzidToEmail(cruzidRaw);
      const profile = Auth.getProfile(email);
      if (!profile) { noProfile++; return; }
      (byPerson[email] = byPerson[email] || []).push({
        date: date, code: code,
        title: cell(row, mapping.title), step: cell(row, mapping.step),
        year: cell(row, mapping.year),
      });
    });

    const people = Object.keys(byPerson).map(email => {
      const recs = byPerson[email].sort((a, b) => a.date.localeCompare(b.date));
      const profile = Auth.getProfile(email);
      const latest = recs[recs.length - 1];
      return {
        email: email,
        name: profile ? (profile.nameLastFirst || profile.name) : email,
        reviewCount: recs.length,
        mostRecent: latest ? (latest.date + ' ' + latest.code) : '',
      };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

    return {
      summary: {
        totalRows: totalRows, reviewRows: reviewRows,
        skippedNoDate: noDate, skippedNoCruzid: noCruzid, skippedNoProfile: noProfile,
        matchedPeople: people.length,
      },
      people: people,
    };
  }

  /**
   * Commit the review-history import. Replaces each matched person's
   * IMPORTED history (Source='imported') with the ledger's review rows —
   * so re-running is idempotent (a re-import refreshes, never duplicates).
   * Case-sourced entries (Source='case') are left untouched. super_admin only.
   * @param {Object} payload - { csv, mapping }
   */
  function commitHistoryImport(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const rows = _parseCsv(p.csv || '').rows;
    const mapping = p.mapping || {};
    const codes = REVIEW_CODES();
    const cell = (row, h) => {
      if (!h) return '';
      const k = String(h).trim().toLowerCase();
      return row.hasOwnProperty(k) ? String(row[k] || '').trim() : '';
    };

    // Gather review rows per matched person.
    const byPerson = {};
    rows.forEach(row => {
      const code = cell(row, mapping.code).toUpperCase();
      if (codes.indexOf(code) === -1) return;
      const date = _histDate(cell(row, mapping.date));
      if (!date) return;
      const cruzidRaw = cell(row, mapping.cruzid);
      if (!cruzidRaw) return;
      const email = _cruzidToEmail(cruzidRaw);
      if (!Auth.getProfile(email)) return;
      (byPerson[email] = byPerson[email] || []).push({
        date: date, code: code,
        title: cell(row, mapping.title), step: cell(row, mapping.step),
        year: cell(row, mapping.year),
      });
    });

    // Remove existing imported rows for these people (idempotent refresh),
    // keeping case-sourced entries.
    const existing = DataService.getAll(SHEET(), HISTORY_TAB());
    existing.forEach(r => {
      const email = _email(r.PersonEmail);
      if (byPerson[email] && String(r.Source) === 'imported') {
        DataService.remove(SHEET(), HISTORY_TAB(), 'ReviewID', r.ReviewID);
      }
    });

    let written = 0;
    Object.keys(byPerson).forEach(email => {
      byPerson[email].forEach(rec => {
        DataService.insert(SHEET(), HISTORY_TAB(), {
          ReviewID:     DataService.generateId('REV'),
          PersonEmail:  email,
          ReviewDate:   rec.date,
          ReviewCode:   rec.code,
          TitleAtTime:  rec.title,
          StepAtTime:   rec.step,
          AcademicYear: rec.year,
          Source:       'imported',
          CaseID:       '',
        });
        written++;
      });
    });

    return { summary: { people: Object.keys(byPerson).length, rowsWritten: written } };
  }

  /**
   * A person's review history, most-recent first, with the derived
   * most-recent-review date (drives the mandatory-review clock).
   * @param {Object} payload - { email }
   */
  function getReviewHistory(payload, user, roles) {
    const email = _email((payload || {}).email);
    if (!email) throw new Error('email is required.');
    const rows = DataService.query(SHEET(), HISTORY_TAB(), 'PersonEmail', email)
      .map(r => ({
        reviewId: r.ReviewID, date: _histDate(r.ReviewDate) || String(r.ReviewDate || ''),
        code: r.ReviewCode, title: r.TitleAtTime, step: r.StepAtTime,
        year: r.AcademicYear, source: r.Source, caseId: r.CaseID || '',
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return {
      email: email,
      history: rows,
      mostRecentDate: rows.length ? rows[0].date : '',
      mostRecentCode: rows.length ? rows[0].code : '',
    };
  }

  /**
   * Append a review-history entry for a completed case. Called when a case
   * moves to 'completed'. Idempotent per case: an existing case-sourced
   * entry for this CaseID is updated rather than duplicated.
   */
  function _appendReviewForCase(caseRow) {
    const email = _email(caseRow.CandidateEmail);
    if (!email) return;
    const code = TYPE_TO_CODE()[String(caseRow.ReviewType)] || '';
    // Effective date: use today as the completion date (no separate
    // effective-date field on the case yet; can be refined later).
    const date = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const existing = DataService.query(SHEET(), HISTORY_TAB(), 'CaseID', caseRow.CaseID)
      .filter(r => String(r.Source) === 'case');
    const fields = {
      PersonEmail: email, ReviewDate: date, ReviewCode: code,
      TitleAtTime: caseRow.SubjectRank || '', StepAtTime: caseRow.Step || '',
      AcademicYear: caseRow.AcademicYear || '', Source: 'case', CaseID: caseRow.CaseID,
    };
    if (existing.length) {
      DataService.update(SHEET(), HISTORY_TAB(), 'ReviewID', existing[0].ReviewID, fields);
    } else {
      DataService.insert(SHEET(), HISTORY_TAB(), Object.assign({ ReviewID: DataService.generateId('REV') }, fields));
    }
  }


  // ============================================================
  // Phase 5 — Anticipated-Call view (pre-Call eligibility)
  // ============================================================
  // Reads the roster (rank/step/years) + each person's most-recent review
  // (for the mandatory 5-year clock) and computes what each ladder-rank
  // faculty member is anticipated for on the upcoming Call: merit,
  // promotion (highlighted — the external-letter cases), indefinite-step
  // (Prof 5+), and mandatory review. Pure read; used before the Call
  // arrives to line up external-letter writers.

  // Normative time at step, by rank family. The standard qualifying service
  // required before a faculty member is listed on the Call. Gates BOTH merit
  // and promotion — a barrier step alone is not sufficient.
  //   Assistant / Assistant Teaching: 2 yrs at Steps 1-5
  //   Associate / Associate Teaching: 2 yrs at Steps 1-3; 3 yrs at Step 4
  //   Professor / Teaching Professor: 3 yrs at Steps 1-8; 4 yrs at Step 9/AS
  const NORMATIVE_TIME = {
    assistant: { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 },
    associate: { 1: 2, 2: 2, 3: 2, 4: 3 },
    professor: { 1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 4 },
  };

  // Codes constituting a POSITIVE ADVANCEMENT — these RESET the eligibility
  // clock (any salary increase counts, even if rank/step advancement was
  // denied). NON_RESETTING_CODES are reviews that do NOT reset the clock:
  // retention actions and denials. Populate the latter once those codes are
  // known; until then every review is treated as resetting, which slightly
  // over-resets for retention/denial cases.
  function ADVANCEMENT_CODES() {
    return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.ADVANCEMENT_CODES)
      || ['IAP', 'MI', 'PR', 'SI', 'REMI', 'RESI', 'MD', 'MA'];
  }
  function NON_RESETTING_CODES() {
    return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.NON_RESETTING_CODES) || [];
  }

  function _num(v) { const n = Number(v); return isFinite(n) ? n : null; }

  /** Map a working title to a rank family for the normative table. */
  function _rankFamily(rank) {
    const r = String(rank || '').trim().toLowerCase();
    if (/^assistant (professor|teaching professor)$/.test(r)) return 'assistant';
    if (/^associate (professor|teaching professor)$/.test(r)) return 'associate';
    if (/^(professor|teaching professor)$/.test(r)) return 'professor';
    return null;   // lecturer & everything else: not on this ladder
  }

  function _normativeYears(family, step) {
    const t = NORMATIVE_TIME[family];
    if (!t || step == null) return null;
    const n = t[step];
    return n == null ? null : n;
  }

  /** Indefinite steps: Professor Step 5 and above (incl. Above-Scale). */
  function _isIndefiniteStep(family, step) {
    return family === 'professor' && step != null && step >= 5;
  }

  function _parseISO(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function _yearsBetween(a, b) {
    const x = _parseISO(a), y = _parseISO(b);
    if (x == null || y == null) return null;
    return (y - x) / (365.25 * 24 * 3600 * 1000);
  }

  /**
   * The last CLOCK-RESETTING advancement in a person's review history.
   * Retention actions and denials (NON_RESETTING_CODES) are skipped —
   * they do not reset the eligibility clock.
   * @param {Array} history - [{ date:'yyyy-MM-dd', code }]
   */
  function _lastAdvancement(history) {
    const adv = ADVANCEMENT_CODES(), non = NON_RESETTING_CODES();
    const eligible = (history || []).filter(h =>
      h.date &&
      adv.indexOf(String(h.code || '').toUpperCase()) !== -1 &&
      non.indexOf(String(h.code || '').toUpperCase()) === -1);
    if (!eligible.length) return null;
    return eligible.reduce((a, b) => (a.date >= b.date ? a : b));
  }

  /**
   * Service at step, in years, measured from the last advancement's
   * EFFECTIVE DATE to the PROSPECTIVE advancement's effective date.
   *
   * This is the rule: the service cutoff is the year the next advancement
   * would take effect. E.g. last advancement effective 7/1/25, next
   * effective 7/1/27 → 2 years of service by then. Computed from the review
   * history, NOT from the roster's years-at-step snapshot (which is stale
   * relative to the prospective cycle).
   */
  function _serviceAtStep(history, prospectiveISO) {
    const last = _lastAdvancement(history);
    if (!last) return { years: null, from: '', code: '' };
    const y = _yearsBetween(last.date, prospectiveISO);
    return { years: y == null ? null : Math.round(y), from: last.date, code: last.code };
  }

  /**
   * Compute anticipated review eligibility for one person.
   *
   * NORMATIVE TIME gates BOTH merit and promotion — a barrier step alone is
   * not enough; the interval must be served. Service is computed from the
   * review history to the prospective effective date. At INDEFINITE steps
   * (Prof 5+) a served interval means the faculty member MAY ELECT review;
   * they are only automatically called at the 5-year mandatory. MANDATORY
   * review fires at 5 years without any review and cannot be deferred.
   *
   * IN-PROGRESS ACTIONS: a case with status 'in_progress' represents an action
   * that is not yet final (often: the department has finished its part and the
   * file has gone forward) but that carries an anticipated EFFECTIVE DATE. That
   * date is a PENDING clock reset. We compute AS IF the action completes —
   * using its effective date as the last advancement — and FLAG the person, so
   * an in-flight action cannot silently distort next cycle's planning. If the
   * action ultimately fails, the person's eligibility reverts to the completed
   * history, which the flag warns about.
   *
   * APPROXIMATE (pending data): the Assistant tenure trigger is really 19
   * QUARTERS of service (mid-career at 10; cap 24) — not modeled.
   *
   * @param {Object} p - { rank, step, history:[{date,code}],
   *                       pendingAction?: { effectiveDate, reviewType, caseId } }
   * @param {string} prospectiveISO - effective date of the next advancement
   */
  function _computeEligibility(p, prospectiveISO) {
    const rank = String(p.rank || '').trim();
    const step = _num(p.step);
    const family = _rankFamily(rank);

    const out = { rank: rank, step: step, family: family,
      merit: false, mayElect: false, promotion: false, mandatory: false,
      indefiniteStep: false, normativeYears: null, serviceYears: null,
      normativeMet: false, anticipated: false, lastAdvancement: '',
      pendingAction: null, approximate: [], reasons: [] };
    if (!family) return out;

    out.indefiniteStep = _isIndefiniteStep(family, step);
    const need = _normativeYears(family, step);
    out.normativeYears = need;

    // An in-progress action's effective date is a PENDING clock reset: treat
    // it as the last advancement (computing as if it completes) and flag it.
    const pending = p.pendingAction || null;
    let svc;
    if (pending && pending.effectiveDate) {
      const y = _yearsBetween(pending.effectiveDate, prospectiveISO);
      svc = { years: y == null ? null : Math.round(y),
              from: pending.effectiveDate, code: 'in progress' };
      out.pendingAction = {
        effectiveDate: pending.effectiveDate,
        reviewType: pending.reviewType || '',
        caseId: pending.caseId || '',
      };
      out.reasons.push('Action IN PROGRESS, effective ' + pending.effectiveDate +
        (pending.reviewType ? ' (' + pending.reviewType + ')' : '') +
        ' — computed as if it completes; eligibility changes if it does not.');
    } else {
      svc = _serviceAtStep(p.history, prospectiveISO);
    }

    out.serviceYears = svc.years;
    out.lastAdvancement = svc.from ? (svc.from + ' (' + svc.code + ')') : '';

    if (svc.years == null) {
      out.approximate.push('No advancement on record — service at step cannot be computed.');
      return out;
    }

    // ── Normative time: gates BOTH merit and promotion ──
    if (need != null) {
      out.normativeMet = svc.years >= need;
      if (!out.normativeMet) {
        out.reasons.push(rank + ' Step ' + step + ': ' + svc.years + '/' + need +
          ' yrs of service by ' + prospectiveISO + ' — normative time not yet met');
      }
    }

    if (out.normativeMet) {
      if (out.indefiniteStep) {
        out.mayElect = true;
        out.reasons.push(rank + ' Step ' + step + ': ' + svc.years + ' yrs served (normative ' +
          need + ') — may elect review; auto-called only at the 5-yr mandatory');
      } else {
        out.merit = true;
        out.reasons.push(rank + ' Step ' + step + ': ' + svc.years + ' yrs served (normative ' +
          need + ') → on Call for merit');
      }

      // ── Promotion: barrier/threshold step AND normative time served ──
      if (family === 'assistant') {
        if (step === 5) {
          out.promotion = true;
          out.reasons.push('Assistant Step 5 (barrier) with normative time served → promotion-eligible');
        } else if (step === 4) {
          out.promotion = true;
          out.reasons.push('Assistant Step 4 with normative time served → promotion-eligible');
        }
      } else if (family === 'associate') {
        if (step === 4) {
          out.promotion = true;
          out.reasons.push('Associate Step 4 (barrier) with normative time served → promotion-eligible');
        } else if (step === 3) {
          out.promotion = true;
          out.reasons.push('Associate Step 3 with normative time served → promotion-eligible');
        }
      }
    }

    // ── Mandatory review (5 yrs without ANY review) ──
    const anyReview = (p.history || []).filter(h => h.date)
      .reduce((a, b) => (!a || b.date > a.date ? b : a), null);
    if (anyReview) {
      const ys = _yearsBetween(anyReview.date, prospectiveISO);
      if (ys != null && ys >= 5) {
        out.mandatory = true;
        out.reasons.push('~' + ys.toFixed(1) + ' yrs since last review → MANDATORY review (cannot be deferred)');
      }
    }

    // A person with a pending action is always LISTED (flagged), even if the
    // pending reset means they are not otherwise anticipated — you need to see
    // that an in-flight action is the reason they're absent from the Call.
    out.anticipated = out.merit || out.promotion || out.mandatory || out.mayElect
      || !!out.pendingAction;
    return out;
  }

  /**
   * The anticipated-Call list: every ladder-rank ACTIVE faculty member with
   * what they are anticipated for on the upcoming Call, promotion-eligible
   * ones flagged (the external-letter cases). Service is computed from each
   * person's review history to the PROSPECTIVE advancement effective date.
   * @param {Object} payload - { prospectiveDate? ('yyyy-MM-dd') }
   */
  function listAnticipatedCandidates(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const prospective = String(p.prospectiveDate || '').trim() || _upcomingJuly1();

    // Full review history per person, one pass over the history tab.
    const histByEmail = {};
    DataService.getAll(SHEET(), HISTORY_TAB()).forEach(r => {
      const email = _email(r.PersonEmail);
      const d = _histDate(r.ReviewDate) || String(r.ReviewDate || '');
      if (!email || !d) return;
      (histByEmail[email] = histByEmail[email] || []).push({ date: d, code: String(r.ReviewCode || '').toUpperCase() });
    });

    // IN-PROGRESS cases: an action not yet final but carrying an anticipated
    // effective date — a PENDING clock reset. Keyed by candidate; if somehow
    // more than one, the latest effective date wins.
    const pendingByEmail = {};
    DataService.getAll(SHEET(), CASES_TAB()).forEach(r => {
      if (String(r.Status) !== 'in_progress') return;
      const email = _email(r.CandidateEmail);
      const eff = _histDate(r.EffectiveDate) || String(r.EffectiveDate || '');
      if (!email || !eff) return;
      const cur = pendingByEmail[email];
      if (!cur || eff > cur.effectiveDate) {
        pendingByEmail[email] = { effectiveDate: eff, reviewType: r.ReviewType || '', caseId: r.CaseID };
      }
    });

    // Active faculty only — departed people are never anticipated candidates.
    const roster = listRoster({ includeInactive: false }, user, roles).roster;
    const candidates = [];
    roster.forEach(person => {
      const history = histByEmail[person.email] || [];
      const elig = _computeEligibility({
        rank: person.rank, step: person.step, history: history,
        pendingAction: pendingByEmail[person.email] || null,
      }, prospective);
      if (!elig.anticipated) return;
      const types = [];
      if (elig.promotion) types.push('promotion');
      if (elig.merit) types.push('merit');
      if (elig.mayElect) types.push('may elect');
      if (elig.mandatory) types.push('mandatory');
      candidates.push({
        email: person.email, name: person.nameLastFirst || person.name,
        rank: person.rank, step: person.step,
        serviceYears: elig.serviceYears,
        normativeYears: elig.normativeYears,
        normativeMet: elig.normativeMet,
        lastAdvancement: elig.lastAdvancement,
        promotion: elig.promotion, merit: elig.merit,
        mayElect: elig.mayElect, mandatory: elig.mandatory,
        indefiniteStep: elig.indefiniteStep,
        pendingAction: elig.pendingAction,
        anticipatedFor: types.join(', ') || (elig.pendingAction ? 'pending action' : ''),
        reasons: elig.reasons,
        approximate: elig.approximate,
      });
    });

    candidates.sort((a, b) => {
      if (a.promotion !== b.promotion) return a.promotion ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });

    return {
      prospectiveDate: prospective,
      candidates: candidates,
      summary: {
        total: candidates.length,
        promotion: candidates.filter(c => c.promotion).length,
        merit: candidates.filter(c => c.merit).length,
        mayElect: candidates.filter(c => c.mayElect).length,
        mandatory: candidates.filter(c => c.mandatory).length,
        pending: candidates.filter(c => c.pendingAction).length,
      },
    };
  }

  // ============================================================
  // Anticipated Call — exports
  // ============================================================

  /** The rows an export renders, shared by both formats. */
  function _anticipatedExportRows(res) {
    const header = ['Faculty', 'Rank', 'Step', 'Service (yrs)', 'Normative (yrs)',
                    'Normative met', 'Anticipated for', 'Promotion-eligible',
                    'Last advancement', 'Notes'];
    const rows = (res.candidates || []).map(c => [
      c.name || '',
      c.rank || '',
      c.step || '',
      c.serviceYears == null ? '' : c.serviceYears,
      c.normativeYears == null ? '' : c.normativeYears,
      c.normativeMet ? 'yes' : 'no',
      c.anticipatedFor || '',
      c.promotion ? 'YES' : '',
      c.lastAdvancement || '',
      (c.reasons || []).join('; '),
    ]);
    return { header: header, rows: rows };
  }

  /**
   * Export the Anticipated Call to a new Google Sheet: bold frozen header,
   * promotion-eligible rows highlighted, columns auto-sized. Created in
   * CONFIG.PERSONNEL.EXPORT_FOLDER_ID when set, else the Drive root.
   * @param {Object} payload - { prospectiveDate? }
   * @returns { url, id, name, rowCount }
   */
  function exportAnticipatedToSheet(payload, user, roles) {
    _requireSuperAdmin(roles);
    const res = listAnticipatedCandidates(payload || {}, user, roles);
    const data = _anticipatedExportRows(res);
    if (!data.rows.length) throw new Error('No anticipated candidates to export.');

    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const name = 'Anticipated Call ' + res.prospectiveDate + ' (exported ' + stamp + ')';

    const ss = SpreadsheetApp.create(name);
    const sheet = ss.getSheets()[0];
    sheet.setName('Anticipated Call');

    // Title + context rows, then the table.
    const s = res.summary || {};
    sheet.getRange(1, 1).setValue('Anticipated Call — next advancement effective ' + res.prospectiveDate);
    sheet.getRange(1, 1).setFontWeight('bold').setFontSize(13);
    sheet.getRange(2, 1).setValue(
      s.total + ' anticipated · ' + s.promotion + ' promotion (external letters) · ' +
      s.merit + ' merit · ' + (s.mayElect || 0) + ' may elect · ' + s.mandatory + ' mandatory');
    sheet.getRange(2, 1).setFontColor('#666666');
    sheet.getRange(3, 1).setValue(
      'Service is counted from the last advancement\'s effective date to ' + res.prospectiveDate +
      '. Normative time gates both merit and promotion.');
    sheet.getRange(3, 1).setFontColor('#666666').setFontStyle('italic');

    const headerRow = 5;
    sheet.getRange(headerRow, 1, 1, data.header.length).setValues([data.header])
      .setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
    sheet.getRange(headerRow + 1, 1, data.rows.length, data.header.length).setValues(data.rows);

    // Highlight promotion-eligible rows (column 8 = 'Promotion-eligible').
    (res.candidates || []).forEach((c, i) => {
      if (c.promotion) {
        sheet.getRange(headerRow + 1 + i, 1, 1, data.header.length)
          .setBackground('#FFF4CC');   // soft gold
      }
    });

    sheet.setFrozenRows(headerRow);
    for (let c = 1; c <= data.header.length; c++) sheet.autoResizeColumn(c);

    // Move to the configured export folder when one is set.
    const folderId = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.EXPORT_FOLDER_ID) || '';
    if (folderId) {
      try {
        const file = DriveApp.getFileById(ss.getId());
        DriveApp.getFolderById(folderId).addFile(file);
        DriveApp.getRootFolder().removeFile(file);
      } catch (err) {
        Logger.log('Export folder move failed (left in Drive root): ' + err);
      }
    }

    return { url: ss.getUrl(), id: ss.getId(), name: name, rowCount: data.rows.length };
  }

  /**
   * Export the Anticipated Call as CSV text (opens in Excel or anything
   * else). Returned as a string; the client turns it into a download.
   * @param {Object} payload - { prospectiveDate? }
   * @returns { csv, filename, rowCount }
   */
  function exportAnticipatedToCsv(payload, user, roles) {
    _requireSuperAdmin(roles);
    const res = listAnticipatedCandidates(payload || {}, user, roles);
    const data = _anticipatedExportRows(res);
    if (!data.rows.length) throw new Error('No anticipated candidates to export.');

    const esc = v => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [data.header.map(esc).join(',')]
      .concat(data.rows.map(r => r.map(esc).join(',')));
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    return {
      csv: lines.join('\n'),
      filename: 'anticipated-call-' + res.prospectiveDate + '-' + stamp + '.csv',
      rowCount: data.rows.length,
    };
  }


  /**
   * Check a prospective case against the eligibility rules — powers the
   * add-case form's live guidance. Tells you whether the normative interval
   * is served, and therefore whether this review would be an ACCELERATION
   * (sought before the interval is complete), which is a distinct category.
   * Read-only.
   * @param {Object} payload - { email, prospectiveDate? }
   * @returns { rank, step, serviceYears, normativeYears, normativeMet,
   *            indefiniteStep, isAcceleration, lastAdvancement, summary }
   */
  function checkCaseEligibility(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const email = _email(p.email);
    if (!email) throw new Error('email is required.');
    const prospective = String(p.prospectiveDate || '').trim() || _upcomingJuly1();

    const person = listRoster({ includeInactive: true }, user, roles).roster
      .find(r => r.email === email);
    if (!person) throw new Error('No roster entry for ' + email + '.');

    const history = DataService.query(SHEET(), HISTORY_TAB(), 'PersonEmail', email)
      .map(r => ({ date: _histDate(r.ReviewDate) || String(r.ReviewDate || ''),
                   code: String(r.ReviewCode || '').toUpperCase() }))
      .filter(h => h.date);

    const elig = _computeEligibility({
      rank: person.rank, step: person.step, history: history,
    }, prospective);

    // An acceleration: a review sought BEFORE the normative interval is
    // complete. Not an error — just a distinct classification the person
    // adding the case should know they're creating.
    const isAcceleration = elig.serviceYears != null
      && elig.normativeYears != null
      && !elig.normativeMet;

    let summary;
    if (elig.serviceYears == null) {
      summary = 'No advancement on record — service at step cannot be computed.';
    } else if (isAcceleration) {
      summary = 'ACCELERATION: ' + elig.serviceYears + ' of ' + elig.normativeYears +
        ' years served at ' + person.rank + ' Step ' + person.step +
        '. A review sought before the normative interval is complete is classified as an acceleration in time.';
    } else if (elig.indefiniteStep) {
      summary = 'Normative time served (' + elig.serviceYears + '/' + elig.normativeYears +
        ') at an indefinite step — this faculty member may elect a review; they are only ' +
        'automatically called at the five-year mandatory.';
    } else {
      summary = 'Normative time served (' + elig.serviceYears + '/' + elig.normativeYears +
        ') — eligible for a normal review.';
    }

    return {
      email: email,
      name: person.nameLastFirst || person.name,
      rank: person.rank, step: person.step,
      serviceYears: elig.serviceYears,
      normativeYears: elig.normativeYears,
      normativeMet: elig.normativeMet,
      indefiniteStep: elig.indefiniteStep,
      isAcceleration: isAcceleration,
      lastAdvancement: elig.lastAdvancement,
      prospectiveDate: prospective,
      summary: summary,
    };
  }

  /**
   * Create a single case by hand — for reviews that don't come from the Call:
   * a faculty member at an indefinite step (Professor 5+) ELECTING a review,
   * an acceleration, or a correction to a missed Call entry. Identity comes
   * from the roster (no name-matching needed). CallActionRaw stays empty,
   * and IsElected marks it as elected rather than called.
   *
   * Upserts on (CandidateEmail, AcademicYear, ReviewType) like the Call
   * import, so adding the same case twice updates rather than duplicates.
   *
   * @param {Object} payload - { candidateEmail, academicYear, reviewType,
   *     subjectRank?, step?, status?, effectiveDate?, isElected?, notes? }
   */
  function createCase(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const email = _email(p.candidateEmail);
    if (!email) throw new Error('A candidate is required.');
    const year = String(p.academicYear || '').trim();
    if (!year) throw new Error('Academic year is required.');
    const type = String(p.reviewType || '').trim();
    if (!REVIEW_TYPES()[type]) throw new Error('Unknown review type: ' + type);

    const profile = Auth.getProfile(email);
    if (!profile) throw new Error('No profile for ' + email + '.');

    // Default rank/step from the roster when not supplied.
    const person = listRoster({ includeInactive: true }, user, roles).roster
      .find(r => r.email === email);
    const rank = String(p.subjectRank || (person ? person.rank : '') || '').trim();
    const step = String(p.step != null && p.step !== '' ? p.step
                       : (person ? person.step : '') || '').trim();

    const status = String(p.status || 'open').trim();
    if (STATUSES().indexOf(status) === -1) throw new Error('Unknown status: ' + status);

    const res = _upsertCase({
      candidateEmail: email,
      academicYear:   year,
      reviewType:     type,
      subjectRank:    rank,
      step:           step,
      callActionRaw:  '',                       // not from the Call
      oaFlag:         '',
      yrsRank:        person ? person.yrsRank : '',
      yrsStep:        person ? person.yrsStep : '',
      qtrs:           '',
      isReappointment: _isAssistantRank(rank),
      isMandatory:     false,
      isElected:       p.isElected !== false,   // manual cases are elected by default
      status:          status,
      effectiveDate:   String(p.effectiveDate || '').trim(),
      notes:           String(p.notes || '').trim(),
    }, user);

    return { caseId: res.caseId, action: res.action, candidateEmail: email,
             academicYear: year, reviewType: type };
  }


  // ============================================================
  // Phase 6 — Drafting assignments
  // ============================================================
  // A case is split into the pieces of the assessment that get written, and
  // each is assigned to a member of the Personnel Committee, who sees it in
  // their task queue with the drafts-due date the scheduler works out.
  //
  // Committee membership is NOT ours: the Service module owns committee
  // assignment and grants the personnel_committee role; we read the pool from
  // the platform (Auth.usersWithRole) and never write identity. Delivery goes
  // through the Tasks service — the task carries routing and a pointer back to
  // the component, never the work itself, so the two can't drift apart.

  function COMPONENTS_TAB()   { return CONFIG.TABS.COMPONENTS; }
  function COMPONENT_TYPES()  { return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.COMPONENT_TYPES) || {}; }
  function COMPONENTS_BY_SERIES() {
    return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.COMPONENTS_BY_SERIES) || {
      ladder: ['research', 'teaching_service'], teaching: ['combined'], lecturer: ['combined'],
    };
  }
  function COMMITTEE_ROLE()   { return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.COMMITTEE_ROLE) || 'personnel_committee'; }
  function DRAFT_TASK_CFG()   {
    return (CONFIG.PERSONNEL && CONFIG.PERSONNEL.DRAFT_TASK)
      || { sourceType: 'draft_component', staleAfterDays: 14 };
  }

  /** The series a rank belongs to, via the rank map. */
  function _seriesForRank(rank) {
    const mapped = _mapRank(rank);
    return mapped ? mapped.series : '';
  }

  /**
   * Generate the components for a case, if it hasn't got them. Which pieces a
   * case has depends on the candidate's series: the ladder is assessed on
   * research and on teaching/service separately; the teaching and lecturer
   * series are assessed as a whole. Idempotent — a component that already
   * exists is left alone, so this is safe to call whenever.
   *
   * Serialized under a script lock: case creation and the first open of the
   * drafting panel can run this nearly simultaneously, and without the lock
   * both pass the "doesn't exist yet" check before either row lands —
   * producing duplicate components (observed in the wild). If the lock can't
   * be had, we skip generation rather than risk the race; the next caller
   * will generate.
   * @returns { created: [types], existing: [types], series }
   */
  function _ensureComponents(caseRow, user) {
    const series = _seriesForRank(caseRow.SubjectRank);
    const want = COMPONENTS_BY_SERIES()[series] || [];
    const out = { created: [], existing: [], series: series };
    if (!want.length) return out;

    let lock = null;
    try {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(5000)) {
        Logger.log('_ensureComponents: lock busy for ' + caseRow.CaseID + ' — skipping (next caller generates).');
        return out;
      }
    } catch (err) {
      lock = null;   // lock service unavailable — proceed unserialized
    }

    try {
      const have = DataService.query(SHEET(), COMPONENTS_TAB(), 'CaseID', caseRow.CaseID);
      const haveTypes = have.map(c => String(c.ComponentType));

      want.forEach(type => {
        if (haveTypes.indexOf(type) !== -1) { out.existing.push(type); return; }
        DataService.insert(SHEET(), COMPONENTS_TAB(), {
          ComponentID:   DataService.generateId('CMP'),
          CaseID:        caseRow.CaseID,
          ComponentType: type,
          AssignedTo:    '',
          Status:        'unassigned',
        });
        out.created.push(type);
      });
    } finally {
      if (lock) { try { lock.releaseLock(); } catch (e) {} }
    }
    return out;
  }

  /**
   * Self-heal duplicate components on a case: where several rows share the
   * same (CaseID, ComponentType), keep the one carrying the most work and
   * DELETE the surplus — but only surplus that is provably empty (unassigned,
   * no assignee, no task, no draft), so nothing anyone did can be lost. A
   * duplicate that has real state on both rows is left alone and reported
   * instead: that needs a human, not a script.
   * @returns { removed: n, conflicts: [types] }
   */
  function _dedupeComponents(caseId) {
    const rows = DataService.query(SHEET(), COMPONENTS_TAB(), 'CaseID', caseId);
    const byType = {};
    rows.forEach(r => (byType[String(r.ComponentType)] = byType[String(r.ComponentType)] || []).push(r));

    const removed = [], conflicts = [];
    Object.keys(byType).forEach(type => {
      const group = byType[type];
      if (group.length < 2) return;

      // Rank rows by how much real state they carry.
      const weight = r =>
        (String(r.Status) === 'drafted' ? 4 : 0) +
        (_email(r.AssignedTo) ? 2 : 0) +
        (String(r.TaskID || '') ? 1 : 0);
      group.sort((a, b) => weight(b) - weight(a));

      const keep = group[0];
      group.slice(1).forEach(r => {
        if (weight(r) === 0) {
          removed.push(r.ComponentID);
        } else {
          // Both rows carry state — deleting either could lose work.
          conflicts.push(type + ' (' + keep.ComponentID + ' vs ' + r.ComponentID + ')');
        }
      });
    });

    // Physical deletion, bottom-up so row indices stay valid.
    if (removed.length) {
      try {
        const sheet = SpreadsheetApp.openById(SHEET()).getSheetByName(COMPONENTS_TAB());
        const data = sheet.getDataRange().getValues();
        const idCol = data[0].indexOf('ComponentID');
        for (let i = data.length - 1; i >= 1; i--) {
          if (removed.indexOf(data[i][idCol]) !== -1) sheet.deleteRow(i + 1);
        }
        Logger.log('_dedupeComponents: removed ' + removed.length + ' empty duplicate(s) on ' + caseId);
      } catch (err) {
        Logger.log('_dedupeComponents: deletion failed for ' + caseId + ': ' + err);
        return { removed: 0, conflicts: conflicts };
      }
    }
    return { removed: removed.length, conflicts: conflicts };
  }

  /**
   * The people who may be assigned drafting work: holders of the
   * personnel_committee role. The Service module maintains that role when it
   * assigns the committee; we only read it.
   */
  function listCommitteeMembers(payload, user, roles) {
    _requireSuperAdmin(roles);
    let members = [];
    try {
      members = Auth.usersWithRole(COMMITTEE_ROLE()) || [];
    } catch (err) {
      Logger.log('listCommitteeMembers: ' + err);
    }
    return {
      role: COMMITTEE_ROLE(),
      members: members,
      empty: !members.length,
      hint: members.length ? '' :
        'Nobody holds the ' + COMMITTEE_ROLE() + ' role yet. The Personnel Committee is assigned in the Service module, which grants the role.',
    };
  }

  /**
   * A case's components, with assignee names resolved and the drafts-due date
   * the schedule works out (so the UI can show what deadline an assignment
   * would carry before anyone commits to it).
   * @param {Object} payload - { caseId }
   */
  function listCaseComponents(payload, user, roles) {
    _requireSuperAdmin(roles);
    const id = String((payload || {}).caseId || '').trim();
    if (!id) throw new Error('caseId is required.');

    const found = DataService.query(SHEET(), CASES_TAB(), 'CaseID', id);
    if (!found.length) throw new Error('Case not found: ' + id);
    const c = found[0];

    // Generate on demand — a case made before components existed still gets
    // them the first time anyone looks.
    const gen = _ensureComponents(c, user);

    // Self-heal any duplicate rows (the pre-lock race left some behind).
    const dedupe = _dedupeComponents(id);

    const types = COMPONENT_TYPES();
    const rows = DataService.query(SHEET(), COMPONENTS_TAB(), 'CaseID', id).map(r => {
      const assignee = _email(r.AssignedTo);
      const profile = assignee ? Auth.getProfile(assignee) : null;
      return {
        componentId:   r.ComponentID,
        caseId:        r.CaseID,
        componentType: r.ComponentType,
        label:         (types[r.ComponentType] && types[r.ComponentType].label) || r.ComponentType,
        assignedTo:    assignee,
        assignedName:  profile ? (profile.nameLastFirst || profile.name) : assignee,
        status:        r.Status || 'unassigned',
        dueAt:         _histDate(r.DueAt) || String(r.DueAt || ''),
        taskId:        r.TaskID || '',
        draftedAt:     _histDate(r.DraftedAt) || String(r.DraftedAt || ''),
        notes:         r.Notes || '',
      };
    });

    // What deadline an assignment would carry, from the case's schedule.
    let draftsDue = '', scheduleWarnings = [];
    try {
      const sch = computeScheduleForCase({ caseId: id }, user, roles);
      draftsDue = sch.effectiveDraftsDue
        || (sch.schedule && sch.schedule.backward && sch.schedule.backward.draftsDue) || '';
      scheduleWarnings = sch.warnings || [];
    } catch (err) {
      scheduleWarnings = ['The drafting deadline could not be worked out: ' + err.message];
    }

    const profile = Auth.getProfile(_email(c.CandidateEmail));
    return {
      caseId: id,
      candidate: profile ? (profile.nameLastFirst || profile.name) : c.CandidateEmail,
      reviewType: c.ReviewType,
      academicYear: c.AcademicYear,
      series: gen.series,
      components: rows,
      draftsDue: draftsDue,
      scheduleWarnings: scheduleWarnings,
      seriesWarning: gen.series ? '' :
        'The candidate\'s rank (' + (c.SubjectRank || '—') + ') doesn\'t map to a series, so no components could be generated.',
      duplicateWarning: dedupe.conflicts.length
        ? 'Duplicate components with real work on both copies: ' + dedupe.conflicts.join('; ') +
          '. Resolve by hand in the Components tab — nothing was deleted.'
        : '',
    };
  }

  /**
   * Assign a component to a committee member, and put it in their queue.
   *
   * The task carries the drafts-due date and points back at the component;
   * reassigning resolves the old task and creates a new one, so nobody is left
   * holding work that isn't theirs. Assigning to '' clears the assignment and
   * resolves the task.
   *
   * @param {Object} payload - { componentId, assignedTo, dueAt? }
   */
  function assignComponent(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const id = String(p.componentId || '').trim();
    if (!id) throw new Error('componentId is required.');

    const found = DataService.query(SHEET(), COMPONENTS_TAB(), 'ComponentID', id);
    if (!found.length) throw new Error('Component not found: ' + id);
    const comp = found[0];

    const assignee = _email(p.assignedTo);
    const cfg = DRAFT_TASK_CFG();

    // Clear any existing task first — whether we're reassigning or unassigning,
    // the old one is now wrong.
    if (comp.TaskID) {
      try { Tasks.resolve(comp.TaskID, { resolvedBy: user, note: 'Reassigned' }); }
      catch (err) { Logger.log('assignComponent: could not resolve old task: ' + err); }
    }

    // Unassign.
    if (!assignee) {
      DataService.update(SHEET(), COMPONENTS_TAB(), 'ComponentID', id, {
        AssignedTo: '', AssignedAt: '', AssignedBy: '',
        Status: 'unassigned', TaskID: '', DueAt: '',
      });
      return { componentId: id, status: 'unassigned' };
    }

    // The pool is the committee — assigning outside it would be a mistake, not
    // a choice.
    const pool = (Auth.usersWithRole(COMMITTEE_ROLE()) || []).map(m => _email(m.email));
    if (pool.indexOf(assignee) === -1) {
      throw new Error('Only members of the Personnel Committee can be assigned drafting work. '
        + (pool.length ? '' : 'Nobody holds the ' + COMMITTEE_ROLE() + ' role yet.'));
    }

    // The deadline: whatever the caller supplies, else the schedule's
    // drafts-due date.
    let dueAt = String(p.dueAt || '').trim();
    if (!dueAt) {
      try {
        const sch = computeScheduleForCase({ caseId: comp.CaseID }, user, roles);
        // The working date: a proposed drafts-due wins over the computed one.
        dueAt = sch.effectiveDraftsDue
          || (sch.schedule && sch.schedule.backward && sch.schedule.backward.draftsDue) || '';
      } catch (err) {
        Logger.log('assignComponent: no schedule for case ' + comp.CaseID + ': ' + err);
      }
    }

    // What the assignee will see in their queue.
    const caseRows = DataService.query(SHEET(), CASES_TAB(), 'CaseID', comp.CaseID);
    const c = caseRows.length ? caseRows[0] : {};
    const candidate = Auth.getProfile(_email(c.CandidateEmail));
    const types = COMPONENT_TYPES();
    const typeLabel = (types[comp.ComponentType] && types[comp.ComponentType].label) || comp.ComponentType;
    const label = 'Draft the ' + typeLabel.toLowerCase() + ' assessment — '
      + (candidate ? (candidate.nameLastFirst || candidate.name) : c.CandidateEmail)
      + ' (' + (c.ReviewType || 'review') + ', ' + (c.AcademicYear || '') + ')';

    let taskId = '';
    try {
      const t = Tasks.create({
        module:     'personnel',
        sourceType: cfg.sourceType,
        sourceId:   id,                 // the component — resolving is unambiguous
        label:      label,
        assignedTo: assignee,
        dueAt:      dueAt || undefined,
        staleAfterDays: cfg.staleAfterDays,
      });
      taskId = t.taskId;
    } catch (err) {
      // The assignment is real even if the queue entry failed; say so rather
      // than pretending the whole thing worked.
      Logger.log('assignComponent: Tasks.create failed: ' + err);
    }

    DataService.update(SHEET(), COMPONENTS_TAB(), 'ComponentID', id, {
      AssignedTo: assignee,
      AssignedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      AssignedBy: user,
      Status:     'assigned',
      DueAt:      dueAt,
      TaskID:     taskId,
    });

    return {
      componentId: id, status: 'assigned', assignedTo: assignee,
      dueAt: dueAt, taskId: taskId,
      warning: taskId ? '' : 'Assigned, but the task could not be added to their queue.',
    };
  }

  /**
   * Mark a component drafted — the work is done. Resolves the task, so it
   * leaves the assignee's queue. The assignee themself may do this, as well as
   * a super admin.
   * @param {Object} payload - { componentId, notes? }
   */
  function markComponentDrafted(payload, user, roles) {
    const p = payload || {};
    const id = String(p.componentId || '').trim();
    if (!id) throw new Error('componentId is required.');

    const found = DataService.query(SHEET(), COMPONENTS_TAB(), 'ComponentID', id);
    if (!found.length) throw new Error('Component not found: ' + id);
    const comp = found[0];

    // The person who owes the draft can mark it done; so can a super admin.
    const isAssignee = _email(comp.AssignedTo) === _email(user);
    if (!isAssignee && (roles || []).indexOf('super_admin') === -1) {
      throw new Error('Only the assignee or a super admin can mark this drafted.');
    }

    const fields = {
      Status:    'drafted',
      DraftedAt: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      DraftedBy: user,
    };
    if (p.notes !== undefined) fields.Notes = String(p.notes || '').trim();
    DataService.update(SHEET(), COMPONENTS_TAB(), 'ComponentID', id, fields);

    // The work is done, so the task should go — the queue never outlives it.
    try { Tasks.resolveForSource('personnel', id, { resolvedBy: user }); }
    catch (err) { Logger.log('markComponentDrafted: could not resolve task: ' + err); }

    return { componentId: id, status: 'drafted' };
  }

  /**
   * Reopen a drafted component — the draft needs more work. Puts it back in
   * the assignee's queue.
   * @param {Object} payload - { componentId }
   */
  function reopenComponent(payload, user, roles) {
    _requireSuperAdmin(roles);
    const id = String((payload || {}).componentId || '').trim();
    if (!id) throw new Error('componentId is required.');
    const found = DataService.query(SHEET(), COMPONENTS_TAB(), 'ComponentID', id);
    if (!found.length) throw new Error('Component not found: ' + id);
    const comp = found[0];

    if (!_email(comp.AssignedTo)) {
      throw new Error('This component has no assignee to reopen it for.');
    }
    // Re-assigning to the same person rebuilds the task cleanly.
    return assignComponent({ componentId: id, assignedTo: comp.AssignedTo, dueAt: comp.DueAt },
                           user, roles);
  }


  /**
   * The committee's drafting workload — one row per member, so the assigner
   * can see at a glance whether the work is balanced. Every role-holder
   * appears, including those with nothing assigned: an empty plate is what
   * imbalance looks like. Major reviews (promotion, mid-career) are counted
   * separately from minor ones — two merit drafts are not two promotion
   * drafts.
   * @param {Object} payload - { academicYear? — restrict to one cycle }
   */
  function committeeWorkload(payload, user, roles) {
    _requireSuperAdmin(roles);
    const year = String((payload || {}).academicYear || '').trim();

    // Which cases are in scope, and which of them are major reviews.
    const types = REVIEW_TYPES();
    const caseById = {};
    DataService.getAll(SHEET(), CASES_TAB()).forEach(c => {
      if (year && String(c.AcademicYear).trim() !== year) return;
      const t = types[String(c.ReviewType)] || {};
      caseById[c.CaseID] = {
        candidateEmail: _email(c.CandidateEmail),
        reviewType: c.ReviewType,
        major: !!t.major,
        academicYear: c.AcademicYear,
      };
    });

    // Tally the components of in-scope cases per assignee.
    const perMember = {};   // email -> tallies
    let unassigned = 0, unassignedMajor = 0;
    const blank = () => ({ assigned: 0, drafted: 0, major: 0, minor: 0, dueSoonest: '' });

    DataService.getAll(SHEET(), COMPONENTS_TAB()).forEach(comp => {
      const c = caseById[comp.CaseID];
      if (!c) return;                                  // out of scope
      const who = _email(comp.AssignedTo);
      const status = String(comp.Status || 'unassigned');

      if (!who || status === 'unassigned') {
        unassigned++;
        if (c.major) unassignedMajor++;
        return;
      }
      const m = (perMember[who] = perMember[who] || blank());
      if (status === 'drafted') m.drafted++; else m.assigned++;
      if (c.major) m.major++; else m.minor++;
      const due = _histDate(comp.DueAt) || '';
      // The nearest deadline still OWED — drafted work has no pull left.
      if (due && status !== 'drafted' && (!m.dueSoonest || due < m.dueSoonest)) {
        m.dueSoonest = due;
      }
    });

    // Every role-holder appears, workload or not.
    let pool = [];
    try { pool = Auth.usersWithRole(COMMITTEE_ROLE()) || []; }
    catch (err) { Logger.log('committeeWorkload: ' + err); }
    const inPool = {};
    pool.forEach(m => { inPool[_email(m.email)] = m.name; });

    // Someone with assignments who has LEFT the committee still owes them —
    // show them, marked, rather than letting their load vanish.
    Object.keys(perMember).forEach(email => {
      if (!inPool[email]) {
        const p = Auth.getProfile(email);
        inPool[email] = (p ? (p.nameLastFirst || p.name) : email) + ' (no longer on the committee)';
      }
    });

    const rows = Object.keys(inPool).map(email => {
      const m = perMember[email] || blank();
      return {
        email: email,
        name: inPool[email],
        assigned: m.assigned,
        drafted: m.drafted,
        total: m.assigned + m.drafted,
        major: m.major,
        minor: m.minor,
        dueSoonest: m.dueSoonest,
      };
    });
    // Heaviest open load first — the balance question reads top-to-bottom.
    rows.sort((a, b) => (b.assigned - a.assigned) || (b.total - a.total)
      || String(a.name).localeCompare(String(b.name)));

    return {
      academicYear: year || 'all years',
      members: rows,
      unassigned: unassigned,
      unassignedMajor: unassignedMajor,
      poolEmpty: !pool.length,
    };
  }

  /**
   * The assignment roster, case by case — the complement of the workload's
   * member-by-member view. One row per in-scope case, with who is drafting
   * each part, so the assigner can see at a glance whether every candidate is
   * fully covered. Cases with unassigned parts sort to the top: they are what
   * needs attention.
   * @param {Object} payload - { academicYear? — restrict to one cycle }
   */
  function caseAssignments(payload, user, roles) {
    _requireSuperAdmin(roles);
    const year = String((payload || {}).academicYear || '').trim();
    const types = COMPONENT_TYPES();

    // Components grouped by case. Duplicates from the pre-lock race are
    // collapsed IN MEMORY here (keep the row carrying the most work) so the
    // roster never shows a ghost 'unassigned' beside a real assignment; the
    // physical rows are healed when the case's drafting panel next opens.
    const byCase = {};
    DataService.getAll(SHEET(), COMPONENTS_TAB()).forEach(comp => {
      (byCase[comp.CaseID] = byCase[comp.CaseID] || []).push(comp);
    });
    const stateWeight = r =>
      (String(r.Status) === 'drafted' ? 4 : 0) +
      (_email(r.AssignedTo) ? 2 : 0) +
      (String(r.TaskID || '') ? 1 : 0);
    Object.keys(byCase).forEach(cid => {
      const best = {};
      byCase[cid].forEach(r => {
        const t = String(r.ComponentType);
        if (!best[t] || stateWeight(r) > stateWeight(best[t])) best[t] = r;
      });
      byCase[cid] = Object.keys(best).map(t => best[t]);
    });

    // Names for assignees, resolved once each.
    const nameCache = {};
    const nameOf = email => {
      if (!email) return '';
      if (nameCache[email] === undefined) {
        const p = Auth.getProfile(email);
        nameCache[email] = p ? (p.nameLastFirst || p.name) : email;
      }
      return nameCache[email];
    };

    const rows = [];
    DataService.getAll(SHEET(), CASES_TAB()).forEach(c => {
      if (year && String(c.AcademicYear).trim() !== year) return;
      // Terminal cases don't need drafters; keep the roster about live work.
      const status = String(c.Status || 'open');
      if (status === 'closed' || status === 'deferred' || status === 'completed') return;

      const comps = (byCase[c.CaseID] || []).map(comp => ({
        componentId: comp.ComponentID,
        type: comp.ComponentType,
        label: (types[comp.ComponentType] && types[comp.ComponentType].label) || comp.ComponentType,
        assignedTo: _email(comp.AssignedTo),
        assignedName: nameOf(_email(comp.AssignedTo)),
        status: String(comp.Status || 'unassigned'),
      }));
      comps.sort((a, b) => String(a.type).localeCompare(String(b.type)));

      const unassignedCount = comps.filter(x => !x.assignedTo || x.status === 'unassigned').length;
      const candidate = nameOf(_email(c.CandidateEmail)) || c.CandidateEmail;

      rows.push({
        caseId: c.CaseID,
        candidate: candidate,
        reviewType: c.ReviewType,
        academicYear: c.AcademicYear,
        caseStatus: status,
        components: comps,
        // A case with no components at all (unmapped rank) is also "not
        // covered" — surface it, don't hide it.
        noComponents: !comps.length,
        unassignedCount: comps.length ? unassignedCount : 1,
        fullyAssigned: comps.length > 0 && unassignedCount === 0,
        allDrafted: comps.length > 0 && comps.every(x => x.status === 'drafted'),
      });
    });

    // Needs-attention first, then by candidate.
    rows.sort((a, b) => (b.unassignedCount - a.unassignedCount)
      || String(a.candidate).localeCompare(String(b.candidate)));

    return {
      academicYear: year || 'all years',
      cases: rows,
      total: rows.length,
      fullyAssigned: rows.filter(r => r.fullyAssigned).length,
    };
  }

  /**
   * Export the committee workload report to a Google Sheet — one workbook,
   * two sheets: "Workload" (member by member) and "Assignments" (case by
   * case), so a single shareable artifact answers both balance questions.
   * Lands in EXPORT_FOLDER_ID when set.
   * @param {Object} payload - { academicYear? }
   */
  function exportWorkloadToSheet(payload, user, roles) {
    _requireSuperAdmin(roles);
    const rep = committeeWorkload(payload || {}, user, roles);
    if (!rep.members.length) throw new Error('Nothing to export — the committee is empty.');

    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const name = 'Committee workload — ' + rep.academicYear + ' (exported ' + stamp + ')';
    const ss = SpreadsheetApp.create(name);
    const sheet = ss.getSheets()[0];
    sheet.setName('Workload');

    sheet.getRange(1, 1).setValue('Personnel Committee drafting workload — ' + rep.academicYear)
      .setFontWeight('bold').setFontSize(13);
    sheet.getRange(2, 1).setValue(
      rep.unassigned + ' component(s) still unassigned' +
      (rep.unassignedMajor ? ' (' + rep.unassignedMajor + ' from major reviews)' : ''))
      .setFontColor('#666666');

    const header = ['Member', 'Open drafts', 'Drafted', 'Total', 'Major reviews', 'Minor reviews', 'Nearest deadline'];
    const headerRow = 4;
    sheet.getRange(headerRow, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
    const data = rep.members.map(m =>
      [m.name, m.assigned, m.drafted, m.total, m.major, m.minor, m.dueSoonest || '']);
    sheet.getRange(headerRow + 1, 1, data.length, header.length).setValues(data);
    sheet.setFrozenRows(headerRow);
    for (let c = 1; c <= header.length; c++) sheet.autoResizeColumn(c);

    // Second sheet: the roster, case by case, so the same workbook answers
    // "is the load balanced?" AND "is every candidate covered?".
    const roster = caseAssignments(payload || {}, user, roles);
    const aSheet = ss.insertSheet('Assignments');
    aSheet.getRange(1, 1).setValue('Drafting assignments by candidate — ' + roster.academicYear)
      .setFontWeight('bold').setFontSize(13);
    aSheet.getRange(2, 1).setValue(roster.fullyAssigned + ' of ' + roster.total + ' case(s) fully assigned')
      .setFontColor('#666666');

    const aHeader = ['Candidate', 'Review type', 'Part of the assessment', 'Drafted by', 'Status'];
    const aHeaderRow = 4;
    aSheet.getRange(aHeaderRow, 1, 1, aHeader.length).setValues([aHeader])
      .setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');

    const aData = [];
    const separatorRows = [];   // sheet-relative offsets to shade
    roster.cases.forEach(r => {
      if (r.noComponents) {
        aData.push([r.candidate, r.reviewType, '(no components — rank not mapped)', '', '']);
      } else {
        r.components.forEach((comp, i) => {
          aData.push([
            i === 0 ? r.candidate : '',          // candidate once per case
            i === 0 ? r.reviewType : '',
            comp.label,
            comp.assignedName || 'UNASSIGNED',
            comp.status,
          ]);
        });
      }
      // A shaded blank row after each case, so every candidate reads as a
      // block when scanned.
      separatorRows.push(aData.length);
      aData.push(['', '', '', '', '']);
    });
    if (aData.length) {
      aSheet.getRange(aHeaderRow + 1, 1, aData.length, aHeader.length).setValues(aData);
      // Shade the separators.
      separatorRows.forEach(i => {
        aSheet.getRange(aHeaderRow + 1 + i, 1, 1, aHeader.length).setBackground('#EFEFEF');
      });
      // Make the gaps loud in the export too.
      for (let i = 0; i < aData.length; i++) {
        if (aData[i][3] === 'UNASSIGNED') {
          aSheet.getRange(aHeaderRow + 1 + i, 4).setFontColor('#B3261E').setFontWeight('bold');
        }
      }
    }
    aSheet.setFrozenRows(aHeaderRow);
    for (let c = 1; c <= aHeader.length; c++) aSheet.autoResizeColumn(c);

    const folderId = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.EXPORT_FOLDER_ID) || '';
    if (folderId) {
      try {
        const file = DriveApp.getFileById(ss.getId());
        DriveApp.getFolderById(folderId).addFile(file);
        DriveApp.getRootFolder().removeFile(file);
      } catch (err) { Logger.log('Workload export folder move failed: ' + err); }
    }
    return { url: ss.getUrl(), name: name, rowCount: data.length };
  }


  /**
   * The steps a date may be proposed against — the department's own process
   * dates. Two things are deliberately absent because they are SET BY POLICY,
   * not by the department:
   *   · the division submission deadline (the Division's date), and
   *   · the candidate's review of the file before submission (the mandatory
   *     window, derived from the submission date — it moves only if the
   *     Division's date moves).
   * The flexible dates still carry one policy parameter, enforced in
   * proposeDate(): the candidate's review of added material (external
   * letters) must COMPLETE before the faculty vote.
   */
  const PROPOSABLE_STEPS = ['draftsDue', 'deliberateBy', 'vote', 'letterFinal'];

  /**
   * Propose (or clear) a working date for one step of a cycle's timeline.
   * The computed date remains the visible baseline; the proposal is what the
   * department actually schedules around — most consequentially, a proposed
   * draftsDue flows into the task deadline when a component is assigned.
   * @param {Object} payload - { academicYear, timeline: 'merit'|'major',
   *                             step, date ('' clears the proposal) }
   */
  function proposeDate(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const year = String(p.academicYear || '').trim();
    if (!year) throw new Error('academicYear is required.');
    const timeline = String(p.timeline || '').trim();
    if (timeline !== 'merit' && timeline !== 'major') {
      throw new Error('timeline must be "merit" or "major".');
    }
    const step = String(p.step || '').trim();
    if (PROPOSABLE_STEPS.indexOf(step) === -1) {
      if (step === 'submission') {
        throw new Error('The division submission deadline is immutable — it cannot be proposed against.');
      }
      if (step === 'lateReviewStart' || step === 'lateReviewEnd') {
        throw new Error('The candidate\'s review of the file before submission is set by policy — it moves only if the Division\'s deadline moves.');
      }
      throw new Error('Unknown step: ' + step);
    }
    const date = String(p.date || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('Dates are yyyy-mm-dd.');
    }

    // Policy parameter: the candidate reviews material added to the file
    // (external letters) BEFORE the faculty acts on it. On the major
    // timeline, a vote — and the deliberation leading to it — cannot precede
    // the end of that review window.
    if (date && timeline === 'major' && (step === 'vote' || step === 'deliberateBy')) {
      try {
        const sch = computeCycleSchedule({ academicYear: year }, user, roles);
        const maj = sch.schedules && sch.schedules.major && sch.schedules.major.schedule;
        const f = maj && maj.forward;
        if (f && f.earlyReviewEnd && date <= f.earlyReviewEnd) {
          throw new Error('The candidate reviews the external letters through ' + f.earlyReviewEnd +
            ' — by policy the ' + (step === 'vote' ? 'faculty vote' : 'deliberation') +
            ' cannot precede the end of that review. Propose a later date.');
        }
      } catch (err) {
        // Re-throw the policy rejection; anything else (schedule couldn't be
        // computed) should not block a proposal.
        if (String(err.message || '').indexOf('cannot precede') !== -1) throw err;
        Logger.log('proposeDate: policy check skipped: ' + err);
      }
    }

    const rows = DataService.query(SHEET(), CYCLES_TAB(), 'AcademicYear', year);
    if (!rows.length) throw new Error('No cycle on file for ' + year + ' — load it in the Calendar tab first.');
    const row = rows[0];

    let proposed = {};
    try { proposed = JSON.parse(row.ProposedDates || '{}') || {}; } catch (e) {}
    proposed[timeline] = proposed[timeline] || {};
    if (date) proposed[timeline][step] = date;
    else delete proposed[timeline][step];
    if (!Object.keys(proposed[timeline]).length) delete proposed[timeline];

    DataService.update(SHEET(), CYCLES_TAB(), 'CycleID', row.CycleID, {
      ProposedDates: Object.keys(proposed).length ? JSON.stringify(proposed) : '',
    });
    return { academicYear: year, timeline: timeline, step: step,
             date: date, proposedDates: proposed };
  }


  /**
   * Export the cycle's schedule to a Google Sheet — both timelines, each with
   * the computed baseline and the proposed working dates side by side, in the
   * same order as the on-screen table. Policy-fixed rows are marked. Lands in
   * EXPORT_FOLDER_ID when set.
   * @param {Object} payload - { academicYear }
   */
  function exportCycleScheduleToSheet(payload, user, roles) {
    _requireSuperAdmin(roles);
    const year = String((payload || {}).academicYear || '').trim();
    if (!year) throw new Error('academicYear is required.');
    const rep = computeCycleSchedule({ academicYear: year }, user, roles);
    if (!rep.schedules) throw new Error('Nothing to export — no schedule could be computed: '
      + (rep.warnings || []).join(' '));

    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const name = 'Cycle schedule — ' + year + ' (exported ' + stamp + ')';
    const ss = SpreadsheetApp.create(name);
    const sheet = ss.getSheets()[0];
    sheet.setName('Schedule');

    sheet.getRange(1, 1).setValue('Review cycle schedule — ' + year)
      .setFontWeight('bold').setFontSize(13);
    sheet.getRange(2, 1).setValue(
      'Computed dates are the scheduler\'s baseline; proposed dates are the department\'s working plan. ' +
      'Rows marked "set by policy" are not the department\'s to move.')
      .setFontColor('#666666').setFontStyle('italic');

    const POLICY = '— set by policy';
    // One section per timeline, mirroring the on-screen row order.
    const sectionRows = (label, sch, proposals, isPromotion) => {
      const b = sch.backward || {};
      const f = sch.forward || null;
      const p = proposals || {};
      const rows = [];
      if (isPromotion && f) {
        rows.push(['External letters due', f.lettersDue || '', '',
          f.basis === 'actual' ? 'Letters actually arrived ' + (f.lettersAdded || '') : 'Planned; buffer absorbs late letters']);
        rows.push(['Candidate reviews the letters (opens)', f.earlyReviewStart || '', '', 'Set by policy — 10 business days']);
        rows.push(['Candidate review of letters closes', f.earlyReviewEnd || '', '', 'Set by policy']);
        rows.push(['Committee may begin deliberating', f.earliestDeliberate || '', '', 'Earliest possible']);
      }
      rows.push(['Drafts complete',                       b.draftsDue || '',       p.draftsDue || '',   'Assessments written']);
      rows.push(['Deliberation underway by',              b.deliberateBy || '',    p.deliberateBy || '', '']);
      rows.push(['Faculty vote',                          b.vote || '',            p.vote || '',        '']);
      rows.push(['Final letter complete, votes recorded', b.letterFinal || '',     p.letterFinal || '', '']);
      rows.push(['Candidate reviews the file (opens)',    b.lateReviewStart || '', POLICY,              'Set by policy — 10 business days']);
      rows.push(['Candidate review closes',               b.lateReviewEnd || '',   POLICY,              'Set by policy']);
      rows.push(['File due to the Division',              b.submission || '',      POLICY,              'The Division\'s deadline — immutable']);
      return { label: label, feasible: sch.feasible !== false, warnings: sch.warnings || [], rows: rows };
    };

    const sections = [];
    const props = rep.proposedDates || {};
    const mer = rep.schedules.merit && rep.schedules.merit.schedule;
    const maj = rep.schedules.major && rep.schedules.major.schedule;
    if (mer) sections.push(sectionRows('Merit & salary-increase files', mer, props.merit, false));
    if (maj) sections.push(sectionRows('Promotion & mid-career files (external letters)', maj, props.major, !!maj.forward));

    let row = 4;
    const header = ['Step', 'Computed', 'Proposed', 'Notes'];
    sections.forEach(sec => {
      sheet.getRange(row, 1).setValue(sec.label + (sec.feasible ? '' : ' — DOES NOT FIT'))
        .setFontWeight('bold').setFontSize(11.5)
        .setFontColor(sec.feasible ? '#003C6C' : '#B3261E');
      row++;
      if (sec.warnings.length) {
        sheet.getRange(row, 1).setValue(sec.warnings.join(' ')).setFontColor('#8a6d00').setFontStyle('italic');
        row++;
      }
      sheet.getRange(row, 1, 1, header.length).setValues([header])
        .setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
      row++;
      sheet.getRange(row, 1, sec.rows.length, header.length).setValues(sec.rows);
      // Gold-tint the proposed cells that carry real proposals.
      sec.rows.forEach((r, i) => {
        if (r[2] && r[2] !== POLICY) {
          sheet.getRange(row + i, 3).setBackground('#FFF4CC').setFontWeight('bold');
        } else if (r[2] === POLICY) {
          sheet.getRange(row + i, 3).setFontColor('#999999').setFontStyle('italic');
        }
      });
      row += sec.rows.length + 1;   // blank row between sections
    });

    for (let c = 1; c <= header.length; c++) sheet.autoResizeColumn(c);

    const folderId = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.EXPORT_FOLDER_ID) || '';
    if (folderId) {
      try {
        const file = DriveApp.getFileById(ss.getId());
        DriveApp.getFolderById(folderId).addFile(file);
        DriveApp.getRootFolder().removeFile(file);
      } catch (err) { Logger.log('Cycle schedule export folder move failed: ' + err); }
    }
    return { url: ss.getUrl(), name: name };
  }


  // ============================================================
  // Phase 7 — Communications (drafting workbench)
  // ============================================================
  // Drafts the module can write better than a human starting from blank:
  // assignment notices merged per committee member, the cycle schedule, and
  // policy notices. Every draft is EDITED BY A HUMAN before it goes anywhere
  // — this is a workbench, not an autoresponder. Delivery is either through
  // the platform's Notify service or copied into the sender's own client;
  // both paths land in the CommunicationsLog, so "did we tell them?" stays
  // answerable.

  function COMM_LOG_TAB() { return CONFIG.TABS.COMMUNICATIONS_LOG; }
  const COMM_KINDS = ['assignments', 'schedule', 'policy'];

  /** The template for a kind: the CONFIG default overlaid with any Settings-tab override. */
  function _commTemplate(kind) {
    const defaults = ((CONFIG.PERSONNEL && CONFIG.PERSONNEL.COMM_TEMPLATES) || {})[kind] || {};
    const out = { label: defaults.label || kind, subject: defaults.subject || '', body: defaults.body || '' };
    try {
      DataService.getAll(SHEET(), SETTINGS_TAB()).forEach(r => {
        const k = String(r.Key || '').trim();
        if (k === 'COMM_' + kind + '_SUBJECT' && String(r.Value || '').trim()) out.subject = String(r.Value);
        if (k === 'COMM_' + kind + '_BODY'    && String(r.Value || '').trim()) out.body = String(r.Value);
      });
    } catch (err) { Logger.log('_commTemplate: ' + err); }
    return out;
  }

  /** The templates, for the editor UI. */
  function getCommTemplates(payload, user, roles) {
    _requireSuperAdmin(roles);
    return {
      kinds: COMM_KINDS.map(k => Object.assign({ kind: k }, _commTemplate(k))),
      tokens: '{Name} {FirstName} {Year} {Assignments} {Schedule} {PolicyDocs} {PortalLink}',
    };
  }

  // ── Policy documents (the references drafts point at) ──────
  // A UI-managed list of name + URL — the CAP letter, the review criteria,
  // and whatever else the committee should have in hand. Stored as JSON in
  // the module's Settings sheet so the annual CAP-letter swap is a paste in
  // the UI, never a code change. Rendered into drafts via {PolicyDocs}.

  const POLICY_DOCS_KEY = 'POLICY_DOCS';

  function _policyDocs() {
    try {
      const row = DataService.getAll(SHEET(), SETTINGS_TAB())
        .find(r => String(r.Key || '').trim() === POLICY_DOCS_KEY);
      if (!row || !row.Value) return [];
      const list = JSON.parse(row.Value);
      return Array.isArray(list)
        ? list.filter(d => d && String(d.name || '').trim() && String(d.url || '').trim())
        : [];
    } catch (err) {
      Logger.log('_policyDocs: ' + err);
      return [];
    }
  }

  /** The {PolicyDocs} block: the document NAMES, one per line. The links are
   *  not shown as text — they are embedded as hyperlinks on the names in the
   *  HTML email at send time (and in the HTML clipboard copy). The plain-text
   *  fallback body carries names only, by design. */
  function _policyDocsBlock() {
    const docs = _policyDocs();
    if (!docs.length) return '';
    return 'Policy references:\n' +
      docs.map(d => '\u2022 ' + d.name).join('\n');
  }

  /** HTML-escape matching Notify.htmlWrap's escaping, so a doc name can be
   *  found inside wrapped HTML and linkified. */
  function _commEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Turn each '\u2022 Name' in wrapped HTML into '\u2022 <a href>Name</a>'. */
  function _linkifyPolicyDocs(html, docs) {
    let out = String(html || '');
    (docs || []).forEach(d => {
      const esc = _commEscape(d.name);
      const plain = '\u2022 ' + esc;
      const linked = '\u2022 <a href="' + _commEscape(d.url) +
        '" style="color:#003C6C;">' + esc + '</a>';
      if (out.indexOf(plain) !== -1) out = out.split(plain).join(linked);
    });
    return out;
  }

  /** The policy-documents list, for the management card. */
  function listPolicyDocs(payload, user, roles) {
    _requireSuperAdmin(roles);
    return { docs: _policyDocs() };
  }

  /**
   * Replace the policy-documents list. Whole-list save: the card edits the
   * full set and writes it back — simpler than row-level CRUD for a list
   * this small, and there is no partial-update ambiguity.
   * @param {Object} payload - { docs: [{name, url}] }
   */
  function savePolicyDocs(payload, user, roles) {
    _requireSuperAdmin(roles);
    const docs = (Array.isArray((payload || {}).docs) ? payload.docs : [])
      .map(d => ({ name: String((d || {}).name || '').trim(), url: String((d || {}).url || '').trim() }))
      .filter(d => d.name && d.url);
    docs.forEach(d => {
      if (!/^https?:\/\//i.test(d.url)) {
        throw new Error('"' + d.name + '" needs a full link starting with http(s):// — got "' + d.url + '".');
      }
    });
    const value = docs.length ? JSON.stringify(docs) : '';
    const existing = DataService.getAll(SHEET(), SETTINGS_TAB())
      .find(r => String(r.Key || '').trim() === POLICY_DOCS_KEY);
    if (existing) DataService.update(SHEET(), SETTINGS_TAB(), 'Key', POLICY_DOCS_KEY, { Value: value });
    else DataService.insert(SHEET(), SETTINGS_TAB(), { Key: POLICY_DOCS_KEY, Value: value });
    return { docs: docs };
  }

  /** Save a template override to the Settings tab. Blank reverts to the default. */
  function saveCommTemplate(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const kind = String(p.kind || '').trim();
    if (COMM_KINDS.indexOf(kind) === -1) throw new Error('Unknown message kind: ' + kind);
    const put = (key, value) => {
      const existing = DataService.getAll(SHEET(), SETTINGS_TAB())
        .find(r => String(r.Key || '').trim() === key);
      if (existing) DataService.update(SHEET(), SETTINGS_TAB(), 'Key', key, { Value: String(value || '') });
      else DataService.insert(SHEET(), SETTINGS_TAB(), { Key: key, Value: String(value || '') });
    };
    if (p.subject !== undefined) put('COMM_' + kind + '_SUBJECT', p.subject);
    if (p.body !== undefined)    put('COMM_' + kind + '_BODY', p.body);
    return { kind: kind, template: _commTemplate(kind) };
  }

  /** The member's open drafting assignments, as the {Assignments} block. */
  function _assignmentsBlockFor(email, year, user, roles) {
    const types = COMPONENT_TYPES();
    const caseById = {};
    DataService.getAll(SHEET(), CASES_TAB()).forEach(c => {
      if (year && String(c.AcademicYear).trim() !== year) return;
      caseById[c.CaseID] = c;
    });
    const lines = [];
    DataService.getAll(SHEET(), COMPONENTS_TAB()).forEach(comp => {
      const c = caseById[comp.CaseID];
      if (!c) return;
      if (_email(comp.AssignedTo) !== email) return;
      if (String(comp.Status) !== 'assigned') return;   // open work only
      const candidate = Auth.getProfile(_email(c.CandidateEmail));
      const who = candidate ? (candidate.nameLastFirst || candidate.name) : c.CandidateEmail;
      const label = (types[comp.ComponentType] && types[comp.ComponentType].label) || comp.ComponentType;
      const due = _histDate(comp.DueAt) || '';
      lines.push('• ' + label + ' — ' + who + ' (' + (c.ReviewType || 'review') + ')'
        + (due ? ' — due ' + due : ''));
    });
    return lines.join('\n');
  }

  /** The cycle's working schedule as the {Schedule} block — proposed dates first. */
  function _scheduleBlockFor(year, user, roles) {
    const rep = computeCycleSchedule({ academicYear: year }, user, roles);
    if (!rep.schedules) return '(No schedule could be computed for ' + year + '.)';
    const props = rep.proposedDates || {};
    const section = (label, sch, p) => {
      if (!sch) return '';
      const b = sch.backward || {};
      const eff = (step) => (p && p[step]) || b[step] || '—';
      const l = [label + ':'];
      l.push('  Drafts complete:        ' + eff('draftsDue'));
      l.push('  Deliberation underway:  ' + eff('deliberateBy'));
      l.push('  Faculty vote:           ' + eff('vote'));
      l.push('  Final letter:           ' + eff('letterFinal'));
      l.push('  Candidate review opens: ' + (b.lateReviewStart || '—') + '  (set by policy)');
      l.push('  Due to the Division:    ' + (b.submission || '—') + '  (the Division\'s deadline)');
      return l.join('\n');
    };
    const parts = [];
    if (rep.schedules.merit && rep.schedules.merit.schedule) {
      parts.push(section('Merit & salary-increase files', rep.schedules.merit.schedule, props.merit));
    }
    if (rep.schedules.major && rep.schedules.major.schedule) {
      const maj = rep.schedules.major.schedule;
      let s = section('Promotion & mid-career files', maj, props.major);
      if (maj.forward && maj.forward.lettersDue) {
        s += '\n  External letters due:   ' + maj.forward.lettersDue +
             '\n  Candidate reviews letters through: ' + (maj.forward.earlyReviewEnd || '—') + '  (set by policy)';
      }
      parts.push(s);
    }
    return parts.join('\n\n');
  }

  /**
   * Generate one editable draft per committee member for a message kind.
   * Nothing is sent — the drafts come back for a human to edit.
   * @param {Object} payload - { kind, academicYear }
   */
  function previewCommunication(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const kind = String(p.kind || '').trim();
    if (COMM_KINDS.indexOf(kind) === -1) throw new Error('Unknown message kind: ' + kind);
    const year = String(p.academicYear || '').trim();
    if (!year) throw new Error('academicYear is required.');

    let members = [];
    try { members = Auth.usersWithRole(COMMITTEE_ROLE()) || []; }
    catch (err) { Logger.log('previewCommunication: ' + err); }
    if (!members.length) {
      return { kind: kind, academicYear: year, drafts: [],
               hint: 'Nobody holds the ' + COMMITTEE_ROLE() + ' role — there is no committee to write to.' };
    }

    const tmpl = _commTemplate(kind);
    const portalLink = (typeof Links !== 'undefined' && Links.deepLink)
      ? (Links.deepLink('personnel') || '') : '';
    // Blocks shared by every recipient are built once.
    const scheduleBlock = kind === 'schedule' ? _scheduleBlockFor(year, user, roles) : '';
    const policyDocsBlock = _policyDocsBlock();

    const drafts = [];
    const skipped = [];
    members.forEach(m => {
      const email = _email(m.email);
      const profile = Auth.getProfile(email);
      const name = profile ? (profile.name || m.name) : m.name;
      const firstName = profile ? (profile.firstName || name) : name;

      let assignmentsBlock = '';
      if (kind === 'assignments') {
        assignmentsBlock = _assignmentsBlockFor(email, year, user, roles);
        if (!assignmentsBlock) { skipped.push(name); return; }   // nothing to notify
      }

      const fill = s => String(s || '')
        .replace(/\{Name\}/g, name || email)
        .replace(/\{FirstName\}/g, firstName || name || email)
        .replace(/\{Year\}/g, year)
        .replace(/\{Assignments\}/g, assignmentsBlock)
        .replace(/\{Schedule\}/g, scheduleBlock)
        .replace(/\{PolicyDocs\}/g, policyDocsBlock)
        .replace(/\{PortalLink\}/g, portalLink);

      drafts.push({ email: email, name: name, subject: fill(tmpl.subject), body: fill(tmpl.body) });
    });

    return {
      kind: kind, academicYear: year, drafts: drafts,
      policyDocs: _policyDocs(),
      skipped: skipped,
      hint: skipped.length
        ? 'No draft for ' + skipped.join(', ') + ' — no open assignments to notify.' : '',
    };
  }

  /** Append one row to the communications log. */
  function _logComm(kind, year, recipient, subject, body, method, user) {
    try {
      DataService.insert(SHEET(), COMM_LOG_TAB(), {
        LogID: DataService.generateId('COM'),
        Kind: kind, AcademicYear: year,
        Recipient: recipient, Subject: subject, Body: body,
        Method: method,
      });
    } catch (err) { Logger.log('_logComm: ' + err); }
  }

  /**
   * Send edited drafts through the portal (Notify), logging each. Sends are
   * per-recipient — one failure doesn't stop the rest — and the result says
   * exactly who got mail and who didn't.
   * @param {Object} payload - { kind, academicYear, drafts: [{email, subject, body}] }
   */
  function sendCommunications(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const kind = String(p.kind || '').trim();
    if (COMM_KINDS.indexOf(kind) === -1) throw new Error('Unknown message kind: ' + kind);
    const year = String(p.academicYear || '').trim();
    const drafts = Array.isArray(p.drafts) ? p.drafts : [];
    if (!drafts.length) throw new Error('Nothing to send.');

    let replyTo = '';
    try { replyTo = Settings.replyTo('personnel'); }
    catch (err) { replyTo = (CONFIG && CONFIG.DEFAULT_REPLY_TO) || ''; }

    const sent = [], failed = [];
    drafts.forEach(d => {
      const email = _email(d.email);
      const subject = String(d.subject || '').trim();
      const body = String(d.body || '').trim();
      if (!email || !subject || !body) {
        failed.push({ email: email || '(blank)', reason: 'missing recipient, subject, or body' });
        return;
      }
      const res = Notify.send({
        to: email,
        subject: subject,
        body: body,   // plain-text fallback: document names without links
        htmlBody: _linkifyPolicyDocs(Notify.htmlWrap(body), _policyDocs()),
        replyTo: replyTo,
      });
      if (res && res.sent) {
        sent.push(email);
        _logComm(kind, year, email, subject, body, 'sent', user);
      } else {
        failed.push({ email: email, reason: (res && res.reason) || 'send failed' });
      }
    });
    return { sent: sent, failed: failed };
  }

  /**
   * Create the messages as DRAFTS in Gmail — the primary delivery path.
   * Drafts land in the DEPLOYING account's Gmail Drafts folder (the account
   * the portal runs as — for this department, the shared staff account),
   * where they can be reviewed, edited, and sent from the real mailbox.
   * Policy-document names carry their links natively in the draft's HTML —
   * no clipboard machinery involved. Each is logged with method 'drafted'.
   * @param {Object} payload - { kind, academicYear, drafts: [{email, subject, body}] }
   */
  function draftCommunications(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const kind = String(p.kind || '').trim();
    if (COMM_KINDS.indexOf(kind) === -1) throw new Error('Unknown message kind: ' + kind);
    const year = String(p.academicYear || '').trim();
    const drafts = Array.isArray(p.drafts) ? p.drafts : [];
    if (!drafts.length) throw new Error('Nothing to draft.');

    // Light HTML for the draft body: escaped text with line breaks, policy
    // document names linkified. Deliberately NOT the branded notification
    // shell — a draft is going to be edited in Gmail, and a heavy wrapper
    // makes that awkward. What you see in Gmail is what you'd write there.
    const docs = _policyDocs();
    const toHtml = body => _linkifyPolicyDocs(
      _commEscape(body).replace(/\r?\n/g, '<br>'), docs);

    const drafted = [], failed = [];
    drafts.forEach(d => {
      const email = _email(d.email);
      const subject = String(d.subject || '').trim();
      const body = String(d.body || '').trim();
      if (!email || !subject || !body) {
        failed.push({ email: email || '(blank)', reason: 'missing recipient, subject, or body' });
        return;
      }
      try {
        GmailApp.createDraft(email, subject, body, { htmlBody: toHtml(body) });
        drafted.push(email);
        _logComm(kind, year, email, subject, body, 'drafted', user);
      } catch (err) {
        failed.push({ email: email, reason: String(err && err.message || err) });
      }
    });
    return { drafted: drafted, failed: failed };
  }

  /** Log a draft the user copied into their own mail client. */
  function logCopiedCommunication(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    _logComm(String(p.kind || ''), String(p.academicYear || ''), _email(p.recipient),
             String(p.subject || ''), String(p.body || ''), 'copied', user);
    return { logged: true };
  }

  /** The most recent log entries, newest first. */
  function listCommunicationsLog(payload, user, roles) {
    _requireSuperAdmin(roles);
    const limit = Math.min(Number((payload || {}).limit) || 20, 100);
    const rows = DataService.getAll(SHEET(), COMM_LOG_TAB()).map(r => ({
      kind: r.Kind, academicYear: r.AcademicYear, recipient: r.Recipient,
      subject: r.Subject, method: r.Method,
      at: String(r.CreatedAt || ''), by: r.CreatedBy || '',
    }));
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { entries: rows.slice(0, limit), total: rows.length };
  }


  // ── Cycle deadline auto-matching ───────────────────────────
  // APO's calendar titles are structured and carry the cycle year, so the
  // division deadlines can simply be found rather than hunted for by hand.
  // Auto-matching APPLIES on cycle load; a hand-picked anchor is never
  // overwritten, and the picker remains available as an override.

  /**
   * The cycle label forms a calendar title might use. "2026-27" → the label
   * itself, plus a four-digit variant ("2026-2027").
   *
   * Deliberately does NOT include the bare years: "2026" also appears in
   * "2026-27" AND would match a "2027-28" title through its first year,
   * pulling in the wrong cycle. Only the full label is unambiguous.
   */
  function _cycleYearTokens(academicYear) {
    const y = String(academicYear || '').trim();
    const m = /^(\d{4})\s*[-\/]\s*(\d{2,4})$/.exec(y);
    if (!m) return [y];
    const first = m[1];
    const shortSecond = m[2].slice(-2);
    const longSecond = m[2].length === 2 ? first.slice(0, 2) + m[2] : m[2];
    return [
      first + '-' + shortSecond,   // 2026-27
      first + '-' + longSecond,    // 2026-2027
    ];
  }

  /** The first calendar year of a cycle: "2026-27" → "2026". */
  function _cycleFirstYear(academicYear) {
    const m = /^(\d{4})/.exec(String(academicYear || '').trim());
    return m ? m[1] : '';
  }

  /**
   * Find the calendar deadline matching a pattern for a given cycle. The
   * pattern's phrases must all appear in the title, at least one 'anyOf'
   * phrase must appear (when given), no 'noneOf' phrase may, and the cycle
   * year must be in the title — which is what keeps years apart.
   * @returns { deadlineId, title, date } | null, plus `ambiguous` when
   *          several match (we then decline to guess).
   */
  function _autoMatchDeadline(academicYear, pattern) {
    if (!pattern) return null;
    let list;
    try {
      const filter = {};
      if (pattern.sourceKey) filter.sourceKey = pattern.sourceKey;
      list = CalendarService.findDeadlines(filter) || [];
    } catch (err) {
      Logger.log('_autoMatchDeadline: calendar read failed: ' + err);
      return null;
    }

    const yearTokens = _cycleYearTokens(academicYear);
    const has = (title, phrase) => title.indexOf(String(phrase).toLowerCase()) !== -1;

    const hits = list.filter(d => {
      const t = String(d.title || '').toLowerCase();
      // The cycle year must appear, or we could match another year's deadline.
      if (!yearTokens.some(y => t.indexOf(String(y).toLowerCase()) !== -1)) return false;
      if ((pattern.allOf || []).some(p => !has(t, p))) return false;
      if ((pattern.noneOf || []).some(p => has(t, p))) return false;
      if (pattern.anyOf && pattern.anyOf.length &&
          !pattern.anyOf.some(p => has(t, p))) return false;
      return true;
    });

    if (!hits.length) return null;
    if (hits.length > 1) {
      return { ambiguous: true, candidates: hits.map(d => ({
        deadlineId: d.deadlineId, title: d.title, date: d.date })) };
    }
    const d = hits[0];
    return { deadlineId: d.deadlineId, title: d.title, date: d.date };
  }

  /**
   * The letters-due date for a cycle, in resolution order:
   *   1. an explicit typed date on the cycle;
   *   2. a chosen calendar deadline;
   *   3. the standing default (Nov 1 of the cycle's first year).
   * Returns { date, source: 'typed'|'calendar'|'default', title? }.
   */
  function _resolveLettersDue(cycleRow, academicYear) {
    const typed = cycleRow ? String(cycleRow.LettersDueDate || '').trim() : '';
    if (typed) {
      const d = _histDate(typed) || typed;
      return { date: d, source: 'typed' };
    }
    const id = cycleRow ? String(cycleRow.LettersDueDeadlineID || '').trim() : '';
    if (id) {
      const res = _calendarDeadline(id);
      if (res.found && res.date) {
        return { date: res.date, source: 'calendar', title: res.title, status: res.status };
      }
    }
    const def = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.LETTERS_DUE_DEFAULT) || { month: 11, day: 1 };
    const first = _cycleFirstYear(academicYear);
    if (!first) return { date: '', source: 'none' };
    const date = first + '-' + String(def.month).padStart(2, '0') + '-' + String(def.day).padStart(2, '0');
    return { date: date, source: 'default' };
  }

  /**
   * Fill in a cycle's division anchors from the calendar automatically, if
   * they aren't already set. Never overwrites an existing choice — a hand
   * pick (or a previous auto-match) stands. Returns what it applied.
   */
  function _autoFillCycleAnchors(academicYear, cycleRow) {
    const patterns = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.CYCLE_DEADLINE_PATTERNS) || {};
    const applied = {}, notes = [];

    const need = {
      merit: !cycleRow || !String(cycleRow.MeritDeadlineID || '').trim(),
      major: !cycleRow || !String(cycleRow.MajorDeadlineID || '').trim(),
    };

    ['merit', 'major'].forEach(which => {
      if (!need[which]) return;
      const hit = _autoMatchDeadline(academicYear, patterns[which]);
      if (!hit) {
        notes.push('No ' + which + '-files deadline could be matched automatically for ' +
                   academicYear + ' — choose one from the calendar.');
        return;
      }
      if (hit.ambiguous) {
        notes.push('Several calendar entries could be the ' + which + '-files deadline for ' +
                   academicYear + ' — choose the right one.');
        return;
      }
      applied[which] = hit;
    });

    if (!Object.keys(applied).length) return { applied: applied, notes: notes };

    const fields = { AcademicYear: academicYear, AutoMatched: 'TRUE' };
    if (applied.merit) fields.MeritDeadlineID = applied.merit.deadlineId;
    if (applied.major) fields.MajorDeadlineID = applied.major.deadlineId;

    const existing = DataService.query(SHEET(), CYCLES_TAB(), 'AcademicYear', academicYear);
    if (existing.length) {
      DataService.update(SHEET(), CYCLES_TAB(), 'CycleID', existing[0].CycleID, fields);
    } else {
      DataService.insert(SHEET(), CYCLES_TAB(),
        Object.assign({ CycleID: DataService.generateId('CYC') }, fields));
    }
    return { applied: applied, notes: notes };
  }


  // ── Cycle anchors + settings (dispatchable) ────────────────

  /**
   * The scheduler settings the UI edits: the gap parameters (with their
   * current values, defaults, and descriptions) so Settings can render a form
   * without hardcoding the vocabulary.
   */
  function getSchedulerSettings(payload, user, roles) {
    _requireSuperAdmin(roles);
    const gaps = SCHEDULE_GAPS();
    const defaults = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.SCHEDULE_GAPS) || {};
    const describe = {
      candidateReviewDays:   'Candidate review window (the mandatory review of the file; also the early review of external letters on promotions).',
      letterToReviewGap:     'Business days the final voted letter must be complete BEFORE the candidate review opens. 0 = the review opens on the letter.',
      voteToLetterGap:       'Business days to finalize the letter after the faculty vote.',
      deliberateToVoteGap:   'Business days of committee deliberation before the vote.',
      draftsToDeliberateGap: 'Business days drafts must be complete before deliberation begins.',
      lateLetterBufferDays:  'Cushion after external letters are due before the early review is PLANNED to start — absorbs late-arriving letters.',
    };
    return {
      gaps: GAP_KEYS.map(k => ({
        key: k, value: gaps[k],
        default: defaults[k],
        description: describe[k] || '',
      })),
    };
  }

  /**
   * Save scheduler gap parameters to the Settings tab. Only known keys are
   * accepted, and only non-negative integers; anything else is rejected rather
   * than silently producing a broken schedule.
   * @param {Object} payload - { gaps: { key: value, ... } }
   */
  function saveSchedulerSettings(payload, user, roles) {
    _requireSuperAdmin(roles);
    const incoming = (payload && payload.gaps) || {};
    const existing = DataService.getAll(SHEET(), SETTINGS_TAB());
    const saved = [];

    Object.keys(incoming).forEach(k => {
      if (GAP_KEYS.indexOf(k) === -1) return;               // unknown key
      const n = Number(incoming[k]);
      if (!isFinite(n) || n < 0) throw new Error('"' + k + '" must be a non-negative whole number.');
      const v = String(Math.floor(n));
      const row = existing.find(r => String(r.Key || '').trim() === k);
      if (row) {
        DataService.update(SHEET(), SETTINGS_TAB(), 'Key', k, { Value: v });
      } else {
        DataService.insert(SHEET(), SETTINGS_TAB(), { Key: k, Value: v });
      }
      saved.push(k);
    });
    return { saved: saved, gaps: SCHEDULE_GAPS() };
  }

  /**
   * The stored anchors for a cycle, each resolved against the calendar so the
   * UI can show the live date and detect a REMOVED anchor.
   * @param {Object} payload - { academicYear }
   */
  function getCycle(payload, user, roles) {
    _requireSuperAdmin(roles);
    const year = String((payload || {}).academicYear || '').trim();
    if (!year) throw new Error('academicYear is required.');

    let rows = DataService.query(SHEET(), CYCLES_TAB(), 'AcademicYear', year);
    let row = rows.length ? rows[0] : null;

    // Fill the division anchors from the calendar automatically when they
    // aren't set — APO's titles are structured and carry the cycle year, so
    // there's nothing to disambiguate. A hand pick is never overwritten.
    const auto = _autoFillCycleAnchors(year, row);
    if (Object.keys(auto.applied).length) {
      rows = DataService.query(SHEET(), CYCLES_TAB(), 'AcademicYear', year);
      row = rows.length ? rows[0] : null;
    }

    const meritId = row ? String(row.MeritDeadlineID || '') : '';
    const majorId = row ? String(row.MajorDeadlineID || '') : '';
    const letId   = row ? String(row.LettersDueDeadlineID || '') : '';
    const letters = _resolveLettersDue(row, year);

    // The department's working schedule: proposed dates keyed by timeline
    // then step. Malformed JSON degrades to "no proposals", never an error.
    let proposed = {};
    if (row && row.ProposedDates) {
      try { proposed = JSON.parse(row.ProposedDates) || {}; }
      catch (err) { Logger.log('getCycle: bad ProposedDates JSON for ' + year + ': ' + err); }
    }

    return {
      academicYear: year,
      exists: !!row,
      meritDeadlineId: meritId,
      majorDeadlineId: majorId,
      lettersDueDeadlineId: letId,
      merit:   meritId ? _calendarDeadline(meritId) : null,
      major:   majorId ? _calendarDeadline(majorId) : null,
      // Letters-due resolves from a typed date, then a calendar entry, then
      // the standing Nov 1 default — so the promotion timeline works without
      // anyone having to set anything.
      lettersDue: letters,
      proposedDates: proposed,
      autoMatched: row ? String(row.AutoMatched || '').toUpperCase() === 'TRUE' : false,
      autoApplied: Object.keys(auto.applied),
      autoNotes: auto.notes,
      notes: row ? (row.Notes || '') : '',
    };
  }

  /**
   * Which division deadline anchors a given review type. The Division splits
   * its submission dates by how heavy the review is: merit and
   * salary-increase-only files go by the merit deadline; promotion and
   * mid-career (the ones with external letters) go by the earlier major
   * deadline. Returns the DeadlineID from the cycle, or ''.
   */
  function _divisionAnchorFor(cycle, reviewType) {
    const map = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.DIVISION_DEADLINE_BY_TYPE) || {};
    const which = map[String(reviewType)] || 'merit';
    return which === 'major'
      ? (cycle.majorDeadlineId || '')
      : (cycle.meritDeadlineId || '');
  }

  /** Every cycle with anchors on file, most recent year first. */
  function listCycles(payload, user, roles) {
    _requireSuperAdmin(roles);
    const cycles = DataService.getAll(SHEET(), CYCLES_TAB()).map(r => ({
      academicYear: r.AcademicYear,
      meritDeadlineId: r.MeritDeadlineID || '',
      majorDeadlineId: r.MajorDeadlineID || '',
      lettersDueDeadlineId: r.LettersDueDeadlineID || '',
      notes: r.Notes || '',
    }));
    cycles.sort((a, b) => String(b.academicYear).localeCompare(String(a.academicYear)));
    return { cycles: cycles };
  }

  /**
   * Set a cycle's anchors. Stores calendar DeadlineIDs (never titles or
   * dates). Upserts on AcademicYear.
   * @param {Object} payload - { academicYear, divisionDeadlineId?,
   *                             lettersDueDeadlineId?, notes? }
   */
  function setCycleAnchors(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const year = String(p.academicYear || '').trim();
    if (!year) throw new Error('Academic year is required.');

    const fields = { AcademicYear: year };
    // A hand pick is a deliberate override: mark the cycle as no longer
    // auto-matched so a later auto-fill leaves it alone.
    if (p.meritDeadlineId !== undefined) {
      fields.MeritDeadlineID = String(p.meritDeadlineId || '').trim();
      fields.AutoMatched = 'FALSE';
    }
    if (p.majorDeadlineId !== undefined) {
      fields.MajorDeadlineID = String(p.majorDeadlineId || '').trim();
      fields.AutoMatched = 'FALSE';
    }
    if (p.lettersDueDeadlineId !== undefined) fields.LettersDueDeadlineID = String(p.lettersDueDeadlineId || '').trim();
    // An explicit letters-due date overrides both the calendar entry and the
    // standing Nov 1 default.
    if (p.lettersDueDate !== undefined) fields.LettersDueDate = String(p.lettersDueDate || '').trim();
    if (p.notes !== undefined) fields.Notes = String(p.notes || '').trim();

    const existing = DataService.query(SHEET(), CYCLES_TAB(), 'AcademicYear', year);
    if (existing.length) {
      DataService.update(SHEET(), CYCLES_TAB(), 'CycleID', existing[0].CycleID, fields);
    } else {
      DataService.insert(SHEET(), CYCLES_TAB(),
        Object.assign({ CycleID: DataService.generateId('CYC') }, fields));
    }
    return getCycle({ academicYear: year }, user, roles);
  }

  /**
   * Compute a cycle's schedule from its stored anchors — the PLANNING view,
   * usable before any cases exist. Returns both timelines (the promotion
   * variant, with its early letters-review window, and the ordinary one), so
   * you can see the shape of the cycle and whether it fits.
   * @param {Object} payload - { academicYear, actualLettersAddedDate? }
   */
  function computeCycleSchedule(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const cycle = getCycle({ academicYear: p.academicYear }, user, roles);
    const warnings = [];

    // The two timelines run against DIFFERENT division deadlines: merit files
    // by the later merit deadline, promotion/mid-career by the earlier major
    // one. Each is computed only if its anchor is set.
    let merit = null, major = null;

    if (cycle.meritDeadlineId) {
      merit = computeCaseSchedule({
        isPromotion: false,
        submissionDeadlineId: cycle.meritDeadlineId,
      }, user, roles);
    } else {
      warnings.push('No merit-files deadline is set — the merit and salary-increase timeline cannot be planned.');
    }

    if (cycle.majorDeadlineId) {
      const lettersDate = (cycle.lettersDue && cycle.lettersDue.date) || '';
      major = computeCaseSchedule({
        isPromotion: !!lettersDate,   // the early window needs a letters date
        submissionDeadlineId: cycle.majorDeadlineId,
        lettersDueDate: lettersDate,
        actualLettersAddedDate: p.actualLettersAddedDate || '',
      }, user, roles);
    } else {
      warnings.push('No major-files deadline (promotion / mid-career / external letters) is set — that timeline cannot be planned.');
    }

    const proposed = cycle.proposedDates || {};
    return {
      academicYear: cycle.academicYear,
      cycle: cycle,
      gaps: SCHEDULE_GAPS(),
      schedules: (merit || major) ? { merit: merit, major: major } : null,
      proposedDates: { merit: proposed.merit || {}, major: proposed.major || {} },
      warnings: warnings,
    };
  }

  /**
   * Compute the schedule for a specific CASE. Reads the case's academic year
   * to find the cycle's anchors, and its review type to decide whether the
   * promotion timeline (with the early external-letters review) applies. So a
   * case's schedule needs nothing but the case.
   * @param {Object} payload - { caseId, actualLettersAddedDate? }
   */
  function computeScheduleForCase(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    const id = String(p.caseId || '').trim();
    if (!id) throw new Error('caseId is required.');

    const found = DataService.query(SHEET(), CASES_TAB(), 'CaseID', id);
    if (!found.length) throw new Error('Case not found: ' + id);
    const c = found[0];

    const year = String(c.AcademicYear || '').trim();
    const cycle = getCycle({ academicYear: year }, user, roles);

    // The Division's submission deadline depends on the review type: merit and
    // salary-increase files go by the merit deadline; promotion and mid-career
    // by the earlier major one.
    const reviewType = String(c.ReviewType || '');
    const anchorId = _divisionAnchorFor(cycle, reviewType);
    if (!anchorId) {
      const map = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.DIVISION_DEADLINE_BY_TYPE) || {};
      const which = map[reviewType] === 'major' ? 'major-files (promotion / mid-career)' : 'merit-files';
      return { caseId: id, academicYear: year, reviewType: reviewType, schedule: null,
               warnings: ['No ' + which + ' division deadline is set for ' + year +
                          ' — set the cycle deadlines in the Calendar tab.'] };
    }

    // Only promotions carry external letters, so only they get the early
    // candidate-review window.
    const lettersDate = (cycle.lettersDue && cycle.lettersDue.date) || '';
    const isPromotion = reviewType === 'promotion' && !!lettersDate;
    const res = computeCaseSchedule({
      isPromotion: isPromotion,
      submissionDeadlineId: anchorId,
      lettersDueDate: lettersDate,
      actualLettersAddedDate: p.actualLettersAddedDate || '',
    }, user, roles);

    // Which timeline's proposals apply to this case — the same split that
    // chooses its division anchor.
    const propMap = (CONFIG.PERSONNEL && CONFIG.PERSONNEL.DIVISION_DEADLINE_BY_TYPE) || {};
    const timelineKey = propMap[reviewType] === 'major' ? 'major' : 'merit';
    const proposals = ((cycle.proposedDates || {})[timelineKey]) || {};

    // The working drafts-due: the proposal when one exists, else computed.
    const computedDrafts = (res.schedule && res.schedule.backward && res.schedule.backward.draftsDue) || '';
    const effectiveDraftsDue = proposals.draftsDue || computedDrafts;

    const profile = Auth.getProfile(_email(c.CandidateEmail));
    return {
      caseId: id,
      candidate: profile ? (profile.nameLastFirst || profile.name) : c.CandidateEmail,
      academicYear: year,
      reviewType: c.ReviewType,
      isPromotion: isPromotion,
      schedule: res.schedule,
      resolved: res.resolved,
      timeline: timelineKey,
      proposedDates: proposals,
      effectiveDraftsDue: effectiveDraftsDue,
      warnings: (res.schedule && res.schedule.warnings) || [],
    };
  }


  /** The upcoming July 1 (the typical cycle effective date) as 'yyyy-MM-dd'. */
  function _upcomingJuly1() {
    const now = new Date();
    const y = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
    return y + '-07-01';
  }


  // Only these names are dispatchable.
  // Only these names are dispatchable (TABS is the tab manifest, not an action).
  return {
    TABS: TABS,
    ping,
    getAttributes,
    getPersonSummary,
    listRoster,
    listRanks,
    updatePersonAttributes,
    detectColumns,
    previewRankImport,
    commitRankImport,
    // Cases
    listReviewTypes,
    detectCallColumns,
    previewCallImport,
    commitCallImport,
    listCases,
    updateCase,
    createCase,
    checkCaseEligibility,
    // Drafting assignments
    listCommitteeMembers,
    listCaseComponents,
    assignComponent,
    markComponentDrafted,
    reopenComponent,
    committeeWorkload,
    exportWorkloadToSheet,
    caseAssignments,
    // Scheduler
    findCalendarDeadlines,
    computeCaseSchedule,
    getSchedulerSettings,
    saveSchedulerSettings,
    getCycle,
    listCycles,
    setCycleAnchors,
    computeCycleSchedule,
    proposeDate,
    exportCycleScheduleToSheet,
    // Communications
    getCommTemplates,
    saveCommTemplate,
    previewCommunication,
    sendCommunications,
    draftCommunications,
    logCopiedCommunication,
    listCommunicationsLog,
    listPolicyDocs,
    savePolicyDocs,
    computeScheduleForCase,
    // Review history
    detectHistoryColumns,
    previewHistoryImport,
    commitHistoryImport,
    getReviewHistory,
    // Anticipated Call
    listAnticipatedCandidates,
    exportAnticipatedToSheet,
    exportAnticipatedToCsv,
  };

})();