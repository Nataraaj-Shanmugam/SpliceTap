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

// ---- F2: settings -------------------------------------------------------------

describe('F2/F4: the observeNetworkRules and allowCodeResponses settings', () => {
    test('both default to false', async () => {
        const { send } = await setup();
        const { settings } = await send({ type: 'getRules' });
        expect(settings.observeNetworkRules).toBe(false);
        expect(settings.allowCodeResponses).toBe(false);
    });

    test('settingsUpdated persists both, and getRules reports them', async () => {
        const { mock, send } = await setup();
        const { settings } = await send({ type: 'getRules' });
        const response = await send({ type: 'settingsUpdated', settings: { ...settings, observeNetworkRules: true, allowCodeResponses: true } });
        expect(response.success).toBe(true);
        expect(mock.raw.spliceTapSettings).toMatchObject({ observeNetworkRules: true, allowCodeResponses: true });
        expect((await send({ type: 'getRules' })).settings).toMatchObject({ observeNetworkRules: true, allowCodeResponses: true });

        await send({ type: 'settingsUpdated', settings: { ...settings, observeNetworkRules: false, allowCodeResponses: false } });
        expect(mock.raw.spliceTapSettings).toMatchObject({ observeNetworkRules: false, allowCodeResponses: false });
    });

    test.each([
        ['observeNetworkRules', 'true'],
        ['allowCodeResponses', 1],
        ['allowCodeResponses', 'yes'],
        ['observeNetworkRules', null]
    ])('refuses %s = %p, leaving the stored settings alone', async (key, value) => {
        const { mock, bg, send } = await setup();
        const response = await send({ type: 'settingsUpdated', settings: { theme: 'dark', [key]: value } });
        expect(response.success).toBe(false);
        expect(response.error).toMatch(new RegExp(key));
        expect(mock.raw.spliceTapSettings).toBeUndefined();
        expect(bg.settings[key]).toBe(false);
    });

    test('refuses settings that are not an object', async () => {
        const { send } = await setup();
        expect((await send({ type: 'settingsUpdated', settings: ['observeNetworkRules'] })).success).toBe(false);
        expect((await send({ type: 'settingsUpdated', settings: 'all' })).success).toBe(false);
    });

    test('a content script still cannot change settings (PER-6)', async () => {
        const { mock, send } = await setup();
        const response = await send({ type: 'settingsUpdated', settings: { allowCodeResponses: true } }, { tab: { id: 1 }, frameId: 0, url: 'https://evil.test/' });
        expect(response.success).toBe(false);
        expect(mock.raw.spliceTapSettings).toBeUndefined();
    });
});

// ---- F2: the network observer ---------------------------------------------------

function webRequestEvent() {
    const listeners = [];
    return {
        addListener(fn, filter) { listeners.push(fn); this.filters.push(filter); },
        removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
        hasListener(fn) { return listeners.includes(fn); },
        filters: [],
        _listeners: listeners,
        _emit(details) { listeners.slice().forEach((fn) => fn(details)); }
    };
}

function grantWebRequest(mock) {
    mock.chrome.webRequest = {
        onBeforeRequest: webRequestEvent(),
        onSendHeaders: webRequestEvent(),
        onHeadersReceived: webRequestEvent()
    };
    return mock.chrome.webRequest;
}

function withPermissionsEvents(mock) {
    mock.chrome.permissions = { onAdded: webRequestEvent(), onRemoved: webRequestEvent() };
}

const SETTINGS_ON = { spliceTapSettings: { observeNetworkRules: true } };

const headersRule = (overrides = {}) => ({
    id: 'hdr', name: 'Add header', type: 'headers', enabled: true, dnrRuleId: 1,
    match: { url: '*/echo*', method: '*' },
    headersMod: { request: [{ op: 'set', name: 'X-A', value: '1' }] },
    ...overrides
});

const queryRule = (overrides = {}) => ({
    id: 'qp', name: 'Add flag', type: 'queryparams', enabled: true, dnrRuleId: 2,
    match: { url: '*/echo*', method: '*' },
    queryParams: { add: [{ key: 'flag', value: 'on' }], remove: [] },
    ...overrides
});

