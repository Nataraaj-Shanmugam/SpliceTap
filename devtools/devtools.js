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
 */

(function() {
    'use strict';

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

            // Panel lifecycle events
            panel.onShown.addListener(function(panelWindow) {
                console.log('TurboMock panel shown');
                // Could refresh data here if needed
            });

            panel.onHidden.addListener(function() {
                console.log('TurboMock panel hidden');
                // Could pause monitoring here if needed
            });
        }
    );

})();