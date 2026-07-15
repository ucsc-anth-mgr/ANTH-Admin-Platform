// ============================================================
// TabRegistry.gs — Per-module, per-role tab visibility
// ============================================================
// A module's tabs are DECLARED IN CODE: the handler object exposes a
// TABS manifest (array of { key, label, icon, roles, actions, floor }).
// This registry layers a sheet ("ModuleTabs" in the config spreadsheet)
// over those manifests so an admin can change WHO SEES EACH TAB without
// a code change — the same code-declares / sheet-configures split as
// the module registry itself. The Admin module is exempt (its tabs are
// never configurable; saveForModule refuses the key).
//
// Manifest shape (per tab):
//   key     — tab identifier, matches the template's data-tab value.
//             PERMANENT once created, like a module key.
//   label   — button text (presentation stays in code, not the sheet).
//   icon    — Tabler icon class (e.g. 'ti-users-group').
//   roles   — DEFAULT visibility roles. '*' = anyone the module admits
//             (they already passed the module's own Roles gate).
//             []  = super_admin only.
//   actions — the dispatch actions this tab "owns". NOT ENFORCED yet:
//             Phase 1 is visibility only, and every handler keeps its
//             own per-action permission checks regardless of tab
//             config. Declared now so a later Phase 2 can gate
//             dispatch per tab without another sweep of the modules.
//   floor   — optional hard-minimum role for the tab's actions in that
//             future Phase 2 (e.g. 'super_admin'). Ignored in Phase 1;
//             surfaced in the Admin editor as a hint.
//
// Sheet columns:  Module | Tab | Roles | Enabled
//   Roles   — comma list, may include '*'. BLANK = fall back to the
//             manifest's default roles, so an empty cell can never
//             lock a tab away by accident.
//   Enabled — FALSE hides the tab from EVERYONE, super admins
//             included — mirroring the module registry's Enabled
//             semantics. (Roles-empty ≠ disabled: an empty role set
//             means super_admin-only, which is the normal state of a
//             management tab.)
//
// Resolution rules (visibleTabs):
//   - manifest order is display order; a sheet row never reorders.
//   - no sheet row            → enabled, manifest default roles.
//   - sheet row, blank Roles  → sheet Enabled, manifest default roles.
//   - sheet row with Roles    → sheet Enabled, sheet Roles.
//   - super_admin sees every ENABLED tab regardless of roles.
//   - '*' admits anyone in the module.
//
// Failure posture: reads NEVER throw — any sheet problem degrades to
// manifest defaults, so a broken/missing ModuleTabs tab can never
// blank a module's tab bar. Writes DO throw so the Admin UI can
// report a save error.
//
// Mirrors the Settings / ModuleManager patterns: an IIFE, sheet I/O by
// header name, an _ensureSheet bootstrap. No seed rows — the sheet is
// populated lazily by Admin saves; unsaved modules run on manifest
// defaults forever, which is correct.
// ============================================================

