// ============================================================
// ActionPolicy.gs — Per-action authorization for dispatch()
// ============================================================
// The gateway's second gate. Module entry (the registry's Roles list)
// answers "may this person open the module at all"; this answers "may
// this role category invoke THIS action." It is a COARSE pre-filter:
// record-level checks (is this the sponsor? the assignee? within the
// ImportPolicy allowlist?) stay in the handlers, which keep every
// check they have today.
//
// DECLARATIONS — each handler exports an ACTIONS map:
//
//   const ThesisModule = (() => {
//     const ACTIONS = {
//       submit:        ['undergraduate_student'],
//       mySubmissions: ['undergraduate_student'],
//       queue:         ['senate_faculty', 'lecturer', 'staff_undergrad'],
//       gradQueue:     ['staff_undergrad'],
//       deleteThesis:  [],                  // [] = super_admin only
//       listEligible:  ['*'],               // '*' = anyone the module admits
//       ...
//     };
//     ...
//     return { ACTIONS: ACTIONS, submit: submit, ... };
//   })();
//
// Semantics:
//   ['*']        — any caller the module itself admits (module entry
//                  already passed; this action adds nothing further).
//   ['role',...] — caller must hold one of these roles.
//   []           — super_admin only.
//   (missing)    — DEFAULT-DENY: treated as super_admin only. A new
//                  action does not run for anyone else until declared.
//
// super_admin ALWAYS passes, matching the platform-wide rule that
// privileged checks always include super_admin.
//
// Tabs vs. ACTIONS — deliberate separation:
//   The TABS manifests (and Admin → Modules → Tabs) manage VISIBILITY
//   ONLY. Widening a tab's roles shows a tab; it never grants an
//   action. ACTIONS is the code-declared floor that configuration can
//   not override. Keep it that way: the day tab config grants
//   permissions is the day an admin UI edit becomes a security event.
//
// MODES (MODE constant below):
//   'shadow'  — evaluate but do not block. A would-be denial writes an
//               audit row with status 'would_deny' and the caller's
//               roles, then the call proceeds normally. Run this first:
//               after a week of real use, the AuditLog's would_deny
//               rows are the complete list of (a) genuine holes about
//               to close and (b) declarations you forgot. Fix the
//               declarations, then flip to 'enforce'.
//   'enforce' — a denial throws (and dispatch audits it as 'denied').
//   'off'     — gateway skips per-action checks entirely (back-out).
// ============================================================

const ActionPolicy = (() => {

  const MODE = 'shadow';   // 'shadow' → 'enforce' once would_deny is clean

  /**
   * Evaluates whether roles may invoke action on this handler.
   * Pure decision — no logging, no throwing; dispatch owns those.
   *
   * @param {Object} handler - the module handler object (may carry ACTIONS)
   * @param {string} action  - the action name being dispatched
   * @param {Array}  roles   - the caller's roles
   * @return {{allowed: boolean, reason: string}}
   */
  function check(handler, action, roles) {
    roles = roles || [];
    if (roles.indexOf('super_admin') !== -1) {
      return { allowed: true, reason: 'super_admin' };
    }

    const map = handler && handler.ACTIONS;
    if (!map || typeof map !== 'object') {
      // Handler predates the policy: every non-super_admin call would
      // deny. Surfaced distinctly so shadow-mode logs make clear the
      // whole MODULE needs a map, not one action.
      return { allowed: false, reason: 'no ACTIONS map on handler' };
    }

    if (!Object.prototype.hasOwnProperty.call(map, action)) {
      return { allowed: false, reason: 'action not declared (default-deny)' };
    }

    const allow = map[action];
    if (!Array.isArray(allow)) {
      return { allowed: false, reason: 'invalid declaration (not an array)' };
    }
    if (allow.length === 0) {
      return { allowed: false, reason: 'declared super_admin only' };
    }
    if (allow.indexOf('*') !== -1) {
      return { allowed: true, reason: 'open to module' };
    }
    for (let i = 0; i < roles.length; i++) {
      if (allow.indexOf(roles[i]) !== -1) {
        return { allowed: true, reason: 'role ' + roles[i] };
      }
    }
    return { allowed: false, reason: 'no matching role' };
  }

  function mode() { return MODE; }

  /**
   * Coverage report for the Admin module (or the editor's Logger):
   * which registered handlers have an ACTIONS map, and which dispatch-
   * able actions on them are undeclared. Useful while migrating.
   */
  function coverage() {
    const out = [];
    getRegisteredHandlers().forEach(function (name) {
      let handler;
      try { handler = getModuleHandler(name); } catch (e) { return; }
      const map = handler.ACTIONS || null;
      const actions = Object.keys(handler).filter(function (k) {
        return typeof handler[k] === 'function' && k !== 'ACTIONS';
      });
      out.push({
        handler: name,
        hasMap: !!map,
        actionCount: actions.length,
        undeclared: map ? actions.filter(function (a) {
          return !Object.prototype.hasOwnProperty.call(map, a);
        }) : actions,
      });
    });
    return out;
  }

  return { check: check, mode: mode, coverage: coverage };

})();

/**
 * Editor-runnable coverage report: which handlers have an ACTIONS map,
 * and which of their dispatchable actions are undeclared. Run from the
 * Apps Script editor and read the log. (ActionPolicy.coverage() itself
 * is a method on the IIFE, so it can't be selected in the run dropdown.)
 */
function logActionPolicyCoverage() {
  const rows = ActionPolicy.coverage();
  rows.forEach(function (r) {
    Logger.log(r.handler + ' — map: ' + (r.hasMap ? 'yes' : 'NO')
      + ' — actions: ' + r.actionCount
      + (r.undeclared.length ? ' — undeclared: ' + r.undeclared.join(', ') : ' — all declared'));
  });
  return rows;
}