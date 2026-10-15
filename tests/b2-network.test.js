/**
 * Batch 2, group G1 "network":
 *   B2-F7  — match.pageDomains / match.resourceTypes on the DNR layer and in
 *            the network observer;
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
