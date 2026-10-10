/**
 * Regression tests for fix group A1, "interceptor": content/injected.js and
 * content/content.js (PERSONA-REVIEW PER-1, 2, 8–13, 20, 32, 35).
 *
 * Most use the existing harnesses. The handshake and lifecycle tests need the
 * relay and the interceptor on ONE document, in either load order, which
 * neither harness does on its own, so bootBoth() below runs both shipped files
 * against a shared event target with the same shims the harnesses use.
 */

const fs = require('fs');
const path = require('path');

const { createInterceptor } = require('./helpers/injected-harness');
const { createRelay } = require('./helpers/relay-harness');
const { createMockXHRClass, ProgressEventShim } = require('./helpers/mock-xhr');

const REPO_ROOT = path.resolve(__dirname, '..');
const INJECTED_SRC = fs.readFileSync(path.join(REPO_ROOT, 'content', 'injected.js'), 'utf8');
const RELAY_SRC = fs.readFileSync(path.join(REPO_ROOT, 'content', 'content.js'), 'utf8');

function mockRule(overrides = {}) {
    return {
        id: 'r1',
        name: 'Mock users',
        enabled: true,
        type: 'mock',
        match: { url: '*/api/users*', method: 'GET' },
        response: {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: { mocked: true },
            delay: 0,
            mode: 'static'
        },
        ...overrides
    };
}

function redirectRule(url, destination, overrides = {}) {
    return { id: 'rd', name: 'Redirect', enabled: true, type: 'redirect', match: { url, method: '*' }, redirect: { destination }, ...overrides };
}

/** An EventTarget that honours the boolean capture flag on removal (see injected-harness). */
function eventTarget() {
    const target = new EventTarget();
    const add = EventTarget.prototype.addEventListener.bind(target);
    const remove = EventTarget.prototype.removeEventListener.bind(target);
    const normalize = (options) => (typeof options === 'boolean' ? { capture: options } : options);
    target.addEventListener = (type, listener, options) => add(type, listener, normalize(options));
    target.removeEventListener = (type, listener, options) => remove(type, listener, normalize(options));
    return target;
}

const quiet = { log() {}, warn() {}, error() {} };

/**
 * The interceptor and the relay sharing one document, as in a real frame.
 * `order` is which content script runs first.
 */
function bootBoth({ order = 'injected-first', rules = [mockRule()] } = {}) {
    const doc = eventTarget();
    doc.visibilityState = 'visible';

    const passthroughCalls = [];
    const MockXHR = createMockXHRClass(async () => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"origin":true}' }));
    const mainWindow = {
        location: { href: 'https://example.test/page' },
        crypto: globalThis.crypto,
        XMLHttpRequest: MockXHR,
        fetch: async (...args) => {
            passthroughCalls.push(args);
            return new Response('{"origin":true}', { headers: { 'Content-Type': 'application/json' } });
        },
        SpliceTapPlaceholders: require('../src/placeholders.js'),
        SpliceTapMatcher: require('../src/matcher.js'),
        SpliceTapPatch: require('../src/patch.js')
    };

    const relayWindow = eventTarget();
    relayWindow.location = { href: 'https://example.test/page' };
    const sent = [];
    const chrome = {
        runtime: {
            id: 'splicetap-test-extension',
            lastError: null,
            onMessage: { addListener() {} },
            sendMessage(message, callback) {
                sent.push(message);
                const response = message.type === 'getRules'
                    ? { success: true, active: true, rules, settings: {}, version: 1 }
                    : { success: true };
                const result = Promise.resolve(response);
                if (typeof callback === 'function') {
                    result.then(callback);
                    return undefined;
                }
                return result;
            }
        }
    };

    const runInjected = () => new Function(
        'window', 'document', 'XMLHttpRequest', 'DOMParser', 'ProgressEvent', 'console', INJECTED_SRC
    )(mainWindow, doc, MockXHR, class {}, ProgressEventShim, quiet);
    const runRelay = () => new Function('window', 'document', 'chrome', 'crypto', 'console', RELAY_SRC)(
        relayWindow, doc, chrome, globalThis.crypto, quiet
    );

    if (order === 'injected-first') { runInjected(); runRelay(); } else { runRelay(); runInjected(); }

    return {
        doc, chrome, sent, passthroughCalls, mainWindow, relayWindow,
        fetch: (...args) => mainWindow.fetch(...args),
        settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
        /** What a page script gets by replaying "ready" after load. */
        replayReady() {
            let nonce = null;
            const grab = (e) => { nonce = e.detail && e.detail.nonce; };
            doc.addEventListener('__splicetap_bootstrap__', grab, true);
            doc.dispatchEvent(new CustomEvent('__splicetap_ready__'));
            doc.removeEventListener('__splicetap_bootstrap__', grab, true);
            return nonce;
        }
    };
}

