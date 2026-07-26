/**
 * SpliceTap DNR (declarativeNetRequest) sync.
 * Maps v2 'headers' / 'queryparams' rules to chrome.declarativeNetRequest
 * dynamic rules and keeps the DNR ruleset in sync with stored rules.
 *
 * Module-loading note: written UMD-only (no top-level ESM `export`) because
 * this repo's Jest has no ESM transform (see src/index.js's require-based
 * workaround for the same constraint on utils.js/storage.js in G1) -- a
 * top-level `export function` here would make `require()` throw under Jest.
 * service_worker/background.js (an ES module) consumes this file via a
 * side-effect `import './dnr.js'` and then reads `globalThis.SpliceTapDnr`,
 * exactly like the G1 shared modules are consumed from the MAIN-world
 * content script via `window.SpliceTapMatcher` etc.
 */
(function (global) {
    'use strict';

    const DNR_TYPES = ['headers', 'queryparams'];

    // S-3: header names a 'headers' rule must never be allowed to touch. All of
    // these are browser/network security controls; letting an imported rule
    // set or remove them would let one JSON file strip CSP/HSTS/frame
    // protections or force a permissive, credentialed CORS policy on every
    // site the rule's URL pattern matches. Checked case-insensitively.
    const FORBIDDEN_HEADER_NAMES = new Set([
        'content-security-policy',
        'content-security-policy-report-only',
        'strict-transport-security',
        'x-frame-options',
        'x-content-type-options',
        'cross-origin-opener-policy',
        'cross-origin-embedder-policy',
        'cross-origin-resource-policy',
        'set-cookie',
        'cookie',
        'permissions-policy'
    ]);

    /**
     * Validate a rule's headersMod against the denylist. Returns
     * { valid, errors } — errors is a list of human-readable messages,
     * suitable for surfacing back to whoever is saving/importing the rule.
     */
    function validateHeadersMod(headersMod) {
        const errors = [];
        const mod = headersMod || {};
        const allOps = [].concat(mod.request || [], mod.response || []);

        for (const op of allOps) {
            const name = op && op.name ? String(op.name).toLowerCase() : '';
            if (FORBIDDEN_HEADER_NAMES.has(name)) {
                errors.push(`Header "${op.name}" cannot be modified — it is a security-sensitive header.`);
            }
            // Forcing a wildcard, credentialed CORS response is a common
            // real-world foot-gun (browsers reject it at fetch time anyway,
            // but it's worth flagging at save time rather than silently
            // shipping a rule that can never actually work as intended).
            if (name === 'access-control-allow-origin' && op.op === 'set' && op.value === '*') {
                const hasCredentialsTrue = allOps.some((o) =>
                    o !== op &&
                    o.name && String(o.name).toLowerCase() === 'access-control-allow-credentials' &&
                    o.op === 'set' && String(o.value).toLowerCase() === 'true'
                );
                if (hasCredentialsTrue) {
                    errors.push('Access-Control-Allow-Origin: * cannot be combined with Access-Control-Allow-Credentials: true.');
                }
            }
        }

        return { valid: errors.length === 0, errors };
    }

    /**
     * Build a DNR `condition` object from a rule's match block.
     * - url wrapped in /.../ -> regexFilter (slashes stripped)
     * - otherwise (wildcard or substring pattern) -> urlFilter, as-is
     * - method other than '*' -> requestMethods: [lowercase method]
     * - resourceTypes scoped to xmlhttprequest/fetch traffic ('other' covers
     *   fetch() in Chrome's classification) so a headers/queryparams rule
     *   only ever touches API-style requests, never the page's own document,
     *   script, or image loads (C-11) — narrower blast radius, and it also
     *   matches what this product is actually for (mocking/modifying API
     *   calls, not general page resources).
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

        condition.resourceTypes = ['xmlhttprequest', 'other'];

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
     * Forbidden header ops are dropped even if validation was somehow
     * bypassed upstream (S-3 defense in depth) — this function only ever
     * emits a DNR action, so it's the last line of defense before the browser
     * actually applies the change.
     */
    function buildHeadersAction(rule) {
        const mod = rule.headersMod || {};
        const action = { type: 'modifyHeaders' };

        const isAllowed = (op) => op && op.name && !FORBIDDEN_HEADER_NAMES.has(String(op.name).toLowerCase());

        const requestHeaders = (mod.request || []).filter(isAllowed).map(mapHeaderOp);
        const responseHeaders = (mod.response || []).filter(isAllowed).map(mapHeaderOp);

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
     *
     * Returns { success, error?, skipped? } instead of swallowing every
     * failure silently (C-10) — callers can surface `error`/`skipped` back to
     * the user (e.g. "N rules exceeded the DNR quota and were not applied")
     * rather than a rule that silently never took effect.
     */
    async function syncDnrRules(rules, isActive) {
        try {
            const desired = isActive
                ? (rules || [])
                    .filter((rule) => rule && rule.enabled && DNR_TYPES.indexOf(rule.type) !== -1)
                    .map(ruleToDnr)
                    .filter(Boolean)
                : [];

            // C-10: Chrome caps the number of dynamic (+ session) rules an
            // extension may register. Exceeding it makes the whole
            // updateDynamicRules call reject, which — before this check —
            // meant EVERY DNR-backed rule silently stopped working the moment
            // the count crept over the limit, with only a console.error to
            // show for it. Truncate to the documented cap and report how many
            // were dropped instead.
            const maxRules = (typeof chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES === 'number')
                ? chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES
                : 5000; // conservative fallback for older Chrome versions without this constant
            let skipped = 0;
            let finalDesired = desired;
            if (desired.length > maxRules) {
                skipped = desired.length - maxRules;
                finalDesired = desired.slice(0, maxRules);
            }

            const current = await chrome.declarativeNetRequest.getDynamicRules();

            // C-16: skip the update entirely when the desired ruleset is
            // already what's registered — avoids a full remove+re-add on
            // every single service-worker cold start (which otherwise pays
            // this cost even when nothing about the rules actually changed
            // since the last time this ran).
            if (rulesetsEqual(current, finalDesired)) {
                return { success: true, skipped };
            }

            const removeRuleIds = current.map((r) => r.id);

            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds,
                addRules: finalDesired
            });

            return { success: true, skipped };
        } catch (error) {
            console.error('Failed to sync DNR rules:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Cheap structural-equality check between the DNR API's current dynamic
     * rules and the freshly computed desired set, so syncDnrRules can skip a
     * no-op remove+re-add (C-16). Order-independent; compares by rule id.
     */
    function rulesetsEqual(current, desired) {
        if (current.length !== desired.length) return false;
        const byId = new Map(current.map((r) => [r.id, r]));
        for (const rule of desired) {
            const existing = byId.get(rule.id);
            if (!existing) return false;
            if (JSON.stringify(existing) !== JSON.stringify(rule)) return false;
        }
        return true;
    }

    const api = { ruleToDnr, syncDnrRules, validateHeadersMod, FORBIDDEN_HEADER_NAMES };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapDnr = api;
})(typeof window !== 'undefined' ? window : globalThis);