/** A background with webRequest granted, these rules stored and the observer on. */
async function observing(rules, { settings = SETTINGS_ON, ...options } = {}) {
    let webRequest;
    const ctx = await setup({
        initial: { spliceTapRules: rules, ...settings },
        ...options,
        extend(mock) { webRequest = grantWebRequest(mock); withPermissionsEvents(mock); }
    });
    return { ...ctx, webRequest };
}

let requestCounter = 0;
const request = (overrides = {}) => ({
    requestId: String(++requestCounter), url: 'http://h.test/echo', method: 'GET', type: 'xmlhttprequest', tabId: 7, ...overrides
});

const logOf = async (send) => (await send({ type: 'getInterceptionLog' })).entries;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('F2: listeners attach only with the permission, the setting and a candidate', () => {
    test('without webRequest nothing is attached and nothing throws', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [headersRule()], ...SETTINGS_ON } });
        expect((await send({ type: 'getRules' })).success).toBe(true);
    });

    test('with the setting off, no listener stays attached', async () => {
        const { webRequest } = await observing([headersRule()], { settings: {} });
        expect(webRequest.onBeforeRequest._listeners).toHaveLength(0);
        expect(webRequest.onSendHeaders._listeners).toHaveLength(0);
        expect(webRequest.onHeadersReceived._listeners).toHaveLength(0);
    });

    test('only the listeners with candidates are attached, over <all_urls>', async () => {
        const { webRequest } = await observing([headersRule()]);
        expect(webRequest.onSendHeaders._listeners).toHaveLength(1);
        expect(webRequest.onSendHeaders.filters[0]).toEqual({ urls: ['<all_urls>'] });
        expect(webRequest.onBeforeRequest._listeners).toHaveLength(0);
        expect(webRequest.onHeadersReceived._listeners).toHaveLength(0);
    });

    test('turning the setting on and off attaches and detaches', async () => {
        const { send, webRequest, bg } = await observing([headersRule()], { settings: {} });
        await send({ type: 'settingsUpdated', settings: { ...bg.settings, observeNetworkRules: true } });
        expect(webRequest.onSendHeaders._listeners).toHaveLength(1);
        await send({ type: 'settingsUpdated', settings: { ...bg.settings, observeNetworkRules: false } });
        expect(webRequest.onSendHeaders._listeners).toHaveLength(0);
    });

    test('a rule change rebuilds the candidates (a new rule attaches its listener)', async () => {
        const { send, webRequest } = await observing([]);
        expect(webRequest.onBeforeRequest._listeners).toHaveLength(0);
        await send({ type: 'saveRule', rule: blockAll() });
        expect(webRequest.onBeforeRequest._listeners).toHaveLength(1);
        await send({ type: 'toggleRule', ruleId: 'blk', enabled: false });
        expect(webRequest.onBeforeRequest._listeners).toHaveLength(0);
    });

    test('switching SpliceTap off empties the candidates', async () => {
        const { send, webRequest } = await observing([headersRule()]);
        await send({ type: 'toggleExtension', active: false });
        expect(webRequest.onSendHeaders._listeners).toHaveLength(0);
    });

    test('reacts to the permission being granted and removed', async () => {
        const { mock, send } = await setup({
            initial: { spliceTapRules: [headersRule()], ...SETTINGS_ON },
            extend: withPermissionsEvents
        });
        const webRequest = grantWebRequest(mock);
        mock.chrome.permissions.onAdded._emit({ permissions: ['webRequest'] });
        await tick();
        expect(webRequest.onSendHeaders._listeners).toHaveLength(1);

        webRequest.onSendHeaders._emit(request());
        expect(await logOf(send)).toHaveLength(1);

        delete mock.chrome.webRequest;
        mock.chrome.permissions.onRemoved._emit({ permissions: ['webRequest'] });
        await tick();
        webRequest.onSendHeaders._emit(request());
        expect(await logOf(send)).toHaveLength(1);
    });

    test('an event that woke the worker before its rules loaded is replayed, not lost', async () => {
        const mock = createChromeMock({ initial: { spliceTapRules: [headersRule()], ...SETTINGS_ON } });
        const webRequest = grantWebRequest(mock);
        restoreChrome = installChrome(mock.chrome);
        const bg = loadEsmModule(BACKGROUND, { chrome: mock.chrome, console: quietConsole }).default;
        activeBackground = bg;
        // Attached in the first turn, before anything is loaded.
        expect(webRequest.onSendHeaders._listeners).toHaveLength(1);
        webRequest.onSendHeaders._emit(request());
        webRequest.onBeforeRequest._emit(request()); // no candidate once loaded
        await bg.ready;
        expect(bg.interceptionLog.map((e) => e.ruleId)).toEqual(['hdr']);
        expect(webRequest.onBeforeRequest._listeners).toHaveLength(0);
    });
});

