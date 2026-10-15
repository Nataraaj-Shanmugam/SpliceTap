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

// -- F8 -----------------------------------------------------------------

describe('B2-F8 response.patchStatus', () => {
    const patchMock = (extra = {}) => mock({}, { mode: 'patch', patch: { ok: true }, statusCode: undefined, ...extra });

    test.each([200, 201, 204, 301, 404, 418, 500, 503, 599])('accepts %i in patch mode', (patchStatus) => {
        expect(S.validateRule(patchMock({ patchStatus }))).toEqual({ valid: true, errors: [] });
    });

    test('a patch response without it is unchanged', () => {
        expect(S.validateRule(patchMock())).toEqual({ valid: true, errors: [] });
    });

    test('it may sit beside a statusCode, which patch mode ignores', () => {
        expect(isValid(patchMock({ statusCode: 200, patchStatus: 503 }))).toBe(true);
    });

    test.each([
        ['199', 199], ['100', 100], ['0', 0], ['600', 600], ['negative', -200],
        ['a fraction', 503.5], ['text', '503'], ['NaN', NaN], ['Infinity', Infinity],
        ['null', null], ['a boolean', true], ['an object', {}]
    ])('refuses %s in patch mode', (label, patchStatus) => {
        const rule = patchMock({ patchStatus });
        expect(isValid(rule)).toBe(false);
        const messages = errorsOf(rule);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(/^Patch status must be a whole number between 200 and 599/);
    });

    test.each(['static', 'code'])('refuses it in %s mode', (mode) => {
        const response = mode === 'code'
            ? { mode, code: 'return { body: 1 };', patchStatus: 503 }
            : { mode, patchStatus: 503 };
        const rule = mock({}, response);
        expect(isValid(rule)).toBe(false);
        expect(errorsOf(rule)).toHaveLength(1);
        expect(errorsOf(rule)[0]).toMatch(new RegExp(`^Patch status only applies to a response in patch mode, not ${mode} mode`));
    });

    test('refuses it when the response has no mode (static by default)', () => {
        const rule = mk('mock', { response: { statusCode: 200, body: {}, patchStatus: 503 } });
        expect(joined(rule)).toMatch(/^Patch status only applies to a response in patch mode, not static mode/);
    });

    test('refuses it on a non-mock rule that carries a response object', () => {
        const rule = block();
        rule.response = { patchStatus: 503 };
        expect(errorsOf(rule)).toHaveLength(1);
        expect(errorsOf(rule)[0]).toMatch(/^Patch status is only available on mock rules in patch mode, not block rules/);
    });

    test('an unknown mode gets the mode error and no patch-status noise', () => {
        const rule = mock({}, { mode: 'telepathy', patchStatus: 503 });
        expect(errorsOf(rule).every((m) => !/^Patch status/.test(m))).toBe(true);
        expect(joined(rule)).toMatch(/Response mode must be/);
    });

    test('no message mentions "status code", which the editor maps to the static status field', () => {
        for (const patchStatus of [100, 700, 'x']) {
            for (const m of errorsOf(patchMock({ patchStatus }))) expect(m).not.toMatch(/status code/i);
        }
        expect(joined(mock({}, { mode: 'static', patchStatus: 503 }))).not.toMatch(/status code/i);
    });
});

// -- F9 -----------------------------------------------------------------

