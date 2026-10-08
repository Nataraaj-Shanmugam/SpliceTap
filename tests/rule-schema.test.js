/**
 * Tests for src/rule-schema.js — the one definition of a valid rule, shared
 * by both editors and the background's save boundary (CQ-1).
 *
 * Several of these pin regressions found running the real extension headless:
 * each was a rule that some surface accepted and Chrome or the interceptor
 * then could not use — silently.
 */

const S = require('../src/rule-schema');

const base = (overrides = {}) => ({
    name: 'Rule',
    type: 'mock',
    match: { url: '*/api/x*', method: 'GET' },
    response: { statusCode: 200, headers: {}, body: {}, delay: 0, mode: 'static' },
    ...overrides
});
const errorsOf = (rule) => S.validateRule(rule).errors.join(' | ');

describe('validateRule — basics', () => {
    test('accepts a well-formed rule of every type', () => {
        const valid = [
            base(),
            base({ type: 'block', response: undefined }),
            base({ type: 'delay', response: undefined, delayMs: 500 }),
            base({ type: 'redirect', response: undefined, redirect: { destination: 'https://example.test/x' } }),
            base({ type: 'headers', response: undefined, headersMod: { request: [{ op: 'set', name: 'X-A', value: '1' }] } }),
            base({ type: 'queryparams', response: undefined, queryParams: { add: [{ key: 'k', value: 'v' }] } })
        ];
        for (const rule of valid) expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
    });

    test('does not require an id (identity is assigned, not validated)', () => {
        expect(S.validateRule(base()).valid).toBe(true);
    });

    test('rejects non-objects', () => {
        expect(S.validateRule(null).valid).toBe(false);
        expect(S.validateRule([]).valid).toBe(false);
    });

    test('enforces the name limit every surface shares', () => {
        expect(errorsOf(base({ name: 'x'.repeat(101) }))).toMatch(/100 characters or less/);
        expect(S.validateRule(base({ name: 'x'.repeat(100) })).valid).toBe(true);
    });

    test('rejects a method declarativeNetRequest would refuse', () => {
        expect(errorsOf(base({ match: { url: '*/x*', method: 'FOO' } }))).toMatch(/HTTP method must be one of/);
        expect(S.validateRule(base({ match: { url: '*/x*', method: 'head' } })).valid).toBe(true);
    });

    test('rejects an unknown type', () => {
        expect(errorsOf(base({ type: 'teleport' }))).toMatch(/Unknown rule type: teleport/);
    });
});

describe('validateUrlPattern — regex is recognised before wildcard', () => {
    // A regex may itself contain '*'. Checking for '*' first classified these
    // as wildcards, skipping both the syntax check and the ReDoS probe.
    test('a catastrophic regex containing * is caught', () => {
        const result = S.validateUrlPattern('/(a*)*$/');
        expect(result.isValid).toBe(false);
        expect(result.error).toMatch(/backtrack catastrophically/);
    });

    test('an invalid regex containing * is caught', () => {
        expect(S.validateUrlPattern('/*broken/').error).toMatch(/Invalid regex/);
    });

    test('a valid regex containing * passes, classified as regex', () => {
        expect(S.validateUrlPattern('/\\/api\\/.*\\/users/')).toEqual({ isValid: true, kind: 'regex' });
    });

    test('wildcards and substrings are classified', () => {
        expect(S.validateUrlPattern('*/api/*').kind).toBe('wildcard');
        expect(S.validateUrlPattern('/api/users').kind).toBe('substring');
    });

    test('a lone slash or empty regex is refused (Q-10)', () => {
        expect(S.validateUrlPattern('/').isValid).toBe(false);
        expect(S.validateUrlPattern('//').isValid).toBe(false);
    });
});

describe('header operations — every op complete, or Chrome rejects the batch', () => {
    const headers = (request) => base({ type: 'headers', response: undefined, headersMod: { request } });

    test.each([
        ['a set with no value', { op: 'set', name: 'X-A' }, /needs a string "value"/],
        ['no name', { op: 'set', value: '1' }, /header name is required/],
        ['an unknown op', { op: 'append', name: 'X-A', value: '1' }, /"op" must be "set" or "remove"/],
        ['a string instead of an op', 'X-A: 1', /must be an object/],
        ['an invalid header name', { op: 'set', name: 'X A', value: '1' }, /not a valid header name/],
        ['a value with a line break', { op: 'set', name: 'X-A', value: '1\r\nX-Evil: 1' }, /cannot contain line breaks/]
    ])('rejects %s', (label, op, pattern) => {
        expect(errorsOf(headers([op]))).toMatch(pattern);
    });

    test('rejects a security-sensitive header (S-3)', () => {
        expect(errorsOf(headers([{ op: 'remove', name: 'Content-Security-Policy' }]))).toMatch(/security-sensitive/);
    });

    test('rejects wildcard CORS combined with credentials', () => {
        const rule = base({
            type: 'headers', response: undefined,
            headersMod: {
                request: [],
                response: [
                    { op: 'set', name: 'Access-Control-Allow-Origin', value: '*' },
                    { op: 'set', name: 'Access-Control-Allow-Credentials', value: 'true' }
                ]
            }
        });
        expect(errorsOf(rule)).toMatch(/cannot be combined/);
    });

    test('rejects a headers rule with no operations', () => {
        expect(errorsOf(headers([]))).toMatch(/At least one request or response header operation/);
    });
});

