/**
 * SpliceTap Content Script Relay
 *
 * This script runs in the isolated content script context.
 * The MAIN-world interceptor (content/injected.js) is now loaded declaratively
 * via a separate manifest content_scripts entry ("world": "MAIN"), so this
 * script no longer injects it via a <script> tag. It only relays state
 * between the background script and the page (MAIN world).
 *
 * Transport note (P-13 / S-4 / C-5 / Q-14): the ISOLATED and MAIN worlds
 * share the same `document`, so instead of `window.postMessage`/'message'
 * (which delivers, and forces a structured-clone of, EVERY postMessage the
 * page itself sends — ad frames, GTM, payment iframes, etc. — before we can
 * even check whether it's ours) we use namespaced CustomEvents dispatched on
 * `document`. The browser only invokes a listener for the exact event type
 * it's registered for, so page traffic on other event types (including the
 * generic 'message' event) never reaches us and is never cloned for us. This
 * also means a child iframe's `parent.postMessage(...)` can no longer forge
 * state into this frame's relay — CustomEvents dispatched on a document only
 * reach listeners on that same document, never a parent/sibling frame's.
 * A same-frame page script that knows the event names can still dispatch
 * them (an inherent limit of MAIN-world content scripts sharing the page's
 * realm), so payload shape validation below is kept as
 * defense in depth.
 */

