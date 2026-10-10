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

describe('PER-34: tabs receive only the rules the interceptor runs', () => {
    const mixed = () => [
        mockRule('on'),
        mockRule('off', { enabled: false, response: { statusCode: 200, headers: {}, body: 'x'.repeat(5000), delay: 0, mode: 'static' } }),
        { ...mockRule('legacy'), type: undefined }, // stored before `type` existed: a mock
        { id: 'blk', name: 'B', type: 'block', enabled: true, match: { url: '*/b*', method: '*' } },
        { id: 'hdr', name: 'H', type: 'headers', enabled: true, dnrRuleId: 1, match: { url: '*/h*', method: '*' }, headersMod: { request: [{ op: 'set', name: 'X', value: '1' }] } }
    ];
    const ids = (rules) => rules.map((r) => r.id);

    test('the syncState broadcast carries only enabled mock/block/delay/redirect rules', async () => {
        const { mock, send } = await setup({ initial: { spliceTapRules: mixed() }, tabs: [{ id: 3, url: 'https://a.test/' }] });
        mock.sentTabMessages.length = 0;

        await send({ type: 'settingsUpdated', settings: { theme: 'dark' } });
        await waitForCondition(() => mock.sentTabMessages.length > 0);

        expect(ids(mock.sentTabMessages[0].message.rules)).toEqual(['on', 'legacy', 'blk']);
    });

    test('getRules with scope "interceptor" returns the same subset', async () => {
        const { send } = await setup({ initial: { spliceTapRules: mixed() } });

        expect(ids((await send({ type: 'getRules', scope: 'interceptor' })).rules)).toEqual(['on', 'legacy', 'blk']);
        expect(ids((await send({ type: 'getRules' })).rules)).toEqual(['on', 'off', 'legacy', 'blk', 'hdr']);
    });

    test('a content script in a subframe gets the subset; the top frame (in-page editor) gets every rule', async () => {
        const { send } = await setup({ initial: { spliceTapRules: mixed() } });

        expect(ids((await send({ type: 'getRules' }, contentScript(4))).rules)).toEqual(['on', 'legacy', 'blk']);
        expect(ids((await send({ type: 'getRules' }, contentScript(0))).rules)).toHaveLength(5);
    });
});

describe('PER-6: what a content script may ask the background for', () => {
    test.each([
        ['setRules', { type: 'setRules', rules: [] }],
        ['resetAll', { type: 'resetAll' }],
        ['clearRules', { type: 'clearRules' }],
        ['deleteRule', { type: 'deleteRule', ruleId: 'a' }],
        ['toggleRule', { type: 'toggleRule', ruleId: 'a', enabled: false }],
        ['toggleExtension', { type: 'toggleExtension', active: false }],
        ['settingsUpdated', { type: 'settingsUpdated', settings: {} }],
        ['setCaptureArmed', { type: 'setCaptureArmed', armed: true }],
        ['getCaptures', { type: 'getCaptures' }],
        ['clearCaptures', { type: 'clearCaptures' }],
        ['getInterceptionLog', { type: 'getInterceptionLog' }],
        ['clearInterceptionLog', { type: 'clearInterceptionLog' }],
        ['resetStats', { type: 'resetStats' }],
        ['getRuleStats', { type: 'getRuleStats' }],
        ['testRule', { type: 'testRule', rule: mockRule('t') }]
    ])('refuses %s from a content script', async (label, message) => {
        const { mock, send } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });

        const response = await send(message, contentScript());

        expect(response.success).toBe(false);
        expect(mock.raw.spliceTapRules.map((r) => [r.id, r.enabled])).toEqual([['a', true]]);
    });

    test('allows what the relay and the in-page editor send', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });
        const page = contentScript();

        expect((await send({ type: 'getRules' }, page)).success).toBe(true);
        expect((await send({ type: 'saveRule', rule: mockRule('b') }, page)).success).toBe(true);
        expect((await send({ type: 'logInterceptionBatch', entries: [] }, page)).success).toBe(true);
        expect((await send({ type: 'logInterception', entry: null }, page)).success).toBe(true);
        expect((await send({ type: 'logCapture', entry: null }, page)).success).toBe(true);
    });

    test('extension pages are not restricted, including one opened in a tab', async () => {
        const { send } = await setup();
        const optionsTab = { ...EXTENSION_PAGE, url: 'chrome-extension://test-extension-id/options/options.html', tab: { id: 2 }, frameId: 0 };

        expect((await send({ type: 'getCaptures' }, optionsTab)).success).toBe(true);
        expect((await send({ type: 'getCaptures' }, { id: 'test-extension-id', origin: 'chrome-extension://test-extension-id' })).success).toBe(true);
    });

    test('a page URL that merely contains the extension URL is still a page', async () => {
        const { send } = await setup();
        const spoof = contentScript();
        spoof.url = 'https://evil.test/chrome-extension://test-extension-id/popup.html';

        expect((await send({ type: 'getCaptures' }, spoof)).success).toBe(false);
    });
});

