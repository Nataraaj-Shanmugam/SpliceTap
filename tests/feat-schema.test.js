/**
 * Tests for the schema side of the Requestly-parity features (G3):
 *   F1  appliesTo on redirect and block rules
 *   F3  the requestBody rule type
 *   F4  mock response mode 'code'
 *   and the "Modify request body" template.
 *
 * Pure logic, so unit tests are enough. The messages asserted here are the
 * ones the editors map to form fields by their opening words — change one and
 * the field highlighting in src/rule-editor.js has to follow.
 */

const S = require('../src/rule-schema');
const common = require('../src/common');
const templates = require('../src/templates');

const mock = (overrides = {}) => ({
    name: 'Rule',
    type: 'mock',
    match: { url: '*/api/x*', method: 'GET' },
    response: { statusCode: 200, headers: {}, body: {}, delay: 0, mode: 'static' },
    ...overrides
});
const block = (overrides = {}) => ({
    name: 'Rule', type: 'block', match: { url: '*/api/x*', method: '*' }, ...overrides
});
const redirect = (overrides = {}) => ({
    name: 'Rule', type: 'redirect', match: { url: '*/api/x*', method: '*' },
    redirect: { destination: 'https://example.test/x' }, ...overrides
});
const reqBody = (requestBody, overrides = {}) => ({
    name: 'Rule', type: 'requestBody', match: { url: '*/api/*', method: 'POST' }, requestBody, ...overrides
});

const errorsOf = (rule) => S.validateRule(rule).errors;
const joined = (rule) => errorsOf(rule).join(' | ');
const isValid = (rule) => S.validateRule(rule).valid;

describe('F1 — appliesTo on redirect and block rules', () => {
    test('absent means page: existing rules stay valid, root-relative redirects included', () => {
        expect(isValid(block())).toBe(true);
        expect(isValid(redirect())).toBe(true);
        expect(isValid(redirect({ redirect: { destination: '/api/v2/users' } }))).toBe(true);
    });

    test('"page" and "all" are accepted on block and redirect', () => {
        for (const appliesTo of ['page', 'all']) {
            expect(S.validateRule(block({ appliesTo }))).toEqual({ valid: true, errors: [] });
            expect(S.validateRule(redirect({ appliesTo }))).toEqual({ valid: true, errors: [] });
        }
    });

    test('any other value is refused, whatever its type', () => {
        for (const appliesTo of ['everything', 'ALL', 'Page', '', null, true, 1, ['all'], {}]) {
            expect(joined(block({ appliesTo }))).toMatch(/^"appliesTo" must be "page" or "all"$/);
            expect(joined(redirect({ appliesTo }))).toMatch(/^"appliesTo" must be "page" or "all"$/);
        }
    });

    test('refused on every other type, even when the value is valid', () => {
        const others = [
            mock({ appliesTo: 'all' }),
            { name: 'R', type: 'delay', match: { url: '*/x*', method: '*' }, delayMs: 100, appliesTo: 'page' },
            { name: 'R', type: 'headers', match: { url: '*/x*', method: '*' }, appliesTo: 'all', headersMod: { request: [{ op: 'remove', name: 'X-A' }] } },
            { name: 'R', type: 'queryparams', match: { url: '*/x*', method: '*' }, appliesTo: 'all', queryParams: { add: [{ key: 'k', value: 'v' }] } }
        ];
        for (const rule of others) {
            expect(joined(rule)).toBe(`"appliesTo" is only for redirect and block rules, not ${rule.type} rules`);
        }
    });

    test('a redirect for all requests needs an absolute http(s) destination, with the contract message', () => {
        const message = 'Use a full URL (https://…) to redirect scripts, images and pages, or untick "all requests".';
        for (const destination of ['/api/v2/users', '//cdn.example.test/x.js', 'HTTP:example.test']) {
            expect(errorsOf(redirect({ appliesTo: 'all', redirect: { destination } }))).toEqual([message]);
        }
        expect(isValid(redirect({ appliesTo: 'all', redirect: { destination: 'http://localhost:3000/x.js' } }))).toBe(true);
        expect(isValid(redirect({ appliesTo: 'all', redirect: { destination: 'HTTPS://example.test/x' } }))).toBe(true);
    });

    test('the same root-relative destination is still fine for page-only redirects', () => {
        expect(isValid(redirect({ appliesTo: 'page', redirect: { destination: '/api/v2/users' } }))).toBe(true);
    });

    test('an already-invalid destination is reported once, not twice', () => {
        expect(errorsOf(redirect({ appliesTo: 'all', redirect: { destination: 'ftp://example.test/x' } })))
            .toEqual(['Redirect destination must use http or https, not ftp:']);
        expect(errorsOf(redirect({ appliesTo: 'all', redirect: { destination: '' } })))
            .toEqual(['Redirect destination is required']);
    });

    test('$1-$9 with all requests still need a regex pattern (PER-22 holds)', () => {
        const rule = redirect({ appliesTo: 'all', redirect: { destination: 'https://example.test/$1' } });
        expect(joined(rule)).toMatch(/only work with a \/regex\/ URL pattern/);
        rule.match.url = '/^https?:\\/\\/[^/]+\\/(api\\/.*)/';
        expect(isValid(rule)).toBe(true);
    });

    test('all-request rules cannot carry header or GraphQL conditions DNR cannot express', () => {
        const withHeaders = block({ appliesTo: 'all', match: { url: '*/x*', method: '*', headers: { 'X-A': '1' } } });
        const withGraphql = block({ appliesTo: 'all', match: { url: '*/graphql*', method: 'POST', graphql: { operationName: 'getUsers' } } });
        expect(joined(withHeaders)).toMatch(/^Rules that apply to all requests cannot use header or GraphQL match conditions/);
        expect(joined(withGraphql)).toMatch(/^Rules that apply to all requests cannot use header or GraphQL match conditions/);
        // The same block is fine while it stays in the page.
        expect(isValid({ ...withHeaders, appliesTo: 'page' })).toBe(true);
        expect(isValid({ ...withGraphql, appliesTo: undefined })).toBe(true);
    });

    test('an all-request redirect keeps the redirect-specific condition message', () => {
        const rule = redirect({ appliesTo: 'all', match: { url: '*/x*', method: '*', headers: { 'X-A': '1' } } });
        expect(joined(rule)).toMatch(/^Redirect rules cannot use header or GraphQL match conditions/);
    });

    test('a non-ASCII wildcard is refused for all-request rules only (it would take down the DNR batch)', () => {
        const match = { url: '*/café*', method: '*' };
        expect(joined(block({ appliesTo: 'all', match }))).toMatch(/URL patterns for rules that apply to all requests can only contain plain ASCII/);
        expect(isValid(block({ match }))).toBe(true);
        expect(isValid(block({ appliesTo: 'page', match }))).toBe(true);
        // A regex is not translated to a urlFilter, so it is not held to ASCII.
        expect(isValid(block({ appliesTo: 'all', match: { url: '/café/', method: '*' } }))).toBe(true);
    });

    test('APPLIES_TO is exported for the editors', () => {
        expect(S.APPLIES_TO).toEqual(['page', 'all']);
    });
});
