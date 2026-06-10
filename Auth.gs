// ============================================================
// Auth.gs — Identity & role engine (platform-wide profiles)
// ============================================================
// Users tab columns:  Email | Roles | Active | Notes | FirstName | LastName | AltNames | StudentID | EmployeeID
// Roles tab columns:  Role  | Description
//
//   Email      — PRIMARY key for authentication and identity matching.
//                IDs are a BACKUP match path only (see PersonMatch).
//   AltNames   — JSON array of alternate-spelling objects, used for
//                matching only (not display); preserved on update unless
//                explicitly supplied.
//   StudentID  — 7 digits;  EmployeeID — 8 digits (each validated when set).
//   Display names (name = "First Last", nameLastFirst = "Last, First")
//                are COMPUTED, not stored.
//
// Columns are read BY HEADER NAME, not position, so the Users tab
// may have columns in any order and new columns can be added later
// without breaking anything.
//
// Profiles are platform-level identity. Modules consume them via
// Auth.getProfile(email); no module stores its own copy of a name/ID.
// ============================================================

const Auth = (() => {

  const _rolesCache   = {};   // email -> roles[]
  const _profileCache = {};   // email -> profile object

  // Expected ID formats per ID type. Used for validation.
  const ID_FORMATS = {
    student:  { length: 7, label: 'Student ID (7 digits)' },
    employee: { length: 8, label: 'Employee ID (8 digits)' },
  };


  // ── Roles ──────────────────────────────────────────────────

  function getRoles(email) {
    if (!email) return [CONFIG.DEFAULT_ROLE];

    if (CONFIG.SUPER_ADMINS.includes(email.toLowerCase())) {
      return ['super_admin'];
    }

    if (_rolesCache[email]) return _rolesCache[email];

    const profile = getProfile(email);
    const roles = (profile && profile.active) ? profile.roles
                : (profile ? [] : [CONFIG.DEFAULT_ROLE]);
    _rolesCache[email] = roles;
    return roles;
  }


  function isAuthorized(userRoles, requiredRoles) {
    if (!userRoles || userRoles.length === 0) return false;
    if (userRoles.includes('super_admin')) return true;
    return requiredRoles.some(r => userRoles.includes(r));
  }


  function getAuthorizedModules(userRoles) {
    const registry = getModuleRegistry();
    return Object.entries(registry)
      .filter(([, mod]) => mod.enabled && isAuthorized(userRoles, mod.roles))
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([key, mod]) => ({ key, ...mod }));
  }


  // ── Profiles (platform-wide identity) ──────────────────────

  /**
   * Returns the full profile for an email, or null if not provisioned.
   * Shape: { email, firstName, lastName, name, nameLastFirst, roles[],
   *          studentId, employeeId, altNames[], active, notes }
   *   - name          = "First Last"  (greetings, "First Last" contexts)
   *   - nameLastFirst = "Last, First" (tables, directories)
   * Super-admins always resolve to an active super_admin profile.
   */
  function getProfile(email) {
    if (!email) return null;
    const key = email.toLowerCase();

    if (CONFIG.SUPER_ADMINS.includes(key)) {
      return _withDisplayNames({ email: email, firstName: '', lastName: '', roles: ['super_admin'],
               studentId: '', employeeId: '', altNames: [], active: true, notes: 'Super admin (config)' });
    }

    if (_profileCache[key]) return _profileCache[key];

    try {
      const { headers, data } = _readUsers();
      const col = _indexer(headers);
      for (let i = 0; i < data.length; i++) {
        if (String(data[i][col('Email')]).trim().toLowerCase() === key) {
          const profile = _rowToProfile(data[i], col);
          _profileCache[key] = profile;
          return profile;
        }
      }
    } catch (err) {
      Logger.log('Auth.getProfile error: ' + err);
    }
    return null;
  }


  /**
   * Adds or updates a user profile, keyed by email.
   * Takes firstName/lastName. Validates ID when provided.
   * @param {Object} p - { email, firstName, lastName, altNames?, roles[], studentId, employeeId, active, notes }
   */
  function upsertUser(p) {
    if (!p.email) throw new Error('Email is required.');
    const email = String(p.email).trim();
    const roles = Array.isArray(p.roles) ? p.roles
                : String(p.roles || '').split(',').map(r => r.trim()).filter(Boolean);

    const firstName = (p.firstName || '').trim();
    const lastName  = (p.lastName || '').trim();
    const studentId  = String(p.studentId || '').trim();
    const employeeId = String(p.employeeId || '').trim();

    if (studentId)  _validateStudentId(studentId);
    if (employeeId) _validateEmployeeId(employeeId);

    const sheet = _getUsersSheet();
    const { headers, data } = _readUsers();
    const col = _indexer(headers);

    const rowValues = _profileToRow({
      email:    email,
      firstName: firstName,
      lastName:  lastName,
      altNames: Array.isArray(p.altNames) ? p.altNames : null,  // null = preserve existing
      roles:    roles,
      studentId:  studentId,
      employeeId: employeeId,
      active:   p.active !== false,
      notes:    p.notes || '',
    }, headers, col);

    for (let i = 0; i < data.length; i++) {
      if (String(data[i][col('Email')]).trim().toLowerCase() === email.toLowerCase()) {
        if (!p.notes && col('Notes') >= 0) rowValues[col('Notes')] = data[i][col('Notes')];
        // Preserve existing alt names if caller didn't supply them
        if (!Array.isArray(p.altNames) && col('AltNames') >= 0) {
          rowValues[col('AltNames')] = data[i][col('AltNames')] || '[]';
        }
        sheet.getRange(i + 2, 1, 1, headers.length).setValues([rowValues]);
        _clearCaches(email);
        return { status: 'updated', email: email };
      }
    }
    sheet.appendRow(rowValues);
    _clearCaches(email);
    return { status: 'created', email: email };
  }


  /**
   * Returns all profiles (for admin listing).
   */
  function listUsers() {
    const { headers, data } = _readUsers();
    const col = _indexer(headers);
    return data
      .filter(row => String(row[col('Email')]).trim())
      .map(row => _rowToProfile(row, col));
  }


  /**
   * Validates a student ID (7 digits) or employee ID (8 digits).
   * Public so self-registration and the importer reuse the same rules.
   */
  function validateStudentId(id)  { return _validateStudentId(id); }
  function validateEmployeeId(id) { return _validateEmployeeId(id); }

  /**
   * Returns the ID format spec for a type ('student'|'employee'), or null.
   */
  function idFormat(idType) {
    return ID_FORMATS[idType] || null;
  }


  // ── Lookup by identity (used by the matching service) ──────

  /**
   * Returns the profile whose StudentID OR EmployeeID matches, or null.
   * Matched as a trimmed string against either field.
   */
  function findByAnyId(idValue) {
    const id = String(idValue || '').trim();
    if (!id) return null;
    const found = listUsers().find(u =>
      (u.studentId  && String(u.studentId).trim()  === id) ||
      (u.employeeId && String(u.employeeId).trim() === id));
    return found || null;
  }

  /**
   * Returns the profile whose email matches, or null.
   */
  function findByEmail(email) {
    return getProfile(email);
  }

  /**
   * Appends an alternate name to a profile (dedup by kind+first+last).
   * Does not change the preferred name. Keyed by email.
   * @param {string} email
   * @param {Object} alt - { kind, first, last, source }
   */
  function attachAltName(email, alt) {
    const profile = getProfile(email);
    if (!profile) throw new Error('No profile for ' + email);
    const alts = profile.altNames || [];
    const norm = s => String(s || '').trim().toLowerCase();
    const dup = alts.some(a =>
      norm(a.first) === norm(alt.first) &&
      norm(a.last)  === norm(alt.last)  &&
      norm(a.kind)  === norm(alt.kind));
    if (dup) return { status: 'exists' };
    alts.push({ kind: alt.kind || 'other', first: alt.first || '', last: alt.last || '', source: alt.source || '' });
    upsertUser({
      email:    profile.email,
      firstName: profile.firstName,
      lastName:  profile.lastName,
      altNames: alts,
      roles:    profile.roles,
      studentId:  profile.studentId,
      employeeId: profile.employeeId,
      active:   profile.active,
      notes:    profile.notes,
    });
    return { status: 'added' };
  }

  /**
   * Stores an ID into the field it belongs to (by type), only if that
   * field is currently empty. Used by matching to accumulate a second
   * ID over time. Returns { status: 'filled' | 'exists' | 'conflict' }.
   * @param {string} email
   * @param {string} idType - 'student' | 'employee'
   * @param {string} idValue
   */
  function fillEmptyId(email, idType, idValue) {
    const profile = getProfile(email);
    if (!profile) throw new Error('No profile for ' + email);
    const id = String(idValue || '').trim();
    if (!id) return { status: 'exists' };
    const field = idType === 'student' ? 'studentId' : 'employeeId';
    const current = String(profile[field] || '').trim();
    if (current) {
      return { status: current === id ? 'exists' : 'conflict' };
    }
    const updated = Object.assign({}, profile);
    updated[field] = id;
    upsertUser({
      email:    updated.email,
      firstName: updated.firstName,
      lastName:  updated.lastName,
      altNames: updated.altNames,
      roles:    updated.roles,
      studentId:  updated.studentId,
      employeeId: updated.employeeId,
      active:   updated.active,
      notes:    updated.notes,
    });
    return { status: 'filled' };
  }


  // ── Roles list ─────────────────────────────────────────────

  function listRoles() {
    try {
      const ss    = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
      const sheet = ss.getSheetByName(CONFIG.TABS.ROLES);
      if (!sheet) return _defaultRoles();
      return sheet.getDataRange().getValues().slice(1).map(r => r[0]).filter(Boolean);
    } catch (e) {
      return _defaultRoles();
    }
  }


  // ── Private ────────────────────────────────────────────────

  function _defaultRoles() {
    return ['super_admin', 'staff', 'senate_faculty', 'lecturer', 'graduate_student', 'undergraduate_student', 'visitor'];
  }

  function _validateStudentId(id) {
    const digits = String(id).trim();
    if (!/^\d{7}$/.test(digits)) throw new Error('Student ID must be exactly 7 digits.');
    return true;
  }
  function _validateEmployeeId(id) {
    const digits = String(id).trim();
    if (!/^\d{8}$/.test(digits)) throw new Error('Employee ID must be exactly 8 digits.');
    return true;
  }

  function _readUsers() {
    const sheet = _getUsersSheet();
    const all   = sheet.getDataRange().getValues();
    const headers = all[0].map(h => String(h).trim());
    const data    = all.slice(1);
    return { headers, data };
  }

  function _indexer(headers) {
    return name => headers.indexOf(name);
  }

  function _rowToProfile(row, col) {
    const get = name => { const i = col(name); return i >= 0 ? row[i] : ''; };
    return _withDisplayNames({
      email:    String(get('Email')).trim(),
      firstName: String(get('FirstName')).trim(),
      lastName:  String(get('LastName')).trim(),
      altNames: _parseAltNames(get('AltNames')),
      roles:    String(get('Roles')).split(',').map(r => r.trim().toLowerCase()).filter(Boolean),
      studentId:  String(get('StudentID')).trim(),
      employeeId: String(get('EmployeeID')).trim(),
      active:   String(get('Active')).trim().toUpperCase() !== 'FALSE',
      notes:    String(get('Notes')).trim(),
    });
  }

  function _parseAltNames(raw) {
    if (!raw) return [];
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }

  /**
   * Attaches computed display-name fields to a profile.
   *   name          → "First Last"   (greetings)
   *   nameLastFirst → "Last, First"  (tables, directories)
   * Falls back gracefully when one part is missing.
   */
  function _withDisplayNames(p) {
    const f = (p.firstName || '').trim();
    const l = (p.lastName || '').trim();
    p.name = (f && l) ? (f + ' ' + l) : (f || l || p.email);
    p.nameLastFirst = (f && l) ? (l + ', ' + f) : (l || f || p.email);
    return p;
  }

  function _profileToRow(profile, headers, col) {
    const row = new Array(headers.length).fill('');
    const set = (name, val) => { const i = col(name); if (i >= 0) row[i] = val; };
    set('Email',     profile.email);
    set('FirstName', profile.firstName || '');
    set('LastName',  profile.lastName || '');
    set('AltNames',  JSON.stringify(profile.altNames || []));
    set('Roles',     profile.roles.join(', '));
    set('StudentID',  profile.studentId || '');
    set('EmployeeID', profile.employeeId || '');
    set('Active',    profile.active ? 'TRUE' : 'FALSE');
    set('Notes',     profile.notes);
    return row;
  }

  function _clearCaches(email) {
    delete _rolesCache[email];
    delete _profileCache[email.toLowerCase()];
  }

  function _getUsersSheet() {
    const ss = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
    const sheet = ss.getSheetByName(CONFIG.TABS.USERS);
    if (!sheet) throw new Error('Users tab not found in config sheet.');
    return sheet;
  }


  return {
    getRoles, isAuthorized, getAuthorizedModules,
    getProfile, upsertUser, listUsers, listRoles,
    validateStudentId, validateEmployeeId, idFormat,
    findByAnyId, findByEmail, attachAltName, fillEmptyId,
  };

})();