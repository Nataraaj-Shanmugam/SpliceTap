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
    async function openPopup({ rules = [], settings = {}, permission = {} } = {}) {
        await h.reset();
        await setSettings({ observeNetworkRules: false, allowCodeResponses: false, theme: 'dark', ...settings });
        for (const r of rules) await h.saveRule(r);

        popup = await h.browser.newPage();
        popup.on('pageerror', (e) => h.record({ where: 'popup', text: 'pageerror: ' + e.message }));
        popup.on('console', (m) => { if (m.type() === 'error') h.record({ where: 'popup', text: m.text() }); });
        await popup.setViewport(POPUP_SIZE);
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
                return realSend(message, ...rest);
            };
        }, permission);
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
            expect((await settingsNow()).allowCodeResponses).toBe(true);
            expect(await noteText('codeWarn')).toMatch(/JavaScript/);
            expect(await popup.$eval('#allowCodeResponses', (el) => el.getAttribute('aria-describedby'))).toBe('codeWarn');
            // It is a single line of copy, not a paragraph.
            expect(await popup.$eval('#codeWarn', (el) => el.textContent.length)).toBeLessThan(110);
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
            await openPopup();
            const cdp = await popup.createCDPSession();
            await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
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

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
