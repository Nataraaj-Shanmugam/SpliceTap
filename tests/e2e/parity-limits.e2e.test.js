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

    // Lifted on 15 October 2026, so no longer pinned here: block/redirect now
    // reach scripts, images and pages (appliesTo 'all', tests/e2e/feat-network),
    // and request bodies can be modified (tests/e2e/feat-interceptor).

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