describe('F2: what a hit records', () => {
    test('a headers rule with request ops is logged from onSendHeaders, redacted, with a hit', async () => {
        const { send, bg, webRequest } = await observing([headersRule()]);
        webRequest.onSendHeaders._emit(request({ url: 'http://h.test/echo?access_token=SECRET1&page=2', tabId: 4 }));

        const [entry] = await logOf(send);
        expect(entry).toMatchObject({
            kind: 'rule',
            ruleId: 'hdr',
            ruleName: 'Add header',
            ruleType: 'headers',
            method: 'GET',
            url: 'http://h.test/echo?access_token=%5Bredacted%5D&page=2',
            note: 'Seen on the network — Chrome applied this rule; SpliceTap matched it independently',
            tabId: 4
        });
        expect(entry.finalStatus).toBeUndefined();
        expect(JSON.stringify(entry)).not.toContain('SECRET1');
        expect(bg.rules[0].hitCount).toBe(1);
        expect(bg.stats.intercepted).toBe(1);
    });

    test('the hit count is persisted with the log', async () => {
        const { mock, bg, webRequest } = await observing([headersRule()]);
        webRequest.onSendHeaders._emit(request());
        webRequest.onSendHeaders._emit(request());
        await bg._persistVolatile(true);
        // The listener's own (unawaited) flush may hold the write.
        const deadline = Date.now() + 2000;
        while (mock.raw.spliceTapRules[0].hitCount !== 2 && Date.now() < deadline) await tick();
        expect(mock.raw.spliceTapRules[0].hitCount).toBe(2);
        expect(mock.rawSession.spliceTapInterceptionLog).toHaveLength(2);
    });

    test('a headers rule with response ops is logged from onHeadersReceived, statusCode as finalStatus', async () => {
        const { send, webRequest } = await observing([headersRule({ headersMod: { response: [{ op: 'set', name: 'X-B', value: '2' }] } })]);
        expect(webRequest.onSendHeaders._listeners).toHaveLength(0);
        webRequest.onHeadersReceived._emit(request({ statusCode: 201 }));
        const [entry] = await logOf(send);
        expect(entry.finalStatus).toBe(201);
    });

    test('a rule with request and response ops counts once per request', async () => {
        const { send, webRequest } = await observing([headersRule({
            headersMod: { request: [{ op: 'set', name: 'X-A', value: '1' }], response: [{ op: 'remove', name: 'X-B' }] }
        })]);
        const r = request();
        webRequest.onSendHeaders._emit(r);
        webRequest.onHeadersReceived._emit({ ...r, statusCode: 200 });
        expect(await logOf(send)).toHaveLength(1);
    });

    test('a request id is counted once per rule, across the redirect Chrome made', async () => {
        const { send, webRequest } = await observing([headersRule()]);
        const r = request();
        webRequest.onSendHeaders._emit(r);
        webRequest.onSendHeaders._emit({ ...r, url: r.url + '?after=redirect' });
        expect(await logOf(send)).toHaveLength(1);
    });

    test('matching uses the DNR rule\'s resource types and methods', async () => {
        const { send, webRequest } = await observing([headersRule({ match: { url: '*/echo*', method: 'POST' } })]);
        webRequest.onSendHeaders._emit(request({ type: 'image', method: 'POST' })); // headers rules: API traffic only
        webRequest.onSendHeaders._emit(request({ method: 'GET' }));
        webRequest.onSendHeaders._emit(request({ url: 'http://h.test/other', method: 'POST' }));
        expect(await logOf(send)).toHaveLength(0);
        webRequest.onSendHeaders._emit(request({ type: 'other', method: 'POST' }));
        expect(await logOf(send)).toHaveLength(1);
    });

    test('a /path* pattern is matched from the path, as DNR anchors it', async () => {
        const { send, webRequest } = await observing([headersRule({ match: { url: '/echo*', method: '*' } })]);
        webRequest.onSendHeaders._emit(request({ url: 'http://h.test/echo/1' }));
        webRequest.onSendHeaders._emit(request({ url: 'http://h.test/x/echo/1' }));
        expect((await logOf(send)).map((e) => e.url)).toEqual(['http://h.test/echo/1']);
    });

    test('a query-param rule is logged from onBeforeRequest when its transform changes the URL', async () => {
        const { send, webRequest } = await observing([queryRule()]);
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/echo?flag=on' })); // Chrome changes nothing
        expect(await logOf(send)).toHaveLength(0);
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/echo?flag=off' }));
        expect((await logOf(send)).map((e) => e.ruleId)).toEqual(['qp']);
    });

    test('an all-request block or redirect is logged for page resources, never for xmlhttprequest', async () => {
        const { send, webRequest } = await observing([blockAll({ dnrRuleId: 3 })]);
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/assets/pixel.png', type: 'xmlhttprequest' }));
        expect(await logOf(send)).toHaveLength(0); // the interceptor logs fetch/XHR itself
        for (const type of ['image', 'script', 'main_frame', 'other']) {
            webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/assets/pixel.png?t=' + type, type }));
        }
        expect((await logOf(send)).map((e) => e.ruleType)).toEqual(['block', 'block', 'block', 'block']);
    });

    test('only the winning block/redirect is logged: network rules first, then list order', async () => {
        const { send, webRequest } = await observing([
            queryRule({ match: { url: '*', method: '*' } }),
            redirectAll({ id: 'r1', dnrRuleId: 4, match: { url: '*/assets/*', method: '*' } }),
            blockAll({ id: 'b2', dnrRuleId: 5, match: { url: '*/assets/*', method: '*' } })
        ]);
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/assets/app.js', type: 'script' }));
        expect((await logOf(send)).map((e) => e.ruleId)).toEqual(['r1']);
    });

    test('disabled rules and rules Chrome refused are not candidates', async () => {
        const { send, bg, webRequest } = await observing([headersRule({ enabled: false }), headersRule({ id: 'h2', dnrRuleId: 9 })]);
        bg.dnrRejected = new Map([['h2', 'refused']]);
        bg._refreshNetworkObserver();
        expect(webRequest.onSendHeaders._listeners).toHaveLength(0);
        webRequest.onSendHeaders._emit(request());
        expect(await logOf(send)).toHaveLength(0);
    });

    test('a request from no tab is logged without a tab id', async () => {
        const { send, webRequest } = await observing([headersRule()]);
        webRequest.onSendHeaders._emit(request({ tabId: -1 }));
        expect((await logOf(send))[0].tabId).toBeNull();
    });
});

