/**
 * SpliceTap Injected Interceptor
 *
 * This script runs in the MAIN world (same context as the page).
 * It monkey-patches window.fetch and XMLHttpRequest to intercept requests.
 *
 * Matching / placeholder / patch logic lives in the shared UMD modules
 * (src/placeholders.js -> window.SpliceTapPlaceholders,
 *  src/matcher.js      -> window.SpliceTapMatcher,
 *  src/patch.js        -> window.SpliceTapPatch), which must be loaded
 * BEFORE this script (see manifest content_scripts order, G3). This file
 * no longer contains any local copy of that logic. It takes those three
 * globals into its closure on load and deletes them (PER-2).
 *
 * State transport note (P-13 / S-4 / C-5 / Q-14): state sync from
 * content/content.js (ISOLATED world) arrives via a namespaced CustomEvent
 * on `document` rather than `window.postMessage`/'message'. See the comment
 * at the top of content/content.js for why.
 */

(function () {
    // PER-2: take the shared modules into this closure, then remove their
    // globals. The page shares this realm, and these functions receive every
    // rule: the request path used to look them up on `window` per request, so
    // a page that wrapped window.SpliceTapMatcher.findMatchingRule received
    // the whole rule set, mock bodies included, on its next fetch. This runs
    // at document_start, before any page script, and before the double-
    // injection guard so a second load's globals are removed as well.
    const sharedMatcher = window.SpliceTapMatcher;
    const sharedPlaceholders = window.SpliceTapPlaceholders;
    const sharedPatch = window.SpliceTapPatch;
    try { delete window.SpliceTapMatcher; } catch (e) { /* non-configurable: leave it */ }
    try { delete window.SpliceTapPlaceholders; } catch (e) { /* non-configurable: leave it */ }
    try { delete window.SpliceTapPatch; } catch (e) { /* non-configurable: leave it */ }

    const findMatchingRule = sharedMatcher && sharedMatcher.findMatchingRule;
    const findMatchingRequestBodyRule = sharedMatcher && sharedMatcher.findMatchingRequestBodyRule;
    const matchUrl = sharedMatcher && sharedMatcher.matchUrl;
    const isCatastrophicRegex = sharedMatcher && sharedMatcher.isCatastrophicRegex;
    const processDynamicResponse = sharedPlaceholders && sharedPlaceholders.processDynamicResponse;
    const jsonMergePatch = sharedPatch && sharedPatch.jsonMergePatch;
    const isPatchApplicable = sharedPatch && sharedPatch.isPatchApplicable;

    // PER-2: the built-ins this file applies to rule data, captured for the
    // same reason. A page that later replaced JSON.stringify or Array.isArray
    // would otherwise see each rule this file handed to them.
    const jsonParse = JSON.parse;
    const jsonStringify = JSON.stringify;
    const objectAssign = Object.assign;
    const objectKeys = Object.keys;
    const isArray = Array.isArray;
    const NativeURL = URL;
    const NativeRequest = Request;
    const reflectApply = Reflect.apply;
    const reflectConstruct = Reflect.construct;
    const reflectDeleteProperty = Reflect.deleteProperty;
    const objectCreate = Object.create;
    const defineProperty = Object.defineProperty;
    const getPrototypeOf = Object.getPrototypeOf;
    const setPrototypeOf = Object.setPrototypeOf;
    // F4: code responses compile with these. A page that replaced the
    // AsyncFunction constructor or EvalError would otherwise be handed each
    // rule's code, or decide how its failure is reported.
    const AsyncFunction = getPrototypeOf(async function () {}).constructor;
    const NativeEvalError = EvalError;
    const NativeWeakMap = WeakMap;
    const weakMapGet = WeakMap.prototype.get;
    const weakMapSet = WeakMap.prototype.set;

    // Contract B (PER-2 residual): a page can also reach rule data through
    // prototypes it hooks before its first request — a getter on
    // Object.prototype fires when a rule lacks the property read (`this` is
    // the rule's own object), String.prototype and RegExp.prototype methods
    // receive patterns, Array.prototype's iterator sees the rule list, and a
    // wrapped dispatchEvent or CustomEvent `detail` getter sees the nonced
    // channel (and with it, on the next sync, every rule). These scripts run
    // at document_start, before any page script, so what is captured here is
    // genuine. Rule data is copied into null-prototype objects on every sync
    // (toNullProto), and the paths that handle it call these instead of
    // looking methods up on the data.
    const hasOwnProperty = Object.prototype.hasOwnProperty;
    const stringIndexOf = String.prototype.indexOf;
    const stringSlice = String.prototype.slice;
    const stringTrim = String.prototype.trim;
    const stringToLowerCase = String.prototype.toLowerCase;
    const stringToUpperCase = String.prototype.toUpperCase;
    const regexpExec = RegExp.prototype.exec;
    const NativeRegExp = RegExp;
    const SymbolIterator = Symbol.iterator;
    const encodeURIComponentNative = encodeURIComponent;
    const eventDispatch = document.dispatchEvent; // EventTarget.prototype's, before any page script
    const NativeCustomEvent = CustomEvent;
    const customEventDetail = (Object.getOwnPropertyDescriptor(CustomEvent.prototype, 'detail') || {}).get;
    const consoleLog = console.log;

    const hasOwn = (object, key) => reflectApply(hasOwnProperty, object, [key]);
    const indexOf = (text, search) => reflectApply(stringIndexOf, text, [search]);
    const slice = (text, start, end) => reflectApply(stringSlice, text, [start, end]);
    const trim = (text) => reflectApply(stringTrim, text, []);
    const lower = (text) => reflectApply(stringToLowerCase, text, []);
    const upper = (text) => reflectApply(stringToUpperCase, text, []);
    const matches = (regex, text) => reflectApply(regexpExec, regex, [text]) !== null;
    /** list.indexOf(value) !== -1, without Array.prototype. */
    function contains(list, value) {
        for (let i = 0; i < list.length; i++) if (list[i] === value) return true;
        return false;
    }

    /** CustomEvent `detail` through the captured getter. */
    function eventDetail(event) {
        return customEventDetail ? reflectApply(customEventDetail, event, []) : event && event.detail;
    }

    /** Dispatch a CustomEvent on the document with the captured built-ins. */
    function emit(type, detail) {
        const event = detail === undefined
            ? new NativeCustomEvent(type)
            : new NativeCustomEvent(type, { __proto__: null, detail });
        return reflectApply(eventDispatch, document, [event]);
    }

    // The iterator a copied rule list carries: `for...of` over it then reads
    // only own properties (Array.prototype[Symbol.iterator] and the array
    // iterator's next() are page-replaceable).
    function ownValues() {
        const list = this;
        let index = 0;
        const iterator = objectCreate(null);
        iterator.next = function next() {
            const step = objectCreate(null);
            step.done = index >= list.length;
            step.value = step.done ? undefined : list[index++];
            return step;
        };
        return iterator;
    }

    const MAX_COPY_DEPTH = 100;

    /**
     * A deep copy made of null-prototype objects and arrays, so a property
     * a rule lacks reads as undefined without consulting Object.prototype.
     * Only own enumerable properties are read from the source, and nothing
     * is assigned until the copy's prototype is null (an assignment would
     * otherwise run a setter the page put on Object.prototype).
     * `iterable`: arrays get an own iterator (ownValues).
     */
    function toNullProto(value, iterable, depth) {
        if (value === null || typeof value !== 'object') return value;
        const level = depth || 0;
        if (level > MAX_COPY_DEPTH) return null;
        if (isArray(value)) {
            const out = [];
            setPrototypeOf(out, null);
            for (let i = 0; i < value.length; i++) {
                out[i] = hasOwn(value, i) ? toNullProto(value[i], iterable, level + 1) : undefined;
            }
            if (iterable) defineProperty(out, SymbolIterator, { __proto__: null, value: ownValues });
            return out;
        }
        const out = objectCreate(null);
        const keys = objectKeys(value);
        for (let i = 0; i < keys.length; i++) out[keys[i]] = toNullProto(value[keys[i]], iterable, level + 1);
        return out;
    }

    function ownValue(object, key) {
        return object && typeof object === 'object' && hasOwn(object, key) ? object[key] : undefined;
    }

    // PER-43: an own property defined on the instance. Plain assignment
    // (`xhr.open = fn`) silently does nothing once a page has frozen
    // XMLHttpRequest.prototype — an inherited read-only property blocks the
    // assignment — so every override was skipped and nothing was mocked.
    function defineOwn(target, name, value) {
        defineProperty(target, name, { __proto__: null, value, writable: true, enumerable: false, configurable: true });
    }

    // Protect against double injection. Non-enumerable so a page scanning
    // `Object.keys(window)` / `for...in` doesn't trivially discover it (S-9).
    if (window.__SPLICETAP_INITIALIZED__) return;
    try {
        Object.defineProperty(window, '__SPLICETAP_INITIALIZED__', {
            value: true, enumerable: false, configurable: true
        });
    } catch (e) {
        window.__SPLICETAP_INITIALIZED__ = true;
    }

    // SEC-2: these were fixed, guessable names. Because a MAIN-world script
    // shares the page's realm, ANY page script — or any third-party iframe on
    // the page — could simply
    //     document.addEventListener('__splicetap_sync_state__', e => exfil(e.detail))
    // and receive the user's entire rule set on every sync: mock bodies,
    // redirect destinations, and the URL patterns of internal endpoints. It
    // could equally dispatch a forged event to disable interception for itself
    // while the popup still showed the rules as active.
    //
    // The channel is now keyed by a per-frame random nonce handed over in a
    // single bootstrap event. Content scripts run at document_start, before any
    // page script executes, so the page cannot have a listener registered in
    // time to observe the handover, and cannot guess the nonce afterwards.
    //
    // Honest limitation: this is not airtight against a same-realm adversary —
    // sharing a realm is inherent to MAIN-world injection, and a sufficiently
    // determined script could still tamper with globals. It removes the
    // trivial, zero-effort eavesdropping and forgery the fixed names allowed.
    const BOOTSTRAP_EVENT = '__splicetap_bootstrap__';
    let SYNC_STATE_EVENT = null;
    let LOG_INTERCEPTION_EVENT = null;
    let CAPTURE_EVENT = null;
    let PING_EVENT = null;
    let DEACTIVATE_EVENT = null;

    // PER-32: set once the relay reports that its extension is gone (reloaded,
    // updated or removed). Sticky: nothing can bring this frame's relay back.
    let orphaned = false;

    // Store originals
    const originalFetch = window.fetch;
    const originalXHR = window.XMLHttpRequest;
    let spliceTapFetch = null; // the wrapper installed as window.fetch

    // State
    let tmState = {
        active: true,
        rules: [],
        settings: {},
        // Derived flags, recomputed whenever rules are synced (perf: avoid
        // rescanning/reallocating on every single request — P-1/P-3/P-10/P-16).
        _anyRuleUsesHeaders: false,
        _anyRuleUsesGraphQL: false,
        _hasRedirectRules: false,
        _hasRequestBodyRules: false // F3
    };

    // Helper: Logging with debug mode check
    function log(msg, ...args) {
        if (tmState.settings?.debugMode) {
            reflectApply(consoleLog, console, [`%c[SpliceTap] ${msg}`, 'color: #2563eb; font-weight: bold;', ...args]);
        }
    }

    // Helper: Better randomness for chaos mode
    function getSecureRandom() {
        if (window.crypto && window.crypto.getRandomValues) {
            const array = new Uint32Array(1);
            window.crypto.getRandomValues(array);
            return array[0] / (0xffffffff + 1);
        }
        return Math.random();
    }

    // PER-48: chaos mode simulates network failures, so it only touches
    // http(s) requests. It failed blob: and data: fetches, which never reach
    // the network.
    function isNetworkUrl(url) {
        return typeof url === 'string' && /^https?:/i.test(url);
    }

    // Helper: is chaos mode currently enabled? (used by the zero-rule early-out
    // so chaos mode still fires even when the user has no regular rules — P-1)
    function isChaosModeActive() {
        return !!(tmState.settings && tmState.settings.chaosMode && tmState.settings.chaosMode.enabled);
    }

    // Capture mode: record real responses so a rule can be built from one,
    // instead of hand-writing a mock body from scratch. Like chaos mode it has
    // no rule dependency — the whole point is to use it BEFORE any rule exists —
    // so it has to gate the zero-rule early-outs too.
    //
    // Off by default and explicitly armed by the user. While disarmed this is a
    // single property read and nothing else on the request path changes.
    function isCaptureArmed() {
        return !!(tmState.settings && tmState.settings.captureArmed);
    }

    // Response bodies are the one thing this extension otherwise never touches
    // at rest, so capture is deliberately bounded: only bodies that look like
    // text/JSON, only up to this size, and only while armed.
    const CAPTURE_MAX_BODY = 100 * 1024;
    const CAPTURE_TEXTUAL = /^(application\/(json|.*\+json|xml|javascript|x-www-form-urlencoded)|text\/)/i;

    /** A body's text, or null once it passes `limit` bytes (the rest is left unread). */
    async function readCapped(body, limit) {
        if (!body) return '';
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        let text = '';
        for (;;) {
            const step = await reader.read();
            if (step.done) break;
            bytes += step.value.byteLength;
            if (bytes > limit) {
                reader.cancel().catch(() => {});
                return null;
            }
            text += decoder.decode(step.value, { stream: true });
        }
        return text + decoder.decode();
    }

    function emitCapture(entry) {
        if (!CAPTURE_EVENT) return;
        emit(CAPTURE_EVENT, entry);
    }

    /**
     * Record a passed-through response without altering it.
     *
     * Takes a clone so the page still gets an unread body — reading the real
     * one would consume the stream and break the very request we are observing.
     */
    async function captureFetchResponse(response, url, method) {
        try {
            const contentType = response.headers.get('content-type') || '';
            if (!CAPTURE_TEXTUAL.test(contentType)) return;
            // PER-18: an event stream is never complete, so it is not a
            // response a rule can be built from.
            if (mimeEssence(contentType) === 'text/event-stream') return;
            if (Number(response.headers.get('content-length')) > CAPTURE_MAX_BODY) return;

            // PER-18: read at most the cap, then stop. clone().text() read
            // the whole body first, so an endless text stream was buffered
            // without bound while capture was armed.
            const text = await readCapped(response.clone().body, CAPTURE_MAX_BODY);
            if (text === null) return;

            const headers = {};
            response.headers.forEach((v, k) => { headers[k] = v; });

            emitCapture({
                ts: Date.now(),
                url: sanitizeUrlForLog(url),
                method,
                status: response.status,
                statusText: response.statusText,
                contentType,
                headers,
                body: text
            });
        } catch (e) {
            // Capture is best-effort and must never affect the real request.
        }
    }

    // Guard: the shared UMD modules must be present (loaded earlier in the
    // manifest's MAIN-world content_scripts array). If they're missing, log
    // once and leave fetch/XHR unpatched rather than throwing.
    const spliceTapGlobalsReady = !!(
        typeof processDynamicResponse === 'function' &&
        typeof findMatchingRule === 'function' &&
        typeof matchUrl === 'function' &&
        typeof jsonMergePatch === 'function'
    );

    if (!spliceTapGlobalsReady) {
        console.error(
            '[SpliceTap] Required globals (SpliceTapPlaceholders / SpliceTapMatcher / SpliceTapPatch) were not found. ' +
            'fetch/XHR interception is disabled for this page load.'
        );
    }

    // Helper: report an applied rule to content.js -> background (1.5 step 1)
    // `outcome` (optional, contract A — PER-54 / PER-56): what happened to
    // the request in the end. `elapsedMs` from the page's call, `finalStatus`
    // (a number, or 'failed') the page finally received, `redirectedTo`
    // (redacted like the URL) and a short human-readable `note`.
    function logInterception(rule, url, method, status, outcome) {
        // Null until the bootstrap handshake completes. Dispatching on a null
        // name would throw inside the interception path and break the request.
        if (!LOG_INTERCEPTION_EVENT) return;
        const detail = {
            ts: Date.now(),
            url: sanitizeUrlForLog(url),
            method,
            ruleId: rule.id,
            ruleName: rule.name,
            ruleType: rule.type || 'mock',
            status,
            ...(outcome ? outcomeFields(outcome) : null)
        };
        emit(LOG_INTERCEPTION_EVENT, detail);
    }

    const LOG_NOTE_MAX = 200;
    const MAX_REDIRECTED_TO_LENGTH = 2048;

    // Collected in a null-prototype object and spread into the entry (a
    // literal defines its properties; assigning them could run a setter a
    // page put on Object.prototype — contract B).
    function outcomeFields(outcome) {
        const fields = objectCreate(null);
        if (typeof outcome.startedAt === 'number') {
            fields.elapsedMs = Math.max(0, Math.round(Date.now() - outcome.startedAt));
        }
        if (outcome.finalStatus !== undefined) fields.finalStatus = outcome.finalStatus;
        if (typeof outcome.redirectedTo === 'string') {
            fields.redirectedTo = slice(sanitizeUrlForLog(outcome.redirectedTo), 0, MAX_REDIRECTED_TO_LENGTH);
        }
        if (typeof outcome.note === 'string') fields.note = slice(outcome.note, 0, LOG_NOTE_MAX);
        return fields;
    }

    // PER-54: a chaos-mode failure left no trace in the log.
    function logChaos(url, method, startedAt) {
        if (!LOG_INTERCEPTION_EVENT) return;
        const detail = {
            ts: Date.now(),
            url: sanitizeUrlForLog(url),
            method,
            kind: 'chaos',
            ruleId: null,
            ruleName: 'Chaos mode',
            status: 'failed',
            ...outcomeFields({ __proto__: null, startedAt })
        };
        emit(LOG_INTERCEPTION_EVENT, detail);
    }

    /**
     * PER-56: delay and redirect rules are logged when the real response
     * settles, with the status the page received, instead of at decision
     * time as "pending" (delay) or a red "302" (a redirect that worked).
     */
    function logWhenSettled(promise, rule, url, method, outcome) {
        return promise.then((response) => {
            logInterception(rule, url, method, response.status, { __proto__: null, finalStatus: response.status, ...outcome });
            return response;
        }, (error) => {
            logInterception(rule, url, method, null, { __proto__: null, finalStatus: 'failed', ...outcome });
            throw error;
        });
    }

    /**
     * PER-19: why jsonMergePatch would leave `target` as it is, or null when
     * the patch applies. Patching an array-root response with {} used to
     * serve {} instead of the real data.
     */
    function patchSkipReason(target, patch) {
        if (!isPatchApplicable || isPatchApplicable(target, patch)) return null;
        if (patch !== null && typeof patch === 'object' && !isArray(patch) && objectKeys(patch).length === 0) {
            return 'Patch skipped — the patch is empty';
        }
        const kind = isArray(target) ? 'array' : (target === null ? 'null' : typeof target);
        return `Patch skipped — response is not a JSON object (${kind})`;
    }

    const PATCH_NOT_JSON_NOTE = 'Patch skipped — response body is not valid JSON';

    // Helper: redact obviously-sensitive values and cap length before a URL
    // is persisted into the interception log or a capture (S-8). Best-effort:
    // if the URL can't be parsed, log it as-is rather than throwing.
    //
    // PER-4: this redacted only a fixed list of exact names, so session_id,
    // JSESSIONID, id_token, refresh_token, access-token, code, client_secret,
    // jwt, X-Amz-Signature, sig, user[token], an #access_token= fragment and
    // a /reset/<token> path all reached the log and captures. A query or
    // fragment key is now sensitive when its name CONTAINS any of these, in
    // any letter case and with any separator; that redacts some harmless
    // keys too (author, keyword), which only costs a value in the log.
    const SENSITIVE_KEY_PARTS = [
        'token', 'secret', 'session', 'sid', 'sig', 'signature', 'auth', 'key', 'password',
        'passwd', 'pwd', 'code', 'jwt', 'credential', 'nonce', 'otp'
    ];
    const REDACTED = '[redacted]';
    // A path segment that looks like a token: 24+ URL-safe characters with
    // both letters and digits (opaque ids, signed links), or a JWT.
    const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{24,}$/;
    const JWT_SEGMENT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;
    const MAX_LOGGED_URL_LENGTH = 2000;

    function isSensitiveKey(name) {
        const lower = String(name).toLowerCase();
        for (let i = 0; i < SENSITIVE_KEY_PARTS.length; i++) {
            if (lower.indexOf(SENSITIVE_KEY_PARTS[i]) !== -1) return true;
        }
        return false;
    }

    function looksLikeToken(segment) {
        if (JWT_SEGMENT.test(segment)) return true;
        return TOKEN_SEGMENT.test(segment) && /[A-Za-z]/.test(segment) && /[0-9]/.test(segment);
    }

    /** Redact sensitive keys in place; true when anything changed. */
    function redactParams(params) {
        const keys = [];
        params.forEach((value, key) => { keys.push(key); });
        let changed = false;
        for (let i = 0; i < keys.length; i++) {
            if (isSensitiveKey(keys[i])) {
                params.set(keys[i], REDACTED);
                changed = true;
            }
        }
        return changed;
    }

    // '#a=b&c=d' (an OAuth implicit-flow fragment) or '#/route?a=b'.
    function redactFragment(hash) {
        const fragment = hash.slice(1);
        if (fragment.indexOf('=') === -1) return hash;
        const query = fragment.indexOf('?');
        const prefix = query === -1 ? '' : fragment.slice(0, query + 1);
        const params = new URLSearchParams(query === -1 ? fragment : fragment.slice(query + 1));
        return redactParams(params) ? '#' + prefix + params.toString() : hash;
    }

    // Token-shaped segments, and ;name=value path parameters (;jsessionid=…).
    function redactPath(pathname) {
        const segments = pathname.split('/');
        let changed = false;
        for (let i = 0; i < segments.length; i++) {
            const parts = segments[i].split(';');
            let decoded = parts[0];
            try { decoded = decodeURIComponent(parts[0]); } catch (e) { /* keep it encoded */ }
            if (looksLikeToken(decoded)) {
                parts[0] = REDACTED;
                changed = true;
            }
            for (let j = 1; j < parts.length; j++) {
                const eq = parts[j].indexOf('=');
                if (eq > 0 && isSensitiveKey(parts[j].slice(0, eq))) {
                    parts[j] = parts[j].slice(0, eq + 1) + REDACTED;
                    changed = true;
                }
            }
            segments[i] = parts.join(';');
        }
        return changed ? segments.join('/') : pathname;
    }

    function sanitizeUrlForLog(rawUrl) {
        let safeUrl = rawUrl;
        try {
            const parsed = new NativeURL(rawUrl, baseUrl());
            redactParams(parsed.searchParams);
            if (parsed.hash) parsed.hash = redactFragment(parsed.hash);
            if (/^https?:$/.test(parsed.protocol)) {
                const path = redactPath(parsed.pathname);
                if (path !== parsed.pathname) parsed.pathname = path;
            }
            // Always the absolute URL. A page calling fetch('/api/x') used to
            // be logged — and captured — as the bare relative path, so the
            // DevTools log lost the origin, and a rule built from a capture
            // took the raw path as its pattern: including the query string,
            // and for a path like '/api/' a pattern the matcher reads as the
            // regex /api/, matching every URL that contains "api".
            safeUrl = parsed.href;
        } catch (e) {
            safeUrl = rawUrl;
        }
        if (typeof safeUrl === 'string' && safeUrl.length > MAX_LOGGED_URL_LENGTH) {
            safeUrl = safeUrl.slice(0, MAX_LOGGED_URL_LENGTH) + '…[truncated]';
        }
        return safeUrl;
    }

    // PER-8 / PER-20: the base a relative request URL resolves against — the
    // document's base URL, as fetch and XHR use. It equals location.href on an
    // ordinary page, and in an about:blank or srcdoc frame it is the creator's
    // URL, where location.href ('about:blank') cannot resolve anything.
    function baseUrl() {
        return document.baseURI || window.location.href;
    }

    // PER-8: rules see the absolute URL, like DNR-backed rules and the
    // browser's own network log. Unparseable input is returned unchanged.
    function resolveUrl(raw) {
        try {
            return new NativeURL(raw, baseUrl()).href;
        } catch (e) {
            return raw;
        }
    }

    /**
     * PER-8: the first rule matching the request's absolute URL — or, so
     * patterns written against the relative form ('/api/x*', /^\/api\//) keep
     * working, the URL as the page wrote it. Matching only the raw string made
     * a host-scoped or full-URL pattern miss every relative call, which is
     * how most single-page apps call their own API.
     *
     * Two scans keep findMatchingRule's first-match order exactly: the winner
     * is whichever of the two hits comes first in the rule list.
     *
     * `finder` (optional) is findMatchingRequestBodyRule for the F3 pass.
     */
    function findRule(request, rawUrl, finder) {
        const find = finder || findMatchingRule;
        const rules = tmState.rules;
        const hit = find(rules, matchRequest(request.url, request));
        if (rawUrl === request.url) return hit;

        const rawHit = find(rules, matchRequest(rawUrl, request));
        if (!hit || !rawHit || hit === rawHit) return hit || rawHit;
        for (let i = 0; i < rules.length; i++) {
            if (rules[i] === hit) return hit;
            if (rules[i] === rawHit) return rawHit;
        }
        return hit;
    }

    // Contract B: the request record the matcher reads, with no prototype.
    function matchRequest(url, request) {
        const record = objectCreate(null);
        record.url = url;
        record.method = request.method;
        record.headers = request.headers;
        record.bodyText = request.bodyText;
        return record;
    }

    /**
     * PER-10: is there an enabled rule above `target` whose URL and method
     * match, but whose header or GraphQL condition can only be judged once
     * the request's headers and body exist? XHR open() cannot tell whether
     * such a rule wins, so it leaves the decision to send().
     */
    function conditionalRuleAhead(target, absUrl, rawUrl, method) {
        const rules = tmState.rules;
        for (let i = 0; i < rules.length && rules[i] !== target; i++) {
            const rule = rules[i];
            // F3: request-body rules are their own pass, not a contender.
            if (!rule || !rule.enabled || rule.type === 'requestBody') continue;
            const match = rule.match || EMPTY_RECORD;
            const conditional = (match.headers && objectKeys(match.headers).length > 0) ||
                (match.graphql && match.graphql.operationName);
            if (!conditional) continue;
            const ruleMethod = upper(String(match.method || '*'));
            if (ruleMethod !== '*' && ruleMethod !== method) continue;
            if (matchUrl(absUrl, match.url) || matchUrl(rawUrl, match.url)) return true;
        }
        return false;
    }

    /**
     * PER-32: confirm the relay's extension still exists before applying a
     * rule. After a reload, update or uninstall the relay in an open tab is
     * cut off, but this frame would keep serving its last rules. The relay
     * answers this synchronously — with a deactivate event when the runtime
     * is gone — so the request about to be mocked passes through instead.
     */
    function relayAlive() {
        if (orphaned) return false;
        // Contract B: through the captured dispatch — a page that wrapped
        // dispatchEvent read the nonce off this ping's event type.
        if (PING_EVENT) emit(PING_EVENT);
        return !orphaned;
    }

    // PER-12: a header value must be a ByteString. A rule name with any
    // character above U+00FF made `new Headers()` throw, and the fallback
    // then dropped every header the mock set. Printable ASCII is sent as is;
    // anything else is percent-encoded (decodeURIComponent restores it).
    const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
    function ruleMarker(name) {
        const value = name === undefined || name === null ? '' : String(name);
        if (matches(PRINTABLE_ASCII, value)) return value;
        try {
            return encodeURIComponentNative(value);
        } catch (e) {
            // A lone surrogate cannot be encoded.
            let out = '';
            for (let i = 0; i < value.length; i++) out += value[i] >= ' ' && value[i] <= '~' ? value[i] : '?';
            return out;
        }
    }

    // Helper: an AbortError matching what native fetch throws (Q-13).
    function abortError() {
        try {
            return new DOMException('The user aborted a request.', 'AbortError');
        } catch (e) {
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            return err;
        }
    }

    // Helper: sleep that rejects early if `signal` aborts mid-wait (Q-13).
    function sleepAbortable(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) {
                reject(abortError());
                return;
            }
            const timer = setTimeout(() => {
                if (signal) signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            function onAbort() {
                clearTimeout(timer);
                reject(abortError());
            }
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    const EMPTY_RECORD = Object.freeze(objectCreate(null));

    // Helper: resolve rule.response with defaults so a legacy/hand-written
    // rule missing the `response` object entirely (or missing individual
    // fields) never throws (Q-5). Does not change the documented schema
    // Only fills in what a well-formed rule would have had.
    function getResponseConfig(rule) {
        const r = rule.response || EMPTY_RECORD;
        return {
            __proto__: null,
            mode: r.mode || 'static',
            body: r.body !== undefined ? r.body : objectCreate(null),
            patch: r.patch !== undefined ? r.patch : objectCreate(null),
            delay: r.delay || 0,
            statusCode: r.statusCode || 200,
            // The background fills a missing reason phrase from the status
            // code when it normalises stored rules (storage.normalizeRule), so
            // this fallback only covers a rule that somehow lacks one. It used
            // to be 'OK' whatever the code — a 404 mock reported "OK".
            // An explicit '' is kept: HTTP/2 responses have no reason phrase,
            // so a rule captured from one is faithful with an empty string.
            statusText: r.statusText !== undefined ? r.statusText : ((r.statusCode || 200) === 200 ? 'OK' : ''),
            headers: r.headers,
            code: typeof r.code === 'string' ? r.code : '' // F4
        };
    }

    /**
     * A rule's mock body as response text. Contract B: serialised with the
     * captured JSON.stringify (a null-prototype body has no toJSON to look
     * up), and handed to the placeholder engine only when it holds a `{{`
     * token — so a body without placeholders never reaches a String method.
     */
    function renderBody(body, details) {
        const text = typeof body === 'string' ? body : jsonStringify(body);
        if (typeof text !== 'string' || indexOf(text, '{{') === -1) return text === undefined ? '' : text;
        const processed = processDynamicResponse(body, details);
        return typeof processed === 'string' ? processed : jsonStringify(toNullProto(processed));
    }

    /** A rule's patch with its placeholders filled, as a null-prototype value. */
    function renderPatch(patch, details) {
        const text = typeof patch === 'string' ? patch : jsonStringify(patch);
        if (typeof text !== 'string' || indexOf(text, '{{') === -1) return patch;
        return toNullProto(processDynamicResponse(patch, details));
    }

    // Helper: compute the destination URL for a redirect rule (supports $1..$9
    // capture references when match.url is a /regex/ pattern). Consistent with
    // src/matcher.js's matchUrl: the /regex/ delimited form is the only branch
    // that supports capture substitution here (there is no separate wildcard
    // branch to mis-order relative to it — a wildcard pattern simply falls
    // through to the plain destination, same as a substring pattern).
    //
    // `sourceUrl` is the absolute request URL and `rawUrl` the URL as the page
    // wrote it (PER-8): the regex is tried against the absolute form first,
    // then the raw one, mirroring how the rule was matched.
    function computeRedirectUrl(sourceUrl, rule, rawUrl) {
        const destination = (rule.redirect && rule.redirect.destination) || sourceUrl; // Q-5: missing rule.redirect
        const pattern = rule.match && rule.match.url;
        if (typeof pattern === 'string' && pattern.length >= 2 && pattern[0] === '/' && pattern[pattern.length - 1] === '/') {
            const regexBody = slice(pattern, 1, -1);
            try {
                // SEC-1: this compiled the raw body directly, bypassing the
                // matcher's ReDoS guard entirely — so a pattern the matcher
                // refused to run could still hang the page here. Reuse the same
                // check rather than trusting that matchUrl already vetted it.
                if (isCatastrophicRegex && isCatastrophicRegex(regexBody)) {
                    return destination;
                }
                // PER-9: the destination replaces the whole URL, with $1..$9
                // taken from the match. This used String.replace, which kept
                // the unmatched prefix: an absolute URL against /\/api\/(.*)/
                // became "https://hosthttp://localhost:3000/...".
                // Contract B: RegExp.prototype.exec captured; the
                // substitution is a loop, not String.replace (which looks up
                // the page-replaceable RegExp.prototype[Symbol.replace]).
                const regex = new NativeRegExp(regexBody, 'i');
                const match = reflectApply(regexpExec, regex, [sourceUrl]) ||
                    (rawUrl !== undefined && rawUrl !== sourceUrl ? reflectApply(regexpExec, regex, [rawUrl]) : null);
                if (!match) return destination;
                const text = String(destination);
                let out = '';
                for (let i = 0; i < text.length; i++) {
                    const digit = text[i + 1];
                    if (text[i] === '$' && digit !== undefined && digit >= '0' && digit <= '9') {
                        const n = Number(digit);
                        // $0 and references past the last group stay
                        // literal, as they do in String.replace.
                        out += (n === 0 || n >= match.length) ? '$' + digit : (match[n] === undefined ? '' : match[n]);
                        i++;
                    } else {
                        out += text[i];
                    }
                }
                return out;
            } catch (e) {
                return destination;
            }
        }
        return destination;
    }

    // Helper: normalize request headers (plain object / Headers / entries array) into a lowercase-keyed plain object
    function collectHeadersInto(target, source) {
        if (!source) return;
        if (typeof Headers !== 'undefined' && source instanceof Headers) {
            source.forEach((value, key) => { target[String(key).toLowerCase()] = value; });
        } else if (Array.isArray(source)) {
            source.forEach((entry) => {
                if (Array.isArray(entry) && entry.length >= 2) {
                    target[String(entry[0]).toLowerCase()] = entry[1];
                }
            });
        } else if (typeof source === 'object') {
            Object.keys(source).forEach((key) => { target[key.toLowerCase()] = source[key]; });
        }
    }

    function collectRequestHeaders(resource, config, isRequestObj) {
        const headers = {};
        if (config && config.headers) {
            collectHeadersInto(headers, config.headers);
        } else if (isRequestObj) {
            collectHeadersInto(headers, resource.headers);
        }
        return headers;
    }

    // Helper: best-effort synchronous/async body-text extraction for GraphQL
    // matching (Q-17). Handles string bodies, URLSearchParams, the
    // graphql-upload FormData convention (an "operations" field carrying the
    // JSON payload), and Request objects. Returns null (rather than throwing)
    // when the body can't be read as text.
    async function readBodyText(resource, config, isRequestObj) {
        const raw = config && 'body' in config ? config.body : undefined;
        if (typeof raw === 'string') return raw;
        if (typeof URLSearchParams !== 'undefined' && raw instanceof URLSearchParams) {
            return raw.toString();
        }
        if (typeof FormData !== 'undefined' && raw instanceof FormData) {
            const ops = typeof raw.get === 'function' ? raw.get('operations') : null;
            return typeof ops === 'string' ? ops : null;
        }
        if (isRequestObj) {
            return await resource.clone().text().catch(() => null);
        }
        return null;
    }

    // PER-11: everything a Request carries, as a fetch init for a new URL.
    // The body is read into a buffer, since a stream body cannot be uploaded
    // over HTTP/1.1. 'navigate' is not a mode an init may set.
    async function requestInit(request) {
        const init = {
            method: request.method,
            headers: request.headers,
            credentials: request.credentials,
            cache: request.cache,
            redirect: request.redirect,
            referrer: request.referrer,
            referrerPolicy: request.referrerPolicy,
            integrity: request.integrity,
            keepalive: request.keepalive,
            signal: request.signal
        };
        if (request.mode !== 'navigate') init.mode = request.mode;
        if (request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null) {
            init.body = await request.clone().arrayBuffer();
        }
        return init;
    }

    // --- F3: request-body rules ---

    const REQUEST_BODY_REPLACED = 'Request body replaced';
    const REQUEST_BODY_PATCHED = 'Request body patched';
    const REQUEST_BODY_SKIP = 'Request body not patched — ';

    // Captured so a page replacing the globals cannot change how a body is read.
    const NativeFormData = typeof FormData !== 'undefined' ? FormData : null;
    const NativeBlob = typeof Blob !== 'undefined' ? Blob : null;
    const NativeURLSearchParams = typeof URLSearchParams !== 'undefined' ? URLSearchParams : null;
    const NativeReadableStream = typeof window.ReadableStream !== 'undefined' ? window.ReadableStream : null;
    const NativeTextDecoder = typeof TextDecoder !== 'undefined' ? TextDecoder : null;
    const NativeArrayBuffer = ArrayBuffer;
    const isArrayBufferView = ArrayBuffer.isView;

    /** What a fetch or XHR body is: 'none', 'text', 'bytes', or its type's name. */
    function bodyKind(body) {
        if (body === null || body === undefined) return 'none';
        if (typeof body === 'string') return 'text';
        if (body instanceof NativeArrayBuffer || isArrayBufferView(body)) return 'bytes';
        if (NativeFormData && body instanceof NativeFormData) return 'FormData';
        if (NativeURLSearchParams && body instanceof NativeURLSearchParams) return 'URLSearchParams';
        if (NativeBlob && body instanceof NativeBlob) return 'Blob';
        if (NativeReadableStream && body instanceof NativeReadableStream) return 'ReadableStream';
        return 'not text'; // an XHR Document, or anything else
    }

    /** UTF-8 text from bytes, or null when they are not valid UTF-8. */
    function decodeUtf8(bytes) {
        if (!NativeTextDecoder) return null;
        try {
            return new NativeTextDecoder('utf-8', { __proto__: null, fatal: true }).decode(bytes);
        } catch (e) {
            return null;
        }
    }

    // Q-17: an XHR body as text for GraphQL matching — a string, a
    // URLSearchParams, or the graphql-upload FormData's "operations" field.
    function xhrBodyText(body) {
        if (typeof body === 'string') return body;
        if (NativeURLSearchParams && body instanceof NativeURLSearchParams) return body.toString();
        if (NativeFormData && body instanceof NativeFormData && typeof body.get === 'function') {
            const operations = body.get('operations');
            return typeof operations === 'string' ? operations : null;
        }
        return null;
    }

    /** The body as text when it is text or bytes, else null — readable synchronously. */
    function bodyAsText(body) {
        const kind = bodyKind(body);
        if (kind === 'text') return body;
        return kind === 'bytes' ? decodeUtf8(body) : null;
    }

    // PER-19's skip reasons, worded for a request body.
    function requestPatchSkipReason(target, patch) {
        if (!isPatchApplicable || isPatchApplicable(target, patch)) return null;
        if (patch !== null && typeof patch === 'object' && !isArray(patch) && objectKeys(patch).length === 0) {
            return REQUEST_BODY_SKIP + 'the patch is empty';
        }
        const kind = isArray(target) ? 'array' : (target === null ? 'null' : typeof target);
        return `${REQUEST_BODY_SKIP}the body is not a JSON object (${kind})`;
    }

    /**
     * F3: a requestBody rule applied to `body`, synchronously (XHR send()
     * cannot wait). Null for a mode this build does not know. Otherwise a
     * null-prototype record: `body` to send, `changed`, `json` (a static
     * object/array body, which wants a JSON Content-Type) and the log `note`.
     * Static: the rule's body through placeholders, as a mock body is.
     * Patch: a JSON merge patch onto JSON text only — FormData, Blob,
     * URLSearchParams, a stream or a non-object JSON body is left as it is.
     */
    function rewriteRequestBody(rule, body, details) {
        const config = rule.requestBody || EMPTY_RECORD;
        const mode = config.mode || 'static';
        if (mode !== 'static' && mode !== 'patch') return null;
        const out = objectCreate(null);
        out.body = body;
        out.changed = false;
        out.json = false;

        if (mode === 'static') {
            const value = config.body === undefined ? '' : config.body;
            out.body = renderBody(value, details);
            out.json = value !== null && typeof value === 'object';
            out.changed = true;
            out.note = REQUEST_BODY_REPLACED;
            return out;
        }

        const text = bodyAsText(body);
        if (text === null) {
            const kind = bodyKind(body);
            out.note = REQUEST_BODY_SKIP + (kind === 'none' ? 'the request has no body' : `the body is ${kind}, not JSON text`);
            return out;
        }
        let data;
        try {
            data = jsonParse(text);
        } catch (e) {
            out.note = REQUEST_BODY_SKIP + 'the body is not valid JSON';
            return out;
        }
        const patch = renderPatch(config.patch === undefined ? objectCreate(null) : config.patch, details);
        const skipped = requestPatchSkipReason(data, patch);
        if (skipped) {
            out.note = skipped;
            return out;
        }
        out.body = jsonStringify(toNullProto(jsonMergePatch(data, patch)));
        out.changed = true;
        out.note = REQUEST_BODY_PATCHED;
        return out;
    }

    // Every member fetch() reads from an init, own or inherited.
    const REQUEST_INIT_MEMBERS = ['method', 'headers', 'body', 'referrer', 'referrerPolicy', 'mode', 'credentials',
        'cache', 'redirect', 'integrity', 'keepalive', 'signal', 'duplex', 'priority', 'window'];

    /**
     * Copy a page's fetch init onto `init` as fetch would read it: inherited
     * members included, and an undefined member treated as absent (so
     * `{body: undefined}` keeps a Request's own body).
     */
    function copyRequestInit(init, config) {
        const keys = objectKeys(config);
        for (let i = 0; i < keys.length; i++) {
            const value = config[keys[i]];
            if (value !== undefined) init[keys[i]] = value;
        }
        for (let i = 0; i < REQUEST_INIT_MEMBERS.length; i++) {
            const value = config[REQUEST_INIT_MEMBERS[i]];
            if (value !== undefined) init[REQUEST_INIT_MEMBERS[i]] = value;
        }
        return init;
    }

    /**
     * F3: a requestBody rule applied to a fetch. Null when it does not apply;
     * otherwise `note`, and — when the body changed — `args`: the URL and a
     * null-prototype init that send the new body. A Request is rebuilt with
     * every field it carries (PER-11), with the page's init over it.
     */
    async function rewriteFetchBody(rule, resource, config, isRequestObj, url, method) {
        const init = objectCreate(null);
        if (isRequestObj) objectAssign(init, await requestInit(resource));
        if (config) copyRequestInit(init, config);

        const rewritten = rewriteRequestBody(rule, init.body, { __proto__: null, url, method });
        if (!rewritten) return null;
        const out = objectCreate(null);
        out.note = rewritten.note;
        if (!rewritten.changed) return out;

        if (rewritten.note === REQUEST_BODY_REPLACED) {
            try {
                const headers = new Headers(init.headers === undefined ? undefined : init.headers);
                // A multipart type names a boundary the new body does not
                // have (a Request built from FormData carries one).
                if (mimeEssence(headers.get('content-type')) === 'multipart/form-data') headers.delete('content-type');
                if (rewritten.json && !headers.has('content-type')) headers.set('Content-Type', 'application/json');
                init.headers = headers;
            } catch (e) {
                // Headers fetch itself will refuse: leave them for it to report.
            }
        }
        init.body = rewritten.body;
        out.args = [isRequestObj ? resource.url : resource, init];
        return out;
    }

    // --- Response construction helpers (Q-2, Q-24, Q-28) ---

    // Statuses the Fetch spec forbids from carrying a body at all.
    const NULL_BODY_STATUSES = [101, 103, 204, 205, 304];

    // `new Headers(...)` throws on an invalid header name/value (Q-24, e.g. a
    // typo'd "Content Type" instead of "Content-Type"). Never let a bad rule
    // turn a mock into a network-level failure.
    //
    // PER-12: drop only the offending header. The fallback used to replace
    // every header with a bare JSON Content-Type, so one value above U+00FF
    // (an en dash in a rule name, "café" in a header) cost the mock its
    // status-relevant headers, Content-Type included.
    function buildHeadersSafe(headersInit) {
        try {
            return new Headers(headersInit);
        } catch (e) {
            // Fall through and add the headers one at a time.
        }
        const headers = new Headers();
        if (!headersInit || typeof headersInit !== 'object') return headers;
        const names = objectKeys(headersInit);
        let droppedContentType = false;
        for (let i = 0; i < names.length; i++) {
            try {
                headers.append(names[i], headersInit[names[i]]);
            } catch (e) {
                log(`Dropping invalid response header "${names[i]}" from rule`, e);
                if (lower(String(names[i])) === 'content-type') droppedContentType = true;
            }
        }
        // Keep the mock's JSON default rather than letting Response() pick
        // text/plain when the rule's own Content-Type was the bad one.
        if (droppedContentType && !headers.has('content-type')) {
            headers.set('Content-Type', 'application/json');
        }
        return headers;
    }

    // Build a fetch Response for an arbitrary mock/patch status, including
    // statuses the Response() constructor can't represent directly:
    // - 101/103/204/205/304 (and anything else) forbid a non-null body.
    // - anything outside [200, 599] makes the constructor itself throw.
    // Both cases previously made the returned promise REJECT instead of
    // resolving (Q-2), which XHR mocking of the same rule never suffered
    // from. We construct with a legal placeholder status when necessary and
    // override the visible `status`/`ok` afterwards.
    /**
     * A rule's response headers, with Content-Type defaulted to JSON unless
     * the rule sets one in ANY letter case. The default used to be merged in
     * by exact key, so a rule with `content-type: text/html` produced two keys
     * that Headers joined into "application/json, text/html".
     */
    function withDefaultContentType(userHeaders, fallback) {
        // Contract B: a null-prototype copy. new Headers() looks up
        // Symbol.iterator on its argument, and the markers are assigned
        // next — on an ordinary object both reach Object.prototype.
        const headers = objectCreate(null);
        let hasContentType = false;
        if (userHeaders && typeof userHeaders === 'object') {
            const names = objectKeys(userHeaders);
            for (let i = 0; i < names.length; i++) {
                headers[names[i]] = userHeaders[names[i]];
                if (lower(names[i]) === 'content-type') hasContentType = true;
            }
        }
        if (!hasContentType) headers['Content-Type'] = fallback || 'application/json'; // F4: text/plain for a code response's text
        return headers;
    }

    // `overrides` (optional): url, redirected, type — what a real response
    // would report and a constructed one cannot (Q-28, PER-42).
    function buildMockResponse(bodyText, status, statusText, headersInit, overrides) {
        const numericStatus = Number.isFinite(status) ? status : 200;
        const inRange = numericStatus >= 200 && numericStatus <= 599;
        const nullBody = bodyText === null || contains(NULL_BODY_STATUSES, numericStatus) || !inRange;
        const constructStatus = inRange ? numericStatus : 200;
        const headers = buildHeadersSafe(headersInit);

        let response;
        try {
            response = new Response(nullBody ? null : bodyText, {
                status: constructStatus,
                statusText,
                headers
            });
        } catch (e) {
            response = new Response(null, { status: 200, statusText, headers });
        }

        const props = objectAssign(objectCreate(null), overrides || EMPTY_RECORD);
        if (constructStatus !== numericStatus) {
            props.status = numericStatus;
            props.ok = numericStatus >= 200 && numericStatus < 300;
        }
        return overrideResponse(response, props);
    }

    // Response.prototype.clone, captured: overrideResponse() reapplies its
    // properties to every clone through it.
    const nativeResponseClone = Response.prototype.clone;

    /**
     * Own-property overrides on a Response (url, status, ok, type,
     * redirected). PER-42: clone() returned a plain clone, so a mocked
     * response's clone lost its url (and the status of a 1xx/6xx mock); the
     * overrides now carry over to every clone.
     */
    function overrideResponse(response, props) {
        const names = objectKeys(props);
        if (names.length === 0) return response;
        try {
            for (let i = 0; i < names.length; i++) {
                defineProperty(response, names[i], { __proto__: null, value: props[names[i]], configurable: true });
            }
            defineOwn(response, 'clone', function clone() {
                return overrideResponse(reflectApply(nativeResponseClone, this, []), props);
            });
        } catch (e) {
            // Environment won't allow the override — keep the constructed values.
        }
        return response;
    }

    function absoluteHref(url) {
        try {
            return new NativeURL(url).href;
        } catch (e) {
            return url;
        }
    }

    // A real fetch response's type: 'basic' from this origin, else 'cors'.
    // (A no-cors request to another origin really gets an unreadable
    // 'opaque' response; a mock stays readable, as the README says.)
    function responseTypeFor(url) {
        try {
            return new NativeURL(url).origin === new NativeURL(baseUrl()).origin ? 'basic' : 'cors';
        } catch (e) {
            return 'basic';
        }
    }

    // PER-42: what fetch returns for a 3xx under redirect: 'manual' — an
    // 'opaqueredirect' response: status 0, no headers, no body.
    function opaqueRedirect(url) {
        return overrideResponse(Response.error(), { type: 'opaqueredirect', url: absoluteHref(url) });
    }

    const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
    const MAX_REDIRECTS = 20;
    // Marks an init this file built to follow a mocked redirect, with the hop count.
    const REDIRECT_HOPS = typeof Symbol === 'function' ? Symbol('splicetapRedirectHops') : '__splicetapRedirectHops';
    // Headers that describe a request body, dropped when a redirect turns the request into a GET.
    const REQUEST_BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type'];

    /**
     * PER-42: follow a mocked 3xx with a Location under the default
     * redirect: 'follow', as fetch does — up to 20 hops, 303 (and a POST
     * answered by 301/302) becoming a GET without its body. The target may
     * itself be mocked. The page gets the final response with
     * `redirected: true`.
     */
    async function followMockedRedirect(thisArg, rule, status, url, method, location, resource, config, isRequestObj, startedAt) {
        let target;
        try {
            target = new NativeURL(location, url).href;
        } catch (e) {
            return Promise.reject(new TypeError('Failed to fetch'));
        }
        const hops = ((config && config[REDIRECT_HOPS]) || 0) + 1;
        if (hops > MAX_REDIRECTS) {
            logInterception(rule, url, method, status, { finalStatus: 'failed', startedAt, note: 'Too many redirects' });
            return Promise.reject(new TypeError('Failed to fetch'));
        }

        const init = isRequestObj ? await requestInit(resource) : objectAssign({}, config || {});
        init.method = method;
        if ((status === 303 && method !== 'HEAD') || ((status === 301 || status === 302) && method === 'POST')) {
            init.method = 'GET';
            delete init.body;
            const headers = new Headers(init.headers || undefined);
            for (let i = 0; i < REQUEST_BODY_HEADERS.length; i++) headers.delete(REQUEST_BODY_HEADERS[i]);
            init.headers = headers;
        }
        init.redirect = 'follow';
        init[REDIRECT_HOPS] = hops;

        // Through this file's own fetch, not window.fetch: a page wrapper
        // around fetch would otherwise see one call twice.
        const followed = reflectApply(spliceTapFetch, thisArg, [target, init])
            .then((response) => overrideResponse(response, { redirected: true }));
        return logWhenSettled(followed, rule, url, method, {
            startedAt, redirectedTo: target, note: `Mocked ${status} redirect followed`
        });
    }

    // PER-41: a patched body is new, so the real response's length,
    // encoding and digests no longer describe it — a gzip response kept
    // `Content-Encoding: gzip` over the decoded, re-serialised JSON.
    const STALE_AFTER_PATCH = ['content-length', 'content-encoding', 'content-md5', 'digest'];

    function patchedHeaders(headers) {
        const out = objectCreate(null);
        headers.forEach((value, key) => {
            if (!contains(STALE_AFTER_PATCH, lower(String(key)))) out[key] = value;
        });
        return out;
    }

    function isJsonMime(essence) {
        return essence === 'application/json' || matches(/\+json$/, essence);
    }

    /**
     * PER-18 / PER-42: why a patch cannot apply, judged from the status and
     * headers alone, before any of the body is read — or null.
     */
    function patchSkipBeforeReading(real, method) {
        if (hasNoBody(real.status, method)) return 'Patch skipped — response has no body';
        const essence = mimeEssence(real.headers.get('content-type'));
        if (!isJsonMime(essence)) {
            return `Patch skipped — response is not a JSON object (${(essence || 'no content type').slice(0, 80)})`;
        }
        return null;
    }

    const EMPTY_HEADERS = Object.freeze({});

    // --- XHR delivery helpers (PER-16, PER-40, PER-47, PER-52) ---

    /** The type/subtype of a Content-Type value, lowercased ('' when absent). */
    function mimeEssence(contentType) {
        if (typeof contentType !== 'string') return '';
        const semi = indexOf(contentType, ';');
        return lower(trim(semi === -1 ? contentType : slice(contentType, 0, semi)));
    }

    function isXmlMime(essence) {
        return essence === 'text/xml' || essence === 'application/xml' || matches(/\+xml$/, essence);
    }

    /** A header's value from a plain header object, by name in any letter case. */
    function headerValue(headers, name) {
        if (!headers) return undefined;
        const names = objectKeys(headers);
        for (let i = 0; i < names.length; i++) {
            if (lower(names[i]) === name) return headers[names[i]];
        }
        return undefined;
    }

    // PER-52: what a fetch mock already does — no body for 204/205/304, for
    // a status the Response constructor cannot carry, or for HEAD. An XHR
    // mock of a 204 delivered the configured body.
    function hasNoBody(status, method) {
        return method === 'HEAD' || contains(NULL_BODY_STATUSES, status) || !(status >= 200 && status <= 599);
    }

    // PER-16: the size an upload progress event reports for a request body.
    function bodyByteLength(body) {
        try {
            if (typeof body === 'string') return new TextEncoder().encode(body).byteLength;
            if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
            if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
            if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                return new TextEncoder().encode(body.toString()).byteLength;
            }
        } catch (e) {
            // Unknown size: reported as 0.
        }
        return 0;
    }

    // PER-47: DOMParser's input is a Trusted Types sink, so on a page that
    // enforces Trusted Types a mocked 'document' response was refused — a
    // policy violation in the console — and the page got the raw string. A
    // private pass-through policy (its createHTML is reachable only from
    // here) lets the mock's own markup through. If the page restricts policy
    // names, none can be made: the document is then built without an HTML
    // sink, with the text as its body's content.
    const DOM_PARSER_TYPES = ['text/html', 'text/xml', 'application/xml', 'application/xhtml+xml', 'image/svg+xml'];
    const NativeDOMParser = typeof DOMParser !== 'undefined' ? DOMParser : null;
    const domParse = NativeDOMParser && NativeDOMParser.prototype.parseFromString;
    const trustedTypesFactory = window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function'
        ? window.trustedTypes
        : null;
    const ttCreatePolicy = trustedTypesFactory && trustedTypesFactory.createPolicy;
    const ttCreateHTML = window.TrustedTypePolicy ? window.TrustedTypePolicy.prototype.createHTML : null;
    let ttPolicy; // undefined: not tried yet; null: the page refused it
    // F4: trustedTypes.defaultPolicy, read through the captured getter.
    const ttDefaultPolicy = trustedTypesFactory
        ? (Object.getOwnPropertyDescriptor(getPrototypeOf(trustedTypesFactory), 'defaultPolicy') || EMPTY_RECORD).get
        : null;

    /** The parser input for `text`, or null when this page will not accept one. */
    function parserInput(text) {
        if (!trustedTypesFactory) return text;
        if (ttPolicy === undefined) {
            try {
                ttPolicy = reflectApply(ttCreatePolicy, trustedTypesFactory,
                    ['splicetap-mock', { __proto__: null, createHTML: (s) => s }]);
            } catch (e) {
                ttPolicy = null;
            }
        }
        if (!ttPolicy) return null;
        return ttCreateHTML ? reflectApply(ttCreateHTML, ttPolicy, [text]) : ttPolicy.createHTML(text);
    }

    /**
     * PER-40: the Document an XHR exposes for an HTML or XML response, or
     * null for any other type, as natively. Never a string (PER-47).
     */
    function buildDocument(text, essence) {
        const html = essence === 'text/html';
        if (!html && !isXmlMime(essence)) return null;
        const type = contains(DOM_PARSER_TYPES, essence) ? essence : 'application/xml';
        const input = parserInput(text);
        if (input !== null && domParse) {
            try {
                return reflectApply(domParse, new NativeDOMParser(), [input, type]);
            } catch (e) {
                // Fall through to the sink-free document.
            }
        }
        try {
            const doc = document.implementation.createHTMLDocument('');
            doc.body.textContent = text;
            return doc;
        } catch (e) {
            return null;
        }
    }

    // --- F4: code responses ---
    //
    // A mock with response.mode 'code' runs the rule's code — the body of an
    // async function of `request` — in this page, and serves what it returns
    // through the same response builders as a static mock. It runs only
    // while Settings allow it; otherwise, and whenever it cannot run, the
    // request goes to the network with a note in the log.

    const CODE_OFF_NOTE = 'Code responses are turned off in Settings';
    const CODE_CSP_NOTE = "Blocked by this page's Content-Security-Policy";
    const CODE_THREW_NOTE = 'Code response threw: ';
    const CODE_MESSAGE_MAX = 150;
    const ENVELOPE_KEYS = ['status', 'headers', 'body'];

    // rule (a synced copy, replaced on every sync) -> its compiled function,
    // or a {note} record when it cannot run.
    const compiledCode = new NativeWeakMap();
    let evalBlocked = false;

    function noteRecord(note) {
        const record = objectCreate(null);
        record.note = note;
        return record;
    }

    function codeThrewNote(error) {
        let message;
        try {
            message = error !== null && typeof error === 'object' && 'message' in error ? `${error.message}` : `${error}`;
        } catch (e) {
            message = 'an unreadable error';
        }
        return CODE_THREW_NOTE + slice(message, 0, CODE_MESSAGE_MAX);
    }

    /**
     * Can this page compile code at all? Probed with an empty function, so
     * a refusal reports nothing of the rule: a CSP violation report and the
     * page's securitypolicyviolation listeners get the source's first
     * characters as `sample`. A Trusted Types default policy would be handed
     * the source to approve, so a page with one is treated as refusing too.
     * Both only ever tighten over a document's life, so a refusal is final.
     */
    function evalAllowed() {
        if (evalBlocked) return false;
        try {
            if (ttDefaultPolicy && reflectApply(ttDefaultPolicy, trustedTypesFactory, []) !== null) {
                evalBlocked = true;
                return false;
            }
            reflectConstruct(AsyncFunction, []);
            return true;
        } catch (e) {
            evalBlocked = true;
            return false;
        }
    }

    /**
     * The rule's code as an async function of `request`, compiled once per
     * synced rule — or a {note} record: code responses are off, the page's
     * CSP forbids compiling, or the code does not parse.
     *
     * Strict mode, so the page cannot reach the function, or its source,
     * through `caller`, `arguments.callee` or a stack trace's
     * CallSite.getFunction().
     */
    function codeFunction(rule, code) {
        if (!tmState.settings || tmState.settings.allowCodeResponses !== true) return noteRecord(CODE_OFF_NOTE);
        const cached = reflectApply(weakMapGet, compiledCode, [rule]);
        if (cached) return cached;
        let compiled;
        if (!evalAllowed()) {
            compiled = noteRecord(CODE_CSP_NOTE);
        } else {
            try {
                compiled = reflectConstruct(AsyncFunction, ['request', '"use strict";' + code]);
            } catch (error) {
                compiled = noteRecord(error instanceof NativeEvalError ? CODE_CSP_NOTE : codeThrewNote(error));
            }
        }
        reflectApply(weakMapSet, compiledCode, [rule, compiled]);
        return compiled;
    }

    /** A request body as text for code: text, bytes (UTF-8), URLSearchParams or a Blob; else null. */
    async function bodyTextForCode(body) {
        const kind = bodyKind(body);
        if (kind === 'URLSearchParams') return body.toString();
        if (kind === 'Blob') {
            try {
                return await body.text();
            } catch (e) {
                return null;
            }
        }
        return bodyAsText(body);
    }

    /** The text a fetch would send, for code (null when it has none, or none as text). */
    async function fetchBodyTextForCode(resource, config, isRequestObj, method) {
        if (method === 'GET' || method === 'HEAD') return null;
        if (config && config.body !== undefined) return bodyTextForCode(config.body);
        if (!isRequestObj || resource.body === null) return null;
        try {
            return await resource.clone().text();
        } catch (e) {
            return null;
        }
    }

    /**
     * What the code receives: {url, method, headers, body, json}, built fresh
     * for every call so nothing persists between requests through it. `url`
     * is absolute, `headers` a plain object with lowercase names, `body` the
     * text sent or null, `json` the body parsed (undefined when it is not JSON).
     */
    function codeRequest(url, method, headers, bodyText) {
        const plainHeaders = {};
        const names = headers ? objectKeys(headers) : [];
        for (let i = 0; i < names.length; i++) plainHeaders[lower(names[i])] = `${headers[names[i]]}`;
        let json;
        if (typeof bodyText === 'string') {
            try {
                json = jsonParse(bodyText);
            } catch (e) {
                json = undefined;
            }
        }
        return { url, method, headers: plainHeaders, body: typeof bodyText === 'string' ? bodyText : null, json };
    }

    /** {status?, headers?, body}: an object whose own keys are only those, with `body`. */
    function isEnvelope(value) {
        if (value === null || typeof value !== 'object' || isArray(value) || !hasOwn(value, 'body')) return false;
        const keys = objectKeys(value);
        for (let i = 0; i < keys.length; i++) if (!contains(ENVELOPE_KEYS, keys[i])) return false;
        return !hasOwn(value, 'status') || typeof value.status === 'number';
    }

    /** A returned headers value (a plain object or a Headers) as a null-prototype record. */
    function codeHeaders(value) {
        const out = objectCreate(null);
        if (value === null || typeof value !== 'object') return out;
        if (value instanceof Headers) {
            value.forEach((v, k) => { out[k] = v; });
            return out;
        }
        const names = objectKeys(value);
        for (let i = 0; i < names.length; i++) out[names[i]] = `${value[names[i]]}`;
        return out;
    }

    /**
     * What the code returned, as a response record {status, statusText,
     * headers, text}: status 200 unless the envelope gives an integer
     * 100–999; Content-Type JSON for an object or array body, else
     * text/plain, unless set; the x-splicetap markers as for static mocks.
     */
    function codeResponse(value, rule) {
        let status = 200;
        let headers = null;
        let body = value;
        if (isEnvelope(value)) {
            const given = value.status;
            if (typeof given === 'number' && given % 1 === 0 && given >= 100 && given <= 999) status = given;
            headers = codeHeaders(value.headers);
            body = value.body;
        }
        let text;
        let json = false;
        if (typeof body === 'string') {
            text = body;
        } else if (body === undefined || body === null) {
            text = '';
        } else if (typeof body === 'object') {
            text = jsonStringify(body);
            json = true;
        } else {
            text = `${body}`;
        }
        const out = objectCreate(null);
        out.status = status;
        out.statusText = status === 200 ? 'OK' : '';
        out.headers = withDefaultContentType(headers, json ? 'application/json' : 'text/plain');
        out.headers['x-splicetap'] = 'true';
        out.headers['x-splicetap-rule'] = ruleMarker(rule.name);
        out.text = typeof text === 'string' ? text : '';
        return out;
    }

    /**
     * Run compiled code: a response record, or a {note} record when it threw
     * (or returned something that cannot be a response).
     */
    async function runCode(fn, request, rule) {
        try {
            return codeResponse(await fn(request), rule);
        } catch (error) {
            return noteRecord(codeThrewNote(error));
        }
    }

    // PER-17: the native timeout setter, to hand a delayed request only the
    // time its xhr.timeout has left.
    const nativeTimeoutAccessor = (originalXHR && originalXHR.prototype &&
        Object.getOwnPropertyDescriptor(originalXHR.prototype, 'timeout')) || null;

    // --- INTERCEPTOR: FETCH ---
    if (spliceTapGlobalsReady) {
        // Sync outer wrapper: P-1/P-2. Bails to the real fetch, with zero
        // extra allocation, before any promise/array/object is created, for
        // the common "installed but nothing to do" case. Chaos mode has no
        // rule dependency, so it must still gate this bail (correctness).
        // PER-7: named and sized like the native fetch (name 'fetch', length 1).
        spliceTapFetch = function fetch(...args) {
            if (!tmState.active || (tmState.rules.length === 0 && !isChaosModeActive() && !isCaptureArmed())) {
                return originalFetch.apply(this, args);
            }
            return handleInterceptedFetch.apply(this, args);
        };
        defineProperty(spliceTapFetch, 'length', { __proto__: null, value: 1 });
        window.fetch = spliceTapFetch;

        async function handleInterceptedFetch(...args) {
            const startedAt = Date.now();
            let [resource, config] = args;
            let isRequestObj = resource instanceof NativeRequest;
            const isURLObj = resource instanceof NativeURL;
            // Q-6: fetch(new URL(...)) previously left `url` as a non-string
            // object, breaking matchUrl's .toLowerCase() and later crashing
            // logInterception's postMessage/CustomEvent with a DataCloneError.
            const rawUrl = isRequestObj ? resource.url : (isURLObj ? resource.href : String(resource));
            // PER-8: match, redirect and fill {{request.url}} with the
            // absolute URL; rawUrl is the fallback for relative patterns.
            const url = resolveUrl(rawUrl);
            const method = ((config && config.method) || (isRequestObj && resource.method) || 'GET').toUpperCase();

            // Q-13: honor AbortController/signal on the mock/patch paths (the
            // real originalFetch calls below already honor it themselves).
            const signal = (config && config.signal) || (isRequestObj ? resource.signal : null);
            if (signal && signal.aborted) {
                return Promise.reject(abortError());
            }

            // 1. Chaos Mode Check — network requests only (PER-48).
            if (tmState.settings?.chaosMode?.enabled && isNetworkUrl(url)) {
                if (getSecureRandom() < (tmState.settings.chaosMode.failureRate || 0.1) && relayAlive()) {
                    log(`Chaos Mode: Blocked ${url}`);
                    logChaos(url, method, startedAt);
                    return Promise.reject(new TypeError('Failed to fetch (SpliceTap Chaos Mode)'));
                }
            }

            // 2. Read request headers into a lowercase-keyed plain object —
            // only if some enabled rule actually has a header condition (P-3).
            let headers = tmState._anyRuleUsesHeaders
                ? collectRequestHeaders(resource, config, isRequestObj)
                : EMPTY_HEADERS;

            // 3. Body text: only read it if some enabled rule needs graphql
            //    matching (perf: avoid consuming/reading the body otherwise).
            let bodyText = null;
            if (tmState._anyRuleUsesGraphQL) {
                bodyText = await readBodyText(resource, config, isRequestObj);
                if (bodyText === null) {
                    log('A GraphQL-matching rule is configured but this request body could not be read as text', { url, method });
                }
            }

            // F3: the request-body pass, before the main first-match, which
            // then sees the new body and Content-Type. Not on a mocked
            // redirect's next hop: a browser re-sends the body it already had.
            let bodyRule = null;
            let bodyNote = null;
            if (tmState._hasRequestBodyRules && method !== 'GET' && method !== 'HEAD' && !(config && config[REDIRECT_HOPS])) {
                const candidate = findRule({ url, method, headers, bodyText }, rawUrl, findMatchingRequestBodyRule);
                const rewritten = candidate && relayAlive()
                    ? await rewriteFetchBody(candidate, resource, config, isRequestObj, url, method)
                    : null;
                if (rewritten) {
                    bodyRule = candidate;
                    bodyNote = rewritten.note;
                    log(`${bodyNote}: ${method} ${url} (Rule: ${candidate.name})`);
                    if (rewritten.args) {
                        args = rewritten.args;
                        resource = args[0];
                        config = args[1];
                        isRequestObj = false;
                        if (tmState._anyRuleUsesHeaders) headers = collectRequestHeaders(resource, config, false);
                        if (tmState._anyRuleUsesGraphQL) bodyText = await readBodyText(resource, config, false);
                    }
                }
            }

            const context = { __proto__: null, startedAt, resource, config, isRequestObj, rawUrl, url, method, signal, headers, bodyText };
            const outcome = reflectApply(fetchMainPass, this, [args, context]);
            // Logged once the page has its answer, like a delay (PER-56).
            return bodyRule ? logWhenSettled(outcome, bodyRule, url, method, { startedAt, note: bodyNote }) : outcome;
        }

        // The main first-match pass over mock/block/delay/redirect, on the
        // request as the F3 pass left it.
        async function fetchMainPass(args, context) {
            const { startedAt, resource, config, isRequestObj, rawUrl, url, method, signal, headers, bodyText } = context;

            // 4. Find matching rule
            const rule = findRule({ url, method, headers, bodyText }, rawUrl);
            if (!rule || !relayAlive()) {
                // Nothing to apply — but this is exactly the response worth
                // capturing, since a rule for it does not exist yet.
                if (isCaptureArmed()) {
                    const passed = await reflectApply(originalFetch, this, args);
                    captureFetchResponse(passed, url, method);
                    return passed;
                }
                return reflectApply(originalFetch, this, args);
            }

            const effectiveType = rule.type || 'mock';

            // 5. Branch on rule.type
            if (effectiveType === 'block') {
                log(`Blocked ${method} ${url} (Rule: ${rule.name})`);
                logInterception(rule, url, method, 0);
                return Promise.reject(new TypeError('Failed to fetch'));
            }

            if (effectiveType === 'delay') {
                // PER-45: a keepalive request is how a page reports on its
                // way out; held in page JavaScript it died with the page.
                // It leaves at once.
                if ((config && config.keepalive) || (isRequestObj && resource.keepalive)) {
                    logInterception(rule, url, method, null, { startedAt, note: 'Delay skipped — keepalive request' });
                    return reflectApply(originalFetch, this, args);
                }
                log(`Delaying ${method} ${url} by ${rule.delayMs}ms (Rule: ${rule.name})`);
                try {
                    await sleepAbortable(rule.delayMs, signal);
                } catch (error) {
                    logInterception(rule, url, method, null, { finalStatus: 'failed', startedAt, note: 'Aborted during the delay' });
                    throw error;
                }
                return logWhenSettled(reflectApply(originalFetch, this, args), rule, url, method, { startedAt });
            }

            if (effectiveType === 'redirect') {
                const newUrl = computeRedirectUrl(url, rule, rawUrl);
                log(`Redirecting ${method} ${url} -> ${newUrl} (Rule: ${rule.name})`);
                const outcome = { startedAt, redirectedTo: newUrl };
                if (!isRequestObj) {
                    return logWhenSettled(reflectApply(originalFetch, this, [newUrl, config]), rule, url, method, outcome);
                }
                // PER-11: `new Request(newUrl, resource)` carried the body over
                // as a stream, and Chrome refuses a streaming upload on
                // HTTP/1.1 — every redirected fetch(Request) with a body failed
                // with "Failed to fetch". Rebuild the init with a buffered body.
                const init = await requestInit(resource);
                return logWhenSettled(
                    reflectApply(originalFetch, this, [newUrl, config ? objectAssign(init, config) : init]),
                    rule, url, method, outcome
                );
            }

            // effectiveType === 'mock'
            const cfg = getResponseConfig(rule);

            if (cfg.mode === 'patch') {
                const real = await reflectApply(originalFetch, this, args);

                // PER-18: only a JSON response is patched. Waiting for any
                // other body held an event stream or NDJSON feed back until
                // it ended (and one that never ends, forever); those now pass
                // straight through, unread.
                const skippedUnread = patchSkipBeforeReading(real, method);
                if (skippedUnread) {
                    logInterception(rule, url, method, real.status, { note: skippedUnread });
                    return real;
                }

                let data;
                try {
                    data = await real.clone().json();
                } catch (e) {
                    log('Patch mode: real response is not valid JSON, returning it unmodified', e);
                    logInterception(rule, url, method, real.status, { note: PATCH_NOT_JSON_NOTE });
                    return real;
                }

                const patchPayload = renderPatch(cfg.patch, { url, method });
                // PER-19: a patch that would not change the response leaves
                // the real one untouched (no markers) and says why in the log.
                const skipped = patchSkipReason(data, patchPayload);
                if (skipped) {
                    logInterception(rule, url, method, real.status, { note: skipped });
                    return real;
                }
                const merged = jsonMergePatch(data, patchPayload);

                if (cfg.delay > 0) {
                    await sleepAbortable(cfg.delay, signal);
                }
                if (signal && signal.aborted) {
                    return Promise.reject(abortError());
                }

                const mergedHeaders = patchedHeaders(real.headers);
                mergedHeaders['x-splicetap'] = 'true';
                mergedHeaders['x-splicetap-rule'] = ruleMarker(rule.name);

                log(`Patched ${method} ${url} (Rule: ${rule.name})`);
                logInterception(rule, url, method, real.status);

                // Q-28: a freshly constructed Response can't carry url,
                // redirected or type, but patch mode is "the real response,
                // plus a merge" — restore them from the real response.
                return buildMockResponse(jsonStringify(toNullProto(merged)), real.status, real.statusText, mergedHeaders,
                    { url: real.url, redirected: real.redirected, type: real.type });
            }

            // mode === 'static' (existing behavior), or F4's 'code': the code
            // runs first, and what it returns takes the static path from here.
            let status = cfg.statusCode;
            let statusText = cfg.statusText;
            let headerObj;
            let codeText = null;
            if (cfg.mode === 'code') {
                const fn = codeFunction(rule, cfg.code);
                const produced = typeof fn === 'function'
                    ? await runCode(fn, codeRequest(url, method, collectRequestHeaders(resource, config, isRequestObj),
                        await fetchBodyTextForCode(resource, config, isRequestObj, method)), rule)
                    : fn;
                if (produced.note !== undefined) {
                    log(`Code response not served for ${method} ${url} (Rule: ${rule.name}): ${produced.note}`);
                    return logWhenSettled(reflectApply(originalFetch, this, args), rule, url, method, { startedAt, note: produced.note });
                }
                status = produced.status;
                statusText = produced.statusText;
                headerObj = produced.headers;
                codeText = produced.text;
            } else {
                headerObj = withDefaultContentType(cfg.headers);
            }
            log(`Intercepted ${method} ${url} (Rule: ${rule.name})`);

            if (cfg.delay > 0) {
                await sleepAbortable(cfg.delay, signal);
            }
            if (signal && signal.aborted) {
                return Promise.reject(abortError());
            }

            // PER-42: a 3xx mock follows the request's redirect mode, as a
            // real one does. It was handed to the page as a 302 whatever the
            // mode: 'error' resolved, and the default 'follow' stopped there.
            if (contains(REDIRECT_STATUSES, status)) {
                const mode = (config && config.redirect) || (isRequestObj ? resource.redirect : 'follow');
                if (mode === 'error') {
                    logInterception(rule, url, method, status, { note: "Redirect refused — the request's redirect mode is 'error'" });
                    return Promise.reject(new TypeError('Failed to fetch'));
                }
                if (mode === 'manual') {
                    logInterception(rule, url, method, status);
                    return opaqueRedirect(url);
                }
                const location = headerValue(headerObj, 'location');
                if (location !== undefined && location !== null && String(location) !== '') {
                    return followMockedRedirect(this, rule, status, url, method, String(location), resource, config, isRequestObj, startedAt);
                }
            }

            // PER-42: no body for HEAD, as for a null-body status (Q-2).
            let responseBody = null;
            if (!hasNoBody(status, method)) {
                responseBody = codeText !== null ? codeText : renderBody(cfg.body, { url, method });
            }

            headerObj['x-splicetap'] = 'true';
            headerObj['x-splicetap-rule'] = ruleMarker(rule.name);

            logInterception(rule, url, method, status);

            // A constructed Response has an empty `url` and type 'default'.
            // Real ones report the URL that was fetched and 'basic' (same
            // origin) or 'cors'; code that logs the URL or resolves relative
            // links against it saw "" from a mock.
            return buildMockResponse(responseBody, status, statusText, headerObj,
                { url: absoluteHref(url), type: responseTypeFor(url) });
        }
    }

    // --- INTERCEPTOR: XHR (COMPLETE IMPLEMENTATION) ---
    if (spliceTapGlobalsReady) {
        // PER-14: the instance is built with Reflect.construct and new.target,
        // so `class Sub extends XMLHttpRequest` gets a Sub. The wrapper used to
        // `return new originalXHR()`, and an object returned from a base
        // constructor replaces `this` in a derived class: every subclass
        // instance lost its own methods (instanceof Sub was false), even with
        // SpliceTap off and no rules.
        // PER-7: named XMLHttpRequest, and a TypeError without `new`, as the
        // native constructor behaves.
        const XMLHttpRequestWrapper = function XMLHttpRequest() {
            if (new.target === undefined) {
                throw new TypeError("Failed to construct 'XMLHttpRequest': Please use the 'new' operator, " +
                    'this DOM object constructor cannot be called as a function.');
            }
            const xhr = reflectConstruct(originalXHR, [], new.target);
            // P-1/P-10: a pristine native XHR (zero own-property overrides)
            // when there's nothing this instance could ever need to do. Chaos
            // mode has no rule dependency, so it must still gate this bail.
            if (!tmState.active || (tmState.rules.length === 0 && !isChaosModeActive() && !isCaptureArmed())) {
                return xhr;
            }
            interceptXHR(xhr);
            return xhr;
        };

        installXHRWrapper(XMLHttpRequestWrapper);
    }

    function installXHRWrapper(Wrapper) {
        const nativePrototype = originalXHR.prototype;
        defineProperty(Wrapper, 'prototype', { __proto__: null, value: nativePrototype, writable: false });
        // PER-7: `new XMLHttpRequest().constructor === XMLHttpRequest`, and
        // static lookups (Sub.DONE) resolve as they do natively.
        try {
            defineProperty(nativePrototype, 'constructor', {
                __proto__: null, value: Wrapper, writable: true, enumerable: false, configurable: true
            });
        } catch (e) {
            // A prototype frozen before this ran: leave its constructor.
        }
        try { setPrototypeOf(Wrapper, getPrototypeOf(originalXHR)); } catch (e) { /* keep Function.prototype */ }

        // Q-27: the static readyState constants. Only .prototype was carried
        // over at first, so `XMLHttpRequest.DONE` was undefined for every page.
        const statics = ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'];
        for (let i = 0; i < statics.length; i++) {
            defineProperty(Wrapper, statics[i], {
                __proto__: null, value: originalXHR[statics[i]], writable: false, enumerable: true, configurable: false
            });
        }
        window.XMLHttpRequest = Wrapper;
    }

    /** Take over one XHR instance: every override is an own property (PER-43). */
    function interceptXHR(xhr) {
        // Request tracking
        let requestUrl = '';
        let requestAbsUrl = '';  // PER-8: requestUrl resolved against the document
        let requestMethod = 'GET';
        let requestHeaders = {};
        // PER-10: what open() and setRequestHeader() were given, in order,
        // so send() can re-open for a redirect it could only decide there.
        let openMethod = 'GET';
        let openRest = [];
        let requestHeaderList = [];
        let requestIsAsync = true; // Q-12: sync XHR (open(..., false)) needs different delivery
        let isMocked = false;      // true while WE own the response lifecycle for this request
        let mockDone = false;      // PER-39: that response has reached DONE
        let redirectHandled = false; // true once open() rewrote the URL for a redirect rule
        let isAborted = false;
        let patchAbort = null;   // QA-6: AbortController for patch mode's real request
        let headersTimer = null;
        let mockTimeout = null;
        let progressInterval = null;
        let timeoutTimer = null; // PER-17
        let mockResponseHeaders = null; // Q-7: headers exposed via getResponseHeader(All)?
        let sendStart = 0;
        // PER-15: bumped by open() and abort(). A timer or fetch callback
        // belonging to an earlier request compares it and stands down, so an
        // abandoned mock can no longer fire load on the object's next request.
        let generation = 0;
        // PER-15: own properties defined for a mocked response, removed by
        // open() so a reused object reads the native state again.
        let overridden = objectCreate(null);
        let restoreTimeout = null; // PER-17: undoes the budget handed to a delayed request
        // PER-16: the request body's upload, emulated for a mocked request.
        let uploadPending = false;
        let uploadTotal = 0;
        // PER-56: a redirect open() applied, logged once the response settles.
        let pendingRedirect = null;
        let logEpoch = 0; // bumped by open(): logs still pending for the last request are dropped
        // F3: the URL as open() was given it, before a redirect rewrote it.
        let sourceUrl = '';
        let sourceAbsUrl = '';

        // Store original methods
        const originalOpen = xhr.open;
        const originalSend = xhr.send;
        const originalAbort = xhr.abort;
        const originalSetRequestHeader = xhr.setRequestHeader;
        const originalGetResponseHeader = xhr.getResponseHeader;
        const originalGetAllResponseHeaders = xhr.getAllResponseHeaders;

        // Build the header set exposed to the page for a mocked response —
        // user headers (defaulted) plus the x-splicetap markers (Q-7).
        function buildMockHeaders(userHeaders, rule) {
            const merged = withDefaultContentType(userHeaders);
            merged['x-splicetap'] = 'true';
            merged['x-splicetap-rule'] = ruleMarker(rule.name); // PER-12: same value as fetch
            return merged;
        }

        /** A read-only own property standing in for the native one (PER-15 records it). */
        function setState(name, value) {
            defineProperty(xhr, name, { __proto__: null, value, writable: false, enumerable: true, configurable: true });
            overridden[name] = true;
        }

        function clearOverrides() {
            const names = objectKeys(overridden);
            for (let i = 0; i < names.length; i++) reflectDeleteProperty(xhr, names[i]);
            overridden = objectCreate(null);
            if (restoreTimeout) {
                const restore = restoreTimeout;
                restoreTimeout = null;
                restore();
            }
        }

        function clearTimers() {
            if (headersTimer) { clearTimeout(headersTimer); headersTimer = null; }
            if (mockTimeout) { clearTimeout(mockTimeout); mockTimeout = null; }
            if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
            if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
        }

        // QA-6: cancel the real request patch mode has in flight, not just
        // its delivery — otherwise the backend still completes the call.
        function cancelPatchFetch() {
            if (patchAbort) {
                try { patchAbort.abort(); } catch (e) { /* already settled */ }
                patchAbort = null;
            }
        }

        /**
         * PER-56: log `rule` when this request's response settles, with the
         * status the page received ('failed' for an error, abort or
         * timeout). A later open() cancels it. F3: a request can have two —
         * its requestBody rule's and its main rule's.
         */
        function logAtLoadend(rule, url, method, outcome) {
            const epoch = logEpoch;
            const onLoadend = () => {
                xhr.removeEventListener('loadend', onLoadend);
                if (logEpoch !== epoch) return;
                const status = xhr.status;
                logInterception(rule, url, method, status > 0 ? status : null,
                    { __proto__: null, finalStatus: status > 0 ? status : 'failed', ...outcome });
            };
            xhr.addEventListener('loadend', onLoadend);
        }

        /** setTimeout for the current request only (PER-15). */
        function later(fn, ms) {
            const gen = generation;
            return setTimeout(() => { if (gen === generation) fn(); }, ms);
        }

        function fireProgress(target, type, loaded, total, lengthComputable) {
            target.dispatchEvent(new ProgressEvent(type, { lengthComputable, loaded, total }));
        }

        function uploadTarget() {
            try {
                return xhr.upload || null;
            } catch (e) {
                return null;
            }
        }

        // PER-16: a real XHR reports its request body's upload on
        // xhr.upload — loadstart inside send(), then progress, load and
        // loadend before the response's headers arrive. Mocks fired none of
        // them, so upload progress UIs stayed at 0%. GET and HEAD send no
        // body, and a synchronous request reports no upload, as natively.
        function startUpload(body) {
            uploadPending = requestIsAsync && body !== null && body !== undefined &&
                requestMethod !== 'GET' && requestMethod !== 'HEAD';
            uploadTotal = uploadPending ? bodyByteLength(body) : 0;
            const upload = uploadPending && uploadTarget();
            if (upload) fireProgress(upload, 'loadstart', 0, uploadTotal, true);
        }

        function completeUpload() {
            if (!uploadPending) return;
            uploadPending = false;
            const upload = uploadTarget();
            if (!upload) return;
            fireProgress(upload, 'progress', uploadTotal, uploadTotal, true);
            fireProgress(upload, 'load', uploadTotal, uploadTotal, true);
            fireProgress(upload, 'loadend', uploadTotal, uploadTotal, true);
        }

        // Shared response-delivery flow (defineProperty + event dispatch),
        // used by BOTH static mock and patch mock so behavior is identical.
        //
        // Q-1: dispatchEvent() already invokes any assigned `on*` handler
        // (onload/onerror/etc. are standard EventTarget event-handler IDL
        // attributes — setting them registers a listener the same
        // dispatch fires). The manual `if (xhr.onX) xhr.onX(...)` calls
        // that used to follow every dispatchEvent() call in this file
        // caused every handler to run twice; they've been removed
        // throughout. Q-8: block/chaos/timeout also dispatch
        // 'readystatechange' before their terminal event, matching load/
        // error/abort, so `onreadystatechange`-only code (readyState ===
        // 4 checks) sees those outcomes too.
        /**
         * Walk readyState up to `state` the way a real response does —
         * HEADERS_RECEIVED (2), then LOADING (3) — with status and headers
         * readable from 2 on. Mocks used to jump straight to 3 (static) or
         * 4 (patch) and set status only at 4, so code that reads status or
         * headers at HEADERS_RECEIVED, as the spec allows, saw 0 and none.
         * Async only: a synchronous XHR reports just the final state.
         */
        function advanceTo(state, status, statusText, headers) {
            if (!requestIsAsync) return;
            mockResponseHeaders = headers || {};
            setState('status', status);
            setState('statusText', statusText);
            for (let next = 2; next <= state; next++) {
                if (xhr.readyState >= next) continue;
                setState('readyState', next);
                xhr.dispatchEvent(new Event('readystatechange'));
            }
        }

        /**
         * Take the request over from the native XHR. A real XHR fires
         * `loadstart` from inside send() (async requests only), and every
         * takeover path skipped it — so progress UIs and libraries keyed
         * off loadstart saw a request that never started.
         *
         * Not used by the delay rule, which hands the request back to the
         * native send() after waiting: that fires its own loadstart then.
         * Announcing the start early as well would deliver it twice, and
         * the native one cannot be suppressed — on an XHR, listeners run
         * in registration order even when ours is capture-phase (verified
         * in Chrome), so a page listener added before send() always sees
         * it. One late loadstart is better than two.
         */
        function takeOver(body) {
            isMocked = true;
            if (!requestIsAsync) return;
            fireProgress(xhr, 'loadstart', 0, 0, false);
            startUpload(body);
        }

        /**
         * The spec's "request error steps" for a request this wrapper owns:
         * DONE with a network error, readystatechange, then `type` and
         * loadend on the upload (if it had not finished) and on the XHR.
         * `type` is 'error' (block, chaos, a failed patch fetch), 'abort' or
         * 'timeout'.
         */
        function failRequest(type) {
            clearTimers();
            mockDone = true;
            mockResponseHeaders = objectCreate(null);
            const responseType = xhr.responseType || '';
            if (overridden.responseText) setState('responseText', '');
            if (overridden.response) setState('response', responseType === '' || responseType === 'text' ? '' : null);
            if (overridden.responseURL) setState('responseURL', '');
            if (overridden.responseXML) setState('responseXML', null);
            setState('status', 0);
            setState('statusText', '');
            setState('readyState', 4);
            xhr.dispatchEvent(new Event('readystatechange'));
            if (uploadPending) {
                uploadPending = false;
                const upload = uploadTarget();
                if (upload) {
                    fireProgress(upload, type, 0, 0, false);
                    fireProgress(upload, 'loadend', 0, 0, false);
                }
            }
            fireProgress(xhr, type, 0, 0, false);
            fireProgress(xhr, 'loadend', 0, 0, false);
        }

        // PER-17: a mocked response honours xhr.timeout, counted from send().
        function armTimeout() {
            let limit = 0;
            try { limit = xhr.timeout; } catch (e) { /* no timeout */ }
            if (!requestIsAsync || !(limit > 0)) return;
            timeoutTimer = later(() => {
                timeoutTimer = null;
                if (mockDone) return;
                cancelPatchFetch();
                failRequest('timeout');
            }, Math.max(0, limit - (Date.now() - sendStart)));
        }

        /**
         * PER-17: a delay rule's hold counts toward xhr.timeout. The native
         * request it hands over to gets only the time left; reading
         * xhr.timeout still shows what the page set.
         */
        function passTimeoutBudget(limit, elapsed) {
            const setter = nativeTimeoutAccessor && nativeTimeoutAccessor.set;
            if (!setter || !(limit > 0)) return;
            let pageValue = limit;
            const budget = (value) => (value > 0 ? Math.max(1, value - elapsed) : value);
            reflectApply(setter, xhr, [budget(limit)]);
            defineProperty(xhr, 'timeout', {
                __proto__: null,
                configurable: true,
                enumerable: true,
                get() { return pageValue; },
                set(value) { pageValue = value; reflectApply(setter, xhr, [budget(value)]); }
            });
            overridden.timeout = true;
            restoreTimeout = () => reflectApply(setter, xhr, [pageValue]);
        }

        // PER-40: responseXML, as natively — for responseType 'document' the
        // response itself; for '' an XML response parsed on first read (HTML
        // is only parsed for 'document'); otherwise null.
        function defineResponseXML(responseType, responseText, essence, documentValue) {
            if (responseType === 'document') {
                setState('responseXML', documentValue);
                return;
            }
            if (!isXmlMime(essence)) {
                setState('responseXML', null);
                return;
            }
            let parsed;
            let built = false;
            defineProperty(xhr, 'responseXML', {
                __proto__: null,
                configurable: true,
                enumerable: true,
                get() {
                    if (!built) {
                        built = true;
                        parsed = buildDocument(responseText, essence);
                    }
                    return parsed;
                }
            });
            overridden.responseXML = true;
        }

        // `rawBody` (optional): the response's own bytes, for a real
        // response delivered unchanged (PER-13), so arraybuffer and blob
        // reads see them rather than a UTF-8 re-encoding of the text.
        // `responseUrl` (optional): the URL the real response came from.
        function finishMock(responseText, status, statusText, headers, rawBody, responseUrl) {
            if (isAborted || mockDone) return;
            clearTimers();
            try {
                completeUpload();
                advanceTo(3, status, statusText, headers);
                // Real responses report the URL that was fetched; a mock
                // left it empty. (fetch mocks already set response.url.)
                try {
                    setState('responseURL', responseUrl || new NativeURL(requestAbsUrl).href);
                } catch (e) {
                    // unparseable URL — leave responseURL as the browser has it
                }
                mockResponseHeaders = headers || {};

                // Q-7: respect responseType instead of always returning text.
                const responseType = xhr.responseType || '';
                const essence = mimeEssence(headerValue(headers, 'content-type'));
                let responseValue = responseText;
                if (responseType === 'json') {
                    try {
                        responseValue = responseText === '' ? null : jsonParse(responseText);
                    } catch (e) {
                        responseValue = null;
                    }
                } else if (responseType === 'arraybuffer' && rawBody) {
                    responseValue = rawBody;
                } else if (responseType === 'arraybuffer' && typeof TextEncoder !== 'undefined') {
                    try {
                        responseValue = new TextEncoder().encode(responseText).buffer;
                    } catch (e) {
                        // keep text fallback
                    }
                } else if (responseType === 'blob' && typeof Blob !== 'undefined') {
                    try {
                        responseValue = new Blob([rawBody || responseText], { type: essence });
                    } catch (e) {
                        // keep text fallback
                    }
                } else if (responseType === 'document') {
                    // QA-7 / PER-40 / PER-47: a Document for HTML or XML,
                    // null for anything else — never the text.
                    responseValue = buildDocument(responseText, essence);
                }

                setState('responseText', responseText);
                setState('response', responseValue);
                if (responseType === '' || responseType === 'document') {
                    defineResponseXML(responseType, responseText, essence, responseValue);
                }
                setState('status', status);
                setState('statusText', statusText);
                setState('readyState', 4);
                // PER-39: DONE from here on, so an abort() from a load
                // handler is the silent after-completion kind.
                mockDone = true;

                xhr.dispatchEvent(new Event('readystatechange'));
                fireProgress(xhr, 'load', responseText.length, responseText.length, true);
                fireProgress(xhr, 'loadend', responseText.length, responseText.length, true);
            } catch (error) {
                console.error('Error processing mock response:', error);
                if (!mockDone) failRequest('error');
            }
        }

        // Static-mock flow: upload, headers and progress events, then hands
        // off to finishMock(). Q-33/P-15: total is derived from the real
        // body length, and the 50ms progress interval is skipped entirely
        // for near-zero delay — a single 100%-loaded progress event is
        // emitted right before delivery instead.
        function runStaticMockFlow(rule) {
            const cfg = getResponseConfig(rule);
            let responseText = '';
            if (!hasNoBody(cfg.statusCode, requestMethod)) {
                responseText = renderBody(cfg.body, { url: requestAbsUrl, method: requestMethod });
            }
            scheduleMockDelivery(responseText, cfg.statusCode, cfg.statusText, buildMockHeaders(cfg.headers, rule), cfg.delay);

            // After the delivery timer, so a timeout equal to the delay loses.
            armTimeout();
        }

        // The timers that deliver a built response (static mocks, F4 code).
        function scheduleMockDelivery(responseText, status, statusText, headers, delay) {
            const totalBytes = responseText.length;

            // The upload finishes, then HEADERS_RECEIVED and LOADING, on a
            // later task — as a real response's do, never inside send().
            headersTimer = later(() => {
                headersTimer = null;
                completeUpload();
                advanceTo(3, status, statusText, headers);

                if (delay > 50) {
                    // Genuinely delayed mocks: emit a few incremental progress
                    // ticks sized to the real body so percentage-based UIs see
                    // real, non-fictitious movement.
                    let bytesLoaded = 0;
                    const stepSize = (totalBytes / 5) || 1;
                    progressInterval = setInterval(() => {
                        bytesLoaded = Math.min(bytesLoaded + stepSize, totalBytes);
                        fireProgress(xhr, 'progress', bytesLoaded, totalBytes, true);
                    }, 50);
                }
            }, 0);

            mockTimeout = later(() => {
                mockTimeout = null;
                if (progressInterval) {
                    clearInterval(progressInterval);
                    progressInterval = null;
                }
                // Always land on a 100%-loaded progress event right before
                // delivery, whether or not the interval above ran.
                fireProgress(xhr, 'progress', totalBytes, totalBytes, true);
                finishMock(responseText, status, statusText, headers);
            }, delay > 10 ? delay : 10);
        }

        /**
         * The real request, made through fetch, for a request this wrapper
         * has taken over (patch mode; a code response that fell through).
         * Null once a failure has been delivered.
         *
         * PER-13: the request is sent once, here, and never again. Every
         * patch failure used to fall back to originalSend(), so a non-JSON
         * or empty response (text, a 204) reached the server twice.
         */
        async function fetchForXHR(body, stale) {
            try {
                // S-7/Q-18: map withCredentials instead of hard-coding
                // 'include'. QA-6: with a signal, so xhr.abort() cancels
                // the request itself, not just its delivery. No prototype:
                // fetch reads the members an init lacks through it (F3's
                // body may be rule data).
                patchAbort = new AbortController();
                return await originalFetch(requestUrl, {
                    __proto__: null,
                    method: requestMethod,
                    headers: requestHeaders,
                    body: body ?? undefined,
                    credentials: xhr.withCredentials ? 'include' : 'same-origin',
                    signal: patchAbort.signal
                });
            } catch (error) {
                // A network failure, as the native XHR would have seen it.
                if (stale()) return null;
                log('XHR: the request failed:', error);
                failRequest('error');
                return null;
            }
        }

        /** A response's headers as a plain record. */
        function responseHeaderRecord(response) {
            const record = {};
            response.headers.forEach((value, key) => { record[key] = value; });
            return record;
        }

        // Patch mode: one real request through fetch, merged and delivered.
        function runPatchFlow(rule, body) {
            const cfg = getResponseConfig(rule);
            const gen = generation;
            const stale = () => gen !== generation || mockDone;
            armTimeout();

            (async () => {
                const real = await fetchForXHR(body, stale);
                if (!real || stale()) return;

                const realHeaders = responseHeaderRecord(real);

                // PER-18: only JSON is patched. Anything else (an event
                // stream, NDJSON) is delivered as it arrives, unchanged.
                const skippedUnread = patchSkipBeforeReading(real, requestMethod);
                if (skippedUnread) {
                    logInterception(rule, requestAbsUrl, requestMethod, real.status, { note: skippedUnread });
                    await deliverStreaming(real, realHeaders, stale);
                    return;
                }

                let rawBody;
                try {
                    rawBody = await real.arrayBuffer();
                } catch (error) {
                    if (stale()) return;
                    failRequest('error');
                    return;
                }
                if (stale()) return;
                patchAbort = null;

                const realText = new TextDecoder().decode(rawBody);
                let mergedText;
                try {
                    const data = jsonParse(realText);
                    const patchPayload = renderPatch(cfg.patch, { url: requestAbsUrl, method: requestMethod });
                    // PER-19: a patch that would not change the response
                    // delivers the real one, and the log says why.
                    const skipped = patchSkipReason(data, patchPayload);
                    if (skipped) {
                        logInterception(rule, requestAbsUrl, requestMethod, real.status, { note: skipped });
                        finishMock(realText, real.status, real.statusText, realHeaders, rawBody, real.url);
                        return;
                    }
                    mergedText = jsonStringify(toNullProto(jsonMergePatch(data, patchPayload)));
                } catch (error) {
                    // Not JSON (or nothing to merge into): deliver the real
                    // response unchanged, as fetch does.
                    log('XHR patch mode: real response is not valid JSON, delivering it unmodified', error);
                    logInterception(rule, requestAbsUrl, requestMethod, real.status, { note: PATCH_NOT_JSON_NOTE });
                    finishMock(realText, real.status, real.statusText, realHeaders, rawBody, real.url);
                    return;
                }

                // PER-41: without the real body's length and encoding.
                const mergedHeaders = patchedHeaders(real.headers);
                mergedHeaders['x-splicetap'] = 'true';
                mergedHeaders['x-splicetap-rule'] = ruleMarker(rule.name);

                log(`Patched XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name})`);
                logInterception(rule, requestAbsUrl, requestMethod, real.status);

                finishMock(mergedText, real.status, real.statusText || 'OK', mergedHeaders, undefined, real.url);
            })();
        }

        /**
         * F4: a code response. send() has taken the request over, so the
         * code's answer is delivered exactly as a static mock's is. Code
         * that throws hands the request to the network through fetch, as
         * patch mode does — the native send() would announce it twice.
         */
        function runCodeFlow(rule, fn, body) {
            const cfg = getResponseConfig(rule);
            const gen = generation;
            const stale = () => gen !== generation || mockDone;
            armTimeout();

            (async () => {
                const request = codeRequest(requestAbsUrl, requestMethod, requestHeaders, await bodyTextForCode(body));
                const produced = await runCode(fn, request, rule);
                if (stale()) return;

                if (produced.note !== undefined) {
                    log(`Code response not served for XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name}): ${produced.note}`);
                    logAtLoadend(rule, requestAbsUrl, requestMethod, { __proto__: null, startedAt: sendStart, note: produced.note });
                    const real = await fetchForXHR(body, stale);
                    if (!real || stale()) return;
                    await deliverStreaming(real, responseHeaderRecord(real), stale);
                    return;
                }

                log(`Intercepted XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name})`);
                logInterception(rule, requestUrl, requestMethod, produced.status);
                const text = hasNoBody(produced.status, requestMethod) ? '' : produced.text;
                scheduleMockDelivery(text, produced.status, produced.statusText, produced.headers, cfg.delay);
            })();
        }

        /**
         * PER-18: hand a real response to the page chunk by chunk, as a
         * native XHR does — LOADING with the text so far and a progress
         * event per chunk — so a stream is not held back until it ends.
         */
        async function deliverStreaming(real, headers, stale) {
            completeUpload();
            advanceTo(2, real.status, real.statusText, headers);
            const responseType = xhr.responseType || '';
            const textual = responseType === '' || responseType === 'text';
            const total = Number(real.headers.get('content-length')) || 0;
            const chunks = [];
            let loaded = 0;
            let text = '';
            if (real.body) {
                const reader = real.body.getReader();
                const decoder = new TextDecoder();
                for (;;) {
                    let step;
                    try {
                        step = await reader.read();
                    } catch (error) {
                        if (!stale()) failRequest('error');
                        return;
                    }
                    if (stale()) {
                        reader.cancel().catch(() => {});
                        return;
                    }
                    if (step.done) break;
                    chunks.push(step.value);
                    loaded += step.value.byteLength;
                    text += decoder.decode(step.value, { stream: true });
                    advanceTo(3, real.status, real.statusText, headers);
                    if (textual) {
                        setState('responseText', text);
                        setState('response', text);
                    }
                    fireProgress(xhr, 'progress', loaded, total, total > 0);
                }
                text += decoder.decode();
            }
            patchAbort = null;
            const raw = new Uint8Array(loaded);
            let offset = 0;
            for (let i = 0; i < chunks.length; i++) {
                raw.set(chunks[i], offset);
                offset += chunks[i].byteLength;
            }
            finishMock(text, real.status, real.statusText, headers, raw.buffer, real.url);
        }

        // Override open
        defineOwn(xhr, 'open', function open(method, url, ...args) {
            // PER-15: open() starts over, as natively. A mocked response's
            // state was left in place, so a reused object reported DONE and
            // the old status straight after open(), and a later real response
            // still read back as the mock; a mock still pending fired its
            // load into the next request.
            generation++;
            clearTimers();
            cancelPatchFetch();
            clearOverrides();
            isMocked = false;
            mockDone = false;
            isAborted = false;
            uploadPending = false;
            pendingRedirect = null;
            logEpoch++;

            requestMethod = String(method).toUpperCase();
            requestUrl = url instanceof NativeURL ? url.href : String(url);
            requestAbsUrl = resolveUrl(requestUrl);
            sourceUrl = requestUrl;
            sourceAbsUrl = requestAbsUrl;
            requestHeaders = {};
            openMethod = method;
            openRest = args;
            requestHeaderList = [];
            redirectHandled = false;
            mockResponseHeaders = null;
            // Q-12: 3rd arg is `async`, defaulting to true only when omitted.
            // PER-46: when passed it converts to a boolean, as natively —
            // open(m, u, undefined) is synchronous. `!== false` made it async.
            requestIsAsync = args.length === 0 ? true : !!args[0];

            let finalUrl = url;

            // Redirect pre-match (url+method only) so we can rewrite the
            // URL passed to originalOpen. Request headers do not exist yet at
            // open() — setRequestHeader() runs after it — so a header or
            // GraphQL condition cannot be evaluated at this point.
            //
            // CQ-4: background.js validateRule() rejects a redirect rule
            // carrying a header condition, so url+method is sufficient to
            // decide whether a redirect rule matches.
            //
            // PER-10: but it is not sufficient to decide that the redirect
            // is the FIRST match. This used to scan redirect rules only, so
            // a mock or block above a broader redirect lost to it on XHR
            // while winning on fetch. It now runs the normal first-match
            // over every rule type and redirects only when the winner is a
            // redirect. If a rule above it has a header or GraphQL
            // condition, the decision waits for send(), which can judge it.
            // P-10c: skip the scan entirely when no enabled redirect rule exists.
            if (tmState.active && tmState._hasRedirectRules) {
                const first = findRule({
                    url: requestAbsUrl, method: requestMethod, headers: EMPTY_HEADERS, bodyText: null
                }, requestUrl);

                if (first && (first.type || 'mock') === 'redirect' &&
                    !conditionalRuleAhead(first, requestAbsUrl, requestUrl, requestMethod) &&
                    relayAlive()) {
                    const newUrl = computeRedirectUrl(requestAbsUrl, first, requestUrl);
                    log(`Redirecting XHR ${requestMethod} ${requestUrl} -> ${newUrl} (Rule: ${first.name})`);
                    pendingRedirect = { rule: first, url: requestAbsUrl, redirectedTo: newUrl };
                    finalUrl = newUrl;
                    requestUrl = newUrl;
                    requestAbsUrl = resolveUrl(newUrl);
                    redirectHandled = true;
                }
            }

            return reflectApply(originalOpen, this, [method, finalUrl, ...args]);
        });

        // Override abort
        defineOwn(xhr, 'abort', function abort() {
            if (!isMocked) return reflectApply(originalAbort, this, arguments);

            generation++;
            clearTimers();
            cancelPatchFetch();
            isAborted = true;

            if (mockDone) {
                // PER-39: abort() after the response completed fires no
                // event, natively — it only returns the object to UNSENT
                // with an empty, network-error response. Mocks fired abort
                // and a second loadend.
                clearOverrides();
                mockResponseHeaders = objectCreate(null);
                setState('readyState', 0);
                return undefined;
            }

            // PER-39: in flight, the request error steps run with readyState
            // DONE (readystatechange first, which mocks skipped), then the
            // object is UNSENT.
            failRequest('abort');
            setState('readyState', 0);
            return undefined;
        });

        // Override getResponseHeader/getAllResponseHeaders so mocked
        // responses expose the rule's response headers (Q-7) instead of
        // silently dropping them (only meaningful once mocked; otherwise
        // pass through to the real network response headers untouched).
        defineOwn(xhr, 'getResponseHeader', function getResponseHeader(name) {
            if (isMocked && mockResponseHeaders) {
                const value = headerValue(mockResponseHeaders, String(name).toLowerCase());
                return value !== undefined ? String(value) : null;
            }
            return reflectApply(originalGetResponseHeader, this, arguments);
        });

        defineOwn(xhr, 'getAllResponseHeaders', function getAllResponseHeaders() {
            if (isMocked && mockResponseHeaders) {
                const keys = objectKeys(mockResponseHeaders);
                let text = '';
                for (let i = 0; i < keys.length; i++) {
                    text += `${lower(keys[i])}: ${mockResponseHeaders[keys[i]]}\r\n`;
                }
                return text;
            }
            return reflectApply(originalGetAllResponseHeaders, this, arguments);
        });

        // Override send — this is where matching now happens (headers + body are only known here)
        defineOwn(xhr, 'send', function send(body) {
            if (isAborted) return undefined;

            if (!tmState.active) {
                return reflectApply(originalSend, this, arguments);
            }
            sendStart = Date.now();

            // Chaos Mode check (moved from open()) — network requests only (PER-48).
            if (tmState.settings?.chaosMode?.enabled && isNetworkUrl(requestAbsUrl) &&
                getSecureRandom() < (tmState.settings.chaosMode.failureRate || 0.1) &&
                relayAlive()) {
                log(`Chaos Mode: Blocked XHR ${requestUrl}`);
                takeOver(body);
                mockTimeout = later(() => {
                    mockTimeout = null;
                    logChaos(requestAbsUrl, requestMethod, sendStart);
                    failRequest('error');
                }, 100);
                return undefined;
            }

            // F3: the request-body pass, before the main first-match below,
            // which then matches the new body. It runs before the redirect
            // open() applied, so a redirect sends the new body too; it
            // matches the URL as the page opened it.
            let sendArgs = arguments;
            if (tmState._hasRequestBodyRules && requestMethod !== 'GET' && requestMethod !== 'HEAD') {
                const bodyRule = findRule({
                    url: sourceAbsUrl, method: requestMethod, headers: requestHeaders, bodyText: xhrBodyText(body)
                }, sourceUrl, findMatchingRequestBodyRule);
                const rewritten = bodyRule && relayAlive()
                    ? rewriteRequestBody(bodyRule, body, { __proto__: null, url: sourceAbsUrl, method: requestMethod })
                    : null;
                if (rewritten) {
                    log(`${rewritten.note}: XHR ${requestMethod} ${sourceUrl} (Rule: ${bodyRule.name})`);
                    if (rewritten.changed) {
                        body = rewritten.body;
                        sendArgs = [body];
                        if (rewritten.json && headerValue(requestHeaders, 'content-type') === undefined) {
                            reflectApply(originalSetRequestHeader, xhr, ['Content-Type', 'application/json']);
                            requestHeaders['content-type'] = 'application/json';
                            requestHeaderList[requestHeaderList.length] = ['Content-Type', 'application/json'];
                        }
                    }
                    logAtLoadend(bodyRule, sourceAbsUrl, requestMethod, { __proto__: null, startedAt: sendStart, note: rewritten.note });
                }
            }

            // A redirect rule was already applied (URL rewritten) in open() —
            // the real network call now goes to the redirected URL; it is
            // logged when that response settles (PER-56).
            if (redirectHandled) {
                if (pendingRedirect) {
                    logAtLoadend(pendingRedirect.rule, pendingRedirect.url, requestMethod,
                        { startedAt: sendStart, redirectedTo: pendingRedirect.redirectedTo });
                    pendingRedirect = null;
                }
                return reflectApply(originalSend, this, sendArgs);
            }

            const bodyText = xhrBodyText(body);

            const rule = findRule({
                url: requestAbsUrl,
                method: requestMethod,
                headers: requestHeaders,
                bodyText
            }, requestUrl);

            if (!rule || !relayAlive()) {
                // No rule applies, so this response is a capture candidate.
                // XHR has no clone(), but reading responseText after the
                // fact is non-destructive — unlike a fetch body stream.
                if (isCaptureArmed()) {
                    xhr.addEventListener('load', function onCaptureLoad() {
                        xhr.removeEventListener('load', onCaptureLoad);
                        try {
                            const ct = xhr.getResponseHeader('content-type') || '';
                            if (!CAPTURE_TEXTUAL.test(ct)) return;
                            // responseText throws for arraybuffer/blob types.
                            const rt = (xhr.responseType === '' || xhr.responseType === 'text')
                                ? xhr.responseText
                                : null;
                            if (typeof rt !== 'string' || rt.length > CAPTURE_MAX_BODY) return;

                            const headers = {};
                            (xhr.getAllResponseHeaders() || '').trim().split(/[\r\n]+/).forEach((line) => {
                                const i = line.indexOf(':');
                                if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
                            });

                            emitCapture({
                                ts: Date.now(),
                                url: sanitizeUrlForLog(requestUrl),
                                method: requestMethod,
                                status: xhr.status,
                                statusText: xhr.statusText,
                                contentType: ct,
                                headers,
                                body: rt
                            });
                        } catch (e) {
                            // Best-effort only.
                        }
                    });
                }
                return reflectApply(originalSend, this, sendArgs);
            }

            const effectiveType = rule.type || 'mock';

            // PER-10: open() left this redirect undecided because a
            // conditional rule above it needed the headers or body (or the
            // rules changed in between). Re-opening an OPENED XHR fires no
            // event and keeps withCredentials, timeout and responseType;
            // it does clear the request headers, so they are replayed.
            if (effectiveType === 'redirect') {
                const newUrl = computeRedirectUrl(requestAbsUrl, rule, requestUrl);
                log(`Redirecting XHR ${requestMethod} ${requestUrl} -> ${newUrl} (Rule: ${rule.name})`);
                logAtLoadend(rule, requestAbsUrl, requestMethod, { startedAt: sendStart, redirectedTo: newUrl });
                reflectApply(originalOpen, xhr, [openMethod, newUrl, ...openRest]);
                for (let i = 0; i < requestHeaderList.length; i++) {
                    reflectApply(originalSetRequestHeader, xhr, requestHeaderList[i]);
                }
                requestUrl = newUrl;
                requestAbsUrl = resolveUrl(newUrl);
                redirectHandled = true;
                return reflectApply(originalSend, this, sendArgs);
            }

            // Q-12: synchronous XHR (open(..., false)) blocks the calling
            // thread inside this very call — none of the setTimeout-based
            // delivery below can run before the caller reads
            // status/responseText immediately after send() returns. Only
            // the paths that can be delivered synchronously are honored;
            // anything that inherently needs async work (patch mode's
            // real fetch, an explicit delay) falls back to a real
            // synchronous network call rather than silently doing nothing.
            if (!requestIsAsync) {
                if (effectiveType === 'block') {
                    takeOver(body);
                    logInterception(rule, requestUrl, requestMethod, 0);
                    failRequest('error');
                    return undefined;
                }

                if (effectiveType === 'mock' && ((rule.response && rule.response.mode) || 'static') === 'static') {
                    const cfg = getResponseConfig(rule);
                    let responseText = '';
                    if (!hasNoBody(cfg.statusCode, requestMethod)) {
                        responseText = renderBody(cfg.body, { url: requestAbsUrl, method: requestMethod });
                    }
                    takeOver(body);
                    logInterception(rule, requestUrl, requestMethod, cfg.statusCode);
                    finishMock(responseText, cfg.statusCode, cfg.statusText, buildMockHeaders(cfg.headers, rule));
                    return undefined;
                }

                // delay / patch / anything else can't be honored without
                // blocking the thread — pass through to a real synchronous request.
                log(`Rule "${rule.name}" (type ${effectiveType}) cannot be mocked on a synchronous XHR; passing through`);
                return reflectApply(originalSend, this, sendArgs);
            }

            if (effectiveType === 'block') {
                log(`Blocked XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name})`);
                takeOver(body);
                logInterception(rule, requestUrl, requestMethod, 0);
                mockTimeout = later(() => { mockTimeout = null; failRequest('error'); }, 10);
                return undefined;
            }

            if (effectiveType === 'delay') {
                log(`Delaying XHR ${requestMethod} ${requestUrl} by ${rule.delayMs}ms (Rule: ${rule.name})`);
                // Not takeOver(): see its comment — the native send() below
                // fires this request's loadstart (and upload events), once,
                // when it leaves.
                isMocked = true;
                logAtLoadend(rule, requestAbsUrl, requestMethod, { startedAt: sendStart });

                // PER-17: the hold counts toward xhr.timeout. A delay of at
                // least the timeout times out at the timeout, as the real
                // request would have; a shorter one hands the native request
                // only the time left. The hold used to be free, so axios
                // `timeout: 1000` against a 3 s delay rule succeeded.
                let limit = 0;
                try { limit = xhr.timeout; } catch (e) { /* no timeout */ }
                if (limit > 0 && rule.delayMs >= limit) {
                    timeoutTimer = later(() => { timeoutTimer = null; failRequest('timeout'); }, limit);
                    return undefined;
                }
                mockTimeout = later(() => {
                    mockTimeout = null;
                    isMocked = false; // hand off to the real network request
                    let current = 0;
                    try { current = xhr.timeout; } catch (e) { /* no timeout */ }
                    passTimeoutBudget(current, Date.now() - sendStart);
                    reflectApply(originalSend, xhr, [body]);
                }, rule.delayMs);
                return undefined;
            }

            if (effectiveType === 'mock') {
                const cfg = getResponseConfig(rule);

                if (cfg.mode === 'patch') {
                    takeOver(body);
                    runPatchFlow(rule, body);
                    return undefined;
                }

                // F4: off in Settings, or refused by the page's CSP, is
                // known now — the native send() takes the request as is.
                if (cfg.mode === 'code') {
                    const fn = codeFunction(rule, cfg.code);
                    if (typeof fn !== 'function') {
                        log(`Code response not served for XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name}): ${fn.note}`);
                        logAtLoadend(rule, requestAbsUrl, requestMethod, { __proto__: null, startedAt: sendStart, note: fn.note });
                        return reflectApply(originalSend, this, sendArgs);
                    }
                    takeOver(body);
                    runCodeFlow(rule, fn, body);
                    return undefined;
                }

                // mode === 'static'
                log(`Intercepted XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name})`);
                takeOver(body);
                logInterception(rule, requestUrl, requestMethod, cfg.statusCode);
                runStaticMockFlow(rule);
                return undefined;
            }

            // Anything else — passthrough.
            return reflectApply(originalSend, this, sendArgs);
        });

        // Override setRequestHeader — record it AND always call through so
        // headers still reach the network for the passthrough case.
        defineOwn(xhr, 'setRequestHeader', function setRequestHeader(name, value) {
            requestHeaders[String(name).toLowerCase()] = value;
            requestHeaderList.push([name, value]);
            return reflectApply(originalSetRequestHeader, this, arguments);
        });
    }

    // --- SYNC STATE ---
    // Transport note: see the header comment and content/content.js — this is
    // a nonce-keyed CustomEvent on `document`, not window.postMessage/'message'.
    function onSyncState(event) {
        // Contract B: through the captured `detail` getter — a page that
        // wrapped CustomEvent.prototype's would get the whole payload.
        const payload = eventDetail(event);

        // Validate payload
        if (!payload || typeof payload !== 'object') {
            console.warn('Invalid state payload received');
            return;
        }
        if (orphaned) return;

        // Contract B: copied into null-prototype objects and arrays, read
        // through own properties only. The rule list carries its own
        // iterator for the matcher's for...of.
        const rules = ownValue(payload, 'rules');
        const settings = ownValue(payload, 'settings');
        tmState.active = ownValue(payload, 'active') !== false;
        tmState.rules = toNullProto(isArray(rules) ? rules : [], true);
        tmState.settings = settings && typeof settings === 'object' ? toNullProto(settings, true) : objectCreate(null);

        // Recompute derived flags once per sync rather than per request.
        // PER-2: index loops and captured built-ins, so no page-replaceable
        // Array.prototype method is handed the rule list.
        let usesHeaders = false;
        let usesGraphQL = false;
        let hasRedirect = false;
        let hasRequestBody = false;
        const synced = tmState.rules;
        for (let i = 0; i < synced.length; i++) {
            const r = synced[i];
            if (!r || !r.enabled) continue;
            if (r.match && r.match.headers && objectKeys(r.match.headers).length > 0) usesHeaders = true;
            if (r.match && r.match.graphql && r.match.graphql.operationName) usesGraphQL = true;
            if ((r.type || 'mock') === 'redirect') hasRedirect = true;
            if (r.type === 'requestBody') hasRequestBody = true;
        }
        tmState._anyRuleUsesHeaders = usesHeaders;
        tmState._anyRuleUsesGraphQL = usesGraphQL;
        tmState._hasRedirectRules = hasRedirect;
        tmState._hasRequestBodyRules = hasRequestBody && typeof findMatchingRequestBodyRule === 'function';

        if (tmState.settings.debugMode) {
            log('State synced:', {
                active: tmState.active,
                rulesCount: tmState.rules.length,
                settings: tmState.settings
            });
        }
    }

    // One-shot handshake: the relay hands over this frame's nonce, we bind the
    // real listener to the nonced name, then stop listening on the fixed one so
    // a later page script cannot re-key the channel by dispatching its own
    // bootstrap event.
    function onBootstrap(event) {
        document.removeEventListener(BOOTSTRAP_EVENT, onBootstrap, true);
        const nonce = ownValue(eventDetail(event), 'nonce');
        if (typeof nonce !== 'string' || !nonce) return;

        // PER-1: tell the relay the nonce landed. When this script ran first,
        // the relay's own bootstrap is the handover, and this is how it knows
        // to stop answering "ready" — which a page script could otherwise
        // replay after load to have the nonce broadcast again.
        if (event.cancelable) event.preventDefault();

        SYNC_STATE_EVENT = '__splicetap_sync_state__:' + nonce;
        LOG_INTERCEPTION_EVENT = '__splicetap_log__:' + nonce;
        CAPTURE_EVENT = '__splicetap_capture__:' + nonce;
        PING_EVENT = '__splicetap_ping__:' + nonce;
        DEACTIVATE_EVENT = '__splicetap_deactivate__:' + nonce;
        document.addEventListener(SYNC_STATE_EVENT, onSyncState, true);
        document.addEventListener(DEACTIVATE_EVENT, onDeactivate, true);
    }

    // PER-32: the relay's extension was reloaded, updated or removed. The
    // tab keeps this script, but no rule change or OFF switch can reach it
    // any more, so it stops intercepting and drops what it holds.
    function onDeactivate() {
        orphaned = true;
        tmState.active = false;
        tmState.rules = [];
        tmState.settings = {};
        tmState._anyRuleUsesHeaders = false;
        tmState._anyRuleUsesGraphQL = false;
        tmState._hasRedirectRules = false;
        tmState._hasRequestBodyRules = false;
        document.removeEventListener(SYNC_STATE_EVENT, onSyncState, true);
        log('Extension context gone; interception stopped for this page');
    }

    document.addEventListener(BOOTSTRAP_EVENT, onBootstrap, true);

    // Announce ourselves so the relay can hand the nonce over even if it ran
    // before this script did. Carries no payload — it is purely a "listener is
    // bound now" signal, so nothing is disclosed if the page observes it.
    document.dispatchEvent(new CustomEvent('__splicetap_ready__'));

    log(spliceTapGlobalsReady ? 'Interceptor injected and active' : 'Interceptor injected but INACTIVE (missing shared modules)');

})();