// ---------------------------------------------------------------------------

describe('PER-1: the nonce handover is single-use in both load orders', () => {
    for (const order of ['injected-first', 'relay-first']) {
        test(`${order}: a page replaying "ready" after load gets no nonce`, async () => {
            const b = bootBoth({ order });
            await b.settle();

            expect(b.replayReady()).toBeNull();

            // The handover itself still worked: the interceptor has the rules.
            const response = await b.fetch('https://example.test/api/users');
            expect(await response.json()).toEqual({ mocked: true });
        });
    }
});

describe('PER-2: the shared modules are not reachable from the page', () => {
    test('the three globals are deleted once captured', () => {
        const h = createInterceptor();
        expect(h.window.SpliceTapMatcher).toBeUndefined();
        expect(h.window.SpliceTapPlaceholders).toBeUndefined();
        expect(h.window.SpliceTapPatch).toBeUndefined();
    });

    test('redefining them afterwards is never consulted', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule({ name: 'SECRET' })] });
        const seen = [];
        const spy = (...args) => { seen.push(JSON.stringify(args)); return null; };
        h.window.SpliceTapMatcher = { findMatchingRule: spy, matchUrl: spy };
        h.window.SpliceTapPlaceholders = { processDynamicResponse: spy };
        h.window.SpliceTapPatch = { jsonMergePatch: spy };

        const response = await h.fetch('https://example.test/api/users');

        expect(await response.json()).toEqual({ mocked: true });
        expect(seen).toEqual([]);
    });

    test('without the modules the interceptor stays inert', async () => {
        const h = createInterceptor({ withGlobals: false });
        h.syncState({ rules: [mockRule()] });
        await h.fetch('https://example.test/api/users');
        expect(h.passthroughCalls).toHaveLength(1);
    });
});

describe('PER-8: rules match the absolute URL, with the raw string as fallback', () => {
    const patterns = {
        'host wildcard': '*example.test*',
        'full URL': 'https://example.test/api/users',
        'host and path wildcard': '*example.test/api/users*',
        'path wildcard': '*/api/users*',
        'relative prefix (raw fallback)': '/api/users*'
    };

    for (const [label, pattern] of Object.entries(patterns)) {
        test(`fetch('/api/users') matches a ${label} pattern`, async () => {
            const h = createInterceptor();
            h.syncState({ rules: [mockRule({ match: { url: pattern, method: 'GET' } })] });
            const response = await h.fetch('/api/users');
            expect(await response.json()).toEqual({ mocked: true });
        });

        test(`relative XHR matches a ${label} pattern`, async () => {
            const h = createInterceptor();
            h.syncState({ rules: [mockRule({ match: { url: pattern, method: 'GET' } })] });
            const xhr = await sendXHR(h, 'GET', '/api/users');
            expect(xhr.getResponseHeader('x-splicetap')).toBe('true');
            expect(h.xhrCalls).toHaveLength(0);
        });
    }

    test('first-match order holds across the absolute and raw forms', async () => {
        const rawOnly = mockRule({ id: 'a', match: { url: '/api/users*', method: 'GET' }, response: { statusCode: 200, body: { from: 'raw' }, mode: 'static' } });
        const absOnly = mockRule({ id: 'b', match: { url: '*example.test*', method: 'GET' }, response: { statusCode: 200, body: { from: 'abs' }, mode: 'static' } });

        let h = createInterceptor();
        h.syncState({ rules: [rawOnly, absOnly] });
        expect(await (await h.fetch('/api/users')).json()).toEqual({ from: 'raw' });

        h = createInterceptor();
        h.syncState({ rules: [absOnly, rawOnly] });
        expect(await (await h.fetch('/api/users')).json()).toEqual({ from: 'abs' });
    });

    test('{{request.url}} is the absolute URL', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule({ response: { statusCode: 200, body: { url: '{{request.url}}' }, mode: 'static' } })] });
        const response = await h.fetch('/api/users?x=1');
        expect(await response.json()).toEqual({ url: 'https://example.test/api/users?x=1' });
    });
});

