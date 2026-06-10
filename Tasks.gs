// ============================================================
// Tasks.gs — Platform "needs attention" queue
// ============================================================
// A lightweight queue of work items that need a human's attention:
// a thesis awaiting an advisor's review, a request awaiting approval,
// a flagged import conflict awaiting resolution. Surfaced to a user at
// login ("you have N things to look at").
//
// DESIGN — a task is a POINTER, not a state engine:
//   A task row holds ROUTING (who's responsible) and a BACK-REFERENCE
//   (which module + which record), never business data. The module's
//   own sheet remains the single source of truth for the underlying
//   record's state. Because the task carries no domain data, it can
//   never drift out of sync with the record it points at — there is
//   nothing to keep in sync. When the module's record reaches a
//   terminal state, the module resolves the task. The queue never
//   becomes a competing source of truth.
//
// ASSIGNMENT — almost always a specific user:
//   AssignedTo (an email) is the normal case: the one person who must
//   act (e.g. the chosen thesis sponsor). Role is used only as an
//   ELIGIBILITY FILTER at the module's UI, before the task exists, and
//   does not appear here. AssignedRole (a role key) is the RARE
//   shared-pool case — "any holder of role X may clear this" — reserved
//   for genuinely shared work like a conflict-review queue. A task uses
//   one or the other, not both.
//
// LOGIN PATH — keep it cheap:
//   forUser() is a read on a hot path. It does one sheet read and
//   filters in memory. No writes, no resolution logic at login —
//   resolution happens on the action path, when the user acts.
//
// COUPLING — modules talk to the queue only through this service
//   (create / resolve / forUser / openForSource); they never read or
//   write the Tasks tab directly. New modules create tasks without the
//   queue knowing anything about their domain.
// ============================================================

