/**
 * Editor fix group (E1): the in-page editor, the options-page editor and the
 * DevTools panel, against the persona-review findings PER-73, 77, 78, 84, 86,
 * 26, 50, 55, 61, 63 (editor) and 79, 80, 53 (panel).
 *
 * The in-page editor lives in a CLOSED shadow root and ignores untrusted
 * clicks, so it is driven through tests/e2e/editor-driver.js (real mouse and
 * keyboard over CDP). axe cannot see into a closed root, so the axe audits run
 * on the options-page host, which mounts the same editor in an open one.
 */

const { launch, pageFetch, waitFor, sleep, auditA11y } = require('./harness');
const ed = require('./editor-driver');

const existing = (overrides = {}) => ({
    id: 'existing-1',
    name: 'Existing rule',
    enabled: true,
    type: 'mock',
    match: { url: '*/api/existing*', method: 'GET' },
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { v: 1 }, delay: 0, mode: 'static' },
    hitCount: 0,
    created: '2026-01-02T03:04:05.000Z',
    ...overrides
});

/** Like editor-driver's inShadow, but for any closed-root host (the toast). */
async function inHostShadow(page, hostId, fn, ...args) {
    const client = await page.createCDPSession();
    try {
        const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
        const stack = [root];
        let backendNodeId = null;
        while (stack.length && backendNodeId === null) {
            const node = stack.pop();
            const attrs = node.attributes || [];
            for (let i = 0; i < attrs.length; i += 2) {
                if (attrs[i] === 'id' && attrs[i + 1] === hostId && node.shadowRoots && node.shadowRoots[0]) {
                    backendNodeId = node.shadowRoots[0].backendNodeId;
                }
            }
            for (const child of node.children || []) stack.push(child);
            for (const sr of node.shadowRoots || []) stack.push(sr);
        }
        if (backendNodeId === null) return null;
        const { object } = await client.send('DOM.resolveNode', { backendNodeId });
        const { result, exceptionDetails } = await client.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `function (...args) { return (${fn.toString()})(this, ...args); }`,
            arguments: args.map((value) => ({ value })),
            returnByValue: true
        });
        if (exceptionDetails) throw new Error('in-shadow evaluation failed: ' + exceptionDetails.text);
        return result.value;
    } finally {
        await client.detach().catch(() => {});
    }
}

const attr = (page, id, name) => ed.inShadow(page, (root, i, n) => {
    const el = root.getElementById(i);
    return el ? el.getAttribute(n) : undefined;
}, id, name);

