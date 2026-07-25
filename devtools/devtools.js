/**
 * TurboMock DevTools Entry Point
 * Creates the DevTools panel with proper error handling.
 *
 * Note: this file intentionally does NOT listen for
 * chrome.devtools.network.onRequestFinished. Mocked/blocked/delayed/redirected
 * requests never touch the real network stack, so that API can never see
 * them (see TODO.md §1.5). The interception log is populated out-of-band by
 * content/injected.js -> content/content.js -> service_worker/background.js
 * and polled by devtools/panel.js instead.
 *
 * Panel visibility (P-12 / performance): panel.js polls the background
 * service worker on a timer, which resets the SW's idle timer and keeps it
 * resident for as long as the panel is open — even while the user is
 * looking at a completely different DevTools tab (Elements, Network, ...).
 * chrome.devtools.panels.ExtensionPanel exposes onShown/onHidden for exactly
 * this: onShown hands us the panel document's own `window`, which lets us
 * call hooks the panel page defines on itself to pause/resume its polling
 * loop. onHidden fires with no arguments, so we remember the last
 * panelWindow we were given and reuse it.
 */

(function() {
    'use strict';

    let lastPanelWindow = null;

    // Best-effort call into the panel document. Guarded because the panel
    // page may not have finished loading yet (onShown can fire before the
    // panel's own DOMContentLoaded in some Chrome versions), and because we
    // never want a panel-side bug to break DevTools panel lifecycle.
    function notifyPanel(win, hookName) {
        try {
            if (win && typeof win[hookName] === 'function') {
                win[hookName]();
            }
        } catch (error) {
            console.error('TurboMock: failed to notify panel (' + hookName + ')', error);
        }
    }

    // Create DevTools panel with error handling
    chrome.devtools.panels.create(
        'TurboMock',
        '/assets/icons/icon-16.png',
        '/devtools/panel.html',
        function(panel) {
            // Check for errors
            if (chrome.runtime.lastError) {
                console.error('TurboMock: Panel creation failed:', chrome.runtime.lastError);
                return;
            }

            console.log('TurboMock DevTools panel created successfully');

            if (!panel) {
                return;
            }

            // Don't assume onShown/onHidden exist — check before wiring up,
            // since this is the only lifecycle hook available and we still
            // want the panel to work (just always-polling) if it's ever
            // missing.
            if (panel.onShown && typeof panel.onShown.addListener === 'function') {
                panel.onShown.addListener(function(panelWindow) {
                    console.log('TurboMock panel shown');
                    if (panelWindow) {
                        lastPanelWindow = panelWindow;
                    }
                    notifyPanel(lastPanelWindow, '__turboMockPanelShown');
                });
            }

            if (panel.onHidden && typeof panel.onHidden.addListener === 'function') {
                panel.onHidden.addListener(function() {
                    console.log('TurboMock panel hidden');
                    notifyPanel(lastPanelWindow, '__turboMockPanelHidden');
                });
            }
        }
    );

})();