describe('SEC2-7: log and capture entries are copied field by field, with size caps', () => {
    test('a log entry keeps only the known fields', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });

        await send({
            type: 'logInterceptionBatch',
            entries: [{ url: 'https://s.test/api/a', method: 'GET', ruleId: 'a', ruleName: 'n', ruleType: 'mock', status: 200, ts: 5, junk: 'x'.repeat(100000) }]
        }, contentScript());

        const [entry] = (await send({ type: 'getInterceptionLog' })).entries;
        expect(Object.keys(entry).sort()).toEqual(['method', 'ruleId', 'ruleName', 'ruleType', 'status', 'tabId', 'ts', 'url']);
        expect(entry.tabId).toBe(7);
    });

    test('an oversized rule name is cut short; an oversized rule type drops the entry', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });

        await send({
            type: 'logInterceptionBatch',
            entries: [
                { url: 'https://s.test/api/a', method: 'GET', ruleId: 'a', ruleName: 'n'.repeat(5000) },
                { url: 'https://s.test/api/a', method: 'GET', ruleId: 'a', ruleType: 't'.repeat(5000) }
            ]
        }, contentScript());

        const { entries } = await send({ type: 'getInterceptionLog' });
        expect(entries).toHaveLength(1);
        expect(entries[0].ruleName).toHaveLength(256);
    });

    test('a capture keeps only known fields, caps headers, and refuses an oversized body', async () => {
        const { send } = await setup();
        await send({ type: 'setCaptureArmed', armed: true });
        const headers = {};
        for (let i = 0; i < 300; i++) headers[`h${i}`] = 'v';
        headers.nested = { a: 1 };
        headers.long = 'v'.repeat(20000);

        await send({
            type: 'logCapture',
            entry: { url: 'https://s.test/x', method: 'get', status: 200, body: '{}', headers, extra: 'x'.repeat(100000) }
        }, contentScript());
        await send({ type: 'logCapture', entry: { url: 'https://s.test/big', body: 'x'.repeat(200 * 1024) } }, contentScript());

        const { captures } = await send({ type: 'getCaptures' });
        expect(captures).toHaveLength(1);
        expect(captures[0].extra).toBeUndefined();
        expect(Object.keys(captures[0].headers).length).toBeLessThanOrEqual(100);
        expect(Object.values(captures[0].headers).every((v) => typeof v === 'string' && v.length <= 8192)).toBe(true);
    });
});

// ---- service_worker/dnr.js ----------------------------------------------

const dnr = require('../service_worker/dnr');
const matcher = require('../src/matcher');

/** A headers rule as stored, for the DNR tests. */
const headersRule = (id, dnrRuleId, url = '*/api/*', value = 'on') => ({
    id, name: id, type: 'headers', enabled: true, dnrRuleId,
    match: { url, method: '*' },
    headersMod: { request: [{ op: 'set', name: 'X-Test', value }] }
});