describe('PER-9: a regex redirect replaces the whole URL', () => {
    async function redirectedTo(rule, url) {
        const h = createInterceptor();
        h.syncState({ rules: [rule] });
        await h.fetch(url);
        return String(h.passthroughCalls[0][0]);
    }

    test('anchored on scheme and host, against an absolute URL', async () => {
        const rule = redirectRule('/^https?:\\/\\/[^/]+\\/api\\/old\\/(\\d+)/', 'http://localhost:3000/echo?id=$1');
        expect(await redirectedTo(rule, 'https://api.example.test/api/old/5')).toBe('http://localhost:3000/echo?id=5');
    });

    test('unanchored, against an absolute URL', async () => {
        const rule = redirectRule('/\\/api\\/old\\/(\\d+)/', 'http://localhost:3000/echo?id=$1');
        expect(await redirectedTo(rule, 'https://api.example.test/api/old/5')).toBe('http://localhost:3000/echo?id=5');
    });

    test('unanchored, against a relative URL', async () => {
        const rule = redirectRule('/\\/api\\/old\\/(\\d+)/', 'http://localhost:3000/echo?id=$1');
        expect(await redirectedTo(rule, '/api/old/5')).toBe('http://localhost:3000/echo?id=5');
    });

    test('anchored on the relative form still matches a relative URL', async () => {
        const rule = redirectRule('/^\\/api\\/(.*)$/', 'http://localhost:3000/v2/$1');
        expect(await redirectedTo(rule, '/api/users/7')).toBe('http://localhost:3000/v2/users/7');
    });

    test('a missing group is empty and a reference past the last group stays literal', async () => {
        const rule = redirectRule('/\\/api\\/(x)?(old)/', 'http://localhost:3000/$1-$2-$3');
        expect(await redirectedTo(rule, 'https://example.test/api/old')).toBe('http://localhost:3000/-old-$3');
    });
});

/** Open and send one XHR; resolves with the instance once it settles. */
function sendXHR(h, method, url, { headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const xhr = h.newXHR();
        const timer = setTimeout(() => reject(new Error('XHR never settled')), 3000);
        xhr.addEventListener('loadend', () => { clearTimeout(timer); resolve(xhr); });
        xhr.open(method, url);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        xhr.send(body);
    });
}

describe('PER-10: XHR honours first-match precedence over redirects', () => {
    const redirect = redirectRule('*/api/*', 'https://example.test/redirect-target');

    test('a mock above a broader redirect wins', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule({ match: { url: '*/api/prec*', method: '*' } }), redirect] });
        const xhr = await sendXHR(h, 'GET', '/api/prec');
        expect(xhr.getResponseHeader('x-splicetap')).toBe('true');
        expect(h.xhrCalls).toHaveLength(0);
    });

    test('a block above a broader redirect wins', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [{ id: 'b', name: 'b', enabled: true, type: 'block', match: { url: '*/api/prec*', method: '*' } }, redirect] });
        const xhr = await sendXHR(h, 'GET', '/api/prec');
        expect(xhr.status).toBe(0);
        expect(h.xhrCalls).toHaveLength(0);
    });

    test('a redirect above a mock still redirects', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [redirect, mockRule({ match: { url: '*/api/prec*', method: '*' } })] });
        await sendXHR(h, 'GET', '/api/prec');
        expect(h.xhrCalls.map((c) => c.url)).toEqual(['https://example.test/redirect-target']);
    });

    test('a header-conditioned mock above a redirect is judged at send()', async () => {
        const conditioned = mockRule({ match: { url: '*/api/prec*', method: '*', headers: { 'X-Mock': 'yes' } } });

        let h = createInterceptor();
        h.syncState({ rules: [conditioned, redirect] });
        let xhr = await sendXHR(h, 'GET', '/api/prec', { headers: { 'X-Mock': 'yes' } });
        expect(xhr.getResponseHeader('x-splicetap')).toBe('true');
        expect(h.xhrCalls).toHaveLength(0);

        h = createInterceptor();
        h.syncState({ rules: [conditioned, redirect] });
        xhr = await sendXHR(h, 'GET', '/api/prec', { headers: { 'X-Other': '1' } });
        expect(h.xhrCalls).toHaveLength(1);
        expect(h.xhrCalls[0].url).toBe('https://example.test/redirect-target');
        // The page's header survives the re-open.
        expect(h.xhrCalls[0].headers['x-other']).toBe('1');
    });
});

