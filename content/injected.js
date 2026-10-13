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
    const matchUrl = sharedMatcher && sharedMatcher.matchUrl;
    const isCatastrophicRegex = sharedMatcher && sharedMatcher.isCatastrophicRegex;
    const processDynamicResponse = sharedPlaceholders && sharedPlaceholders.processDynamicResponse;
    const jsonMergePatch = sharedPatch && sharedPatch.jsonMergePatch;

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

    // State
    let tmState = {
        active: true,
        rules: [],
        settings: {},
        // Derived flags, recomputed whenever rules are synced (perf: avoid
        // rescanning/reallocating on every single request — P-1/P-3/P-10/P-16).
        _anyRuleUsesHeaders: false,
        _anyRuleUsesGraphQL: false,
        _hasRedirectRules: false
    };

    // Helper: Logging with debug mode check
    function log(msg, ...args) {
        if (tmState.settings?.debugMode) {
            console.log(`%c[SpliceTap] ${msg}`, 'color: #2563eb; font-weight: bold;', ...args);
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

    function emitCapture(entry) {
        if (!CAPTURE_EVENT) return;
        document.dispatchEvent(new CustomEvent(CAPTURE_EVENT, { detail: entry }));
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

            const clone = response.clone();
            const text = await clone.text();
            if (text.length > CAPTURE_MAX_BODY) return;

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
    function logInterception(rule, url, method, status) {
        // Null until the bootstrap handshake completes. Dispatching on a null
        // name would throw inside the interception path and break the request.
        if (!LOG_INTERCEPTION_EVENT) return;
        document.dispatchEvent(new CustomEvent(LOG_INTERCEPTION_EVENT, {
            detail: {
                ts: Date.now(),
                url: sanitizeUrlForLog(url),
                method,
                ruleId: rule.id,
                ruleName: rule.name,
                ruleType: rule.type || 'mock',
                status
            }
        }));
    }

    // Helper: redact obviously-sensitive query parameter values and cap length
    // before a URL is persisted into the interception log (S-8). Best-effort:
    // if the URL can't be parsed, log it as-is rather than throwing.
    const SENSITIVE_QUERY_KEY_RE = /^(access_token|token|api[_-]?key|apikey|key|secret|password|pwd|auth|authorization|session|sid)$/i;
    const MAX_LOGGED_URL_LENGTH = 2000;
    function sanitizeUrlForLog(rawUrl) {
        let safeUrl = rawUrl;
        try {
            const parsed = new NativeURL(rawUrl, baseUrl());
            parsed.searchParams.forEach((value, key) => {
                if (SENSITIVE_QUERY_KEY_RE.test(key)) {
                    parsed.searchParams.set(key, '[redacted]');
                }
            });
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
     */
    function findRule(request, rawUrl) {
        const rules = tmState.rules;
        const hit = findMatchingRule(rules, request);
        if (rawUrl === request.url) return hit;

        const rawHit = findMatchingRule(rules, {
            url: rawUrl, method: request.method, headers: request.headers, bodyText: request.bodyText
        });
        if (!hit || !rawHit || hit === rawHit) return hit || rawHit;
        for (let i = 0; i < rules.length; i++) {
            if (rules[i] === hit) return hit;
            if (rules[i] === rawHit) return rawHit;
        }
        return hit;
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
            if (!rule || !rule.enabled) continue;
            const match = rule.match || {};
            const conditional = (match.headers && objectKeys(match.headers).length > 0) ||
                (match.graphql && match.graphql.operationName);
            if (!conditional) continue;
            const ruleMethod = String(match.method || '*').toUpperCase();
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
        if (PING_EVENT) document.dispatchEvent(new CustomEvent(PING_EVENT));
        return !orphaned;
    }

    // PER-12: a header value must be a ByteString. A rule name with any
    // character above U+00FF made `new Headers()` throw, and the fallback
    // then dropped every header the mock set. Printable ASCII is sent as is;
    // anything else is percent-encoded (decodeURIComponent restores it).
    const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
    function ruleMarker(name) {
        const value = name === undefined || name === null ? '' : String(name);
        if (PRINTABLE_ASCII.test(value)) return value;
        try {
            return encodeURIComponent(value);
        } catch (e) {
            // A lone surrogate cannot be encoded.
            return value.replace(/[^\x20-\x7E]/g, '?');
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

    // Helper: resolve rule.response with defaults so a legacy/hand-written
    // rule missing the `response` object entirely (or missing individual
    // fields) never throws (Q-5). Does not change the documented schema
    // Only fills in what a well-formed rule would have had.
    function getResponseConfig(rule) {
        const r = rule.response || {};
        return {
            mode: r.mode || 'static',
            body: r.body !== undefined ? r.body : {},
            patch: r.patch !== undefined ? r.patch : {},
            delay: r.delay || 0,
            statusCode: r.statusCode || 200,
            // The background fills a missing reason phrase from the status
            // code when it normalises stored rules (storage.normalizeRule), so
            // this fallback only covers a rule that somehow lacks one. It used
            // to be 'OK' whatever the code — a 404 mock reported "OK".
            // An explicit '' is kept: HTTP/2 responses have no reason phrase,
            // so a rule captured from one is faithful with an empty string.
            statusText: r.statusText !== undefined ? r.statusText : ((r.statusCode || 200) === 200 ? 'OK' : ''),
            headers: r.headers
        };
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
        if (typeof pattern === 'string' && pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
            const regexBody = pattern.slice(1, -1);
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
                const regex = new RegExp(regexBody, 'i');
                const match = regex.exec(sourceUrl) ||
                    (rawUrl !== undefined && rawUrl !== sourceUrl ? regex.exec(rawUrl) : null);
                if (!match) return destination;
                return destination.replace(/\$(\d)/g, (ref, digit) => {
                    const n = Number(digit);
                    // $0 and references past the last group stay literal, as
                    // they do in String.replace.
                    if (n === 0 || n >= match.length) return ref;
                    return match[n] === undefined ? '' : match[n];
                });
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

    // --- Response construction helpers (Q-2, Q-24, Q-28) ---

    // Statuses the Fetch spec forbids from carrying a body at all.
    const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

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
                if (String(names[i]).toLowerCase() === 'content-type') droppedContentType = true;
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
    function withDefaultContentType(userHeaders) {
        const headers = objectAssign({}, userHeaders || {});
        const names = objectKeys(headers);
        let hasContentType = false;
        for (let i = 0; i < names.length; i++) {
            if (names[i].toLowerCase() === 'content-type') hasContentType = true;
        }
        if (!hasContentType) headers['Content-Type'] = 'application/json';
        return headers;
    }

    function buildMockResponse(bodyText, status, statusText, headersInit) {
        const numericStatus = Number.isFinite(status) ? status : 200;
        const inRange = numericStatus >= 200 && numericStatus <= 599;
        const nullBody = NULL_BODY_STATUSES.has(numericStatus) || !inRange;
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

        if (constructStatus !== numericStatus) {
            try {
                Object.defineProperty(response, 'status', { value: numericStatus, configurable: true });
                Object.defineProperty(response, 'ok', {
                    value: numericStatus >= 200 && numericStatus < 300, configurable: true
                });
            } catch (e) {
                // Environment won't allow the override — keep the constructed status/ok.
            }
        }
        return response;
    }

    const EMPTY_HEADERS = Object.freeze({});

    // --- XHR delivery helpers (PER-16, PER-40, PER-47, PER-52) ---

    /** The type/subtype of a Content-Type value, lowercased ('' when absent). */
    function mimeEssence(contentType) {
        if (typeof contentType !== 'string') return '';
        const semi = contentType.indexOf(';');
        return (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
    }

    function isXmlMime(essence) {
        return essence === 'text/xml' || essence === 'application/xml' || /\+xml$/.test(essence);
    }

    /** A header's value from a plain header object, by name in any letter case. */
    function headerValue(headers, name) {
        if (!headers) return undefined;
        const names = objectKeys(headers);
        for (let i = 0; i < names.length; i++) {
            if (names[i].toLowerCase() === name) return headers[names[i]];
        }
        return undefined;
    }

    // PER-52: what a fetch mock already does — no body for 204/205/304, for
    // a status the Response constructor cannot carry, or for HEAD. An XHR
    // mock of a 204 delivered the configured body.
    function hasNoBody(status, method) {
        return method === 'HEAD' || NULL_BODY_STATUSES.has(status) || !(status >= 200 && status <= 599);
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
        const type = DOM_PARSER_TYPES.indexOf(essence) !== -1 ? essence : 'application/xml';
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
        window.fetch = function (...args) {
            if (!tmState.active || (tmState.rules.length === 0 && !isChaosModeActive() && !isCaptureArmed())) {
                return originalFetch.apply(this, args);
            }
            return handleInterceptedFetch.apply(this, args);
        };

        async function handleInterceptedFetch(...args) {
            const [resource, config] = args;
            const isRequestObj = resource instanceof NativeRequest;
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

            // 1. Chaos Mode Check
            if (tmState.settings?.chaosMode?.enabled) {
                if (getSecureRandom() < (tmState.settings.chaosMode.failureRate || 0.1) && relayAlive()) {
                    log(`Chaos Mode: Blocked ${url}`);
                    return Promise.reject(new TypeError('Failed to fetch (SpliceTap Chaos Mode)'));
                }
            }

            // 2. Read request headers into a lowercase-keyed plain object —
            // only if some enabled rule actually has a header condition (P-3).
            const headers = tmState._anyRuleUsesHeaders
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

            // 4. Find matching rule
            const rule = findRule({ url, method, headers, bodyText }, rawUrl);
            if (!rule || !relayAlive()) {
                // Nothing to apply — but this is exactly the response worth
                // capturing, since a rule for it does not exist yet.
                if (isCaptureArmed()) {
                    const passed = await originalFetch.apply(this, args);
                    captureFetchResponse(passed, url, method);
                    return passed;
                }
                return originalFetch.apply(this, args);
            }

            const effectiveType = rule.type || 'mock';

            // 5. Branch on rule.type
            if (effectiveType === 'block') {
                log(`Blocked ${method} ${url} (Rule: ${rule.name})`);
                logInterception(rule, url, method, 0);
                return Promise.reject(new TypeError('Failed to fetch'));
            }

            if (effectiveType === 'delay') {
                log(`Delaying ${method} ${url} by ${rule.delayMs}ms (Rule: ${rule.name})`);
                logInterception(rule, url, method, null);
                await sleepAbortable(rule.delayMs, signal);
                return originalFetch.apply(this, args);
            }

            if (effectiveType === 'redirect') {
                const newUrl = computeRedirectUrl(url, rule, rawUrl);
                log(`Redirecting ${method} ${url} -> ${newUrl} (Rule: ${rule.name})`);
                logInterception(rule, url, method, 302);
                if (!isRequestObj) return originalFetch.call(this, newUrl, config);
                // PER-11: `new Request(newUrl, resource)` carried the body over
                // as a stream, and Chrome refuses a streaming upload on
                // HTTP/1.1 — every redirected fetch(Request) with a body failed
                // with "Failed to fetch". Rebuild the init with a buffered body.
                const init = await requestInit(resource);
                return originalFetch.call(this, newUrl, config ? objectAssign(init, config) : init);
            }

            // effectiveType === 'mock'
            const cfg = getResponseConfig(rule);

            if (cfg.mode === 'patch') {
                const real = await originalFetch.apply(this, args);

                let data;
                try {
                    data = await real.clone().json();
                } catch (e) {
                    log('Patch mode: real response is not valid JSON, returning it unmodified', e);
                    return real;
                }

                const patchPayload = processDynamicResponse(cfg.patch, { url, method });
                const merged = jsonMergePatch(data, patchPayload);

                if (cfg.delay > 0) {
                    await sleepAbortable(cfg.delay, signal);
                }
                if (signal && signal.aborted) {
                    return Promise.reject(abortError());
                }

                const mergedHeaders = {};
                real.headers.forEach((value, key) => { mergedHeaders[key] = value; });
                mergedHeaders['x-splicetap'] = 'true';
                mergedHeaders['x-splicetap-rule'] = ruleMarker(rule.name);

                log(`Patched ${method} ${url} (Rule: ${rule.name})`);
                logInterception(rule, url, method, real.status);

                const patchedResponse = buildMockResponse(jsonStringify(merged), real.status, real.statusText, mergedHeaders);
                // Q-28: a freshly constructed Response can't carry these, but
                // patch mode is "the real response, plus a merge" — best-effort
                // restore them from the real response.
                try {
                    Object.defineProperty(patchedResponse, 'url', { value: real.url, configurable: true });
                    Object.defineProperty(patchedResponse, 'redirected', { value: real.redirected, configurable: true });
                    Object.defineProperty(patchedResponse, 'type', { value: real.type, configurable: true });
                } catch (e) {
                    // ignore if the environment won't allow the override
                }
                return patchedResponse;
            }

            // mode === 'static' (existing behavior)
            log(`Intercepted ${method} ${url} (Rule: ${rule.name})`);

            if (cfg.delay > 0) {
                await sleepAbortable(cfg.delay, signal);
            }
            if (signal && signal.aborted) {
                return Promise.reject(abortError());
            }

            const body = processDynamicResponse(cfg.body, { url, method });
            const responseBody = typeof body === 'string' ? body : jsonStringify(body);

            const headerObj = withDefaultContentType(cfg.headers);
            headerObj['x-splicetap'] = 'true';
            headerObj['x-splicetap-rule'] = ruleMarker(rule.name);

            logInterception(rule, url, method, cfg.statusCode);

            const mocked = buildMockResponse(responseBody, cfg.statusCode, cfg.statusText, headerObj);
            // A constructed Response has an empty `url`. Real ones report the
            // URL that was fetched, and code that logs it or resolves relative
            // links against it saw "" from a mock. Patch mode already restores
            // this (Q-28); static mocks now match.
            try {
                Object.defineProperty(mocked, 'url', { value: new NativeURL(url).href, configurable: true });
            } catch (e) {
                // Environment won't allow the override — leave it empty.
            }
            return mocked;
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
            const status = cfg.statusCode;
            const statusText = cfg.statusText;
            let responseText = '';
            if (!hasNoBody(status, requestMethod)) {
                const bodyContent = processDynamicResponse(cfg.body, { url: requestAbsUrl, method: requestMethod });
                responseText = typeof bodyContent === 'string' ? bodyContent : jsonStringify(bodyContent);
            }
            const totalBytes = responseText.length;
            const delay = cfg.delay;
            const headers = buildMockHeaders(cfg.headers, rule);

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

            // After the delivery timer, so a timeout equal to the delay loses.
            armTimeout();
        }

        // Patch mode: one real request through fetch, merged and delivered.
        function runPatchFlow(rule, body) {
            const cfg = getResponseConfig(rule);
            const gen = generation;
            armTimeout();

            (async () => {
                // PER-13: the request has been sent once, below, and is never
                // sent again. Every failure used to fall back to
                // originalSend(), so a non-JSON or empty response (text, a
                // 204) reached the server twice.
                let real;
                let rawBody;
                try {
                    // S-7/Q-18: map withCredentials instead of hard-coding
                    // 'include'. QA-6: with a signal, so xhr.abort() cancels
                    // the request itself, not just its delivery.
                    patchAbort = new AbortController();
                    real = await originalFetch(requestUrl, {
                        method: requestMethod,
                        headers: requestHeaders,
                        body: body ?? undefined,
                        credentials: xhr.withCredentials ? 'include' : 'same-origin',
                        signal: patchAbort.signal
                    });
                    rawBody = await real.arrayBuffer();
                } catch (error) {
                    // A network failure, as the native XHR would have seen it.
                    if (gen !== generation || mockDone) return;
                    log('XHR patch mode: the request failed:', error);
                    failRequest('error');
                    return;
                }
                if (gen !== generation || mockDone) return;
                patchAbort = null;

                const realText = new TextDecoder().decode(rawBody);
                const realHeaders = {};
                real.headers.forEach((value, key) => { realHeaders[key] = value; });

                let mergedText;
                try {
                    const data = jsonParse(realText);
                    const patchPayload = processDynamicResponse(cfg.patch, { url: requestAbsUrl, method: requestMethod });
                    mergedText = jsonStringify(jsonMergePatch(data, patchPayload));
                } catch (error) {
                    // Not JSON (or nothing to merge into): deliver the real
                    // response unchanged, as fetch does.
                    log('XHR patch mode: real response is not valid JSON, delivering it unmodified', error);
                    finishMock(realText, real.status, real.statusText, realHeaders, rawBody, real.url);
                    return;
                }

                const mergedHeaders = realHeaders;
                mergedHeaders['x-splicetap'] = 'true';
                mergedHeaders['x-splicetap-rule'] = ruleMarker(rule.name);

                log(`Patched XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name})`);
                logInterception(rule, requestAbsUrl, requestMethod, real.status);

                finishMock(mergedText, real.status, real.statusText || 'OK', mergedHeaders, undefined, real.url);
            })();
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

            requestMethod = String(method).toUpperCase();
            requestUrl = url instanceof NativeURL ? url.href : String(url);
            requestAbsUrl = resolveUrl(requestUrl);
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
                    logInterception(first, requestAbsUrl, requestMethod, 302);
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
                    text += `${keys[i].toLowerCase()}: ${mockResponseHeaders[keys[i]]}\r\n`;
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

            // Chaos Mode check (moved from open())
            if (tmState.settings?.chaosMode?.enabled &&
                getSecureRandom() < (tmState.settings.chaosMode.failureRate || 0.1) &&
                relayAlive()) {
                log(`Chaos Mode: Blocked XHR ${requestUrl}`);
                takeOver(body);
                mockTimeout = later(() => { mockTimeout = null; failRequest('error'); }, 100);
                return undefined;
            }

            // A redirect rule was already applied (URL rewritten) in open() —
            // the real network call now goes to the redirected URL, nothing more to do here.
            if (redirectHandled) {
                return reflectApply(originalSend, this, arguments);
            }

            // Q-17: handle non-string bodies (URLSearchParams, the
            // graphql-upload FormData convention) instead of silently
            // defeating GraphQL matching.
            const bodyText = typeof body === 'string'
                ? body
                : (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
                    ? body.toString()
                    : (typeof FormData !== 'undefined' && body instanceof FormData && typeof body.get === 'function')
                        ? (typeof body.get('operations') === 'string' ? body.get('operations') : null)
                        : null;

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
                return reflectApply(originalSend, this, arguments);
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
                logInterception(rule, requestAbsUrl, requestMethod, 302);
                reflectApply(originalOpen, xhr, [openMethod, newUrl, ...openRest]);
                for (let i = 0; i < requestHeaderList.length; i++) {
                    reflectApply(originalSetRequestHeader, xhr, requestHeaderList[i]);
                }
                requestUrl = newUrl;
                requestAbsUrl = resolveUrl(newUrl);
                redirectHandled = true;
                return reflectApply(originalSend, this, arguments);
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
                        const bodyContent = processDynamicResponse(cfg.body, { url: requestAbsUrl, method: requestMethod });
                        responseText = typeof bodyContent === 'string' ? bodyContent : jsonStringify(bodyContent);
                    }
                    takeOver(body);
                    logInterception(rule, requestUrl, requestMethod, cfg.statusCode);
                    finishMock(responseText, cfg.statusCode, cfg.statusText, buildMockHeaders(cfg.headers, rule));
                    return undefined;
                }

                // delay / patch / anything else can't be honored without
                // blocking the thread — pass through to a real synchronous request.
                log(`Rule "${rule.name}" (type ${effectiveType}) cannot be mocked on a synchronous XHR; passing through`);
                return reflectApply(originalSend, this, arguments);
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
                logInterception(rule, requestUrl, requestMethod, null);

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

                // mode === 'static'
                log(`Intercepted XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name})`);
                takeOver(body);
                logInterception(rule, requestUrl, requestMethod, cfg.statusCode);
                runStaticMockFlow(rule);
                return undefined;
            }

            // Anything else — passthrough.
            return reflectApply(originalSend, this, arguments);
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
        const payload = event && event.detail;

        // Validate payload
        if (!payload || typeof payload !== 'object') {
            console.warn('Invalid state payload received');
            return;
        }
        if (orphaned) return;

        tmState.active = payload.active !== false;
        tmState.rules = isArray(payload.rules) ? payload.rules : [];
        tmState.settings = payload.settings || {};

        // Recompute derived flags once per sync rather than per request.
        // PER-2: index loops and captured built-ins, so no page-replaceable
        // Array.prototype method is handed the rule list.
        let usesHeaders = false;
        let usesGraphQL = false;
        let hasRedirect = false;
        const rules = tmState.rules;
        for (let i = 0; i < rules.length; i++) {
            const r = rules[i];
            if (!r || !r.enabled) continue;
            if (r.match && r.match.headers && objectKeys(r.match.headers).length > 0) usesHeaders = true;
            if (r.match && r.match.graphql && r.match.graphql.operationName) usesGraphQL = true;
            if ((r.type || 'mock') === 'redirect') hasRedirect = true;
        }
        tmState._anyRuleUsesHeaders = usesHeaders;
        tmState._anyRuleUsesGraphQL = usesGraphQL;
        tmState._hasRedirectRules = hasRedirect;

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
        const nonce = event && event.detail && event.detail.nonce;
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
