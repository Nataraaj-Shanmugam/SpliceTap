/**
 * Regression tests for fix group B1 ("background"), against the real
 * extension in headless Chrome. Each block names the finding it guards
 * (PERSONA-REVIEW.md).
 */

const { launch, pageFetch, waitFor, sleep } = require('./harness');

const json = { 'Content-Type': 'application/json' };
const mock = (id, url, extra = {}) => ({
    id, name: id, enabled: true, type: 'mock', match: { url, method: '*' },
    response: { statusCode: 200, headers: json, body: { from: id }, delay: 0, mode: 'static' },
    ...extra
});
const header = (id, url, name, extra = {}) => ({
    id, name: id, enabled: true, type: 'headers', match: { url, method: '*' },
    headersMod: { request: [{ op: 'set', name, value: 'on' }], response: [] },
    ...extra
});

describe('fix group B1 (background)', () => {
    let h;
    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    beforeEach(async () => { await h.reset(); });

    const storedIds = async () => (await h.bg({ type: 'getRules' })).rules.map((r) => r.id);

    // ---- PER-27 / PER-28: bulk writes ------------------------------------

    test('PER-27: a stored rule today\'s validator refuses survives a reorder', async () => {
        await h.saveRule(mock('a', '*/api/a*'));
        await h.saveRule(mock('b', '*/api/b*'));
        // Planted directly in storage, as an older build that allowed
        // 120-character names would have stored it.
        await h.extensionEval(async () => {
            const k = 'spliceTapRules';
            const cur = (await chrome.storage.local.get(k))[k];
            cur.unshift({
                id: 'old', name: 'x'.repeat(120), enabled: true, type: 'mock',
                match: { url: '*/api/old*', method: '*' },
                response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: {}, delay: 0, mode: 'static' }
            });
            await chrome.storage.local.set({ [k]: cur });
        });
        // Any mutation makes the background reload from storage.
        await h.bg({ type: 'toggleRule', ruleId: 'a', enabled: true });
        expect(await storedIds()).toEqual(['old', 'a', 'b']);

        // The popup's "Move down" on `a`.
        const list = (await h.bg({ type: 'getRules' })).rules;
        const response = await h.bg({ type: 'setRules', rules: [list[0], list[2], list[1]] });

        expect(response.success).toBe(true);
        expect(response.rejected).toBeUndefined();
        expect(await storedIds()).toEqual(['old', 'b', 'a']);
    });

    test('PER-28: a replace import with a repeated id stores two distinct rules', async () => {
        await h.bg({ type: 'setRules', rules: [mock('dup', '*/api/one*'), mock('dup', '*/api/two*')] });

        const ids = await storedIds();
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);

        await h.bg({ type: 'deleteRule', ruleId: 'dup' });
        expect(await storedIds()).toHaveLength(1);
    });

    // ---- PER-31: a tab paused at a breakpoint ----------------------------

    test('PER-31: a tab paused in the debugger stalls neither saves nor the OFF switch', async () => {
        await h.saveRule(mock('r1', '*/api/r1*'));
        await h.saveRule(header('hdr', '*/echo*', 'X-B1-Paused'));
        const other = await h.openPage();
        await waitFor(async () => (await pageFetch(other, '/echo')).body.headers['x-b1-paused'] === 'on',
            { label: 'header rule applied' });

        const paused = await h.openPage();
        await sleep(300);
        const cdp = await paused.createCDPSession();
        await cdp.send('Debugger.enable');
        let isPaused = false;
        cdp.on('Debugger.paused', () => { isPaused = true; });
        cdp.send('Runtime.evaluate', { expression: 'debugger; 1' }).catch(() => {});
        await waitFor(() => isPaused, { label: 'tab paused' });

        try {
            let t = Date.now();
            const toggled = await h.bg({ type: 'toggleRule', ruleId: 'r1', enabled: false });
            expect(toggled.success).toBe(true);
            expect(Date.now() - t).toBeLessThan(1000);

            t = Date.now();
            const off = await h.bg({ type: 'toggleExtension', active: false });
            expect(off).toMatchObject({ success: true, active: false });
            expect(Date.now() - t).toBeLessThan(1000);

            // The network rules are withdrawn now, not when the tab resumes.
            expect(await h.extensionEval(() => chrome.declarativeNetRequest.getDynamicRules())).toEqual([]);
            expect((await pageFetch(other, '/echo')).body.headers['x-b1-paused']).toBeUndefined();
        } finally {
            await cdp.send('Debugger.resume').catch(() => {});
            await cdp.detach().catch(() => {});
        }

        // Once resumed, the paused tab catches up with the latest state.
        await waitFor(async () => {
            const r = await pageFetch(paused, '/api/r1');
            return r.body && r.body.from === undefined;
        }, { label: 'paused tab sees the extension off', timeout: 8000 });

        await paused.close();
        await other.close();
    }, 30000);

    // ---- PER-21 / PER-33 / PER-37: the network layer ---------------------

    /** Count updateDynamicRules calls the worker makes from now on. */
    async function countDnrUpdates() {
        await h.worker.evaluate(() => {
            const api = chrome.declarativeNetRequest;
            if (!globalThis.__b1RealUpdate) globalThis.__b1RealUpdate = api.updateDynamicRules.bind(api);
            globalThis.__b1Updates = 0;
            api.updateDynamicRules = (...args) => {
                globalThis.__b1Updates++;
                return globalThis.__b1RealUpdate(...args);
            };
        });
        return () => h.worker.evaluate(() => globalThis.__b1Updates);
    }

    test('PER-21: */echo adds a header to /echo, but not to /echo?x=1 or /echo/sub', async () => {
        await h.saveRule(header('anchored', '*/echo', 'X-B1-Anchored'));
        const page = await h.openPage();
        await waitFor(async () => (await pageFetch(page, '/echo')).body.headers['x-b1-anchored'] === 'on',
            { label: 'anchored rule on /echo' });

        expect((await pageFetch(page, '/echo?x=1')).body.headers['x-b1-anchored']).toBeUndefined();
        await pageFetch(page, '/echo/sub');
        const sub = h.requests.filter((r) => r.path === '/echo/sub').pop();
        expect(sub.headers['x-b1-anchored']).toBeUndefined();
        await page.close();
    });

    test('PER-21: a path pattern (/echo*) still applies on the wire', async () => {
        await h.saveRule(header('from-path', '/echo*', 'X-B1-Path'));
        const page = await h.openPage();
        await waitFor(async () => (await pageFetch(page, '/echo?q=1')).body.headers['x-b1-path'] === 'on',
            { label: 'path-anchored rule applied' });
        await page.close();
    });

    test('PER-37: a sync with nothing to change makes no update call', async () => {
        await h.saveRule(header('steady', '*/echo*', 'X-B1-Steady'));
        await h.saveRule(header('steady-re', '/\\/echo\\/re/', 'X-B1-Re'));
        await h.saveRule(mock('m', '*/api/m*'));
        const updates = await countDnrUpdates();

        // Toggling a mock rule re-syncs the network layer; nothing in it changed.
        await h.bg({ type: 'toggleRule', ruleId: 'm', enabled: false });
        expect(await updates()).toBe(0);

        await h.bg({ type: 'toggleRule', ruleId: 'steady', enabled: false });
        expect(await updates()).toBe(1);
    });

    test('PER-33: a rule Chrome refuses is isolated once, remembered, and costs nothing after', async () => {
        for (let i = 0; i < 20; i++) await h.saveRule(header(`good${i}`, `*/echo/${i}*`, `X-B1-${i}`));
        // Chrome refuses a modifyHeaders action with no headers; planted in
        // storage as an older build could have stored it.
        const stored = (await h.bg({ type: 'getRules' })).rules;
        await h.extensionEval((rules) => chrome.storage.local.set({ spliceTapRules: rules }), [...stored, {
            id: 'refused', name: 'Refused rule', enabled: true, type: 'headers', dnrRuleId: 9001,
            match: { url: '*/echo*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X-No-Value' }], response: [] }
        }]);
        const updates = await countDnrUpdates();

        const toggled = await h.bg({ type: 'toggleRule', ruleId: 'good0', enabled: true });
        expect(toggled.dnrWarning).toMatch(/Refused rule/);
        expect(await updates()).toBeLessThanOrEqual(3);
        expect(await h.extensionEval(() => chrome.declarativeNetRequest.getDynamicRules())).toHaveLength(20);
        const remembered = await h.extensionEval(() => chrome.storage.session.get('spliceTapDnrRejected'));
        expect(Object.values(remembered.spliceTapDnrRejected)).toHaveLength(1);

        // The next sync, as on the next worker wake, goes straight past it.
        const before = await updates();
        const again = await h.bg({ type: 'toggleRule', ruleId: 'good1', enabled: true });
        expect(again.dnrWarning).toMatch(/Refused rule/);
        expect(await updates()).toBe(before);
    });

    // ---- PER-6 / PER-34: what a content script can ask for --------------

    /** Send a message from SpliceTap's own content-script world in `page`. */
    async function fromContentScript(page, message) {
        const cdp = await page.createCDPSession();
        const contexts = [];
        cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
        await cdp.send('Runtime.enable');
        const { frameTree } = await cdp.send('Page.getFrameTree');
        const ctx = contexts.find((c) => c.auxData && c.auxData.type === 'isolated'
            && c.auxData.frameId === frameTree.frame.id && c.origin.includes(h.extensionId));
        if (!ctx) throw new Error('content-script world not found');
        const { result } = await cdp.send('Runtime.evaluate', {
            contextId: ctx.id,
            expression: `chrome.runtime.sendMessage(${JSON.stringify(message)})`,
            awaitPromise: true,
            returnByValue: true
        });
        await cdp.detach();
        return result.value;
    }

    test('PER-6: a content script gets its own messages answered and nothing else', async () => {
        await h.saveRule(mock('kept', '*/api/kept*'));
        await h.saveRule(mock('disabled', '*/api/disabled*', { enabled: false }));
        const page = await h.openPage();

        const state = await fromContentScript(page, { type: 'getRules' });
        expect(state.success).toBe(true);
        // The top frame hosts the in-page editor, which needs every rule.
        expect(state.rules.map((r) => r.id).sort()).toEqual(['disabled', 'kept']);

        const scoped = await fromContentScript(page, { type: 'getRules', scope: 'interceptor' });
        expect(scoped.rules.map((r) => r.id)).toEqual(['kept']);

        for (const message of [{ type: 'getCaptures' }, { type: 'setRules', rules: [] }, { type: 'resetAll' }]) {
            expect(await fromContentScript(page, message)).toMatchObject({ success: false });
        }
        expect(await storedIds()).toEqual(['kept', 'disabled']);

        // The popup (an extension page) is unaffected.
        expect((await h.bg({ type: 'getCaptures' })).success).toBe(true);
        await page.close();
    });

    test('ran without extension errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
