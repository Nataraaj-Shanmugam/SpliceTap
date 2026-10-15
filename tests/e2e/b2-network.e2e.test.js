/**
 * Batch 2, group G1 "network", in Chrome:
 *   B2-F7 — match.pageDomains (initiatorDomains) and match.resourceTypes on
 *           the DNR layer;
 */

const dnr = require('../../service_worker/dnr');
const { launch, pageFetch } = require('./harness');

/** Load an <img> and report whether it loaded. */
function loadImage(page, src) {
    return page.evaluate((s) => new Promise((resolve) => {
        const img = document.createElement('img');
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = s;
    }), src);
}

const unique = () => Math.random().toString(36).slice(2);

describe('B2-F7: page domains and resource types in Chrome', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });

    beforeEach(async () => {
        await h.reset();
        page = await h.openPage();
    });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    const port = () => new URL(h.baseUrl).port;
    const served = (pathname) => h.requests.filter((r) => r.path === pathname);
    const dynamicRules = () => h.extensionEval(() => chrome.declarativeNetRequest.getDynamicRules());

    test('an all-request block with pageDomains ["localhost"] blocks an <img> on localhost, not on 127.0.0.1', async () => {
        const saved = await h.saveRule({
            id: 'blk-local', name: 'Block pixel on localhost', enabled: true, type: 'block', appliesTo: 'all',
            match: { url: '*/assets/pixel.png*', method: '*', pageDomains: ['localhost'] }
        });
        expect(saved.dnrWarning).toBeUndefined();

        // Same server, same port: only the page's host differs.
        await page.goto(`http://localhost:${port()}/page`, { waitUntil: 'load' });
        expect(await loadImage(page, '/assets/pixel.png?n=' + unique())).toBe(false);
        expect(served('/assets/pixel.png')).toHaveLength(0);

        await page.goto(`http://127.0.0.1:${port()}/page`, { waitUntil: 'load' });
        expect(await loadImage(page, '/assets/pixel.png?n=' + unique())).toBe(true);
        expect(served('/assets/pixel.png')).toHaveLength(1);

        // Chrome holds exactly what the next sync would build, so the rule is
        // not re-registered on every save (PER-37).
        const [registered] = await dynamicRules();
        const stored = (await h.bg({ type: 'getRules' })).rules[0];
        expect(registered.condition.initiatorDomains).toEqual(['localhost']);
        expect(dnr.dnrRuleEqual(registered, dnr.ruleToDnr(stored, 0))).toBe(true);
    });

    test('a headers rule limited to "document" sets its header on a page navigation, not on a fetch', async () => {
        await h.saveRule({
            id: 'hdr-doc', name: 'Header on navigations', enabled: true, type: 'headers',
            match: { url: '*/echo*', method: '*', resourceTypes: ['document'] },
            headersMod: { request: [{ op: 'set', name: 'X-Nav', value: 'doc' }], response: [] }
        });

        await page.goto(h.baseUrl + '/echo?nav=' + unique(), { waitUntil: 'load' });
        const [navigation] = served('/echo');
        expect(navigation.headers['x-nav']).toBe('doc');
        // The page shows what the server received: the probe echoes it back.
        const echoed = JSON.parse(await page.evaluate(() => document.body.innerText));
        expect(echoed.headers['x-nav']).toBe('doc');

        const fetched = await pageFetch(page, '/echo?f=' + unique());
        expect(fetched.body.headers['x-nav']).toBeUndefined();

        const [registered] = await dynamicRules();
        expect(registered.condition.resourceTypes).toEqual(['main_frame']);
        const stored = (await h.bg({ type: 'getRules' })).rules[0];
        expect(dnr.dnrRuleEqual(registered, dnr.ruleToDnr(stored, 0))).toBe(true);
    });

    test('without a list, the same headers rule leaves navigations alone (today\'s default)', async () => {
        await h.saveRule({
            id: 'hdr-api', name: 'Header on API calls', enabled: true, type: 'headers',
            match: { url: '*/echo*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X-Nav', value: 'api' }], response: [] }
        });
        await page.goto(h.baseUrl + '/echo?nav=' + unique(), { waitUntil: 'load' });
        expect(served('/echo')[0].headers['x-nav']).toBeUndefined();
        expect((await pageFetch(page, '/echo?f=' + unique())).body.headers['x-nav']).toBe('api');
    });

    test('an all-request block limited to "image" blocks the <img> but not a fetch of the same URL', async () => {
        await h.saveRule({
            id: 'blk-img', name: 'Images only', enabled: true, type: 'block', appliesTo: 'all',
            match: { url: '*/assets/pixel.png*', method: '*', resourceTypes: ['image'] }
        });
        expect(await loadImage(page, '/assets/pixel.png?n=' + unique())).toBe(false);
        const fetched = await pageFetch(page, '/assets/pixel.png?n=' + unique());
        expect(fetched.ok).toBe(true);
        expect(fetched.status).toBe(200);
        expect(served('/assets/pixel.png')).toHaveLength(1);
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
