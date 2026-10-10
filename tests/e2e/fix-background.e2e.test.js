/**
 * Regression tests for fix group B1 ("background"), against the real
 * extension in headless Chrome. Each block names the finding it guards
 * (PERSONA-REVIEW.md).
 */

const { launch, pageFetch, waitFor, sleep } = require('./harness');

const json = { 'Content-Type': 'application/json' };
const mock = (id, url, extra = {}) => ({
    id, name: id, enabled: true, type: 'mock', match: { url, method: '*' },
    response: { statusCode: 200, headers: json, body: { from: id }, delay: 0, mode: 'static' },
    ...extra
});
const header = (id, url, name, extra = {}) => ({
    id, name: id, enabled: true, type: 'headers', match: { url, method: '*' },
    headersMod: { request: [{ op: 'set', name, value: 'on' }], response: [] },
    ...extra
});

describe('fix group B1 (background)', () => {
    let h;
    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    beforeEach(async () => { await h.reset(); });

    const storedIds = async () => (await h.bg({ type: 'getRules' })).rules.map((r) => r.id);

    // ---- PER-27 / PER-28: bulk writes ------------------------------------

    test('PER-27: a stored rule today\'s validator refuses survives a reorder', async () => {
        await h.saveRule(mock('a', '*/api/a*'));
        await h.saveRule(mock('b', '*/api/b*'));
        // Planted directly in storage, as an older build that allowed
        // 120-character names would have stored it.
        await h.extensionEval(async () => {
            const k = 'spliceTapRules';
            const cur = (await chrome.storage.local.get(k))[k];
            cur.unshift({
                id: 'old', name: 'x'.repeat(120), enabled: true, type: 'mock',
                match: { url: '*/api/old*', method: '*' },
                response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: {}, delay: 0, mode: 'static' }
            });
            await chrome.storage.local.set({ [k]: cur });
        });
        // Any mutation makes the background reload from storage.
        await h.bg({ type: 'toggleRule', ruleId: 'a', enabled: true });
        expect(await storedIds()).toEqual(['old', 'a', 'b']);

        // The popup's "Move down" on `a`.
        const list = (await h.bg({ type: 'getRules' })).rules;
        const response = await h.bg({ type: 'setRules', rules: [list[0], list[2], list[1]] });

        expect(response.success).toBe(true);
        expect(response.rejected).toBeUndefined();
        expect(await storedIds()).toEqual(['old', 'b', 'a']);
    });

    test('PER-28: a replace import with a repeated id stores two distinct rules', async () => {
        await h.bg({ type: 'setRules', rules: [mock('dup', '*/api/one*'), mock('dup', '*/api/two*')] });

        const ids = await storedIds();
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(2);

        await h.bg({ type: 'deleteRule', ruleId: 'dup' });
        expect(await storedIds()).toHaveLength(1);
    });

    test('ran without extension errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
