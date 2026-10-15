/**
 * Batch 2, group G1 "network":
 *   B2-F7  — match.pageDomains / match.resourceTypes on the DNR layer and in
 *            the network observer;
 *   B2-F9  — response-header append and queryParams.removeAll;
 *   B2-F10 — the explainMatch message ("Try a URL" and shadowing);
 *   PER-63 — restorable editor drafts (saveEditorDraft / getEditorDraft /
 *            clearEditorDraft);
 *
 * Chrome's own behaviour is covered by tests/e2e/b2-network.e2e.test.js.
 */

const path = require('path');
const { loadEsmModule, installChrome } = require('./helpers/load-esm');
const { createChromeMock } = require('./helpers/chrome-mock');
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
    id: 'blk', name: 'Block pixel', type: 'block', enabled: true, appliesTo: 'all', dnrRuleId: 3,
    match: { url: '*/assets/pixel.png*', method: '*' },
    ...overrides
});

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

const withMatch = (rule, extra) => ({ ...rule, match: { ...rule.match, ...extra } });

// ---- B2-F7: resource types -----------------------------------------------------

describe('B2-F7: match.resourceTypes on the DNR layer', () => {
    test.each([
        ['fetch-xhr', ['xmlhttprequest']],
        ['document', ['main_frame']],
        ['subdocument', ['sub_frame']],
        ['script', ['script']],
        ['stylesheet', ['stylesheet']],
        ['image', ['image']],
        ['font', ['font']],
        ['media', ['media']],
        ['websocket', ['websocket']],
        ['ping', ['ping']],
        ['other', ['object', 'csp_report', 'webtransport', 'webbundle', 'other']]
    ])('a headers rule limited to %s compiles to %p', (type, expected) => {
        const out = dnr.ruleToDnr(withMatch(headersRule(), { resourceTypes: [type] }));
        expect(out.condition.resourceTypes).toEqual(expected);
    });

    test('headers and query-param rules keep xmlhttprequest + other when the list is absent', () => {
        expect(dnr.ruleToDnr(headersRule()).condition.resourceTypes).toEqual(['xmlhttprequest', 'other']);
        expect(dnr.ruleToDnr(queryRule()).condition.resourceTypes).toEqual(['xmlhttprequest', 'other']);
    });

    test('a query-param rule takes the list too', () => {
        const out = dnr.ruleToDnr(withMatch(queryRule(), { resourceTypes: ['document', 'fetch-xhr'] }));
        expect(out.condition.resourceTypes).toEqual(['xmlhttprequest', 'main_frame']);
    });

    test('the order the rule lists them in does not change the compiled rule (PER-37)', () => {
        const a = dnr.ruleToDnr(withMatch(headersRule(), { resourceTypes: ['image', 'document', 'fetch-xhr'] }));
        const b = dnr.ruleToDnr(withMatch(headersRule(), { resourceTypes: ['fetch-xhr', 'image', 'document', 'image'] }));
        expect(a).toEqual(b);
        expect(a.condition.resourceTypes).toEqual(['xmlhttprequest', 'main_frame', 'image']);
    });

    test('an all-request rule without a list still reaches every type but xmlhttprequest', () => {
        expect(dnr.ruleToDnr(blockAll()).condition.resourceTypes).toEqual(ALL_TYPES);
    });

    test('an all-request rule narrows to its list, and never gets xmlhttprequest', () => {
        const out = dnr.ruleToDnr(withMatch(blockAll(), { resourceTypes: ['image', 'fetch-xhr', 'script'] }));
        expect(out.condition.resourceTypes).toEqual(['script', 'image']);
        const redirect = dnr.ruleToDnr({
            ...blockAll({ type: 'redirect', redirect: { destination: 'https://cdn.test/x.js' } }),
            match: { url: '*/x.js', method: '*', resourceTypes: ['script'] }
        });
        expect(redirect.condition.resourceTypes).toEqual(['script']);
    });

    test('an all-request rule limited to fetch-xhr has no DNR rule — the interceptor has it all', () => {
        expect(dnr.ruleToDnr(withMatch(blockAll(), { resourceTypes: ['fetch-xhr'] }))).toBeNull();
    });

    test('a list naming nothing Chrome knows compiles to nothing, rather than to every type', () => {
        expect(dnr.ruleToDnr(withMatch(headersRule(), { resourceTypes: ['bogus'] }))).toBeNull();
        expect(dnr.ruleToDnr(withMatch(headersRule(), { resourceTypes: [] }))).toBeNull();
        expect(dnr.ruleToDnr(withMatch(headersRule(), { resourceTypes: ['__proto__', 'constructor'] }))).toBeNull();
        // Absent is undefined only: null names no type, it does not mean "default".
        expect(dnr.ruleToDnr(withMatch(headersRule(), { resourceTypes: null }))).toBeNull();
        expect(dnr.ruleToDnr(withMatch(blockAll(), { resourceTypes: null }))).toBeNull();
    });

    test('a repeated or overlapping type is emitted once (Chrome refuses duplicates)', () => {
        const out = dnr.ruleToDnr(withMatch(headersRule(), { resourceTypes: ['other', 'other', 'fetch-xhr', 'fetch-xhr'] }));
        expect(out.condition.resourceTypes).toEqual(['xmlhttprequest', 'object', 'csp_report', 'webtransport', 'webbundle', 'other']);
        expect(new Set(out.condition.resourceTypes).size).toBe(out.condition.resourceTypes.length);
    });
});

