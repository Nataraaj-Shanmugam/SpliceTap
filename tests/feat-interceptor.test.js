/**
 * Feature group G2, "interceptor": F3 (request-body rules) and F4 (code
 * responses) in src/matcher.js and content/injected.js.
 *
 * The interceptor runs under the shared harness (Node's real
 * Request/Response/Headers and a simulated XMLHttpRequest). What only Chrome
 * can show — the bytes a server receives, a page's CSP refusing eval — is in
 * tests/e2e/feat-interceptor.e2e.test.js.
 */

const matcher = require('../src/matcher.js');

const { findMatchingRule, findMatchingRequestBodyRule } = matcher;

function bodyRule(overrides = {}) {
    return {
        id: 'rb1',
        name: 'Rewrite body',
        enabled: true,
        type: 'requestBody',
        match: { url: '*/api/submit*', method: '*' },
        requestBody: { mode: 'static', body: { replaced: true } },
        ...overrides
    };
}

function mockRule(overrides = {}) {
    return {
        id: 'm1',
        name: 'Mock submit',
        enabled: true,
        type: 'mock',
        match: { url: '*/api/submit*', method: '*' },
        response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { mocked: true }, delay: 0, mode: 'static' },
        ...overrides
    };
}

const req = (overrides = {}) => ({ url: 'https://example.test/api/submit', method: 'POST', headers: {}, bodyText: null, ...overrides });

// ---------------------------------------------------------------------------

describe('F3: findMatchingRequestBodyRule', () => {
    test('is exported next to findMatchingRule', () => {
        expect(typeof findMatchingRequestBodyRule).toBe('function');
    });

    test('returns the first enabled requestBody rule in list order', () => {
        const first = bodyRule({ id: 'a' });
        const second = bodyRule({ id: 'b' });
        expect(findMatchingRequestBodyRule([first, second], req())).toBe(first);
    });

    test('skips disabled rules and every other rule type', () => {
        const off = bodyRule({ id: 'off', enabled: false });
        const on = bodyRule({ id: 'on' });
        const mock = mockRule();
        expect(findMatchingRequestBodyRule([mock, off, on], req())).toBe(on);
        expect(findMatchingRequestBodyRule([mock, off], req())).toBeNull();
    });

    test('the main pass never returns a requestBody rule', () => {
        const body = bodyRule();
        const mock = mockRule();
        expect(findMatchingRule([body], req())).toBeNull();
        expect(findMatchingRule([body, mock], req())).toBe(mock);
    });

    test('url and method are matched like the main pass', () => {
        const putOnly = bodyRule({ match: { url: '*/api/submit*', method: 'PUT' } });
        expect(findMatchingRequestBodyRule([putOnly], req())).toBeNull();
        expect(findMatchingRequestBodyRule([putOnly], req({ method: 'put' }))).toBe(putOnly);
        expect(findMatchingRequestBodyRule([bodyRule()], req({ url: 'https://example.test/other' }))).toBeNull();
        const regex = bodyRule({ match: { url: '/\\/api\\/sub/', method: '*' } });
        expect(findMatchingRequestBodyRule([regex], req())).toBe(regex);
    });

    test('header conditions are honoured', () => {
        const rule = bodyRule({ match: { url: '*/api/submit*', method: '*', headers: { 'X-Tenant': 'acme' } } });
        expect(findMatchingRequestBodyRule([rule], req())).toBeNull();
        expect(findMatchingRequestBodyRule([rule], req({ headers: { 'x-tenant': 'acme-eu' } }))).toBe(rule);
    });

    test('GraphQL conditions are honoured against the body', () => {
        const rule = bodyRule({ match: { url: '*/api/submit*', method: '*', graphql: { operationName: 'Save' } } });
        expect(findMatchingRequestBodyRule([rule], req({ bodyText: '{"operationName":"Load"}' }))).toBeNull();
        expect(findMatchingRequestBodyRule([rule], req({ bodyText: '{"operationName":"Save"}' }))).toBe(rule);
        expect(findMatchingRequestBodyRule([rule], req({ bodyText: '{"query":"mutation Save { x }"}' }))).toBe(rule);
    });

    test('null-prototype rules (as the state sync delivers them) match', () => {
        const rule = Object.assign(Object.create(null), bodyRule());
        rule.match = Object.assign(Object.create(null), rule.match);
        const list = [rule];
        Object.setPrototypeOf(list, null);
        expect(findMatchingRequestBodyRule(list, req())).toBe(rule);
    });

    test('a non-array rule list matches nothing', () => {
        expect(findMatchingRequestBodyRule(null, req())).toBeNull();
        expect(findMatchingRequestBodyRule({}, req())).toBeNull();
    });
});
