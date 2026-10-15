/**
 * SpliceTap Matcher
 * Shared URL / header / GraphQL / rule matching logic (UMD).
 * Loads as: (a) a plain MAIN-world script, (b) a CommonJS module under Jest,
 * (c) via ESM side-effect import.
 */
(function (global) {
    'use strict';

    // PER-2 (Contract B): this runs in the page's realm and is handed every
    // rule, so anything it calls through a prototype or a global is a hook the
    // page can install before its first request: a getter on Object.prototype
    // fires when a rule lacks a property, a String.prototype method receives
    // each URL pattern, Array.prototype[Symbol.iterator] sees the rule list,
    // Map.prototype.get sees the cache keys. This file loads at document_start,
    // before any page script, so what it captures here is the genuine built-in.
    // Every built-in applied to rule data below is one of these, called with
    // the object as its first argument (uncurryThis) rather than looked up on
    // it, over index loops, and over rules that may be null-prototype objects
    // and arrays (state sync copies them so: there is no prototype to hook).
    const uncurryThis = Function.prototype.bind.bind(Function.prototype.call);

    const NativeRegExp = RegExp;
    const NativeString = String;
    const isArray = Array.isArray;
    const objectKeys = Object.keys;
    const objectCreate = Object.create;
    const objectSetPrototypeOf = Object.setPrototypeOf;
    const objectDefineProperty = Object.defineProperty;
    const hasOwnProperty = uncurryThis(Object.prototype.hasOwnProperty);
    const jsonParse = JSON.parse;
    const mathMax = Math.max;
    const mathMin = Math.min;
    const mathFloor = Math.floor;
    const dateNow = Date.now;
    const stringStartsWith = uncurryThis(String.prototype.startsWith);
    const stringEndsWith = uncurryThis(String.prototype.endsWith);
    const stringIncludes = uncurryThis(String.prototype.includes);
    const stringIndexOf = uncurryThis(String.prototype.indexOf);
    const stringSlice = uncurryThis(String.prototype.slice);
    const stringRepeat = uncurryThis(String.prototype.repeat);
    const stringReplace = uncurryThis(String.prototype.replace);
    const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
    const stringToUpperCase = uncurryThis(String.prototype.toUpperCase);
    // RegExp.prototype.test and String.prototype.replace/split look exec (and
    // @@replace, @@split) up on the object at call time, so a page that
    // replaced those would still see the text. The builtin exec reads nothing
    // from the regex but lastIndex, so matching goes through it directly.
    const regexExec = uncurryThis(RegExp.prototype.exec);
    const mapGet = uncurryThis(Map.prototype.get);
    const mapSet = uncurryThis(Map.prototype.set);
    const mapDelete = uncurryThis(Map.prototype.delete);
    const mapKeys = uncurryThis(Map.prototype.keys);
    const mapSize = uncurryThis(Object.getOwnPropertyDescriptor(Map.prototype, 'size').get);
    const mapIteratorNext = uncurryThis(Object.getPrototypeOf(new Map().keys()).next);
    const setHas = uncurryThis(Set.prototype.has);
    const setAdd = uncurryThis(Set.prototype.add);
    // console.error is handed patterns (and the engine's error for one, which
    // quotes it), so a page that replaced it would read them.
    const consoleObject = typeof console !== 'undefined' ? console : null;
    const consoleError = consoleObject && typeof consoleObject.error === 'function'
        ? uncurryThis(consoleObject.error)
        : null;
    function reportError(message, detail) {
        if (consoleError) consoleError(consoleObject, message, detail);
    }

    // A read that never reaches the prototype chain. Rules from the state sync
    // are null-prototype already; this keeps an ordinary object (a unit test, a
    // caller that did not copy) from hitting an Object.prototype getter named
    // `headers` or `graphql` when the rule simply lacks one.
    function own(object, key) {
        return hasOwnProperty(object, key) ? object[key] : undefined;
    }

    // Lists built here hold pattern-derived text, so they have no prototype to
    // hook: no setter at an index, no iterator, and only the helpers below.
    function newList() {
        const list = [];
        objectSetPrototypeOf(list, null);
        return list;
    }
    function listPush(list, value) {
        list[list.length] = value;
    }
    function listIncludes(list, value) {
        for (let i = 0; i < list.length; i++) if (list[i] === value) return true;
        return false;
    }
    function listAddUnique(list, value) {
        if (!listIncludes(list, value)) listPush(list, value);
    }
    function listOf(values) {
        const list = newList();
        for (let i = 0; i < values.length; i++) listPush(list, values[i]);
        return list;
    }
    // B2-F7: a rule without a `match` block reads its conditions from here.
    const EMPTY_MATCH = objectCreate(null);
    function nullProtoTable(entries) {
        const table = objectCreate(null);
        const keys = objectKeys(entries);
        for (let i = 0; i < keys.length; i++) table[keys[i]] = entries[keys[i]];
        return table;
    }

    // Rule types handled by the interceptor (fetch/XHR patch). 'headers' and
    // 'queryparams' are DNR-backed and are never matched here.
    const INTERCEPTOR_TYPES = new Set(['mock', 'block', 'delay', 'redirect']);
    // F3: request-body rules run as their own pass before the main one, so
    // they are deliberately not in INTERCEPTOR_TYPES.
    const REQUEST_BODY_TYPE = 'requestBody';

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
    const performanceNow = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? uncurryThis(performance.now)
        : null;
    const probeNow = performanceNow ? () => performanceNow(performance) : () => dateNow();

    // The default terminator. Built rather than written as an escape or a
    // literal: U+FFFF is a noncharacter, and a literal one in a shipped file
    // makes Chrome refuse to load the extension (scripts/chromium-text.js).
    const PROBE_DEFAULT_TERMINATOR = String.fromCharCode(0xFFFF);

    // Lookup tables keyed by a character of the pattern: no prototype, so a
    // getter on Object.prototype never learns which character was asked for.
    const CONTROL_ESCAPES = nullProtoTable({ n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' });
    const CLASS_ESCAPE_SAMPLES = nullProtoTable({ d: '0', w: 'a', s: ' ' });
    // A character each negated class escape REFUSES. A terminator the pattern
    // can consume ends nothing: \W and \D happily eat U+FFFF, so a probe that
    // ends in it matches and never backtracks.
    const REFUSED_BY_ESCAPE = nullProtoTable({ D: '0', W: 'a', S: ' ' });

    const REGEX_SPECIALS = '.*+?^${}()|[]\\';

    function isDigit(ch) {
        return ch >= '0' && ch <= '9';
    }
    function isAlphanumeric(ch) {
        return isDigit(ch) || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
    }

    // Does the `{` at body[from] open a counted quantifier ({3}, {3,}, {3,5})?
    // This read the next 16 characters with /^\{\d+(,\d*)?\}/.
    function isBraceQuantifier(body, from) {
        const window = stringSlice(body, from, from + 16);
        let j = 1;
        let digits = 0;
        while (j < window.length && isDigit(window[j])) { j++; digits++; }
        if (digits === 0) return false;
        if (j < window.length && window[j] === ',') {
            j++;
            while (j < window.length && isDigit(window[j])) j++;
        }
        return j < window.length && window[j] === '}';
    }

    // The text with every regex metacharacter escaped.
    function escapeRegExp(text) {
        const source = NativeString(text);
        let out = '';
        for (let i = 0; i < source.length; i++) {
            const c = source[i];
            out += stringIndexOf(REGEX_SPECIALS, c) !== -1 ? '\\' + c : c;
        }
        return out;
    }

    // A wildcard pattern as regex source: every character literal, '*' as '.*'.
    function wildcardToRegexSource(pattern) {
        let out = '';
        for (let i = 0; i < pattern.length; i++) {
            const c = pattern[i];
            if (c === '*') out += '.*';
            else out += stringIndexOf(REGEX_SPECIALS, c) !== -1 ? '\\' + c : c;
        }
        return out;
    }

    // String.prototype.split for a one-character separator, without the @@split
    // lookup split performs on its separator (a hook there receives the text).
    function splitOn(text, separator) {
        const parts = newList();
        let from = 0;
        for (;;) {
            const at = stringIndexOf(text, separator, from);
            if (at === -1) break;
            listPush(parts, stringSlice(text, from, at));
            from = at + separator.length;
        }
        listPush(parts, stringSlice(text, from));
        return parts;
    }

    /**
     * Read the literal material out of a regex body: the runs of literal text
     * (split at groups, alternation and quantifiers — a quantifier detaches
     * the character it applies to), the single characters and class members
     * mentioned, a character each negated class (and '.') refuses, and the
     * leading literal. A scanner, not a parser; it only needs to find good
     * probes.
     */
    function analyzePattern(body) {
        const runs = newList();
        const chars = newList();
        const refused = newList();
        let prefix = '';
        let leading = true;
        let run = '';

        // body[k] past the end falls through to String.prototype[k], so every
        // read that can overshoot goes through here.
        const at = (k) => (k >= 0 && k < body.length ? body[k] : undefined);
        const addChar = (c) => listAddUnique(chars, c);
        const flush = () => {
            if (run.length > 0) listPush(runs, run);
            if (leading) { prefix = run; leading = false; }
            run = '';
        };
        const skipTo = (from, ch) => {
            const close = stringIndexOf(body, ch, from);
            return close === -1 ? body.length : close;
        };

        for (let i = 0; i < body.length; i++) {
            const c = body[i];
            if (c === '\\') {
                const next = at(++i);
                if (next === undefined) break;
                if (CONTROL_ESCAPES[next]) {
                    run += CONTROL_ESCAPES[next];
                } else if (isAlphanumeric(next)) {
                    // \d \w \s \b, a backreference, \xHH, \p{..}: no literal.
                    flush();
                    if (REFUSED_BY_ESCAPE[next]) listPush(refused, REFUSED_BY_ESCAPE[next]);
                    if ((next === 'p' || next === 'P') && at(i + 1) === '{') i = skipTo(i, '}');
                    if (next === 'k' && at(i + 1) === '<') i = skipTo(i, '>');
                } else {
                    run += next;
                    addChar(next);
                }
            } else if (c === '*' || c === '+' || c === '?'
                || (c === '{' && isBraceQuantifier(body, i))) {
                if (c === '{') i = skipTo(i, '}');
                if (run.length > 0) {
                    // The quantifier binds to the last character only.
                    const last = stringSlice(run, -1);
                    run = stringSlice(run, 0, -1);
                    flush();
                    listPush(runs, last);
                }
            } else if (c === '(') {
                flush();
                if (at(i + 1) === '?') {
                    i++;
                    const kind = at(i + 1);
                    if (kind === ':' || kind === '=' || kind === '!') {
                        i++;
                    } else if (kind === '<') {
                        i++;
                        if (at(i + 1) === '=' || at(i + 1) === '!') i++;
                        else i = skipTo(i, '>');
                    }
                }
            } else if (c === '.') {
                flush();
                listPush(refused, '\n'); // the one character '.' will not consume
            } else if (c === ')' || c === '|' || c === '$') {
                flush();
            } else if (c === '^') {
                if (!leading || run.length > 0) flush();
            } else if (c === '[') {
                flush();
                let j = i + 1;
                const negated = at(j) === '^';
                if (negated) j++;
                const members = newList();
                for (; j < body.length && body[j] !== ']'; j++) {
                    let m = body[j];
                    if (m === '\\') {
                        m = at(++j);
                        if (m === undefined) break;
                        if (isAlphanumeric(m)) {
                            if (CLASS_ESCAPE_SAMPLES[m]) listPush(members, CLASS_ESCAPE_SAMPLES[m]);
                            continue;
                        }
                    }
                    listPush(members, m);
                }
                i = j;
                if (negated) {
                    if (members.length > 0) listPush(refused, members[0]);
                } else {
                    for (let k = 0; k < members.length && k < 4; k++) addChar(members[k]);
                }
            } else {
                run += c;
                addChar(c);
            }
        }
        flush();

        return { runs, chars, refused, prefix: stringSlice(prefix, 0, 60) };
    }

    function probeUnits(info) {
        const units = newList();
        // The pattern's own literal runs.
        let derived = 0;
        for (let i = 0; i < info.runs.length && derived < 12; i++) {
            if (info.runs[i].length <= PROBE_MAX_UNIT) { listAddUnique(units, info.runs[i]); derived++; }
        }
        // Its single characters, and two of them alternating: (a|b)+ style ambiguity.
        const singles = mathMin(8, info.chars.length);
        for (let i = 0; i < singles; i++) listAddUnique(units, info.chars[i]);
        const pairable = mathMin(3, singles);
        for (let a = 0; a < pairable; a++) {
            for (let b = a + 1; b < pairable; b++) listAddUnique(units, info.chars[a] + info.chars[b]);
        }
        for (let i = 0; i < PROBE_FIXED_UNITS.length; i++) listAddUnique(units, PROBE_FIXED_UNITS[i]);
        return units;
    }

    function isCatastrophicRegex(regexBody) {
        let re;
        try {
            re = new NativeRegExp(regexBody, 'i');
        } catch (error) {
            return true;
        }

        const info = analyzePattern(regexBody);
        const prefixes = info.prefix ? ['', info.prefix] : [''];
        const terminators = newList();
        listPush(terminators, PROBE_DEFAULT_TERMINATOR);
        for (let i = 0; i < info.refused.length && terminators.length < 4; i++) listAddUnique(terminators, info.refused[i]);
        const start = probeNow();

        const time = (text) => {
            const began = probeNow();
            regexExec(re, text);
            return probeNow() - began;
        };

        try {
            const units = probeUnits(info);
            for (let u = 0; u < units.length; u++) {
                const unit = units[u];
                const maxReps = mathMin(PROBE_MAX_REPS, mathFloor(PROBE_MAX_LENGTH / unit.length));
                for (let p = 0; p < prefixes.length; p++) {
                    for (let t = 0; t < terminators.length; t++) {
                        for (let reps = PROBE_MIN_REPS; reps <= maxReps;) {
                            const text = prefixes[p] + stringRepeat(unit, reps) + terminators[t];
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
        const cached = mapGet(patternCache, pattern);
        if (cached) return cached;

        let compiled;
        try {
            if (typeof pattern !== 'string') {
                compiled = { kind: 'never' };
            } else if (stringStartsWith(pattern, '/') && stringEndsWith(pattern, '/')) {
                const regexBody = stringSlice(pattern, 1, -1);
                if (regexBody.length === 0) {
                    // Q-10: '/' or '//' must not become an empty regex that matches everything.
                    compiled = { kind: 'never' };
                } else if (isCatastrophicRegex(regexBody)) {
                    reportError('SpliceTap: refusing potentially catastrophic regex pattern:', pattern);
                    compiled = { kind: 'never' };
                } else {
                    compiled = { kind: 'regex', regex: new NativeRegExp(regexBody, 'i') };
                }
            } else if (stringIncludes(pattern, '*')) {
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
                const segments = splitOn(pattern, '*');
                let literalCount = 0;
                let firstLiteral = '';
                for (let i = 0; i < segments.length; i++) {
                    if (segments[i].length > 0) {
                        if (literalCount === 0) firstLiteral = segments[i];
                        literalCount++;
                    }
                }

                if (literalCount === 0) {
                    compiled = { kind: 'any' }; // '*', '**', ...
                } else if (literalCount === 1) {
                    const literal = stringToLowerCase(firstLiteral);
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
                    compiled = { kind: 'regex', regex: new NativeRegExp('^' + wildcardToRegexSource(pattern) + '$', 'i') };
                }
            } else {
                compiled = { kind: 'substring', lower: stringToLowerCase(pattern) };
            }
        } catch (error) {
            reportError('Error compiling URL pattern:', error);
            compiled = { kind: 'never' };
        }

        // A loop, not an if: the cap follows the rule set (PER-36), so it can
        // also shrink between scans.
        while (mapSize(patternCache) >= patternCacheMax) {
            mapDelete(patternCache, mapIteratorNext(mapKeys(patternCache)).value);
        }
        mapSet(patternCache, pattern, compiled);
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
            return regexExec(compiled.regex, url) !== null;
        }

        if (url !== lastUrl) {
            lastUrl = url;
            lastUrlLower = stringToLowerCase(url);
        }

        if (compiled.kind === 'prefix') return stringStartsWith(lastUrlLower, compiled.lower);
        if (compiled.kind === 'suffix') return stringEndsWith(lastUrlLower, compiled.lower);
        return stringIncludes(lastUrlLower, compiled.lower);
    }

    /**
     * Match request headers against a rule's header conditions.
     * ALL rule entries must match; header name compare is case-insensitive;
     * value compare is substring. Empty/absent ruleHeaders -> true.
     */
    function matchHeaders(requestHeaders, ruleHeaders) {
        if (!ruleHeaders) return true;
        const names = objectKeys(ruleHeaders);
        if (names.length === 0) return true;

        // No prototype: a rule's header name is looked up here, and a request
        // header called "__proto__" is data, not a prototype swap.
        const normalizedRequestHeaders = objectCreate(null);
        if (requestHeaders) {
            const keys = objectKeys(requestHeaders);
            for (let i = 0; i < keys.length; i++) {
                normalizedRequestHeaders[stringToLowerCase(keys[i])] = requestHeaders[keys[i]];
            }
        }

        for (let i = 0; i < names.length; i++) {
            const expected = ruleHeaders[names[i]];
            const actual = normalizedRequestHeaders[stringToLowerCase(names[i])];
            if (actual === undefined || actual === null) return false;
            if (!stringIncludes(stringToLowerCase(NativeString(actual)), stringToLowerCase(NativeString(expected)))) return false;
        }
        return true;
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
        let text = stringReplace(query, /"""[\s\S]*?"""/g, '""');
        text = stringReplace(text, /"(?:[^"\\\r\n]|\\.)*"/g, '""');
        text = stringReplace(text, /#[^\r\n]*/g, '');
        const token = /[{}()]|\b(?:query|mutation|subscription)\b[\s,]+([_A-Za-z][_0-9A-Za-z]*)/g;
        const names = newList();
        let depth = 0;
        let found;
        while ((found = regexExec(token, text)) !== null) {
            if (found[0] === '{' || found[0] === '(') depth++;
            else if (found[0] === '}' || found[0] === ')') depth = mathMax(0, depth - 1);
            else if (depth === 0) listPush(names, found[1]);
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
            setAdd(names, operation.operationName);
        } else {
            const declared = queryOperationNames(operation.query);
            for (let i = 0; i < declared.length; i++) setAdd(names, declared[i]);
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
                const parsed = jsonParse(bodyText);
                if (isArray(parsed)) {
                    for (let i = 0; i < parsed.length; i++) addOperationNames(names, parsed[i]);
                } else {
                    addOperationNames(names, parsed);
                }
            } catch (error) {
                unparsed = bodyText;
            }
        }

        if (typeof url === 'string') {
            const hash = stringIndexOf(url, '#');
            const noFragment = hash === -1 ? url : stringSlice(url, 0, hash);
            const queryStart = stringIndexOf(noFragment, '?');
            if (queryStart !== -1) {
                try {
                    const params = new URLSearchParams(stringSlice(noFragment, queryStart + 1));
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
        const wanted = graphqlMatch ? own(graphqlMatch, 'operationName') : undefined;
        if (!wanted) return true;

        let request = memo ? own(memo, 'graphql') : undefined;
        if (!request) {
            request = readGraphQLRequest(bodyText, url);
            if (memo) {
                // A prototype-less descriptor: see setOwn in src/patch.js.
                objectDefineProperty(memo, 'graphql', { __proto__: null, value: request, writable: true, enumerable: true, configurable: true });
            }
        }

        if (setHas(request.names, wanted)) return true;
        if (request.unparsed === null) return false;

        const regex = new NativeRegExp('"operationName"\\s*:\\s*"' + escapeRegExp(wanted) + '"');
        return regexExec(regex, request.unparsed) !== null;
    }

    // B2-F7: a host as compared: lowercase, without the trailing dot of a
    // fully qualified name ('example.com.').
    function normalizeHost(host) {
        const lowered = stringToLowerCase(NativeString(host));
        return stringEndsWith(lowered, '.') ? stringSlice(lowered, 0, -1) : lowered;
    }

    // B2-F7: does `host` fall under `domain` — the name itself or a
    // subdomain of it, as DNR's initiatorDomains reads it.
    function hostWithin(host, domain) {
        const name = normalizeHost(domain);
        if (name === '' || host === '') return false;
        return host === name || stringEndsWith(host, '.' + name);
    }

    /**
     * B2-F7: `match.pageDomains` against the host of the page (or frame) that
     * makes the request. No list (or an empty one) is no condition. An
     * unknown host — a caller that names no page — matches no list: the rule
     * only runs on those pages, and nothing says this is one.
     */
    function matchPageDomains(pageHost, domains) {
        if (!isArray(domains) || domains.length === 0) return true;
        if (typeof pageHost !== 'string') return false;
        const host = normalizeHost(pageHost);
        for (let i = 0; i < domains.length; i++) {
            if (typeof domains[i] === 'string' && hostWithin(host, domains[i])) return true;
        }
        return false;
    }

    // B2-F7: what a rule reaches when it has no `match.resourceTypes`.
    const FETCH_XHR = 'fetch-xhr';
    const RESOURCE_TYPES = listOf([FETCH_XHR, 'document', 'subdocument', 'script', 'stylesheet', 'image', 'font',
        'media', 'websocket', 'ping', 'other']);
    const API_RESOURCE_TYPES = listOf([FETCH_XHR, 'other']);
    const PAGE_RESOURCE_TYPES = listOf([FETCH_XHR]);
    const NETWORK_RULE_TYPES = new Set(['headers', 'queryparams']);

    function isAllRequestsRule(rule) {
        const type = own(rule, 'type') || 'mock';
        return (type === 'block' || type === 'redirect') && own(rule, 'appliesTo') === 'all';
    }

    /**
     * B2-F7: the resource types a rule applies to. Its own list when it has
     * one; otherwise every type for an appliesTo:'all' block or redirect,
     * fetch/XHR plus 'other' for headers and query-parameter rules, and
     * fetch/XHR alone for everything the in-page interceptor runs.
     */
    function ruleResourceTypes(rule) {
        const match = own(rule, 'match');
        const listed = match && typeof match === 'object' ? own(match, 'resourceTypes') : undefined;
        if (isArray(listed) && listed.length > 0) return listed;
        if (isAllRequestsRule(rule)) return RESOURCE_TYPES;
        return setHas(NETWORK_RULE_TYPES, own(rule, 'type')) ? API_RESOURCE_TYPES : PAGE_RESOURCE_TYPES;
    }

    function matchResourceType(rule, resourceType) {
        return listIncludes(ruleResourceTypes(rule), resourceType || FETCH_XHR);
    }

    // B2-F7: the JSON request body, parsed once per request (see the
    // GraphQL memo). `ok` is false for a body that is absent or not JSON.
    function parsedBody(bodyText, memo) {
        let parsed = memo ? own(memo, 'json') : undefined;
        if (parsed) return parsed;
        parsed = objectCreate(null);
        parsed.ok = false;
        if (typeof bodyText === 'string' && bodyText !== '') {
            try {
                parsed.value = jsonParse(bodyText);
                parsed.ok = true;
            } catch (error) {
                // Not JSON: a payload condition never matches it.
            }
        }
        if (memo) {
            objectDefineProperty(memo, 'json', { __proto__: null, value: parsed, writable: true, enumerable: true, configurable: true });
        }
        return parsed;
    }

    /**
     * B2-F7: the value at a dot path ('user.id', 'items.0.sku') in parsed
     * JSON. Own properties only, so a key the body lacks never reaches a
     * getter the page put on Object.prototype (the key is rule data).
     * `found` is false when the path leaves the body.
     */
    function valueAtPath(value, path) {
        const result = objectCreate(null);
        result.found = false;
        if (typeof path !== 'string' || path === '') return result;
        const segments = splitOn(path, '.');
        let current = value;
        for (let i = 0; i < segments.length; i++) {
            if (current === null || typeof current !== 'object' || !hasOwnProperty(current, segments[i])) return result;
            current = current[segments[i]];
        }
        result.found = true;
        result.value = current;
        return result;
    }

    // B2-F7: String(value) for parsed JSON, without the toString and join
    // lookups String() makes on an object or array (page-hookable).
    function jsonValueText(value) {
        if (value === null) return 'null';
        if (typeof value !== 'object') return NativeString(value);
        if (!isArray(value)) return '[object Object]';
        let out = '';
        for (let i = 0; i < value.length; i++) {
            if (i > 0) out += ',';
            const item = value[i];
            if (item !== null && item !== undefined) out += jsonValueText(item);
        }
        return out;
    }

    function payloadCompare(actual, operator, expected) {
        if (operator === 'equals') return actual === expected;
        if (operator === 'contains') return stringIncludes(actual, expected);
        return false;
    }

    /**
     * B2-F7: `match.payload` ({ path, operator, value }) against the JSON
     * request body: String(value at path) equals, or contains, `value`. A
     * body that is absent or not JSON, or lacks the path, never matches.
     * Absent payload -> true. `memo` as for matchGraphQL.
     */
    function matchPayload(bodyText, payload, memo) {
        if (!payload || typeof payload !== 'object') return true;
        const body = parsedBody(bodyText, memo);
        if (!body.ok) return false;
        const at = valueAtPath(body.value, own(payload, 'path'));
        if (!at.found) return false;
        const expected = own(payload, 'value');
        return payloadCompare(jsonValueText(at.value), own(payload, 'operator'),
            expected === undefined || expected === null ? '' : NativeString(expected));
    }

    /**
     * Find the first enabled, interceptor-handled rule (array order) whose
     * url + method + headers + graphql conditions all match. Method '*'
     * matches any method.
     *
     * B2-F7: and whose page domains, resource types and payload condition
     * match too. The request may carry `pageHost` (the requesting frame's
     * host), `resourceType` (default 'fetch-xhr') and `altUrl`, the URL as
     * the page wrote it: a rule matches if either URL form does (PER-8), in
     * one scan.
     */
    function findMatchingRule(rules, request) {
        return findFirstMatch(rules, request, false);
    }

    /**
     * F3: the first enabled `requestBody` rule (array order) matching the
     * request, judged exactly as findMatchingRule judges the main pass. A
     * separate pass, as in Requestly: the interceptor applies this rule to
     * the body first, then runs findMatchingRule on the modified request.
     */
    function findMatchingRequestBodyRule(rules, request) {
        return findFirstMatch(rules, request, true);
    }

    // `requestBodyPass`: requestBody rules only (F3), else the main-pass types.
    function findFirstMatch(rules, request, requestBodyPass) {
        if (!isArray(rules)) return null;
        const record = request && typeof request === 'object' ? request : objectCreate(null);
        const url = own(record, 'url');
        const method = own(record, 'method');
        const headers = own(record, 'headers');
        const bodyText = own(record, 'bodyText');
        // B2-F7: see findMatchingRule.
        const pageHost = own(record, 'pageHost');
        const resourceType = own(record, 'resourceType') || FETCH_XHR;
        const rawAltUrl = own(record, 'altUrl');
        const altUrl = typeof rawAltUrl === 'string' && rawAltUrl !== url ? rawAltUrl : null;

        // PER-36: keep every pattern of this rule set cached (see the cache).
        patternCacheMax = mathMax(PATTERN_CACHE_MIN, rules.length);

        // PERF-7: this uppercased the *request's* method once per rule, so a
        // page with N rules allocated N throwaway strings for every request to
        // compare against a value that cannot change mid-scan.
        const requestMethod = stringToUpperCase(NativeString(method || ''));

        // PER-38: filled by the first GraphQL rule that gets this far.
        // B2-F7: and the parsed body, by the first payload rule.
        const graphqlMemo = objectCreate(null);

        // PER-2: an index loop (for...of asks the rule list for its iterator)
        // and own-property reads (a rule lacking `headers` must not fall
        // through to a getter on Object.prototype).
        for (let i = 0; i < rules.length; i++) {
            const rule = rules[i];
            if (!rule || !own(rule, 'enabled')) continue;

            const type = own(rule, 'type') || 'mock';
            if (requestBodyPass ? type !== REQUEST_BODY_TYPE : !setHas(INTERCEPTOR_TYPES, type)) continue;

            const match = own(rule, 'match') || EMPTY_MATCH;
            const ruleMethod = stringToUpperCase(own(match, 'method') || '*');
            if (ruleMethod !== '*' && requestMethod !== ruleMethod) continue;

            const pattern = own(match, 'url');
            if (!matchUrl(url, pattern) && !(altUrl !== null && matchUrl(altUrl, pattern))) continue;
            if (!matchPageDomains(pageHost, own(match, 'pageDomains'))) continue;
            if (!matchResourceType(rule, resourceType)) continue;
            if (!matchHeaders(headers, own(match, 'headers'))) continue;
            if (!matchGraphQL(bodyText, own(match, 'graphql'), url, graphqlMemo)) continue;
            if (!matchPayload(bodyText, own(match, 'payload'), graphqlMemo)) continue;

            return rule;
        }

        return null;
    }

    // --- B2-F10: why a rule does or does not match a request -----------------
    //
    // For the "Try a URL" box and shadowing warnings (the service worker's
    // explainMatch and the editors). Never called on the page's request path.

    const DETAIL_TEXT_MAX = 60;

    // Text from a rule or request, quoted into a detail and kept short.
    function shown(text) {
        const value = NativeString(text);
        return value.length > DETAIL_TEXT_MAX ? stringSlice(value, 0, DETAIL_TEXT_MAX - 1) + '…' : value;
    }
    function quoted(text) {
        return '"' + shown(text) + '"';
    }

    // 'a', 'a or b', 'a, b or c'.
    function orList(items) {
        let out = '';
        for (let i = 0; i < items.length; i++) {
            if (i > 0) out += i === items.length - 1 ? ' or ' : ', ';
            out += items[i];
        }
        return out;
    }

    const RESOURCE_TYPE_LABELS = nullProtoTable({
        'fetch-xhr': 'fetch/XHR calls', document: 'pages', subdocument: 'frames', script: 'scripts',
        stylesheet: 'stylesheets', image: 'images', font: 'fonts', media: 'media', websocket: 'WebSockets',
        ping: 'pings and beacons', other: 'other requests'
    });
    function resourceTypeLabel(type) {
        return RESOURCE_TYPE_LABELS[type] || quoted(type);
    }

    function check(condition, ok, detail) {
        return { condition, ok, detail };
    }

    // How a URL pattern is read (see compilePattern).
    function patternKind(pattern) {
        if (stringStartsWith(pattern, '/') && stringEndsWith(pattern, '/')) return 'regex';
        return stringIncludes(pattern, '*') ? 'wildcard' : 'substring';
    }

    // The URL as a same-site page usually writes it: its path, query and
    // fragment. In the page a rule also matches that form (PER-8).
    function relativeForm(url) {
        const scheme = regexExec(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, url);
        if (!scheme) return null;
        const rest = stringSlice(url, scheme[0].length);
        return rest === '' ? '/' : rest;
    }

    function explainUrl(pattern, url, rawUrl) {
        if (typeof pattern !== 'string' || pattern === '') {
            return check('url', false, 'This rule has no URL pattern, so it matches nothing.');
        }
        if (typeof url !== 'string' || url === '') return check('url', false, 'No URL was given to test.');
        const kind = patternKind(pattern);
        if (compilePattern(pattern).kind === 'never') {
            return check('url', false, `The pattern ${shown(pattern)} is not a usable regular expression (invalid, empty or too slow to run safely), so it matches nothing.`);
        }
        const what = kind === 'regex' ? `the regular expression ${shown(pattern)}`
            : kind === 'wildcard' ? `the wildcard pattern ${quoted(pattern)}` : null;
        if (matchUrl(url, pattern)) {
            return check('url', true, what ? `The URL matches ${what}.` : `The URL contains ${quoted(pattern)}.`);
        }
        const alternative = typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : relativeForm(url);
        if (alternative !== null && alternative !== url && matchUrl(alternative, pattern)) {
            return check('url', true, `The URL as a relative path (${quoted(alternative)}) matches ${what || quoted(pattern)}, as when the page calls it that way.`);
        }
        return check('url', false, what ? `The URL does not match ${what}.` : `The URL does not contain ${quoted(pattern)}.`);
    }

    function explainMethod(ruleMethod, method) {
        const wanted = stringToUpperCase(NativeString(ruleMethod || '*'));
        const actual = stringToUpperCase(NativeString(method || 'GET'));
        if (wanted === '*') return check('method', true, 'Any method matches.');
        if (wanted === actual) return check('method', true, `The method is ${shown(actual)}.`);
        return check('method', false, `The rule needs ${shown(wanted)}, but this request is ${shown(actual)}.`);
    }

    function explainHeaders(requestHeaders, ruleHeaders) {
        const names = objectKeys(ruleHeaders);
        const request = objectCreate(null);
        if (requestHeaders && typeof requestHeaders === 'object') {
            const keys = objectKeys(requestHeaders);
            for (let i = 0; i < keys.length; i++) request[stringToLowerCase(keys[i])] = requestHeaders[keys[i]];
        }
        for (let i = 0; i < names.length; i++) {
            const expected = NativeString(ruleHeaders[names[i]]);
            const actual = request[stringToLowerCase(names[i])];
            if (actual === undefined || actual === null) {
                return check('headers', false, `The request has no ${quoted(names[i])} header.`);
            }
            if (!stringIncludes(stringToLowerCase(NativeString(actual)), stringToLowerCase(expected))) {
                return check('headers', false, `The ${quoted(names[i])} header does not contain ${quoted(expected)}.`);
            }
        }
        return check('headers', true, names.length === 1
            ? `The ${quoted(names[0])} header contains ${quoted(ruleHeaders[names[0]])}.`
            : `All ${names.length} header conditions match.`);
    }

    function explainGraphQL(bodyText, url, wanted) {
        if (matchGraphQL(bodyText, { operationName: wanted }, url)) {
            return check('graphql', true, `The GraphQL operation is ${quoted(wanted)}.`);
        }
        const found = newList();
        const names = readGraphQLRequest(bodyText, url).names;
        names.forEach((name) => { if (found.length < 3) listPush(found, quoted(name)); });
        if (found.length > 0) {
            return check('graphql', false, `The GraphQL operation is ${orList(found)}, not ${quoted(wanted)}.`);
        }
        return check('graphql', false, typeof bodyText === 'string' && bodyText !== ''
            ? `The request names no GraphQL operation; the rule needs ${quoted(wanted)}.`
            : `No request body was given, so the GraphQL operation ${quoted(wanted)} cannot be found.`);
    }

    function explainPageDomains(pageHost, domains) {
        const listed = newList();
        for (let i = 0; i < domains.length && listed.length < 5; i++) listPush(listed, shown(domains[i]));
        if (domains.length > 5) listPush(listed, `${domains.length - 5} more`);
        const where = orList(listed);
        if (typeof pageHost !== 'string') {
            return check('pageDomains', false, `No page was given; this rule only runs on pages on ${where}.`);
        }
        const host = normalizeHost(pageHost);
        if (host === '') return check('pageDomains', false, `The page has no host name; this rule only runs on pages on ${where}.`);
        for (let i = 0; i < domains.length; i++) {
            if (typeof domains[i] !== 'string' || !hostWithin(host, domains[i])) continue;
            const domain = normalizeHost(domains[i]);
            return check('pageDomains', true, host === domain
                ? `The page is on ${shown(host)}.`
                : `The page is on ${shown(host)}, within ${shown(domain)}.`);
        }
        return check('pageDomains', false, `The page is on ${shown(host)}, not on ${where}.`);
    }

    function explainResourceType(rule, resourceType) {
        const type = resourceType || FETCH_XHR;
        const types = ruleResourceTypes(rule);
        if (types === RESOURCE_TYPES) return check('resourceTypes', true, 'This rule applies to every kind of request.');
        const labels = newList();
        for (let i = 0; i < types.length; i++) listPush(labels, resourceTypeLabel(types[i]));
        const covered = labels.length === 1 ? labels[0] : orList(labels);
        return listIncludes(types, type)
            ? check('resourceTypes', true, `The rule covers ${resourceTypeLabel(type)}.`)
            : check('resourceTypes', false, `The rule covers ${covered}, not ${resourceTypeLabel(type)}.`);
    }

    function explainPayload(bodyText, payload) {
        const path = own(payload, 'path');
        const operator = own(payload, 'operator');
        const rawExpected = own(payload, 'value');
        const expected = rawExpected === undefined || rawExpected === null ? '' : NativeString(rawExpected);
        if (operator !== 'equals' && operator !== 'contains') {
            return check('payload', false, `The payload operator ${quoted(operator)} is not one SpliceTap knows.`);
        }
        const needs = `${shown(path)} ${operator === 'equals' ? 'to equal' : 'to contain'} ${quoted(expected)}`;
        if (typeof bodyText !== 'string' || bodyText === '') {
            return check('payload', false, `No request body was given; the rule needs ${needs}.`);
        }
        const body = parsedBody(bodyText, null);
        if (!body.ok) return check('payload', false, 'The request body is not JSON, so the payload condition cannot match.');
        const at = valueAtPath(body.value, path);
        if (!at.found) return check('payload', false, `The body has no ${quoted(path)}.`);
        const actual = jsonValueText(at.value);
        const ok = payloadCompare(actual, operator, expected);
        if (operator === 'equals') {
            return check('payload', ok, ok
                ? `The body's ${shown(path)} is ${quoted(actual)}.`
                : `The body's ${shown(path)} is ${quoted(actual)}, not ${quoted(expected)}.`);
        }
        return check('payload', ok, ok
            ? `The body's ${shown(path)} (${quoted(actual)}) contains ${quoted(expected)}.`
            : `The body's ${shown(path)} (${quoted(actual)}) does not contain ${quoted(expected)}.`);
    }

    /**
     * B2-F10: does `rule` match `req`, condition by condition?
     * `req` = { url, method, headers, bodyText, pageHost, resourceType }
     * (and optionally `rawUrl`, the URL as the page wrote it). Returns
     * { matches, checks: [{ condition, ok, detail }] }, `detail` a short
     * plain-English sentence. url and method are always checked; headers,
     * graphql, pageDomains and payload when the rule has them; resourceTypes
     * when the rule lists some or `req` names one. Whether the rule is
     * enabled, its type's pass and a call filter (PER-66) are not judged.
     */
    function explainRuleMatch(rule, req) {
        const request = req && typeof req === 'object' ? req : objectCreate(null);
        const ruleObject = rule && typeof rule === 'object' ? rule : objectCreate(null);
        const matchBlock = own(ruleObject, 'match');
        const match = matchBlock && typeof matchBlock === 'object' ? matchBlock : EMPTY_MATCH;
        const url = own(request, 'url');
        const bodyText = own(request, 'bodyText');
        const checks = [];

        checks[checks.length] = explainUrl(own(match, 'url'), url, own(request, 'rawUrl'));
        checks[checks.length] = explainMethod(own(match, 'method'), own(request, 'method'));

        const headers = own(match, 'headers');
        if (headers && typeof headers === 'object' && objectKeys(headers).length > 0) {
            checks[checks.length] = explainHeaders(own(request, 'headers'), headers);
        }
        const graphql = own(match, 'graphql');
        const operationName = graphql && typeof graphql === 'object' ? own(graphql, 'operationName') : undefined;
        if (operationName) checks[checks.length] = explainGraphQL(bodyText, url, operationName);

        const domains = own(match, 'pageDomains');
        if (isArray(domains) && domains.length > 0) checks[checks.length] = explainPageDomains(own(request, 'pageHost'), domains);

        const listed = own(match, 'resourceTypes');
        const resourceType = own(request, 'resourceType');
        if ((isArray(listed) && listed.length > 0) || resourceType) {
            checks[checks.length] = explainResourceType(ruleObject, resourceType);
        }

        const payload = own(match, 'payload');
        if (payload && typeof payload === 'object') checks[checks.length] = explainPayload(bodyText, payload);

        let matches = true;
        for (let i = 0; i < checks.length; i++) if (!checks[i].ok) matches = false;
        return { matches, checks };
    }

    // isCatastrophicRegex is exported so the save-time validator and the
    // redirect path guard against the same thing this matcher does, rather
    // than each re-deriving (or, as before, omitting) the check.
    const api = {
        matchUrl, matchHeaders, matchGraphQL, findMatchingRule, findMatchingRequestBodyRule, isCatastrophicRegex,
        matchPageDomains, matchPayload, // B2-F7
        explainRuleMatch // B2-F10
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapMatcher = api;
})(typeof window !== 'undefined' ? window : globalThis);