// ---- B2-F7: page domains ------------------------------------------------------

describe('B2-F7: match.pageDomains on the DNR layer', () => {
    test('becomes initiatorDomains on every DNR-backed rule type', () => {
        for (const rule of [headersRule(), queryRule(), blockAll()]) {
            const out = dnr.ruleToDnr(withMatch(rule, { pageDomains: ['app.example.com', 'localhost'] }));
            expect(out.condition.initiatorDomains).toEqual(['app.example.com', 'localhost']);
        }
    });

    test('is lowercased and de-duplicated', () => {
        const out = dnr.ruleToDnr(withMatch(headersRule(), { pageDomains: ['Example.COM', 'example.com', ' a.test '] }));
        expect(out.condition.initiatorDomains).toEqual(['example.com', 'a.test']);
    });

    test('absent leaves the condition without initiatorDomains', () => {
        expect(dnr.ruleToDnr(headersRule()).condition).not.toHaveProperty('initiatorDomains');
        expect(dnr.ruleToDnr(blockAll()).condition).not.toHaveProperty('initiatorDomains');
    });

    test('a list with no usable name compiles to nothing, rather than to every page', () => {
        expect(dnr.ruleToDnr(withMatch(headersRule(), { pageDomains: [] }))).toBeNull();
        expect(dnr.ruleToDnr(withMatch(blockAll(), { pageDomains: ['', 7] }))).toBeNull();
        expect(dnr.ruleToDnr(withMatch(blockAll(), { pageDomains: 'example.com' }))).toBeNull();
        expect(dnr.ruleToDnr(withMatch(headersRule(), { pageDomains: null }))).toBeNull();
    });

    test('the sync registers both conditions', async () => {
        const { mock, send } = await setup();
        const response = await send({
            type: 'saveRule',
            rule: { ...headersRule({ dnrRuleId: undefined }), match: { url: '*/echo*', method: '*', pageDomains: ['localhost'], resourceTypes: ['document'] } }
        });
        expect(response.success).toBe(true);
        const [registered] = mock.getDynamicRules();
        expect(registered.condition).toMatchObject({ initiatorDomains: ['localhost'], resourceTypes: ['main_frame'] });
    });
});

// ---- B2-F7: what the interceptor is sent -----------------------------------------

describe('B2-F7: an all-request rule without fetch-xhr is not sent to tabs', () => {
    test('_interceptorRules leaves it out, keeps the rest', async () => {
        const { bg, send } = await setup({
            initial: {
                spliceTapRules: [
                    withMatch(blockAll({ id: 'img-only' }), { resourceTypes: ['image'] }),
                    withMatch(blockAll({ id: 'with-xhr', dnrRuleId: 4 }), { resourceTypes: ['image', 'fetch-xhr'] }),
                    blockAll({ id: 'no-list', dnrRuleId: 5 }),
                    withMatch(blockAll({ id: 'page', appliesTo: 'page', dnrRuleId: undefined }), { resourceTypes: ['image'] })
                ]
            }
        });
        expect(bg._interceptorRules().map((r) => r.id)).toEqual(['with-xhr', 'no-list', 'page']);
        expect((await send({ type: 'getRules', scope: 'interceptor' })).rules.map((r) => r.id)).toEqual(['with-xhr', 'no-list', 'page']);
        // The editor (top frame, no scope) still sees every rule.
        expect((await send({ type: 'getRules' })).rules).toHaveLength(4);
    });
});

// ---- B2-F7: the network observer --------------------------------------------------

