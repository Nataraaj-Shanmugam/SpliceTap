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

describe('F3 — the requestBody rule type', () => {
    test('requestBody is a known rule type', () => {
        expect(S.RULE_TYPES).toContain('requestBody');
        expect(joined(reqBody({ mode: 'patch', patch: { a: 1 } }))).not.toMatch(/Unknown rule type/);
    });

    test('accepts a static rule with an object, an array, text or an empty string', () => {
        for (const body of [{ user: 'a' }, [1, 2], 'plain text', '', '{"already":"json"}']) {
            expect(S.validateRule(reqBody({ mode: 'static', body }))).toEqual({ valid: true, errors: [] });
        }
    });

    test('accepts a patch rule with an object patch', () => {
        expect(S.validateRule(reqBody({ mode: 'patch', patch: { debug: true } }))).toEqual({ valid: true, errors: [] });
        expect(isValid(reqBody({ mode: 'patch', patch: {} }))).toBe(true);
    });

    test('match is validated like a mock rule: url, headers and graphql', () => {
        const rb = { mode: 'patch', patch: { a: 1 } };
        expect(joined(reqBody(rb, { match: { url: '', method: 'POST' } }))).toMatch(/URL pattern is required/);
        expect(joined(reqBody(rb, { match: { url: '/(a|a)+$/', method: 'POST' } }))).toMatch(/Invalid URL pattern/);
        expect(joined(reqBody(rb, { match: { url: '*/x*', method: 'FOO' } }))).toMatch(/^HTTP method must be one of/);
        expect(joined(reqBody(rb, { match: { url: '*/x*', method: 'POST', headers: { 'bad name': '1' } } }))).toMatch(/^Match request headers/);
        expect(joined(reqBody(rb, { match: { url: '*/x*', method: 'POST', graphql: {} } }))).toMatch(/^A GraphQL condition needs an operationName/);
        // Header and GraphQL conditions ARE allowed here, unlike redirect.
        expect(isValid(reqBody(rb, { match: { url: '*/graphql*', method: 'POST', headers: { 'X-A': '1' }, graphql: { operationName: 'getUsers' } } }))).toBe(true);
    });

    test('method GET and HEAD are refused in any letter case; the other methods and * are allowed', () => {
        const rb = { mode: 'patch', patch: { a: 1 } };
        for (const method of ['GET', 'HEAD', 'get', 'Head']) {
            const errors = errorsOf(reqBody(rb, { match: { url: '*/x*', method } }));
            expect(errors).toHaveLength(1);
            expect(errors[0]).toMatch(/^HTTP method for a request body rule cannot be GET or HEAD/);
        }
        for (const method of ['*', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'post']) {
            expect(isValid(reqBody(rb, { match: { url: '*/x*', method } }))).toBe(true);
        }
    });

    test('GET is still fine for every other type (the refusal is requestBody-only)', () => {
        expect(isValid(mock({ match: { url: '*/x*', method: 'GET' } }))).toBe(true);
        expect(isValid(block({ match: { url: '*/x*', method: 'HEAD' } }))).toBe(true);
    });

    test('a missing method is reported once, as "required"', () => {
        expect(errorsOf(reqBody({ mode: 'patch', patch: { a: 1 } }, { match: { url: '*/x*' } })))
            .toEqual(['HTTP method is required']);
    });

    test('the requestBody object is required', () => {
        expect(errorsOf(reqBody(undefined))).toEqual(['Request body settings are required']);
        for (const bad of [null, 'static', [], 5]) {
            expect(errorsOf(reqBody(bad))).toEqual(['Request body settings are required']);
        }
    });

    test('mode is required — there is no default', () => {
        expect(errorsOf(reqBody({ body: 'x' }))).toEqual(['Request body mode is required: "static" or "patch"']);
        expect(errorsOf(reqBody({ patch: {} }))).toEqual(['Request body mode is required: "static" or "patch"']);
    });

    test('an unknown mode is refused by name; "code" is for mock responses only', () => {
        expect(errorsOf(reqBody({ mode: 'append', body: 'x' }))).toEqual(['Request body mode must be "static" or "patch", not "append"']);
        expect(errorsOf(reqBody({ mode: 'code', code: 'return 1' }))).toEqual(['Request body mode must be "static" or "patch", not "code"']);
        expect(errorsOf(reqBody({ mode: 7, body: 'x' }))).toEqual(['Request body mode must be "static" or "patch"']);
        expect(errorsOf(reqBody({ mode: 'x'.repeat(500) }))[0].length).toBeLessThan(100);
    });

    test('static mode requires a body, but an empty string counts as one', () => {
        expect(errorsOf(reqBody({ mode: 'static' }))).toEqual(['Request body (static) needs a "body" — an empty string is allowed']);
        expect(isValid(reqBody({ mode: 'static', body: '' }))).toBe(true);
    });

    test('a static body must be text, an object or an array — not null, a number or a boolean', () => {
        for (const body of [null, 5, true, false]) {
            expect(errorsOf(reqBody({ mode: 'static', body }))).toEqual(['Request body (static) must be text, a JSON object or a JSON array']);
        }
    });

    test('patch mode requires a non-array object patch', () => {
        const message = 'Request body (patch) must be a JSON object, like {"debug": true}';
        expect(errorsOf(reqBody({ mode: 'patch' }))).toEqual([message]);
        for (const patch of [null, [1, 2], 'text', 5, true]) {
            expect(errorsOf(reqBody({ mode: 'patch', patch }))).toEqual([message]);
        }
    });

    test('a patch field does not matter in static mode, nor a body in patch mode', () => {
        expect(isValid(reqBody({ mode: 'static', body: 'x', patch: [1] }))).toBe(true);
        expect(isValid(reqBody({ mode: 'patch', patch: { a: 1 }, body: null }))).toBe(true);
    });

    test('the depth limit of 64 applies to the body and to the patch', () => {
        const nest = (levels) => {
            let value = 'leaf';
            for (let i = 0; i < levels; i++) value = { n: value };
            return value;
        };
        // nest(64) is a 64-level container chain; nest(65) is 65.
        expect(isValid(reqBody({ mode: 'static', body: nest(64) }))).toBe(true);
        expect(errorsOf(reqBody({ mode: 'static', body: nest(65) })))
            .toEqual(['Request body (static) is nested more than 64 levels deep, which cannot be stored reliably. Flatten it.']);
        expect(isValid(reqBody({ mode: 'patch', patch: nest(64) }))).toBe(true);
        expect(errorsOf(reqBody({ mode: 'patch', patch: nest(65) })))
            .toEqual(['Request body (patch) is nested more than 64 levels deep, which cannot be stored reliably. Flatten it.']);
        // An array counts as a level too.
        let arrays = 'leaf';
        for (let i = 0; i < 65; i++) arrays = [arrays];
        expect(joined(reqBody({ mode: 'static', body: arrays }))).toMatch(/nested more than 64 levels/);
    });

    test('a cyclic body is refused rather than hanging the validator', () => {
        const body = {};
        body.self = body;
        expect(joined(reqBody({ mode: 'static', body }))).toMatch(/nested more than 64 levels/);
    });

    test('a stray requestBody on any other type is ignored, even a malformed one', () => {
        const stray = [{ mode: 'nonsense' }, null, 'junk', { mode: 'static' }, { mode: 'patch', patch: [1] }];
        const others = [
            (rb) => mock({ requestBody: rb }),
            (rb) => block({ requestBody: rb }),
            (rb) => redirect({ requestBody: rb }),
            (rb) => ({ name: 'R', type: 'delay', match: { url: '*/x*', method: '*' }, delayMs: 100, requestBody: rb }),
            (rb) => ({ name: 'R', type: 'headers', match: { url: '*/x*', method: '*' }, headersMod: { request: [{ op: 'remove', name: 'X-A' }] }, requestBody: rb }),
            (rb) => ({ name: 'R', type: 'queryparams', match: { url: '*/x*', method: '*' }, queryParams: { add: [{ key: 'k', value: 'v' }] }, requestBody: rb })
        ];
        for (const make of others) {
            for (const rb of stray) expect(S.validateRule(make(rb))).toEqual({ valid: true, errors: [] });
        }
    });

    test('a stray mock response on a requestBody rule is ignored too', () => {
        const rule = reqBody({ mode: 'patch', patch: { a: 1 } }, { response: { mode: 'stream' } });
        expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
    });

    test('every error carries the opening words the editor maps to a field', () => {
        const rb = (requestBody, match) => reqBody(requestBody, match ? { match } : {});
        const cases = [
            [rb(undefined), /^Request body settings/],
            [rb({}), /^Request body mode/],
            [rb({ mode: 'x' }), /^Request body mode/],
            [rb({ mode: 'static' }), /^Request body \(static\)/],
            [rb({ mode: 'static', body: 1 }), /^Request body \(static\)/],
            [rb({ mode: 'patch' }), /^Request body \(patch\)/],
            [rb({ mode: 'patch', patch: [] }), /^Request body \(patch\)/],
            [rb({ mode: 'patch', patch: {} }, { url: '*/x*', method: 'GET' }), /^HTTP method/]
        ];
        for (const [rule, opening] of cases) {
            const errors = errorsOf(rule);
            expect(errors.length).toBeGreaterThan(0);
            for (const message of errors) expect(message).toMatch(opening);
        }
    });
});

describe('every rule type has a valid minimal rule (guards a new type being added half-way)', () => {
    const minimal = {
        mock: () => mock(),
        block: () => block(),
        delay: () => ({ name: 'R', type: 'delay', match: { url: '*/x*', method: '*' }, delayMs: 100 }),
        redirect: () => redirect(),
        headers: () => ({ name: 'R', type: 'headers', match: { url: '*/x*', method: '*' }, headersMod: { request: [{ op: 'remove', name: 'X-A' }] } }),
        queryparams: () => ({ name: 'R', type: 'queryparams', match: { url: '*/x*', method: '*' }, queryParams: { add: [{ key: 'k', value: 'v' }] } }),
        requestBody: () => reqBody({ mode: 'patch', patch: { debug: true } })
    };

    test.each(S.RULE_TYPES)('%s', (type) => {
        expect(minimal[type]).toBeDefined();
        expect(S.validateRule(minimal[type]())).toEqual({ valid: true, errors: [] });
    });
});
