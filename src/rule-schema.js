/**
 * SpliceTap Rule Schema
 * The one definition of what a valid rule is (UMD).
 * Loads as: (a) a plain script in an extension page, (b) a content script,
 * (c) a CommonJS module under Jest, (d) via ESM side-effect import.
 *
 * Why this exists. Three places decided whether a rule was valid — the
 * background's save boundary, the options editor and the in-page overlay —
 * and each had its own copy of the checks, which had drifted (CQ-1):
 *
 *   - Only the options editor enforced the name and URL length limits.
 *   - Only the options editor checked a header operation's shape, and the
 *     boundary checked it nowhere. A headers rule with `{op:'set', name}` and
 *     no value, arriving by import, was stored as valid; Chrome then rejected
 *     the whole updateDynamicRules batch it was part of, which froze every
 *     headers and queryparams rule at its previous state. Verified headless:
 *     disabling a rule afterwards reported success, the UI showed it off, and
 *     it kept rewriting real traffic.
 *   - validateUrlPattern classified a pattern as a wildcard before checking
 *     for the /regex/ form, so a regex containing '*' — /(a*)*$/ — skipped
 *     both the syntax check and the ReDoS probe and was saved as valid,
 *     though the matcher would never run it.
 *
 * Every surface now asks this module. The editors use it for immediate
 * feedback; the background calls it as the trust boundary, adding only the
 * checks that need Chrome itself (see background.js validateRule).
 */