describe('PER-21: header and query-param URL patterns match what the interceptor matches', () => {
    // A JS model of Chrome's urlFilter: '*' wildcard, '|' start/end anchor,
    // case-insensitive (isUrlFilterCaseSensitive:false). The '||' and '^'
    // forms are never emitted for these patterns.
    function urlFilterMatches(filter, url) {
        let body = filter;
        const start = body.startsWith('|');
        const end = body.endsWith('|');
        if (start) body = body.slice(1);
        if (end) body = body.slice(0, -1);
        expect(body).not.toMatch(/[|^]/);
        const source = body.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        return new RegExp((start ? '^' : '') + source + (end ? '$' : ''), 'i').test(url);
    }
    const dnrMatches = (pattern, url) => {
        const { condition } = dnr.ruleToDnr(headersRule('h', 1, pattern));
        return condition.regexFilter !== undefined
            ? new RegExp(condition.regexFilter, 'i').test(url)
            : urlFilterMatches(condition.urlFilter, url);
    };

    const urls = [
        'http://127.0.0.1:8080/echo',
        'http://127.0.0.1:8080/echo?x=1',
        'http://127.0.0.1:8080/echo/sub',
        'http://127.0.0.1:8080/ECHO',
        'http://127.0.0.1:8080/api/v1/users',
        'https://api.example.com/v1/users?page=2',
        'https://example.com/a|b/c',
        'https://example.com/a^b'
    ];
    const patterns = [
        '*/echo', '*/echo*', 'http://127.0.0.1:8080/echo*', 'http://127.0.0.1:8080/echo',
        '*/api/*/users', 'https://*/users*', '*example.com*', 'echo', 'api/v1',
        '*a|b*', '*/a^b', 'a|b', '*/v1/users?page=*'
    ];

    test.each(patterns)('%s', (pattern) => {
        for (const url of urls) {
            expect([url, dnrMatches(pattern, url)]).toEqual([url, matcher.matchUrl(url, pattern)]);
        }
    });

    test('*/echo is anchored at the end, so /echo/sub and /echo?x=1 do not match', () => {
        expect(dnr.ruleToDnr(headersRule('h', 1, '*/echo')).condition.urlFilter).toBe('*/echo|');
    });

    test('a pattern starting with / is anchored at the path, as the interceptor sees a relative URL', () => {
        const { condition } = dnr.ruleToDnr(headersRule('h', 1, '/echo*'));
        const re = new RegExp(condition.regexFilter, 'i');
        expect(re.test('http://127.0.0.1:8080/echo?x=1')).toBe(true);
        expect(re.test('http://127.0.0.1:8080/other/echo')).toBe(false);
        expect(matcher.matchUrl('/echo?x=1', '/echo*')).toBe(true);
    });

    test('patterns without | or ^ keep using urlFilter', () => {
        expect(dnr.ruleToDnr(headersRule('h', 1, '*/api/*')).condition).toMatchObject({ urlFilter: '*/api/*' });
        expect(dnr.ruleToDnr(headersRule('h', 1, 'api/users')).condition).toMatchObject({ urlFilter: 'api/users' });
        expect(dnr.ruleToDnr(headersRule('h', 1, 'a|b')).condition).toMatchObject({ regexFilter: 'a\\|b' });
    });
});

describe('PER-37: an unchanged ruleset is recognised in the shape Chrome returns it', () => {
    let mock;
    beforeEach(() => {
        mock = createChromeMock();
        restoreChrome = installChrome(mock.chrome);
    });

    // Exactly what getDynamicRules returned in headless Chrome for this rule:
    // keys sorted alphabetically at every level.
    const asChromeReturnsIt = (id, urlFilter, value) => ({
        action: { requestHeaders: [{ header: 'X-Test', operation: 'set', value }], type: 'modifyHeaders' },
        condition: { isUrlFilterCaseSensitive: false, resourceTypes: ['xmlhttprequest', 'other'], urlFilter },
        id,
        priority: 1
    });

    test('no update call when Chrome already holds the same rules', async () => {
        mock.setDynamicRules([asChromeReturnsIt(1, '*/api/*', 'on'), asChromeReturnsIt(2, '*/b/*', 'on')]);

        const outcome = await dnr.syncDnrRules([headersRule('a', 1), headersRule('b', 2, '*/b/*')], true);

        expect(outcome.success).toBe(true);
        expect(mock.calls.updateDynamicRules).toBe(0);
    });

    test('a changed regexFilter is not mistaken for no change', async () => {
        const regexRule = headersRule('r', 3, '/\\/new\\//');
        const registered = dnr.ruleToDnr(regexRule);
        mock.setDynamicRules([{ ...registered, condition: { ...registered.condition, regexFilter: '\\/old\\/' } }]);

        await dnr.syncDnrRules([regexRule], true);

        expect(mock.calls.updateDynamicRules).toBe(1);
        expect(mock.getDynamicRules()[0].condition.regexFilter).toBe('\\/new\\/');
    });

    test('dnrRuleEqual ignores key order but not values', () => {
        const ours = dnr.ruleToDnr(headersRule('a', 1));
        expect(dnr.dnrRuleEqual(asChromeReturnsIt(1, '*/api/*', 'on'), ours)).toBe(true);
        expect(dnr.dnrRuleEqual(asChromeReturnsIt(1, '*/api/*', 'off'), ours)).toBe(false);
    });
});

