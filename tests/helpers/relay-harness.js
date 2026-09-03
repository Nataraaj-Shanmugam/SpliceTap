/**
 * Boot content/content.js — the ISOLATED-world relay between the background
 * service worker and the MAIN-world interceptor.
 *
 * Same approach and rationale as injected-harness.js: run the shipped file
 * unmodified under node, shimming only the small surface it touches
 * (chrome.runtime, document as an event target, window as a property bag).
 *
 * `document` uses the same capture-flag normalisation as the interceptor
 * harness — see createDocumentTarget there for why Node needs it.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RELAY_SRC = fs.readFileSync(path.join(REPO_ROOT, 'content', 'content.js'), 'utf8');

function createEventTarget() {
    const target = new EventTarget();
    const add = EventTarget.prototype.addEventListener.bind(target);
    const remove = EventTarget.prototype.removeEventListener.bind(target);
    const normalize = (options) => (typeof options === 'boolean' ? { capture: options } : options);

    target.addEventListener = (type, listener, options) => add(type, listener, normalize(options));
    target.removeEventListener = (type, listener, options) => remove(type, listener, normalize(options));
    return target;
}

/**
 * @param {object}   options
 * @param {string}   options.href      page URL (drives shouldInject)
 * @param {Function} options.onMessage handler for chrome.runtime.sendMessage;
 *                                     returns the response, or throws to
 *                                     simulate a sleeping service worker
 */
function createRelay(options = {}) {
    const {
        href = 'https://example.test/page',
        onMessage = async () => ({ success: true, rules: [], active: true, settings: {} })
    } = options;

    const doc = createEventTarget();
    doc.visibilityState = 'visible';

    const win = createEventTarget();
    win.location = { href };
    win.postMessage = () => {};

    const sent = [];
    const chrome = {
        runtime: {
            lastError: null,
            onMessage: {
                _listeners: [],
                addListener(fn) { this._listeners.push(fn); }
            },
            sendMessage(message, callback) {
                sent.push(message);
                const result = Promise.resolve().then(() => onMessage(message));
                if (typeof callback === 'function') {
                    result.then((response) => callback(response), () => callback(undefined));
                    return undefined;
                }
                return result;
            }
        }
    };

    const logs = [];
    const quietConsole = {
        log: (...a) => logs.push(['log', ...a]),
        warn: (...a) => logs.push(['warn', ...a]),
        error: (...a) => logs.push(['error', ...a])
    };

    // The relay hands its nonce to the MAIN world in a bootstrap event at
    // document_start; capture it so tests can address the real channels.
    let nonce = null;
    doc.addEventListener('__splicetap_bootstrap__', (event) => {
        nonce = event && event.detail && event.detail.nonce;
    }, true);

    const factory = new Function('window', 'document', 'chrome', 'crypto', 'console', RELAY_SRC);
    factory(win, doc, chrome, globalThis.crypto, quietConsole);

    return {
        window: win,
        document: doc,
        chrome,
        logs,
        sent,
        get nonce() { return nonce; },
        channels: {
            sync: () => '__splicetap_sync_state__:' + nonce,
            log: () => '__splicetap_log__:' + nonce,
            capture: () => '__splicetap_capture__:' + nonce
        },
        /** Emit an interception-log entry the way injected.js does. */
        emitLog(entry) {
            doc.dispatchEvent(new CustomEvent('__splicetap_log__:' + nonce, { detail: entry }));
        },
        emitCapture(entry) {
            doc.dispatchEvent(new CustomEvent('__splicetap_capture__:' + nonce, { detail: entry }));
        },
        /** Messages of one type, in order. */
        sentOfType(type) {
            return sent.filter((m) => m && m.type === type);
        },
        wait(ms) {
            return new Promise((resolve) => setTimeout(resolve, ms));
        }
    };
}

module.exports = { createRelay };