describe('query parameters', () => {
    const qp = (queryParams) => base({ type: 'queryparams', response: undefined, queryParams });

    test('an added parameter needs a key and a string value', () => {
        expect(errorsOf(qp({ add: [{ value: 'v' }] }))).toMatch(/"key" is required/);
        expect(errorsOf(qp({ add: [{ key: 'k', value: 1 }] }))).toMatch(/"value" must be a string/);
    });

    test('parameters to remove must be non-empty names', () => {
        expect(errorsOf(qp({ remove: ['ok', ''] }))).toMatch(/non-empty name/);
    });

    test('needs at least one change', () => {
        expect(errorsOf(qp({ add: [], remove: [] }))).toMatch(/At least one query parameter/);
    });
});

describe('redirect destination', () => {
    const redirect = (destination) => base({ type: 'redirect', response: undefined, redirect: { destination } });

    test('accepts an absolute http(s) URL, with $n substitutions', () => {
        expect(S.validateRule(redirect('https://staging.example.test/$1')).valid).toBe(true);
    });

    test('accepts a root-relative path (same-origin redirect)', () => {
        expect(S.validateRule(redirect('/api/v2/users')).valid).toBe(true);
    });

    test('rejects other schemes', () => {
        expect(errorsOf(redirect('javascript:alert(1)'))).toMatch(/must use http or https/);
        expect(errorsOf(redirect('data:text/plain,x'))).toMatch(/must use http or https/);
    });

    test('rejects a relative path without a leading slash', () => {
        expect(errorsOf(redirect('api/v2'))).toMatch(/http\(s\) URL or a path/);
    });
});

describe('match conditions', () => {
    test('are valid on mock, block and delay rules', () => {
        const cond = { url: '*/x*', method: 'GET', headers: { 'X-Env': 'dev' } };
        expect(S.validateRule(base({ match: cond })).valid).toBe(true);
        expect(S.validateRule(base({ type: 'block', response: undefined, match: cond })).valid).toBe(true);
        expect(S.validateRule(base({ type: 'delay', response: undefined, delayMs: 10, match: cond })).valid).toBe(true);
    });

    test('are refused on DNR-backed rules and on redirect (CQ-4)', () => {
        const cond = { url: '*/x*', method: 'GET', headers: { 'X-Env': 'dev' } };
        expect(errorsOf(base({ type: 'headers', response: undefined, match: cond, headersMod: { request: [{ op: 'remove', name: 'X' }] } })))
            .toMatch(/not supported for this rule type/);
        expect(errorsOf(base({ type: 'redirect', response: undefined, match: cond, redirect: { destination: '/x' } })))
            .toMatch(/Redirect rules cannot use header or GraphQL/);
    });

    test('a GraphQL condition needs POST or any method', () => {
        const rule = base({ match: { url: '*/graphql', method: 'GET', graphql: { operationName: 'Q' } } });
        expect(errorsOf(rule)).toMatch(/requires method POST or Any/);
    });

    test('a non-ASCII URL filter is refused for DNR-backed rules only', () => {
        const url = '*/café*';
        expect(errorsOf(base({ type: 'headers', response: undefined, match: { url, method: '*' }, headersMod: { request: [{ op: 'remove', name: 'X' }] } })))
            .toMatch(/plain ASCII/);
        expect(S.validateRule(base({ match: { url, method: 'GET' } })).valid).toBe(true);
    });
});

describe('mock responses', () => {
    test('patch mode does not require a status code', () => {
        expect(S.validateRule(base({ response: { mode: 'patch', patch: {} } })).valid).toBe(true);
    });

    test('a patch must be an object', () => {
        expect(errorsOf(base({ response: { mode: 'patch', patch: [1, 2] } }))).toMatch(/must be a JSON object/);
    });

    test('response header values must be text', () => {
        expect(errorsOf(base({ response: { statusCode: 200, headers: { 'X-A': { nested: 1 } } } }))).toMatch(/must be text/);
    });

    test('rejects an unknown response mode', () => {
        expect(errorsOf(base({ response: { statusCode: 200, mode: 'stream' } }))).toMatch(/Response mode must be/);
    });
});
