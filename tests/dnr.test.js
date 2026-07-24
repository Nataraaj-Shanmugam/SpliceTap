/**
 * Tests for the pure ruleToDnr() mapping in service_worker/dnr.js.
 *
 * syncDnrRules() is intentionally NOT tested here: it depends on the
 * chrome.declarativeNetRequest API, which does not exist in Jest/jsdom, and
 * mocking the whole API just to exercise a thin diff/update wrapper would
 * test the mock rather than the code. Per TODO.md §G4.6/§G4 intro, only the
 * pure mapping function is covered.
 */
const { ruleToDnr } = require('../service_worker/dnr');

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
                    { op: 'remove', name: 'X-Frame-Options' }
                ]
            }
        };

        const dnrRule = ruleToDnr(rule);

        expect(dnrRule).toEqual({
            id: 5,
            priority: 1,
            condition: { urlFilter: '*example.com*', isUrlFilterCaseSensitive: false },
            action: {
                type: 'modifyHeaders',
                requestHeaders: [{ header: 'User-Agent', operation: 'set', value: 'CustomAgent/1.0' }],
                responseHeaders: [
                    { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
                    { header: 'X-Frame-Options', operation: 'remove' }
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
        expect(ruleToDnr(rule).condition).toEqual({ urlFilter: '*/api/*', isUrlFilterCaseSensitive: false });
    });

    test('plain substring url pattern also maps to urlFilter, as-is', () => {
        const rule = {
            dnrRuleId: 2,
            type: 'headers',
            match: { url: 'api/users', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X', value: 'Y' }] }
        };
        expect(ruleToDnr(rule).condition).toEqual({ urlFilter: 'api/users', isUrlFilterCaseSensitive: false });
    });

    test('/regex/ url pattern maps to regexFilter with slashes stripped', () => {
        const rule = {
            dnrRuleId: 3,
            type: 'headers',
            match: { url: '/\\/users\\/\\d+/', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X', value: 'Y' }] }
        };
        expect(ruleToDnr(rule).condition).toEqual({ regexFilter: '\\/users\\/\\d+', isUrlFilterCaseSensitive: false });
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
