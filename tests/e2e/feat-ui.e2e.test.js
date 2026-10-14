/**
 * G4b "popup + panel": the pieces of the Requestly-parity work that live in the
 * popup (F2/F4 Settings switches, row chips for the new rule kinds) and the
 * DevTools panel (F5 HAR export, request-body rows).
 *
 * Puppeteer cannot answer Chrome's permission prompt, so the popup page gets a
 * stub `chrome.permissions` before it loads. The click is real, the messages
 * the popup sends to the background are recorded as they leave, and the
 * background is asked afterwards what it actually stored.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, waitFor, sleep, auditA11y } = require('./harness');

const POPUP_SIZE = { width: 400, height: 600 };

const mock = (id, overrides = {}) => ({
    id,
    name: `Mock ${id}`,
    enabled: true,
    type: 'mock',
    match: { url: `*/api/${id}*`, method: 'GET' },
    response: { statusCode: 200, headers: {}, body: { id }, delay: 0, mode: 'static' },
    ...overrides
});

describe('popup + panel (G4b)', () => {
    let h;
    let popup;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (popup && !popup.isClosed()) await popup.close(); popup = null; });

    const settingsNow = async () => (await h.bg({ type: 'getRules' })).settings;
    async function setSettings(patch) {
        const response = await h.bg({ type: 'settingsUpdated', settings: { ...(await settingsNow()), ...patch } });
        expect(response.success).toBe(true);
    }

    /**
     * Open a popup at its real size. `permission` stubs chrome.permissions:
     *   held     whether Chrome reports webRequest as granted
     *   request  what the prompt does: 'grant' | 'decline' | 'throw' | 'hold'
     * Every call the popup makes (to the stub and to the background) is kept on
     * window.__perm.calls / window.__sent for the test to read.
     */
    async function openPopup({ rules = [], fakeRules = null, settings = {}, permission = {}, viewport = POPUP_SIZE, forcedColors = false } = {}) {
        await h.reset();
        await setSettings({ observeNetworkRules: false, allowCodeResponses: false, theme: 'dark', ...settings });
        for (const r of rules) await h.saveRule(r);

        popup = await h.browser.newPage();
        popup.on('pageerror', (e) => h.record({ where: 'popup', text: 'pageerror: ' + e.message }));
        popup.on('console', (m) => { if (m.type() === 'error') h.record({ where: 'popup', text: m.text() }); });
        await popup.setViewport(viewport);
        if (forcedColors) {
            const cdp = await popup.createCDPSession();
            await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
        }
        await popup.evaluateOnNewDocument((cfg) => {
            const state = { calls: [], held: !!cfg.held, mode: cfg.request || 'grant', release: null };
            window.__perm = state;
            window.__sent = [];
            const stub = {
                request(query) {
                    state.calls.push({
                        fn: 'request',
                        query,
                        gesture: window.navigator.userActivation.isActive,
                        // The stack names the caller: still inside the change
                        // handler, not resumed after an await.
                        stack: new Error().stack
                    });
                    if (state.mode === 'throw') throw new Error('prompt unavailable');
                    if (state.mode === 'hold') return new Promise((resolve) => { state.release = resolve; });
                    state.held = state.mode === 'grant';
                    return Promise.resolve(state.held);
                },
                contains(query) {
                    state.calls.push({ fn: 'contains', query });
                    return Promise.resolve(state.held);
                },
                remove(query) {
                    state.calls.push({ fn: 'remove', query, sentBefore: window.__sent.length });
                    state.held = false;
                    return Promise.resolve(true);
                }
            };
            Object.defineProperty(chrome, 'permissions', { value: stub, configurable: true });

            const realSend = chrome.runtime.sendMessage.bind(chrome.runtime);
            chrome.runtime.sendMessage = (message, ...rest) => {
                window.__sent.push(JSON.parse(JSON.stringify(message)));
                // Rules of kinds the background in this tree cannot store yet
                // (the schema lands with another group) are shown by handing
                // the popup its rule list directly.
                if (cfg.fakeRules && message && message.type === 'getRules') {
                    return realSend(message, ...rest).then((r) => ({ ...r, rules: cfg.fakeRules }));
                }
                return realSend(message, ...rest);
            };
        }, { ...permission, fakeRules });
        await popup.goto(h.extUrl('popup/popup.html'), { waitUntil: 'load' });
        await popup.waitForSelector('#rulesContainer');
        await sleep(200);
        return popup;
    }

    const openSettings = async () => { await popup.click('#tabSettings'); await sleep(150); };
    const permCalls = (fn) => popup.evaluate((name) => window.__perm.calls.filter((c) => c.fn === name), fn);
    const sentSettings = () => popup.evaluate(() => window.__sent.filter((m) => m.type === 'settingsUpdated'));
    const isChecked = (id) => popup.$eval('#' + id, (el) => el.checked);
    const noteText = (id) => popup.$eval('#' + id, (el) => (el.hidden ? '' : el.textContent.trim()));

    // ---- F2: the observer switch and its permission flow ---------------------

    describe('F2: "Show header, query-param and all-request rules in the log"', () => {
        test('the switch is in Settings, named by its visible text, off by default', async () => {
            await openPopup();
            await openSettings();
            expect(await isChecked('observeNetworkRules')).toBe(false);
            const label = await popup.$eval('label[for="observeNetworkRules"]', (el) => el.querySelector('.set-title').textContent.trim());
            expect(label).toBe('Show header, query-param and all-request rules in the log');
            expect(await noteText('observeNote')).toBe('');
        });

        test('switching on asks Chrome for webRequest from inside the click, then saves observeNetworkRules:true', async () => {
            await openPopup({ permission: { request: 'grant' } });
            await openSettings();
            await popup.click('#observeNetworkRules + .switch-track');

            await waitFor(async () => (await sentSettings()).length === 1, { label: 'settingsUpdated sent' });
            const requests = await permCalls('request');
            expect(requests).toHaveLength(1);
            expect(requests[0].query).toEqual({ permissions: ['webRequest'] });
            // Inside a user gesture, and called by the change handler itself
            // rather than resumed after an await.
            expect(requests[0].gesture).toBe(true);
            expect(requests[0].stack).toMatch(/onObserveToggle/);

            const [sent] = await sentSettings();
            expect(sent.settings.observeNetworkRules).toBe(true);
            expect(await isChecked('observeNetworkRules')).toBe(true);
            expect((await settingsNow()).observeNetworkRules).toBe(true);
            expect(await noteText('observeNote')).toBe('');
        });

        test('the permission is requested before anything is sent to the background', async () => {
            await openPopup({ permission: { request: 'hold' } });
            await openSettings();
            const sentBefore = (await popup.evaluate(() => window.__sent.length));
            await popup.click('#observeNetworkRules + .switch-track');

            // The prompt is still open: it has been asked, and nothing has been saved.
            await waitFor(async () => (await permCalls('request')).length === 1, { label: 'request called' });
            expect(await popup.evaluate(() => window.__sent.length)).toBe(sentBefore);
            expect((await settingsNow()).observeNetworkRules).toBe(false);

            // A second click while the prompt is open does not start a second request.
            await popup.click('#observeNetworkRules + .switch-track');
            await sleep(150);
            expect(await permCalls('request')).toHaveLength(1);
            expect(await isChecked('observeNetworkRules')).toBe(true);

            // Chrome grants: now it is saved.
            await popup.evaluate(() => window.__perm.release(true));
            await waitFor(async () => (await sentSettings()).length === 1, { label: 'saved after the grant' });
            expect((await settingsNow()).observeNetworkRules).toBe(true);
        });

        test('declined: the switch goes back off, an inline note explains, and nothing is saved', async () => {
            await openPopup({ permission: { request: 'decline' } });
            await openSettings();
            await popup.click('#observeNetworkRules + .switch-track');

            await waitFor(async () => (await noteText('observeNote')) !== '', { label: 'inline note' });
            expect(await isChecked('observeNetworkRules')).toBe(false);
            expect(await noteText('observeNote')).toMatch(/declined/i);
            expect(await sentSettings()).toEqual([]);
            expect((await settingsNow()).observeNetworkRules).toBe(false);
            // The note is the switch's description, and the live region repeats it.
            expect(await popup.$eval('#observeNetworkRules', (el) => el.getAttribute('aria-describedby'))).toBe('observeNote');
            expect(await popup.$eval('#liveRegion', (el) => el.textContent)).toMatch(/declined/i);
        });

        test('the prompt failing to open leaves the switch off with a note', async () => {
            await openPopup({ permission: { request: 'throw' } });
            await openSettings();
            await popup.click('#observeNetworkRules + .switch-track');
            await waitFor(async () => (await noteText('observeNote')) !== '', { label: 'inline note' });
            expect(await isChecked('observeNetworkRules')).toBe(false);
            expect(await sentSettings()).toEqual([]);
        });

        test('declining once does not stop a later grant from working', async () => {
            await openPopup({ permission: { request: 'decline' } });
            await openSettings();
            await popup.click('#observeNetworkRules + .switch-track');
            await waitFor(async () => (await noteText('observeNote')) !== '', { label: 'declined note' });

            await popup.evaluate(() => { window.__perm.mode = 'grant'; });
            await popup.click('#observeNetworkRules + .switch-track');
            await waitFor(async () => (await settingsNow()).observeNetworkRules === true, { label: 'stored' });
            expect(await noteText('observeNote')).toBe('');
        });

        test('switching off saves false first, then gives the permission back', async () => {
            await openPopup({ settings: { observeNetworkRules: true }, permission: { held: true } });
            await openSettings();
            await waitFor(() => isChecked('observeNetworkRules'), { label: 'shown on' });

            await popup.click('#observeNetworkRules + .switch-track');
            await waitFor(async () => (await permCalls('remove')).length === 1, { label: 'permission removed' });

            const [sent] = await sentSettings();
            expect(sent.settings.observeNetworkRules).toBe(false);
            const [removal] = await permCalls('remove');
            expect(removal.query).toEqual({ permissions: ['webRequest'] });
            // The save had already left the popup when the permission went.
            expect(removal.sentBefore).toBeGreaterThanOrEqual(1);
            expect(await isChecked('observeNetworkRules')).toBe(false);
            expect((await settingsNow()).observeNetworkRules).toBe(false);
        });

        test('on open it shows on only when the setting is on AND Chrome holds the permission', async () => {
            await openPopup({ settings: { observeNetworkRules: true }, permission: { held: true } });
            await openSettings();
            await waitFor(() => isChecked('observeNetworkRules'), { label: 'on' });
            expect(await noteText('observeNote')).toBe('');
            expect((await permCalls('contains')).length).toBeGreaterThanOrEqual(1);
            await popup.close();

            // The setting is still on, but the permission has been taken away.
            await openPopup({ settings: { observeNetworkRules: true }, permission: { held: false } });
            await openSettings();
            await waitFor(async () => (await noteText('observeNote')) !== '', { label: 'permission-gone note' });
            expect(await isChecked('observeNetworkRules')).toBe(false);
            expect(await noteText('observeNote')).toMatch(/no longer granted/i);
            // Showing it off is a display decision: the stored setting is not rewritten.
            expect(await sentSettings()).toEqual([]);

            // Switching it on again asks for the permission again.
            await popup.evaluate(() => { window.__perm.mode = 'grant'; });
            await popup.click('#observeNetworkRules + .switch-track');
            await waitFor(() => isChecked('observeNetworkRules'), { label: 'back on' });
            await waitFor(async () => (await permCalls('request')).length === 1, { label: 'asked again' });
            expect(await noteText('observeNote')).toBe('');
        });

        test('setting off with the permission still held (popup closed mid-prompt) shows off', async () => {
            await openPopup({ settings: { observeNetworkRules: false }, permission: { held: true } });
            await openSettings();
            expect(await isChecked('observeNetworkRules')).toBe(false);
            expect(await permCalls('request')).toEqual([]);
        });

        test.each(['dark', 'light'])('Settings has no WCAG A/AA violations with the note showing (%s theme)', async (theme) => {
            await openPopup({ settings: { theme }, permission: { request: 'decline' } });
            await openSettings();
            await popup.click('#observeNetworkRules + .switch-track');
            await waitFor(async () => (await noteText('observeNote')) !== '', { label: 'note' });
            expect(await auditA11y(popup)).toEqual([]);
        });
    });

    // ---- F4: the code responses switch ---------------------------------------

    describe('F4: "Allow code responses"', () => {
        test('is off by default, with no warning showing', async () => {
            await openPopup();
            await openSettings();
            expect(await isChecked('allowCodeResponses')).toBe(false);
            expect(await noteText('codeWarn')).toBe('');
            const title = await popup.$eval('label[for="allowCodeResponses"] .set-title', (el) => el.textContent.trim());
            expect(title).toBe('Allow code responses (runs your JavaScript inside the pages you test)');
        });

        test('switching on sends allowCodeResponses:true and shows a one-line warning; off hides it', async () => {
            await openPopup();
            await openSettings();
            await popup.click('#allowCodeResponses + .switch-track');

            await waitFor(async () => (await sentSettings()).length === 1, { label: 'settingsUpdated' });
            const [sent] = await sentSettings();
            expect(sent.settings.allowCodeResponses).toBe(true);
            // settingsUpdated replaces the stored object, so the whole of it is sent,
            // with the booleans as booleans.
            expect(sent.settings).toMatchObject({ theme: 'dark', observeNetworkRules: false, allowCodeResponses: true });
            expect(sent.settings.chaosMode).toBeDefined();
            expect((await settingsNow()).allowCodeResponses).toBe(true);
            expect(await noteText('codeWarn')).toMatch(/JavaScript/);
            expect(await popup.$eval('#allowCodeResponses', (el) => el.getAttribute('aria-describedby'))).toBe('codeWarn');
            // One line of copy, not a paragraph: it fits on a single rendered line.
            const lines = await popup.$eval('#codeWarn', (el) => {
                const cs = window.getComputedStyle(el);
                const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
                const inner = el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
                return Math.round(inner / lineHeight);
            });
            expect(lines).toBe(1);
            // No permission is involved.
            expect(await permCalls('request')).toEqual([]);

            await popup.click('#allowCodeResponses + .switch-track');
            await waitFor(async () => (await settingsNow()).allowCodeResponses === false, { label: 'off stored' });
            expect(await noteText('codeWarn')).toBe('');
        });

        test('the setting survives reopening the popup, and the warning with it', async () => {
            await openPopup({ settings: { allowCodeResponses: true } });
            await openSettings();
            expect(await isChecked('allowCodeResponses')).toBe(true);
            expect(await noteText('codeWarn')).not.toBe('');
        });

        test('the other settings are untouched when it changes', async () => {
            await openPopup({ settings: { debugMode: true, observeNetworkRules: false } });
            await openSettings();
            await popup.click('#allowCodeResponses + .switch-track');
            await waitFor(async () => (await settingsNow()).allowCodeResponses === true, { label: 'stored' });
            const now = await settingsNow();
            expect(now.debugMode).toBe(true);
            expect(now.chaosMode).toBeDefined();
        });

        test.each(['dark', 'light'])('Settings has no WCAG A/AA violations with the warning showing (%s theme)', async (theme) => {
            await openPopup({ settings: { theme, allowCodeResponses: true } });
            await openSettings();
            expect(await auditA11y(popup)).toEqual([]);
        });

        test('the new switches differ on vs off in forced colours', async () => {
            await openPopup({ forcedColors: true });
            await openSettings();
            for (const id of ['observeNetworkRules', 'allowCodeResponses']) {
                const look = () => popup.$eval(`#${id} ~ .switch-track`, (el) => {
                    const s = window.getComputedStyle(el);
                    return s.backgroundColor + '|' + s.borderColor;
                });
                const off = await look();
                await popup.$eval('#' + id, (el) => { el.checked = true; });
                await sleep(300); // the track animates between states
                expect(await look()).not.toBe(off);
                await popup.$eval('#' + id, (el) => { el.checked = false; });
            }
        });
    });

    // ---- rule rows for the new kinds ------------------------------------------

    describe('rule rows', () => {
        const redirect = (id, extra = {}) => ({
            id, name: `Redirect ${id}`, enabled: true, type: 'redirect',
            match: { url: `*/${id}*`, method: 'GET' }, redirect: { destination: 'https://example.com/new' }, ...extra
        });
        const block = (id, extra = {}) => ({
            id, name: `Block ${id}`, enabled: true, type: 'block', match: { url: `*/${id}*`, method: '*' }, ...extra
        });
        const bodyRule = (id, mode, extra = {}) => ({
            id, name: `Body ${id}`, enabled: true, type: 'requestBody',
            match: { url: `*/${id}*`, method: 'POST' },
            requestBody: mode === 'patch' ? { mode: 'patch', patch: { role: 'admin' } } : { mode: 'static', body: { role: 'admin' } },
            ...extra
        });
        const code = (id, extra = {}) => mock(id, {
            name: `Code ${id}`,
            response: { mode: 'code', code: 'return { ok: true };', delay: 0 },
            ...extra
        });

        /** What one row shows: badge, chips, outcome, and the tooltip. */
        const row = (id) => popup.$eval(`.rule-card[data-rule-id="${id}"]`, (card) => ({
            badge: card.querySelector('.rule-type-badge').textContent,
            badgeType: card.querySelector('.rule-type-badge').dataset.type,
            chips: Array.from(card.querySelectorAll('.rule-scope-chip')).map((c) => c.textContent.replace(/\s+/g, ' ').trim()),
            outcome: card.querySelector('.rule-outcome').textContent,
            title: card.querySelector('.rule-details').title
        }));

        test('a request-body rule says "Request body" and what it does to the body', async () => {
            await openPopup({ fakeRules: [bodyRule('p', 'patch'), bodyRule('s', 'static')] });
            expect(await row('p')).toMatchObject({ badge: 'Request body', badgeType: 'requestBody', outcome: '→ Patch body' });
            expect(await row('s')).toMatchObject({ badge: 'Request body', badgeType: 'requestBody', outcome: '→ Replace body' });
            expect((await row('p')).title).toBe('POST */p* → Patch body');
        });

        test('a request-body rule with no mode falls back to "Modify request body"', async () => {
            await openPopup({ fakeRules: [bodyRule('x', 'patch', { requestBody: undefined })] });
            expect((await row('x')).outcome).toBe('→ Modify request body');
        });

        test('redirect and block rules for all requests carry an "All requests" chip; page-only ones do not', async () => {
            await openPopup({
                fakeRules: [
                    redirect('ra', { appliesTo: 'all' }), block('ba', { appliesTo: 'all' }),
                    redirect('rp', { appliesTo: 'page' }), block('b0'), redirect('r0')
                ]
            });
            expect((await row('ra')).chips).toEqual(['All requests']);
            expect((await row('ba')).chips).toEqual(['All requests']);
            expect((await row('rp')).chips).toEqual([]);
            expect((await row('b0')).chips).toEqual([]);
            expect((await row('r0')).chips).toEqual([]);
            // The explanation is on the chip itself.
            expect(await popup.$eval('.rule-card[data-rule-id="ra"] .rule-scope-chip', (c) => c.title)).toMatch(/scripts, images, pages/);
        });

        test('appliesTo on a rule type that has no such field draws nothing', async () => {
            await openPopup({ fakeRules: [mock('m', { appliesTo: 'all' }), bodyRule('b', 'patch', { appliesTo: 'all' })] });
            expect((await row('m')).chips).toEqual([]);
            expect((await row('b')).chips).toEqual([]);
        });

        test('a code mock carries a "Code" chip and the outcome "Code response"; its delay still shows', async () => {
            await openPopup({ settings: { allowCodeResponses: true }, fakeRules: [code('c'), code('d', { response: { mode: 'code', code: 'return 1', delay: 250 } }), mock('plain')] });
            expect(await row('c')).toMatchObject({ chips: ['Code'], outcome: '→ Code response' });
            expect((await row('d')).outcome).toBe('→ Code response (+250ms)');
            expect((await row('plain')).chips).toEqual([]);
            expect((await row('plain')).outcome).toBe('→ 200 OK');
        });

        test('with code responses off the chip says so, and flipping the switch updates the row', async () => {
            await openPopup({ settings: { allowCodeResponses: false }, fakeRules: [code('c')] });
            expect((await row('c')).chips).toEqual(['Code (off in Settings)']);
            expect(await popup.$eval('.rule-card[data-rule-id="c"] .rule-scope-chip', (c) => c.title)).toMatch(/turned off in Settings/);

            await openSettings();
            await popup.click('#allowCodeResponses + .switch-track');
            await waitFor(async () => (await settingsNow()).allowCodeResponses === true, { label: 'stored' });
            await popup.click('#tabRules');
            await waitFor(async () => (await row('c')).chips[0] === 'Code', { label: 'chip updated' });
        });

        test('search finds the new kinds by their long names', async () => {
            await openPopup({ fakeRules: [bodyRule('b', 'patch'), redirect('ra', { appliesTo: 'all' }), redirect('r0'), mock('m')] });
            const visible = () => popup.$$eval('.rule-card[data-rule-id]', (els) => els.map((e) => e.dataset.ruleId));
            await popup.type('#searchInput', 'modify request body');
            await waitFor(async () => (await visible()).join() === 'b', { label: 'type search' });
            await popup.$eval('#searchInput', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
            await popup.type('#searchInput', 'all requests');
            await waitFor(async () => (await visible()).join() === 'ra', { label: 'chip search' });
        });

        const everyKind = (extra = {}) => [
            bodyRule('b1', 'patch', extra), bodyRule('b2', 'static', { enabled: false, ...extra }),
            redirect('ra', { appliesTo: 'all', ...extra }), block('ba', { appliesTo: 'all', enabled: false, ...extra }),
            code('c1', extra), code('c2', { enabled: false, ...extra })
        ];

        test.each(['dark', 'light'])('the Rules tab has no WCAG A/AA violations with every new kind (%s theme, code on)', async (theme) => {
            await openPopup({ settings: { theme, allowCodeResponses: true }, fakeRules: everyKind() });
            expect(await auditA11y(popup)).toEqual([]);
        });

        test.each(['dark', 'light'])('the Rules tab has no WCAG A/AA violations with code responses off (%s theme)', async (theme) => {
            await openPopup({ settings: { theme, allowCodeResponses: false }, fakeRules: everyKind() });
            expect(await auditA11y(popup)).toEqual([]);
        });

        test('long names plus every chip do not overflow at popup width or at 400% zoom', async () => {
            const long = { name: 'A rule with a very long name that has to truncate rather than push its chips off the edge' };
            for (const viewport of [POPUP_SIZE, { width: 200, height: 150 }]) {
                await openPopup({ viewport, settings: { allowCodeResponses: true }, fakeRules: [redirect('ra', { appliesTo: 'all', enabled: false, hitCount: 12, ...long }), code('c1', { enabled: false, hitCount: 3, ...long })] });
                const overflow = await popup.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
                expect(overflow).toBeLessThanOrEqual(0);
                await popup.close();
            }
        });

        test('in forced colours the chips keep an outline', async () => {
            await openPopup({ forcedColors: true, fakeRules: [redirect('ra', { appliesTo: 'all' })] });
            const border = await popup.$eval('.rule-scope-chip', (c) => window.getComputedStyle(c).borderTopWidth);
            expect(border).toBe('1px');
        });
    });

    // ---- F5: HAR export from the DevTools panel -------------------------------

    describe('F5: Export HAR', () => {
        let panel;
        let downloadDir;
        let browserCdp;

        afterEach(async () => {
            if (panel && !panel.isClosed()) await panel.close();
            panel = null;
            if (downloadDir) fs.rmSync(downloadDir, { recursive: true, force: true });
            downloadDir = null;
        });

        const users = () => `${h.baseUrl}/api/users?page=2&sort=name`;

        async function logEntries(entries) {
            const response = await h.bg({ type: 'logInterceptionBatch', entries });
            expect(response).toMatchObject({ success: true, accepted: entries.length });
        }

        async function captureBody(fields) {
            await h.bg({ type: 'setCaptureArmed', armed: true });
            await h.bg({ type: 'logCapture', entry: { ts: Date.now(), status: 200, statusText: 'OK', contentType: 'application/json', headers: {}, ...fields } });
        }

        /** Open the panel with the browser told to save downloads into a temp dir. */
        async function openPanel() {
            downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splicetap-har-'));
            // Browser.setDownloadBehavior is a browser-level command; a page's
            // own session does not accept it.
            browserCdp = browserCdp || await h.browser.target().createCDPSession();
            const suggested = [];
            browserCdp.removeAllListeners('Browser.downloadWillBegin');
            browserCdp.on('Browser.downloadWillBegin', (event) => suggested.push(event.suggestedFilename));
            await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });

            panel = await h.browser.newPage();
            panel.on('pageerror', (e) => h.record({ where: 'panel', text: 'pageerror: ' + e.message }));
            panel.on('console', (m) => { if (m.type() === 'error') h.record({ where: 'panel', text: m.text() }); });
            await panel.setViewport({ width: 900, height: 600 });
            await panel.goto(h.extUrl('devtools/panel.html'), { waitUntil: 'load' });
            return { suggested };
        }

        /** Click Export HAR and return the saved file's name and parsed JSON. */
        async function exportAndRead(suggested) {
            await panel.click('#exportHarBtn');
            const file = await waitFor(() => {
                const done = fs.readdirSync(downloadDir).filter((f) => !f.endsWith('.crdownload'));
                return done.length ? done[0] : null;
            }, { timeout: 8000, label: 'the downloaded file' });
            const text = fs.readFileSync(path.join(downloadDir, file), 'utf8');
            return { file, text, har: JSON.parse(text), suggested: suggested.slice() };
        }

        const seed = async () => {
            await h.reset();
            await h.saveRule(mock('users'));
            await h.saveRule(mock('orders', { type: 'block', response: undefined }));
            await h.saveRule(mock('moved', { type: 'redirect', response: undefined, redirect: { destination: 'https://example.com/new' } }));
        };

        test('downloads splicetap-YYYYMMDD-HHMMSS.har holding a HAR 1.2 entry per log entry, with a captured body', async () => {
            await seed();
            const t0 = Date.now();
            // Two captures of the same call: the later one is the one exported.
            await captureBody({ ts: t0 - 2000, url: users(), method: 'GET', headers: { 'x-version': '1' }, body: '{"old":true}' });
            await captureBody({ ts: t0 - 1000, url: users(), method: 'GET', headers: { 'x-version': '2' }, body: '{"users":["Ada","Zoë"]}' });
            await captureBody({ ts: t0 - 500, url: users(), method: 'POST', body: '{"posted":true}' });
            await logEntries([
                { ts: t0, url: users(), method: 'GET', ruleId: 'users', ruleName: 'Mock users', ruleType: 'mock', status: 200, kind: 'rule', elapsedMs: 42, finalStatus: 200 },
                { ts: t0 + 1, url: `${h.baseUrl}/api/orders`, method: 'DELETE', ruleId: 'orders', ruleName: 'Mock orders', ruleType: 'block', status: 0, kind: 'rule' },
                { ts: t0 + 2, url: `${h.baseUrl}/api/moved`, method: 'GET', ruleId: 'moved', ruleName: 'Mock moved', ruleType: 'redirect', status: 302, finalStatus: 200, redirectedTo: 'https://example.com/new', elapsedMs: 80, kind: 'rule' },
                { ts: t0 + 3, url: `${h.baseUrl}/api/users`, method: 'POST', ruleId: 'users', ruleName: 'Mock users', ruleType: 'requestBody', status: 200, kind: 'rule', note: 'Request body patched' }
            ]);

            const { suggested } = await openPanel();
            await sleep(300);
            const out = await exportAndRead(suggested);

            // The file, named by the clock and the extension.
            expect(out.file).toMatch(/^splicetap-\d{8}-\d{6}\.har$/);
            expect(suggested).toEqual([out.file]);
            const { log } = out.har;
            expect(log.version).toBe('1.2');
            expect(log.creator.name).toBe('SpliceTap');
            expect(log.creator.version).toBe(require('../../manifest.json').version);
            expect(log.entries).toHaveLength(4);

            // Every entry has what HAR 1.2 requires of it.
            for (const e of log.entries) {
                expect(new Date(e.startedDateTime).toISOString()).toBe(e.startedDateTime);
                expect(typeof e.time).toBe('number');
                expect(e.request).toMatchObject({ httpVersion: '', headers: [], cookies: [], headersSize: -1, bodySize: -1 });
                expect(Array.isArray(e.request.queryString)).toBe(true);
                expect(e.response).toMatchObject({ statusText: '', cookies: [], headersSize: -1, bodySize: -1 });
                expect(typeof e.response.content.size).toBe('number');
                expect(typeof e.response.content.mimeType).toBe('string');
                expect(e.cache).toEqual({});
                expect(e.timings).toEqual({ send: 0, wait: e.time, receive: 0 });
            }

            const byUrlMethod = (method, url) => log.entries.find((e) => e.request.method === method && e.request.url === url);
            const getUsers = byUrlMethod('GET', users());
            expect(getUsers.time).toBe(42);
            expect(getUsers.response.status).toBe(200);
            expect(getUsers.request.queryString).toEqual([{ name: 'page', value: '2' }, { name: 'sort', value: 'name' }]);
            // The body, headers and size come from the later GET capture.
            expect(getUsers.response.content).toEqual({
                size: Buffer.byteLength('{"users":["Ada","Zoë"]}', 'utf8'),
                mimeType: 'application/json',
                text: '{"users":["Ada","Zoë"]}'
            });
            expect(getUsers.response.headers).toEqual([{ name: 'x-version', value: '2' }]);
            expect(getUsers._splicetap).toEqual({ ruleName: 'Mock users', type: 'mock', kind: 'rule', note: '' });
            expect(getUsers.startedDateTime).toBe(new Date(t0).toISOString());

            const block = byUrlMethod('DELETE', `${h.baseUrl}/api/orders`);
            expect(block.response.status).toBe(0);
            expect(block.response.content.text).toBeUndefined();
            expect(block._splicetap.type).toBe('block');

            const redirect = byUrlMethod('GET', `${h.baseUrl}/api/moved`);
            expect(redirect.response.redirectURL).toBe('https://example.com/new');
            expect(redirect.response.status).toBe(200);
            expect(redirect.time).toBe(80);

            // Same URL, other method: it gets the POST capture, never the GET one.
            const body = log.entries.find((e) => e._splicetap.type === 'requestBody');
            expect(body._splicetap.note).toBe('Request body patched');
            expect(body.response.content.text).toBeUndefined();
            expect(body.request.url).toBe(`${h.baseUrl}/api/users`);
        });

        test('a POST entry gets the POST capture for its URL', async () => {
            await seed();
            const t0 = Date.now();
            await captureBody({ ts: t0 - 500, url: users(), method: 'POST', body: '{"posted":true}' });
            await captureBody({ ts: t0 - 400, url: users(), method: 'GET', body: '{"got":true}' });
            await logEntries([{ ts: t0, url: users(), method: 'POST', ruleId: 'users', ruleName: 'Mock users', ruleType: 'mock', status: 201, kind: 'rule' }]);
            const { suggested } = await openPanel();
            const { har } = await exportAndRead(suggested);
            expect(har.log.entries[0].response.content.text).toBe('{"posted":true}');
        });

        test('with no captures it still exports, with empty bodies', async () => {
            await seed();
            await logEntries([{ ts: Date.now(), url: users(), method: 'GET', ruleId: 'users', ruleName: 'Mock users', ruleType: 'mock', status: 200, kind: 'rule' }]);
            const { suggested } = await openPanel();
            const { har } = await exportAndRead(suggested);
            expect(har.log.entries).toHaveLength(1);
            expect(har.log.entries[0].response.content).toEqual({ size: 0, mimeType: '' });
        });

        test('exports the whole log, not only the rows the filter or Dismiss leaves on screen', async () => {
            await seed();
            const t0 = Date.now();
            await logEntries([
                { ts: t0, url: `${h.baseUrl}/api/users`, method: 'GET', ruleId: 'users', ruleName: 'Mock users', ruleType: 'mock', status: 200 },
                { ts: t0 + 1, url: `${h.baseUrl}/api/orders`, method: 'GET', ruleId: 'orders', ruleName: 'Mock orders', ruleType: 'block', status: 0 }
            ]);
            const { suggested } = await openPanel();
            await waitFor(async () => (await panel.$$('#requestItems [role="row"]')).length === 2, { label: 'two rows' });
            await panel.type('#filterText', 'orders');
            await waitFor(async () => (await panel.$$('#requestItems [role="row"]')).length === 1, { label: 'filtered to one' });
            const { har } = await exportAndRead(suggested);
            expect(har.log.entries.map((e) => e.request.url)).toEqual([`${h.baseUrl}/api/users`, `${h.baseUrl}/api/orders`]);
        });

        test('an empty log downloads nothing and says so', async () => {
            await h.reset();
            const { suggested } = await openPanel();
            await panel.click('#exportHarBtn');
            await waitFor(async () => /Nothing to export/.test(await panel.$eval('#logAnnouncer', (el) => el.textContent)), { label: 'announcement' });
            await sleep(500);
            expect(fs.readdirSync(downloadDir)).toEqual([]);
            expect(suggested).toEqual([]);
        });

        test('the button is reachable by keyboard and announces the export', async () => {
            await seed();
            await logEntries([{ ts: Date.now(), url: users(), method: 'GET', ruleId: 'users', ruleName: 'Mock users', ruleType: 'mock', status: 200 }]);
            const { suggested } = await openPanel();
            await panel.focus('#exportHarBtn');
            expect(await panel.evaluate(() => document.activeElement.id)).toBe('exportHarBtn');
            await panel.keyboard.press('Enter');
            await waitFor(() => fs.readdirSync(downloadDir).some((f) => /^splicetap-.*\.har$/.test(f)), { label: 'download' });
            expect(await panel.$eval('#logAnnouncer', (el) => el.textContent)).toMatch(/Exported 1 request to splicetap-\d{8}-\d{6}\.har/);
            expect(suggested).toHaveLength(1);
            // Focus stays on the button.
            expect(await panel.evaluate(() => document.activeElement.id)).toBe('exportHarBtn');
        });

        test.each(['dark', 'light'])('the panel with the Export button has no WCAG A/AA violations (%s theme)', async (theme) => {
            await seed();
            await setSettings({ theme });
            await logEntries([{ ts: Date.now(), url: users(), method: 'GET', ruleId: 'users', ruleName: 'Mock users', ruleType: 'mock', status: 200 }]);
            await openPanel();
            await waitFor(async () => (await panel.$$('#requestItems [role="row"]')).length === 1, { label: 'a row' });
            await waitFor(() => panel.evaluate((t) => document.body.classList.contains('theme-' + t), theme), { label: 'the theme applied' });
            await sleep(500); // the buttons ease between theme colours
            expect(await auditA11y(panel)).toEqual([]);
        });
    });

    // ---- panel rows: request-body entries and observed entries -----------------

    describe('panel rendering', () => {
        let panel;
        afterEach(async () => { if (panel && !panel.isClosed()) await panel.close(); panel = null; });

        const OBSERVED = 'Seen on the network — Chrome applied this rule; SpliceTap matched it independently';

        async function seedLog() {
            await h.reset();
            // The log only accepts entries for rules that exist, and the stored
            // type does not matter to it: the entry's own ruleType is what is shown.
            for (const id of ['body', 'hdr', 'qp', 'blk', 'red', 'mk']) await h.saveRule(mock(id));
            const t0 = Date.now();
            const entry = (n, over) => ({ ts: t0 + n, url: `${h.baseUrl}/api/${over.ruleId}`, method: 'GET', kind: 'rule', ...over });
            const response = await h.bg({
                type: 'logInterceptionBatch',
                entries: [
                    entry(0, { ruleId: 'body', ruleName: 'Patch role', ruleType: 'requestBody', method: 'POST', note: 'Request body patched' }),
                    entry(1, { ruleId: 'hdr', ruleName: 'Add header', ruleType: 'headers', note: OBSERVED }),
                    entry(2, { ruleId: 'qp', ruleName: 'Strip param', ruleType: 'queryparams', finalStatus: 200, note: OBSERVED }),
                    entry(3, { ruleId: 'blk', ruleName: 'Block script', ruleType: 'block', note: OBSERVED }),
                    entry(4, { ruleId: 'red', ruleName: 'Swap script', ruleType: 'redirect', status: 302, redirectedTo: 'https://example.com/a.js', note: OBSERVED }),
                    entry(5, { ruleId: 'mk', ruleName: 'Plain mock', ruleType: 'mock', status: 200 })
                ]
            });
            expect(response.accepted).toBe(6);
        }

        async function openPanel(theme = 'dark') {
            await setSettings({ theme });
            panel = await h.browser.newPage();
            panel.on('pageerror', (e) => h.record({ where: 'panel', text: 'pageerror: ' + e.message }));
            panel.on('console', (m) => { if (m.type() === 'error') h.record({ where: 'panel', text: m.text() }); });
            await panel.setViewport({ width: 900, height: 600 });
            await panel.goto(h.extUrl('devtools/panel.html'), { waitUntil: 'load' });
            await waitFor(async () => (await panel.$$('#requestItems [role="row"]')).length === 6, { label: 'six rows' });
        }

        const row = (name) => panel.evaluate((n) => {
            const el = Array.from(document.querySelectorAll('#requestItems [role="row"]'))
                .find((r) => r.querySelector('.rule-name').textContent === n);
            const badge = el.querySelector('.rule-type-badge');
            const note = el.querySelector('.request-note');
            return {
                badge: badge.textContent,
                badgeType: badge.dataset.type,
                status: el.querySelector('.request-status').textContent,
                statusClass: el.querySelector('.request-status').className,
                note: note ? note.textContent : null,
                described: note ? el.querySelector('.url-toggle').getAttribute('aria-describedby') === note.id : null
            };
        }, name);

        test('a request-body entry is labelled "Request body" and is not shown as pending', async () => {
            await seedLog();
            await openPanel();
            expect(await row('Patch role')).toMatchObject({
                badge: 'Request body',
                badgeType: 'requestBody',
                status: 'modified',
                note: 'Request body patched',
                described: true
            });
            expect((await row('Patch role')).statusClass).toMatch(/status-neutral/);
        });

        test('observer entries show their note, and "applied" rather than "pending" when no status exists', async () => {
            await seedLog();
            await openPanel();
            expect(await row('Add header')).toMatchObject({ badge: 'headers', status: 'applied', note: OBSERVED, described: true });
            expect((await row('Add header')).statusClass).toMatch(/status-neutral/);
            // A request-side block with no status is blocked, and says so.
            expect(await row('Block script')).toMatchObject({ badge: 'block', status: 'blocked', note: OBSERVED });
            // A response-side rule carries Chrome's status code.
            expect(await row('Strip param')).toMatchObject({ badge: 'queryparams', status: '200' });
            // A redirect keeps its destination.
            expect((await row('Swap script')).status).toMatch(/redirected via https:\/\/example\.com\/a\.js/);
            // Interceptor entries are unchanged.
            expect(await row('Plain mock')).toMatchObject({ badge: 'mock', status: '200', note: null });
        });

        test('observer and request-body entries with no numeric status stay out of the 2xx rate', async () => {
            await h.reset();
            for (const id of ['a', 'b', 'c', 'd']) await h.saveRule(mock(id));
            const t0 = Date.now();
            const entry = (n, over) => ({ ts: t0 + n, url: `${h.baseUrl}/api/${over.ruleId}`, method: 'GET', kind: 'rule', ...over });
            await h.bg({
                type: 'logInterceptionBatch',
                entries: [
                    entry(0, { ruleId: 'a', ruleName: 'Seen, no status', ruleType: 'headers', note: OBSERVED }),
                    entry(1, { ruleId: 'b', ruleName: 'Seen, 500', ruleType: 'headers', finalStatus: 500, note: OBSERVED }),
                    entry(2, { ruleId: 'c', ruleName: 'Body, no status', ruleType: 'requestBody', note: 'Request body replaced' }),
                    entry(3, { ruleId: 'd', ruleName: 'Mock 200', ruleType: 'mock', status: 200 })
                ]
            });
            panel = await h.browser.newPage();
            await panel.setViewport({ width: 900, height: 600 });
            await panel.goto(h.extUrl('devtools/panel.html'), { waitUntil: 'load' });
            await waitFor(async () => (await panel.$$('#requestItems [role="row"]')).length === 4, { label: 'four rows' });
            // One 200 and one 500 count; the two without a status do not.
            expect(await panel.$eval('#successRate', (el) => el.textContent)).toBe('50%');
        });

        test('the type filter has a "Request body" option that shows only those entries', async () => {
            await seedLog();
            await openPanel();
            const options = await panel.$$eval('#filterType option', (els) => els.map((o) => [o.value, o.textContent.trim()]));
            expect(options).toContainEqual(['requestBody', 'Request body']);

            await panel.select('#filterType', 'requestBody');
            await waitFor(async () => (await panel.$$('#requestItems [role="row"]')).length === 1, { label: 'one row' });
            expect(await panel.$eval('#requestItems .rule-name', (el) => el.textContent)).toBe('Patch role');

            await panel.select('#filterType', 'headers');
            await waitFor(async () => (await panel.$eval('#requestItems .rule-name', (el) => el.textContent)) === 'Add header', { label: 'headers only' });
        });

        test('the live region announces a new request-body entry by its outcome', async () => {
            await seedLog();
            await openPanel();
            await h.bg({ type: 'logInterceptionBatch', entries: [{ ts: Date.now(), url: `${h.baseUrl}/api/body?again=1`, method: 'POST', ruleId: 'body', ruleName: 'Patch role', ruleType: 'requestBody', kind: 'rule' }] });
            // The panel polls every 3 s.
            await waitFor(async () => /New request logged: POST .* — modified \(Patch role\)/.test(await panel.$eval('#logAnnouncer', (el) => el.textContent)), { timeout: 8000, label: 'announcement' });
        });

        test.each(['dark', 'light'])('the panel has no WCAG A/AA violations with these rows (%s theme)', async (theme) => {
            await seedLog();
            await openPanel(theme);
            await waitFor(() => panel.evaluate((t) => document.body.classList.contains('theme-' + t), theme), { label: 'the theme applied' });
            await sleep(500);
            expect(await auditA11y(panel)).toEqual([]);
        });

        test('in forced colours the new badge keeps its outline', async () => {
            await seedLog();
            await openPanel();
            const cdp = await panel.createCDPSession();
            await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
            await sleep(200);
            const border = await panel.$eval('.rule-type-badge[data-type="requestBody"]', (el) => window.getComputedStyle(el).borderTopWidth);
            expect(border).toBe('1px');
        });
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
