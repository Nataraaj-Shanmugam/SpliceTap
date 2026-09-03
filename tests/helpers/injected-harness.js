/**
 * Boot content/injected.js — the MAIN-world fetch/XHR interceptor — in a
 * controlled environment so its behaviour can be asserted (CQ-8).
 *
 * Environment choice: plain node, not jsdom. injected.js's correctness rests
 * on Response/Headers/Request semantics (status handling, null-body statuses,
 * header merging), and jsdom supplies Headers but neither Response nor
 * Request — so a jsdom run would have to test against hand-written fakes of
 * the exact primitives under test. Node 22 has the real ones. What Node
 * lacks is the DOM, and injected.js needs almost none of it: `document` is
 * used only as an event target for the content-script channel, and `window`
 * only as a property bag. Those are shimmed below; everything that affects
 * the result is genuine.
 *
 * XMLHttpRequest is stubbed just far enough for the patch to install. The XHR
 * interception path is not exercised here; the fetch path is.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INJECTED_SRC = fs.readFileSync(path.join(REPO_ROOT, 'content', 'injected.js'), 'utf8');

const BOOTSTRAP_EVENT = '__splicetap_bootstrap__';

/** Minimal XMLHttpRequest stand-in: enough shape for the patch to wrap it. */
class StubXMLHttpRequest {
    constructor() { this.readyState = 0; }
    open() {}
    send() {}
    setRequestHeader() {}
    getAllResponseHeaders() { return ''; }
    addEventListener() {}
    removeEventListener() {}
    abort() {}
}
StubXMLHttpRequest.UNSENT = 0;
StubXMLHttpRequest.OPENED = 1;
StubXMLHttpRequest.HEADERS_RECEIVED = 2;
StubXMLHttpRequest.LOADING = 3;
StubXMLHttpRequest.DONE = 4;

class StubDOMParser {
    parseFromString() { return {}; }
}

/**
 * A `document` stand-in whose capture flag behaves the way a browser's does.
 *
 * Node's EventTarget does not honour the *boolean* capture form on removal:
 * `removeEventListener(type, fn, true)` fails to remove a listener added with
 * `addEventListener(type, fn, true)`, so a one-shot self-removing capture
 * listener fires again on the next dispatch. Node accepts the equivalent
 * options-object form correctly, and Chrome handles both.
 *
 * injected.js's bootstrap handshake uses exactly that boolean form, so
 * without this normalisation the harness reports a channel-rekeying hole in
 * SEC-2 that does not exist in the browser. Verified directly in Chrome 148:
 * add(true)/remove(true) invokes the handler once, and the same one-shot
 * pattern on `document` also invokes once. Normalising here makes the tests
 * assert browser behaviour rather than a Node artifact.
 */
function createDocumentTarget() {
    const target = new EventTarget();
    const add = EventTarget.prototype.addEventListener.bind(target);
    const remove = EventTarget.prototype.removeEventListener.bind(target);
    const normalize = (options) => (typeof options === 'boolean' ? { capture: options } : options);

    target.addEventListener = (type, listener, options) => add(type, listener, normalize(options));
    target.removeEventListener = (type, listener, options) => remove(type, listener, normalize(options));
    return target;
}

/**
 * Instantiate the interceptor.
 *
 * @param {object}   options
 * @param {Function} options.originalFetch  stands in for the page's real fetch
 * @param {boolean}  options.withGlobals    load the shared UMD modules (default true);
 *                                          false exercises the missing-globals guard
 * @param {boolean}  options.bootstrap      perform the nonce handshake (default true)
 */
function createInterceptor(options = {}) {
    const {
        originalFetch = async () => new Response('{"origin":true}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        }),
        withGlobals = true,
        bootstrap = true
    } = options;

    const doc = createDocumentTarget();
    const passthroughCalls = [];

    const win = {
        location: { href: 'https://example.test/page' },
        crypto: globalThis.crypto,
        XMLHttpRequest: StubXMLHttpRequest,
        postMessage() {},
        fetch: function (...args) {
            passthroughCalls.push(args);
            return originalFetch.apply(this, args);
        }
    };

    if (withGlobals) {
        // The UMD modules register on globalThis under node; injected.js reads
        // them off `window`, exactly as it does in the MAIN world where the
        // manifest loads them first.
        win.SpliceTapPlaceholders = require(path.join(REPO_ROOT, 'src', 'placeholders.js'));
        win.SpliceTapMatcher = require(path.join(REPO_ROOT, 'src', 'matcher.js'));
        win.SpliceTapPatch = require(path.join(REPO_ROOT, 'src', 'patch.js'));
    }

    const logs = [];
    const quietConsole = {
        log: (...a) => logs.push(['log', ...a]),
        warn: (...a) => logs.push(['warn', ...a]),
        error: (...a) => logs.push(['error', ...a])
    };

    // injected.js is an IIFE that reads `window`/`document` from its scope.
    const factory = new Function(
        'window', 'document', 'XMLHttpRequest', 'DOMParser', 'console',
        INJECTED_SRC
    );
    factory(win, doc, StubXMLHttpRequest, StubDOMParser, quietConsole);

    const nonce = 'test-nonce-' + Math.random().toString(36).slice(2);
    const channels = {
        sync: '__splicetap_sync_state__:' + nonce,
        log: '__splicetap_log__:' + nonce,
        capture: '__splicetap_capture__:' + nonce
    };

    if (bootstrap) {
        doc.dispatchEvent(new CustomEvent(BOOTSTRAP_EVENT, { detail: { nonce } }));
    }

    /** Push state the way content.js does, over the nonced channel. */
    function syncState(state) {
        doc.dispatchEvent(new CustomEvent(channels.sync, {
            detail: { active: true, rules: [], settings: {}, ...state }
        }));
    }

    /** Collect events the interceptor emits back toward content.js. */
    function collect(eventName) {
        const seen = [];
        doc.addEventListener(eventName, (e) => seen.push(e.detail), true);
        return seen;
    }

    /**
     * Let fire-and-forget work settle. captureFetchResponse() is intentionally
     * not awaited by the request path — capture must never delay the page's
     * request — so a capture event lands a few microtasks after fetch()
     * resolves. Tests asserting on captures have to yield first.
     */
    function flush() {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    return {
        window: win,
        document: doc,
        flush,
        nonce,
        channels,
        syncState,
        collect,
        logs,
        passthroughCalls,
        BOOTSTRAP_EVENT,
        fetch: (...args) => win.fetch(...args)
    };
}

module.exports = { createInterceptor, StubXMLHttpRequest, BOOTSTRAP_EVENT };