const Tasks = (() => {

  const STATUS = { OPEN: 'open', RESOLVED: 'resolved' };

  // Time constants for the (reporting-only) urgency computation.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DUE_SOON_WINDOW_MS = 3 * DAY_MS;   // "due soon" = within 3 days of DueAt


  /**
   * Creates an open task. Supply EITHER assignedTo (specific user)
   * OR assignedRole (shared pool) — assignedTo wins if both are given.
   *
   * Time fields are OPTIONAL and supplied by the module/workflow (domain
   * knowledge); the queue never invents them:
   *   dueAt          - hard deadline (Date or ISO string); omit for none
   *   staleAfterDays - neglect threshold in days; omit for never
   * LastActivityAt is owned by the queue and stamped here automatically.
   *
   * @param {Object} p
   *   @param {string} p.module     - source module key (e.g. 'thesis')
   *   @param {string} p.sourceType - record type within the module (e.g. 'thesis_submission')
   *   @param {string} p.sourceId   - id of the authoritative record in the module's sheet
   *   @param {string} p.label      - short human-readable description for display
   *   @param {string} [p.assignedTo]   - email of the specific responsible user
   *   @param {string} [p.assignedRole] - role key, for shared-pool tasks only
   *   @param {string} [p.note]     - optional free-text note
   *   @param {Date|string} [p.dueAt]        - hard deadline (domain-supplied)
   *   @param {number}      [p.staleAfterDays]- neglect threshold (domain-supplied)
   * @returns {{ taskId: string }}
   */
  function create(p) {
    p = p || {};
    const module    = String(p.module || '').trim();
    const sourceId  = String(p.sourceId || '').trim();
    const assignedTo   = String(p.assignedTo || '').trim();
    const assignedRole = String(p.assignedRole || '').trim().toLowerCase();

    if (!module)   throw new Error('Tasks.create: module is required.');
    if (!sourceId) throw new Error('Tasks.create: sourceId is required.');
    if (!assignedTo && !assignedRole) {
      throw new Error('Tasks.create: provide assignedTo (a user) or assignedRole (a pool).');
    }

    const now = new Date();
    const taskId = DataService.generateId('TASK');
    DataService.insert(CONFIG.SHEETS.PLATFORM, CONFIG.TABS.TASKS, {
      TaskID:       taskId,
      Module:       module,
      SourceType:   String(p.sourceType || '').trim(),
      SourceID:     sourceId,
      Label:        String(p.label || '').trim(),
      // assignedTo wins when both supplied — a specific user is more precise
      // than a pool. Storing only one keeps routing unambiguous.
      AssignedTo:   assignedTo,
      AssignedRole: assignedTo ? '' : assignedRole,
      Status:       STATUS.OPEN,
      Note:         String(p.note || '').trim(),
      DueAt:          _toDateOrBlank(p.dueAt),
      StaleAfterDays: _toPosIntOrBlank(p.staleAfterDays),
      LastActivityAt: now,
      // CreatedAt / CreatedBy are filled by DataService.insert.
    });
    return { taskId: taskId };
  }


  /**
   * Marks a task resolved. Called by the OWNING MODULE when its record
   * reaches a terminal state — not by the queue itself. Idempotent-ish:
   * resolving an already-resolved or missing task is a no-op that reports
   * what happened rather than throwing, so a double-call can't break a flow.
   *
   * @param {string} taskId
   * @param {Object} [opts] - { resolvedBy, note }
   * @returns {{ status: 'resolved' | 'already_resolved' | 'not_found' }}
   */
  function resolve(taskId, opts) {
    const id = String(taskId || '').trim();
    if (!id) return { status: 'not_found' };
    opts = opts || {};

    const existing = _byId(id);
    if (!existing) return { status: 'not_found' };
    if (String(existing.Status).trim().toLowerCase() === STATUS.RESOLVED) {
      return { status: 'already_resolved' };
    }

    DataService.update(CONFIG.SHEETS.PLATFORM, CONFIG.TABS.TASKS, 'TaskID', id, {
      Status:         STATUS.RESOLVED,
      ResolvedAt:     new Date(),
      ResolvedBy:     String(opts.resolvedBy || Session.getActiveUser().getEmail() || '').trim(),
      LastActivityAt: new Date(),
      Note:           opts.note !== undefined ? String(opts.note) : existing.Note,
    });
    return { status: 'resolved' };
  }


  /**
   * Resolves the OPEN task(s) tied to a specific source record, without
   * the caller needing to have stored the TaskID. Lets a module say
   * "this record is done — clear whatever task points at it."
   *
   * @param {string} module
   * @param {string} sourceId
   * @param {Object} [opts] - { resolvedBy, note }
   * @returns {{ resolved: number }}
   */
  function resolveForSource(module, sourceId, opts) {
    const open = openForSource(module, sourceId);
    let n = 0;
    open.forEach(t => {
      if (resolve(t.taskId, opts).status === 'resolved') n++;
    });
    return { resolved: n };
  }


  /**
   * The login-path read: open tasks this user is responsible for.
   * Matches tasks assigned directly to the user's email OR to any role
   * the user holds (shared-pool tasks). One sheet read, filtered in
   * memory; no writes. Safe to call on every login.
   *
   * @param {string} email
   * @param {string[]} [roles] - the user's roles (lower-cased)
   * @returns {Object[]} open tasks (newest first), shaped for display
   */
  function forUser(email, roles) {
    const userEmail = String(email || '').trim().toLowerCase();
    const userRoles = (roles || []).map(r => String(r).trim().toLowerCase()).filter(Boolean);
    if (!userEmail && !userRoles.length) return [];

    const all = _allOpen();
    const mine = all.filter(t => {
      const to   = String(t.assignedTo || '').trim().toLowerCase();
      const role = String(t.assignedRole || '').trim().toLowerCase();
      if (to && to === userEmail) return true;
      if (role && userRoles.indexOf(role) !== -1) return true;
      return false;
    });
    // Most urgent first (overdue → due_soon → stale → normal), then newest.
    mine.sort((a, b) => {
      if (a._urgencyRank !== b._urgencyRank) return a._urgencyRank - b._urgencyRank;
      return (b._createdAt || 0) - (a._createdAt || 0);
    });
    return mine.map(_publicShape);
  }


  /** Count of open tasks for a user — convenience for a login badge. */
  function countForUser(email, roles) {
    return forUser(email, roles).length;
  }


  /**
   * Open tasks tied to a given source record (module + sourceId).
   * @returns {Object[]} open tasks in display shape
   */
  function openForSource(module, sourceId) {
    const m  = String(module || '').trim();
    const sid = String(sourceId || '').trim();
    if (!m || !sid) return [];
    return _allOpen()
      .filter(t => String(t.module) === m && String(t.sourceId) === sid)
      .map(_publicShape);
  }


  // ── Private ──────────────────────────────────────────────────

  /**
   * Reads all OPEN task rows. Tolerates a missing PLATFORM sheet / Tasks
   * tab (returns []) so a not-yet-provisioned platform sheet can never
   * break the login path — callers just see "no tasks".
   */
  function _allOpen() {
    try {
      if (!CONFIG.SHEETS.PLATFORM) return [];   // not configured yet
      const rows = DataService.getAll(CONFIG.SHEETS.PLATFORM, CONFIG.TABS.TASKS);
      return rows
        .filter(r => String(r.Status || '').trim().toLowerCase() === STATUS.OPEN)
        .map(_internalShape);
    } catch (err) {
      Logger.log('Tasks._allOpen failed (treating as empty): ' + err);
      return [];
    }
  }

  function _byId(taskId) {
    try {
      if (!CONFIG.SHEETS.PLATFORM) return null;
      const found = DataService.query(CONFIG.SHEETS.PLATFORM, CONFIG.TABS.TASKS, 'TaskID', taskId);
      return found && found.length ? found[0] : null;
    } catch (err) {
      Logger.log('Tasks._byId failed: ' + err);
      return null;
    }
  }

  /** Internal shape: keeps sortable timestamps + computed urgency status. */
  function _internalShape(r) {
    const created = r.CreatedAt ? new Date(r.CreatedAt).getTime() : 0;
    const lastAct = r.LastActivityAt ? new Date(r.LastActivityAt).getTime() : created;
    const dueAt   = r.DueAt ? new Date(r.DueAt) : null;
    const staleDays = _toPosIntOrBlank(r.StaleAfterDays);
    const urgency = _computeUrgency(dueAt, staleDays, lastAct);
    return {
      taskId:       r.TaskID,
      module:       r.Module,
      sourceType:   r.SourceType,
      sourceId:     r.SourceID,
      label:        r.Label,
      assignedTo:   r.AssignedTo,
      assignedRole: r.AssignedRole,
      status:       r.Status,          // lifecycle status (open/resolved)
      urgency:      urgency,           // computed reporting status
      note:         r.Note,
      dueAt:        r.DueAt || '',
      staleAfterDays: staleDays === '' ? '' : staleDays,
      lastActivityAt: r.LastActivityAt || r.CreatedAt || '',
      createdAt:    r.CreatedAt,
      _createdAt:   created,
      _lastAct:     lastAct,
      _urgencyRank: _urgencyRank(urgency),
    };
  }

  /**
   * Computes a reporting-only urgency label from time fields. This is
   * pure visibility — it NEVER changes workflow state. Order of checks:
   * a hard overdue deadline outranks staleness; due-soon outranks stale.
   *   'overdue'  - past DueAt
   *   'due_soon' - within DUE_SOON_WINDOW_MS of DueAt
   *   'stale'    - no/!near deadline, but untouched beyond StaleAfterDays
   *   'normal'   - none of the above
   */
  function _computeUrgency(dueAt, staleDays, lastActMs) {
    const now = Date.now();
    if (dueAt instanceof Date && !isNaN(dueAt.getTime())) {
      const due = dueAt.getTime();
      if (now > due) return 'overdue';
      if (due - now <= DUE_SOON_WINDOW_MS) return 'due_soon';
    }
    if (staleDays !== '' && lastActMs) {
      const ageMs = now - lastActMs;
      if (ageMs > staleDays * DAY_MS) return 'stale';
    }
    return 'normal';
  }

  /** Sort rank: lower = more urgent (floats to the top of forUser). */
  function _urgencyRank(u) {
    switch (u) {
      case 'overdue':  return 0;
      case 'due_soon': return 1;
      case 'stale':    return 2;
      default:         return 3;
    }
  }

  /** Public shape: what callers/UI get (drops the private sort helpers). */
  function _publicShape(t) {
    return {
      taskId:     t.taskId,
      module:     t.module,
      sourceType: t.sourceType,
      sourceId:   t.sourceId,
      label:      t.label,
      assignedTo: t.assignedTo,
      assignedRole: t.assignedRole,
      status:     t.status,        // lifecycle: open/resolved
      urgency:    t.urgency,       // reporting: overdue/due_soon/stale/normal
      note:       t.note,
      dueAt:          t.dueAt,
      staleAfterDays: t.staleAfterDays,
      lastActivityAt: t.lastActivityAt,
      createdAt:  t.createdAt,
    };
  }


  // ── Time-field coercion helpers ──────────────────────────────

  /** Returns a Date for valid date input, or '' (blank cell) otherwise. */
  function _toDateOrBlank(v) {
    if (!v) return '';
    const d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? '' : d;
  }

  /** Returns a positive integer, or '' for blank/invalid/non-positive. */
  function _toPosIntOrBlank(v) {
    if (v === '' || v === null || v === undefined) return '';
    const n = Number(v);
    return (isFinite(n) && n > 0) ? Math.floor(n) : '';
  }


  return { create, resolve, resolveForSource, forUser, countForUser, openForSource };

})();