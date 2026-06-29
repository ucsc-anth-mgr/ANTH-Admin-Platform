// ============================================================
// Links.gs — Centralized deep-link URL construction
// ============================================================
// One place that builds portal deep-link URLs, so every module's
// emails AND the module settings cards draw the SAME link from the
// SAME logic. Replaces the per-module _deepLink* builders that each
// independently called ScriptApp.getService().getUrl() and re-derived
// the ?/& joining.
//
// BASE URL: prefers CONFIG.PUBLIC_BASE_URL (the public alias, e.g.
//   https://anthroadmin.ucsc.edu/portal), falling back to the raw
//   Apps Script web-app URL (…/exec or …/dev). Blank the constant to
//   revert every deep link to the raw script URL — a safe back-out.
//
// ALIAS CAVEAT: the alias only works as a deep link if the redirect
//   forwards the FULL query string through to the underlying /exec URL
//   with params intact. If links built here open the portal but land
//   on the default page (focus lost), the fix is in the DNS / URL-
//   forwarding rule, not in this file.
// ============================================================

const Links = (() => {

  /**
   * The portal base URL, WITHOUT any query string.
   * CONFIG.PUBLIC_BASE_URL wins when set; otherwise the deployment's
   * own web-app URL. Returns '' if neither is available (e.g. the
   * service URL can't be read in the current context) — callers treat
   * '' as "couldn't build a link" and degrade gracefully.
   */
  function base() {
    var configured = '';
    try {
      configured = (CONFIG && CONFIG.PUBLIC_BASE_URL) ? String(CONFIG.PUBLIC_BASE_URL).trim() : '';
    } catch (e) {
      configured = '';
    }
    if (configured) return configured;

    try {
      return ScriptApp.getService().getUrl() || '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Builds a deep link into a module.
   *
   *   deepLink('transcript', 'mine')  → <base>?page=transcript&focus=mine
   *   deepLink('thesis', 'THES_123')  → <base>?page=thesis&focus=THES_123
   *   deepLink('transcript')          → <base>?page=transcript
   *
   * @param {string} moduleKey   the module's registry key (the `page` value)
   * @param {string} [focusValue] optional focus token; omitted from the URL
   *                              when empty, yielding a plain module link
   * @return {string} the URL, or '' if no base URL could be determined
   */
  function deepLink(moduleKey, focusValue) {
    var b = base();
    if (!b) return '';

    var key = String(moduleKey == null ? '' : moduleKey).trim();
    if (!key) return '';

    var sep = b.indexOf('?') === -1 ? '?' : '&';
    var url = b + sep + 'page=' + encodeURIComponent(key);

    var focus = String(focusValue == null ? '' : focusValue).trim();
    if (focus) {
      url += '&focus=' + encodeURIComponent(focus);
    }
    return url;
  }

  return { base: base, deepLink: deepLink };

})();