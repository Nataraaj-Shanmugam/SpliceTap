/**
 * Regression tests for fix group C1 "schema": matcher.js, rule-schema.js,
 * patch.js and templates.js. Each block names the PER-n finding it pins.
 * Pure logic, so unit tests are enough — nothing here needs a browser.
 */

const matcher = require('../src/matcher');
const S = require('../src/rule-schema');
const { jsonMergePatch, isPatchApplicable } = require('../src/patch');
const templates = require('../src/templates');

const { findMatchingRule, matchGraphQL, isCatastrophicRegex, matchUrl } = matcher;

const rule = (overrides = {}) => ({
    id: 'r', name: 'Rule', enabled: true, type: 'mock',
    match: { method: '*', url: '*' },
    response: { statusCode: 200, headers: {}, body: {}, delay: 0, mode: 'static' },
    ...overrides
});
const base = (overrides = {}) => rule({ match: { url: '*/api/x*', method: 'GET' }, ...overrides });
const errorsOf = (r) => S.validateRule(r).errors.join(' | ');

/**
 * A fresh copy of the matcher whose `new RegExp(...)` calls are counted.
 *
 * PER-2: the matcher takes RegExp (and JSON.parse, and every other built-in it
 * applies to rule data) from the realm when it loads, so a page — or a test —
 * that replaces one afterwards is not seen. The counter therefore has to be in
 * place while the module loads. `compilations(fn)` runs fn and returns the
 * count, so a cache that survives between calls can still be measured.
 */
function loadCountingMatcher() {
    const state = { count: 0 };
    const Original = globalThis.RegExp;
    globalThis.RegExp = new Proxy(Original, {
        construct(target, args, newTarget) {
            state.count++;
            return Reflect.construct(target, args, newTarget);
        }
    });
    let loaded;
    try {
        jest.isolateModules(() => { loaded = require('../src/matcher'); });
    } finally {
        globalThis.RegExp = Original;
    }
    return Object.assign({}, loaded, {
        compilations(fn) { state.count = 0; fn(); return state.count; }
    });
}

describe('PER-3 — the ReDoS guard probes the pattern\'s own units', () => {
    // These were all accepted: the probes only ever used alphanumeric runs and
    // one two-character alternation. Each costs ~11 s at 30 repetitions.
    test.each([
        '(api|api)+$',
        '(xyz|xyz)+$',
        '(-|-)+$',
        '(\\.|\\.)+$',
        '(_|_)+$',
        '(\\/|\\/)+$',
        '([-.]|[-.])+$',
        '(~|~)+$',
        '(%|%)+$',
        '(:|:)+$',
        '(=|=)+$',
        '(&|&)+$',
        '(\\s|\\s)+$',
        '(\\W|\\W)+$',
        '(\\D|\\D)+$'
    ])('rejects /%s/ as catastrophic', (body) => {
        expect(isCatastrophicRegex(body)).toBe(true);
        expect(S.validateUrlPattern(`/${body}/`).isValid).toBe(false);
    });

    test.each([
        '\\/api\\/(x|x)+$',
        '\\/api\\/v1\\/(a+)+$',
        '([^/]+)+$',
        '(users|users)+$',
        '(foo|foo|bar)+baz$',
        '(a|aa)+$'
    ])('still rejects /%s/ (unit behind a literal prefix, negated class, longer branch)', (body) => {
        expect(isCatastrophicRegex(body)).toBe(true);
    });

    test('the shapes the old guard already caught are still caught', () => {
        for (const body of ['(a+)+$', '(a*)*$', '(a|a)+$', '(\\w+\\s?)+$', '(.*a){12}x']) {
            expect(isCatastrophicRegex(body)).toBe(true);
        }
    });

    // Every regex pattern the repository's tests and templates use. A guard
    // that rejects one of these is a false positive that breaks a real rule.
    const ACCEPTED = [
        '\\/users\\/\\d+',
        '\\/api\\/.*\\/users',
        '\\/echo(?=\\?)',
        '\\/echo\\?v=\\d+',
        '\\/api\\/users\\/\\d+\\/?$',
        '\\/api\\/(users|accounts)\\/',
        '\\/api\\/target\\/(\\w+)\\/(\\w+)',
        '^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?\\/',
        '^https?:\\/\\/[^/]+\\/(api\\/.*)',
        '\\/(api\\/.*)',
        '^https?:\\/\\/api\\.example\\.com\\/v1\\/(users|orders)\\/\\d+$',
        '\\/v(1|2)\\/items\\/[a-z0-9-]+$',
        'foo|bar|baz'
    ];

    test.each(ACCEPTED)('accepts /%s/', (body) => {
        expect(isCatastrophicRegex(body)).toBe(false);
        expect(S.validateUrlPattern(`/${body}/`).isValid).toBe(true);
    });

    test('every template URL pattern is accepted', () => {
        for (const meta of templates.listTemplates()) {
            const t = templates.getTemplate(meta.id);
            expect(S.validateUrlPattern(t.url).isValid).toBe(true);
        }
    });

    test('the guard\'s own cost stays bounded, for rejects and accepts alike', () => {
        const time = (body) => {
            const start = Date.now();
            isCatastrophicRegex(body);
            return Date.now() - start;
        };
        // Generous for a loaded CI box: a reject was ~25-45 ms when measured,
        // an accept under 1 ms. The point is "never seconds".
        for (const body of ['(api|api)+$', '(-|-)+$', '\\/api\\/(x|x)+$', '(a+)+$']) {
            expect(time(body)).toBeLessThan(750);
        }
        const start = Date.now();
        for (const body of ACCEPTED) isCatastrophicRegex(body);
        expect(Date.now() - start).toBeLessThan(750);
    });

    test('a saved catastrophic rule never reaches a hang: the matcher fails closed', () => {
        const start = Date.now();
        expect(matchUrl('https://x.test/' + '-'.repeat(30), '/(-|-)+$/')).toBe(false);
        expect(Date.now() - start).toBeLessThan(750);
    });
});