function webRequestEvent() {
    const listeners = [];
    return {
        addListener(fn) { listeners.push(fn); },
        removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
        hasListener(fn) { return listeners.includes(fn); },
        _listeners: listeners,
        _emit(details) { listeners.slice().forEach((fn) => fn(details)); }
    };
}

async function observing(rules) {
    let webRequest;
    const ctx = await setup({
        initial: { spliceTapRules: rules, spliceTapSettings: { observeNetworkRules: true } },
        extend(mock) {
            webRequest = mock.chrome.webRequest = {
                onBeforeRequest: webRequestEvent(),
                onSendHeaders: webRequestEvent(),
                onHeadersReceived: webRequestEvent()
            };
        }
    });
    return { ...ctx, webRequest };
}

let requestCounter = 0;
const request = (overrides = {}) => ({
    requestId: 'b2-' + (++requestCounter), url: 'http://h.test/echo', method: 'GET', type: 'xmlhttprequest', tabId: 7, ...overrides
});
const logOf = async (send) => (await send({ type: 'getInterceptionLog' })).entries;

describe('B2-F7: the observer follows the same resource types and page domains', () => {
    test('a headers rule limited to document is logged for a navigation, not for a fetch', async () => {
        const { send, webRequest } = await observing([withMatch(headersRule(), { resourceTypes: ['document'] })]);
        webRequest.onSendHeaders._emit(request({ type: 'xmlhttprequest' }));
        expect(await logOf(send)).toHaveLength(0);
        webRequest.onSendHeaders._emit(request({ type: 'main_frame' }));
        expect((await logOf(send)).map((e) => e.ruleId)).toEqual(['hdr']);
    });

    test('an all-request block limited to image is not logged for a script', async () => {
        const { send, webRequest } = await observing([withMatch(blockAll(), { url: '*/assets/*', resourceTypes: ['image'] })]);
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/assets/a.js', type: 'script' }));
        expect(await logOf(send)).toHaveLength(0);
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/assets/a.png', type: 'image' }));
        expect(await logOf(send)).toHaveLength(1);
    });

    test('pageDomains is judged on the initiator, subdomains included', async () => {
        const { send, webRequest } = await observing([withMatch(headersRule(), { pageDomains: ['example.com'] })]);
        webRequest.onSendHeaders._emit(request({ initiator: 'https://other.test' }));
        webRequest.onSendHeaders._emit(request({ initiator: 'https://notexample.com' }));
        webRequest.onSendHeaders._emit(request({ initiator: undefined })); // address-bar navigation
        webRequest.onSendHeaders._emit(request({ initiator: 'null' })); // opaque origin
        expect(await logOf(send)).toHaveLength(0);
        webRequest.onSendHeaders._emit(request({ initiator: 'https://example.com' }));
        webRequest.onSendHeaders._emit(request({ initiator: 'http://app.EXAMPLE.com:8080' }));
        expect(await logOf(send)).toHaveLength(2);
    });

    test('a rule without pageDomains ignores the initiator', async () => {
        const { send, webRequest } = await observing([headersRule()]);
        webRequest.onSendHeaders._emit(request({ initiator: undefined }));
        expect(await logOf(send)).toHaveLength(1);
    });
});

// ---- B2-F9: response-header append and query "remove all" ------------------------

describe('B2-F9: response-header append', () => {
    test('maps to DNR\'s append operation on the response side', () => {
        const out = dnr.ruleToDnr(headersRule({
            headersMod: {
                request: [],
                response: [
                    { op: 'append', name: 'X-Multi', value: 'a=1' },
                    { op: 'set', name: 'X-Set', value: '2' },
                    { op: 'remove', name: 'X-Gone' }
                ]
            }
        }));
        expect(out.action.responseHeaders).toEqual([
            { header: 'X-Multi', operation: 'append', value: 'a=1' },
            { header: 'X-Set', operation: 'set', value: '2' },
            { header: 'X-Gone', operation: 'remove' }
        ]);
    });

    test('is dropped on the request side, where Chrome 120 cannot append', () => {
        const out = dnr.ruleToDnr(headersRule({
            headersMod: { request: [{ op: 'append', name: 'X-A', value: '1' }, { op: 'set', name: 'X-B', value: '2' }] }
        }));
        expect(out.action.requestHeaders).toEqual([{ header: 'X-B', operation: 'set', value: '2' }]);
    });

    test('needs a string value, and never touches a forbidden header', () => {
        const out = dnr.ruleToDnr(headersRule({
            headersMod: {
                request: [],
                response: [
                    { op: 'append', name: 'X-NoValue' },
                    { op: 'append', name: 'Content-Security-Policy', value: 'default-src *' },
                    { op: 'append', name: 'X-Ok', value: '' }
                ]
            }
        }));
        expect(out.action.responseHeaders).toEqual([{ header: 'X-Ok', operation: 'append', value: '' }]);
    });

    test('the observer logs an append rule from onHeadersReceived', async () => {
        const { send, webRequest } = await observing([headersRule({
            headersMod: { request: [], response: [{ op: 'append', name: 'X-Multi', value: 'b' }] }
        })]);
        expect(webRequest.onSendHeaders._listeners).toHaveLength(0);
        webRequest.onHeadersReceived._emit(request({ statusCode: 200 }));
        expect((await logOf(send)).map((e) => [e.ruleId, e.finalStatus])).toEqual([['hdr', 200]]);
    });
});

