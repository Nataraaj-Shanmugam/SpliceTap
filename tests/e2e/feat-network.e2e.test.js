/**
 * Feature group G1 "network", in Chrome:
 *   F1 — appliesTo:'all' redirect/block rules act on scripts, images and
 *        navigations through declarativeNetRequest, while fetch/XHR stay with
 *        the interceptor and are handled exactly once;
 *   F2 — the optional webRequest observer logs header, query-param and
 *        all-request rules (on a copy of the extension that holds webRequest
 *        from install, since a permission prompt cannot be accepted headless).
 */

const dnr = require('../../service_worker/dnr');
const { launch, pageFetch, pageXHR, waitFor, sleep } = require('./harness');

/** Load an <img> and report whether it loaded. */
function loadImage(page, src) {
    return page.evaluate((s) => new Promise((resolve) => {
        const img = document.createElement('img');
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = s;
    }), src);
}

/** Load a <script> and report which asset actually ran (or 'error'). */
function loadScript(page, src) {
    return page.evaluate((s) => new Promise((resolve) => {
        window.__assetFrom = undefined;
        const el = document.createElement('script');
        el.onload = () => resolve(window.__assetFrom);
        el.onerror = () => resolve('error');
        el.src = s;
        document.head.appendChild(el);
    }), src);
}

const unique = () => Math.random().toString(36).slice(2);

