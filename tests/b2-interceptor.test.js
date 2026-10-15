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
