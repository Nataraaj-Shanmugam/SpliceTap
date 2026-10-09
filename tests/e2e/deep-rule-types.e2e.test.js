/**
 * Deep feature test — every rule type, its README claims, and the matching
 * Requestly scenario (Cancel, Delay, Redirect / Map Remote, Modify Headers,
 * Modify User Agent, Modify Query Params). Network-level effects are read
 * from the server's side, the only place they are observable.
 */

const { launch, pageFetch, pageXHR, waitFor, sleep } = require('./harness');

const base = (id, type, extra) => ({
    id, name: `Rule ${id}`, enabled: true, type,
    match: { url: '*/api/target*', method: '*' },
    ...extra
});
const control = {
    id: 'control', name: 'Control', enabled: true, type: 'mock',
    match: { url: '*/api/control*', method: 'GET' },
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { control: true }, delay: 0, mode: 'static' }
};

describe('deep: rule types', () => {
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
        h.requests.length = 0;
        return page;
    }
    const served = (path) => h.requests.filter((r) => r.path === path);

    // ---- block (Requestly: Cancel Request) ------------------------------------------

    test('block: fetch rejects with TypeError "Failed to fetch", as the README says', async () => {
        await withRules(base('b', 'block', {}));
        const r = await pageFetch(page, '/api/target');
        expect(r.ok).toBe(false);
        expect(r.name).toBe('TypeError');
        expect(r.error).toBe('Failed to fetch');
        expect(served('/api/target')).toHaveLength(0);
    });

    test('block: XHR fires error with status 0, and loadstart/loadend around it', async () => {
        await withRules(base('b', 'block', {}));
        const events = await page.evaluate(() => new Promise((resolve) => {
            const seen = [];
            const x = new XMLHttpRequest();
            for (const t of ['loadstart', 'load', 'error', 'loadend']) x.addEventListener(t, () => {
                seen.push(t);
                if (t === 'loadend') resolve({ seen, status: x.status });
            });
            x.open('GET', '/api/target');
            x.send();
        }));
        expect(events).toEqual({ seen: ['loadstart', 'error', 'loadend'], status: 0 });
    });

    test('block: a method condition blocks only that method', async () => {
        await withRules(base('b', 'block', { match: { url: '*/api/target*', method: 'POST' } }));
        expect((await pageFetch(page, '/api/target', { method: 'POST' })).ok).toBe(false);
        expect((await pageFetch(page, '/api/target')).ok).toBe(true);
    });

    // ---- delay (Requestly: Delay; its extension caps XHR/fetch at 5000ms) --------------

    test('delay: holds the request, then the real response arrives (fetch and XHR)', async () => {
        await withRules(base('d', 'delay', { delayMs: 800 }));
        const f = await pageFetch(page, '/api/target');
        const x = await pageXHR(page, '/api/target');
        expect(f.body.real).toBe(true);
        expect(x.body.real).toBe(true);
        expect(f.ms).toBeGreaterThanOrEqual(750);
        expect(x.ms).toBeGreaterThanOrEqual(750);
        expect(served('/api/target')).toHaveLength(2);
    });

    test('delay: longer than Requestly\'s 5s extension cap works', async () => {
        await withRules(base('d', 'delay', { delayMs: 6000 }));
        const r = await pageFetch(page, '/api/target');
        expect(r.body.real).toBe(true);
        expect(r.ms).toBeGreaterThanOrEqual(5900);
    }, 20000);

    test('delay: XHR fires loadstart exactly once (when the request leaves)', async () => {
        // Known limitation, recorded in PARITY.md: the native send() after the
        // delay fires loadstart, so it comes late; it cannot also be announced
        // early without a duplicate. What must hold is that it fires once.
        await withRules(base('d', 'delay', { delayMs: 800 }));
        const r = await page.evaluate(() => new Promise((resolve) => {
            const t0 = performance.now();
            const starts = [];
            const x = new XMLHttpRequest();
            x.addEventListener('loadstart', () => starts.push(Math.round(performance.now() - t0)));
            x.addEventListener('loadend', () => resolve({ starts, total: performance.now() - t0 }));
            x.open('GET', '/api/target');
            x.send();
        }));
        expect(r.starts).toHaveLength(1);
        expect(r.total).toBeGreaterThanOrEqual(750);
    });

    // ---- redirect (Requestly: Redirect / Map Remote) ------------------------------------

    test('redirect: a root-relative destination is served (fetch and XHR)', async () => {
        await withRules(base('r', 'redirect', { redirect: { destination: '/redirect-target' } }));
        expect((await pageFetch(page, '/api/target')).body).toEqual({ real: true, redirected: true });
        expect((await pageXHR(page, '/api/target')).body).toEqual({ real: true, redirected: true });
    });

    test('redirect: an absolute URL destination is served', async () => {
        await withRules(base('r', 'redirect', { redirect: { destination: h.baseUrl + '/redirect-target' } }));
        expect((await pageFetch(page, '/api/target')).body).toEqual({ real: true, redirected: true });
    });

    test('redirect: regex capture groups $1 and $2 are substituted', async () => {
        await withRules(base('r', 'redirect', {
            match: { url: '/\\/api\\/target\\/(\\w+)\\/(\\w+)/', method: '*' },
            redirect: { destination: '/echo?first=$1&second=$2' }
        }));
        const r = await pageFetch(page, '/api/target/alpha/beta');
        expect(r.body.query).toEqual({ first: 'alpha', second: 'beta' });
        const x = await pageXHR(page, '/api/target/gamma/delta');
        expect(x.body.query).toEqual({ first: 'gamma', second: 'delta' });
    });

    test('redirect: a POST keeps its method, body and headers', async () => {
        await withRules(base('r', 'redirect', { redirect: { destination: '/graphql' } }));
        const r = await pageFetch(page, '/api/target', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Keep': 'yes' }, body: '{"payload":1}'
        });
        expect(r.body.received).toBe('{"payload":1}');
        const hit = served('/graphql')[0];
        expect(hit.method).toBe('POST');
        expect(hit.headers['x-keep']).toBe('yes');
    });

    // ---- modify headers (Requestly: Modify Headers) ---------------------------------------

    const headersRule = (request, response, extra = {}) => base('hd', 'headers', {
        match: { url: '*/echo*', method: '*' }, headersMod: { request, response }, ...extra
    });

    test('headers: set and remove request headers, as the server sees them', async () => {
        await withRules(headersRule(
            [{ op: 'set', name: 'X-Added', value: 'yes' }, { op: 'remove', name: 'X-Remove-Me' }], []
        ));
        const seen = await waitFor(async () => {
            const b = (await pageFetch(page, '/echo', { headers: { 'X-Remove-Me': 'still-here' } })).body;
            return b.headers['x-added'] === 'yes' ? b : null;
        }, { label: 'header rule active' });
        expect(seen.headers['x-remove-me']).toBeUndefined();
    });

    test('headers: set and remove response headers, as the page sees them', async () => {
        await withRules(base('hd', 'headers', {
            match: { url: '*/api/target*', method: '*' },
            headersMod: { request: [], response: [{ op: 'set', name: 'X-Injected', value: 'yes' }, { op: 'remove', name: 'X-Origin-Server' }] }
        }));
        const r = await waitFor(async () => page.evaluate(async () => {
            const res = await fetch('/api/target');
            const injected = res.headers.get('x-injected');
            return injected ? { injected, origin: res.headers.get('x-origin-server') } : null;
        }), { label: 'response header rule' });
        expect(r).toEqual({ injected: 'yes', origin: null });
    });

    test('headers: applies to XHR as well as fetch', async () => {
        await withRules(headersRule([{ op: 'set', name: 'X-Added', value: 'xhr' }], []));
        const seen = await waitFor(async () => {
            const b = (await pageXHR(page, '/echo')).body;
            return b.headers['x-added'] === 'xhr' ? b : null;
        }, { label: 'xhr header' });
        expect(seen.headers['x-added']).toBe('xhr');
    });

    test('headers: a method condition limits the rule to that method', async () => {
        await withRules(headersRule([{ op: 'set', name: 'X-Added', value: 'post-only' }], [], {
            match: { url: '*/echo*', method: 'POST' }
        }));
        await waitFor(async () => (await pageFetch(page, '/echo', { method: 'POST' })).body.headers['x-added'] === 'post-only', { label: 'POST header' });
        expect((await pageFetch(page, '/echo')).body.headers['x-added']).toBeUndefined();
    });

    test('headers: a /regex/ URL pattern works at the network layer', async () => {
        await withRules(headersRule([{ op: 'set', name: 'X-Regex', value: 'yes' }], [], {
            match: { url: '/\\/echo\\?v=\\d+/', method: '*' }
        }));
        await waitFor(async () => (await pageFetch(page, '/echo?v=42')).body.headers['x-regex'] === 'yes', { label: 'regex rule' });
        expect((await pageFetch(page, '/echo?v=abc')).body.headers['x-regex']).toBeUndefined();
    });

    test('headers: User-Agent override reaches the server (Requestly: Modify User Agent)', async () => {
        await withRules(headersRule([{ op: 'set', name: 'User-Agent', value: 'SpliceTap-Test-UA/1.0' }], []));
        const seen = await waitFor(async () => {
            const b = (await pageFetch(page, '/echo')).body;
            return b.headers['user-agent'] === 'SpliceTap-Test-UA/1.0' ? b : null;
        }, { label: 'UA override' });
        expect(seen.headers['user-agent']).toBe('SpliceTap-Test-UA/1.0');
    });

    test('headers: page navigations are not touched — only XHR/fetch (C-11 blast radius)', async () => {
        await withRules(headersRule([{ op: 'set', name: 'X-Added', value: 'yes' }], [], {
            match: { url: '*/page*', method: '*' }
        }));
        await sleep(200);
        h.requests.length = 0;
        await page.reload({ waitUntil: 'load' });
        const nav = h.requests.find((r) => r.path === '/page');
        expect(nav.headers['x-added']).toBeUndefined();
    });

    // ---- query params (Requestly: Modify Query Params) ------------------------------------

    const qpRule = (queryParams) => base('qp', 'queryparams', { match: { url: '*/echo*', method: '*' }, queryParams });

    test('query params: add, replace an existing value, and remove', async () => {
        await withRules(qpRule({ add: [{ key: 'added', value: '1' }, { key: 'mode', value: 'test' }], remove: ['drop'] }));
        const q = await waitFor(async () => {
            const b = (await pageFetch(page, '/echo?mode=prod&drop=me&keep=yes')).body;
            return b.query.added === '1' ? b.query : null;
        }, { label: 'query rule' });
        expect(q).toEqual({ mode: 'test', keep: 'yes', added: '1' });
    });

    test('query params: applies to XHR too', async () => {
        await withRules(qpRule({ add: [{ key: 'via', value: 'xhr' }], remove: [] }));
        await waitFor(async () => (await pageXHR(page, '/echo')).body.query.via === 'xhr', { label: 'xhr query' });
    });

    // ---- chaos mode (no Requestly equivalent) ------------------------------------------------

    test('chaos mode at 100% fails every request, and stops when switched off', async () => {
        await withRules();
        await h.bg({ type: 'settingsUpdated', settings: { chaosMode: { enabled: true, failureRate: 1 } } });
        await waitFor(async () => !(await pageFetch(page, '/api/anything')).ok, { label: 'chaos active' });
        expect((await pageXHR(page, '/api/anything')).outcome).toBe('error');

        await h.bg({ type: 'settingsUpdated', settings: { chaosMode: { enabled: false, failureRate: 1 } } });
        await waitFor(async () => (await pageFetch(page, '/api/anything')).ok, { label: 'chaos off' });
    });

    test('chaos mode at 50% fails roughly half of requests', async () => {
        await withRules();
        await h.bg({ type: 'settingsUpdated', settings: { chaosMode: { enabled: true, failureRate: 0.5 } } });
        await sleep(200);
        const results = await page.evaluate(() => Promise.all(Array.from({ length: 200 }, () =>
            fetch('/api/anything').then(() => true, () => false))));
        const failed = results.filter((ok) => !ok).length;
        expect(failed).toBeGreaterThan(60);
        expect(failed).toBeLessThan(140);
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});