describe('in-page editor (overlay host)', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    beforeEach(async () => { await h.reset(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }); page = null; });

    async function openOverlay(rule, { prepare } = {}) {
        if (rule) await h.saveRule(rule);
        page = await h.openPage();
        await page.bringToFront();
        if (prepare) await page.evaluate(prepare);
        await h.openOverlay(page, rule ? { mode: 'edit', rule } : { mode: 'new' });
        await waitFor(() => ed.isOpen(page), { label: 'the editor to open' });
        await sleep(150);
    }

    const stored = async () => (await h.bg({ type: 'getRules' })).rules;
    const save = async () => { await ed.click(page, 'tmSave'); };
    async function saveAndWait(predicate, label) {
        await save();
        return waitFor(async () => {
            const rules = await stored();
            return predicate(rules) ? rules : null;
        }, { label });
    }

    // ---- PER-73 ----------------------------------------------------------

    const SIZED = ['tmTitle', 'tmName', 'tmUrl', 'tmUrlHint', 'tmBody', 'tmSave', 'tmCancel', 'tmClose'];

    async function computedSizes() {
        return ed.inShadow(page, (root, ids) => {
            const out = {};
            for (const id of ids) out[id] = window.getComputedStyle(root.getElementById(id)).fontSize;
            out.label = window.getComputedStyle(root.querySelector('label[for="tmName"]')).fontSize;
            out.legend = window.getComputedStyle(root.querySelector('.tm-legend')).fontSize;
            out.hintBar = window.getComputedStyle(root.getElementById('tmHintClose')).fontSize;
            return out;
        }, SIZED);
    }

    test('PER-73: the editor renders at the same size whatever the host page sets as its root font size', async () => {
        await openOverlay();
        const plain = await computedSizes();
        await page.close();

        await openOverlay(null, { prepare: () => { document.documentElement.style.fontSize = '62.5%'; } });
        expect(await page.evaluate(() => window.getComputedStyle(document.documentElement).fontSize)).toBe('10px'); // the reset took effect
        const reset = await computedSizes();

        expect(reset).toEqual(plain);
        // and those sizes are the design's, not a shrunken version of them
        expect(plain.label).toBe('10px');
        expect(plain.tmUrl).toBe('12.5px');
        expect(plain.tmUrlHint).toBe('11px');
        expect(plain.tmSave).toBe('12.5px');
        expect(plain.hintBar).toBe('15px');
    });

    // ---- PER-78 ----------------------------------------------------------

    test('PER-78: an RTL host page does not flip the English editor or its code fields', async () => {
        await openOverlay(null, { prepare: () => { document.documentElement.dir = 'rtl'; document.body.dir = 'rtl'; } });
        const dirs = await ed.inShadow(page, (root) => ({
            root: root.querySelector('.tm-backdrop').getAttribute('dir'),
            panel: window.getComputedStyle(root.querySelector('.tm-panel')).direction,
            url: window.getComputedStyle(root.getElementById('tmUrl')).direction,
            body: window.getComputedStyle(root.getElementById('tmBody')).direction,
            align: window.getComputedStyle(root.getElementById('tmUrl')).textAlign,
            // the close button stays at the right of the header, the brand at the left
            brandLeft: root.querySelector('.tm-brand').getBoundingClientRect().left,
            closeLeft: root.getElementById('tmClose').getBoundingClientRect().left
        }));
        expect(dirs).toMatchObject({ root: 'ltr', panel: 'ltr', url: 'ltr', body: 'ltr' });
        expect(['start', 'left']).toContain(dirs.align);
        expect(dirs.brandLeft).toBeLessThan(dirs.closeLeft);
    });

    // ---- PER-77 / PER-86 -------------------------------------------------

    test('PER-77: required fields are marked, visibly and for assistive tech', async () => {
        await openOverlay();
        expect(await attr(page, 'tmName', 'aria-required')).toBe('true');
        expect(await attr(page, 'tmUrl', 'aria-required')).toBe('true');
        const marks = await ed.inShadow(page, (root) => ({
            name: root.querySelector('label[for="tmName"] .tm-req').textContent,
            url: root.querySelector('label[for="tmUrl"] .tm-req').textContent,
            // decorative to a screen reader: aria-required says it instead
            hidden: root.querySelector('label[for="tmName"] .tm-req').getAttribute('aria-hidden'),
            legend: root.querySelector('.tm-legend').textContent.replace(/\s+/g, ' ').trim()
        }));
        expect(marks).toEqual({ name: '*', url: '*', hidden: 'true', legend: '* Required field' });
        expect(await attr(page, 'tmType', 'aria-required')).toBeNull(); // not everything is required
    });

    test('PER-77: a failed save marks each invalid field, describes it, and focuses the first', async () => {
        await openOverlay();
        await save();
        await waitFor(async () => /name is required/i.test(await ed.errorText(page)), { label: 'the summary' });

        // name is empty; the URL is empty too (a new rule has no URL until typed)
        for (const id of ['tmName', 'tmUrl']) {
            expect(await attr(page, id, 'aria-invalid')).toBe('true');
        }
        const described = await ed.inShadow(page, (root) => ['tmName', 'tmUrl'].map((id) => {
            const ids = root.getElementById(id).getAttribute('aria-describedby').split(/\s+/);
            return { id, ids, texts: ids.map((i) => (root.getElementById(i) || {}).textContent) };
        }));
        expect(described[0].ids).toEqual(['tmNameErr']);
        expect(described[0].texts[0]).toMatch(/name is required/i);
        // the URL keeps its hint (PER-86) and gains its error
        expect(described[1].ids).toEqual(['tmUrlHint', 'tmUrlErr']);
        expect(described[1].texts[0]).toMatch(/wildcards/);
        expect(described[1].texts[1]).toMatch(/URL pattern is required/);

        expect(await ed.activeElementId(page)).toBe('tmName'); // first invalid, not Save
        expect(await stored()).toEqual([]);
    });

    test('PER-77: focus goes to the first invalid field in form order, and fixing a field clears its error', async () => {
        await openOverlay();
        await ed.fill(page, 'tmName', 'Has a name');
        await ed.fill(page, 'tmType', 'delay');
        await ed.fill(page, 'tmDelayMs', '0'); // below the minimum; URL empty as well
        await save();
        await waitFor(async () => (await attr(page, 'tmUrl', 'aria-invalid')) === 'true', { label: 'the URL to be marked' });
        expect(await attr(page, 'tmDelayMs', 'aria-invalid')).toBe('true');
        expect(await attr(page, 'tmName', 'aria-invalid')).toBeNull();
        expect(await ed.activeElementId(page)).toBe('tmUrl'); // URL comes before Delay in the form

        // typing in the URL answers its error; the other stays
        await ed.fill(page, 'tmUrl', '*/api/x*');
        expect(await attr(page, 'tmUrl', 'aria-invalid')).toBeNull();
        expect(await attr(page, 'tmUrl', 'aria-describedby')).toBe('tmUrlHint');
        expect(await attr(page, 'tmDelayMs', 'aria-invalid')).toBe('true');
        expect(await attr(page, 'tmDelayMs', 'aria-describedby')).toBe('tmDelayMsHint tmDelayMsErr');
    });

    test('PER-77: malformed JSON is tied to its own field', async () => {
        await openOverlay();
        await ed.fill(page, 'tmName', 'Bad json');
        await ed.fill(page, 'tmUrl', '*/api/x*');
        await ed.fill(page, 'tmMatchHeaders', '{"x-api-key": ');
        await save();
        await waitFor(async () => (await attr(page, 'tmMatchHeaders', 'aria-invalid')) === 'true', { label: 'the headers field to be marked' });
        expect(await ed.activeElementId(page)).toBe('tmMatchHeaders');
        expect(await ed.errorText(page)).toMatch(/Match Request Headers: invalid JSON/);
        expect(await attr(page, 'tmName', 'aria-invalid')).toBeNull();
    });

    test('PER-86: the hints under URL, Patch, Delay and Redirect are linked with aria-describedby', async () => {
        await openOverlay();
        const links = await ed.inShadow(page, (root) => ['tmUrl', 'tmPatch', 'tmDelayMs', 'tmRedirect'].map((id) => {
            const el = root.getElementById(id);
            const target = root.getElementById(el.getAttribute('aria-describedby'));
            return { id, hint: target && target.className, text: target && target.textContent.length > 10 };
        }));
        expect(links).toEqual([
            { id: 'tmUrl', hint: 'tm-hint', text: true },
            { id: 'tmPatch', hint: 'tm-hint', text: true },
            { id: 'tmDelayMs', hint: 'tm-hint', text: true },
            { id: 'tmRedirect', hint: 'tm-hint', text: true }
        ]);
    });

    // ---- PER-84 ----------------------------------------------------------

    test('PER-84: the "press Escape again" arming does not lapse after a few seconds', async () => {
        await openOverlay();
        await ed.fill(page, 'tmName', 'Half-written');
        await page.keyboard.press('Escape');
        expect(await ed.errorText(page)).toMatch(/unsaved changes/i);

        await sleep(4600); // the old window was 4000 ms
        expect(await ed.isOpen(page)).toBe(true);
        expect(await ed.errorText(page)).toMatch(/unsaved changes/i); // still armed, still saying so
        await page.keyboard.press('Escape');
        await waitFor(async () => !(await ed.isOpen(page)), { label: 'the editor to close on the second Escape' });
        expect(await stored()).toEqual([]);
    });

    test('PER-84: any other input disarms it, and withdraws the message with it', async () => {
        await openOverlay();
        await ed.fill(page, 'tmName', 'Half-written');
        await page.keyboard.press('Escape');
        expect(await ed.errorText(page)).toMatch(/unsaved changes/i);

        await page.keyboard.type('x'); // the next input that is not Escape
        expect(await ed.errorText(page)).toBe('');
        await page.keyboard.press('Escape'); // arms again; does not close
        expect(await ed.isOpen(page)).toBe(true);
        expect(await ed.errorText(page)).toMatch(/unsaved changes/i);
        await page.keyboard.press('Escape');
        await waitFor(async () => !(await ed.isOpen(page)), { label: 'the editor to close' });
    });

    // ---- PER-26 ----------------------------------------------------------

    test('PER-26: renaming a rule that serves an empty body keeps it empty', async () => {
        await openOverlay(existing({ response: { statusCode: 200, headers: {}, body: '', delay: 0, mode: 'static' } }));
        await ed.fill(page, 'tmName', 'Renamed');
        const rules = await saveAndWait((r) => r[0] && r[0].name === 'Renamed', 'the rename');
        expect(rules[0].response.body).toBe('');

        // and it really serves nothing
        const target = await h.openPage();
        const res = await waitFor(async () => {
            const r = await pageFetch(target, '/api/existing');
            return r.marker === 'true' ? r : null;
        }, { label: 'the rule to apply' });
        expect(res.status).toBe(200);
        expect(res.body).toBe('');
        await target.close();
    });

    test('PER-26: a new rule saved with a blank or whitespace body stores an empty string, not {}', async () => {
        await openOverlay();
        await ed.fill(page, 'tmName', 'Empty 200');
        await ed.fill(page, 'tmUrl', '*/api/empty*');
        await ed.fill(page, 'tmBody', '  ');
        const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
        expect(rules[0].response.body).toBe('');
    });

    // ---- PER-50 ----------------------------------------------------------

    test('PER-50: a delay typed as 2e3 is 2000 ms, not 2', async () => {
        await openOverlay();
        await ed.fill(page, 'tmType', 'delay');
        await ed.fill(page, 'tmName', 'Slow');
        await ed.fill(page, 'tmUrl', '*/api/slow*');
        await ed.fill(page, 'tmDelayMs', '2e3');
        const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
        expect(rules[0].delayMs).toBe(2000);
    });

    test('PER-50: status and mock-delay accept the same notation', async () => {
        await openOverlay();
        await ed.fill(page, 'tmName', 'Notation');
        await ed.fill(page, 'tmUrl', '*/api/n*');
        await ed.fill(page, 'tmStatus', '4e2');
        await ed.fill(page, 'tmDelay', '2e2');
        const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
        expect(rules[0].response).toMatchObject({ statusCode: 400, delay: 200 });
    });

    test.each([
        ['tmDelayMs', 'delay', '1.5'],
        ['tmDelayMs', 'delay', '2e-1'],
        ['tmStatus', 'mock', '200.5']
    ])('PER-50: %s = %s is refused as not a whole number, never truncated', async (id, type, text) => {
        await openOverlay();
        await ed.fill(page, 'tmType', type);
        await ed.fill(page, 'tmName', 'Fractional');
        await ed.fill(page, 'tmUrl', '*/api/frac*');
        await ed.fill(page, id, text);
        await save();
        await waitFor(async () => /whole number/.test(await ed.errorText(page)), { label: 'the whole-number error' });
        expect(await attr(page, id, 'aria-invalid')).toBe('true');
        expect(await ed.activeElementId(page)).toBe(id);
        expect(await stored()).toEqual([]);
    });

    test('PER-50: a number field left with unparseable text is refused, not saved as blank', async () => {
        await openOverlay();
        await ed.fill(page, 'tmType', 'delay');
        await ed.fill(page, 'tmName', 'Garbage');
        await ed.fill(page, 'tmUrl', '*/api/g*');
        await ed.fill(page, 'tmDelayMs', '1e'); // a number input reports this as an empty value with badInput set
        await save();
        await waitFor(async () => /whole number/.test(await ed.errorText(page)), { label: 'the error' });
        expect(await stored()).toEqual([]);
    });

    // ---- PER-55 (editor) -------------------------------------------------

    test('PER-55: the URL placeholder matches a path with no trailing segment, and a new rule defaults to Any method', async () => {
        await openOverlay();
        expect(await attr(page, 'tmUrl', 'placeholder')).toBe('*/api/users*');
        expect(await ed.value(page, 'tmMethod')).toBe('*');
        const label = await ed.inShadow(page, (root) => root.getElementById('tmMethod').selectedOptions[0].textContent);
        expect(label).toBe('Any (*)');
    });

    test('PER-55: a rule created from the placeholder pattern fires for /api/users', async () => {
        await openOverlay();
        await ed.fill(page, 'tmName', 'Users');
        await ed.fill(page, 'tmUrl', '*/api/users*'); // what the placeholder now suggests
        await saveAndWait((r) => r.length === 1, 'the rule to save');
        const target = await h.openPage();
        const res = await waitFor(async () => {
            const r = await pageFetch(target, '/api/users', { method: 'POST' });
            return r.marker === 'true' ? r : null;
        }, { label: 'the rule to intercept a POST to /api/users' });
        expect(res.status).toBe(200);
        await target.close();
    });

    test('PER-55: editing a rule keeps its own method, GET included', async () => {
        await openOverlay(existing());
        expect(await ed.value(page, 'tmMethod')).toBe('GET');
    });

    // ---- PER-61 ----------------------------------------------------------

    test('PER-61: saving shows a confirmation toast in a closed shadow root with a live region, then removes it', async () => {
        await openOverlay();
        await ed.fill(page, 'tmName', 'My new rule');
        await ed.fill(page, 'tmUrl', '*/api/toast*');
        await save();
        await waitFor(async () => !(await ed.isOpen(page)), { label: 'the editor to close' });

        const read = () => inHostShadow(page, 'splicetap-toast-host', (root) => {
            const live = root.querySelector('[role="status"]');
            return live ? {
                text: live.textContent.replace(/\s+/g, ' ').trim(),
                polite: live.getAttribute('aria-live'),
                atomic: live.getAttribute('aria-atomic'),
                pointerEvents: window.getComputedStyle(live).pointerEvents
            } : null;
        });
        const toast = await waitFor(async () => {
            const t = await read();
            return t && t.text ? t : null;
        }, { label: 'the toast text' });
        expect(toast.text).toBe("✓Rule 'My new rule' saved"); // the tick is aria-hidden; a screen reader hears the rest
        expect(toast).toMatchObject({ polite: 'polite', atomic: 'true', pointerEvents: 'none' });

        // S-1: closed, so the page cannot read it
        expect(await page.evaluate(() => {
            const host = document.getElementById('splicetap-toast-host');
            return host ? host.shadowRoot : 'missing';
        })).toBeNull();

        // it goes away by itself
        await waitFor(async () => (await read()) === null, { timeout: 9000, label: 'the toast to remove itself' });
        expect(await page.evaluate(() => !!document.getElementById('splicetap-toast-host'))).toBe(false);
    });

    test('PER-61: no toast when the editor is cancelled', async () => {
        await openOverlay();
        await ed.fill(page, 'tmName', 'Never saved');
        await ed.click(page, 'tmCancel');
        await waitFor(async () => !(await ed.isOpen(page)), { label: 'the editor to close' });
        await sleep(300);
        expect(await page.evaluate(() => !!document.getElementById('splicetap-toast-host'))).toBe(false);
    });

    // ---- PER-63 ----------------------------------------------------------

    /** Reload and report which dialogs the page raised. */
    async function reloadAndWatchDialogs() {
        const dialogs = [];
        const onDialog = async (d) => { dialogs.push(d.type()); await d.accept(); };
        page.on('dialog', onDialog);
        await page.reload({ waitUntil: 'load' });
        page.off('dialog', onDialog);
        return dialogs;
    }

    test('PER-63: a dirty form makes the browser prompt before the page unloads', async () => {
        await openOverlay();
        await ed.fill(page, 'tmName', 'Draft in progress');
        expect(await reloadAndWatchDialogs()).toEqual(['beforeunload']);
    });

    test('PER-63: no prompt while nothing has been typed, after Cancel, or after Save', async () => {
        await openOverlay();
        expect(await reloadAndWatchDialogs()).toEqual([]); // opened, untouched

        await page.close();
        await openOverlay();
        await ed.fill(page, 'tmName', 'Typed then cancelled');
        await ed.click(page, 'tmCancel');
        await waitFor(async () => !(await ed.isOpen(page)), { label: 'the editor to close' });
        expect(await reloadAndWatchDialogs()).toEqual([]);

        await page.close();
        await openOverlay();
        await ed.fill(page, 'tmName', 'Typed then saved');
        await ed.fill(page, 'tmUrl', '*/api/saved*');
        await saveAndWait((r) => r.length === 1, 'the rule to save');
        await waitFor(async () => !(await ed.isOpen(page)), { label: 'the editor to close' });
        expect(await reloadAndWatchDialogs()).toEqual([]);
    });

    test('PER-63: the draft is not kept anywhere the page can read', async () => {
        await openOverlay();
        await ed.fill(page, 'tmName', 'SECRET-DRAFT-NAME');
        const leaked = await page.evaluate(() => {
            const hay = [];
            for (const store of [window.localStorage, window.sessionStorage]) {
                for (let i = 0; i < store.length; i++) hay.push(store.key(i) + '=' + store.getItem(store.key(i)));
            }
            hay.push(document.documentElement.outerHTML, document.cookie);
            return hay.join('\n').includes('SECRET-DRAFT-NAME');
        });
        expect(leaked).toBe(false);
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});

