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

    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    /**
     * PER-21: the URL part of a condition, matching the URLs the interceptor
     * (src/matcher.js) matches for the same pattern.
     *
     * The pattern used to be passed as an unanchored urlFilter, so a pattern
     * ending in `/echo` also matched `/echo/sub` and `/echo?x=1` for header
     * and query-param rules but not for any other rule type. The
     * interceptor's rules:
     *   - `/.../` is a regex;
     *   - a pattern with `*` is a full, case-insensitive match (so it is
     *     anchored at whichever end has no `*`);
     *   - anything else is a substring.
     * urlFilter treats `|` and `^` as syntax, so a pattern containing either
     * becomes an equivalent regexFilter. So does a `*` pattern starting with
     * `/`: the interceptor matches it against the page's relative URL, and
     * the closest the network layer can come is anchoring it at the path.
     */
    function urlCondition(pattern) {
        if (pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
            return { regexFilter: pattern.slice(1, -1) };
        }

        const special = /[|^]/.test(pattern);
        if (!pattern.includes('*')) {
            return special ? { regexFilter: escapeRegex(pattern) } : { urlFilter: pattern };
        }

        const openLeft = pattern.startsWith('*');
        const openRight = pattern.endsWith('*');
        const fromPath = !openLeft && pattern.startsWith('/');
        if (!special && !fromPath) {
            return { urlFilter: (openLeft ? '' : '|') + pattern + (openRight ? '' : '|') };
        }

        const body = pattern.split('*').map(escapeRegex).join('.*')
            .replace(/^(\.\*)+/, '')
            .replace(/(\.\*)+$/, '');
        let start = openLeft ? '' : '^';
        if (pattern.startsWith('//')) start = '^[^:/?#]+:'; // scheme-relative
        else if (fromPath) start = '^[^:/?#]+://[^/?#]*'; // after scheme and host
        return { regexFilter: start + body + (openRight ? '' : '$') };
    }

    /**
     * Build a DNR `condition` object from a rule's match block.
     * - url -> urlFilter or regexFilter, see urlCondition (PER-21)
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
            Object.assign(condition, urlCondition(pattern));
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

    // PER-33: DNR rules Chrome has already refused, keyed by their exact JSON,
    // persisted in chrome.storage.session. A refused rule is excluded up front
    // on later syncs instead of being retried — which would otherwise re-run
    // the isolation pass below on every save. This used to be a module-level
    // Map, lost each time the worker idled out, so every wake redid the
    // isolation. Session storage lasts the browser session, is not readable
    // from content scripts, and editing the rule changes its JSON, so the
    // fixed version is tried. The Map is only a fallback for when session
    // storage is unavailable.
    const REJECTED_KEY = 'spliceTapDnrRejected';
    let rejectedFallback = new Map();

    async function loadKnownRejected() {
        try {
            const stored = (await chrome.storage.session.get(REJECTED_KEY))[REJECTED_KEY];
            return new Map(stored && typeof stored === 'object' ? Object.entries(stored) : []);
        } catch (error) {
            return new Map(rejectedFallback);
        }
    }

    async function saveKnownRejected(known) {
        rejectedFallback = new Map(known);
        try {
            await chrome.storage.session.set({ [REJECTED_KEY]: Object.fromEntries(known) });
        } catch (error) {
            // Kept in memory for this worker's lifetime instead.
        }
    }

    const messageOf = (error) => String((error && error.message) || error);

    // Syncs run one at a time. Two that diff against the same registered set
    // would both add the same ids, and the loser's "does not have a unique ID"
    // would be misread as Chrome refusing a rule.
    let syncChain = Promise.resolve();

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
     * rejected batch is isolated (see applyIsolating), every acceptable rule
     * is applied, and the refused ones are reported by name.
     */
    function syncDnrRules(rules, isActive) {
        const run = syncChain.then(() => syncOnce(rules, isActive));
        syncChain = run.catch(() => undefined);
        return run;
    }

    async function syncOnce(rules, isActive) {
        try {
            const dnrApi = chrome.declarativeNetRequest;
            const candidates = isActive
                ? (rules || []).filter((rule) => rule && rule.enabled && DNR_TYPES.indexOf(rule.type) !== -1)
                : [];

            const known = await loadKnownRejected();
            const stillKnown = new Map(); // pruned to rules that still exist
            const rejected = [];
            const reject = (rule, error) => rejected.push({ id: rule.id, name: rule.name, error });
            const ids = new Set();
            let entries = [];
            for (const rule of candidates) {
                const dnr = ruleToDnr(rule);
                if (!dnr) continue;
                const signature = JSON.stringify(dnr);
                if (known.has(signature)) {
                    stillKnown.set(signature, known.get(signature));
                    reject(rule, known.get(signature));
                    continue;
                }
                // Chrome refuses the whole call over a repeated id; name the
                // rule instead of paying for an isolation pass to find it.
                if (ids.has(dnr.id)) {
                    reject(rule, 'it shares its network rule id with another rule — edit and save it again');
                    continue;
                }
                ids.add(dnr.id);
                entries.push({ rule, dnr, signature });
            }

            // C-10: Chrome caps the number of dynamic (+ session) rules an
            // extension may register; exceeding it rejects the whole call.
            // Truncate to the documented cap and report how many were dropped.
            const maxRules = (typeof dnrApi.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES === 'number')
                ? dnrApi.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES
                : 5000; // conservative fallback for older Chrome versions without this constant
            let skipped = 0;
            if (entries.length > maxRules) {
                skipped = entries.length - maxRules;
                entries = entries.slice(0, maxRules);
            }

            // PER-33: regex rules have their own, lower cap. Past it every
            // further regex rule fails, which isolation would discover one call
            // at a time (1005 regex rules took 1007 calls, 15 s).
            const maxRegex = (typeof dnrApi.MAX_NUMBER_OF_REGEX_RULES === 'number')
                ? dnrApi.MAX_NUMBER_OF_REGEX_RULES
                : 1000;
            let regexCount = 0;
            entries = entries.filter((entry) => {
                if (entry.dnr.condition.regexFilter === undefined || ++regexCount <= maxRegex) return true;
                reject(entry.rule, `Chrome allows at most ${maxRegex} regex-based network rules`);
                return false;
            });

            // C-16 / PER-37: only what differs is touched. A rule already
            // registered exactly as desired is left alone — so a sync after
            // every save or wake costs one getDynamicRules, and no acceptable
            // rule is ever unregistered while a refused one is isolated.
            const current = await dnrApi.getDynamicRules();
            const currentById = new Map(current.map((r) => [r.id, r]));
            const desiredIds = new Set(entries.map((e) => e.dnr.id));
            const gone = current.filter((r) => !desiredIds.has(r.id)).map((r) => r.id);
            const units = [];
            for (const entry of entries) {
                const existing = currentById.get(entry.dnr.id);
                if (existing && dnrRuleEqual(existing, entry.dnr)) continue;
                units.push({ entry, replaces: !!existing });
            }

            if (gone.length || units.length) {
                const refused = await applyIsolating(dnrApi, gone, units);
                for (const { unit, message } of refused.list) {
                    reject(unit.entry.rule, message);
                    if (refused.persist) stillKnown.set(unit.entry.signature, message);
                }
            }

            if (stillKnown.size !== known.size || [...stillKnown.keys()].some((k) => !known.has(k))) {
                await saveKnownRejected(stillKnown);
            }
            return result(skipped, rejected);
        } catch (error) {
            console.error('Failed to sync DNR rules:', error);
            return { success: false, skipped: 0, rejected: [], error: error.message };
        }
    }

    /**
     * Apply removals and additions, isolating any rule Chrome refuses.
     * Returns { list: [{ unit, message }], persist }.
     *
     * PER-33: on a refusal this used to clear every registered rule, then add
     * the rules back one call each — so the network rules vanished for the
     * duration (14 of 300 still registered mid-way) and N rules cost N calls.
     * Now, after a failed batch:
     *   1. regex rules are checked with isRegexSupported, which is cheap and
     *      names the usual culprit without an update call;
     *   2. rules that are gone are removed (removal cannot be refused);
     *   3. the rest is bisected: a half that Chrome accepts is registered,
     *      and a half that fails is split again — about 2·log2(N) calls per
     *      refused rule. Unchanged rules are never in play, so they stay
     *      registered throughout;
     *   4. a changed rule whose new version is refused has its old version
     *      withdrawn last, as a single removal.
     */
    async function applyIsolating(dnrApi, gone, units) {
        const replacedIds = (list) => list.filter((u) => u.replaces).map((u) => u.entry.dnr.id);
        const apply = (list, removeRuleIds = []) => dnrApi.updateDynamicRules({
            removeRuleIds: removeRuleIds.concat(replacedIds(list)),
            addRules: list.map((u) => u.entry.dnr)
        });

        try {
            await apply(units, gone);
            return { list: [], persist: false };
        } catch (batchError) {
            const refused = [];
            let remaining = units;

            if (typeof dnrApi.isRegexSupported === 'function') {
                const supported = await Promise.all(remaining.map(async (unit) => {
                    const condition = unit.entry.dnr.condition;
                    if (condition.regexFilter === undefined) return true;
                    try {
                        const answer = await dnrApi.isRegexSupported({
                            regex: condition.regexFilter,
                            isCaseSensitive: !!condition.isUrlFilterCaseSensitive
                        });
                        if (answer && answer.isSupported === false) {
                            refused.push({ unit, message: `Chrome's network rules cannot run its regex (${answer.reason || 'unsupported'})` });
                            return false;
                        }
                    } catch (error) {
                        // Unknown: leave it to the bisection.
                    }
                    return true;
                }));
                remaining = remaining.filter((unit, i) => supported[i]);
            }

            if (gone.length) await dnrApi.updateDynamicRules({ removeRuleIds: gone });

            const bisect = async (list, knownToFail) => {
                if (list.length === 0) return true;
                if (!knownToFail || list.length === 1) {
                    try {
                        await apply(list);
                        return true;
                    } catch (error) {
                        if (list.length === 1) {
                            refused.push({ unit: list[0], message: messageOf(error) });
                            return false;
                        }
                    }
                }
                const mid = Math.ceil(list.length / 2);
                const leftApplied = await bisect(list.slice(0, mid), false);
                // The whole list fails and its left half went in, so the
                // right half is known to fail: split it without trying it.
                await bisect(list.slice(mid), leftApplied);
                return false;
            };
            // Unchanged from the failed batch unless the regex check removed
            // something, in which case it may now go in whole.
            await bisect(remaining, remaining.length === units.length);

            const stale = replacedIds(refused.map((r) => r.unit));
            if (stale.length) await dnrApi.updateDynamicRules({ removeRuleIds: stale });

            // Remember refusals for later syncs — unless every rule was
            // refused, which says more about the call than about the rules
            // (and would otherwise switch them all off for the session).
            const persist = refused.length > 0 && (refused.length < units.length || units.length === 1);
            return { list: refused, persist };
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
     * Is a registered DNR rule (as getDynamicRules returns it) the rule we
     * would register now?
     *
     * PER-37: this compared JSON.stringify output, which is key-order
     * sensitive. Chrome returns every object with its keys sorted, so the
     * comparison never matched, and every save and every worker wake
     * re-registered all network rules (PERF-10 reopened). It also ignored
     * condition.regexFilter, so a regex edit could have been skipped as
     * "unchanged" once the order was fixed. The whole rule is compared now,
     * structurally.
     */
    function dnrRuleEqual(a, b) {
        return !!a && !!b && a.id === b.id && a.priority === b.priority
            && deepEqual(a.condition || {}, b.condition || {})
            && deepEqual(a.action || {}, b.action || {});
    }

    /**
     * Structural equality for JSON-shaped values. Object key order is ignored
     * and a key holding `undefined` counts as absent (it would not survive a
     * message or storage round trip); array order is significant.
     */
    function deepEqual(a, b) {
        if (a === b) return true;
        if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        if (Array.isArray(a)) {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                if (!deepEqual(a[i], b[i])) return false;
            }
            return true;
        }
        const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
        const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
        if (keysA.length !== keysB.length) return false;
        for (const key of keysA) {
            if (!deepEqual(a[key], b[key])) return false;
        }
        return true;
    }

    const api = { ruleToDnr, syncDnrRules, dnrRuleEqual, validateHeadersMod, FORBIDDEN_HEADER_NAMES, deepEqual };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapDnr = api;
})(typeof window !== 'undefined' ? window : globalThis);
