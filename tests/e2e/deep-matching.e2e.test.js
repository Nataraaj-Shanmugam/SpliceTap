/**
 * Deep feature test — matching. Every matching claim the README makes,
 * checked in a real page, plus the matching scenarios a Requestly user brings
 * (source conditions, payload filters, cross-origin targets).
 */

const { launch, pageFetch, pageXHR, waitFor } = require('./harness');

const mock = (id, match, extra = {}) => ({
    id,
    name: `Rule ${id}`,
    enabled: true,
    type: 'mock',
    match,
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { hit: id }, delay: 0, mode: 'static' },
    ...extra
});

// Always-present control rule, so a "not matched" result is meaningful: once
// it answers, rules have reached the page.
const control = mock('control', { url: '*/api/control*', method: 'GET' });

describe('deep: matching', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    async function withRules(...rules) {
        await h.reset();
        for (const r of [control, ...rules]) await h.saveRule(r);
        page = await h.openPage();
        await waitFor(async () => (await pageFetch(page, '/api/control')).marker === 'true', { label: 'rules on page' });
        return page;
    }
    const hit = async (path, init) => {
        const r = await pageFetch(page, path, init);
        return r.body && r.body.hit ? r.body.hit : (r.ok ? 'real' : 'failed');
    };

    // ---- URL pattern semantics (README "Matching & Precedence") -------------

    test('wildcard is an anchored full match', async () => {
        await withRules(mock('w', { url: '*/api/*/profile', method: 'GET' }));
        expect(await hit('/api/v1/profile')).toBe('w');
        expect(await hit('/api/v2/profile')).toBe('w');
        expect(await hit('/api/v1/profile/extra')).toBe('real');
    });

    test('a bare "*" matches everything', async () => {
        await withRules(mock('all', { url: '*', method: 'GET' }));
        expect(await hit('/anything/at/all?x=1')).toBe('all');
    });

    test('a /regex/ pattern matches as a regular expression', async () => {
        await withRules(mock('re', { url: '/\\/api\\/users\\/\\d+\\/?$/', method: 'GET' }));
        expect(await hit('/api/users/123')).toBe('re');
        expect(await hit('/api/users/abc')).toBe('real');
    });

    test('a regex with alternation matches either branch', async () => {
        await withRules(mock('alt', { url: '/\\/api\\/(users|accounts)\\//', method: 'GET' }));
        expect(await hit('/api/users/1')).toBe('alt');
        expect(await hit('/api/accounts/1')).toBe('alt');
        expect(await hit('/api/orders/1')).toBe('real');
    });

    test('a pattern without * or slashes is a substring match', async () => {
        await withRules(mock('sub', { url: 'api/plain', method: 'GET' }));
        expect(await hit('/v2/api/plain/thing?q=1')).toBe('sub');
    });

    test('matching is case-insensitive', async () => {
        await withRules(mock('ci', { url: '*/API/Users*', method: 'GET' }));
        expect(await hit('/api/users/1')).toBe('ci');
    });

    test('query strings and fragments are part of the URL matched', async () => {
        await withRules(mock('qs', { url: '*/api/search?q=shoes*', method: 'GET' }));
        expect(await hit('/api/search?q=shoes&page=2')).toBe('qs');
        expect(await hit('/api/search?q=hats')).toBe('real');
    });

    // ---- method ----------------------------------------------------------------

    test('method "*" matches every method', async () => {
        await withRules(mock('any', { url: '*/api/any*', method: '*' }));
        for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
            expect(await hit('/api/any', { method })).toBe('any');
        }
    });

    test('a specific method matches only that method', async () => {
        await withRules(mock('post', { url: '*/api/write*', method: 'POST' }));
        expect(await hit('/api/write', { method: 'POST' })).toBe('post');
        expect(await hit('/api/write', { method: 'PUT' })).toBe('real');
    });

    // ---- header conditions -----------------------------------------------------

    test('header condition: name case-insensitive, value by substring', async () => {
        await withRules(mock('hdr', { url: '*/api/h*', method: 'GET', headers: { 'x-env': 'dev' } }));
        expect(await hit('/api/h', { headers: { 'X-ENV': 'development' } })).toBe('hdr');
        expect(await hit('/api/h', { headers: { 'X-Env': 'production' } })).toBe('real');
        expect(await hit('/api/h')).toBe('real');
    });

    test('every header condition must match', async () => {
        await withRules(mock('both', { url: '*/api/h*', method: 'GET', headers: { 'X-A': '1', 'X-B': '2' } }));
        expect(await hit('/api/h', { headers: { 'X-A': '1' } })).toBe('real');
        expect(await hit('/api/h', { headers: { 'X-A': '1', 'X-B': '2' } })).toBe('both');
    });

    test('header conditions read headers set on a Request object and a Headers instance', async () => {
        await withRules(mock('obj', { url: '*/api/h*', method: 'GET', headers: { 'X-Env': 'dev' } }));
        const viaRequest = await page.evaluate(async () => {
            const r = await fetch(new Request('/api/h', { headers: { 'X-Env': 'dev' } }));
            return (await r.json()).hit;
        });
        const viaHeaders = await page.evaluate(async () => {
            const r = await fetch('/api/h', { headers: new Headers([['X-Env', 'dev']]) });
            return (await r.json()).hit;
        });
        expect(viaRequest).toBe('obj');
        expect(viaHeaders).toBe('obj');
    });

    test('header conditions work for XHR too', async () => {
        await withRules(mock('xhrh', { url: '*/api/h*', method: 'GET', headers: { 'X-Env': 'dev' } }));
        expect((await pageXHR(page, '/api/h', { headers: { 'X-Env': 'dev' } })).body).toEqual({ hit: 'xhrh' });
        expect((await pageXHR(page, '/api/h', { headers: { 'X-Env': 'prod' } })).body.real).toBe(true);
    });

    // ---- GraphQL (Requestly: "payload key operationName") -----------------------

    const gql = (op) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationName: op, query: `query ${op} { x }`, variables: {} })
    });

    test('GraphQL operationName matches over fetch', async () => {
        await withRules(mock('gq', { url: '*/graphql*', method: 'POST', graphql: { operationName: 'GetUser' } }));
        expect(await hit('/graphql', gql('GetUser'))).toBe('gq');
        expect(await hit('/graphql', gql('GetOrders'))).toBe('real');
    });

    test('GraphQL operationName matches over XHR', async () => {
        await withRules(mock('gqx', { url: '*/graphql*', method: 'POST', graphql: { operationName: 'GetUser' } }));
        const r = await pageXHR(page, '/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operationName: 'GetUser', query: '{x}' })
        });
        expect(r.body).toEqual({ hit: 'gqx' });
    });

    test('GraphQL operationName matches a body sent as a Request object', async () => {
        await withRules(mock('gqr', { url: '*/graphql*', method: 'POST', graphql: { operationName: 'GetUser' } }));
        const result = await page.evaluate(async () => {
            const r = await fetch(new Request('/graphql', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ operationName: 'GetUser', query: '{x}' })
            }));
            return r.json();
        });
        expect(result).toEqual({ hit: 'gqr' });
    });

    test('GraphQL: two rules on one endpoint answer different operations', async () => {
        await withRules(
            mock('users', { url: '*/graphql*', method: 'POST', graphql: { operationName: 'GetUsers' } }),
            mock('orders', { url: '*/graphql*', method: 'POST', graphql: { operationName: 'GetOrders' } })
        );
        expect(await hit('/graphql', gql('GetUsers'))).toBe('users');
        expect(await hit('/graphql', gql('GetOrders'))).toBe('orders');
    });

    test('GraphQL: the real request still carries its body to the server when unmatched', async () => {
        await withRules(mock('gq', { url: '*/graphql*', method: 'POST', graphql: { operationName: 'GetUser' } }));
        h.requests.length = 0;
        const r = await pageFetch(page, '/graphql', gql('Other'));
        // Reading the body to match it must not consume it.
        expect(JSON.parse(r.body.received).operationName).toBe('Other');
    });

    // ---- precedence --------------------------------------------------------------

    test('the first enabled matching rule wins; a disabled one is skipped', async () => {
        await withRules(
            mock('first', { url: '*/api/p*', method: 'GET' }, { enabled: false }),
            mock('second', { url: '*/api/p*', method: 'GET' }),
            mock('third', { url: '*/api/p*', method: 'GET' })
        );
        expect(await hit('/api/p')).toBe('second');
    });

    test('reordering rules changes which one answers', async () => {
        await withRules(mock('a', { url: '*/api/p*', method: 'GET' }), mock('b', { url: '*/api/p*', method: 'GET' }));
        expect(await hit('/api/p')).toBe('a');
        const rules = (await h.bg({ type: 'getRules' })).rules;
        const reordered = [rules[0], rules[2], rules[1]]; // control, b, a
        await h.bg({ type: 'setRules', rules: reordered });
        await waitFor(async () => (await hit('/api/p')) === 'b', { label: 'new order to apply' });
    });

    // ---- cross-origin targets (third-party APIs) ----------------------------------

    test('mocks a cross-origin API the server never enabled CORS for', async () => {
        // A Requestly staple: mock a third-party endpoint. The test server sends
        // no CORS headers, so the real cross-origin call fails — the mock must
        // answer without ever needing the network.
        await withRules(mock('xo', { url: '*://localhost*/api/third-party*', method: 'GET' }));
        const crossUrl = h.baseUrl.replace('127.0.0.1', 'localhost');
        const realUnmocked = await pageFetch(page, crossUrl + '/api/not-mocked');
        expect(realUnmocked.ok).toBe(false); // proves CORS really blocks the real call
        expect(await hit(crossUrl + '/api/third-party')).toBe('xo');
    });
});
