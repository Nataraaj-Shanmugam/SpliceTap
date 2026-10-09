/**
 * The conditions production throws at an MV3 extension that a happy-path
 * test never meets: the service worker being idled out, frames and
 * cross-origin frames, pages with a hostile CSP, several tabs at once, rapid
 * state changes, hundreds of rules, and rules written by an older version.
 */

const { launch, pageFetch, waitFor } = require('./harness');

const mock = (id, overrides = {}) => ({
    id,
    name: `Mock ${id}`,
    enabled: true,
    type: 'mock',
    match: { url: `*/api/${id}*`, method: 'GET' },
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { mocked: id }, delay: 0, mode: 'static' },
    ...overrides
});

const header = (id, name) => ({
    id,
    name: `Header ${id}`,
    enabled: true,
    type: 'headers',
    match: { url: '*/echo*', method: '*' },
    headersMod: { request: [{ op: 'set', name, value: 'on' }], response: [] }
});

/** Fetch from inside a page or frame until it is mocked (or time out). */
const untilMocked = (ctx, path, label) => waitFor(async () => {
    const r = await pageFetch(ctx, path);
    return r.marker === 'true' ? r : null;
}, { label });

describe('service worker idled out by Chrome', () => {
    // Real idle termination takes ~30s, and only happens when no DevTools
    // session is attached to the worker — see attachWorker in the harness.
    let h;
    beforeAll(async () => { h = await launch({ attachWorker: false }); });
    afterAll(async () => { if (h) await h.close(); });

    test('interception, network rules, the log and state all survive it', async () => {
        await h.reset();
        await h.saveRule(mock('alive'));
        await h.saveRule(header('hdr', 'X-Survives'));
        const page = await h.openPage();
        await untilMocked(page, '/api/alive', 'mock before idle');

        // A long-lived extension page, like an options tab left open.
        const longLived = await h.browser.newPage();
        await longLived.goto(h.extUrl('options/options.html'), { waitUntil: 'load' });

        expect(await h.waitForWorkerIdleExit(70000)).toBe(true);

        // With the worker gone, the page still intercepts (the content
        // scripts hold their own copy of the rules)...
        const whileDown = await pageFetch(page, '/api/alive');
        expect(whileDown.body).toEqual({ mocked: 'alive' });
        // ...and declarativeNetRequest rules live in the browser, not the
        // worker, so they keep applying too.
        const echoed = await pageFetch(page, '/echo');
        expect(echoed.body.headers['x-survives']).toBe('on');

        // The log entry for that request wakes the worker when its batch
        // lands, and is recorded.
        await waitFor(async () => {
            const r = await longLived.evaluate(() => chrome.runtime.sendMessage({ type: 'getInterceptionLog' }));
            return r.entries.some((e) => e.ruleId === 'alive');
        }, { label: 'the log entry after restart', timeout: 10000 });

        // A message from the page open throughout gets full, intact state.
        const state = await longLived.evaluate(() => chrome.runtime.sendMessage({ type: 'getRules' }));
        expect(state.active).toBe(true);
        expect(state.rules.map((r) => r.id).sort()).toEqual(['alive', 'hdr']);
        expect(h.workerRunning()).toBe(true);

        await page.close();
        await longLived.close();
    }, 120000);
});

