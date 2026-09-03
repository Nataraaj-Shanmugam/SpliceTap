/**
 * SpliceTap Common Helpers
 * Small utilities every surface needs (UMD).
 * Loads as: (a) a plain script in an extension page, (b) a content script,
 * (c) a CommonJS module under Jest, (d) via ESM side-effect import.
 *
 * CQ-6: these existed as three copies of escapeHtml and four of generateId,
 * and they had drifted:
 *   - devtools/panel.js also escaped '/', the other two did not
 *   - options/options.js produced ids shaped 'item-...' while every other
 *     surface produced 'rule_...', so a rule created on the options page was
 *     visibly different from the same rule created anywhere else
 * Neither was load-bearing yet, which is exactly why it was worth fixing
 * before something started parsing id shape.
 */
(function (global) {
    'use strict';

    /**
     * Escape a value for interpolation into HTML.
     *
     * Escapes quotes as well as angle brackets because output frequently lands
     * in an attribute (title="...", aria-label="..."), where escaping only
     * & < > still allows breaking out. '/' is escaped too — harmless in text,
     * and it closes the `</script>`-in-a-string case.
     */
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"'/]/g, (ch) => {
            switch (ch) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                case "'": return '&#39;';
                case '/': return '&#47;';
                default: return ch;
            }
        });
    }

    /**
     * Generate an id. Default prefix is 'rule' because that is what every
     * caller but one was already producing.
     */
    function generateId(prefix = 'rule') {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }

    /**
     * CQ-10: the rule-schema limits, in one place.
     *
     * 30000 was written as a bare literal in content/overlay.js and
     * service_worker/background.js, and named only in options/options.js —
     * three copies of one product decision, so raising the cap would have
     * meant finding all three. Same for the 100-599 status range.
     */
    const LIMITS = {
        NAME_MAX: 100,
        URL_MAX: 500,
        STATUS_MIN: 100,
        STATUS_MAX: 599,
        DELAY_MIN: 0,        // response delay on a mock rule
        DELAY_MAX: 30000,
        DELAY_MS_MIN: 1,     // the delay rule type's own wait
        DELAY_MS_MAX: 30000
    };

    const api = { escapeHtml, generateId, LIMITS };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapCommon = api;
})(typeof window !== 'undefined' ? window : globalThis);
