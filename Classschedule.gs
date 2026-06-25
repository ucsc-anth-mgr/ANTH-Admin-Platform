// ============================================================
// ClassSchedule.gs — Term class-number table (shared service)
// ============================================================
// A PLATFORM SERVICE, not a registered module. Like Tasks/Notify/Auth,
// it is a plain .gs object other code calls; it has no Modules-sheet row,
// no dispatch entry, and no UI of its own. The Individual Studies module
// provides the import UI and is the first consumer; the Thesis module
// (for ANTH 195S) and a future graduate individual-studies module are
// designed to become additional consumers with no change here.
//
// WHAT IT OWNS
//   The per-term table of individual-studies class sections, parsed from
//   the registrar's "Schedule of Classes — Independent Studies" export.
//   One row per real section (course, section, class number, units,
//   instructor). The whole department's individual-studies sections are
//   admitted (undergrad, 195S, grad alike) so any consumer can read its
//   own course slice; the importer drops only the report's footer/blank
//   rows.
//
// WHAT IT DOES NOT DO
//   It knows nothing about petitions, theses, workflow, tasks, or email.
//   It answers "what class numbers exist for this term/course, and which
//   one matches this sponsor." The calling module decides what to do with
//   the answer. (Same division as Tasks: reports/looks-up, never owns
//   workflow.)
//
// IDENTITY / MATCHING
//   The report has NO email column — only instructor name strings, in two
//   observed formats: "Last,F.M." (e.g. "Oelze,V.") and, for some rows,
//   "First Last (cruzid)" (e.g. "Mark Anderson (mda)"). Resolution cascade,
//   best to worst:
//     1. CruzID in parentheses  -> cruzid@ucsc.edu, matched to a profile
//     2. exact match of the raw string against a profile's name,
//        nameLastFirst, or AltNames (alternate spellings kept for matching)
//     3. unmatched -> surfaced in the preview for the advisor to resolve
//   Resolving an unmatched row MERGES the report spelling into the chosen
//   profile's AltNames (append, never replace), so the next term's import
//   matches it automatically. "Staff" placeholder rows are kept but never
//   matched — they are the unassigned pool a consumer can draw a number
//   from.
//
// STORAGE
//   The table and the import log live in their own spreadsheet, created by
//   setUp() (CONFIG.SHEETS.CLASS_SCHEDULE), with tab names from CONFIG.TABS.
//   Tabs: ClassSchedule (the section rows) and ClassScheduleImports (one
//   row per committed import, for auditability). Read/written via
//   DataService by header name only — never SpreadsheetApp here.
//
// CONFIG / SETUP additions required before first use (applied as separate,
// deliberate edits to Config.gs and Setup.gs — this file does not create
// them; the exact paste-in blocks are at the bottom of this file):
//   - CONFIG.SHEETS.CLASS_SCHEDULE        (new per-service spreadsheet id;
//     left blank, setUp() creates it and logs the id to paste back)
//   - CONFIG.TABS.CLASS_SCHEDULE / CLASS_SCHEDULE_IMPORTS
//   - SETUP_SCHEMA.CLASS_SCHEDULE / CLASS_SCHEDULE_IMPORTS, a
//     _resolveSpreadsheet + _setupTab pair in setUp(), and two
//     _schemaPlacement() rows.
// ============================================================

