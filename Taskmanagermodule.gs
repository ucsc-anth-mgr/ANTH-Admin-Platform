// ============================================================
// Taskmanagermodule.gs — Task Manager (super_admin queue viewer)
// ============================================================
// Read-only inspection of any user's open task queue, exactly as
// their dashboard shows it. Built on Tasks.forUser(email, roles) —
// the same call the dashboard's doGet/getMyTasks path runs — so the
// admin view matches what the person sees BY CONSTRUCTION, including
// shared-pool tasks they receive via roles, with the same urgency
// ordering (overdue → due_soon → stale → normal).
//
// This is NOT portal impersonation. Nothing about the target is
// touched, no task is resolved or reassigned, and every view lands
// in the platform audit log via dispatch like any other action.
//
// Access: super_admin only, three ways —
//   1. The module's registry row (Admin → Modules) lists super_admin.
//   2. The ACTIONS map declares every action [] (= super_admin only),
//      the ActionPolicy floor once enforcement is on.
//   3. _assertSuperAdmin() at the top of every action — the in-handler
//      check that holds today while ActionPolicy runs in shadow mode.
//
// Deep-link contract: the UI (task_manager.html) consumes
// window.__focus at init — a focus of { sourceType: 'user',
// sourceId: <email> } pre-selects that person and loads their queue.
// Both entry paths produce it: the Admin roster's "Tasks" link calls
// App.loadModule('task_manager', {...}), and a URL of
// ?page=task_manager&focus=<email> arrives through doGet.
//
// Registration reminder (the usual two-place rule): TaskManagerModule
// must be added to BOTH getModuleHandler() and getRegisteredHandlers()
// in Code.gs, and ONLY once this file is saved in the project. The
// Modules sheet row is then created via Admin → Modules (key:
// task_manager — permanent; UI file: task_manager; roles: super_admin).
// ============================================================

const TaskManagerModule = (() => {

  // ── ActionPolicy floor (see ActionPolicy.gs) ───────────────
  // [] = super_admin only. Missing entries would default-deny to the
  // same thing, but declaring them keeps the coverage report clean.
  const ACTIONS = {
    listTargets:   [],
    viewUserTasks: [],
  };

  // ── Per-action gate (in force today, shadow mode or not) ───
  function _assertSuperAdmin(roles) {
    if (!(roles || []).includes('super_admin')) {
      throw new Error('Only super admins may use the Task Manager.');
    }
  }

  // ── Action: the picker's user list ─────────────────────────
  // Active profiles only — the people who can log in and therefore
  // have a dashboard to mirror. Shaped for the search+dropdown picker;
  // roles ride along so the client can show why pool tasks apply.
  function listTargets(p, user, roles) {
    _assertSuperAdmin(roles);
    return Auth.listUsers()
      .filter(function (u) { return u.active; })
      .map(function (u) {
        return {
          email:      u.email,
          name:       u.nameLastFirst || u.name || u.email,
          roles:      u.roles || [],
          studentId:  u.studentId  || '',
          employeeId: u.employeeId || '',
        };
      })
      .sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name));
      });
  }

  // ── Action: one user's queue, dashboard-faithful ───────────
  // Roles come from Auth.getRoles(email) — the SAME resolution the
  // login path uses (super-admin override, inactive → default role) —
  // so the returned queue is what that person's dashboard would show
  // if they logged in right now. Read-only: one sheet read inside
  // Tasks.forUser, no writes anywhere.
  function viewUserTasks(p, user, roles) {
    _assertSuperAdmin(roles);
    const email = String((p && p.email) || '').trim();
    if (!email) throw new Error('Target email is required.');

    const profile     = Auth.getProfile(email);
    const targetRoles = Auth.getRoles(email);
    const tasks       = Tasks.forUser(email, targetRoles).map(_serializable);

    return {
      target: {
        email:  email,
        name:   profile ? (profile.nameLastFirst || profile.name || email) : email,
        roles:  targetRoles,
        active: profile ? !!profile.active : false,
        known:  !!profile,   // false = no platform profile (deep link typo etc.)
      },
      tasks: tasks,   // Tasks.forUser order preserved — do not re-sort
    };
  }

  // ── Serialization guard ────────────────────────────────────
  // The Tasks tab is read via getValues(), so date cells surface as
  // Date objects — which google.script.run cannot serialize. Map the
  // date-ish fields to strings before the payload crosses the
  // client-server boundary. Field-by-field (not JSON round-trip) so
  // the array order from Tasks.forUser is untouched.
  function _serializable(t) {
    return {
      taskId:         String(t.taskId       || ''),
      module:         String(t.module       || ''),
      sourceType:     String(t.sourceType   || ''),
      sourceId:       String(t.sourceId     || ''),
      label:          String(t.label        || ''),
      assignedTo:     String(t.assignedTo   || ''),
      assignedRole:   String(t.assignedRole || ''),
      status:         String(t.status       || ''),
      urgency:        String(t.urgency      || ''),
      note:           String(t.note         || ''),
      dueAt:          _dateStr(t.dueAt),
      staleAfterDays: (t.staleAfterDays === '' || t.staleAfterDays == null)
                        ? '' : Number(t.staleAfterDays),
      lastActivityAt: _dateStr(t.lastActivityAt),
      createdAt:      _dateStr(t.createdAt),
    };
  }

  function _dateStr(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date) {
      return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    }
    return String(v);
  }

  return {
    ACTIONS:       ACTIONS,
    listTargets:   listTargets,
    viewUserTasks: viewUserTasks,
  };

})();
