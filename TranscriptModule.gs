// ============================================================
// TranscriptModule.gs — Layer 1: ASSIST articulation sync
// ============================================================
// Pulls UCSC Anthropology lower-division articulation agreements from
// the ASSIST public API for every California community college that has
// a published Major agreement with UCSC, and stores them in this
// module's own spreadsheet (CONFIG.SHEETS.TRANSCRIPT):
//
//   Articulations       — trusted, clean 1:1 course equivalencies
//   ArticulationReview  — anything NOT a clean 1:1 (multi-course groups,
//                         AND/OR conjunctions, denied courses, advisement,
//                         no-articulation, or parse failures), flagged for
//                         advisor review with the raw cell JSON retained
//
// Layer 1 scope: the sync engine + the two tables + a match report.
// (Layer 2 = student upload + advisor review screen; Layer 3 = PDF
//  extraction. Not in this file.)
//
// Conventions honored (see Readme module development):
//   - One IIFE returning named actions; signature (payload, user, roles).
//   - Privileged actions check roles and always allow super_admin.
//   - All sheet I/O via DataService (read/write by header name).
//   - Own spreadsheet via CONFIG.SHEETS.TRANSCRIPT; tabs in SETUP_SCHEMA.
//   - No top-level globals beyond this single const (shared global scope).
//   - Read-only consumer of an unofficial-but-stable ASSIST API; the
//     stored tables are a durable snapshot, so an API change degrades
//     sync without breaking stored data.
//   - Anthropology-only, lower-division only.
//
// Registration (only after this file ships): add 'TranscriptModule' to
// getModuleHandler() and getRegisteredHandlers() in Code.gs, then add the
// Modules sheet row via Admin → Modules.
// ============================================================

