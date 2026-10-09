/**
 * Documented limitations, pinned as tests (see PARITY.md).
 *
 * These assert what SpliceTap does NOT do today, where Requestly does. They
 * exist so the comparison stays honest: if a limitation is ever lifted, the
 * test fails and PARITY.md has to be updated with it, rather than drifting.
 */

const { launch, waitFor, sleep } = require('./harness');

describe('documented limitations vs Requestly', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    async function withRule(rule) {
        await h.reset();
        await h.saveRule(rule);
        page = await h.openPage();
        await sleep(300);
    }

    test('block/redirect act on fetch and XHR only — not on scripts or images', async () => {
        // Requestly's Cancel and Redirect also reach page resources (via
        // declarativeNetRequest), which is how "point the production bundle at
        // my local build" works there. SpliceTap's interceptor patches fetch
        // and XHR, so a <script> or <img> is untouched.
        await withRule({
            id: 'redir', name: 'Redirect bundle', enabled: true, type: 'redirect',
            match: { url: '*/assets/app.js*', method: '*' }, redirect: { destination: '/assets/app-local.js' }
        });
        const from = await page.evaluate(() => new Promise((resolve) => {
            const s = document.createElement('script');
            s.src = '/assets/app.js';
            s.onload = () => resolve(window.__assetFrom);
            document.head.appendChild(s);
        }));
        expect(from).toBe('/assets/app.js'); // not redirected

        await withRule({
            id: 'blk', name: 'Block image', enabled: true, type: 'block',
            match: { url: '*/assets/pixel.png*', method: '*' }
        });
        const loaded = await page.evaluate(() => new Promise((resolve) => {
            const img = document.createElement('img');
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = '/assets/pixel.png';
        }));
        expect(loaded).toBe(true); // not blocked
    });

    test('there is no way to modify a request body', async () => {
        // Requestly: "Modify Request Body". SpliceTap has no such rule type,
        // and the schema refuses one.
        await h.reset();
        const r = await h.bg({
            type: 'saveRule',
            rule: { id: 'rb', name: 'Body', enabled: true, type: 'requestbody', match: { url: '*', method: 'POST' } }
        });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/Unknown rule type/);
    });

    test('patch mode cannot change the status code of a real response', async () => {
        // Requestly's Modify Response can override the status and keep the
        // body. SpliceTap's patch mode always keeps the real status.
        await withRule({
            id: 'p', name: 'Patch', enabled: true, type: 'mock',
            match: { url: '*/api/status-keep*', method: '*' },
            response: { mode: 'patch', statusCode: 503, patch: { patched: true }, headers: {}, delay: 0 }
        });
        const r = await page.evaluate(async () => {
            const res = await fetch('/api/status-keep');
            return { status: res.status, body: await res.json() };
        });
        expect(r.status).toBe(200);
        expect(r.body.patched).toBe(true);
    });

    test('ran without errors', async () => {
        await waitFor(async () => true, { label: 'noop' });
        expect(h.allErrors).toEqual([]);
    });
});
