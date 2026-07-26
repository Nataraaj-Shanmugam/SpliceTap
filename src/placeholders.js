/**
 * SpliceTap Placeholders
 * Canonical dynamic-response placeholder engine (UMD).
 * Loads as: (a) a plain MAIN-world script, (b) a CommonJS module under Jest,
 * (c) via ESM side-effect import. See TODO.md §1.3.
 */
(function (global) {
    'use strict';

    // Any body without this substring cannot contain a placeholder token, so
    // the entire replace/parse pipeline below can be skipped (P-7).
    const PLACEHOLDER_MARKER = '{{';

    /**
     * Process dynamic response placeholders, always returning a string.
     * This is the actual work function; processDynamicResponse() wraps it to
     * preserve the legacy object-in/object-out shape. Callers that are about
     * to JSON.stringify the result anyway (e.g. content/injected.js) can call
     * this directly to avoid the redundant parse + re-stringify (P-7 #3).
     */
    function processDynamicResponseToString(bodyStr, requestDetails = {}) {
        // Date/time placeholders — arguments are replacer callbacks so Date()
        // is only constructed when the token is actually present (P-7 #2).
        bodyStr = bodyStr.replace(/{{timestamp}}/g, () => new Date().toISOString());
        bodyStr = bodyStr.replace(/{{timestamp_ms}}/g, () => Date.now().toString());
        bodyStr = bodyStr.replace(/{{date}}/g, () => new Date().toISOString().split('T')[0]);
        bodyStr = bodyStr.replace(/{{time}}/g, () => new Date().toTimeString().split(' ')[0]);

        // GUID/UUID
        bodyStr = bodyStr.replace(/{{guid}}/g, () =>
            'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                const r = Math.random() * 16 | 0;
                const v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            })
        );

        // Random values
        bodyStr = bodyStr.replace(/{{randomInt}}/g, () =>
            Math.floor(Math.random() * 1000).toString()
        );
        bodyStr = bodyStr.replace(/{{randomInt:(\d+)}}/g, (match, max) =>
            Math.floor(Math.random() * parseInt(max, 10)).toString()
        );
        bodyStr = bodyStr.replace(/{{randomFloat}}/g, () =>
            (Math.random() * 100).toFixed(2)
        );
        bodyStr = bodyStr.replace(/{{randomString}}/g, () =>
            Math.random().toString(36).substring(2, 12)
        );
        bodyStr = bodyStr.replace(/{{randomString:(\d+)}}/g, (match, length) =>
            Math.random().toString(36).substring(2, 2 + parseInt(length, 10))
        );

        // Random email
        bodyStr = bodyStr.replace(/{{randomEmail}}/g, () => {
            const names = ['john', 'jane', 'bob', 'alice', 'charlie', 'david', 'emma'];
            const domains = ['example.com', 'test.com', 'demo.com', 'mail.com'];
            const name = names[Math.floor(Math.random() * names.length)];
            const domain = domains[Math.floor(Math.random() * domains.length)];
            return `${name}${Math.floor(Math.random() * 1000)}@${domain}`;
        });

        // Random boolean
        bodyStr = bodyStr.replace(/{{randomBool}}/g, () =>
            Math.random() > 0.5 ? 'true' : 'false'
        );

        // Request details (if provided). Callback form avoids treating '$'
        // sequences inside the request URL/method as replacement patterns.
        if (requestDetails && requestDetails.url) {
            bodyStr = bodyStr.replace(/{{request\.url}}/g, () => requestDetails.url);
        }
        if (requestDetails && requestDetails.method) {
            bodyStr = bodyStr.replace(/{{request\.method}}/g, () => requestDetails.method);
        }

        return bodyStr;
    }

    /**
     * Process dynamic response placeholders.
     * Accepts an object or a string body; returns the same shape:
     * object in -> object out (via JSON round-trip), string in -> string out.
     * Bodies with no '{{' token are returned untouched, skipping the entire
     * replace pipeline and (for object input) both JSON operations (P-7 #1).
     */
    function processDynamicResponse(body, requestDetails = {}) {
        if (!body) return body;

        const isObject = typeof body !== 'string';
        const bodyStr = isObject ? JSON.stringify(body) : body;

        if (bodyStr.indexOf(PLACEHOLDER_MARKER) === -1) {
            return body;
        }

        const processedStr = processDynamicResponseToString(bodyStr, requestDetails);

        if (isObject) {
            try {
                return JSON.parse(processedStr);
            } catch (e) {
                console.error('Failed to parse dynamic body:', e);
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
