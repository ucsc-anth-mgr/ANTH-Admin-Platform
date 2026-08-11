// ============================================================
// CourseworkPetitionModule.gs — Undergraduate Coursework Petition (server)
// ============================================================
// Course-substitution petitions for the Anthropology major/minor:
//   LOWER division — ANTH 1/2/3 equivalents from CCCs, four-year
//     institutions, or out-of-state community colleges.
//   UPPER division — up to two elective courses (10-credit campus cap)
//     from Education Abroad, four-year transfer, or field schools.
//
// SHAPE: header + line items. Decisions, documents, review path, and
// MyUCSC processing are all PER COURSE, so each course line is its own
// row in PetitionItems, keyed to the Petitions header row.
//
//   SUBMITTED ─ advisor intake ─┬─ Return ──────────────► RETURNED
//                               ├─ all items resolved ──► PENDING_PROCESSING | COMPLETE
//                               └─ any FACULTY_REVIEW ──► PENDING_DUS
//   PENDING_DUS ─ DUS decides every open item ──────────► PENDING_PROCESSING | COMPLETE
//   PENDING_PROCESSING ─ advisor records MyUCSC actions ► COMPLETE (terminal; PDF)
//   RETURNED ─ student revises + resubmits ─────────────► SUBMITTED (same record)
//
// DESIGN NOTES (agreed in design review):
//   - RETURNED is for INTAKE problems only (missing docs, wrong form).
//     A DENIAL — by the DUS at review, or by the advisor at intake (cap,
//     articulation says no) — is TERMINAL for that item. One decision
//     vocabulary regardless of decider; DecidedBy is the audit trail.
//   - The articulation short-circuit: at intake the advisor classifies
//     each item ARTICULATED (approved on the spot, DUS never sees it)
//     or FACULTY_REVIEW (queued for the undergrad_director). A petition
//     whose items are all resolved at intake skips the DUS stage.
//   - The DUS is whoever holds the 'undergrad_director' role (assign in
//     Admin → Users) — a pool, like staff_undergrad, not a stored email.
//   - Institutions are a curated reference list (starts empty). Students
//     pick from it or use the free-text escape hatch; the advisor can
//     promote free text onto the list at intake, so precedent matching
//     becomes exact on InstitutionID over time.
//   - Precedent matching (reviewer-facing only): prior APPROVED and
//     DENIED items for the same course + institution, with reasons.
//   - Upper-division cap: 2 approved elective items (10 credits) total.
//     Computed informationally for the student at submit and as a
//     warning for the advisor at intake; the advisor may deny for cap.
//   - Duplicate guard: a new item matching (student, courseId,
//     institution) is blocked while a matching item is pending or
//     already APPROVED; a DENIED (or withdrawn) match may be re-filed.
//   - Identity is NOT copied onto records: StudentEmail is the routing
//     key; names/StudentID come from Auth at display time.
//   - The canonical PDF is generated ONCE, at COMPLETE, via
//     ReportService (campus-form layout; name/email/timestamp in lieu
//     of signatures). Uploaded syllabi/transcripts live in
//     CONFIG.COURSEWORK.DRIVE_FOLDER_ID.
//   - Every privileged action allows super_admin. No SpreadsheetApp
//     here — DataService, Tasks, Notify, Auth, EventBus, ReportService.
//
// SERIALIZATION RULE (the Date landmine): google.script.run cannot
// return Date objects — the client call fails SILENTLY. Every action's
// return value is shaped to plain strings/numbers/booleans (_plainStr).
//
// REGISTRATION (only after this file ships — see WIRING.md):
//   Code.gs getModuleHandler():      CourseworkPetitionModule: CourseworkPetitionModule,
//   Code.gs getRegisteredHandlers(): 'CourseworkPetitionModule'
//   Admin → Modules row:             key 'coursework_petition',
//                                    include 'coursework_petition'
// ============================================================

