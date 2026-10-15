/**
 * Batch 2, group G2 "interceptor": F7 in-page targeting (page domains,
 * resource types, payload), F8 status override in patch mode, F10
 * explainRuleMatch and PER-66 call filters, in src/matcher.js and
 * content/injected.js.
 *
 * The interceptor runs under the shared harness, whose page is
 * https://example.test/page. What only Chrome can show (an about:blank or
 * srcdoc frame's host, a real page's resource loads) is in
 * tests/e2e/b2-interceptor.e2e.test.js.
 */

const { createInterceptor } = require('./helpers/injected-harness');
const matcher = require('../src/matcher.js');

const { findMatchingRule, findMatchingRequestBodyRule, matchPageDomains, matchPayload } = matcher;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function mockRule(id, match = {}, response = {}, extra = {}) {
    return {
        id,
        name: id,
        enabled: true,
        type: 'mock',
        match: { url: '*/api/*', method: '*', ...match },
        response: { statusCode: 200, headers: JSON_HEADERS, body: { mocked: id }, delay: 0, mode: 'static', ...response },
        ...extra
    };
}

function blockRule(id, match = {}, extra = {}) {
    return { id, name: id, enabled: true, type: 'block', match: { url: '*/api/*', method: '*', ...match }, ...extra };
}

const req = (overrides = {}) => ({
    url: 'https://example.test/api/x',
    method: 'POST',
    headers: {},
    bodyText: null,
    pageHost: 'example.test',
    ...overrides
});

/** An interceptor holding these rules. */
function withRules(rules, settings = {}, options = {}) {
    const h = createInterceptor(options);
    h.syncState({ rules, settings });
    return h;
}

/** fetch() through the interceptor, reporting what the page sees. */
async function pageFetch(h, url, init) {
    try {
        const response = await h.fetch(url, init);
        const text = await response.text();
        let body = text;
        try { body = JSON.parse(text); } catch (e) { /* text */ }
        return { status: response.status, statusText: response.statusText, marker: response.headers.get('x-splicetap'), body };
    } catch (error) {
        return { failed: true, error: String(error && error.message) };
    }
}

/** Drive one XHR to loadend. */
function sendXHR(h, { method = 'POST', url = 'https://example.test/api/x', headers = {}, body = null } = {}) {
    const xhr = h.newXHR();
    return new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('XHR never settled')), 3000);
        xhr.addEventListener('loadend', () => {
            clearTimeout(guard);
            setTimeout(() => {
                let parsed = xhr.responseText;
                try { parsed = JSON.parse(parsed); } catch (e) { /* text */ }
                resolve({ xhr, status: xhr.status, statusText: xhr.statusText, body: parsed, marker: xhr.getResponseHeader('x-splicetap') });
            }, 0);
        });
        xhr.open(method, url);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        xhr.send(body);
    });
}

// ---------------------------------------------------------------------------
// F7: page domains

