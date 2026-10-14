/**
 * Feature group G1 "network" (see REQUESTLY-ANALYSIS.md):
 *   F1 — appliesTo:'all' redirect/block rules compiled to declarativeNetRequest;
 *   F2 — the optional webRequest observer that logs network-layer rules;
 *   F3 — background plumbing for requestBody rules.
 *
 * Chrome's own behaviour (DNR actually redirecting a <script>, the observer
 * seeing real traffic) is covered by tests/e2e/feat-network.e2e.test.js.
 */

const path = require('path');
const { loadEsmModule, installChrome } = require('./helpers/load-esm');
const { createChromeMock } = require('./helpers/chrome-mock');
const { createInterceptor } = require('./helpers/injected-harness');
const dnr = require('../service_worker/dnr');

const BACKGROUND = path.resolve(__dirname, '..', 'service_worker', 'background.js');
const EXTENSION_PAGE = { id: 'test-extension-id', url: 'chrome-extension://test-extension-id/popup/popup.html' };
const quietConsole = Object.assign({}, console, { log() {}, error() {}, warn() {} });

let restoreChrome = null;
let activeBackground = null;

async function setup(options = {}) {
    const mock = createChromeMock(options);
    if (options.extend) options.extend(mock);
    restoreChrome = installChrome(mock.chrome);
    const bg = loadEsmModule(BACKGROUND, { chrome: mock.chrome, console: quietConsole }).default;
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

const ALL_TYPES = [
    'main_frame', 'sub_frame', 'script', 'stylesheet', 'image', 'font', 'media', 'object',
    'ping', 'csp_report', 'websocket', 'webtransport', 'webbundle', 'other'
];

const blockAll = (overrides = {}) => ({
    id: 'blk', name: 'Block pixel', type: 'block', enabled: true, appliesTo: 'all',
    match: { url: '*/assets/pixel.png*', method: '*' },
    ...overrides
});

const redirectAll = (overrides = {}) => ({
    id: 'rdr', name: 'Redirect bundle', type: 'redirect', enabled: true, appliesTo: 'all',
    match: { url: '*/assets/app.js*', method: '*' },
    redirect: { destination: 'http://localhost:3000/app.js' },
    ...overrides
});

// ---- F1: compilation ---------------------------------------------------------

describe('F1: ruleToDnr compiles appliesTo:"all" redirect and block rules', () => {
    test('a block rule becomes a block action over every resource type except xmlhttprequest', () => {
        const out = dnr.ruleToDnr(blockAll({ dnrRuleId: 3 }), 0);
        expect(out.id).toBe(3);
        expect(out.action).toEqual({ type: 'block' });
        expect(out.condition.resourceTypes).toEqual(ALL_TYPES);
        expect(out.condition.resourceTypes).not.toContain('xmlhttprequest');
        expect(out.condition.urlFilter).toBe('*/assets/pixel.png*');
        expect(out.condition.isUrlFilterCaseSensitive).toBe(false);
        expect(out.condition.requestMethods).toBeUndefined();
    });

    test('a redirect without $n becomes redirect.url', () => {
        const out = dnr.ruleToDnr(redirectAll({ dnrRuleId: 4 }), 0);
        expect(out.action).toEqual({ type: 'redirect', redirect: { url: 'http://localhost:3000/app.js' } });
    });

    test('priority is 100000 - index, so an earlier rule wins', () => {
        expect(dnr.ruleToDnr(blockAll({ dnrRuleId: 1 }), 0).priority).toBe(100000);
        expect(dnr.ruleToDnr(blockAll({ dnrRuleId: 1 }), 7).priority).toBe(99993);
        // headers/queryparams keep priority 1, below every network rule.
        expect(dnr.ruleToDnr({
            type: 'headers', dnrRuleId: 2, match: { url: '*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X', value: '1' }] }
        }, 0).priority).toBe(1);
    });

    test('a method other than * becomes requestMethods', () => {
        const out = dnr.ruleToDnr(blockAll({ dnrRuleId: 1, match: { url: '*/x*', method: 'POST' } }), 0);
        expect(out.condition.requestMethods).toEqual(['post']);
    });

    test('uses the same URL condition as headers rules (PER-21)', () => {
        const headers = (url) => dnr.ruleToDnr({
            type: 'headers', dnrRuleId: 1, match: { url, method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X', value: '1' }] }
        });
        for (const url of ['*/echo', '/api/*', 'a|b', '/\\/api\\/v\\d+/', 'example.com/x']) {
            const { resourceTypes: _a, ...networkCondition } = dnr.ruleToDnr(blockAll({ dnrRuleId: 1, match: { url, method: '*' } })).condition;
            const { resourceTypes: _b, ...headersCondition } = headers(url).condition;
            expect(networkCondition).toEqual(headersCondition);
        }
    });

    test('absent or "page" appliesTo is not compiled (today\'s fetch/XHR-only behaviour)', () => {
        expect(dnr.ruleToDnr(blockAll({ dnrRuleId: 1, appliesTo: undefined }))).toBeNull();
        expect(dnr.ruleToDnr(blockAll({ dnrRuleId: 1, appliesTo: 'page' }))).toBeNull();
        expect(dnr.ruleToDnr(redirectAll({ dnrRuleId: 1, appliesTo: 'page' }))).toBeNull();
        // Only redirect and block take appliesTo.
        expect(dnr.ruleToDnr({ type: 'mock', appliesTo: 'all', dnrRuleId: 1, match: { url: '*' } })).toBeNull();
        expect(dnr.ruleToDnr({ type: 'delay', appliesTo: 'all', dnrRuleId: 1, match: { url: '*' } })).toBeNull();
        // And never without an allocated id.
        expect(dnr.ruleToDnr(blockAll())).toBeNull();
    });

    test('a redirect whose destination is not a full http(s) URL is not compiled', () => {
        for (const destination of ['/local.js', '//cdn.test/x.js', 'javascript:alert(1)', 'data:text/plain,x', '', undefined]) {
            expect(dnr.ruleToDnr(redirectAll({ dnrRuleId: 1, redirect: { destination } }))).toBeNull();
        }
    });

    test('a block rule with header conditions stays page-only, rather than blocking more than it says', () => {
        expect(dnr.ruleToDnr(blockAll({ dnrRuleId: 1, match: { url: '*', method: '*', headers: { 'X-A': '1' } } }))).toBeNull();
        expect(dnr.ruleToDnr(blockAll({ dnrRuleId: 1, match: { url: '*', method: '*', headers: {} } }))).not.toBeNull();
    });

    test('isDnrRule names exactly the rules that need a dnrRuleId', () => {
        expect(dnr.isDnrRule({ type: 'headers' })).toBe(true);
        expect(dnr.isDnrRule({ type: 'queryparams' })).toBe(true);
        expect(dnr.isDnrRule(blockAll())).toBe(true);
        expect(dnr.isDnrRule(redirectAll())).toBe(true);
        expect(dnr.isDnrRule(blockAll({ appliesTo: 'page' }))).toBe(false);
        expect(dnr.isDnrRule({ type: 'mock', appliesTo: 'all' })).toBe(false);
        expect(dnr.isDnrRule(null)).toBe(false);
    });
});

