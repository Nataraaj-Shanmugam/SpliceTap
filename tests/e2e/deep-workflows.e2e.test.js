/**
 * Deep feature test — the workflows around rules: capture → rule, testing,
 * bulk toggling, keyboard shortcuts, import paths (including a Requestly
 * export, which is how a Requestly user would arrive), and the system theme.
 */

const { launch, pageFetch, waitFor, sleep } = require('./harness');

describe('deep: workflows', () => {
    let h;
    let popup;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => {
        for (const p of [popup, page]) if (p && !p.isClosed()) await p.close();
        popup = null;
        page = null;
    });

    async function openPopup() {
        popup = await h.browser.newPage();
        await popup.setViewport({ width: 400, height: 600 });
        await popup.goto(h.extUrl('popup/popup.html'), { waitUntil: 'load' });
        await popup.waitForSelector('#rulesContainer');
        await sleep(200);
        return popup;
    }
    const stored = async () => (await h.bg({ type: 'getRules' })).rules;

    // ---- capture → rule (Requestly: "record session → generate mocks") -----------------

    test('capture a real response in the popup, turn it into a mock, and it serves the captured body', async () => {
        await h.reset();
        await openPopup();
        await popup.click('#tabData');
        await popup.click('#captureArmed');
        await waitFor(async () => (await h.bg({ type: 'getCaptures' })).armed, { label: 'capture armed' });

        page = await h.openPage();
        // A relative URL, as almost every app calls its own API.
        await pageFetch(page, '/api/captured/42?page=1');
        await waitFor(async () => (await h.bg({ type: 'getCaptures' })).captures.length === 1, { label: 'a capture' });

        await popup.bringToFront();
        await popup.reload({ waitUntil: 'load' });
        await popup.click('#tabData');
        await popup.waitForSelector('[data-capture-action="mock"]');
        await popup.click('[data-capture-action="mock"]');

        const rule = await waitFor(async () => (await stored())[0], { label: 'rule created from capture' });
        expect(rule.enabled).toBe(false); // never starts intercepting unseen
        expect(rule.match.url).toBe('*/api/captured/42*');
        expect(rule.response.body).toMatchObject({ real: true, path: '/api/captured/42' });

        await h.bg({ type: 'toggleRule', ruleId: rule.id, enabled: true });
        await h.bg({ type: 'setCaptureArmed', armed: false });
        h.requests.length = 0;
        const served = await waitFor(async () => {
            const r = await pageFetch(page, '/api/captured/42');
            return r.marker === 'true' ? r : null;
        }, { label: 'the captured mock' });
        expect(served.body).toMatchObject({ real: true, path: '/api/captured/42' });
        expect(h.requests.some((r) => r.path === '/api/captured/42')).toBe(false);
    });

    test('capturing a path that looks like a regex does not create an over-broad rule', async () => {
        // "/api/" begins and ends with "/", which the matcher reads as a regex.
        await h.reset();
        await h.bg({ type: 'setCaptureArmed', armed: true });
        page = await h.openPage();
        await waitFor(async () => {
            await pageFetch(page, '/api/');
            return (await h.bg({ type: 'getCaptures' })).captures.length > 0;
        }, { label: 'a capture' });

        await openPopup();
        await popup.click('#tabData');
        await popup.waitForSelector('[data-capture-action="mock"]');
        await popup.click('[data-capture-action="mock"]');
        const rule = await waitFor(async () => (await stored())[0], { label: 'rule created' });

        // Captured rules mean "URL contains this path" — /x/api/ matching is by
        // design. The bug was the pattern "/api/" being read as the regex
        // /api/, which matches anything containing the letters "api".
        const M = require('../../src/matcher.js');
        expect(rule.match.url).toBe('*/api/*');
        expect(M.matchUrl(h.baseUrl + '/api/', rule.match.url)).toBe(true);
        expect(M.matchUrl(h.baseUrl + '/rapid-transit', rule.match.url)).toBe(false);
        expect(M.matchUrl('https://capi.example.com/x', rule.match.url)).toBe(false);
    });

    // ---- popup actions ---------------------------------------------------------------------

    test('toggle-all disables every rule, then enables them all again', async () => {
        await h.reset();
        for (const id of ['a', 'b', 'c']) {
            await h.saveRule({ id, name: id, enabled: id !== 'c', type: 'block', match: { url: `*/${id}*`, method: 'GET' } });
        }
        await openPopup();
        await popup.click('#toggleAllBtn');
        await waitFor(async () => (await stored()).every((r) => !r.enabled), { label: 'all disabled' });
        await popup.click('#toggleAllBtn');
        await waitFor(async () => (await stored()).every((r) => r.enabled), { label: 'all enabled' });
    });

    test('Test marks a rule passed and announces it', async () => {
        await h.reset();
        await h.saveRule({ id: 't', name: 'Testable', enabled: true, type: 'block', match: { url: '*/t*', method: 'GET' } });
        await openPopup();
        await popup.click('.rule-action[data-action="test"][data-rule-id="t"]');
        await waitFor(() => popup.evaluate(() =>
            /passed/i.test(document.querySelector('.rule-card[data-rule-id="t"] .status-indicator').getAttribute('aria-label') || '')),
        { label: 'status updated' });
    });

    // ---- popup keyboard shortcuts (README) ------------------------------------------------

    test('Ctrl+F focuses search', async () => {
        await h.reset();
        await openPopup();
        await popup.keyboard.down('Control');
        await popup.keyboard.press('f');
        await popup.keyboard.up('Control');
        expect(await popup.evaluate(() => document.activeElement.id)).toBe('searchInput');
    });

    /** Press keys that are expected to close the popup they are sent to. */
    async function pressClosing(keys) {
        const closed = new Promise((resolve) => popup.once('close', resolve));
        try {
            for (const [action, key] of keys) await popup.keyboard[action](key);
        } catch (error) {
            // The popup closed mid-sequence — which is the behaviour under test.
        }
        return closed;
    }

    test('Ctrl+N opens the editor — on the options page, where no web page is active', async () => {
        await h.reset();
        await openPopup();
        const opened = h.browser.waitForTarget((t) => t.url().includes('options/options.html?action=new'), { timeout: 5000 });
        await pressClosing([['down', 'Control'], ['press', 'n'], ['up', 'Control']]);
        const target = await opened;
        const p = await target.page();
        if (p) await p.close();
    });

    test('Escape closes the popup', async () => {
        await h.reset();
        await openPopup();
        await Promise.race([
            pressClosing([['press', 'Escape']]),
            sleep(3000).then(() => { throw new Error('popup did not close'); })
        ]);
    });

    test('both browser-level shortcuts are actually assigned by Chrome', async () => {
        // Regression: the manifest asked for Alt+Shift+N, which Chrome refuses
        // as a conflict — the command then has NO shortcut, and the key the
        // README documented did nothing.
        const commands = await h.extensionEval(() => chrome.commands.getAll());
        const byName = Object.fromEntries(commands.map((c) => [c.name, c.shortcut]));
        expect(byName['toggle-extension']).toBe('Alt+Shift+M');
        expect(byName['new-rule']).toBe('Alt+Shift+E');
    });

    // ---- import paths ------------------------------------------------------------------------

    async function importJson(json, { keepExisting = true } = {}) {
        await openPopup();
        await popup.click('#tabData');
        await popup.click('#importToggleBtn');
        if (!keepExisting) await popup.click('#importMerge');
        await popup.$eval('#importJson', (el, v) => { el.value = v; }, json);
        await popup.click('#importConfirmBtn');
        return waitFor(() => popup.evaluate(() => {
            const t = Array.from(document.querySelectorAll('.toast')).map((x) => x.innerText).join(' | ');
            return t || null;
        }), { label: 'an import result' });
    }

    test('a v1 rule file (no type, no mode) imports and works', async () => {
        await h.reset();
        const v1 = [{
            id: 'legacy', name: 'Legacy v1', enabled: true,
            match: { url: '*/api/v1-import*', method: 'GET' },
            response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { v1: true }, delay: 0 }
        }];
        const message = await importJson(JSON.stringify(v1));
        expect(message).toMatch(/Imported 1 rule/);
        page = await h.openPage();
        const r = await waitFor(async () => {
            const x = await pageFetch(page, '/api/v1-import');
            return x.marker === 'true' ? x : null;
        }, { label: 'v1 rule active' });
        expect(r.body).toEqual({ v1: true });
    });

    test('import with "Keep existing rules" unticked replaces the rule set', async () => {
        await h.reset();
        await h.saveRule({ id: 'old', name: 'Old', enabled: true, type: 'block', match: { url: '*/old*', method: 'GET' } });
        await importJson(JSON.stringify([{ id: 'new', name: 'New', enabled: true, type: 'block', match: { url: '*/new*', method: 'GET' } }]), { keepExisting: false });
        await waitFor(async () => {
            const names = (await stored()).map((r) => r.name);
            return names.length === 1 && names[0] === 'New';
        }, { label: 'replaced rule set' });
    });

    test('a Requestly export is recognised and reported clearly — conversion is a known gap', async () => {
        // The documented Requestly rule shape (public API schema): ruleType,
        // status, pairs[].source {key, operator, value}, per-type fields.
        await h.reset();
        const requestlyExport = [
            {
                name: 'RQ redirect', objectType: 'rule', ruleType: 'Redirect', status: 'Active',
                pairs: [{ source: { key: 'Url', operator: 'Contains', value: '/api/rq-redirect' }, destinationType: 'url', destination: h.baseUrl + '/redirect-target' }]
            },
            {
                name: 'RQ cancel', objectType: 'rule', ruleType: 'Cancel', status: 'Active',
                pairs: [{ source: { key: 'Url', operator: 'Contains', value: '/api/rq-cancel' } }]
            },
            {
                name: 'RQ delay', objectType: 'rule', ruleType: 'Delay', status: 'Active',
                pairs: [{ source: { key: 'Url', operator: 'Contains', value: '/api/rq-delay' }, delay: 500 }]
            },
            {
                name: 'RQ headers', objectType: 'rule', ruleType: 'Headers', status: 'Active',
                pairs: [{
                    source: { key: 'Url', operator: 'Contains', value: '/echo' },
                    modifications: { Request: [{ header: 'X-From-Requestly', type: 'Add', value: 'yes' }], Response: [] }
                }]
            }
        ];
        // SpliceTap cannot convert Requestly rules yet (see PARITY.md). It used
        // to call this well-formed file "4 invalid"; it must say what it is.
        const message = await importJson(JSON.stringify(requestlyExport));
        expect(message).toMatch(/Requestly export/);
        expect(message).not.toMatch(/invalid/);
        expect(await stored()).toEqual([]);
    });

    // ---- theme --------------------------------------------------------------------------------

    test.each(['dark', 'light'])('the "auto" theme follows the system preference (%s)', async (scheme) => {
        await h.reset();
        popup = await h.browser.newPage();
        await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
        await popup.goto(h.extUrl('popup/popup.html'), { waitUntil: 'load' });
        await sleep(300);
        const isLight = await popup.evaluate(() => document.body.classList.contains('theme-light'));
        expect(isLight).toBe(scheme === 'light');
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
