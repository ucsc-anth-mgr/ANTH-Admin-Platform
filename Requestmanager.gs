// ============================================================
// RequestManager.gs — Self-registration access requests
// ============================================================
// Unprovisioned users submit an access request (name, ID, requested
// role, note). Requests live in their own "Requests" tab and never
// confer access until a super-admin approves — at which point a real
// Users profile is created with an admin-chosen role.
//
// Requests tab columns:
//   RequestID | Email | FirstName | LastName | IDType | IDNumber | RequestedRole |
//   Note | Status | SubmittedAt | DecidedBy | DecidedAt | DecisionNote
// ============================================================

const RequestManager = (() => {

  const HEADERS = [
    'RequestID', 'Email', 'FirstName', 'LastName', 'IDType', 'IDNumber', 'RequestedRole',
    'Note', 'Status', 'SubmittedAt', 'DecidedBy', 'DecidedAt', 'DecisionNote',
  ];


  /**
   * Submits a new access request from an unprovisioned user.
   * The caller's email is taken from the session, NOT the payload.
   * @param {Object} p - { name, idType, idNumber, requestedRole, note }
   * @param {string} user - session email (injected by dispatch)
   */
  function submitRequest(p, user) {
    if (!user) throw new Error('Could not determine your email. Are you signed in?');

    // Already a provisioned, active user? No need to request.
    const existing = Auth.getProfile(user);
    if (existing && existing.active) {
      throw new Error('You already have access. Try reloading the portal.');
    }

    if (!p.firstName || !p.lastName) throw new Error('Please enter your first and last name.');

    // Validate ID against its type (reuses the platform rules)
    if (p.idNumber) {
      if (p.idType === 'student') Auth.validateStudentId(p.idNumber);
      else if (p.idType === 'employee') Auth.validateEmployeeId(p.idNumber);
    }

    const sheet = _ensureSheet();

    // Prevent duplicate pending requests from the same email
    const pending = _all().find(r =>
      r.email.toLowerCase() === user.toLowerCase() && r.status === 'Pending');
    if (pending) {
      throw new Error('You already have a pending request. An administrator will review it soon.');
    }

    const id = DataService.generateId('REQ');
    sheet.appendRow([
      id, user, p.firstName, p.lastName, p.idType || '', p.idNumber || '',
      p.requestedRole || '', p.note || '',
      'Pending', Utils.formatDate(new Date()), '', '', '',
    ]);

    _notifyAdmins(user, p.firstName + ' ' + p.lastName, p.requestedRole);
    return { id: id, status: 'Pending' };
  }


  /**
   * Returns pending requests (for the admin queue).
   */
  function listPending() {
    return _all().filter(r => r.status === 'Pending');
  }

  /**
   * Returns all requests (history view).
   */
  function listAll() {
    return _all();
  }


  /**
   * Approves a request: creates a real Users profile with the
   * admin-chosen role(s), then marks the request approved.
   * @param {Object} p - { requestId, roles[], idType?, idNumber?, note? }
   * @param {string} admin - session email of the approver
   */
  function approve(p, admin) {
    const req = _get(p.requestId);
    if (req.status !== 'Pending') throw new Error('This request has already been decided.');

    const roles = Array.isArray(p.roles) ? p.roles : [p.roles].filter(Boolean);
    if (!roles.length) throw new Error('Select at least one role to grant.');

    // Create the actual user profile (admin may correct ID details).
    // The request stores ONE entered ID + its type; map it into the
    // matching profile field (StudentID or EmployeeID).
    const idType   = p.idType !== undefined ? p.idType : req.idType;
    const idNumber = p.idNumber !== undefined ? p.idNumber : req.idNumber;
    Auth.upsertUser({
      email:    req.email,
      firstName: req.firstName,
      lastName:  req.lastName,
      roles:    roles,
      studentId:  idType === 'student'  ? idNumber : '',
      employeeId: idType === 'employee' ? idNumber : '',
      active:   true,
      notes:    'Self-registered; approved by ' + admin,
    });

    _decide(req.requestId, 'Approved', admin, p.note || '');
    _notifyRequester(req.email, true, p.note || '', roles);
    return { status: 'Approved', email: req.email };
  }


  /**
   * Rejects a request with an optional reason emailed to the requester.
   * @param {Object} p - { requestId, note }
   */
  function reject(p, admin) {
    const req = _get(p.requestId);
    if (req.status !== 'Pending') throw new Error('This request has already been decided.');
    _decide(req.requestId, 'Rejected', admin, p.note || '');
    _notifyRequester(req.email, false, p.note || '', []);
    return { status: 'Rejected', email: req.email };
  }


  // ── Private ────────────────────────────────────────────────

  function _decide(requestId, status, admin, note) {
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    const h = HEADERS;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === requestId) {
        sheet.getRange(i + 1, h.indexOf('Status') + 1).setValue(status);
        sheet.getRange(i + 1, h.indexOf('DecidedBy') + 1).setValue(admin);
        sheet.getRange(i + 1, h.indexOf('DecidedAt') + 1).setValue(Utils.formatDate(new Date()));
        sheet.getRange(i + 1, h.indexOf('DecisionNote') + 1).setValue(note);
        return;
      }
    }
    throw new Error('Request not found: ' + requestId);
  }

  function _all() {
    const sheet = _ensureSheet();
    const data  = sheet.getDataRange().getValues();
    return data.slice(1)
      .filter(row => String(row[0]).trim())
      .map(row => ({
        requestId:     row[0],
        email:         row[1],
        firstName:     row[2],
        lastName:      row[3],
        name:          ((row[2]||'') + ' ' + (row[3]||'')).trim(),  // convenience for display
        idType:        row[4],
        idNumber:      row[5],
        requestedRole: row[6],
        note:          row[7],
        status:        row[8],
        submittedAt:   row[9] ? Utils.formatDate(row[9]) : '',
        decidedBy:     row[10],
        decidedAt:     row[11] ? Utils.formatDate(row[11]) : '',
        decisionNote:  row[12],
      }));
  }

  function _get(requestId) {
    if (!requestId) throw new Error('Request ID is required.');
    const found = _all().find(r => r.requestId === requestId);
    if (!found) throw new Error('Request not found: ' + requestId);
    return found;
  }

  function _notifyAdmins(email, name, requestedRole) {
    try {
      // Recipients = super admins + anyone the NotifyRules tab lists
      // for the requested role (e.g. the undergraduate/graduate advisors).
      const seen = {};
      const recipients = [];
      (CONFIG.SUPER_ADMINS || []).concat(NotifyRules.recipientsFor(requestedRole)).forEach(a => {
        const key = String(a).trim().toLowerCase();
        if (key && !seen[key]) { seen[key] = true; recipients.push(String(a).trim()); }
      });
      if (!recipients.length) return;
      const body = 'A new access request is awaiting review.\n\n'
        + 'Name: ' + name + '\n'
        + 'Email: ' + email + '\n'
        + 'Requested role: ' + (requestedRole || '(none specified)') + '\n\n'
        + 'Open the portal (User Management → Requests, or Admin → Requests) to approve or reject it.';
      Utils.sendEmail({ to: recipients.join(','), subject: '[Portal] New access request from ' + name, body: body });
    } catch (e) {
      Logger.log('Request admin-notify failed: ' + e);
    }
  }

  function _notifyRequester(email, approved, note, roles) {
    try {
      const body = approved
        ? 'Your access request has been approved.\n\n'
          + 'Roles granted: ' + roles.join(', ') + '\n'
          + (note ? '\nNote: ' + note + '\n' : '')
          + '\nReload the portal to begin.'
        : 'Your access request was not approved at this time.\n'
          + (note ? '\nReason: ' + note + '\n' : '')
          + '\nIf you believe this is a mistake, contact the department office.';
      Utils.sendEmail({ to: email, subject: '[Portal] Access request ' + (approved ? 'approved' : 'update'), body: body });
    } catch (e) {
      Logger.log('Request requester-notify failed: ' + e);
    }
  }

  function _ensureSheet() {
    const ss = SpreadsheetApp.openById(CONFIG.SHEETS.USERS_CONFIG);
    let sheet = ss.getSheetByName(CONFIG.TABS.REQUESTS);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.TABS.REQUESTS);
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#003C6C').setFontColor('#FFFFFF');
      sheet.setFrozenRows(1);
    }
    return sheet;
  }


  return { submitRequest, listPending, listAll, approve, reject };

})();