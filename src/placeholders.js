/**
 * SpliceTap Placeholders
 * Canonical dynamic-response placeholder engine (UMD).
 * Loads as: (a) a plain MAIN-world script, (b) a CommonJS module under Jest,
 * (c) via ESM side-effect import.
 */
(function (global) {
    'use strict';

    // PER-2 (Contract B): this runs in the page's realm and is handed every
    // mock body, so anything it calls through a prototype or a global is a hook
    // the page can install before its first request. This file loads at
    // document_start, before any page script, so what it captures here is the
    // genuine built-in. Everything applied to rule data goes through these,
    // called with the text as the first argument (uncurryThis) rather than
    // looked up on it. Math.random, Date and the Number methods are left to
    // the realm: they only ever see generated values, and a page that seeds
    // Math.random or fakes the clock expects {{randomInt}} and {{timestamp}} to
    // follow.
    const uncurryThis = Function.prototype.bind.bind(Function.prototype.call);
    const NativeString = String;
    const nativeParseInt = parseInt;
    const jsonStringify = JSON.stringify;
    const jsonParse = JSON.parse;
    const mathMin = Math.min;
    const mathMax = Math.max;
    const stringIndexOf = uncurryThis(String.prototype.indexOf);
    const stringSlice = uncurryThis(String.prototype.slice);
    // String.prototype.replace with a regex dispatches to
    // RegExp.prototype[Symbol.replace], which looks exec up on the regex at
    // call time: a page that replaced either would be handed the whole body.
    // The builtin exec reads nothing from the regex but lastIndex, so
    // substitution is a loop over it.
    const regexExec = uncurryThis(RegExp.prototype.exec);
    const consoleObject = typeof console !== 'undefined' ? console : null;
    const consoleError = consoleObject && typeof consoleObject.error === 'function'
        ? uncurryThis(consoleObject.error)
        : null;
    function reportError(message, detail) {
        if (consoleError) consoleError(consoleObject, message, detail);
    }

    // Any body without this substring cannot contain a placeholder token, so
    // the entire replace/parse pipeline below can be skipped (P-7).
    const PLACEHOLDER_MARKER = '{{';

    // One regex per token, built once. Every one is global, so exec walks the
    // text from lastIndex (reset before each use).
    const RE_TIMESTAMP = /{{timestamp}}/g;
    const RE_TIMESTAMP_MS = /{{timestamp_ms}}/g;
    const RE_DATE = /{{date}}/g;
    const RE_TIME = /{{time}}/g;
    const RE_GUID = /{{guid}}/g;
    const RE_RANDOM_INT = /{{randomInt}}/g;
    const RE_RANDOM_INT_MAX = /{{randomInt:(\d+)}}/g;
    const RE_RANDOM_FLOAT = /{{randomFloat}}/g;
    const RE_RANDOM_STRING = /{{randomString}}/g;
    const RE_RANDOM_STRING_LEN = /{{randomString:(\d+)}}/g;
    const RE_RANDOM_EMAIL = /{{randomEmail}}/g;
    const RE_RANDOM_BOOL = /{{randomBool}}/g;
    const RE_REQUEST_URL = /{{request\.url}}/g;
    const RE_REQUEST_METHOD = /{{request\.method}}/g;

    /**
     * Replace every match of the global regex `re` in `text` with
     * replacer(matchedText, firstGroup). The result is the same as
     * text.replace(re, replacer) for a replacer that returns a string.
     */
    function replaceAll(text, re, replacer) {
        let out = '';
        let last = 0;
        let matched = false;
        re.lastIndex = 0;
        for (;;) {
            const m = regexExec(re, text);
            if (m === null) break;
            matched = true;
            const whole = m[0];
            // m[1] past the end of the match array falls through to
            // Array.prototype[1]: read it only when the regex had a group.
            const group = m.length > 1 ? m[1] : undefined;
            out += stringSlice(text, last, m.index) + replacer(whole, group);
            last = m.index + whole.length;
            if (whole.length === 0) re.lastIndex = last + 1;
        }
        re.lastIndex = 0;
        return matched ? out + stringSlice(text, last) : text;
    }

    // Everything before the first `separator` (all of `text` without one).
    function beforeFirst(text, separator) {
        const at = stringIndexOf(text, separator);
        return at === -1 ? text : stringSlice(text, 0, at);
    }

    /**
     * Process dynamic response placeholders, always returning a string.
     * This is the actual work function; processDynamicResponse() wraps it to
     * preserve the legacy object-in/object-out shape. Callers that are about
     * to JSON.stringify the result anyway (e.g. content/injected.js) can call
     * this directly to avoid the redundant parse + re-stringify (P-7 #3).
     */
    const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const MAX_RANDOM_STRING = 4096;

    /**
     * Exactly `length` random [a-z0-9] characters. This used to slice
     * Math.random().toString(36), which has only about 11 digits — so
     * {{randomString:20}} returned 11 characters, and {{randomString}} was
     * occasionally shorter than 10 when the float had trailing zeros.
     */
    function randomString(length) {
        const n = mathMin(mathMax(0, length || 0), MAX_RANDOM_STRING);
        let out = '';
        for (let i = 0; i < n; i++) out += ALPHANUMERIC[Math.floor(Math.random() * ALPHANUMERIC.length)];
        return out;
    }

    // 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx' with each x and y a random hex digit.
    function randomGuid() {
        const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
        let out = '';
        for (let i = 0; i < template.length; i++) {
            const c = template[i];
            if (c === 'x' || c === 'y') {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                out += v.toString(16);
            } else {
                out += c;
            }
        }
        return out;
    }

    function processDynamicResponseToString(bodyStr, requestDetails = {}, jsonContext = false) {
        // QA-4: for an object body the pipeline is stringify -> substitute into
        // the raw JSON text -> parse. Every generated placeholder above uses a
        // safe charset (hex, base36, digits, ISO dates, fixed word lists), but
        // request.url and request.method carry whatever the page actually sent.
        // A URL containing a double quote or backslash then produced invalid
        // JSON, the parse threw, and the caller silently fell back to the
        // UNPROCESSED body — shipping the literal "{{request.url}}" token to the
        // page with only a console error. Escape those two for JSON string
        // context; leave them raw when the body is plain text.
        const forContext = (value) => {
            const s = NativeString(value);
            return jsonContext ? stringSlice(jsonStringify(s), 1, -1) : s;
        };
        // Date/time placeholders — the replacer callbacks only run (and Date()
        // is only constructed) when the token is actually present (P-7 #2).
        bodyStr = replaceAll(bodyStr, RE_TIMESTAMP, () => new Date().toISOString());
        bodyStr = replaceAll(bodyStr, RE_TIMESTAMP_MS, () => Date.now().toString());
        bodyStr = replaceAll(bodyStr, RE_DATE, () => beforeFirst(new Date().toISOString(), 'T'));
        bodyStr = replaceAll(bodyStr, RE_TIME, () => beforeFirst(new Date().toTimeString(), ' '));

        // GUID/UUID
        bodyStr = replaceAll(bodyStr, RE_GUID, randomGuid);

        // Random values
        bodyStr = replaceAll(bodyStr, RE_RANDOM_INT, () =>
            Math.floor(Math.random() * 1000).toString()
        );
        // Inclusive of max, as documented — and consistent with {{randomInt}},
        // which is 0–999 inclusive. This returned 0..max-1.
        bodyStr = replaceAll(bodyStr, RE_RANDOM_INT_MAX, (match, max) =>
            Math.floor(Math.random() * (nativeParseInt(max, 10) + 1)).toString()
        );
        bodyStr = replaceAll(bodyStr, RE_RANDOM_FLOAT, () =>
            (Math.random() * 100).toFixed(2)
        );
        bodyStr = replaceAll(bodyStr, RE_RANDOM_STRING, () => randomString(10));
        bodyStr = replaceAll(bodyStr, RE_RANDOM_STRING_LEN, (match, length) =>
            randomString(nativeParseInt(length, 10))
        );

        // Random email
        bodyStr = replaceAll(bodyStr, RE_RANDOM_EMAIL, () => {
            const names = ['john', 'jane', 'bob', 'alice', 'charlie', 'david', 'emma'];
            const domains = ['example.com', 'test.com', 'demo.com', 'mail.com'];
            const name = names[Math.floor(Math.random() * names.length)];
            const domain = domains[Math.floor(Math.random() * domains.length)];
            return `${name}${Math.floor(Math.random() * 1000)}@${domain}`;
        });

        // Random boolean
        bodyStr = replaceAll(bodyStr, RE_RANDOM_BOOL, () =>
            Math.random() > 0.5 ? 'true' : 'false'
        );

        // Request details (if provided). The replacer form avoids treating '$'
        // sequences inside the request URL/method as replacement patterns.
        if (requestDetails && requestDetails.url) {
            bodyStr = replaceAll(bodyStr, RE_REQUEST_URL, () => forContext(requestDetails.url));
        }
        if (requestDetails && requestDetails.method) {
            bodyStr = replaceAll(bodyStr, RE_REQUEST_METHOD, () => forContext(requestDetails.method));
        }

        return bodyStr;
    }

    /**
     * Process dynamic response placeholders.
     * Accepts an object or a string body; returns the same shape:
     * object in -> object out (via JSON round-trip), string in -> string out.
     * Bodies with no '{{' token are returned untouched, skipping the entire
     * replace pipeline and (for object input) both JSON operations (P-7 #1).
     * An object body may be a null-prototype one (the state sync copies rules
     * that way, PER-2).
     */
    function processDynamicResponse(body, requestDetails = {}) {
        if (!body) return body;

        const isObject = typeof body !== 'string';
        const bodyStr = isObject ? jsonStringify(body) : body;

        if (stringIndexOf(bodyStr, PLACEHOLDER_MARKER) === -1) {
            return body;
        }

        // isObject means bodyStr is JSON text we are about to re-parse, so
        // substituted values must be escaped for a JSON string literal.
        const processedStr = processDynamicResponseToString(bodyStr, requestDetails, isObject);

        if (isObject) {
            try {
                return jsonParse(processedStr);
            } catch (e) {
                reportError('Failed to parse dynamic body:', e);
                return body;
            }
        }

        return processedStr;
    }

    const api = { processDynamicResponse, processDynamicResponseToString };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapPlaceholders = api;
})(typeof window !== 'undefined' ? window : globalThis);
