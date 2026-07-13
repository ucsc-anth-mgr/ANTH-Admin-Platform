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

  function _computeBackward(submissionISO, closures, g) {
    const lateReviewStart = _schAddBusinessDays(submissionISO, g.candidateReviewDays, closures, -1);
    const lateReviewEnd   = _schAddBusinessDays(submissionISO, 1, closures, -1);
    const letterFinal = g.letterToReviewGap > 0
      ? _schAddBusinessDays(lateReviewStart, g.letterToReviewGap, closures, -1)
      : lateReviewStart;
    const vote         = _schAddBusinessDays(letterFinal, g.voteToLetterGap, closures, -1);
    const deliberateBy = _schAddBusinessDays(vote, g.deliberateToVoteGap, closures, -1);
    const draftsDue    = _schAddBusinessDays(deliberateBy, g.draftsToDeliberateGap, closures, -1);
    return { submission: submissionISO, lateReviewStart, lateReviewEnd,
             letterFinal, vote, deliberateBy, draftsDue };
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
  function _computeSchedule(c, closures) {
    const g = SCHEDULE_GAPS();
    const backward = _computeBackward(c.submissionISO, closures, g);
    const out = { backward: backward, forward: null, feasible: true, warnings: [] };
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
   * Find candidate anchor deadlines for the picker (division submission,
   * external letters due). Thin pass-through to CalendarService.findDeadlines
   * so the personnel UI can search without knowing the calendar's internals.
   * @param {Object} payload - { titleContains?, sourceKey?, origin?, kind?, from?, to? }
   */
  function findCalendarDeadlines(payload, user, roles) {
    _requireSuperAdmin(roles);
    const p = payload || {};
    try {
      return { deadlines: CalendarService.findDeadlines({
        titleContains: p.titleContains || '', sourceKey: p.sourceKey || '',
        origin: p.origin || '', kind: p.kind || 'deadline',
        from: p.from || '', to: p.to || '',
      }) || [] };
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

    let letters = { found: false, date: '', status: 'missing' };
    if (p.isPromotion) {
      letters = _calendarDeadline(p.lettersDueDeadlineId);
      if (!letters.found) warnings.push('This is a promotion but no external-letters-due deadline is set — the early candidate-review window can\'t be planned.');
      else if (letters.status === 'removed') warnings.push('The external-letters-due deadline was removed upstream — the date shown may be stale.');
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

    const schedule = _computeSchedule({
      isPromotion: !!p.isPromotion,
      submissionISO: sub.date,
      lettersDueISO: (p.isPromotion && letters.date) ? letters.date : '',
      actualLettersAddedISO: p.actualLettersAddedDate || '',
    }, closures);

    schedule.warnings = warnings.concat(schedule.warnings || []);
    return { schedule: schedule, resolved: { submission: sub, letters: letters, closureCount: closures.length } };
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

    const rows = DataService.query(SHEET(), CYCLES_TAB(), 'AcademicYear', year);
    const row = rows.length ? rows[0] : null;
    const divId = row ? String(row.DivisionDeadlineID || '') : '';
    const letId = row ? String(row.LettersDueDeadlineID || '') : '';

    return {
      academicYear: year,
      exists: !!row,
      divisionDeadlineId: divId,
      lettersDueDeadlineId: letId,
      division: divId ? _calendarDeadline(divId) : null,
      letters:  letId ? _calendarDeadline(letId) : null,
      notes: row ? (row.Notes || '') : '',
    };
  }

  /** Every cycle with anchors on file, most recent year first. */
  function listCycles(payload, user, roles) {
    _requireSuperAdmin(roles);
    const cycles = DataService.getAll(SHEET(), CYCLES_TAB()).map(r => ({
      academicYear: r.AcademicYear,
      divisionDeadlineId: r.DivisionDeadlineID || '',
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
    if (p.divisionDeadlineId   !== undefined) fields.DivisionDeadlineID   = String(p.divisionDeadlineId || '').trim();
    if (p.lettersDueDeadlineId !== undefined) fields.LettersDueDeadlineID = String(p.lettersDueDeadlineId || '').trim();
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
    if (!cycle.divisionDeadlineId) {
      return { academicYear: cycle.academicYear, cycle: cycle, schedules: null,
               warnings: ['No division submission deadline is set for this cycle — pick one below.'] };
    }
    const base = {
      submissionDeadlineId: cycle.divisionDeadlineId,
      lettersDueDeadlineId: cycle.lettersDueDeadlineId,
      actualLettersAddedDate: p.actualLettersAddedDate || '',
    };
    const ordinary  = computeCaseSchedule(Object.assign({ isPromotion: false }, base), user, roles);
    const promotion = cycle.lettersDueDeadlineId
      ? computeCaseSchedule(Object.assign({ isPromotion: true }, base), user, roles)
      : null;

    return {
      academicYear: cycle.academicYear,
      cycle: cycle,
      gaps: SCHEDULE_GAPS(),
      schedules: { ordinary: ordinary, promotion: promotion },
      warnings: cycle.lettersDueDeadlineId ? []
        : ['No external-letters-due deadline is set — the promotion timeline (with its early candidate-review window) cannot be planned.'],
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
    if (!cycle.divisionDeadlineId) {
      return { caseId: id, academicYear: year, schedule: null,
               warnings: ['No division submission deadline is set for ' + year +
                          ' — set the cycle anchors in Settings.'] };
    }

    const isPromotion = String(c.ReviewType) === 'promotion';
    const res = computeCaseSchedule({
      isPromotion: isPromotion,
      submissionDeadlineId: cycle.divisionDeadlineId,
      lettersDueDeadlineId: cycle.lettersDueDeadlineId,
      actualLettersAddedDate: p.actualLettersAddedDate || '',
    }, user, roles);

    const profile = Auth.getProfile(_email(c.CandidateEmail));
    return {
      caseId: id,
      candidate: profile ? (profile.nameLastFirst || profile.name) : c.CandidateEmail,
      academicYear: year,
      reviewType: c.ReviewType,
      isPromotion: isPromotion,
      schedule: res.schedule,
      resolved: res.resolved,
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
  return {
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
    // Scheduler
    findCalendarDeadlines,
    computeCaseSchedule,
    getSchedulerSettings,
    saveSchedulerSettings,
    getCycle,
    listCycles,
    setCycleAnchors,
    computeCycleSchedule,
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