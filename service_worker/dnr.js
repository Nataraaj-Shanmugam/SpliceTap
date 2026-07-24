/**
 * TurboMock DNR (declarativeNetRequest) sync.
 * Maps v2 'headers' / 'queryparams' rules to chrome.declarativeNetRequest
 * dynamic rules and keeps the DNR ruleset in sync with stored rules. See
 * TODO.md §G4.1.
 *
 * Module-loading note: written UMD-only (no top-level ESM `export`) because
 * this repo's Jest has no ESM transform (see src/index.js's require-based
 * workaround for the same constraint on utils.js/storage.js in G1) -- a
 * top-level `export function` here would make `require()` throw under Jest.
 * service_worker/background.js (an ES module) consumes this file via a
 * side-effect `import './dnr.js'` and then reads `globalThis.TurboMockDnr`,
 * exactly like the G1 shared modules are consumed from the MAIN-world
 * content script via `window.TurboMockMatcher` etc.
 */
(function (global) {
    'use strict';

    const DNR_TYPES = ['headers', 'queryparams'];

    /**
     * Build a DNR `condition` object from a rule's match block.
     * - url wrapped in /.../ -> regexFilter (slashes stripped)
     * - otherwise (wildcard or substring pattern) -> urlFilter, as-is
     * - method other than '*' -> requestMethods: [lowercase method]
     */
    function buildCondition(match) {
        const condition = {};
        const pattern = match && match.url;

        if (pattern) {
            if (pattern.startsWith('/') && pattern.endsWith('/')) {
                condition.regexFilter = pattern.slice(1, -1);
            } else {
                condition.urlFilter = pattern;
            }
            // Match the interceptor's case-insensitive URL matching so the same
            // pattern behaves the same whether it lands on the DNR layer or the
            // fetch/XHR layer.
            condition.isUrlFilterCaseSensitive = false;
        }

        const method = ((match && match.method) || '*').toUpperCase();
        if (method !== '*') {
            condition.requestMethods = [method.toLowerCase()];
        }

        return condition;
    }

    function mapHeaderOp(op) {
        if (op.op === 'remove') {
            return { header: op.name, operation: 'remove' };
        }
        return { header: op.name, operation: 'set', value: op.value };
    }

    /**
     * Build the `action` object for a 'headers' rule: modifyHeaders with
     * requestHeaders/responseHeaders arrays. Empty arrays are omitted.
     */
    function buildHeadersAction(rule) {
        const mod = rule.headersMod || {};
        const action = { type: 'modifyHeaders' };

        const requestHeaders = (mod.request || []).map(mapHeaderOp);
        const responseHeaders = (mod.response || []).map(mapHeaderOp);

        if (requestHeaders.length > 0) action.requestHeaders = requestHeaders;
        if (responseHeaders.length > 0) action.responseHeaders = responseHeaders;

        return action;
    }

    /**
     * Build the `action` object for a 'queryparams' rule: a redirect action
     * with a queryTransform.
     */
    function buildQueryParamsAction(rule) {
        const qp = rule.queryParams || {};
        return {
            type: 'redirect',
            redirect: {
                transform: {
                    queryTransform: {
                        addOrReplaceParams: (qp.add || []).map((p) => ({ key: p.key, value: p.value })),
                        removeParams: qp.remove || []
                    }
                }
            }
        };
    }

    /**
     * Pure mapping: one v2 rule of type 'headers'/'queryparams' -> one DNR
     * dynamic rule object. Returns null for non-DNR-backed types or rules
     * without an allocated dnrRuleId (DNR ids must be positive integers).
     */
    function ruleToDnr(rule) {
        if (!rule || DNR_TYPES.indexOf(rule.type) === -1 || !rule.dnrRuleId) {
            return null;
        }

        const condition = buildCondition(rule.match || {});
        const action = rule.type === 'headers' ? buildHeadersAction(rule) : buildQueryParamsAction(rule);

        return {
            id: rule.dnrRuleId,
            priority: 1,
            condition,
            action
        };
    }

    /**
     * Diff the desired DNR ruleset (enabled headers/queryparams rules, only
     * when the extension isActive) against chrome.declarativeNetRequest's
     * current dynamic rules and issue one full-replace updateDynamicRules
     * call. Idempotent; safe to call after every rules/active mutation.
     */
    async function syncDnrRules(rules, isActive) {
        try {
            const desired = isActive
                ? (rules || [])
                    .filter((rule) => rule && rule.enabled && DNR_TYPES.indexOf(rule.type) !== -1)
                    .map(ruleToDnr)
                    .filter(Boolean)
                : [];

            const current = await chrome.declarativeNetRequest.getDynamicRules();
            const removeRuleIds = current.map((r) => r.id);

            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds,
                addRules: desired
            });
        } catch (error) {
            console.error('Failed to sync DNR rules:', error);
        }
    }

    const api = { ruleToDnr, syncDnrRules };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.TurboMockDnr = api;
})(typeof window !== 'undefined' ? window : globalThis);
