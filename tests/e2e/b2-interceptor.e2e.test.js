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

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
