/**
 * The popup, rendered by Chrome at its real size and driven like a user
 * would: clicks, keyboard, and what ends up in storage as a result.
 */

const { launch, waitFor, sleep, auditA11y } = require('./harness');

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

describe('popup', () => {
    let h;
    let popup;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (popup && !popup.isClosed()) await popup.close(); popup = null; });

    /** Seed rules, then open a fresh popup at its real size. */
    async function openPopup(rules = []) {
        await h.reset();
        for (const r of rules) await h.saveRule(r);
        popup = await h.browser.newPage();
        popup.on('pageerror', (e) => h.record({ where: 'popup', text: 'pageerror: ' + e.message }));
        popup.on('console', (m) => { if (m.type() === 'error') h.record({ where: 'popup', text: m.text() }); });
        await popup.setViewport(POPUP_SIZE);
        await popup.goto(h.extUrl('popup/popup.html'), { waitUntil: 'load' });
        await popup.waitForSelector('#rulesContainer');
        await sleep(150);
        return popup;
    }

    const storedRules = async () => (await h.bg({ type: 'getRules' })).rules;
    const cardIds = () => popup.$$eval('.rule-card[data-rule-id]', (els) => els.map((e) => e.dataset.ruleId));

    // ---- layout ----------------------------------------------------------

    test('tabs are Rules, Data, Settings — in that order and equal width', async () => {
        await openPopup();
        const tabs = await popup.$$eval('[role="tab"]', (els) => els.map((e) => ({
            label: e.textContent.replace(/\s+/g, ' ').trim(),
            width: Math.round(e.getBoundingClientRect().width)
        })));

        expect(tabs.map((t) => t.label.replace(/\s*\d+$/, ''))).toEqual(['Rules', 'Data', 'Settings']);
        const widths = tabs.map((t) => t.width);
        expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    });

    test('nothing overflows horizontally at popup width', async () => {
        await openPopup([rule('a', { name: 'A rule with a very long name that should truncate rather than overflow the popup' })]);
        const overflow = await popup.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
    });

    test('shows an empty state with no rules', async () => {
        await openPopup();
        const text = await popup.$eval('#rulesContainer', (e) => e.textContent);
        expect(text.trim().length).toBeGreaterThan(0);
        expect(await cardIds()).toEqual([]);
    });

    test('lists saved rules in order, with the count on the tab', async () => {
        await openPopup([rule('a'), rule('b'), rule('c', { enabled: false })]);
        expect(await cardIds()).toEqual(['a', 'b', 'c']);
        expect(await popup.$eval('#tabRuleCount', (e) => e.textContent.trim())).toBe('3');
    });

    // ---- rule actions ----------------------------------------------------

    test('the rule checkbox disables and re-enables a rule', async () => {
        await openPopup([rule('a')]);
        await popup.click('.rule-checkbox[data-rule-id="a"]');
        await waitFor(async () => (await storedRules())[0].enabled === false, { label: 'rule disabled' });

        await popup.click('.rule-checkbox[data-rule-id="a"]');
        await waitFor(async () => (await storedRules())[0].enabled === true, { label: 'rule re-enabled' });
    });

    test('the master switch turns the extension off', async () => {
        await openPopup([rule('a')]);
        await popup.click('#statusToggle');
        await waitFor(async () => (await h.extensionEval(() => chrome.action.getBadgeText({}))) === 'OFF', {
            label: 'badge OFF'
        });
    });

    test('delete removes the rule, and Undo restores it unchanged', async () => {
        await openPopup([rule('a'), rule('b', { hitCount: 7 })]);
        const createdBefore = (await storedRules()).find((r) => r.id === 'b').created;
        await popup.click('.rule-action[data-action="delete"][data-rule-id="b"]');
        await waitFor(async () => !(await storedRules()).some((r) => r.id === 'b'), { label: 'rule deleted' });

        // The toast slides in from the right; wait until Undo is actually the
        // element under its own centre point before clicking it, as a user
        // would by the time they move the pointer there.
        await waitFor(() => popup.evaluate(() => {
            const b = document.querySelector('.toast .toast-action');
            if (!b) return false;
            const r = b.getBoundingClientRect();
            return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
        }), { label: 'Undo to be clickable' });
        await popup.click('.toast .toast-action');
        const restored = await waitFor(async () => (await storedRules()).find((r) => r.id === 'b'), { label: 'rule restored' });
        expect(restored.hitCount).toBe(7);
        // Undo is meant to restore the rule identically, history included.
        expect(restored.created).toBe(createdBefore);
    });

    test('duplicate adds a disabled copy with its own identity', async () => {
        await openPopup([rule('a')]);
        await popup.click('.rule-action[data-action="copy"][data-rule-id="a"]');

        const rules = await waitFor(async () => {
            const r = await storedRules();
            return r.length === 2 ? r : null;
        }, { label: 'copy saved' });
        const copy = rules.find((r) => r.id !== 'a');
        expect(copy.enabled).toBe(false);
        expect(copy.name).toMatch(/Copy/);
        expect(copy.match).toEqual(rules.find((r) => r.id === 'a').match);
    });

    test('move up/down reorders rules — which changes which one matches first', async () => {
        await openPopup([rule('a'), rule('b'), rule('c')]);
        await popup.click('.rule-action[data-action="move-up"][data-rule-id="c"]');
        await waitFor(async () => (await storedRules()).map((r) => r.id).join() === 'a,c,b', { label: 'reordered' });
    });

    test('search filters the list', async () => {
        await openPopup([rule('alpha', { name: 'Users endpoint' }), rule('beta', { name: 'Orders endpoint' })]);
        await popup.type('#searchInput', 'orders');
        await waitFor(async () => {
            const visible = await popup.$$eval('.rule-card[data-rule-id]', (els) =>
                els.filter((e) => e.offsetParent !== null).map((e) => e.dataset.ruleId));
            return visible.join() === 'beta';
        }, { label: 'search to filter' });
    });

    // ---- keyboard ----------------------------------------------------------

    test('arrow keys move between tabs (ARIA tabs pattern)', async () => {
        await openPopup();
        await popup.focus('#tabRules');
        await popup.keyboard.press('ArrowRight');
        expect(await popup.evaluate(() => document.activeElement.id)).toBe('tabData');
        expect(await popup.$eval('#tabData', (e) => e.getAttribute('aria-selected'))).toBe('true');
        expect(await popup.$eval('#paneData', (e) => e.hidden)).toBe(false);
    });

    // ---- data tab: export / import -----------------------------------------

    async function captureExport() {
        await popup.evaluate(() => {
            window.__exported = null;
            const original = URL.createObjectURL;
            URL.createObjectURL = (blob) => {
                blob.text().then((t) => { window.__exported = t; });
                return original.call(URL, blob);
            };
        });
        await popup.click('#tabData');
        await popup.click('#exportRulesBtn');
        return waitFor(() => popup.evaluate(() => window.__exported), { label: 'export blob' });
    }

    test('export produces the rules as JSON', async () => {
        await openPopup([rule('a'), rule('b')]);
        const exported = JSON.parse(await captureExport());
        const rules = Array.isArray(exported) ? exported : exported.rules;
        expect(rules.map((r) => r.id)).toEqual(['a', 'b']);
    });

    test('an exported file imports back to the same rules', async () => {
        await openPopup([rule('a'), rule('b')]);
        const exported = await captureExport();

        await h.bg({ type: 'clearRules' });
        // The "Exported" toast overlays the Import button. A user clicks it
        // away (toasts dismiss on click), which is what this models.
        await popup.click('.toast .toast-message');
        await waitFor(() => popup.evaluate(() => !document.querySelector('.toast')), { label: 'toast dismissed' });
        await popup.click('#importToggleBtn');
        await popup.$eval('#importJson', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, exported);
        await popup.click('#importConfirmBtn');

        // Merge-import re-issues ids so an import can never overwrite a rule
        // already stored under the same id — compare by content instead.
        const names = await waitFor(async () => {
            const r = await storedRules();
            return r.length === 2 ? r.map((x) => x.name) : null;
        }, { label: 'import to land' });
        expect(names.sort()).toEqual(['Rule a', 'Rule b']);
    });

    test('a toast never leaves the control beneath it unreachable', async () => {
        // Regression: toasts overlay the bottom of the pane, swallowed clicks,
        // and stayed open while hovered — so right after an export, the Import
        // button could not be clicked at all.
        await openPopup([rule('a')]);
        await popup.click('#tabData');
        await popup.click('#exportRulesBtn');
        await popup.click('#importToggleBtn');
        await popup.waitForSelector('.toast');

        const hitsButton = () => popup.evaluate(() => {
            const b = document.getElementById('importConfirmBtn');
            const r = b.getBoundingClientRect();
            return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b;
        });

        // Click exactly where the Import button is, as a user would.
        const point = await popup.$eval('#importConfirmBtn', (b) => {
            const r = b.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        const coveredBeforeClick = !(await hitsButton());
        await popup.mouse.click(point.x, point.y);

        if (coveredBeforeClick) {
            // That click landed on the toast, which must get out of the way.
            await waitFor(() => popup.evaluate(() => !document.querySelector('.toast')), { label: 'toast dismissed by click' });
        }
        expect(await hitsButton()).toBe(true);
    });

    test('invalid import JSON is reported, not silently ignored', async () => {
        await openPopup([rule('a')]);
        await popup.click('#tabData');
        await popup.click('#importToggleBtn');
        await popup.type('#importJson', '{ not json');
        await popup.click('#importConfirmBtn');

        await waitFor(async () => popup.evaluate(() =>
            /not valid JSON/i.test(document.body.innerText)), { label: 'an error message' });
        expect((await storedRules()).map((r) => r.id)).toEqual(['a']);
    });

    test('an import containing a rule the network layer would reject tells the user', async () => {
        await openPopup();
        await popup.click('#tabData');
        await popup.click('#importToggleBtn');
        const payload = JSON.stringify([rule('ok'), {
            id: 'bad', name: 'Bad header op', enabled: true, type: 'headers',
            match: { url: '*/echo*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X-Bad' }], response: [] }
        }]);
        await popup.$eval('#importJson', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, payload);
        await popup.click('#importConfirmBtn');

        await waitFor(async () => popup.evaluate(() => /skipped|rejected|invalid|not imported|1 rule/i.test(document.body.innerText)), {
            label: 'the rejection to be reported'
        });
        // Merge-import re-issues ids, so identify rules by name.
        const names = (await storedRules()).map((r) => r.name);
        expect(names).toContain('Rule ok');
        expect(names).not.toContain('Bad header op');
    });

    test('a rule Chrome refused is flagged on its own row, accessibly, in both themes', async () => {
        // Plant a malformed headers rule straight into storage, as an older
        // build's import would have, then make the background re-sync.
        await openPopup([rule('good')]);
        const stored = (await h.bg({ type: 'getRules' })).rules;
        await h.extensionEval((rules) => chrome.storage.local.set({ spliceTapRules: rules }), [...stored, {
            id: 'refused', name: 'Refused rule', enabled: true, type: 'headers', dnrRuleId: 9100,
            match: { url: '*/echo*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X-No-Value' }], response: [] }
        }]);
        await h.saveRule(rule('trigger'));

        await popup.reload({ waitUntil: 'load' });
        await popup.waitForSelector('.rule-card[data-rule-id="refused"] .rule-error-chip');
        const flagged = await popup.$$eval('.rule-error-chip', (els) => els.map((e) => e.closest('.rule-card').dataset.ruleId));
        expect(flagged).toEqual(['refused']);

        expect(await auditA11y(popup, { include: '.rule-list' })).toEqual([]);
        await popup.click('#tabSettings');
        await popup.click('#themeDark');
        await popup.click('#tabRules');
        await sleep(300);
        expect(await auditA11y(popup, { include: '.rule-list' })).toEqual([]);
    });

    // ---- settings ------------------------------------------------------------

    test('theme choice persists across popup openings', async () => {
        await openPopup();
        await popup.click('#tabSettings');
        await popup.click('#themeDark');
        await sleep(300);
        await popup.close();

        popup = await h.browser.newPage();
        await popup.setViewport(POPUP_SIZE);
        await popup.goto(h.extUrl('popup/popup.html'), { waitUntil: 'load' });
        await sleep(300);
        const theme = await popup.evaluate(() => document.documentElement.getAttribute('data-theme') ||
            (document.documentElement.classList.contains('dark') ? 'dark' : document.body.className));
        expect(String(theme)).toMatch(/dark/);
    });

    // ---- accessibility -------------------------------------------------------

    test('Rules tab has no WCAG A/AA violations', async () => {
        await openPopup([rule('a'), rule('b', { enabled: false })]);
        expect(await auditA11y(popup)).toEqual([]);
    });

    test('Data tab has no WCAG A/AA violations', async () => {
        await openPopup([rule('a')]);
        await popup.click('#tabData');
        await sleep(150);
        expect(await auditA11y(popup)).toEqual([]);
    });

    test('Settings tab has no WCAG A/AA violations', async () => {
        await openPopup();
        await popup.click('#tabSettings');
        await sleep(150);
        expect(await auditA11y(popup)).toEqual([]);
    });

    test('dark theme has no WCAG A/AA violations', async () => {
        await openPopup([rule('a'), rule('b', { enabled: false })]);
        await popup.click('#tabSettings');
        await popup.click('#themeDark');
        await popup.click('#tabRules');
        await sleep(300);
        expect(await auditA11y(popup)).toEqual([]);
    });

    test('ran without errors', async () => {
        await openPopup([rule('a')]);
        expect(h.allErrors).toEqual([]);
    });
});
