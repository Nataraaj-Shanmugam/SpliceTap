/**
 * The interceptor in a real page: every interceptor-handled rule type, over
 * both fetch and XMLHttpRequest, with the server log as the witness for what
 * did and did not reach the network.
 */

const { launch, pageFetch, pageXHR, waitFor } = require('./harness');

const base = (overrides) => ({
    enabled: true,
    match: { url: '*/api/target*', method: 'GET' },
    ...overrides
});

const mock = (overrides = {}) => base({
    id: 'mock-1',
    name: 'Mock target',
    type: 'mock',
    response: {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: { mocked: true },
        delay: 0,
        mode: 'static'
    },
    ...overrides
});

// A rule on a different path that every test also saves. Once the control
// mock answers, rules have demonstrably reached this page — so a negative
// assertion ("this request was NOT intercepted") means something, instead of
// passing because state had not synced yet.
const control = base({
    id: 'control',
    name: 'Control',
    type: 'mock',
    match: { url: '*/api/control*', method: 'GET' },
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { control: true }, delay: 0, mode: 'static' }
});

describe('interception in a real page', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (page) await page.close(); page = null; });

    /** Save rules, open a page, and wait until the page has them. */
    async function withRules(...rules) {
        await h.reset();
        for (const rule of [control, ...rules]) await h.saveRule(rule);
        page = await h.openPage();
        await waitFor(async () => (await pageFetch(page, '/api/control')).marker === 'true', {
            label: 'rules to reach the page'
        });
        h.requests.length = 0;
        return page;
    }

    const hitServer = (p) => h.requests.some((r) => r.path === p);

    // ---- mock ----------------------------------------------------------

    test('fetch: a mock answers without the request reaching the server', async () => {
        await withRules(mock());
        const r = await pageFetch(page, '/api/target');

        expect(r.body).toEqual({ mocked: true });
        expect(r.marker).toBe('true');
        expect(hitServer('/api/target')).toBe(false);
    });

    test('xhr: a mock answers without the request reaching the server', async () => {
        await withRules(mock());
        const r = await pageXHR(page, '/api/target');

        expect(r.body).toEqual({ mocked: true });
        expect(hitServer('/api/target')).toBe(false);
    });

    test('xhr: onload fires exactly once (Q-1)', async () => {
        await withRules(mock());
        expect((await pageXHR(page, '/api/target')).loads).toBe(1);
    });

    test('xhr: readyState walks the full sequence a real response does', async () => {
        // A real XHR reports 2 (HEADERS_RECEIVED) and 3 (LOADING) before 4.
        // Code that reads headers at readyState 2 depends on that.
        await withRules(mock());
        const mocked = await pageXHR(page, '/api/target');
        const real = await pageXHR(page, '/api/other');

        expect(real.states).toEqual(expect.arrayContaining([2, 3, 4]));
        expect(mocked.states).toEqual(real.states);
    });

    test('the mocked status code and its reason phrase both reach the page', async () => {
        await withRules(mock({
            response: { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: { e: 1 }, delay: 0, mode: 'static' }
        }));

        const viaFetch = await pageFetch(page, '/api/target');
        const viaXhr = await pageXHR(page, '/api/target');

        expect(viaFetch.status).toBe(404);
        expect(viaFetch.statusText).toBe('Not Found');
        expect(viaXhr.status).toBe(404);
        expect(viaXhr.statusText).toBe('Not Found');
    });

    test('a mocked fetch response reports the URL that was requested', async () => {
        // Real responses carry response.url; code that logs it, or follows
        // relative links from it, sees an empty string from a mock otherwise.
        await withRules(mock());
        const r = await pageFetch(page, '/api/target?x=1');

        expect(r.url).toMatch(/\/api\/target\?x=1$/);
    });

    test('a disabled rule passes through', async () => {
        await withRules(mock({ enabled: false }));
        const r = await pageFetch(page, '/api/target');

        expect(r.body.real).toBe(true);
        expect(hitServer('/api/target')).toBe(true);
    });

    test('the master switch stops interception in an open page', async () => {
        await withRules(mock());
        await h.bg({ type: 'toggleExtension', active: false });

        await waitFor(async () => (await pageFetch(page, '/api/target')).body.real === true, {
            label: 'interception to stop'
        });
    });

    test('a rule saved while the page is open applies without a reload', async () => {
        await withRules();
        await h.saveRule(mock());

        const r = await waitFor(async () => {
            const res = await pageFetch(page, '/api/target');
            return res.marker === 'true' ? res : null;
        }, { label: 'the broadcast to reach the open page' });
        expect(r.body).toEqual({ mocked: true });
    });

    // ---- patch ---------------------------------------------------------

    test('patch: merges into the real response (fetch and xhr)', async () => {
        await withRules(mock({
            response: { statusCode: 200, headers: {}, delay: 0, mode: 'patch', patch: { name: 'patched', extra: 1 } }
        }));

        const viaFetch = await pageFetch(page, '/api/target');
        const viaXhr = await pageXHR(page, '/api/target');

        for (const r of [viaFetch, viaXhr]) {
            expect(r.body).toMatchObject({ real: true, id: 1, name: 'patched', extra: 1, keep: true });
        }
    });

    // ---- block / delay / redirect --------------------------------------

    test('block: fetch rejects and nothing reaches the server', async () => {
        await withRules(base({ id: 'block-1', name: 'Block', type: 'block' }));
        const r = await pageFetch(page, '/api/target');

        expect(r.ok).toBe(false);
        expect(r.name).toBe('TypeError');
        expect(hitServer('/api/target')).toBe(false);
    });

    test('block: xhr errors and nothing reaches the server', async () => {
        await withRules(base({ id: 'block-1', name: 'Block', type: 'block' }));
        const r = await pageXHR(page, '/api/target');

        expect(r.outcome).toBe('error');
        expect(hitServer('/api/target')).toBe(false);
    });

    test('delay: holds the real request for the configured time', async () => {
        await withRules(base({ id: 'delay-1', name: 'Delay', type: 'delay', delayMs: 600 }));
        const r = await pageFetch(page, '/api/target');

        expect(r.body.real).toBe(true);
        expect(r.ms).toBeGreaterThanOrEqual(550);
    });

    test('redirect: fetch is served from the destination', async () => {
        const destination = h.baseUrl + '/redirect-target';
        await withRules(base({ id: 'redir-1', name: 'Redirect', type: 'redirect', redirect: { destination } }));
        const r = await pageFetch(page, '/api/target');

        expect(r.body).toEqual({ real: true, redirected: true });
    });

    test('redirect: xhr is served from the destination', async () => {
        const destination = h.baseUrl + '/redirect-target';
        await withRules(base({ id: 'redir-1', name: 'Redirect', type: 'redirect', redirect: { destination } }));
        const r = await pageXHR(page, '/api/target');

        expect(r.body).toEqual({ real: true, redirected: true });
    });

    // ---- match conditions ----------------------------------------------

    test('a header condition only matches requests carrying it', async () => {
        await withRules(mock({ match: { url: '*/api/target*', method: 'GET', headers: { 'X-Env': 'dev' } } }));

        expect((await pageFetch(page, '/api/target', { headers: { 'X-Env': 'prod' } })).body.real).toBe(true);
        expect((await pageFetch(page, '/api/target', { headers: { 'X-Env': 'dev' } })).body).toEqual({ mocked: true });
    });

    test('a GraphQL operation condition matches on operationName', async () => {
        await withRules(mock({ match: { url: '*/graphql*', method: 'POST', graphql: { operationName: 'GetUser' } } }));

        const other = await pageFetch(page, '/graphql', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operationName: 'GetOrders', query: '{orders{id}}' })
        });
        const matched = await pageFetch(page, '/graphql', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operationName: 'GetUser', query: '{user{id}}' })
        });

        expect(other.body.real).toBe(true);
        expect(matched.body).toEqual({ mocked: true });
    });

    test('a block rule with a header condition blocks only matching requests', async () => {
        // Header conditions are valid on block/delay rules, not only mocks —
        // the matcher and the trust boundary both accept them.
        await withRules(base({
            id: 'block-hdr', name: 'Block dev', type: 'block',
            match: { url: '*/api/target*', method: 'GET', headers: { 'X-Env': 'dev' } }
        }));

        expect((await pageFetch(page, '/api/target', { headers: { 'X-Env': 'prod' } })).ok).toBe(true);
        expect((await pageFetch(page, '/api/target', { headers: { 'X-Env': 'dev' } })).ok).toBe(false);
    });

    test('ran without extension errors', async () => {
        await withRules(mock());
        await pageFetch(page, '/api/target');
        expect(h.allErrors).toEqual([]);
    });
});
