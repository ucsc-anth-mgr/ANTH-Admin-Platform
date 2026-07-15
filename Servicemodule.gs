// ============================================================
// ServiceModule.gs — Department Service (server)
// ============================================================
// Assigns and tracks faculty department service: a catalog of
// service positions/committees and a ledger of per-year assignments,
// adapted from the department's standalone service app.
//
// PHASE 1: catalog management, assignment CRUD, the current-year
//   directory, per-person history, granted full history, corrections
//   routed through Tasks, and a one-time CSV import with name-match
//   preview.
// PHASE 2 (this file now includes it): ranked self-nomination. Everyone
//   in the module submits ORDERED preferences (Priority 1 = first
//   choice) for a target year while the window is open; preferences
//   inform assignments but are NOT a guarantee. The super admin opens/
//   closes the window (target year locked at open, so a window that
//   straddles July 1 keeps its year), reviews the queue, and accepts
//   (creating the proposed next-year assignment) or declines (note is
//   internal). PROPOSED is the NOMINATIONS SLATE for the cycle's
//   target year — the tentative pool (volunteered = OPEN, confirmed =
//   ACCEPTED shown as "Assigned"), distinct from Current's confirmed
//   selections. It is visible ONLY to super_admin and the
//   department_chair role holder: nomination notes carry things like
//   sabbatical timing written for the chair/admin, so the audience is
//   restricted rather than the fields redacted — the slate includes
//   each nominee's priority and note, expandable per entry in the UI.
//   DECLINED and WITHDRAWN nominations never render. The tab follows
//   the nomination cycle's target year (NOMINATION_YEAR); Current
//   still rolls on July 1 and the window still defaults to next AY.
// PHASE 3 (later): service report / hours survey.
//
// DESIGN NOTES (platform contracts honored here):
//   - Identity is NOT copied onto records. PersonEmail is the routing
//     key; display names come from Auth at read time. RawName is kept
//     ONLY for historical people with no portal profile (21 years of
//     legacy data includes retired/departed faculty). When a record is
//     matched to a profile, RawName is cleared — never both.
//   - The ServiceCatalog tab replaces the legacy Settings sheet AND the
//     legacy UI's hardcoded category lists (special/quarterly categories,
//     leadership ordering, no-bold lists). All display behavior is
//     driven by catalog attributes: IsQuarterly, DefaultRole,
//     IsLeadership, SortWeight, NominationEligible (used in Phase 2).
//     Catalog keys are slugs and PERMANENT once created (assignment
//     rows reference them); labels are editable.
//   - PERMISSIONS (module-centric entry via the Modules row; finer
//     checks per action). Deciding who serves is deliberately
//     super_admin-only — assignment CRUD, import, the corrections
//     queue, catalog management, and nomination decisions are one
//     sensitive function:
//       everyone in the module  → current/proposed directories, own
//                                 history, submit a correction, ranked
//                                 self-nomination
//       service_history role    → full multi-year department history
//                                 (grantable ONLY by super_admin: keep
//                                 this role OFF the ImportPolicy
//                                 allowlist). Staff have NO implicit
//                                 full-history view — grant this role
//                                 individually where wanted.
//       department_chair role   → the Proposed slate (nominations with
//                                 priorities and notes for the cycle's
//                                 target year). A functional position-
//                                 role like staff_undergrad: created in
//                                 Admin → Roles, assigned to whoever
//                                 holds the chair, kept OFF the
//                                 ImportPolicy allowlist.
//       super_admin             → all management: catalog, assignments,
//                                 corrections queue, import, nomination
//                                 window + decisions (and everything
//                                 the chair sees)
//   - Corrections: the ServiceCorrections row is the authoritative
//     record; a Tasks entry (assignedRole: staff) is a pointer to it,
//     and staff role-holders are emailed via Notify (best-effort). This
//     replaces the legacy write-only Corrections sheet nobody watched.
//   - Import is preview-then-commit (same shape as ClassSchedule and
//     the batch user importer). The legacy CSV is name-keyed with no
//     emails, so matching is name-vs-profile (FirstName/LastName plus
//     AltNames, which may hold strings or {first,last} objects).
//     Unmatched rows import with RawName preserved. Non-quarter values
//     found in the legacy Quarter column ("BioAnth cases",
//     "Outside Dept") are shunted into Notes, never silently dropped.
//   - AUTO-ASSIGNS (catalog-driven, never hardcoded): a category may
//     carry companion categories in its AutoAssigns attribute
//     ("key:Role, key" — Role optional, falling back to the target's
//     DefaultRole). When someone is assigned to the category — via
//     manual Add or by accepting a nomination — companion assignments
//     are created for the same year/quarter with a provenance note.
//     Skipped when the person is already on that committee that year.
//     ONE LEVEL ONLY (companions never chain); the legacy import never
//     fires rules (history already holds its explicit rows); deleting
//     the trigger does NOT cascade (companions are real assignments).
//     Rules are NOT retroactive on their own — reapplyAutoAssigns is
//     the deliberate catch-up: it sweeps one year's existing
//     assignments and creates missing companions (idempotent; snapshot
//     iteration keeps it one-level too).
//     Accepting a nomination also auto-accepts the person's own OPEN
//     nominations for companion committees (provenance decision note),
//     so nothing moot lingers in the queue.
//   - AD HOC (per-assignment visibility): an ASSIGNMENT flagged IsAdHoc
//     is hidden from the Current Assignments directory only — the
//     member is ad hoc, not the committee, so the committee's card and
//     its regular members render normally (a committee whose members
//     are ALL ad hoc simply has no card, since Current is populated-
//     only). The record remains fully visible — badged "ad hoc" — in
//     My History, Full History, and the management tables: real,
//     credited service. Behaviors are unaffected: GrantsRole still
//     grants (hidden, not stripped of function), and an auto-assign
//     companion INHERITS the trigger's flag so a hidden appointment
//     never leaks into the directory through a rule. Set on the
//     Add/Edit assignment form; accepted nominations are never ad hoc
//     (self-nominated is the opposite of appointed); the legacy import
//     ignores it. Filtered server-side in currentAssignments.
//   - GRANTS-ROLE (catalog-driven cross-module contract): a category
//     may carry a GrantsRole attribute — "role" or "role:members" — and
//     the module keeps that Auth role equal to the category's CURRENT-
//     YEAR membership (a live projection other modules read via
//     Auth.usersWithRole(), e.g. Academic Personnel reads
//     personnel_committee for its assignable-drafter pool). ":members"
//     excludes assignees whose Role is exactly "Chair" (the chair
//     assigns rather than drafts); drop the modifier to include them —
//     a data edit, no code. Rules: the granted role must already exist
//     in Admin → Roles; super_admin can never be granted this way;
//     RawName rows and inactive profiles never receive the role; the
//     role is MACHINE-OWNED (a manual grant not backed by a current
//     assignment is stripped at the next reconcile). Reconciles run
//     after every assignment mutation (add/update/delete/import/accept/
//     re-apply) and lazily at the first bootstrap after July 1
//     (LAST_ROLE_SYNC_YEAR in ServiceSettings — no cron exists), all
//     best-effort: a role-sync failure never fails the primary action.
//     upsertUser REBUILDS the profile row, so the reconcile reads each
//     full profile and writes every field back with the modified roles.
//   - Cross-cutting concerns go through platform services: Tasks,
//     Notify, Auth, DataService, Settings. No SpreadsheetApp here.
//
// REGISTRATION (Code.gs): add ServiceModule to getModuleHandler() and
//   getRegisteredHandlers(), then add the Modules-sheet row via
//   Admin → Modules (key: service — permanent). Keep both commented
//   until this file ships. Config.gs / Setup.gs paste-ins are at the
//   bottom of this file.
// ============================================================