describe('F1: $1-$9 redirects use regexSubstitution and land where the interceptor sends fetch', () => {
    /** RE2::Replace as Chrome applies regexSubstitution: the first match is replaced. */
    function applyDnrRedirect(compiled, url) {
        const regex = new RegExp(compiled.condition.regexFilter, compiled.condition.isUrlFilterCaseSensitive ? '' : 'i');
        const m = regex.exec(url);
        if (!m) return null;
        const sub = compiled.action.redirect.regexSubstitution;
        let out = '';
        for (let i = 0; i < sub.length; i++) {
            if (sub[i] === '\\') {
                const next = sub[++i];
                out += next === '\\' ? '\\' : (m[Number(next)] || '');
            } else {
                out += sub[i];
            }
        }
        return url.slice(0, m.index) + out + url.slice(m.index + m[0].length);
    }

    /** Where the shipped interceptor redirects a fetch of `url`. */
    async function interceptorTarget(rule, url) {
        const h = createInterceptor();
        h.syncState({ rules: [{ ...rule, appliesTo: undefined }] });
        await h.fetch(url);
        const target = h.passthroughCalls[0][0];
        return typeof target === 'string' ? target : target.url;
    }

    const cases = [
        ['/\\/assets\\/(\\w+)\\.js/', 'http://localhost:3000/$1-local.js', 'https://cdn.example.com/assets/app.js?v=3'],
        ['/^https:\\/\\/prod\\.example\\.com\\/(.*)$/', 'https://staging.example.com/$1', 'https://prod.example.com/api/users?page=2'],
        ['/\\/(v\\d)\\/(users)/', 'https://api.test/$2/$1/$9/$0', 'https://x.test/v2/users/9'],
        ['/(?:a|b)\\/(\\d+)/', 'https://h.test/n/$1?x=a\\b', 'https://h.test/a/42']
    ];

    test.each(cases)('%s -> %s', async (pattern, destination, url) => {
        const rule = redirectAll({ dnrRuleId: 1, match: { url: pattern, method: '*' }, redirect: { destination } });
        const compiled = dnr.ruleToDnr(rule);
        expect(compiled.action.redirect.url).toBeUndefined();
        expect(compiled.action.redirect.regexSubstitution).toMatch(/\\[1-9]/);
        expect(applyDnrRedirect(compiled, url)).toBe(await interceptorTarget(rule, url));
    });

    test('$n maps to \\n; $0 and references past the last group stay literal; backslashes are doubled', () => {
        const compiled = dnr.ruleToDnr(redirectAll({
            dnrRuleId: 1,
            match: { url: '/\\/(a)\\/(b)/', method: '*' },
            redirect: { destination: 'https://h.test/$2/$1/$0/$3\\x' }
        }));
        expect(compiled.action.redirect.regexSubstitution).toBe('https://h.test/\\2/\\1/$0/$3\\\\x');
    });

    test('a wildcard pattern with no $n keeps a plain redirect.url', () => {
        const compiled = dnr.ruleToDnr(redirectAll({ dnrRuleId: 1, match: { url: '/\\/assets\\//', method: '*' } }));
        expect(compiled.action.redirect).toEqual({ url: 'http://localhost:3000/app.js' });
        expect(compiled.condition.regexFilter).toBe('\\/assets\\/');
    });
});

