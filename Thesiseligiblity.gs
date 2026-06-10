// ============================================================
// ThesisEligibility.gs — who may sponsor / read senior theses
// ============================================================
// Eligibility is CONFIGURATION, not code. For each capability
// ('sponsor', 'reader') it is computed as:
//
//     (active users holding an eligible ROLE)
//       ∪  AllowEmails   (force ON — eligible even without the role)
//       −  DenyEmails    (force OFF — not eligible even with the role)
//
// super_admin is NOT auto-added to the picklist — an admin account
// shouldn't clutter the faculty picker. A super_admin appears only if
// their real roles (or an allow entry) qualify them. Validation
// (isEligible) still permits a super_admin if one is explicitly chosen,
// consistent with super_admin overriding every other privileged check.
//
// The base roles default to senate_faculty + lecturer but live in the
// ThesisEligibility sheet tab so they are editable without code. The
// Admin "faculty roster" UI never exposes allow/deny lists directly —
// it shows each faculty member with a Sponsor and a Reader toggle and
// translates a flip into the right allow/deny edit here.
//
// TOGGLE SEMANTICS (how a per-person switch maps to the lists):
//   A person whose role already makes them eligible is ON by default.
//     - turning them OFF  → add to DenyEmails
//     - turning them ON   → remove from DenyEmails
//   A person whose role does NOT make them eligible is OFF by default.
//     - turning them ON   → add to AllowEmails
//     - turning them OFF  → remove from AllowEmails
//   So the stored lists only ever hold EXCEPTIONS to the role default,
//   which keeps the sheet small and readable.
//
// Mirrors the ImportPolicy / NotifyRules pattern: a small config IIFE
// with list / resolver / mutators, self-seeding its tab on first use.
// ============================================================

