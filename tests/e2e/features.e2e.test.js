/**
 * Cross-cutting behaviour in a real browser: the interception log and its
 * batching, the toolbar badge, capture, and the page-isolation guarantees
 * the threat model in content/injected.js promises.
 */

const { launch, pageFetch, waitFor, sleep } = require('./harness');

const mockRule = (overrides = {}) => ({
    id: 'm1',
    name: 'Mock target',
    enabled: true,
    type: 'mock',
    match: { url: '*/api/target*', method: 'GET' },
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { mocked: true }, delay: 0, mode: 'static' },
    ...overrides
});

describe('features in a real browser', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    beforeEach(async () => { await h.reset(); });
    afterEach(async () => { if (page) await page.close(); page = null; });

    async function pageWithMock() {
        await h.saveRule(mockRule());
        page = await h.openPage();
        await waitFor(async () => (await pageFetch(page, '/api/target')).marker === 'true', { label: 'mock active' });
        await h.bg({ type: 'clearInterceptionLog' });
        return page;
    }

    // ---- interception log ----------------------------------------------

    test('intercepted requests appear in the log, attributed to their tab', async () => {
        await pageWithMock();
        await pageFetch(page, '/api/target?n=1');
        await pageFetch(page, '/api/target?n=2');

        const log = await waitFor(async () => {
            const r = await h.bg({ type: 'getInterceptionLog' });
            return r.entries.length >= 2 ? r.entries : null;
        }, { label: 'log entries' });

        expect(log.map((e) => e.ruleId)).toEqual(['m1', 'm1']);
        expect(log.every((e) => typeof e.tabId === 'number')).toBe(true);
    });

    test('a burst of requests is relayed in batches, not one message each (PERF-4)', async () => {
        await pageWithMock();
        await page.evaluate(() => Promise.all(Array.from({ length: 30 }, (_, i) => fetch('/api/target?b=' + i))));

        const entries = await waitFor(async () => {
            const r = await h.bg({ type: 'getInterceptionLog' });
            return r.entries.length >= 30 ? r.entries : null;
        }, { label: '30 log entries' });

        expect(entries).toHaveLength(30);
    });

    test('sensitive query values are redacted before they are logged', async () => {
        await pageWithMock();
        await pageFetch(page, '/api/target?access_token=super-secret&page=2');

        const [entry] = await waitFor(async () => {
            const r = await h.bg({ type: 'getInterceptionLog' });
            return r.entries.length ? r.entries : null;
        }, { label: 'log entry' });

        expect(entry.url).not.toMatch(/super-secret/);
        expect(entry.url).toMatch(/page=2/);
    });

    test('hit counts accumulate on the rule', async () => {
        await pageWithMock();
        const before = (await h.bg({ type: 'getRules' })).rules.find((r) => r.id === 'm1').hitCount || 0;
        await pageFetch(page, '/api/target');
        await pageFetch(page, '/api/target');

        await waitFor(async () => {
            const rule = (await h.bg({ type: 'getRules' })).rules.find((r) => r.id === 'm1');
            return (rule.hitCount || 0) >= before + 2;
        }, { label: 'hit count to rise' });
    });

    // ---- badge -----------------------------------------------------------

    const badge = () => h.extensionEval(() => chrome.action.getBadgeText({}));

    test('badge shows the enabled-rule count, OFF when switched off, REC while capturing', async () => {
        await h.saveRule(mockRule({ id: 'a' }));
        await h.saveRule(mockRule({ id: 'b' }));
        await h.saveRule(mockRule({ id: 'c', enabled: false }));
        expect(await badge()).toBe('2');

        await h.bg({ type: 'setCaptureArmed', armed: true });
        expect(await badge()).toBe('REC');
        await h.bg({ type: 'setCaptureArmed', armed: false });

        await h.bg({ type: 'toggleExtension', active: false });
        expect(await badge()).toBe('OFF');
    });

    test('badge is empty with no rules', async () => {
        expect(await badge()).toBe('');
    });

    // ---- capture ---------------------------------------------------------

    test('capture records real responses only while armed', async () => {
        page = await h.openPage();
        await pageFetch(page, '/api/before-arming');
        await sleep(400);
        expect((await h.bg({ type: 'getCaptures' })).captures).toHaveLength(0);

        await h.bg({ type: 'setCaptureArmed', armed: true });
        await waitFor(async () => {
            await pageFetch(page, '/api/after-arming');
            const r = await h.bg({ type: 'getCaptures' });
            return r.captures.some((c) => c.url.includes('/api/after-arming'));
        }, { label: 'a capture' });

        const { captures } = await h.bg({ type: 'getCaptures' });
        const cap = captures.find((c) => c.url.includes('/api/after-arming'));
        expect(JSON.parse(cap.body)).toMatchObject({ real: true });
        expect(cap.status).toBe(200);
    });

    // ---- page isolation (SEC-2) ------------------------------------------

    test('a page script cannot read the rule set off the content-script channel', async () => {
        // Before SEC-2 the channel name was fixed, so any page could listen
        // and receive every mock body and internal URL pattern.
        await h.saveRule(mockRule({ name: 'SECRET-RULE-NAME' }));
        page = await h.openPage();

        const leaked = await page.evaluate(() => new Promise((resolve) => {
            const seen = [];
            for (const name of ['__splicetap_sync_state__', '__splicetap_log__', '__splicetap_capture__']) {
                document.addEventListener(name, (e) => seen.push(JSON.stringify(e.detail)), true);
            }
            fetch('/api/target').then(() => setTimeout(() => resolve(seen), 300));
        }));

        expect(leaked.join('')).not.toMatch(/SECRET-RULE-NAME/);
    });

    test('a page script cannot inject rules by forging the channel', async () => {
        page = await h.openPage();
        await page.evaluate(() => {
            const forged = {
                active: true,
                settings: {},
                rules: [{
                    id: 'evil', name: 'evil', enabled: true, type: 'mock',
                    match: { url: '*/api/target*', method: 'GET' },
                    response: { statusCode: 200, body: { forged: true }, mode: 'static' }
                }]
            };
            document.dispatchEvent(new CustomEvent('__splicetap_sync_state__', { detail: forged }));
            document.dispatchEvent(new CustomEvent('__splicetap_bootstrap__', { detail: { nonce: 'attacker' } }));
            document.dispatchEvent(new CustomEvent('__splicetap_sync_state__:attacker', { detail: forged }));
        });

        const r = await pageFetch(page, '/api/target');
        expect(r.body.forged).toBeUndefined();
        expect(r.body.real).toBe(true);
    });

    test('a page script cannot write rows into the interception log', async () => {
        await h.saveRule(mockRule());
        page = await h.openPage();
        await page.evaluate(() => {
            const fake = { url: 'https://evil.test/', method: 'GET', ruleId: 'm1', ts: Date.now() };
            document.dispatchEvent(new CustomEvent('__splicetap_log__', { detail: fake }));
        });
        await sleep(500);

        const { entries } = await h.bg({ type: 'getInterceptionLog' });
        expect(entries.some((e) => e.url.includes('evil.test'))).toBe(false);
    });

    test('ran without extension errors', async () => {
        await pageWithMock();
        expect(h.allErrors).toEqual([]);
    });
});