describe('B2-F9: queryParams.removeAll', () => {
    const removeAll = (queryParams) => dnr.ruleToDnr(queryRule({ queryParams })).action;

    test('alone, the whole query is dropped: {query: ""}', () => {
        expect(removeAll({ removeAll: true })).toEqual({ type: 'redirect', redirect: { transform: { query: '' } } });
        // A remove list has nothing left to remove.
        expect(removeAll({ removeAll: true, remove: ['a'], add: [] })).toEqual({ type: 'redirect', redirect: { transform: { query: '' } } });
    });

    test('with params to add, the query becomes exactly those, encoded', () => {
        expect(removeAll({ removeAll: true, add: [{ key: 'flag', value: 'on' }, { key: 'q x', value: 'a&b=c/é' }] }).redirect.transform)
            .toEqual({ query: '?flag=on&q%20x=a%26b%3Dc%2F%C3%A9' });
    });

    test('only a literal true counts; otherwise the add/remove transform is unchanged', () => {
        for (const value of [false, 'true', 1, undefined]) {
            expect(removeAll({ removeAll: value, add: [{ key: 'flag', value: 'on' }], remove: ['x'] }).redirect.transform).toEqual({
                queryTransform: { addOrReplaceParams: [{ key: 'flag', value: 'on' }], removeParams: ['x'] }
            });
        }
    });

    test('the observer logs it only when the query would change', async () => {
        const { send, webRequest } = await observing([queryRule({ queryParams: { removeAll: true } })]);
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/echo' }));
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/echo#frag?x=1' }));
        expect(await logOf(send)).toHaveLength(0);
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/echo?a=1' }));
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/echo?' }));
        expect(await logOf(send)).toHaveLength(2);
    });

    test('with adds, the observer logs it unless the query is already exactly those', async () => {
        const { send, webRequest } = await observing([queryRule({ queryParams: { removeAll: true, add: [{ key: 'flag', value: 'on' }] } })]);
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/echo?flag=on' }));
        expect(await logOf(send)).toHaveLength(0);
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/echo?flag=on&a=1' }));
        webRequest.onBeforeRequest._emit(request({ url: 'http://h.test/echo' }));
        expect(await logOf(send)).toHaveLength(2);
    });
});

// ---- B2-F10: explainMatch ------------------------------------------------------------

const mock = (overrides = {}) => ({
    id: 'm', name: 'Mock', type: 'mock', enabled: true,
    match: { url: '*/api/*', method: '*' },
    response: { statusCode: 200, headers: {}, body: {}, delay: 0 },
    ...overrides
});

/**
 * Run with the matcher's explainRuleMatch replaced (a stub recording what it
 * was given), or removed (`null`: the background's own url+method fallback).
 */
async function withExplain(impl, fn) {
    const matcher = globalThis.SpliceTapMatcher;
    const had = Object.prototype.hasOwnProperty.call(matcher, 'explainRuleMatch');
    const previous = matcher.explainRuleMatch;
    if (impl === null) delete matcher.explainRuleMatch;
    else matcher.explainRuleMatch = impl;
    try {
        return await fn();
    } finally {
        if (had) matcher.explainRuleMatch = previous;
        else delete matcher.explainRuleMatch;
    }
}

/** A stub explainRuleMatch: matches by URL pattern and method only, recording each call. */
function recordingExplain() {
    const calls = [];
    const { matchUrl } = globalThis.SpliceTapMatcher;
    const fn = (rule, req) => {
        calls.push({ ruleId: rule.id, req });
        const m = rule.match || {};
        const methodOk = !m.method || m.method === '*' || m.method.toUpperCase() === req.method;
        const ok = matchUrl(req.url, m.url) && methodOk;
        return { matches: ok, checks: [{ condition: 'url', ok, detail: 'stub' }] };
    };
    fn.calls = calls;
    return fn;
}

