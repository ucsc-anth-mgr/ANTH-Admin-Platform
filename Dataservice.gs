// ============================================================
// DataService.gs — Generic Sheets CRUD wrapper
// ============================================================
// Each module stores data in a named tab of a designated Sheet.
// This service provides a consistent read/write/query API so
// modules never call SpreadsheetApp directly.
// ============================================================

const DataService = (() => {

  /**
   * Appends a row to a sheet tab.
   *
   * @param {string} sheetId   - Spreadsheet ID from CONFIG.SHEETS
   * @param {string} tabName   - Sheet tab name
   * @param {Object} record    - Key/value object; keys must match header row
   * @returns {number} The 1-based row number of the new row
   */
  function insert(sheetId, tabName, record) {
    const { sheet, headers } = _open(sheetId, tabName);
    const row = _toRow(record, headers);
    row[_headerIndex(headers, 'CreatedAt')] = new Date();
    row[_headerIndex(headers, 'CreatedBy')] = Session.getActiveUser().getEmail();
    sheet.appendRow(row);
    return sheet.getLastRow();
  }


  /**
   * Updates a single row identified by a matching field value.
   *
   * @param {string} sheetId
   * @param {string} tabName
   * @param {string} keyField  - Header name to match on (e.g. 'ID')
   * @param {*}      keyValue  - Value to match
   * @param {Object} updates   - Fields to overwrite
   * @returns {boolean} true if a row was found and updated
   */
  function update(sheetId, tabName, keyField, keyValue, updates) {
    const { sheet, headers, data } = _open(sheetId, tabName);
    const keyCol = _headerIndex(headers, keyField);

    for (let i = 0; i < data.length; i++) {
      if (String(data[i][keyCol]) === String(keyValue)) {
        const rowNum = i + 2; // +1 for header, +1 for 1-based index
        updates['UpdatedAt'] = new Date();
        updates['UpdatedBy'] = Session.getActiveUser().getEmail();
        Object.keys(updates).forEach(field => {
          const col = _headerIndex(headers, field);
          if (col >= 0) sheet.getRange(rowNum, col + 1).setValue(updates[field]);
        });
        return true;
      }
    }
    return false;
  }


  /**
   * Deletes the first row where keyField === keyValue. The row is removed
   * entirely (not cleared), so no empty record is left behind. Returns
   * true if a row was deleted, false if no match.
   *
   * Deliberately destructive — callers own the decision and any cleanup
   * of references (tasks, files) that point at the deleted record.
   *
   * @param {string} sheetId
   * @param {string} tabName
   * @param {string} keyField
   * @param {string} keyValue
   * @returns {boolean}
   */
  function remove(sheetId, tabName, keyField, keyValue) {
    const { sheet, headers, data } = _open(sheetId, tabName);
    const keyCol = _headerIndex(headers, keyField);

    for (let i = 0; i < data.length; i++) {
      if (String(data[i][keyCol]) === String(keyValue)) {
        sheet.deleteRow(i + 2); // +1 for header, +1 for 1-based index
        return true;
      }
    }
    return false;
  }


  /**
   * Returns all rows as an array of objects.
   *
   * @param {string} sheetId
   * @param {string} tabName
   * @returns {Object[]}
   */
  function getAll(sheetId, tabName) {
    const { headers, data } = _open(sheetId, tabName);
    return data.map(row => _toRecord(row, headers));
  }


  /**
   * Returns rows where field === value.
   *
   * @param {string} sheetId
   * @param {string} tabName
   * @param {string} field
   * @param {*}      value
   * @returns {Object[]}
   */
  function query(sheetId, tabName, field, value) {
    const { headers, data } = _open(sheetId, tabName);
    const col = _headerIndex(headers, field);
    return data
      .filter(row => String(row[col]) === String(value))
      .map(row => _toRecord(row, headers));
  }


  /**
   * Generates a simple unique ID (timestamp + random suffix).
   * Suitable for sheet-based record IDs.
   */
  function generateId(prefix) {
    const ts   = new Date().getTime().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substr(2, 4).toUpperCase();
    return (prefix || 'ID') + '-' + ts + '-' + rand;
  }


  // ── Private helpers ────────────────────────────────────────

  function _open(sheetId, tabName) {
    const ss    = SpreadsheetApp.openById(sheetId);
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) throw new Error('Tab "' + tabName + '" not found in sheet ' + sheetId);

    const all     = sheet.getDataRange().getValues();
    const headers = all[0].map(h => String(h).trim());
    const data    = all.slice(1).filter(row => row.some(cell => cell !== ''));
    return { sheet, headers, data };
  }

  function _headerIndex(headers, field) {
    const idx = headers.indexOf(field);
    // Don't throw for optional meta fields like CreatedAt
    return idx;
  }

  function _toRow(record, headers) {
    return headers.map(h => record.hasOwnProperty(h) ? record[h] : '');
  }

  function _toRecord(row, headers) {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  }


  return { insert, update, remove, getAll, query, generateId };

})();