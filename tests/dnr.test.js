/**
 * Tests for the pure ruleToDnr() / validateHeadersMod() logic in
 * service_worker/dnr.js.
 *
 * syncDnrRules() is intentionally NOT tested here: it depends on the
 * chrome.declarativeNetRequest API, which does not exist in Jest/jsdom, and
 * mocking the whole API just to exercise a thin diff/update wrapper would
 * test the mock rather than the code. Only the pure mapping and validation
 * functions are covered here.
 */
const { ruleToDnr, validateHeadersMod } = require('../service_worker/dnr');

const RESOURCE_TYPES = ['xmlhttprequest', 'other'];

describe('ruleToDnr', () => {
    test('returns null for non-DNR rule types', () => {
        expect(ruleToDnr({ type: 'mock', dnrRuleId: 1, match: { url: '*' } })).toBeNull();
        expect(ruleToDnr({ type: 'block', dnrRuleId: 1, match: { url: '*' } })).toBeNull();
        expect(ruleToDnr(null)).toBeNull();
    });

    test('returns null when dnrRuleId has not been allocated', () => {
        const rule = {
            type: 'headers',
            match: { url: '*example.com*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'User-Agent', value: 'Test' }] }
        };
        expect(ruleToDnr(rule)).toBeNull();
    });

    test('headers rule: maps set and remove ops into modifyHeaders action', () => {
        const rule = {
            dnrRuleId: 5,
            type: 'headers',
            match: { url: '*example.com*', method: '*' },
            headersMod: {
                request: [{ op: 'set', name: 'User-Agent', value: 'CustomAgent/1.0' }],
                response: [
                    { op: 'set', name: 'Access-Control-Allow-Origin', value: '*' },
                    { op: 'remove', name: 'X-Custom-Debug-Header' }
                ]
            }
        };

        const dnrRule = ruleToDnr(rule);

        expect(dnrRule).toEqual({
            id: 5,
            priority: 1,
            condition: { urlFilter: '*example.com*', isUrlFilterCaseSensitive: false, resourceTypes: RESOURCE_TYPES },
            action: {
                type: 'modifyHeaders',
                requestHeaders: [{ header: 'User-Agent', operation: 'set', value: 'CustomAgent/1.0' }],
                responseHeaders: [
                    { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
                    { header: 'X-Custom-Debug-Header', operation: 'remove' }
                ]
            }
        });
    });

    test('headers rule: omits empty requestHeaders/responseHeaders arrays', () => {
        const rule = {
            dnrRuleId: 6,
            type: 'headers',
            match: { url: '*example.com*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'User-Agent', value: 'X' }] }
        };

        const dnrRule = ruleToDnr(rule);

        expect(dnrRule.action.requestHeaders).toBeDefined();
        expect(dnrRule.action.responseHeaders).toBeUndefined();
    });

    test('S-3: forbidden security headers are dropped from the action even if present in headersMod', () => {
        const rule = {
            dnrRuleId: 10,
            type: 'headers',
            match: { url: '*', method: '*' },
            headersMod: {
                request: [{ op: 'set', name: 'User-Agent', value: 'X' }],
                response: [
                    { op: 'remove', name: 'Content-Security-Policy' },
                    { op: 'remove', name: 'Strict-Transport-Security' },
                    { op: 'set', name: 'X-Frame-Options', value: 'ALLOWALL' },
                    { op: 'set', name: 'Access-Control-Allow-Origin', value: '*' } // allowed on its own
                ]
            }
        };

        const dnrRule = ruleToDnr(rule);

        expect(dnrRule.action.requestHeaders).toEqual([{ header: 'User-Agent', operation: 'set', value: 'X' }]);
        // Only the non-forbidden response op survives.
        expect(dnrRule.action.responseHeaders).toEqual([
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' }
        ]);
    });

    test('queryparams rule: maps add/remove into a redirect queryTransform action', () => {
        const rule = {
            dnrRuleId: 7,
            type: 'queryparams',
            match: { url: '*example.com/api*', method: '*' },
            queryParams: {
                add: [{ key: 'debug', value: 'true' }],
                remove: ['tracking_id']
            }
        };

        const dnrRule = ruleToDnr(rule);

        expect(dnrRule.action).toEqual({
            type: 'redirect',
            redirect: {
                transform: {
                    queryTransform: {
                        addOrReplaceParams: [{ key: 'debug', value: 'true' }],
                        removeParams: ['tracking_id']
                    }
                }
            }
        });
    });

    test('wildcard url pattern maps to urlFilter', () => {
        const rule = {
            dnrRuleId: 1,
            type: 'headers',
            match: { url: '*/api/*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X', value: 'Y' }] }
        };
        expect(ruleToDnr(rule).condition).toEqual({
            urlFilter: '*/api/*', isUrlFilterCaseSensitive: false, resourceTypes: RESOURCE_TYPES
        });
    });

    test('plain substring url pattern also maps to urlFilter, as-is', () => {
        const rule = {
            dnrRuleId: 2,
            type: 'headers',
            match: { url: 'api/users', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X', value: 'Y' }] }
        };
        expect(ruleToDnr(rule).condition).toEqual({
            urlFilter: 'api/users', isUrlFilterCaseSensitive: false, resourceTypes: RESOURCE_TYPES
        });
    });

    test('/regex/ url pattern maps to regexFilter with slashes stripped', () => {
        const rule = {
            dnrRuleId: 3,
            type: 'headers',
            match: { url: '/\\/users\\/\\d+/', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X', value: 'Y' }] }
        };
        expect(ruleToDnr(rule).condition).toEqual({
            regexFilter: '\\/users\\/\\d+', isUrlFilterCaseSensitive: false, resourceTypes: RESOURCE_TYPES
        });
    });

    test('non-wildcard method maps to lowercase requestMethods', () => {
        const rule = {
            dnrRuleId: 4,
            type: 'headers',
            match: { url: '*example.com*', method: 'POST' },
            headersMod: { request: [{ op: 'set', name: 'X', value: 'Y' }] }
        };
        expect(ruleToDnr(rule).condition).toEqual({
            urlFilter: '*example.com*',
            isUrlFilterCaseSensitive: false,
            resourceTypes: RESOURCE_TYPES,
            requestMethods: ['post']
        });
    });

    test("'*' method omits requestMethods entirely", () => {
        const rule = {
            dnrRuleId: 8,
            type: 'headers',
            match: { url: '*example.com*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X', value: 'Y' }] }
        };
        expect(ruleToDnr(rule).condition.requestMethods).toBeUndefined();
    });

    test('missing method defaults to wildcard behavior (no requestMethods)', () => {
        const rule = {
            dnrRuleId: 9,
            type: 'queryparams',
            match: { url: '*example.com*' },
            queryParams: { add: [], remove: [] }
        };
        expect(ruleToDnr(rule).condition.requestMethods).toBeUndefined();
    });
});

describe('validateHeadersMod (S-3)', () => {
    test('passes for ordinary, non-security headers', () => {
        const result = validateHeadersMod({
            request: [{ op: 'set', name: 'User-Agent', value: 'X' }],
            response: [{ op: 'set', name: 'X-Custom-Header', value: 'Y' }]
        });
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
    });

    test('rejects a request op targeting a forbidden security header', () => {
        const result = validateHeadersMod({
            request: [{ op: 'remove', name: 'Content-Security-Policy' }]
        });
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    test('rejects a response op targeting X-Frame-Options', () => {
        const result = validateHeadersMod({
            response: [{ op: 'set', name: 'X-Frame-Options', value: 'ALLOWALL' }]
        });
        expect(result.valid).toBe(false);
    });

    test('header name check is case-insensitive', () => {
        const result = validateHeadersMod({
            request: [{ op: 'remove', name: 'sTrIcT-tRaNsPoRt-sEcUrItY' }]
        });
        expect(result.valid).toBe(false);
    });

    test('rejects wildcard CORS origin combined with allow-credentials:true', () => {
        const result = validateHeadersMod({
            response: [
                { op: 'set', name: 'Access-Control-Allow-Origin', value: '*' },
                { op: 'set', name: 'Access-Control-Allow-Credentials', value: 'true' }
            ]
        });
        expect(result.valid).toBe(false);
    });

    test('allows wildcard CORS origin alone (no credentials flag)', () => {
        const result = validateHeadersMod({
            response: [{ op: 'set', name: 'Access-Control-Allow-Origin', value: '*' }]
        });
        expect(result.valid).toBe(true);
    });

    test('empty/absent headersMod is valid', () => {
        expect(validateHeadersMod({}).valid).toBe(true);
        expect(validateHeadersMod(undefined).valid).toBe(true);
    });
});