describe('PER-11: redirecting a fetch(Request) with a body', () => {
    test('re-issues it with a buffered body and the request\'s own fields', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [redirectRule('*/api/save*', 'https://other.test/save')] });

        await h.fetch(new Request('https://example.test/api/save', {
            method: 'POST', body: 'payload', headers: { 'X-Token': 't' }, credentials: 'include'
        }));

        const [target, init] = h.passthroughCalls[0];
        expect(target).toBe('https://other.test/save');
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('include');
        expect(new Headers(init.headers).get('x-token')).toBe('t');
        expect(init.body).toBeInstanceOf(ArrayBuffer);
        expect(Buffer.from(init.body).toString()).toBe('payload');
    });

    test('a GET Request carries no body', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [redirectRule('*/api/save*', 'https://other.test/save')] });
        await h.fetch(new Request('https://example.test/api/save'));
        expect(h.passthroughCalls[0][1].body).toBeUndefined();
    });
});

describe('PER-12: header values outside Latin-1', () => {
    const name = 'Bestellungen – 429';
    const rule429 = (overrides = {}) => mockRule({
        name,
        response: { statusCode: 429, headers: { 'Content-Type': 'text/plain', 'Retry-After': '30' }, body: 'slow down', mode: 'static' },
        ...overrides
    });

    test('a non-ASCII rule name keeps every header and is percent-encoded', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [rule429()] });
        const response = await h.fetch('https://example.test/api/users');
        expect(response.status).toBe(429);
        expect(response.headers.get('content-type')).toBe('text/plain');
        expect(response.headers.get('retry-after')).toBe('30');
        expect(response.headers.get('x-splicetap')).toBe('true');
        expect(decodeURIComponent(response.headers.get('x-splicetap-rule'))).toBe(name);
    });

    test('an ASCII rule name is sent unchanged', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [rule429({ name: 'Orders 429 (v2)' })] });
        const response = await h.fetch('https://example.test/api/users');
        expect(response.headers.get('x-splicetap-rule')).toBe('Orders 429 (v2)');
    });

    test('one bad header value drops only that header', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [mockRule({
                response: { statusCode: 200, headers: { 'Content-Type': 'text/plain', 'X-Note': 'café ☕', 'X-Keep': 'yes' }, body: 'ok', mode: 'static' }
            })]
        });
        const response = await h.fetch('https://example.test/api/users');
        expect(response.headers.get('content-type')).toBe('text/plain');
        expect(response.headers.get('x-keep')).toBe('yes');
        expect(response.headers.get('x-note')).toBeNull();
    });

    test('XHR reports the same marker value', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [rule429()] });
        const xhr = await sendXHR(h, 'GET', 'https://example.test/api/users');
        expect(xhr.getResponseHeader('x-splicetap-rule')).toBe(encodeURIComponent(name));
    });
});

describe('PER-13: XHR patch mode never re-sends', () => {
    const patchRule = mockRule({
        match: { url: '*/text*', method: '*' },
        response: { statusCode: 200, headers: {}, patch: { a: 1 }, delay: 0, mode: 'patch' }
    });

    test('a non-JSON response is delivered unchanged, sent once', async () => {
        const h = createInterceptor({
            originalFetch: async () => new Response('plain real text', { status: 200, headers: { 'Content-Type': 'text/plain', 'X-Origin': 'yes' } })
        });
        h.syncState({ rules: [patchRule] });

        const xhr = await sendXHR(h, 'POST', 'https://example.test/text', { body: 'x' });

        expect(h.passthroughCalls).toHaveLength(1);
        expect(h.xhrCalls).toHaveLength(0);
        expect(xhr.status).toBe(200);
        expect(xhr.responseText).toBe('plain real text');
        expect(xhr.getResponseHeader('x-origin')).toBe('yes');
        expect(xhr.getResponseHeader('x-splicetap')).toBeNull();
    });

    test('an empty 204 is delivered unchanged, sent once', async () => {
        const h = createInterceptor({ originalFetch: async () => new Response(null, { status: 204 }) });
        h.syncState({ rules: [patchRule] });
        const xhr = await sendXHR(h, 'DELETE', 'https://example.test/text');
        expect(h.passthroughCalls).toHaveLength(1);
        expect(h.xhrCalls).toHaveLength(0);
        expect(xhr.status).toBe(204);
    });

    test('a network failure surfaces as an XHR error, not a second send', async () => {
        const h = createInterceptor({ originalFetch: async () => { throw new TypeError('Failed to fetch'); } });
        h.syncState({ rules: [patchRule] });
        let errored = false;
        const xhr = h.newXHR();
        xhr.addEventListener('error', () => { errored = true; });
        const done = new Promise((resolve) => xhr.addEventListener('loadend', resolve));
        xhr.open('POST', 'https://example.test/text');
        xhr.send('x');
        await done;
        expect(errored).toBe(true);
        expect(xhr.status).toBe(0);
        expect(h.xhrCalls).toHaveLength(0);
    });
});