describe('B2-F10: explainMatch — who may ask', () => {
    test('an extension page and the top frame\'s content script may; a subframe may not', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mock()] } });
        expect((await send({ type: 'explainMatch', ruleId: 'm' })).success).toBe(true);
        expect((await send({ type: 'explainMatch', ruleId: 'm' }, { tab: { id: 1 }, frameId: 0, url: 'https://a.test/' })).success).toBe(true);
        const sub = await send({ type: 'explainMatch', ruleId: 'm' }, { tab: { id: 1 }, frameId: 3, url: 'https://a.test/frame' });
        expect(sub).toEqual({ success: false, error: 'This request is not available to web pages' });
    });

    test('an unknown rule id, or no rule at all, is an error', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mock()] } });
        expect(await send({ type: 'explainMatch', ruleId: 'nope' })).toEqual({ success: false, error: 'Rule not found' });
        expect((await send({ type: 'explainMatch' })).success).toBe(false);
        expect((await send({ type: 'explainMatch', rule: 'x' })).success).toBe(false);
        expect((await send({ type: 'explainMatch', ruleId: 'm', url: 7 })).success).toBe(false);
    });
});

describe('B2-F10: explainMatch — the URL tried', () => {
    const tried = async (pattern, type = 'mock') => {
        const { send } = await setup();
        const rule = type === 'mock' ? mock({ match: { url: pattern, method: '*' } }) : headersRule({ match: { url: pattern, method: '*' } });
        return withExplain(null, () => send({ type: 'explainMatch', rule }));
    };

    test.each([
        ['*/api/*', 'https://example.testx/api/x'],
        ['/api/users*', 'https://example.test/api/usersx'],
        ['https://api.example.com/v1/*', 'https://api.example.com/v1/x'],
        ['*://h.test/*', 'https://h.test/x'],
        ['//cdn.test/*', 'https://cdn.test/x'],
        ['/users/42', 'https://example.test/users/42'],
        ['example.com/users', 'https://example.testexample.com/users'],
        ['*.example.com/*', 'https://example.testx.example.com/x']
    ])('%s is tried as %s, and the rule matches it', async (pattern, expected) => {
        const response = await tried(pattern);
        expect(response).toMatchObject({ success: true, url: expected, network: false });
        expect(response.result.matches).toBe(true);
    });

    test('a scheme-less pattern anchored at its start matches no full URL, and the result says so', async () => {
        const response = await tried('api.example.com/*');
        expect(response).toMatchObject({ success: true, url: 'https://example.testapi.example.com/x' });
        expect(response.result.matches).toBe(false);
    });

    test('for a network rule, a /path* pattern is judged from the path, as Chrome does', async () => {
        const response = await tried('/echo*', 'headers');
        expect(response).toMatchObject({ success: true, url: 'https://example.test/echox', network: true });
        expect(response.result.matches).toBe(true);
    });

    test('a regex pattern needs a URL', async () => {
        const response = await tried('/\\/api\\/(\\d+)/');
        expect(response).toMatchObject({ success: false, needsUrl: true, shadowedBy: [], result: null });
        expect(response.error).toMatch(/regex/);
    });

    test('a given relative URL resolves against the page, and is matched as the page wrote it', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mock({ match: { url: '/api/*', method: '*' } })] } });
        const response = await withExplain(null, () => send({ type: 'explainMatch', ruleId: 'm', url: '/api/users', pageUrl: 'https://shop.test/cart' }));
        expect(response).toMatchObject({ success: true, url: 'https://shop.test/api/users' });
        expect(response.result.matches).toBe(true);
    });

    test('a given absolute URL that does not match says so, condition by condition', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mock({ match: { url: '*/api/*', method: 'POST' } })] } });
        const response = await withExplain(null, () => send({ type: 'explainMatch', ruleId: 'm', url: 'https://x.test/other', method: 'get' }));
        expect(response.result.matches).toBe(false);
        expect(response.result.checks.map((c) => [c.condition, c.ok])).toEqual([['url', false], ['method', false]]);
        expect(response.result.checks.every((c) => typeof c.detail === 'string' && c.detail.length > 0)).toBe(true);
    });
});