describe('PER-23 — GraphQL operationName beyond a single JSON body', () => {
    const gql = (operationName) => ({ operationName });

    test('a batched (array) body matches when any element matches', () => {
        const body = JSON.stringify([
            { operationName: 'getUsers', query: '{ users { id } }' },
            { operationName: 'getPosts', query: '{ posts { id } }' }
        ]);
        expect(matchGraphQL(body, gql('getPosts'))).toBe(true);
        expect(matchGraphQL(body, gql('getUsers'))).toBe(true);
        expect(matchGraphQL(body, gql('getNothing'))).toBe(false);
    });

    test('a GET request matches on ?operationName= in the URL', () => {
        const url = 'https://api.test/graphql?operationName=getUsers&variables=%7B%7D&extensions=%7B%7D';
        expect(matchGraphQL('', gql('getUsers'), url)).toBe(true);
        expect(matchGraphQL(undefined, gql('getPosts'), url)).toBe(false);
        // A fragment is not part of the query string.
        expect(matchGraphQL('', gql('getUsers'), 'https://api.test/graphql#?operationName=getUsers')).toBe(false);
    });

    test('a GET request with only ?query=query Name{...} matches on the declared name', () => {
        const url = 'https://api.test/graphql?query=' + encodeURIComponent('query getUsers { users { id } }');
        expect(matchGraphQL('', gql('getUsers'), url)).toBe(true);
    });

    test('a body without operationName matches on the name its query declares', () => {
        const body = JSON.stringify({ query: 'query getUsers($n: Int) { users(first: $n) { id } }' });
        expect(matchGraphQL(body, gql('getUsers'))).toBe(true);
        expect(matchGraphQL(JSON.stringify({ query: 'mutation SaveUser { save { id } }' }), gql('SaveUser'))).toBe(true);
        expect(matchGraphQL(JSON.stringify({ query: 'subscription OnTick { tick }' }), gql('OnTick'))).toBe(true);
        expect(matchGraphQL(body, gql('getPosts'))).toBe(false);
    });

    test('an explicit operationName wins over the names in the document', () => {
        const body = JSON.stringify({
            operationName: 'B',
            query: 'query A { a } query B { b }'
        });
        expect(matchGraphQL(body, gql('B'))).toBe(true);
        expect(matchGraphQL(body, gql('A'))).toBe(false);
    });

    test('anonymous operations and nested fields called "query" declare no name', () => {
        expect(matchGraphQL(JSON.stringify({ query: '{ users { id } }' }), gql('users'))).toBe(false);
        expect(matchGraphQL(JSON.stringify({ query: 'query { query Foo }' }), gql('Foo'))).toBe(false);
        // Strings and comments do not declare operations either.
        expect(matchGraphQL(JSON.stringify({ query: '# query Hidden\n{ a(x: "query Fake") }' }), gql('Hidden'))).toBe(false);
        expect(matchGraphQL(JSON.stringify({ query: '{ a(x: "query Fake") }' }), gql('Fake'))).toBe(false);
    });

    test('batched bodies without operationName are read per element', () => {
        const body = JSON.stringify([{ query: 'query A { a }' }, { query: 'query B { b }' }]);
        expect(matchGraphQL(body, gql('B'))).toBe(true);
    });

    test('findMatchingRule feeds the request URL, so a GET rule matches', () => {
        const rules = [rule({
            id: 'get-gql',
            match: { method: 'GET', url: '*/graphql*', graphql: { operationName: 'getUsers' } }
        })];
        const hit = findMatchingRule(rules, { url: 'https://api.test/graphql?operationName=getUsers', method: 'GET' });
        expect(hit && hit.id).toBe('get-gql');
        expect(findMatchingRule(rules, { url: 'https://api.test/graphql?operationName=other', method: 'GET' })).toBeNull();
    });

    test('the schema allows a GraphQL condition on GET (and still POST and *)', () => {
        for (const method of ['GET', 'POST', '*']) {
            const r = base({ match: { url: '*/graphql', method, graphql: { operationName: 'Q' } } });
            expect(S.validateRule(r).valid).toBe(true);
        }
        expect(errorsOf(base({ match: { url: '*/graphql', method: 'PUT', graphql: { operationName: 'Q' } } })))
            .toMatch(/requires method POST, GET or Any/);
    });
});

