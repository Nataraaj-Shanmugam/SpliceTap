/**
 * Editor feature group (G4a), end to end, in both hosts of the one editor:
 * the in-page overlay (CLOSED shadow root, driven through CDP) and the options
 * page (OPEN root). F1 appliesTo checkbox, F3 "Modify request body", F4 code
 * responses. The pure form-to-rule mapping is in tests/feat-editor.test.js.
 */

const { launch, waitFor, sleep } = require('./harness');
const ed = require('./editor-driver');

const HOSTS = ['overlay', 'options'];

describe.each(HOSTS)('editor features — %s host', (hostKind) => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    beforeEach(async () => { await h.reset(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

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

    const baseRule = (over = {}) => ({
        id: 'seed-1', name: 'Seed', enabled: true,
        match: { url: '*/api/seed*', method: '*' },
        hitCount: 0, created: '2026-01-02T03:04:05.000Z', ...over
    });

    // ---- F1: appliesTo -----------------------------------------------------------

    describe('F1: "Also apply to scripts, images, styles and pages"', () => {
        test.each(['redirect', 'block'])('is offered for %s with its hint linked, and for no other type', async (type) => {
            await openEditor();
            for (const other of ['mock', 'delay', 'headers', 'queryparams']) {
                await ed.fill(page, 'tmType', other);
                expect(await ed.visibleFieldIds(page)).not.toContain('tmAppliesAll');
            }
            await ed.fill(page, 'tmType', type);
            expect(await ed.visibleFieldIds(page)).toContain('tmAppliesAll');

            const wiring = await ed.inShadow(page, (root) => {
                const box = root.getElementById('tmAppliesAll');
                const hint = root.getElementById(box.getAttribute('aria-describedby'));
                return { label: box.closest('label').textContent.trim(), hint: hint && hint.textContent };
            });
            expect(wiring.label).toBe('Also apply to scripts, images, styles and pages');
            expect(wiring.hint).toBe("fetch/XHR are handled in the page; everything else by Chrome's network layer.");
        });

        test.each([
            ['redirect', [['tmRedirect', 'https://example.test/elsewhere']]],
            ['block', []]
        ])('a new %s rule is ticked by default and saves appliesTo "all"', async (type, fields) => {
            await openEditor();
            await ed.fill(page, 'tmType', type);
            await ed.fill(page, 'tmName', `New ${type}`);
            await ed.fill(page, 'tmUrl', '*/api/everything*');
            for (const [id, v] of fields) await ed.fill(page, id, v);
            expect(await ed.value(page, 'tmAppliesAll')).toBe(true);
            const rules = await saveAndWait((r) => r.length === 1, `the ${type} rule to save`);
            expect(rules[0]).toMatchObject({ type, appliesTo: 'all' });
        });

        test.each([
            ['redirect', [['tmRedirect', 'https://example.test/elsewhere']]],
            ['block', []]
        ])('unticking a new %s rule saves appliesTo "page"', async (type, fields) => {
            await openEditor();
            await ed.fill(page, 'tmType', type);
            await ed.fill(page, 'tmName', `Page-only ${type}`);
            await ed.fill(page, 'tmUrl', '*/api/pageonly*');
            for (const [id, v] of fields) await ed.fill(page, id, v);
            await ed.fill(page, 'tmAppliesAll', false);
            const rules = await saveAndWait((r) => r.length === 1, `the ${type} rule to save`);
            expect(rules[0]).toMatchObject({ type, appliesTo: 'page' });
        });

        test.each([
            ['absent', undefined, false],
            ['"page"', 'page', false],
            ['"all"', 'all', true]
        ])('editing a stored redirect with appliesTo %s shows the checkbox as %s', async (label, appliesTo, ticked) => {
            const seed = baseRule({ type: 'redirect', redirect: { destination: 'https://example.test/x' } });
            if (appliesTo) seed.appliesTo = appliesTo;
            await openEditor(seed);
            expect(await ed.value(page, 'tmAppliesAll')).toBe(ticked);
        });

        test('editing a block rule and ticking the box stores "all", and the edit keeps its identity', async () => {
            await openEditor(baseRule({ type: 'block', hitCount: 7 }));
            expect(await ed.value(page, 'tmAppliesAll')).toBe(false);
            await ed.fill(page, 'tmAppliesAll', true);
            const rules = await saveAndWait((r) => r[0] && r[0].appliesTo === 'all', 'the edit to save');
            expect(rules).toHaveLength(1);
            expect(rules[0]).toMatchObject({ id: 'seed-1', type: 'block', hitCount: 7 });
        });
    });
});