// ---- F2: shared redaction -----------------------------------------------------

describe('F2: src/redact.js redacts exactly like the interceptor (PER-4)', () => {
    const { redactUrl } = require('../src/redact');
    const SECRET = 'LEAKME7f3a';
    const token = 'f3a9c2e8b1d4a7c6e5f8a2b3c4d5e6f7';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

    // The SEC2-4 list (tests/fix-interceptor-2.test.js), plus what must survive.
    const cases = [
        `/api/users?session_id=${SECRET}`,
        `/api/users?sessionid=${SECRET}`,
        `/api/users?JSESSIONID=${SECRET}`,
        `/api/users?id_token=${SECRET}`,
        `/api/users?refresh_token=${SECRET}`,
        `/api/users?access-token=${SECRET}`,
        `/api/users?code=${SECRET}`,
        `/api/users?client_secret=${SECRET}`,
        `/api/users?jwt=${SECRET}`,
        `/api/users?X-Amz-Signature=${SECRET}`,
        `/api/users?sig=${SECRET}`,
        `/api/users?user[token]=${SECRET}`,
        `/api/users#access_token=${SECRET}&state=s1`,
        `/api/users#/callback?id_token=${SECRET}`,
        `/api/users/reset/${token}${SECRET}`,
        `/api/users/verify/${jwt}${SECRET}`,
        `/api/users;jsessionid=${SECRET}`,
        '/api/users/42?page=2&q=shoes#section',
        '/api/users/report-2024-final.pdf',
        `/api/users?page=2&refresh_token=${SECRET}#access_token=${SECRET}&state=s1`,
        `/api/users/${'a1'.repeat(1100)}x?q=${'y'.repeat(100)}`
    ];

    async function interceptorLogged(url) {
        const h = createInterceptor();
        h.syncState({ rules: [{ id: 'r', name: 'R', enabled: true, type: 'mock', match: { url: '*', method: '*' }, response: { statusCode: 200, headers: {}, body: {}, delay: 0, mode: 'static' } }] });
        const entries = h.collect(h.channels.log);
        await h.fetch(url);
        return entries[0].url;
    }

    test.each(cases)('absolute %s', async (casePath) => {
        const url = 'https://example.test' + casePath;
        const ours = redactUrl(url);
        expect(ours).toBe(await interceptorLogged(url));
        if (casePath.includes(SECRET)) {
            expect(ours).not.toContain(SECRET);
            expect(ours).toMatch(/redacted/);
        }
    });

    test.each(cases.slice(0, 4))('relative %s resolves against a base like the interceptor', async (casePath) => {
        expect(redactUrl(casePath, 'https://example.test/page')).toBe(await interceptorLogged(casePath));
    });

    test('an unparseable URL is kept as-is', () => {
        expect(redactUrl('not a url')).toBe('not a url');
    });

    test('is published on globalThis for the service worker', () => {
        expect(globalThis.SpliceTapRedact.redactUrl).toBe(redactUrl);
    });
});