describe('F1: appliesTo:"all" redirect and block rules in Chrome', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });

    beforeEach(async () => {
        await h.reset();
        page = await h.openPage();
    });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    const dynamicRules = () => h.extensionEval(() => chrome.declarativeNetRequest.getDynamicRules());
    const served = (pathname) => h.requests.filter((r) => r.path === pathname).length;
    const logFor = async (ruleId) => (await h.bg({ type: 'getInterceptionLog' })).entries.filter((e) => e.ruleId === ruleId);

    const blockPixel = (overrides = {}) => ({
        id: 'blk-img', name: 'Block pixel', enabled: true, type: 'block', appliesTo: 'all',
        match: { url: '*/assets/pixel.png*', method: '*' },
        ...overrides
    });

    test('a block rule stops an <img> loading, and Chrome registers it as written', async () => {
        const saved = await h.saveRule(blockPixel());
        expect(saved.dnrWarning).toBeUndefined();

        expect(await loadImage(page, '/assets/pixel.png?n=' + unique())).toBe(false);
        expect(served('/assets/pixel.png')).toBe(0);

        // Chrome accepted the rule, and what it holds is what the next sync
        // would build — so it is not re-registered on every save (PER-37).
        const [registered] = await dynamicRules();
        const stored = (await h.bg({ type: 'getRules' })).rules[0];
        expect(registered.condition.resourceTypes).not.toContain('xmlhttprequest');
        expect(dnr.dnrRuleEqual(registered, dnr.ruleToDnr(stored, 0))).toBe(true);
    });

    test('the "page" default leaves an <img> untouched', async () => {
        await h.saveRule(blockPixel({ appliesTo: undefined }));
        expect(await dynamicRules()).toEqual([]);
        expect(await loadImage(page, '/assets/pixel.png?n=' + unique())).toBe(true);
        expect(served('/assets/pixel.png')).toBe(1);
    });

    test('flipping appliesTo back to "page" removes the network rule', async () => {
        await h.saveRule(blockPixel());
        expect(await loadImage(page, '/assets/pixel.png?n=' + unique())).toBe(false);

        const stored = (await h.bg({ type: 'getRules' })).rules[0];
        await h.saveRule({ ...stored, appliesTo: 'page' });
        expect(await dynamicRules()).toEqual([]);
        expect(await loadImage(page, '/assets/pixel.png?n=' + unique())).toBe(true);
    });

    test('a redirect rule sends a <script src> to its destination', async () => {
        await h.saveRule({
            id: 'rdr-js', name: 'Bundle to local', enabled: true, type: 'redirect', appliesTo: 'all',
            match: { url: '*/assets/app.js*', method: '*' },
            redirect: { destination: h.baseUrl + '/assets/app-local.js' }
        });
        expect(await loadScript(page, '/assets/app.js?n=' + unique())).toBe('/assets/app-local.js');
        expect(served('/assets/app.js')).toBe(0);
    });

    test('a $1 redirect from a /regex/ pattern uses the capture group', async () => {
        const saved = await h.saveRule({
            id: 'rdr-re', name: 'Regex bundle', enabled: true, type: 'redirect', appliesTo: 'all',
            match: { url: '/\\/assets\\/(app)\\.js/', method: '*' },
            redirect: { destination: h.baseUrl + '/assets/$1-local.js' }
        });
        expect(saved.dnrWarning).toBeUndefined();
        expect(await loadScript(page, '/assets/app.js?n=' + unique())).toBe('/assets/app-local.js');
    });

    test('a redirect rule sends a main_frame navigation to its destination', async () => {
        await h.saveRule({
            id: 'rdr-nav', name: 'Navigate away', enabled: true, type: 'redirect', appliesTo: 'all',
            match: { url: '*/nav-source*', method: 'GET' },
            redirect: { destination: h.baseUrl + '/redirect-target' }
        });
        await page.goto(h.baseUrl + '/nav-source', { waitUntil: 'load' });
        expect(new URL(page.url()).pathname).toBe('/redirect-target');
        expect(served('/nav-source')).toBe(0);
        expect(served('/redirect-target')).toBe(1);
    });

    test('earlier rules win: list order decides between two network rules', async () => {
        const redirect = {
            id: 'first-redirect', name: 'Redirect', enabled: true, type: 'redirect', appliesTo: 'all',
            match: { url: '*/assets/app.js*', method: '*' },
            redirect: { destination: h.baseUrl + '/assets/app-local.js' }
        };
        const block = { id: 'then-block', name: 'Block', enabled: true, type: 'block', appliesTo: 'all', match: { url: '*/assets/app.js*', method: '*' } };

        await h.bg({ type: 'setRules', rules: [redirect, block] });
        expect(await loadScript(page, '/assets/app.js?n=' + unique())).toBe('/assets/app-local.js');

        const stored = (await h.bg({ type: 'getRules' })).rules;
        await h.bg({ type: 'setRules', rules: [stored[1], stored[0]] });
        expect(await loadScript(page, '/assets/app.js?n=' + unique())).toBe('error');
    });

    test('a fetch or XHR to a blocked URL is handled once, in the page, never reaching the network', async () => {
        await h.saveRule(blockPixel({ id: 'blk-api', match: { url: '*/api/net-block*', method: '*' } }));
        const fetched = await pageFetch(page, '/api/net-block');
        const xhr = await pageXHR(page, '/api/net-block');
        expect(fetched.ok).toBe(false);
        expect(xhr.outcome).toBe('error');
        expect(served('/api/net-block')).toBe(0);

        await waitFor(async () => (await logFor('blk-api')).length >= 2, { label: 'two log entries' });
        await sleep(600);
        expect(await logFor('blk-api')).toHaveLength(2);
    });

    test('a fetch to a redirected URL is redirected once, by the interceptor', async () => {
        await h.saveRule({
            id: 'rdr-api', name: 'API redirect', enabled: true, type: 'redirect', appliesTo: 'all',
            match: { url: '*/api/net-src*', method: '*' },
            redirect: { destination: h.baseUrl + '/api/net-dst' }
        });
        const fetched = await pageFetch(page, '/api/net-src');
        expect(fetched.body.path).toBe('/api/net-dst');
        expect(served('/api/net-src')).toBe(0);
        expect(served('/api/net-dst')).toBe(1);

        await waitFor(async () => (await logFor('rdr-api')).length >= 1, { label: 'a log entry' });
        await sleep(600);
        expect(await logFor('rdr-api')).toHaveLength(1);
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
