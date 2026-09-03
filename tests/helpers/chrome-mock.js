/**
 * Minimal in-memory stand-in for the slice of `chrome.*` that SpliceTap's
 * background/storage layers actually touch (CQ-8).
 *
 * Two things it deliberately does that a naive mock would not:
 *
 * 1. Every async storage method resolves on a *macrotask* (setTimeout 0), not
 *    an already-resolved promise. Read-modify-write races only appear when
 *    another caller can interleave between the get and the set; with
 *    microtask-only resolution the window is far narrower and the QA-2
 *    regression tests would pass even against the unserialized code they
 *    exist to catch. Verified both ways: replacing storage.js's
 *    _serializeMutation with a passthrough makes those tests fail here.
 *
 * 2. It counts calls and can inject failures, so tests can assert on
 *    throttling (PERF-9) and error propagation (QA-1) rather than only the
 *    happy path.
 *
 * `dispatchMessage` reproduces Chrome's onMessage contract, including the
 * "return true to keep sendResponse alive" rule — a handler that forgets it
 * would resolve to undefined here, exactly as it silently would in Chrome.
 */

function defer(value) {
    return new Promise((resolve) => setTimeout(() => resolve(value), 0));
}

/** Minimal chrome.events.Event stand-in. */
function createEvent() {
    const listeners = [];
    return {
        addListener(fn) { listeners.push(fn); },
        removeListener(fn) {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
        },
        hasListener(fn) { return listeners.includes(fn); },
        _listeners: listeners,
        _emit(...args) { return listeners.map((fn) => fn(...args)); }
    };
}

function createStorageArea(data, calls, fail, prefix) {
    return {
        async get(keys) {
            calls[prefix + 'get']++;
            if (fail[prefix + 'get']) throw new Error(fail[prefix + 'get']);
            await defer();
            if (keys == null) return { ...data };
            const wanted = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const key of wanted) {
                if (key in data) out[key] = data[key];
            }
            return out;
        },

        async set(items) {
            calls[prefix + 'set']++;
            if (fail[prefix + 'set']) throw new Error(fail[prefix + 'set']);
            await defer();
            Object.assign(data, JSON.parse(JSON.stringify(items)));
            return undefined;
        },

        async remove(keys) {
            await defer();
            for (const key of (Array.isArray(keys) ? keys : [keys])) delete data[key];
            return undefined;
        },

        async clear() {
            calls[prefix + 'clear']++;
            await defer();
            for (const key of Object.keys(data)) delete data[key];
            return undefined;
        }
    };
}

function createChromeMock(options = {}) {
    const data = { ...(options.initial || {}) };
    const sessionData = { ...(options.session || {}) };

    const calls = {
        get: 0, set: 0, clear: 0, getBytesInUse: 0,
        sessionGet: 0, sessionSet: 0, sessionClear: 0,
        updateDynamicRules: 0, setBadgeText: 0,
        tabsQuery: 0, tabsSendMessage: 0
    };

    // Test hooks: set to a string to make matching calls reject.
    const fail = { set: null, get: null, getBytesInUse: null, sessionGet: null, sessionSet: null, sessionClear: null };

    let bytesInUse = options.bytesInUse || 0;
    let dynamicRules = [];

    const local = createStorageArea(data, calls, fail, '');
    local.QUOTA_BYTES = options.quotaBytes || 10485760;
    local.getBytesInUse = async function () {
        calls.getBytesInUse++;
        if (fail.getBytesInUse) throw new Error(fail.getBytesInUse);
        await defer();
        return bytesInUse;
    };

    const session = createStorageArea(sessionData, calls, fail, 'session');

    const badge = { text: null, color: null };
    const sentTabMessages = [];
    let tabs = options.tabs || [];

    const events = {
        onMessage: createEvent(),
        onInstalled: createEvent(),
        onSuspend: createEvent(),
        onCommand: createEvent(),
        onContextMenuClicked: createEvent(),
        onTabRemoved: createEvent(),
        onTabUpdated: createEvent()
    };

    const chrome = {
        storage: { local, session },

        declarativeNetRequest: {
            MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 5000,
            async getDynamicRules() { await defer(); return dynamicRules.slice(); },
            async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
                calls.updateDynamicRules++;
                await defer();
                dynamicRules = dynamicRules
                    .filter((r) => !removeRuleIds.includes(r.id))
                    .concat(addRules);
                return undefined;
            }
        },

        runtime: {
            lastError: null,
            id: 'test-extension-id',
            getManifest: () => ({ version: options.version || '0.0.1', name: 'SpliceTap' }),
            openOptionsPage: () => { chrome.runtime._optionsOpened = (chrome.runtime._optionsOpened || 0) + 1; },
            onMessage: events.onMessage,
            onInstalled: events.onInstalled,
            onSuspend: events.onSuspend
        },

        action: {
            async setBadgeText({ text }) { calls.setBadgeText++; badge.text = text; },
            async setBadgeBackgroundColor({ color }) { badge.color = color; }
        },

        contextMenus: {
            create: () => undefined,
            removeAll: (cb) => { if (cb) cb(); },
            onClicked: events.onContextMenuClicked
        },

        commands: { onCommand: events.onCommand },

        tabs: {
            async query() { calls.tabsQuery++; await defer(); return tabs.slice(); },
            async sendMessage(tabId, message) {
                calls.tabsSendMessage++;
                sentTabMessages.push({ tabId, message });
                await defer();
                return undefined;
            },
            onRemoved: events.onTabRemoved,
            onUpdated: events.onTabUpdated
        }
    };

    /**
     * Send a message through the registered onMessage listeners the way
     * Chrome does: a listener that returns true keeps the channel open for an
     * async sendResponse; one that does not is treated as answering
     * synchronously (undefined if it never called sendResponse).
     */
    function dispatchMessage(message, sender = { tab: { id: 1 } }) {
        return new Promise((resolve, reject) => {
            const listeners = events.onMessage._listeners;
            if (listeners.length === 0) {
                reject(new Error('dispatchMessage: no onMessage listener registered'));
                return;
            }

            let settled = false;

            // Guard against a handler that silently never responds, so a
            // broken contract surfaces as a clear failure rather than a suite
            // that hangs until Jest's global timeout. Cleared on settle —
            // an uncleared timer per dispatch keeps Node's event loop alive
            // and makes Jest hang after the run instead.
            const guard = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error(`dispatchMessage: no response for "${message && message.type}"`));
                }
            }, 3000);

            const settle = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(guard);
                fn(value);
            };

            const sendResponse = (response) => settle(resolve, response);

            let keptOpen = false;
            for (const listener of listeners) {
                if (listener(message, sender, sendResponse) === true) keptOpen = true;
            }

            if (!keptOpen) settle(resolve, undefined);
        });
    }

    return {
        chrome,
        calls,
        fail,
        events,
        dispatchMessage,
        // Direct access for arrange/assert without going through the API.
        raw: data,
        rawSession: sessionData,
        badge,
        sentTabMessages,
        setTabs(next) { tabs = next; },
        setBytesInUse(n) { bytesInUse = n; },
        getDynamicRules() { return dynamicRules.slice(); },
        setDynamicRules(rules) { dynamicRules = rules.slice(); }
    };
}

module.exports = { createChromeMock };