describe('B2-F9 headers op "append"', () => {
    const res = (...response) => headers({}, { request: [], response });
    const req = (...request) => headers({}, { request, response: [] });

    test('is accepted on a response header', () => {
        expect(S.validateRule(res({ op: 'append', name: 'Link', value: '</a.css>; rel=preload' }))).toEqual({ valid: true, errors: [] });
        expect(S.validateRule(res({ op: 'append', name: 'X-A', value: '' }))).toEqual({ valid: true, errors: [] });
    });

    test('mixes with set and remove on the response side', () => {
        const rule = res(
            { op: 'set', name: 'X-Set', value: '1' },
            { op: 'append', name: 'X-Append', value: '2' },
            { op: 'remove', name: 'X-Remove' }
        );
        expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
    });

    test('is refused on a request header, with a message that opens "Request header #n"', () => {
        const rule = req({ op: 'set', name: 'X-Ok', value: '1' }, { op: 'append', name: 'X-A', value: '1' });
        expect(isValid(rule)).toBe(false);
        expect(errorsOf(rule)).toHaveLength(1);
        expect(errorsOf(rule)[0]).toMatch(/^Request header #2: "op" must be "set" or "remove" — "append" works on response headers only/);
        expect(errorsOf(rule)[0]).toMatch(/Chrome cannot append to a request header/);
    });

    test('an unknown op still lists the right choices for each side', () => {
        expect(joined(req({ op: 'bogus', name: 'X-A', value: '1' }))).toMatch(/^Request header #1: "op" must be "set" or "remove"$/);
        expect(joined(res({ op: 'bogus', name: 'X-A', value: '1' }))).toMatch(/^Response header #1: "op" must be "set", "append" or "remove"$/);
        expect(joined(res({ name: 'X-A', value: '1' }))).toMatch(/^Response header #1: "op" must be "set", "append" or "remove"$/);
    });

    test('needs a string value, no line breaks and nothing above Latin-1, like "set"', () => {
        expect(joined(res({ op: 'append', name: 'X-A' }))).toMatch(/^Response header #1: an "append" operation needs a string "value"/);
        expect(joined(res({ op: 'append', name: 'X-A', value: 1 }))).toMatch(/needs a string "value"/);
        expect(joined(res({ op: 'append', name: 'X-A', value: '1\r\nX-Evil: 1' }))).toMatch(/^Response header #1: header values cannot contain line breaks/);
        expect(joined(res({ op: 'append', name: 'X-A', value: 'caf–' }))).toMatch(/^Response header #1: the header value contains characters above U\+00FF/);
        expect(joined(res({ op: 'set', name: 'X-A' }))).toMatch(/a "set" operation needs a string "value"/);
    });

    test('needs a valid, non-forbidden header name', () => {
        expect(joined(res({ op: 'append', name: 'X A', value: '1' }))).toMatch(/^Response header #1: "X A" is not a valid header name/);
        expect(joined(res({ op: 'append', name: 'Content-Security-Policy', value: "default-src 'self'" }))).toMatch(/security-sensitive/);
        expect(joined(res({ op: 'append', name: 'Set-Cookie', value: 'a=b' }))).toMatch(/security-sensitive/);
    });

    test('the one-operation-per-name rule counts an append too', () => {
        const rule = res({ op: 'set', name: 'X-A', value: '1' }, { op: 'append', name: 'x-a', value: '2' });
        expect(joined(rule)).toMatch(/^Response header #2: "x-a" appears twice in the response headers/);
    });

    test('the same name on both sides is fine', () => {
        const rule = headers({}, { request: [{ op: 'set', name: 'X-A', value: '1' }], response: [{ op: 'append', name: 'X-A', value: '2' }] });
        expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
    });

    test('an appended wildcard origin still cannot be combined with credentials', () => {
        const rule = res(
            { op: 'append', name: 'Access-Control-Allow-Origin', value: '*' },
            { op: 'append', name: 'Access-Control-Allow-Credentials', value: 'true' }
        );
        expect(joined(rule)).toMatch(/Access-Control-Allow-Origin: \* cannot be combined with Access-Control-Allow-Credentials: true/);
    });

    test('an appended credentials header still needs a URL pattern that names a host', () => {
        const rule = headers({ url: '*/api/*' }, { request: [], response: [{ op: 'append', name: 'Access-Control-Allow-Credentials', value: 'true' }] });
        expect(joined(rule)).toMatch(/^Access-Control-Allow-Credentials: true needs a URL pattern that names a host/);
        const scoped = headers({ url: 'https://api.example.com/*' }, { request: [], response: [{ op: 'append', name: 'Access-Control-Allow-Credentials', value: 'true' }] });
        expect(isValid(scoped)).toBe(true);
    });

    test('the standalone headers validator applies the same side rule', () => {
        expect(S.validateHeadersMod({ response: [{ op: 'append', name: 'X-A', value: '1' }] }).valid).toBe(true);
        expect(S.validateHeadersMod({ request: [{ op: 'append', name: 'X-A', value: '1' }] }).valid).toBe(false);
    });
});

describe('B2-F9 queryParams.removeAll', () => {
    test('a rule with removeAll and nothing else is valid', () => {
        expect(S.validateRule(queryparams({}, { removeAll: true }))).toEqual({ valid: true, errors: [] });
        expect(S.validateRule(queryparams({}, { removeAll: true, add: [], remove: [] }))).toEqual({ valid: true, errors: [] });
    });

    test('removeAll with adds is valid (the DNR layer keeps only the added parameters)', () => {
        expect(isValid(queryparams({}, { removeAll: true, add: [{ key: 'k', value: 'v' }] }))).toBe(true);
    });

    test('removeAll with a remove list is tolerated, since remove-all already covers it', () => {
        expect(isValid(queryparams({}, { removeAll: true, remove: ['a'] }))).toBe(true);
    });

    test('removeAll false does not count as a change', () => {
        const rule = queryparams({}, { removeAll: false });
        expect(isValid(rule)).toBe(false);
        expect(joined(rule)).toMatch(/^At least one query parameter to add or remove, or "remove all", is required$/);
        expect(isValid(queryparams({}, { removeAll: false, remove: ['a'] }))).toBe(true);
    });

    test('an empty queryParams object is still refused', () => {
        expect(joined(queryparams({}, {}))).toMatch(/^At least one query parameter/);
        expect(joined(queryparams({}, { add: [], remove: [] }))).toMatch(/^At least one query parameter/);
    });

    test.each([['"true"', 'true'], ['1', 1], ['0', 0], ['null', null], ['an object', {}], ['an array', []]])(
        'refuses removeAll set to %s, with a message that opens "Query parameters"', (label, removeAll) => {
            const rule = queryparams({}, { removeAll, add: [{ key: 'k', value: 'v' }] });
            expect(isValid(rule)).toBe(false);
            expect(errorsOf(rule)).toEqual(['Query parameters: "removeAll" must be true or false']);
        }
    );

    test('a non-boolean removeAll does not also report "at least one"', () => {
        expect(errorsOf(queryparams({}, { removeAll: 'yes' }))).toEqual(['Query parameters: "removeAll" must be true or false']);
    });

    test('the standalone validator agrees', () => {
        expect(S.validateQueryParams({ removeAll: true })).toEqual({ valid: true, errors: [] });
        expect(S.validateQueryParams({ removeAll: 'x' }).valid).toBe(false);
    });
});
