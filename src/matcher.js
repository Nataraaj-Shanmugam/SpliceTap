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
    //
    // PER-36: the cap used to be a flat 500 with FIFO eviction. A rule set of
    // 501+ patterns scanned in order then evicted, each lookup, exactly the
    // pattern the next lookup needed, so EVERY lookup missed and recompiled
    // (30 us -> 2.7 ms per request for regexes). The floor is still 500 for
    // callers that feed matchUrl a stream of unique patterns, but
    // findMatchingRule raises the cap to the size of the rule set it is
    // scanning: the number of patterns that can be live is bounded by the
    // rules, so the memory stays bounded too.
    const PATTERN_CACHE_MIN = 500;
    let patternCacheMax = PATTERN_CACHE_MIN;
    const patternCache = new Map();

    // ReDoS guard. This used to be a shape test for nested quantifiers
    // (/\([^()]*[+*][^()]*\)[+*]/), which caught (a+)+ but sailed straight past
    // (a|a)+ — a textbook catastrophic shape that measured 42 SECONDS against a
    // 28-character URL, hanging the tab. Any shape blocklist is a guess about
    // which forms are slow; this measures whether THIS pattern is actually slow.
    //
    // The regex is run against escalating repetitions of a "unit" it can
    // consume, each followed by a terminator that forces a failed match — the
    // shape that makes a backtracking engine explore exponentially many paths.
    // Cost grows ~4x per +2 repetitions, so a catastrophic pattern crosses the
    // slow threshold while the probes are still cheap, and we stop before ever
    // reaching the slow ones.
    //
    // PER-3: the units used to be single alphanumeric runs plus one
    // two-character alternation, so any unit the probe never produced sailed
    // through: (api|api)+$ (three characters) and (-|-)+$, (\.|\.)+$, (_|_)+$,
    // (\/|\/)+$ (punctuation) cost ~11 s at 30 characters and were saved as
    // safe. Units now come from the pattern itself — its literal runs, its
    // alternation branches and the members of its character classes — plus a
    // fixed set: 'a' and '0' for \w, \d and ranges, ' ' for \s, '#' for \W and
    // \D, and the punctuation URLs are made of. Each is also tried after the
    // pattern's leading literal ('/api/' in /\/api\/(x|x)+$/), because the
    // repeated part is otherwise never reached. Terminators include a
    // character each negated class refuses, since [^/]+ happily eats the
    // default one. This is still a heuristic: a repeated part buried behind
    // non-literal text (\/users\/\d+\/(x|x)+$) is not reached.
    //
    // Measured: legitimate patterns finish in a few ms; catastrophic ones are
    // rejected in ~20 ms. Only ever paid once per unique pattern (cached).
    const PROBE_FIXED_UNITS = ['a', '0', ' ', '#', ...'-./_~%:?=&'];
    const PROBE_MIN_REPS = 14;
    const PROBE_MAX_REPS = 34;
    const PROBE_MAX_LENGTH = 160; // per probe string, so long units can't make the probe itself slow
    const PROBE_MAX_UNIT = 10;
    const PROBE_SLOW_MS = 5;      // one probe slower than this, twice running, is catastrophic
    const PROBE_ADAPT_MS = 0.4;   // slower than this: step the repetitions by 2, not 4
    const PROBE_TOTAL_MS = 150;   // hard bound on the whole check
    const probeNow = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? () => performance.now()
        : () => Date.now();

    // The default terminator. Built rather than written as an escape or a
    // literal: U+FFFF is a noncharacter, and a literal one in a shipped file
    // makes Chrome refuse to load the extension (scripts/chromium-text.js).
    const PROBE_DEFAULT_TERMINATOR = String.fromCharCode(0xFFFF);

    const CONTROL_ESCAPES = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' };
    const CLASS_ESCAPE_SAMPLES = { d: '0', w: 'a', s: ' ' };
    // A character each negated class escape REFUSES. A terminator the pattern
    // can consume ends nothing: \W and \D happily eat U+FFFF, so a probe that
    // ends in it matches and never backtracks.
    const REFUSED_BY_ESCAPE = { D: '0', W: 'a', S: ' ' };

    /**
     * Read the literal material out of a regex body: the runs of literal text
     * (split at groups, alternation and quantifiers — a quantifier detaches
     * the character it applies to), the single characters and class members
     * mentioned, a character each negated class (and '.') refuses, and the
     * leading literal. A scanner, not a parser; it only needs to find good
     * probes.
     */
    function analyzePattern(body) {
        const runs = [];
        const chars = [];
        const refused = [];
        let prefix = '';
        let leading = true;
        let run = '';

        const addChar = (c) => { if (!chars.includes(c)) chars.push(c); };
        const flush = () => {
            if (run.length > 0) runs.push(run);
            if (leading) { prefix = run; leading = false; }
            run = '';
        };
        const skipTo = (from, ch) => {
            const close = body.indexOf(ch, from);
            return close === -1 ? body.length : close;
        };

        for (let i = 0; i < body.length; i++) {
            const c = body[i];
            if (c === '\\') {
                const next = body[++i];
                if (next === undefined) break;
                if (CONTROL_ESCAPES[next]) {
                    run += CONTROL_ESCAPES[next];
                } else if (/[A-Za-z0-9]/.test(next)) {
                    // \d \w \s \b, a backreference, \xHH, \p{..}: no literal.
                    flush();
                    if (REFUSED_BY_ESCAPE[next]) refused.push(REFUSED_BY_ESCAPE[next]);
                    if ((next === 'p' || next === 'P') && body[i + 1] === '{') i = skipTo(i, '}');
                    if (next === 'k' && body[i + 1] === '<') i = skipTo(i, '>');
                } else {
                    run += next;
                    addChar(next);
                }
            } else if (c === '*' || c === '+' || c === '?'
                || (c === '{' && /^\{\d+(,\d*)?\}/.test(body.slice(i, i + 16)))) {
                if (c === '{') i = skipTo(i, '}');
                if (run.length > 0) {
                    // The quantifier binds to the last character only.
                    const last = run.slice(-1);
                    run = run.slice(0, -1);
                    flush();
                    runs.push(last);
                }
            } else if (c === '(') {
                flush();
                if (body[i + 1] === '?') {
                    i++;
                    const kind = body[i + 1];
                    if (kind === ':' || kind === '=' || kind === '!') {
                        i++;
                    } else if (kind === '<') {
                        i++;
                        if (body[i + 1] === '=' || body[i + 1] === '!') i++;
                        else i = skipTo(i, '>');
                    }
                }
            } else if (c === '.') {
                flush();
                refused.push('\n'); // the one character '.' will not consume
            } else if (c === ')' || c === '|' || c === '$') {
                flush();
            } else if (c === '^') {
                if (!leading || run.length > 0) flush();
            } else if (c === '[') {
                flush();
                let j = i + 1;
                const negated = body[j] === '^';
                if (negated) j++;
                const members = [];
                for (; j < body.length && body[j] !== ']'; j++) {
                    let m = body[j];
                    if (m === '\\') {
                        m = body[++j];
                        if (m === undefined) break;
                        if (/[A-Za-z0-9]/.test(m)) {
                            if (CLASS_ESCAPE_SAMPLES[m]) members.push(CLASS_ESCAPE_SAMPLES[m]);
                            continue;
                        }
                    }
                    members.push(m);
                }
                i = j;
                if (negated) {
                    if (members.length > 0) refused.push(members[0]);
                } else {
                    members.slice(0, 4).forEach(addChar);
                }
            } else {
                run += c;
                addChar(c);
            }
        }
        flush();

        return { runs, chars, refused, prefix: prefix.slice(0, 60) };
    }

    function probeUnits(info) {
        const derived = info.runs.filter((r) => r.length <= PROBE_MAX_UNIT).slice(0, 12);
        const singles = info.chars.slice(0, 8);
        // Two of the pattern's characters alternating: (a|b)+ style ambiguity.
        const pairs = [];
        for (let a = 0; a < Math.min(3, singles.length); a++) {
            for (let b = a + 1; b < Math.min(3, singles.length); b++) pairs.push(singles[a] + singles[b]);
        }
        return Array.from(new Set([...derived, ...singles, ...pairs, ...PROBE_FIXED_UNITS]));
    }

    function isCatastrophicRegex(regexBody) {
        let re;
        try {
            re = new RegExp(regexBody, 'i');
        } catch (error) {
            return true;
        }

        const info = analyzePattern(regexBody);
        const prefixes = info.prefix ? ['', info.prefix] : [''];
        const terminators = Array.from(new Set([PROBE_DEFAULT_TERMINATOR, ...info.refused])).slice(0, 4);
        const start = probeNow();

        const time = (text) => {
            const began = probeNow();
            re.test(text);
            return probeNow() - began;
        };

        try {
            for (const unit of probeUnits(info)) {
                const maxReps = Math.min(PROBE_MAX_REPS, Math.floor(PROBE_MAX_LENGTH / unit.length));
                for (const prefix of prefixes) {
                    for (const end of terminators) {
                        for (let reps = PROBE_MIN_REPS; reps <= maxReps;) {
                            const text = prefix + unit.repeat(reps) + end;
                            const took = time(text);
                            // A lone slow probe can be a GC pause or a busy
                            // machine; an exponential one is slow every time.
                            if (took > PROBE_SLOW_MS && time(text) > PROBE_SLOW_MS) return true;
                            if (probeNow() - start > PROBE_TOTAL_MS) return true;
                            reps += took > PROBE_ADAPT_MS ? 2 : 4;
                        }
                    }
                }
            }
        } catch (error) {
            return true;
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

        // A loop, not an if: the cap follows the rule set (PER-36), so it can
        // also shrink between scans.
        while (patternCache.size >= patternCacheMax) {
            patternCache.delete(patternCache.keys().next().value);
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
     * PER-23: operation names declared by a GraphQL document, in order —
     * `query Foo`, `mutation Bar`, `subscription Baz` at the top level. Only
     * top-level definitions count (a field called `query` inside a selection
     * set is not one), so strings and comments are stripped and brace /
     * parenthesis depth is tracked. Anonymous operations yield nothing.
     */
    function queryOperationNames(query) {
        if (typeof query !== 'string' || query === '') return [];
        const text = query
            .replace(/"""[\s\S]*?"""/g, '""')
            .replace(/"(?:[^"\\\r\n]|\\.)*"/g, '""')
            .replace(/#[^\r\n]*/g, '');
        const token = /[{}()]|\b(?:query|mutation|subscription)\b[\s,]+([_A-Za-z][_0-9A-Za-z]*)/g;
        const names = [];
        let depth = 0;
        let found;
        while ((found = token.exec(text)) !== null) {
            if (found[0] === '{' || found[0] === '(') depth++;
            else if (found[0] === '}' || found[0] === ')') depth = Math.max(0, depth - 1);
            else if (depth === 0) names.push(found[1]);
        }
        return names;
    }

    // One GraphQL operation as a client sends it: the operationName field if
    // it has one (it picks the operation out of a multi-operation document),
    // otherwise whatever names the query text declares (Relay-style bodies
    // send only the document).
    function addOperationNames(names, operation) {
        if (!operation || typeof operation !== 'object') return;
        if (typeof operation.operationName === 'string' && operation.operationName !== '') {
            names.add(operation.operationName);
        } else {
            for (const name of queryOperationNames(operation.query)) names.add(name);
        }
    }

    /**
     * PER-23 / PER-38: everything a request says about which GraphQL
     * operation(s) it is, read once. Sources: the JSON body (an array body is
     * a batch — every element counts) and the URL's query string (persisted-
     * query and plain GET requests send ?operationName=...). `unparsed` is the
     * body text when it is not JSON, for the pattern fallback in matchGraphQL.
     */
    function readGraphQLRequest(bodyText, url) {
        const names = new Set();
        let unparsed = null;

        if (typeof bodyText === 'string' && bodyText !== '') {
            try {
                const parsed = JSON.parse(bodyText);
                (Array.isArray(parsed) ? parsed : [parsed]).forEach((operation) => addOperationNames(names, operation));
            } catch (error) {
                unparsed = bodyText;
            }
        }

        if (typeof url === 'string') {
            const hash = url.indexOf('#');
            const noFragment = hash === -1 ? url : url.slice(0, hash);
            const queryStart = noFragment.indexOf('?');
            if (queryStart !== -1) {
                try {
                    const params = new URLSearchParams(noFragment.slice(queryStart + 1));
                    addOperationNames(names, { operationName: params.get('operationName'), query: params.get('query') });
                } catch (error) {
                    // A query string that will not parse names no operation.
                }
            }
        }

        return { names, unparsed };
    }

    /**
     * Match a GraphQL operationName condition against a request.
     * The name can come from the JSON body (any element of a batched array),
     * from the name declared in the body's `query`, or from the URL's
     * ?operationName= (GET). When the body is not JSON, falls back to a regex
     * looking for "operationName":"<name>". Absent graphqlMatch -> true.
     *
     * `url` is optional (body-only callers keep working). `memo` is an
     * optional scratch object a caller scanning many rules passes to every
     * call, so the body is parsed once per request instead of once per
     * GraphQL rule (PER-38: 36 ms per request with 50 rules and a 565 KB body).
     */
    function matchGraphQL(bodyText, graphqlMatch, url, memo) {
        if (!graphqlMatch || !graphqlMatch.operationName) return true;

        let request = memo && memo.graphql;
        if (!request) {
            request = readGraphQLRequest(bodyText, url);
            if (memo) memo.graphql = request;
        }

        if (request.names.has(graphqlMatch.operationName)) return true;
        if (request.unparsed === null) return false;

        const escapedName = graphqlMatch.operationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp('"operationName"\\s*:\\s*"' + escapedName + '"');
        return regex.test(request.unparsed);
    }

    /**
     * Find the first enabled, interceptor-handled rule (array order) whose
     * url + method + headers + graphql conditions all match. Method '*'
     * matches any method.
     */
    function findMatchingRule(rules, request) {
        if (!Array.isArray(rules)) return null;
        const { url, method, headers, bodyText } = request || {};

        // PER-36: keep every pattern of this rule set cached (see the cache).
        patternCacheMax = Math.max(PATTERN_CACHE_MIN, rules.length);

        // PERF-7: this uppercased the *request's* method once per rule, so a
        // page with N rules allocated N throwaway strings for every request to
        // compare against a value that cannot change mid-scan.
        const requestMethod = String(method || '').toUpperCase();

        // PER-38: filled by the first GraphQL rule that gets this far.
        const graphqlMemo = {};

        for (const rule of rules) {
            if (!rule || !rule.enabled) continue;

            const type = rule.type || 'mock';
            if (!INTERCEPTOR_TYPES.has(type)) continue;

            const match = rule.match || {};
            const ruleMethod = (match.method || '*').toUpperCase();
            if (ruleMethod !== '*' && requestMethod !== ruleMethod) continue;

            if (!matchUrl(url, match.url)) continue;
            if (!matchHeaders(headers, match.headers)) continue;
            if (!matchGraphQL(bodyText, match.graphql, url, graphqlMemo)) continue;

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
