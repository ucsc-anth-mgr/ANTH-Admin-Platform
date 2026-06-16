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
    return rows;
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

  // Only these names are dispatchable.
  return { listAcademicYears, getSummary, listReview, syncArticulations, diagnose };

})();