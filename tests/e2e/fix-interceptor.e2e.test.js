/**
 * Fix group A1, "interceptor", in a real browser: what only Chrome can show
 * for PERSONA-REVIEW PER-2, 8–13, 20, 32 and 35 (PER-1 is the strengthened
 * channel test in features.e2e.test.js). Network effects are read from the
 * test server's side, where a request's real destination is observable.
 */

const { launch, pageFetch, pageXHR, waitFor, sleep } = require('./harness');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const mock = (id, url, body = { mocked: id }, extra = {}) => ({
    id, name: id, enabled: true, type: 'mock', match: { url, method: '*' },
    response: { statusCode: 200, headers: JSON_HEADERS, body, delay: 0, mode: 'static' },
    ...extra
});
const redirect = (id, url, destination) => ({
    id, name: id, enabled: true, type: 'redirect', match: { url, method: '*' }, redirect: { destination }
});
const control = mock('control', '*/api/control*', { control: true });

describe('fix-interceptor: interception in a real browser', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    /** A fresh page holding exactly these rules (plus a control rule to know they arrived). */
    async function withRules(...rules) {
        await h.reset();
        const response = await h.bg({ type: 'setRules', rules: [control, ...rules] });
        expect(response && response.success).toBe(true);
        page = await h.openPage();
        await waitFor(async () => (await pageFetch(page, '/api/control')).marker === 'true', { label: 'rules on page' });
        h.requests.length = 0;
        return page;
    }
    const served = (pathname) => h.requests.filter((r) => r.path === pathname);

    // ---- PER-2 -------------------------------------------------------------

    test('PER-2: the shared modules are not page globals, and redefining them leaks nothing', async () => {
        const secret = mock('secret', '*/api/internal-only*', { token: 'MOCK-BODY-SECRET' });
        await withRules(secret, mock('visible', '*/api/target*'));

        const globals = await page.evaluate(() => [
            typeof window.SpliceTapMatcher, typeof window.SpliceTapPlaceholders, typeof window.SpliceTapPatch
        ]);
        expect(globals).toEqual(['undefined', 'undefined', 'undefined']);

        // Everything a page could plant where the interceptor used to look,
        // plus the built-ins it applies to rule data.
        await page.evaluate(() => {
            const stringify = JSON.stringify.bind(JSON);
            window.__leaks = [];
            const watch = (label) => function (...args) {
                let text = '';
                try { text = stringify(args); } catch (e) { text = String(args); }
                if (text.includes('MOCK-BODY-SECRET')) window.__leaks.push(label);
                return null;
            };
            window.SpliceTapMatcher = { findMatchingRule: watch('findMatchingRule'), matchUrl: watch('matchUrl'), isCatastrophicRegex: watch('isCatastrophicRegex') };
            window.SpliceTapPlaceholders = { processDynamicResponse: watch('processDynamicResponse') };
            window.SpliceTapPatch = { jsonMergePatch: watch('jsonMergePatch') };
            const wrap = (owner, name) => {
                const original = owner[name];
                const spy = watch(name);
                owner[name] = function (...args) { spy(...args); return original.apply(this, args); };
            };
            wrap(JSON, 'stringify');
            wrap(JSON, 'parse');
            wrap(Object, 'keys');
            wrap(Object, 'assign');
        });

        // A request through each path, and a rule change to force a state sync.
        const fetched = await pageFetch(page, '/api/target');
        const xhr = await pageXHR(page, '/api/target');
        await h.saveRule(mock('another', '*/api/another*'));
        await sleep(300);
        await pageFetch(page, '/api/target');

        expect(fetched.marker).toBe('true');
        expect(xhr.marker).toBe('true');
        expect(await page.evaluate(() => window.__leaks)).toEqual([]);
    });

    // ---- PER-8 -------------------------------------------------------------

    test('PER-8: host-scoped and full-URL patterns match every call style', async () => {
        const host = new URL(h.baseUrl).host;
        const patterns = [`*${host}*`, `${h.baseUrl}/api/x`, `*${host}/api/x*`, '*/api/x*'];
        const results = {};

        for (const pattern of patterns) {
            await withRules(mock('m', pattern));
            const r = {
                relativeFetch: (await pageFetch(page, '/api/x')).marker,
                absoluteFetch: (await pageFetch(page, h.baseUrl + '/api/x')).marker,
                requestObject: await page.evaluate(async () => (await fetch(new Request('/api/x'))).headers.get('x-splicetap')),
                relativeXHR: (await pageXHR(page, '/api/x')).marker
            };
            results[pattern] = r;
            await page.close();
            page = null;
        }

        for (const pattern of patterns) {
            expect({ pattern, ...results[pattern] }).toEqual({
                pattern, relativeFetch: 'true', absoluteFetch: 'true', requestObject: 'true', relativeXHR: 'true'
            });
        }
    });

    // ---- PER-9 -------------------------------------------------------------

    test('PER-9: a regex redirect replaces the whole URL, for a cross-origin absolute request', async () => {
        const otherOrigin = h.baseUrl.replace('127.0.0.1', 'localhost');
        await withRules(redirect('rx', '/^https?:\\/\\/[^/]+\\/api\\/old\\/(\\d+)/', h.baseUrl + '/echo?id=$1'));

        const fetched = await pageFetch(page, otherOrigin + '/api/old/5');
        const xhr = await pageXHR(page, otherOrigin + '/api/old/6');

        expect(fetched.body.query).toEqual({ id: '5' });
        expect(xhr.body.query).toEqual({ id: '6' });
        expect(served('/echo').map((r) => r.query)).toEqual(['?id=5', '?id=6']);
        expect(served('/api/old/5')).toHaveLength(0);
    });

    test('PER-9: an unanchored regex redirect works on an absolute URL', async () => {
        const otherOrigin = h.baseUrl.replace('127.0.0.1', 'localhost');
        await withRules(redirect('rx', '/\\/api\\/old\\/(\\d+)/', h.baseUrl + '/echo?id=$1'));

        const sameOrigin = await pageFetch(page, h.baseUrl + '/api/old/7');
        const crossOrigin = await pageFetch(page, otherOrigin + '/api/old/8');
        const xhr = await pageXHR(page, h.baseUrl + '/api/old/9');

        expect(sameOrigin.body.query).toEqual({ id: '7' });
        expect(crossOrigin.body.query).toEqual({ id: '8' });
        expect(xhr.body.query).toEqual({ id: '9' });
        expect(served('/echo').map((r) => r.query)).toEqual(['?id=7', '?id=8', '?id=9']);
    });

    // ---- PER-10 ------------------------------------------------------------

    test('PER-10: XHR gives a mock or block above a broader redirect precedence', async () => {
        await withRules(
            mock('m', '*/api/prec*', { from: 'mock' }),
            { id: 'b', name: 'b', enabled: true, type: 'block', match: { url: '*/api/blocked*', method: '*' } },
            redirect('rd', '*/api/*', h.baseUrl + '/redirect-target')
        );

        const mocked = await pageXHR(page, '/api/prec');
        const blocked = await pageXHR(page, '/api/blocked');
        const redirected = await pageXHR(page, '/api/other');

        expect(mocked.body).toEqual({ from: 'mock' });
        expect(blocked.outcome).toBe('error');
        expect(redirected.body).toEqual({ real: true, redirected: true });
        expect(served('/redirect-target')).toHaveLength(1);
    });

    test('PER-10: a header-conditioned rule above a redirect is decided at send(), invisibly', async () => {
        await withRules(
            mock('m', '*/api/prec*', { from: 'mock' }, { match: { url: '*/api/prec*', method: '*', headers: { 'X-Mock': 'yes' } } }),
            redirect('rd', '*/api/*', h.baseUrl + '/echo')
        );

        const withHeader = await pageXHR(page, '/api/prec', { headers: { 'X-Mock': 'yes' } });
        const without = await pageXHR(page, '/api/prec', { headers: { 'X-Keep': 'kept' } });

        expect(withHeader.body).toEqual({ from: 'mock' });
        // Redirected by re-opening at send(): the page's header is replayed
        // and no extra readystatechange is seen.
        expect(without.body.real).toBe(true);
        expect(served('/echo')[0].headers['x-keep']).toBe('kept');
        expect(without.states).toEqual([1, 2, 3, 4]);
    });

    // ---- PER-11 ------------------------------------------------------------

    test('PER-11: a redirected fetch(new Request(...)) with a body arrives intact', async () => {
        await withRules(redirect('rd', '*/api/target*', '/graphql'));

        const r = await page.evaluate(async () => {
            try {
                const response = await fetch(new Request('/api/target', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Keep': 'yes' }, body: '{"payload":1}'
                }));
                return { ok: true, body: await response.json() };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        });

        expect(r).toEqual({ ok: true, body: { real: true, received: '{"payload":1}' } });
        const hit = served('/graphql')[0];
        expect(hit.method).toBe('POST');
        expect(hit.headers['x-keep']).toBe('yes');
    });

    // ---- PER-12 ------------------------------------------------------------

    test('PER-12: a rule name above U+00FF keeps the mock\'s headers', async () => {
        const name = 'Bestellungen – 429';
        await withRules({
            ...mock('n', '*/api/named*'),
            name,
            response: { statusCode: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' }, body: 'slow down', delay: 0, mode: 'static' }
        });

        const r = await page.evaluate(async () => {
            const res = await fetch('/api/named');
            return [res.status, res.headers.get('content-type'), res.headers.get('retry-after'), res.headers.get('x-splicetap'), res.headers.get('x-splicetap-rule')];
        });

        expect(r).toEqual([429, 'text/plain', '30', 'true', encodeURIComponent(name)]);
    });

    // ---- PER-13 ------------------------------------------------------------

    test('PER-13: XHR patch on a non-JSON response reaches the server once', async () => {
        await withRules({
            ...mock('p', '*/text/plain*'),
            response: { statusCode: 200, headers: JSON_HEADERS, patch: { a: 1 }, delay: 0, mode: 'patch' }
        });

        const x = await pageXHR(page, '/text/plain', { method: 'POST', body: 'x' });
        await sleep(400);

        expect(served('/text/plain').filter((r) => r.method === 'POST')).toHaveLength(1);
        expect(x.status).toBe(200);
        expect(x.body).toBe('plain real text');
    });

    // ---- PER-35 ------------------------------------------------------------

    test('PER-35: a prerendered page activated after a rule change runs the new rules', async () => {
        await withRules(mock('m', '*/api/target*'));
        await page.evaluate(() => {
            const rules = document.createElement('script');
            rules.type = 'speculationrules';
            rules.textContent = JSON.stringify({ prerender: [{ source: 'list', urls: ['/page2'] }] });
            document.head.appendChild(rules);
        });
        await sleep(2500); // let the prerender load, content scripts and all

        await h.bg({ type: 'toggleExtension', active: false });
        await sleep(500);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'load' }),
            page.evaluate(() => { location.href = '/page2'; })
        ]);

        const activated = await page.evaluate(() => performance.getEntriesByType('navigation')[0].activationStart > 0);
        const r = await pageFetch(page, '/api/target');

        expect(activated).toBe(true);
        expect(r.marker).toBeNull();
        expect(r.body.real).toBe(true);
    });

    // ---- PER-20 ------------------------------------------------------------

    test('PER-20: srcdoc and page-created about:blank frames are intercepted', async () => {
        await withRules(mock('m', '*/api/target*'));

        await page.evaluate(() => {
            const blank = document.createElement('iframe');
            blank.id = 'blank';
            document.body.appendChild(blank);
            const srcdoc = document.createElement('iframe');
            srcdoc.id = 'srcdoc';
            srcdoc.srcdoc = '<p>inline</p>';
            document.body.appendChild(srcdoc);
        });
        const frameFetch = (id) => page.evaluate(async (frameId) => {
            const w = document.getElementById(frameId).contentWindow;
            const res = await w.fetch('/api/target');
            return { marker: res.headers.get('x-splicetap'), href: w.location.href };
        }, id);

        const blank = await waitFor(async () => {
            const r = await frameFetch('blank');
            return r.marker === 'true' ? r : null;
        }, { label: 'about:blank frame mocked' });
        const srcdoc = await waitFor(async () => {
            const r = await frameFetch('srcdoc');
            return r.marker === 'true' && r.href === 'about:srcdoc' ? r : null;
        }, { label: 'srcdoc frame mocked' });

        expect(blank.href).toBe('about:blank');
        expect(srcdoc.href).toBe('about:srcdoc');
        expect(h.errors.filter((e) => e.where === 'page')).toEqual([]);
    });

    test('PER-20: a frame or popup used straight after creation is intercepted', async () => {
        await withRules(mock('m', '*/api/target*'));

        const r = await page.evaluate(async () => {
            const marker = async (win) => (await win.fetch('/api/target')).headers.get('x-splicetap');
            const xhrMarker = (win) => new Promise((resolve) => {
                const x = new win.XMLHttpRequest();
                x.onloadend = () => resolve(x.getResponseHeader('x-splicetap'));
                x.open('GET', '/api/target');
                x.send();
            });

            const frame = document.createElement('iframe');
            document.body.appendChild(frame);
            // No await between creation and use: the child's rules have to be
            // there already, not on their way from the background.
            const frameFetch = marker(frame.contentWindow);
            const frameXHR = xhrMarker(frame.contentWindow);

            const popup = window.open('about:blank');
            const popupFetch = popup ? marker(popup) : Promise.resolve('no popup');
            const result = { frameFetch: await frameFetch, frameXHR: await frameXHR, popupFetch: await popupFetch };
            if (popup) popup.close();
            return result;
        });

        expect(r).toEqual({ frameFetch: 'true', frameXHR: 'true', popupFetch: 'true' });
    });

    test('PER-20: blob: and data: frames are intercepted', async () => {
        await withRules(mock('m', '*/api/target*'));

        const r = await page.evaluate(async (target) => {
            const seen = {};
            window.addEventListener('message', (e) => { if (e.data && e.data.kind) seen[e.data.kind] = e.data.marker; });
            // A data: frame cannot read its creator's rules (opaque origin), so
            // it waits for the background's answer like any page: the request
            // is made once the frame has loaded, not during its parse.
            const frameHtml = (kind) => '<script>setTimeout(() => fetch(' + JSON.stringify(target) + ')' +
                '.then((res) => parent.postMessage({ kind: ' + JSON.stringify(kind) + ', marker: res.headers.get("x-splicetap") }, "*"),' +
                ' (err) => parent.postMessage({ kind: ' + JSON.stringify(kind) + ', marker: "error" }, "*")), 500)<\/script>';

            const blobFrame = document.createElement('iframe');
            blobFrame.src = URL.createObjectURL(new Blob([frameHtml('blob')], { type: 'text/html' }));
            document.body.appendChild(blobFrame);
            const dataFrame = document.createElement('iframe');
            dataFrame.src = 'data:text/html,' + encodeURIComponent(frameHtml('data'));
            document.body.appendChild(dataFrame);

            const deadline = Date.now() + 5000;
            while (!(seen.blob && seen.data) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
            return seen;
        }, h.baseUrl + '/api/target');

        expect(r).toEqual({ blob: 'true', data: 'true' });
    });
});

describe('fix-interceptor: an extension reload under an open tab (PER-32)', () => {
    let h;

    beforeAll(async () => { h = await launch({ attachWorker: false }); });
    afterAll(async () => { if (h) await h.close(); });

    test('the orphaned tab stops mocking and raises no errors', async () => {
        await h.reset();
        await h.saveRule(mock('m', '*/api/target*'));
        const page = await h.openPage('/page');
        await waitFor(async () => (await pageFetch(page, '/api/target')).marker === 'true', { label: 'mock active' });

        // What an update or "Reload" in chrome://extensions does.
        await h.control.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 50); });
        await sleep(2500);
        h.errors.length = 0;

        const fetched = await pageFetch(page, '/api/target');
        const xhr = await pageXHR(page, '/api/target');
        await sleep(600); // past a log-batch window, which used to throw here

        expect(fetched.marker).toBeNull();
        expect(fetched.body.real).toBe(true);
        expect(xhr.marker).toBeNull();
        expect(h.errors.filter((e) => e.where === 'page')).toEqual([]);
    });
});
