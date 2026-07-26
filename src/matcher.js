/**
 * SpliceTap Matcher
 * Shared URL / header / GraphQL / rule matching logic (UMD).
 * Loads as: (a) a plain MAIN-world script, (b) a CommonJS module under Jest,
 * (c) via ESM side-effect import.
 */
(function (global) {
    'use strict';

    // Rule types handled by the interceptor (fetch/XHR patch). 'headers' and
    // 'queryparams' are DNR-backed and are never matched here.
    const INTERCEPTOR_TYPES = new Set(['mock', 'block', 'delay', 'redirect']);

    // Compiled-pattern cache (P-4): matchUrl is called once per enabled rule on
    // every intercepted request, so recompiling a RegExp per call is pure waste.
    // Keyed by the raw pattern string; capped so a stream of unique/generated
    // patterns can't grow this unboundedly.
    const PATTERN_CACHE_MAX = 500;
    const patternCache = new Map();

    // Crude nested-quantifier detector used as a ReDoS guard (S-10 / Q-30).
    // Catches the classic catastrophic-backtracking shapes such as (a+)+,
    // (a*)*, (.+)+, (\d*)* etc. Not exhaustive, but cheap and zero false
    // positives on ordinary patterns.
    const NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)[+*]/;

    // Single-slot memo for the last URL's lowercase form (P-4): within one
    // findMatchingRule scan, matchUrl is called repeatedly with the SAME url
    // across many rules, so this turns an O(rules) toLowerCase() cost into
    // O(1) for everything after the first substring-match rule.
    let lastUrl = null;
    let lastUrlLower = null;

    /**
     * Compile (and cache) a URL pattern into a matchable descriptor.
     * - pattern wrapped in /.../ -> regex (checked FIRST, see Q-3)
     * - pattern contains '*' -> wildcard, full-match regex (also covers pattern === '*')
     * - otherwise -> substring match
     * Malformed, empty, or potentially-catastrophic regex bodies compile to
     * a 'never' descriptor (fail closed) rather than throwing or hanging.
     */
    function compilePattern(pattern) {
        const cached = patternCache.get(pattern);
        if (cached) return cached;

        let compiled;
        try {
            if (pattern.startsWith('/') && pattern.endsWith('/')) {
                const regexBody = pattern.slice(1, -1);
                if (regexBody.length === 0) {
                    // Q-10: '/' or '//' must not become an empty regex that matches everything.
                    compiled = { kind: 'never' };
                } else if (NESTED_QUANTIFIER_RE.test(regexBody)) {
                    console.error('SpliceTap: refusing potentially catastrophic regex pattern:', pattern);
                    compiled = { kind: 'never' };
                } else {
                    compiled = { kind: 'regex', regex: new RegExp(regexBody, 'i') };
                }
            } else if (pattern.includes('*')) {
                const regexPattern = pattern
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    .replace(/\\\*/g, '.*');
                compiled = { kind: 'regex', regex: new RegExp('^' + regexPattern + '$', 'i') };
            } else {
                compiled = { kind: 'substring', lower: pattern.toLowerCase() };
            }
        } catch (error) {
            console.error('Error compiling URL pattern:', error);
            compiled = { kind: 'never' };
        }

        if (patternCache.size >= PATTERN_CACHE_MAX) {
            const oldestKey = patternCache.keys().next().value;
            patternCache.delete(oldestKey);
        }
        patternCache.set(pattern, compiled);
        return compiled;
    }

    /**
     * Match a URL against a pattern.
     * - pattern wrapped in /.../ -> regex test (checked FIRST — see Q-3: a
     *   regex containing '*' must not be misread as a wildcard)
     * - pattern contains '*' -> wildcard, full-match regex (also covers pattern === '*')
     * - otherwise -> substring match
     * All comparisons are case-insensitive.
     */
    function matchUrl(url, pattern) {
        if (!url || !pattern) return false;

        const compiled = compilePattern(pattern);
        if (compiled.kind === 'never') return false;

        if (compiled.kind === 'regex') {
            return compiled.regex.test(url);
        }

        if (url !== lastUrl) {
            lastUrl = url;
            lastUrlLower = url.toLowerCase();
        }
        return lastUrlLower.includes(compiled.lower);
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
            if (!INTERCEPTOR_TYPES.has(type)) continue;

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
    global.SpliceTapMatcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
