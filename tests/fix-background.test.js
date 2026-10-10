/**
 * Regression tests for fix group B1 ("background"): service_worker/background.js,
 * service_worker/dnr.js and src/storage.js. Each block names the finding it
 * guards (PERSONA-REVIEW.md).
 *
 * Same harness as tests/background.test.js: the real onMessage listener is
 * driven through tests/helpers/chrome-mock.js.
 */

const { loadEsmModule, installChrome } = require('./helpers/load-esm');
const { createChromeMock } = require('./helpers/chrome-mock');
const path = require('path');

const BACKGROUND = path.resolve(__dirname, '..', 'service_worker', 'background.js');

const quietConsole = Object.assign({}, console, { log() {}, error() {}, warn() {} });

// Senders as Chrome describes them: an extension page (popup, options,
// DevTools panel) and a content script running in a web page's frame.
const EXTENSION_PAGE = { id: 'test-extension-id', url: 'chrome-extension://test-extension-id/popup/popup.html' };
const contentScript = (frameId = 0, tabId = 7) => ({
    id: 'test-extension-id', url: 'https://site.test/app', origin: 'https://site.test', frameId, tab: { id: tabId }
});

let restoreChrome = null;
let activeBackground = null;

async function setup(options) {
    const mock = createChromeMock(options);
    restoreChrome = installChrome(mock.chrome);
    const exports = loadEsmModule(BACKGROUND, { chrome: mock.chrome, console: quietConsole });
    const bg = exports.default;
    activeBackground = bg;
    await bg.ready;
    const send = (message, sender = EXTENSION_PAGE) => mock.dispatchMessage(message, sender);
    return { mock, bg, send };
}

afterEach(() => {
    if (activeBackground && activeBackground._trailingFlushTimer) {
        clearTimeout(activeBackground._trailingFlushTimer);
        activeBackground._trailingFlushTimer = null;
    }
    activeBackground = null;
    if (restoreChrome) restoreChrome();
    restoreChrome = null;
});

const mockRule = (id, overrides = {}) => ({
    id,
    name: `Rule ${id}`,
    type: 'mock',
    enabled: true,
    match: { url: `*/api/${id}*`, method: 'GET' },
    response: { statusCode: 200, statusText: 'OK', headers: {}, body: {}, delay: 0, mode: 'static' },
    ...overrides
});

// A rule an earlier build accepted and today's validator refuses (names are
// now capped at 100 characters).
const legacyRule = () => mockRule('old', { name: 'x'.repeat(120) });

describe('PER-27: a bulk write never drops a stored rule', () => {
    test('Move down keeps a stored rule that fails today\'s validator', async () => {
        const { mock, send } = await setup({
            initial: { spliceTapRules: [legacyRule(), mockRule('a'), mockRule('b')] }
        });
        const { rules } = await send({ type: 'getRules' });

        // The popup's "Move down" on `a`: the same rules, reordered.
        const reordered = [rules[0], rules[2], rules[1]];
        const response = await send({ type: 'setRules', rules: reordered });

        expect(response.success).toBe(true);
        expect(response.rejected).toBeUndefined();
        expect(mock.raw.spliceTapRules.map((r) => r.id)).toEqual(['old', 'b', 'a']);
        expect(mock.raw.spliceTapRules[0].name).toHaveLength(120);
    });

    test('an unchanged rule is kept even when only its hit count differs', async () => {
        const { mock, send } = await setup({
            initial: { spliceTapRules: [{ ...legacyRule(), hitCount: 9 }, mockRule('a')] }
        });
        const { rules } = await send({ type: 'getRules' });
        const stale = rules.map((r) => ({ ...r, hitCount: 2 }));

        const response = await send({ type: 'setRules', rules: stale.reverse() });

        expect(response.success).toBe(true);
        expect(mock.raw.spliceTapRules.map((r) => r.id)).toEqual(['a', 'old']);
    });

    test('a refused change to a stored rule keeps the stored copy and reports it', async () => {
        // Toggle-all flips `enabled` on every rule, so the legacy rule arrives
        // changed and is validated. Refusing the change must not delete it.
        const { mock, send } = await setup({
            initial: { spliceTapRules: [legacyRule(), mockRule('a')] }
        });
        const { rules } = await send({ type: 'getRules' });

        const response = await send({ type: 'setRules', rules: rules.map((r) => ({ ...r, enabled: false })) });

        expect(response.success).toBe(true);
        expect(mock.raw.spliceTapRules.map((r) => [r.id, r.enabled])).toEqual([['old', true], ['a', false]]);
        expect(response.rejected).toHaveLength(1);
        expect(response.rejected[0]).toMatchObject({ id: 'old', keptStored: true });
        expect(response.rejected[0].errors.join(' ')).toMatch(/100 characters/);
    });

    test('a merge import reports only the imported rules it refused', async () => {
        const { mock, send } = await setup({
            initial: { spliceTapRules: [legacyRule(), mockRule('a')] }
        });
        const { rules } = await send({ type: 'getRules' });

        const response = await send({
            type: 'setRules',
            rules: [...rules, mockRule('new'), mockRule('bad', { name: '' })]
        });

        expect(mock.raw.spliceTapRules.map((r) => r.id)).toEqual(['old', 'a', 'new']);
        expect(response.rejected.map((r) => r.id)).toEqual(['bad']);
    });

    test('a changed rule is still validated', async () => {
        const { mock, send } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });

        const response = await send({ type: 'setRules', rules: [mockRule('a', { match: { url: '', method: 'GET' } })] });

        expect(response.rejected).toHaveLength(1);
        expect(mock.raw.spliceTapRules[0].match.url).toBe('*/api/a*');
    });
});

