/**
 * Batch 2, group G6 "popup + panel": the Requestly import flow (F6), the
 * per-tab status line (PER-58), shadowing chips (PER-59), the capture to
 * editor hand-off (PER-60), the DevTools row actions (PER-57), and two fix-ups.
 *
 * Other groups write the pieces these lean on, so until the branches merge:
 *   - the Requestly converter (src/importers/requestly.js) is stood in for by a
 *     stub the tests install on the popup page;
 *   - the background's `explainMatch` is stood in for by wrapping
 *     chrome.runtime.sendMessage in the popup page before it loads.
 * Tests that can only pass with the real thing are marked afterMerge.
 */

const { launch, pageFetch, waitFor, sleep, auditA11y } = require('./harness');

// The coordinator flips this to `test` once every group is merged.
const afterMerge = test.failing; // coordinator flips

const POPUP_SIZE = { width: 400, height: 600 };

const rule = (id, overrides = {}) => ({
    id,
    name: `Rule ${id}`,
    enabled: true,
    type: 'mock',
    match: { url: `*/api/${id}*`, method: 'GET' },
    response: { statusCode: 200, headers: {}, body: {}, delay: 0, mode: 'static' },
    ...overrides
});

describe('batch 2: popup and DevTools panel', () => {
    let h;
    let popup;
    let page;
    let panel;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => {
        for (const p of [popup, page, panel]) if (p && !p.isClosed()) await p.close();
        popup = null;
        page = null;
        panel = null;
    });

    /**
     * Seed rules, then open a fresh popup at its real size. `beforeLoad` is a
     * function run in the popup page before any of its own script, which is
     * where a stub for a background message has to go.
     */
    async function openPopup(rules = [], { settings = {}, viewport = POPUP_SIZE, beforeLoad = null, beforeLoadArg = null, reset = true } = {}) {
        if (reset) await h.reset();
        await h.bg({ type: 'settingsUpdated', settings });
        for (const r of rules) await h.saveRule(r);
        popup = await h.browser.newPage();
        popup.on('pageerror', (e) => h.record({ where: 'popup', text: 'pageerror: ' + e.message }));
        popup.on('console', (m) => { if (m.type() === 'error') h.record({ where: 'popup', text: m.text() }); });
        await popup.setViewport(viewport);
        if (beforeLoad) await popup.evaluateOnNewDocument(beforeLoad, beforeLoadArg);
        await popup.goto(h.extUrl('popup/popup.html'), { waitUntil: 'load' });
        await popup.waitForSelector('#rulesContainer');
        await sleep(200);
        return popup;
    }

    /** Wait out transitions and move the pointer off everything, so an audit reads settled colours. */
    async function settle(p) {
        await p.mouse.move(0, 0);
        await p.evaluate(() => Promise.race([
            Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))),
            new Promise((resolve) => setTimeout(resolve, 2000))
        ]));
        await sleep(100);
    }

    const storedRules = async () => (await h.bg({ type: 'getRules' })).rules;
    const toastTexts = () => popup.evaluate(() =>
        Array.from(document.querySelectorAll('.toast:not(.closing)')).map((t) => t.innerText.replace(/\s+/g, ' ').trim()));
    const liveText = () => popup.$eval('#liveRegion', (r) => r.textContent);

    // ================================================================ F6 ===
    describe('B2-F6: importing a Requestly export', () => {
        // What a Requestly export looks like (shared/src/types/entities/rules).
        const requestlyRule = (id, ruleType, name, extra = {}) => ({
            id, name, description: '', status: 'Active', objectType: 'rule', ruleType, schemaVersion: '3.0.0',
            pairs: [{ id: `${id}_p`, source: { key: 'Url', operator: 'Contains', value: `/api/${id}` } }],
            ...extra
        });
        const EXPORT = [
            requestlyRule('ads', 'Cancel', 'Block ads'),
            requestlyRule('slow', 'Delay', 'Slow users', { status: 'Inactive' }),
            requestlyRule('inject', 'Script', 'Inject banner')
        ];

        // Stands in for src/importers/requestly.js until that group merges.
        function installStubImporter(p, { throwOnConvert = false } = {}) {
            return p.evaluate((boom) => {
                window.SpliceTapImporters = window.SpliceTapImporters || {};
                window.__converted = [];
                window.SpliceTapImporters.requestly = {
                    detect: (json) => Array.isArray(json) && json.some((i) => i && typeof i.ruleType === 'string' && Array.isArray(i.pairs)),
                    convert: (json) => {
                        window.__converted.push(json.length);
                        if (boom) throw new Error('converter exploded');
                        return {
                            rules: [
                                { id: 'c1', name: 'Block ads', enabled: true, type: 'block', appliesTo: 'all', match: { url: '*/api/ads*', method: 'GET' } },
                                { id: 'c2', name: 'Slow users', enabled: false, type: 'delay', delayMs: 300, match: { url: '*/api/slow*', method: 'GET' } }
                            ],
                            skipped: [{ name: 'Inject banner', reason: 'Script rules are not supported' }],
                            warnings: [{ name: 'Slow users', message: 'Only fetch and XHR requests are delayed' }]
                        };
                    }
                };
            }, throwOnConvert);
        }

        async function paste(json, { fire = true, replace = false } = {}) {
            await popup.click('#tabData');
            await popup.click('#importToggleBtn');
            if (replace) await popup.click('#importMerge');
            await popup.$eval('#importJson', (el, v, f) => {
                el.value = v;
                if (f) el.dispatchEvent(new Event('input', { bubbles: true }));
            }, JSON.stringify(json), fire);
        }

        const offerState = () => popup.evaluate(() => {
            const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.getClientRects().length > 0; };
            const convert = document.getElementById('importConvertBtn');
            return {
                convert: vis('importConvertBtn') ? convert.textContent.trim() : null,
                importVisible: vis('importConfirmBtn'),
                note: vis('importOffer') ? document.getElementById('importOffer').textContent.trim() : null
            };
        });

        test('pasting an export offers "Convert 3 Requestly rules" in place of Import, with no error', async () => {
            await openPopup([rule('mine', { name: 'Mine' })]);
            await installStubImporter(popup);
            await paste(EXPORT);
            await waitFor(async () => (await offerState()).convert, { label: 'the Convert action' });

            const state = await offerState();
            expect(state.convert).toBe('Convert 3 Requestly rules');
            expect(state.importVisible).toBe(false);
            expect(state.note).toMatch(/looks like a Requestly export with 3 rules/);
            expect(await toastTexts()).toEqual([]);
            expect(await liveText()).toMatch(/Requestly export with 3 rules/);
            // Offering is not importing.
            expect((await storedRules()).map((r) => r.name)).toEqual(['Mine']);
        });

        test('clicking Import on an export whose paste raised no input event shows the action and focuses it', async () => {
            await openPopup([rule('mine', { name: 'Mine' })]);
            await installStubImporter(popup);
            await paste(EXPORT, { fire: false });
            expect((await offerState()).convert).toBeNull();

            await popup.click('#importConfirmBtn');
            await waitFor(async () => (await offerState()).convert, { label: 'the Convert action' });
            expect(await popup.evaluate(() => document.activeElement.id)).toBe('importConvertBtn');
            expect(await toastTexts()).toEqual([]); // the old error toast is gone
            expect((await storedRules()).map((r) => r.name)).toEqual(['Mine']);
        });

        test('Convert imports after the existing rules, keeps each rule\'s enabled flag, and leaves a report of converted, skipped and warnings', async () => {
            await openPopup([rule('mine', { name: 'Mine' })]);
            await installStubImporter(popup);
            await paste(EXPORT);
            await waitFor(async () => (await offerState()).convert, { label: 'the Convert action' });
            await popup.click('#importConvertBtn');
            await popup.waitForSelector('#importReport:not([hidden])');

            const rules = await storedRules();
            expect(rules.map((r) => r.name)).toEqual(['Mine', 'Block ads', 'Slow users']);
            expect(rules.map((r) => r.enabled)).toEqual([true, true, false]);

            const report = await popup.$eval('#importReport', (el) => ({
                cls: el.className,
                title: el.querySelector('.import-report-title').textContent,
                text: el.innerText.replace(/\s+/g, ' ').trim(),
                headings: Array.from(el.querySelectorAll('h4')).map((x) => x.textContent),
                converted: Array.from(el.querySelectorAll('.import-report-names li')).map((x) => x.textContent)
            }));
            expect(report.title).toBe('Converted 2 of 3 Requestly rules, imported 2, skipped 1 (1 not converted)');
            expect(report.cls).toContain('is-error'); // something was left out
            expect(report.headings).toEqual(['Skipped (1)', 'Warnings (1)']);
            expect(report.text).toMatch(/Inject banner\s*Script rules are not supported/);
            expect(report.text).toMatch(/Slow users\s*Only fetch and XHR requests are delayed/);
            expect(report.converted).toEqual(['Block ads', 'Slow users']);

            // The panel closed, the box is empty, and the report outlives the toast.
            expect(await popup.$eval('#importPanel', (p) => p.hidden)).toBe(true);
            expect(await popup.$eval('#importJson', (t) => t.value)).toBe('');
            await sleep(3600);
            expect(await popup.$eval('#importReport', (el) => !el.hidden && /Inject banner/.test(el.textContent))).toBe(true);
        });

        test('a conversion with nothing skipped still leaves its report, in the quiet style', async () => {
            await openPopup([]);
            await popup.evaluate(() => {
                window.SpliceTapImporters = { requestly: {
                    detect: () => true,
                    convert: () => ({ rules: [{ id: 'c1', name: 'Only', enabled: true, type: 'block', match: { url: '*/api/only*', method: 'GET' } }], skipped: [], warnings: [] })
                } };
            });
            await paste([requestlyRule('only', 'Cancel', 'Only')]);
            await popup.waitForSelector('#importConvertBtn:not([hidden])');
            await popup.click('#importConvertBtn');
            await popup.waitForSelector('#importReport:not([hidden])');
            const report = await popup.$eval('#importReport', (el) => ({ cls: el.className, title: el.querySelector('.import-report-title').textContent }));
            expect(report.title).toBe('Converted 1 of 1 Requestly rule, imported 1');
            expect(report.cls).not.toContain('is-error');
        });

        test('converting the same export twice skips the second as duplicates (the existing dedupe path)', async () => {
            await openPopup([]);
            await installStubImporter(popup);
            await paste(EXPORT);
            await popup.waitForSelector('#importConvertBtn:not([hidden])');
            await popup.click('#importConvertBtn');
            await waitFor(async () => (await storedRules()).length === 2, { label: 'first import' });

            await paste(EXPORT);
            await popup.waitForSelector('#importConvertBtn:not([hidden])');
            await popup.click('#importConvertBtn');
            await waitFor(() => popup.$eval('#importReport .import-report-title', (t) => /Imported|Converted 2 of 3 Requestly rules, imported 0/.test(t.textContent)), { label: 'second report' });

            expect(await storedRules()).toHaveLength(2);
            const text = await popup.$eval('#importReport', (el) => el.innerText.replace(/\s+/g, ' '));
            expect(text).toMatch(/imported 0, skipped 3 \(1 not converted, 2 duplicates\)/);
            expect(text).toMatch(/Exact duplicate of "Block ads"/);
        });

        test('in replace mode Convert asks to confirm first, then replaces', async () => {
            await openPopup([rule('mine', { name: 'Mine' }), rule('other', { name: 'Other' })]);
            await installStubImporter(popup);
            await paste(EXPORT, { replace: true });
            await popup.waitForSelector('#importConvertBtn:not([hidden])');
            expect(await offerState()).toMatchObject({ convert: 'Replace all 2 with 3 converted' });

            await popup.click('#importConvertBtn');
            await popup.waitForSelector('#importReplaceWarn:not([hidden])');
            expect(await popup.$eval('#importConvertBtn', (b) => b.textContent)).toMatch(/Replace all 2 rules — confirm/);
            expect((await storedRules()).map((r) => r.name)).toEqual(['Mine', 'Other']); // nothing yet

            await popup.click('#importConvertBtn');
            await waitFor(async () => (await storedRules()).map((r) => r.name).join() === 'Block ads,Slow users', { label: 'replacement' });
            expect(await popup.$eval('#importReport .import-report-title', (t) => t.textContent)).toMatch(/replacing 2/);
        });

        test('editing the box so it is no longer an export takes the action away', async () => {
            await openPopup([]);
            await installStubImporter(popup);
            await paste(EXPORT);
            await popup.waitForSelector('#importConvertBtn:not([hidden])');
            await popup.$eval('#importJson', (el) => { el.value = '[]'; el.dispatchEvent(new Event('input', { bubbles: true })); });
            await waitFor(async () => (await offerState()).convert === null, { label: 'the action to go' });
            expect((await offerState()).importVisible).toBe(true);
        });

        test('a converter that throws is reported, imports nothing, and keeps the panel open', async () => {
            await openPopup([rule('mine', { name: 'Mine' })]);
            await installStubImporter(popup, { throwOnConvert: true });
            await paste(EXPORT);
            await popup.waitForSelector('#importConvertBtn:not([hidden])');
            await popup.click('#importConvertBtn');
            await waitFor(async () => (await toastTexts()).some((t) => /Could not convert the Requestly rules: converter exploded/.test(t)), { label: 'an error toast' });
            expect((await storedRules()).map((r) => r.name)).toEqual(['Mine']);
            expect(await popup.$eval('#importPanel', (p) => p.hidden)).toBe(false);
        });

        test('with no converter loaded the old explanation stands, and nothing is imported', async () => {
            await openPopup([]);
            await popup.evaluate(() => { window.SpliceTapImporters = {}; });
            await paste(EXPORT);
            await popup.click('#importConfirmBtn');
            await waitFor(async () => (await toastTexts()).some((t) => /looks like a Requestly export, but the converter is not available/.test(t)), { label: 'the explanation' });
            expect(await storedRules()).toEqual([]);
            expect((await offerState()).convert).toBeNull();
        });

        test('SpliceTap\'s own export still imports through the plain path with the converter loaded', async () => {
            await openPopup([]);
            await installStubImporter(popup);
            await paste([{ id: 'x', name: 'Plain', enabled: true, type: 'block', match: { url: '*/plain*', method: 'GET' } }]);
            await sleep(400);
            expect((await offerState()).convert).toBeNull();
            await popup.click('#importConfirmBtn');
            await waitFor(async () => (await storedRules()).length === 1, { label: 'plain import' });
            expect(await popup.evaluate(() => window.__converted.length)).toBe(0);
            expect(await popup.$eval('#importReport', (el) => el.hidden)).toBe(true);
        });

        test.each(['dark', 'light'])('axe: the offer, and the report with converted, skipped and warnings (%s)', async (theme) => {
            await openPopup([rule('mine', { name: 'Mine' })], { settings: { theme } });
            await installStubImporter(popup);
            await paste(EXPORT);
            await popup.waitForSelector('#importConvertBtn:not([hidden])');
            await settle(popup);
            expect(await auditA11y(popup)).toEqual([]);

            await popup.click('#importConvertBtn');
            await popup.waitForSelector('#importReport:not([hidden])');
            await popup.click('#importReport summary'); // open the converted list too
            await settle(popup);
            expect(await auditA11y(popup)).toEqual([]);
        });

        // The real converter, once G4 has merged: a Requestly export in, rules
        // that pass the schema out, through the same popup.
        afterMerge('with the real converter: a Requestly export becomes rules, and the Script rule is reported as skipped', async () => {
            await openPopup([]);
            await paste(EXPORT);
            await popup.waitForSelector('#importConvertBtn:not([hidden])', { timeout: 3000 });
            await popup.click('#importConvertBtn');
            await popup.waitForSelector('#importReport:not([hidden])');
            const rules = await storedRules();
            expect(rules.map((r) => r.name)).toEqual(['Block ads', 'Slow users']);
            expect(rules[0]).toMatchObject({ type: 'block', appliesTo: 'all', enabled: true });
            expect(rules[1]).toMatchObject({ type: 'delay', enabled: false });
            expect(await popup.$eval('#importReport', (el) => el.innerText)).toMatch(/Inject banner/);
        });
    });

    // ============================================================ PER-58 ===
    describe('PER-58: the per-tab status line', () => {
        /** The id Chrome gave the test page's tab, found the way the harness finds it for the overlay. */
        const tabIdOf = (p) => h.control.evaluate(async (url) => {
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find((t) => t.url === url);
            return tab ? tab.id : null;
        }, p.url());

        /** The popup sees `tab` as the active tab, as it does when opened from the toolbar on that page. */
        const asActiveTab = (tab) => (arg) => {
            chrome.tabs.query = async () => [arg];
        };
        const statusText = () => popup.$eval('#tabStatus', (e) => (e.hidden ? null : e.textContent.trim()));

        test('says nothing has been intercepted on a tab with no traffic', async () => {
            await h.reset();
            page = await h.openPage();
            await openPopup([rule('users')], { beforeLoad: asActiveTab(), beforeLoadArg: { id: await tabIdOf(page), url: page.url(), active: true } });
            await waitFor(statusText, { label: 'the status line' });
            expect(await statusText()).toBe('Nothing intercepted on this tab yet');
        });

        test('counts what was intercepted on that tab and says how long ago', async () => {
            await h.reset();
            await h.saveRule(rule('users'));
            page = await h.openPage();
            await waitFor(async () => (await pageFetch(page, '/api/users')).marker === 'true', { label: 'mock active' });
            await pageFetch(page, '/api/users?again=1');
            const tabId = await tabIdOf(page);
            await waitFor(async () => (await h.bg({ type: 'getInterceptionLog', tabId })).entries.length >= 2, { label: 'two log entries' });

            await openPopup([], { reset: false, beforeLoad: asActiveTab(), beforeLoadArg: { id: tabId, url: page.url(), active: true } });
            await waitFor(async () => /^This tab: \d+ intercepted · last \d+ s ago$/.test(await statusText() || ''), { label: 'the status line' });
            const n = Number((await statusText()).match(/This tab: (\d+)/)[1]);
            expect(n).toBeGreaterThanOrEqual(2);

            // A new request moves the count on the next refresh.
            await pageFetch(page, '/api/users?third=1');
            await waitFor(async () => (await h.bg({ type: 'getInterceptionLog', tabId })).entries.length > n, { label: 'third entry' });
            await popup.click('#refreshBtn');
            await waitFor(async () => Number(((await statusText()) || '').match(/This tab: (\d+)/)?.[1]) > n, { label: 'the count to rise' });
        });

        test('counts only the active tab: another tab\'s traffic is not in it', async () => {
            await h.reset();
            await h.saveRule(rule('users'));
            page = await h.openPage();
            const other = await h.openPage();
            await waitFor(async () => (await pageFetch(other, '/api/users')).marker === 'true', { label: 'mock active' });
            await pageFetch(other, '/api/users?x=1');
            await waitFor(async () => (await h.bg({ type: 'getInterceptionLog' })).entries.length >= 2, { label: 'entries' });
            const quiet = await tabIdOf(page);
            await other.close();

            popup = await h.browser.newPage();
            await popup.evaluateOnNewDocument(asActiveTab(), { id: quiet, url: page.url(), active: true });
            await popup.goto(h.extUrl('popup/popup.html'), { waitUntil: 'load' });
            await waitFor(statusText, { label: 'the status line' });
            expect(await statusText()).toBe('Nothing intercepted on this tab yet');
        });

        test('is a plain line under the header: not a live region, and no axe violations (dark and light)', async () => {
            for (const theme of ['dark', 'light']) {
                await h.reset();
                page = await h.openPage();
                await openPopup([rule('users')], { settings: { theme }, beforeLoad: asActiveTab(), beforeLoadArg: { id: await tabIdOf(page), url: page.url(), active: true } });
                await waitFor(statusText, { label: 'the status line' });
                const info = await popup.$eval('#tabStatus', (e) => ({
                    live: e.closest('[aria-live]'), prevIsHeader: e.previousElementSibling.classList.contains('header')
                }));
                expect(info).toEqual({ live: null, prevIsHeader: true });
                await settle(popup);
                expect(await auditA11y(popup)).toEqual([]);
                await popup.close();
                await page.close();
            }
        });
    });

    // ============================================================ PER-59 ===
    describe('PER-59: "Shadowed by" chips', () => {
        // Stands in for the background's explainMatch (another group) by answering it
        // in the popup page, and notes how many rows were on screen when each question was asked.
        const stubExplain = (cfg) => {
            const original = chrome.runtime.sendMessage.bind(chrome.runtime);
            window.__explainCalls = [];
            chrome.runtime.sendMessage = (message, ...rest) => {
                if (message && message.type === 'explainMatch') {
                    window.__explainCalls.push({ ruleId: message.ruleId, cards: document.querySelectorAll('.rule-card').length });
                    const answer = (cfg.needsUrl || []).includes(message.ruleId)
                        ? { success: true, needsUrl: true, shadowedBy: [] }
                        : { success: true, url: 'https://example.test/x', result: {}, shadowedBy: (cfg.shadows || {})[message.ruleId] || [], network: false };
                    return new Promise((resolve) => setTimeout(() => resolve(answer), cfg.delayMs || 0));
                }
                return original(message, ...rest);
            };
        };
        const calls = () => popup.evaluate(() => window.__explainCalls);
        const chips = () => popup.$$eval('.rule-card', (cards) => cards.map((c) => {
            const chip = c.querySelector('.rule-shadow-chip');
            return { id: c.dataset.ruleId, chip: chip ? chip.textContent : null };
        }));
        const RULES = [rule('broad', { name: 'Broad', match: { url: '*/api/*', method: 'GET' } }), rule('users', { name: 'Users' }), rule('rx', { name: 'Regex', match: { url: '/api\\/rx/', method: 'GET' } })];
        const CFG = { shadows: { users: [{ ruleId: 'broad', ruleName: 'Broad' }] }, needsUrl: ['rx'] };

        test('a shadowed rule\'s row says "Shadowed by <name>"; the rest do not, and a regex rule is never asked about', async () => {
            await openPopup(RULES, { beforeLoad: stubExplain, beforeLoadArg: CFG });
            await waitFor(async () => (await chips()).some((c) => c.chip), { label: 'a chip' });
            expect(await chips()).toEqual([
                { id: 'broad', chip: null },
                { id: 'users', chip: 'Shadowed by Broad' },
                { id: 'rx', chip: null }
            ]);
            expect((await calls()).map((c) => c.ruleId).sort()).toEqual(['broad', 'users']);
            // The chip sits on the detail line with the other chips, before the URL.
            expect(await popup.$eval('.rule-card[data-rule-id="users"] .rule-details', (d) =>
                d.querySelector('.rule-shadow-chip').nextElementSibling.classList.contains('rule-url'))).toBe(true);
        });

        test('it is asked after the rows are on screen: the first render does not wait for it', async () => {
            await openPopup(RULES, { beforeLoad: stubExplain, beforeLoadArg: { ...CFG, delayMs: 1500 } });
            // All three rows are drawn while the answers are still 1.5 s away...
            expect(await popup.$$eval('.rule-card', (c) => c.length)).toBe(3);
            expect((await chips()).every((c) => c.chip === null)).toBe(true);
            await waitFor(async () => (await calls()).length >= 1, { label: 'the first question' });
            // ...and every question was asked with all of them already there.
            expect((await calls()).every((c) => c.cards === 3)).toBe(true);
            await waitFor(async () => (await chips()).some((c) => c.chip), { label: 'the chip', timeout: 6000 });
        });

        test('typing in the search box does not ask again, and the chip survives the redraw', async () => {
            await openPopup(RULES, { beforeLoad: stubExplain, beforeLoadArg: CFG });
            await waitFor(async () => (await chips()).some((c) => c.chip), { label: 'a chip' });
            const before = (await calls()).length;
            await popup.type('#searchInput', 'users');
            await sleep(500);
            expect(await chips()).toEqual([{ id: 'users', chip: 'Shadowed by Broad' }]);
            expect((await calls()).length).toBe(before);
        });

        test('switching a rule on or off asks again, because who shadows whom has changed', async () => {
            await openPopup(RULES, { beforeLoad: stubExplain, beforeLoadArg: CFG });
            await waitFor(async () => (await calls()).length >= 2, { label: 'first pass' });
            const before = (await calls()).length;
            await popup.click('.rule-checkbox[data-rule-id="broad"]');
            await waitFor(async () => (await calls()).length >= before + 2, { label: 'a second pass' });
        });

        test.each(['dark', 'light'])('axe: shadow chips on an enabled and a disabled row (%s)', async (theme) => {
            await openPopup([RULES[0], { ...RULES[1], enabled: false }], {
                settings: { theme }, beforeLoad: stubExplain, beforeLoadArg: CFG
            });
            await waitFor(async () => (await chips()).some((c) => c.chip), { label: 'a chip' });
            await settle(popup);
            expect(await auditA11y(popup)).toEqual([]);
        });

        test('in forced colours the chip keeps an outline', async () => {
            await openPopup(RULES, { beforeLoad: stubExplain, beforeLoadArg: CFG });
            const cdp = await popup.createCDPSession();
            await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
            await waitFor(async () => (await chips()).some((c) => c.chip), { label: 'a chip' });
            expect(await popup.$eval('.rule-shadow-chip', (c) => window.getComputedStyle(c).borderTopWidth)).toBe('1px');
        });

        afterMerge('with the real background: a broad rule above a narrow one puts the chip on the narrow one', async () => {
            await openPopup([rule('broad', { name: 'Broad', match: { url: '*/api/*', method: 'GET' } }), rule('users', { name: 'Users' })]);
            await waitFor(async () => (await chips()).some((c) => c.chip), { label: 'a chip', timeout: 4000 });
            expect(await chips()).toEqual([{ id: 'broad', chip: null }, { id: 'users', chip: 'Shadowed by Broad' }]);
        });
    });

    // ============================================================ PER-60 ===
    describe('PER-60: capture to editor hand-off', () => {
        const ed = require('./editor-driver');

        /**
         * The popup's view of the world: `tab` is the active tab (or null to leave Chrome's answer alone),
         * sendMessage to it is recorded, and either passed through or refused as a tab with no content
         * script would; chrome.tabs.create and window.close are recorded, not obeyed.
         */
        const handOffEnv = ({ tab, refuse }) => {
            window.__sent = [];
            window.__created = [];
            window.__closed = 0;
            window.close = () => { window.__closed++; };
            if (tab) chrome.tabs.query = async () => [tab];
            const send = chrome.tabs.sendMessage.bind(chrome.tabs);
            chrome.tabs.sendMessage = async (id, message, ...rest) => {
                window.__sent.push({ id, message });
                if (refuse) throw new Error('Could not establish connection. Receiving end does not exist.');
                return send(id, message, ...rest);
            };
            chrome.tabs.create = async (props) => { window.__created.push(props.url); return {}; };
        };

        /** A page on the test origin whose real response has been captured; returns its tab id. */
        async function pageWithCapture() {
            await h.reset();
            await h.bg({ type: 'setCaptureArmed', armed: true });
            page = await h.openPage();
            await waitFor(async () => {
                await pageFetch(page, '/api/readme-user');
                return (await h.bg({ type: 'getCaptures' })).captures.length >= 1;
            }, { label: 'a capture' });
            await h.bg({ type: 'setCaptureArmed', armed: false });
            return h.control.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, page.url());
        }

        async function clickCapture(action) {
            await popup.bringToFront();
            await popup.reload({ waitUntil: 'load' });
            await popup.click('#tabData');
            await popup.waitForSelector(`[data-capture-action="${action}"]`);
            await popup.click(`[data-capture-action="${action}"]`);
        }
        const sent = () => popup.evaluate(() => window.__sent);
        const created = () => popup.evaluate(() => window.__created);

        test.each(['mock', 'patch'])('%s: opens the editor on the active tab with the rule and the captured body, still switching to the Rules tab', async (action) => {
            const tabId = await pageWithCapture();
            await openPopup([], { reset: false, beforeLoad: handOffEnv, beforeLoadArg: { tab: { id: tabId, url: page.url(), active: true } } });
            await clickCapture(action);

            const stored = await waitFor(async () => (await storedRules())[0], { label: 'the new rule' });
            await waitFor(async () => (await sent()).length === 1, { label: 'the hand-off message' });
            const [{ id, message }] = await sent();
            const body = (await h.bg({ type: 'getCaptures' })).captures[0].body;
            expect(id).toBe(tabId);
            expect(Object.keys(message).sort()).toEqual(['mode', 'referenceBody', 'rule', 'type']);
            expect(message).toMatchObject({ type: 'openRuleOverlay', mode: 'edit', referenceBody: body });
            expect(message.rule.id).toBe(stored.id);
            expect(message.rule.response.mode).toBe(action === 'patch' ? 'patch' : 'static');

            // The page's editor really opened, on the new rule, and nothing fell back.
            await waitFor(() => ed.isOpen(page), { label: 'the editor on the page' });
            expect(await created()).toEqual([]);
            // Rules tab, as before, and the popup then closes.
            expect(await popup.$eval('#tabRules', (t) => t.getAttribute('aria-selected'))).toBe('true');
            await waitFor(() => popup.evaluate(() => window.__closed >= 1), { label: 'the popup to close' });
        });

        test('with no content script on the tab it falls back to options.html?editRule=<id>', async () => {
            const tabId = await pageWithCapture();
            await openPopup([], { reset: false, beforeLoad: handOffEnv, beforeLoadArg: { tab: { id: tabId, url: page.url(), active: true }, refuse: true } });
            await clickCapture('mock');
            const stored = await waitFor(async () => (await storedRules())[0], { label: 'the new rule' });
            await waitFor(async () => (await created()).length === 1, { label: 'the fallback tab' });
            expect(await created()).toEqual([h.extUrl(`options/options.html?editRule=${encodeURIComponent(stored.id)}`)]);
            expect(await popup.$eval('#tabRules', (t) => t.getAttribute('aria-selected'))).toBe('true');
            // No "Reload this tab" banner: the rule was made, and it needs editing.
            expect(await popup.$('#reloadNotice')).toBeNull();
        });

        test('on a tab that cannot host a content script it goes straight to the options page', async () => {
            const tabId = await pageWithCapture();
            await openPopup([], { reset: false, beforeLoad: handOffEnv, beforeLoadArg: { tab: { id: tabId, url: 'chrome://newtab/', active: true } } });
            await clickCapture('mock');
            const stored = await waitFor(async () => (await storedRules())[0], { label: 'the new rule' });
            await waitFor(async () => (await created()).length === 1, { label: 'the fallback tab' });
            expect(await sent()).toEqual([]);
            expect((await created())[0]).toContain(`options/options.html?editRule=${encodeURIComponent(stored.id)}`);
        });

        test('a refused save hands nothing off', async () => {
            const tabId = await pageWithCapture();
            await openPopup([], { reset: false, beforeLoad: handOffEnv, beforeLoadArg: { tab: { id: tabId, url: page.url(), active: true } } });
            await popup.bringToFront();
            await popup.reload({ waitUntil: 'load' });
            await popup.click('#tabData');
            await popup.waitForSelector('[data-capture-action="mock"]');
            await popup.evaluate(() => {
                const p = window.spliceTapPopup;
                const original = p.sendMessage.bind(p);
                p.sendMessage = async (m) => (m && m.type === 'saveRule' ? { success: false, error: 'nope' } : original(m));
            });
            await popup.click('[data-capture-action="mock"]');
            await waitFor(async () => (await toastTexts()).some((t) => /nope/.test(t)), { label: 'the refusal' });
            expect(await sent()).toEqual([]);
            expect(await created()).toEqual([]);
        });
    });

    test('ran without errors', async () => {
        await openPopup([rule('a')]);
        // Until the importer group merges, popup.html's <script src="../src/importers/requestly.js"> 404s on
        // every popup load. That one message is expected here and goes away with the merge.
        const missingImporter = (e) => e.where !== 'page' && /ERR_FILE_NOT_FOUND/.test(e.text);
        expect(h.allErrors.filter((e) => !missingImporter(e))).toEqual([]);
    });
});
