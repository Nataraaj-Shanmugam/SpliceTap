/**
 * SpliceTap DNR (declarativeNetRequest) sync.
 * Maps v2 'headers' / 'queryparams' rules, and redirect / block rules with
 * appliesTo:'all' (F1), to chrome.declarativeNetRequest dynamic rules and
 * keeps the DNR ruleset in sync with stored rules.
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

    // F1: redirect and block rules marked appliesTo:'all' also reach page
    // resources (scripts, images, documents…) through DNR. fetch/XHR stay
    // with the interceptor, so `xmlhttprequest` is left out and no request
    // is handled twice.
    const NETWORK_TYPES = ['redirect', 'block'];
    const ALL_RESOURCE_TYPES = [
        'main_frame', 'sub_frame', 'script', 'stylesheet', 'image', 'font', 'media', 'object',
        'ping', 'csp_report', 'websocket', 'webtransport', 'webbundle', 'other'
    ];
    // C-11: what headers/queryparams rules reach ('other' covers some fetches).
    const API_RESOURCE_TYPES = ['xmlhttprequest', 'other'];
    // F1: earlier rules win, as in the interceptor's first-match.
    const NETWORK_PRIORITY_BASE = 100000;

    // B2-F7: match.resourceTypes names -> Chrome's resource types.
    const RESOURCE_TYPE_MAP = {
        'fetch-xhr': ['xmlhttprequest'],
        document: ['main_frame'],
        subdocument: ['sub_frame'],
        script: ['script'],
        stylesheet: ['stylesheet'],
        image: ['image'],
        font: ['font'],
        media: ['media'],
        websocket: ['websocket'],
        ping: ['ping'],
        other: ['other', 'object', 'csp_report', 'webtransport', 'webbundle']
    };
    // B2-F7: emitted in one fixed order, whatever order the rule lists them
    // in, so a rule compiles to the same DNR rule every time (PER-37).
    const CANONICAL_RESOURCE_TYPES = ['xmlhttprequest'].concat(ALL_RESOURCE_TYPES);

    /**
     * B2-F7: the DNR resource types for a rule. Absent match.resourceTypes
     * keeps today's defaults: every type for an appliesTo:'all' rule, API
     * traffic for headers/queryparams. An appliesTo:'all' rule never gets
     * xmlhttprequest: 'fetch-xhr' in its list means the interceptor handles
     * fetch/XHR, never DNR (no request is handled twice). May be empty — the
     * rule then has nothing for DNR to do.
     */
    function dnrResourceTypes(match, networkRule) {
        const wanted = match ? match.resourceTypes : undefined;
        if (wanted === undefined) return (networkRule ? ALL_RESOURCE_TYPES : API_RESOURCE_TYPES).slice();
        // Absent is undefined only, as the schema has it: null or any other
        // non-list names no type, so the rule compiles to nothing.
        if (!Array.isArray(wanted)) return [];
        // A Set: 'other' expands to several, and Chrome refuses a repeated
        // type (taking the whole batch with it).
        const chosen = new Set();
        for (const type of wanted) {
            if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(RESOURCE_TYPE_MAP, type)) continue;
            for (const dnrType of RESOURCE_TYPE_MAP[type]) chosen.add(dnrType);
        }
        if (networkRule) chosen.delete('xmlhttprequest');
        return CANONICAL_RESOURCE_TYPES.filter((type) => chosen.has(type));
    }

    /**
     * B2-F7: match.pageDomains -> initiatorDomains (the page or frame making
     * the request; a name covers its subdomains, as in DNR). Returns
     * undefined when absent (undefined only, as the schema has it), and null
     * when present but holding no usable name — null included — since
     * compiling that without the condition would widen the rule.
     */
    function initiatorDomains(match) {
        const domains = match ? match.pageDomains : undefined;
        if (domains === undefined) return undefined;
        if (!Array.isArray(domains)) return null;
        const names = [];
        for (const name of domains) {
            if (typeof name !== 'string' || !name.trim()) continue;
            const lower = name.trim().toLowerCase();
            if (!names.includes(lower)) names.push(lower);
        }
        return names.length ? names : null;
    }

    const isNetworkRule = (rule) => !!rule && NETWORK_TYPES.indexOf(rule.type) !== -1 && rule.appliesTo === 'all';

    /** Does this rule compile to a DNR rule (and so need a dnrRuleId)? */
    const isDnrRule = (rule) => !!rule && (DNR_TYPES.indexOf(rule.type) !== -1 || isNetworkRule(rule));

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
     *   calls, not general page resources). F1: appliesTo:'all' rules pass
     *   ALL_RESOURCE_TYPES instead. B2-F7: match.resourceTypes narrows either
     *   (see dnrResourceTypes).
     * - B2-F7: match.pageDomains -> initiatorDomains
     */
    function buildCondition(match, resourceTypes = API_RESOURCE_TYPES) {
        const condition = {};
        const pattern = match && match.url;
        const domains = initiatorDomains(match);
        if (domains) condition.initiatorDomains = domains;

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

        condition.resourceTypes = resourceTypes.slice();

        return condition;
    }

    const isRegexPattern = (pattern) => typeof pattern === 'string' && pattern.length >= 2
        && pattern.startsWith('/') && pattern.endsWith('/');

    // Capture groups in a regex body, or Infinity when JS cannot compile it
    // (RE2 syntax JS lacks): Chrome then judges the substitution itself.
    function captureGroupCount(body) {
        try {
            return new RegExp(body + '|').exec('').length - 1;
        } catch (error) {
            return Infinity;
        }
    }

    /**
     * F1: a destination with $1-$9 as an RE2 rewrite string. As in the
     * interceptor (computeRedirectUrl), $0 and references past the last group
     * stay literal; a literal backslash must be doubled for RE2.
     */
    function toRegexSubstitution(destination, groups) {
        let out = '';
        for (let i = 0; i < destination.length; i++) {
            const c = destination[i];
            const digit = destination[i + 1];
            if (c === '\\') {
                out += '\\\\';
            } else if (c === '$' && digit >= '1' && digit <= '9' && Number(digit) <= groups) {
                out += '\\' + digit;
                i++;
            } else {
                out += c;
            }
        }
        return out;
    }

    /**
     * F1: an appliesTo:'all' redirect or block rule -> its DNR action and
     * condition, or null when DNR cannot express it faithfully.
     */
    function buildNetworkRule(rule, resourceTypes) {
        const match = rule.match || {};
        // DNR has no header or GraphQL conditions. Compiling without them
        // would redirect or block more than the rule says, so such a rule
        // stays with the interceptor.
        const hasHeaders = match.headers && typeof match.headers === 'object' && Object.keys(match.headers).length > 0;
        if (hasHeaders || (match.graphql && match.graphql.operationName)) return null;

        const condition = buildCondition(match, resourceTypes);
        if (rule.type === 'block') return { condition, action: { type: 'block' } };

        const destination = rule.redirect && rule.redirect.destination;
        // A root-relative destination has no meaning for an arbitrary
        // resource; the schema requires a full URL for these rules.
        if (typeof destination !== 'string' || !/^https?:\/\/[^/?#\\]/i.test(destination)) return null;

        if (isRegexPattern(match.url) && /\$[1-9]/.test(destination)) {
            const body = match.url.slice(1, -1);
            // regexSubstitution replaces only the matched part of the URL;
            // the interceptor replaces the whole URL (PER-9). Matching the
            // whole URL around the pattern gives the same result. A
            // non-capturing group keeps the rule's group numbers.
            condition.regexFilter = '^.*?(?:' + body + ').*$';
            return {
                condition,
                action: { type: 'redirect', redirect: { regexSubstitution: toRegexSubstitution(destination, captureGroupCount(body)) } }
            };
        }
        return { condition, action: { type: 'redirect', redirect: { url: destination } } };
    }

    function mapHeaderOp(op) {
        if (op.op === 'remove') {
            return { header: op.name, operation: 'remove' };
        }
        // B2-F9: 'append' adds a value alongside any the server sent.
        return { header: op.name, operation: op.op === 'append' ? 'append' : 'set', value: op.value };
    }

    // Anything but a well-formed set/remove is dropped rather than coerced:
    // an unknown op used to be mapped to 'set', and a 'set' without a value is
    // a rule Chrome rejects. The save boundary rejects both now; this keeps a
    // rule stored before that from reaching the browser malformed.
    // B2-F9: 'append' too, on the response side only — Chrome 120 cannot
    // append request headers.
    const isApplicableOp = (op, side) => op && typeof op.name === 'string' && op.name
        && !FORBIDDEN_HEADER_NAMES.has(op.name.toLowerCase())
        && (op.op === 'remove'
            || ((op.op === 'set' || (op.op === 'append' && side === 'response')) && typeof op.value === 'string'));

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

        const requestHeaders = (Array.isArray(mod.request) ? mod.request : [])
            .filter((op) => isApplicableOp(op, 'request')).map(mapHeaderOp);
        const responseHeaders = (Array.isArray(mod.response) ? mod.response : [])
            .filter((op) => isApplicableOp(op, 'response')).map(mapHeaderOp);

        if (requestHeaders.length > 0) action.requestHeaders = requestHeaders;
        if (responseHeaders.length > 0) action.responseHeaders = responseHeaders;

        return action;
    }

    /**
     * Build the `action` object for a 'queryparams' rule: a redirect action
     * with a queryTransform.
     *
     * B2-F9: removeAll replaces the whole query instead — '' drops it, and
     * with params to add it becomes exactly those ('?k=v&…', encoded). The
     * remove list has nothing left to remove then.
     */
    function buildQueryParamsAction(rule) {
        const qp = rule.queryParams || {};
        if (qp.removeAll === true) {
            const add = (Array.isArray(qp.add) ? qp.add : [])
                .filter((p) => p && typeof p.key === 'string' && p.key && typeof p.value === 'string');
            const query = add.length
                ? '?' + add.map((p) => encodeURIComponent(p.key) + '=' + encodeURIComponent(p.value)).join('&')
                : '';
            return { type: 'redirect', redirect: { transform: { query } } };
        }
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
     *
     * F1: also appliesTo:'all' redirect/block rules, with priority
     * 100000 - `index` (the rule's position in the rule list), so an earlier
     * rule wins — over a later one, and over any query-param redirect.
     */
    function ruleToDnr(rule, index = 0) {
        if (!rule || !isDnrRule(rule) || !rule.dnrRuleId) {
            return null;
        }

        // B2-F7: no resource type left for DNR (an all-request rule limited
        // to fetch-xhr is the interceptor's alone), or page domains that name
        // nothing usable: no DNR rule, rather than a wider one.
        const match = rule.match || {};
        const networkRule = isNetworkRule(rule);
        const resourceTypes = dnrResourceTypes(match, networkRule);
        if (resourceTypes.length === 0 || initiatorDomains(match) === null) return null;

        if (networkRule) {
            const built = buildNetworkRule(rule, resourceTypes);
            if (!built) return null;
            return {
                id: rule.dnrRuleId,
                priority: Math.max(1, NETWORK_PRIORITY_BASE - (Number(index) || 0)),
                condition: built.condition,
                action: built.action
            };
        }

        const condition = buildCondition(match, resourceTypes);
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
            // F1: each rule keeps its list position, which sets the
            // priority of a redirect/block network rule.
            const candidates = isActive
                ? (rules || []).map((rule, index) => ({ rule, index }))
                    .filter(({ rule }) => rule && rule.enabled && isDnrRule(rule))
                : [];

            const known = await loadKnownRejected();
            const stillKnown = new Map(); // pruned to rules that still exist
            const rejected = [];
            const reject = (rule, error) => rejected.push({ id: rule.id, name: rule.name, error });
            const ids = new Set();
            let entries = [];
            for (const { rule, index } of candidates) {
                const dnr = ruleToDnr(rule, index);
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

    const api = {
        ruleToDnr, syncDnrRules, dnrRuleEqual, validateHeadersMod, FORBIDDEN_HEADER_NAMES, deepEqual,
        isDnrRule, isNetworkRule, ALL_RESOURCE_TYPES, API_RESOURCE_TYPES,
        RESOURCE_TYPE_MAP, dnrResourceTypes, initiatorDomains
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapDnr = api;
})(typeof window !== 'undefined' ? window : globalThis);
