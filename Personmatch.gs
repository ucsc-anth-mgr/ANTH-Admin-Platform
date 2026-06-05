// ============================================================
// PersonMatch.gs — Platform identity-matching service
// ============================================================
// Reusable by ANY module that ingests records about people from
// outside sources (CSV reports, future module imports, etc.) and
// needs to tie them to existing profiles despite name-spelling
// differences and differing identifiers across campus systems.
//
// Match priority: EMAIL first, then ANY ID (student or employee).
// Name is never used to match (too error-prone).
//
// A person accumulates both IDs over time: when a record matches an
// existing person and carries an ID they don't have stored yet, the
// empty ID field is filled (via Auth.fillEmptyId). A DIFFERENT id of
// a type they already have is reported as a conflict, not overwritten.
//
// This service does not create profiles itself; it returns a decision
// (and can attach alt names / fill empty IDs on a certain match).
// ============================================================

const PersonMatch = (() => {

  /**
   * Resolves an incoming record to an existing person, or reports no match.
   *
   * @param {Object} rec - {
   *     email?, first?, last?,
   *     idType?: 'student'|'employee',   // which kind of ID idValue is
   *     idValue?,                        // the ID number from the report
   *     kind?, source?                   // for alt-name recording
   *   }
   * @returns {Object} result:
   *   {
   *     status: 'matched' | 'new',
   *     matchedBy: 'email' | 'id' | null,
   *     profile: <profile or null>,
   *     conflicts: [ { field, oldValue, newValue } ],
   *     nameIsNew: boolean,
   *     idToFill: { type, value } | null   // an empty ID slot we can fill
   *   }
   */
  function resolve(rec) {
    const email   = String(rec.email || '').trim();
    const idValue = String(rec.idValue || '').trim();
    const idType  = rec.idType === 'employee' ? 'employee'
                  : rec.idType === 'student'  ? 'student' : '';

    let profile = null, matchedBy = null;

    // 1) Email first
    if (email) {
      const byEmail = Auth.findByEmail(email);
      if (byEmail) { profile = byEmail; matchedBy = 'email'; }
    }
    // 2) Then any ID (student or employee)
    if (!profile && idValue) {
      const byId = Auth.findByAnyId(idValue);
      if (byId) { profile = byId; matchedBy = 'id'; }
    }

    if (!profile) {
      return { status: 'new', matchedBy: null, profile: null,
               conflicts: [], nameIsNew: true, idToFill: null };
    }

    // Conflict / fill detection on the incoming ID (if any)
    const conflicts = [];
    let idToFill = null;
    if (idValue && idType) {
      const field = idType === 'student' ? 'studentId' : 'employeeId';
      const stored = String(profile[field] || '').trim();
      if (!stored) {
        idToFill = { type: idType, value: idValue };       // empty slot → can fill
      } else if (stored !== idValue) {
        conflicts.push({ field: (idType === 'student' ? 'StudentID' : 'EmployeeID'),
                         oldValue: stored, newValue: idValue });
      }
    }

    // If matched by ID but email differs, that's a secondary-field conflict
    if (email && profile.email && email.toLowerCase() !== profile.email.toLowerCase()) {
      conflicts.push({ field: 'Email', oldValue: profile.email, newValue: email });
    }

    // New name spelling?
    const norm = s => String(s || '').trim().toLowerCase();
    const inFirst = norm(rec.first), inLast = norm(rec.last);
    const sameAsPreferred = inFirst === norm(profile.firstName) && inLast === norm(profile.lastName);
    const alreadyAlt = (profile.altNames || []).some(a => norm(a.first) === inFirst && norm(a.last) === inLast);
    const nameIsNew = !!(rec.first || rec.last) && !sameAsPreferred && !alreadyAlt;

    return { status: 'matched', matchedBy: matchedBy, profile: profile,
             conflicts: conflicts, nameIsNew: nameIsNew, idToFill: idToFill };
  }


  /**
   * Resolve, and on a certain match with no conflicts:
   *   - fill an empty ID slot if the record supplies a new ID, and
   *   - attach a new name spelling as an alternate.
   * Returns the resolve() result plus { altAttached, idFilled }.
   */
  function resolveAndRecord(rec) {
    const result = resolve(rec);
    result.altAttached = false;
    result.idFilled = false;
    if (result.status !== 'matched') return result;

    // Only auto-apply when there are no conflicts to review
    if (result.conflicts.length === 0) {
      if (result.idToFill) {
        const r = Auth.fillEmptyId(result.profile.email, result.idToFill.type, result.idToFill.value);
        result.idFilled = (r.status === 'filled');
      }
      if (result.nameIsNew) {
        Auth.attachAltName(result.profile.email, {
          kind:   rec.kind || 'other',
          first:  rec.first || '',
          last:   rec.last || '',
          source: rec.source || '',
        });
        result.altAttached = true;
      }
    }
    return result;
  }


  return { resolve, resolveAndRecord };

})();