(function (global) {
    'use strict';

    const common = global.SpliceTapCommon
        || (typeof require === 'function' ? require('./common.js') : null);
    const LIMITS = (common && common.LIMITS) || {
        NAME_MAX: 100, URL_MAX: 500, STATUS_MIN: 200, STATUS_MAX: 599,
        DELAY_MIN: 0, DELAY_MAX: 30000, DELAY_MS_MIN: 1, DELAY_MS_MAX: 30000
    };

    // PER-52: 1xx statuses are interim ("100 Continue", "103 Early Hints"):
    // they precede the real response and can never BE it, and fetch and XHR
    // disagree on what a mocked one is. The shared LIMITS still say 100, which
    // the editors use for their number inputs; the floor is enforced here.
    const STATUS_MIN = Math.max(LIMITS.STATUS_MIN, 200);

    // PER-30: chrome.storage silently truncates a value nested deeper than
    // about 96 levels to `{}` (verified), so a deep mock body or patch came
    // back empty after a reload. Refuse well short of that.
    const JSON_DEPTH_MAX = 64;

    // F3: 'requestBody' rewrites the outgoing body of fetch/XHR in the page.
    const RULE_TYPES = ['mock', 'block', 'delay', 'redirect', 'headers', 'queryparams', 'requestBody'];

    // What the editors offer. Also the set declarativeNetRequest accepts as a
    // requestMethods value (lowercased), so a headers/queryparams rule with
    // any other method would be rejected by Chrome — and take its batch down.
    const METHODS = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

    const RESPONSE_MODES = ['static', 'patch'];

    // F3: how a requestBody rule changes the body. Unlike a mock response,
    // there is no default mode — the rule has to say what it does.
    const REQUEST_BODY_MODES = ['static', 'patch'];

    // F1: where a redirect or block rule applies. 'page' (the default when the
    // field is absent) is fetch/XHR only, handled in the page; 'all' adds every
    // other resource type through declarativeNetRequest.
    const APPLIES_TO = ['page', 'all'];

    // RFC 9110 field-name: a token. Anything else is rejected by `new
    // Headers()` in the page and by declarativeNetRequest in the browser.
    const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

    const MAX_REDIRECT_LENGTH = 2000;

    // Header names a 'headers' rule must never be allowed to touch. All are
    // browser/network security controls: letting an imported rule set or
    // remove them would let one JSON file strip CSP/HSTS/frame protections or
    // force a permissive, credentialed CORS policy on every matching site.
    // Checked case-insensitively. (S-3; moved here from service_worker/dnr.js,
    // which still applies it as its own last line of defence.)
    const FORBIDDEN_HEADER_NAMES = new Set([
        'content-security-policy',
        'content-security-policy-report-only',
        'strict-transport-security',
        'x-frame-options',
        'x-content-type-options',
        'cross-origin-opener-policy',
        'cross-origin-embedder-policy',
        'cross-origin-resource-policy',
        'set-cookie',
        'cookie',
        'permissions-policy'
    ]);

    const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const isRegexPattern = (p) => typeof p === 'string' && p.length >= 2 && p.startsWith('/') && p.endsWith('/');

    // PER-12: header names and values reach `new Headers()` in the page, which
    // throws on anything that is not a ByteString — a character above U+00FF.
    // An en dash (as macOS and Word autocorrect type it), an emoji or CJK text
    // is enough. Reject at save time rather than lose every header at runtime.
    const ABOVE_LATIN1_RE = /[^\x00-\xFF]/;
    const ABOVE_LATIN1_VALUE = 'contains characters above U+00FF (an en dash, emoji or CJK text, for example), '
        + 'which a browser cannot send in a header. Use plain ASCII or Latin-1 text, or percent-encode it.';

    // PER-49: /pattern/flags. Only the slash-delimited form is a regex, so a
    // trailing flag silently turned the whole pattern into a literal substring
    // that no URL contains. A trailing run of flag letters is only read as
    // flags when the body also looks like a regex (an escape, anchor, group,
    // class, alternation or `.*`), so a plain path like /api/v1/i or /api/v is
    // still a substring pattern.
    const REGEX_FLAGGED_RE = /^\/(.+)\/([dgimsuvy]{1,8})$/;
    const REGEX_SYNTAX_RE = /[\\^$()[\]{}|+?]|\.[*+]/;

    // PER-5: does a URL pattern name a host? Yes when, after a "//" (the one
    // in "https://" or "*://"), it spells out a specific host: localhost, an
    // IPv4 address, or a dotted name such as api.example.com, optionally behind
    // a "*." wildcard subdomain. "*/api/*", "*://*/*" and a bare path do not.
    // In a /regex/ the punctuation escapes are undone first, so
    // ^https?:\/\/api\.example\.com\/ reads as https://api.example.com/.
    const HOST_AFTER_SLASHES_RE = /^\(?(?:\?:)?(?:\*\.)?(?:localhost\b|\d{1,3}(?:\.\d{1,3}){3}\b|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b)/i;

    function patternNamesHost(pattern) {
        if (typeof pattern !== 'string') return false;
        const text = isRegexPattern(pattern)
            ? pattern.slice(1, -1).replace(/\\([^A-Za-z0-9])/g, '$1')
            : pattern;
        return text.split('//').slice(1).some((rest) => HOST_AFTER_SLASHES_RE.test(rest));
    }

    // True when a JSON value nests containers deeper than `max` levels.
    // Iterative, and it returns as soon as one path is too deep, so neither a
    // hostile document nor a cyclic object can exhaust the stack or the clock.
    function exceedsDepth(value, max) {
        const stack = [[value, 1]];
        while (stack.length > 0) {
            const [node, depth] = stack.pop();
            if (node === null || typeof node !== 'object') continue;
            if (depth > max) return true;
            for (const child of Array.isArray(node) ? node : Object.values(node)) {
                stack.push([child, depth + 1]);
            }
        }
        return false;
    }

    function getMatcher() {
        return global.SpliceTapMatcher
            || (typeof require === 'function' ? require('./matcher.js') : null);
    }

    /**
     * Validate a URL pattern. The /regex/ form is recognised FIRST — before
     * looking for '*' — because a regex may itself contain '*'. The matcher
     * has made that distinction since Q-3; this validator did not, and waved
     * regexes containing '*' through as wildcards.
     */
    function validateUrlPattern(pattern) {
        if (pattern === undefined || pattern === null || pattern === '') {
            return { isValid: false, error: 'Pattern is required' };
        }
        if (typeof pattern !== 'string') {
            return { isValid: false, error: 'Pattern must be a string' };
        }
        if (pattern.trim().length === 0) {
            return { isValid: false, error: 'Pattern cannot be empty' };
        }
        if (pattern.length > LIMITS.URL_MAX) {
            return { isValid: false, error: `Pattern is too long (max ${LIMITS.URL_MAX} characters)` };
        }

        const flagged = REGEX_FLAGGED_RE.exec(pattern);
        if (flagged && REGEX_SYNTAX_RE.test(flagged[1])) {
            return {
                isValid: false,
                error: `Regex flags aren't supported — matching is already case-insensitive. Remove "${flagged[2]}" after the closing slash (/${flagged[1]}/).`
            };
        }

        if (isRegexPattern(pattern)) {
            const body = pattern.slice(1, -1);
            if (body.length === 0) {
                return { isValid: false, error: 'Regex pattern cannot be empty' };
            }
            try {
                new RegExp(body, 'i');
            } catch (error) {
                return { isValid: false, error: `Invalid regex: ${error.message}` };
            }
            // SEC-1: compiling only proves the syntax is legal, not that the
            // pattern terminates. /(a|a)+$/ compiles and then hangs the tab.
            const matcher = getMatcher();
            if (matcher && matcher.isCatastrophicRegex && matcher.isCatastrophicRegex(body)) {
                return {
                    isValid: false,
                    error: 'This regex can backtrack catastrophically and would freeze the page. Simplify it — nested or ambiguous repetition like (a|a)+ is the usual cause.'
                };
            }
            return { isValid: true, kind: 'regex' };
        }

        if (pattern === '/') {
            // Q-10: '/' alone would be read as an empty regex matching everything.
            return { isValid: false, error: 'Pattern cannot be a lone "/"' };
        }

        return { isValid: true, kind: pattern.includes('*') ? 'wildcard' : 'substring' };
    }

    function validateStatusCode(code) {
        // PER-25: a number, and a whole one. This used to parseInt strings, so
        // "404" and even "201abc" passed here while the interceptor then
        // served the stored string differently in fetch and XHR.
        if (typeof code !== 'number' || !Number.isInteger(code)) {
            return { isValid: false, error: 'Status code must be a whole number like 200, not text or a fraction' };
        }
        if (code < STATUS_MIN || code > LIMITS.STATUS_MAX) {
            const interim = code >= 100 && code < STATUS_MIN
                ? ' — 1xx statuses are interim responses and can never be a final response'
                : '';
            return { isValid: false, error: `Status code must be between ${STATUS_MIN} and ${LIMITS.STATUS_MAX}${interim}` };
        }
        return { isValid: true, code };
    }

    function validateHeaderName(name, where) {
        if (typeof name !== 'string' || name.trim() === '') return `${where}: header name is required`;
        if (ABOVE_LATIN1_RE.test(name)) {
            return `${where}: the header name "${name}" contains characters above U+00FF — header names must be plain ASCII`;
        }
        if (!HEADER_NAME_RE.test(name)) return `${where}: "${name}" is not a valid header name`;
        return null;
    }

    const hasLineBreak = (v) => /[\r\n]/.test(v);

    /**
     * Header operations for a 'headers' rule. Every op must be complete,
     * because Chrome validates a whole updateDynamicRules batch at once: one
     * incomplete op does not just fail its own rule, it blocks every other
     * headers/queryparams rule from being applied or withdrawn.
     */
    function validateHeadersMod(headersMod, urlPattern) {
        const errors = [];
        if (!isPlainObject(headersMod)) {
            return { valid: false, errors: ['Header operations must be an object with "request" and "response" lists'] };
        }

        const lists = [['request', headersMod.request], ['response', headersMod.response]];
        const allOps = [];
        const responseOps = [];
        for (const [side, list] of lists) {
            if (list === undefined || list === null) continue;
            if (!Array.isArray(list)) {
                errors.push(`${side} header operations must be a list`);
                continue;
            }
            // PER-51: only the first operation on a header name applies, so a
            // second one on the same side is a rule that does less than it says.
            const seen = new Set();
            list.forEach((op, i) => {
                const where = `${side === 'request' ? 'Request' : 'Response'} header #${i + 1}`;
                if (!isPlainObject(op)) {
                    errors.push(`${where}: must be an object like {"op": "set", "name": "X-Example", "value": "1"}`);
                    return;
                }
                if (op.op !== 'set' && op.op !== 'remove') {
                    errors.push(`${where}: "op" must be "set" or "remove"`);
                }
                const nameError = validateHeaderName(op.name, where);
                if (nameError) errors.push(nameError);
                if (typeof op.name === 'string' && op.name.trim() !== '') {
                    const key = op.name.toLowerCase();
                    if (seen.has(key)) {
                        errors.push(`${where}: "${op.name}" appears twice in the ${side} headers — use one operation per header name (names are not case-sensitive)`);
                    }
                    seen.add(key);
                }
                if (op.op === 'set') {
                    if (typeof op.value !== 'string') {
                        errors.push(`${where}: a "set" operation needs a string "value"`);
                    } else if (hasLineBreak(op.value)) {
                        errors.push(`${where}: header values cannot contain line breaks`);
                    } else if (ABOVE_LATIN1_RE.test(op.value)) {
                        errors.push(`${where}: the header value ${ABOVE_LATIN1_VALUE}`);
                    }
                }
                allOps.push(op);
                if (side === 'response') responseOps.push(op);
            });
        }

        for (const op of allOps) {
            const name = op && typeof op.name === 'string' ? op.name.toLowerCase() : '';
            if (FORBIDDEN_HEADER_NAMES.has(name)) {
                errors.push(`Header "${op.name}" cannot be modified — it is a security-sensitive header.`);
            }
            // Browsers reject a wildcard origin combined with credentials at
            // fetch time anyway; say so at save time instead of shipping a
            // rule that can never work.
            if (name === 'access-control-allow-origin' && op.op === 'set' && String(op.value).trim() === '*') {
                const credentials = allOps.some((o) => o !== op && o && typeof o.name === 'string'
                    && o.name.toLowerCase() === 'access-control-allow-credentials'
                    && o.op === 'set' && String(o.value).trim().toLowerCase() === 'true');
                if (credentials) {
                    errors.push('Access-Control-Allow-Origin: * cannot be combined with Access-Control-Allow-Credentials: true.');
                }
            }
        }

        // PER-5: credentialed CORS tells the browser to hand cookies and auth
        // headers to the page. Applied to every site a pattern like */api/*
        // matches, that is a shared pack's way of opening the user's sessions
        // to whatever origin it names, so the rule must say which host it is
        // for. `urlPattern` is only passed by validateRule: a caller with no
        // URL in hand (the DNR layer) cannot be judged on it.
        if (urlPattern !== undefined) {
            const credentials = responseOps.some((o) => o && typeof o.name === 'string'
                && o.name.toLowerCase() === 'access-control-allow-credentials'
                && o.op === 'set' && String(o.value).trim().toLowerCase() === 'true');
            if (credentials && !patternNamesHost(urlPattern)) {
                errors.push('Access-Control-Allow-Credentials: true needs a URL pattern that names a host, such as "https://api.example.com/*" or "http://localhost:3000/*". A pattern like "*/api/*" would send credentialed CORS headers to every site it matches.');
            }
        }

        const count = (Array.isArray(headersMod.request) ? headersMod.request.length : 0)
            + (Array.isArray(headersMod.response) ? headersMod.response.length : 0);
        if (count === 0 && errors.length === 0) {
            errors.push('At least one request or response header operation is required');
        }

        return { valid: errors.length === 0, errors };
    }

    function validateQueryParams(queryParams) {
        const errors = [];
        if (!isPlainObject(queryParams)) {
            return { valid: false, errors: ['Query parameter changes must be an object with "add" and "remove" lists'] };
        }
        const add = queryParams.add === undefined ? [] : queryParams.add;
        const remove = queryParams.remove === undefined ? [] : queryParams.remove;

        if (!Array.isArray(add)) {
            errors.push('"add" must be a list of {"key": ..., "value": ...}');
        } else {
            add.forEach((p, i) => {
                const where = `Added parameter #${i + 1}`;
                if (!isPlainObject(p)) {
                    errors.push(`${where}: must be an object like {"key": "debug", "value": "1"}`);
                    return;
                }
                if (typeof p.key !== 'string' || p.key.trim() === '') errors.push(`${where}: "key" is required`);
                if (typeof p.value !== 'string') errors.push(`${where}: "value" must be a string`);
            });
        }

        if (!Array.isArray(remove)) {
            errors.push('"remove" must be a list of parameter names');
        } else if (remove.some((k) => typeof k !== 'string' || k.trim() === '')) {
            errors.push('Every parameter to remove must be a non-empty name');
        }

        if (errors.length === 0 && add.length === 0 && remove.length === 0) {
            errors.push('At least one query parameter to add or remove is required');
        }
        return { valid: errors.length === 0, errors };
    }

    function validateRedirectDestination(destination) {
        if (typeof destination !== 'string' || destination.trim() === '') {
            return 'Redirect destination is required';
        }
        if (destination.length > MAX_REDIRECT_LENGTH) {
            return `Redirect destination is too long (max ${MAX_REDIRECT_LENGTH} characters)`;
        }
        // A root-relative path is a same-origin redirect ("/api/v2/users").
        if (destination.startsWith('/')) return null;
        let parsed;
        try {
            parsed = new URL(destination);
        } catch (error) {
            return 'Redirect destination must be an http(s) URL or a path starting with "/"';
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return `Redirect destination must use http or https, not ${parsed.protocol}`;
        }
        return null;
    }

    function validateHeaderMap(map, label, errors) {
        if (map === undefined || map === null) return;
        if (!isPlainObject(map)) {
            errors.push(`${label} must be an object of header names to values`);
            return;
        }
        for (const [name, value] of Object.entries(map)) {
            const nameError = validateHeaderName(name, label);
            if (nameError) errors.push(nameError);
            if (value !== null && typeof value === 'object') {
                errors.push(`${label}: the value for "${name}" must be text, not an object`);
            } else if (typeof value === 'string' && hasLineBreak(value)) {
                errors.push(`${label}: the value for "${name}" cannot contain line breaks`);
            } else if (typeof value === 'string' && ABOVE_LATIN1_RE.test(value)) {
                errors.push(`${label}: the value for "${name}" ${ABOVE_LATIN1_VALUE}`);
            }
        }
    }

    /**
     * F3: the `requestBody` object of a requestBody rule. Every message opens
     * with "Request body" so the editors can tell them from the rest; the
     * second word group says which field ("mode", "(static)", "(patch)").
     */
    function validateRequestBody(config, errors) {
        if (!isPlainObject(config)) {
            errors.push('Request body settings are required');
            return;
        }
        const mode = config.mode;
        if (mode === undefined) {
            errors.push('Request body mode is required: "static" or "patch"');
        } else if (!REQUEST_BODY_MODES.includes(mode)) {
            const shown = typeof mode === 'string' ? `, not "${mode.slice(0, 30)}"` : '';
            errors.push(`Request body mode must be "static" or "patch"${shown}`);
        }

        if (mode === 'static') {
            const body = config.body;
            // An empty string is a real body (it empties the request), so only
            // an absent body is "missing".
            if (body === undefined) {
                errors.push('Request body (static) needs a "body" — an empty string is allowed');
            } else if (typeof body !== 'string' && !Array.isArray(body) && !isPlainObject(body)) {
                errors.push('Request body (static) must be text, a JSON object or a JSON array');
            }
        } else if (mode === 'patch' && !isPlainObject(config.patch)) {
            errors.push('Request body (patch) must be a JSON object, like {"debug": true}');
        }

        // PER-30 applies to whatever is stored, whichever mode is chosen.
        if (config.body !== undefined && exceedsDepth(config.body, JSON_DEPTH_MAX)) {
            errors.push(`Request body (static) is nested more than ${JSON_DEPTH_MAX} levels deep, which cannot be stored reliably. Flatten it.`);
        }
        if (config.patch !== undefined && exceedsDepth(config.patch, JSON_DEPTH_MAX)) {
            errors.push(`Request body (patch) is nested more than ${JSON_DEPTH_MAX} levels deep, which cannot be stored reliably. Flatten it.`);
        }
    }

    function validateDelay(value, min, max, errors) {
        // PER-25: a number, and a whole one. parseInt used to accept "300ms"
        // (and read "2e3" as 2), which then waited about 0 ms at runtime.
        if (typeof value !== 'number' || !Number.isInteger(value)) {
            errors.push(`Delay must be a whole number of milliseconds between ${min} and ${max}`);
        } else if (value < min || value > max) {
            errors.push(`Delay must be between ${min} and ${max} ms`);
        }
    }

    /**
     * Validate a complete rule. Returns { valid, errors }, where errors are
     * human-readable sentences suitable for showing to the person saving it.
     *
     * Synchronous and dependency-free on purpose, so the editors can run it
     * on every save for immediate feedback. Checks that need Chrome itself —
     * whether declarativeNetRequest accepts a regex — live in the background.
     */
    function validateRule(rule) {
        if (!isPlainObject(rule)) {
            return { valid: false, errors: ['Rule data is required'] };
        }
        // Identity (`id`) is deliberately not checked: it is not content, the
        // editors validate before one exists, and the background assigns one
        // to any rule that arrives without it.
        const errors = [];

        if (typeof rule.name !== 'string' || rule.name.trim().length === 0) {
            errors.push('Rule name is required');
        } else if (rule.name.length > LIMITS.NAME_MAX) {
            errors.push(`Rule name must be ${LIMITS.NAME_MAX} characters or less`);
        }

        // PER-25: `enabled: "false"` is truthy, so the interceptor ran the rule
        // while the UI, which compares strictly, showed it as off.
        if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
            errors.push('"enabled" must be true or false');
        }

        const type = rule.type || 'mock';
        if (!RULE_TYPES.includes(type)) {
            errors.push(`Unknown rule type: ${type}`);
        }

        // F1: `appliesTo` belongs to redirect and block rules only. Any other
        // type with the field is refused rather than ignored, so a rule that
        // claims to reach every resource type never silently reaches none.
        if (rule.appliesTo !== undefined) {
            if (type !== 'redirect' && type !== 'block') {
                errors.push(`"appliesTo" is only for redirect and block rules, not ${type} rules`);
            } else if (!APPLIES_TO.includes(rule.appliesTo)) {
                errors.push('"appliesTo" must be "page" or "all"');
            }
        }
        const allRequests = (type === 'redirect' || type === 'block') && rule.appliesTo === 'all';

        const match = rule.match;
        if (!isPlainObject(match) || !match.url) {
            errors.push('URL pattern is required');
        } else {
            const url = validateUrlPattern(match.url);
            if (!url.isValid) errors.push(`Invalid URL pattern: ${url.error}`);
        }

        if (!isPlainObject(match) || !match.method) {
            errors.push('HTTP method is required');
        } else if (!METHODS.includes(String(match.method).toUpperCase())) {
            errors.push(`HTTP method must be one of ${METHODS.join(', ')}`);
        } else if (type === 'requestBody' && ['GET', 'HEAD'].includes(String(match.method).toUpperCase())) {
            // F3: a GET or HEAD request has no body to change. Opens with
            // "HTTP method" so it lands on the method field, not the body.
            errors.push('HTTP method for a request body rule cannot be GET or HEAD, because those requests carry no body. Use POST, PUT, PATCH, DELETE or Any (*).');
        }

        if (isPlainObject(match)) {
            validateHeaderMap(match.headers, 'Match request headers', errors);
            if (match.graphql !== undefined && match.graphql !== null) {
                if (!isPlainObject(match.graphql) || typeof match.graphql.operationName !== 'string'
                    || match.graphql.operationName.trim() === '') {
                    errors.push('A GraphQL condition needs an operationName');
                } else {
                    // PER-23: GET too — persisted-query clients send
                    // ?operationName= in the URL and no body at all.
                    const method = String(match.method || '').toUpperCase();
                    if (method !== 'POST' && method !== 'GET' && method !== '*') {
                        errors.push('GraphQL operation matching requires method POST, GET or Any (*)');
                    }
                }
            }
        }

        if (type === 'mock') {
            const r = rule.response;
            if (!isPlainObject(r)) {
                errors.push('Response configuration is required');
            } else {
                const mode = r.mode || 'static';
                if (!RESPONSE_MODES.includes(mode)) {
                    errors.push(`Response mode must be "static" or "patch", not "${mode}"`);
                }
                // Patch mode keeps the real response's status, so the field
                // is optional there; static mode is what it is used for.
                if (mode !== 'patch' || r.statusCode !== undefined) {
                    const status = validateStatusCode(r.statusCode);
                    if (!status.isValid) errors.push(`Invalid status code: ${status.error}`);
                }
                validateHeaderMap(r.headers, 'Response headers', errors);
                if (r.delay !== undefined) validateDelay(r.delay, LIMITS.DELAY_MIN, LIMITS.DELAY_MAX, errors);
                if (mode === 'patch' && r.patch !== undefined && !isPlainObject(r.patch)) {
                    errors.push('A response patch must be a JSON object');
                }
                if (r.body !== undefined && exceedsDepth(r.body, JSON_DEPTH_MAX)) {
                    errors.push(`The response body is nested more than ${JSON_DEPTH_MAX} levels deep, which cannot be stored reliably. Flatten it.`);
                }
                if (r.patch !== undefined && exceedsDepth(r.patch, JSON_DEPTH_MAX)) {
                    errors.push(`The response patch is nested more than ${JSON_DEPTH_MAX} levels deep, which cannot be stored reliably. Flatten it.`);
                }
            }
        } else if (type === 'delay') {
            validateDelay(rule.delayMs, LIMITS.DELAY_MS_MIN, LIMITS.DELAY_MS_MAX, errors);
        } else if (type === 'redirect') {
            const destination = rule.redirect && rule.redirect.destination;
            const destinationError = validateRedirectDestination(destination);
            if (destinationError) errors.push(destinationError);
            // F1: a root-relative destination means "this page's origin",
            // which declarativeNetRequest cannot express for a script, image
            // or navigation. (An invalid destination already has its error.)
            if (allRequests && !destinationError && !/^https?:\/\//i.test(destination)) {
                errors.push('Use a full URL (https://…) to redirect scripts, images and pages, or untick "all requests".');
            }
            // PER-22: $1-$9 only mean something when the URL pattern is a
            // /regex/ with capture groups. A wildcard has none, so the page
            // was sent to the literal text "$1" (or every path collapsed to
            // one URL), with no warning. Stated at save time instead.
            if (typeof destination === 'string' && /\$[1-9]/.test(destination)
                && isPlainObject(match) && typeof match.url === 'string' && match.url !== ''
                && !isRegexPattern(match.url)) {
                errors.push('The redirect destination uses $1-$9, which only work with a /regex/ URL pattern. Wildcards (*) don\'t capture, so the page would be sent to the literal text "$1". Use a pattern like /\\/api\\/(.*)/, or remove the $ placeholders.');
            }
        } else if (type === 'headers') {
            if (rule.headersMod === undefined || rule.headersMod === null) {
                errors.push('At least one request or response header operation is required');
            } else {
                errors.push(...validateHeadersMod(rule.headersMod, isPlainObject(match) ? match.url : undefined).errors);
            }
        } else if (type === 'queryparams') {
            errors.push(...validateQueryParams(rule.queryParams || {}).errors);
        } else if (type === 'requestBody') {
            validateRequestBody(rule.requestBody, errors);
        }

        // headers/queryparams are applied by declarativeNetRequest, which
        // cannot express header or GraphQL conditions. Redirect is
        // interceptor-handled, but XHR must choose the target in open(),
        // before request headers exist — so the same rule would redirect a
        // fetch and skip the identical XHR (CQ-4). Enforced here, where every
        // write passes, rather than only in the options form.
        // F1: a redirect/block that applies to all requests is DNR-backed too
        // (for the non-fetch/XHR types), so it has the same two limits.
        const dnrBacked = type === 'headers' || type === 'queryparams';
        if ((dnrBacked || type === 'redirect' || allRequests) && isPlainObject(match)) {
            const hasHeaders = isPlainObject(match.headers) && Object.keys(match.headers).length > 0;
            const hasGraphql = isPlainObject(match.graphql) && match.graphql.operationName;
            if (hasHeaders || hasGraphql) {
                if (dnrBacked) {
                    errors.push('Header/GraphQL match conditions are not supported for this rule type');
                } else if (type === 'redirect') {
                    errors.push('Redirect rules cannot use header or GraphQL match conditions, because the redirect target must be chosen before request headers exist');
                } else {
                    // Compiled without the condition, the rule would block every
                    // request to the URL, not only the ones the condition names.
                    errors.push('Rules that apply to all requests cannot use header or GraphQL match conditions, because only fetch and XHR requests can be checked against them. Untick "all requests", or remove the condition.');
                }
            }
        }

        // declarativeNetRequest's urlFilter is ASCII-only; a non-ASCII filter
        // is rejected, with the same whole-batch consequence as above.
        if ((dnrBacked || allRequests) && isPlainObject(match) && typeof match.url === 'string'
            && !isRegexPattern(match.url) && /[^\x20-\x7e]/.test(match.url)) {
            errors.push(dnrBacked
                ? 'URL patterns for header and query-parameter rules can only contain plain ASCII characters'
                : 'URL patterns for rules that apply to all requests can only contain plain ASCII characters');
        }

        return { valid: errors.length === 0, errors };
    }

    const api = {
        validateRule,
        validateUrlPattern,
        validateStatusCode,
        validateHeadersMod,
        validateQueryParams,
        validateRedirectDestination,
        isRegexPattern,
        patternNamesHost,
        RULE_TYPES,
        APPLIES_TO,
        METHODS,
        FORBIDDEN_HEADER_NAMES,
        // The limits this validator enforces: the shared ones, with the
        // status floor (PER-52) and the nesting cap (PER-30) applied.
        LIMITS: Object.assign({}, LIMITS, { STATUS_MIN, JSON_DEPTH_MAX })
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapRuleSchema = api;
})(typeof window !== 'undefined' ? window : globalThis);
