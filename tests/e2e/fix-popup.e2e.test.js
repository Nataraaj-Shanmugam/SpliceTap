/**
 * Fix group D1 — the popup: accessibility (PER-71/72/74/75/76/81/82/83/85/86),
 * data and workflow (PER-27/29/32/53/55/59/60/61/62/68/69/70/19).
 *
 * Every test here fails against the popup as it was before the fixes. They
 * drive the real popup in Chrome, at its real size, the way a user would:
 * keyboard, clicks, wheel, forced colours, zoom.
 */

const { launch, pageFetch, waitFor, sleep, auditA11y } = require('./harness');

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

describe('fix: popup', () => {
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

    /** Seed rules, then open a fresh popup at its real size. */
    async function openPopup(rules = [], { settings = {}, viewport = POPUP_SIZE, forcedColors = false } = {}) {
        await h.reset();
        await h.bg({ type: 'settingsUpdated', settings });
        for (const r of rules) await h.saveRule(r);
        popup = await h.browser.newPage();
        popup.on('pageerror', (e) => h.record({ where: 'popup', text: 'pageerror: ' + e.message }));
        popup.on('console', (m) => { if (m.type() === 'error') h.record({ where: 'popup', text: m.text() }); });
        await popup.setViewport(viewport);
        if (forcedColors) {
            const cdp = await popup.createCDPSession();
            await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
        }
        await popup.goto(h.extUrl('popup/popup.html'), { waitUntil: 'load' });
        await popup.waitForSelector('#rulesContainer');
        await sleep(200);
        return popup;
    }

    const storedRules = async () => (await h.bg({ type: 'getRules' })).rules;
    const storedIds = async () => (await storedRules()).map((r) => r.id);
    const storedNames = async () => (await storedRules()).map((r) => r.name);
    const active = () => popup.evaluate(() => {
        const a = document.activeElement;
        return {
            tag: a.tagName,
            id: a.id,
            cls: a.className,
            ruleId: a.dataset && a.dataset.ruleId,
            text: (a.textContent || '').trim()
        };
    });
    const toastTexts = () => popup.evaluate(() =>
        Array.from(document.querySelectorAll('.toast:not(.closing)')).map((t) => t.innerText.replace(/\s+/g, ' ').trim()));
    const liveRegion = () => popup.evaluate(() => {
        const r = document.getElementById('liveRegion');
        return { text: r.textContent, live: r.getAttribute('aria-live'), role: r.getAttribute('role') };
    });
    const pressWith = async (modifier, key) => {
        await popup.keyboard.down(modifier);
        await popup.keyboard.press(key);
        await popup.keyboard.up(modifier);
    };
    async function deleteByKeyboard(id) {
        await popup.focus(`.rule-action[data-action="delete"][data-rule-id="${id}"]`);
        await popup.keyboard.press('Enter');
        await waitFor(async () => !(await storedIds()).includes(id), { label: `rule ${id} deleted` });
        await popup.waitForSelector('.toast-action');
    }
    async function importJson(json, { replace = false } = {}) {
        await popup.click('#tabData');
        await popup.click('#importToggleBtn');
        if (replace) await popup.click('#importMerge');
        await popup.$eval('#importJson', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, json);
    }

    // ---- PER-71 / PER-29: Undo after Delete -------------------------------------------------

    test('PER-71: after Delete, focus is on Undo; Enter restores the rule at its original position (PER-29)', async () => {
        await openPopup([rule('a'), rule('b'), rule('c')]);
        await deleteByKeyboard('b');

        const focused = await active();
        expect(focused.cls).toContain('toast-action');
        expect(focused.text).toBe('Undo');

        await popup.keyboard.press('Enter');
        await waitFor(async () => (await storedIds()).join() === 'a,b,c', { label: 'restored in place' });
        // Focus follows the restored row, not row 1 or <body>.
        await waitFor(async () => (await active()).ruleId === 'b', { label: 'focus on the restored rule' });
    });

    test('PER-29: Undo puts a deleted first rule back first, and a middle one back in the middle', async () => {
        await openPopup([rule('a'), rule('b'), rule('c')]);
        await deleteByKeyboard('a');
        expect(await storedIds()).toEqual(['b', 'c']);
        await popup.keyboard.press('Enter');
        await waitFor(async () => (await storedIds()).join() === 'a,b,c', { label: 'a restored at the top' });
        await popup.waitForSelector('.toast-action', { hidden: true });
        await waitFor(() => popup.evaluate(() => !document.querySelector('.toast-action')), { label: 'toast gone' });

        await deleteByKeyboard('c');
        await popup.keyboard.press('Enter');
        await waitFor(async () => (await storedIds()).join() === 'a,b,c', { label: 'c restored at the bottom' });
    });

    test('PER-71: Ctrl+Z undoes the delete from anywhere, and Alt+Z from inside the search box', async () => {
        await openPopup([rule('a'), rule('b'), rule('c')]);
        await deleteByKeyboard('b');
        await popup.evaluate(() => document.activeElement.blur());
        await pressWith('Control', 'z');
        await waitFor(async () => (await storedIds()).join() === 'a,b,c', { label: 'Ctrl+Z restored' });

        await popup.waitForSelector('.toast-action', { hidden: true });
        await deleteByKeyboard('c');
        await popup.focus('#searchInput');
        await pressWith('Alt', 'z');
        await waitFor(async () => (await storedIds()).join() === 'a,b,c', { label: 'Alt+Z restored' });
    });

    test('PER-71: Ctrl+Z inside a text field is left alone (it is that field\'s own undo)', async () => {
        await openPopup([rule('a'), rule('b')]);
        await deleteByKeyboard('b');
        await popup.focus('#searchInput');
        await pressWith('Control', 'z');
        await sleep(400);
        expect(await storedIds()).toEqual(['a']);
    });

    test('PER-71: a toast with an action does not time out (it used to vanish after 8 s)', async () => {
        await openPopup([rule('a'), rule('b')]);
        await deleteByKeyboard('b');
        await sleep(9000);
        expect(await popup.$('.toast-action')).not.toBeNull();
        await popup.keyboard.press('Enter');
        await waitFor(async () => (await storedIds()).join() === 'a,b', { label: 'still undoable after 9 s' });
    });

    test('PER-71: Escape dismisses the Undo toast and focus returns to the neighbouring row', async () => {
        await openPopup([rule('a'), rule('b'), rule('c')]);
        await deleteByKeyboard('b');
        await popup.keyboard.press('Escape');
        await waitFor(() => popup.evaluate(() => !document.querySelector('.toast:not(.closing)')), { label: 'toast dismissed' });
        expect(popup.isClosed()).toBe(false);
        // Row 2 is now "c" — the row that took b's place — not row 1.
        expect((await active()).ruleId).toBe('c');
        expect(await storedIds()).toEqual(['a', 'c']);
    });

    test('PER-71: deleting the last row lands focus on the new last row', async () => {
        await openPopup([rule('a'), rule('b'), rule('c')]);
        await deleteByKeyboard('c');
        await popup.keyboard.press('Escape');
        await waitFor(async () => (await active()).ruleId === 'b', { label: 'focus on the previous row' });
    });

    // ---- PER-59: duplicate below the original; Move to top ----------------------------------

    test('PER-59 / PER-71: Duplicate lands directly below the original, and focus goes to the copy', async () => {
        await openPopup([rule('a'), rule('b'), rule('c')]);
        await popup.focus('.rule-action[data-action="copy"][data-rule-id="a"]');
        await popup.keyboard.press('Enter');

        const rules = await waitFor(async () => {
            const r = await storedRules();
            return r.length === 4 ? r : null;
        }, { label: 'copy saved' });
        expect(rules.map((r) => r.id).filter((id) => id !== 'a')[0]).not.toBe('b'); // the copy is second
        expect(rules[0].id).toBe('a');
        expect(rules[1].name).toBe('Rule a (Copy)');
        expect(rules.slice(2).map((r) => r.id)).toEqual(['b', 'c']);
        expect(rules[1].enabled).toBe(false);

        await waitFor(async () => (await active()).ruleId === rules[1].id, { label: 'focus on the copy' });
    });

    test('PER-59: "Move to top" puts a rule first, and is not offered on the first row', async () => {
        await openPopup([rule('a'), rule('b'), rule('c')]);
        expect(await popup.$('.rule-action[data-action="move-top"][data-rule-id="a"]')).toBeNull();
        await popup.click('.rule-action[data-action="move-top"][data-rule-id="c"]');
        await waitFor(async () => (await storedIds()).join() === 'c,a,b', { label: 'c moved to the top' });
        // The pressed row is first now; focus stays on that row's controls.
        expect((await active()).ruleId).toBe('c');
    });

    // ---- PER-72: zoom --------------------------------------------------------------------------

    test('PER-72: at 200% zoom (400x300) the page scrolls and New rule is reachable', async () => {
        await openPopup([rule('a'), rule('b'), rule('c')], { viewport: { width: 400, height: 300 } });
        const before = await popup.evaluate(() => ({
            scrollH: document.scrollingElement.scrollHeight,
            clientH: document.scrollingElement.clientHeight,
            btnTop: document.getElementById('newRuleBtn').getBoundingClientRect().top
        }));
        // The content really is taller than the viewport, and New rule is below the fold...
        expect(before.scrollH).toBeGreaterThan(before.clientH);
        expect(before.btnTop).toBeGreaterThan(before.clientH);

        // ...and a wheel gesture — which `overflow: hidden` used to swallow — brings it into view.
        await popup.mouse.move(200, 150);
        await popup.mouse.wheel({ deltaY: 800 });
        await waitFor(() => popup.evaluate(() => window.scrollY > 0), { label: 'the page to scroll' });
        const rect = await popup.$eval('#newRuleBtn', (b) => {
            const r = b.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
        });
        expect(rect.top).toBeGreaterThanOrEqual(0);
        expect(rect.bottom).toBeLessThanOrEqual(rect.vh);

        // Keyboard users reach it too: focusing scrolls it into view.
        await popup.evaluate(() => window.scrollTo(0, 0));
        await popup.focus('#newRuleBtn');
        const focusedRect = await popup.$eval('#newRuleBtn', (b) => {
            const r = b.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
        });
        expect(focusedRect.top).toBeGreaterThanOrEqual(0);
        expect(focusedRect.bottom).toBeLessThanOrEqual(focusedRect.vh);
    });

    test('PER-72: at 400% zoom (200x150) nothing is cut off on the right and the footer wraps', async () => {
        await openPopup([rule('a')], { viewport: { width: 200, height: 150 } });
        const m = await popup.evaluate(() => ({
            scrollW: document.scrollingElement.scrollWidth,
            clientW: document.scrollingElement.clientWidth,
            bodyW: document.body.getBoundingClientRect().width,
            footerRight: document.getElementById('rulesFooter').getBoundingClientRect().right,
            newRuleRight: document.getElementById('newRuleBtn').getBoundingClientRect().right
        }));
        expect(m.scrollW).toBeLessThanOrEqual(m.clientW);
        expect(m.bodyW).toBeLessThanOrEqual(m.clientW);
        expect(m.newRuleRight).toBeLessThanOrEqual(m.clientW);
    });

    test('PER-72: text sizes are in rem, so they follow the browser text size', async () => {
        await openPopup([rule('a')]);
        const sizes = await popup.evaluate(() => {
            const sheet = Array.from(document.styleSheets).find((s) => /popup\.css/.test(s.href || ''));
            const px = [];
            for (const r of Array.from(sheet.cssRules)) {
                if (r.style && /px/.test(r.style.fontSize || '')) px.push(r.selectorText);
            }
            return px;
        });
        expect(sizes).toEqual([]);
    });

    // ---- PER-74 / PER-75: switches and focus in forced colours; light theme -------------------------

    const switchColours = () => popup.evaluate(() => {
        const out = {};
        for (const c of document.querySelectorAll('.rule-checkbox')) {
            const b = window.getComputedStyle(c, '::before');
            const a = window.getComputedStyle(c, '::after');
            out[c.dataset.ruleId] = { track: b.backgroundColor, border: b.borderColor, knob: a.backgroundColor, left: a.left };
        }
        return out;
    });

    test.each(['dark', 'light'])('PER-74: rule switches differ on vs off in forced colours (%s theme)', async (theme) => {
        await openPopup([rule('on'), rule('off', { enabled: false })], { settings: { theme }, forcedColors: true });
        const c = await switchColours();
        expect(c.on.track).not.toBe(c.off.track);
        // The knob also differs (colour and position), so state is not carried by one signal.
        expect(`${c.on.knob}|${c.on.left}`).not.toBe(`${c.off.knob}|${c.off.left}`);
    });

    test('PER-74: in the light theme an enabled rule\'s switch is not drawn like a disabled one', async () => {
        await openPopup([rule('on'), rule('off', { enabled: false })], { settings: { theme: 'light' } });
        expect(await popup.evaluate(() => document.body.classList.contains('theme-light'))).toBe(true);
        const c = await switchColours();
        expect(c.on.track).not.toBe(c.off.track);
        expect(c.on.track).toBe('rgb(30, 99, 245)'); // --accent
    });

    test.each(['captureArmed', 'chaosModeEnabled', 'debugMode'])('PER-74: the %s switch differs on vs off in forced colours', async (id) => {
        await openPopup([], { forcedColors: true });
        await popup.click(id === 'captureArmed' ? '#tabData' : '#tabSettings');
        const read = () => popup.evaluate((inputId) => {
            const track = document.getElementById(inputId).parentElement.querySelector('.switch-track');
            const t = window.getComputedStyle(track);
            const k = window.getComputedStyle(track, '::after');
            return { track: t.backgroundColor, border: t.borderColor, knob: k.backgroundColor, transform: k.transform };
        }, id);
        const off = await read();
        await popup.$eval(`#${id}`, (el) => el.click());
        await sleep(300);
        const on = await read();
        expect(on.track).not.toBe(off.track);
        expect(`${on.knob}|${on.transform}`).not.toBe(`${off.knob}|${off.transform}`);
        // leave the shared worker as found
        await h.bg({ type: 'settingsUpdated', settings: {} });
    });

    test('PER-75: the search box shows a focus indicator in forced colours', async () => {
        await openPopup([rule('a')], { forcedColors: true });
        await popup.focus('#searchInput');
        const outline = await popup.$eval('.search-bar', (el) => {
            const s = window.getComputedStyle(el);
            return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
        });
        expect(outline.style).not.toBe('none');
        expect(outline.width).toBeGreaterThan(0);
    });

    // ---- PER-76: the Disabled chip follows the switch --------------------------------------------

    test('PER-76: the "Disabled" chip appears when a rule is switched off and goes when it is switched on', async () => {
        await openPopup([rule('a'), rule('b', { enabled: false })]);
        const chip = (id) => popup.evaluate((rid) => {
            const card = Array.from(document.querySelectorAll('.rule-card')).find((c) => c.dataset.ruleId === rid);
            return !!card.querySelector('.disabled-chip');
        }, id);
        expect(await chip('a')).toBe(false);
        expect(await chip('b')).toBe(true);

        await popup.click('.rule-checkbox[data-rule-id="b"]');
        await waitFor(async () => !(await chip('b')), { label: 'chip removed after enabling' });
        await popup.click('.rule-checkbox[data-rule-id="a"]');
        await waitFor(() => chip('a'), { label: 'chip added after disabling' });
        // Exactly one chip per disabled row, and toggling back removes it again.
        await popup.click('.rule-checkbox[data-rule-id="a"]');
        await waitFor(async () => !(await chip('a')), { label: 'chip removed again' });
        expect(await popup.$$eval('.rule-card[data-rule-id="a"] .disabled-chip', (els) => els.length)).toBe(0);
    });

    // ---- PER-85: roving tabindex -----------------------------------------------------------------

    test('PER-85: the tablist is a single Tab stop and arrow keys move the stop', async () => {
        await openPopup([rule('a')]);
        const tabindexes = () => popup.$$eval('[role="tab"]', (els) => els.map((e) => `${e.id}=${e.getAttribute('tabindex')}`));
        expect(await tabindexes()).toEqual(['tabRules=0', 'tabData=-1', 'tabSettings=-1']);

        // Tab from the selected tab skips the other two and lands on search.
        await popup.focus('#tabRules');
        await popup.keyboard.press('Tab');
        expect((await active()).id).toBe('searchInput');

        await popup.focus('#tabRules');
        await popup.keyboard.press('ArrowRight');
        expect(await tabindexes()).toEqual(['tabRules=-1', 'tabData=0', 'tabSettings=-1']);
        expect((await active()).id).toBe('tabData');
        await popup.keyboard.press('End');
        expect(await tabindexes()).toEqual(['tabRules=-1', 'tabData=-1', 'tabSettings=0']);
    });

    // ---- PER-86: target size ---------------------------------------------------------------------

    test('PER-86: the search clear button is at least 24x24', async () => {
        await openPopup([rule('a')]);
        await popup.type('#searchInput', 'a');
        const size = await popup.$eval('#searchClearBtn', (b) => {
            const r = b.getBoundingClientRect();
            return { w: r.width, h: r.height };
        });
        expect(size.w).toBeGreaterThanOrEqual(24);
        expect(size.h).toBeGreaterThanOrEqual(24);
    });

    // ---- PER-81: one announcement per message; keyboard dismissal -----------------------------------

    test('PER-81: a toast has no live role and no tooltip; #liveRegion announces the message once (errors assertively)', async () => {
        await openPopup([]);
        await popup.click('#toggleAllBtn'); // no rules => an error toast
        await popup.waitForSelector('.toast');

        const toast = await popup.$eval('.toast', (t) => ({ role: t.getAttribute('role'), title: t.getAttribute('title'), text: t.innerText.trim() }));
        expect(toast.role).toBeNull();
        expect(toast.title).toBeNull();
        expect(toast.text).toBe('No rules to toggle');

        const live = await liveRegion();
        expect(live).toEqual({ text: 'No rules to toggle', live: 'assertive', role: 'alert' });
        // Nothing else on the page is a live region carrying that text.
        const announcers = await popup.evaluate(() => Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live]'))
            .filter((el) => el.textContent.includes('No rules to toggle')).map((el) => el.id));
        expect(announcers).toEqual(['liveRegion']);

        // A non-error is polite.
        await h.saveRule(rule('a'));
        await popup.click('#refreshBtn');
        await waitFor(async () => (await liveRegion()).text === 'Refreshed', { label: 'a polite announcement' });
        expect(await liveRegion()).toMatchObject({ live: 'polite', role: 'status' });
    });

    test('PER-81: Escape dismisses the toast first (and does not close the popup)', async () => {
        await openPopup([]);
        await popup.click('#toggleAllBtn');
        await popup.waitForSelector('.toast');
        await popup.keyboard.press('Escape');
        await waitFor(() => popup.evaluate(() => !document.querySelector('.toast:not(.closing)')), { label: 'toast dismissed' });
        await sleep(300);
        expect(popup.isClosed()).toBe(false);
    });

    // ---- PER-68: toasts never swallow a click -----------------------------------------------------------

    test('PER-68: a toast does not intercept pointer events, except on its own buttons', async () => {
        await openPopup([rule('a')]);
        await deleteByKeyboard('a');
        const styles = await popup.evaluate(() => {
            const t = document.querySelector('.toast');
            const r = t.getBoundingClientRect();
            const centre = document.elementFromPoint(r.x + 6, r.y + r.height / 2);
            return {
                container: window.getComputedStyle(document.getElementById('toastContainer')).pointerEvents,
                toast: window.getComputedStyle(t).pointerEvents,
                action: window.getComputedStyle(t.querySelector('.toast-action')).pointerEvents,
                hitIsToast: !!(centre && centre.closest('.toast'))
            };
        });
        expect(styles).toEqual({ container: 'none', toast: 'none', action: 'auto', hitIsToast: false });
    });

    test('PER-68: the click meant for a control under a toast reaches the control', async () => {
        await openPopup([rule('a')]);
        await popup.click('#tabData');
        await popup.click('#exportRulesBtn');
        await popup.waitForSelector('.toast');

        // Put a button exactly where the toast is, beneath it in stacking order,
        // standing in for whatever control the toast happens to cover (Import,
        // the last row's actions...).
        const centre = await popup.evaluate(() => {
            const r = document.querySelector('.toast').getBoundingClientRect();
            const probe = document.createElement('button');
            probe.id = 'probeUnderToast';
            probe.textContent = 'probe';
            probe.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:1`;
            probe.addEventListener('click', () => { window.__probeClicks = (window.__probeClicks || 0) + 1; });
            document.body.appendChild(probe);
            return { x: r.left + 6, y: r.top + r.height / 2 };
        });

        await popup.mouse.click(centre.x, centre.y);
        await waitFor(() => popup.evaluate(() => window.__probeClicks === 1), { label: 'the click to reach the control under the toast' });
    });

    // ---- PER-82 / PER-19 / PER-60: capture ---------------------------------------------------------------

    async function seedCaptures() {
        await h.bg({ type: 'setCaptureArmed', armed: true });
        page = await h.openPage();
        await waitFor(async () => {
            await pageFetch(page, '/api/readme-user');
            await pageFetch(page, '/api/list');
            return (await h.bg({ type: 'getCaptures' })).captures.length >= 2;
        }, { label: 'two captures' });
        await h.bg({ type: 'setCaptureArmed', armed: false });
        await popup.bringToFront();
        await popup.reload({ waitUntil: 'load' });
        await popup.click('#tabData');
        await popup.waitForSelector('[data-capture-action="mock"]');
        await sleep(500); // the theme/hover colour transitions settle before an audit
    }

    test('PER-82 / PER-19: capture buttons name their request; Patch is not offered for an array response', async () => {
        await openPopup([]);
        await seedCaptures();
        const labels = await popup.$$eval('[data-capture-action]', (els) => els.map((e) => e.getAttribute('aria-label')).sort());
        expect(labels).toEqual([
            'Mock GET /api/list',
            'Mock GET /api/readme-user',
            'Patch GET /api/readme-user'
        ]);
        // The visible word is still first in the accessible name (WCAG 2.5.3).
        expect(await popup.$$eval('[data-capture-action]', (els) => els.every((e) => e.getAttribute('aria-label').startsWith(e.textContent.trim())))).toBe(true);
    });

    test('PER-60: creating a rule from a capture goes to the Rules tab and focuses the new rule', async () => {
        await openPopup([rule('existing')]);
        await seedCaptures();
        // B2-PER-60: creating the rule now also hands it to the editor and closes the popup. Here
        // the "active tab" is an editor that opens, and the popup's close is recorded, not obeyed,
        // so the Rules-tab state below can still be read. (The hand-off itself is in b2-ui.e2e.test.js.)
        await popup.evaluate(() => {
            chrome.tabs.query = async () => [{ id: 4242, url: 'http://app.example.test/' }];
            chrome.tabs.sendMessage = async () => ({ success: true });
            window.close = () => { window.__closed = true; };
        });
        await popup.click('[data-capture-action="patch"]');
        const created = await waitFor(async () => (await storedRules()).find((r) => r.id !== 'existing'), { label: 'rule created' });
        await waitFor(() => popup.evaluate(() => window.__closed === true), { label: 'the hand-off to finish' });

        expect(await popup.$eval('#tabRules', (t) => t.getAttribute('aria-selected'))).toBe('true');
        expect(await popup.$eval('#paneRules', (p) => p.hidden)).toBe(false);
        const focused = await active();
        expect(focused.cls).toContain('rule-name-btn');
        expect(focused.ruleId).toBe(created.id);
        const inView = await popup.evaluate((id) => {
            const btn = Array.from(document.querySelectorAll('.rule-name-btn')).find((b) => b.dataset.ruleId === id);
            const r = btn.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight;
        }, created.id);
        expect(inView).toBe(true);
    });

    // ---- PER-61: the empty state ----------------------------------------------------------------------

    test('PER-61: the empty state offers "Create a rule" and "Record a real response"', async () => {
        await openPopup([]);
        const buttons = await popup.$$eval('#rulesContainer .empty-state button', (els) => els.map((e) => e.textContent.trim()));
        expect(buttons).toEqual(['Create a rule', 'Record a real response']);

        await popup.click('[data-empty-action="record"]');
        await waitFor(async () => (await h.bg({ type: 'getCaptures' })).armed, { label: 'capture armed' });
        expect(await popup.$eval('#tabData', (t) => t.getAttribute('aria-selected'))).toBe('true');
        await h.bg({ type: 'setCaptureArmed', armed: false });
    });

    test('PER-61: "Create a rule" opens the editor (the options page where no web page is active)', async () => {
        await openPopup([]);
        const opened = h.browser.waitForTarget((t) => t.url().includes('options/options.html?action=new'), { timeout: 8000 });
        const closed = new Promise((resolve) => popup.once('close', resolve));
        await popup.click('[data-empty-action="create"]').catch(() => {});
        const target = await opened;
        await closed;
        const p = await target.page();
        if (p) await p.close();
    });

    // ---- PER-32: no content script on this tab ------------------------------------------------------------

    async function stubTabs({ url, reject = true }) {
        await popup.evaluate((u, rej) => {
            window.__reloads = [];
            chrome.tabs.query = async () => [{ id: 4242, url: u }];
            chrome.tabs.sendMessage = async () => {
                if (rej) throw new Error('Could not establish connection. Receiving end does not exist.');
                return { success: true };
            };
            chrome.tabs.reload = async (id) => { window.__reloads.push(id); };
        }, url, reject);
    }

    test('PER-32: on an http(s) tab with no content script, New rule offers "Reload this tab" instead of opening the options page', async () => {
        await openPopup([]);
        await stubTabs({ url: 'http://app.example.test/dashboard' });
        await popup.click('#newRuleBtn');
        await popup.waitForSelector('#reloadNotice');

        const text = await popup.$eval('#reloadNotice', (n) => n.innerText.replace(/\s+/g, ' ').trim());
        expect(text).toMatch(/Reload this tab to start intercepting/);
        expect(popup.isClosed()).toBe(false);
        expect((await h.browser.pages()).some((p) => p.url().includes('options/options.html'))).toBe(false);
        expect((await active()).id).toBe('reloadTabBtn');

        await popup.click('#reloadTabBtn');
        await waitFor(() => popup.evaluate(() => window.__reloads.length === 1), { label: 'chrome.tabs.reload called' });
        expect(await popup.evaluate(() => window.__reloads)).toEqual([4242]);
        expect(await popup.$('#reloadNotice')).toBeNull();
    });

    test('PER-32: on the Web Store (where a reload cannot help) the options-page fallback is kept', async () => {
        await openPopup([]);
        await stubTabs({ url: 'https://chromewebstore.google.com/detail/x' });
        const opened = h.browser.waitForTarget((t) => t.url().includes('options/options.html?action=new'), { timeout: 8000 });
        const closed = new Promise((resolve) => popup.once('close', resolve));
        await popup.click('#newRuleBtn').catch(() => {});
        const target = await opened;
        await closed;
        const p = await target.page();
        if (p) await p.close();
    });

    // ---- PER-27: the background's `rejected` list is surfaced ----------------------------------------------

    /** Make the popup's next setRules answer with a refusal, whatever the background would say. */
    async function stubSetRules(rejected) {
        await popup.evaluate((rej) => {
            const p = window.spliceTapPopup;
            const original = p.sendMessage.bind(p);
            p.sendMessage = async (m) => {
                const res = await original(m);
                if (m && m.type === 'setRules') return { ...res, rejected: rej };
                return res;
            };
        }, rejected);
    }

    test('PER-27: Move up / Toggle all report the rules the background refused, by name and reason', async () => {
        await openPopup([rule('a'), rule('b'), rule('c')]);
        await stubSetRules([{ name: 'Old legacy rule', errors: ['Rule name must be 100 characters or less'] }]);

        await popup.click('.rule-action[data-action="move-down"][data-rule-id="a"]');
        await waitFor(async () => (await toastTexts()).some((t) => /Old legacy rule/.test(t) && /100 characters/.test(t)), { label: 'a refusal toast (move)' });
        expect((await liveRegion()).live).toBe('assertive');

        await popup.click('#toggleAllBtn');
        await waitFor(async () => (await toastTexts()).some((t) => /Disabled 2 of 3/.test(t) && /Old legacy rule/.test(t)), { label: 'a refusal toast (toggle all)' });
    });

    // ---- PER-62 / PER-5: import ---------------------------------------------------------------------------------

    test('PER-5: "Keep existing rules" appends the import after the existing rules and keeps each imported rule\'s enabled flag', async () => {
        await openPopup([rule('e1', { name: 'Mine' })]);
        const incoming = [
            rule('x1', { name: 'Theirs on', enabled: true, match: { url: '*/api/x1*', method: 'GET' } }),
            rule('x2', { name: 'Theirs off', enabled: false, match: { url: '*/api/x2*', method: 'GET' } })
        ];
        await importJson(JSON.stringify(incoming));
        await popup.click('#importConfirmBtn');
        await waitFor(async () => (await storedRules()).length === 3, { label: 'import to land' });

        const rules = await storedRules();
        expect(rules.map((r) => r.name)).toEqual(['Mine', 'Theirs on', 'Theirs off']);
        expect(rules.map((r) => r.enabled)).toEqual([true, true, false]);
    });

    test('PER-62: exact duplicates are skipped and reported by name, persistently, with error styling', async () => {
        await openPopup([rule('e1', { name: 'Users', type: 'block', match: { url: '*/users*', method: 'GET' }, response: undefined })]);
        const incoming = [
            { id: 'z', name: 'Users again', enabled: true, type: 'block', match: { url: '*/users*', method: 'GET' } },
            { id: 'y', name: 'Fresh', enabled: true, type: 'block', match: { url: '*/fresh*', method: 'GET' } }
        ];
        await importJson(JSON.stringify(incoming));
        await popup.click('#importConfirmBtn');
        await popup.waitForSelector('#importReport:not([hidden])');

        expect(await storedNames()).toEqual(['Users', 'Fresh']);
        const report = await popup.$eval('#importReport', (el) => ({ cls: el.className, text: el.innerText.replace(/\s+/g, ' ').trim() }));
        expect(report.cls).toContain('is-error');
        expect(report.text).toMatch(/Imported 1 rule/);
        expect(report.text).toMatch(/Users again/);
        expect(report.text).toMatch(/duplicate/i);

        // The toast is long gone; the report is not.
        await sleep(7500);
        expect(await popup.$('.toast')).toBeNull();
        expect(await popup.$eval('#importReport', (el) => !el.hidden && /Users again/.test(el.textContent))).toBe(true);

        // Dismissing removes it and returns focus to the Import button.
        await popup.click('#importReportDismiss');
        expect(await popup.$eval('#importReport', (el) => el.hidden)).toBe(true);
        expect((await active()).id).toBe('importToggleBtn');
    });

    test('PER-62: a rule the background refuses is listed with its name and reason', async () => {
        await openPopup([]);
        const incoming = [
            rule('ok', { name: 'Fine' }),
            { id: 'bad', name: 'Bad header op', enabled: true, type: 'headers', match: { url: '*/echo*', method: '*' }, headersMod: { request: [{ op: 'set', name: 'X-Bad' }], response: [] } }
        ];
        await importJson(JSON.stringify(incoming));
        await popup.click('#importConfirmBtn');
        await popup.waitForSelector('#importReport:not([hidden])');

        expect(await storedNames()).toEqual(['Fine']);
        const items = await popup.$$eval('#importReport li', (els) => els.map((li) => ({
            name: li.querySelector('.ir-name').textContent,
            reason: li.querySelector('.ir-reason').textContent
        })));
        expect(items).toHaveLength(1);
        expect(items[0].name).toBe('Bad header op');
        expect(items[0].reason.length).toBeGreaterThan(5);
        expect(await popup.$eval('#importReport', (el) => el.className)).toContain('is-error');
    });

    test('PER-62: Replace mode says how many rules it replaces and needs a second click', async () => {
        await openPopup([rule('o1'), rule('o2')]);
        await importJson(JSON.stringify([rule('n1', { name: 'Brand new' })]), { replace: true });
        expect(await popup.$eval('#importConfirmBtn', (b) => b.textContent.trim())).toBe('Replace all 2 rules');

        await popup.click('#importConfirmBtn');
        await sleep(500);
        // Nothing was replaced by the first click; it only asked.
        expect(await storedIds()).toEqual(['o1', 'o2']);
        expect(await popup.$eval('#importReplaceWarn', (w) => ({ hidden: w.hidden, text: w.textContent }))).toMatchObject({ hidden: false });
        expect(await popup.$eval('#importConfirmBtn', (b) => b.textContent)).toMatch(/Replace all 2 rules/);

        await popup.click('#importConfirmBtn');
        await waitFor(async () => (await storedNames()).join() === 'Brand new', { label: 'the rule set replaced' });
    });

    test('PER-62: editing the JSON or the mode cancels a pending replace confirmation', async () => {
        await openPopup([rule('o1')]);
        await importJson(JSON.stringify([rule('n1', { name: 'Brand new' })]), { replace: true });
        await popup.click('#importConfirmBtn');
        await popup.waitForSelector('#importReplaceWarn:not([hidden])');

        await popup.type('#importJson', ' ');
        expect(await popup.$eval('#importReplaceWarn', (w) => w.hidden)).toBe(true);
        // ...so the next click asks again rather than replacing.
        await popup.click('#importConfirmBtn');
        await sleep(400);
        expect(await storedIds()).toEqual(['o1']);
    });

    test('PER-62: an export carries no runtime fields (hitCount, testStatus, dnrRuleId)', async () => {
        await openPopup([
            rule('a', { hitCount: 41 }),
            { id: 'h', name: 'Headers', enabled: true, type: 'headers', match: { url: '*/echo*', method: '*' }, headersMod: { request: [{ op: 'set', name: 'X-A', value: '1' }], response: [] } }
        ]);
        // Make the popup remember a check result too.
        await popup.evaluate(() => { window.spliceTapPopup.rules[0].testStatus = 'passed'; });
        await popup.evaluate(() => {
            window.__exported = null;
            const original = URL.createObjectURL;
            URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__exported = t; }); return original.call(URL, blob); };
        });
        await popup.click('#tabData');
        await popup.click('#exportRulesBtn');
        const exported = JSON.parse(await waitFor(() => popup.evaluate(() => window.__exported), { label: 'export blob' }));
        expect(exported.rules.map((r) => r.id)).toEqual(['a', 'h']);
        for (const r of exported.rules) {
            expect(r).not.toHaveProperty('hitCount');
            expect(r).not.toHaveProperty('testStatus');
            expect(r).not.toHaveProperty('dnrRuleId');
        }
        // The stored rule still has its counter.
        expect((await storedRules()).find((r) => r.id === 'a').hitCount).toBe(41);
    });

    // ---- PER-83: Reset ----------------------------------------------------------------------------------------------

    test('PER-83: Reset re-renders in place (no reload), announces once, and parks focus on the tab strip', async () => {
        await openPopup([rule('a'), rule('b')]);
        await popup.evaluate(() => { window.__marker = 'same-document'; });
        await popup.click('#tabData');
        await popup.click('#resetAllBtn');
        await popup.click('#resetConfirmBtn');
        await waitFor(async () => (await storedRules()).length === 0, { label: 'reset' });

        await sleep(1500); // the old code reloaded the page after 600 ms
        expect(await popup.evaluate(() => window.__marker)).toBe('same-document');
        expect((await liveRegion()).text).toBe('All SpliceTap data deleted');
        expect(await popup.$eval('#tabRuleCount', (e) => e.textContent.trim())).toBe('0');
        expect(await popup.$eval('#exportCount', (e) => e.textContent.trim())).toBe('0');
        const focused = await active();
        expect(focused.id).toBe('tabData');
        // The Rules pane shows the empty state, not the old rows.
        await popup.click('#tabRules');
        expect(await popup.$$eval('.rule-card', (els) => els.length)).toBe(0);
        expect(await popup.$eval('#statusText', (e) => e.textContent.trim())).toBe('No rules');
    });

    // ---- PER-55: check, not test --------------------------------------------------------------------------------------------

    test('PER-55: the per-rule action is a validity check ("Valid"), never "Test passed", and hits are the evidence', async () => {
        await openPopup([rule('a', { hitCount: 3 }), rule('b')]);

        // Evidence of it working is visible on the row: a count, or "No hits yet".
        const hits = await popup.$$eval('.rule-card', (els) => els.map((c) => c.querySelector('.hit-count').textContent.trim()));
        expect(hits).toEqual(['3 hits', 'No hits yet']);

        const btn = await popup.$eval('.rule-action[data-action="test"][data-rule-id="b"]', (b) => b.getAttribute('aria-label'));
        expect(btn).toBe('Check syntax of Rule b');

        await popup.click('.rule-action[data-action="test"][data-rule-id="b"]');
        await waitFor(async () => (await toastTexts()).some((t) => /^Valid/.test(t)), { label: 'a "Valid" toast' });
        const label = await popup.$eval('.rule-card[data-rule-id="b"] .status-indicator', (e) => e.getAttribute('aria-label'));
        expect(label).toMatch(/^Valid/);
        expect(label).not.toMatch(/passed/i);
        expect(await popup.evaluate(() => /Test passed/i.test(document.body.innerText + document.getElementById('liveRegion').textContent))).toBe(false);
        // The hit count still says "No hits yet": a valid rule is not a working one.
        expect(await popup.$eval('.rule-card[data-rule-id="b"] .hit-count', (e) => e.textContent.trim())).toBe('No hits yet');
    });

    test('PER-55: an invalid rule is reported as Invalid with the reason', async () => {
        await openPopup([rule('a')]);
        // Break the popup's copy only; the check validates what it is sent.
        await popup.evaluate(() => { window.spliceTapPopup.rules[0].name = 'x'.repeat(150); });
        await popup.click('.rule-action[data-action="test"][data-rule-id="a"]');
        await waitFor(async () => (await toastTexts()).some((t) => /^Invalid: /.test(t)), { label: 'an "Invalid" toast' });
        const label = await popup.$eval('.rule-card[data-rule-id="a"] .status-indicator', (e) => e.getAttribute('aria-label'));
        expect(label).toMatch(/^Invalid: /);
        expect((await liveRegion()).live).toBe('assertive');
    });

    // ---- PER-69 / PER-53 / PER-70 -----------------------------------------------------------------------------------------------

    test('PER-69: with rules but none enabled, the header says "Active (0/2)", not "No rules"', async () => {
        await openPopup([rule('a', { enabled: false }), rule('b', { enabled: false })]);
        expect(await popup.$eval('#statusText', (e) => e.textContent.trim())).toBe('Active (0/2)');
        await popup.click('.rule-checkbox[data-rule-id="a"]');
        await waitFor(() => popup.evaluate(() => document.getElementById('statusText').textContent.trim() === 'Active (1)'), { label: 'one enabled' });
    });

    test('PER-53: the footer counter is labelled "today"', async () => {
        await openPopup([rule('a')]);
        expect(await popup.$eval('#statsText', (e) => e.textContent.trim())).toMatch(/^\d+ intercepts? today$/);
    });

    test('PER-70: long names and URLs keep their full text in a title, and the outcome comes before the URL', async () => {
        const longName = 'A very long rule name '.repeat(4).trim();
        const longUrl = `*://api.example.com/${'segment/'.repeat(12)}*`;
        await openPopup([rule('a', {
            name: longName,
            match: { url: longUrl, method: 'POST' },
            response: { statusCode: 201, statusText: 'Created', headers: {}, body: {}, delay: 0, mode: 'static' }
        })]);
        const row = await popup.$eval('.rule-card[data-rule-id="a"]', (c) => ({
            nameTitle: c.querySelector('.rule-name').title,
            detailsTitle: c.querySelector('.rule-details').title,
            detailsText: c.querySelector('.rule-details').textContent.replace(/\s+/g, ' ').trim()
        }));
        expect(row.nameTitle).toBe(longName);
        expect(row.detailsTitle).toContain(longUrl);
        expect(row.detailsTitle).toContain('201 Created');
        expect(row.detailsText.indexOf('→ 201 Created')).toBeGreaterThanOrEqual(0);
        expect(row.detailsText.indexOf('→ 201 Created')).toBeLessThan(row.detailsText.indexOf('api.example.com'));
    });

    // ---- accessibility audits of the new states ---------------------------------------------------------------------------------------

    test.each(['light', 'dark'])('axe: Rules tab with hits, a disabled rule, a failed check and a toast (%s)', async (theme) => {
        await openPopup([rule('a', { hitCount: 5 }), rule('b', { enabled: false }), rule('c')], { settings: { theme } });
        await popup.evaluate(() => { window.spliceTapPopup.rules[2].name = 'x'.repeat(150); });
        await popup.click('.rule-action[data-action="test"][data-rule-id="c"]');
        await waitFor(async () => (await toastTexts()).some((t) => /^Invalid/.test(t)), { label: 'check result' });
        await popup.reload({ waitUntil: 'load' });
        await popup.waitForSelector('.rule-card');
        await deleteByKeyboard('a');
        await sleep(400);
        expect(await auditA11y(popup)).toEqual([]);
    });

    test.each(['light', 'dark'])('axe: Data tab with an import report and a replace warning (%s)', async (theme) => {
        await openPopup([rule('e1', { name: 'Users', type: 'block', response: undefined, match: { url: '*/users*', method: 'GET' } })], { settings: { theme } });
        await importJson(JSON.stringify([
            { id: 'z', name: 'Users again', enabled: true, type: 'block', match: { url: '*/users*', method: 'GET' } },
            { id: 'y', name: 'Fresh', enabled: true, type: 'block', match: { url: '*/fresh*', method: 'GET' } }
        ]));
        await popup.click('#importConfirmBtn');
        await popup.waitForSelector('#importReport:not([hidden])');
        // Arm a replace as well, so the warning text is in the audit.
        await popup.click('#importToggleBtn');
        await popup.click('#importMerge');
        await popup.$eval('#importJson', (el) => { el.value = '[{"name":"Z","type":"block","match":{"url":"*/z*","method":"GET"}}]'; });
        await popup.click('#importConfirmBtn');
        await popup.waitForSelector('#importReplaceWarn:not([hidden])');
        // B2 fix-up: this was flaky in the dark theme. The pointer was still over the Replace button it
        // had just clicked, and the hover tint (and its 0.15s transition) put the danger text at 4.41:1
        // in some runs and 4.9:1 in others. Move the pointer off everything and let every transition
        // finish before reading colours.
        await popup.mouse.move(0, 0);
        await popup.evaluate(() => Promise.race([
            Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))),
            new Promise((resolve) => setTimeout(resolve, 2000))
        ]));
        await sleep(100);
        expect(await auditA11y(popup)).toEqual([]);
    });

    test.each(['light', 'dark'])('axe: the empty state with its buttons (%s)', async (theme) => {
        await openPopup([], { settings: { theme } });
        expect(await auditA11y(popup)).toEqual([]);
    });

    test('axe: Data tab with named capture buttons, and the Settings tab', async () => {
        await openPopup([]);
        await seedCaptures();
        expect(await auditA11y(popup)).toEqual([]);
        await popup.click('#tabSettings');
        await sleep(150);
        expect(await auditA11y(popup)).toEqual([]);
    });

    test('axe: the reload banner', async () => {
        await openPopup([rule('a')]);
        await stubTabs({ url: 'http://app.example.test/' });
        await popup.click('#newRuleBtn');
        await popup.waitForSelector('#reloadNotice');
        await popup.mouse.move(0, 0);
        await sleep(500);
        expect(await auditA11y(popup)).toEqual([]);
    });

    test('ran without errors', async () => {
        await openPopup([rule('a')]);
        expect(h.allErrors).toEqual([]);
    });
});