const CourseworkPetitionModule = (() => {

  const MODULE      = 'coursework_petition';
  const SOURCE_TYPE = 'coursework_petition';

  const SHEET     = () => CONFIG.SHEETS.COURSEWORK;
  const TAB       = () => CONFIG.TABS.COURSEWORK_PETITIONS;
  const ITEMS_TAB = () => CONFIG.TABS.COURSEWORK_ITEMS;
  const INST_TAB  = () => CONFIG.TABS.COURSEWORK_INSTITUTIONS;
  const SETTINGS_TAB = () => CONFIG.TABS.COURSEWORK_SETTINGS;

  // ── UI-managed student-notification templates ──────────────
  // Defaults for the two student emails, editable in the module's
  // Settings tab (stored in the CourseworkSettings key/value tab,
  // mirroring PetitionSettings / TranscriptSettings). The template is
  // the INTRO of the message; the essentials are always appended below
  // it and cannot be edited away — the return note and resubmission
  // link (returned), the per-course outcomes and PDF link (complete).
  // Tokens filled at send time: {FirstName} {Name} {Division}.
  // A blank/missing stored value falls back to these defaults.
  const NOTIFY_DEFAULTS = {
    NOTIFY_RETURNED:
      'Hello {FirstName},\n\nYour Anthropology {Division} coursework petition was returned by the '
      + 'undergraduate advisor and needs your attention before it can be reviewed.',
    NOTIFY_COMPLETE:
      'Hello {FirstName},\n\nYour Anthropology {Division} coursework petition is complete. '
      + 'The outcome for each course is listed below.',
  };

  const ADVISOR_ROLE = 'staff_undergrad';
  const DUS_ROLE     = 'undergrad_director';
  const STUDENT_ROLE = 'undergraduate_student';

  const STAGE = {
    SUBMITTED:  'SUBMITTED',
    RETURNED:   'RETURNED',
    PENDING_DUS: 'PENDING_DUS',
    PENDING_PROCESSING: 'PENDING_PROCESSING',
    COMPLETE:   'COMPLETE',
    WITHDRAWN:  'WITHDRAWN',
  };
  const OPEN_STAGES = [STAGE.SUBMITTED, STAGE.RETURNED, STAGE.PENDING_DUS, STAGE.PENDING_PROCESSING];

  const DIVISION = { LOWER: 'LOWER', UPPER: 'UPPER' };

  // Lower-division targets are the three fixed prerequisites; upper items
  // all target the elective bucket.
  const LOWER_TARGETS = [
    { key: 'ANTH1', label: 'ANTH 1: Intro to Biological Anthropology' },
    { key: 'ANTH2', label: 'ANTH 2: Intro to Cultural Anthropology' },
    { key: 'ANTH3', label: 'ANTH 3: Intro to Archaeology' },
  ];
  const UPPER_TARGET = 'UD_ELECTIVE';

  // Division-scoped type vocabularies (mirror the paper forms).
  const LOWER_TYPES = [
    { key: 'CCC',       label: 'California Community College' },
    { key: 'FOUR_YEAR', label: 'Four-Year Institution' },
    { key: 'OOS_CC',    label: 'Out-of-state Community College' },
  ];
  const UPPER_TYPES = [
    { key: 'EAP',          label: 'Education Abroad' },
    { key: 'TRANSFER_4YR', label: 'Transfer from Four-Year Institution' },
    { key: 'FIELD_SCHOOL', label: 'Field School' },
  ];

  // Institution reference-list types. Lower-division dropdowns filter to
  // the first three; upper-division dropdowns show the full active list
  // (course TYPE and institution type are independent concepts there).
  const INST_TYPES = [
    { key: 'CCC',           label: 'California Community College' },
    { key: 'FOUR_YEAR',     label: 'Four-Year Institution' },
    { key: 'OOS_CC',        label: 'Out-of-state Community College' },
    { key: 'INTERNATIONAL', label: 'International Institution / EAP Host' },
    { key: 'FIELD_SCHOOL',  label: 'Field School / Program' },
  ];
  const LOWER_INST_TYPES = ['CCC', 'FOUR_YEAR', 'OOS_CC'];

  const REVIEW_PATH = { ARTICULATED: 'ARTICULATED', FACULTY_REVIEW: 'FACULTY_REVIEW' };
  const DECISION    = { APPROVED: 'APPROVED', DENIED: 'DENIED' };

  const MYUCSC_ACTIONS = [
    { key: 'OTHER_CREDIT_QUICK', label: 'Other Credit Quick' },
    { key: 'REQUIREMENT_WAIVER', label: 'Requirement Waiver' },
    { key: 'COURSE_DIRECTIVE',   label: 'Course Directive' },
  ];

  // Campus cap: two upper-division elective courses (10 credits) may be
  // applied toward the major, total, across all of a student's petitions.
  const UD_CAP_ITEMS = 2;


  // ============================================================
  // Tab manifest (TabRegistry) — visibility only; every action is
  // still permission-checked below.
  // ============================================================
  const TABS = [
    { key: 'new',          label: 'New Petition',   icon: 'ti-file-plus',   roles: [STUDENT_ROLE],
      actions: ['bootstrap', 'submit'] },
    { key: 'mine',         label: 'My Petitions',   icon: 'ti-list',        roles: [STUDENT_ROLE],
      actions: ['mine', 'get', 'resubmit', 'withdraw'] },
    { key: 'intake',       label: 'Intake',         icon: 'ti-inbox',       roles: [ADVISOR_ROLE],
      actions: ['intakeQueue', 'intakeSubmit', 'returnToStudent', 'promoteInstitution'] },
    { key: 'dus',          label: 'Faculty Review', icon: 'ti-gavel',       roles: [DUS_ROLE],
      actions: ['dusQueue', 'dusSubmit'] },
    { key: 'processing',   label: 'Processing',     icon: 'ti-checklist',   roles: [ADVISOR_ROLE],
      actions: ['processingQueue', 'processSubmit'] },
    { key: 'all',          label: 'All Petitions',  icon: 'ti-archive',     roles: [ADVISOR_ROLE, DUS_ROLE],
      actions: ['allPetitions', 'get', 'precedents', 'deletePetition'] },
    { key: 'institutions', label: 'Institutions',   icon: 'ti-building',    roles: [ADVISOR_ROLE],
      actions: ['listInstitutionsAll', 'saveInstitution'] },
    { key: 'settings',     label: 'Settings',       icon: 'ti-settings',    roles: [ADVISOR_ROLE],
      actions: ['getSettings', 'saveSettings', 'syncDocumentAccess'] },
  ];


  // ============================================================
  // BOOTSTRAP — everything the UI needs to draw itself once
  // ============================================================

  function bootstrap(payload, user, roles) {
    const isStudent = roles.indexOf(STUDENT_ROLE) !== -1;
    return {
      userEmail: user,
      isStudent: isStudent,
      isAdvisor: _isAdvisor(roles),
      isDus:     _isDus(roles),
      isSuper:   roles.indexOf('super_admin') !== -1,
      lowerTargets: LOWER_TARGETS,
      lowerTypes:   LOWER_TYPES,
      upperTypes:   UPPER_TYPES,
      instTypes:    INST_TYPES,
      myUcscActions: MYUCSC_ACTIONS,
      institutions:  _activeInstitutions(),
      lowerInstTypes: LOWER_INST_TYPES,
      udCap: UD_CAP_ITEMS,
      // Informational for the student's form: how much of the elective
      // cap their APPROVED items already consume.
      myApprovedUdItems: isStudent ? _approvedUdCount(user) : 0,
    };
  }


  // ============================================================
  // INSTITUTIONS — curated reference list (starts empty)
  // ============================================================

  /** Active institutions, for the student form + advisor pickers. */
  function listInstitutions(payload, user, roles) {
    return _activeInstitutions();
  }

  /** Full list, including inactive — the advisor's management view. */
  function listInstitutionsAll(payload, user, roles) {
    _assertAdvisor(roles);
    return DataService.getAll(SHEET(), INST_TAB())
      .map(_publicInstitution)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  /**
   * Create or update an institution. Advisor-curated (staff_undergrad or
   * super_admin). Name+type required; the (case-insensitive) name must be
   * unique among active rows so the list can't grow near-duplicates.
   * @param {Object} payload - { institutionId?, name, type, assistLink?,
   *                             active?, notes? }
   */
  function saveInstitution(payload, user, roles) {
    _assertAdvisor(roles);
    const p = payload || {};
    const name = String(p.name || '').trim();
    if (!name) throw new Error('Institution name is required.');
    const type = _requireOneOf(p.type, INST_TYPES.map(t => t.key), 'Institution type');
    const active = (p.active === undefined) ? true : (p.active === true || p.active === 'true');

    const all = DataService.getAll(SHEET(), INST_TAB());
    const id = String(p.institutionId || '').trim();
    const nameKey = _normText(name);
    const clash = all.find(r =>
      _normText(r.Name) === nameKey &&
      String(r.InstitutionID) !== id &&
      _isTrueStr(r.Active));
    if (active && clash) {
      throw new Error('An active institution named "' + clash.Name + '" already exists.');
    }

    const fields = {
      Name: name,
      Type: type,
      AssistLink: String(p.assistLink || '').trim(),
      Active: active ? 'TRUE' : 'FALSE',
    };
    // Notes preserved unless explicitly supplied (platform convention).
    if (p.notes !== undefined) fields.Notes = String(p.notes || '').trim();

    if (id) {
      const existing = all.find(r => String(r.InstitutionID) === id);
      if (!existing) throw new Error('Institution not found.');
      DataService.update(SHEET(), INST_TAB(), 'InstitutionID', id, fields);
      return { institutionId: id, updated: true };
    }
    const newId = DataService.generateId('INST');
    DataService.insert(SHEET(), INST_TAB(), Object.assign({ InstitutionID: newId }, fields));
    return { institutionId: newId, created: true };
  }

  /**
   * Promote an item's free-text institution onto the reference list and
   * link the item to the new entry (InstitutionID set, free text cleared).
   * The advisor may correct the name/type at promotion. One-click at
   * intake; also reachable from any reviewer detail view.
   * @param {Object} payload - { itemId, name?, type, assistLink?, notes? }
   */
  function promoteInstitution(payload, user, roles) {
    _assertAdvisor(roles);
    const p = payload || {};
    const item = _itemById(String(p.itemId || '').trim());
    if (!item) throw new Error('Petition item not found.');
    if (String(item.InstitutionID || '').trim()) {
      throw new Error('This item is already linked to a listed institution.');
    }
    const name = String(p.name || item.InstitutionFreeText || '').trim();
    if (!name) throw new Error('The item has no institution text to promote.');

    const saved = saveInstitution({
      name: name, type: p.type, assistLink: p.assistLink, notes: p.notes,
      active: true,
    }, user, roles);

    DataService.update(SHEET(), ITEMS_TAB(), 'ItemID', item.ItemID, {
      InstitutionID: saved.institutionId,
      InstitutionFreeText: '',
    });
    return { itemId: item.ItemID, institutionId: saved.institutionId, name: name };
  }


  // ============================================================
  // SETTINGS — UI-managed student-notification templates
  // ============================================================

  /**
   * Current settings for the Settings tab: the effective template for
   * each student email (stored value, else default), the defaults (for
   * the Reset button), and the token vocabulary for the hint text.
   */
  function getSettings(payload, user, roles) {
    _assertAdvisor(roles);
    const s = _readSettings();
    return {
      templates: {
        NOTIFY_RETURNED: s.NOTIFY_RETURNED,
        NOTIFY_COMPLETE: s.NOTIFY_COMPLETE,
      },
      defaults: {
        NOTIFY_RETURNED: NOTIFY_DEFAULTS.NOTIFY_RETURNED,
        NOTIFY_COMPLETE: NOTIFY_DEFAULTS.NOTIFY_COMPLETE,
      },
      tokens: ['{FirstName}', '{Name}', '{Division}'],
    };
  }

  /**
   * Saves the two templates from the Settings tab. A value identical to
   * the default (or blank) is stored as '' so the code default keeps
   * applying — future default-wording improvements then reach every
   * deployment that hasn't customized.
   * @param {Object} payload - { notifyReturned, notifyComplete }
   */
  function saveSettings(payload, user, roles) {
    _assertAdvisor(roles);
    const p = payload || {};
    _writeSettingsKey('NOTIFY_RETURNED',
      _storableTemplate(p.notifyReturned, NOTIFY_DEFAULTS.NOTIFY_RETURNED));
    _writeSettingsKey('NOTIFY_COMPLETE',
      _storableTemplate(p.notifyComplete, NOTIFY_DEFAULTS.NOTIFY_COMPLETE));
    return getSettings({}, user, roles);
  }

  /**
   * Re-grants viewer access on EVERY file this module owns — all uploaded
   * transcripts and syllabi, and every generated petition PDF — to the
   * student who filed it plus all current staff_undergrad and
   * undergrad_director holders.
   *
   * Grants at upload/completion capture the role holders of that moment,
   * so this is what makes "both roles can view everything" true for
   * someone added to a role afterward. Run it after any role change
   * (Settings → Document access).
   *
   * BATCHED: Drive permission calls are slow and Apps Script caps
   * execution at ~6 minutes, so each call processes a slice and reports
   * progress; the caller loops with the returned nextStartAt until done.
   * Idempotent — re-granting an existing viewer is a no-op, so a repeated
   * or overlapping run is harmless.
   *
   * @param {Object} payload - { startAt?, batchSize? }
   */
  function syncDocumentAccess(payload, user, roles) {
    _assertAdvisor(roles);
    const p = payload || {};
    const start = Math.max(0, Number(p.startAt || 0));
    const batchSize = Math.min(40, Math.max(1, Number(p.batchSize || 15)));

    const reviewers = _reviewerEmails();
    const files = _allModuleFiles();
    const slice = files.slice(start, start + batchSize);
    slice.forEach(f => _grantViewers(f.fileId, [f.studentEmail].concat(reviewers)));

    const processed = start + slice.length;
    return {
      processed: processed,
      total: files.length,
      done: processed >= files.length,
      nextStartAt: processed,
      reviewerCount: reviewers.length,
    };
  }

  /**
   * Every file the module owns, as { fileId, studentEmail, kind }.
   * Trashed/blank ids are skipped. Order is stable (petitions in sheet
   * order, then each petition's item files) so batched paging is safe.
   */
  function _allModuleFiles() {
    const out = [];
    const studentByPetition = {};
    DataService.getAll(SHEET(), TAB()).forEach(r => {
      const pid = String(r.PetitionID);
      studentByPetition[pid] = String(r.StudentEmail || '');
      const pdfId = String(r.DriveFileID || '').trim();
      if (pdfId) out.push({ fileId: pdfId, studentEmail: studentByPetition[pid], kind: 'PDF' });
    });
    DataService.getAll(SHEET(), ITEMS_TAB()).forEach(it => {
      const student = studentByPetition[String(it.PetitionID)] || '';
      const t = String(it.TranscriptFileID || '').trim();
      const s = String(it.SyllabusFileID || '').trim();
      if (t) out.push({ fileId: t, studentEmail: student, kind: 'TRANSCRIPT' });
      if (s) out.push({ fileId: s, studentEmail: student, kind: 'SYLLABUS' });
    });
    return out;
  }


  // ============================================================
  // STUDENT ACTIONS — submit / resubmit / withdraw / mine
  // ============================================================

  /**
   * Student files a petition. One header row + one item row per course.
   * payload = {
   *   division: 'LOWER' | 'UPPER',
   *   items: [{
   *     targetCourse,            // LOWER: ANTH1|ANTH2|ANTH3 (distinct); UPPER: ignored (UD_ELECTIVE)
   *     typeCode,                // division-scoped vocabulary
   *     institutionId?,          // from the reference list…
   *     institutionFreeText?,    // …or the escape hatch (exactly one required)
   *     courseId,                // their course, e.g. "ANTH 101"
   *     transcript: { dataBase64, mimeType?, name? },   // REQUIRED
   *     syllabus?:  { dataBase64, mimeType?, name? },   // encouraged; advisor may return without it
   *   }, ...]
   * }
   */
  function submit(payload, user, roles) {
    if (roles.indexOf(STUDENT_ROLE) === -1 && roles.indexOf('super_admin') === -1) {
      throw new Error('Only undergraduate students may file a coursework petition.');
    }
    const p = payload || {};
    const division = _requireOneOf(p.division, [DIVISION.LOWER, DIVISION.UPPER], 'Division');
    const items = _validateItems(division, p.items, user, /*resubmitOfId*/ null);

    const petitionId = DataService.generateId('CWP');
    DataService.insert(SHEET(), TAB(), {
      PetitionID: petitionId,
      StudentEmail: user,
      Division: division,
      Stage: STAGE.SUBMITTED,
      ReturnNote: '',
      IntakeBy: '', IntakeAt: '',
      ProcessedBy: '', ProcessedAt: '',
      DriveFileID: '', DocumentLink: '', FileName: '',
    });

    items.forEach(it => {
      const itemId = DataService.generateId('CWI');
      DataService.insert(SHEET(), ITEMS_TAB(), {
        ItemID: itemId,
        PetitionID: petitionId,
        TargetCourse: it.targetCourse,
        TypeCode: it.typeCode,
        InstitutionID: it.institutionId,
        InstitutionFreeText: it.institutionFreeText,
        CourseID: it.courseId,
        SyllabusFileID: '', SyllabusLink: '', SyllabusName: '',
        TranscriptFileID: '', TranscriptLink: '', TranscriptName: '',
        ReviewPath: '', Decision: '', DenialReason: '',
        DecidedBy: '', DecidedAt: '',
        MyUCSCAction: '', EnteredBy: '', EnteredAt: '',
      });
      _saveItemFile(itemId, petitionId, user, 'TRANSCRIPT', it.transcript);
      if (it.syllabus) _saveItemFile(itemId, petitionId, user, 'SYLLABUS', it.syllabus);
    });

    _routeToIntake(petitionId, user, division, /*resubmitted*/ false);
    EventBus.emit(MODULE + '.submitted', { recordId: petitionId, division: division }, { user: user });
    return {
      petitionId: petitionId,
      stage: STAGE.SUBMITTED,
      capNote: division === DIVISION.UPPER ? _capNoteFor(user) : '',
    };
  }

  /**
   * Student revises a RETURNED petition. Same record, same items (matched
   * by itemId): fields may be edited; a supplied file replaces the prior
   * upload, an omitted one is kept. Items cannot be added or removed on
   * resubmission — withdraw and file fresh for a different course set.
   * payload = { petitionId, items: [{ itemId, targetCourse?, typeCode?,
   *             institutionId?, institutionFreeText?, courseId?,
   *             transcript?, syllabus? }] }
   */
  function resubmit(payload, user, roles) {
    const p = payload || {};
    const rec = _byId(String(p.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    const isSuper = roles.indexOf('super_admin') !== -1;
    if (!isSuper && _norm(rec.StudentEmail) !== _norm(user)) {
      throw new Error('You can only revise your own petition.');
    }
    if (rec.Stage !== STAGE.RETURNED) {
      throw new Error('This petition is not awaiting revision.');
    }

    const existing = _itemsFor(rec.PetitionID);
    const byId = {};
    existing.forEach(it => { byId[String(it.ItemID)] = it; });

    const updates = Array.isArray(p.items) ? p.items : [];
    if (!updates.length) throw new Error('Nothing to resubmit.');

    // Merge each update onto its existing item, then re-validate the full
    // set exactly as a fresh submission would be (duplicate guard excludes
    // this petition's own items).
    const merged = existing.map(cur => {
      const u = updates.find(x => String((x || {}).itemId || '') === String(cur.ItemID)) || {};
      return {
        itemId: String(cur.ItemID),
        targetCourse: u.targetCourse !== undefined ? u.targetCourse : cur.TargetCourse,
        typeCode:     u.typeCode     !== undefined ? u.typeCode     : cur.TypeCode,
        institutionId: u.institutionId !== undefined ? u.institutionId : cur.InstitutionID,
        institutionFreeText: u.institutionFreeText !== undefined ? u.institutionFreeText : cur.InstitutionFreeText,
        courseId:     u.courseId     !== undefined ? u.courseId     : cur.CourseID,
        transcript:   _hasFile(u.transcript) ? u.transcript : null,
        syllabus:     _hasFile(u.syllabus)   ? u.syllabus   : null,
        _hadTranscript: !!String(cur.TranscriptFileID || '').trim(),
      };
    });
    const items = _validateItems(rec.Division, merged, rec.StudentEmail, rec.PetitionID);

    items.forEach(it => {
      DataService.update(SHEET(), ITEMS_TAB(), 'ItemID', it.itemId, {
        TargetCourse: it.targetCourse,
        TypeCode: it.typeCode,
        InstitutionID: it.institutionId,
        InstitutionFreeText: it.institutionFreeText,
        CourseID: it.courseId,
        // A revision reopens the item: any intake classification is
        // cleared so the advisor re-reviews the corrected material.
        ReviewPath: '', Decision: '', DenialReason: '', DecidedBy: '', DecidedAt: '',
      });
      if (it.transcript) _saveItemFile(it.itemId, rec.PetitionID, rec.StudentEmail, 'TRANSCRIPT', it.transcript);
      if (it.syllabus)   _saveItemFile(it.itemId, rec.PetitionID, rec.StudentEmail, 'SYLLABUS', it.syllabus);
    });

    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
      Stage: STAGE.SUBMITTED,
      ReturnNote: '',
      IntakeBy: '', IntakeAt: '',
    });

    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    _routeToIntake(rec.PetitionID, rec.StudentEmail, rec.Division, /*resubmitted*/ true);
    EventBus.emit(MODULE + '.resubmitted', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.SUBMITTED, resubmitted: true };
  }

  /** Student withdraws their own non-terminal petition (record kept). */
  function withdraw(payload, user, roles) {
    const rec = _byId(String((payload || {}).petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    const isSuper = roles.indexOf('super_admin') !== -1;
    if (!isSuper && _norm(rec.StudentEmail) !== _norm(user)) {
      throw new Error('You can only withdraw your own petition.');
    }
    if (rec.Stage === STAGE.COMPLETE || rec.Stage === STAGE.WITHDRAWN) {
      throw new Error('This petition is already closed.');
    }
    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, { Stage: STAGE.WITHDRAWN });
    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user, note: 'Withdrawn by student' });
    EventBus.emit(MODULE + '.withdrawn', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.WITHDRAWN };
  }

  /** The student's own petitions, newest first, with items. */
  function mine(payload, user, roles) {
    return DataService.query(SHEET(), TAB(), 'StudentEmail', user)
      .map(r => _publicRecord(r, /*withItems*/ true, /*reviewer*/ false))
      .sort(_byCreatedDesc);
  }

  /** One petition, permission-checked. Reviewers get precedents per item. */
  function get(payload, user, roles) {
    const rec = _byId(String((payload || {}).petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    const reviewer = _isAdvisor(roles) || _isDus(roles) || roles.indexOf('super_admin') !== -1;
    if (!reviewer && _norm(rec.StudentEmail) !== _norm(user)) {
      throw new Error('You do not have access to this petition.');
    }
    return _publicRecord(rec, true, reviewer);
  }


  // ============================================================
  // ADVISOR — intake (gatekeeping + articulation short-circuit)
  // ============================================================

  /** Petitions awaiting intake (SUBMITTED), with items + precedents. */
  function intakeQueue(payload, user, roles) {
    _assertAdvisor(roles);
    return DataService.query(SHEET(), TAB(), 'Stage', STAGE.SUBMITTED)
      .map(r => _publicRecord(r, true, true))
      .sort(_byCreatedDesc);
  }

  /**
   * Advisor completes intake: classifies every item, optionally denying
   * some (cap reached, articulation says no, etc. — terminal, same
   * vocabulary as a DUS denial; DecidedBy records who).
   *
   * payload = { petitionId, items: [{ itemId,
   *   resolution: 'ARTICULATED' | 'FACULTY_REVIEW' | 'DENY',
   *   denialReason? }] }
   *
   * Every item on the petition must receive a resolution. Routing:
   *   any FACULTY_REVIEW (undecided)      → PENDING_DUS
   *   else any APPROVED                   → PENDING_PROCESSING
   *   else (everything denied at intake)  → COMPLETE (PDF documents it)
   */
  function intakeSubmit(payload, user, roles) {
    _assertAdvisor(roles);
    const p = payload || {};
    const rec = _byId(String(p.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    if (rec.Stage !== STAGE.SUBMITTED) throw new Error('This petition is not awaiting intake.');

    const items = _itemsFor(rec.PetitionID);
    const resolutions = Array.isArray(p.items) ? p.items : [];
    const now = new Date().toISOString();

    items.forEach(it => {
      const r = resolutions.find(x => String((x || {}).itemId || '') === String(it.ItemID));
      if (!r) throw new Error('Every course line needs a resolution (missing for ' + _itemLabel(it) + ').');
      const res = String(r.resolution || '').trim().toUpperCase();

      if (res === REVIEW_PATH.ARTICULATED) {
        // The classification IS the decision: an articulated course is
        // approved on the spot and never reaches the DUS.
        DataService.update(SHEET(), ITEMS_TAB(), 'ItemID', it.ItemID, {
          ReviewPath: REVIEW_PATH.ARTICULATED,
          Decision: DECISION.APPROVED, DenialReason: '',
          DecidedBy: user, DecidedAt: now,
        });
      } else if (res === REVIEW_PATH.FACULTY_REVIEW) {
        DataService.update(SHEET(), ITEMS_TAB(), 'ItemID', it.ItemID, {
          ReviewPath: REVIEW_PATH.FACULTY_REVIEW,
          Decision: '', DenialReason: '', DecidedBy: '', DecidedAt: '',
        });
      } else if (res === 'DENY') {
        const reason = String(r.denialReason || '').trim();
        if (!reason) throw new Error('A denial needs a reason (' + _itemLabel(it) + ').');
        DataService.update(SHEET(), ITEMS_TAB(), 'ItemID', it.ItemID, {
          ReviewPath: REVIEW_PATH.FACULTY_REVIEW,   // reviewed path; denied at intake
          Decision: DECISION.DENIED, DenialReason: reason,
          DecidedBy: user, DecidedAt: now,
        });
      } else {
        throw new Error('Unknown resolution "' + res + '" for ' + _itemLabel(it) + '.');
      }
    });

    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
      IntakeBy: user, IntakeAt: now,
    });
    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });

    const stage = _routeAfterDecisions(rec.PetitionID, user);
    EventBus.emit(MODULE + '.intake_complete', { recordId: rec.PetitionID, stage: stage }, { user: user });
    return { petitionId: rec.PetitionID, stage: stage };
  }

  /**
   * Advisor returns a petition to the student — INTAKE PROBLEMS ONLY
   * (missing documents, wrong form/division, unreadable files). Only
   * available from SUBMITTED; a denial is never expressed as a return.
   */
  function returnToStudent(payload, user, roles) {
    _assertAdvisor(roles);
    const p = payload || {};
    const rec = _byId(String(p.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    if (rec.Stage !== STAGE.SUBMITTED) {
      throw new Error('Returns are for intake problems only — this petition has left intake.');
    }
    const note = String(p.note || '').trim();
    if (!note) throw new Error('Add a note telling the student what to fix.');

    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
      Stage: STAGE.RETURNED, ReturnNote: note,
    });
    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    _routeToStudentReturned(rec, note);
    EventBus.emit(MODULE + '.returned', { recordId: rec.PetitionID }, { user: user });
    return { petitionId: rec.PetitionID, stage: STAGE.RETURNED };
  }


  // ============================================================
  // DUS — faculty review of unarticulated items
  // ============================================================

  /** Petitions awaiting the director (PENDING_DUS), items + precedents. */
  function dusQueue(payload, user, roles) {
    _assertDus(roles);
    return DataService.query(SHEET(), TAB(), 'Stage', STAGE.PENDING_DUS)
      .map(r => _publicRecord(r, true, true))
      .sort(_byCreatedDesc);
  }

  /**
   * DUS decides every still-open FACULTY_REVIEW item. Terminal decisions;
   * a denial needs a reason (printed on the form and surfaced to future
   * reviewers by the precedent matcher).
   * payload = { petitionId, decisions: [{ itemId, decision, denialReason? }] }
   */
  function dusSubmit(payload, user, roles) {
    _assertDus(roles);
    const p = payload || {};
    const rec = _byId(String(p.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    if (rec.Stage !== STAGE.PENDING_DUS) throw new Error('This petition is not awaiting faculty review.');

    const open = _itemsFor(rec.PetitionID).filter(it =>
      String(it.ReviewPath) === REVIEW_PATH.FACULTY_REVIEW && !String(it.Decision || '').trim());
    if (!open.length) throw new Error('No items are awaiting a decision.');

    const decisions = Array.isArray(p.decisions) ? p.decisions : [];
    const now = new Date().toISOString();

    open.forEach(it => {
      const d = decisions.find(x => String((x || {}).itemId || '') === String(it.ItemID));
      if (!d) throw new Error('Every open course line needs a decision (missing for ' + _itemLabel(it) + ').');
      const decision = _requireOneOf(String(d.decision || '').toUpperCase(),
        [DECISION.APPROVED, DECISION.DENIED], 'Decision');
      const reason = String(d.denialReason || '').trim();
      if (decision === DECISION.DENIED && !reason) {
        throw new Error('A denial needs a reason (' + _itemLabel(it) + ').');
      }
      DataService.update(SHEET(), ITEMS_TAB(), 'ItemID', it.ItemID, {
        Decision: decision,
        DenialReason: decision === DECISION.DENIED ? reason : '',
        DecidedBy: user, DecidedAt: now,
      });
    });

    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    const stage = _routeAfterDecisions(rec.PetitionID, user);
    EventBus.emit(MODULE + '.dus_decided', { recordId: rec.PetitionID, stage: stage }, { user: user });
    return { petitionId: rec.PetitionID, stage: stage };
  }


  // ============================================================
  // ADVISOR — final processing (MyUCSC actions) + completion
  // ============================================================

  /** Petitions awaiting MyUCSC processing, items + precedents. */
  function processingQueue(payload, user, roles) {
    _assertAdvisor(roles);
    return DataService.query(SHEET(), TAB(), 'Stage', STAGE.PENDING_PROCESSING)
      .map(r => _publicRecord(r, true, true))
      .sort(_byCreatedDesc);
  }

  /**
   * Advisor records the MyUCSC action taken for each APPROVED item
   * (Other Credit Quick / Requirement Waiver / Course Directive), then
   * the petition completes: canonical PDF generated and archived, tasks
   * resolved, student notified and granted viewer on the PDF.
   * payload = { petitionId, actions: [{ itemId, myUcscAction }] }
   */
  function processSubmit(payload, user, roles) {
    _assertAdvisor(roles);
    const p = payload || {};
    const rec = _byId(String(p.petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');
    if (rec.Stage !== STAGE.PENDING_PROCESSING) {
      throw new Error('This petition is not awaiting processing.');
    }

    const approved = _itemsFor(rec.PetitionID)
      .filter(it => String(it.Decision) === DECISION.APPROVED);
    const actions = Array.isArray(p.actions) ? p.actions : [];
    const now = new Date().toISOString();
    const actionKeys = MYUCSC_ACTIONS.map(a => a.key);

    approved.forEach(it => {
      const a = actions.find(x => String((x || {}).itemId || '') === String(it.ItemID));
      if (!a) throw new Error('Record the MyUCSC action for ' + _itemLabel(it) + '.');
      const key = _requireOneOf(String(a.myUcscAction || '').toUpperCase(), actionKeys, 'MyUCSC action');
      DataService.update(SHEET(), ITEMS_TAB(), 'ItemID', it.ItemID, {
        MyUCSCAction: key, EnteredBy: user, EnteredAt: now,
      });
    });

    DataService.update(SHEET(), TAB(), 'PetitionID', rec.PetitionID, {
      ProcessedBy: user, ProcessedAt: now,
    });
    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user });
    return _complete(rec.PetitionID, user);
  }

  /**
   * Every petition, newest first — the advisor's/DUS's management and
   * history view (search/filter client-side). super_admin also reaches
   * deletable records here.
   */
  function allPetitions(payload, user, roles) {
    if (!_isAdvisor(roles) && !_isDus(roles) && roles.indexOf('super_admin') === -1) {
      throw new Error('Not authorized.');
    }
    return DataService.getAll(SHEET(), TAB())
      .map(r => _publicRecord(r, true, true))
      .sort(_byCreatedDesc);
  }

  /**
   * Prior decided items matching a course + institution — the precedent
   * view. Reviewer-facing ONLY (advisor / DUS / super_admin); students
   * never see other students' records.
   * payload = { courseId, institutionId?, institutionText? }
   */
  function precedents(payload, user, roles) {
    if (!_isAdvisor(roles) && !_isDus(roles) && roles.indexOf('super_admin') === -1) {
      throw new Error('Not authorized.');
    }
    const p = payload || {};
    return _precedentsFor(p.courseId, p.institutionId, p.institutionText, /*excludeItemId*/ '');
  }

  /** super_admin test cleanup: removes the record, items, uploads, tasks. */
  function deletePetition(payload, user, roles) {
    if (roles.indexOf('super_admin') === -1) {
      throw new Error('Only a super admin can delete a petition.');
    }
    const rec = _byId(String((payload || {}).petitionId || '').trim());
    if (!rec) throw new Error('Petition not found.');

    _itemsFor(rec.PetitionID).forEach(it => {
      _trashFile(it.SyllabusFileID);
      _trashFile(it.TranscriptFileID);
      DataService.remove(SHEET(), ITEMS_TAB(), 'ItemID', it.ItemID);
    });
    _trashFile(rec.DriveFileID);
    Tasks.resolveForSource(MODULE, rec.PetitionID, { resolvedBy: user, note: 'Petition deleted' });
    DataService.remove(SHEET(), TAB(), 'PetitionID', rec.PetitionID);
    return { petitionId: rec.PetitionID, deleted: true };
  }


  // ============================================================
  // PRIVATE — routing after decisions, completion, PDF
  // ============================================================

  /**
   * After a decision pass (intake or DUS), route the petition by the
   * state of its items:
   *   any FACULTY_REVIEW item with no decision → PENDING_DUS
   *   else any APPROVED item                   → PENDING_PROCESSING
   *   else (all denied)                        → COMPLETE (PDF documents it)
   */
  function _routeAfterDecisions(petitionId, user) {
    const items = _itemsFor(petitionId);
    const anyOpen = items.some(it =>
      String(it.ReviewPath) === REVIEW_PATH.FACULTY_REVIEW && !String(it.Decision || '').trim());
    if (anyOpen) {
      DataService.update(SHEET(), TAB(), 'PetitionID', petitionId, { Stage: STAGE.PENDING_DUS });
      _routeToDus(petitionId);
      return STAGE.PENDING_DUS;
    }
    const anyApproved = items.some(it => String(it.Decision) === DECISION.APPROVED);
    if (anyApproved) {
      DataService.update(SHEET(), TAB(), 'PetitionID', petitionId, { Stage: STAGE.PENDING_PROCESSING });
      _routeToProcessing(petitionId);
      return STAGE.PENDING_PROCESSING;
    }
    // Everything denied — nothing to process in MyUCSC; close it out.
    const out = _complete(petitionId, user);
    return out.stage;
  }

  /** Terminal completion: PDF once, archive, notify + share with student. */
  function _complete(petitionId, user) {
    DataService.update(SHEET(), TAB(), 'PetitionID', petitionId, { Stage: STAGE.COMPLETE });
    const rec = _byId(petitionId);   // re-read: ProcessedBy/At now populated

    let pdf = null;
    try {
      pdf = _generatePetitionPdf(rec, user);
      DataService.update(SHEET(), TAB(), 'PetitionID', petitionId, {
        DriveFileID: pdf.fileId || '',
        DocumentLink: pdf.url || '',
        FileName: pdf.fileName || '',
      });
      if (pdf.fileId) _grantViewers(pdf.fileId, _fileAudience(rec.StudentEmail));
    } catch (e) {
      // The workflow outcome stands even if the PDF pipeline hiccups; the
      // failure is logged and the record can be regenerated later.
      Logger.log('CourseworkPetitionModule._complete: PDF failed for ' + petitionId + ': ' + e);
    }

    _notifyStudentComplete(_byId(petitionId), pdf);
    EventBus.emit(MODULE + '.completed', { recordId: petitionId }, { user: user });
    return { petitionId: petitionId, stage: STAGE.COMPLETE,
             pdfUrl: (pdf && pdf.url) || '' };
  }

  function _generatePetitionPdf(rec, user) {
    const student = Auth.getProfile(rec.StudentEmail) || {};
    const term = _completionTerm();
    return ReportService.generate({
      module: MODULE,
      reportKey: 'petition',
      title: 'Coursework Petition — ' + (student.name || rec.StudentEmail),
      sourceId: rec.PetitionID,
      params: { petitionId: rec.PetitionID, division: rec.Division },
      html: _petitionHtml(rec, student),
      fileName: _buildFileName(rec, student, term),
      orientation: 'portrait',
      letterhead: false,        // self-contained campus-form layout
      footerText: '',
    }, user);
  }

  /**
   * Completion-term quarter/year (petitions aren't term-bound; the term
   * in which the petition COMPLETES anchors the filename, per convention).
   */
  function _completionTerm() {
    const now = new Date();
    const m = now.getMonth() + 1;
    let quarter;
    if (m <= 3) quarter = 'Winter';
    else if (m <= 6) quarter = 'Spring';
    else if (m <= 8) quarter = 'Summer';
    else quarter = 'Fall';
    return { quarter: quarter, year: String(now.getFullYear()) };
  }

  /** <Year>-<Quarter>_<StudentID>-CWP-<L|U>_Last-First.pdf */
  function _buildFileName(rec, student, term) {
    const div = rec.Division === DIVISION.UPPER ? 'U' : 'L';
    const last  = _slug(student.lastName)  || 'Last';
    const first = _slug(student.firstName) || 'First';
    return term.year + '-' + term.quarter + '_' + (student.studentId || 'NOID')
      + '-CWP-' + div + '_' + last + '-' + first + '.pdf';
  }

  /**
   * Campus-form layout mirroring the DocuSign originals: student block,
   * one block per course line (type, institution, course, documents,
   * decision), the Director-of-Undergraduate-Studies signature block
   * (name/email/timestamp in lieu of signature — omitted when every item
   * resolved at intake), and the "Entered into Academic Advisement
   * Report" block. Table-based markup for the HTML→Doc→PDF pipeline.
   */
  function _petitionHtml(rec, student) {
    const navy = (CONFIG.BRAND && CONFIG.BRAND.NAVY) || '#003C6C';
    const e = _esc;
    const items = _itemsFor(rec.PetitionID);
    const lower = rec.Division !== DIVISION.UPPER;

    const row = (label, value) =>
      '<tr><td style="padding:3px 10px 3px 0;color:#555;white-space:nowrap;vertical-align:top;">' + e(label) +
      '</td><td style="padding:3px 0;vertical-align:top;">' + (value || '&mdash;') + '</td></tr>';

    const sig = (who, email, at, verb) => {
      if (!who && !email) return '&mdash;';
      const profile = email ? Auth.getProfile(email) : null;
      const name = (profile && profile.name) || who || email;
      return e(name) + (email ? ' &lt;' + e(email) + '&gt;' : '') +
        (at ? '<br><span style="color:#777;font-size:9pt;">' + e(verb || 'Signed') + ' ' + e(_fmtDate(at)) + '</span>' : '');
    };

    const dusItems = items.filter(it => String(it.ReviewPath) === REVIEW_PATH.FACULTY_REVIEW
      && String(it.DecidedBy || '').trim());
    // The most recent DUS-path decider stamps the signature block. Items
    // denied by the ADVISOR at intake also ride this path; DecidedBy on
    // each item block below keeps the per-item attribution honest.
    const lastDecided = dusItems.length ? dusItems[dusItems.length - 1] : null;

    const itemBlocks = items.map((it, idx) => {
      const typeLabel = _typeLabel(rec.Division, it.TypeCode);
      const heading = lower
        ? _lowerTargetLabel(it.TargetCourse)
        : 'Course #' + (idx + 1);
      let decision = '&mdash;';
      if (String(it.Decision) === DECISION.APPROVED) {
        decision = 'APPROVED' + (String(it.ReviewPath) === REVIEW_PATH.ARTICULATED
          ? ' — Existing Articulation Agreement' : ' — Faculty Review');
      } else if (String(it.Decision) === DECISION.DENIED) {
        decision = 'DENIED';
      }
      return ''
        + '<div style="border:1px solid #ccc;border-left:3px solid ' + navy + ';padding:8px 10px;margin-bottom:10px;">'
        + '<div style="font-size:10.5pt;font-weight:bold;color:' + navy + ';margin-bottom:4px;">' + e(heading) + '</div>'
        + '<table style="width:100%;border-collapse:collapse;">'
        +   row(lower ? 'Institution type' : 'Course type', e(typeLabel))
        +   row('Course sponsoring institution', e(_institutionLabelFor(it)))
        +   row('Course ID', e(it.CourseID))
        +   row('Supporting documents',
              'Syllabus: ' + (String(it.SyllabusFileID || '').trim() ? 'on file' : '&mdash;')
              + ' &nbsp;·&nbsp; Transcript: ' + (String(it.TranscriptFileID || '').trim() ? 'on file' : '&mdash;'))
        +   row('Decision', decision)
        +   (String(it.Decision) === DECISION.DENIED
              ? row('Reason for denial', e(it.DenialReason)) : '')
        +   (String(it.DecidedBy || '').trim()
              ? row('Decided by', sig('', it.DecidedBy, it.DecidedAt, 'Decided')) : '')
        +   (String(it.MyUCSCAction || '').trim()
              ? row('MyUCSC action', e(_myUcscLabel(it.MyUCSCAction))) : '')
        + '</table>'
        + '</div>';
    }).join('');

    return ''
      + '<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:10pt;line-height:1.4;">'
      + '<div style="border-bottom:3px solid ' + navy + ';padding-bottom:8px;margin-bottom:12px;">'
      +   '<div style="font-size:9pt;color:#555;">University of California, Santa Cruz · Department of Anthropology</div>'
      +   '<div style="font-size:15pt;font-weight:bold;color:' + navy + ';">Anthropology Undergraduate Coursework Petition — '
      +     (lower ? 'Lower Division Courses' : 'Upper Division Electives') + '</div>'
      + '</div>'

      + '<table style="width:100%;border-collapse:collapse;margin-bottom:10px;">'
      +   row('Student name', e(student.name || rec.StudentEmail))
      +   row('Student ID', e(student.studentId || ''))
      +   row('UCSC email', e(rec.StudentEmail))
      +   (lower ? '' : row('Number of courses petitioned', String(items.length)))
      + '</table>'

      + itemBlocks

      + '<div style="border:1px solid #ccc;border-left:3px solid ' + navy + ';padding:8px 10px;margin-bottom:10px;">'
      + '<div style="font-size:9pt;font-weight:bold;color:' + navy + ';text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Director of Undergraduate Studies</div>'
      + '<table style="width:100%;border-collapse:collapse;">'
      +   row('Signature', lastDecided
            ? sig('', lastDecided.DecidedBy, lastDecided.DecidedAt, 'Decided')
            : 'Not required — all courses resolved by existing articulation agreements at intake')
      + '</table>'
      + '</div>'

      + '<div style="border:1px solid #ccc;border-left:3px solid ' + navy + ';padding:8px 10px;">'
      + '<div style="font-size:9pt;font-weight:bold;color:' + navy + ';text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Entered into Academic Advisement Report</div>'
      + '<table style="width:100%;border-collapse:collapse;">'
      +   row('Entered by', rec.ProcessedBy
            ? sig('', rec.ProcessedBy, rec.ProcessedAt, 'Entered')
            : 'Not applicable — no approved courses to process')
      + '</table>'
      + '</div>'
      + '</div>';
  }


  // ============================================================
  // PRIVATE — routing: Tasks + Notify at each handoff
  // ============================================================

  function _routeToIntake(petitionId, studentEmail, division, resubmitted) {
    const student = _studentLabel(studentEmail);
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: petitionId,
      label: 'Coursework petition awaiting intake — ' + student
        + (resubmitted ? ' (resubmitted)' : ''),
      assignedRole: ADVISOR_ROLE,
    });
    _mailPool(_roleEmails(ADVISOR_ROLE),
      'Coursework petition ' + (resubmitted ? 'resubmitted' : 'submitted'),
      [
        student + ' has ' + (resubmitted ? 'revised and resubmitted' : 'submitted')
          + ' a ' + (division === DIVISION.UPPER ? 'upper-division elective' : 'lower-division')
          + ' coursework petition.',
        '',
        'Review it in the portal (Intake tab).' + _deepLinkLine(petitionId),
      ]);
  }

  function _routeToDus(petitionId) {
    const rec = _byId(petitionId);
    const student = _studentLabel(rec.StudentEmail);
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: petitionId,
      label: 'Coursework petition awaiting faculty review — ' + student,
      assignedRole: DUS_ROLE,
    });
    _mailPool(_roleEmails(DUS_ROLE),
      'Coursework petition awaiting your review',
      [
        'A coursework petition from ' + student + ' has courses that need faculty review',
        '(the remaining courses, if any, were resolved by existing articulation agreements).',
        '',
        'Review it in the portal (Faculty Review tab).' + _deepLinkLine(petitionId),
      ]);
  }

  function _routeToProcessing(petitionId) {
    const rec = _byId(petitionId);
    const student = _studentLabel(rec.StudentEmail);
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: petitionId,
      label: 'Coursework petition ready for MyUCSC processing — ' + student,
      assignedRole: ADVISOR_ROLE,
    });
    _mailPool(_roleEmails(ADVISOR_ROLE),
      'Coursework petition ready for processing',
      [
        'All decisions are in for ' + student + '\'s coursework petition.',
        'Record the MyUCSC actions to complete it (Processing tab).' + _deepLinkLine(petitionId),
      ]);
  }

  function _routeToStudentReturned(rec, note) {
    Tasks.create({
      module: MODULE, sourceType: SOURCE_TYPE, sourceId: rec.PetitionID,
      label: 'Your coursework petition needs revisions',
      assignedTo: rec.StudentEmail,
    });
    // The editable intro (Settings tab), then the essentials that are
    // always appended: the advisor's note and the resubmission path.
    Notify.send({
      to: rec.StudentEmail,
      subject: 'Your coursework petition was returned',
      body: _fillTokens(_notifyTemplate('NOTIFY_RETURNED'), rec) + '\n\n'
        + 'What to fix: ' + note + '\n\n'
        + 'Revise and resubmit in the portal (My Petitions).'
        + _deepLinkLine(rec.PetitionID),
      replyTo: Settings.replyTo(MODULE),
    });
  }

  function _notifyStudentComplete(rec, pdf) {
    try {
      const items = _itemsFor(rec.PetitionID);
      // The editable intro (Settings tab), then the essentials that are
      // always appended: per-course outcomes, the PDF link, the AAR line.
      const lines = [_fillTokens(_notifyTemplate('NOTIFY_COMPLETE'), rec), ''];
      let anyApproved = false;
      items.forEach(it => {
        const name = (rec.Division === DIVISION.UPPER)
          ? (it.CourseID + ' (' + _institutionLabelFor(it) + ')')
          : _lowerTargetLabel(it.TargetCourse);
        if (String(it.Decision) === DECISION.APPROVED) {
          anyApproved = true;
          lines.push('• ' + name + ' — APPROVED');
        } else {
          lines.push('• ' + name + ' — DENIED'
            + (String(it.DenialReason || '').trim() ? ' (' + it.DenialReason + ')' : ''));
        }
      });
      lines.push('');
      if (pdf && pdf.url) lines.push('Your completed petition (save for your records): ' + pdf.url);
      if (anyApproved) {
        lines.push('Approved courses have been recorded in your Academic Advisement Report.');
      }
      Notify.send({
        to: rec.StudentEmail,
        subject: 'Your coursework petition is complete',
        body: lines.join('\n') + _deepLinkLine(rec.PetitionID),
        replyTo: Settings.replyTo(MODULE),
      });
    } catch (e) {
      Logger.log('CourseworkPetitionModule._notifyStudentComplete: ' + e);
    }
  }

  /** Best-effort pool mail; a mail failure never breaks the workflow. */
  function _mailPool(emails, subject, lines) {
    try {
      const to = Notify.resolveRecipients({ superAdmins: [], explicit: emails || [] });
      if (!to.length) return;
      Notify.send({ to: to, subject: subject, body: lines.join('\n'),
                    replyTo: Settings.replyTo(MODULE) });
    } catch (e) {
      Logger.log('CourseworkPetitionModule._mailPool: ' + e);
    }
  }

  /** Active holders of a role — the pool-email pattern (Auth.listUsers). */
  function _roleEmails(role) {
    try {
      return Auth.listUsers()
        .filter(u => u.active && (u.roles || []).indexOf(role) !== -1)
        .map(u => u.email);
    } catch (e) {
      Logger.log('CourseworkPetitionModule._roleEmails(' + role + '): ' + e);
      return [];
    }
  }

  function _deepLinkLine(petitionId) {
    try {
      if (typeof Links !== 'undefined' && Links && Links.deepLink) {
        // The focus token lands in window.__focus; the module's init()
        // fetches that petition and opens its detail view.
        const url = Links.deepLink(MODULE, String(petitionId || '')) || '';
        if (url) return '\n\nPetition: ' + url;
      }
    } catch (e) { /* link is a nicety, never required */ }
    return '';
  }


  // ── Settings storage (CourseworkSettings key/value tab) ─────

  /**
   * Effective settings: defaults overlaid with any NON-BLANK stored
   * values. Tolerates a missing tab (fresh deployment before setUp is
   * re-run) by returning pure defaults — the module keeps working.
   */
  function _readSettings() {
    const out = {
      NOTIFY_RETURNED: NOTIFY_DEFAULTS.NOTIFY_RETURNED,
      NOTIFY_COMPLETE: NOTIFY_DEFAULTS.NOTIFY_COMPLETE,
    };
    try {
      DataService.getAll(SHEET(), SETTINGS_TAB()).forEach(r => {
        const k = String(r.Key || '').trim();
        const v = String(r.Value != null ? r.Value : '');
        if (k && Object.prototype.hasOwnProperty.call(out, k) && v.trim()) out[k] = v;
      });
    } catch (e) {
      Logger.log('CourseworkPetitionModule._readSettings (using defaults): ' + e);
    }
    return out;
  }

  function _notifyTemplate(key) {
    return _readSettings()[key] || NOTIFY_DEFAULTS[key] || '';
  }

  /** Update-or-insert one key in the settings tab. */
  function _writeSettingsKey(key, value) {
    const existing = DataService.query(SHEET(), SETTINGS_TAB(), 'Key', key);
    if (existing && existing.length) {
      DataService.update(SHEET(), SETTINGS_TAB(), 'Key', key, { Value: value });
    } else {
      DataService.insert(SHEET(), SETTINGS_TAB(), { Key: key, Value: value });
    }
  }

  /** '' when the edited text is blank or identical to the default (so the
   *  code default keeps applying); otherwise the trimmed custom text. */
  function _storableTemplate(text, defaultText) {
    const t = String(text == null ? '' : text).trim();
    if (!t || t === String(defaultText).trim()) return '';
    return t;
  }

  /** Fill notification tokens from the petition's student profile. */
  function _fillTokens(tmpl, rec) {
    const profile = Auth.getProfile(rec.StudentEmail) || {};
    const division = String(rec.Division) === DIVISION.UPPER
      ? 'upper-division' : 'lower-division';
    return String(tmpl || '')
      .replace(/\{FirstName\}/g, profile.firstName || profile.name || 'student')
      .replace(/\{Name\}/g, profile.name || String(rec.StudentEmail || ''))
      .replace(/\{Division\}/g, division);
  }


  // ============================================================
  // PRIVATE — validation, duplicate guard, cap, precedents
  // ============================================================

  /**
   * Validates a full item set for a division and returns normalized
   * items. Applies the duplicate guard per item (excluding the items of
   * resubmitOfId, so a revision never collides with itself).
   */
  function _validateItems(division, rawItems, studentEmail, resubmitOfId) {
    const arr = Array.isArray(rawItems) ? rawItems : [];
    if (!arr.length) throw new Error('Add at least one course to the petition.');

    const lower = division === DIVISION.LOWER;
    if (lower && arr.length > 3) throw new Error('A lower-division petition covers at most ANTH 1, 2, and 3.');
    if (!lower && arr.length > 2) throw new Error('An upper-division petition covers at most two courses.');

    const typeKeys = (lower ? LOWER_TYPES : UPPER_TYPES).map(t => t.key);
    const targetKeys = LOWER_TARGETS.map(t => t.key);
    const instMap = _institutionMap();
    const seenTargets = {};

    const items = arr.map((raw, idx) => {
      const r = raw || {};
      const label = lower
        ? _lowerTargetLabel(String(r.targetCourse || '').trim())
        : 'Course #' + (idx + 1);

      let targetCourse;
      if (lower) {
        targetCourse = _requireOneOf(String(r.targetCourse || '').trim().toUpperCase(),
          targetKeys, 'Target course');
        if (seenTargets[targetCourse]) {
          throw new Error('Each of ANTH 1, 2, and 3 may appear only once on a petition.');
        }
        seenTargets[targetCourse] = true;
      } else {
        targetCourse = UPPER_TARGET;
      }

      const typeCode = _requireOneOf(String(r.typeCode || '').trim().toUpperCase(),
        typeKeys, (lower ? 'Institution type' : 'Course type') + ' (' + label + ')');

      const courseId = String(r.courseId || '').trim();
      if (!courseId) throw new Error('Enter the course ID for ' + label + ' (e.g. "ANTH ' + (lower ? '1' : '101') + '").');

      // Institution: exactly one of reference-list id / free text.
      const institutionId = String(r.institutionId || '').trim();
      const freeText = String(r.institutionFreeText || '').trim();
      if (institutionId && freeText) {
        throw new Error('Pick a listed institution OR type one, not both (' + label + ').');
      }
      if (!institutionId && !freeText) {
        throw new Error('Name the course-sponsoring institution for ' + label + '.');
      }
      if (institutionId) {
        const inst = instMap[institutionId];
        if (!inst || !_isTrueStr(inst.Active)) {
          throw new Error('The selected institution is not on the active list (' + label + ').');
        }
        // Lower-division items must come from CCC / four-year / OOS-CC
        // institutions; upper items may use any listed institution
        // (course TYPE and institution type are independent there).
        if (lower && LOWER_INST_TYPES.indexOf(String(inst.Type)) === -1) {
          throw new Error('Lower-division petitions accept community-college or four-year institutions only (' + label + ').');
        }
      }

      // Transcript required. On resubmission, an item that already has
      // one on file may omit a re-upload.
      const hasNewTranscript = _hasFile(r.transcript);
      if (!hasNewTranscript && !r._hadTranscript) {
        throw new Error('Attach the transcript for ' + label + '.');
      }
      _assertPdf(r.transcript, 'Transcript (' + label + ')');
      _assertPdf(r.syllabus, 'Syllabus (' + label + ')');

      return {
        itemId: String(r.itemId || ''),
        targetCourse: targetCourse,
        typeCode: typeCode,
        institutionId: institutionId,
        institutionFreeText: freeText,
        courseId: courseId,
        transcript: hasNewTranscript ? r.transcript : null,
        syllabus: _hasFile(r.syllabus) ? r.syllabus : null,
      };
    });

    // Duplicate guard: per item, against the student's other items.
    items.forEach(it => _assertNoDuplicate(studentEmail, it, resubmitOfId));

    // No same-course-same-institution twice WITHIN this petition either.
    const keys = {};
    items.forEach(it => {
      const k = _dupKey(it.courseId, it.institutionId, it.institutionFreeText, _institutionMap());
      if (keys[k]) throw new Error('The same course from the same institution appears twice on this petition.');
      keys[k] = true;
    });

    return items;
  }

  /**
   * Duplicate guard. Blocks a new item whose (courseId, institution)
   * matches one of the student's existing items when that item is
   * APPROVED (nothing to gain from re-approving) or its petition is
   * still open (pending or returned — revise that one instead). DENIED
   * and WITHDRAWN matches may be re-filed.
   */
  function _assertNoDuplicate(studentEmail, item, excludePetitionId) {
    const instMap = _institutionMap();
    const key = _dupKey(item.courseId, item.institutionId, item.institutionFreeText, instMap);

    const myPetitions = DataService.query(SHEET(), TAB(), 'StudentEmail', studentEmail);
    const stageById = {};
    myPetitions.forEach(r => { stageById[String(r.PetitionID)] = String(r.Stage); });

    const allItems = DataService.getAll(SHEET(), ITEMS_TAB());
    allItems.forEach(ex => {
      const pid = String(ex.PetitionID);
      if (!stageById[pid]) return;                          // another student's
      if (excludePetitionId && pid === String(excludePetitionId)) return;
      if (_dupKey(ex.CourseID, ex.InstitutionID, ex.InstitutionFreeText, instMap) !== key) return;

      if (String(ex.Decision) === DECISION.APPROVED) {
        throw new Error('You already have an approved petition for ' + item.courseId
          + ' from this institution.');
      }
      const stage = stageById[pid];
      if (OPEN_STAGES.indexOf(stage) !== -1 && String(ex.Decision) !== DECISION.DENIED) {
        throw new Error('You already have a petition in progress for ' + item.courseId
          + ' from this institution' + (stage === STAGE.RETURNED
            ? ' — revise that returned petition instead of filing a new one.' : '.'));
      }
    });
  }

  /** Canonical (course, institution) key for the duplicate guard. */
  function _dupKey(courseId, institutionId, freeText, instMap) {
    const course = _normText(courseId);
    const id = String(institutionId || '').trim();
    // A listed institution matches by id AND by its normalized name, so a
    // free-text "Cabrillo College" collides with the listed one after
    // promotion — the guard doesn't loosen when the list catches up.
    let inst;
    if (id && instMap[id]) inst = 'name:' + _normText(instMap[id].Name);
    else if (id) inst = 'id:' + id;
    else inst = 'name:' + _normText(freeText);
    return course + '||' + inst;
  }

  /** Count of the student's APPROVED upper-division elective items. */
  function _approvedUdCount(studentEmail) {
    const mine = DataService.query(SHEET(), TAB(), 'StudentEmail', studentEmail);
    const ids = {};
    mine.forEach(r => { ids[String(r.PetitionID)] = true; });
    return DataService.getAll(SHEET(), ITEMS_TAB()).filter(it =>
      ids[String(it.PetitionID)] &&
      String(it.TargetCourse) === UPPER_TARGET &&
      String(it.Decision) === DECISION.APPROVED).length;
  }

  function _capNoteFor(studentEmail) {
    const n = _approvedUdCount(studentEmail);
    return 'You have ' + n + ' of ' + UD_CAP_ITEMS
      + ' allowed upper-division elective courses (10 credits) already approved.';
  }

  /**
   * Decided items (approved AND denied — a prior denial with its reason
   * is exactly what saves re-litigating) matching a course+institution.
   * Cross-student by design; reviewer-facing only, enforced by callers.
   */
  function _precedentsFor(courseId, institutionId, institutionText, excludeItemId) {
    const instMap = _institutionMap();
    const key = _dupKey(courseId, institutionId, institutionText, instMap);
    const petById = {};
    DataService.getAll(SHEET(), TAB()).forEach(r => { petById[String(r.PetitionID)] = r; });

    return DataService.getAll(SHEET(), ITEMS_TAB())
      .filter(it =>
        String(it.ItemID) !== String(excludeItemId || '') &&
        String(it.Decision || '').trim() &&
        _dupKey(it.CourseID, it.InstitutionID, it.InstitutionFreeText, instMap) === key)
      .map(it => {
        const pet = petById[String(it.PetitionID)] || {};
        return {
          itemId: String(it.ItemID),
          courseId: _plainStr(it.CourseID),
          institution: _institutionLabelFor(it),
          targetCourse: _plainStr(it.TargetCourse),
          division: _plainStr(pet.Division),
          decision: _plainStr(it.Decision),
          denialReason: _plainStr(it.DenialReason),
          reviewPath: _plainStr(it.ReviewPath),
          decidedBy: _plainStr(it.DecidedBy),
          decidedAt: _fmtDate(it.DecidedAt),
        };
      })
      .sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)));
  }


  // ============================================================
  // PRIVATE — uploads (syllabus / transcript per item)
  // ============================================================

  function _hasFile(f) {
    return !!(f && String(f.dataBase64 || '').trim());
  }

  function _assertPdf(f, label) {
    if (!_hasFile(f)) return;
    const mime = String(f.mimeType || 'application/pdf');
    if (mime.indexOf('pdf') === -1) throw new Error(label + ' must be a PDF file.');
  }

  /**
   * Save an item's supporting document (kind: 'TRANSCRIPT' | 'SYLLABUS').
   * Replace-in-place best effort (trash prior + create fresh — DriveApp
   * can't overwrite bytes without Advanced Drive); grants the student
   * viewer. Best-effort: a file failure never blocks the submit it rides
   * along with — it is logged, and the intake return loop catches gaps.
   */
  function _saveItemFile(itemId, petitionId, studentEmail, kind, f) {
    if (!_hasFile(f)) return;
    try {
      const folderId = String((CONFIG.COURSEWORK && CONFIG.COURSEWORK.DRIVE_FOLDER_ID) || '').trim();
      if (!folderId) { Logger.log('CourseworkPetitionModule: no Drive folder configured.'); return; }

      const item = _itemById(itemId);
      if (!item) return;
      const isTranscript = kind === 'TRANSCRIPT';
      const name = petitionId + '_' + itemId + '_' + kind + '.pdf';
      const bytes = Utilities.base64Decode(String(f.dataBase64));
      const blob = Utilities.newBlob(bytes, 'application/pdf', name);
      const folder = DriveApp.getFolderById(folderId);

      const priorId = String((isTranscript ? item.TranscriptFileID : item.SyllabusFileID) || '').trim();
      const fresh = folder.createFile(blob);
      if (priorId) {
        try { DriveApp.getFileById(priorId).setTrashed(true); } catch (e) { /* already gone */ }
      }
      const fileId = fresh.getId();
      const link = 'https://drive.google.com/file/d/' + fileId + '/view';
      const patch = isTranscript
        ? { TranscriptFileID: fileId, TranscriptLink: link, TranscriptName: name }
        : { SyllabusFileID: fileId, SyllabusLink: link, SyllabusName: name };
      DataService.update(SHEET(), ITEMS_TAB(), 'ItemID', itemId, patch);
      // Student + both reviewer pools (see the access-model note above).
      _grantViewers(fileId, _fileAudience(studentEmail));
    } catch (e) {
      Logger.log('CourseworkPetitionModule._saveItemFile(' + kind + ') failed for ' + itemId + ': ' + e);
    }
  }

  /**
   * ACCESS MODEL — per-file, never folder-level.
   *
   * Every file this module creates (uploaded transcripts and syllabi, and
   * the generated petition PDF) is readable by exactly three parties: the
   * student who filed it, every active staff_undergrad, and every active
   * undergrad_director. Reviewers legitimately see ALL petitions, but the
   * grant is still made file by file — students must never receive folder
   * access (they would see every other student's documents), and the
   * generated PDFs live in ReportService's shared archive folder, whose
   * siblings hold other modules' reports.
   *
   * Grants capture whoever holds the roles AT THAT MOMENT, so a person
   * added to a role later has no access to earlier files. That gap is
   * closed by syncDocumentAccess() (Settings → Document access), which
   * re-grants every file in the module to the current role holders.
   *
   * Returns the reviewer audience: active holders of either role.
   */
  function _reviewerEmails() {
    const out = [];
    const seen = {};
    [ADVISOR_ROLE, DUS_ROLE].forEach(role => {
      _roleEmails(role).forEach(e => {
        const key = String(e || '').trim().toLowerCase();
        if (!key || seen[key]) return;
        seen[key] = true;
        out.push(e);
      });
    });
    return out;
  }

  /** The full audience for one petition's files: student + both pools. */
  function _fileAudience(studentEmail) {
    return [studentEmail].concat(_reviewerEmails());
  }

  /**
   * Grants read access on a file to several people (deduped
   * case-insensitively, blanks dropped). Each grant is best-effort and
   * silent; one failure never blocks the others.
   */
  function _grantViewers(fileId, emails) {
    const seen = {};
    (emails || []).forEach(e => {
      const email = String(e || '').trim();
      if (!email) return;
      const key = email.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      _grantStudentViewer(fileId, email);
    });
  }

  /**
   * Grants one person read access without a notification email. Uses the
   * Advanced Drive Service when available (v3 then v2 shapes); falls back
   * to DriveApp.addViewer (which does notify). Best-effort, never throws.
   * Idempotent — re-granting an existing viewer is a no-op.
   */
  function _grantStudentViewer(fileId, studentEmail) {
    const id = String(fileId || '').trim();
    const email = String(studentEmail || '').trim();
    if (!id || !email) return;
    try {
      if (typeof Drive !== 'undefined' && Drive && Drive.Permissions) {
        if (typeof Drive.Permissions.create === 'function') {          // v3
          Drive.Permissions.create(
            { role: 'reader', type: 'user', emailAddress: email },
            id, { sendNotificationEmail: false });
          return;
        }
        if (typeof Drive.Permissions.insert === 'function') {          // v2
          Drive.Permissions.insert(
            { role: 'reader', type: 'user', value: email },
            id, { sendNotificationEmails: false });
          return;
        }
      }
      DriveApp.getFileById(id).addViewer(email);
    } catch (e) {
      Logger.log('CourseworkPetitionModule._grantStudentViewer: could not share ' + id + ' with ' + email + ': ' + e);
    }
  }

  function _trashFile(fileId) {
    const id = String(fileId || '').trim();
    if (!id) return;
    try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* already gone */ }
  }


  // ============================================================
  // PRIVATE — record shaping (serialization-safe), lookups, misc
  // ============================================================

  function _byId(petitionId) {
    const id = String(petitionId || '').trim();
    if (!id) return null;
    const found = DataService.query(SHEET(), TAB(), 'PetitionID', id);
    return found && found.length ? found[0] : null;
  }

  function _itemById(itemId) {
    const id = String(itemId || '').trim();
    if (!id) return null;
    const found = DataService.query(SHEET(), ITEMS_TAB(), 'ItemID', id);
    return found && found.length ? found[0] : null;
  }

  function _itemsFor(petitionId) {
    return DataService.query(SHEET(), ITEMS_TAB(), 'PetitionID', String(petitionId));
  }

  function _activeInstitutions() {
    return DataService.getAll(SHEET(), INST_TAB())
      .filter(r => _isTrueStr(r.Active))
      .map(_publicInstitution)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function _publicInstitution(r) {
    return {
      institutionId: _plainStr(r.InstitutionID),
      name: _plainStr(r.Name),
      type: _plainStr(r.Type),
      typeLabel: _instTypeLabel(r.Type),
      assistLink: _plainStr(r.AssistLink),
      active: _isTrueStr(r.Active),
      notes: _plainStr(r.Notes),
    };
  }

  function _institutionMap() {
    const map = {};
    DataService.getAll(SHEET(), INST_TAB()).forEach(r => {
      map[String(r.InstitutionID)] = r;
    });
    return map;
  }

  function _institutionLabelFor(item) {
    const id = String(item.InstitutionID || '').trim();
    if (id) {
      const inst = _institutionMap()[id];
      if (inst) return _plainStr(inst.Name);
    }
    return _plainStr(item.InstitutionFreeText);
  }

  /**
   * Public petition shape (all plain strings — the Date landmine).
   * reviewer=true adds decider identities, precedents per item, and the
   * student's cap status; the student view omits other-student data.
   */
  function _publicRecord(rec, withItems, reviewer) {
    const student = Auth.getProfile(rec.StudentEmail) || {};
    const out = {
      petitionId: _plainStr(rec.PetitionID),
      studentEmail: _plainStr(rec.StudentEmail),
      studentName: student.name || _plainStr(rec.StudentEmail),
      studentId: reviewer ? (student.studentId || '') : '',
      division: _plainStr(rec.Division),
      stage: _plainStr(rec.Stage),
      returnNote: _plainStr(rec.ReturnNote),
      intakeBy: reviewer ? _plainStr(rec.IntakeBy) : '',
      intakeAt: _fmtDate(rec.IntakeAt),
      processedBy: reviewer ? _plainStr(rec.ProcessedBy) : '',
      processedAt: _fmtDate(rec.ProcessedAt),
      documentLink: _plainStr(rec.DocumentLink),
      fileName: _plainStr(rec.FileName),
      createdAt: _fmtDate(rec.CreatedAt),
      _created: rec.CreatedAt ? new Date(rec.CreatedAt).getTime() : 0,
    };
    if (reviewer && String(rec.Division) === DIVISION.UPPER) {
      const n = _approvedUdCount(rec.StudentEmail);
      out.capApproved = n;
      out.capLimit = UD_CAP_ITEMS;
      out.capWarning = (n + _itemsFor(rec.PetitionID).filter(it =>
        !String(it.Decision || '').trim()).length) > UD_CAP_ITEMS
        ? ('This student already has ' + n + ' of ' + UD_CAP_ITEMS
          + ' allowed upper-division elective courses approved — approving '
          + 'everything here would exceed the 10-credit cap.')
        : '';
    }
    if (withItems) {
      out.items = _itemsFor(rec.PetitionID).map(it => {
        const item = {
          itemId: _plainStr(it.ItemID),
          targetCourse: _plainStr(it.TargetCourse),
          targetLabel: String(rec.Division) === DIVISION.LOWER
            ? _lowerTargetLabel(it.TargetCourse) : 'Upper-Division Elective',
          typeCode: _plainStr(it.TypeCode),
          typeLabel: _typeLabel(rec.Division, it.TypeCode),
          institutionId: _plainStr(it.InstitutionID),
          institutionFreeText: _plainStr(it.InstitutionFreeText),
          institutionLabel: _institutionLabelFor(it),
          courseId: _plainStr(it.CourseID),
          syllabusLink: _plainStr(it.SyllabusLink),
          syllabusName: _plainStr(it.SyllabusName),
          transcriptLink: _plainStr(it.TranscriptLink),
          transcriptName: _plainStr(it.TranscriptName),
          reviewPath: _plainStr(it.ReviewPath),
          decision: _plainStr(it.Decision),
          denialReason: _plainStr(it.DenialReason),
          decidedBy: reviewer ? _plainStr(it.DecidedBy) : '',
          decidedAt: _fmtDate(it.DecidedAt),
          myUcscAction: _plainStr(it.MyUCSCAction),
          myUcscActionLabel: _myUcscLabel(it.MyUCSCAction),
          enteredBy: reviewer ? _plainStr(it.EnteredBy) : '',
          enteredAt: _fmtDate(it.EnteredAt),
        };
        if (reviewer) {
          item.precedents = _precedentsFor(it.CourseID, it.InstitutionID,
            it.InstitutionFreeText, it.ItemID);
        }
        return item;
      });
    }
    return out;
  }

  function _itemLabel(it) {
    return (String(it.TargetCourse) === UPPER_TARGET
      ? String(it.CourseID || 'course')
      : _lowerTargetLabel(it.TargetCourse));
  }

  function _lowerTargetLabel(key) {
    const t = LOWER_TARGETS.find(x => x.key === String(key || '').trim().toUpperCase());
    return t ? t.label : _plainStr(key);
  }

  function _typeLabel(division, key) {
    const list = division === DIVISION.UPPER ? UPPER_TYPES : LOWER_TYPES;
    const t = list.find(x => x.key === String(key || '').trim());
    return t ? t.label : _plainStr(key);
  }

  function _instTypeLabel(key) {
    const t = INST_TYPES.find(x => x.key === String(key || '').trim());
    return t ? t.label : _plainStr(key);
  }

  function _myUcscLabel(key) {
    const a = MYUCSC_ACTIONS.find(x => x.key === String(key || '').trim());
    return a ? a.label : _plainStr(key);
  }

  function _studentLabel(email) {
    const p = Auth.getProfile(email);
    return (p && p.name) ? p.name : String(email || '');
  }

  function _isAdvisor(roles) {
    return roles.indexOf(ADVISOR_ROLE) !== -1 || roles.indexOf('super_admin') !== -1;
  }
  function _assertAdvisor(roles) {
    if (!_isAdvisor(roles)) throw new Error('Only the undergraduate advisor can perform this action.');
  }
  function _isDus(roles) {
    return roles.indexOf(DUS_ROLE) !== -1 || roles.indexOf('super_admin') !== -1;
  }
  function _assertDus(roles) {
    if (!_isDus(roles)) throw new Error('Only the Director of Undergraduate Studies can perform this action.');
  }

  function _requireOneOf(value, allowed, label) {
    const v = String(value || '').trim();
    if (allowed.indexOf(v) === -1) {
      throw new Error(label + ' must be one of: ' + allowed.join(', ') + '.');
    }
    return v;
  }

  function _byCreatedDesc(a, b) { return (b._created || 0) - (a._created || 0); }
  function _isTrueStr(v) { return String(v).toUpperCase() === 'TRUE'; }
  function _norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

  /** Lowercase, collapse whitespace, strip punctuation + generic suffix
   *  words — so "Cabrillo College" and "cabrillo" key the same. */
  function _normText(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\b(college|university|community|institute|the|of)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function _slug(s) {
    return String(s || '').trim().replace(/[^A-Za-z0-9]+/g, '');
  }

  function _fmtDate(v) {
    if (!v) return '';
    const d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMM d, yyyy');
  }

  /** Shape any sheet cell for a client return (the Date landmine). */
  function _plainStr(v) {
    if (v instanceof Date) return _fmtDate(v);
    return v == null ? '' : String(v);
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }


  return {
    TABS: TABS,
    bootstrap: bootstrap,
    // institutions
    listInstitutions: listInstitutions,
    listInstitutionsAll: listInstitutionsAll,
    saveInstitution: saveInstitution,
    promoteInstitution: promoteInstitution,
    // settings
    getSettings: getSettings,
    saveSettings: saveSettings,
    syncDocumentAccess: syncDocumentAccess,
    // student
    submit: submit,
    resubmit: resubmit,
    withdraw: withdraw,
    mine: mine,
    get: get,
    // advisor — intake
    intakeQueue: intakeQueue,
    intakeSubmit: intakeSubmit,
    returnToStudent: returnToStudent,
    // DUS
    dusQueue: dusQueue,
    dusSubmit: dusSubmit,
    // advisor — processing + management
    processingQueue: processingQueue,
    processSubmit: processSubmit,
    allPetitions: allPetitions,
    precedents: precedents,
    deletePetition: deletePetition,
  };

})();