const ServiceModule = (() => {

  const MODULE = 'service';
  const HISTORY_ROLE = 'service_history';      // full-history grant (super_admin-assigned)
  const CHAIR_ROLE = 'department_chair';       // Proposed-slate access (position role)
  const CORRECTION_SOURCE_TYPE = 'service_correction';

  const QUARTERS = ['Fall', 'Winter', 'Spring'];
  const ROLE_SUGGESTIONS = ['Chair', 'Vice Chair', 'Member', 'Coordinator'];
  // Who appears in the Add/Edit assignment person picker. Assignments are
  // a faculty function; anyone else (emeriti, one-off cases) can still be
  // recorded via the "person without a portal profile" RawName path.
  const ASSIGNABLE_ROLES = ['senate_faculty', 'lecturer'];

  // ── Configuration access (read lazily so load order is irrelevant) ──
  function SHEET() {
    const id = String((CONFIG.SHEETS && CONFIG.SHEETS.SERVICE) || '').trim();
    if (!id) throw new Error('Department Service storage is not configured (CONFIG.SHEETS.SERVICE).');
    return id;
  }
  function CATALOG_TAB() { return String((CONFIG.TABS && CONFIG.TABS.SERVICE_CATALOG) || 'ServiceCatalog'); }
  function ASSIGN_TAB()  { return String((CONFIG.TABS && CONFIG.TABS.SERVICE_ASSIGNMENTS) || 'ServiceAssignments'); }
  function CORR_TAB()    { return String((CONFIG.TABS && CONFIG.TABS.SERVICE_CORRECTIONS) || 'ServiceCorrections'); }
  function NOMS_TAB()    { return String((CONFIG.TABS && CONFIG.TABS.SERVICE_NOMINATIONS) || 'ServiceNominations'); }
  function SETTINGS_TAB(){ return String((CONFIG.TABS && CONFIG.TABS.SERVICE_SETTINGS) || 'ServiceSettings'); }


  // ============================================================
  // PERMISSION HELPERS
  // ============================================================

  function _isAdmin(roles) {
    return roles.indexOf('super_admin') !== -1;
  }
  function _canSeeAll(roles) {
    return _isAdmin(roles) || roles.indexOf(HISTORY_ROLE) !== -1;
  }
  function _assertAdmin(roles) {
    if (!_isAdmin(roles)) throw new Error('Only a portal super admin can perform this action.');
  }
  function _canSeeProposed(roles) {
    return _isAdmin(roles) || roles.indexOf(CHAIR_ROLE) !== -1;
  }
  function _assertProposed(roles) {
    if (!_canSeeProposed(roles)) {
      throw new Error('The proposed slate is visible to the department chair and super admins.');
    }
  }
  function _assertSeeAll(roles) {
    if (!_canSeeAll(roles)) {
      throw new Error('Full service history requires the service_history role. You can view your own history.');
    }
  }


  // ============================================================
  // SMALL UTILITIES
  // ============================================================

  function _isTrue(v) { return String(v).trim().toUpperCase() === 'TRUE'; }
  function _bool(v)   { return v ? 'TRUE' : 'FALSE'; }
  function _numOr(v, d) { const n = Number(v); return (v !== '' && v !== null && v !== undefined && isFinite(n)) ? n : d; }
  function _normEmail(e) { return String(e || '').trim().toLowerCase(); }

  /**
   * Date-safe string for values returned to the client. google.script.run
   * cannot serialize Date objects — a Date anywhere in the return value
   * nulls the whole response. DataService stamps CreatedAt/UpdatedAt as
   * real Dates (and Sheets returns date-typed cells as Dates), so every
   * date-ish field is converted at the return boundary, matching the
   * platform convention (RequestManager formats dates before returning).
   */
  function _dateStr(v) {
    if (v instanceof Date) return v.toISOString();
    return v === null || v === undefined ? '' : String(v);
  }

  /** Accent-insensitive, punctuation-insensitive name normalization. */
  function _norm(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /** Catalog key slug from a label. Keys are permanent once created. */
  function _slug(label) { return _norm(label).replace(/\s+/g, '_'); }

  // Academic year helpers — same convention as the legacy app:
  // Jan–Jun belongs to the year that started the previous fall.
  function _fmtYear(startYear) { return startYear + '-' + String(startYear + 1).slice(-2); }
  function _yearStart() {
    const now = new Date();
    return now.getMonth() < 6 ? now.getFullYear() - 1 : now.getFullYear();
  }
  function _currentYear() { return _fmtYear(_yearStart()); }
  function _nextYear()    { return _fmtYear(_yearStart() + 1); }

  function _yearOk(y) { return /^\d{4}-\d{2}$/.test(String(y || '').trim()); }

  /**
   * Normalizes legacy quarter spellings toward the canonical form:
   * comma-separated lists become slash-joined ("Fall, Winter, Spring" →
   * "Fall/Winter/Spring"), whitespace is trimmed around separators.
   * Returns the normalized string; validity is still _quarterOk's call.
   */
  function _normalizeQuarter(q) {
    return String(q || '').trim()
      .replace(/\s*,\s*/g, '/')
      .replace(/\s*\/\s*/g, '/');
  }

  /** '' | 'AY' | slash-joined quarters (e.g. "Fall", "Fall/Winter"). */
  function _quarterOk(q) {
    q = String(q || '').trim();
    if (!q || q === 'AY') return true;
    return q.split('/').every(p => QUARTERS.indexOf(p.trim()) !== -1);
  }


  // ============================================================
  // CATALOG (shared readers)
  // ============================================================

  function _catalogRows() { return DataService.getAll(SHEET(), CATALOG_TAB()); }

  function _catalogMap() {
    const m = {};
    _catalogRows().forEach(r => { if (String(r.Key || '').trim()) m[String(r.Key).trim()] = r; });
    return m;
  }

  function _publicCategory(r, usage) {
    return {
      key: r.Key,
      label: r.Label,
      active: _isTrue(r.Active),
      isQuarterly: _isTrue(r.IsQuarterly),
      defaultRole: String(r.DefaultRole || 'Member'),
      isLeadership: _isTrue(r.IsLeadership),
      sortWeight: _numOr(r.SortWeight, 100),
      nominationEligible: _isTrue(r.NominationEligible),
      autoAssigns: String(r.AutoAssigns || ''),
      grantsRole: String(r.GrantsRole || ''),
      notes: String(r.Notes || ''),
      usageCount: usage ? (usage[r.Key] || 0) : undefined,
    };
  }


  // ── Auto-assign rules ────────────────────────────────────

  /**
   * Parses an AutoAssigns attribute: comma-separated entries, each a
   * category label or key, optionally ":Role". Labels are slugged, so
   * "Graduate Admissions:Chair" and "graduate_admissions:Chair" are
   * equivalent. Returns [{ key, role }] (role '' = target's default).
   */
  function _parseAutoAssigns(raw) {
    return String(raw || '').split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(entry => {
        const at = entry.indexOf(':');
        const keyPart = at === -1 ? entry : entry.slice(0, at);
        const rolePart = at === -1 ? '' : entry.slice(at + 1).trim();
        return { key: _slug(keyPart), role: rolePart };
      })
      .filter(e => e.key);
  }

  /**
   * Fires a category's auto-assign rules for one just-created
   * assignment: creates companion assignments (same person, year,
   * quarter; rule role or the target's DefaultRole) with a provenance
   * note. Skips when the person already holds ANY assignment in that
   * category+year, or the target category no longer exists. One level
   * only — companions are inserted directly and never chain.
   * Returns [{ categoryLabel, role?, created, reason? }].
   */
  function _runAutoAssigns(triggerRec, triggerCat) {
    const rules = _parseAutoAssigns(triggerCat && triggerCat.AutoAssigns);
    if (!rules.length) return [];
    const catMap = _catalogMap();
    const all = _assignmentRows();
    const results = [];

    rules.forEach(rule => {
      const target = catMap[rule.key];
      if (!target) {
        results.push({ categoryLabel: rule.key, created: false, reason: 'unknown category' });
        return;
      }
      const label = String(target.Label);
      const onIt = all.some(r =>
        String(r.CategoryKey || '').trim() === rule.key &&
        String(r.Year || '').trim() === triggerRec.Year &&
        ((triggerRec.PersonEmail && _normEmail(r.PersonEmail) === _normEmail(triggerRec.PersonEmail)) ||
         (!triggerRec.PersonEmail && _norm(r.RawName) && _norm(r.RawName) === _norm(triggerRec.RawName))));
      if (onIt) {
        results.push({ categoryLabel: label, created: false, reason: 'already on this committee for ' + triggerRec.Year });
        return;
      }
      const role = rule.role || String(target.DefaultRole || 'Member').trim() || 'Member';
      DataService.insert(SHEET(), ASSIGN_TAB(), {
        AssignmentID: DataService.generateId('SVASN'),
        PersonEmail: triggerRec.PersonEmail,
        RawName: triggerRec.RawName,
        CategoryKey: rule.key,
        Role: role,
        Year: triggerRec.Year,
        Quarter: triggerRec.Quarter,
        IsAdHoc: _bool(_isTrue(triggerRec.IsAdHoc)),   // hidden appointments never leak via a rule
        Notes: 'Auto-assigned with ' + String(triggerCat.Label || ''),
      });
      results.push({ categoryLabel: label, role: role, created: true });
    });
    return results;
  }


  /**
   * Re-applies auto-assign rules across one year's EXISTING assignments —
   * the catch-up for rules created after assignments were made (rules
   * fire only at Add/Accept time and are never retroactive on their
   * own). Idempotent: a person already on the companion committee for
   * the year is skipped, so repeat runs are no-ops. Iterates a
   * pre-sweep snapshot, so companions created by the sweep are never
   * themselves treated as triggers (one level, like live firing).
   */
  function reapplyAutoAssigns(payload, user, roles) {
    _assertAdmin(roles);
    const year = String((payload || {}).year || '').trim();
    if (!_yearOk(year)) throw new Error('Year must look like 2026-27.');

    const catMap = _catalogMap();
    const rulesByCat = {};
    Object.keys(catMap).forEach(k => {
      const rules = _parseAutoAssigns(catMap[k].AutoAssigns);
      if (rules.length) rulesByCat[k] = rules;
    });
    if (!Object.keys(rulesByCat).length) {
      return { year: year, scanned: 0, created: [], skippedUnknownTargets: 0 };
    }

    const snapshot = _assignmentRows().filter(r => String(r.Year || '').trim() === year);
    const personKey = r => _normEmail(r.PersonEmail) || _norm(r.RawName);
    const has = {};
    snapshot.forEach(r => { has[personKey(r) + '|' + String(r.CategoryKey || '').trim()] = true; });

    const created = [];
    let skippedUnknown = 0;
    snapshot.forEach(r => {
      const trigKey = String(r.CategoryKey || '').trim();
      const rules = rulesByCat[trigKey];
      if (!rules) return;
      const pk = personKey(r);
      if (!pk) return;
      const trigCat = catMap[trigKey];

      rules.forEach(rule => {
        const target = catMap[rule.key];
        if (!target) { skippedUnknown++; return; }
        const k = pk + '|' + rule.key;
        if (has[k]) return;   // already on that committee this year (or created earlier in this sweep)
        has[k] = true;
        const role = rule.role || String(target.DefaultRole || 'Member').trim() || 'Member';
        DataService.insert(SHEET(), ASSIGN_TAB(), {
          AssignmentID: DataService.generateId('SVASN'),
          PersonEmail: String(r.PersonEmail || ''),
          RawName: String(r.PersonEmail || '').trim() ? '' : String(r.RawName || ''),
          CategoryKey: rule.key,
          Role: role,
          Year: year,
          Quarter: String(r.Quarter || ''),
          IsAdHoc: _bool(_isTrue(r.IsAdHoc)),
          Notes: 'Auto-assigned with ' + String(trigCat.Label || ''),
        });
        const p = String(r.PersonEmail || '').trim() ? Auth.getProfile(r.PersonEmail) : null;
        created.push({
          name: p ? (p.nameLastFirst || p.name || p.email) : String(r.RawName || r.PersonEmail || ''),
          categoryLabel: String(target.Label),
          role: role,
          withCategory: String(trigCat.Label || ''),
        });
      });
    });

    _syncGrantedRoles();
    return { year: year, scanned: snapshot.length, created: created, skippedUnknownTargets: skippedUnknown };
  }


  // ── Granted roles (catalog GrantsRole → Auth role projection) ──

  const ROLE_SYNC_YEAR_KEY = 'LAST_ROLE_SYNC_YEAR';

  /** "role" or "role:members" → { role, membersOnly } (null when blank). */
  function _parseGrantsRole(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const at = s.indexOf(':');
    const role = (at === -1 ? s : s.slice(0, at)).trim().toLowerCase();
    if (!role) return null;
    const mod = at === -1 ? '' : s.slice(at + 1).trim().toLowerCase();
    return { role: role, membersOnly: mod === 'members' };
  }

  /** ":members" excludes exactly this assignment Role (Vice Chair stays in). */
  function _isChairRole(role) { return /^\s*chair\s*$/i.test(String(role || '')); }

  /**
   * Reconciles every GrantsRole projection: for each granted role, the
   * holder set becomes exactly the CURRENT-YEAR assignees of the
   * categories granting it (active profiles only; RawName rows have no
   * account to grant; ":members" drops Chair-role assignees). Grants
   * the missing, revokes the stale — including manual strays and
   * holders gone inactive — touching only users whose membership
   * changed. upsertUser rebuilds the row, so the FULL profile is passed
   * back with the modified roles (names/IDs/AltNames/Notes preserved).
   * Stamps LAST_ROLE_SYNC_YEAR so the bootstrap rollover guard knows
   * the projection has been computed for this academic year.
   */
  function _reconcileGrantedRoles() {
    const year = _currentYear();
    const rules = [];
    _catalogRows().forEach(c => {
      const g = _parseGrantsRole(c.GrantsRole);
      if (g && g.role !== 'super_admin') rules.push({ key: String(c.Key || '').trim(), role: g.role, membersOnly: g.membersOnly });
    });
    const summary = { granted: [], revoked: [] };
    if (rules.length) {
      const desiredByRole = {};   // role -> { email: true }
      rules.forEach(rule => { desiredByRole[rule.role] = desiredByRole[rule.role] || {}; });
      _assignmentRows()
        .filter(r => String(r.Year || '').trim() === year)
        .forEach(r => {
          const catKey = String(r.CategoryKey || '').trim();
          const email = _normEmail(r.PersonEmail);
          if (!email) return;   // RawName-only records carry no account
          rules.forEach(rule => {
            if (rule.key !== catKey) return;
            if (rule.membersOnly && _isChairRole(r.Role)) return;
            desiredByRole[rule.role][email] = true;
          });
        });

      const users = Auth.listUsers();
      Object.keys(desiredByRole).forEach(role => {
        const desired = desiredByRole[role];
        users.forEach(u => {
          const has = (u.roles || []).indexOf(role) !== -1;
          const want = !!desired[_normEmail(u.email)] && u.active !== false;
          if (want === has) return;
          Auth.upsertUser({
            email: u.email,
            firstName: u.firstName, lastName: u.lastName,
            altNames: u.altNames,
            roles: want ? (u.roles || []).concat([role]) : (u.roles || []).filter(x => x !== role),
            studentId: u.studentId, employeeId: u.employeeId,
            active: u.active, notes: u.notes,
          });
          (want ? summary.granted : summary.revoked).push(u.email);
        });
      });
    }
    _setSetting(ROLE_SYNC_YEAR_KEY, year);
    return summary;
  }

  /** Best-effort wrapper: a role-sync failure never fails the primary action. */
  function _syncGrantedRoles() {
    try { return _reconcileGrantedRoles(); }
    catch (e) {
      Logger.log('ServiceModule granted-role sync failed: ' + e);
      return { granted: [], revoked: [], error: String(e) };
    }
  }


  // ============================================================
  // ASSIGNMENTS (shared readers)
  // ============================================================

  function _assignmentRows() { return DataService.getAll(SHEET(), ASSIGN_TAB()); }

  function _publicAssignment(r, catMap) {
    const cat = catMap[String(r.CategoryKey || '').trim()] || null;
    let name = String(r.RawName || '').trim();
    let nameLastFirst = name;
    let hasProfile = false;
    if (String(r.PersonEmail || '').trim()) {
      const p = Auth.getProfile(r.PersonEmail);
      if (p) {
        name = p.name; nameLastFirst = p.nameLastFirst; hasProfile = true;
      } else {
        name = name || String(r.PersonEmail);
        nameLastFirst = nameLastFirst || String(r.PersonEmail);
      }
    }
    return {
      assignmentId: r.AssignmentID,
      personEmail: String(r.PersonEmail || ''),
      rawName: String(r.RawName || ''),
      name: name, nameLastFirst: nameLastFirst, hasProfile: hasProfile,
      categoryKey: String(r.CategoryKey || ''),
      categoryLabel: cat ? String(cat.Label) : String(r.CategoryKey || ''),
      isLeadership: cat ? _isTrue(cat.IsLeadership) : false,
      isQuarterly: cat ? _isTrue(cat.IsQuarterly) : false,
      sortWeight: cat ? _numOr(cat.SortWeight, 100) : 100,
      role: String(r.Role || ''),
      year: String(r.Year || ''),
      quarter: String(r.Quarter || ''),
      isAdHoc: _isTrue(r.IsAdHoc),
      notes: String(r.Notes || ''),
      createdAt: _dateStr(r.CreatedAt),
    };
  }

  /** Exact-duplicate key: person + category + role + year + quarter. */
  function _dupKey(personEmail, rawName, categoryKey, role, year, quarter) {
    const who = _normEmail(personEmail) || _norm(rawName);
    return [who, String(categoryKey).trim(), _norm(role), String(year).trim(), _norm(quarter)].join('|');
  }

  function _existingDupKeys() {
    const set = {};
    _assignmentRows().forEach(r => {
      set[_dupKey(r.PersonEmail, r.RawName, r.CategoryKey, r.Role, r.Year, r.Quarter)] = true;
    });
    return set;
  }


  // ============================================================
  // ENTRY-LEVEL ACTIONS (everyone the Modules row admits)
  // ============================================================

  /** One-round-trip module state: permissions + catalog + directory. */
  function bootstrap(payload, user, roles) {
    const me = Auth.getProfile(user);
    // Lazy rollover guard: nothing fires AT July 1 (no cron), so the
    // first bootstrap of a new academic year reconciles granted roles
    // once — last year's committee stops holding personnel_committee
    // the first time anyone opens the module after the year turns.
    if (_getSetting(ROLE_SYNC_YEAR_KEY, '') !== _currentYear()) _syncGrantedRoles();
    return {
      me: { email: user, name: (me && me.name) || user },
      canManage: _isAdmin(roles),
      canSeeProposed: _canSeeProposed(roles),
      canSeeAll: _canSeeAll(roles),
      currentYear: _currentYear(),
      nextYear: _nextYear(),
      nomination: _nominationState(),
      roleSuggestions: ROLE_SUGGESTIONS,
      catalog: _catalogRows().map(r => _publicCategory(r, null)),
      currentAssignments: currentAssignments(payload, user, roles),
    };
  }

  /** The public directory: every assignment for the current academic year. */
  function currentAssignments(payload, user, roles) {
    const catMap = _catalogMap();
    const year = _currentYear();
    return _assignmentRows()
      .filter(r => String(r.Year || '').trim() === year
        && !_isTrue(r.IsAdHoc))   // ad hoc members: hidden from the public directory
      .map(r => _publicAssignment(r, catMap));
  }

  /** The signed-in person's own service history, all years. */
  function myHistory(payload, user, roles) {
    const catMap = _catalogMap();
    const key = _normEmail(user);
    return _assignmentRows()
      .filter(r => _normEmail(r.PersonEmail) === key)
      .map(r => _publicAssignment(r, catMap))
      .sort(_byYearDesc);
  }

  /**
   * Every assignment, every year — the department-wide historical view.
   * Requires the service_history grant (or staff / super_admin).
   */
  function fullHistory(payload, user, roles) {
    _assertSeeAll(roles);
    const catMap = _catalogMap();
    return _assignmentRows()
      .map(r => _publicAssignment(r, catMap))
      .sort(_byYearDesc);
  }

  function _byYearDesc(a, b) {
    const y = String(b.year).localeCompare(String(a.year));
    if (y !== 0) return y;
    const c = String(a.categoryLabel).localeCompare(String(b.categoryLabel));
    if (c !== 0) return c;
    return String(a.nameLastFirst).localeCompare(String(b.nameLastFirst));
  }

  /**
   * Anyone in the module may request a correction to the service record.
   * The ServiceCorrections row is the authoritative record; a staff-pool
   * Task points at it and staff role-holders are emailed (best-effort).
   */
  function submitCorrection(payload, user, roles) {
    payload = payload || {};
    const note = String(payload.note || '').trim();
    if (!note) throw new Error('Describe what needs to be corrected.');

    const year = String(payload.year || '').trim();
    if (year && !_yearOk(year)) throw new Error('Year must look like 2025-26.');
    const quarter = String(payload.quarter || '').trim();
    if (quarter && !_quarterOk(quarter)) throw new Error('Quarter must be AY, Fall, Winter, Spring, or a Fall/Winter-style combination.');

    const categoryLabel = String(payload.categoryLabel || '').trim();
    const catMap = _catalogMap();
    const key = _slug(categoryLabel);
    const categoryKey = catMap[key] ? key : '';   // free text is allowed; key only when it resolves

    const correctionId = DataService.generateId('SVCORR');
    DataService.insert(SHEET(), CORR_TAB(), {
      CorrectionID: correctionId,
      PersonEmail: user,
      Year: year,
      CategoryKey: categoryKey,
      CategoryLabel: categoryLabel,
      Role: String(payload.role || '').trim(),
      Quarter: quarter,
      Note: note,
      Status: 'OPEN',
    });

    const who = (Auth.getProfile(user) || {}).name || user;
    Tasks.create({
      module: MODULE,
      sourceType: CORRECTION_SOURCE_TYPE,
      sourceId: correctionId,
      label: 'Service record correction: ' + who + (categoryLabel ? ' — ' + categoryLabel : '') + (year ? ' (' + year + ')' : ''),
      assignedRole: 'super_admin',
      staleAfterDays: 30,
    });
    _notifyAdminsOfCorrection(correctionId, who, categoryLabel, year, note);

    return { correctionId: correctionId, status: 'OPEN' };
  }

  function _notifyAdminsOfCorrection(correctionId, who, categoryLabel, year, note) {
    try {
      const to = Notify.resolveRecipients({ superAdmins: [], explicit: _superAdminEmails() });
      if (!to.length) return;
      const lines = [
        who + ' has requested a correction to the department service record.',
        '',
        'Committee / service: ' + (categoryLabel || '(not specified)'),
        'Year: ' + (year || '(not specified)'),
        '',
        'Request: ' + note,
      ];
      const base = String((CONFIG.PUBLIC_BASE_URL || '')).trim();
      if (base) lines.push('', 'Review it in the portal: ' + base + '?page=' + MODULE + '&focus=' + correctionId);
      Notify.send({
        to: to,
        subject: 'Service record correction requested',
        body: lines.join('\n'),
        replyTo: Settings.replyTo(MODULE),   // module reply-to (Admin → settings); falls back to CONFIG.DEFAULT_REPLY_TO
      });
    } catch (e) {
      Logger.log('ServiceModule._notifyAdminsOfCorrection failed for ' + correctionId + ': ' + e);
    }
  }

  /** Super admin emails: CONFIG.SUPER_ADMINS plus active role-holders. */
  function _superAdminEmails() {
    const seen = {};
    const out = [];
    (CONFIG.SUPER_ADMINS || []).concat(
      Auth.listUsers()
        .filter(u => u.active && (u.roles || []).indexOf('super_admin') !== -1)
        .map(u => u.email)
    ).forEach(e => {
      const k = _normEmail(e);
      if (k && !seen[k]) { seen[k] = true; out.push(e); }
    });
    return out;
  }


  // ============================================================
  // MANAGEMENT — corrections queue (super_admin only)
  // ============================================================

  function listCorrections(payload, user, roles) {
    _assertAdmin(roles);
    return DataService.getAll(SHEET(), CORR_TAB())
      .map(r => ({
        correctionId: r.CorrectionID,
        personEmail: String(r.PersonEmail || ''),
        personName: (Auth.getProfile(r.PersonEmail) || {}).name || String(r.PersonEmail || ''),
        year: String(r.Year || ''),
        categoryKey: String(r.CategoryKey || ''),
        categoryLabel: String(r.CategoryLabel || ''),
        role: String(r.Role || ''),
        quarter: String(r.Quarter || ''),
        note: String(r.Note || ''),
        status: String(r.Status || 'OPEN'),
        resolvedBy: String(r.ResolvedBy || ''),
        resolvedAt: _dateStr(r.ResolvedAt),
        resolutionNote: String(r.ResolutionNote || ''),
        createdAt: _dateStr(r.CreatedAt),
      }))
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'OPEN' ? -1 : 1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }

  /**
   * Marks a correction handled and resolves its task. The actual record
   * fix (add/edit/delete of an assignment) is a separate, deliberate
   * action — resolving only closes the request.
   */
  function resolveCorrection(payload, user, roles) {
    _assertAdmin(roles);
    const id = String((payload || {}).correctionId || '').trim();
    if (!id) throw new Error('Correction not found.');
    const rows = DataService.query(SHEET(), CORR_TAB(), 'CorrectionID', id);
    if (!rows.length) throw new Error('Correction not found.');
    if (String(rows[0].Status) === 'RESOLVED') return { correctionId: id, status: 'RESOLVED' };

    DataService.update(SHEET(), CORR_TAB(), 'CorrectionID', id, {
      Status: 'RESOLVED',
      ResolvedBy: user,
      ResolvedAt: new Date().toISOString(),
      ResolutionNote: String((payload || {}).resolutionNote || '').trim(),
    });
    Tasks.resolveForSource(MODULE, id, { resolvedBy: user });
    return { correctionId: id, status: 'RESOLVED' };
  }


  // ============================================================
  // SELF-NOMINATION — ranked preferences for the target year
  // ============================================================
  // Everyone in the module. Preferences inform the super admin's
  // assignment decisions; they are NOT a guarantee of assignment.

  function _getSetting(key, dflt) {
    const rows = DataService.query(SHEET(), SETTINGS_TAB(), 'Key', key);
    return rows.length ? String(rows[0].Value).trim() : dflt;
  }
  function _setSetting(key, value) {
    const rows = DataService.query(SHEET(), SETTINGS_TAB(), 'Key', key);
    if (rows.length) DataService.update(SHEET(), SETTINGS_TAB(), 'Key', key, { Value: value });
    else DataService.insert(SHEET(), SETTINGS_TAB(), { Key: key, Value: value });
  }
  function _nominationState() {
    return {
      open: _getSetting('NOMINATIONS_OPEN', 'FALSE') === 'TRUE',
      targetYear: _getSetting('NOMINATION_YEAR', ''),
    };
  }

  function _myNominationRows(email, year) {
    return DataService.query(SHEET(), NOMS_TAB(), 'PersonEmail', email)
      .filter(r => String(r.Year || '').trim() === String(year));
  }

  /** includeInternal=false strips DecidedBy/DecisionNote (nominator view). */
  function _publicNomination(r, catMap, includeInternal) {
    const cat = catMap[String(r.CategoryKey || '').trim()] || null;
    const p = Auth.getProfile(r.PersonEmail);
    const out = {
      nominationId: r.NominationID,
      personEmail: String(r.PersonEmail || ''),
      personName: p ? (p.nameLastFirst || p.name || p.email) : String(r.PersonEmail || ''),
      year: String(r.Year || ''),
      categoryKey: String(r.CategoryKey || ''),
      categoryLabel: cat ? String(cat.Label) : String(r.CategoryKey || ''),
      role: String(r.Role || ''),
      quarter: String(r.Quarter || ''),
      priority: _numOr(r.Priority, 999),
      note: String(r.Note || ''),
      status: String(r.Status || 'OPEN'),
      createdAt: _dateStr(r.CreatedAt),
    };
    if (includeInternal) {
      out.decidedBy = String(r.DecidedBy || '');
      out.decidedAt = _dateStr(r.DecidedAt);
      out.decisionNote = String(r.DecisionNote || '');
    }
    return out;
  }

  /** Keeps a person's OPEN priorities contiguous (1..n) after any change. */
  function _renumberOpen(email, year) {
    _myNominationRows(email, year)
      .filter(r => String(r.Status) === 'OPEN')
      .sort((a, b) => _numOr(a.Priority, 999) - _numOr(b.Priority, 999))
      .forEach((r, i) => {
        if (_numOr(r.Priority, 0) !== i + 1) {
          DataService.update(SHEET(), NOMS_TAB(), 'NominationID', r.NominationID, { Priority: i + 1 });
        }
      });
  }

  /** The signed-in person's nominations for the target year + window state. */
  function myNominations(payload, user, roles) {
    const st = _nominationState();
    if (!st.targetYear) return { state: st, rows: [] };
    const catMap = _catalogMap();
    const rows = _myNominationRows(user, st.targetYear)
      .map(r => _publicNomination(r, catMap, false))
      .sort((a, b) => ((a.status === 'OPEN' ? 0 : 1) - (b.status === 'OPEN' ? 0 : 1)) || (a.priority - b.priority));
    return { state: st, rows: rows };
  }

  function submitNomination(payload, user, roles) {
    payload = payload || {};
    const st = _nominationState();
    if (!st.open) throw new Error('Self-nomination is currently closed.');

    const key = String(payload.categoryKey || '').trim();
    const cat = _catalogMap()[key];
    if (!cat || !_isTrue(cat.Active) || !_isTrue(cat.NominationEligible)) {
      throw new Error('Choose a service category that is open to self-nomination.');
    }
    const quarter = String(payload.quarter || '').trim();
    if (!_quarterOk(quarter)) throw new Error('Quarter must be blank, AY, Fall, Winter, Spring, or a Fall/Winter-style combination.');

    const mine = _myNominationRows(user, st.targetYear);
    const clash = mine.find(r => String(r.CategoryKey || '').trim() === key && String(r.Status) !== 'WITHDRAWN');
    if (clash) {
      throw new Error('You already have a nomination for ' + cat.Label + ' (' + String(clash.Status).toLowerCase() + ').');
    }

    DataService.insert(SHEET(), NOMS_TAB(), {
      NominationID: DataService.generateId('SVNOM'),
      PersonEmail: user,
      Year: st.targetYear,
      CategoryKey: key,
      Role: String(payload.role || '').trim(),
      Quarter: quarter,
      Priority: mine.filter(r => String(r.Status) === 'OPEN').length + 1,
      Note: String(payload.note || ''),
      Status: 'OPEN',
    });
    return myNominations({}, user, roles);
  }

  function withdrawNomination(payload, user, roles) {
    const st = _nominationState();
    if (!st.open) throw new Error('Self-nomination is closed — nominations can no longer be changed.');
    const id = String((payload || {}).nominationId || '').trim();
    const rows = DataService.query(SHEET(), NOMS_TAB(), 'NominationID', id);
    if (!rows.length || _normEmail(rows[0].PersonEmail) !== _normEmail(user)) throw new Error('Nomination not found.');
    if (String(rows[0].Status) !== 'OPEN') throw new Error('Only open nominations can be withdrawn.');

    DataService.update(SHEET(), NOMS_TAB(), 'NominationID', id, { Status: 'WITHDRAWN' });
    _renumberOpen(user, st.targetYear);
    return myNominations({}, user, roles);
  }

  /** Moves one of the caller's OPEN nominations up/down in their ranking. */
  function moveNomination(payload, user, roles) {
    payload = payload || {};
    const st = _nominationState();
    if (!st.open) throw new Error('Self-nomination is closed — nominations can no longer be changed.');
    const id = String(payload.nominationId || '').trim();
    const dir = payload.direction === 'up' ? -1 : 1;

    const open = _myNominationRows(user, st.targetYear)
      .filter(r => String(r.Status) === 'OPEN')
      .sort((a, b) => _numOr(a.Priority, 999) - _numOr(b.Priority, 999));
    const idx = open.findIndex(r => String(r.NominationID) === id);
    if (idx === -1) throw new Error('Nomination not found.');
    const j = idx + dir;
    if (j >= 0 && j < open.length) {
      DataService.update(SHEET(), NOMS_TAB(), 'NominationID', String(open[idx].NominationID), { Priority: j + 1 });
      DataService.update(SHEET(), NOMS_TAB(), 'NominationID', String(open[j].NominationID), { Priority: idx + 1 });
    }
    return myNominations({}, user, roles);
  }

  /**
   * The Proposed slate (super_admin + department_chair ONLY): the
   * nomination pool for the cycle's target year. OPEN (volunteered)
   * and ACCEPTED (confirmed — "Assigned" in the UI) only; DECLINED and
   * WITHDRAWN never appear. Includes each nominee's priority and note —
   * that content was written for the chair/admin, which is exactly why
   * this action's audience is restricted rather than its fields.
   */
  function proposedSlate(payload, user, roles) {
    _assertProposed(roles);
    const state = _nominationState();
    if (!state.targetYear) return { year: '', open: state.open, rows: [] };
    const catMap = _catalogMap();
    const rows = DataService.getAll(SHEET(), NOMS_TAB())
      .filter(r => String(r.Year || '').trim() === state.targetYear
        && (String(r.Status) === 'OPEN' || String(r.Status) === 'ACCEPTED'))
      .map(r => {
        const cat = catMap[String(r.CategoryKey || '').trim()] || null;
        const p = Auth.getProfile(r.PersonEmail);
        return {
          nominationId: r.NominationID,
          personEmail: String(r.PersonEmail || ''),
          name: p ? (p.name || p.email) : String(r.PersonEmail || ''),
          nameLastFirst: p ? (p.nameLastFirst || p.name || p.email) : String(r.PersonEmail || ''),
          categoryKey: String(r.CategoryKey || ''),
          categoryLabel: cat ? String(cat.Label) : String(r.CategoryKey || ''),
          isLeadership: cat ? _isTrue(cat.IsLeadership) : false,
          sortWeight: cat ? _numOr(cat.SortWeight, 100) : 100,
          role: String(r.Role || ''),
          quarter: String(r.Quarter || ''),
          priority: _numOr(r.Priority, 999),
          note: String(r.Note || ''),
          status: String(r.Status || 'OPEN'),
        };
      });
    return { year: state.targetYear, open: state.open, rows: rows };
  }


  // ============================================================
  // NOMINATIONS — window + decisions (super_admin only)
  // ============================================================

  /**
   * Opens (locking in the target year — payload.targetYear or next AY at
   * this moment) or closes the self-nomination window. Decisions work
   * regardless of window state; the window only gates faculty changes.
   */
  function setNominationWindow(payload, user, roles) {
    _assertAdmin(roles);
    payload = payload || {};
    if (payload.open === true) {
      const year = String(payload.targetYear || '').trim() || _nextYear();
      if (!_yearOk(year)) throw new Error('Target year must look like 2027-28.');
      _setSetting('NOMINATION_YEAR', year);
      _setSetting('NOMINATIONS_OPEN', 'TRUE');
    } else {
      _setSetting('NOMINATIONS_OPEN', 'FALSE');
    }
    return _nominationState();
  }

  function listNominations(payload, user, roles) {
    _assertAdmin(roles);
    const catMap = _catalogMap();
    return {
      state: _nominationState(),
      rows: DataService.getAll(SHEET(), NOMS_TAB())
        .map(r => _publicNomination(r, catMap, true))
        .sort((a, b) => String(b.year).localeCompare(String(a.year))
          || String(a.personName).localeCompare(String(b.personName))
          || (a.priority - b.priority)),
    };
  }

  /**
   * Accepts a nomination: creates the proposed assignment (nomination's
   * year/category; role/quarter overridable via payload) unless an
   * identical one already exists, and marks the nomination ACCEPTED.
   */
  function acceptNomination(payload, user, roles) {
    _assertAdmin(roles);
    payload = payload || {};
    const id = String(payload.nominationId || '').trim();
    const rows = DataService.query(SHEET(), NOMS_TAB(), 'NominationID', id);
    if (!rows.length) throw new Error('Nomination not found.');
    const nom = rows[0];
    if (String(nom.Status) !== 'OPEN') throw new Error('This nomination has already been decided or withdrawn.');

    const cat = _catalogMap()[String(nom.CategoryKey || '').trim()] || {};
    const rec = _validateAssignmentInput({
      personEmail: nom.PersonEmail,
      categoryKey: nom.CategoryKey,
      role: String((payload.role !== undefined ? payload.role : nom.Role) || '').trim()
        || String(cat.DefaultRole || 'Member'),
      year: nom.Year,
      quarter: payload.quarter !== undefined ? payload.quarter : nom.Quarter,
      notes: 'Accepted from self-nomination',
    });

    let created = false;
    let auto = [];
    const autoResolved = [];
    if (!_existingDupKeys()[_dupKey(rec.PersonEmail, rec.RawName, rec.CategoryKey, rec.Role, rec.Year, rec.Quarter)]) {
      rec.AssignmentID = DataService.generateId('SVASN');
      DataService.insert(SHEET(), ASSIGN_TAB(), rec);
      created = true;
      auto = _runAutoAssigns(rec, cat);

      // The person's own OPEN nominations for companion committees are
      // now moot (whether the companion was just created or already
      // existed) — auto-accept them with a provenance decision note so
      // they don't linger in the queue awaiting a confusing second
      // decision. Their nominators see status only, as always.
      const ruleKeys = _parseAutoAssigns(cat && cat.AutoAssigns).map(r => r.key);
      if (ruleKeys.length) {
        const catMapNow = _catalogMap();
        _myNominationRows(String(nom.PersonEmail), String(nom.Year))
          .filter(r => String(r.Status) === 'OPEN' && ruleKeys.indexOf(String(r.CategoryKey).trim()) !== -1)
          .forEach(r => {
            DataService.update(SHEET(), NOMS_TAB(), 'NominationID', String(r.NominationID), {
              Status: 'ACCEPTED',
              DecidedBy: user,
              DecidedAt: new Date().toISOString(),
              DecisionNote: 'Auto-accepted with ' + String((cat && cat.Label) || 'linked') + ' assignment',
            });
            const rc = catMapNow[String(r.CategoryKey).trim()];
            autoResolved.push(rc ? String(rc.Label) : String(r.CategoryKey));
          });
      }
    }

    DataService.update(SHEET(), NOMS_TAB(), 'NominationID', id, {
      Status: 'ACCEPTED',
      DecidedBy: user,
      DecidedAt: new Date().toISOString(),
      DecisionNote: String(payload.decisionNote || ''),
    });
    _renumberOpen(String(nom.PersonEmail), String(nom.Year));
    _syncGrantedRoles();
    return { nominationId: id, status: 'ACCEPTED', assignmentCreated: created,
             autoAssigned: auto, autoResolvedNominations: autoResolved };
  }

  /** Declines a nomination. The note is INTERNAL — never shown to the nominator. */
  function declineNomination(payload, user, roles) {
    _assertAdmin(roles);
    payload = payload || {};
    const id = String(payload.nominationId || '').trim();
    const rows = DataService.query(SHEET(), NOMS_TAB(), 'NominationID', id);
    if (!rows.length) throw new Error('Nomination not found.');
    if (String(rows[0].Status) !== 'OPEN') throw new Error('This nomination has already been decided or withdrawn.');

    DataService.update(SHEET(), NOMS_TAB(), 'NominationID', id, {
      Status: 'DECLINED',
      DecidedBy: user,
      DecidedAt: new Date().toISOString(),
      DecisionNote: String(payload.decisionNote || ''),
    });
    _renumberOpen(String(rows[0].PersonEmail), String(rows[0].Year));
    return { nominationId: id, status: 'DECLINED' };
  }


  // ============================================================
  // MANAGEMENT — catalog (super_admin only)
  // ============================================================

  function listCatalog(payload, user, roles) {
    _assertAdmin(roles);
    const usage = {};
    _assignmentRows().forEach(r => {
      const k = String(r.CategoryKey || '').trim();
      if (k) usage[k] = (usage[k] || 0) + 1;
    });
    return _catalogRows()
      .map(r => _publicCategory(r, usage))
      .sort((a, b) => (a.sortWeight - b.sortWeight) || String(a.label).localeCompare(String(b.label)));
  }

  /**
   * Creates or updates a catalog entry. On create, the key is slugged
   * from the label (or taken from payload.key) and is PERMANENT — updates
   * are keyed by it and may change every attribute except the key itself.
   */
  function upsertCategory(payload, user, roles) {
    _assertAdmin(roles);
    payload = payload || {};
    const label = String(payload.label || '').trim();
    if (!label) throw new Error('Enter a name for the service category.');

    const fields = {
      Label: label,
      Active: _bool(payload.active !== false),
      IsQuarterly: _bool(payload.isQuarterly === true),
      DefaultRole: String(payload.defaultRole || 'Member').trim() || 'Member',
      IsLeadership: _bool(payload.isLeadership === true),
      SortWeight: _numOr(payload.sortWeight, 100),
      NominationEligible: _bool(payload.nominationEligible !== false),
      Notes: String(payload.notes || ''),
    };

    const map = _catalogMap();
    const existingKey = String(payload.key || '').trim();

    // AutoAssigns: validate + normalize to canonical "key:Role" form.
    if (payload.autoAssigns !== undefined) {
      const rules = _parseAutoAssigns(payload.autoAssigns);
      const selfKey = existingKey || _slug(label);
      rules.forEach(rule => {
        if (!map[rule.key]) throw new Error('Auto-assign target not found: "' + rule.key + '". Use existing category names or keys.');
        if (rule.key === selfKey) throw new Error('A category cannot auto-assign to itself.');
      });
      fields.AutoAssigns = rules.map(r => r.key + (r.role ? ':' + r.role : '')).join(', ');
    }

    // GrantsRole: "role" or "role:members" — the role must already exist
    // in Admin → Roles (create it there first), and super_admin is never
    // grantable through committee membership.
    let grantsRoleTouched = false;
    if (payload.grantsRole !== undefined) {
      grantsRoleTouched = true;
      const g = _parseGrantsRole(payload.grantsRole);
      if (!g) {
        fields.GrantsRole = '';
      } else {
        if (!/^[a-z][a-z0-9_]*$/.test(g.role)) {
          throw new Error('Role names are lowercase letters, digits, and underscores (e.g. personnel_committee).');
        }
        if (g.role === 'super_admin') throw new Error('super_admin cannot be granted by a committee assignment.');
        const known = Auth.listRoles().map(r => String(r).trim().toLowerCase());
        if (known.indexOf(g.role) === -1) {
          throw new Error('Unknown role "' + g.role + '" — create it first in Admin → Roles, then set it here.');
        }
        fields.GrantsRole = g.role + (g.membersOnly ? ':members' : '');
      }
    }

    if (existingKey) {
      if (!map[existingKey]) throw new Error('Unknown category: ' + existingKey);
      DataService.update(SHEET(), CATALOG_TAB(), 'Key', existingKey, fields);
      const out = { key: existingKey, status: 'updated' };
      if (grantsRoleTouched) {
        const sync = _syncGrantedRoles();
        out.roleSync = { granted: sync.granted.length, revoked: sync.revoked.length };
      }
      return out;
    }

    const key = _slug(label);
    if (!key) throw new Error('The category name must contain letters or numbers.');
    if (map[key]) throw new Error('A category with this name already exists (' + map[key].Label + ').');

    fields.Key = key;
    DataService.insert(SHEET(), CATALOG_TAB(), fields);
    const out = { key: key, status: 'created' };
    if (grantsRoleTouched) {
      const sync = _syncGrantedRoles();
      out.roleSync = { granted: sync.granted.length, revoked: sync.revoked.length };
    }
    return out;
  }

  /**
   * Hard-removes a catalog entry ONLY when no assignment references it
   * (typo cleanup). Categories in use are deactivated instead, from the
   * same edit form.
   */
  function removeCategory(payload, user, roles) {
    _assertAdmin(roles);
    const key = String((payload || {}).key || '').trim();
    if (!key) throw new Error('Category not found.');
    const used = _assignmentRows().filter(r => String(r.CategoryKey || '').trim() === key).length;
    if (used > 0) {
      throw new Error('This category is referenced by ' + used + ' assignment(s). Deactivate it instead of deleting.');
    }
    const referrer = _catalogRows().find(c =>
      String(c.Key).trim() !== key &&
      _parseAutoAssigns(c.AutoAssigns).some(rule => rule.key === key));
    if (referrer) {
      throw new Error('This category is an auto-assign target of "' + referrer.Label + '". Remove it from that rule first.');
    }
    DataService.remove(SHEET(), CATALOG_TAB(), 'Key', key);
    return { key: key, deleted: true };
  }


  // ============================================================
  // MANAGEMENT — assignments (super_admin only)
  // ============================================================

  /**
   * Active profiles for the person picker: senate_faculty and lecturers
   * only (ASSIGNABLE_ROLES) — { email, name } sorted.
   */
  function listPeople(payload, user, roles) {
    _assertAdmin(roles);
    return Auth.listUsers()
      .filter(u => u.active && (u.roles || []).some(r => ASSIGNABLE_ROLES.indexOf(r) !== -1))
      .map(u => ({ email: u.email, name: u.nameLastFirst || u.name || u.email }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function addAssignment(payload, user, roles) {
    _assertAdmin(roles);
    const rec = _validateAssignmentInput(payload || {});
    if (_existingDupKeys()[_dupKey(rec.PersonEmail, rec.RawName, rec.CategoryKey, rec.Role, rec.Year, rec.Quarter)]) {
      throw new Error('An identical assignment (same person, category, role, year, and quarter) already exists.');
    }
    rec.AssignmentID = DataService.generateId('SVASN');
    DataService.insert(SHEET(), ASSIGN_TAB(), rec);
    const auto = _runAutoAssigns(rec, _catalogMap()[rec.CategoryKey]);
    _syncGrantedRoles();
    const pub = _publicAssignment(rec, _catalogMap());
    pub.autoAssigned = auto;
    return pub;
  }

  /**
   * Partial update. Notes are written ONLY when explicitly supplied
   * (platform convention). Setting personEmail clears RawName and vice
   * versa — a record is keyed by exactly one identity path.
   */
  function updateAssignment(payload, user, roles) {
    _assertAdmin(roles);
    payload = payload || {};
    const id = String(payload.assignmentId || '').trim();
    if (!id) throw new Error('Assignment not found.');
    const rows = DataService.query(SHEET(), ASSIGN_TAB(), 'AssignmentID', id);
    if (!rows.length) throw new Error('Assignment not found.');
    const current = rows[0];

    // Merge: validate the merged record, then write only supplied fields.
    const merged = {
      personEmail: payload.personEmail !== undefined ? payload.personEmail : current.PersonEmail,
      rawName:     payload.rawName     !== undefined ? payload.rawName     : current.RawName,
      categoryKey: payload.categoryKey !== undefined ? payload.categoryKey : current.CategoryKey,
      role:        payload.role        !== undefined ? payload.role        : current.Role,
      year:        payload.year        !== undefined ? payload.year        : current.Year,
      quarter:     payload.quarter     !== undefined ? payload.quarter     : current.Quarter,
      isAdHoc:     payload.isAdHoc     !== undefined ? payload.isAdHoc === true : _isTrue(current.IsAdHoc),
      notes:       payload.notes       !== undefined ? payload.notes       : current.Notes,
    };
    // Identity: if an email was supplied, it wins and clears RawName.
    if (payload.personEmail !== undefined && String(payload.personEmail).trim()) merged.rawName = '';
    const rec = _validateAssignmentInput(merged);

    const dupKey = _dupKey(rec.PersonEmail, rec.RawName, rec.CategoryKey, rec.Role, rec.Year, rec.Quarter);
    const clash = _assignmentRows().some(r =>
      String(r.AssignmentID) !== id &&
      _dupKey(r.PersonEmail, r.RawName, r.CategoryKey, r.Role, r.Year, r.Quarter) === dupKey);
    if (clash) throw new Error('An identical assignment already exists.');

    const fields = {
      PersonEmail: rec.PersonEmail, RawName: rec.RawName,
      CategoryKey: rec.CategoryKey, Role: rec.Role,
      Year: rec.Year, Quarter: rec.Quarter, IsAdHoc: rec.IsAdHoc,
    };
    if (payload.notes !== undefined) fields.Notes = rec.Notes;
    DataService.update(SHEET(), ASSIGN_TAB(), 'AssignmentID', id, fields);
    _syncGrantedRoles();

    rec.AssignmentID = id;
    return _publicAssignment(rec, _catalogMap());
  }

  function deleteAssignment(payload, user, roles) {
    _assertAdmin(roles);
    const id = String((payload || {}).assignmentId || '').trim();
    if (!id) throw new Error('Assignment not found.');
    const removed = DataService.remove(SHEET(), ASSIGN_TAB(), 'AssignmentID', id);
    if (!removed) throw new Error('Assignment not found.');
    _syncGrantedRoles();
    return { assignmentId: id, deleted: true };
  }

  /** Shared validation → a sheet-shaped record (without AssignmentID). */
  function _validateAssignmentInput(p) {
    const personEmail = String(p.personEmail || '').trim();
    const rawName = String(p.rawName || '').trim();
    if (personEmail) {
      if (!Auth.getProfile(personEmail)) throw new Error('No portal profile found for ' + personEmail + '.');
    } else if (!rawName) {
      throw new Error('Choose a person, or enter a name for someone without a portal profile.');
    }

    const categoryKey = String(p.categoryKey || '').trim();
    if (!categoryKey || !_catalogMap()[categoryKey]) throw new Error('Choose a service category.');

    const year = String(p.year || '').trim();
    if (!_yearOk(year)) throw new Error('Year must look like 2025-26.');

    const quarter = String(p.quarter || '').trim();
    if (!_quarterOk(quarter)) throw new Error('Quarter must be blank, AY, Fall, Winter, Spring, or a Fall/Winter-style combination.');

    return {
      PersonEmail: personEmail,
      RawName: personEmail ? '' : rawName,
      CategoryKey: categoryKey,
      Role: String(p.role || '').trim(),
      Year: year,
      Quarter: quarter,
      IsAdHoc: _bool(p.isAdHoc === true),
      Notes: String(p.notes || ''),
    };
  }


  // ============================================================
  // IMPORT — legacy CSV, preview then commit (super_admin only)
  // ============================================================
  // Expected headers (case/space-insensitive): First Name, Last Name,
  // Service Category, Role, Year, Quarter. Extra columns are ignored.

  function importPreview(payload, user, roles) {
    _assertAdmin(roles);
    const csvText = String((payload || {}).csvText || '');
    if (!csvText.trim()) throw new Error('Paste or upload the CSV first.');

    const grid = _parseCsv(csvText);
    if (grid.length < 2) throw new Error('The CSV needs a header row and at least one data row.');

    const headers = grid[0].map(h => _norm(h));
    const col = name => headers.indexOf(_norm(name));
    const iFirst = col('First Name'), iLast = col('Last Name'),
          iCat = col('Service Category'), iRole = col('Role'),
          iYear = col('Year'), iQtr = col('Quarter');
    if (iFirst === -1 || iLast === -1 || iCat === -1 || iYear === -1) {
      throw new Error('Missing required column(s). Expected headers: First Name, Last Name, Service Category, Year (plus optional Role, Quarter).');
    }

    const nameIndex = _nameIndex();
    const catMap = _catalogMap();
    const rows = [];
    const newCategoryLabels = {};
    let matched = 0, ambiguous = 0, unmatched = 0, badYears = 0, movedQuarters = 0;

    grid.slice(1).forEach(cells => {
      const cell = i => (i >= 0 && i < cells.length) ? String(cells[i]).trim() : '';
      const first = cell(iFirst), last = cell(iLast);
      const categoryLabel = cell(iCat);
      if (!first && !last && !categoryLabel) return;   // skip blank lines

      const row = {
        first: first, last: last,
        rawName: (first + ' ' + last).trim(),
        personEmail: '', matchedName: '',
        matchMethod: 'none', candidates: [],
        categoryLabel: categoryLabel,
        categoryKey: _slug(categoryLabel),
        knownCategory: false,
        role: cell(iRole),
        year: cell(iYear), yearOk: false,
        quarter: cell(iQtr), quarterMoved: '',
        include: true,
      };

      // Name match: exact profile name / AltNames, else last-name suggestions.
      const hit = _lookupName(nameIndex, first, last);
      row.candidates = hit.candidates;
      if (hit.match) {
        row.personEmail = hit.match.email;
        row.matchedName = hit.match.name;
        row.matchMethod = hit.method;
        matched++;
      } else if (hit.candidates.length > 1 && hit.method === 'ambiguous') {
        row.matchMethod = 'ambiguous'; ambiguous++;
      } else {
        row.matchMethod = 'none'; unmatched++;
      }

      // Category
      row.knownCategory = !!catMap[row.categoryKey];
      if (!row.knownCategory && categoryLabel) newCategoryLabels[row.categoryKey] = categoryLabel;

      // Year / quarter hygiene
      row.yearOk = _yearOk(row.year);
      if (!row.yearOk) badYears++;
      if (!_quarterOk(row.quarter)) {
        row.quarterMoved = row.quarter;   // shunted to Notes at commit
        row.quarter = '';
        movedQuarters++;
      }

      rows.push(row);
    });

    return {
      rows: rows,
      existingCount: _assignmentRows().length,
      summary: {
        total: rows.length, matched: matched, ambiguous: ambiguous, unmatched: unmatched,
        badYears: badYears, movedQuarters: movedQuarters,
        newCategories: Object.keys(newCategoryLabels).map(k => newCategoryLabels[k]).sort(),
      },
    };
  }

  /**
   * Binds an unmatched import spelling to a chosen profile by attaching
   * it as an AltName (kind: 'import'), so this and every future import
   * matches it. Nothing is committed — the client updates its preview.
   */
  function resolveImportName(payload, user, roles) {
    _assertAdmin(roles);
    payload = payload || {};
    const first = String(payload.first || '').trim();
    const last = String(payload.last || '').trim();
    const email = String(payload.email || '').trim();
    if (!first && !last) throw new Error('No name to resolve.');
    if (!email) throw new Error('Choose a person to link this name to.');
    const profile = Auth.getProfile(email);
    if (!profile) throw new Error('No profile found for ' + email + '.');

    Auth.attachAltName(email, { kind: 'import', first: first, last: last, source: 'service import' });
    return { email: profile.email, name: profile.nameLastFirst || profile.name || profile.email };
  }

  /**
   * Commits previewed rows. Server-side revalidation throughout — client
   * flags are advisory only. Appends (never replaces); exact duplicates
   * against existing rows and within the batch are skipped with reasons,
   * as are rows with invalid years or unknown-empty categories. Unknown
   * categories are auto-created (inactive attributes at defaults, for
   * staff to tune afterward). Requires acknowledgeExisting when the
   * assignments tab already has rows.
   */
  function importCommit(payload, user, roles) {
    _assertAdmin(roles);
    payload = payload || {};
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (!rows.length) throw new Error('There are no rows to import.');

    const existingCount = _assignmentRows().length;
    if (existingCount > 0 && payload.acknowledgeExisting !== true) {
      throw new Error('The service record already has ' + existingCount +
        ' assignment(s). Confirm that this import should APPEND to them.');
    }

    const catMap = _catalogMap();
    const dupKeys = _existingDupKeys();
    const createdCategories = [];
    const skipped = [];
    let inserted = 0, withProfile = 0, rawOnly = 0;

    rows.forEach((r, idx) => {
      r = r || {};
      if (r.include === false) { skipped.push({ row: idx + 1, reason: 'Excluded in preview' }); return; }

      const year = String(r.year || '').trim();
      if (!_yearOk(year)) { skipped.push({ row: idx + 1, reason: 'Invalid year "' + year + '"' }); return; }

      const categoryLabel = String(r.categoryLabel || '').trim();
      const categoryKey = _slug(categoryLabel);
      if (!categoryKey) { skipped.push({ row: idx + 1, reason: 'Missing service category' }); return; }

      if (!catMap[categoryKey]) {
        DataService.insert(SHEET(), CATALOG_TAB(), {
          Key: categoryKey, Label: categoryLabel,
          Active: 'TRUE', IsQuarterly: 'FALSE', DefaultRole: 'Member',
          IsLeadership: 'FALSE', SortWeight: 100, NominationEligible: 'TRUE',
          Notes: 'Created by service import',
        });
        catMap[categoryKey] = { Key: categoryKey, Label: categoryLabel };
        createdCategories.push(categoryLabel);
      }

      // Identity: honor a claimed email only if the profile really exists.
      let personEmail = String(r.personEmail || '').trim();
      if (personEmail && !Auth.getProfile(personEmail)) personEmail = '';
      const rawName = personEmail ? '' : String(r.rawName || ((r.first || '') + ' ' + (r.last || ''))).trim();
      if (!personEmail && !rawName) { skipped.push({ row: idx + 1, reason: 'Missing person' }); return; }

      // Quarter hygiene (re-checked server-side)
      let quarter = String(r.quarter || '').trim();
      let notes = '';
      if (!_quarterOk(quarter)) { notes = 'Imported quarter value: "' + quarter + '"'; quarter = ''; }
      else if (String(r.quarterMoved || '').trim()) { notes = 'Imported quarter value: "' + String(r.quarterMoved).trim() + '"'; }

      const role = String(r.role || '').trim();
      const key = _dupKey(personEmail, rawName, categoryKey, role, year, quarter);
      if (dupKeys[key]) { skipped.push({ row: idx + 1, reason: 'Duplicate of an existing assignment' }); return; }
      dupKeys[key] = true;

      DataService.insert(SHEET(), ASSIGN_TAB(), {
        AssignmentID: DataService.generateId('SVASN'),
        PersonEmail: personEmail,
        RawName: rawName,
        CategoryKey: categoryKey,
        Role: role,
        Year: year,
        Quarter: quarter,
        Notes: notes,
      });
      inserted++;
      if (personEmail) withProfile++; else rawOnly++;
    });

    if (inserted > 0) _syncGrantedRoles();
    return {
      inserted: inserted,
      withProfile: withProfile,
      rawNameOnly: rawOnly,
      skipped: skipped,
      createdCategories: createdCategories,
      appendedToExisting: existingCount > 0,
    };
  }


  // ============================================================
  // IMPORT — legacy self-nominations, preview then commit (super_admin)
  // ============================================================
  // Expected headers (case/space-insensitive): Year, First Name,
  // Last Name, Service Category, plus optional Role, Quarter, Notes.
  // The legacy form was checkbox-style (no ranking), so priorities are
  // assigned per person in CSV row order. Nominations are PersonEmail-
  // only by design: rows that cannot be matched to a profile are
  // SKIPPED at commit (the preview's Link control attaches an AltName
  // to fix a spelling). Imported rows land OPEN — a live queue for the
  // super admin to accept (creating the year's assignments) or decline.

  function importNominationsPreview(payload, user, roles) {
    _assertAdmin(roles);
    const csvText = String((payload || {}).csvText || '');
    if (!csvText.trim()) throw new Error('Paste or upload the CSV first.');

    const grid = _parseCsv(csvText);
    if (grid.length < 2) throw new Error('The CSV needs a header row and at least one data row.');

    const headers = grid[0].map(h => _norm(h));
    const col = name => headers.indexOf(_norm(name));
    const iYear = col('Year'), iFirst = col('First Name'), iLast = col('Last Name'),
          iCat = col('Service Category'), iRole = col('Role'),
          iQtr = col('Quarter'), iNote = col('Notes');
    if (iYear === -1 || iFirst === -1 || iLast === -1 || iCat === -1) {
      throw new Error('Missing required column(s). Expected headers: Year, First Name, Last Name, Service Category (plus optional Role, Quarter, Notes).');
    }

    const nameIndex = _nameIndex();
    const catMap = _catalogMap();
    const rows = [];
    const newCategoryLabels = {};
    let matched = 0, ambiguous = 0, unmatched = 0, badYears = 0, movedQuarters = 0;

    grid.slice(1).forEach(cells => {
      const cell = i => (i >= 0 && i < cells.length) ? String(cells[i]).trim() : '';
      const first = cell(iFirst), last = cell(iLast);
      const categoryLabel = cell(iCat);
      if (!first && !last && !categoryLabel) return;   // blank line

      const row = {
        first: first, last: last,
        rawName: (first + ' ' + last).trim(),
        personEmail: '', matchedName: '',
        matchMethod: 'none', candidates: [],
        categoryLabel: categoryLabel,
        categoryKey: _slug(categoryLabel),
        knownCategory: false,
        role: cell(iRole),
        year: cell(iYear), yearOk: false,
        quarter: _normalizeQuarter(cell(iQtr)), quarterMoved: '',
        note: String(cell(iNote) || '').trim(),
        include: true,
      };

      const hit = _lookupName(nameIndex, first, last);
      row.candidates = hit.candidates;
      if (hit.match) {
        row.personEmail = hit.match.email;
        row.matchedName = hit.match.name;
        row.matchMethod = hit.method;
        matched++;
      } else if (hit.candidates.length > 1 && hit.method === 'ambiguous') {
        row.matchMethod = 'ambiguous'; ambiguous++;
      } else {
        row.matchMethod = 'none'; unmatched++;
      }

      row.knownCategory = !!catMap[row.categoryKey];
      if (!row.knownCategory && categoryLabel) newCategoryLabels[row.categoryKey] = categoryLabel;

      row.yearOk = _yearOk(row.year);
      if (!row.yearOk) badYears++;
      if (!_quarterOk(row.quarter)) {
        row.quarterMoved = row.quarter;
        row.quarter = '';
        movedQuarters++;
      }

      rows.push(row);
    });

    return {
      rows: rows,
      windowState: _nominationState(),
      existingCount: DataService.getAll(SHEET(), NOMS_TAB()).length,
      summary: {
        total: rows.length, matched: matched, ambiguous: ambiguous, unmatched: unmatched,
        badYears: badYears, movedQuarters: movedQuarters,
        newCategories: Object.keys(newCategoryLabels).map(k => newCategoryLabels[k]).sort(),
      },
    };
  }

  /**
   * Commits previewed nomination rows (server-side revalidation, client
   * flags advisory). Skips: excluded rows, invalid years, rows without a
   * matched profile, and duplicates (an existing non-withdrawn nomination
   * for the same person+category+year, or a repeat within the batch).
   * Unknown categories are auto-created. Priorities continue each
   * person's existing OPEN count for that year, in CSV row order.
   * Afterward, if the nomination window is CLOSED, its target year is
   * set to the latest committed year so faculty see their imported
   * preferences (read-only) on the Nominate tab; an OPEN window is
   * never touched.
   */
  function importNominationsCommit(payload, user, roles) {
    _assertAdmin(roles);
    payload = payload || {};
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (!rows.length) throw new Error('There are no rows to import.');

    const catMap = _catalogMap();
    const existing = DataService.getAll(SHEET(), NOMS_TAB());
    const dupKeys = {};   // email|categoryKey|year for non-withdrawn nominations
    existing.forEach(r => {
      if (String(r.Status) !== 'WITHDRAWN') {
        dupKeys[_normEmail(r.PersonEmail) + '|' + String(r.CategoryKey).trim() + '|' + String(r.Year).trim()] = true;
      }
    });
    const openCounts = {};   // email|year -> running OPEN count for priority
    existing.forEach(r => {
      if (String(r.Status) === 'OPEN') {
        const k = _normEmail(r.PersonEmail) + '|' + String(r.Year).trim();
        openCounts[k] = (openCounts[k] || 0) + 1;
      }
    });

    const createdCategories = [];
    const skipped = [];
    let inserted = 0;
    let latestYear = '';

    rows.forEach((r, idx) => {
      r = r || {};
      if (r.include === false) { skipped.push({ row: idx + 1, reason: 'Excluded in preview' }); return; }

      const year = String(r.year || '').trim();
      if (!_yearOk(year)) { skipped.push({ row: idx + 1, reason: 'Invalid year "' + year + '"' }); return; }

      const categoryLabel = String(r.categoryLabel || '').trim();
      const categoryKey = _slug(categoryLabel);
      if (!categoryKey) { skipped.push({ row: idx + 1, reason: 'Missing service category' }); return; }

      // Nominations require a real profile — no RawName path.
      const personEmail = String(r.personEmail || '').trim();
      if (!personEmail || !Auth.getProfile(personEmail)) {
        skipped.push({ row: idx + 1, reason: 'No portal profile for "' + String(r.rawName || '').trim() + '" — nominations require one' });
        return;
      }

      const dupKey = _normEmail(personEmail) + '|' + categoryKey + '|' + year;
      if (dupKeys[dupKey]) { skipped.push({ row: idx + 1, reason: 'Duplicate nomination (same person, category, and year)' }); return; }
      dupKeys[dupKey] = true;

      if (!catMap[categoryKey]) {
        DataService.insert(SHEET(), CATALOG_TAB(), {
          Key: categoryKey, Label: categoryLabel,
          Active: 'TRUE', IsQuarterly: 'FALSE', DefaultRole: 'Member',
          IsLeadership: 'FALSE', SortWeight: 100, NominationEligible: 'TRUE',
          Notes: 'Created by nominations import',
        });
        catMap[categoryKey] = { Key: categoryKey, Label: categoryLabel };
        createdCategories.push(categoryLabel);
      }

      let quarter = _normalizeQuarter(r.quarter);
      let note = String(r.note || '').trim();
      if (!_quarterOk(quarter)) {
        note = (note ? note + ' — ' : '') + 'Imported quarter value: "' + quarter + '"';
        quarter = '';
      }

      const pk = _normEmail(personEmail) + '|' + year;
      openCounts[pk] = (openCounts[pk] || 0) + 1;

      DataService.insert(SHEET(), NOMS_TAB(), {
        NominationID: DataService.generateId('SVNOM'),
        PersonEmail: personEmail,
        Year: year,
        CategoryKey: categoryKey,
        Role: String(r.role || '').trim(),
        Quarter: quarter,
        Priority: openCounts[pk],
        Note: note,
        Status: 'OPEN',
      });
      inserted++;
      if (year > latestYear) latestYear = year;
    });

    // Point the (closed) window at the imported year so faculty see their
    // preferences on the Nominate tab. Never touch an OPEN window.
    let targetYearSet = '';
    const state = _nominationState();
    if (inserted > 0 && !state.open && latestYear) {
      _setSetting('NOMINATION_YEAR', latestYear);
      targetYearSet = latestYear;
    }

    return {
      inserted: inserted,
      skipped: skipped,
      createdCategories: createdCategories,
      targetYearSet: targetYearSet,
      windowState: _nominationState(),
    };
  }


  // ── Import internals — name matching ────────────────────────

  /**
   * normalized-name → [profiles]. Indexes preferred names both ways
   * ("first last" and "last first") plus every AltName entry, which may
   * be an object ({first,last}) or a raw string (possibly "Last, First").
   */
  function _nameIndex() {
    const byName = {};
    const byLast = {};
    const add = (k, p) => { if (k) (byName[k] = byName[k] || []).push(p); };

    Auth.listUsers().forEach(u => {
      const p = { email: u.email, name: u.nameLastFirst || u.name || u.email, active: u.active };
      add(_norm((u.firstName || '') + ' ' + (u.lastName || '')), p);
      add(_norm((u.lastName || '') + ' ' + (u.firstName || '')), p);
      const lastKey = _norm(u.lastName);
      if (lastKey) (byLast[lastKey] = byLast[lastKey] || []).push(p);

      (u.altNames || []).forEach(a => {
        if (a && typeof a === 'object') {
          add(_norm((a.first || '') + ' ' + (a.last || '')), p);
          add(_norm((a.last || '') + ' ' + (a.first || '')), p);
        } else if (a) {
          const s = String(a);
          add(_norm(s), p);
          const parts = s.split(',');
          if (parts.length === 2) add(_norm(parts[1] + ' ' + parts[0]), p);
        }
      });
    });
    return { byName: byName, byLast: byLast };
  }

  function _lookupName(index, first, last) {
    const key = _norm(first + ' ' + last);
    const seen = {};
    const cands = (index.byName[key] || []).filter(p => {
      if (seen[p.email]) return false;
      seen[p.email] = true;
      return true;
    });
    if (cands.length === 1) return { match: cands[0], method: 'name', candidates: cands };
    if (cands.length > 1)  return { match: null, method: 'ambiguous', candidates: cands };

    // No direct hit: suggest profiles sharing the last name.
    const lastSeen = {};
    const suggestions = (index.byLast[_norm(last)] || []).filter(p => {
      if (lastSeen[p.email]) return false;
      lastSeen[p.email] = true;
      return true;
    });
    return { match: null, method: 'none', candidates: suggestions };
  }

  /** Minimal RFC-4180 CSV parser (quotes, embedded commas/newlines). */
  function _parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') {
        inQ = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || String(row[0]).trim() !== '') rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) {
      row.push(field);
      if (row.length > 1 || String(row[0]).trim() !== '') rows.push(row);
    }
    return rows;
  }


  // Only these names are dispatchable.
  return {
    // everyone in the module
    bootstrap, currentAssignments, proposedSlate, myHistory, fullHistory, submitCorrection,
    myNominations, submitNomination, withdrawNomination, moveNomination,
    // super_admin only
    listCorrections, resolveCorrection,
    setNominationWindow, listNominations, acceptNomination, declineNomination,
    listCatalog, upsertCategory, removeCategory,
    listPeople, addAssignment, updateAssignment, deleteAssignment, reapplyAutoAssigns,
    importPreview, resolveImportName, importCommit,
    importNominationsPreview, importNominationsCommit,
  };

})();


/* ============================================================
 * CONFIG / SETUP additions — applied separately to Config.gs and
 * Setup.gs (deliberate paste-in patches; this file does not create
 * them). Reproduced here so the module documents its own storage
 * contract, same as ClassSchedule.
 *
 * Config.gs — CONFIG.SHEETS: add (leave blank; setUp creates + logs id)
 *     SERVICE: '',   // Tabs: ServiceCatalog, ServiceAssignments, ServiceCorrections
 *
 * Config.gs — CONFIG.TABS: add
 *     SERVICE_CATALOG:     'ServiceCatalog',
 *     SERVICE_ASSIGNMENTS: 'ServiceAssignments',
 *     SERVICE_CORRECTIONS: 'ServiceCorrections',
 *     SERVICE_NOMINATIONS: 'ServiceNominations',
 *     SERVICE_SETTINGS:    'ServiceSettings',
 *   (Phase 2 tabs: full SETUP_SCHEMA blocks live in Setup.gs — see the
 *    SERVICE_NOMINATIONS and SERVICE_SETTINGS entries there.)
 *
 * Setup.gs — SETUP_SCHEMA: add
 *     SERVICE_CATALOG: {
 *       tab: 'ServiceCatalog',
 *       headers: ['Key', 'Label', 'Active', 'IsQuarterly', 'DefaultRole',
 *                 'IsLeadership', 'SortWeight', 'NominationEligible', 'Notes',
 *                 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
 *       seed: [],
 *     },
 *     SERVICE_ASSIGNMENTS: {
 *       tab: 'ServiceAssignments',
 *       headers: ['AssignmentID', 'PersonEmail', 'RawName', 'CategoryKey',
 *                 'Role', 'Year', 'Quarter', 'Notes',
 *                 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
 *       seed: [],
 *     },
 *     SERVICE_CORRECTIONS: {
 *       tab: 'ServiceCorrections',
 *       headers: ['CorrectionID', 'PersonEmail', 'Year', 'CategoryKey',
 *                 'CategoryLabel', 'Role', 'Quarter', 'Note', 'Status',
 *                 'ResolvedBy', 'ResolvedAt', 'ResolutionNote',
 *                 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
 *       seed: [],
 *     },
 *
 * Setup.gs — setUp(): resolve the spreadsheet and create its tabs
 *     const serviceSS = _resolveSpreadsheet(
 *       CONFIG.SHEETS.SERVICE, 'Portal Department Service', 'SERVICE');
 *     _setupTab(serviceSS, SETUP_SCHEMA.SERVICE_CATALOG);
 *     _setupTab(serviceSS, SETUP_SCHEMA.SERVICE_ASSIGNMENTS);
 *     _setupTab(serviceSS, SETUP_SCHEMA.SERVICE_CORRECTIONS);
 *     _tidyDefaultSheet(serviceSS);
 *
 * Setup.gs — _schemaPlacement(): add
 *     { sheetKey: 'SERVICE', def: SETUP_SCHEMA.SERVICE_CATALOG },
 *     { sheetKey: 'SERVICE', def: SETUP_SCHEMA.SERVICE_ASSIGNMENTS },
 *     { sheetKey: 'SERVICE', def: SETUP_SCHEMA.SERVICE_CORRECTIONS },
 *
 * Setup.gs — checkSetup() (optional): add
 *     ['SERVICE', CONFIG.SHEETS.SERVICE,
 *      [SETUP_SCHEMA.SERVICE_CATALOG.tab, SETUP_SCHEMA.SERVICE_ASSIGNMENTS.tab,
 *       SETUP_SCHEMA.SERVICE_CORRECTIONS.tab]],
 * ============================================================ */