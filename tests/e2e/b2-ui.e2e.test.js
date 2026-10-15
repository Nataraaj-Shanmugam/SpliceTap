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
    async function openPopup(rules = [], { settings = {}, viewport = POPUP_SIZE, beforeLoad = null, beforeLoadArg = null } = {}) {
        await h.reset();
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
            await popup.evaluate(() => { delete window.SpliceTapImporters.requestly; });
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

    test('ran without errors', async () => {
        await openPopup([rule('a')]);
        expect(h.allErrors).toEqual([]);
    });
});