const TranscriptModule = (() => {

  // ── Module-local constants (kept inside the IIFE so they never collide
  //    with the project's shared global scope) ──────────────────────────
  const SHEET   = () => CONFIG.SHEETS.TRANSCRIPT;
  const T_ARTIC = () => CONFIG.TABS.ARTICULATIONS;        // 'Articulations'
  const T_REVIEW = () => CONFIG.TABS.ARTICULATION_REVIEW; // 'ArticulationReview'

  const cfg = () => (CONFIG.TRANSCRIPT || {});
  const API_BASE = () => cfg().ASSIST_API_BASE || 'https://prod.assistng.org';
  const UCSC_ID  = () => cfg().UCSC_INSTITUTION_ID;        // 132
  const ANTHRO   = () => (cfg().ANTHRO_MATCH_SUBSTRING || 'anthropolog').toLowerCase();

  // Receiving-course allowlist, normalized to a Set of "PREFIX NUMBER"
  // upper-cased+trimmed for O(1) membership tests. Empty/missing list means
  // "no filter" (keep everything) — but in practice the list is configured.
  function _allowSet() {
    const list = cfg().RECEIVING_COURSE_ALLOWLIST || [];
    const s = {};
    list.forEach(item => { s[_normCourse(item)] = true; });
    return s;
  }
  function _normCourse(s) {
    return String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
  }
  // Is this parsed cell's RECEIVING course in the allowlist? (applies to
  // both simple and flagged cells; an empty allowlist keeps everything.)
  function _cellAllowed(cell, allowSet) {
    if (!allowSet || !Object.keys(allowSet).length) return true;
    const key = _normCourse(cell.receiving.prefix + ' ' + cell.receiving.number);
    return !!allowSet[key];
  }

  // Review reasons — stable strings so the UI can group/filter.
  const REASON = {
    MULTI_GROUP: 'multiple course groups',
    GROUP_AND:   'internal AND (multiple courses required)',
    GROUP_OR:    'OR between course groups',
    DENIED:      'denied courses present',
    ADVISEMENT:  'advisement / non-course requirement',
    NO_ARTIC:    'no articulation (per ASSIST)',
    PARSE:       'could not parse cell',
  };

  // ASSIST academic-year ids are stable; the /AcademicYears endpoint is
  // key-gated, so we surface a small known window for the dropdown rather
  // than hardcode-and-rot a single value. Extend as ASSIST opens years.
  const ACADEMIC_YEARS = [
    { id: 74, code: '2023-2024' },
    { id: 75, code: '2024-2025' },
    { id: 76, code: '2025-2026' },
    { id: 77, code: '2026-2027' },
  ];
  const DEFAULT_YEAR_ID = 76;

  // ========================================================================
  // Public actions (dispatchable)
  // ========================================================================

  /** Years for the sync dropdown. No privilege needed (read-only metadata). */
  function listAcademicYears(payload, user, roles) {
    return { years: ACADEMIC_YEARS.slice(), defaultId: DEFAULT_YEAR_ID };
  }

  /** Counts per year for the module landing screen. */
  function getSummary(payload, user, roles) {
    const years = {};
    let totalTrusted = 0, totalFlagged = 0;

    DataService.getAll(SHEET(), T_ARTIC()).forEach(r => {
      const y = String(r.CatalogYear || '');
      if (!years[y]) years[y] = { trusted: 0, flagged: 0 };
      years[y].trusted++; totalTrusted++;
    });
    DataService.getAll(SHEET(), T_REVIEW()).forEach(r => {
      const y = String(r.CatalogYear || '');
      if (!years[y]) years[y] = { trusted: 0, flagged: 0 };
      years[y].flagged++; totalFlagged++;
    });

    return { years, totalTrusted, totalFlagged };
  }

  /**
   * The articulation review list — flagged (non-1:1) rows for an admin to
   * confirm against assist.org. Optionally filter by year via payload.year.
   * Read-only; entry to the module is already gated to super_admin/staff via
   * the registry Roles, so no extra per-action check is needed here.
   *
   * Returns ONLY the human-readable display columns — deliberately NOT the
   * RawCell blob. RawCell holds the full nested ASSIST cell JSON (large,
   * heavily quoted); shipping ~47 of those back through google.script.run
   * bloats and can break the return serialization, which is why the list
   * view never carries it. The raw JSON stays in the sheet for anyone who
   * needs to inspect a specific case directly.
   */
  function listReview(payload, user, roles) {
    payload = payload || {};
    let rows = DataService.getAll(SHEET(), T_REVIEW());
    if (payload.year) {
      rows = rows.filter(r => String(r.CatalogYear) === String(payload.year));
    }
    // Sort by college then UCSC course for a stable, readable list.
    rows.sort((a, b) => {
      const ca = String(a.SendingCollege || ''), cb = String(b.SendingCollege || '');
      if (ca !== cb) return ca < cb ? -1 : 1;
      const ra = String(a.ReceivingPrefix || '') + String(a.ReceivingNumber || '');
      const rb = String(b.ReceivingPrefix || '') + String(b.ReceivingNumber || '');
      return ra < rb ? -1 : (ra > rb ? 1 : 0);
    });
    // Project to display columns only (omit RawCell and meta columns).
    // AssistUrl is built server-side from the year + sending college so the
    // UI can render a "View on ASSIST" link straight to the agreement.
    return rows.map(r => ({
      CatalogYear: r.CatalogYear,
      SendingCollege: r.SendingCollege,
      SendingCollegeId: r.SendingCollegeId,
      ReceivingPrefix: r.ReceivingPrefix,
      ReceivingNumber: r.ReceivingNumber,
      ReceivingCourseId: r.ReceivingCourseId,
      ReceivingTitle: r.ReceivingTitle,
      Reason: r.Reason,
      AssistUrl: _assistAgreementUrl(r.CatalogYear, r.SendingCollegeId),
    }));
  }

  /**
   * Sync UCSC Anthropology articulations for a catalog year.
   * Privileged: super_admin or staff only.
   * @param {Object} payload - { academicYearId, academicYearCode? }
   */
  function syncArticulations(payload, user, roles) {
    if (!roles.includes('super_admin') && !roles.includes('staff')) {
      throw new Error('Not authorized: syncing articulations requires super_admin or staff.');
    }
    payload = payload || {};
    const yearId = payload.academicYearId;
    if (!yearId) throw new Error('academicYearId is required to sync.');
    if (!UCSC_ID()) {
      throw new Error('CONFIG.TRANSCRIPT.UCSC_INSTITUTION_ID is not set (expected 132).');
    }

    const yearCode = payload.academicYearCode || _resolveYearCode(yearId);
    const syncedDate = new Date().toISOString();

    const report = {
      academicYearId: yearId,
      academicYearCode: yearCode,
      syncedDate: syncedDate,
      institutionsChecked: 0,
      collegesWithAnthroAgreement: [],
      collegesWithoutAnthroAgreement: [],
      fetchFailures: [],
      trustedRowCount: 0,
      flaggedRowCount: 0,
      perCollege: [],
    };

    const trustedRows = [];
    const reviewRows = [];

    // 1) Derive the feeder list: CCCs with a published agreement to UCSC.
    const sending = _assistGetSendingInstitutions(UCSC_ID(), yearId);

    sending.forEach(inst => {
      if (!inst.isCommunityCollege) return;
      report.institutionsChecked++;

      const per = {
        collegeId: inst.id, collegeName: inst.name,
        anthroAgreementLabel: null, trusted: 0, flagged: 0, note: '',
      };

      try {
        // 2) Find ALL of this college's UCSC Anthropology agreements
        //    (major, minor, etc.) — for prereq hunting we merge them.
        const reports = _assistListMajorAgreements(UCSC_ID(), inst.id, yearId);
        const anthroAgreements = _findAllAnthro(reports);

        if (!anthroAgreements.length) {
          report.collegesWithoutAnthroAgreement.push(inst.name);
          per.note = 'no Anthropology agreement found, checked ' + syncedDate;
          report.perCollege.push(per);
          return;
        }
        per.anthroAgreementLabel = anthroAgreements.map(a => a.label).join(' + ');

        // 3) Fetch + parse EACH matching agreement, accumulating all cells.
        let allCells = [];
        anthroAgreements.forEach(ag => {
          const agreement = _assistGetAgreement(ag.key);
          allCells = allCells.concat(_parseCells(agreement));
        });

        // 3b) Keep only cells whose RECEIVING course is in the allowlist
        //     (e.g. ANTH 1/2/3) — applies to simple AND flagged alike, so a
        //     flagged target course still reaches review.
        const allowSet = _allowSet();
        allCells = allCells.filter(c => _cellAllowed(c, allowSet));

        // 4) Dedupe across agreements. Key on the receiving+sending course
        //    pair (for simple cells) or the receiving course alone (for
        //    flags, which have no single sending course). Flag-takes-
        //    precedence: if the same receiving course is simple in one
        //    agreement but flagged in another, the flag wins — we never
        //    assert a clean 1:1 that another agreement contradicts.
        const merged = _dedupeCells(allCells, inst, yearCode, syncedDate);

        merged.trusted.forEach(row => { trustedRows.push(row); per.trusted++; });
        merged.flagged.forEach(row => { reviewRows.push(row); per.flagged++; });

        report.collegesWithAnthroAgreement.push(inst.name);
        report.perCollege.push(per);

      } catch (err) {
        // One college failing logs and continues; never aborts the run.
        report.fetchFailures.push({ college: inst.name, collegeId: inst.id, error: String(err) });
        per.note = 'ERROR: ' + String(err);
        report.perCollege.push(per);
      }
    });

    // 4) Replace this year's rows (other years preserved = coexistence).
    _replaceYear(T_ARTIC(), yearCode, trustedRows);
    _replaceYear(T_REVIEW(), yearCode, reviewRows);

    report.trustedRowCount = trustedRows.length;
    report.flaggedRowCount = reviewRows.length;
    return report;
  }

  // ========================================================================
  // Dedupe — merge cells from multiple agreements for one college
  // ========================================================================

  /**
   * Collapse cells gathered across a college's several Anthropology
   * agreements into deduped trusted/flagged row sets.
   *
   * Rules:
   *   - A receiving UCSC course that is FLAGGED in any agreement is flagged
   *     overall (flag-takes-precedence) — we never trust a 1:1 that another
   *     agreement contradicts. Keyed by receiving course identity.
   *   - Among simple cells for receiving courses NOT flagged anywhere, dedupe
   *     by the full receiving+sending pair, so the same ANTH 1 -> ANTH 1
   *     appearing in both a major and minor agreement yields one row.
   *   - First occurrence wins for a given flag reason / pair (they are
   *     equivalent by construction).
   *
   * @return {{ trusted: Object[], flagged: Object[] }} sheet-ready row objects
   */
  function _dedupeCells(cells, inst, yearCode, syncedDate) {
    const recvKey = r => [r.prefix, r.number, r.courseId].join('|');
    const pairKey = c => recvKey(c.receiving) + '>>' +
      [c.sending.prefix, c.sending.number, c.sending.courseId].join('|');

    // Pass 1: which receiving courses are flagged anywhere?
    const flaggedRecv = {};       // recvKey -> first flag cell
    cells.forEach(c => {
      if (c.kind !== 'simple') {
        const k = recvKey(c.receiving);
        if (!flaggedRecv[k]) flaggedRecv[k] = c;
      }
    });

    // Pass 2: trusted rows for receiving courses not flagged anywhere,
    // deduped by full pair.
    const trusted = [];
    const seenPair = {};
    cells.forEach(c => {
      if (c.kind !== 'simple') return;
      if (flaggedRecv[recvKey(c.receiving)]) return; // flag wins
      const pk = pairKey(c);
      if (seenPair[pk]) return;
      seenPair[pk] = true;
      trusted.push({
        CatalogYear: yearCode,
        SendingCollege: inst.name,
        SendingCollegeId: inst.id,
        SendingPrefix: c.sending.prefix,
        SendingNumber: c.sending.number,
        SendingCourseId: c.sending.courseId,
        SendingTitle: c.sending.title,
        ReceivingPrefix: c.receiving.prefix,
        ReceivingNumber: c.receiving.number,
        ReceivingCourseId: c.receiving.courseId,
        ReceivingTitle: c.receiving.title,
        SyncedDate: syncedDate,
      });
    });

    // Flagged rows: one per flagged receiving course.
    const flagged = [];
    Object.keys(flaggedRecv).forEach(k => {
      const c = flaggedRecv[k];
      flagged.push({
        CatalogYear: yearCode,
        SendingCollege: inst.name,
        SendingCollegeId: inst.id,
        ReceivingPrefix: c.receiving.prefix,
        ReceivingNumber: c.receiving.number,
        ReceivingCourseId: c.receiving.courseId,
        ReceivingTitle: c.receiving.title,
        Reason: c.reason,
        RawCell: c.raw,
        SyncedDate: syncedDate,
      });
    });

    return { trusted: trusted, flagged: flagged };
  }

  // ========================================================================
  // Parser — classify each agreement cell as simple 1:1 or flag-for-review
  // ========================================================================

  function _parseCells(agreement) {
    const out = [];
    const artics = _safeJson(agreement && agreement.articulations);
    if (!artics || !artics.length) return out;

    artics.forEach(cell => {
      const artic = (cell && cell.articulation) ? cell.articulation : cell;
      const receiving = _receivingCourse(artic, cell);

      const recvType = (artic && artic.type) || (cell && cell.type);
      if (recvType && String(recvType).toLowerCase() !== 'course') {
        out.push(_flag(REASON.ADVISEMENT, cell, receiving)); return;
      }

      const sa = artic && artic.sendingArticulation;
      if (!sa) { out.push(_flag(REASON.PARSE, cell, receiving)); return; }

      if (sa.noArticulationReason) {
        out.push(_flag(REASON.NO_ARTIC, cell, receiving)); return;
      }
      if (sa.deniedCourses && sa.deniedCourses.length) {
        out.push(_flag(REASON.DENIED, cell, receiving)); return;
      }
      if (sa.courseGroupConjunctions && sa.courseGroupConjunctions.length) {
        out.push(_flag(REASON.GROUP_OR, cell, receiving)); return;
      }

      const groups = sa.items || [];
      if (groups.length === 0) { out.push(_flag(REASON.PARSE, cell, receiving)); return; }
      if (groups.length > 1)   { out.push(_flag(REASON.MULTI_GROUP, cell, receiving)); return; }

      const items = (groups[0] && groups[0].items) || [];
      const courses = [];
      let hasNonCourse = false;
      items.forEach(it => {
        if (it && String(it.type).toLowerCase() === 'course') courses.push(it);
        else hasNonCourse = true;
      });
      if (hasNonCourse) { out.push(_flag(REASON.ADVISEMENT, cell, receiving)); return; }
      if (courses.length !== 1) { out.push(_flag(REASON.GROUP_AND, cell, receiving)); return; }

      const sendingCourse = _sendingCourse(courses[0]);
      if (!sendingCourse.prefix || !sendingCourse.number) {
        out.push(_flag(REASON.PARSE, cell, receiving)); return;
      }

      out.push({ kind: 'simple', sending: sendingCourse, receiving: receiving });
    });

    return out;
  }

  function _flag(reason, cell, receiving) {
    return { kind: 'flag', reason: reason, raw: JSON.stringify(cell), receiving: receiving };
  }

  function _receivingCourse(artic, cell) {
    const src = (artic && artic.course) || (cell && cell.course) ||
                (cell && cell.receiving) || null;
    if (src) {
      return {
        prefix: src.prefix || '',
        number: src.courseNumber || '',
        courseId: src.courseIdentifierParentId || '',
        title: src.courseTitle || '',
      };
    }
    return { prefix: '', number: '', courseId: '', title: '' };
  }

  function _sendingCourse(item) {
    return {
      prefix: item.prefix || '',
      number: item.courseNumber || '',
      courseId: item.courseIdentifierParentId || '',
      title: item.courseTitle || '',
    };
  }

  // ========================================================================
  // ASSIST API (UrlFetchApp — allowlist-free from Apps Script)
  // ========================================================================

  function _assistJson(url) {
    const resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { accept: 'application/json' },
      muteHttpExceptions: true,
      followRedirects: true,
    });
    const code = resp.getResponseCode();
    if (code < 200 || code >= 300) throw new Error('ASSIST API ' + code + ' for ' + url);
    return JSON.parse(resp.getContentText());
  }

  /**
   * Institutions that have a published agreement with UCSC. Uses the
   * key-free "Get Agreement Institutions" route:
   *   /articulation/api/Agreements/Published/from/{institutionId}
   * Each result wraps the partner under .receivingInstitution and lists the
   * academic-year ids in which that partner SENDS agreements to UCSC under
   * .sendingYearIds. We keep CCC partners whose sendingYearIds include the
   * target year — i.e. the colleges that articulate TO UCSC that year.
   * Returns [{ id, name, isCommunityCollege }].
   */
  function _assistGetSendingInstitutions(receivingId, yearId) {
    const url = API_BASE() + '/articulation/api/Agreements/Published/from/' + receivingId;
    return _extractInstitutions(_assistJson(url), yearId);
  }

  function _extractInstitutions(json, yearId) {
    const result = (json && json.result) || [];
    const arr = Array.isArray(result) ? result : [];

    const out = [];
    arr.forEach(item => {
      const inst = item && item.receivingInstitution ? item.receivingInstitution : item;
      if (!inst) return;

      // Keep only partners that SEND to UCSC in the target year.
      const sendingYears = item && item.sendingYearIds;
      if (!sendingYears || sendingYears.indexOf(yearId) === -1) return;

      let name = '';
      if (inst.names && inst.names.length) {
        name = inst.names[0].name || inst.names[inst.names.length - 1].name || '';
      } else {
        name = inst.name || '';
      }
      const isCCC = inst.isCommunityCollege === true ||
                    inst.category === 2 || inst.category === 'CCC';

      out.push({ id: inst.id, name: name, isCommunityCollege: isCCC });
    });
    return out;
  }

  /** Major agreements between UCSC (receiving) and a college (sending). */
  function _assistListMajorAgreements(receivingId, sendingId, yearId) {
    const url = API_BASE() + '/articulation/api/Agreements/Published/for/' +
                receivingId + '/to/' + sendingId + '/in/' + yearId + '?types=Major';
    const json = _assistJson(url);
    return (json && json.result && json.result.reports) || [];
  }

  /**
   * All agreements whose label contains the anthropology substring (Major,
   * Minor, B.A., emphases, etc.). For prerequisite hunting the major/minor
   * distinction is irrelevant — we want every valid course equivalency — so
   * the sync pulls pairs from ALL matches and dedupes downstream.
   */
  function _findAllAnthro(reports) {
    return (reports || []).filter(r =>
      String(r.label || '').toLowerCase().indexOf(ANTHRO()) !== -1);
  }

  function _assistGetAgreement(key) {
    const url = API_BASE() + '/articulation/api/Agreements?key=' + encodeURIComponent(key);
    const json = _assistJson(url);
    return json && json.result;
  }

  // ========================================================================
  // Sheet helpers — via DataService only (read/write by header name)
  // ========================================================================

  /**
   * Replace all rows for a catalog year in a tab with a fresh set, preserving
   * other years. DataService has no batch/year-scoped op, so we remove the
   * year's existing rows then insert the new ones. Fine for a periodic,
   * admin-run sync over ~24 colleges.
   *
   * Removal keys on CatalogYear + a per-row identity (ReceivingCourseId +
   * SendingCollegeId) is not needed — we simply delete every row whose
   * CatalogYear matches, then insert. We read the rows once to find matches.
   */
  function _replaceYear(tabName, yearCode, rowObjs) {
    // Delete existing rows for this year. DataService.remove() deletes the
    // FIRST match per call, so loop until none remain.
    let guard = 0;
    while (DataService.query(SHEET(), tabName, 'CatalogYear', yearCode).length) {
      DataService.remove(SHEET(), tabName, 'CatalogYear', yearCode);
      if (++guard > 100000) throw new Error('Runaway delete guard in _replaceYear (' + tabName + ')');
    }
    // Insert fresh rows.
    rowObjs.forEach(obj => DataService.insert(SHEET(), tabName, obj));
  }

  // ========================================================================
  // Utilities
  // ========================================================================

  function _resolveYearCode(yearId) {
    for (let i = 0; i < ACADEMIC_YEARS.length; i++) {
      if (ACADEMIC_YEARS[i].id === yearId) return ACADEMIC_YEARS[i].code;
    }
    return String(yearId);
  }

  // Reverse of _resolveYearCode: "2025-2026" -> 76. Returns '' if unknown,
  // in which case the ASSIST link is omitted rather than built wrong.
  function _resolveYearId(yearCode) {
    for (let i = 0; i < ACADEMIC_YEARS.length; i++) {
      if (ACADEMIC_YEARS[i].code === String(yearCode)) return ACADEMIC_YEARS[i].id;
    }
    return '';
  }

  /**
   * Build a shareable assist.org link to the sending-college -> UCSC
   * agreement, pre-scoped to Major view. Verified format; the GUID-less
   * form lands on the correct agreement page (admin clicks the major to
   * see courses — ASSIST has no per-row anchor). Returns '' if we can't
   * resolve the year id or college id, so the UI simply shows no link
   * rather than a broken one.
   */
  function _assistAgreementUrl(yearCode, sendingCollegeId) {
    const yearId = _resolveYearId(yearCode);
    if (!yearId || !sendingCollegeId || !UCSC_ID()) return '';
    // Human-facing site (distinct from the prod.assistng.org API host).
    const SITE = 'https://assist.org';
    return SITE + '/transfer/results?year=' + yearId +
      '&institution=' + sendingCollegeId +
      '&agreement=' + UCSC_ID() +
      '&agreementType=to&view=agreement&viewBy=major';
  }

  function _safeJson(maybe) {
    if (maybe == null) return null;
    if (typeof maybe === 'object') return maybe;
    try { return JSON.parse(maybe); } catch (e) { return null; }
  }

  /**
   * DRY-RUN diagnostic — fetches from live ASSIST and parses, but writes
   * NOTHING to the sheets. Use this to verify the two endpoints that could
   * not be confirmed offline: the feeder-list route and receiving-course
   * extraction. Privileged: super_admin or staff.
   *
   * @param {Object} payload - {
   *     academicYearId,            // defaults to DEFAULT_YEAR_ID
   *     maxColleges,               // cap colleges probed (default 3); keeps
   *                                // a first run fast and quota-light
   *     sampleRows                 // how many parsed cells to echo (default 5)
   *   }
   * @return {Object} a diagnostic report (feeder count, per-college parse
   *   counts, and sample trusted/flagged rows) — never persisted.
   */
  function diagnose(payload, user, roles) {
    if (!roles.includes('super_admin') && !roles.includes('staff')) {
      throw new Error('Not authorized: diagnose requires super_admin or staff.');
    }
    payload = payload || {};
    const yearId = payload.academicYearId || DEFAULT_YEAR_ID;
    const maxColleges = payload.maxColleges || 3;
    const sampleRows = payload.sampleRows || 5;
    const yearCode = _resolveYearCode(yearId);

    const out = {
      academicYearId: yearId,
      academicYearCode: yearCode,
      step1_feederList: { ok: false, ccCount: 0, sample: [], error: null },
      step2_agreements: [],
      sampleTrusted: [],
      sampleFlagged: [],
    };

    // ── Step 1: feeder list (tests _assistGetSendingInstitutions) ──
    let feeders = [];
    try {
      feeders = _assistGetSendingInstitutions(UCSC_ID(), yearId);
      const cccs = feeders.filter(f => f.isCommunityCollege);
      out.step1_feederList.ok = true;
      out.step1_feederList.ccCount = cccs.length;
      out.step1_feederList.sample = cccs.slice(0, 8).map(c => c.id + ':' + c.name);
      feeders = cccs;
    } catch (err) {
      out.step1_feederList.error = String(err);
      return out; // can't proceed without feeders; surface the error
    }

    // ── Step 2: for up to maxColleges, find + parse ALL Anthropology
    //    agreements, then dedupe — mirrors the real sync exactly. ──
    for (let i = 0; i < feeders.length && i < maxColleges; i++) {
      const inst = feeders[i];
      const row = { collegeId: inst.id, collegeName: inst.name,
                    anthroLabel: null, trusted: 0, flagged: 0, error: null };
      try {
        const reports = _assistListMajorAgreements(UCSC_ID(), inst.id, yearId);
        const anthroAgreements = _findAllAnthro(reports);
        if (!anthroAgreements.length) {
          row.anthroLabel = '(no Anthropology agreement)';
          out.step2_agreements.push(row);
          continue;
        }
        row.anthroLabel = anthroAgreements.map(a => a.label).join(' + ');

        let allCells = [];
        anthroAgreements.forEach(ag => {
          allCells = allCells.concat(_parseCells(_assistGetAgreement(ag.key)));
        });
        const allowSet = _allowSet();
        allCells = allCells.filter(c => _cellAllowed(c, allowSet));
        const merged = _dedupeCells(allCells, inst, out.academicYearCode,
                                    new Date().toISOString());

        row.trusted = merged.trusted.length;
        row.flagged = merged.flagged.length;
        merged.trusted.forEach(r => {
          if (out.sampleTrusted.length < sampleRows) {
            out.sampleTrusted.push(inst.name + ': ' +
              r.SendingPrefix + ' ' + r.SendingNumber +
              ' \u2192 ' + r.ReceivingPrefix + ' ' + r.ReceivingNumber +
              ' (' + (r.ReceivingTitle || '?') + ')');
          }
        });
        merged.flagged.forEach(r => {
          if (out.sampleFlagged.length < sampleRows) {
            out.sampleFlagged.push(inst.name + ': ' +
              r.ReceivingPrefix + ' ' + r.ReceivingNumber +
              ' \u2014 ' + r.Reason);
          }
        });
      } catch (err) {
        row.error = String(err);
      }
      out.step2_agreements.push(row);
    }

    return out;
  }

  // ========================================================================
  // LAYER 2 — student transcript upload (Pass 1: student side)
  // ========================================================================

  const T_TRANSCRIPTS = () => CONFIG.TABS.TRANSCRIPTS;          // 'Transcripts'
  const STATUS = {
    PENDING:        'Pending Review',
    PROCESSED:      'Processed',
    NO_ARTICULATION:'No Articulation',
  };
  const ADVISOR_ROLE = 'staff_undergrad';
  const QUEUE_TASK = { module: 'transcript', sourceType: 'transcript_queue', sourceId: 'PENDING' };

  // ── Claim-set normalization ───────────────────────────────
  // A claim set is the UCSC prereqs a transcript is submitted for. Stored
  // and compared order-independently as a sorted, deduped, allowlist-bounded
  // comma string, e.g. "ANTH 1, ANTH 3".
  function _normalizePrereqs(list) {
    const allow = _allowSet(); // keys are normalized "ANTH 1" etc.
    const seen = {};
    (list || []).forEach(item => {
      const k = _normCourse(item);
      if (k && (!Object.keys(allow).length || allow[k])) seen[k] = true;
    });
    return Object.keys(seen).sort();
  }
  function _claimKey(prereqArr) { return prereqArr.join(', '); }

  // ── Prereq availability for a student ─────────────────────
  // Returns, per allowlisted prereq, the student's current state:
  //   'approved'  — in a Processed transcript (any college)        → locked
  //   'pending'   — in a Pending Review transcript (any college)   → locked
  //   'none'      — claimable
  // PLUS the set of (collegeId, prereq) pairs that returned No Articulation,
  // so the form can block re-submitting the SAME college for that prereq
  // while still allowing a DIFFERENT college.
  function getMyPrereqStatus(payload, user, roles) {
    const mine = DataService.query(SHEET(), T_TRANSCRIPTS(), 'StudentEmail', user);
    const allow = Object.keys(_allowSet());           // ['ANTH 1','ANTH 2','ANTH 3']
    const state = {};
    allow.forEach(p => { state[p] = 'none'; });
    const noArtPairs = {};                            // "collegeId|ANTH 1" -> true

    mine.forEach(r => {
      const prereqs = _normalizePrereqs(String(r.ClaimedPrereqs || '').split(','));
      const status = String(r.Status || '');
      prereqs.forEach(p => {
        if (status === STATUS.PROCESSED) {
          state[p] = 'approved';                      // permanent, beats all
        } else if (status === STATUS.PENDING && state[p] !== 'approved') {
          state[p] = 'pending';
        } else if (status === STATUS.NO_ARTICULATION) {
          noArtPairs[String(r.SendingCollegeId) + '|' + p] = true;
        }
      });
    });

    // Claimable = any prereq not approved/pending. (No-articulation does not
    // lock the prereq itself — only the specific college pair, enforced at
    // upload against noArtPairs.)
    const anyClaimable = allow.some(p => state[p] === 'none');
    return {
      prereqs: allow,
      titles: (cfg().RECEIVING_COURSE_TITLES) || {},  // { 'ANTH 1': 'Introduction to…' }
      state: state,                                   // per-prereq lock state
      noArticulationPairs: Object.keys(noArtPairs),   // "collegeId|ANTH 1"
      anyClaimable: anyClaimable,
    };
  }

  // ── Colleges available to claim against ───────────────────
  // Only colleges that actually appear in the trusted Articulations table —
  // a college with no articulation data can't be matched, so it isn't an
  // option (the form tells such students to contact the advisor).
  function listColleges(payload, user, roles) {
    const rows = DataService.getAll(SHEET(), T_ARTIC());
    const byId = {};
    rows.forEach(r => {
      const id = String(r.SendingCollegeId || '');
      if (id && !byId[id]) byId[id] = { id: id, name: String(r.SendingCollege || '') };
    });
    return Object.keys(byId)
      .map(id => byId[id])
      .sort((a, b) => a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
  }

  // ── The student's own transcripts ─────────────────────────
  function listMyTranscripts(payload, user, roles) {
    const mine = DataService.query(SHEET(), T_TRANSCRIPTS(), 'StudentEmail', user);
    return mine.map(_publicTranscript).sort((a, b) =>
      String(b.uploadedAt) < String(a.uploadedAt) ? -1 :
      (String(b.uploadedAt) > String(a.uploadedAt) ? 1 : 0));
  }

  // ── Upload (or replace) a transcript ──────────────────────
  function uploadTranscript(payload, user, roles) {
    payload = payload || {};
    const collegeId = String(payload.sendingCollegeId || '').trim();
    const collegeName = String(payload.sendingCollege || '').trim();
    const prereqs = _normalizePrereqs(payload.claimedPrereqs);

    if (!collegeId) throw new Error('Select the community college this transcript is from.');
    if (!prereqs.length) throw new Error('Select at least one prerequisite this transcript is for.');

    // Validate the college is one we have articulation data for.
    const validCollege = listColleges({}, user, roles).some(c => c.id === collegeId);
    if (!validCollege) {
      throw new Error('That college has no articulation data on file. Please contact the Undergraduate Advisor.');
    }

    // Server-side lock enforcement (mirrors the form; can't be bypassed).
    const avail = getMyPrereqStatus({}, user, roles);
    prereqs.forEach(p => {
      if (avail.state[p] === 'approved') {
        throw new Error(p + ' has already been approved and cannot be resubmitted.');
      }
      if (avail.state[p] === 'pending') {
        throw new Error(p + ' is already submitted and under review.');
      }
      if (avail.noArticulationPairs.indexOf(collegeId + '|' + p) !== -1) {
        throw new Error('You already submitted ' + collegeName + ' for ' + p +
          ' and it did not articulate. Try a different college, or contact the Undergraduate Advisor.');
      }
    });

    const profile = Auth.getProfile(user);
    if (!profile) throw new Error('Your profile could not be found.');
    const fileName = _buildTranscriptFileName(collegeName, profile);

    // Replacement key: same student + same college + same exact claim set.
    const claimKey = _claimKey(prereqs);
    const mine = DataService.query(SHEET(), T_TRANSCRIPTS(), 'StudentEmail', user);
    const match = mine.filter(r =>
      String(r.SendingCollegeId) === collegeId &&
      _claimKey(_normalizePrereqs(String(r.ClaimedPrereqs || '').split(','))) === claimKey
    )[0];

    if (match) {
      // Replace in place: new file (same id if possible), reset to Pending,
      // clear prior review fields — a fresh submission needs fresh review.
      const replaced = _replacePdf(match.DriveFileID, payload.file, fileName);
      _grantStudentViewer(replaced.fileId, user);
      DataService.update(SHEET(), T_TRANSCRIPTS(), 'TranscriptID', match.TranscriptID, {
        SendingCollege: collegeName,
        ClaimedPrereqs: claimKey,
        Status: STATUS.PENDING,
        ReviewNote: '', ReviewedBy: '', ReviewedAt: '',
        DriveFileID: replaced.fileId, FileName: fileName, DocumentLink: replaced.url,
        UploadedAt: new Date().toISOString(),
      });
      _ensureQueueTask();
      _emailStudentReceipt(user, collegeName, claimKey, true);
      _emailAdvisorsNewUpload({ StudentEmail: user, SendingCollege: collegeName, ClaimedPrereqs: claimKey }, true);
      return { transcriptId: match.TranscriptID, replaced: true };
    }

    // New transcript.
    const id = DataService.generateId('TR');
    const uploaded = _uploadPdf(payload.file, fileName);
    _grantStudentViewer(uploaded.fileId, user);
    DataService.insert(SHEET(), T_TRANSCRIPTS(), {
      TranscriptID: id,
      StudentEmail: user,
      SendingCollege: collegeName,
      SendingCollegeId: collegeId,
      ClaimedPrereqs: claimKey,
      Status: STATUS.PENDING,
      ReviewNote: '',
      DriveFileID: uploaded.fileId, FileName: fileName, DocumentLink: uploaded.url,
      UploadedAt: new Date().toISOString(),
      ReviewedBy: '', ReviewedAt: '',
    });
    _ensureQueueTask();
    _emailStudentReceipt(user, collegeName, claimKey, false);
    _emailAdvisorsNewUpload({ StudentEmail: user, SendingCollege: collegeName, ClaimedPrereqs: claimKey }, false);
    return { transcriptId: id, replaced: false };
  }

  // ── Queue task: one standing "transcripts awaiting review" pointer ──
  // Created when anything is Pending Review; resolved when none remain.
  // Routed to the advisor role (any holder sees/clears it).
  function _ensureQueueTask() {
    const pending = DataService.query(SHEET(), T_TRANSCRIPTS(), 'Status', STATUS.PENDING);
    if (!pending.length) return;
    // Avoid stacking duplicates: only create if no open task already points
    // at this source. (Tasks exposes openForSource, not an exists check.)
    try {
      const open = Tasks.openForSource(QUEUE_TASK.module, QUEUE_TASK.sourceId);
      if (open && open.length) return;
    } catch (e) { /* fall through to create */ }
    Tasks.create({
      module: QUEUE_TASK.module,
      sourceType: QUEUE_TASK.sourceType,
      sourceId: QUEUE_TASK.sourceId,
      // No count in the label: it's a standing pointer created once and not
      // updated as more arrive, so a number would go stale. The advisor
      // clicks through to the queue for the live list.
      label: 'Transcripts awaiting review',
      assignedRole: ADVISOR_ROLE,
      staleAfterDays: 7,
    });
  }
  function _resolveQueueTaskIfEmpty(actingUser) {
    const pending = DataService.query(SHEET(), T_TRANSCRIPTS(), 'Status', STATUS.PENDING);
    if (pending.length) return;
    try { Tasks.resolveForSource(QUEUE_TASK.module, QUEUE_TASK.sourceId, { resolvedBy: actingUser || 'system' }); }
    catch (e) { Logger.log('Transcript queue task resolve failed: ' + e); }
  }

  // ── Drive helpers (mirror ThesisModule for platform consistency) ──
  function _uploadPdf(file, fileName) {
    const blob = _toPdfBlob(file, fileName);
    const created = _transcriptFolder().createFile(blob);
    return { fileId: created.getId(), url: created.getUrl() };
  }

  // Grant a student view access to their own transcript PDF, so the
  // "Open PDF" links in their emails/portal actually open (the file lives
  // in a department folder they otherwise can't see). Best-effort: a
  // sharing failure (policy, etc.) must never break the upload itself.
  function _grantStudentViewer(fileId, studentEmail) {
    const id = String(fileId || '').trim();
    const email = String(studentEmail || '').trim();
    if (!id || !email) return;
    try {
      DriveApp.getFileById(id).addViewer(email);
    } catch (e) {
      Logger.log('TranscriptModule._grantStudentViewer: could not share ' + id + ' with ' + email + ': ' + e);
    }
  }

  // Share the transcript Drive FOLDER with all current staff_undergrad
  // advisors as viewers, so they can open any transcript PDF (current and
  // future). Folder-level so new uploads are covered automatically; run via
  // the admin button to reconcile after advisors change. Best-effort and
  // idempotent (addViewer on an existing viewer is a no-op). Returns a small
  // report. Super_admin (or staff) only — gated at the action.
  function shareFolderWithAdvisors(payload, user, roles) {
    if (!roles.includes('super_admin') && !roles.includes('staff')) {
      throw new Error('Not authorized to manage transcript folder sharing.');
    }
    const advisors = Auth.listUsers()
      .filter(u => u.active && (u.roles || []).indexOf(ADVISOR_ROLE) !== -1)
      .map(u => u.email);
    const folder = _transcriptFolder();
    const shared = [];
    const failed = [];
    advisors.forEach(email => {
      try { folder.addViewer(email); shared.push(email); }
      catch (e) { failed.push({ email: email, error: String(e) }); Logger.log('shareFolderWithAdvisors: ' + email + ': ' + e); }
    });
    return { advisors: advisors.length, shared: shared.length, failed: failed };
  }

  function _replacePdf(fileId, file, fileName) {
    const id = String(fileId || '').trim();
    const blob = _toPdfBlob(file, fileName);
    if (id && _hasAdvancedDrive()) {
      try {
        Drive.Files.update({ title: fileName, mimeType: 'application/pdf' }, id, blob);
        const f = DriveApp.getFileById(id);
        f.setName(fileName);
        return { fileId: id, url: f.getUrl() };
      } catch (err) {
        Logger.log('TranscriptModule._replacePdf: in-place update failed (' + err + '); uploading fresh.');
      }
    }
    return _uploadPdf(file, fileName);
  }
  function _hasAdvancedDrive() {
    return (typeof Drive !== 'undefined') && Drive && Drive.Files && typeof Drive.Files.update === 'function';
  }
  function _toPdfBlob(file, fileName) {
    file = file || {};
    const b64 = String(file.dataBase64 || '').trim();
    if (!b64) throw new Error('Attach the transcript PDF.');
    const mime = String(file.mimeType || 'application/pdf');
    if (mime.indexOf('pdf') === -1) throw new Error('The transcript must be a PDF file.');
    const bytes = Utilities.base64Decode(b64);
    return Utilities.newBlob(bytes, 'application/pdf', fileName);
  }
  function _transcriptFolder() {
    const id = String((cfg().DRIVE_FOLDER_ID) || '').trim();
    if (!id) throw new Error('Transcript Drive folder is not configured (CONFIG.TRANSCRIPT.DRIVE_FOLDER_ID).');
    return DriveApp.getFolderById(id);
  }
  // Filename: <College>_<StudentID>_TRANSCRIPT_Last-First.pdf
  function _buildTranscriptFileName(collegeName, profile) {
    const college = _slug(collegeName) || 'College';
    const last  = _slug(profile.lastName)  || 'Last';
    const first = _slug(profile.firstName) || 'First';
    const sid   = profile.studentId || 'NoID';
    return college + '_' + sid + '_TRANSCRIPT_' + last + '-' + first + '.pdf';
  }
  function _slug(s) {
    return String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '');
  }

  // ── Display shaping ───────────────────────────────────────
  function _publicTranscript(r) {
    const student = Auth.getProfile(r.StudentEmail);
    // Deep link to the college's UCSC agreement on ASSIST for the current
    // catalog year — an advisor convenience while reviewing. A transcript
    // record has no catalog year of its own (the student only picks a
    // college), so we use the default/current year, which is the year the
    // advisor's articulation table reflects. Empty string if it can't be
    // built (missing college id), so the UI shows plain text, not a link.
    const assistUrl = _assistAgreementUrl(_resolveYearCode(DEFAULT_YEAR_ID), r.SendingCollegeId);
    return {
      transcriptId: r.TranscriptID,
      studentEmail: r.StudentEmail,
      studentName:  student ? student.nameLastFirst : r.StudentEmail,
      studentId:    student ? student.studentId : '',
      college:      r.SendingCollege,
      collegeId:    r.SendingCollegeId,
      assistUrl:    assistUrl,
      claimedPrereqs: r.ClaimedPrereqs,
      status:       r.Status,
      reviewNote:   r.ReviewNote,
      documentLink: r.DocumentLink,
      fileName:     r.FileName,
      uploadedAt:   r.UploadedAt,
      reviewedBy:   r.ReviewedBy,
      reviewedAt:   r.ReviewedAt,
    };
  }

  // ========================================================================
  // LAYER 2 — advisor review + admin settings + digest (Pass 2)
  // ========================================================================

  const SETTINGS_TAB = () => CONFIG.TABS.TRANSCRIPT_SETTINGS;   // 'TranscriptSettings'

  function _isAdvisor(roles) {
    return roles.includes('super_admin') || roles.includes(ADVISOR_ROLE) || roles.includes('staff');
  }

  // ── The review queue (advisor) ────────────────────────────
  // Pending transcripts by default; pass payload.includeRecent to also
  // return recently-resolved ones for context. Deep-link target.
  function listQueue(payload, user, roles) {
    if (!_isAdvisor(roles)) {
      throw new Error('Not authorized: the transcript queue requires the undergraduate advisor role.');
    }
    payload = payload || {};
    let rows = DataService.getAll(SHEET(), T_TRANSCRIPTS());
    if (!payload.includeRecent) {
      rows = rows.filter(r => String(r.Status) === STATUS.PENDING);
    }
    rows.sort((a, b) => String(a.UploadedAt) < String(b.UploadedAt) ? -1 :
                        (String(a.UploadedAt) > String(b.UploadedAt) ? 1 : 0));
    return rows.map(_publicTranscript);
  }

  // ── One transcript's detail (advisor review screen) ───────
  function getTranscript(payload, user, roles) {
    if (!_isAdvisor(roles)) throw new Error('Not authorized.');
    const id = String((payload || {}).transcriptId || '').trim();
    if (!id) throw new Error('transcriptId is required.');
    const found = DataService.query(SHEET(), T_TRANSCRIPTS(), 'TranscriptID', id);
    if (!found.length) throw new Error('Transcript not found.');
    return _publicTranscript(found[0]);
  }

  // ── Record a review decision (advisor) ────────────────────
  // Sets a terminal status, stamps the reviewer, emails the student
  // (template + appended note), and resolves the queue task if nothing
  // remains Pending. status must be Processed or No Articulation.
  function recordReview(payload, user, roles) {
    if (!_isAdvisor(roles)) throw new Error('Not authorized to review transcripts.');
    payload = payload || {};
    const id = String(payload.transcriptId || '').trim();
    const status = String(payload.status || '').trim();
    const note = String(payload.note || '').trim();

    if (status !== STATUS.PROCESSED && status !== STATUS.NO_ARTICULATION) {
      throw new Error('Status must be "' + STATUS.PROCESSED + '" or "' + STATUS.NO_ARTICULATION + '".');
    }
    // Processing reflects credit entered in the separate "Other Credit Quick"
    // system. The advisor must confirm that step before a transcript can be
    // marked Processed — a reminder gate, not an audited fact (so nothing is
    // stored; reaching Processed is itself the confirmation). No Articulation
    // grants no credit, so it does not involve Other Credit Quick.
    if (status === STATUS.PROCESSED && payload.otherCreditConfirmed !== true) {
      throw new Error('Confirm the credit has been entered in Other Credit Quick before marking this transcript Processed.');
    }
    const found = DataService.query(SHEET(), T_TRANSCRIPTS(), 'TranscriptID', id);
    if (!found.length) throw new Error('Transcript not found.');
    const rec = found[0];

    DataService.update(SHEET(), T_TRANSCRIPTS(), 'TranscriptID', id, {
      Status: status,
      ReviewNote: note,
      ReviewedBy: user,
      ReviewedAt: new Date().toISOString(),
    });

    _emailStudentDecision(rec, status, note);
    _resolveQueueTaskIfEmpty(user);
    return { transcriptId: id, status: status };
  }

  // ── Override / reset / delete (escape hatch) ──────────────
  // Two distinct, separately-gated actions sharing one entry point:
  //   • Revert (default) — sets the transcript back to Pending Review (into
  //     the advisor queue) and clears the recorded decision. Allowed to the
  //     undergraduate advisor (staff_undergrad) or super_admin.
  //   • Delete (payload.delete === true) — permanently removes the record
  //     and trashes its Drive PDF. SUPER_ADMIN ONLY. Useful for clearing
  //     test data or mistaken/duplicate uploads. The audit log entry for
  //     this action is retained (it is not "associated data" to purge).
  function overrideReset(payload, user, roles) {
    payload = payload || {};
    const id = String(payload.transcriptId || '').trim();
    if (!id) throw new Error('transcriptId is required.');

    const isDelete = payload.delete === true;
    if (isDelete) {
      if (!roles.includes('super_admin')) {
        throw new Error('Not authorized: deleting a transcript requires super_admin.');
      }
    } else {
      if (!roles.includes('super_admin') && !roles.includes(ADVISOR_ROLE)) {
        throw new Error('Not authorized: reopening a transcript requires the undergraduate advisor role.');
      }
    }

    const found = DataService.query(SHEET(), T_TRANSCRIPTS(), 'TranscriptID', id);
    if (!found.length) throw new Error('Transcript not found.');

    if (isDelete) {
      // Best-effort: trash the Drive file, then remove the row.
      const fid = String(found[0].DriveFileID || '').trim();
      if (fid) { try { DriveApp.getFileById(fid).setTrashed(true); } catch (e) { Logger.log('overrideReset trash failed: ' + e); } }
      DataService.remove(SHEET(), T_TRANSCRIPTS(), 'TranscriptID', id);
      _resolveQueueTaskIfEmpty(user);
      return { transcriptId: id, action: 'deleted' };
    }

    DataService.update(SHEET(), T_TRANSCRIPTS(), 'TranscriptID', id, {
      Status: STATUS.PENDING, ReviewNote: '', ReviewedBy: '', ReviewedAt: '',
    });
    _ensureQueueTask();
    return { transcriptId: id, action: 'reverted' };
  }

  // ── Settings (admin tab): templates + digest toggle ───────
  function getSettings(payload, user, roles) {
    if (!_isAdvisor(roles)) throw new Error('Not authorized.');
    return _readSettings();
  }
  function saveSettings(payload, user, roles) {
    if (!roles.includes('super_admin') && !roles.includes('staff') && !roles.includes(ADVISOR_ROLE)) {
      throw new Error('Not authorized to change transcript settings.');
    }
    payload = payload || {};
    const boolKeys = ['DIGEST_ENABLED', 'NOTIFY_ON_UPLOAD'];
    const allowed = ['DIGEST_ENABLED', 'NOTIFY_ON_UPLOAD', 'NOTIFY_PROCESSED', 'NOTIFY_NO_ARTICULATION'];
    allowed.forEach(key => {
      if (payload[key] === undefined) return;
      const value = (boolKeys.indexOf(key) !== -1)
        ? (payload[key] === true || String(payload[key]).toUpperCase() === 'TRUE' ? 'TRUE' : 'FALSE')
        : String(payload[key]);
      _writeSetting(key, value);
    });
    return _readSettings();
  }

  // ── Daily digest (Scheduler job) ──────────────────────────
  // Emails staff_undergrad role-holders a summary of pending transcripts,
  // only if DIGEST_ENABLED and at least one is pending. context = { frequency,
  // runAt } from Scheduler. Never throws (Scheduler isolates jobs anyway).
  function dailyDigest(context) {
    const settings = _readSettings();
    if (String(settings.DIGEST_ENABLED).toUpperCase() !== 'TRUE') return { sent: false, reason: 'disabled' };

    const pending = DataService.query(SHEET(), T_TRANSCRIPTS(), 'Status', STATUS.PENDING);
    if (!pending.length) return { sent: false, reason: 'queue empty' };

    const recipients = Auth.listUsers()
      .filter(u => u.active && (u.roles || []).indexOf(ADVISOR_ROLE) !== -1)
      .map(u => u.email);
    if (!recipients.length) return { sent: false, reason: 'no advisors' };

    const lines = pending.map(r => {
      const p = Auth.getProfile(r.StudentEmail);
      const who = p ? p.nameLastFirst : r.StudentEmail;
      return '• ' + who + ' — ' + r.SendingCollege + ' (' + r.ClaimedPrereqs + ')';
    });
    const body = 'There ' + (pending.length === 1 ? 'is 1 transcript' : 'are ' + pending.length + ' transcripts')
      + ' awaiting review:\n\n' + lines.join('\n')
      + '\n\nOpen the portal → Transcripts to review.';

    Notify.send({
      to: recipients,
      subject: 'Transcripts awaiting review (' + pending.length + ')',
      body: body,
      replyTo: Settings.replyTo('transcript'),   // module reply-to (Admin → settings); falls back to CONFIG.DEFAULT_REPLY_TO
    });
    return { sent: true, count: pending.length, recipients: recipients.length };
  }

  // ── Student receipt email (on upload) ─────────────────────
  // Confirms the department has the transcript and points the student to
  // "My transcripts" for status — mirrors the Thesis received receipt.
  // Goes to the student's own email; delivery via Notify (never throws).
  function _emailStudentReceipt(studentEmail, collegeName, claimedPrereqs, replaced) {
    const profile = Auth.getProfile(studentEmail);
    const firstName = profile ? (profile.firstName || profile.name || 'there') : 'there';
    const heading = replaced
      ? 'Your revised transcript has been received by the Anthropology Department and is back under review.'
      : 'Your transcript has been received by the Anthropology Department.';
    const link = _deepLinkMine();
    const statusNote = 'You can check its status anytime in the "My transcripts" tab' +
      (link ? '' : '') + ' — you will also be emailed when the review is complete.';
    const linkText = link ? ('\n\nView your transcripts:\n' + link) : '';
    const bodyText = 'Hello ' + firstName + ',\n\n' + heading + '\n\n' + statusNote +
      '\n\nCollege: ' + (collegeName || '') +
      '\nPrerequisites: ' + (claimedPrereqs || '') +
      linkText +
      '\n\n— UCSC Anthropology Department';

    const htmlBody = Notify.htmlWrap(
      'Hello ' + firstName + ',\n\n' + heading + '\n\n' + statusNote +
      '\n\nCollege: ' + (collegeName || '') +
      '\nPrerequisites: ' + (claimedPrereqs || '') +
      '\n\n— UCSC Anthropology Department'
    ) + _mineButtonHtml();

    Notify.send({
      to: studentEmail,
      subject: replaced ? 'Your revised transcript has been received' : 'Your transcript has been received',
      body: bodyText,
      htmlBody: htmlBody,
      replyTo: Settings.replyTo('transcript'),   // module reply-to (Admin → settings); falls back to CONFIG.DEFAULT_REPLY_TO
    });
  }

  // ── New-upload advisor notification (global toggle) ───────
  // Emails active staff_undergrad role-holders that a transcript is waiting,
  // gated by the NOTIFY_ON_UPLOAD setting. Fires on BOTH a new upload and a
  // resubmission (replaced=true) — either way the transcript (re)enters the
  // queue. Delivery via Notify (never throws), so a mail problem can't break
  // the upload. rec carries StudentEmail / SendingCollege / ClaimedPrereqs.
  function _emailAdvisorsNewUpload(rec, replaced) {
    const settings = _readSettings();
    if (String(settings.NOTIFY_ON_UPLOAD).toUpperCase() !== 'TRUE') return;

    const recipients = Auth.listUsers()
      .filter(u => u.active && (u.roles || []).indexOf(ADVISOR_ROLE) !== -1)
      .map(u => u.email);
    if (!recipients.length) return;

    const profile = Auth.getProfile(rec.StudentEmail);
    const who = profile ? profile.nameLastFirst : rec.StudentEmail;
    const verb = replaced ? 'A revised transcript' : 'A new transcript';
    const subject = replaced ? 'Revised transcript awaiting review' : 'Transcript awaiting review';

    const bodyText = verb + ' has been submitted and is awaiting review.\n\n' +
      'Student: ' + who + '\n' +
      'College: ' + (rec.SendingCollege || '') + '\n' +
      'Prerequisites: ' + (rec.ClaimedPrereqs || '') + '\n\n' +
      'Open the portal \u2192 Transcripts to review.';

    const link = _deepLinkQueue();
    const textWithLink = bodyText + (link ? ('\n\nReview the queue:\n' + link) : '');

    Notify.send({
      to: recipients,
      subject: subject,
      body: textWithLink,
      htmlBody: Notify.htmlWrap(bodyText) + _queueButtonHtml(),
      replyTo: Settings.replyTo('transcript'),   // module reply-to (Admin → settings); falls back to CONFIG.DEFAULT_REPLY_TO
    });
  }

  // Deep link to the student's "My transcripts" tab (after portal login).
  function _deepLinkMine() {
    return Links.deepLink('transcript', 'mine');
  }

  // HTML button to the My transcripts tab, or '' if the URL can't be built.
  function _mineButtonHtml() {
    const url = _deepLinkMine();
    if (!url) return '';
    return '<p style="margin:16px 0;">' +
      '<a href="' + url + '" ' +
      'style="display:inline-block;background:#003C6C;color:#fff;text-decoration:none;' +
      'padding:10px 18px;border-radius:6px;font-size:14px;">View my transcripts</a></p>' +
      '<p style="margin:0;color:#888;font-size:12px;">You will be asked to sign in if you are not already.</p>';
  }

  // Deep link to the advisor review queue (after portal login). The shell
  // parses ?focus= into window.__focus.sourceId; the module's init() sends
  // any advisor focus target to the queue tab, so 'queue' just needs to be
  // non-empty to route correctly.
  function _deepLinkQueue() {
    return Links.deepLink('transcript', 'queue');
  }

  // HTML button to the review queue, or '' if the URL can't be built.
  function _queueButtonHtml() {
    const url = _deepLinkQueue();
    if (!url) return '';
    return '<p style="margin:16px 0;">' +
      '<a href="' + url + '" ' +
      'style="display:inline-block;background:#003C6C;color:#fff;text-decoration:none;' +
      'padding:10px 18px;border-radius:6px;font-size:14px;">Review transcripts</a></p>' +
      '<p style="margin:0;color:#888;font-size:12px;">You will be asked to sign in if you are not already.</p>';
  }

  // ── Student decision email ────────────────────────────────
  // Template for the status (tokens filled) + the advisor note appended
  // below with a label, when present. Goes to the student's own profile
  // email. Delivery via Notify (never throws).
  function _emailStudentDecision(rec, status, note) {
    const settings = _readSettings();
    const tmplKey = (status === STATUS.PROCESSED) ? 'NOTIFY_PROCESSED' : 'NOTIFY_NO_ARTICULATION';
    const profile = Auth.getProfile(rec.StudentEmail);
    const firstName = profile ? (profile.firstName || profile.name || '') : '';

    let bodyText = String(settings[tmplKey] || '')
      .replace(/\{FirstName\}/g, firstName)
      .replace(/\{College\}/g, rec.SendingCollege || '');
    if (note) {
      bodyText += '\n\n— Note from your advisor —\n' + note;
    }
    const link = _deepLinkMine();
    const textWithLink = bodyText + (link ? ('\n\nView your transcripts:\n' + link) : '');

    const subject = (status === STATUS.PROCESSED)
      ? 'Your transcript has been processed'
      : 'Update on your transcript review';

    Notify.send({
      to: rec.StudentEmail,
      subject: subject,
      body: textWithLink,
      htmlBody: Notify.htmlWrap(bodyText) + _mineButtonHtml(),
      replyTo: Settings.replyTo('transcript'),   // module reply-to (Admin → settings); falls back to CONFIG.DEFAULT_REPLY_TO
    });
  }

  // ── Settings read/write (key/value tab) ───────────────────
  function _readSettings() {
    const out = { DIGEST_ENABLED: 'TRUE', NOTIFY_ON_UPLOAD: 'TRUE', NOTIFY_PROCESSED: '', NOTIFY_NO_ARTICULATION: '' };
    try {
      DataService.getAll(SHEET(), SETTINGS_TAB()).forEach(r => {
        const k = String(r.Key || '').trim();
        if (k) out[k] = String(r.Value != null ? r.Value : '');
      });
    } catch (e) { Logger.log('Transcript _readSettings failed: ' + e); }
    return out;
  }
  function _writeSetting(key, value) {
    const existing = DataService.query(SHEET(), SETTINGS_TAB(), 'Key', key);
    if (existing.length) {
      DataService.update(SHEET(), SETTINGS_TAB(), 'Key', key, { Value: value });
    } else {
      DataService.insert(SHEET(), SETTINGS_TAB(), { Key: key, Value: value });
    }
  }

  // Only these names are dispatchable.
  return { listAcademicYears, getSummary, listReview, syncArticulations, diagnose,
           getMyPrereqStatus, listColleges, listMyTranscripts, uploadTranscript,
           listQueue, getTranscript, recordReview, overrideReset,
           getSettings, saveSettings, dailyDigest, shareFolderWithAdvisors };

})();