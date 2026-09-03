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

    // ReDoS guard. This used to be a shape test for nested quantifiers
    // (/\([^()]*[+*][^()]*\)[+*]/), which caught (a+)+ but sailed straight past
    // (a|a)+ — a textbook catastrophic shape that measured 42 SECONDS against a
    // 28-character URL, hanging the tab. Any shape blocklist is a guess about
    // which forms are slow; this measures whether THIS pattern is actually slow.
    //
    // The regex is run against escalating runs of characters it references,
    // each followed by a terminator that forces a failed match — the shape that
    // makes a backtracking engine explore exponentially many paths. Cost grows
    // ~4x per +4 characters, so a catastrophic pattern blows the budget while
    // lengths are still cheap, and we stop before ever reaching the slow ones.
    //
    // Measured: legitimate patterns finish in <1ms; catastrophic ones are
    // rejected in 25-45ms. Only ever paid once per unique pattern (cached).
    const PROBE_LENGTHS = [18, 22, 26, 30, 34];
    const PROBE_BUDGET_MS = 20;

    function probeAlphabet(regexBody) {
        // Characters the pattern actually mentions, so probes can partially
        // match and force backtracking. 'a'/'0' are always included because a
        // pattern may reference classes (\d, \w) rather than literals.
        const literals = Array.from(new Set(regexBody.match(/[A-Za-z0-9]/g) || [])).slice(0, 3);
        return Array.from(new Set([...literals, 'a', '0'])).slice(0, 5);
    }

    function isCatastrophicRegex(regexBody) {
        let re;
        try {
            re = new RegExp(regexBody, 'i');
        } catch (error) {
            return true;
        }
        const alphabet = probeAlphabet(regexBody);
        const start = Date.now();
        for (const len of PROBE_LENGTHS) {
            for (const ch of alphabet) {
                try {
                    re.test(ch.repeat(len) + '￿');
                } catch (error) {
                    return true;
                }
                if (Date.now() - start > PROBE_BUDGET_MS) return true;
            }
            if (alphabet.length > 1) {
                const mixed = (alphabet[0] + alphabet[1]).repeat(Math.ceil(len / 2)).slice(0, len);
                try {
                    re.test(mixed + '￿');
                } catch (error) {
                    return true;
                }
                if (Date.now() - start > PROBE_BUDGET_MS) return true;
            }
        }
        return false;
    }

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
                } else if (isCatastrophicRegex(regexBody)) {
                    console.error('SpliceTap: refusing potentially catastrophic regex pattern:', pattern);
                    compiled = { kind: 'never' };
                } else {
                    compiled = { kind: 'regex', regex: new RegExp(regexBody, 'i') };
                }
            } else if (pattern.includes('*')) {
                // PERF-7: the overwhelmingly common shapes here are '*/api/x*',
                // '/api/x*' and '*/api/x' — a single literal with stars around
                // it. Those are exactly includes/startsWith/endsWith, so
                // compiling them to a regex meant paying the regex engine on
                // every rule for every request to answer a substring question.
                // Multi-literal patterns ('a*b') still compile to a regex.
                //
                // The anchored '^...$' form the regex branch uses makes these
                // equivalences exact: '*X*' is "contains X", 'X*' is "starts
                // with X", '*X' is "ends with X".
                const segments = pattern.split('*');
                const literals = segments.filter((segment) => segment.length > 0);

                if (literals.length === 0) {
                    compiled = { kind: 'any' }; // '*', '**', ...
                } else if (literals.length === 1) {
                    const literal = literals[0].toLowerCase();
                    const openLeft = segments[0] === '';
                    const openRight = segments[segments.length - 1] === '';

                    if (openLeft && openRight) {
                        compiled = { kind: 'substring', lower: literal };
                    } else if (openRight) {
                        compiled = { kind: 'prefix', lower: literal };
                    } else {
                        compiled = { kind: 'suffix', lower: literal };
                    }
                } else {
                    const regexPattern = pattern
                        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                        .replace(/\\\*/g, '.*');
                    compiled = { kind: 'regex', regex: new RegExp('^' + regexPattern + '$', 'i') };
                }
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
        if (compiled.kind === 'any') return true;

        if (compiled.kind === 'regex') {
            return compiled.regex.test(url);
        }

        if (url !== lastUrl) {
            lastUrl = url;
            lastUrlLower = url.toLowerCase();
        }

        if (compiled.kind === 'prefix') return lastUrlLower.startsWith(compiled.lower);
        if (compiled.kind === 'suffix') return lastUrlLower.endsWith(compiled.lower);
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

        // PERF-7: this uppercased the *request's* method once per rule, so a
        // page with N rules allocated N throwaway strings for every request to
        // compare against a value that cannot change mid-scan.
        const requestMethod = String(method || '').toUpperCase();

        for (const rule of rules) {
            if (!rule || !rule.enabled) continue;

            const type = rule.type || 'mock';
            if (!INTERCEPTOR_TYPES.has(type)) continue;

            const match = rule.match || {};
            const ruleMethod = (match.method || '*').toUpperCase();
            if (ruleMethod !== '*' && requestMethod !== ruleMethod) continue;

            if (!matchUrl(url, match.url)) continue;
            if (!matchHeaders(headers, match.headers)) continue;
            if (!matchGraphQL(bodyText, match.graphql)) continue;

            return rule;
        }

        return null;
    }

    // isCatastrophicRegex is exported so the save-time validator and the
    // redirect path guard against the same thing this matcher does, rather
    // than each re-deriving (or, as before, omitting) the check.
    const api = { matchUrl, matchHeaders, matchGraphQL, findMatchingRule, isCatastrophicRegex };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapMatcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