// ---- F3: plumbing ---------------------------------------------------------------

describe('F3: requestBody rules reach the interceptor', () => {
    const bodyRule = (overrides = {}) => ({
        id: 'rb', name: 'Body', type: 'requestBody', enabled: true,
        match: { url: '*/api/*', method: 'POST' },
        requestBody: { mode: 'static', body: { replaced: true } },
        ...overrides
    });

    test('_interceptorRules includes enabled requestBody rules, in list order', async () => {
        const { bg, send } = await setup({
            initial: {
                spliceTapRules: [
                    bodyRule(),
                    bodyRule({ id: 'rb-off', enabled: false }),
                    { id: 'm', name: 'M', type: 'mock', enabled: true, match: { url: '*', method: '*' }, response: { statusCode: 200, headers: {}, body: {}, delay: 0 } },
                    headersRule()
                ]
            }
        });
        expect(bg._interceptorRules().map((r) => r.id)).toEqual(['rb', 'm']);
        expect((await send({ type: 'getRules', scope: 'interceptor' })).rules.map((r) => r.id)).toEqual(['rb', 'm']);
    });

    test('the syncState broadcast carries them, body and all', async () => {
        const { mock, send, bg } = await setup({ initial: { spliceTapRules: [bodyRule()] }, tabs: [{ id: 3, url: 'https://a.test/' }] });
        mock.sentTabMessages.length = 0;
        await send({ type: 'settingsUpdated', settings: { ...bg.settings, theme: 'dark' } });
        await new Promise((r) => setTimeout(r, 20));
        const sync = mock.sentTabMessages.find((m) => m.message.type === 'syncState');
        expect(sync.message.rules).toEqual([expect.objectContaining({ id: 'rb', requestBody: { mode: 'static', body: { replaced: true } } })]);
    });

    test('a requestBody hit is accepted into the log and counted', async () => {
        const { bg, send } = await setup({ initial: { spliceTapRules: [bodyRule()] } });
        const response = await send({
            type: 'logInterception',
            entry: { ts: Date.now(), url: 'https://a.test/api/x', method: 'POST', ruleId: 'rb', ruleName: 'Body', ruleType: 'requestBody', status: 200, kind: 'rule', note: 'Request body replaced' }
        }, { tab: { id: 3 }, frameId: 0, url: 'https://a.test/' });
        expect(response.success).toBe(true);
        expect((await logOf(send))[0]).toMatchObject({ ruleType: 'requestBody', note: 'Request body replaced' });
        expect(bg.rules[0].hitCount).toBe(1);
    });
});