describe('pages and frames', () => {
    let h;
    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    beforeEach(async () => { await h.reset(); });

    test('intercepts inside same-origin and cross-origin iframes', async () => {
        await h.saveRule(mock('framed'));
        const page = await h.openPage('/frames');
        await waitFor(() => page.frames().length >= 3, { label: 'both frames to load' });

        const same = page.frames().find((f) => f.url().startsWith(h.baseUrl + '/page'));
        const cross = page.frames().find((f) => f.url().includes('localhost'));
        expect(same).toBeTruthy();
        expect(cross).toBeTruthy();

        expect((await untilMocked(same, '/api/framed', 'same-origin frame')).body).toEqual({ mocked: 'framed' });
        expect((await untilMocked(cross, '/api/framed', 'cross-origin frame')).body).toEqual({ mocked: 'framed' });
        await page.close();
    });

    test('intercepts on a page whose CSP forbids every script', async () => {
        // MAIN-world content scripts are injected by the browser, so a page
        // locking itself down must not switch interception off.
        await h.saveRule(mock('csp'));
        const page = await h.openPage('/csp-page');
        expect((await untilMocked(page, '/api/csp', 'mock under strict CSP')).body).toEqual({ mocked: 'csp' });
        await page.close();
    });

    test('a rule saved once applies in every open tab, without reloading them', async () => {
        const tabs = [await h.openPage(), await h.openPage(), await h.openPage()];
        await h.saveRule(mock('everywhere'));
        for (const tab of tabs) {
            expect((await untilMocked(tab, '/api/everywhere', 'broadcast to each tab')).body).toEqual({ mocked: 'everywhere' });
        }
        for (const tab of tabs) await tab.close();
    });

    test('rapid on/off toggling settles in a consistent state', async () => {
        await h.saveRule(mock('toggled'));
        await h.saveRule(header('hdr', 'X-Toggled'));
        const page = await h.openPage();
        await untilMocked(page, '/api/toggled', 'mock active');

        // Ten flips without waiting; the last one (off) must win everywhere.
        const flips = [];
        for (let i = 0; i < 10; i++) flips.push(h.bg({ type: 'toggleExtension', active: i % 2 === 1 ? false : true }));
        await Promise.all(flips);
        await h.bg({ type: 'toggleExtension', active: false });

        await waitFor(async () => (await pageFetch(page, '/api/toggled')).body.real === true, { label: 'interception off' });
        expect((await pageFetch(page, '/echo')).body.headers['x-toggled']).toBeUndefined();
        expect(await h.extensionEval(() => chrome.action.getBadgeText({}))).toBe('OFF');
        expect(await h.extensionEval(() => chrome.declarativeNetRequest.getDynamicRules())).toEqual([]);
        await page.close();
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});

describe('scale', () => {
    let h;
    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });

    test('handles 300 mock rules and 40 network rules', async () => {
        await h.reset();
        const rules = [];
        // Zero-padded so no pattern is a prefix of another: */api/m2* would
        // otherwise match /api/m299, and first-match-wins would (correctly) pick it.
        for (let i = 0; i < 300; i++) rules.push(mock(`m${String(i).padStart(3, '0')}`));
        for (let i = 0; i < 40; i++) rules.push(header(`h${i}`, `X-Scale-${i}`));

        const started = Date.now();
        const response = await h.bg({ type: 'setRules', rules });
        const importMs = Date.now() - started;
        expect(response.success).toBe(true);
        expect(response.rejected).toBeUndefined();
        expect(importMs).toBeLessThan(5000);

        // Rules are scanned in order, so the last one exercises the full scan.
        const page = await h.openPage();
        expect((await untilMocked(page, '/api/m299', 'the last rule to match')).body).toEqual({ mocked: 'm299' });

        const echoed = await pageFetch(page, '/echo');
        expect(echoed.body.headers['x-scale-0']).toBe('on');
        expect(echoed.body.headers['x-scale-39']).toBe('on');
        expect(await h.extensionEval(() => chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length))).toBe(40);

        // The popup renders the whole list.
        const popup = await h.browser.newPage();
        await popup.setViewport({ width: 400, height: 600 });
        await popup.goto(h.extUrl('popup/popup.html'), { waitUntil: 'load' });
        await waitFor(async () => (await popup.$$('.rule-card[data-rule-id]')).length === 340, { label: '340 rows', timeout: 10000 });
        expect(await popup.$eval('#tabRuleCount', (e) => e.textContent.trim())).toBe('340');

        await page.close();
        await popup.close();
        expect(h.allErrors).toEqual([]);
    }, 60000);
});

describe('rules written by an older version', () => {
    let h;
    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });

    test('legacy-shaped rules load, intercept, and show in the popup', async () => {
        await h.reset();
        // The original schema: no `type`, a response with no `mode` and no
        // statusText. Written straight to storage, as an old build left it.
        const legacy = [{
            id: 'legacy-1',
            name: 'Legacy not found',
            enabled: true,
            match: { url: '*/api/legacy*', method: 'GET' },
            response: { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: { legacy: true }, delay: 0 }
        }];
        await h.extensionEval((r) => chrome.storage.local.set({ spliceTapRules: r }), legacy);
        // Any write makes the background reload storage and broadcast.
        await h.saveRule(mock('trigger'));

        const page = await h.openPage();
        const r = await untilMocked(page, '/api/legacy', 'the legacy rule');
        expect(r.status).toBe(404);
        expect(r.statusText).toBe('Not Found');
        expect(r.body).toEqual({ legacy: true });

        const popup = await h.browser.newPage();
        await popup.goto(h.extUrl('popup/popup.html'), { waitUntil: 'load' });
        await popup.waitForSelector('.rule-card[data-rule-id="legacy-1"]');
        await page.close();
        await popup.close();
        expect(h.allErrors).toEqual([]);
    });
});