describe('B2-F10: explainMatch — what the matcher is asked', () => {
    test('calls the matcher\'s explainRuleMatch with the contract\'s request, and returns its answer', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mock({ match: { url: '*/api/*', method: 'PUT' } })] } });
        const answer = { matches: true, checks: [{ condition: 'url', ok: true, detail: 'From the matcher.' }] };
        const calls = [];
        const response = await withExplain((rule, req) => { calls.push([rule.id, req]); return answer; },
            () => send({ type: 'explainMatch', ruleId: 'm', url: 'https://a.test/api/x', pageUrl: 'https://page.test/', resourceType: 'fetch-xhr', body: { a: 1 } }));
        expect(response.result).toEqual(answer);
        expect(calls).toEqual([['m', {
            url: 'https://a.test/api/x', method: 'PUT', headers: {}, bodyText: '{"a":1}', pageHost: 'page.test', resourceType: 'fetch-xhr'
        }]]);
    });

    test('a synthesised request carries the rule\'s own conditions', async () => {
        const rule = mock({
            match: {
                url: '*/graphql*', method: 'POST', headers: { 'X-Tenant': 'acme' }, graphql: { operationName: 'GetUser' },
                payload: { path: 'user.id', operator: 'equals', value: '42' }, pageDomains: ['App.example.com'], resourceTypes: ['fetch-xhr']
            }
        });
        const { send } = await setup({ initial: { spliceTapRules: [rule] } });
        const stub = recordingExplain();
        await withExplain(stub, () => send({ type: 'explainMatch', ruleId: 'm' }));
        const [{ req }] = stub.calls;
        expect(req).toMatchObject({ method: 'POST', headers: { 'X-Tenant': 'acme' }, pageHost: 'app.example.com', resourceType: 'fetch-xhr' });
        expect(JSON.parse(req.bodyText)).toEqual({ operationName: 'GetUser', user: { id: '42' } });
    });

    test('the page defaults to the request\'s own host, and the method to GET', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mock()] } });
        const stub = recordingExplain();
        await withExplain(stub, () => send({ type: 'explainMatch', ruleId: 'm', url: 'https://api.test/api/x' }));
        expect(stub.calls[0].req).toMatchObject({ pageHost: 'api.test', method: 'GET', resourceType: 'fetch-xhr', headers: {} });
        expect(stub.calls[0].req.bodyText).toBeUndefined();
    });

    test('a payload path cannot reach Object.prototype', async () => {
        const rule = mock({ match: { url: '*/api/*', method: 'POST', payload: { path: '__proto__.polluted', operator: 'equals', value: 'yes' } } });
        const { send } = await setup({ initial: { spliceTapRules: [rule] } });
        await withExplain(recordingExplain(), () => send({ type: 'explainMatch', ruleId: 'm' }));
        expect({}.polluted).toBeUndefined();
    });

    test('a matcher that throws is reported, not a crash', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mock()] } });
        const response = await withExplain(() => { throw new Error('boom'); }, () => send({ type: 'explainMatch', ruleId: 'm' }));
        expect(response.success).toBe(false);
        expect(response.error).toMatch(/boom/);
    });
});

