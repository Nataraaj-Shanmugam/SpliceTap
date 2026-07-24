/**
 * TurboMock Placeholders
 * Canonical dynamic-response placeholder engine (UMD).
 * Loads as: (a) a plain MAIN-world script, (b) a CommonJS module under Jest,
 * (c) via ESM side-effect import. See TODO.md §1.3.
 */
(function (global) {
    'use strict';

    /**
     * Process dynamic response placeholders.
     * Accepts an object or a string body; returns the same shape:
     * object in -> object out (via JSON round-trip), string in -> string out.
     */
    function processDynamicResponse(body, requestDetails = {}) {
        if (!body) return body;

        let bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

        // Date/time placeholders
        bodyStr = bodyStr.replace(/{{timestamp}}/g, new Date().toISOString());
        bodyStr = bodyStr.replace(/{{timestamp_ms}}/g, Date.now().toString());
        bodyStr = bodyStr.replace(/{{date}}/g, new Date().toISOString().split('T')[0]);
        bodyStr = bodyStr.replace(/{{time}}/g, new Date().toTimeString().split(' ')[0]);

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

        // Request details (if provided)
        if (requestDetails && requestDetails.url) {
            bodyStr = bodyStr.replace(/{{request.url}}/g, requestDetails.url);
        }
        if (requestDetails && requestDetails.method) {
            bodyStr = bodyStr.replace(/{{request.method}}/g, requestDetails.method);
        }

        // Try to parse back to object if original was object
        if (typeof body !== 'string') {
            try {
                return JSON.parse(bodyStr);
            } catch (e) {
                console.error('Failed to parse dynamic body:', e);
                return body;
            }
        }

        return bodyStr;
    }

    const api = { processDynamicResponse };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.TurboMockPlaceholders = api;
})(typeof window !== 'undefined' ? window : globalThis);
