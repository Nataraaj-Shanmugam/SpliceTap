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
 * no longer contains any local copy of that logic.
 *
 * State transport note (P-13 / S-4 / C-5 / Q-14): state sync from
 * content/content.js (ISOLATED world) arrives via a namespaced CustomEvent
 * on `document` rather than `window.postMessage`/'message'. See the comment
 * at the top of content/content.js for why.
 */

(function () {
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

    const SYNC_STATE_EVENT = '__splicetap_sync_state__';
    const LOG_INTERCEPTION_EVENT = '__splicetap_log__';

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

    // Guard: the shared UMD modules must be present (loaded earlier in the
    // manifest's MAIN-world content_scripts array). If they're missing, log
    // once and leave fetch/XHR unpatched rather than throwing.
    const spliceTapGlobalsReady = !!(
        window.SpliceTapPlaceholders && typeof window.SpliceTapPlaceholders.processDynamicResponse === 'function' &&
        window.SpliceTapMatcher && typeof window.SpliceTapMatcher.findMatchingRule === 'function' &&
        window.SpliceTapPatch && typeof window.SpliceTapPatch.jsonMergePatch === 'function'
    );

    if (!spliceTapGlobalsReady) {
        console.error(
            '[SpliceTap] Required globals (SpliceTapPlaceholders / SpliceTapMatcher / SpliceTapPatch) were not found. ' +
            'fetch/XHR interception is disabled for this page load.'
        );
    }

    // Helper: report an applied rule to content.js -> background (1.5 step 1)
    function logInterception(rule, url, method, status) {
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
            const parsed = new URL(rawUrl, window.location.href);
            let redacted = false;
            parsed.searchParams.forEach((value, key) => {
                if (SENSITIVE_QUERY_KEY_RE.test(key)) {
                    parsed.searchParams.set(key, '[redacted]');
                    redacted = true;
                }
            });
            safeUrl = redacted ? parsed.toString() : rawUrl;
        } catch (e) {
            safeUrl = rawUrl;
        }
        if (typeof safeUrl === 'string' && safeUrl.length > MAX_LOGGED_URL_LENGTH) {
            safeUrl = safeUrl.slice(0, MAX_LOGGED_URL_LENGTH) + '…[truncated]';
        }
        return safeUrl;
    }

    // Helper: sleep
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
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
            statusText: r.statusText || 'OK',
            headers: r.headers
        };
    }

    // Helper: compute the destination URL for a redirect rule (supports $1..$9
    // capture references when match.url is a /regex/ pattern). Consistent with
    // src/matcher.js's matchUrl: the /regex/ delimited form is the only branch
    // that supports capture substitution here (there is no separate wildcard
    // branch to mis-order relative to it — a wildcard pattern simply falls
    // through to the plain destination, same as a substring pattern).
    function computeRedirectUrl(sourceUrl, rule) {
        const destination = (rule.redirect && rule.redirect.destination) || sourceUrl; // Q-5: missing rule.redirect
        const pattern = rule.match && rule.match.url;
        if (typeof pattern === 'string' && pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
            const regexBody = pattern.slice(1, -1);
            try {
                return sourceUrl.replace(new RegExp(regexBody, 'i'), destination);
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

    // --- Response construction helpers (Q-2, Q-24, Q-28) ---

    // Statuses the Fetch spec forbids from carrying a body at all.
    const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

    // `new Headers(...)` throws on an invalid header name/value (Q-24, e.g. a
    // typo'd "Content Type" instead of "Content-Type"). Never let a bad rule
    // turn a mock into a network-level failure — fall back to a sane default.
    function buildHeadersSafe(headersInit) {
        try {
            return new Headers(headersInit);
        } catch (e) {
            log('Invalid response header name/value in rule, falling back to default headers', e);
            try {
                return new Headers({ 'Content-Type': 'application/json' });
            } catch (e2) {
                return new Headers();
            }
        }
    }

    // Build a fetch Response for an arbitrary mock/patch status, including
    // statuses the Response() constructor can't represent directly:
    // - 101/103/204/205/304 (and anything else) forbid a non-null body.
    // - anything outside [200, 599] makes the constructor itself throw.
    // Both cases previously made the returned promise REJECT instead of
    // resolving (Q-2), which XHR mocking of the same rule never suffered
    // from. We construct with a legal placeholder status when necessary and
    // override the visible `status`/`ok` afterwards.
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

    // --- INTERCEPTOR: FETCH ---
    if (spliceTapGlobalsReady) {
        const EMPTY_HEADERS = Object.freeze({});

        // Sync outer wrapper: P-1/P-2. Bails to the real fetch, with zero
        // extra allocation, before any promise/array/object is created, for
        // the common "installed but nothing to do" case. Chaos mode has no
        // rule dependency, so it must still gate this bail (correctness).
        window.fetch = function (...args) {
            if (!tmState.active || (tmState.rules.length === 0 && !isChaosModeActive())) {
                return originalFetch.apply(this, args);
            }
            return handleInterceptedFetch.apply(this, args);
        };

        async function handleInterceptedFetch(...args) {
            const [resource, config] = args;
            const isRequestObj = resource instanceof Request;
            const isURLObj = typeof URL !== 'undefined' && resource instanceof URL;
            // Q-6: fetch(new URL(...)) previously left `url` as a non-string
            // object, breaking matchUrl's .toLowerCase() and later crashing
            // logInterception's postMessage/CustomEvent with a DataCloneError.
            const url = isRequestObj ? resource.url : (isURLObj ? resource.href : String(resource));
            const method = ((config && config.method) || (isRequestObj && resource.method) || 'GET').toUpperCase();

            // Q-13: honor AbortController/signal on the mock/patch paths (the
            // real originalFetch calls below already honor it themselves).
            const signal = (config && config.signal) || (isRequestObj ? resource.signal : null);
            if (signal && signal.aborted) {
                return Promise.reject(abortError());
            }

            // 1. Chaos Mode Check
            if (tmState.settings?.chaosMode?.enabled) {
                if (getSecureRandom() < (tmState.settings.chaosMode.failureRate || 0.1)) {
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
            const rule = window.SpliceTapMatcher.findMatchingRule(tmState.rules, { url, method, headers, bodyText });
            if (!rule) {
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
                const newUrl = computeRedirectUrl(url, rule);
                log(`Redirecting ${method} ${url} -> ${newUrl} (Rule: ${rule.name})`);
                logInterception(rule, url, method, 302);
                const newResource = isRequestObj ? new Request(newUrl, resource) : newUrl;
                return originalFetch.call(this, newResource, config);
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

                const patchPayload = window.SpliceTapPlaceholders.processDynamicResponse(cfg.patch, { url, method });
                const merged = window.SpliceTapPatch.jsonMergePatch(data, patchPayload);

                if (cfg.delay > 0) {
                    await sleepAbortable(cfg.delay, signal);
                }
                if (signal && signal.aborted) {
                    return Promise.reject(abortError());
                }

                const mergedHeaders = {};
                real.headers.forEach((value, key) => { mergedHeaders[key] = value; });
                mergedHeaders['x-splicetap'] = 'true';
                mergedHeaders['x-splicetap-rule'] = rule.name;

                log(`Patched ${method} ${url} (Rule: ${rule.name})`);
                logInterception(rule, url, method, real.status);

                const patchedResponse = buildMockResponse(JSON.stringify(merged), real.status, real.statusText, mergedHeaders);
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

            const body = window.SpliceTapPlaceholders.processDynamicResponse(cfg.body, { url, method });
            const responseBody = typeof body === 'string' ? body : JSON.stringify(body);

            const headerObj = Object.assign({ 'Content-Type': 'application/json' }, cfg.headers || {});
            headerObj['x-splicetap'] = 'true';
            headerObj['x-splicetap-rule'] = rule.name;

            logInterception(rule, url, method, cfg.statusCode);

            return buildMockResponse(responseBody, cfg.statusCode, cfg.statusText, headerObj);
        }
    }

    // --- INTERCEPTOR: XHR (COMPLETE IMPLEMENTATION) ---
    if (spliceTapGlobalsReady) {
        window.XMLHttpRequest = function () {
            // P-1/P-10: bail to a pristine native XHR (zero added allocations,
            // zero own-property overrides) when there's nothing this instance
            // could ever need to do. Chaos mode has no rule dependency, so it
            // must still gate this bail (correctness).
            if (!tmState.active || (tmState.rules.length === 0 && !isChaosModeActive())) {
                return new originalXHR();
            }

            const xhr = new originalXHR();

            // Request tracking
            let requestUrl = '';
            let requestMethod = 'GET';
            let requestHeaders = {};
            let requestIsAsync = true; // Q-12: sync XHR (open(..., false)) needs different delivery
            let isMocked = false;      // true while WE own the response lifecycle for this request
            let redirectHandled = false; // true once open() rewrote the URL for a redirect rule
            let isAborted = false;
            let mockTimeout = null;
            let progressInterval = null;
            let mockResponseHeaders = null; // Q-7: headers exposed via getResponseHeader(All)?

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
                const merged = Object.assign({ 'Content-Type': 'application/json' }, userHeaders || {});
                merged['x-splicetap'] = 'true';
                merged['x-splicetap-rule'] = rule.name;
                return merged;
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
            // throughout (finishMock, runStaticMockFlow, abort, chaos, block,
            // timeout). Q-8: block/chaos/timeout now also dispatch
            // 'readystatechange' before their terminal event, matching load/
            // error/abort, so `onreadystatechange`-only code (readyState ===
            // 4 checks) sees those outcomes too.
            function finishMock(responseText, status, statusText, headers) {
                if (isAborted) return;
                try {
                    mockResponseHeaders = headers || {};

                    // Q-7: respect responseType instead of always returning text.
                    const responseType = xhr.responseType || '';
                    let responseValue = responseText;
                    if (responseType === 'json') {
                        try {
                            responseValue = responseText === '' ? null : JSON.parse(responseText);
                        } catch (e) {
                            responseValue = null;
                        }
                    } else if (responseType === 'arraybuffer' && typeof TextEncoder !== 'undefined') {
                        try {
                            responseValue = new TextEncoder().encode(responseText).buffer;
                        } catch (e) {
                            // keep text fallback
                        }
                    } else if (responseType === 'blob' && typeof Blob !== 'undefined') {
                        try {
                            responseValue = new Blob([responseText]);
                        } catch (e) {
                            // keep text fallback
                        }
                    }

                    Object.defineProperty(xhr, 'responseText', { value: responseText, writable: false, configurable: true });
                    Object.defineProperty(xhr, 'response', { value: responseValue, writable: false, configurable: true });
                    Object.defineProperty(xhr, 'status', { value: status, writable: false, configurable: true });
                    Object.defineProperty(xhr, 'statusText', { value: statusText, writable: false, configurable: true });
                    Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });

                    xhr.dispatchEvent(new Event('readystatechange'));
                    xhr.dispatchEvent(new ProgressEvent('load', {
                        lengthComputable: true,
                        loaded: responseText.length,
                        total: responseText.length
                    }));
                    xhr.dispatchEvent(new ProgressEvent('loadend', {
                        lengthComputable: true,
                        loaded: responseText.length,
                        total: responseText.length
                    }));
                } catch (error) {
                    console.error('Error processing mock response:', error);

                    Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
                    xhr.dispatchEvent(new ProgressEvent('error'));
                    xhr.dispatchEvent(new ProgressEvent('loadend'));
                } finally {
                    if (mockTimeout) {
                        clearTimeout(mockTimeout);
                        mockTimeout = null;
                    }
                    if (progressInterval) {
                        clearInterval(progressInterval);
                        progressInterval = null;
                    }
                }
            }

            // Static-mock flow: progress events + timeout handling, then hands
            // off to finishMock(). Q-33/P-15: total is now derived from the
            // real body length (was a fictitious hard-coded 1000), and the
            // 50ms progress interval is skipped entirely for near-zero delay
            // (it used to be set up and torn down before its first tick could
            // ever fire) — a single 100%-loaded progress event is emitted
            // right before delivery instead.
            function runStaticMockFlow(rule) {
                const cfg = getResponseConfig(rule);
                const bodyContent = window.SpliceTapPlaceholders.processDynamicResponse(cfg.body, { url: requestUrl, method: requestMethod });
                const responseText = typeof bodyContent === 'string' ? bodyContent : JSON.stringify(bodyContent);
                const status = cfg.statusCode;
                const statusText = cfg.statusText;
                const totalBytes = responseText.length;
                const delay = cfg.delay;
                const headers = buildMockHeaders(cfg.headers, rule);

                // Update readyState to LOADING
                Object.defineProperty(xhr, 'readyState', { value: 3, writable: true, configurable: true });
                xhr.dispatchEvent(new Event('readystatechange'));

                if (delay > 50) {
                    // Genuinely delayed mocks: emit a few incremental progress
                    // ticks sized to the real body so percentage-based UIs see
                    // real, non-fictitious movement.
                    let bytesLoaded = 0;
                    const progressSteps = 5;
                    const stepSize = (totalBytes / progressSteps) || 1;

                    progressInterval = setInterval(() => {
                        if (isAborted) {
                            clearInterval(progressInterval);
                            return;
                        }
                        bytesLoaded = Math.min(bytesLoaded + stepSize, totalBytes);
                        xhr.dispatchEvent(new ProgressEvent('progress', {
                            lengthComputable: true,
                            loaded: bytesLoaded,
                            total: totalBytes
                        }));
                    }, 50);
                }

                // Check for timeout
                if (xhr.timeout > 0 && delay > xhr.timeout) {
                    mockTimeout = setTimeout(() => {
                        if (isAborted) return;

                        if (progressInterval) {
                            clearInterval(progressInterval);
                            progressInterval = null;
                        }

                        Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
                        xhr.dispatchEvent(new Event('readystatechange')); // Q-8
                        xhr.dispatchEvent(new ProgressEvent('timeout'));
                        xhr.dispatchEvent(new ProgressEvent('loadend'));
                    }, xhr.timeout);
                    return;
                }

                // Schedule response
                mockTimeout = setTimeout(() => {
                    if (progressInterval) {
                        clearInterval(progressInterval);
                        progressInterval = null;
                    }
                    if (!isAborted) {
                        // Always land on a 100%-loaded progress event right
                        // before delivery, whether or not the interval above
                        // ran (and however far it got).
                        xhr.dispatchEvent(new ProgressEvent('progress', {
                            lengthComputable: true, loaded: totalBytes, total: totalBytes
                        }));
                    }
                    finishMock(responseText, status, statusText, headers);
                }, delay > 10 ? delay : 10);
            }

            // Override open
            xhr.open = function (method, url, ...args) {
                requestMethod = String(method).toUpperCase();
                requestUrl = url instanceof URL ? url.href : String(url);
                requestHeaders = {};
                isMocked = false;
                redirectHandled = false;
                mockResponseHeaders = null;
                // Q-12: 3rd arg is `async`, defaulting to true when omitted.
                requestIsAsync = args.length === 0 ? true : args[0] !== false;

                let finalUrl = url;

                // Redirect-only pre-match (url+method only) so we can rewrite the URL
                // passed to originalOpen. A redirect rule with match.headers/graphql
                // is invalid (G5 enforces this), so url+method is sufficient here.
                // P-10c: skip the scan entirely when no enabled redirect rule exists.
                if (tmState.active && tmState._hasRedirectRules) {
                    const redirectRule = tmState.rules.find((rule) =>
                        rule && rule.enabled &&
                        (rule.type || 'mock') === 'redirect' &&
                        window.SpliceTapMatcher.matchUrl(requestUrl, rule.match && rule.match.url) &&
                        (((rule.match && rule.match.method) || '*').toUpperCase() === '*' ||
                            ((rule.match && rule.match.method) || '').toUpperCase() === requestMethod)
                    );

                    if (redirectRule) {
                        const newUrl = computeRedirectUrl(requestUrl, redirectRule);
                        log(`Redirecting XHR ${requestMethod} ${requestUrl} -> ${newUrl} (Rule: ${redirectRule.name})`);
                        logInterception(redirectRule, requestUrl, requestMethod, 302);
                        finalUrl = newUrl;
                        requestUrl = newUrl;
                        redirectHandled = true;
                    }
                }

                return originalOpen.apply(this, [method, finalUrl, ...args]);
            };

            // Override abort
            xhr.abort = function () {
                isAborted = true;

                // Clear any pending timeouts
                if (mockTimeout) {
                    clearTimeout(mockTimeout);
                    mockTimeout = null;
                }

                if (progressInterval) {
                    clearInterval(progressInterval);
                    progressInterval = null;
                }

                if (isMocked) {
                    // Trigger abort event for mocked requests
                    Object.defineProperty(xhr, 'readyState', { value: 0, writable: true, configurable: true });
                    xhr.dispatchEvent(new ProgressEvent('abort', { bubbles: false }));
                    xhr.dispatchEvent(new ProgressEvent('loadend', { bubbles: false }));
                    return;
                }

                return originalAbort.apply(this);
            };

            // Override getResponseHeader/getAllResponseHeaders so mocked
            // responses expose the rule's response headers (Q-7) instead of
            // silently dropping them (only meaningful once mocked; otherwise
            // pass through to the real network response headers untouched).
            xhr.getResponseHeader = function (name) {
                if (isMocked && mockResponseHeaders) {
                    const key = String(name).toLowerCase();
                    const foundKey = Object.keys(mockResponseHeaders).find((k) => k.toLowerCase() === key);
                    return foundKey !== undefined ? String(mockResponseHeaders[foundKey]) : null;
                }
                return originalGetResponseHeader.apply(this, arguments);
            };

            xhr.getAllResponseHeaders = function () {
                if (isMocked && mockResponseHeaders) {
                    const keys = Object.keys(mockResponseHeaders);
                    if (keys.length === 0) return '';
                    return keys.map((k) => `${k.toLowerCase()}: ${mockResponseHeaders[k]}`).join('\r\n') + '\r\n';
                }
                return originalGetAllResponseHeaders.apply(this, arguments);
            };

            // Override send — this is where matching now happens (headers + body are only known here)
            xhr.send = function (body) {
                if (isAborted) return;

                if (!tmState.active) {
                    return originalSend.apply(this, arguments);
                }

                // Chaos Mode check (moved from open())
                if (tmState.settings?.chaosMode?.enabled &&
                    getSecureRandom() < (tmState.settings.chaosMode.failureRate || 0.1)) {
                    log(`Chaos Mode: Blocked XHR ${requestUrl}`);
                    isMocked = true;

                    setTimeout(() => {
                        if (isAborted) return;

                        Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
                        Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
                        xhr.dispatchEvent(new Event('readystatechange')); // Q-8
                        xhr.dispatchEvent(new ProgressEvent('error', { bubbles: false }));
                        xhr.dispatchEvent(new ProgressEvent('loadend', { bubbles: false }));
                    }, 100);
                    return;
                }

                // A redirect rule was already applied (URL rewritten) in open() —
                // the real network call now goes to the redirected URL, nothing more to do here.
                if (redirectHandled) {
                    return originalSend.apply(this, arguments);
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

                const rule = window.SpliceTapMatcher.findMatchingRule(tmState.rules, {
                    url: requestUrl,
                    method: requestMethod,
                    headers: requestHeaders,
                    bodyText
                });

                if (!rule) {
                    return originalSend.apply(this, arguments);
                }

                const effectiveType = rule.type || 'mock';

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
                        isMocked = true;
                        logInterception(rule, requestUrl, requestMethod, 0);
                        Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
                        Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
                        xhr.dispatchEvent(new Event('readystatechange'));
                        xhr.dispatchEvent(new ProgressEvent('error', { bubbles: false }));
                        xhr.dispatchEvent(new ProgressEvent('loadend', { bubbles: false }));
                        return;
                    }

                    if (effectiveType === 'mock' && ((rule.response && rule.response.mode) || 'static') === 'static') {
                        const cfg = getResponseConfig(rule);
                        const bodyContent = window.SpliceTapPlaceholders.processDynamicResponse(cfg.body, { url: requestUrl, method: requestMethod });
                        const responseText = typeof bodyContent === 'string' ? bodyContent : JSON.stringify(bodyContent);
                        isMocked = true;
                        logInterception(rule, requestUrl, requestMethod, cfg.statusCode);
                        finishMock(responseText, cfg.statusCode, cfg.statusText, buildMockHeaders(cfg.headers, rule));
                        return;
                    }

                    // delay / patch / anything else can't be honored without
                    // blocking the thread — pass through to a real synchronous request.
                    log(`Rule "${rule.name}" (type ${effectiveType}) cannot be mocked on a synchronous XHR; passing through`);
                    return originalSend.apply(this, arguments);
                }

                if (effectiveType === 'block') {
                    log(`Blocked XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name})`);
                    isMocked = true;
                    logInterception(rule, requestUrl, requestMethod, 0);

                    setTimeout(() => {
                        if (isAborted) return;

                        Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
                        Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
                        xhr.dispatchEvent(new Event('readystatechange')); // Q-8
                        xhr.dispatchEvent(new ProgressEvent('error', { bubbles: false }));
                        xhr.dispatchEvent(new ProgressEvent('loadend', { bubbles: false }));
                    }, 10);
                    return;
                }

                if (effectiveType === 'delay') {
                    log(`Delaying XHR ${requestMethod} ${requestUrl} by ${rule.delayMs}ms (Rule: ${rule.name})`);
                    isMocked = true;
                    logInterception(rule, requestUrl, requestMethod, null);

                    mockTimeout = setTimeout(() => {
                        mockTimeout = null;
                        isMocked = false; // hand off to the real network request
                        if (isAborted) return;
                        originalSend.call(xhr, body);
                    }, rule.delayMs);
                    return;
                }

                if (effectiveType === 'mock') {
                    const cfg = getResponseConfig(rule);

                    if (cfg.mode === 'patch') {
                        isMocked = true;

                        (async () => {
                            try {
                                // S-7/Q-18: map withCredentials instead of
                                // hard-coding 'include' (which silently
                                // attached cookies to cross-origin requests
                                // the page deliberately made anonymous, and
                                // could fail CORS for servers that don't also
                                // send Access-Control-Allow-Credentials).
                                const real = await originalFetch(requestUrl, {
                                    method: requestMethod,
                                    headers: requestHeaders,
                                    body: body ?? undefined,
                                    credentials: xhr.withCredentials ? 'include' : 'same-origin'
                                });

                                if (isAborted) return;

                                const data = await real.clone().json();
                                const patchPayload = window.SpliceTapPlaceholders.processDynamicResponse(cfg.patch, { url: requestUrl, method: requestMethod });
                                const merged = window.SpliceTapPatch.jsonMergePatch(data, patchPayload);
                                const mergedText = JSON.stringify(merged);

                                const mergedHeaders = {};
                                real.headers.forEach((value, key) => { mergedHeaders[key] = value; });
                                mergedHeaders['x-splicetap'] = 'true';
                                mergedHeaders['x-splicetap-rule'] = rule.name;

                                log(`Patched XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name})`);
                                logInterception(rule, requestUrl, requestMethod, real.status);

                                finishMock(mergedText, real.status, real.statusText || 'OK', mergedHeaders);
                            } catch (error) {
                                log('XHR patch mode failed, falling back to real send:', error);
                                isMocked = false;
                                if (isAborted) return;
                                originalSend.call(xhr, body);
                            }
                        })();
                        return;
                    }

                    // mode === 'static'
                    log(`Intercepted XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name})`);
                    isMocked = true;
                    logInterception(rule, requestUrl, requestMethod, cfg.statusCode);
                    runStaticMockFlow(rule);
                    return;
                }

                // Anything else (e.g. a redirect rule reaching send() despite the
                // open()-time pre-match, which shouldn't normally happen) — passthrough.
                return originalSend.apply(this, arguments);
            };

            // Override setRequestHeader — record it AND always call through so
            // headers still reach the network for the passthrough case.
            xhr.setRequestHeader = function (name, value) {
                requestHeaders[String(name).toLowerCase()] = value;
                return originalSetRequestHeader.apply(this, arguments);
            };

            return xhr;
        };

        // Preserve XMLHttpRequest prototype
        window.XMLHttpRequest.prototype = originalXHR.prototype;

        // Q-27: copy the static readyState constants onto the wrapper — only
        // .prototype was carried over above, so `XMLHttpRequest.DONE` (the
        // static form, used by e.g. `xhr.readyState === XMLHttpRequest.DONE`)
        // was undefined for every page, mocked or not.
        window.XMLHttpRequest.UNSENT = originalXHR.UNSENT;
        window.XMLHttpRequest.OPENED = originalXHR.OPENED;
        window.XMLHttpRequest.HEADERS_RECEIVED = originalXHR.HEADERS_RECEIVED;
        window.XMLHttpRequest.LOADING = originalXHR.LOADING;
        window.XMLHttpRequest.DONE = originalXHR.DONE;
    }

    // --- SYNC STATE ---
    // Transport note: see the header comment and content/content.js — this is
    // a namespaced CustomEvent on `document`, not window.postMessage/'message'.
    document.addEventListener(SYNC_STATE_EVENT, (event) => {
        const payload = event && event.detail;

        // Validate payload
        if (!payload || typeof payload !== 'object') {
            console.warn('Invalid state payload received');
            return;
        }

        tmState.active = payload.active !== false;
        tmState.rules = Array.isArray(payload.rules) ? payload.rules : [];
        tmState.settings = payload.settings || {};

        // Recompute derived flags once per sync rather than per request.
        tmState._anyRuleUsesHeaders = tmState.rules.some((r) =>
            r && r.enabled && r.match && r.match.headers && Object.keys(r.match.headers).length > 0
        );
        tmState._anyRuleUsesGraphQL = tmState.rules.some((r) =>
            r && r.enabled && r.match && r.match.graphql && r.match.graphql.operationName
        );
        tmState._hasRedirectRules = tmState.rules.some((r) =>
            r && r.enabled && (r.type || 'mock') === 'redirect'
        );

        if (tmState.settings.debugMode) {
            log('State synced:', {
                active: tmState.active,
                rulesCount: tmState.rules.length,
                settings: tmState.settings
            });
        }
    });

    log(spliceTapGlobalsReady ? 'Interceptor injected and active' : 'Interceptor injected but INACTIVE (missing shared modules)');

})();
