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
 * realm — see TODO.md 1.7), so payload shape validation below is kept as
 * defense in depth.
 */

(function() {
    'use strict';

    const SYNC_STATE_EVENT = '__splicetap_sync_state__';
    const LOG_INTERCEPTION_EVENT = '__splicetap_log__';

    // Rule types the interceptor (content/injected.js) actually consults.
    // Must mirror src/matcher.js's INTERCEPTOR_TYPES. 'headers'/'queryparams'
    // are DNR-backed and are never read by the interceptor, so we don't pay
    // to clone them into the MAIN world of every frame (P-8).
    const INTERCEPTOR_RULE_TYPES = ['mock', 'block', 'delay', 'redirect'];

    // State
    let stateRequestTimeout = null;
    let stateRequestAttempts = 0;
    const MAX_STATE_REQUEST_ATTEMPTS = 5;

    /**
     * Request initial state from background script
     */
    function requestInitialState() {
        // Clear any existing timeout
        if (stateRequestTimeout) {
            clearTimeout(stateRequestTimeout);
            stateRequestTimeout = null;
        }

        chrome.runtime.sendMessage({ type: 'getRules' }, (response) => {
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
    function forwardStateToInjected(state) {
        // Validate state before forwarding
        if (!validateState(state)) {
            console.error('Invalid state received, not forwarding to injected script');
            return;
        }

        const filteredRules = state.rules.filter((rule) =>
            rule && INTERCEPTOR_RULE_TYPES.indexOf(rule.type || 'mock') !== -1
        );

        document.dispatchEvent(new CustomEvent(SYNC_STATE_EVENT, {
            detail: {
                active: state.active,
                rules: filteredRules,
                settings: state.settings || {}
            }
        }));
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
        document.addEventListener(LOG_INTERCEPTION_EVENT, (event) => {
            const entry = event && event.detail;
            if (!entry || typeof entry !== 'object') {
                console.warn('Invalid interception log entry received from injected script');
                return;
            }

            chrome.runtime.sendMessage({
                type: 'logInterception',
                entry
            }).catch(error => {
                console.error('Failed to send interception log entry to background:', error);
            });
        });
    }

    /**
     * Check if we should inject on this page
     */
    function shouldInject() {
        const url = window.location.href;

        // Don't inject on chrome:// pages
        if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
            return false;
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
