// ============================================================
// SubmissionsModule.gs — Form Submissions module (server side)
// ============================================================
// Manages flexible form submissions stored in Google Sheets.
// Each form type gets its own tab in the submissions Sheet.
// ============================================================

const SubmissionsModule = (() => {

  // ── Form type definitions ─────────────────────────────────
  // Add new form types here. Each key becomes a Sheet tab name.
  // The 'fields' array defines the columns in that tab.
  // ──────────────────────────────────────────────────────────
  const FORM_TYPES = {
    general: {
      label:  'General Request',
      fields: ['ID', 'Subject', 'Description', 'Priority', 'Status', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'Notes'],
      notify: [],  // add email addresses to notify on new submission
    },
    leave: {
      label:  'Leave Request',
      fields: ['ID', 'StartDate', 'EndDate', 'LeaveType', 'Reason', 'Status', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'Notes'],
      notify: [],
    },
    // Add more form types:
    // it_request: {
    //   label:  'IT Request',
    //   fields: ['ID', 'Category', 'Description', 'Urgency', 'Status', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    //   notify: ['it@yourdomain.com'],
    // },
  };


  // ── Public actions (callable via dispatch) ─────────────────

  /**
   * Returns form type definitions for the client UI.
   */
  function getFormTypes() {
    return Object.entries(FORM_TYPES).map(([key, def]) => ({
      key,
      label:  def.label,
      fields: def.fields,
    }));
  }


  /**
   * Submits a new form entry.
   * @param {Object} payload - { formType, data: { field: value, … } }
   */
  function submit(payload, user) {
    const { formType, data } = payload;
    const def = FORM_TYPES[formType];
    if (!def) throw new Error('Unknown form type: ' + formType);

    _ensureTab(formType, def.fields);

    const id = DataService.generateId(formType.toUpperCase().substring(0, 4));
    const record = Object.assign({ ID: id, Status: 'Pending' }, data);

    DataService.insert(CONFIG.SHEETS.SUBMISSIONS, formType, record);

    // Optional email notification
    if (def.notify && def.notify.length > 0) {
      def.notify.forEach(email => {
        Utils.sendEmail({
          to:      email,
          subject: '[' + CONFIG.APP_TITLE + '] New ' + def.label + ' – ' + id,
          body:    'A new submission was received from ' + user + '.\n\nID: ' + id + '\n\nData:\n' + JSON.stringify(data, null, 2),
        });
      });
    }

    return { id, status: 'Pending' };
  }


  /**
   * Returns all submissions visible to the current user.
   * Admins see all rows; regular users see only their own.
   */
  function list(payload, user, roles) {
    const { formType } = payload || {};
    const def = formType ? FORM_TYPES[formType] : null;
    if (formType && !def) throw new Error('Unknown form type: ' + formType);

    const isAdmin = roles.includes('super_admin') || roles.includes('admin');
    const tabName = formType || FORM_TYPES[Object.keys(FORM_TYPES)[0]];

    let rows;
    if (isAdmin) {
      rows = DataService.getAll(CONFIG.SHEETS.SUBMISSIONS, formType || Object.keys(FORM_TYPES)[0]);
    } else {
      rows = DataService.query(CONFIG.SHEETS.SUBMISSIONS, formType || Object.keys(FORM_TYPES)[0], 'CreatedBy', user);
    }

    return rows.map(r => ({
      ...r,
      CreatedAt: r.CreatedAt ? Utils.formatDate(r.CreatedAt) : '',
      UpdatedAt: r.UpdatedAt ? Utils.formatDate(r.UpdatedAt) : '',
    }));
  }


  /**
   * Updates the status of a submission (admin only).
   * @param {Object} payload - { formType, id, status, notes }
   */
  function updateStatus(payload, user, roles) {
    if (!roles.includes('super_admin') && !roles.includes('admin')) {
      throw new Error('Only admins can update submission status.');
    }
    const { formType, id, status, notes } = payload;
    const def = FORM_TYPES[formType];
    if (!def) throw new Error('Unknown form type: ' + formType);

    const updated = DataService.update(
      CONFIG.SHEETS.SUBMISSIONS, formType, 'ID', id,
      { Status: status, Notes: notes || '' }
    );
    if (!updated) throw new Error('Submission not found: ' + id);

    return { id, status };
  }


  // ── Private helpers ────────────────────────────────────────

  /**
   * Ensures the Sheet tab exists with the correct header row.
   */
  function _ensureTab(tabName, fields) {
    const ss    = SpreadsheetApp.openById(CONFIG.SHEETS.SUBMISSIONS);
    let   sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
      sheet.appendRow(fields);
      sheet.getRange(1, 1, 1, fields.length).setFontWeight('bold').setBackground('#e8eaed');
      sheet.setFrozenRows(1);
    }
  }


  return { getFormTypes, submit, list, updateStatus };

})();