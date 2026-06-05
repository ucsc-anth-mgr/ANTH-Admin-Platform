// ============================================================
// ImportModule.gs — Standalone batch-import module
// ============================================================
// Thin pass-through to BatchImport (parse/detect/preview/commit) and
// ImportPolicy (who may import, which roles they may assign). Kept
// separate from Admin so importing can be delegated without granting
// full admin access.
// ============================================================

const ImportModule = (() => {

  function detectColumns(p, user, roles) { return BatchImport.detectColumns(p, user, roles); }
  function preview(p, user, roles)       { return BatchImport.preview(p, user, roles); }
  function commit(p, user, roles)        { return BatchImport.commit(p, user, roles); }

  /**
   * Form bootstrap: the roles this importer may assign, plus the
   * default ID type per role (roles containing 'student' default to
   * student IDs; everything else to employee IDs).
   */
  function importOptions(p, user, roles) {
    const assignable = ImportPolicy.assignableFor(roles);
    const defaults = {};
    assignable.forEach(r => {
      defaults[r] = (r.indexOf('student') !== -1) ? 'student' : 'employee';
    });
    return { assignable: assignable, idTypeDefaults: defaults };
  }

  return { detectColumns, preview, commit, importOptions };

})();