(function() {
    'use strict';

    // SEC-2: the channel names are keyed by a per-frame random nonce so a page
    // script (or a third-party iframe) cannot listen in on the rule set or
    // forge state into the interceptor. See the long note in content/injected.js
    // for the threat model and its honest limits.
    //
    // The handover happens here, synchronously, at document_start — before any
    // page script has executed — so nothing on the page can be listening for
    // the bootstrap event yet, and the nonce is unguessable afterwards.
    const nonce = (() => {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    })();

    const SYNC_STATE_EVENT = '__splicetap_sync_state__:' + nonce;
    const LOG_INTERCEPTION_EVENT = '__splicetap_log__:' + nonce;
    const CAPTURE_EVENT = '__splicetap_capture__:' + nonce;
    const PING_EVENT = '__splicetap_ping__:' + nonce;             // PER-32
    const DEACTIVATE_EVENT = '__splicetap_deactivate__:' + nonce; // PER-32

    // Manifest injection order across worlds is not something to bet the
    // feature on, so the handshake works whichever script runs first:
    //   injected first -> it is listening, this dispatch lands.
    //   relay first    -> this dispatch is lost, but injected announces itself
    //                     on load and we re-send once.
    // Only the first handover is honoured on both sides, so a page script
    // cannot replay "ready" later to make us re-broadcast the nonce.
    let readyHandled = false;

    // Returns true when the interceptor took the nonce: it cancels the event.
    function dispatchBootstrap() {
        return !document.dispatchEvent(new CustomEvent('__splicetap_bootstrap__', {
            detail: { nonce },
            cancelable: true
        }));
    }

    function onInjectedReady() {
        // Answer exactly one "ready", then stop listening — otherwise a page
        // script could replay it after document_start to make us re-broadcast
        // the nonce at a moment when it *can* be listening.
        if (readyHandled) return;
        readyHandled = true;
        document.removeEventListener('__splicetap_ready__', onInjectedReady, true);
        dispatchBootstrap();
    }

    // PER-1: when the interceptor ran first, this dispatch IS the handover,
    // and its "ready" went out before anyone was listening. The ready listener
    // used to be armed regardless and stayed armed for the life of the page,
    // so the first page script to dispatch "ready" got the nonce re-broadcast
    // to its own bootstrap listener — and with it every rule. Arm it only
    // when the handover has not happened yet.
    if (dispatchBootstrap()) {
        readyHandled = true;
    } else {
        document.addEventListener('__splicetap_ready__', onInjectedReady, true);
    }

    // Rule types the interceptor (content/injected.js) actually consults.
    // Must mirror src/matcher.js's INTERCEPTOR_TYPES. 'headers'/'queryparams'
    // are DNR-backed and are never read by the interceptor, so we don't pay
    // to clone them into the MAIN world of every frame (P-8).
    const INTERCEPTOR_RULE_TYPES = ['mock', 'block', 'delay', 'redirect'];

    // State
    let stateRequestTimeout = null;
    let stateRequestAttempts = 0;
    const MAX_STATE_REQUEST_ATTEMPTS = 5;

    // PER-32: after the extension is reloaded, updated or removed, this script
    // keeps running in every open tab, cut off from it: chrome.runtime.id goes
    // away and every runtime call throws "Extension context invalidated". The
    // interceptor in the same frame kept serving its last rules — mocks the
    // popup no longer showed, which no OFF switch could reach any more.
    //
    // A runtime.connect() port reports this as a disconnect, but only while
    // the background holds an onConnect listener, and an MV3 worker drops its
    // ports every time it idles out; holding one would also keep the page out
    // of the back/forward cache. So the check runs where it matters: the
    // interceptor pings this relay synchronously before it applies a rule,
    // and every runtime call below is guarded by it.
    let orphaned = false;

    function runtimeAlive() {
        try {
            return !!(chrome.runtime && chrome.runtime.id);
        } catch (e) {
            return false;
        }
    }

    /** True (and the interceptor told to stand down) once the runtime is gone. */
    function checkOrphaned() {
        if (orphaned) return true;
        if (runtimeAlive()) return false;
        orphaned = true;
        if (stateRequestTimeout) {
            clearTimeout(stateRequestTimeout);
            stateRequestTimeout = null;
        }
        document.dispatchEvent(new CustomEvent(DEACTIVATE_EVENT));
        return true;
    }

    /**
     * Request initial state from background script
     */
    function requestInitialState() {
        // Clear any existing timeout
        if (stateRequestTimeout) {
            clearTimeout(stateRequestTimeout);
            stateRequestTimeout = null;
        }
        if (checkOrphaned()) return;

        try {
            // PER-34: the interceptor needs only enabled interceptor rules —
            // not disabled rules' mock bodies or the DNR-backed ones.
            chrome.runtime.sendMessage({ type: 'getRules', scope: 'interceptor' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error('Failed to get rules from background:', chrome.runtime.lastError);
                    scheduleRetry();
                    return;
                }

                if (response && response.success) {
                    stateRequestAttempts = 0;
                    forwardStateToInjected(response);
                } else {
                    console.warn('Invalid response from background script:', response);
                    scheduleRetry();
                }
            });
        } catch (error) {
            // Invalidated between the check and the call.
            if (!checkOrphaned()) scheduleRetry();
        }
    }

    /**
     * Schedule a retry of requestInitialState, capped at
     * MAX_STATE_REQUEST_ATTEMPTS (P-11c) so an unreachable background script
     * doesn't keep this content script (and the service worker it keeps
     * waking) retrying forever.
     */
    function scheduleRetry() {
        stateRequestAttempts++;
        if (stateRequestAttempts > MAX_STATE_REQUEST_ATTEMPTS) {
            console.error(
                `SpliceTap: failed to reach the background script after ${MAX_STATE_REQUEST_ATTEMPTS} attempts; ` +
                'giving up for this page load. Mocking stays inactive here unless a later syncState push arrives.'
            );
            return;
        }
        stateRequestTimeout = setTimeout(requestInitialState, 2000);
    }

    /**
     * Forward state to injected script
     */
    // Highest state version applied in this frame. State reaches the relay on
    // two channels — the reply to its own getRules, and pushed syncState
    // messages — with no ordering between them, and the background used to
    // send delayed snapshots too. Anything older than what is already applied
    // is dropped, so a late, stale state can never overwrite a newer one.
    let appliedVersion = -1;

    function forwardStateToInjected(state) {
        // Validate state before forwarding
        if (!validateState(state)) {
            console.error('Invalid state received, not forwarding to injected script');
            return;
        }

        if (typeof state.version === 'number') {
            if (state.version < appliedVersion) return;
            appliedVersion = state.version;
        }

        const filteredRules = state.rules.filter((rule) =>
            rule && INTERCEPTOR_RULE_TYPES.indexOf(rule.type || 'mock') !== -1
        );

        const detail = {
            active: state.active,
            rules: filteredRules,
            settings: state.settings || {}
        };
        document.dispatchEvent(new CustomEvent(SYNC_STATE_EVENT, { detail }));
        appliedState = { ...detail, version: state.version };
    }

    // PER-20: the state this frame applied last, readable by the relay in an
    // about:blank or srcdoc frame this page creates. Such a frame's content
    // scripts run inside appendChild() (or window.open()), and a page that
    // uses the frame straight away — appendChild, then frame.contentWindow
    // .fetch() — would otherwise beat its getRules round trip. The value
    // lives on this extension's isolated-world view of `window`, which page
    // scripts and other extensions cannot see.
    let appliedState = null;
    try {
        Object.defineProperty(window, '__spliceTapAppliedState', {
            get: () => appliedState,
            configurable: false
        });
    } catch (e) {
        // A second relay in this frame: the first one's state is as good.
    }

    function inheritCreatorState() {
        let creator = null;
        try {
            creator = window.parent !== window ? window.parent : window.opener;
            const state = creator && creator.__spliceTapAppliedState;
            if (state) forwardStateToInjected(state);
        } catch (e) {
            // A cross-origin creator: nothing to inherit, getRules follows.
        }
    }

    /**
     * Validate state structure
     */
    function validateState(state) {
        if (!state || typeof state !== 'object') {
            return false;
        }

        // Required fields
        if (!Array.isArray(state.rules)) {
            console.warn('State missing rules array');
            return false;
        }

        if (typeof state.active !== 'boolean') {
            console.warn('State missing active flag');
            return false;
        }

        return true;
    }

    /**
     * Listen for state updates from background script
     */
    function setupMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            // Only claim messages this relay actually handles. Returning true
            // unconditionally would hold the response channel open for other
            // listeners' messages (e.g. the rule overlay's openRuleOverlay).
            if (!request || request.type !== 'syncState') {
                return false;
            }

            try {
                forwardStateToInjected(request);
                sendResponse({ success: true });
            } catch (error) {
                console.error('Error handling message:', error);
                sendResponse({ success: false, error: error.message });
            }
            return true;
        });
    }

    /**
     * Listen for interception-log CustomEvents from the MAIN-world injected
     * script and forward them to the background script (the 1.5 pipeline).
     */
    function setupPageMessageListener() {
        document.addEventListener(CAPTURE_EVENT, (event) => {
            const entry = event && event.detail;
            if (!entry || typeof entry !== 'object' || typeof entry.body !== 'string') return;
            if (checkOrphaned()) return;

            try {
                chrome.runtime.sendMessage({
                    type: 'logCapture',
                    entry
                }).catch(() => {
                    // Background may be asleep or the page closing — captures are
                    // a convenience, never worth surfacing an error for.
                });
            } catch (error) {
                checkOrphaned();
            }
        });

        document.addEventListener(LOG_INTERCEPTION_EVENT, (event) => {
            const entry = event && event.detail;
            if (!entry || typeof entry !== 'object') {
                console.warn('Invalid interception log entry received from injected script');
                return;
            }

            queueLogEntry(entry);
        });
    }

    // PERF-4: this used to be one chrome.runtime.sendMessage per intercepted
    // request. On a page whose rules match a polling or streaming endpoint
    // that is a continuous stream of messages, and each one is a reason for
    // the service worker to stay awake — so a busy mocked page could keep it
    // resident indefinitely, which is exactly what MV3's ephemeral worker
    // model is trying to avoid.
    //
    // Entries are coalesced into one message per window instead. The log is a
    // diagnostic the user reads after the fact, so a sub-second delay costs
    // nothing; losing entries would matter, so the queue also flushes when it
    // fills and when the page goes away.
    const LOG_BATCH_WINDOW_MS = 250;
    const LOG_BATCH_MAX = 25;

    let logQueue = [];
    let logFlushTimer = null;

    function flushLogQueue() {
        if (logFlushTimer !== null) {
            clearTimeout(logFlushTimer);
            logFlushTimer = null;
        }
        if (logQueue.length === 0) return;

        const entries = logQueue;
        logQueue = [];

        // PER-32: this flush threw an uncaught "Extension context
        // invalidated" in every orphaned tab — a synchronous throw, which the
        // .catch() below never sees.
        if (checkOrphaned()) return;
        try {
            chrome.runtime.sendMessage({
                type: 'logInterceptionBatch',
                entries
            }).catch(error => {
                if (checkOrphaned()) return;
                console.error('Failed to send interception log entries to background:', error);
            });
        } catch (error) {
            checkOrphaned();
        }
    }

    function queueLogEntry(entry) {
        logQueue.push(entry);

        if (logQueue.length >= LOG_BATCH_MAX) {
            flushLogQueue();
            return;
        }
        if (logFlushTimer === null) {
            logFlushTimer = setTimeout(flushLogQueue, LOG_BATCH_WINDOW_MS);
        }
    }

    // A navigation or tab close would otherwise discard whatever is still
    // queued. 'pagehide' fires for both, including bfcache eviction, where
    // 'unload' is unreliable.
    window.addEventListener('pagehide', flushLogQueue);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushLogQueue();
    });

    /**
     * Check if we should inject on this page
     */
    function shouldInject() {
        const url = window.location.href;

        // Don't inject on chrome:// pages
        if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
            return false;
        }

        // PER-20: about:blank and about:srcdoc frames are the page's own
        // documents (the manifest's match_about_blank / match_origin_as_fallback
        // only reach them under an http(s) parent), and their requests go to
        // the page's backend like any other. Other about: pages are internal.
        if (url.startsWith('about:blank') || url.startsWith('about:srcdoc')) {
            return true;
        }

        // Don't inject on internal browser pages
        if (url.startsWith('about:') || url.startsWith('edge://')) {
            return false;
        }

        return true;
    }

    /**
     * Initialize content script
     */
    function initialize() {
        if (!shouldInject()) {
            return;
        }

        // Setup listeners first
        setupMessageListener();
        setupPageMessageListener();
        document.addEventListener(PING_EVENT, checkOrphaned, true); // PER-32

        // PER-35: a prerendered page gets its state while still hidden, and the
        // background's syncState broadcasts reach a tab's active page only, so
        // a rule change made before activation never arrived: the page ran the
        // old rules once shown. A back/forward-cache restore resumes a page
        // frozen with whatever it had. Ask again in both cases; the version
        // check in forwardStateToInjected drops anything older.
        document.addEventListener('prerenderingchange', () => requestInitialState(), { once: true });
        window.addEventListener('pageshow', (event) => {
            if (event && event.persisted) requestInitialState();
        });

        // PER-20: a frame the page made itself starts from its creator's rules
        // synchronously; the background's answer below still follows. (A
        // data: frame has an opaque origin, so it cannot read its creator and
        // waits for that answer like any page.)
        const href = window.location.href;
        if (href.startsWith('about:') || href.startsWith('blob:')) inheritCreatorState();

        // The interceptor now loads declaratively (manifest MAIN-world content
        // script), so document_start is already the right timing to request
        // state — no need to wait for DOMContentLoaded.
        requestInitialState();
    }

    initialize();

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (stateRequestTimeout) {
            clearTimeout(stateRequestTimeout);
        }
    });

})();
