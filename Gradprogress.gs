// ============================================================
// GradProgress.gs — Shared graduate student progress record
// ============================================================
// One row per graduate student (key: StudentEmail) holding academic
// state that outlives any single form: advisor, dates, degree
// objective, candidacy, committee rosters, milestone dates. All three
// grad modules (grad_status, phd_milestones, masters_milestones) read
// it to prefill forms and write it back when workflows complete.
//
// NOT a registered module — a platform-style service (like ClassSchedule),
// exposed to users only through module actions (the grad_status module's
// Progress tab is its UI home). Identity stays in Auth/Profiles; this
// row is academic state only. Rows are created lazily: first form
// submission or first staff edit.
//
// Preservation contract (matches the platform's Notes convention):
// upsert() only writes the fields it is GIVEN — omitted fields are
// untouched, and Notes/roster JSON are never blanked unless explicitly
// supplied. Callers therefore send patches, not whole records.
// ============================================================

const GradProgress = (() => {

  function _sheetId() { return CONFIG.SHEETS.GRAD; }
  function _tab()     { return (CONFIG.TABS && CONFIG.TABS.GRAD_PROGRESS) || 'GradProgress'; }

  // Fields a caller may write via upsert(). Anything else in a patch is
  // ignored (CreatedAt/By, UpdatedAt/By are DataService's to manage).
  const WRITABLE = [
    'AdvisorEmail', 'DateEntered', 'DegreeObjective', 'ExpectedGraduation',
    'AdvancedToCandidacy', 'QECommitteeJSON', 'ReadingCommitteeJSON',
    'QEPassedDate', 'LanguageFulfilledDate', 'Notes',
  ];

  function _norm(e) { return String(e || '').trim().toLowerCase(); }

  /**
   * The progress row for one student, or null. Email match is
   * case-insensitive (profiles store campus emails, but defend anyway).
   */
  function get(studentEmail) {
    const email = _norm(studentEmail);
    if (!email) return null;
    const rows = DataService.getAll(_sheetId(), _tab());
    for (let i = 0; i < rows.length; i++) {
      if (_norm(rows[i].StudentEmail) === email) return rows[i];
    }
    return null;
  }

  /**
   * Creates or patches a student's progress row. Only WRITABLE fields
   * present in `patch` are written; blank-string values ARE written
   * (an explicit blank is a deliberate clear), but undefined/missing
   * fields never touch the sheet. Returns the fresh row.
   *
   * @param {string} studentEmail
   * @param {Object} patch  subset of WRITABLE fields
   * @param {string} user   acting user (audit context; DataService stamps it)
   */
  function upsert(studentEmail, patch, user) {
    const email = _norm(studentEmail);
    if (!email) throw new Error('GradProgress.upsert: student email is required.');
    const clean = {};
    WRITABLE.forEach(function (f) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, f) && patch[f] !== undefined) {
        clean[f] = patch[f];
      }
    });

    const existing = get(email);
    if (existing) {
      if (Object.keys(clean).length) {
        DataService.update(_sheetId(), _tab(), 'StudentEmail', existing.StudentEmail, clean);
      }
    } else {
      clean.StudentEmail = email;
      DataService.insert(_sheetId(), _tab(), clean);
    }
    return get(email);
  }

  /**
   * Fill-if-blank writeback used by form submissions: for each field in
   * `candidates`, writes it ONLY when the stored value is blank and the
   * candidate is non-blank. AdvisorEmail is the exception — a form
   * submission always confirms/updates it (the self-maintaining advisor
   * assignment). Creates the row if absent. Returns the fresh row.
   */
  function absorb(studentEmail, candidates, user) {
    const email = _norm(studentEmail);
    if (!email) return null;
    const row = get(email) || {};
    const patch = {};
    Object.keys(candidates || {}).forEach(function (f) {
      if (WRITABLE.indexOf(f) === -1) return;
      const incoming = String(candidates[f] == null ? '' : candidates[f]).trim();
      if (!incoming) return;
      if (f === 'AdvisorEmail') { patch[f] = incoming; return; }   // always confirm
      const current = String(row[f] == null ? '' : row[f]).trim();
      if (!current) patch[f] = incoming;
    });
    if (!Object.keys(patch).length && row.StudentEmail) return row;
    return upsert(email, patch, user);
  }

  /**
   * Writes a committee roster (JSON array) to the named roster field.
   * @param {string} studentEmail
   * @param {string} field   'QECommitteeJSON' | 'ReadingCommitteeJSON'
   * @param {Array}  roster  [{ name, email, title, deptCampus, slot }]
   */
  function writeRoster(studentEmail, field, roster, user) {
    if (field !== 'QECommitteeJSON' && field !== 'ReadingCommitteeJSON') {
      throw new Error('GradProgress.writeRoster: unknown roster field ' + field);
    }
    const patch = {};
    patch[field] = JSON.stringify(Array.isArray(roster) ? roster : []);
    return upsert(studentEmail, patch, user);
  }

  /**
   * Dashboard feed for the milestone modules (Phase 3+) and the
   * grad_status Progress tab: the row plus parsed rosters and a few
   * derived booleans. Never throws — a missing row returns nulls.
   */
  function milestoneSummary(studentEmail) {
    const row = get(studentEmail);
    if (!row) {
      return { exists: false, studentEmail: _norm(studentEmail),
               advisorEmail: '', degreeObjective: '', qeCommittee: null,
               readingCommittee: null, qePassed: '', languageFulfilled: '',
               advancedToCandidacy: '' };
    }
    return {
      exists: true,
      studentEmail: row.StudentEmail,
      advisorEmail: String(row.AdvisorEmail || ''),
      dateEntered: String(row.DateEntered || ''),
      degreeObjective: String(row.DegreeObjective || ''),
      expectedGraduation: String(row.ExpectedGraduation || ''),
      advancedToCandidacy: String(row.AdvancedToCandidacy || ''),
      qePassed: String(row.QEPassedDate || ''),
      languageFulfilled: String(row.LanguageFulfilledDate || ''),
      qeCommittee: _parseJson(row.QECommitteeJSON),
      readingCommittee: _parseJson(row.ReadingCommitteeJSON),
      notes: String(row.Notes || ''),
    };
  }

  /** All progress rows (staff Progress tab). */
  function listAll() {
    return DataService.getAll(_sheetId(), _tab());
  }

  function _parseJson(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  return { get, upsert, absorb, writeRoster, milestoneSummary, listAll };

})();