describe('PER-38 — the request body is parsed at most once per lookup', () => {
    const graphqlRules = (n) => Array.from({ length: n }, (_, i) => rule({
        id: `g${i}`,
        match: { method: 'POST', url: '*/graphql*', graphql: { operationName: `op${i}` } }
    }));
    const request = (operationName) => ({
        url: 'https://api.test/graphql',
        method: 'POST',
        bodyText: JSON.stringify({ operationName, query: '{ a }' })
    });

    // PER-2: JSON.parse is captured when the matcher loads, so the spy goes in
    // first and fn gets a copy loaded under it.
    function parseCalls(fn) {
        const spy = jest.spyOn(JSON, 'parse');
        try {
            let fresh;
            jest.isolateModules(() => { fresh = require('../src/matcher'); });
            fn(fresh);
            return spy.mock.calls.length;
        } finally {
            spy.mockRestore();
        }
    }

    test('50 GraphQL rules cost one parse, not fifty', () => {
        const rules = graphqlRules(50);
        let hit;
        const calls = parseCalls((m) => { hit = m.findMatchingRule(rules, request('op49')); });
        expect(hit && hit.id).toBe('g49');
        expect(calls).toBe(1);
    });

    test('a lookup that never reaches a GraphQL rule parses nothing', () => {
        const rules = graphqlRules(50);
        const calls = parseCalls((m) => {
            m.findMatchingRule(rules, { url: 'https://api.test/other', method: 'POST', bodyText: '{"operationName":"op1"}' });
        });
        expect(calls).toBe(0);
    });

    test('each lookup parses afresh: the memo does not leak between requests', () => {
        const rules = graphqlRules(5);
        expect(findMatchingRule(rules, request('op1')).id).toBe('g1');
        expect(findMatchingRule(rules, request('op3')).id).toBe('g3');
    });
});

describe('PER-36 — the pattern cache survives a rule set larger than 500', () => {
    // Multi-literal wildcards compile through `new RegExp`, so the number of
    // constructions is the number of compilations. Counting, not timing.
    const wildcardRules = (n, tag) => Array.from({ length: n }, (_, i) => rule({
        id: `${tag}${i}`,
        match: { method: '*', url: `*/${tag}-${i}/*end` }
    }));
    const miss = { url: 'https://api.test/nothing-matches-this', method: 'GET' };

    test('a second pass over 600 patterns compiles nothing', () => {
        const m = loadCountingMatcher();
        const rules = wildcardRules(600, 'big');
        const first = m.compilations(() => { m.findMatchingRule(rules, miss); });
        const second = m.compilations(() => { m.findMatchingRule(rules, miss); });
        expect(first).toBe(600);
        expect(second).toBe(0);
    });

    test('and again at 1200, well past the old cap', () => {
        const m = loadCountingMatcher();
        const rules = wildcardRules(1200, 'huge');
        m.findMatchingRule(rules, miss);
        expect(m.compilations(() => { m.findMatchingRule(rules, miss); })).toBe(0);
    });

    test('the cache is still bounded for a stream of unique patterns (small rule set)', () => {
        const m = loadCountingMatcher();
        m.findMatchingRule([rule()], miss); // the cap is at its floor
        const stream = Array.from({ length: 700 }, (_, i) => `*/stream-${i}/*end`);
        for (const pattern of stream) m.matchUrl(miss.url, pattern);
        // The first patterns were evicted, so asking again recompiles them.
        expect(m.compilations(() => { m.matchUrl(miss.url, stream[0]); })).toBe(1);
        // The newest are still cached.
        expect(m.compilations(() => { m.matchUrl(miss.url, stream[699]); })).toBe(0);
    });
});