const ClassSchedule = (() => {

  // ── Configuration access (read lazily so load order is irrelevant) ──
  // Storage follows the standard per-tier convention: its own spreadsheet
  // (CONFIG.SHEETS.CLASS_SCHEDULE, created by setUp) and tab names from
  // CONFIG.TABS, exactly like every other module/service.
  function _cfg() {
    const sheetId = String((CONFIG.SHEETS && CONFIG.SHEETS.CLASS_SCHEDULE) || '').trim();
    if (!sheetId) {
      throw new Error('Class schedule storage is not configured (CONFIG.SHEETS.CLASS_SCHEDULE).');
    }
    const tabs = (typeof CONFIG !== 'undefined' && CONFIG.TABS) || {};
    return {
      sheetId: sheetId,
      tab: String(tabs.CLASS_SCHEDULE || 'ClassSchedule'),
      importsTab: String(tabs.CLASS_SCHEDULE_IMPORTS || 'ClassScheduleImports'),
    };
  }

  // Registrar export column headers we read. Read BY NAME so a column
  // reorder in the export does not break parsing; extra columns are
  // ignored. These are the headers seen in the sample export.
  const COL = {
    COURSE:     'Subject Cat Nbr',   // e.g. "ANTH 199"
    TITLE:      'Class Title',        // e.g. "Tutorial", "Indep Field Study"
    SECTION:    'Section',           // e.g. "01", "01A"
    CLASS_NBR:  'Class Nbr',         // e.g. "13214"
    UNITS:      'Units',             // e.g. "5"
    COMPONENT:  'Component',         // e.g. "IND", "FLI"
    TERM:       'Term',              // e.g. "2258"
    INSTRUCTOR: 'Instructor',        // e.g. "Oelze,V." or "Mark Anderson (mda)"
  };

  // The literal the registrar uses for an unstaffed/placeholder section.
  const STAFF = 'staff';

  const MATCH = {
    CRUZID:    'cruzid',
    NAME:      'name',
    ALTNAME:   'altname',
    UNMATCHED: 'unmatched',
    STAFF:     'staff',
  };


  // ============================================================
  // IMPORT FACE
  // ============================================================

  /**
   * Parse an uploaded registrar CSV into a preview. Commits NOTHING.
   * Filters out only the footer ("Count:" row) and blank rows; admits
   * every real section regardless of course, so the term-wide table can
   * serve any consumer. Runs the instructor-match cascade against current
   * profiles and returns matched / unmatched / staff buckets plus a flag
   * if the term already has a committed table (so the UI can warn before a
   * wholesale overwrite at commit time).
   *
   * @param {Object} payload
   *   @param {string} payload.csvBase64  base64 of the uploaded .csv
   *   @param {string} [payload.csvText]  raw text alternative to csvBase64
   * @returns {{ term, rows, matched, unmatched, staff, counts, existingTermWarning }}
   */
  function parsePreview(payload) {
    payload = payload || {};
    const text = _decodeCsv(payload);
    const parsed = _parseCsv(text);
    if (!parsed.length) throw new Error('The file has no rows.');

    const headers = parsed[0].map(h => String(h).trim());
    const idx = _headerIndexes(headers);
    if (idx[COL.CLASS_NBR] === -1 || idx[COL.COURSE] === -1) {
      throw new Error('This does not look like a Schedule of Classes export ' +
        '(missing "' + COL.COURSE + '" / "' + COL.CLASS_NBR + '" columns).');
    }

    // Build a one-time lookup of profiles for matching, so we resolve
    // every row against the same in-memory snapshot.
    const profiles = _profileIndex();

    const rows = [];
    let term = '';
    for (let i = 1; i < parsed.length; i++) {
      const raw = parsed[i];
      if (_isFooterOrBlank(raw, idx)) continue;

      const course    = String(_cell(raw, idx, COL.COURSE)).trim();
      const classNbr  = String(_cell(raw, idx, COL.CLASS_NBR)).trim();
      if (!course || !classNbr) continue;          // not a real section line

      const rowTerm   = String(_cell(raw, idx, COL.TERM)).trim();
      if (rowTerm && !term) term = rowTerm;         // capture the term once

      const instrRaw  = String(_cell(raw, idx, COL.INSTRUCTOR)).trim();
      const resolved  = _resolveInstructor(instrRaw, profiles);

      rows.push({
        course:      course,
        title:       String(_cell(raw, idx, COL.TITLE)).trim(),
        section:     String(_cell(raw, idx, COL.SECTION)).trim(),
        classNbr:    classNbr,
        units:       String(_cell(raw, idx, COL.UNITS)).trim(),
        component:   String(_cell(raw, idx, COL.COMPONENT)).trim(),
        term:        rowTerm,
        instructorRaw:   instrRaw,
        instructorEmail: resolved.email,
        instructorName:  resolved.name,
        matchMethod:     resolved.method,
        isStaff:         resolved.method === MATCH.STAFF,
      });
    }

    if (!rows.length) throw new Error('No class sections were found in the file.');
    if (!term) throw new Error('Could not determine the term from the file (no "' + COL.TERM + '" value).');

    // Any rows whose term differs from the dominant term are a sign of a
    // mixed file; surface them but key the import on the dominant term.
    const offTerm = rows.filter(r => r.term && r.term !== term);

    const matched   = rows.filter(r => r.instructorEmail);
    const unmatched = rows.filter(r => !r.instructorEmail && !r.isStaff);
    const staff     = rows.filter(r => r.isStaff);

    return {
      term: term,
      rows: rows,
      matched: matched,
      unmatched: unmatched,
      staff: staff,
      offTerm: offTerm,
      counts: {
        total: rows.length,
        matched: matched.length,
        unmatched: unmatched.length,
        staff: staff.length,
      },
      existingTermWarning: _termHasRows(term),
    };
  }

  /**
   * Bind one unmatched report spelling to a chosen profile, and MERGE the
   * spelling into that profile's AltNames so future imports match it
   * automatically. Does not touch the table (nothing is committed yet) —
   * the caller re-runs parsePreview (or applies the resolution to its
   * in-memory preview) to see the row move into "matched".
   *
   * AltNames is preserved-on-update by Auth.upsertUser unless explicitly
   * supplied, so we read the existing array, append if absent, and pass
   * the merged array back — never a bare overwrite.
   *
   * @param {Object} payload
   *   @param {string} payload.instructorRaw  the unmatched report spelling
   *   @param {string} payload.email          chosen profile's email
   * @returns {{ email, name, addedAltName }}
   */
  function resolveUnmatched(payload) {
    payload = payload || {};
    const raw   = String(payload.instructorRaw || '').trim();
    const email = String(payload.email || '').trim();
    if (!raw)   throw new Error('No instructor spelling to resolve.');
    if (!email) throw new Error('Choose a person to bind this instructor to.');

    const profile = Auth.getProfile(email);
    if (!profile) throw new Error('No profile found for ' + email + '.');

    const existing = _altNamesOf(profile);
    const has = existing.some(a => _norm(a) === _norm(raw));
    let addedAltName = false;
    if (!has) {
      existing.push(raw);
      Auth.upsertUser({
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
        roles: profile.roles,
        studentId: profile.studentId,
        employeeId: profile.employeeId,
        active: profile.active,
        notes: profile.notes,
        altNames: existing,            // explicitly supplied (merged) array
      });
      addedAltName = true;
    }

    return {
      email: profile.email,
      name: profile.nameLastFirst || profile.name || profile.email,
      addedAltName: addedAltName,
    };
  }

  /**
   * Commit a parsed preview's rows as the term's table, WHOLESALE: every
   * existing row for the term is removed first, then the new rows inserted.
   * Gated by acknowledge — the caller must pass acknowledgeOverwrite:true
   * when the term already has rows (parsePreview.existingTermWarning), so a
   * destructive replace is always intentional. Writes one ClassScheduleImports
   * log row.
   *
   * @param {Object} payload
   *   @param {string}  payload.term                 term being committed
   *   @param {Array}   payload.rows                  preview rows to store
   *   @param {boolean} [payload.acknowledgeOverwrite]
   * @param {string} user  acting user (for the import log)
   * @returns {{ term, rowCount, matched, unmatched, staff, replaced }}
   */
  function commit(payload, user) {
    payload = payload || {};
    const term = String(payload.term || '').trim();
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (!term)       throw new Error('Term is required to commit a schedule.');
    if (!rows.length) throw new Error('There are no rows to commit.');

    const { sheetId, tab, importsTab } = _cfg();

    const hadRows = _termHasRows(term);
    if (hadRows && payload.acknowledgeOverwrite !== true) {
      throw new Error('A schedule for ' + term + ' already exists. ' +
        'Confirm the overwrite to replace it.');
    }

    // Wholesale replace: delete every existing row for this term, then
    // insert. DataService.remove deletes the FIRST match per call, so loop.
    let guard = 0;
    while (DataService.query(sheetId, tab, 'Term', term).length) {
      DataService.remove(sheetId, tab, 'Term', term);
      if (++guard > 100000) throw new Error('Runaway delete guard in ClassSchedule.commit.');
    }

    let matched = 0, unmatched = 0, staff = 0;
    rows.forEach(r => {
      if (r.isStaff) staff++;
      else if (r.instructorEmail) matched++;
      else unmatched++;

      DataService.insert(sheetId, tab, {
        RowID:           DataService.generateId('CS'),
        Term:            term,
        Course:          r.course || '',
        Title:           r.title || '',
        Section:         r.section || '',
        ClassNbr:        r.classNbr || '',
        Units:           r.units || '',
        Component:       r.component || '',
        InstructorRaw:   r.instructorRaw || '',
        InstructorEmail: r.instructorEmail || '',
        MatchMethod:     r.matchMethod || (r.isStaff ? MATCH.STAFF : MATCH.UNMATCHED),
        IsStaffPlaceholder: r.isStaff ? 'TRUE' : 'FALSE',
      });
    });

    DataService.insert(sheetId, importsTab, {
      ImportID:        DataService.generateId('CSIMP'),
      Term:            term,
      RowCount:        rows.length,
      MatchedCount:    matched,
      UnmatchedCount:  unmatched,
      StaffCount:      staff,
      ImportedBy:      user || '',
      ReplacedExisting: hadRows ? 'TRUE' : 'FALSE',
    });

    return {
      term: term,
      rowCount: rows.length,
      matched: matched,
      unmatched: unmatched,
      staff: staff,
      replaced: hadRows,
    };
  }


  // ============================================================
  // LOOKUP / ASSIGN FACE  (consumed by any module)
  // ============================================================

  /**
   * The pre-assigned section for (term, course, sponsor): the row whose
   * course matches and whose resolved instructor email is the sponsor.
   * This is the auto-prefill path — a confirmed match means the registrar
   * already assigned that sponsor a section, and the consumer can offer
   * its class number for the advisor to confirm. Returns the section row,
   * or null when there is no pre-assignment.
   *
   * @param {string} term
   * @param {string} course        e.g. "ANTH 199"
   * @param {string} sponsorEmail
   * @returns {Object|null}
   */
  function findPreassigned(term, course, sponsorEmail) {
    const email = _norm(sponsorEmail);
    if (!email) return null;
    return _courseRows(term, course).find(r =>
      _norm(r.InstructorEmail) === email) || null;
  }

  /**
   * The unassigned pool for (term, course): "Staff" placeholder sections a
   * consumer can draw an unused class number from when the sponsor has no
   * pre-assignment. Section rows, in section order.
   *
   * @returns {Object[]}
   */
  function availablePool(term, course) {
    return _courseRows(term, course)
      .filter(r => _isTrue(r.IsStaffPlaceholder) || !String(r.InstructorEmail || '').trim())
      .sort(_bySection);
  }

  /**
   * Reassignable sections for (term, course): NAMED sections whose
   * instructor is not in the caller-supplied exclusion set (e.g. sponsors
   * who already have a live petition this term). The service does not know
   * what a petition is, so the caller passes the emails to exclude. These
   * are repurposing candidates — taking a number listed under a faculty
   * member who is not sponsoring an individual study — and a consumer
   * should confirm before using one. Returns named, non-excluded section
   * rows.
   *
   * @param {string} term
   * @param {string} course
   * @param {string[]} [excludeSponsorEmails]
   * @returns {Object[]}
   */
  function reassignable(term, course, excludeSponsorEmails) {
    const exclude = {};
    (excludeSponsorEmails || []).forEach(e => { exclude[_norm(e)] = true; });
    return _courseRows(term, course)
      .filter(r => {
        const email = String(r.InstructorEmail || '').trim();
        if (!email) return false;                 // unnamed -> that's the pool
        if (_isTrue(r.IsStaffPlaceholder)) return false;
        return !exclude[_norm(email)];
      })
      .sort(_bySection);
  }

  /**
   * All stored section rows for a term (any course). Mostly for a
   * consumer's admin/inspection views. Raw records — shaping is the
   * caller's job.
   */
  function sectionsForTerm(term) {
    const { sheetId, tab } = _cfg();
    return DataService.query(sheetId, tab, 'Term', String(term || '').trim());
  }

  /**
   * The distinct terms that have committed schedule rows, each decoded to a
   * human Quarter/Year label. Drives a consumer's term-first selection: a
   * term with no imported schedule is simply not offered. Newest first.
   *
   * @returns {Array<{ term, quarter, year, label }>}
   */
  function availableTerms() {
    const { sheetId, tab } = _cfg();
    const seen = {};
    DataService.getAll(sheetId, tab).forEach(r => {
      const t = String(r.Term || '').trim();
      if (t) seen[t] = true;
    });
    return Object.keys(seen)
      .map(t => {
        const d = decodeTermCode(t);
        return { term: t, quarter: d.quarter, year: d.year, label: d.label };
      })
      // Sort by the numeric term code descending (newest first); codes sort
      // chronologically because year digits precede the quarter digit.
      .sort((a, b) => Number(b.term) - Number(a.term));
  }

  /**
   * The distinct courses present in a term's schedule, each with the credit
   * (Units) value carried by its sections. Optionally restricted to an
   * allowlist of course tokens (so a consumer shows only its own slice —
   * e.g. the undergraduate module excludes grad courses and 195S).
   *
   * Credits come from the schedule, not from code: a course's credit value
   * is the Units of its sections. If a course's sections disagree on Units
   * (they should not), the most common value wins and the rest are noted.
   *
   * @param {string} term
   * @param {Object} [opts]
   *   @param {string[]} [opts.allowlist]  course tokens to include (others dropped)
   * @returns {Array<{ course, credits, sectionCount }>}
   */
  function coursesForTerm(term, opts) {
    opts = opts || {};
    const allow = opts.allowlist
      ? opts.allowlist.map(c => String(c).trim().toUpperCase())
      : null;
    const rows = sectionsForTerm(term);
    const byCourse = {};
    rows.forEach(r => {
      const course = String(r.Course || '').trim();
      if (!course) return;
      if (allow && allow.indexOf(course.toUpperCase()) === -1) return;
      (byCourse[course] = byCourse[course] || []).push(r);
    });
    return Object.keys(byCourse)
      .map(course => {
        const units = byCourse[course]
          .map(r => _unitsNum(r.Units))
          .filter(n => n !== null);
        const titles = byCourse[course]
          .map(r => String(r.Title || '').trim())
          .filter(t => t);
        return {
          course: course,
          title: _mode(titles) || '',            // most common Class Title
          credits: _mode(units),                 // most common Units value
          sectionCount: byCourse[course].length,
        };
      })
      .sort((a, b) => String(a.course).localeCompare(String(b.course),
        undefined, { numeric: true, sensitivity: 'base' }));
  }

  /**
   * Sections for (term, course), filtered to a target credit value when
   * given (Units === credits). Each row is annotated so a consumer can
   * render a single menu: isStaff / isAssigned (a named instructor) and the
   * resolved instructor. Sorted unassigned-first, then by section.
   *
   * If a credit target is given and NO section matches it, returns ALL
   * course sections with matchedCredits:false on the result, so the
   * consumer can show everything with a "none match N credits" note rather
   * than an empty list.
   *
   * @param {string} term
   * @param {string} course
   * @param {Object} [opts]
   *   @param {number|string} [opts.units]  target credit value to match
   * @returns {{ sections: Object[], matchedCredits: boolean, target: (number|null) }}
   */
  function sectionsForCourse(term, course, opts) {
    opts = opts || {};
    const all = _courseRows(term, course).map(_annotateSection).sort(_byAvailability);
    const target = (opts.units === undefined || opts.units === null || opts.units === '')
      ? null : _unitsNum(opts.units);

    if (target === null) {
      return { sections: all, matchedCredits: true, target: null };
    }
    const matched = all.filter(s => _unitsNum(s.units) === target);
    if (matched.length) {
      return { sections: matched, matchedCredits: true, target: target };
    }
    // No section at that credit value — return all, flagged, never empty.
    return { sections: all, matchedCredits: false, target: target };
  }

  /** Whether a committed table exists for a term. */
  function hasTerm(term) {
    return _termHasRows(String(term || '').trim());
  }

  /** The committed-import log rows (newest first), for an admin view. */
  function importHistory() {
    const { sheetId, importsTab } = _cfg();
    return DataService.getAll(sheetId, importsTab).slice().reverse();
  }

  /**
   * Decode a registrar term code to Quarter/Year. UCSC convention:
   * first 3 digits are an abbreviated year ("225" -> 2025: leading 2 is the
   * century marker, next two are the year), last digit is the quarter
   * (0=Winter, 2=Spring, 4=Summer, 8=Fall). A code that does not match this
   * shape degrades to { quarter:'', year:'', label:<raw code> } so a
   * malformed code is shown rather than mislabeled.
   *
   * @param {string} code  e.g. "2258"
   * @returns {{ term, quarter, year, label }}
   */
  function decodeTermCode(code) {
    const s = String(code == null ? '' : code).trim();
    const QUARTERS = { '0': 'Winter', '2': 'Spring', '4': 'Summer', '8': 'Fall' };
    if (!/^\d{4}$/.test(s)) {
      return { term: s, quarter: '', year: '', label: s };
    }
    const year = 2000 + Number(s.slice(1, 3));   // "225" -> 25 -> 2025
    const quarter = QUARTERS[s.slice(3)] || '';
    if (!quarter) {
      return { term: s, quarter: '', year: String(year), label: s };
    }
    return { term: s, quarter: quarter, year: String(year), label: quarter + ' ' + year };
  }


  // ============================================================
  // PRIVATE — instructor matching
  // ============================================================

  /**
   * Build a snapshot index of active profiles keyed by the strings we can
   * match a report row against: each profile's name, nameLastFirst, and
   * every AltName, plus its cruzid (local part of a @ucsc.edu email).
   * Returns { byKey: { normalizedString -> profile }, byCruzid: {...} }.
   */
  function _profileIndex() {
    const byKey = {};
    const byCruzid = {};
    Auth.listUsers().forEach(p => {
      if (p.active === false) return;
      const add = s => { const k = _norm(s); if (k) byKey[k] = byKey[k] || p; };
      add(p.name);
      add(p.nameLastFirst);
      _altNamesOf(p).forEach(add);
      const cruzid = _cruzidOf(p.email);
      if (cruzid) byCruzid[cruzid] = byCruzid[cruzid] || p;
    });
    return { byKey: byKey, byCruzid: byCruzid };
  }

  /**
   * Resolve a raw instructor string to { email, name, method }.
   * "Staff" -> staff (unassigned). CruzID-in-parens -> cruzid match.
   * Else exact name/altname match. Else unmatched.
   */
  function _resolveInstructor(raw, profiles) {
    const s = String(raw || '').trim();
    if (!s || _norm(s) === STAFF) {
      return { email: '', name: '', method: MATCH.STAFF };
    }

    // 1. CruzID in parentheses, e.g. "Mark Anderson (mda)".
    const cruzid = _parenCruzid(s);
    if (cruzid) {
      const p = profiles.byCruzid[cruzid];
      if (p) return { email: p.email, name: _label(p), method: MATCH.CRUZID };
      // CruzID present but no profile: still a strong key — synthesize the
      // ucsc address so the consumer can route, but mark it cruzid so the
      // advisor preview can show it resolved-by-id even without a profile.
      return { email: cruzid + '@ucsc.edu', name: _nameBeforeParen(s), method: MATCH.CRUZID };
    }

    // 2. Exact match against name / nameLastFirst / AltNames.
    const hit = profiles.byKey[_norm(s)];
    if (hit) {
      const viaAlt = _altNamesOf(hit).some(a => _norm(a) === _norm(s));
      return { email: hit.email, name: _label(hit), method: viaAlt ? MATCH.ALTNAME : MATCH.NAME };
    }

    // 3. Unmatched — surfaced for advisor resolution.
    return { email: '', name: '', method: MATCH.UNMATCHED };
  }

  /** "(mda)" -> "mda"; returns '' when absent. Lowercased. */
  function _parenCruzid(s) {
    const m = String(s).match(/\(([A-Za-z0-9._-]+)\)\s*$/);
    return m ? m[1].toLowerCase() : '';
  }

  /** "Mark Anderson (mda)" -> "Mark Anderson". */
  function _nameBeforeParen(s) {
    return String(s).replace(/\s*\([^)]*\)\s*$/, '').trim();
  }

  /** Local part of a @ucsc.edu email, lowercased; '' if not ucsc. */
  function _cruzidOf(email) {
    const e = _norm(email);
    const at = e.indexOf('@');
    if (at === -1) return '';
    return e.slice(0, at);
  }

  function _label(p) {
    return p.nameLastFirst || p.name || p.email;
  }

  /** Parse a profile's AltNames into an array, tolerating JSON or blank. */
  function _altNamesOf(p) {
    const v = p && p.altNames;
    if (Array.isArray(v)) return v.slice();
    if (!v) return [];
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }


  // ============================================================
  // PRIVATE — table access + CSV parsing + small helpers
  // ============================================================

  function _courseRows(term, course) {
    const { sheetId, tab } = _cfg();
    const t = String(term || '').trim();
    const c = String(course || '').trim();
    return DataService.query(sheetId, tab, 'Term', t)
      .filter(r => String(r.Course || '').trim() === c);
  }

  function _termHasRows(term) {
    const { sheetId, tab } = _cfg();
    const t = String(term || '').trim();
    if (!t) return false;
    return DataService.query(sheetId, tab, 'Term', t).length > 0;
  }

  function _decodeCsv(payload) {
    if (payload.csvText) return String(payload.csvText);
    const b64 = String(payload.csvBase64 || '').trim();
    if (!b64) throw new Error('Attach the Schedule of Classes CSV.');
    const bytes = Utilities.base64Decode(b64);
    return Utilities.newBlob(bytes).getDataAsString();
  }

  /**
   * Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded
   * commas, and doubled quotes ("") inside quotes. Returns array of rows,
   * each an array of cell strings. Good enough for the registrar export,
   * which quotes instructor names like "Habicht Mauche,J.A.".
   */
  function _parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field); field = '';
      } else if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else {
        field += ch;
      }
    }
    // Flush trailing field/row if the file does not end in a newline.
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // Drop fully-empty trailing rows.
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  function _headerIndexes(headers) {
    const idx = {};
    Object.keys(COL).forEach(k => { idx[COL[k]] = headers.indexOf(COL[k]); });
    return idx;
  }

  function _cell(rawRow, idx, colName) {
    const i = idx[colName];
    return (i === -1 || i >= rawRow.length) ? '' : rawRow[i];
  }

  /**
   * A footer/blank line. The export ends with a "...,Count:,269,..." row
   * whose Course/ClassNbr cells are empty and which carries the word
   * "Count:" somewhere. Anything with no course and no class number is
   * treated as non-data.
   */
  function _isFooterOrBlank(rawRow, idx) {
    const joined = rawRow.join('').trim();
    if (!joined) return true;
    if (rawRow.some(c => String(c).trim().toLowerCase() === 'count:')) return true;
    const course   = String(_cell(rawRow, idx, COL.COURSE)).trim();
    const classNbr = String(_cell(rawRow, idx, COL.CLASS_NBR)).trim();
    return !course && !classNbr;
  }

  function _bySection(a, b) {
    return String(a.Section || '').localeCompare(String(b.Section || ''),
      undefined, { numeric: true, sensitivity: 'base' });
  }

  /**
   * Shape one stored section row for a consumer's section list, annotating
   * availability. isStaff = a placeholder/unassigned section (the free pool);
   * isAssigned = a named, resolved instructor (relay or reassignment).
   */
  function _annotateSection(r) {
    const hasInstructor = !!String(r.InstructorEmail || '').trim();
    const isStaff = _isTrue(r.IsStaffPlaceholder) || !hasInstructor;
    return {
      rowId: r.RowID,
      course: r.Course,
      section: r.Section,
      classNbr: r.ClassNbr,
      units: r.Units,
      component: r.Component,
      instructorRaw: r.InstructorRaw,
      instructorEmail: r.InstructorEmail,
      matchMethod: r.MatchMethod,
      isStaff: isStaff,
      isAssigned: !isStaff,
    };
  }

  /** Sort unassigned (Staff) sections first, then by section number. */
  function _byAvailability(a, b) {
    if (a.isStaff !== b.isStaff) return a.isStaff ? -1 : 1;
    return String(a.section || '').localeCompare(String(b.section || ''),
      undefined, { numeric: true, sensitivity: 'base' });
  }

  /** Parse a Units cell to a number, or null when blank/non-numeric. */
  function _unitsNum(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }

  /** Most frequent value in an array of numbers (ties: first seen). null if empty. */
  function _mode(nums) {
    if (!nums || !nums.length) return null;
    const count = {};
    let best = nums[0], bestN = 0;
    nums.forEach(n => {
      count[n] = (count[n] || 0) + 1;
      if (count[n] > bestN) { bestN = count[n]; best = n; }
    });
    return best;
  }

  function _isTrue(v) { return String(v).toUpperCase() === 'TRUE'; }
  function _norm(s)   { return String(s == null ? '' : s).trim().toLowerCase(); }


  return {
    // import face
    parsePreview, resolveUnmatched, commit,
    // lookup / assign face
    findPreassigned, availablePool, reassignable,
    sectionsForTerm, sectionsForCourse,
    availableTerms, coursesForTerm, decodeTermCode,
    hasTerm, importHistory,
  };

})();