describe('B2-F7: matchPageDomains', () => {
    test('a domain matches itself and its subdomains, not a lookalike', () => {
        expect(matchPageDomains('example.com', ['example.com'])).toBe(true);
        expect(matchPageDomains('app.example.com', ['example.com'])).toBe(true);
        expect(matchPageDomains('a.b.example.com', ['example.com'])).toBe(true);
        expect(matchPageDomains('badexample.com', ['example.com'])).toBe(false);
        expect(matchPageDomains('example.com.evil.test', ['example.com'])).toBe(false);
        expect(matchPageDomains('com', ['example.com'])).toBe(false);
    });

    test('any listed domain will do; case and a trailing dot do not matter', () => {
        expect(matchPageDomains('other.test', ['example.com', 'other.test'])).toBe(true);
        expect(matchPageDomains('App.Example.COM', ['example.com'])).toBe(true);
        expect(matchPageDomains('example.com.', ['example.com'])).toBe(true);
    });

    test('no list, or an empty one, is no condition', () => {
        expect(matchPageDomains('anything.test', undefined)).toBe(true);
        expect(matchPageDomains('anything.test', [])).toBe(true);
    });

    test('an unknown or empty host matches no list', () => {
        expect(matchPageDomains(undefined, ['example.com'])).toBe(false);
        expect(matchPageDomains(null, ['example.com'])).toBe(false);
        expect(matchPageDomains('', ['example.com'])).toBe(false);
    });

    test('in findMatchingRule, a rule for another site falls through to the next', () => {
        const elsewhere = mockRule('elsewhere', { pageDomains: ['other.test'] });
        const here = mockRule('here', { pageDomains: ['example.test'] });
        expect(findMatchingRule([elsewhere, here], req())).toBe(here);
        expect(findMatchingRule([elsewhere, here], req({ pageHost: 'www.other.test' }))).toBe(elsewhere);
        expect(findMatchingRule([elsewhere], req({ pageHost: undefined }))).toBeNull();
        expect(findMatchingRequestBodyRule([{ ...elsewhere, type: 'requestBody' }], req())).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// F7: resource types

describe('B2-F7: resource types in the page', () => {
    const all = (id, resourceTypes) => blockRule(id, resourceTypes ? { resourceTypes } : {}, { appliesTo: 'all' });

    test("an appliesTo:'all' rule is handled here only when 'fetch-xhr' is listed or nothing is", () => {
        expect(findMatchingRule([all('none')], req())).not.toBeNull();
        expect(findMatchingRule([all('scripts', ['script', 'image'])], req())).toBeNull();
        expect(findMatchingRule([all('both', ['script', 'fetch-xhr'])], req())).not.toBeNull();
    });

    test('a skipped rule lets a later rule have the call', () => {
        const scripts = all('scripts', ['script']);
        const mock = mockRule('m');
        expect(findMatchingRule([scripts, mock], req())).toBe(mock);
    });

    test('the request may name another resource type', () => {
        expect(findMatchingRule([all('scripts', ['script'])], req({ resourceType: 'script' }))).not.toBeNull();
        // A page-scoped rule only ever sees fetch and XHR.
        expect(findMatchingRule([mockRule('m')], req({ resourceType: 'script' }))).toBeNull();
        expect(findMatchingRule([all('none')], req({ resourceType: 'image' }))).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// F7: payload

describe('B2-F7: matchPayload', () => {
    const body = JSON.stringify({ user: { id: 42, name: 'Ada Lovelace', admin: false, tags: ['a', 'b'], meta: { x: 1 }, none: null }, items: [{ sku: 'X-1' }, { sku: 'Y-2' }] });

    test('equals compares String(value at path)', () => {
        expect(matchPayload(body, { path: 'user.id', operator: 'equals', value: '42' })).toBe(true);
        expect(matchPayload(body, { path: 'user.id', operator: 'equals', value: '4' })).toBe(false);
        expect(matchPayload(body, { path: 'user.admin', operator: 'equals', value: 'false' })).toBe(true);
        expect(matchPayload(body, { path: 'user.none', operator: 'equals', value: 'null' })).toBe(true);
        expect(matchPayload(body, { path: 'user.tags', operator: 'equals', value: 'a,b' })).toBe(true);
        expect(matchPayload(body, { path: 'user.meta', operator: 'equals', value: '[object Object]' })).toBe(true);
    });

    test('contains is a substring test, case-sensitive', () => {
        expect(matchPayload(body, { path: 'user.name', operator: 'contains', value: 'Love' })).toBe(true);
        expect(matchPayload(body, { path: 'user.name', operator: 'contains', value: 'love' })).toBe(false);
    });

    test('array indexes are path segments', () => {
        expect(matchPayload(body, { path: 'items.1.sku', operator: 'equals', value: 'Y-2' })).toBe(true);
        expect(matchPayload(body, { path: 'items.2.sku', operator: 'equals', value: 'Y-2' })).toBe(false);
    });

    test('a missing path, a non-JSON body or no body never matches', () => {
        expect(matchPayload(body, { path: 'user.missing', operator: 'equals', value: 'undefined' })).toBe(false);
        expect(matchPayload(body, { path: 'user.name.first', operator: 'contains', value: '' })).toBe(false);
        expect(matchPayload('user=42', { path: 'user', operator: 'equals', value: '42' })).toBe(false);
        expect(matchPayload(null, { path: 'user', operator: 'contains', value: '' })).toBe(false);
        expect(matchPayload('', { path: 'user', operator: 'contains', value: '' })).toBe(false);
    });

    test('an unknown operator never matches; no payload condition always does', () => {
        expect(matchPayload(body, { path: 'user.id', operator: 'startsWith', value: '4' })).toBe(false);
        expect(matchPayload(body, undefined)).toBe(true);
        expect(matchPayload(null, null)).toBe(true);
    });

    test('a path never reaches the prototype chain (contract B)', () => {
        const seen = [];
        Object.defineProperty(Object.prototype, 'spliceTapSecretKey', {
            configurable: true,
            get() { seen.push('read'); return 'leak'; }
        });
        try {
            expect(matchPayload('{"a":{}}', { path: 'a.spliceTapSecretKey', operator: 'equals', value: 'leak' })).toBe(false);
            expect(matchPayload('{"a":{}}', { path: 'a.__proto__.spliceTapSecretKey', operator: 'equals', value: 'leak' })).toBe(false);
            expect(seen).toEqual([]);
        } finally {
            delete Object.prototype.spliceTapSecretKey;
        }
    });

    test('constructor and __proto__ resolve only as own keys of the body', () => {
        const condition = (path, value) => ({ path, operator: 'equals', value });
        expect(matchPayload('{"a":{}}', condition('a.constructor.name', 'Object'))).toBe(false);
        expect(matchPayload('{"a":[]}', condition('a.constructor.name', 'Array'))).toBe(false);
        expect(matchPayload('{"a":"text"}', condition('a.length', '4'))).toBe(false);
        expect(matchPayload('{"a":{}}', condition('a.__proto__', '[object Object]'))).toBe(false);
        expect(matchPayload('{"constructor":{"name":"mine"}}', condition('constructor.name', 'mine'))).toBe(true);
        expect(matchPayload('{"__proto__":{"x":"own"}}', condition('__proto__.x', 'own'))).toBe(true);
    });

    test('in findMatchingRule, a non-matching payload falls through', () => {
        const admin = mockRule('admin', { payload: { path: 'user.id', operator: 'equals', value: '1' } });
        const rest = mockRule('rest');
        expect(findMatchingRule([admin, rest], req({ bodyText: '{"user":{"id":1}}' }))).toBe(admin);
        expect(findMatchingRule([admin, rest], req({ bodyText: '{"user":{"id":2}}' }))).toBe(rest);
        expect(findMatchingRule([admin, rest], req({ bodyText: null }))).toBe(rest);
    });
});

// ---------------------------------------------------------------------------
// F7 in the interceptor

describe('B2-F7: the interceptor passes the frame host, resource type and body', () => {
    test('page domains: fetch and XHR are mocked on the listed site only (the harness page is example.test)', async () => {
        const h = withRules([
            mockRule('other', { url: '*/api/a*', pageDomains: ['other.test'] }),
            mockRule('mine', { url: '*/api/b*', pageDomains: ['test'] })
        ]);
        expect((await pageFetch(h, 'https://example.test/api/a')).body).toEqual({ origin: true });
        expect((await pageFetch(h, 'https://example.test/api/b')).body).toEqual({ mocked: 'mine' });
        expect((await sendXHR(h, { url: 'https://example.test/api/a' })).body).toEqual({ origin: true });
        expect((await sendXHR(h, { url: 'https://example.test/api/b' })).body).toEqual({ mocked: 'mine' });
    });

    test("resource types: an appliesTo:'all' block without 'fetch-xhr' leaves fetch and XHR alone", async () => {
        const h = withRules([
            blockRule('scripts', { url: '*/api/a*', resourceTypes: ['script'] }, { appliesTo: 'all' }),
            blockRule('calls', { url: '*/api/b*', resourceTypes: ['fetch-xhr', 'script'] }, { appliesTo: 'all' })
        ]);
        expect((await pageFetch(h, 'https://example.test/api/a')).body).toEqual({ origin: true });
        expect((await pageFetch(h, 'https://example.test/api/b')).failed).toBe(true);
        expect((await sendXHR(h, { url: 'https://example.test/api/a' })).status).toBe(200);
        expect((await sendXHR(h, { url: 'https://example.test/api/b' })).status).toBe(0);
    });

    test('payload: fetch reads the body for a payload rule, and a non-matching body passes', async () => {
        const h = withRules([mockRule('vip', { payload: { path: 'user.tier', operator: 'equals', value: 'gold' } })]);
        const gold = await pageFetch(h, 'https://example.test/api/order', { method: 'POST', body: '{"user":{"tier":"gold"}}' });
        const basic = await pageFetch(h, 'https://example.test/api/order', { method: 'POST', body: '{"user":{"tier":"basic"}}' });
        const viaRequest = await pageFetch(h, new Request('https://example.test/api/order', { method: 'POST', body: '{"user":{"tier":"gold"}}' }));
        expect(gold.body).toEqual({ mocked: 'vip' });
        expect(basic.body).toEqual({ origin: true });
        expect(viaRequest.body).toEqual({ mocked: 'vip' });
    });

    test('payload: XHR matches its sent body', async () => {
        const h = withRules([mockRule('vip', { payload: { path: 'items.0.sku', operator: 'contains', value: 'PRO' } })]);
        expect((await sendXHR(h, { body: '{"items":[{"sku":"PRO-9"}]}' })).body).toEqual({ mocked: 'vip' });
        expect((await sendXHR(h, { body: '{"items":[{"sku":"LITE"}]}' })).body).toEqual({ origin: true });
        expect((await sendXHR(h, { body: 'not json' })).body).toEqual({ origin: true });
    });

    test('payload: a requestBody rule is chosen by the original body', async () => {
        const h = withRules([{
            id: 'rb', name: 'rb', enabled: true, type: 'requestBody',
            match: { url: '*/api/*', method: '*', payload: { path: 'kind', operator: 'equals', value: 'draft' } },
            requestBody: { mode: 'patch', patch: { kind: 'final' } }
        }]);
        await pageFetch(h, 'https://example.test/api/save', { method: 'POST', body: '{"kind":"draft"}' });
        await pageFetch(h, 'https://example.test/api/save', { method: 'POST', body: '{"kind":"other"}' });
        const sent = await Promise.all(h.passthroughCalls.map(async ([resource, init]) => new Request(resource, init).text()));
        expect(sent.map((text) => JSON.parse(text).kind)).toEqual(['final', 'other']);
    });

    test('XHR open() leaves a redirect to send() when a payload rule above it may win', async () => {
        const h = withRules([
            mockRule('vip', { url: '*/api/*', payload: { path: 'vip', operator: 'equals', value: 'true' } }),
            { id: 'r', name: 'r', enabled: true, type: 'redirect', match: { url: '*/api/*', method: '*' }, redirect: { destination: 'https://example.test/elsewhere' } }
        ]);
        const vip = await sendXHR(h, { body: '{"vip":true}' });
        expect(vip.body).toEqual({ mocked: 'vip' });
        await sendXHR(h, { body: '{"vip":false}' });
        expect(h.xhrCalls.map((c) => c.url)).toEqual(['https://example.test/elsewhere']);
    });

    test('a pattern written for the relative URL still matches, in one scan (PER-8)', async () => {
        const h = withRules([mockRule('rel', { url: '/api/rel*' })]);
        expect((await pageFetch(h, '/api/rel')).body).toEqual({ mocked: 'rel' });
        expect((await sendXHR(h, { url: '/api/rel' })).body).toEqual({ mocked: 'rel' });
    });
});

// ---------------------------------------------------------------------------
// F8: status override in patch mode

describe('B2-F8: response.patchStatus', () => {
    const { reasonPhrase } = require('../src/patch.js');
    const templates = require('../src/templates.js');

    const patchRule = (response = {}) => mockRule('p', { url: '*/api/*' },
        { mode: 'patch', patch: { patched: true }, ...response });
    const textFetch = async () => new Response('plain real text', { status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/plain' } });
    const realFetch = async () => new Response('{"origin":true}', { status: 201, statusText: 'Made it', headers: JSON_HEADERS });

    test("the page's reason phrases are SpliceTap's table (src/templates.js)", () => {
        for (let code = 100; code <= 599; code++) expect(reasonPhrase(code)).toBe(templates.getStatusText(code));
        expect(reasonPhrase('404')).toBe('Not Found');
        expect(reasonPhrase(undefined)).toBe('');
    });

    test('fetch: the patched body is served with the override status and its reason phrase', async () => {
        const h = withRules([patchRule({ patchStatus: 503 })]);
        const log = h.collect(h.channels.log);
        const r = await pageFetch(h, 'https://example.test/api/x');
        expect(r).toEqual({ status: 503, statusText: 'Service Unavailable', marker: 'true', body: { origin: true, patched: true } });
        expect(log[0]).toEqual(expect.objectContaining({ ruleId: 'p', status: 503 }));
    });

    test('fetch: without an override the real status stays; a code outside the table gets no phrase', async () => {
        const plain = await pageFetch(withRules([patchRule()], {}, { originalFetch: realFetch }), 'https://example.test/api/x');
        const multi = await pageFetch(withRules([patchRule({ patchStatus: 207 })], {}, { originalFetch: realFetch }), 'https://example.test/api/x');
        expect(plain).toEqual(expect.objectContaining({ status: 201, statusText: 'Made it', body: { origin: true, patched: true } }));
        expect(multi).toEqual(expect.objectContaining({ status: 207, statusText: '', body: { origin: true, patched: true } }));
    });

    test('fetch: an override outside 200-599, or not an integer, is ignored', async () => {
        for (const patchStatus of [199, 600, 503.5, '503']) {
            const r = await pageFetch(withRules([patchRule({ patchStatus })]), 'https://example.test/api/x');
            expect(r.status).toBe(200);
        }
    });

    test('fetch: a body that cannot be patched is served unchanged, with the override status', async () => {
        const text = await pageFetch(withRules([patchRule({ patchStatus: 500 })], {}, { originalFetch: textFetch }), 'https://example.test/api/x');
        const empty = await pageFetch(withRules([patchRule({ patchStatus: 404, patch: {} })]), 'https://example.test/api/x');
        expect(text).toEqual({ status: 500, statusText: 'Internal Server Error', marker: null, body: 'plain real text' });
        expect(empty).toEqual(expect.objectContaining({ status: 404, statusText: 'Not Found', body: { origin: true } }));
    });

    test('fetch: an overridden response keeps the status on clone()', async () => {
        const h = withRules([patchRule({ patchStatus: 503, patch: {} })]);
        const response = await h.fetch('https://example.test/api/x');
        const copy = response.clone();
        expect([response.status, response.ok, copy.status, copy.statusText, copy.ok]).toEqual([503, false, 503, 'Service Unavailable', false]);
    });

    test('XHR: the patched body is served with the override status and its reason phrase', async () => {
        const r = await sendXHR(withRules([patchRule({ patchStatus: 502 })]), { method: 'GET' });
        expect(r).toEqual(expect.objectContaining({ status: 502, statusText: 'Bad Gateway', marker: 'true', body: { origin: true, patched: true } }));
    });

    test('XHR: a text response streams through unchanged, with the override status', async () => {
        const h = withRules([patchRule({ patchStatus: 500 })], {}, { originalFetch: textFetch });
        const r = await sendXHR(h, { method: 'GET' });
        expect(r).toEqual(expect.objectContaining({ status: 500, statusText: 'Internal Server Error', body: 'plain real text' }));
    });

    test('XHR: without an override the real status stays', async () => {
        const r = await sendXHR(withRules([patchRule()], {}, { originalFetch: realFetch }), { method: 'GET' });
        expect(r).toEqual(expect.objectContaining({ status: 201, statusText: 'Made it', body: { origin: true, patched: true } }));
    });
});

// ---------------------------------------------------------------------------
// F10: explainRuleMatch

describe('B2-F10: explainRuleMatch', () => {
    const { explainRuleMatch } = matcher;
    const rule = (match = {}, extra = {}) => ({ id: 'r', type: 'mock', enabled: true, match: { url: '*/api/*', method: '*', ...match }, ...extra });
    const tryUrl = (overrides = {}) => ({ url: 'https://example.test/api/x', method: 'GET', headers: {}, bodyText: null, ...overrides });

    /** The single check for `condition`. */
    function only(result, condition) {
        const found = result.checks.filter((c) => c.condition === condition);
        expect(found).toHaveLength(1);
        expect(typeof found[0].detail).toBe('string');
        expect(found[0].detail).toMatch(/^[A-Z].*\.$/); // a sentence
        return found[0];
    }

    test('a plain rule is checked on url and method only, and matches', () => {
        const result = explainRuleMatch(rule(), tryUrl());
        expect(result.matches).toBe(true);
        expect(result.checks.map((c) => c.condition)).toEqual(['url', 'method']);
        expect(only(result, 'url')).toEqual({ condition: 'url', ok: true, detail: 'The URL matches the wildcard pattern "*/api/*".' });
        expect(only(result, 'method')).toEqual({ condition: 'method', ok: true, detail: 'Any method matches.' });
    });

    describe('url', () => {
        test('wildcard, substring and regex patterns, passing and failing', () => {
            expect(only(explainRuleMatch(rule({ url: '*/nope/*' }), tryUrl()), 'url'))
                .toEqual({ condition: 'url', ok: false, detail: 'The URL does not match the wildcard pattern "*/nope/*".' });
            expect(only(explainRuleMatch(rule({ url: 'api/x' }), tryUrl()), 'url'))
                .toEqual({ condition: 'url', ok: true, detail: 'The URL contains "api/x".' });
            expect(only(explainRuleMatch(rule({ url: 'api/y' }), tryUrl()), 'url'))
                .toEqual({ condition: 'url', ok: false, detail: 'The URL does not contain "api/y".' });
            expect(only(explainRuleMatch(rule({ url: '/\\/api\\/x$/' }), tryUrl()), 'url'))
                .toEqual({ condition: 'url', ok: true, detail: 'The URL matches the regular expression /\\/api\\/x$/.' });
            expect(only(explainRuleMatch(rule({ url: '/\\/api\\/y$/' }), tryUrl()), 'url'))
                .toEqual({ condition: 'url', ok: false, detail: 'The URL does not match the regular expression /\\/api\\/y$/.' });
        });

        test('a pattern written for the relative URL matches the path, and says so', () => {
            const ok = only(explainRuleMatch(rule({ url: '/api/x*' }), tryUrl({ url: 'https://example.test/api/x?q=1' })), 'url');
            expect(ok.ok).toBe(true);
            expect(ok.detail).toBe('The URL as a relative path ("/api/x?q=1") matches the wildcard pattern "/api/x*", as when the page calls it that way.');
            expect(only(explainRuleMatch(rule({ url: '/api/y*' }), tryUrl()), 'url').ok).toBe(false);
            expect(only(explainRuleMatch(rule({ url: '/api/x*' }), tryUrl({ url: 'https://h.test/z', rawUrl: '/api/x' })), 'url').ok).toBe(true);
        });

        test('no pattern, an unusable regex, or no URL never matches', () => {
            expect(only(explainRuleMatch(rule({ url: undefined }), tryUrl()), 'url'))
                .toEqual({ condition: 'url', ok: false, detail: 'This rule has no URL pattern, so it matches nothing.' });
            expect(only(explainRuleMatch(rule({ url: '/(unclosed/' }), tryUrl()), 'url').detail)
                .toMatch(/^The pattern \/\(unclosed\/ is not a usable regular expression/);
            expect(only(explainRuleMatch(rule(), tryUrl({ url: '' })), 'url'))
                .toEqual({ condition: 'url', ok: false, detail: 'No URL was given to test.' });
            expect(explainRuleMatch({}, tryUrl()).matches).toBe(false);
        });
    });

    test('method: any, equal (case-insensitive) and different; no method given is GET', () => {
        expect(only(explainRuleMatch(rule({ method: 'post' }), tryUrl({ method: 'POST' })), 'method'))
            .toEqual({ condition: 'method', ok: true, detail: 'The method is POST.' });
        const wrong = explainRuleMatch(rule({ method: 'POST' }), tryUrl({ method: undefined }));
        expect(wrong.matches).toBe(false);
        expect(only(wrong, 'method')).toEqual({ condition: 'method', ok: false, detail: 'The rule needs POST, but this request is GET.' });
    });

    test('headers: all match, one matches, missing, wrong value', () => {
        const two = rule({ headers: { 'X-Env': 'stag', 'X-Team': 'web' } });
        expect(only(explainRuleMatch(two, tryUrl({ headers: { 'x-env': 'staging', 'X-TEAM': 'web-a' } })), 'headers'))
            .toEqual({ condition: 'headers', ok: true, detail: 'All 2 header conditions match.' });
        expect(only(explainRuleMatch(rule({ headers: { 'X-Env': 'stag' } }), tryUrl({ headers: { 'x-env': 'STAGING' } })), 'headers'))
            .toEqual({ condition: 'headers', ok: true, detail: 'The "X-Env" header contains "stag".' });
        expect(only(explainRuleMatch(two, tryUrl({ headers: { 'x-env': 'staging' } })), 'headers'))
            .toEqual({ condition: 'headers', ok: false, detail: 'The request has no "X-Team" header.' });
        expect(only(explainRuleMatch(two, tryUrl({ headers: { 'x-env': 'prod', 'x-team': 'web' } })), 'headers'))
            .toEqual({ condition: 'headers', ok: false, detail: 'The "X-Env" header does not contain "stag".' });
        expect(explainRuleMatch(rule({ headers: {} }), tryUrl()).checks.map((c) => c.condition)).toEqual(['url', 'method']);
    });

    test('graphql: named operation, another operation, none, no body', () => {
        const gql = rule({ graphql: { operationName: 'GetUser' } });
        expect(only(explainRuleMatch(gql, tryUrl({ bodyText: '{"query":"query GetUser { me { id } }"}' })), 'graphql'))
            .toEqual({ condition: 'graphql', ok: true, detail: 'The GraphQL operation is "GetUser".' });
        expect(only(explainRuleMatch(gql, tryUrl({ url: 'https://example.test/api/x?operationName=GetUser' })), 'graphql').ok).toBe(true);
        expect(only(explainRuleMatch(gql, tryUrl({ bodyText: '{"operationName":"ListUsers"}' })), 'graphql'))
            .toEqual({ condition: 'graphql', ok: false, detail: 'The GraphQL operation is "ListUsers", not "GetUser".' });
        expect(only(explainRuleMatch(gql, tryUrl({ bodyText: '{"query":"{ me { id } }"}' })), 'graphql'))
            .toEqual({ condition: 'graphql', ok: false, detail: 'The request names no GraphQL operation; the rule needs "GetUser".' });
        expect(only(explainRuleMatch(gql, tryUrl()), 'graphql'))
            .toEqual({ condition: 'graphql', ok: false, detail: 'No request body was given, so the GraphQL operation "GetUser" cannot be found.' });
    });

    test('pageDomains: the domain, a subdomain, another site, no host, no page', () => {
        const scoped = rule({ pageDomains: ['example.com', 'example.org'] });
        expect(only(explainRuleMatch(scoped, tryUrl({ pageHost: 'example.com' })), 'pageDomains'))
            .toEqual({ condition: 'pageDomains', ok: true, detail: 'The page is on example.com.' });
        expect(only(explainRuleMatch(scoped, tryUrl({ pageHost: 'App.Example.org' })), 'pageDomains'))
            .toEqual({ condition: 'pageDomains', ok: true, detail: 'The page is on app.example.org, within example.org.' });
        expect(only(explainRuleMatch(scoped, tryUrl({ pageHost: 'other.test' })), 'pageDomains'))
            .toEqual({ condition: 'pageDomains', ok: false, detail: 'The page is on other.test, not on example.com or example.org.' });
        expect(only(explainRuleMatch(scoped, tryUrl({ pageHost: '' })), 'pageDomains'))
            .toEqual({ condition: 'pageDomains', ok: false, detail: 'The page has no host name; this rule only runs on pages on example.com or example.org.' });
        expect(only(explainRuleMatch(scoped, tryUrl()), 'pageDomains'))
            .toEqual({ condition: 'pageDomains', ok: false, detail: 'No page was given; this rule only runs on pages on example.com or example.org.' });
        const many = rule({ pageDomains: ['a.test', 'b.test', 'c.test', 'd.test', 'e.test', 'f.test', 'g.test'] });
        expect(only(explainRuleMatch(many, tryUrl({ pageHost: 'z.test' })), 'pageDomains').detail)
            .toBe('The page is on z.test, not on a.test, b.test, c.test, d.test, e.test or 2 more.');
    });

    test('resourceTypes: listed or defaulted by rule kind, passing and failing', () => {
        const all = (resourceTypes) => rule(resourceTypes ? { resourceTypes } : {}, { type: 'block', appliesTo: 'all' });
        expect(only(explainRuleMatch(all(['script', 'image']), tryUrl({ resourceType: 'image' })), 'resourceTypes'))
            .toEqual({ condition: 'resourceTypes', ok: true, detail: 'The rule covers images.' });
        expect(only(explainRuleMatch(all(['script', 'image']), tryUrl()), 'resourceTypes'))
            .toEqual({ condition: 'resourceTypes', ok: false, detail: 'The rule covers scripts or images, not fetch/XHR calls.' });
        expect(only(explainRuleMatch(all(), tryUrl({ resourceType: 'font' })), 'resourceTypes'))
            .toEqual({ condition: 'resourceTypes', ok: true, detail: 'This rule applies to every kind of request.' });
        expect(only(explainRuleMatch(rule(), tryUrl({ resourceType: 'document' })), 'resourceTypes'))
            .toEqual({ condition: 'resourceTypes', ok: false, detail: 'The rule covers fetch/XHR calls, not pages.' });
        expect(only(explainRuleMatch(rule({}, { type: 'headers' }), tryUrl({ resourceType: 'other' })), 'resourceTypes'))
            .toEqual({ condition: 'resourceTypes', ok: true, detail: 'The rule covers other requests.' });
        expect(only(explainRuleMatch(rule({}, { type: 'queryparams' }), tryUrl({ resourceType: 'websocket' })), 'resourceTypes'))
            .toEqual({ condition: 'resourceTypes', ok: false, detail: 'The rule covers fetch/XHR calls or other requests, not WebSockets.' });
    });

    test('payload: equals and contains, passing and failing; no body, not JSON, missing path, unknown operator', () => {
        const eq = rule({ payload: { path: 'user.id', operator: 'equals', value: '42' } });
        const has = rule({ payload: { path: 'user.name', operator: 'contains', value: 'Ada' } });
        const body = (user) => JSON.stringify({ user });
        expect(only(explainRuleMatch(eq, tryUrl({ bodyText: body({ id: 42 }) })), 'payload'))
            .toEqual({ condition: 'payload', ok: true, detail: 'The body\'s user.id is "42".' });
        expect(only(explainRuleMatch(eq, tryUrl({ bodyText: body({ id: 7 }) })), 'payload'))
            .toEqual({ condition: 'payload', ok: false, detail: 'The body\'s user.id is "7", not "42".' });
        expect(only(explainRuleMatch(has, tryUrl({ bodyText: body({ name: 'Ada L' }) })), 'payload'))
            .toEqual({ condition: 'payload', ok: true, detail: 'The body\'s user.name ("Ada L") contains "Ada".' });
        expect(only(explainRuleMatch(has, tryUrl({ bodyText: body({ name: 'Bob' }) })), 'payload'))
            .toEqual({ condition: 'payload', ok: false, detail: 'The body\'s user.name ("Bob") does not contain "Ada".' });
        expect(only(explainRuleMatch(eq, tryUrl()), 'payload'))
            .toEqual({ condition: 'payload', ok: false, detail: 'No request body was given; the rule needs user.id to equal "42".' });
        expect(only(explainRuleMatch(eq, tryUrl({ bodyText: 'id=42' })), 'payload'))
            .toEqual({ condition: 'payload', ok: false, detail: 'The request body is not JSON, so the payload condition cannot match.' });
        expect(only(explainRuleMatch(eq, tryUrl({ bodyText: body({}) })), 'payload'))
            .toEqual({ condition: 'payload', ok: false, detail: 'The body has no "user.id".' });
        expect(only(explainRuleMatch(rule({ payload: { path: 'a', operator: 'regex', value: 'x' } }), tryUrl({ bodyText: '{"a":"x"}' })), 'payload'))
            .toEqual({ condition: 'payload', ok: false, detail: 'The payload operator "regex" is not one SpliceTap knows.' });
    });

    test('matches only when every check passes, and agrees with findMatchingRule', () => {
        const full = rule({
            url: '*/api/*', method: 'POST', headers: { 'X-Env': 'stag' }, pageDomains: ['example.test'],
            payload: { path: 'a', operator: 'equals', value: '1' }
        });
        const good = tryUrl({ method: 'POST', headers: { 'x-env': 'staging' }, pageHost: 'example.test', bodyText: '{"a":1}' });
        expect(explainRuleMatch(full, good).matches).toBe(true);
        expect(findMatchingRule([full], good)).toBe(full);
        for (const bad of [{ method: 'GET' }, { headers: {} }, { pageHost: 'other.test' }, { bodyText: '{"a":2}' }, { url: 'https://example.test/x' }]) {
            const request = { ...good, ...bad };
            expect(explainRuleMatch(full, request).matches).toBe(false);
            expect(findMatchingRule([full], request)).toBeNull();
        }
    });

    test('long values are shortened in details; null-prototype rules work', () => {
        const long = 'x'.repeat(100);
        const detail = only(explainRuleMatch(rule({ url: long }), tryUrl()), 'url').detail;
        expect(detail.length).toBeLessThan(100);
        expect(detail).toContain('…');
        const bare = Object.assign(Object.create(null), { match: Object.assign(Object.create(null), { url: '*/api/*' }) });
        expect(explainRuleMatch(bare, tryUrl()).matches).toBe(true);
        expect(explainRuleMatch(null, null).matches).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// PER-66: call filters

describe('PER-66: match.callFilter in the matcher', () => {
    const filtered = (id, mode, n, match = {}) => mockRule(id, { callFilter: { mode, n }, ...match });
    /** Which rule (id, or null) answers each of `calls` requests with one shared counter store. */
    function run(rules, calls, request = req()) {
        const callCounts = Object.create(null);
        const out = [];
        for (let i = 0; i < calls; i++) {
            const hit = findMatchingRule(rules, { ...request, callCounts });
            out.push(hit ? hit.id : null);
        }
        return { out, callCounts };
    }

    test('first n, after n, every n', () => {
        expect(run([filtered('f', 'first', 2)], 4).out).toEqual(['f', 'f', null, null]);
        expect(run([filtered('a', 'after', 2)], 4).out).toEqual([null, null, 'a', 'a']);
        expect(run([filtered('e', 'every', 3)], 7).out).toEqual([null, null, 'e', null, null, 'e', null]);
    });

    test('a call that does not qualify falls through to later rules', () => {
        expect(run([filtered('once', 'first', 1), mockRule('rest')], 3).out).toEqual(['once', 'rest', 'rest']);
    });

    test('counts are per rule id and only for calls that meet every condition', () => {
        const rules = [filtered('f', 'first', 1, { url: '*/api/x*' })];
        const callCounts = Object.create(null);
        expect(findMatchingRule(rules, req({ url: 'https://example.test/other', callCounts }))).toBeNull();
        expect(callCounts).toEqual({});
        expect(findMatchingRule(rules, req({ callCounts }))).toBe(rules[0]);
        expect(findMatchingRule(rules, req({ callCounts }))).toBeNull();
        expect({ ...callCounts }).toEqual({ 'id:f': 2 });
    });

    test('rules below the winner are not counted', () => {
        const { callCounts } = run([mockRule('top'), filtered('below', 'first', 1)], 3);
        expect({ ...callCounts }).toEqual({});
    });

    test('without a counter store (the service worker, a look-ahead) the filter is not applied', () => {
        const rule = filtered('f', 'after', 5);
        expect(findMatchingRule([rule], req())).toBe(rule);
        expect(findMatchingRule([rule], req())).toBe(rule);
    });

    test('a malformed filter always qualifies', () => {
        for (const callFilter of [{ mode: 'first' }, { mode: 'first', n: 0 }, { mode: 'sometimes', n: 1 }, 'first']) {
            expect(run([mockRule('m', { callFilter })], 3).out).toEqual(['m', 'm', 'm']);
        }
    });

    test('requestBody rules count in their own pass', () => {
        const body = { ...filtered('rb', 'first', 1), type: 'requestBody' };
        const callCounts = Object.create(null);
        expect(findMatchingRequestBodyRule([body], req({ callCounts }))).toBe(body);
        expect(findMatchingRequestBodyRule([body], req({ callCounts }))).toBeNull();
    });
});

describe('PER-66: call filters in the interceptor', () => {
    const fail500 = (match = {}) => mockRule('fail', { callFilter: { mode: 'first', n: 1 }, ...match },
        { statusCode: 500, statusText: 'Internal Server Error', body: { failed: true } });

    test('fetch: "fail once, then succeed" gives [500, 200]', async () => {
        const h = withRules([fail500()]);
        const statuses = [];
        for (let i = 0; i < 3; i++) statuses.push((await pageFetch(h, 'https://example.test/api/x')).status);
        expect(statuses).toEqual([500, 200, 200]);
    });

    test('fetch: every:2 gives real, mock, real, mock — counted once per call, relative URL included', async () => {
        const h = withRules([mockRule('even', { url: '/api/x*', callFilter: { mode: 'every', n: 2 } })]);
        const seen = [];
        for (let i = 0; i < 4; i++) seen.push((await pageFetch(h, '/api/x')).marker === 'true' ? 'mock' : 'real');
        expect(seen).toEqual(['real', 'mock', 'real', 'mock']);
    });

    test('XHR: fail once, then succeed; every:2 alternates', async () => {
        const once = withRules([fail500()]);
        expect([(await sendXHR(once)).status, (await sendXHR(once)).status]).toEqual([500, 200]);
        const even = withRules([mockRule('even', { callFilter: { mode: 'every', n: 2 } })]);
        const seen = [];
        for (let i = 0; i < 4; i++) seen.push((await sendXHR(even)).marker === 'true' ? 'mock' : 'real');
        expect(seen).toEqual(['real', 'mock', 'real', 'mock']);
    });

    test('fetch and XHR share one count per rule', async () => {
        const h = withRules([fail500()]);
        expect((await sendXHR(h)).status).toBe(500);
        expect((await pageFetch(h, 'https://example.test/api/x')).status).toBe(200);
    });

    test('XHR: a call-filtered redirect is decided at send(), and counted once', async () => {
        const h = withRules([{
            id: 'r', name: 'r', enabled: true, type: 'redirect',
            match: { url: '*/api/*', method: '*', callFilter: { mode: 'first', n: 1 } },
            redirect: { destination: 'https://example.test/elsewhere' }
        }]);
        await sendXHR(h);
        await sendXHR(h);
        expect(h.xhrCalls.map((c) => c.url)).toEqual(['https://example.test/elsewhere', 'https://example.test/api/x']);
    });

    test('XHR: a call-filtered mock above a redirect hands later calls to the redirect', async () => {
        const h = withRules([
            fail500(),
            { id: 'r', name: 'r', enabled: true, type: 'redirect', match: { url: '*/api/*', method: '*' }, redirect: { destination: 'https://example.test/elsewhere' } }
        ]);
        expect((await sendXHR(h)).status).toBe(500);
        await sendXHR(h);
        expect(h.xhrCalls.map((c) => c.url)).toEqual(['https://example.test/elsewhere']);
    });

    test('requestBody: a filtered body rule rewrites only the calls it qualifies for', async () => {
        const h = withRules([{
            id: 'rb', name: 'rb', enabled: true, type: 'requestBody',
            match: { url: '*/api/*', method: '*', callFilter: { mode: 'after', n: 1 } },
            requestBody: { mode: 'static', body: 'rewritten' }
        }]);
        await pageFetch(h, 'https://example.test/api/x', { method: 'POST', body: 'one' });
        await pageFetch(h, 'https://example.test/api/x', { method: 'POST', body: 'two' });
        await sendXHR(h, { body: 'three' });
        const fetched = await Promise.all(h.passthroughCalls.map(([resource, init]) => new Request(resource, init).text()));
        expect(fetched).toEqual(['one', 'rewritten']);
        expect(h.xhrCalls.map((c) => c.body)).toEqual(['rewritten']);
    });

    test('a changed rule set resets the counts; a settings-only or hit-count sync does not', async () => {
        const rule = fail500();
        const h = withRules([rule]);
        expect((await pageFetch(h, 'https://example.test/api/x')).status).toBe(500);
        h.syncState({ rules: [{ ...rule, hitCount: 7 }], settings: { debugMode: false } });
        expect((await pageFetch(h, 'https://example.test/api/x')).status).toBe(200);
        h.syncState({ rules: [{ ...rule, name: 'renamed' }] });
        expect((await pageFetch(h, 'https://example.test/api/x')).status).toBe(500);
        expect((await pageFetch(h, 'https://example.test/api/x')).status).toBe(200);
        h.syncState({ rules: [rule, mockRule('other', { url: '*/other*' })] });
        expect((await pageFetch(h, 'https://example.test/api/x')).status).toBe(500);
    });

    test('the counts are not on the page (contract B)', async () => {
        const h = withRules([fail500()]);
        const before = Object.getOwnPropertyNames(h.window).sort();
        await pageFetch(h, 'https://example.test/api/x');
        expect(Object.getOwnPropertyNames(h.window).sort()).toEqual(before);
    });
});
