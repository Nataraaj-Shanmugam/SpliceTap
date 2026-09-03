/**
 * SpliceTap Rule Templates
 * The canonical set of starter rules (UMD).
 * Loads as: (a) a plain MAIN-world script, (b) a CommonJS module under Jest,
 * (c) via ESM side-effect import.
 *
 * These lived only in options/options.js, which meant the README advertised
 * six presets that the editor people actually use — the in-page overlay, opened
 * by the popup, the context menu and Alt+Shift+N — did not have (PROD-3).
 * Copying them into the overlay would have created a third place for the same
 * knowledge to drift, on top of the two rule editors that already have
 * (CQ-1), so they live here instead and both editors read from one definition.
 *
 * Fields are named for the rule schema, not for either editor's form controls;
 * each editor maps them onto its own inputs.
 */
(function (global) {
    'use strict';

    const TEMPLATES = [
        {
            id: 'graphqlMock',
            label: 'GraphQL Mock',
            description: 'Mock one operation on a shared /graphql endpoint',
            rule: {
                type: 'mock',
                method: 'POST',
                url: '*/graphql*',
                graphqlOperation: 'getUsers',
                status: 200,
                mode: 'static',
                body: '{\n  "data": {}\n}'
            }
        },
        {
            id: 'patchResponse',
            label: 'Patch Response',
            description: 'Let the real response through and change a few fields',
            rule: {
                type: 'mock',
                method: 'GET',
                url: '*/api/*',
                mode: 'patch',
                patch: '{\n  "data": null\n}'
            }
        },
        {
            id: 'blockRequest',
            label: 'Block Request',
            description: 'Fail the request, as an offline or error state would',
            rule: {
                type: 'block',
                method: '*',
                url: '*/api/*'
            }
        },
        {
            id: 'delayRequest',
            label: 'Slow Request',
            description: 'Hold the request, then let it through — for spinners',
            rule: {
                type: 'delay',
                method: '*',
                url: '*/api/*',
                delayMs: 2000
            }
        },
        {
            id: 'redirectLocalhost',
            label: 'Redirect to localhost',
            description: 'Point a production API at your local server',
            rule: {
                type: 'redirect',
                method: '*',
                url: '/\\/(api\\/.*)/',
                redirectDestination: 'http://localhost:3000/$1'
            }
        },
        {
            id: 'corsUnblock',
            label: 'CORS Unblock',
            description: 'Allow cross-origin responses from your local API',
            rule: {
                // C-15: scoped to localhost deliberately. This once defaulted to
                // url '*', so one click applied Access-Control-Allow-Origin: *
                // to every request on every site for as long as it stayed
                // enabled. Widening it has to be a deliberate act.
                type: 'headers',
                method: '*',
                url: '*://localhost/*',
                headersModResponse: [
                    { op: 'set', name: 'Access-Control-Allow-Origin', value: '*' },
                    { op: 'set', name: 'Access-Control-Allow-Headers', value: '*' }
                ]
            }
        },
        {
            id: 'customUserAgent',
            label: 'Custom User-Agent',
            description: 'Send a different User-Agent to your local API',
            rule: {
                // C-15: same scoping reasoning as CORS Unblock above.
                type: 'headers',
                method: '*',
                url: '*://localhost/*',
                headersModRequest: [
                    { op: 'set', name: 'User-Agent', value: 'Mozilla/5.0 (SpliceTap)' }
                ]
            }
        }
    ];

    function listTemplates() {
        return TEMPLATES.map((t) => ({ id: t.id, label: t.label, description: t.description }));
    }

    function getTemplate(id) {
        const found = TEMPLATES.find((t) => t.id === id);
        // Returned as a deep copy so an editor mutating what it applies cannot
        // corrupt the shared definition for the next use.
        return found ? JSON.parse(JSON.stringify(found.rule)) : null;
    }

    const api = { listTemplates, getTemplate };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapTemplates = api;
})(typeof window !== 'undefined' ? window : globalThis);