describe('B2-F10: explainMatch — shadowedBy', () => {
    const block = (overrides = {}) => ({ id: 'b', name: 'Block', type: 'block', enabled: true, match: { url: '*/api/*', method: '*' }, ...overrides });
    const body = (overrides = {}) => ({
        id: 'rb', name: 'Body', type: 'requestBody', enabled: true, match: { url: '*/api/*', method: 'POST' },
        requestBody: { mode: 'static', body: {} }, ...overrides
    });
    const shadows = async (rules, message) => {
        const { send } = await setup({ initial: { spliceTapRules: rules } });
        const response = await withExplain(recordingExplain(), () => send({ type: 'explainMatch', ...message }));
        return response.shadowedBy.map((s) => s.ruleId);
    };

    test('earlier enabled page rules that match, in stored order, with their names', async () => {
        const { send } = await setup({
            initial: {
                spliceTapRules: [
                    block({ id: 'b1', name: 'First' }),
                    mock({ id: 'off', enabled: false }),
                    mock({ id: 'other', match: { url: '*/elsewhere/*', method: '*' } }),
                    block({ id: 'b2', name: 'Second', type: 'delay', delayMs: 10 }),
                    mock({ id: 'target' }),
                    mock({ id: 'later' })
                ]
            }
        });
        const response = await withExplain(recordingExplain(), () => send({ type: 'explainMatch', ruleId: 'target' }));
        expect(response.shadowedBy).toEqual([{ ruleId: 'b1', ruleName: 'First' }, { ruleId: 'b2', ruleName: 'Second' }]);
    });

    test('an earlier rule whose method differs does not shadow', async () => {
        expect(await shadows([mock({ id: 'post', match: { url: '*/api/*', method: 'POST' } }), mock({ id: 't' })], { ruleId: 't', method: 'GET' })).toEqual([]);
    });

    test('families do not mix: headers rules and request-body rules never shadow a mock', async () => {
        expect(await shadows([headersRule({ match: { url: '*/api/*', method: '*' } }), body(), mock({ id: 't' })], { ruleId: 't' })).toEqual([]);
    });

    test('a request-body rule is shadowed only by an earlier request-body rule', async () => {
        expect(await shadows([mock(), body({ id: 'rb1' }), body({ id: 't' })], { ruleId: 't' })).toEqual(['rb1']);
    });

    test('network rules shadow network rules', async () => {
        const rules = [
            queryRule({ match: { url: '*/echo*', method: '*' } }),
            mock({ match: { url: '*/echo*', method: '*' } }),
            headersRule({ id: 't' })
        ];
        const { send } = await setup({ initial: { spliceTapRules: rules } });
        const response = await withExplain(recordingExplain(), () => send({ type: 'explainMatch', ruleId: 't' }));
        expect(response).toMatchObject({ network: true, shadowedBy: [{ ruleId: 'qp', ruleName: 'Add flag' }] });
    });

    test('an all-request block is a page rule for fetch/XHR and a network rule for an image', async () => {
        const rules = [
            mock({ id: 'm1' }),
            headersRule({ id: 'h1', match: { url: '*/api/*', method: '*', resourceTypes: ['image'] } }),
            blockAll({ id: 't', match: { url: '*/api/*', method: '*' } })
        ];
        expect(await shadows(rules, { ruleId: 't' })).toEqual(['m1']);
        expect(await shadows(rules, { ruleId: 't', resourceType: 'image' })).toEqual(['h1']);
        // Limited to images, it never meets the interceptor at all.
        const imageOnly = [mock({ id: 'm1' }), blockAll({ id: 't', match: { url: '*/api/*', method: '*', resourceTypes: ['image'] } })];
        expect(await shadows(imageOnly, { ruleId: 't', resourceType: 'fetch-xhr' })).toEqual([]);
    });

    test('a rule not yet saved is judged as if saved last; an edited one at its stored place', async () => {
        const rules = [mock({ id: 'a' }), mock({ id: 'b' }), mock({ id: 'c' })];
        expect(await shadows(rules, { rule: mock({ id: undefined }) })).toEqual(['a', 'b', 'c']);
        expect(await shadows(rules, { rule: mock({ id: 'b', name: 'Edited' }) })).toEqual(['a']);
    });

    test('works on the fallback matcher too', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [block({ id: 'b1' }), mock({ id: 't' })] } });
        const response = await withExplain(null, () => send({ type: 'explainMatch', ruleId: 't' }));
        expect(response.shadowedBy.map((s) => s.ruleId)).toEqual(['b1']);
        expect(response.result.matches).toBe(true);
    });
});

// ---- PER-63: editor drafts --------------------------------------------------------------

