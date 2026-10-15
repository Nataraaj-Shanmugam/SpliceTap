/**
 * Batch 2, group G1 "network", in Chrome:
 *   B2-F7 — match.pageDomains (initiatorDomains) and match.resourceTypes on
 *           the DNR layer;
 *   B2-F9 — response-header append and queryParams.removeAll, through /echo;
 */

const dnr = require('../../service_worker/dnr');
const { launch, pageFetch } = require('./harness');

// Tests that need the schema group's (G3) validation of the new fields: the
// save boundary refuses them until it merges.
const afterMerge = test.failing; // coordinator flips

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

describe('B2-F9: header append and query "remove all" in Chrome', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });

    beforeEach(async () => {
        await h.reset();
        page = await h.openPage();
    });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    const echoHeaders = (pathname) => page.evaluate(async (u) => {
        const response = await fetch(u);
        return { multi: response.headers.get('x-multi'), body: await response.json() };
    }, pathname);
    const appendRule = (id, value) => ({
        id, name: 'Append ' + value, enabled: true, type: 'headers',
        match: { url: '*/echo*', method: '*' },
        headersMod: { request: [], response: [{ op: 'append', name: 'X-Multi', value }] }
    });

    afterMerge('two rules appending to one response header both land, where "set" keeps only one', async () => {
        expect((await h.saveRule(appendRule('app-a', 'a'))).dnrWarning).toBeUndefined();
        expect((await h.saveRule(appendRule('app-b', 'b'))).dnrWarning).toBeUndefined();
        const appended = await echoHeaders('/echo?n=' + unique());
        expect(appended.body.real).toBe(true);
        expect(appended.multi.split(/,\s*/).sort()).toEqual(['a', 'b']);

        // The contrast: two "set" rules on one header — only one value lands.
        await h.reset();
        await h.saveRule({ ...appendRule('set-a', 'a'), headersMod: { request: [], response: [{ op: 'set', name: 'X-Multi', value: 'a' }] } });
        await h.saveRule({ ...appendRule('set-b', 'b'), headersMod: { request: [], response: [{ op: 'set', name: 'X-Multi', value: 'b' }] } });
        expect((await echoHeaders('/echo?n=' + unique())).multi).toMatch(/^[ab]$/);
    });

    afterMerge('removeAll alone drops the whole query', async () => {
        const saved = await h.saveRule({
            id: 'qp-clear', name: 'Drop the query', enabled: true, type: 'queryparams',
            match: { url: '*/echo*', method: '*' },
            queryParams: { removeAll: true }
        });
        expect(saved.dnrWarning).toBeUndefined();
        const fetched = await pageFetch(page, '/echo?a=1&b=2');
        expect(fetched.body.query).toEqual({});
        expect(h.requests.filter((r) => r.path === '/echo').map((r) => r.query)).toEqual(['']);
    });

    test('B2-F10: explainMatch runs in the real worker — an example URL, the result and who shadows it', async () => {
        const mock = (id, name) => ({
            id, name, enabled: true, type: 'mock', match: { url: '*/api/*', method: '*' },
            response: { statusCode: 200, headers: {}, body: {}, delay: 0 }
        });
        await h.saveRule(mock('first', 'Catch-all API'));
        await h.saveRule(mock('second', 'Users'));
        const response = await h.bg({ type: 'explainMatch', ruleId: 'second' });
        expect(response).toMatchObject({
            success: true,
            url: 'https://example.testx/api/x',
            network: false,
            shadowedBy: [{ ruleId: 'first', ruleName: 'Catch-all API' }]
        });
        expect(response.result.matches).toBe(true);
        expect(response.result.checks.find((c) => c.condition === 'url').ok).toBe(true);

        const regex = await h.bg({ type: 'explainMatch', rule: { ...mock('r', 'Regex'), match: { url: '/\\/api\\//', method: '*' } } });
        expect(regex).toMatchObject({ success: false, needsUrl: true });
    });

    test('removeAll with params to add leaves exactly those, encoded', async () => {
        const saved = await h.saveRule({
            id: 'qp-only', name: 'Only these params', enabled: true, type: 'queryparams',
            match: { url: '*/echo*', method: '*' },
            queryParams: { removeAll: true, add: [{ key: 'flag', value: 'on' }, { key: 'q x', value: 'a&b=c' }], remove: [] }
        });
        expect(saved.dnrWarning).toBeUndefined();
        const fetched = await pageFetch(page, '/echo?a=1&flag=off&b=2');
        expect(fetched.body.query).toEqual({ flag: 'on', 'q x': 'a&b=c' });
        expect(h.requests.filter((r) => r.path === '/echo').map((r) => r.query)).toEqual(['?flag=on&q%20x=a%26b%3Dc']);

        // Already exactly those: Chrome leaves the request alone.
        h.requests.length = 0;
        await pageFetch(page, '/echo?flag=on&q%20x=a%26b%3Dc');
        expect(h.requests.filter((r) => r.path === '/echo')).toHaveLength(1);
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