describe('F3/F4/F1: storage.normalizeRule keeps the new fields', () => {
    let storage;
    beforeEach(() => {
        const mock = createChromeMock();
        restoreChrome = installChrome(mock.chrome);
        const { SpliceTapStorage } = loadEsmModule(path.resolve(__dirname, '..', 'src', 'storage.js'), { chrome: mock.chrome });
        storage = new SpliceTapStorage();
    });

    test('requestBody (static and patch) passes through untouched', () => {
        const rule = { id: 'rb', type: 'requestBody', match: { url: '*', method: 'POST' }, requestBody: { mode: 'patch', patch: { a: { b: 1 } } } };
        expect(storage.normalizeRule(rule)).toEqual(rule);
        const staticRule = { ...rule, requestBody: { mode: 'static', body: '' } };
        expect(storage.normalizeRule(staticRule).requestBody).toEqual({ mode: 'static', body: '' });
    });

    test('appliesTo is kept', () => {
        expect(storage.normalizeRule(blockAll()).appliesTo).toBe('all');
        expect(storage.normalizeRule(redirectAll({ appliesTo: 'page' })).appliesTo).toBe('page');
    });

    test('a code response keeps mode "code" and its code', () => {
        const rule = { id: 'c', type: 'mock', match: { url: '*', method: '*' }, response: { mode: 'code', code: 'return { ok: true };', delay: 5 } };
        const normalized = storage.normalizeRule(rule);
        expect(normalized.response.mode).toBe('code');
        expect(normalized.response.code).toBe('return { ok: true };');
        expect(normalized.response.delay).toBe(5);
    });

    test('unknown fields and unknown modes are not stripped or rewritten', () => {
        const rule = { id: 'u', type: 'mock', futureField: { x: 1 }, match: { url: '*', method: '*', extra: 1 }, response: { mode: 'stream', statusCode: 200, other: 'y' } };
        const normalized = storage.normalizeRule(rule);
        expect(normalized.futureField).toEqual({ x: 1 });
        expect(normalized.match.extra).toBe(1);
        expect(normalized.response.mode).toBe('stream');
        expect(normalized.response.other).toBe('y');
    });

    test('they survive a save and reload', async () => {
        const rules = [blockAll(), { id: 'rb', name: 'B', type: 'requestBody', enabled: true, match: { url: '*', method: 'POST' }, requestBody: { mode: 'static', body: { a: 1 } } },
            { id: 'c', name: 'C', type: 'mock', enabled: true, match: { url: '*', method: '*' }, response: { mode: 'code', code: 'return 1', statusCode: 200 } }];
        await storage.replaceRules(rules);
        const loaded = await storage.getRules();
        expect(loaded[0].appliesTo).toBe('all');
        expect(loaded[1].requestBody).toEqual({ mode: 'static', body: { a: 1 } });
        expect(loaded[2].response).toMatchObject({ mode: 'code', code: 'return 1' });
    });
});