describe('PER-31: a tab that never answers cannot stall a mutation', () => {
    const headerRule = {
        id: 'h1', name: 'H', type: 'headers', enabled: true,
        match: { url: '*/api/*', method: '*' },
        headersMod: { request: [{ op: 'set', name: 'X-T', value: '1' }] }
    };

    // A tab paused at a breakpoint: tabs.sendMessage to it never settles.
    async function withPausedTab(options) {
        const ctx = await setup(options);
        ctx.mock.setTabs([{ id: 5, url: 'https://paused.test/' }]);
        ctx.mock.chrome.tabs.sendMessage = () => new Promise(() => {});
        return ctx;
    }

    test.each([
        ['saveRule', () => ({ type: 'saveRule', rule: mockRule('n') })],
        ['toggleRule', () => ({ type: 'toggleRule', ruleId: 'a', enabled: false })],
        ['deleteRule', () => ({ type: 'deleteRule', ruleId: 'a' })],
        ['setRules', () => ({ type: 'setRules', rules: [mockRule('a')] })],
        ['toggleExtension', () => ({ type: 'toggleExtension', active: false })],
        ['settingsUpdated', () => ({ type: 'settingsUpdated', settings: { theme: 'dark' } })],
        ['setCaptureArmed', () => ({ type: 'setCaptureArmed', armed: true })],
        ['clearRules', () => ({ type: 'clearRules' })],
        ['resetAll', () => ({ type: 'resetAll' })]
    ])('%s answers while a tab is paused', async (label, message) => {
        const { send } = await withPausedTab({ initial: { spliceTapRules: [mockRule('a')] } });

        const response = await send(message());

        expect(response.success).toBe(true);
    });

    test('switching off withdraws the network rules while a tab is paused', async () => {
        const { mock, send } = await withPausedTab();
        await send({ type: 'saveRule', rule: headerRule });
        expect(mock.getDynamicRules()).toHaveLength(1);

        const response = await send({ type: 'toggleExtension', active: false });

        expect(response).toMatchObject({ success: true, active: false });
        expect(mock.getDynamicRules()).toHaveLength(0);
    });

    test('a worker starting while a tab is paused still becomes ready', async () => {
        // loadStoredData broadcast to every tab and awaited it, so `ready`,
        // which every handler waits on, never resolved.
        const mock = createChromeMock({ tabs: [{ id: 5, url: 'https://paused.test/' }] });
        mock.chrome.tabs.sendMessage = () => new Promise(() => {});
        restoreChrome = installChrome(mock.chrome);
        const bg = loadEsmModule(BACKGROUND, { chrome: mock.chrome, console: quietConsole }).default;
        activeBackground = bg;

        const response = await mock.dispatchMessage({ type: 'getRules' }, EXTENSION_PAGE);

        expect(response.success).toBe(true);
    });

    test('tabs still receive the new state, after the caller has its answer', async () => {
        const { mock, send } = await setup({ tabs: [{ id: 3, url: 'https://a.test/' }] });

        await send({ type: 'saveRule', rule: mockRule('a') });

        await waitForCondition(() => mock.sentTabMessages.some((m) =>
            m.tabId === 3 && m.message.type === 'syncState' && m.message.rules.some((r) => r.id === 'a')));
    });
});

async function waitForCondition(fn, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (!fn()) {
        if (Date.now() > deadline) throw new Error('condition not met');
        await new Promise((r) => setTimeout(r, 5));
    }
}

describe('PER-28: setRules re-issues duplicate ids', () => {
    test('a replace-mode import with a repeated id keeps both rules, distinctly', async () => {
        const { mock, send } = await setup();

        const response = await send({
            type: 'setRules',
            rules: [mockRule('dup', { name: 'First' }), mockRule('dup', { name: 'Second' })]
        });

        expect(response.success).toBe(true);
        const stored = mock.raw.spliceTapRules;
        expect(stored.map((r) => r.name)).toEqual(['First', 'Second']);
        expect(stored[0].id).toBe('dup');
        expect(stored[1].id).not.toBe('dup');

        // Delete now removes exactly one.
        await send({ type: 'deleteRule', ruleId: 'dup' });
        expect(mock.raw.spliceTapRules.map((r) => r.name)).toEqual(['Second']);
    });

    test('a repeated network rule id is re-allocated, so Chrome sees unique ids', async () => {
        const { mock, send } = await setup();
        const header = (id) => ({
            id, name: id, type: 'headers', enabled: true, dnrRuleId: 4,
            match: { url: '*/api/*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X-T', value: id }] }
        });

        await send({ type: 'setRules', rules: [header('h1'), header('h1')] });

        const ids = mock.raw.spliceTapRules.map((r) => r.dnrRuleId);
        expect(new Set(ids).size).toBe(2);
        expect(mock.getDynamicRules()).toHaveLength(2);
    });
});