describe('PER-32: an orphaned relay stands the interceptor down', () => {
    test('a matched request passes through once the runtime is gone', async () => {
        const b = bootBoth();
        await b.settle();
        expect(await (await b.fetch('https://example.test/api/users')).json()).toEqual({ mocked: true });

        delete b.chrome.runtime.id; // what an extension reload does to an open tab

        expect(await (await b.fetch('https://example.test/api/users')).json()).toEqual({ origin: true });
        expect(b.passthroughCalls).toHaveLength(1);
    });

    test('log flushes stop, without throwing, after invalidation', async () => {
        const relay = createRelay();
        delete relay.chrome.runtime.id;
        relay.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };

        relay.emitLog({ ts: 1, url: 'https://example.test/', method: 'GET', ruleId: 'r' });
        relay.emitCapture({ ts: 1, url: 'https://example.test/', method: 'GET', body: 'x' });
        relay.window.dispatchEvent(new Event('pagehide'));
        await relay.wait(300);
        // Reaching here means nothing threw out of a listener or timer.
    });

    test('the relay answers a ping with a deactivate once the runtime is gone', () => {
        const relay = createRelay();
        const deactivations = [];
        relay.document.addEventListener('__splicetap_deactivate__:' + relay.nonce, () => deactivations.push(1), true);

        relay.document.dispatchEvent(new CustomEvent('__splicetap_ping__:' + relay.nonce));
        expect(deactivations).toHaveLength(0);

        delete relay.chrome.runtime.id;
        relay.document.dispatchEvent(new CustomEvent('__splicetap_ping__:' + relay.nonce));
        expect(deactivations).toHaveLength(1);
    });

    test('a later state push cannot revive a deactivated interceptor', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });
        h.document.dispatchEvent(new CustomEvent('__splicetap_deactivate__:' + h.nonce));
        h.syncState({ rules: [mockRule()] });
        await h.fetch('https://example.test/api/users');
        expect(h.passthroughCalls).toHaveLength(1);
    });
});

describe('PER-35: state is re-requested on prerender activation and bfcache restore', () => {
    test('prerenderingchange asks for state again', async () => {
        const relay = createRelay();
        await relay.wait(0);
        const before = relay.sentOfType('getRules').length;
        relay.document.dispatchEvent(new Event('prerenderingchange'));
        expect(relay.sentOfType('getRules')).toHaveLength(before + 1);
    });

    test('a persisted pageshow asks for state again; an ordinary one does not', async () => {
        const relay = createRelay();
        await relay.wait(0);
        const before = relay.sentOfType('getRules').length;

        relay.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
        expect(relay.sentOfType('getRules')).toHaveLength(before);

        relay.window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
        expect(relay.sentOfType('getRules')).toHaveLength(before + 1);
    });
});

describe('PER-20: about:blank and about:srcdoc frames are wired up', () => {
    for (const href of ['about:blank', 'about:srcdoc']) {
        test(`${href} requests state`, () => {
            const relay = createRelay({ href });
            expect(relay.sentOfType('getRules')).toHaveLength(1);
        });
    }

    test('other about: pages are still skipped', () => {
        const relay = createRelay({ href: 'about:settings' });
        expect(relay.sent).toHaveLength(0);
    });

    test('a relative URL in such a frame resolves against the document base', async () => {
        const h = createInterceptor();
        h.window.location.href = 'about:blank';
        h.document.baseURI = 'https://example.test/app/';
        h.syncState({ rules: [mockRule({ match: { url: '*example.test/api/users*', method: 'GET' } })] });
        const response = await h.fetch('/api/users');
        expect(await response.json()).toEqual({ mocked: true });
    });
});