describe('editor accessibility (axe, options host: an open root)', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    async function openOptions(theme) {
        await h.reset();
        await h.extensionEval((t) => chrome.storage.local.get('spliceTapSettings').then((r) =>
            chrome.storage.local.set({ spliceTapSettings: { ...(r.spliceTapSettings || {}), theme: t } })), theme);
        page = await h.browser.newPage();
        await page.setViewport({ width: 1100, height: 900 });
        await page.goto(h.extUrl('options/options.html?action=new'), { waitUntil: 'load' });
        await waitFor(() => ed.isOpen(page), { label: 'the editor to open' });
        await sleep(300);
    }

    test.each(['dark', 'light'])('the editor with required markers and a failed-save state has no WCAG A/AA violations (%s)', async (theme) => {
        await openOptions(theme);
        const violations = [];
        violations.push(...(await auditA11y(page)).map((v) => ({ state: 'pristine', ...v })));

        // a failed save: aria-invalid + aria-describedby on real elements, and the red text on both themes
        await ed.click(page, 'tmSave');
        await waitFor(async () => (await attr(page, 'tmName', 'aria-invalid')) === 'true', { label: 'invalid state' });
        violations.push(...(await auditA11y(page)).map((v) => ({ state: 'failed save', ...v })));

        // and with the type-specific fields that carry hints
        for (const type of ['delay', 'redirect', 'mock']) {
            await ed.fill(page, 'tmType', type);
            await ed.click(page, 'tmSave');
            violations.push(...(await auditA11y(page)).map((v) => ({ state: type + ' invalid', ...v })));
        }
        expect(violations).toEqual([]);
    });

    test('PER-77: the options host behaves the same — focus on the first invalid field', async () => {
        await openOptions('dark');
        await ed.click(page, 'tmSave');
        await waitFor(async () => (await attr(page, 'tmName', 'aria-invalid')) === 'true', { label: 'invalid state' });
        expect(await ed.activeElementId(page)).toBe('tmName');
    });

    test('PER-61: the options host still reports a save in its own status line', async () => {
        await openOptions('dark');
        await ed.fill(page, 'tmName', 'Saved from options');
        await ed.fill(page, 'tmUrl', '*/api/opt*');
        await ed.click(page, 'tmSave');
        await waitFor(async () => /Saved "Saved from options"/.test(await page.$eval('#status', (el) => el.textContent)), { label: 'the status line' });
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});

describe('DevTools panel', () => {
    let h;
    let panel;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => {
        for (const p of [panel, page]) if (p && !p.isClosed()) await p.close();
        panel = null;
        page = null;
    });

    const mockRule = (id) => ({
        id, name: `Mock ${id}`, enabled: true, type: 'mock',
        match: { url: `*/api/${id}*`, method: 'GET' },
        response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { id }, delay: 0, mode: 'static' }
    });

    /** Seed rules, make `calls` requests, and open the panel at `width`. */
    async function setUp(width, calls, { theme = 'dark' } = {}) {
        await h.reset();
        await h.extensionEval((t) => chrome.storage.local.get('spliceTapSettings').then((r) =>
            chrome.storage.local.set({ spliceTapSettings: { ...(r.spliceTapSettings || {}), theme: t } })), theme);
        for (const id of new Set(calls.map((c) => c.split('?')[0].split('/')[2]))) await h.saveRule(mockRule(id));
        page = await h.openPage();
        await waitFor(async () => (await pageFetch(page, calls[0])).marker === 'true', { label: 'the first rule to apply' });
        for (const c of calls.slice(1)) await pageFetch(page, c);
        panel = await h.browser.newPage();
        await panel.setViewport({ width, height: 700 });
        await panel.goto(h.extUrl('devtools/panel.html'), { waitUntil: 'load' });
        await panel.bringToFront();
        await waitFor(async () => (await panel.$$('#requestItems .request-item')).length >= calls.length, { timeout: 8000, label: 'the rows' });
    }

    const dismissNames = () => panel.$$eval('.dismiss-btn', (els) => els.map((e) => e.getAttribute('aria-label')));
    const focusedInfo = () => panel.evaluate(() => {
        const a = document.activeElement;
        return { id: a.id || null, label: a.getAttribute('aria-label'), isBody: a === document.body };
    });

    test('PER-53: the stat that resets daily says "today"', async () => {
        await setUp(900, ['/api/aaa']);
        const labels = await panel.$$eval('.stat-label', (els) => els.map((e) => e.textContent.trim()));
        expect(labels).toContain('Intercepted today');
        expect(labels.join('|')).not.toMatch(/all time/i);
    });

    test('PER-79: at 320 px the URL gets a usable width, rows stack, and nothing scrolls sideways', async () => {
        await setUp(320, ['/api/users/42/profile/settings?token=a', '/api/orders/17/items?token=b']);
        const g = await panel.evaluate(() => {
            const row = document.querySelector('#requestItems .request-item');
            const r = (sel) => row.querySelector(sel).getBoundingClientRect();
            const list = document.getElementById('requestsList');
            return {
                url: { w: Math.round(r('.request-url').width), h: Math.round(r('.request-url').height) },
                // stacked: method/status on top, URL below, rule below that
                methodTop: r('.request-method').top, urlTop: r('.request-url').top, ruleTop: r('.rule-info').top,
                rowScrollW: row.scrollWidth, rowW: row.clientWidth,
                listScrollW: list.scrollWidth, listClientW: list.clientWidth,
                headerVisible: document.querySelector('.request-item-header').getBoundingClientRect().height > 2
            };
        });
        expect(g.url.w).toBeGreaterThan(200); // was 0
        expect(g.url.h).toBeLessThan(80);     // was 689: one character per line
        expect(g.urlTop).toBeGreaterThan(g.methodTop + 10);
        expect(g.ruleTop).toBeGreaterThan(g.urlTop + 10);
        expect(g.rowScrollW).toBeLessThanOrEqual(g.rowW);
        expect(g.listScrollW).toBeLessThanOrEqual(g.listClientW);
        expect(g.headerVisible).toBe(false);
        // the header row is hidden from sight, not from the accessibility tree
        expect(await panel.$$eval('[role="columnheader"]', (els) => els.length)).toBe(6);
    });

    test('PER-79: at a wide width the rows keep their one-line layout', async () => {
        await setUp(900, ['/api/users/42?token=a']);
        const g = await panel.evaluate(() => {
            const row = document.querySelector('#requestItems .request-item');
            const r = (sel) => row.querySelector(sel).getBoundingClientRect();
            return { methodTop: r('.request-method').top, urlTop: r('.request-url').top, urlW: r('.request-url').width, headerVisible: document.querySelector('.request-item-header').getBoundingClientRect().height > 10 };
        });
        expect(Math.abs(g.urlTop - g.methodTop)).toBeLessThan(12); // same line (centre-aligned)
        expect(g.urlW).toBeGreaterThan(150);
        expect(g.headerVisible).toBe(true);
    });

    test('PER-79: the layout switches below ~560 px and is stable around it', async () => {
        await setUp(900, ['/api/users/42?token=a']);
        for (const [w, stacked] of [[700, false], [561, false], [560, true], [480, true], [360, true]]) {
            await panel.setViewport({ width: w, height: 700 });
            await sleep(100);
            const g = await panel.evaluate(() => {
                const row = document.querySelector('#requestItems .request-item');
                return { stacked: row.querySelector('.request-url').getBoundingClientRect().top > row.querySelector('.request-method').getBoundingClientRect().bottom - 4, urlW: row.querySelector('.request-url').getBoundingClientRect().width };
            });
            expect({ w, stacked: g.stacked }).toEqual({ w, stacked });
            expect(g.urlW).toBeGreaterThan(100);
        }
    });

    test('PER-80: every dismiss button has its own name, naming the request', async () => {
        await setUp(900, ['/api/aaa/one', '/api/bbb/two', '/api/ccc/three?secret=1']);
        const names = await dismissNames();
        expect(new Set(names).size).toBe(3);
        // newest first
        expect(names[0]).toMatch(/^Dismiss GET http:\/\/127\.0\.0\.1:\d+\/api\/ccc\/three$/); // the query string stays out of it (S-8)
        expect(names[1]).toMatch(/\/api\/bbb\/two$/);
        expect(names[2]).toMatch(/\/api\/aaa\/one$/);
    });

    test('PER-80: two rows for the same call are still told apart, and stay told apart when newer traffic arrives', async () => {
        await setUp(900, ['/api/dup/x?n=1', '/api/dup/x?n=2']);
        let names = await dismissNames();
        expect(new Set(names).size).toBe(2);
        expect(names.map((n) => (n.match(/\(#(\d)\)$/) || [])[1])).toEqual(['2', '1']); // oldest is #1
        await pageFetch(page, '/api/dup/x?n=3');
        await waitFor(async () => (await dismissNames()).length === 3, { timeout: 8000, label: 'the third row' });
        names = await dismissNames();
        expect(names.map((n) => (n.match(/\(#(\d)\)$/) || [])[1])).toEqual(['3', '2', '1']);
    });

    test('PER-80: dismissing a row moves focus to the next row\'s dismiss button, then the previous, then the list', async () => {
        await setUp(900, ['/api/aaa/one', '/api/bbb/two', '/api/ccc/three']);
        // rows are newest first: ccc, bbb, aaa. Dismiss the middle one by keyboard.
        await panel.evaluate(() => document.querySelectorAll('.dismiss-btn')[1].focus());
        await panel.keyboard.press('Enter');
        let f = await focusedInfo();
        expect(f.isBody).toBe(false);
        expect(f.label).toMatch(/\/api\/aaa\/one$/); // the next row down

        // dismiss that (now last) row: focus goes to the previous one
        await panel.keyboard.press('Enter');
        f = await focusedInfo();
        expect(f.label).toMatch(/\/api\/ccc\/three$/);

        // dismiss the only row left: focus goes to the list, not <body>
        await panel.keyboard.press('Enter');
        f = await focusedInfo();
        expect(f).toMatchObject({ id: 'requestsList', isBody: false });
        expect(await panel.$eval('#logAnnouncer', (el) => el.textContent)).toMatch(/dismissed/i);
    });

    test('PER-80: a new request arriving does not knock focus off the button a keyboard user is on', async () => {
        await setUp(900, ['/api/aaa/one', '/api/bbb/two']);
        await h.saveRule(mockRule('ccc'));
        await panel.evaluate(() => document.querySelectorAll('.dismiss-btn')[1].focus());
        const before = (await focusedInfo()).label;
        await waitFor(async () => (await pageFetch(page, '/api/ccc/three')).marker === 'true', { label: 'the new rule to apply' });
        await waitFor(async () => (await panel.$$('#requestItems .request-item')).length === 3, { timeout: 8000, label: 'the new row' });
        expect((await focusedInfo()).label).toBe(before);
    });

    test('PER-80: Pause keeps one name, and aria-pressed carries the state', async () => {
        await setUp(900, ['/api/aaa/one']);
        const cdp = await panel.createCDPSession();
        const pauseButton = async () => {
            const { nodes } = await cdp.send('Accessibility.getFullAXTree');
            const node = nodes.find((n) => !n.ignored && n.role && n.role.value === 'button' && /Pause|Resume/.test((n.name && n.name.value) || ''));
            const props = Object.fromEntries((node.properties || []).map((p) => [p.name, p.value.value]));
            return { name: node.name.value, pressed: String(props.pressed) };
        };
        expect(await pauseButton()).toEqual({ name: 'Pause', pressed: 'false' });
        await panel.focus('#pauseBtn');
        await panel.keyboard.press('Space');
        await sleep(200);
        expect(await pauseButton()).toEqual({ name: 'Pause', pressed: 'true' });
        expect(await panel.$eval('#logAnnouncer', (el) => el.textContent)).toMatch(/paused/i);
        await panel.keyboard.press('Space');
        await sleep(200);
        expect(await pauseButton()).toEqual({ name: 'Pause', pressed: 'false' });
        await cdp.detach();
    });

    test.each([['dark', 900], ['light', 900], ['dark', 320], ['light', 320]])('has no WCAG A/AA violations (%s theme, %d px wide), with rows, a dismissed list and a paused log', async (theme, width) => {
        await setUp(width, ['/api/aaa/one', '/api/bbb/two', '/api/bbb/two?n=2'], { theme });
        // let the theme and the button transitions settle: axe samples colours mid-fade otherwise
        await sleep(500);
        const violations = (await auditA11y(panel)).map((v) => ({ state: 'rows', ...v }));
        await panel.click('#pauseBtn');
        await sleep(400);
        violations.push(...(await auditA11y(panel)).map((v) => ({ state: 'paused', ...v })));
        await panel.click('.dismiss-btn');
        await panel.evaluate(() => document.activeElement && document.activeElement.blur());
        await sleep(400);
        violations.push(...(await auditA11y(panel)).map((v) => ({ state: 'after dismiss', ...v })));
        expect(violations).toEqual([]);
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