describe('deep: every template does what its label says', () => {
    // Templates are presented as the fast path to a first rule (PROD-3), so
    // each is saved exactly as the editor would produce it and then used for
    // its stated purpose — against the test server, which runs on a port, as
    // nearly every local API does.
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    const templates = require('../../src/templates.js');

    /** Turn a template into the rule the editor saves from it. */
    function ruleFrom(id, overrides = {}) {
        const t = templates.getTemplate(id);
        const label = templates.listTemplates().find((x) => x.id === id).label;
        const rule = {
            id: 'tpl-' + id, name: label, enabled: true, type: t.type,
            match: { url: t.url, method: t.method }
        };
        if (t.graphqlOperation) rule.match.graphql = { operationName: t.graphqlOperation };
        if (t.type === 'mock') {
            rule.response = { statusCode: t.status || 200, headers: { 'Content-Type': 'application/json' }, delay: 0, mode: t.mode || 'static' };
            if (t.mode === 'patch') rule.response.patch = JSON.parse(t.patch);
            else rule.response.body = JSON.parse(t.body);
        }
        if (t.type === 'delay') rule.delayMs = t.delayMs;
        if (t.type === 'redirect') rule.redirect = { destination: t.redirectDestination };
        if (t.type === 'headers') rule.headersMod = { request: t.headersModRequest || [], response: t.headersModResponse || [] };
        return Object.assign(rule, overrides);
    }

    async function withTemplate(id, overrides) {
        await h.reset();
        const response = await h.bg({ type: 'saveRule', rule: ruleFrom(id, overrides) });
        expect(response.success).toBe(true);
        page = await h.openPage();
        await sleep(300);
        return page;
    }

    test('GraphQL Mock answers the getUsers operation', async () => {
        await withTemplate('graphqlMock');
        const r = await pageFetch(page, '/graphql', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operationName: 'getUsers', query: '{users{id}}' })
        });
        expect(r.body).toEqual({ data: {} });
    });

    test('Patch Response nulls `data` on a real response', async () => {
        await withTemplate('patchResponse');
        const r = await pageFetch(page, '/api/thing');
        expect(r.body.real).toBe(true);
        expect('data' in r.body).toBe(false);
    });

    test('Block Request fails an /api/ call', async () => {
        await withTemplate('blockRequest');
        expect((await pageFetch(page, '/api/thing')).ok).toBe(false);
    });

    test('Slow Request holds an /api/ call for about 2 seconds', async () => {
        await withTemplate('delayRequest');
        const r = await pageFetch(page, '/api/thing');
        expect(r.ms).toBeGreaterThanOrEqual(1900);
        expect(r.body.real).toBe(true);
    });

    test('Redirect to localhost rewrites an /api/ call to localhost:3000 with the path kept', async () => {
        // Nothing listens on :3000 in the test, so assert on the rewrite itself:
        // the request must leave for localhost:3000/api/... — observed as a
        // network failure rather than our server answering.
        await withTemplate('redirectLocalhost');
        h.requests.length = 0;
        const r = await pageFetch(page, '/api/users/7');
        expect(h.requests.some((x) => x.path === '/api/users/7')).toBe(false);
        expect(r.ok).toBe(false);
    });

    test('CORS Unblock lets a page call a localhost API on a port', async () => {
        // The canonical use: an app on one origin calling a local API on
        // another, e.g. localhost:3000, which sends no CORS headers.
        await withTemplate('corsUnblock');
        const crossOrigin = h.baseUrl.replace('127.0.0.1', 'localhost') + '/api/thing';
        const r = await waitFor(async () => {
            const res = await pageFetch(page, crossOrigin);
            return res.ok ? res : null;
        }, { label: 'cross-origin call to succeed', timeout: 4000 }).catch(() => pageFetch(page, crossOrigin));
        expect(r.ok).toBe(true);
        expect(r.body.real).toBe(true);
    });

    test('Custom User-Agent reaches a localhost API on a port', async () => {
        await withTemplate('customUserAgent');
        const echo = h.baseUrl.replace('127.0.0.1', 'localhost') + '/echo';
        // Same-origin from a localhost page, so CORS is not in the way.
        await page.goto(echo.replace('/echo', '/page'), { waitUntil: 'load' });
        await sleep(300);
        const r = await pageFetch(page, '/echo');
        expect(r.body.headers['user-agent']).toBe('Mozilla/5.0 (SpliceTap)');
    });
});
