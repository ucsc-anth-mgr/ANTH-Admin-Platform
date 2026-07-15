// ============================================================
// UserManagerModule.gs — User Management (individual + batch)
// ============================================================
// One delegatable module for getting people into the system:
//   - People tab: list, add, and edit individual users
//   - Batch import tab: CSV import (engine in BatchImport.gs)
// Designated roles (e.g. staff) get this WITHOUT access to the Admin
// module (Module Manager, Roles, Audit).
//
// Permission model (two layers, same pattern as the Import module):
//   1. The module's access list (Modules sheet) controls who sees it.
//   2. The ImportPolicy mapping (Admin → Roles → "Import permissions")
//      controls WHICH roles a manager may assign — shared with batch
//      import so there is one assignable-roles policy, not two.
//
// Escalation guards (non-super_admins):
//   - May only assign roles within their allowlist.
//   - May only edit users whose existing roles are all within their
//     allowlist (so they can't modify admins/staff above them).
//   - super_admin accounts are never editable here.
// ============================================================

const UserManagerModule = (() => {

  // ── Tab manifest (TabRegistry) ─────────────────────────────
  // Declares this module's tabs for per-role visibility, edited in
  // Admin → Modules → Tabs. roles ['*'] = anyone the module admits.
  // Tab visibility is presentation only: every action here is ALSO
  // gated server-side by the ImportPolicy _assertManager check.
  // options() is the shared bootstrap loader and stays unlisted.
  const TABS = [
    { key: 'people',   label: 'People',       icon: 'ti-users',       roles: ['*'],
      actions: ['listUsers', 'setActive'] },
    { key: 'add',      label: 'Add / edit',   icon: 'ti-user-plus',   roles: ['*'],
      actions: ['upsertUser'] },
    { key: 'requests', label: 'Requests',     icon: 'ti-inbox',       roles: ['*'],
      actions: ['listRequests', 'approveRequest', 'rejectRequest'] },
    { key: 'batch',    label: 'Batch import', icon: 'ti-file-upload', roles: ['*'],
      actions: ['detectColumns', 'previewImport', 'commitImport'] },
  ];


  // ── Action: bootstrap for the forms ────────────────────────
  function options(p, user, roles) {
    _assertManager(roles);
    const assignable = ImportPolicy.assignableFor(roles);
    // Default ID type per role for the batch-import tab: roles
    // containing 'student' default to student IDs, else employee IDs.
    const idTypeDefaults = {};
    assignable.forEach(r => {
      idTypeDefaults[r] = (r.indexOf('student') !== -1) ? 'student' : 'employee';
    });
    return { assignable: assignable, idTypeDefaults: idTypeDefaults };
  }


  // ── Action: deactivate / reactivate one user ───────────────
  function setActive(p, user, roles) {
    _assertManager(roles);
    if (!p.email) throw new Error('Email is required.');
    const target = Auth.getProfile(p.email);
    if (!target) throw new Error('No profile for ' + p.email);
    if (target.roles.includes('super_admin')) {
      throw new Error('Super-admin accounts cannot be deactivated here.');
    }
    if (p.active === false && p.email.toLowerCase() === String(user).toLowerCase()) {
      throw new Error('You cannot deactivate yourself.');
    }
    if (!roles.includes('super_admin')) {
      const allowed = ImportPolicy.assignableFor(roles);
      const outside = target.roles.filter(r => allowed.indexOf(r) === -1);
      if (outside.length) {
        throw new Error('You are not permitted to modify this user (role: ' + outside.join(', ') + ').');
      }
    }
    Auth.upsertUser({
      email: target.email, firstName: target.firstName, lastName: target.lastName,
      roles: target.roles,
      studentId: target.studentId, employeeId: target.employeeId,
      active: p.active !== false,
      notes: target.notes,
    });
    return { status: p.active !== false ? 'reactivated' : 'deactivated', email: target.email };
  }


  // ── Actions: access requests (scoped by the allowlist) ─────
  // A manager sees only requests whose requested role is within their
  // assignable allowlist (or blank). super_admin sees all.
  function listRequests(p, user, roles) {
    _assertManager(roles);
    return _visibleRequests(roles);
  }

  function approveRequest(p, user, roles) {
    _assertManager(roles);
    if (!roles.includes('super_admin')) {
      if (!_visibleRequests(roles).some(r => r.requestId === p.requestId)) {
        throw new Error('You are not permitted to decide this request.');
      }
      const allowed = ImportPolicy.assignableFor(roles);
      const granting = Array.isArray(p.roles) ? p.roles : [p.roles].filter(Boolean);
      const bad = granting.filter(r => allowed.indexOf(r) === -1);
      if (bad.length) throw new Error('You are not permitted to grant: ' + bad.join(', '));
    }
    return RequestManager.approve(p, user);
  }

  function rejectRequest(p, user, roles) {
    _assertManager(roles);
    if (!roles.includes('super_admin')) {
      if (!_visibleRequests(roles).some(r => r.requestId === p.requestId)) {
        throw new Error('You are not permitted to decide this request.');
      }
    }
    return RequestManager.reject(p, user);
  }

  function _visibleRequests(roles) {
    const pending = RequestManager.listPending();
    if (roles.includes('super_admin')) return pending;
    const allowed = ImportPolicy.assignableFor(roles);
    return pending.filter(r => {
      const req = String(r.requestedRole || '').trim().toLowerCase();
      return !req || allowed.indexOf(req) !== -1;
    });
  }


  // ── Actions: batch import (engine lives in BatchImport) ────
  function detectColumns(p, user, roles) { return BatchImport.detectColumns(p, user, roles); }
  function previewImport(p, user, roles) { return BatchImport.preview(p, user, roles); }
  function commitImport(p, user, roles)  { return BatchImport.commit(p, user, roles); }


  // ── Action: list users (with per-row editability) ──────────
  function listUsers(p, user, roles) {
    _assertManager(roles);
    const isSuper = roles.includes('super_admin');
    const allowed = ImportPolicy.assignableFor(roles);
    return Auth.listUsers().map(u => {
      const editable = isSuper
        || (!u.roles.includes('super_admin')
            && u.roles.every(r => allowed.indexOf(r) !== -1));
      return {
        email: u.email,
        firstName: u.firstName, lastName: u.lastName,
        name: u.name, nameLastFirst: u.nameLastFirst,
        roles: u.roles,
        studentId: u.studentId, employeeId: u.employeeId,
        active: u.active, notes: u.notes,
        editable: editable,
      };
    });
  }


  // ── Action: add or edit one user ───────────────────────────
  function upsertUser(p, user, roles) {
    _assertManager(roles);
    if (!p.email) throw new Error('Email is required.');
    const newRoles = Array.isArray(p.roles) ? p.roles : [p.roles].filter(Boolean);

    if (!roles.includes('super_admin')) {
      const allowed = ImportPolicy.assignableFor(roles);

      // May only assign roles within the allowlist
      const notAllowed = newRoles.filter(r => allowed.indexOf(r) === -1);
      if (notAllowed.length) {
        throw new Error('You are not permitted to assign: ' + notAllowed.join(', '));
      }

      // May only edit users entirely within the allowlist; never super_admins
      const existing = Auth.getProfile(p.email);
      if (existing) {
        if (existing.roles.includes('super_admin')) {
          throw new Error('Super-admin accounts cannot be edited here.');
        }
        const outside = existing.roles.filter(r => allowed.indexOf(r) === -1);
        if (outside.length) {
          throw new Error('You are not permitted to edit this user (role: ' + outside.join(', ') + ').');
        }
      }
    }

    return Auth.upsertUser({
      email:    p.email,
      firstName: p.firstName,
      lastName:  p.lastName,
      roles:    newRoles,
      studentId:  p.studentId,
      employeeId: p.employeeId,
      active:   p.active,
      notes:    p.notes,
    });
  }


  // ── Private ────────────────────────────────────────────────
  function _assertManager(roles) {
    if (roles.includes('super_admin')) return;
    if (!ImportPolicy.canImport(roles)) {
      throw new Error('You do not have permission to manage users. '
        + 'A super admin can grant it under Admin → Roles → Import permissions.');
    }
  }

  return { TABS: TABS,
           options, listUsers, upsertUser, setActive,
           listRequests, approveRequest, rejectRequest,
           detectColumns, previewImport, commitImport };

})();