describe('PER-63: editor drafts', () => {
    const tab = (id, frameId = 0) => ({ tab: { id }, frameId, url: 'https://a.test/page' });
    const draft = (name = 'Unsaved', extra = {}) => ({ rule: { name, type: 'mock', match: { url: '*/api/*', method: '*' } }, ...extra });

    test('a content script saves, reads and clears its own tab\'s draft, in session storage', async () => {
        const { mock, send } = await setup();
        expect((await send({ type: 'saveEditorDraft', draft: draft() }, tab(5))).success).toBe(true);
        expect(mock.rawSession.spliceTapDrafts['5'].draft).toEqual(draft());
        expect(mock.raw.spliceTapDrafts).toBeUndefined(); // never local storage

        const got = await send({ type: 'getEditorDraft' }, tab(5));
        expect(got).toMatchObject({ success: true, draft: draft() });
        expect(typeof got.savedAt).toBe('number');

        expect((await send({ type: 'clearEditorDraft' }, tab(5))).success).toBe(true);
        expect((await send({ type: 'getEditorDraft' }, tab(5))).draft).toBeNull();
    });

    test('a page cannot reach another tab\'s draft by naming its id', async () => {
        const { send } = await setup();
        await send({ type: 'saveEditorDraft', draft: draft('Tab 5') }, tab(5));
        expect((await send({ type: 'getEditorDraft', tabId: 5 }, tab(6))).draft).toBeNull();
        await send({ type: 'saveEditorDraft', draft: draft('From 6'), tabId: 5 }, tab(6));
        await send({ type: 'clearEditorDraft', tabId: 5 }, tab(6));
        expect((await send({ type: 'getEditorDraft' }, tab(5))).draft.rule.name).toBe('Tab 5');
        expect((await send({ type: 'getEditorDraft' }, tab(6))).draft).toBeNull(); // cleared its own
    });

    test('a subframe is refused all three', async () => {
        const { send } = await setup();
        for (const type of ['saveEditorDraft', 'getEditorDraft', 'clearEditorDraft']) {
            expect(await send({ type, draft: draft() }, tab(5, 2))).toEqual({ success: false, error: 'This request is not available to web pages' });
        }
    });

    test('extension pages name the tab, or "options"; anything else is refused', async () => {
        const { send } = await setup();
        await send({ type: 'saveEditorDraft', draft: draft('Overlay') }, tab(9));
        expect((await send({ type: 'getEditorDraft', tabId: 9 })).draft.rule.name).toBe('Overlay');
        await send({ type: 'saveEditorDraft', tabId: 'options', draft: draft('Options') });
        expect((await send({ type: 'getEditorDraft', tabId: 'options' })).draft.rule.name).toBe('Options');
        for (const tabId of [undefined, '9', -1, 1.5, 'popup']) {
            expect((await send({ type: 'getEditorDraft', tabId })).success).toBe(false);
        }
    });

    test('a draft over 200 KB is refused, and the stored one kept', async () => {
        const { send } = await setup();
        await send({ type: 'saveEditorDraft', draft: draft('Small') }, tab(5));
        const big = await send({ type: 'saveEditorDraft', draft: draft('Big', { body: 'x'.repeat(200 * 1024) }) }, tab(5));
        expect(big.success).toBe(false);
        expect(big.error).toMatch(/200 KB/);
        // Bytes, not characters: 70k three-byte characters is over the cap.
        expect((await send({ type: 'saveEditorDraft', draft: draft('Wide', { body: '€'.repeat(70 * 1024) }) }, tab(5))).success).toBe(false);
        expect((await send({ type: 'getEditorDraft' }, tab(5))).draft.rule.name).toBe('Small');
        expect((await send({ type: 'saveEditorDraft', draft: 'text' }, tab(5))).success).toBe(false);
        expect((await send({ type: 'saveEditorDraft', draft: [1] }, tab(5))).success).toBe(false);
    });

    test('a draft expires after 24 hours', async () => {
        const day = 24 * 60 * 60 * 1000;
        const { mock, send } = await setup({
            session: {
                spliceTapDrafts: {
                    5: { draft: draft('Old'), ts: Date.now() - day - 1000 },
                    6: { draft: draft('Fresh'), ts: Date.now() - day + 60000 }
                }
            }
        });
        expect((await send({ type: 'getEditorDraft' }, tab(5))).draft).toBeNull();
        expect((await send({ type: 'getEditorDraft' }, tab(6))).draft.rule.name).toBe('Fresh');
        await send({ type: 'saveEditorDraft', draft: draft('New') }, tab(7));
        expect(Object.keys(mock.rawSession.spliceTapDrafts).sort()).toEqual(['6', '7']);
    });

    test('closing a tab drops its draft; at most 20 drafts are kept, newest first', async () => {
        const { mock, send } = await setup();
        const realNow = Date.now;
        let clock = realNow();
        Date.now = () => ++clock;
        try {
            // Saved from high tab ids to low: the oldest drafts have the highest ids.
            for (let id = 30; id >= 9; id--) await send({ type: 'saveEditorDraft', draft: draft('T' + id) }, tab(id));
        } finally {
            Date.now = realNow;
        }
        const keys = Object.keys(mock.rawSession.spliceTapDrafts);
        expect(keys).toHaveLength(20);
        expect(keys).not.toContain('30');
        expect(keys).not.toContain('29');
        expect(keys).toContain('9');

        mock.events.onTabRemoved._emit(9);
        await new Promise((r) => setTimeout(r, 20));
        expect((await send({ type: 'getEditorDraft' }, tab(9))).draft).toBeNull();
        expect((await send({ type: 'getEditorDraft' }, tab(10))).draft.rule.name).toBe('T10');
    });

    test('"Delete all SpliceTap data" removes drafts too', async () => {
        const { send } = await setup();
        await send({ type: 'saveEditorDraft', draft: draft() }, tab(5));
        await send({ type: 'resetAll' });
        expect((await send({ type: 'getEditorDraft' }, tab(5))).draft).toBeNull();
    });
});