/* ============================================================
 * CONFIG / SETUP additions — applied separately to Config.gs and
 * Setup.gs (provided as drop-in patches). Reproduced here so the
 * service documents its own storage contract.
 *
 * Config.gs — CONFIG.SHEETS: add (leave blank; setUp creates + logs id)
 *     CLASS_SCHEDULE: '',   // Tabs: ClassSchedule, ClassScheduleImports
 *
 * Config.gs — CONFIG.TABS: add
 *     CLASS_SCHEDULE:         'ClassSchedule',
 *     CLASS_SCHEDULE_IMPORTS: 'ClassScheduleImports',
 *
 * Setup.gs — SETUP_SCHEMA: add
 *     CLASS_SCHEDULE: {
 *       tab: 'ClassSchedule',
 *       headers: ['RowID', 'Term', 'Course', 'Section', 'ClassNbr', 'Units',
 *                 'Component', 'InstructorRaw', 'InstructorEmail', 'MatchMethod',
 *                 'IsStaffPlaceholder',
 *                 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
 *       seed: [],
 *     },
 *     CLASS_SCHEDULE_IMPORTS: {
 *       tab: 'ClassScheduleImports',
 *       headers: ['ImportID', 'Term', 'RowCount', 'MatchedCount', 'UnmatchedCount',
 *                 'StaffCount', 'ImportedBy', 'ReplacedExisting',
 *                 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
 *       seed: [],
 *     },
 *
 * Setup.gs — setUp(): resolve the spreadsheet and create its tabs
 *     const classScheduleSS = _resolveSpreadsheet(
 *       CONFIG.SHEETS.CLASS_SCHEDULE, 'Portal Class Schedule', 'CLASS_SCHEDULE');
 *     _setupTab(classScheduleSS, SETUP_SCHEMA.CLASS_SCHEDULE);
 *     _setupTab(classScheduleSS, SETUP_SCHEMA.CLASS_SCHEDULE_IMPORTS);
 *     _tidyDefaultSheet(classScheduleSS);
 *
 * Setup.gs — _schemaPlacement(): add
 *     { sheetKey: 'CLASS_SCHEDULE', def: SETUP_SCHEMA.CLASS_SCHEDULE },
 *     { sheetKey: 'CLASS_SCHEDULE', def: SETUP_SCHEMA.CLASS_SCHEDULE_IMPORTS },
 *
 * Setup.gs — checkSetup() (optional): add
 *     ['CLASS_SCHEDULE', CONFIG.SHEETS.CLASS_SCHEDULE,
 *      [SETUP_SCHEMA.CLASS_SCHEDULE.tab, SETUP_SCHEMA.CLASS_SCHEDULE_IMPORTS.tab]],
 * ============================================================ */