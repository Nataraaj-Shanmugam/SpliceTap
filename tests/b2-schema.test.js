/**
 * Batch 2, group G3 — schema validation for the new rule fields:
 *   F7  match.pageDomains / match.resourceTypes / match.payload
 *   F8  response.patchStatus
 *   F9  headers op "append" (response side), queryParams.removeAll
 *   PER-66  match.callFilter
 *   F11 User-Agent preset templates
 *
 * Every error message is pinned by its opening words, because the editor maps
 * a message to a form field by those words ("Page domains…", "Payload filter…").
 */

const S = require('../src/rule-schema');

const URL_MATCH = { url: '*/api/x*', method: 'POST' };
const mk = (type, extra = {}, match = {}) => ({
    name: 'R', type, enabled: true, match: { ...URL_MATCH, ...match }, ...extra
});
const mock = (match, response) => mk('mock', { response: { statusCode: 200, headers: {}, body: {}, mode: 'static', ...response } }, match);
const block = (match, appliesTo) => mk('block', appliesTo ? { appliesTo } : {}, match);
const delay = (match) => mk('delay', { delayMs: 100 }, match);
const redirect = (match, appliesTo) => mk('redirect', {
    redirect: { destination: 'https://example.test/y' }, ...(appliesTo ? { appliesTo } : {})
}, match);
const headers = (match, headersMod) => mk('headers', {
    headersMod: headersMod || { request: [{ op: 'set', name: 'X-A', value: '1' }] }
}, match);
const queryparams = (match, queryParams) => mk('queryparams', {
    queryParams: queryParams || { add: [{ key: 'k', value: 'v' }] }
}, match);
const requestBody = (match) => mk('requestBody', { requestBody: { mode: 'patch', patch: { a: 1 } } }, match);

const errorsOf = (rule) => S.validateRule(rule).errors;
const isValid = (rule) => S.validateRule(rule).valid;
const joined = (rule) => errorsOf(rule).join(' | ');

// -- F7 -----------------------------------------------------------------

