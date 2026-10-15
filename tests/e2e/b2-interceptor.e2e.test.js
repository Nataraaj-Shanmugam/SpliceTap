/**
 * Batch 2, group G2 "interceptor", in a real browser: F7 in-page targeting
 * (page domains, including about:blank and srcdoc frames; resource types;
 * payload), F8 patch-mode status and PER-66 call filters.
 *
 * Pages on other hosts come from the same harness server: Chrome resolves
 * `localhost` and every `*.localhost` name to the loopback address.
 */

const { launch, pageFetch, pageXHR, waitFor } = require('./harness');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const mock = (id, url, match = {}, response = {}) => ({
    id, name: id, enabled: true, type: 'mock', match: { url, method: '*', ...match },
    response: { statusCode: 200, headers: JSON_HEADERS, body: { mocked: id }, delay: 0, mode: 'static', ...response }
});
const control = mock('control', '*/api/control*');

describe('b2-interceptor: in-page targeting, patch status and call filters', () => {
    let h;
    let page;
    let port;

    beforeAll(async () => {
        h = await launch();
        port = new URL(h.baseUrl).port;
    });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => {
        if (page && !page.isClosed()) await page.close();
        page = null;
    });

    /** Replace every rule (plus a control rule that runs everywhere). */
    async function setRules(rules) {
        await h.reset();
        const response = await h.bg({ type: 'setRules', rules: [control, ...rules] });
        expect(response && response.success).toBe(true);
    }

    /** Open `url` (a harness path, or a full URL) once the control rule is live there. */
    async function open(url = '/page') {
        page = await h.browser.newPage();
        page.on('pageerror', (e) => h.record({ where: 'page', text: 'pageerror: ' + e.message }));
        page.on('console', (msg) => {
            if (msg.type() === 'error' && !/^Failed to load resource/.test(msg.text())) h.record({ where: 'page', text: msg.text() });
        });
        await page.goto(url.startsWith('http') ? url : h.baseUrl + url, { waitUntil: 'load' });
        await waitFor(async () => (await pageFetch(page, '/api/control')).marker === 'true', { label: 'rules on page' });
        return page;
    }

    const pageErrors = () => h.errors.filter((e) => e.where === 'page');

    // --- F7: page domains --------------------------------------------------

    describe('B2-F7: page domains', () => {
        test('a rule runs only on pages of its domains, subdomains included', async () => {
            await setRules([mock('local', '*/api/pd*', { pageDomains: ['localhost'] })]);

            await open('/page'); // 127.0.0.1
            const onIp = await pageFetch(page, '/api/pd');
            const onIpXhr = await pageXHR(page, '/api/pd');
            await page.close();

            await open(`http://localhost:${port}/page`);
            const onHost = await pageFetch(page, '/api/pd');
            const onHostXhr = await pageXHR(page, '/api/pd');
            await page.close();

            await open(`http://app.localhost:${port}/page`);
            const onSub = await pageFetch(page, '/api/pd');

            expect(onIp.body.real).toBe(true);
            expect(onIpXhr.body.real).toBe(true);
            expect(onHost.body).toEqual({ mocked: 'local' });
            expect(onHostXhr.body).toEqual({ mocked: 'local' });
            expect(onSub.body).toEqual({ mocked: 'local' });
            expect(pageErrors()).toEqual([]);
        });

        test('the domain is the requesting page, not the request: a cross-host call is still matched', async () => {
            await setRules([mock('from-ip', '*/api/pd-cross*', { pageDomains: ['127.0.0.1'] })]);
            await open('/page');
            // The page is on 127.0.0.1; the request goes to localhost.
            const r = await pageFetch(page, `http://localhost:${port}/api/pd-cross`);
            expect(r.body).toEqual({ mocked: 'from-ip' });
        });

        test("about:blank and srcdoc frames use their creator's host", async () => {
            await setRules([
                mock('ip-only', '*/api/pd-frame*', { pageDomains: ['127.0.0.1'] }),
                mock('host-only', '*/api/pd-other*', { pageDomains: ['localhost'] })
            ]);
            await open('/page');
            await page.evaluate(() => {
                const blank = document.createElement('iframe');
                blank.id = 'blank';
                document.body.appendChild(blank);
                const srcdoc = document.createElement('iframe');
                srcdoc.id = 'srcdoc';
                srcdoc.srcdoc = '<p>inline</p>';
                document.body.appendChild(srcdoc);
            });
            const frameFetch = (id, path) => page.evaluate(async (frameId, p) => {
                const w = document.getElementById(frameId).contentWindow;
                const res = await w.fetch(p);
                return { marker: res.headers.get('x-splicetap'), body: await res.json(), href: w.location.href };
            }, id, path);

            const blank = await waitFor(async () => {
                const r = await frameFetch('blank', '/api/pd-frame');
                return r.marker === 'true' ? r : null;
            }, { label: 'about:blank frame mocked' });
            const srcdoc = await waitFor(async () => {
                const r = await frameFetch('srcdoc', '/api/pd-frame');
                return r.marker === 'true' && r.href === 'about:srcdoc' ? r : null;
            }, { label: 'srcdoc frame mocked' });

            expect(blank).toEqual(expect.objectContaining({ href: 'about:blank', body: { mocked: 'ip-only' } }));
            expect(srcdoc.body).toEqual({ mocked: 'ip-only' });
            // Not the frames' own (empty) host either: a rule for another site stays out.
            expect((await frameFetch('blank', '/api/pd-other')).body.real).toBe(true);
            expect((await frameFetch('srcdoc', '/api/pd-other')).body.real).toBe(true);
            expect(pageErrors()).toEqual([]);
        });
    });

    // --- F7: resource types -------------------------------------------------

    describe('B2-F7: resource types', () => {
        const allBlock = (id, url, resourceTypes) => ({
            id, name: id, enabled: true, type: 'block', appliesTo: 'all',
            match: { url, method: '*', ...(resourceTypes ? { resourceTypes } : {}) }
        });

        test("an appliesTo:'all' block reaches fetch and XHR only when 'fetch-xhr' is listed, or nothing is", async () => {
            await setRules([
                allBlock('scripts', '*/api/rt-scripts*', ['script']),
                allBlock('calls', '*/api/rt-calls*', ['fetch-xhr', 'image']),
                allBlock('any', '*/api/rt-any*')
            ]);
            await open('/page');

            const scripts = await pageFetch(page, '/api/rt-scripts');
            const scriptsXhr = await pageXHR(page, '/api/rt-scripts');
            const calls = await pageFetch(page, '/api/rt-calls');
            const callsXhr = await pageXHR(page, '/api/rt-calls');
            const any = await pageFetch(page, '/api/rt-any');

            expect(scripts.body.real).toBe(true);
            expect(scriptsXhr.body.real).toBe(true);
            expect(calls).toEqual(expect.objectContaining({ ok: false, error: 'Failed to fetch' }));
            expect(callsXhr.outcome).toBe('error');
            expect(any.ok).toBe(false);
        });
    });

    // --- F7: payload ---------------------------------------------------------

    describe('B2-F7: payload', () => {
        test('fetch and XHR are matched on a value in the JSON body', async () => {
            await setRules([mock('vip', '*/api/order*', { payload: { path: 'user.tier', operator: 'equals', value: 'gold' } })]);
            await open('/page');

            const post = (body) => pageFetch(page, '/api/order', { method: 'POST', headers: JSON_HEADERS, body });
            const gold = await post(JSON.stringify({ user: { tier: 'gold' } }));
            const basic = await post(JSON.stringify({ user: { tier: 'basic' } }));
            const notJson = await post('tier=gold');
            const xhrGold = await pageXHR(page, '/api/order', { method: 'POST', body: JSON.stringify({ user: { tier: 'gold' } }) });
            const xhrBasic = await pageXHR(page, '/api/order', { method: 'POST', body: JSON.stringify({ user: { tier: 'basic' } }) });

            expect(gold.body).toEqual({ mocked: 'vip' });
            expect(basic.body.real).toBe(true);
            expect(notJson.body.real).toBe(true);
            expect(xhrGold.body).toEqual({ mocked: 'vip' });
            expect(xhrBasic.body.real).toBe(true);
            expect(pageErrors()).toEqual([]);
        });

        test('contains, with an array index in the path', async () => {
            await setRules([mock('pro', '*/api/cart*', { payload: { path: 'items.0.sku', operator: 'contains', value: 'PRO' } })]);
            await open('/page');
            const pro = await pageFetch(page, '/api/cart', { method: 'PUT', body: JSON.stringify({ items: [{ sku: 'X-PRO-1' }] }) });
            const lite = await pageFetch(page, '/api/cart', { method: 'PUT', body: JSON.stringify({ items: [{ sku: 'LITE' }, { sku: 'PRO' }] }) });
            expect(pro.body).toEqual({ mocked: 'pro' });
            expect(lite.body.real).toBe(true);
        });
    });

    // --- F8: patch-mode status ---------------------------------------------

    describe('B2-F8: patch-mode status', () => {
        const patch = (id, url, response) => mock(id, url, {}, { mode: 'patch', patch: { patched: true }, ...response });

        test('fetch and XHR receive the override status and reason phrase, with the real body patched', async () => {
            await setRules([patch('ps', '*/api/status-keep*', { patchStatus: 503 })]);
            await open('/page');
            const f = await pageFetch(page, '/api/status-keep');
            const x = await pageXHR(page, '/api/status-keep');

            expect(f).toEqual(expect.objectContaining({ ok: true, status: 503, statusText: 'Service Unavailable', marker: 'true' }));
            expect(f.body).toEqual(expect.objectContaining({ real: true, path: '/api/status-keep', patched: true }));
            expect(x).toEqual(expect.objectContaining({ status: 503, statusText: 'Service Unavailable', marker: 'true' }));
            expect(x.body).toEqual(expect.objectContaining({ real: true, patched: true }));
            expect(pageErrors()).toEqual([]);
        });

        test('a real 404 can be turned into a 200; a text response keeps its body and gets the status', async () => {
            await setRules([
                patch('found', '*/api/missing*', { patchStatus: 200, patch: { found: true } }),
                patch('text', '*/text/plain*', { patchStatus: 500 })
            ]);
            await open('/page');
            const found = await pageFetch(page, '/api/missing');
            const foundXhr = await pageXHR(page, '/api/missing');
            const text = await pageFetch(page, '/text/plain');
            const textXhr = await pageXHR(page, '/text/plain');

            expect(found).toEqual(expect.objectContaining({ status: 200, statusText: 'OK', body: { error: 'missing', found: true } }));
            expect(foundXhr).toEqual(expect.objectContaining({ status: 200, statusText: 'OK', body: { error: 'missing', found: true } }));
            expect(text).toEqual(expect.objectContaining({ status: 500, statusText: 'Internal Server Error', body: 'plain real text' }));
            expect(textXhr).toEqual(expect.objectContaining({ status: 500, statusText: 'Internal Server Error', body: 'plain real text' }));
        });

        test('without patchStatus the real status is kept', async () => {
            await setRules([patch('keep', '*/api/missing*', {})]);
            await open('/page');
            const r = await pageFetch(page, '/api/missing');
            expect(r).toEqual(expect.objectContaining({ status: 404, body: { error: 'missing', patched: true } }));
        });
    });

    // --- PER-66: call filters -----------------------------------------------

    describe('PER-66: call filters', () => {
        const fail = (id, url, callFilter) => mock(id, url, { callFilter },
            { statusCode: 500, statusText: 'Internal Server Error', body: { failed: true } });

        test('fail once, then succeed: a 500 mock with first:1 gives [500, 200], on fetch and on XHR', async () => {
            await setRules([fail('once', '*/api/flaky*', { mode: 'first', n: 1 }), fail('once-xhr', '*/api/xflaky*', { mode: 'first', n: 1 })]);
            await open('/page');
            const fetched = [(await pageFetch(page, '/api/flaky')).status, (await pageFetch(page, '/api/flaky')).status];
            const xhr = [(await pageXHR(page, '/api/xflaky')).status, (await pageXHR(page, '/api/xflaky')).status];
            expect(fetched).toEqual([500, 200]);
            expect(xhr).toEqual([500, 200]);
            expect(pageErrors()).toEqual([]);
        });

        test('every:2 gives real, mock, real, mock', async () => {
            await setRules([mock('even', '*/api/even*', { callFilter: { mode: 'every', n: 2 } })]);
            await open('/page');
            const seen = [];
            for (let i = 0; i < 4; i++) {
                const r = i % 2 ? await pageXHR(page, '/api/even') : await pageFetch(page, '/api/even');
                seen.push(r.marker === 'true' ? 'mock' : 'real');
            }
            expect(seen).toEqual(['real', 'mock', 'real', 'mock']);
        });

        test('after:1 on a request-body rule rewrites from the second call on', async () => {
            await setRules([{
                id: 'rb', name: 'rb', enabled: true, type: 'requestBody',
                match: { url: '*/graphql*', method: '*', callFilter: { mode: 'after', n: 1 } },
                requestBody: { mode: 'static', body: 'rewritten' }
            }]);
            await open('/page');
            const first = await pageFetch(page, '/graphql', { method: 'POST', body: 'original' });
            const second = await pageFetch(page, '/graphql', { method: 'POST', body: 'original' });
            expect([first.body.received, second.body.received]).toEqual(['original', 'rewritten']);
        });

        test('reloading the page starts the count again', async () => {
            await setRules([fail('once', '*/api/flaky*', { mode: 'first', n: 1 })]);
            await open('/page');
            expect((await pageFetch(page, '/api/flaky')).status).toBe(500);
            await page.reload({ waitUntil: 'load' });
            await waitFor(async () => (await pageFetch(page, '/api/control')).marker === 'true', { label: 'rules after reload' });
            expect((await pageFetch(page, '/api/flaky')).status).toBe(500);
            expect((await pageFetch(page, '/api/flaky')).status).toBe(200);
        });
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