const TabRegistry = (() => {

  const HEADERS = ['Module', 'Tab', 'Roles', 'Enabled'];

  function _tabName() {
    return (CONFIG.TABS && CONFIG.TABS.MODULE_TABS) || 'ModuleTabs';
  }


  // ── Manifests (code-declared) ──────────────────────────────

  /**
   * The TABS manifest of a module's handler, normalized. Returns []
   * when the module is unknown, its handler is missing, or it declares
   * no tabs. Never throws.
   * @param {string} moduleKey
   * @returns {Array<{key,label,icon,roles,actions,floor}>}
   */
  function manifest(moduleKey) {
    try {
      const registry = getModuleRegistry();
      const mod = registry[String(moduleKey || '').trim()];
      if (!mod) return [];
      const handler = getModuleHandler(mod.handler);
      const raw = handler && handler.TABS;
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(t => t && String(t.key || '').trim())
        .map(t => ({
          key: String(t.key).trim(),
          label: String(t.label || t.key),
          icon: String(t.icon || 'ti-square'),
          roles: Array.isArray(t.roles)
            ? t.roles.map(r => String(r).trim()).filter(Boolean)
            : [],
          actions: Array.isArray(t.actions) ? t.actions.slice() : [],
          floor: String(t.floor || ''),
        }));
    } catch (e) {
      Logger.log('TabRegistry.manifest(' + moduleKey + ') failed: ' + e);
      return [];
    }
  }


  // ── Read (Admin editing view) ──────────────────────────────

  /**
   * Everything the Admin tabs editor needs for one module:
   *   { moduleKey, tabs, orphans }
   * tabs — one entry per MANIFEST tab, in manifest order:
   *   { key, label, icon, defaultRoles, actions, floor,
   *     roles (effective), enabled, overridden }
   * orphans — sheet rows for tabs the code no longer declares (drift;
   *   they are removed automatically on the next save).
   * @param {string} moduleKey
   */
  function listForModule(moduleKey) {
    const mkey = String(moduleKey || '').trim();
    const man = manifest(mkey);
    const rows = _rowsForModule(mkey);
    const byTab = {};
    rows.forEach(r => { byTab[r.tab] = r; });

    const tabs = man.map(t => {
      const row = byTab[t.key] || null;
      const eff = _effective(t, row);
      return {
        key: t.key, label: t.label, icon: t.icon,
        defaultRoles: t.roles, actions: t.actions, floor: t.floor,
        roles: eff.roles, enabled: eff.enabled,
        overridden: !!row,
      };
    });

    const manKeys = {};
    man.forEach(t => { manKeys[t.key] = true; });
    const orphans = rows
      .filter(r => !manKeys[r.tab])
      .map(r => ({ tab: r.tab, roles: r.roles, enabled: r.enabled }));

    return { moduleKey: mkey, tabs: tabs, orphans: orphans };
  }


  // ── Resolve (render time) ──────────────────────────────────

  /**
   * The tabs THIS user sees in a module, resolved from the manifest +
   * sheet overrides: [{ key, label, icon }] in manifest order.
   * Called by getModuleHTML for every module render. Never throws —
   * degrades to manifest defaults on any sheet problem.
   * @param {string} moduleKey
   * @param {string[]} userRoles
   */
  function visibleTabs(moduleKey, userRoles) {
    const roles = Array.isArray(userRoles) ? userRoles : [];
    const isSuper = roles.indexOf('super_admin') !== -1;
    const man = manifest(moduleKey);
    if (!man.length) return [];

    let byTab = {};
    try {
      _rowsForModule(String(moduleKey || '').trim())
        .forEach(r => { byTab[r.tab] = r; });
    } catch (e) {
      byTab = {};   // degrade to manifest defaults
    }

    return man
      .filter(t => {
        const eff = _effective(t, byTab[t.key] || null);
        if (!eff.enabled) return false;              // off for everyone
        if (isSuper) return true;                    // super sees all enabled
        if (eff.roles.indexOf('*') !== -1) return true;
        return eff.roles.some(r => roles.indexOf(r) !== -1);
      })
      .map(t => ({ key: t.key, label: t.label, icon: t.icon }));
  }


  // ── Write (Admin UI) ───────────────────────────────────────

  /**
   * Saves the tab configuration for one module: one entry per manifest
   * tab — { tab, roles[], enabled }. Entries for tabs the manifest does
   * not declare are ignored, and existing sheet rows for undeclared
   * tabs (orphans) are deleted. The Admin module is exempt entirely.
   * @param {string} moduleKey
   * @param {Array<{tab,roles,enabled}>} tabs
   * @returns {{ moduleKey, saved, orphansRemoved }}
   */
  function saveForModule(moduleKey, tabs) {
    const mkey = String(moduleKey || '').trim();
    if (!mkey) throw new Error('Module key is required.');
    if (mkey === 'admin') throw new Error('The Admin module\'s tabs cannot be configured.');
    const registry = getModuleRegistry();
    if (!registry[mkey]) throw new Error('Unknown module: ' + mkey);

    const man = manifest(mkey);
    if (!man.length) throw new Error('This module\'s code does not declare configurable tabs.');
    const manKeys = {};
    man.forEach(t => { manKeys[t.key] = true; });

    const entries = (Array.isArray(tabs) ? tabs : [])
      .map(t => ({
        tab: String((t || {}).tab || '').trim(),
        roles: Array.isArray((t || {}).roles)
          ? t.roles.map(r => String(r).trim()).filter(Boolean)
          : [],
        enabled: (t || {}).enabled !== false,
      }))
      .filter(t => t.tab && manKeys[t.tab]);

    const sheet = _ensureSheet();
    let data = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim());
    const cMod = headers.indexOf('Module');
    const cTab = headers.indexOf('Tab');
    const cRoles = headers.indexOf('Roles');
    const cEnabled = headers.indexOf('Enabled');
    if (cMod === -1 || cTab === -1 || cRoles === -1 || cEnabled === -1) {
      throw new Error('The ' + _tabName() + ' sheet is missing expected columns (Module, Tab, Roles, Enabled).');
    }

    // 1) Delete this module's orphan rows (bottom-up so indexes hold).
    let orphansRemoved = 0;
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][cMod]).trim() !== mkey) continue;
      if (!manKeys[String(data[i][cTab]).trim()]) {
        sheet.deleteRow(i + 1);
        orphansRemoved++;
      }
    }

    // 2) Upsert each entry. Re-read once after deletions, then track
    //    appended rows locally so a batch save stays consistent.
    data = sheet.getDataRange().getValues();
    const rowIndexByTab = {};
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][cMod]).trim() === mkey) {
        rowIndexByTab[String(data[i][cTab]).trim()] = i + 1;   // 1-based
      }
    }

    let saved = 0;
    entries.forEach(entry => {
      const rolesStr = entry.roles.join(', ');
      const enabledStr = entry.enabled ? 'TRUE' : 'FALSE';
      const at = rowIndexByTab[entry.tab];
      if (at) {
        sheet.getRange(at, cRoles + 1).setValue(rolesStr);
        sheet.getRange(at, cEnabled + 1).setValue(enabledStr);
      } else {
        const row = [];
        row[cMod] = mkey;
        row[cTab] = entry.tab;
        row[cRoles] = rolesStr;
        row[cEnabled] = enabledStr;
        for (let c = 0; c < headers.length; c++) {
          if (row[c] === undefined) row[c] = '';
        }
        sheet.appendRow(row);
        rowIndexByTab[entry.tab] = sheet.getLastRow();
      }
      saved++;
    });

    return { moduleKey: mkey, saved: saved, orphansRemoved: orphansRemoved };
  }


  // ── Private ────────────────────────────────────────────────

  /**
   * Effective { roles, enabled } for a manifest tab + optional sheet
   * row. Blank sheet Roles falls back to the manifest defaults.
   */
  function _effective(manifestTab, row) {
    if (!row) return { roles: manifestTab.roles, enabled: true };
    return {
      roles: row.roles.length ? row.roles : manifestTab.roles,
      enabled: row.enabled,
    };
  }

  /**
   * Sheet rows for one module: [{ tab, roles[], enabled }].
   * Never throws — returns [] on any read failure.
   */
  function _rowsForModule(moduleKey) {
    const out = [];
    try {
      const sheet = _ensureSheet();
      const data = sheet.getDataRange().getValues();
      if (data.length < 2) return out;
      const headers = data[0].map(h => String(h).trim());
      const cMod = headers.indexOf('Module');
      const cTab = headers.indexOf('Tab');
      const cRoles = headers.indexOf('Roles');
      const cEnabled = headers.indexOf('Enabled');
      if (cMod === -1 || cTab === -1) return out;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][cMod]).trim() !== moduleKey) continue;
        const tab = String(data[i][cTab]).trim();
        if (!tab) continue;
        out.push({
          tab: tab,
          roles: cRoles === -1 ? [] :
            String(data[i][cRoles] == null ? '' : data[i][cRoles])
              .split(',').map(r => r.trim()).filter(Boolean),
          enabled: cEnabled === -1 ? true :
            String(data[i][cEnabled]).trim().toUpperCase() !== 'FALSE',
        });
      }
    } catch (e) {
      Logger.log('TabRegistry._rowsForModule(' + moduleKey + ') failed: ' + e);
    }
    return out;
  }

  /** Returns the ModuleTabs sheet, creating it with headers if absent. */
  function _ensureSheet() {
    const ss = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
    let sheet = ss.getSheetByName(_tabName());
    if (!sheet) {
      sheet = ss.insertSheet(_tabName());
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length)
           .setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
    }
    return sheet;
  }


  return { manifest, listForModule, visibleTabs, saveForModule };

})();
