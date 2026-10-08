/**
 * SpliceTap DNR (declarativeNetRequest) sync.
 * Maps v2 'headers' / 'queryparams' rules to chrome.declarativeNetRequest
 * dynamic rules and keeps the DNR ruleset in sync with stored rules.
 *
 * Module-loading note: written UMD-only (no top-level ESM `export`) because
 * this repo's Jest has no ESM transform (see src/index.js's require-based
 * workaround for the same constraint on storage.js) -- a
 * top-level `export function` here would make `require()` throw under Jest.
 * service_worker/background.js (an ES module) consumes this file via a
 * side-effect `import './dnr.js'` and then reads `globalThis.SpliceTapDnr`,
 * exactly like the G1 shared modules are consumed from the MAIN-world
 * content script via `window.SpliceTapMatcher` etc.
 */
(function (global) {
    'use strict';

    const DNR_TYPES = ['headers', 'queryparams'];

    // S-3's forbidden-header list and the header-op validator now live in
    // src/rule-schema.js, shared with the editors and the save boundary. They
    // are re-exported below so existing callers keep working, and this file
    // still applies the list itself as the last line of defence before the
    // browser (see buildHeadersAction).
    const schema = global.SpliceTapRuleSchema
        || (typeof require === 'function' ? require('../src/rule-schema.js') : null);
    const FORBIDDEN_HEADER_NAMES = schema.FORBIDDEN_HEADER_NAMES;
    const validateHeadersMod = schema.validateHeadersMod;

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

    // Anything but a well-formed set/remove is dropped rather than coerced:
    // an unknown op used to be mapped to 'set', and a 'set' without a value is
    // a rule Chrome rejects. The save boundary rejects both now; this keeps a
    // rule stored before that from reaching the browser malformed.
    const isApplicableOp = (op) => op && typeof op.name === 'string' && op.name
        && !FORBIDDEN_HEADER_NAMES.has(op.name.toLowerCase())
        && (op.op === 'remove' || (op.op === 'set' && typeof op.value === 'string'));

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

        const requestHeaders = (Array.isArray(mod.request) ? mod.request : []).filter(isApplicableOp).map(mapHeaderOp);
        const responseHeaders = (Array.isArray(mod.response) ? mod.response : []).filter(isApplicableOp).map(mapHeaderOp);

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

    // DNR rules Chrome has already refused, keyed by their exact JSON. A
    // refused rule is excluded up front on later syncs instead of being
    // retried — which would otherwise re-run the isolation pass below on every
    // save. Editing the rule changes its JSON, so the fixed version is tried.
    const knownRejected = new Map();

    /**
     * Diff the desired DNR ruleset (enabled headers/queryparams rules, only
     * when the extension isActive) against chrome.declarativeNetRequest's
     * current dynamic rules and apply the difference. Idempotent; safe to
     * call after every rules/active mutation.
     *
     * Returns { success, skipped, rejected, error? }. `rejected` lists the
     * rules Chrome refused — [{ id, name, error }] — so callers can tell the
     * user which rule is not being applied (C-10, CQ-3).
     *
     * One bad rule must not freeze the rest. updateDynamicRules is atomic: if
     * Chrome rejects any rule in the batch it applies none of the change, and
     * the previous ruleset stays registered. Before this, a single malformed
     * rule (imported, or stored before the save boundary checked op shape)
     * froze the network layer at its old state — verified headless: disabling
     * a rule then reported success, the popup showed it off, and it kept
     * rewriting real traffic, while newly added rules never applied. Now a
     * rejected batch is retried one rule at a time, every acceptable rule is
     * applied, and the refused ones are reported by name.
     */
    async function syncDnrRules(rules, isActive) {
        try {
            const candidates = isActive
                ? (rules || []).filter((rule) => rule && rule.enabled && DNR_TYPES.indexOf(rule.type) !== -1)
                : [];

            const rejected = [];
            let entries = [];
            for (const rule of candidates) {
                const dnr = ruleToDnr(rule);
                if (!dnr) continue;
                const signature = JSON.stringify(dnr);
                if (knownRejected.has(signature)) {
                    rejected.push({ id: rule.id, name: rule.name, error: knownRejected.get(signature) });
                    continue;
                }
                entries.push({ rule, dnr, signature });
            }

            // C-10: Chrome caps the number of dynamic (+ session) rules an
            // extension may register; exceeding it rejects the whole call.
            // Truncate to the documented cap and report how many were dropped.
            const maxRules = (typeof chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES === 'number')
                ? chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES
                : 5000; // conservative fallback for older Chrome versions without this constant
            let skipped = 0;
            if (entries.length > maxRules) {
                skipped = entries.length - maxRules;
                entries = entries.slice(0, maxRules);
            }

            const desired = entries.map((e) => e.dnr);
            const current = await chrome.declarativeNetRequest.getDynamicRules();

            // C-16: skip the update entirely when the desired ruleset is
            // already what's registered — avoids a remove+re-add on every
            // service-worker cold start.
            if (rulesetsEqual(current, desired)) {
                return result(skipped, rejected);
            }

            const removeRuleIds = current.map((r) => r.id);
            try {
                await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: desired });
                return result(skipped, rejected);
            } catch (batchError) {
                // Isolate the rule(s) Chrome refuses: clear, then add one at a
                // time. Only runs on the failure path, and refused rules are
                // remembered, so a later sync goes back to one batched call.
                await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
                for (const entry of entries) {
                    try {
                        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [entry.dnr] });
                    } catch (error) {
                        const message = String((error && error.message) || error);
                        knownRejected.set(entry.signature, message);
                        rejected.push({ id: entry.rule.id, name: entry.rule.name, error: message });
                    }
                }
                return result(skipped, rejected);
            }
        } catch (error) {
            console.error('Failed to sync DNR rules:', error);
            return { success: false, skipped: 0, rejected: [], error: error.message };
        }
    }

    function result(skipped, rejected) {
        if (rejected.length === 0) return { success: true, skipped, rejected };
        const names = rejected.map((r) => `"${r.name || r.id}"`).join(', ');
        const noun = rejected.length === 1 ? 'rule was' : 'rules were';
        // Everything else was applied; this names what was not, and why.
        return {
            success: false,
            skipped,
            rejected,
            error: `${rejected.length} ${noun} refused by Chrome and is not being applied: ${names} — ${rejected[0].error}`
        };
    }

    /**
     * Cheap structural-equality check between the DNR API's current dynamic
     * rules and the freshly computed desired set, so syncDnrRules can skip a
     * no-op remove+re-add (C-16). Order-independent; compares by rule id.
     */
    /**
     * PERF-10: compare the fields a DNR rule is actually made of, rather than
     * JSON.stringify-ing both sides per rule.
     *
     * Beyond the allocation, stringify comparison is also wrong in principle
     * here — it treats key order as significant, so two structurally identical
     * rules built in different order would compare unequal and trigger a
     * pointless updateDynamicRules call.
     */
    function dnrRuleEqual(a, b) {
        if (a.id !== b.id || a.priority !== b.priority) return false;

        const ac = a.condition || {};
        const bc = b.condition || {};
        if (ac.urlFilter !== bc.urlFilter) return false;
        if (ac.isUrlFilterCaseSensitive !== bc.isUrlFilterCaseSensitive) return false;
        if (String(ac.resourceTypes) !== String(bc.resourceTypes)) return false;
        if (String(ac.requestMethods) !== String(bc.requestMethods)) return false;

        // The action holds header/query-param lists whose shape varies by rule
        // type; comparing it structurally would mean re-encoding the DNR schema
        // here, so this one part stays a serialized comparison.
        return JSON.stringify(a.action) === JSON.stringify(b.action);
    }

    function rulesetsEqual(current, desired) {
        if (current.length !== desired.length) return false;
        const byId = new Map(current.map((r) => [r.id, r]));
        for (const rule of desired) {
            const existing = byId.get(rule.id);
            if (!existing) return false;
            if (!dnrRuleEqual(existing, rule)) return false;
        }
        return true;
    }

    const api = { ruleToDnr, syncDnrRules, validateHeadersMod, FORBIDDEN_HEADER_NAMES };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapDnr = api;
})(typeof window !== 'undefined' ? window : globalThis);
