/**
 * SpliceTap popup helpers (batch 2) - pure, no DOM and no chrome.* (UMD).
 *
 * Loads as (a) a plain script in popup.html, ahead of popup.js, and (b) a
 * CommonJS module under Jest, so the wording and the decisions that do not
 * need a browser are unit-tested without one.
 */
(function (global) {
    'use strict';

    // ---- PER-58: the per-tab status line ---------------------------------

    /** "5 s ago", "3 min ago", "2 h ago", "4 d ago". Seconds stay seconds under a minute. */
    function formatAgo(ms) {
        const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
        if (sec < 60) return sec + ' s ago';
        const min = Math.floor(sec / 60);
        if (min < 60) return min + ' min ago';
        const hr = Math.floor(min / 60);
        if (hr < 24) return hr + ' h ago';
        return Math.floor(hr / 24) + ' d ago';
    }

    /**
     * The line under the header. `entries` is the answer to
     * getInterceptionLog {tabId} (already filtered to the tab by the
     * background), `now` is Date.now().
     */
    function tabStatusText(entries, now) {
        const list = Array.isArray(entries) ? entries : [];
        if (list.length === 0) return 'Nothing intercepted on this tab yet';
        let last = 0;
        for (const entry of list) {
            const ts = entry && Number(entry.ts);
            if (ts > last) last = ts;
        }
        const count = list.length + ' intercepted';
        // An entry with no usable timestamp still counts; it just has no age.
        if (!last) return 'This tab: ' + count;
        return 'This tab: ' + count + ' · last ' + formatAgo(Number(now) - last);
    }

    // ---- PER-59: the shadowing chip --------------------------------------

    /**
     * A pattern wrapped in /.../ is a regex, which cannot be turned into a
     * sample URL, so the background answers needsUrl for it. Mirrors the
     * matcher's own test (a lone "/" or "//" is not one).
     */
    function isRegexPattern(pattern) {
        const text = String(pattern || '');
        return text.length > 2 && text.charAt(0) === '/' && text.charAt(text.length - 1) === '/';
    }

    /** "Shadowed by Mock users", or "Shadowed by Mock users +2" for several. '' for none. */
    function shadowChipText(shadowedBy) {
        const list = (Array.isArray(shadowedBy) ? shadowedBy : []).filter((item) => item && typeof item === 'object');
        if (list.length === 0) return '';
        const first = String(list[0].ruleName || '(unnamed rule)');
        return 'Shadowed by ' + first + (list.length > 1 ? ' +' + (list.length - 1) : '');
    }

    // ---- F6: importing a Requestly export --------------------------------

    /** The rule-like items of a pasted Requestly export (groups excluded). */
    function requestlyRuleItems(parsed) {
        const list = Array.isArray(parsed)
            ? parsed
            : (parsed && typeof parsed === 'object' && Array.isArray(parsed.rules) ? parsed.rules : []);
        return list.filter((item) => item && typeof item === 'object' && !Array.isArray(item)
            && item.objectType !== 'group'
            && (Array.isArray(item.pairs) || typeof item.ruleType === 'string'));
    }

    function countRequestlyRules(parsed) {
        return requestlyRuleItems(parsed).length;
    }

    /** "Convert 1 Requestly rule" / "Convert 3 Requestly rules". */
    function convertLabel(count) {
        return 'Convert ' + count + ' Requestly rule' + (count === 1 ? '' : 's');
    }

    /**
     * The importer module (src/importers/requestly.js) if it loaded and has
     * the two functions the popup needs; otherwise null.
     */
    function requestlyImporter(scope) {
        const root = scope || global;
        const found = root && root.SpliceTapImporters && root.SpliceTapImporters.requestly;
        return found && typeof found.detect === 'function' && typeof found.convert === 'function' ? found : null;
    }

    /** detect() on untrusted input must never take the popup down. */
    function detectRequestly(importer, parsed) {
        if (!importer) return false;
        try {
            return !!importer.detect(parsed);
        } catch (error) {
            return false;
        }
    }

    /**
     * Normalise a converter result into what the import report shows.
     * Tolerates a missing or malformed field: the importer is another file.
     */
    function normalizeConversion(result) {
        const out = (result && typeof result === 'object') ? result : {};
        const rules = (Array.isArray(out.rules) ? out.rules : []).filter((r) => r && typeof r === 'object');
        const skipped = (Array.isArray(out.skipped) ? out.skipped : []).map((item) => ({
            name: item && item.name ? String(item.name) : '',
            reason: item && item.reason ? String(item.reason) : 'not converted'
        }));
        const warnings = (Array.isArray(out.warnings) ? out.warnings : []).map((item) => ({
            name: item && item.name ? String(item.name) : '',
            message: item && item.message ? String(item.message) : ''
        })).filter((item) => item.message);
        return { rules, skipped, warnings };
    }

    /**
     * One sentence for a finished import. `parts` counts what was left out.
     *   { added, replaced, notConverted, duplicates, invalid, total?, converted? }
     * With `total` it speaks of a conversion ("Converted 6 of 8 Requestly
     * rules, ..."; `converted` defaults to total - notConverted); without, it
     * is the plain import wording the popup always had.
     */
    function importSummary(parts) {
        const added = Number(parts.added) || 0;
        const replaced = Number(parts.replaced) || 0;
        const notConverted = Number(parts.notConverted) || 0;
        const duplicates = Number(parts.duplicates) || 0;
        const invalid = Number(parts.invalid) || 0;
        const left = notConverted + duplicates + invalid;

        let summary;
        if (parts.total !== undefined) {
            const total = Number(parts.total) || 0;
            const converted = parts.converted !== undefined
                ? Number(parts.converted) || 0
                : Math.max(total - notConverted, 0);
            summary = 'Converted ' + converted + ' of ' + total + ' Requestly rule' + (total === 1 ? '' : 's')
                + ', imported ' + added;
        } else {
            summary = 'Imported ' + added + ' rule' + (added === 1 ? '' : 's');
        }
        if (replaced) summary += ', replacing ' + replaced;
        if (left) {
            const bits = [];
            if (notConverted) bits.push(notConverted + ' not converted');
            if (duplicates) bits.push(duplicates + ' duplicate' + (duplicates === 1 ? '' : 's'));
            if (invalid) bits.push(invalid + ' invalid');
            summary += ', skipped ' + left + ' (' + bits.join(', ') + ')';
        }
        return summary;
    }

    const api = {
        formatAgo, tabStatusText,
        isRegexPattern, shadowChipText,
        requestlyRuleItems, countRequestlyRules, convertLabel, requestlyImporter, detectRequestly,
        normalizeConversion, importSummary
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapPopupHelpers = api;
})(typeof window !== 'undefined' ? window : globalThis);