describe('PER-12 — header names and values above U+00FF are refused at save time', () => {
    const EN_DASH = String.fromCharCode(0x2013);
    const EMOJI = String.fromCodePoint(0x1F680);
    const headersRule = (headersMod) => base({ type: 'headers', response: undefined, headersMod });
    const mock = (headers) => base({ response: { statusCode: 200, headers, body: {} } });

    test('a mock response header value with an en dash is refused, naming the header', () => {
        const errors = errorsOf(mock({ 'X-Note': `Orders ${EN_DASH} 429` }));
        expect(errors).toMatch(/Response headers: the value for "X-Note" contains characters above U\+00FF/);
        expect(errors).toMatch(/plain ASCII or Latin-1/);
    });

    test('so is an emoji, and a header name with one', () => {
        expect(S.validateRule(mock({ 'X-Note': EMOJI })).valid).toBe(false);
        expect(errorsOf(mock({ [`X-${EN_DASH}`]: 'v' }))).toMatch(/header name "X-.*" contains characters above U\+00FF/);
    });

    test('match.headers values and names are checked too', () => {
        const rule = base({ match: { url: '*/x*', method: 'GET', headers: { 'X-Env': `dev ${EN_DASH} 1` } } });
        expect(errorsOf(rule)).toMatch(/Match request headers: the value for "X-Env" contains characters above U\+00FF/);
    });

    test('headers-rule operations are checked on both sides', () => {
        const request = headersRule({ request: [{ op: 'set', name: 'X-A', value: `a${EN_DASH}b` }] });
        const response = headersRule({ response: [{ op: 'set', name: 'X-A', value: EMOJI }] });
        expect(errorsOf(request)).toMatch(/Request header #1: the header value contains characters above U\+00FF/);
        expect(errorsOf(response)).toMatch(/Response header #1: the header value contains characters above U\+00FF/);
    });

    test('Latin-1 text (U+00FF and below) is still allowed', () => {
        const cafe = 'caf' + String.fromCharCode(0xE9);
        expect(S.validateRule(mock({ 'X-Note': cafe })).valid).toBe(true);
        expect(S.validateRule(headersRule({ request: [{ op: 'set', name: 'X-A', value: cafe }] })).valid).toBe(true);
    });

    test('the rule NAME is not a header value and may contain anything', () => {
        // PER-12 encodes the x-splicetap-rule marker at runtime instead.
        expect(S.validateRule(base({ name: `Bestellungen ${EN_DASH} 429` })).valid).toBe(true);
    });
});

describe('PER-5 — credentialed CORS needs a rule that names a host', () => {
    const cors = (url, ...ops) => base({
        type: 'headers', response: undefined,
        match: { url, method: '*' },
        headersMod: { response: ops }
    });
    const allowCredentials = (value = 'true') => ({ op: 'set', name: 'Access-Control-Allow-Credentials', value });
    const allowOrigin = (value) => ({ op: 'set', name: 'Access-Control-Allow-Origin', value });
    const NEEDS_HOST = /Access-Control-Allow-Credentials: true needs a URL pattern that names a host/;

    test.each([
        'https://api.example.com/*',
        'http://localhost:3000/*',
        '*://localhost*',
        '*://*.example.com/*',
        'http://127.0.0.1:8080/api',
        '/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?\\//',
        '/^https?:\\/\\/api\\.example\\.com\\//'
    ])('allows Allow-Credentials: true on %s', (url) => {
        const rule = cors(url, allowOrigin('https://app.example.com'), allowCredentials());
        expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
        expect(S.patternNamesHost(url)).toBe(true);
    });

    test.each([
        '*/api/*',
        '*',
        '*://*/*',
        'https://*/api',
        '/api/users',
        '*example.com*',
        '/\\/api\\//',
        '/^https?:\\/\\/[^/]+\\/(api\\/.*)/',
        '/\\.json$/'
    ])('refuses Allow-Credentials: true on %s', (url) => {
        const rule = cors(url, allowOrigin('https://app.example.com'), allowCredentials());
        expect(errorsOf(rule)).toMatch(NEEDS_HOST);
        expect(S.patternNamesHost(url)).toBe(false);
    });

    test('Allow-Credentials is also refused on a host-less pattern with no Allow-Origin at all', () => {
        expect(errorsOf(cors('*/api/*', allowCredentials('True')))).toMatch(NEEDS_HOST);
        expect(errorsOf(cors('*/api/*', allowCredentials(' true ')))).toMatch(NEEDS_HOST);
    });

    test('Allow-Credentials: false does not need a host', () => {
        expect(S.validateRule(cors('*/api/*', allowCredentials('false'))).valid).toBe(true);
    });

    test('a wildcard origin plus credentials is refused even on a named host', () => {
        const rule = cors('https://api.example.com/*', allowOrigin('*'), allowCredentials());
        expect(errorsOf(rule)).toMatch(/Access-Control-Allow-Origin: \* cannot be combined with Access-Control-Allow-Credentials: true/);
        expect(errorsOf(cors('https://api.example.com/*', allowOrigin(' * '), allowCredentials())))
            .toMatch(/cannot be combined/);
    });

    test('a request-side header of that name is not response CORS and is not judged', () => {
        const rule = base({
            type: 'headers', response: undefined,
            match: { url: '*/api/*', method: '*' },
            headersMod: { request: [allowCredentials()] }
        });
        expect(S.validateRule(rule).valid).toBe(true);
    });

    test('the shipped CORS Unblock template (wildcard origin, no credentials) stays valid', () => {
        const t = templates.getTemplate('corsUnblock');
        const rule = cors(t.url, ...t.headersModResponse);
        expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
    });

    test('validateHeadersMod called without a URL (the DNR layer) does not judge the host', () => {
        const mod = { response: [allowCredentials()] };
        expect(S.validateHeadersMod(mod).valid).toBe(true);
        expect(S.validateHeadersMod(mod, '*/api/*').valid).toBe(false);
    });
});

describe('PER-22 — $1-$9 in a redirect destination need a /regex/ URL pattern', () => {
    const redirect = (url, destination) => base({
        type: 'redirect', response: undefined,
        match: { url, method: '*' },
        redirect: { destination }
    });

    test.each(['*/api/old/*', '/api/old', '*'])('refuses $1 with the wildcard/substring pattern %s', (url) => {
        const errors = errorsOf(redirect(url, 'https://staging.example.test/$1'));
        expect(errors).toMatch(/uses \$1-\$9, which only work with a \/regex\/ URL pattern/);
        expect(errors).toMatch(/Wildcards \(\*\) don't capture/);
    });

    test('refuses any of $1..$9, including $9 in the middle of the URL', () => {
        expect(S.validateRule(redirect('*/api/*', 'https://s.test/$9/x')).valid).toBe(false);
        expect(S.validateRule(redirect('*/api/*', 'https://s.test/?a=$5')).valid).toBe(false);
    });

    test('accepts $n with a regex pattern', () => {
        expect(S.validateRule(redirect('/\\/api\\/(.*)/', 'http://localhost:3000/$1')).valid).toBe(true);
    });

    test('a destination without $1-$9 is fine with a wildcard, even with a bare $ or $0', () => {
        expect(S.validateRule(redirect('*/api/*', 'https://s.test/new')).valid).toBe(true);
        expect(S.validateRule(redirect('*/api/*', 'https://s.test/a$')).valid).toBe(true);
        expect(S.validateRule(redirect('*/api/*', 'https://s.test/$0')).valid).toBe(true);
    });
});

describe('PER-25 — statusCode, delay and enabled must have the right type', () => {
    const mockWith = (response) => base({ response: { headers: {}, body: {}, ...response } });

    test.each(['404', '200', '201abc', 404.5, null, NaN])('statusCode %p is refused', (statusCode) => {
        expect(errorsOf(mockWith({ statusCode }))).toMatch(/Invalid status code: Status code must be a whole number/);
    });

    test('a numeric statusCode is accepted, and validateStatusCode agrees', () => {
        expect(S.validateRule(mockWith({ statusCode: 404 })).valid).toBe(true);
        expect(S.validateStatusCode(404)).toEqual({ isValid: true, code: 404 });
        expect(S.validateStatusCode('404').isValid).toBe(false);
    });

    test.each(['300ms', '300', '2e3', 1.5, null])('a mock delay of %p is refused', (delay) => {
        expect(errorsOf(mockWith({ statusCode: 200, delay }))).toMatch(/Delay must be a whole number of milliseconds between 0 and 30000/);
    });

    test('a whole-number mock delay in range is accepted; out of range keeps its old message', () => {
        expect(S.validateRule(mockWith({ statusCode: 200, delay: 300 })).valid).toBe(true);
        expect(errorsOf(mockWith({ statusCode: 200, delay: 30001 }))).toMatch(/Delay must be between 0 and 30000 ms/);
    });

    test('delay-rule delayMs must be a number too', () => {
        const delayRule = (delayMs) => base({ type: 'delay', response: undefined, delayMs });
        expect(errorsOf(delayRule('500'))).toMatch(/whole number of milliseconds/);
        expect(errorsOf(delayRule('300ms'))).toMatch(/whole number of milliseconds/);
        expect(errorsOf(delayRule(2.5))).toMatch(/whole number of milliseconds/);
        expect(S.validateRule(delayRule(500)).valid).toBe(true);
    });

    test.each(['false', 'true', 0, 1, null])('enabled %p is refused', (enabled) => {
        expect(errorsOf(base({ enabled }))).toMatch(/"enabled" must be true or false/);
    });

    test('enabled true, false and absent are accepted', () => {
        expect(S.validateRule(base({ enabled: true })).valid).toBe(true);
        expect(S.validateRule(base({ enabled: false })).valid).toBe(true);
        expect(S.validateRule(base()).valid).toBe(true);
    });
});

describe('PER-52 — a status code is at least 200', () => {
    const statusError = (statusCode) => S.validateStatusCode(statusCode).error;

    test.each([100, 101, 103, 199])('%i is refused, and the message says why', (code) => {
        expect(S.validateStatusCode(code).isValid).toBe(false);
        expect(statusError(code)).toMatch(/between 200 and 599/);
        expect(statusError(code)).toMatch(/1xx statuses are interim responses and can never be a final response/);
    });

    test('0 and 600 get the plain range message', () => {
        expect(statusError(0)).toBe('Status code must be between 200 and 599');
        expect(statusError(600)).toBe('Status code must be between 200 and 599');
    });

    test('200 and 599 are the inclusive bounds', () => {
        expect(S.validateStatusCode(200).isValid).toBe(true);
        expect(S.validateStatusCode(599).isValid).toBe(true);
    });

    test('a mock rule with a 1xx status is refused through validateRule', () => {
        const rule = base({ response: { statusCode: 101, headers: {}, body: {} } });
        expect(errorsOf(rule)).toMatch(/Invalid status code: Status code must be between 200 and 599/);
    });

    test('the exported limits report the enforced floor', () => {
        expect(S.LIMITS.STATUS_MIN).toBe(200);
        expect(S.LIMITS.STATUS_MAX).toBe(599);
    });
});

describe('PER-51 — one operation per header name on each side', () => {
    const headersRule = (headersMod) => base({ type: 'headers', response: undefined, headersMod });

    test('the same name twice on one side is refused, case-insensitively', () => {
        const rule = headersRule({
            request: [
                { op: 'set', name: 'X-Token', value: 'a' },
                { op: 'set', name: 'x-token', value: 'b' }
            ]
        });
        expect(errorsOf(rule)).toMatch(/Request header #2: "x-token" appears twice in the request headers/);
    });

    test('a set and a remove of the same name conflict too', () => {
        const rule = headersRule({
            response: [
                { op: 'set', name: 'X-Debug', value: '1' },
                { op: 'remove', name: 'X-DEBUG' }
            ]
        });
        expect(errorsOf(rule)).toMatch(/Response header #2: "X-DEBUG" appears twice in the response headers/);
    });

    test('the same name on the request and the response side is not a conflict', () => {
        const rule = headersRule({
            request: [{ op: 'set', name: 'X-Trace', value: '1' }],
            response: [{ op: 'set', name: 'X-Trace', value: '2' }]
        });
        expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
    });

    test('different names are fine', () => {
        const rule = headersRule({
            request: [{ op: 'set', name: 'X-A', value: '1' }, { op: 'set', name: 'X-B', value: '2' }]
        });
        expect(S.validateRule(rule).valid).toBe(true);
    });
});

describe('PER-49 — /regex/flags patterns are refused instead of silently never matching', () => {
    const flagsError = (pattern) => S.validateUrlPattern(pattern).error;

    test.each([
        '/api\\/x/i',
        '/^api/gi',
        '/foo.*bar/g',
        '/\\/users\\/\\d+/i',
        '/(a|b)/ims'
    ])('refuses %s', (pattern) => {
        expect(S.validateUrlPattern(pattern).isValid).toBe(false);
        expect(flagsError(pattern)).toMatch(/^Regex flags aren't supported — matching is already case-insensitive\./);
    });

    test('the message names the flags and shows the pattern to use instead', () => {
        expect(flagsError('/api\\/x/i')).toContain('Remove "i" after the closing slash (/api\\/x/)');
    });

    test('refused through validateRule as an invalid URL pattern', () => {
        expect(errorsOf(base({ match: { url: '/api\\/x/i', method: 'GET' } })))
            .toMatch(/Invalid URL pattern: Regex flags aren't supported/);
    });

    test.each([
        '/api/v1/i',
        '/api/v',
        '/users/i',
        '/api/s',
        '*/api/*',
        '/api/users',
        '/\\/api\\/x/'
    ])('leaves the ordinary pattern %s alone', (pattern) => {
        expect(S.validateUrlPattern(pattern).isValid).toBe(true);
    });
});

describe('PER-30 — mock bodies and patches nested too deeply are refused', () => {
    /** An object nested `levels` containers deep: {a:{a:{...}}}. */
    function nested(levels, leaf = 1) {
        let value = leaf;
        for (let i = 0; i < levels; i++) value = { a: value };
        return value;
    }
    const withBody = (body) => base({ response: { statusCode: 200, headers: {}, body } });
    const withPatch = (patch) => base({ response: { mode: 'patch', patch } });

    test('64 levels are accepted, 65 refused, for a static body', () => {
        expect(S.validateRule(withBody(nested(64))).valid).toBe(true);
        expect(errorsOf(withBody(nested(65)))).toMatch(/response body is nested more than 64 levels deep/);
    });

    test('and for a patch', () => {
        expect(S.validateRule(withPatch(nested(64))).valid).toBe(true);
        expect(errorsOf(withPatch(nested(65)))).toMatch(/response patch is nested more than 64 levels deep/);
    });

    test('arrays count as levels, and a deep leaf inside a wide document is still found', () => {
        let value = 1;
        for (let i = 0; i < 70; i++) value = [value];
        expect(S.validateRule(withBody(value)).valid).toBe(false);
        expect(S.validateRule(withBody({ a: 1, b: [1, 2, { c: nested(70) }] })).valid).toBe(false);
    });

    test('a document far past the stack limit is refused without blowing the stack', () => {
        expect(S.validateRule(withBody(nested(100000))).valid).toBe(false);
    });

    test('a cyclic object terminates (refused) rather than looping forever', () => {
        const cyclic = { a: 1 };
        cyclic.self = cyclic;
        expect(S.validateRule(withBody(cyclic)).valid).toBe(false);
    });

    test('string and absent bodies are untouched', () => {
        expect(S.validateRule(withBody('plain text')).valid).toBe(true);
        expect(S.validateRule(base({ response: { statusCode: 200, headers: {} } })).valid).toBe(true);
    });
});

describe('PER-19 — an empty patch is a no-op and an object patch never rewrites a non-object root', () => {
    test('an empty patch returns the original untouched', () => {
        const original = { a: 1, b: { c: 2 } };
        expect(jsonMergePatch(original, {})).toEqual({ a: 1, b: { c: 2 } });
        expect(original).toEqual({ a: 1, b: { c: 2 } });
    });

    test('{} on an array root serves the array, not {}', () => {
        const original = [1, 2, 3];
        expect(jsonMergePatch(original, {})).toBe(original);
        expect(jsonMergePatch([{ id: 1 }], {})).toEqual([{ id: 1 }]);
    });

    test('an object patch with keys on an array or scalar root returns the root unchanged', () => {
        const list = [1, 2, 3];
        expect(jsonMergePatch(list, { a: 1 })).toBe(list);
        expect(jsonMergePatch('text', { a: 1 })).toBe('text');
        expect(jsonMergePatch(42, { a: 1 })).toBe(42);
        expect(jsonMergePatch(true, { a: null })).toBe(true);
    });

    test('a missing (null/undefined) root is still treated as an empty object', () => {
        expect(jsonMergePatch(undefined, { a: 1 })).toEqual({ a: 1 });
        expect(jsonMergePatch(null, { a: 1 })).toEqual({ a: 1 });
        expect(jsonMergePatch(null, {})).toEqual({});
    });

    test('a non-object patch still replaces whatever the root was', () => {
        expect(jsonMergePatch([1, 2, 3], 'replaced')).toBe('replaced');
        expect(jsonMergePatch([1, 2, 3], [9])).toEqual([9]);
        expect(jsonMergePatch({ a: 1 }, null)).toBeNull();
    });

    test('nested levels still follow RFC 7386: a non-object value becomes the merged object', () => {
        expect(jsonMergePatch({ a: [1, 2] }, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
        expect(jsonMergePatch({ a: 'x' }, { a: { b: 1 } })).toEqual({ a: { b: 1 } });
        expect(jsonMergePatch({ a: { c: 1 } }, { a: {} })).toEqual({ a: { c: 1 } });
    });

    test.each([
        [{ a: 1 }, {}, false],
        [[1, 2, 3], {}, false],
        [[1, 2, 3], { a: 1 }, false],
        ['text', { a: 1 }, false],
        [7, { a: 1 }, false],
        [{ a: 1 }, { a: 2 }, true],
        [{}, { a: 2 }, true],
        [null, { a: 2 }, true],
        [undefined, { a: 2 }, true],
        [[1, 2], 'replacement', true],
        [{ a: 1 }, [1], true],
        [{ a: 1 }, null, true]
    ])('isPatchApplicable(%j, %j) is %s', (target, patch, expected) => {
        expect(isPatchApplicable(target, patch)).toBe(expected);
    });
});

describe('PER-41 — __proto__ and constructor keys survive the merge', () => {
    test('a __proto__ key in the patch is kept as data and does not touch the prototype', () => {
        const patch = JSON.parse('{"__proto__": {"x": 1}, "a": 1}');
        const result = jsonMergePatch({ b: 2 }, patch);
        // PER-2: the merge builds prototype-less objects, so the proto is null, and a "__proto__" key is data on it.
        expect(Object.getPrototypeOf(result)).toBeNull();
        expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
        expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse('{"b": 2, "__proto__": {"x": 1}, "a": 1}'));
        expect(result.x).toBeUndefined();
        expect({}.x).toBeUndefined();
    });

    test('a __proto__ key in the original survives an unrelated patch', () => {
        const original = JSON.parse('{"__proto__": {"k": 1}, "b": 2}');
        const result = jsonMergePatch(original, { a: 1 });
        expect(Object.getPrototypeOf(result)).toBeNull();
        expect(JSON.stringify(result)).toBe('{"__proto__":{"k":1},"b":2,"a":1}');
    });

    test('a patch merges into an existing __proto__ key, and null deletes it', () => {
        const original = JSON.parse('{"__proto__": {"k": 1}}');
        const merged = jsonMergePatch(original, JSON.parse('{"__proto__": {"y": 2}}'));
        expect(JSON.stringify(merged)).toBe('{"__proto__":{"k":1,"y":2}}');
        const removed = jsonMergePatch(original, JSON.parse('{"__proto__": null}'));
        expect(JSON.stringify(removed)).toBe('{}');
    });

    test('a constructor key is kept as data and pollutes nothing', () => {
        const patch = JSON.parse('{"constructor": {"prototype": {"polluted": true}}}');
        const result = jsonMergePatch({ constructor: { keep: 1 } }, patch);
        expect(JSON.stringify(result)).toBe('{"constructor":{"keep":1,"prototype":{"polluted":true}}}');
        expect({}.polluted).toBeUndefined();
        expect(Object.prototype.polluted).toBeUndefined();
    });
});

describe('templates — PER-9 and PER-24', () => {
    const asRule = (id) => {
        const t = templates.getTemplate(id);
        const rule = { name: id, enabled: true, type: t.type, match: { url: t.url, method: t.method } };
        if (t.graphqlOperation) rule.match.graphql = { operationName: t.graphqlOperation };
        if (t.type === 'mock') {
            rule.response = { statusCode: t.status || 200, headers: { 'Content-Type': 'application/json' }, delay: 0, mode: t.mode || 'static' };
            if (t.mode === 'patch') rule.response.patch = JSON.parse(t.patch);
            else rule.response.body = JSON.parse(t.body);
        }
        if (t.type === 'delay') rule.delayMs = t.delayMs;
        if (t.type === 'redirect') rule.redirect = { destination: t.redirectDestination };
        if (t.type === 'headers') rule.headersMod = { request: t.headersModRequest || [], response: t.headersModResponse || [] };
        return rule;
    };

    test('every template, as the editor saves it, passes the schema', () => {
        for (const meta of templates.listTemplates()) {
            expect({ id: meta.id, ...S.validateRule(asRule(meta.id)) }).toEqual({ id: meta.id, valid: true, errors: [] });
        }
    });

    test('PER-9: "Redirect to localhost" is anchored at the origin and keeps its destination', () => {
        const t = templates.getTemplate('redirectLocalhost');
        expect(t.url).toBe('/^https?:\\/\\/[^/]+\\/(api\\/.*)/');
        expect(t.redirectDestination).toBe('http://localhost:3000/$1');
    });

    test('PER-9: the anchored pattern matches absolute URLs on any host and captures the API path', () => {
        const t = templates.getTemplate('redirectLocalhost');
        const body = t.url.slice(1, -1);
        const re = new RegExp(body, 'i');
        expect(re.exec('https://api.staging.example.com/api/users/7')[1]).toBe('api/users/7');
        expect(re.exec('http://127.0.0.1:8080/api/orders?id=1')[1]).toBe('api/orders?id=1');
        expect(re.test('/api/users/7')).toBe(false);
        expect(re.test('https://example.com/static/app.js')).toBe(false);
        expect(matchUrl('https://api.staging.example.com/api/users/7', t.url)).toBe(true);
    });

    test('PER-24: CORS Unblock also allows the methods a preflight asks about', () => {
        const t = templates.getTemplate('corsUnblock');
        const byName = Object.fromEntries(t.headersModResponse.map((op) => [op.name, op.value]));
        expect(byName['Access-Control-Allow-Methods']).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS');
        expect(byName['Access-Control-Allow-Origin']).toBe('*');
        expect(byName['Access-Control-Allow-Headers']).toBe('*');
        expect(t.headersModResponse).toHaveLength(3);
    });
});
