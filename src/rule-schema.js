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
        NAME_MAX: 100, URL_MAX: 500, STATUS_MIN: 100, STATUS_MAX: 599,
        DELAY_MIN: 0, DELAY_MAX: 30000, DELAY_MS_MIN: 1, DELAY_MS_MAX: 30000
    };

    const RULE_TYPES = ['mock', 'block', 'delay', 'redirect', 'headers', 'queryparams'];

    // What the editors offer. Also the set declarativeNetRequest accepts as a
    // requestMethods value (lowercased), so a headers/queryparams rule with
    // any other method would be rejected by Chrome — and take its batch down.
    const METHODS = ['*', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

    const RESPONSE_MODES = ['static', 'patch'];

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
        const numCode = typeof code === 'number' ? code : parseInt(code, 10);
        if (!Number.isInteger(numCode)) {
            return { isValid: false, error: 'Status code must be a number' };
        }
        if (numCode < LIMITS.STATUS_MIN || numCode > LIMITS.STATUS_MAX) {
            return { isValid: false, error: `Status code must be between ${LIMITS.STATUS_MIN} and ${LIMITS.STATUS_MAX}` };
        }
        return { isValid: true, code: numCode };
    }

    function validateHeaderName(name, where) {
        if (typeof name !== 'string' || name.trim() === '') return `${where}: header name is required`;
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
    function validateHeadersMod(headersMod) {
        const errors = [];
        if (!isPlainObject(headersMod)) {
            return { valid: false, errors: ['Header operations must be an object with "request" and "response" lists'] };
        }

        const lists = [['request', headersMod.request], ['response', headersMod.response]];
        const allOps = [];
        for (const [side, list] of lists) {
            if (list === undefined || list === null) continue;
            if (!Array.isArray(list)) {
                errors.push(`${side} header operations must be a list`);
                continue;
            }
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
                if (op.op === 'set') {
                    if (typeof op.value !== 'string') {
                        errors.push(`${where}: a "set" operation needs a string "value"`);
                    } else if (hasLineBreak(op.value)) {
                        errors.push(`${where}: header values cannot contain line breaks`);
                    }
                }
                allOps.push(op);
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
            if (name === 'access-control-allow-origin' && op.op === 'set' && op.value === '*') {
                const credentials = allOps.some((o) => o !== op && o && typeof o.name === 'string'
                    && o.name.toLowerCase() === 'access-control-allow-credentials'
                    && o.op === 'set' && String(o.value).toLowerCase() === 'true');
                if (credentials) {
                    errors.push('Access-Control-Allow-Origin: * cannot be combined with Access-Control-Allow-Credentials: true.');
                }
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
            }
        }
    }

    function validateDelay(value, min, max, errors) {
        const n = typeof value === 'number' ? value : parseInt(value, 10);
        if (!Number.isInteger(n) || n < min || n > max) {
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

        const type = rule.type || 'mock';
        if (!RULE_TYPES.includes(type)) {
            errors.push(`Unknown rule type: ${type}`);
        }

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
        }

        if (isPlainObject(match)) {
            validateHeaderMap(match.headers, 'Match request headers', errors);
            if (match.graphql !== undefined && match.graphql !== null) {
                if (!isPlainObject(match.graphql) || typeof match.graphql.operationName !== 'string'
                    || match.graphql.operationName.trim() === '') {
                    errors.push('A GraphQL condition needs an operationName');
                } else {
                    const method = String(match.method || '').toUpperCase();
                    if (method !== 'POST' && method !== '*') {
                        errors.push('GraphQL operation matching requires method POST or Any (*)');
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
            }
        } else if (type === 'delay') {
            validateDelay(rule.delayMs, LIMITS.DELAY_MS_MIN, LIMITS.DELAY_MS_MAX, errors);
        } else if (type === 'redirect') {
            const destinationError = validateRedirectDestination(rule.redirect && rule.redirect.destination);
            if (destinationError) errors.push(destinationError);
        } else if (type === 'headers') {
            if (rule.headersMod === undefined || rule.headersMod === null) {
                errors.push('At least one request or response header operation is required');
            } else {
                errors.push(...validateHeadersMod(rule.headersMod).errors);
            }
        } else if (type === 'queryparams') {
            errors.push(...validateQueryParams(rule.queryParams || {}).errors);
        }

        // headers/queryparams are applied by declarativeNetRequest, which
        // cannot express header or GraphQL conditions. Redirect is
        // interceptor-handled, but XHR must choose the target in open(),
        // before request headers exist — so the same rule would redirect a
        // fetch and skip the identical XHR (CQ-4). Enforced here, where every
        // write passes, rather than only in the options form.
        const dnrBacked = type === 'headers' || type === 'queryparams';
        if ((dnrBacked || type === 'redirect') && isPlainObject(match)) {
            const hasHeaders = isPlainObject(match.headers) && Object.keys(match.headers).length > 0;
            const hasGraphql = isPlainObject(match.graphql) && match.graphql.operationName;
            if (hasHeaders || hasGraphql) {
                errors.push(dnrBacked
                    ? 'Header/GraphQL match conditions are not supported for this rule type'
                    : 'Redirect rules cannot use header or GraphQL match conditions, because the redirect target must be chosen before request headers exist');
            }
        }

        // declarativeNetRequest's urlFilter is ASCII-only; a non-ASCII filter
        // is rejected, with the same whole-batch consequence as above.
        if (dnrBacked && isPlainObject(match) && typeof match.url === 'string'
            && !isRegexPattern(match.url) && /[^\x20-\x7e]/.test(match.url)) {
            errors.push('URL patterns for header and query-parameter rules can only contain plain ASCII characters');
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
        RULE_TYPES,
        METHODS,
        FORBIDDEN_HEADER_NAMES,
        LIMITS
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapRuleSchema = api;
})(typeof window !== 'undefined' ? window : globalThis);
