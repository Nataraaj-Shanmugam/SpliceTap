/**
 * A working XMLHttpRequest for the interceptor tests (CQ-8 / PERF-8).
 *
 * content/injected.js wraps XHR in ~550 lines carrying most of the accumulated
 * bug fixes in the repo (Q-1's double-dispatch, Q-7's responseType and header
 * exposure, Q-8's readystatechange ordering, Q-12's sync delivery, Q-13's
 * abort semantics, QA-6, QA-7). None of it was covered, because the fetch
 * harness only needs a class shape. This is the real thing: it simulates the
 * network, drives readyState transitions, and dispatches the same events a
 * browser does — so the wrapper can be exercised end-to-end.
 *
 * Two fidelity details matter for what the tests assert:
 *
 * 1. `on*` are accessor properties backed by real listeners, not plain fields.
 *    On a real XHR these are event-handler IDL attributes, so dispatchEvent
 *    invokes them. Q-1 removed manual `if (xhr.onload) xhr.onload()` calls
 *    precisely because dispatch already does it — with plain fields, a
 *    regression reintroducing those calls would go unnoticed here.
 *
 * 2. Node has no ProgressEvent, which the wrapper constructs for
 *    load/error/abort/timeout/progress/loadend. The shim below extends Event
 *    with the three IDL fields; the wrapper only ever uses it as an event
 *    type, so nothing observable depends on more than that.
 */

class ProgressEventShim extends Event {
    constructor(type, init = {}) {
        super(type, init);
        this.lengthComputable = !!init.lengthComputable;
        this.loaded = init.loaded || 0;
        this.total = init.total || 0;
    }
}

const MAX_TRACKED_INSTANCES = 100;

const HANDLER_EVENTS = [
    'readystatechange', 'load', 'error', 'abort', 'timeout', 'progress', 'loadend'
];

/**
 * @param {Function} responder ({method, url, headers, body}) =>
 *        { status, statusText, headers, body } | Promise of one.
 *        Throwing (or rejecting) simulates a network failure.
 */
function createMockXHRClass(responder) {
    const instances = [];

    class MockXMLHttpRequest extends EventTarget {
        constructor() {
            super();
            this.readyState = 0;
            this.status = 0;
            this.statusText = '';
            this.responseText = '';
            this.response = '';
            this.responseURL = '';
            this.responseType = '';
            this.timeout = 0;
            this.withCredentials = false;

            this._requestHeaders = {};
            this._responseHeaders = {};
            this._aborted = false;
            this._sent = false;
            this._handlers = {};

            // Bounded: tests only ever look at recent instances, and an
            // unbounded array would retain every XHR a suite constructs.
            instances.push(this);
            if (instances.length > MAX_TRACKED_INSTANCES) instances.shift();
        }

        open(method, url, async = true) {
            this._method = String(method || 'GET').toUpperCase();
            this._url = url;
            this._async = async !== false;
            this.readyState = 1;
            this.dispatchEvent(new Event('readystatechange'));
        }

        setRequestHeader(name, value) {
            this._requestHeaders[String(name).toLowerCase()] = value;
        }

        send(body) {
            this._sent = true;
            this._body = body;

            const deliver = async () => {
                if (this._aborted) return;
                let result;
                try {
                    result = await responder({
                        method: this._method,
                        url: this._url,
                        headers: this._requestHeaders,
                        body: this._body
                    });
                } catch (error) {
                    if (this._aborted) return;
                    this.readyState = 4;
                    this.dispatchEvent(new Event('readystatechange'));
                    this.dispatchEvent(new ProgressEventShim('error'));
                    this.dispatchEvent(new ProgressEventShim('loadend'));
                    return;
                }
                if (this._aborted) return;

                this.status = result.status;
                this.statusText = result.statusText || '';
                this.responseText = result.body || '';
                this.response = result.body || '';
                this.responseURL = this._url;
                this._responseHeaders = result.headers || {};

                this.readyState = 2;
                this.dispatchEvent(new Event('readystatechange'));
                this.readyState = 3;
                this.dispatchEvent(new Event('readystatechange'));
                this.readyState = 4;
                this.dispatchEvent(new Event('readystatechange'));
                this.dispatchEvent(new ProgressEventShim('load'));
                this.dispatchEvent(new ProgressEventShim('loadend'));
            };

            if (this._async) setTimeout(deliver, 0);
            else deliver();
        }

        abort() {
            this._aborted = true;
            this.readyState = 4;
            this.dispatchEvent(new Event('readystatechange'));
            this.dispatchEvent(new ProgressEventShim('abort'));
            this.dispatchEvent(new ProgressEventShim('loadend'));
        }

        getResponseHeader(name) {
            const key = String(name).toLowerCase();
            const found = Object.keys(this._responseHeaders)
                .find((k) => k.toLowerCase() === key);
            return found ? this._responseHeaders[found] : null;
        }

        getAllResponseHeaders() {
            return Object.keys(this._responseHeaders)
                .map((k) => `${k.toLowerCase()}: ${this._responseHeaders[k]}`)
                .join('\r\n');
        }

        overrideMimeType() {}
    }

    // Event-handler IDL attributes: assigning registers a listener, so
    // dispatchEvent invokes them exactly as a browser would.
    for (const type of HANDLER_EVENTS) {
        Object.defineProperty(MockXMLHttpRequest.prototype, 'on' + type, {
            configurable: true,
            get() { return (this._handlers && this._handlers[type]) || null; },
            set(fn) {
                const previous = this._handlers[type];
                if (previous) this.removeEventListener(type, previous);
                this._handlers[type] = fn;
                if (fn) this.addEventListener(type, fn);
            }
        });
    }

    MockXMLHttpRequest.UNSENT = 0;
    MockXMLHttpRequest.OPENED = 1;
    MockXMLHttpRequest.HEADERS_RECEIVED = 2;
    MockXMLHttpRequest.LOADING = 3;
    MockXMLHttpRequest.DONE = 4;

    MockXMLHttpRequest.instances = instances;
    return MockXMLHttpRequest;
}

module.exports = { createMockXHRClass, ProgressEventShim };
