/**
 * The rule editor, end to end, in both places it appears:
 *
 *   - overlay:  in-page, opened over the user's tab from the popup;
 *   - options:  the extension's options page, the fallback where the overlay
 *               cannot run (chrome:// pages, the Web Store, PDFs).
 *
 * These used to be two separate editors that had drifted (CQ-1). The same
 * assertions run against both hosts, so they can only both pass if both hosts
 * behave identically — which, after R1, they do by construction: one editor.
 */

const { launch, pageFetch, waitFor, sleep } = require('./harness');
const ed = require('./editor-driver');

const existing = (overrides = {}) => ({
    id: 'existing-1',
    name: 'Existing rule',
    enabled: true,
    type: 'mock',
    match: { url: '*/api/existing*', method: 'GET' },
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { v: 1 }, delay: 0, mode: 'static' },
    hitCount: 42,
    created: '2026-01-02T03:04:05.000Z',
    ...overrides
});

const HOSTS = ['overlay', 'options'];

describe.each(HOSTS)('rule editor — %s host', (hostKind) => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    beforeEach(async () => { await h.reset(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    /** Open the editor for a new rule, or to edit `rule` (seeded first). */
    async function openEditor(rule) {
        if (rule) await h.saveRule(rule);
        if (hostKind === 'overlay') {
            page = await h.openPage();
            await h.openOverlay(page, rule ? { mode: 'edit', rule } : { mode: 'new' });
        } else {
            page = await h.browser.newPage();
            await page.setViewport({ width: 1100, height: 900 });
            const query = rule ? `?editRule=${encodeURIComponent(rule.id)}` : '?action=new';
            await page.goto(h.extUrl('options/options.html' + query), { waitUntil: 'load' });
        }
        await waitFor(() => ed.isOpen(page), { label: 'the editor to open' });
        await sleep(100);
        return page;
    }

    const stored = async () => (await h.bg({ type: 'getRules' })).rules;

    async function saveAndWait(predicate, label) {
        await ed.click(page, 'tmSave');
        return waitFor(async () => {
            const rules = await stored();
            return predicate(rules) ? rules : null;
        }, { label });
    }

    // ---- opening ---------------------------------------------------------

    test('a new-rule editor opens with focus on the name field', async () => {
        await openEditor();
        expect(await ed.activeElementId(page)).toBe('tmName');
        expect(await ed.inShadow(page, (root) => root.getElementById('tmTitle').textContent)).toMatch(/New Rule/i);
    });

    test('every editor button has a spoken name, not just a glyph', async () => {
        // The close button's only content is "×", which screen readers read
        // as "times" or "multiplication sign". axe accepts that as a name, so
        // it is checked here directly.
        await openEditor();
        const names = await ed.inShadow(page, (root) => Array.from(root.querySelectorAll('button')).map((b) => ({
            id: b.id,
            name: (b.getAttribute('aria-label') || b.textContent).trim()
        })));
        for (const { id, name } of names) {
            expect({ id, ok: /[a-z]{3,}/i.test(name) }).toEqual({ id, ok: true });
        }
        expect(names.find((b) => b.id === 'tmClose').name).toBe('Close editor');
    });

    test('editing fills the form from the rule', async () => {
        await openEditor(existing());
        expect(await ed.value(page, 'tmName')).toBe('Existing rule');
        expect(await ed.value(page, 'tmUrl')).toBe('*/api/existing*');
        expect(await ed.value(page, 'tmMethod')).toBe('GET');
        expect(JSON.parse(await ed.value(page, 'tmBody'))).toEqual({ v: 1 });
    });

    // ---- creating each type ------------------------------------------------

    test('creates a mock rule that then intercepts a real request', async () => {
        await openEditor();
        await ed.fill(page, 'tmName', 'Created mock');
        await ed.fill(page, 'tmUrl', '*/api/created*');
        await ed.fill(page, 'tmStatus', '201');
        await ed.fill(page, 'tmBody', '{"created": true}');
        const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');

        expect(rules[0]).toMatchObject({
            name: 'Created mock', type: 'mock', enabled: true,
            match: { url: '*/api/created*', method: 'GET' },
            response: { statusCode: 201, body: { created: true } }
        });
        expect(rules[0].response.statusText).toBe('Created');

        const target = await h.openPage();
        const r = await waitFor(async () => {
            const res = await pageFetch(target, '/api/created');
            return res.marker === 'true' ? res : null;
        }, { label: 'the new rule to intercept' });
        expect(r.status).toBe(201);
        await target.close();
    });

    const typeCases = [
        ['block', [], (r) => expect(r.type).toBe('block')],
        ['delay', [['tmDelayMs', '750']], (r) => expect(r.delayMs).toBe(750)],
        ['redirect', [['tmRedirect', 'https://example.test/elsewhere']], (r) => expect(r.redirect).toEqual({ destination: 'https://example.test/elsewhere' })],
        ['headers', [['tmHdrReq', '[{"op":"set","name":"X-Test","value":"1"}]']], (r) => {
            expect(r.headersMod.request).toEqual([{ op: 'set', name: 'X-Test', value: '1' }]);
            expect(typeof r.dnrRuleId).toBe('number');
        }],
        ['queryparams', [['tmQpAdd', '[{"key":"debug","value":"1"}]'], ['tmQpRemove', 'token, sid']], (r) => {
            expect(r.queryParams).toEqual({ add: [{ key: 'debug', value: '1' }], remove: ['token', 'sid'] });
        }]
    ];

    test.each(typeCases)('creates a %s rule', async (type, fields, check) => {
        await openEditor();
        await ed.fill(page, 'tmType', type);
        await ed.fill(page, 'tmName', `New ${type}`);
        await ed.fill(page, 'tmUrl', '*/api/typed*');
        for (const [id, v] of fields) await ed.fill(page, id, v);
        const rules = await saveAndWait((r) => r.length === 1, `the ${type} rule to save`);
        check(rules[0]);
    });

    test('patch mode hides the Status Code field, which it ignores', async () => {
        await openEditor();
        expect(await ed.visibleFieldIds(page)).toContain('tmStatus');
        await ed.fill(page, 'tmMode', 'patch');
        expect(await ed.visibleFieldIds(page)).not.toContain('tmStatus');
        await ed.fill(page, 'tmMode', 'static');
        expect(await ed.visibleFieldIds(page)).toContain('tmStatus');
    });

    test('switching type shows only that type\'s fields', async () => {
        await openEditor();
        await ed.fill(page, 'tmType', 'redirect');
        const visible = await ed.visibleFieldIds(page);
        expect(visible).toContain('tmRedirect');
        expect(visible).not.toContain('tmBody');
        expect(visible).not.toContain('tmHdrReq');
    });

    // ---- validation ----------------------------------------------------------

    test('a missing name is reported and nothing is saved', async () => {
        await openEditor();
        await ed.fill(page, 'tmUrl', '*/api/x*');
        await ed.click(page, 'tmSave');
        await waitFor(async () => /name is required/i.test(await ed.errorText(page)), { label: 'the error' });
        expect(await stored()).toEqual([]);
        expect(await ed.isOpen(page)).toBe(true);
    });

    test('an incomplete header operation is caught by the shared schema before saving', async () => {
        // The same check the background applies; the editor now runs it too,
        // so the person sees why immediately rather than after a round trip.
        await openEditor();
        await ed.fill(page, 'tmType', 'headers');
        await ed.fill(page, 'tmName', 'Bad header op');
        await ed.fill(page, 'tmUrl', '*/api/x*');
        await ed.fill(page, 'tmHdrReq', '[{"op":"set","name":"X-No-Value"}]');
        await ed.click(page, 'tmSave');
        await waitFor(async () => /needs a string "value"/.test(await ed.errorText(page)), { label: 'the schema error' });
        expect(await stored()).toEqual([]);
    });

    test('a rule name over the limit is reported', async () => {
        await openEditor();
        await ed.fill(page, 'tmName', 'x'.repeat(101));
        await ed.fill(page, 'tmUrl', '*/api/x*');
        await ed.click(page, 'tmSave');
        await waitFor(async () => /100 characters or less/.test(await ed.errorText(page)), { label: 'the length error' });
    });

    // ---- editing preserves what the form does not show -------------------------

    test('an edit keeps the rule\'s identity, history and fields the form does not show', async () => {
        const original = existing({ imported: true, notes: 'from the QA team' });
        await openEditor(original);
        await ed.fill(page, 'tmName', 'Renamed rule');
        const rules = await saveAndWait((r) => r[0] && r[0].name === 'Renamed rule', 'the edit to save');

        expect(rules).toHaveLength(1);
        expect(rules[0]).toMatchObject({
            id: 'existing-1',
            hitCount: 42,
            created: '2026-01-02T03:04:05.000Z',
            imported: true,
            notes: 'from the QA team'
        });
    });

    test('editing a block rule keeps its header match conditions', async () => {
        // Header conditions are valid on block/delay rules (an imported rule
        // can carry them), but the editors only showed them for mocks — so
        // saving any edit silently dropped them, widening the rule to block
        // every request to that URL.
        await openEditor(existing({
            id: 'block-hdr', name: 'Block dev only', type: 'block',
            match: { url: '*/api/x*', method: 'GET', headers: { 'X-Env': 'dev' } },
            response: undefined
        }));
        expect(await ed.visibleFieldIds(page)).toContain('tmMatchHeaders');
        await ed.fill(page, 'tmName', 'Block dev only (edited)');
        const rules = await saveAndWait((r) => r[0] && r[0].name === 'Block dev only (edited)', 'the edit to save');
        expect(rules[0].match.headers).toEqual({ 'X-Env': 'dev' });
    });

    test('a rule deleted elsewhere is not resurrected by saving a stale edit (Q-19)', async () => {
        await openEditor(existing());
        await h.bg({ type: 'deleteRule', ruleId: 'existing-1' });
        await ed.fill(page, 'tmName', 'Stale edit');
        await ed.click(page, 'tmSave');
        await waitFor(async () => /deleted elsewhere/i.test(await ed.errorText(page)), { label: 'the stale-edit error' });
        expect(await stored()).toEqual([]);
    });

    // ---- templates -------------------------------------------------------------

    test('a template fills the form without overwriting a typed name', async () => {
        await openEditor();
        await ed.fill(page, 'tmName', 'My name');
        const templateId = await ed.inShadow(page, (root) => {
            const opts = Array.from(root.getElementById('tmTemplate').options).filter((o) => o.value);
            return opts.length ? opts[0].value : null;
        });
        expect(templateId).toBeTruthy();
        await ed.fill(page, 'tmTemplate', templateId);
        expect(await ed.value(page, 'tmName')).toBe('My name');
        expect(await ed.value(page, 'tmUrl')).not.toBe('');
    });

    // ---- dismissing ------------------------------------------------------------

    test('Escape with unsaved changes asks first; a second Escape discards (A11Y-7)', async () => {
        await openEditor();
        await ed.fill(page, 'tmName', 'Half-written');
        await page.keyboard.press('Escape');
        expect(await ed.isOpen(page)).toBe(true);
        expect(await ed.errorText(page)).toMatch(/unsaved changes/i);
        await page.keyboard.press('Escape');
        await waitFor(async () => !(await ed.isOpen(page)), { label: 'the editor to close' });
        expect(await stored()).toEqual([]);
    });

    test('Cancel closes without saving', async () => {
        await openEditor();
        await ed.fill(page, 'tmName', 'Never saved');
        await ed.click(page, 'tmCancel');
        await waitFor(async () => !(await ed.isOpen(page)), { label: 'the editor to close' });
        expect(await stored()).toEqual([]);
    });

    test('ran without errors', async () => {
        await openEditor();
        expect(h.allErrors).toEqual([]);
    });
});

describe('rule editor accessibility', () => {
    // axe cannot see into a CLOSED shadow root, which is what the in-page
    // overlay uses (S-1). The options page mounts the same editor in an OPEN
    // root, so the editor's own markup and styles are audited there — one
    // implementation, so the result holds for both hosts.
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    async function openOnOptionsPage(theme) {
        await h.reset();
        await h.bg({ type: 'settingsUpdated', settings: { theme } }).catch(() => {});
        await h.extensionEval((t) => chrome.storage.local.get('spliceTapSettings').then((r) =>
            chrome.storage.local.set({ spliceTapSettings: { ...(r.spliceTapSettings || {}), theme: t } })), theme);
        page = await h.browser.newPage();
        await page.setViewport({ width: 1100, height: 900 });
        await page.goto(h.extUrl('options/options.html?action=new'), { waitUntil: 'load' });
        await waitFor(() => ed.isOpen(page), { label: 'the editor to open' });
        await sleep(300);
    }

    const { auditA11y } = require('./harness');

    test.each(['dark', 'light'])('the editor has no WCAG A/AA violations (%s theme), for every rule type', async (theme) => {
        await openOnOptionsPage(theme);
        const violations = [];
        for (const type of ['mock', 'block', 'delay', 'redirect', 'headers', 'queryparams']) {
            await ed.fill(page, 'tmType', type);
            for (const v of await auditA11y(page)) violations.push({ type, ...v });
        }
        expect(violations).toEqual([]);
    });

    test('the options page itself has no WCAG A/AA violations', async () => {
        await openOnOptionsPage('dark');
        await ed.click(page, 'tmCancel');
        await waitFor(async () => !(await ed.isOpen(page)), { label: 'editor closed' });
        expect(await auditA11y(page)).toEqual([]);
    });
});
