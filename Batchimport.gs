// ============================================================
// BatchImport.gs — Bulk user import from CSV (homogeneous batches)
// ============================================================
// Each upload is ONE kind of people (all students OR all employees):
//   - The ROLE for the batch is chosen in the form (checked once
//     against the importer's ImportPolicy allowlist).
//   - The ID FIELD the report fills (StudentID or EmployeeID) defaults
//     from the role and can be overridden in the form.
//   - The CSV itself carries only identity data: first name, last
//     name, email, ID number — with FLEXIBLE headers. Columns are
//     auto-detected and the importer confirms/corrects the mapping.
//
// Matching uses the platform PersonMatch service (email first, then
// any ID). On a certain match: empty ID slots are filled and new name
// spellings are attached as alternates. Conflicts (a DIFFERENT id of
// a type they already have, or an email mismatch) are skipped with a
// reason — a dedicated review queue is planned but not yet built.
//
// Flow: detectColumns() → preview() → commit().
// ============================================================

const BatchImport = (() => {

  // Header variants for auto-detection (lowercased, punctuation-stripped)
  const COLUMN_HINTS = {
    first: ['first', 'firstname', 'first name', 'given', 'given name', 'givenname', 'preferred first', 'preferred first name'],
    last:  ['last', 'lastname', 'last name', 'surname', 'family name', 'familyname', 'preferred last', 'preferred last name'],
    email: ['email', 'e-mail', 'email address', 'e-mail address', 'mail', 'ucsc email', 'campus email', 'campus e-mail', 'school email', 'university email'],
    id:    ['id', 'sid', 'student id', 'studentid', 'student id number', 'employee id', 'employeeid', 'emp id', 'empid', 'perm', 'id number', 'idnumber'],
  };


  /**
   * Parses the CSV headers and guesses which column is which.
   * @param {Object} p - { csv }
   * @returns { headers: [...], mapping: {first,last,email,id}, rowCount }
   *   mapping values are header names (or '' if not detected).
   */
  function detectColumns(p, user, roles) {
    _assertImporter(roles);
    const parsed = _parseCsv(p.csv || '');
    if (!parsed.rows.length) throw new Error('No data rows found in the file.');

    const mapping = { first: '', last: '', email: '', id: '' };
    const taken = {};
    Object.keys(COLUMN_HINTS).forEach(field => {
      const hints = COLUMN_HINTS[field];
      // exact hint match first, then contains-match
      let found = parsed.headers.find(h => !taken[h] && hints.indexOf(_normHeader(h)) !== -1);
      if (!found) {
        found = parsed.headers.find(h => !taken[h] && hints.some(hint => _normHeader(h).indexOf(hint) !== -1));
      }
      if (found) { mapping[field] = found; taken[found] = true; }
    });

    return { headers: parsed.headers, mapping: mapping, rowCount: parsed.rows.length };
  }


  /**
   * Validates and plans the import WITHOUT writing.
   * @param {Object} p - { csv, mapping:{first,last,email,id}, role, idType }
   *   role: the single role for every row in this batch
   *   idType: 'student' | 'employee' | 'none' — which field the ID column fills
   */
  function preview(p, user, roles) {
    _assertImporter(roles);
    _assertBatchSettings(p, roles);
    const parsed = _parseCsv(p.csv || '');
    if (!parsed.rows.length) throw new Error('No data rows found in the file.');

    const out = parsed.rows.map((row, i) => _evaluateRow(row, i + 2, p));
    if (p.syncRoster) {
      _syncPlan(p, out, user, roles).forEach(s => out.push(s));
    }
    return {
      summary: {
        total:    out.length,
        create:   out.filter(r => r.action === 'create').length,
        update:   out.filter(r => r.action === 'update').length,
        sync:     out.filter(r => r.action === 'sync').length,
        skip:     out.filter(r => r.action === 'skip').length,
      },
      rows: out,
    };
  }


  /**
   * Roster sync: anyone holding the batch role who is NOT present in
   * the file gets the role removed (if they have other roles) or is
   * deactivated (if it's their only role). Guards: never super_admins,
   * never the importer themself, and only users entirely within the
   * importer's assignable allowlist.
   */
  function _syncPlan(p, evaluated, user, roles) {
    const present = {};
    evaluated.forEach(r => {
      if (r.rec && r.rec.email) present[r.rec.email.toLowerCase()] = true;
      if (r.matchedEmail) present[r.matchedEmail.toLowerCase()] = true;
    });

    const isSuper = roles.includes('super_admin');
    const allowed = isSuper ? null : ImportPolicy.assignableFor(roles);
    const out = [];

    Auth.listUsers().forEach(u => {
      if (!u.active) return;
      if (u.roles.includes('super_admin')) return;
      if (u.roles.indexOf(p.role) === -1) return;
      if (present[u.email.toLowerCase()]) return;
      if (u.email.toLowerCase() === String(user).toLowerCase()) {
        out.push({ line: '—', email: u.email, action: 'skip',
                   reason: 'Not in roster, but you cannot deactivate yourself' });
        return;
      }
      if (allowed && u.roles.some(r => allowed.indexOf(r) === -1)) {
        out.push({ line: '—', email: u.email, action: 'skip',
                   reason: 'Not in roster, but you are not permitted to modify this user' });
        return;
      }
      const others = u.roles.filter(r => r !== p.role);
      if (others.length) {
        out.push({ line: '—', email: u.email, action: 'sync', syncOp: 'removeRole',
                   details: 'Not in roster → remove role ' + p.role + ' (keeps: ' + others.join(', ') + ')' });
      } else {
        out.push({ line: '—', email: u.email, action: 'sync', syncOp: 'deactivate',
                   details: 'Not in roster → deactivate (' + (u.name || u.email) + ')' });
      }
    });
    return out;
  }


  /**
   * Applies the import (re-validates server-side; never trusts a client plan).
   * Same params as preview().
   */
  function commit(p, user, roles) {
    _assertImporter(roles);
    _assertBatchSettings(p, roles);
    const parsed = _parseCsv(p.csv || '');

    const created = [], updated = [], skipped = [];

    const evaluated = [];
    parsed.rows.forEach((row, i) => {
      const evald = _evaluateRow(row, i + 2, p);
      evaluated.push(evald);
      if (evald.action === 'skip') { skipped.push(evald); return; }
      try {
        if (evald.action === 'create') {
          Auth.upsertUser({
            email:    evald.rec.email,
            firstName: evald.rec.first,
            lastName:  evald.rec.last,
            roles:    [p.role],
            studentId:  p.idType === 'student'  ? evald.rec.idValue : '',
            employeeId: p.idType === 'employee' ? evald.rec.idValue : '',
            active:   true,
            notes:    'Imported' + (p.source ? ' (' + p.source + ')' : ''),
          });
          created.push(evald);
        } else {
          // Matched existing person: record via PersonMatch (fills empty
          // ID, attaches alt name), then add the batch role if missing.
          const rr = PersonMatch.resolveAndRecord(evald.rec);
          const prof = rr.profile;
          if (prof && prof.roles.indexOf(p.role) === -1 && !prof.roles.includes('super_admin')) {
            Auth.upsertUser({
              email: prof.email, firstName: prof.firstName, lastName: prof.lastName,
              roles: prof.roles.concat([p.role]),
              studentId: rr.idFilled && p.idType === 'student' ? evald.rec.idValue : prof.studentId,
              employeeId: rr.idFilled && p.idType === 'employee' ? evald.rec.idValue : prof.employeeId,
              active: prof.active, notes: prof.notes,
            });
          }
          updated.push(evald);
        }
      } catch (err) {
        evald.action = 'skip';
        evald.reason = 'Write failed: ' + err.message;
        skipped.push(evald);
      }
    });

    // Roster sync: deactivate / de-role everyone with this role who
    // wasn't present in the file (same plan logic as preview).
    const synced = [];
    if (p.syncRoster) {
      _syncPlan(p, evaluated, user, roles).forEach(s => {
        if (s.action === 'skip') { skipped.push(s); return; }
        try {
          const prof = Auth.getProfile(s.email);
          if (!prof) { s.action = 'skip'; s.reason = 'Profile vanished'; skipped.push(s); return; }
          if (s.syncOp === 'removeRole') {
            Auth.upsertUser({
              email: prof.email, firstName: prof.firstName, lastName: prof.lastName,
              roles: prof.roles.filter(r => r !== p.role),
              studentId: prof.studentId, employeeId: prof.employeeId,
              active: prof.active, notes: prof.notes,
            });
          } else {
            Auth.upsertUser({
              email: prof.email, firstName: prof.firstName, lastName: prof.lastName,
              roles: prof.roles,
              studentId: prof.studentId, employeeId: prof.employeeId,
              active: false, notes: prof.notes,
            });
          }
          synced.push(s);
        } catch (err) {
          s.action = 'skip';
          s.reason = 'Sync failed: ' + err.message;
          skipped.push(s);
        }
      });
    }

    return {
      summary: { created: created.length, updated: updated.length,
                 synced: synced.length, skipped: skipped.length },
      created: created, updated: updated, synced: synced, skipped: skipped,
    };
  }


  // ── Row evaluation (shared by preview + commit) ────────────

  function _evaluateRow(row, lineNo, p) {
    const m = p.mapping || {};
    const cell = h => h ? String(row[String(h).trim().toLowerCase()] || '').trim() : '';

    // Strip float suffix that spreadsheet apps add to numeric cells (e.g. "1234567.0" → "1234567")
    const _cleanId = v => String(v).trim().replace(/\.0+$/, '');
    const rec = {
      first:   cell(m.first),
      last:    cell(m.last),
      email:   cell(m.email),
      idType:  p.idType === 'none' ? '' : p.idType,
      idValue: p.idType === 'none' ? '' : _cleanId(cell(m.id)),
      kind:    'other',
      source:  p.source || 'Batch import',
    };
    const result = { line: lineNo, email: rec.email, rec: rec };

    // Both names required
    if (!rec.first || !rec.last) return _skip(result, 'Missing first or last name');

    // Email well-formed if present
    if (rec.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) {
      return _skip(result, 'Invalid email');
    }

    // Light ID validation per the batch's ID type
    if (rec.idValue) {
      if (p.idType === 'student' && !/^\d{7}$/.test(rec.idValue)) {
        return _skip(result, 'Student ID must be exactly 7 digits');
      }
      if (p.idType === 'employee' && !/^\d{8}$/.test(rec.idValue)) {
        return _skip(result, 'Employee ID must be exactly 8 digits');
      }
    }

    // A row must have at least one identifier to be usable
    if (!rec.email && !rec.idValue) {
      return _skip(result, 'No identifier (needs an email or an ID)');
    }

    // Resolve identity (read-only here; commit applies)
    const rr = PersonMatch.resolve(rec);
    if (rr.status === 'matched') result.matchedEmail = rr.profile.email;

    if (rr.status === 'new') {
      // Creating a profile requires an email (it's the profile key)
      if (!rec.email) return _skip(result, 'New person but no email (email is required to create a profile)');
      result.action = 'create';
      result.details = rec.first + ' ' + rec.last + ' · ' + (rec.idValue || 'no ID');
      return result;
    }

    // Matched. Conflicts are skipped (review queue not yet built).
    if (rr.conflicts.length) {
      const what = rr.conflicts.map(c => c.field + ': stored "' + c.oldValue + '" vs row "' + c.newValue + '"').join('; ');
      return _skip(result, 'Conflict — ' + what);
    }

    result.action = 'update';
    const bits = [];
    bits.push('matched by ' + rr.matchedBy + ' → ' + (rr.profile.name || rr.profile.email));
    if (rr.idToFill)  bits.push('will add ' + (rr.idToFill.type === 'student' ? 'StudentID' : 'EmployeeID') + ' ' + rr.idToFill.value);
    const _storedName = !!(String(rr.profile.firstName || '').trim() || String(rr.profile.lastName || '').trim());
    const _rowHasName = !!(rec.first || rec.last);
    if (!_storedName && _rowHasName) {
      bits.push('will set name to "' + rec.first + ' ' + rec.last + '"');
    } else if (rr.nameIsNew) {
      bits.push('will record "' + rec.first + ' ' + rec.last + '" as an alternate name');
    }
    if (rr.profile.roles.indexOf(p.role) === -1) bits.push('will add role ' + p.role);
    if (bits.length === 1) bits.push('no changes');
    result.details = bits.join('; ');
    return result;
  }

  function _skip(result, reason) {
    result.action = 'skip';
    result.reason = reason;
    return result;
  }


  // ── Batch settings checks ──────────────────────────────────

  function _assertBatchSettings(p, roles) {
    if (!p.role) throw new Error('Choose the role for this batch.');
    if (['student', 'employee', 'none'].indexOf(p.idType) === -1) {
      throw new Error('Choose which ID this report contains (student, employee, or none).');
    }
    if (!p.mapping || !p.mapping.first || !p.mapping.last) {
      throw new Error('Map the First name and Last name columns before importing.');
    }
    if (p.idType !== 'none' && !p.mapping.id) {
      throw new Error('Map the ID column, or set the ID type to "none".');
    }
    // The batch role must be within the importer's assignable allowlist
    const allowed = ImportPolicy.assignableFor(roles);
    if (allowed.indexOf(p.role) === -1) {
      throw new Error('You are not permitted to assign the role "' + p.role + '".');
    }
  }

  function _assertImporter(roles) {
    if (roles.includes('super_admin')) return;   // super_admin always may
    if (!ImportPolicy.canImport(roles)) {
      throw new Error('You do not have permission to import users.');
    }
  }


  // ── CSV parsing ────────────────────────────────────────────

  function _normHeader(h) {
    return String(h).toLowerCase().replace(/[_\-\.]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped
   * quotes (""), and commas/newlines inside quotes. Returns
   * { headers: [...original-case trimmed], rows: [ {lowerHeader: value} ] }.
   */
  function _parseCsv(text) {
    const records = _tokenize(text);
    if (!records.length) return { headers: [], rows: [] };

    const headers = records[0].map(h => String(h).trim().replace(/[\r\n]+/g, ' ').trim());
    const lower = headers.map(h => h.toLowerCase());
    const rows = [];
    for (let i = 1; i < records.length; i++) {
      const cells = records[i];
      if (cells.length === 1 && String(cells[0]).trim() === '') continue;
      const obj = {};
      lower.forEach((h, idx) => { obj[h] = cells[idx] !== undefined ? cells[idx] : ''; });
      rows.push(obj);
    }
    return { headers: headers, rows: rows };
  }

  function _tokenize(text) {
    const records = [];
    let field = '', record = [], inQuotes = false;
    const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { record.push(field); field = ''; }
        else if (c === '\n') { record.push(field); records.push(record); record = []; field = ''; }
        else field += c;
      }
    }
    if (field !== '' || record.length) { record.push(field); records.push(record); }
    return records;
  }


  return { detectColumns, preview, commit };

})();