describe('B2-F7 match.pageDomains', () => {
    const withDomains = (pageDomains, make = mock) => make({ pageDomains });

    test('accepts 1 to 20 lowercase hostnames on every rule type', () => {
        const domains = ['example.com', 'localhost', 'a-b.co.uk', '127.0.0.1', 'xn--bcher-kva.example'];
        for (const make of [mock, block, delay, redirect, headers, queryparams, requestBody]) {
            expect(S.validateRule(withDomains(domains, make))).toEqual({ valid: true, errors: [] });
        }
        expect(isValid(withDomains(Array.from({ length: 20 }, (_, i) => `h${i}.test`)))).toBe(true);
    });

    test('a rule without the field is unchanged', () => {
        expect(isValid(mock())).toBe(true);
    });

    test.each([
        ['an empty list', [], /^Page domains cannot be an empty list/],
        ['a non-list', 'example.com', /^Page domains must be a list of 1 to 20/],
        ['null (omit the field instead)', null, /^Page domains must be a list/],
        ['an object', { 0: 'example.com' }, /^Page domains must be a list/],
        ['21 hostnames', Array.from({ length: 21 }, (_, i) => `h${i}.test`), /^Page domains can list at most 20/],
        ['a scheme', ['https://example.com'], /^Page domains: "https:\/\/example.com" includes a scheme/],
        ['a path', ['example.com/app'], /^Page domains: "example.com\/app" includes a path/],
        ['a query', ['example.com?x=1'], /^Page domains: .* includes a path/],
        ['credentials', ['me@example.com'], /^Page domains: .* includes a path/],
        ['a port', ['localhost:3000'], /^Page domains: "localhost:3000" includes a port/],
        ['a wildcard', ['*.example.com'], /^Page domains: "\*.example.com" contains a wildcard/],
        ['an uppercase letter', ['Example.com'], /^Page domains: "Example.com" must be lowercase/],
        ['non-ASCII text', ['bücher.example'], /^Page domains: .* plain ASCII/],
        ['a trailing dot', ['example.com.'], /^Page domains: .* is not a valid hostname/],
        ['an empty label', ['a..b'], /^Page domains: .* is not a valid hostname/],
        ['a leading hyphen', ['-a.com'], /^Page domains: .* is not a valid hostname/],
        ['a space', ['exa mple.com'], /^Page domains: .* is not a valid hostname/],
        ['an underscore', ['my_host.test'], /^Page domains: .* is not a valid hostname/],
        ['an over-long name', [`${'a'.repeat(64)}.com`], /^Page domains: .* is not a valid hostname/],
        ['a non-string entry', [42], /^Page domains: entry #1 must be a hostname/],
        ['an empty entry', [''], /^Page domains: entry #1 must be a hostname/],
        ['a duplicate', ['a.com', 'a.com'], /^Page domains: "a.com" is listed twice/]
    ])('refuses %s', (label, value, opening) => {
        const rule = withDomains(value);
        expect(isValid(rule)).toBe(false);
        const messages = errorsOf(rule);
        expect(messages.length).toBeGreaterThan(0);
        for (const m of messages) expect(m).toMatch(/^Page domains/);
        expect(messages[0]).toMatch(opening);
    });

    test('every offending entry is reported, numbered or named', () => {
        const messages = errorsOf(withDomains(['ok.com', 'BAD.com', 'https://x.com']));
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatch(/"BAD.com"/);
        expect(messages[1]).toMatch(/"https:\/\/x.com"/);
    });

    test('a long bad entry is truncated in the message', () => {
        const [message] = errorsOf(withDomains([`https://${'x'.repeat(300)}.com`]));
        expect(message.length).toBeLessThan(250);
    });

    test('the standalone validator agrees with validateRule', () => {
        expect(S.validatePageDomains(['a.com'])).toEqual({ valid: true, errors: [] });
        expect(S.validatePageDomains([]).valid).toBe(false);
    });
});

describe('B2-F7 match.resourceTypes', () => {
    const ALL_TYPES = ['fetch-xhr', 'document', 'subdocument', 'script', 'stylesheet',
        'image', 'font', 'media', 'websocket', 'ping', 'other'];

    test('the allowed set is exactly the contract\'s eleven names', () => {
        expect(S.RESOURCE_TYPES).toEqual(ALL_TYPES);
    });

    test('accepts any non-empty subset on headers and queryparams rules', () => {
        for (const make of [headers, queryparams]) {
            expect(isValid(make({ resourceTypes: ['fetch-xhr'] }))).toBe(true);
            expect(isValid(make({ resourceTypes: ['script', 'image'] }))).toBe(true);
            expect(isValid(make({ resourceTypes: ALL_TYPES }))).toBe(true);
        }
    });

    test('accepts a list on block and redirect rules that apply to all requests', () => {
        expect(isValid(block({ resourceTypes: ['script', 'image'] }, 'all'))).toBe(true);
        expect(isValid(redirect({ resourceTypes: ['document'] }, 'all'))).toBe(true);
        // fetch-xhr on an "all" rule is what hands the rule to the in-page interceptor
        expect(isValid(block({ resourceTypes: ['fetch-xhr'] }, 'all'))).toBe(true);
        expect(isValid(block({ resourceTypes: ALL_TYPES }, 'all'))).toBe(true);
    });

    test.each([
        ['a page-scoped block', () => block({ resourceTypes: ['script'] }), /^Resource types need "all requests" on a block rule/],
        ['a block with appliesTo "page"', () => block({ resourceTypes: ['script'] }, 'page'), /^Resource types need "all requests" on a block rule/],
        ['a page-scoped redirect', () => redirect({ resourceTypes: ['script'] }), /^Resource types need "all requests" on a redirect rule/],
        ['a mock', () => mock({ resourceTypes: ['script'] }), /^Resource types only apply to .* not to mock rules/],
        ['a delay', () => delay({ resourceTypes: ['script'] }), /^Resource types only apply to .* not to delay rules/],
        ['a request-body rule', () => requestBody({ resourceTypes: ['script'] }), /^Resource types only apply to .* not to requestBody rules/]
    ])('refuses the field on %s', (label, make, opening) => {
        const rule = make();
        expect(isValid(rule)).toBe(false);
        expect(errorsOf(rule)).toHaveLength(1);
        expect(errorsOf(rule)[0]).toMatch(opening);
    });

    test.each([
        ['an empty list', [], /^Resource types must be a non-empty list of: fetch-xhr, document/],
        ['a non-list', 'script', /^Resource types must be a non-empty list/],
        ['null (omit the field instead)', null, /^Resource types must be a non-empty list/],
        ['an unknown name', ['script', 'xmlhttprequest'], /^Resource types: "xmlhttprequest" is not a known type/],
        ['a DNR-only name', ['main_frame'], /^Resource types: "main_frame" is not a known type/],
        ['a non-string entry', [7], /^Resource types: "7" is not a known type/],
        ['an uppercase name', ['Script'], /^Resource types: "Script" is not a known type/],
        ['a duplicate', ['script', 'script'], /^Resource types: "script" is listed twice/]
    ])('refuses %s on a headers rule', (label, value, opening) => {
        const rule = headers({ resourceTypes: value });
        expect(isValid(rule)).toBe(false);
        for (const m of errorsOf(rule)) expect(m).toMatch(/^Resource types/);
        expect(errorsOf(rule)[0]).toMatch(opening);
    });

    test('shape is checked on the "all requests" form too', () => {
        expect(joined(block({ resourceTypes: [] }, 'all'))).toMatch(/^Resource types must be a non-empty list/);
        expect(joined(redirect({ resourceTypes: ['nope'] }, 'all'))).toMatch(/^Resource types: "nope"/);
    });

    test('an unknown rule type gets its own error and no resource-types noise', () => {
        const rule = mk('teleport', {}, { resourceTypes: ['script'] });
        expect(errorsOf(rule)).toEqual(['Unknown rule type: teleport']);
    });
});

describe('B2-F7 match.payload', () => {
    const payload = (overrides = {}) => ({ path: 'user.id', operator: 'equals', value: '42', ...overrides });
    const withPayload = (p, make = mock) => make({ payload: p });

    test('accepts the filter on mock, block, delay, requestBody and page-scoped redirect/block', () => {
        for (const make of [mock, block, delay, redirect, requestBody]) {
            expect(S.validateRule(withPayload(payload(), make))).toEqual({ valid: true, errors: [] });
        }
        expect(isValid(block({ payload: payload() }, 'page'))).toBe(true);
        expect(isValid(redirect({ payload: payload() }, 'page'))).toBe(true);
    });

    test('accepts both operators, array-index paths, and edge lengths', () => {
        expect(isValid(withPayload(payload({ operator: 'contains' })))).toBe(true);
        expect(isValid(withPayload(payload({ path: 'items.0.sku' })))).toBe(true);
        expect(isValid(withPayload(payload({ path: 'a' })))).toBe(true);
        expect(isValid(withPayload(payload({ path: 'a'.repeat(200) })))).toBe(true);
        expect(isValid(withPayload(payload({ value: '' })))).toBe(true);
        expect(isValid(withPayload(payload({ value: 'v'.repeat(1000) })))).toBe(true);
    });

    test.each([
        ['a block that applies to all requests', () => block({ payload: payload() }, 'all'), /^Payload filter is not available on rules that apply to all requests/],
        ['a redirect that applies to all requests', () => redirect({ payload: payload() }, 'all'), /^Payload filter is not available on rules that apply to all requests/],
        ['a headers rule', () => headers({ payload: payload() }), /^Payload filter only works on rules handled in the page.* not on headers rules/],
        ['a queryparams rule', () => queryparams({ payload: payload() }), /^Payload filter only works on rules handled in the page.* not on queryparams rules/]
    ])('refuses the filter on %s', (label, make, opening) => {
        const rule = make();
        expect(isValid(rule)).toBe(false);
        expect(errorsOf(rule)).toHaveLength(1);
        expect(errorsOf(rule)[0]).toMatch(opening);
    });

    test.each([
        ['a non-object', 'user.id', /^Payload filter must be an object/],
        ['an array', [], /^Payload filter must be an object/],
        ['null (omit the field instead)', null, /^Payload filter must be an object/],
        ['no path', payload({ path: undefined }), /^Payload filter path is required/],
        ['an empty path', payload({ path: '' }), /^Payload filter path is required/],
        ['a non-string path', payload({ path: 5 }), /^Payload filter path is required/],
        ['a 201-character path', payload({ path: 'a'.repeat(201) }), /^Payload filter path is too long \(max 200/],
        ['a leading dot', payload({ path: '.user' }), /^Payload filter path cannot have empty parts/],
        ['a trailing dot', payload({ path: 'user.' }), /^Payload filter path cannot have empty parts/],
        ['a doubled dot', payload({ path: 'user..id' }), /^Payload filter path cannot have empty parts/],
        ['no operator', payload({ operator: undefined }), /^Payload filter operator must be "equals" or "contains"/],
        ['an unknown operator', payload({ operator: 'matches' }), /^Payload filter operator must be "equals" or "contains"/],
        ['a number value', payload({ value: 42 }), /^Payload filter value must be text of up to 1000 characters/],
        ['no value', payload({ value: undefined }), /^Payload filter value must be text/],
        ['a null value', payload({ value: null }), /^Payload filter value must be text/],
        ['a 1001-character value', payload({ value: 'v'.repeat(1001) }), /^Payload filter value is too long \(max 1000/]
    ])('refuses %s', (label, value, opening) => {
        const rule = withPayload(value);
        expect(isValid(rule)).toBe(false);
        for (const m of errorsOf(rule)) expect(m).toMatch(/^Payload filter/);
        expect(errorsOf(rule)[0]).toMatch(opening);
    });

    test('reports every wrong part at once', () => {
        const messages = errorsOf(withPayload({ path: '', operator: 'x', value: 1 }));
        expect(messages).toHaveLength(3);
    });

    test('the standalone validator agrees with validateRule', () => {
        expect(S.validatePayload(payload())).toEqual({ valid: true, errors: [] });
        expect(S.validatePayload({}).valid).toBe(false);
        expect(S.PAYLOAD_OPERATORS).toEqual(['equals', 'contains']);
    });
});

describe('B2-F7 the new fields coexist and change nothing else', () => {
    test('all three filters on one page-scoped rule', () => {
        const rule = block({ pageDomains: ['example.com'], payload: { path: 'a', operator: 'equals', value: '1' } });
        expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
    });

    test('a headers rule with domains and types', () => {
        const rule = headers({ pageDomains: ['example.com'], resourceTypes: ['script'] });
        expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
    });

    test('an "all requests" block with domains and types', () => {
        const rule = block({ pageDomains: ['example.com'], resourceTypes: ['image', 'fetch-xhr'] }, 'all');
        expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
    });

    test('LIMITS carries the new bounds', () => {
        expect(S.LIMITS).toMatchObject({ PAGE_DOMAINS_MAX: 20, PAYLOAD_PATH_MAX: 200, PAYLOAD_VALUE_MAX: 1000 });
    });
});
