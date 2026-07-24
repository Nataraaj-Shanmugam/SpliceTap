/**
 * TurboMock Content Script Relay
 *
 * This script runs in the isolated content script context.
 * The MAIN-world interceptor (content/injected.js) is now loaded declaratively
 * via a separate manifest content_scripts entry ("world": "MAIN"), so this
 * script no longer injects it via a <script> tag. It only relays state
 * between the background script and the page (window.postMessage).
 */

(function() {
    'use strict';

    // State
    let stateRequestTimeout = null;

    /**
     * Request initial state from background script
     */
    function requestInitialState() {
        // Clear any existing timeout
        if (stateRequestTimeout) {
            clearTimeout(stateRequestTimeout);
        }

        chrome.runtime.sendMessage({ type: 'getRules' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('Failed to get rules from background:', chrome.runtime.lastError);
                // Retry after delay
                stateRequestTimeout = setTimeout(requestInitialState, 2000);
                return;
            }

            if (response && response.success) {
                forwardStateToInjected(response);
            } else {
                console.warn('Invalid response from background script:', response);
                // Retry after delay
                stateRequestTimeout = setTimeout(requestInitialState, 2000);
            }
        });
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

        window.postMessage({
            source: 'turbomock-extension',
            type: 'syncState',
            payload: state
        }, '*');
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
            try {
                if (request.type === 'syncState') {
                    forwardStateToInjected(request);
                    sendResponse({ success: true });
                }
            } catch (error) {
                console.error('Error handling message:', error);
                sendResponse({ success: false, error: error.message });
            }
            return true;
        });
    }

    /**
     * Listen for page (window.postMessage) traffic from the MAIN-world
     * injected script and forward interception-log entries to the background
     * script (the §1.5 pipeline).
     */
    function setupPageMessageListener() {
        window.addEventListener('message', (event) => {
            if (!event.data || event.data.source !== 'turbomock-injected') {
                return;
            }

            if (event.data.type === 'logInterception') {
                if (!event.data.entry || typeof event.data.entry !== 'object') {
                    console.warn('Invalid interception log entry received from injected script');
                    return;
                }

                chrome.runtime.sendMessage({
                    type: 'logInterception',
                    entry: event.data.entry
                }).catch(error => {
                    console.error('Failed to send interception log entry to background:', error);
                });
            }
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
            console.log('TurboMock: Skipping relay setup for this page');
            return;
        }

        console.log('TurboMock content script initializing...');

        // Setup listeners first
        setupMessageListener();
        setupPageMessageListener();

        // The interceptor now loads declaratively (manifest MAIN-world content
        // script), so document_start is already the right timing to request
        // state — no need to wait for DOMContentLoaded.
        requestInitialState();
        console.log('TurboMock content script initialized successfully');
    }

    initialize();

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (stateRequestTimeout) {
            clearTimeout(stateRequestTimeout);
        }
    });

})();