const ThesisEligibility = (() => {

  const HEADERS = ['Capability', 'Roles', 'AllowEmails', 'DenyEmails'];
  const CAPABILITIES = ['sponsor', 'reader'];
  const DEFAULT_ROLES = ['senate_faculty', 'lecturer'];


  /**
   * Returns the configured rows (one per capability) for the Admin UI.
   * @returns {Array<{capability, roles[], allowEmails[], denyEmails[]}>}
   */
  function list() {
    const rows = _readRows();
    return CAPABILITIES.map(cap => {
      const r = rows[cap] || _defaultRow(cap);
      return {
        capability:  cap,
        roles:       r.roles,
        allowEmails: r.allowEmails,
        denyEmails:  r.denyEmails,
      };
    });
  }


  /**
   * Resolves the set of users eligible for a capability, shaped for a
   * dropdown: [{ email, name }] sorted by name. Does NOT include
   * super_admins unless their real roles (or an allow entry) qualify them.
   * Tolerates a missing tab (falls back to defaults).
   *
   * @param {string} capability - 'sponsor' | 'reader'
   */
  function eligibleFor(capability) {
    const cap = _requireCapability(capability);
    const row = _readRows()[cap] || _defaultRow(cap);

    const roleSet = {};
    row.roles.forEach(r => { roleSet[_norm(r)] = true; });
    const deny  = _emailSet(row.denyEmails);
    const allow = _emailSet(row.allowEmails);

    const out = [];
    const seen = {};
    const add = (email, name) => {
      const key = _norm(email);
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push({ email: email, name: name || email });
    };

    Auth.listUsers().forEach(u => {
      if (!u.active) return;
      const key = _norm(u.email);
      if (deny[key]) return;                                  // forced OFF
      const roleMatch = (u.roles || []).some(r => roleSet[_norm(r)]);
      if (roleMatch || allow[key]) add(u.email, u.nameLastFirst || u.name || u.email);
    });

    // Allow-listed addresses that are not provisioned users still count
    // (e.g. an external co-sponsor added by email). Name falls back to email.
    Object.keys(allow).forEach(key => {
      if (!seen[key] && !deny[key]) {
        const p = Auth.getProfile(key);
        add(key, p ? (p.nameLastFirst || p.name) : key);
      }
    });

    // NOTE: super_admins are intentionally NOT force-added here. A super
    // admin appears in the sponsor/reader picklist only if their actual
    // roles (or an explicit allow entry) qualify them — admin accounts
    // shouldn't clutter the faculty picker. Validation (isEligible) still
    // permits a super_admin if one is ever explicitly chosen.

    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }


  /** True if `email` is eligible for `capability`. Single-person check
   *  used by the module when validating a chosen sponsor / reader.
   *  Fully roster-governed: a super_admin is eligible only if toggled on
   *  (no implicit override) — off means off for everyone. */
  function isEligible(capability, email) {
    const key = _norm(email);
    if (!key) return false;
    return eligibleFor(capability).some(u => _norm(u.email) === key);
  }


  /**
   * The Admin roster: people who can be toggled as sponsors/readers, each
   * with current state and a `category` for grouping in the UI. Candidates
   * are: faculty (the default-eligible roles), staff (surfaced for testing/
   * convenience, OFF by default), super admins (OFF by default), and anyone
   * on an allow list (e.g. an external email already toggled on).
   *
   * Surfacing a role here does NOT make it eligible — staff and admins start
   * off and only become eligible when switched on (writing an allow entry).
   * Only the seeded eligible roles (faculty) are on by default.
   *
   * @returns {Array<{email, name, roles[], category,
   *                  sponsor:{eligible,byRole,override},
   *                  reader: {eligible,byRole,override}}>}
   */
  function roster() {
    const rows = _readRows();
    const spRow = rows.sponsor || _defaultRow('sponsor');
    const rdRow = rows.reader  || _defaultRow('reader');

    const spRoles = _roleSet(spRow.roles), spAllow = _emailSet(spRow.allowEmails), spDeny = _emailSet(spRow.denyEmails);
    const rdRoles = _roleSet(rdRow.roles), rdAllow = _emailSet(rdRow.allowEmails), rdDeny = _emailSet(rdRow.denyEmails);

    // Roles surfaced for visibility/toggling beyond the eligible ones.
    // Eligible (faculty) roles are on by default; these extra roles are
    // shown so they can be toggled on for testing, but start off.
    const EXTRA_VISIBLE_ROLES = { staff: true };

    const people = {};
    const remember = (email, name, roles) => {
      const key = _norm(email);
      if (!key) return;
      if (!people[key]) people[key] = { email: email, name: name || email, roles: roles || [] };
    };

    Auth.listUsers().forEach(u => {
      if (!u.active) return;
      const roleHit  = (u.roles || []).some(r => spRoles[_norm(r)] || rdRoles[_norm(r)]);
      const extraHit = (u.roles || []).some(r => EXTRA_VISIBLE_ROLES[_norm(r)]);
      const allowHit = spAllow[_norm(u.email)] || rdAllow[_norm(u.email)];
      if (roleHit || extraHit || allowHit) remember(u.email, u.nameLastFirst || u.name || u.email, u.roles || []);
    });
    Object.keys(Object.assign({}, spAllow, rdAllow)).forEach(key => {
      if (!people[key]) {
        const p = Auth.getProfile(key);
        remember(key, p ? (p.nameLastFirst || p.name || key) : key, p ? p.roles : []);
      }
    });

    // Super admins are surfaced as roster rows too, so they can be toggled
    // on/off like anyone else. They are OFF by default (no eligible role,
    // no allow entry) and become eligible only when switched on, which
    // writes an allow entry — same mechanism as a non-faculty person.
    (CONFIG.SUPER_ADMINS || []).forEach(em => {
      const p = Auth.getProfile(em);
      const roles = p ? p.roles : ['super_admin'];
      remember(em, p ? (p.nameLastFirst || p.name || em) : em, roles && roles.length ? roles : ['super_admin']);
    });

    return Object.keys(people).map(key => {
      const person = people[key];
      const sp = _state(person, spRoles, spAllow, spDeny);
      const rd = _state(person, rdRoles, rdAllow, rdDeny);
      return {
        email: person.email, name: person.name, roles: person.roles,
        category: _category(person.email, person.roles),
        sponsor: sp, reader: rd,
      };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  /**
   * Buckets a person for roster grouping. A super admin is shown under
   * "Super admins" even if they also hold another role, since that's the
   * account's defining capability for this screen.
   */
  function _category(email, roles) {
    if ((CONFIG.SUPER_ADMINS || []).some(a => _norm(a) === _norm(email))) return 'Super admins';
    const rs = (roles || []).map(_norm);
    if (rs.indexOf('super_admin') !== -1) return 'Super admins';
    if (rs.indexOf('senate_faculty') !== -1 || rs.indexOf('lecturer') !== -1) return 'Faculty';
    if (rs.indexOf('staff') !== -1) return 'Staff';
    return 'Other';
  }


  /**
   * Flips one person's eligibility for one capability ON or OFF, writing
   * the minimal allow/deny change. Idempotent.
   *
   * @param {Object} p - { capability, email, eligible:boolean }
   */
  function setToggle(p) {
    p = p || {};
    const cap = _requireCapability(p.capability);
    const email = String(p.email || '').trim();
    if (!email) throw new Error('Email is required.');
    const want = (p.eligible === true || p.eligible === 'true');

    const rows = _readRows();
    const row  = rows[cap] || _defaultRow(cap);
    const roleSet = _roleSet(row.roles);

    const profile = Auth.getProfile(email);
    const eligibleByRole = !!(profile && profile.active &&
      (profile.roles || []).some(r => roleSet[_norm(r)]));

    let allow = row.allowEmails.slice();
    let deny  = row.denyEmails.slice();
    const key = _norm(email);

    if (eligibleByRole) {
      // Default ON: an override is a DENY entry.
      deny  = deny.filter(e => _norm(e) !== key);
      allow = allow.filter(e => _norm(e) !== key);   // allow is meaningless here
      if (!want) deny.push(email);
    } else {
      // Default OFF: an override is an ALLOW entry.
      allow = allow.filter(e => _norm(e) !== key);
      deny  = deny.filter(e => _norm(e) !== key);     // deny is meaningless here
      if (want) allow.push(email);
    }

    _writeRow(cap, { roles: row.roles, allowEmails: allow, denyEmails: deny });
    return { capability: cap, email: email, eligible: want };
  }


  /**
   * Replaces the base ROLES for a capability (advanced; the roster UI
   * doesn't expose this, but it keeps roles out of code and editable).
   * @param {Object} p - { capability, roles: string[] | csv }
   */
  function setRoles(p) {
    p = p || {};
    const cap = _requireCapability(p.capability);
    const roles = (Array.isArray(p.roles) ? p.roles : String(p.roles || '').split(','))
      .map(r => _norm(r)).filter(Boolean);
    const row = _readRows()[cap] || _defaultRow(cap);
    _writeRow(cap, { roles: roles, allowEmails: row.allowEmails, denyEmails: row.denyEmails });
    return { capability: cap, roles: roles };
  }


  // ── Private ────────────────────────────────────────────────

  function _state(person, roleSet, allow, deny) {
    const key = _norm(person.email);
    const byRole = (person.roles || []).some(r => roleSet[_norm(r)]);
    let eligible, override;
    if (deny[key])      { eligible = false; override = byRole; }      // explicit OFF (only meaningful if byRole)
    else if (allow[key]){ eligible = true;  override = !byRole; }     // explicit ON (only meaningful if !byRole)
    else                { eligible = byRole; override = false; }      // role default
    return { eligible: eligible, byRole: byRole, override: override };
  }

  function _readRows() {
    const out = {};
    try {
      const sheet = _ensureSheet();
      const data  = sheet.getDataRange().getValues();
      const headers = data[0].map(h => String(h).trim());
      const idx = name => headers.indexOf(name);
      for (let i = 1; i < data.length; i++) {
        const cap = _norm(data[i][idx('Capability')]);
        if (CAPABILITIES.indexOf(cap) === -1) continue;
        out[cap] = {
          roles:       _csv(data[i][idx('Roles')]).map(_norm),
          allowEmails: _csv(data[i][idx('AllowEmails')]),
          denyEmails:  _csv(data[i][idx('DenyEmails')]),
        };
      }
    } catch (err) {
      Logger.log('ThesisEligibility._readRows failed (using defaults): ' + err);
    }
    return out;
  }

  function _writeRow(capability, row) {
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim());
    const idx = name => headers.indexOf(name);
    const values = [];
    values[idx('Capability')]  = capability;
    values[idx('Roles')]       = (row.roles || []).join(', ');
    values[idx('AllowEmails')] = (row.allowEmails || []).join(', ');
    values[idx('DenyEmails')]  = (row.denyEmails || []).join(', ');

    for (let i = 1; i < data.length; i++) {
      if (_norm(data[i][idx('Capability')]) === _norm(capability)) {
        sheet.getRange(i + 1, 1, 1, headers.length).setValues([values]);
        return;
      }
    }
    sheet.appendRow(values);
  }

  function _ensureSheet() {
    const ss = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
    let sheet = ss.getSheetByName(CONFIG.TABS.THESIS_ELIGIBILITY);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.TABS.THESIS_ELIGIBILITY);
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#e8eaed');
      sheet.setFrozenRows(1);
      CAPABILITIES.forEach(cap => {
        const d = _defaultRow(cap);
        sheet.appendRow([cap, d.roles.join(', '), '', '']);
      });
    }
    return sheet;
  }

  function _defaultRow(cap) {
    return { roles: DEFAULT_ROLES.slice(), allowEmails: [], denyEmails: [] };
  }

  function _requireCapability(c) {
    const cap = _norm(c);
    if (CAPABILITIES.indexOf(cap) === -1) {
      throw new Error('Unknown thesis capability: ' + c + ' (expected ' + CAPABILITIES.join(' or ') + ').');
    }
    return cap;
  }

  function _csv(v) { return String(v || '').split(/[,;]/).map(s => s.trim()).filter(Boolean); }
  function _roleSet(arr) { const m = {}; (arr || []).forEach(r => { m[_norm(r)] = true; }); return m; }
  function _emailSet(arr) { const m = {}; (arr || []).forEach(e => { m[_norm(e)] = true; }); return m; }
  function _norm(s) { return String(s || '').trim().toLowerCase(); }


  return { list, eligibleFor, isEligible, roster, setToggle, setRoles };

})();