/**
 * SpliceTap DevTools panel helpers (batch 2) - pure, no DOM and no chrome.* (UMD).
 *
 * Loads as a plain script in the panel and as a CommonJS module under Jest.
 */
(function (global) {
    'use strict';

    // A capture body is at most 100 KB; a <pre> of that is slow to lay out for
    // no reader's benefit, so the view stops here and says so.
    const BODY_VIEW_MAX = 20000;

    /** "Content-Type: application/json" lines, in the order the capture has them. */
    function formatHeaders(headers) {
        if (!headers || typeof headers !== 'object') return [];
        return Object.keys(headers)
            .filter((name) => typeof headers[name] === 'string')
            .map((name) => name + ': ' + headers[name]);
    }

    /**
     * The body as the read-only view shows it: JSON re-indented, anything else
     * as is, cut at BODY_VIEW_MAX. { text, truncated }.
     */
    function formatBody(body) {
        let text = typeof body === 'string' ? body : '';
        try {
            const parsed = JSON.parse(text);
            if (parsed !== null && typeof parsed === 'object') text = JSON.stringify(parsed, null, 2);
        } catch (error) {
            // not JSON: shown exactly as captured
        }
        if (text.length > BODY_VIEW_MAX) return { text: text.slice(0, BODY_VIEW_MAX), truncated: true };
        return { text, truncated: false };
    }

    /** "200 OK" / "404" - the status line of the view. */
    function formatStatus(capture) {
        const status = capture && Number(capture.status);
        if (!status) return 'Status unknown';
        const text = capture.statusText ? ' ' + capture.statusText : '';
        return String(status) + text;
    }

    /** The URL of the options page's editor for a rule. */
    function editRulePath(ruleId) {
        return 'options/options.html?editRule=' + encodeURIComponent(ruleId);
    }

    const api = { BODY_VIEW_MAX, formatHeaders, formatBody, formatStatus, editRulePath };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapPanelHelpers = api;
})(typeof window !== 'undefined' ? window : globalThis);
