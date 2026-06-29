// ============================================================
// Notify.gs — Platform notification delivery service
// ============================================================
// Notify owns DELIVERY, not CONTENT. Its job is to take a message a
// module has already composed and get it to the right people:
// resolve + dedupe recipients, apply consistent dressing (subject
// prefix, optional HTML wrapper), send, and log-and-continue so a
// mail failure never breaks the action that triggered it.
//
// WHAT NOTIFY DOES NOT DO: it does not know what any message says.
// Message wording lives in the calling module, which alone knows its
// domain ("request approved", "thesis handoff"). This is deliberate —
// if Notify owned wording, adding a module would mean editing Notify,
// which is exactly the cross-module coupling the platform avoids.
// Notify's interface therefore stays frozen as modules churn.
//
// Consistency is offered, not forced: modules may use the formatting
// helpers (subjectLine, htmlWrap) so every portal email looks alike,
// but Notify never rewrites a module's content.
//
// Wraps Utils.sendEmail (the low-level GmailApp call). Absorbs the
// recipient-dedup logic formerly inline in RequestManager._notifyAdmins.
// ============================================================

const Notify = (() => {

  // Standard subject prefix so portal mail is recognizable in an inbox.
  // Kept short and stable ('[Portal] ') rather than the full app title.
  const SUBJECT_PREFIX = '[Portal] ';


  /**
   * Delivers a single message. Recipients may be a string, an array,
   * or a mix; they are normalized, validated, and deduped before send.
   * Never throws on a delivery failure — logs and returns a summary,
   * so a notification problem cannot break the caller's main action.
   *
   * Content (subject text, body, htmlBody) is supplied by the caller.
   * Set prefixSubject:false to opt out of the standard subject prefix.
   *
   * @param {Object} p
   *   @param {string|string[]} p.to        - recipient address(es)
   *   @param {string|string[]} [p.cc]      - cc address(es)
   *   @param {string}          p.subject   - subject TEXT (module-owned)
   *   @param {string}          p.body      - plain-text body (module-owned)
   *   @param {string}          [p.htmlBody]- optional HTML body (module-owned)
   *   @param {boolean}         [p.prefixSubject=true] - apply SUBJECT_PREFIX
   *   @param {Blob|Blob[]}     [p.attachments] - file attachment(s), e.g. a
   *                            certificate PDF from ReportService.generate().blob
   *   @param {string|string[]} [p.replyTo] - reply-to address(es); normalized
   *                            and deduped like to/cc
   *   @param {string}          [p.senderName] - inbox DISPLAY name only; the
   *                            sending ADDRESS is always the deploying account
   *                            (GmailApp cannot send from another account).
   *                            When omitted, falls back to CONFIG.NOTIFY_FROM_NAME
   *                            so portal mail shows a friendly name by default.
   * @returns {{ sent: boolean, recipients: string[], reason?: string }}
   */
  function send(p) {
    p = p || {};
    try {
      const to = _dedupeEmails(_collect(p.to));
      if (!to.length) {
        return { sent: false, recipients: [], reason: 'no valid recipients' };
      }

      const cc = _dedupeEmails(_collect(p.cc)).filter(e => to.indexOf(e) === -1);

      const subjectText = String(p.subject || '').trim();
      const subject = (p.prefixSubject === false)
        ? subjectText
        : subjectLine(subjectText);

      // Route through Utils.sendEmail (the single low-level mailer)
      // when only the basic fields are in play; _deliver upgrades to
      // GmailApp directly whenever extended options are present.
      _deliver({
        to: to.join(','),
        subject: subject,
        body: p.body || '',
        htmlBody: p.htmlBody,
        cc: cc.length ? cc.join(',') : '',
        attachments: _collectBlobs(p.attachments),
        replyTo: _dedupeEmails(_collect(p.replyTo)).join(','),
        // Inbox display name. A caller may override per-message; otherwise
        // the department-wide CONFIG.NOTIFY_FROM_NAME masks the sending
        // account's label (e.g. "anth_mgr"). Address is unchanged.
        senderName: String(p.senderName || (typeof CONFIG !== 'undefined' && CONFIG.NOTIFY_FROM_NAME) || '').trim(),
      });

      return { sent: true, recipients: to };

    } catch (err) {
      // Delivery must never break the caller.
      Logger.log('Notify.send failed: ' + err);
      return { sent: false, recipients: [], reason: String(err && err.message ? err.message : err) };
    }
  }


  /**
   * Resolves a final, deduped recipient list from the common sources a
   * module draws on. All inputs optional; result preserves first-seen
   * order and drops blanks/invalids. This absorbs the dedup pattern
   * previously inline in RequestManager._notifyAdmins.
   *
   * @param {Object} p
   *   @param {string[]} [p.superAdmins] - e.g. CONFIG.SUPER_ADMINS
   *   @param {string[]} [p.roleRules]   - e.g. NotifyRules.recipientsFor(role)
   *   @param {string|string[]} [p.explicit] - any direct addresses
   * @returns {string[]} deduped, validated addresses
   */
  function resolveRecipients(p) {
    p = p || {};
    const combined = []
      .concat(_collect(p.superAdmins))
      .concat(_collect(p.roleRules))
      .concat(_collect(p.explicit));
    return _dedupeEmails(combined);
  }


  // ── Optional formatting helpers (consistency made easy) ──────

  /** Applies the standard subject prefix unless already present. */
  function subjectLine(text) {
    const t = String(text || '').trim();
    if (!t) return SUBJECT_PREFIX.trim();
    return t.indexOf(SUBJECT_PREFIX) === 0 ? t : SUBJECT_PREFIX + t;
  }


  /**
   * Wraps plain text in a minimal branded HTML shell. Optional — a
   * module that wants a consistent HTML look can pass the result as
   * htmlBody. Escapes the text and converts newlines to <br>.
   */
  function htmlWrap(text) {
    const navy = (CONFIG && CONFIG.BRAND && CONFIG.BRAND.NAVY) || '#003C6C';
    const safe = _escapeHtml(String(text || '')).replace(/\n/g, '<br>');
    return ''
      + '<div style="font-family:Arial,Helvetica,sans-serif;color:#222;line-height:1.5;">'
      +   '<div style="border-top:4px solid ' + navy + ';padding:16px 0;">'
      +     safe
      +   '</div>'
      +   '<div style="margin-top:16px;font-size:12px;color:#888;">'
      +     ((CONFIG && CONFIG.APP_TITLE) || 'Portal') + ' — automated message.'
      +   '</div>'
      + '</div>';
  }


  // ── Private ──────────────────────────────────────────────────

  /**
   * Low-level send. Goes straight to GmailApp whenever cc, attachments,
   * replyTo, or senderName are present (Utils.sendEmail's signature
   * doesn't carry them); otherwise routes through Utils.sendEmail.
   *
   * NOTE on senderName: GmailApp cannot send FROM another account — the
   * sending address is always the deploying/portal account. The `name`
   * option only changes the DISPLAY name shown in the inbox (e.g.
   * "Prof. Lucia Navarro (UCSC Anthropology)"). replyTo controls where
   * a reply actually goes.
   */
  function _deliver(msg) {
    const hasExtras = !!msg.cc || !!msg.replyTo || !!msg.senderName ||
                      (msg.attachments && msg.attachments.length);
    if (hasExtras) {
      const opts = {};
      if (msg.htmlBody)   opts.htmlBody = msg.htmlBody;
      if (msg.cc)         opts.cc = msg.cc;
      if (msg.replyTo)    opts.replyTo = msg.replyTo;
      if (msg.senderName) opts.name = msg.senderName;
      if (msg.attachments && msg.attachments.length) opts.attachments = msg.attachments;
      GmailApp.sendEmail(msg.to, msg.subject, msg.body || '', opts);
    } else {
      Utils.sendEmail({ to: msg.to, subject: msg.subject, body: msg.body, htmlBody: msg.htmlBody });
    }
  }

  /** Normalizes attachments input into an array of blobs (or []). */
  function _collectBlobs(v) {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr.filter(b => b && typeof b.getBytes === 'function');
  }

  /** Normalizes a string|array|falsy input into an array of trimmed strings. */
  function _collect(v) {
    if (!v) return [];
    if (Array.isArray(v)) {
      return v.reduce((acc, item) => acc.concat(_splitAddresses(item)), []);
    }
    return _splitAddresses(v);
  }

  /** Splits a single value on commas/semicolons into trimmed addresses. */
  function _splitAddresses(v) {
    return String(v || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  }

  /** Dedupes (case-insensitive) and drops invalid addresses, keeping order. */
  function _dedupeEmails(list) {
    const seen = {};
    const out = [];
    list.forEach(raw => {
      const addr = String(raw).trim();
      const key  = addr.toLowerCase();
      if (!addr || seen[key]) return;
      if (!_isValidEmail(addr)) return;
      seen[key] = true;
      out.push(addr);
    });
    return out;
  }

  /** Email validation — defers to Utils when present, else a local regex. */
  function _isValidEmail(s) {
    if (typeof Utils !== 'undefined' && Utils.isValidEmail) return Utils.isValidEmail(s);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s));
  }

  function _escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }


  return { send, resolveRecipients, subjectLine, htmlWrap };

})();