describe('PER-33: one rule Chrome refuses', () => {
    let mock;
    let registeredLow;
    beforeEach(() => {
        mock = createChromeMock();
        restoreChrome = installChrome(mock.chrome);
        // Chrome refuses a rule whose header value is BAD, and (like Chrome)
        // an update call is all-or-nothing.
        const real = mock.chrome.declarativeNetRequest.updateDynamicRules;
        registeredLow = Infinity;
        mock.chrome.declarativeNetRequest.updateDynamicRules = async (options) => {
            registeredLow = Math.min(registeredLow, mock.getDynamicRules().length);
            const bad = (options.addRules || []).find((r) =>
                r.action.requestHeaders && r.action.requestHeaders.some((h) => h.value === 'BAD'));
            if (bad) {
                mock.calls.updateDynamicRules++;
                throw new Error(`Rule with id ${bad.id} is invalid.`);
            }
            await real(options);
            registeredLow = Math.min(registeredLow, mock.getDynamicRules().length);
        };
    });

    const manyRules = (n, badAt) => Array.from({ length: n }, (_, i) =>
        headersRule(`r${i}`, i + 1, `*/api/${i}/*`, i === badAt ? 'BAD' : 'on'));

    test('isolates it by bisection, without unregistering the acceptable rules', async () => {
        const rules = manyRules(300, -1);
        await dnr.syncDnrRules(rules, true);
        mock.calls.updateDynamicRules = 0;
        registeredLow = Infinity;

        // One more rule, refused by Chrome.
        const outcome = await dnr.syncDnrRules([...rules, headersRule('bad', 301, '*/bad/*', 'BAD')], true);

        expect(outcome.rejected.map((r) => r.id)).toEqual(['bad']);
        expect(mock.getDynamicRules()).toHaveLength(300);
        expect(registeredLow).toBe(300);
        expect(mock.calls.updateDynamicRules).toBeLessThanOrEqual(3);
    });

    test('a bad rule among 300 new ones costs a logarithmic number of calls', async () => {
        const outcome = await dnr.syncDnrRules(manyRules(300, 150), true);

        expect(outcome.rejected.map((r) => r.id)).toEqual(['r150']);
        expect(mock.getDynamicRules()).toHaveLength(299);
        expect(mock.calls.updateDynamicRules).toBeLessThanOrEqual(20);
    });

    test('the refusal is remembered across a worker restart, so the next wake is no update call', async () => {
        const rules = manyRules(50, 10);
        await dnr.syncDnrRules(rules, true);
        expect(mock.rawSession.spliceTapDnrRejected).toBeDefined();
        mock.calls.updateDynamicRules = 0;

        // A fresh copy of the module, as a restarted worker would load it.
        let fresh;
        jest.isolateModules(() => { fresh = require('../service_worker/dnr'); });
        const outcome = await fresh.syncDnrRules(rules, true);

        expect(outcome.rejected.map((r) => r.id)).toEqual(['r10']);
        expect(mock.calls.updateDynamicRules).toBe(0);
    });

    test('a regex Chrome cannot run is found with isRegexSupported, not by bisection', async () => {
        mock.chrome.declarativeNetRequest.isRegexSupported = async ({ regex }) =>
            (regex.includes('(?=') ? { isSupported: false, reason: 'syntaxError' } : { isSupported: true });
        const real = mock.chrome.declarativeNetRequest.updateDynamicRules;
        mock.chrome.declarativeNetRequest.updateDynamicRules = async (options) => {
            if ((options.addRules || []).some((r) => (r.condition.regexFilter || '').includes('(?='))) {
                mock.calls.updateDynamicRules++;
                throw new Error('Rule with id 1 specified a non-supported regex.');
            }
            return real(options);
        };
        const rules = [headersRule('lookahead', 1, '/a(?=b)/'), ...manyRules(40, -1).map((r, i) => ({ ...r, dnrRuleId: i + 2 }))];

        const outcome = await dnr.syncDnrRules(rules, true);

        expect(outcome.rejected.map((r) => r.id)).toEqual(['lookahead']);
        expect(mock.getDynamicRules()).toHaveLength(40);
        expect(mock.calls.updateDynamicRules).toBe(2);
    });

    test('rules sharing one network id are reported without a round trip to Chrome', async () => {
        const outcome = await dnr.syncDnrRules([headersRule('a', 7), headersRule('b', 7, '*/b/*')], true);

        expect(outcome.rejected.map((r) => r.id)).toEqual(['b']);
        expect(mock.calls.updateDynamicRules).toBe(1);
    });
});

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
