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
   * Returns the full personnel roster: one entry per person who has any
   * personnel-namespace attribute loaded, folded to
   *   { email, name, nameLastFirst, rank, step, series, tier,
   *     updatedAt, updatedBy }
   * and sorted by nameLastFirst. Names come from Auth; if a profile no
   * longer exists for an attributed email (e.g. a user was removed), the
   * email is used as the display name and a `noProfile` flag is set so the
   * UI can show it. One sheet read for the whole roster — the client does
   * all filtering/sorting/detail from this payload (no per-row calls).
   *
   * Read-only; any authorized module user may view the roster.
   */
  function listRoster(payload, user, roles) {
    const all = DataService.getAll(SHEET(), ATTR_TAB())
      .filter(r => String(r.Namespace) === NS());

    // Group rows by email, folding key→value and tracking the latest update.
    const byEmail = {};
    all.forEach(r => {
      const email = _email(r.Email);
      if (!email) return;
      if (!byEmail[email]) byEmail[email] = { attrs: {}, updatedAt: null, updatedBy: '' };
      byEmail[email].attrs[String(r.Key)] = r.Value;
      // Track the most recent UpdatedAt across this person's attribute rows.
      const ts = r.UpdatedAt || r.CreatedAt || null;
      if (ts && (!byEmail[email].updatedAt || ts > byEmail[email].updatedAt)) {
        byEmail[email].updatedAt = ts;
        byEmail[email].updatedBy = r.UpdatedBy || r.CreatedBy || '';
      }
    });

    const roster = Object.keys(byEmail).map(email => {
      const a = byEmail[email].attrs;
      const profile = Auth.getProfile(email);
      const noProfile = !profile;
      return {
        email:         email,
        name:          profile ? (profile.name || (profile.firstName + ' ' + profile.lastName)) : email,
        nameLastFirst: profile ? (profile.nameLastFirst || '') : email,
        noProfile:     noProfile,
        rank:          a.rank   || '',
        step:          a.step   || '',
        series:        a.series || '',
        tier:          a.tier   || '',
        yrsRank:       a.yrs_rank || '',
        yrsStep:       a.yrs_step || '',
        salary:        a.salary   || '',
        updatedAt:     byEmail[email].updatedAt ? _isoDate(byEmail[email].updatedAt) : '',
        updatedBy:     byEmail[email].updatedBy || '',
      };
    });

    roster.sort((x, y) =>
      String(x.nameLastFirst || x.email).localeCompare(String(y.nameLastFirst || y.email)));

    return { roster: roster, count: roster.length };
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
    const roster = listRoster({}, null, ['super_admin']).roster;
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
      Status:          c.status,
    };

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
        status:        r.Status || 'open',
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

    DataService.update(SHEET(), CASES_TAB(), 'CaseID', id, fields);
    return { caseId: id, updated: Object.keys(fields) };
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
  };

})();