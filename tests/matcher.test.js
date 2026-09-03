
const { SpliceTapMatcher } = require('../src/index');
const { matchUrl, matchHeaders, matchGraphQL, findMatchingRule } = SpliceTapMatcher;

describe('SpliceTapMatcher', () => {
    describe('matchUrl', () => {
        test('wildcard pattern matches full URL', () => {
            expect(matchUrl('https://example.com/api/users/123', '*/api/users/*')).toBe(true);
        });

        test('wildcard pattern does not match unrelated URL', () => {
            expect(matchUrl('https://example.com/api/products/123', '*/api/users/*')).toBe(false);
        });

        test("bare '*' matches everything", () => {
            expect(matchUrl('https://anything.example/whatever?x=1', '*')).toBe(true);
        });

        test('/regex/ pattern is tested as a regular expression', () => {
            expect(matchUrl('https://example.com/api/users/123', '/\\/users\\/\\d+/')).toBe(true);
            expect(matchUrl('https://example.com/api/users/abc', '/\\/users\\/\\d+/')).toBe(false);
        });

        test('plain pattern falls back to substring match', () => {
            expect(matchUrl('https://example.com/api/users/123', 'api/users')).toBe(true);
            expect(matchUrl('https://example.com/api/products', 'api/users')).toBe(false);
        });

        test('matching is case-insensitive', () => {
            expect(matchUrl('https://EXAMPLE.com/API/Users', 'example.com/api/users')).toBe(true);
            expect(matchUrl('https://EXAMPLE.com/API/Users/123', '*/api/users/*')).toBe(true);
        });

        test('missing url or pattern returns false', () => {
            expect(matchUrl('', '*/api/*')).toBe(false);
            expect(matchUrl('https://example.com', '')).toBe(false);
        });
    });

    describe('matchHeaders', () => {
        test('absent or empty ruleHeaders always matches', () => {
            expect(matchHeaders({ 'x-foo': 'bar' }, undefined)).toBe(true);
            expect(matchHeaders({}, {})).toBe(true);
            expect(matchHeaders(undefined, {})).toBe(true);
        });

        test('header name compare is case-insensitive', () => {
            expect(matchHeaders({ 'X-Custom-Header': 'value-123' }, { 'x-custom-header': 'value-123' })).toBe(true);
        });

        test('value compare is substring, not exact', () => {
            expect(matchHeaders({ 'x-token': 'Bearer abc123' }, { 'x-token': 'abc123' })).toBe(true);
            expect(matchHeaders({ 'x-token': 'Bearer abc123' }, { 'x-token': 'zzz' })).toBe(false);
        });

        test('multiple rule headers are AND-ed together', () => {
            const requestHeaders = { 'x-a': 'foo', 'x-b': 'bar' };
            expect(matchHeaders(requestHeaders, { 'x-a': 'foo', 'x-b': 'bar' })).toBe(true);
            expect(matchHeaders(requestHeaders, { 'x-a': 'foo', 'x-b': 'baz' })).toBe(false);
        });

        test('missing request header fails the match', () => {
            expect(matchHeaders({ 'x-a': 'foo' }, { 'x-b': 'bar' })).toBe(false);
        });
    });

    describe('matchGraphQL', () => {
        test('absent graphqlMatch always matches', () => {
            expect(matchGraphQL('{}', undefined)).toBe(true);
            expect(matchGraphQL(null, undefined)).toBe(true);
        });

        test('matches operationName parsed from valid JSON', () => {
            const body = JSON.stringify({ operationName: 'getUsers', query: '{ users { id } }' });
            expect(matchGraphQL(body, { operationName: 'getUsers' })).toBe(true);
        });

        test('mismatched operationName fails', () => {
            const body = JSON.stringify({ operationName: 'getPosts' });
            expect(matchGraphQL(body, { operationName: 'getUsers' })).toBe(false);
        });

        test('malformed JSON falls back to regex and can still hit', () => {
            const malformed = '{"operationName": "getUsers", "query": broken';
            expect(matchGraphQL(malformed, { operationName: 'getUsers' })).toBe(true);
        });

        test('malformed JSON falls back to regex and can still miss', () => {
            const malformed = '{"operationName": "getPosts", "query": broken';
            expect(matchGraphQL(malformed, { operationName: 'getUsers' })).toBe(false);
        });

        test('absent bodyText with a graphqlMatch fails', () => {
            expect(matchGraphQL(null, { operationName: 'getUsers' })).toBe(false);
        });
    });

    describe('findMatchingRule', () => {
        const rule = (overrides) => ({
            id: 'id',
            enabled: true,
            type: 'mock',
            match: { method: '*', url: '*' },
            ...overrides
        });

        test('first matching rule wins (array order)', () => {
            const rules = [
                rule({ id: 'first', match: { method: '*', url: '*/api/*' } }),
                rule({ id: 'second', match: { method: '*', url: '*/api/*' } })
            ];
            const result = findMatchingRule(rules, { url: 'https://x.com/api/y', method: 'GET' });
            expect(result.id).toBe('first');
        });

        test('disabled rules are skipped', () => {
            const rules = [
                rule({ id: 'disabled', enabled: false }),
                rule({ id: 'enabled' })
            ];
            const result = findMatchingRule(rules, { url: 'https://x.com', method: 'GET' });
            expect(result.id).toBe('enabled');
        });

        test('DNR-type rules (headers/queryparams) are skipped', () => {
            const rules = [
                rule({ id: 'headers-rule', type: 'headers' }),
                rule({ id: 'queryparams-rule', type: 'queryparams' }),
                rule({ id: 'mock-rule', type: 'mock' })
            ];
            const result = findMatchingRule(rules, { url: 'https://x.com', method: 'GET' });
            expect(result.id).toBe('mock-rule');
        });

        test("method '*' matches any method", () => {
            const rules = [rule({ match: { method: '*', url: '*' } })];
            expect(findMatchingRule(rules, { url: 'https://x.com', method: 'DELETE' })).not.toBeNull();
        });

        test('specific method mismatch skips the rule', () => {
            const rules = [rule({ match: { method: 'POST', url: '*' } })];
            expect(findMatchingRule(rules, { url: 'https://x.com', method: 'GET' })).toBeNull();
        });

        test('no matching rule returns null', () => {
            const rules = [rule({ match: { method: '*', url: '*/foo/*' } })];
            expect(findMatchingRule(rules, { url: 'https://x.com/bar', method: 'GET' })).toBeNull();
        });

        test('non-array rules returns null', () => {
            expect(findMatchingRule(undefined, { url: 'https://x.com', method: 'GET' })).toBeNull();
        });
    });
    // PERF-7 compiles single-literal wildcards to includes/startsWith/endsWith
    // instead of a regex. These pin the equivalence: each case is one the
    // anchored '^...$' regex answered the same way before the change.
    describe('wildcard fast paths (PERF-7)', () => {
        test("'*X*' behaves as contains", () => {
            expect(matchUrl('https://a.test/api/users/1', '*/api/users*')).toBe(true);
            expect(matchUrl('https://a.test/api/orders/1', '*/api/users*')).toBe(false);
        });

        test("'X*' behaves as starts-with, not contains", () => {
            expect(matchUrl('https://a.test/x', 'https://a.test/*')).toBe(true);
            expect(matchUrl('https://b.test/https://a.test/x', 'https://a.test/*')).toBe(false);
        });

        test("'*X' behaves as ends-with, not contains", () => {
            expect(matchUrl('https://a.test/data.json', '*.json')).toBe(true);
            expect(matchUrl('https://a.test/data.json?v=1', '*.json')).toBe(false);
        });

        test("'*' matches any URL", () => {
            expect(matchUrl('https://a.test/anything', '*')).toBe(true);
            expect(matchUrl('https://a.test/', '**')).toBe(true);
        });

        test('multi-literal wildcards still match through the regex path', () => {
            expect(matchUrl('https://a.test/api/v1/9/items/3', '*/api/v1/*/items*')).toBe(true);
            expect(matchUrl('https://a.test/api/v2/9/orders/3', '*/api/v1/*/items*')).toBe(false);
        });

        test('fast paths stay case-insensitive', () => {
            expect(matchUrl('https://a.test/API/Users/1', '*/api/users*')).toBe(true);
            expect(matchUrl('https://A.TEST/x', 'https://a.test/*')).toBe(true);
            expect(matchUrl('https://a.test/DATA.JSON', '*.json')).toBe(true);
        });

        test('regex metacharacters in a literal are matched literally', () => {
            // The regex path escaped these; the literal path must not start
            // treating them as syntax.
            expect(matchUrl('https://a.test/a+b', '*a+b*')).toBe(true);
            expect(matchUrl('https://a.test/aXb', '*a+b*')).toBe(false);
            expect(matchUrl('https://a.test/(b)', '*(b)*')).toBe(true);
        });
    });
});