// ---- F1: ids and sync ---------------------------------------------------------

describe('F1: dnrRuleId allocation and the network layer', () => {
    test('saving an appliesTo:"all" redirect or block allocates a dnrRuleId and registers it', async () => {
        const { mock, send } = await setup();
        expect((await send({ type: 'saveRule', rule: blockAll() })).success).toBe(true);
        expect((await send({ type: 'saveRule', rule: redirectAll() })).success).toBe(true);

        const stored = mock.raw.spliceTapRules;
        expect(stored.map((r) => r.dnrRuleId)).toEqual([1, 2]);
        const registered = mock.getDynamicRules();
        expect(registered.map((r) => [r.id, r.action.type, r.priority])).toEqual([[1, 'block', 100000], [2, 'redirect', 99999]]);
    });

    test('a "page" (or unset) redirect/block gets no dnrRuleId and registers nothing', async () => {
        const { mock, send } = await setup();
        await send({ type: 'saveRule', rule: blockAll({ appliesTo: 'page' }) });
        await send({ type: 'saveRule', rule: redirectAll({ appliesTo: undefined }) });
        expect(mock.raw.spliceTapRules.every((r) => r.dnrRuleId === undefined)).toBe(true);
        expect(mock.getDynamicRules()).toEqual([]);
    });

    test('flipping appliesTo back to "page" removes its DNR rule; flipping again restores it', async () => {
        const { mock, send } = await setup();
        await send({ type: 'saveRule', rule: blockAll() });
        expect(mock.getDynamicRules()).toHaveLength(1);

        await send({ type: 'saveRule', rule: { ...mock.raw.spliceTapRules[0], appliesTo: 'page' } });
        expect(mock.getDynamicRules()).toEqual([]);

        await send({ type: 'saveRule', rule: { ...mock.raw.spliceTapRules[0], appliesTo: 'all' } });
        expect(mock.getDynamicRules().map((r) => r.id)).toEqual([1]);
    });

    test('disabling the rule or switching SpliceTap off withdraws it', async () => {
        const { mock, send } = await setup();
        await send({ type: 'saveRule', rule: blockAll() });
        await send({ type: 'toggleRule', ruleId: 'blk', enabled: false });
        expect(mock.getDynamicRules()).toEqual([]);
        await send({ type: 'toggleRule', ruleId: 'blk', enabled: true });
        await send({ type: 'toggleExtension', active: false });
        expect(mock.getDynamicRules()).toEqual([]);
    });

    test('setRules allocates ids for appliesTo:"all" rules and keeps them unique (PER-28)', async () => {
        const { mock, send } = await setup();
        const response = await send({
            type: 'setRules',
            rules: [blockAll({ id: 'a', dnrRuleId: 9 }), blockAll({ id: 'b', dnrRuleId: 9 }), redirectAll({ id: 'c' }), blockAll({ id: 'p', appliesTo: 'page' })]
        });
        expect(response.success).toBe(true);
        const ids = mock.raw.spliceTapRules.map((r) => r.dnrRuleId);
        expect(ids[3]).toBeUndefined();
        expect(new Set(ids.slice(0, 3)).size).toBe(3);
        expect(ids.slice(0, 3).every((id) => Number.isInteger(id) && id > 0)).toBe(true);
        // New rules never trust an id they brought from elsewhere.
        expect(ids.slice(0, 3)).not.toContain(9);
        expect(mock.getDynamicRules()).toHaveLength(3);
    });

    test('a stored network rule keeps its id across a reorder, and its priority follows the new order', async () => {
        const { mock, send } = await setup();
        await send({ type: 'saveRule', rule: blockAll({ id: 'a' }) });
        await send({ type: 'saveRule', rule: redirectAll({ id: 'b' }) });
        const [a, b] = mock.raw.spliceTapRules;

        await send({ type: 'setRules', rules: [b, a] });
        expect(mock.raw.spliceTapRules.map((r) => [r.id, r.dnrRuleId])).toEqual([['b', b.dnrRuleId], ['a', a.dnrRuleId]]);
        const byId = new Map(mock.getDynamicRules().map((r) => [r.id, r.priority]));
        expect(byId.get(b.dnrRuleId)).toBe(100000);
        expect(byId.get(a.dnrRuleId)).toBe(99999);
    });

    test('an unchanged network rule is not re-registered on the next sync (PER-37)', async () => {
        const { mock, send } = await setup();
        await send({ type: 'saveRule', rule: blockAll() });
        const before = mock.calls.updateDynamicRules;
        await send({ type: 'saveRule', rule: { id: 'm', name: 'M', type: 'mock', enabled: true, match: { url: '*/m', method: '*' }, response: { statusCode: 200, headers: {}, body: {}, delay: 0 } } });
        expect(mock.calls.updateDynamicRules).toBe(before);
    });

    test('a regex Chrome cannot run is refused at save time for an appliesTo:"all" rule', async () => {
        const { send } = await setup({
            extend(mock) {
                mock.chrome.declarativeNetRequest.isRegexSupported = async () => ({ isSupported: false, reason: 'syntaxError' });
            }
        });
        const response = await send({ type: 'saveRule', rule: blockAll({ match: { url: '/a(?=b)/', method: '*' } }) });
        expect(response.success).toBe(false);
        expect(response.error).toMatch(/all requests/);
        // The same pattern on a page-only rule is the interceptor's business.
        expect((await send({ type: 'saveRule', rule: blockAll({ appliesTo: 'page', match: { url: '/a(?=b)/', method: '*' } }) })).success).toBe(true);
    });
});
