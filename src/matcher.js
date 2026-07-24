/**
 * TurboMock Matcher
 * Shared URL / header / GraphQL / rule matching logic (UMD).
 * Loads as: (a) a plain MAIN-world script, (b) a CommonJS module under Jest,
 * (c) via ESM side-effect import. See TODO.md §1.3.
 */
(function (global) {
    'use strict';

    // Rule types handled by the interceptor (fetch/XHR patch). 'headers' and
    // 'queryparams' are DNR-backed and are never matched here.
    const INTERCEPTOR_TYPES = ['mock', 'block', 'delay', 'redirect'];

    /**
     * Match a URL against a pattern.
     * - pattern contains '*' -> wildcard, full-match regex (also covers pattern === '*')
     * - pattern wrapped in /.../ -> regex test
     * - otherwise -> substring match
     * All comparisons are case-insensitive.
     */
    function matchUrl(url, pattern) {
        if (!url || !pattern) return false;

        try {
            if (pattern.includes('*')) {
                const regexPattern = pattern
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    .replace(/\\\*/g, '.*');
                const regex = new RegExp('^' + regexPattern + '$', 'i');
                return regex.test(url);
            } else if (pattern.startsWith('/') && pattern.endsWith('/')) {
                const regexBody = pattern.slice(1, -1);
                const regex = new RegExp(regexBody, 'i');
                return regex.test(url);
            } else {
                return url.toLowerCase().includes(pattern.toLowerCase());
            }
        } catch (error) {
            console.error('Error matching URL pattern:', error);
            return false;
        }
    }

    /**
     * Match request headers against a rule's header conditions.
     * ALL rule entries must match; header name compare is case-insensitive;
     * value compare is substring. Empty/absent ruleHeaders -> true.
     */
    function matchHeaders(requestHeaders, ruleHeaders) {
        if (!ruleHeaders || Object.keys(ruleHeaders).length === 0) return true;

        const normalizedRequestHeaders = {};
        if (requestHeaders) {
            Object.keys(requestHeaders).forEach((key) => {
                normalizedRequestHeaders[key.toLowerCase()] = requestHeaders[key];
            });
        }

        return Object.keys(ruleHeaders).every((name) => {
            const expected = ruleHeaders[name];
            const actual = normalizedRequestHeaders[name.toLowerCase()];
            if (actual === undefined || actual === null) return false;
            return String(actual).toLowerCase().includes(String(expected).toLowerCase());
        });
    }

    /**
     * Match a GraphQL operationName condition against a request body.
     * Parses bodyText as JSON and compares parsed.operationName; on parse
     * failure falls back to a regex looking for "operationName":"<name>".
     * Absent graphqlMatch -> true.
     */
    function matchGraphQL(bodyText, graphqlMatch) {
        if (!graphqlMatch || !graphqlMatch.operationName) return true;
        if (!bodyText) return false;

        try {
            const parsed = JSON.parse(bodyText);
            return !!parsed && parsed.operationName === graphqlMatch.operationName;
        } catch (error) {
            const escapedName = graphqlMatch.operationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp('"operationName"\\s*:\\s*"' + escapedName + '"');
            return regex.test(bodyText);
        }
    }

    /**
     * Find the first enabled, interceptor-handled rule (array order) whose
     * url + method + headers + graphql conditions all match. Method '*'
     * matches any method.
     */
    function findMatchingRule(rules, request) {
        if (!Array.isArray(rules)) return null;
        const { url, method, headers, bodyText } = request || {};

        for (const rule of rules) {
            if (!rule || !rule.enabled) continue;

            const type = rule.type || 'mock';
            if (INTERCEPTOR_TYPES.indexOf(type) === -1) continue;

            const match = rule.match || {};
            const ruleMethod = (match.method || '*').toUpperCase();
            if (ruleMethod !== '*' && String(method || '').toUpperCase() !== ruleMethod) continue;

            if (!matchUrl(url, match.url)) continue;
            if (!matchHeaders(headers, match.headers)) continue;
            if (!matchGraphQL(bodyText, match.graphql)) continue;

            return rule;
        }

        return null;
    }

    const api = { matchUrl, matchHeaders, matchGraphQL, findMatchingRule };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.TurboMockMatcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
