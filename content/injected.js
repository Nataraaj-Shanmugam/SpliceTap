/**
 * TurboMock Injected Interceptor
 *
 * This script runs in the MAIN world (same context as the page).
 * It monkey-patches window.fetch and XMLHttpRequest to intercept requests.
 *
 * Matching / placeholder / patch logic lives in the shared UMD modules
 * (src/placeholders.js -> window.TurboMockPlaceholders,
 *  src/matcher.js      -> window.TurboMockMatcher,
 *  src/patch.js        -> window.TurboMockPatch), which must be loaded
 * BEFORE this script (see manifest content_scripts order, G3). This file
 * no longer contains any local copy of that logic.
 */

(function () {
    // Protect against double injection
    if (window.__TURBOMOCK_INITIALIZED__) return;
    window.__TURBOMOCK_INITIALIZED__ = true;

    // Store originals
    const originalFetch = window.fetch;
    const originalXHR = window.XMLHttpRequest;

    // State
    let tmState = {
        active: true,
        rules: [],
        settings: {}
    };

    // Helper: Logging with debug mode check
    function log(msg, ...args) {
        if (tmState.settings?.debugMode) {
            console.log(`%c[TurboMock] ${msg}`, 'color: #2563eb; font-weight: bold;', ...args);
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

    // Guard: the shared UMD modules must be present (loaded earlier in the
    // manifest's MAIN-world content_scripts array). If they're missing, log
    // once and leave fetch/XHR unpatched rather than throwing.
    const turboMockGlobalsReady = !!(
        window.TurboMockPlaceholders && typeof window.TurboMockPlaceholders.processDynamicResponse === 'function' &&
        window.TurboMockMatcher && typeof window.TurboMockMatcher.findMatchingRule === 'function' &&
        window.TurboMockPatch && typeof window.TurboMockPatch.jsonMergePatch === 'function'
    );

    if (!turboMockGlobalsReady) {
        console.error(
            '[TurboMock] Required globals (TurboMockPlaceholders / TurboMockMatcher / TurboMockPatch) were not found. ' +
            'fetch/XHR interception is disabled for this page load.'
        );
    }

    // Helper: report an applied rule to content.js -> background (§1.5 step 1)
    function logInterception(rule, url, method, status) {
        window.postMessage({
            source: 'turbomock-injected',
            type: 'logInterception',
            entry: {
                ts: Date.now(),
                url,
                method,
                ruleId: rule.id,
                ruleName: rule.name,
                ruleType: rule.type || 'mock',
                status
            }
        }, '*');
    }

    // Helper: sleep
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Helper: compute the destination URL for a redirect rule (supports $1..$9
    // capture references when match.url is a /regex/ pattern).
    function computeRedirectUrl(sourceUrl, rule) {
        const pattern = rule.match && rule.match.url;
        if (typeof pattern === 'string' && pattern.length >= 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
            const regexBody = pattern.slice(1, -1);
            try {
                return sourceUrl.replace(new RegExp(regexBody, 'i'), rule.redirect.destination);
            } catch (e) {
                return rule.redirect.destination;
            }
        }
        return rule.redirect.destination;
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

    // --- INTERCEPTOR: FETCH ---
    if (turboMockGlobalsReady) {
        window.fetch = async function (...args) {
            if (!tmState.active) return originalFetch.apply(this, args);

            const [resource, config] = args;
            const url = (resource instanceof Request) ? resource.url : resource;
            const method = ((config && config.method) || (resource instanceof Request && resource.method) || 'GET').toUpperCase();

            // 1. Chaos Mode Check
            if (tmState.settings?.chaosMode?.enabled) {
                if (getSecureRandom() < (tmState.settings.chaosMode.failureRate || 0.1)) {
                    log(`Chaos Mode: Blocked ${url}`);
                    return Promise.reject(new TypeError('Failed to fetch (TurboMock Chaos Mode)'));
                }
            }

            // 2. Read request headers into a lowercase-keyed plain object
            const headers = {};
            if (config && config.headers) {
                collectHeadersInto(headers, config.headers);
            } else if (resource instanceof Request) {
                collectHeadersInto(headers, resource.headers);
            }

            // 3. Body text: only read it if some enabled rule needs graphql matching
            //    (perf: avoid consuming/reading the body otherwise)
            let bodyText = null;
            const needsBody = tmState.rules.some((r) => {
                if (!r || !r.enabled || !r.match || !r.match.graphql) return false;
                const ruleMethod = (r.match.method || '*').toUpperCase();
                if (ruleMethod !== '*' && ruleMethod !== method) return false;
                return window.TurboMockMatcher.matchUrl(url, r.match.url);
            });
            if (needsBody) {
                if (typeof config?.body === 'string') {
                    bodyText = config.body;
                } else if (resource instanceof Request) {
                    bodyText = await resource.clone().text().catch(() => null);
                } else {
                    bodyText = null;
                }
            }

            // 4. Find matching rule
            const rule = window.TurboMockMatcher.findMatchingRule(tmState.rules, { url, method, headers, bodyText });
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
                await sleep(rule.delayMs);
                return originalFetch.apply(this, args);
            }

            if (effectiveType === 'redirect') {
                const newUrl = computeRedirectUrl(url, rule);
                log(`Redirecting ${method} ${url} -> ${newUrl} (Rule: ${rule.name})`);
                logInterception(rule, url, method, 302);
                const newResource = (resource instanceof Request) ? new Request(newUrl, resource) : newUrl;
                return originalFetch.call(this, newResource, config);
            }

            // effectiveType === 'mock'
            const mode = (rule.response && rule.response.mode) || 'static';

            if (mode === 'patch') {
                const real = await originalFetch.apply(this, args);

                let data;
                try {
                    data = await real.clone().json();
                } catch (e) {
                    log('Patch mode: real response is not valid JSON, returning it unmodified', e);
                    return real;
                }

                const patchPayload = window.TurboMockPlaceholders.processDynamicResponse(rule.response.patch, { url, method });
                const merged = window.TurboMockPatch.jsonMergePatch(data, patchPayload);

                if (rule.response.delay > 0) {
                    await sleep(rule.response.delay);
                }

                const mergedHeaders = new Headers(real.headers);
                mergedHeaders.set('x-turbomock', 'true');
                mergedHeaders.set('x-turbomock-rule', rule.name);

                log(`Patched ${method} ${url} (Rule: ${rule.name})`);
                logInterception(rule, url, method, real.status);

                return new Response(JSON.stringify(merged), {
                    status: real.status,
                    statusText: real.statusText,
                    headers: mergedHeaders
                });
            }

            // mode === 'static' (existing behavior)
            log(`Intercepted ${method} ${url} (Rule: ${rule.name})`);

            if (rule.response.delay > 0) {
                await sleep(rule.response.delay);
            }

            const body = window.TurboMockPlaceholders.processDynamicResponse(rule.response.body, { url, method });
            const responseBody = typeof body === 'string' ? body : JSON.stringify(body);

            const responseHeaders = new Headers(rule.response.headers || { 'Content-Type': 'application/json' });
            responseHeaders.set('x-turbomock', 'true');
            responseHeaders.set('x-turbomock-rule', rule.name);

            const status = rule.response.statusCode || 200;
            logInterception(rule, url, method, status);

            return new Response(responseBody, {
                status,
                statusText: rule.response.statusText || 'OK',
                headers: responseHeaders
            });
        };
    }

    // --- INTERCEPTOR: XHR (COMPLETE IMPLEMENTATION) ---
    if (turboMockGlobalsReady) {
        window.XMLHttpRequest = function () {
            const xhr = new originalXHR();

            // Request tracking
            let requestUrl = '';
            let requestMethod = 'GET';
            let requestHeaders = {};
            let isMocked = false;      // true while WE own the response lifecycle for this request
            let redirectHandled = false; // true once open() rewrote the URL for a redirect rule
            let isAborted = false;
            let mockTimeout = null;
            let progressInterval = null;

            // Store original methods
            const originalOpen = xhr.open;
            const originalSend = xhr.send;
            const originalAbort = xhr.abort;
            const originalSetRequestHeader = xhr.setRequestHeader;

            // Shared response-delivery flow (defineProperty + event dispatch),
            // used by BOTH static mock and patch mock so behavior is identical.
            function finishMock(responseText, status, statusText) {
                if (isAborted) return;
                try {
                    Object.defineProperty(xhr, 'responseText', { value: responseText, writable: false, configurable: true });
                    Object.defineProperty(xhr, 'response', { value: responseText, writable: false, configurable: true });
                    Object.defineProperty(xhr, 'status', { value: status, writable: false, configurable: true });
                    Object.defineProperty(xhr, 'statusText', { value: statusText, writable: false, configurable: true });
                    Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });

                    // 1. readystatechange
                    xhr.dispatchEvent(new Event('readystatechange'));
                    if (xhr.onreadystatechange) xhr.onreadystatechange();

                    // 2. load
                    xhr.dispatchEvent(new ProgressEvent('load', {
                        lengthComputable: true,
                        loaded: responseText.length,
                        total: responseText.length
                    }));
                    if (xhr.onload) xhr.onload(new ProgressEvent('load'));

                    // 3. loadend
                    xhr.dispatchEvent(new ProgressEvent('loadend', {
                        lengthComputable: true,
                        loaded: responseText.length,
                        total: responseText.length
                    }));
                    if (xhr.onloadend) xhr.onloadend(new ProgressEvent('loadend'));
                } catch (error) {
                    console.error('Error processing mock response:', error);

                    Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
                    xhr.dispatchEvent(new ProgressEvent('error'));
                    if (xhr.onerror) xhr.onerror(new ProgressEvent('error'));
                    if (xhr.onloadend) xhr.onloadend(new ProgressEvent('loadend'));
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

            // Static-mock flow: progress events + timeout handling, exactly as before,
            // then hands off to finishMock().
            function runStaticMockFlow(rule) {
                const bodyContent = window.TurboMockPlaceholders.processDynamicResponse(rule.response.body, { url: requestUrl, method: requestMethod });
                const responseText = typeof bodyContent === 'string' ? bodyContent : JSON.stringify(bodyContent);
                const status = rule.response.statusCode || 200;
                const statusText = rule.response.statusText || 'OK';

                // Simulate progress events
                let bytesLoaded = 0;
                const totalBytes = 1000;
                const progressSteps = 5;
                const stepSize = totalBytes / progressSteps;

                // Update readyState to LOADING
                Object.defineProperty(xhr, 'readyState', { value: 3, writable: true, configurable: true });
                xhr.dispatchEvent(new Event('readystatechange'));

                // Emit progress events
                progressInterval = setInterval(() => {
                    if (isAborted) {
                        clearInterval(progressInterval);
                        return;
                    }

                    bytesLoaded += stepSize;
                    if (bytesLoaded <= totalBytes) {
                        xhr.dispatchEvent(new ProgressEvent('progress', {
                            lengthComputable: true,
                            loaded: bytesLoaded,
                            total: totalBytes
                        }));
                        if (xhr.onprogress) {
                            xhr.onprogress(new ProgressEvent('progress', {
                                lengthComputable: true,
                                loaded: bytesLoaded,
                                total: totalBytes
                            }));
                        }
                    }
                }, 50);

                // Check for timeout
                if (xhr.timeout > 0) {
                    const delay = rule.response.delay || 0;

                    if (delay > xhr.timeout) {
                        mockTimeout = setTimeout(() => {
                            if (isAborted) return;

                            if (progressInterval) {
                                clearInterval(progressInterval);
                                progressInterval = null;
                            }

                            Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
                            xhr.dispatchEvent(new ProgressEvent('timeout'));
                            if (xhr.ontimeout) xhr.ontimeout(new ProgressEvent('timeout'));
                            if (xhr.onloadend) xhr.onloadend(new ProgressEvent('loadend'));
                        }, xhr.timeout);
                        return;
                    }
                }

                // Schedule response
                const delay = rule.response.delay || 0;
                mockTimeout = setTimeout(() => finishMock(responseText, status, statusText), delay > 10 ? delay : 10);
            }

            // Override open
            xhr.open = function (method, url, ...args) {
                requestMethod = String(method).toUpperCase();
                requestUrl = url instanceof URL ? url.href : String(url);
                requestHeaders = {};
                isMocked = false;
                redirectHandled = false;

                let finalUrl = url;

                // Redirect-only pre-match (url+method only) so we can rewrite the URL
                // passed to originalOpen. A redirect rule with match.headers/graphql
                // is invalid (G5 enforces this), so url+method is sufficient here.
                if (tmState.active) {
                    const redirectRule = tmState.rules.find((rule) =>
                        rule && rule.enabled &&
                        (rule.type || 'mock') === 'redirect' &&
                        window.TurboMockMatcher.matchUrl(requestUrl, rule.match && rule.match.url) &&
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
                    if (xhr.onabort) xhr.onabort(new ProgressEvent('abort'));
                    if (xhr.onloadend) xhr.onloadend(new ProgressEvent('loadend'));
                    return;
                }

                return originalAbort.apply(this);
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
                        xhr.dispatchEvent(new ProgressEvent('error', { bubbles: false }));
                        if (xhr.onerror) xhr.onerror(new ProgressEvent('error'));
                        if (xhr.onloadend) xhr.onloadend(new ProgressEvent('loadend'));
                    }, 100);
                    return;
                }

                // A redirect rule was already applied (URL rewritten) in open() —
                // the real network call now goes to the redirected URL, nothing more to do here.
                if (redirectHandled) {
                    return originalSend.apply(this, arguments);
                }

                const bodyText = typeof body === 'string' ? body : null;
                const rule = window.TurboMockMatcher.findMatchingRule(tmState.rules, {
                    url: requestUrl,
                    method: requestMethod,
                    headers: requestHeaders,
                    bodyText
                });

                if (!rule) {
                    return originalSend.apply(this, arguments);
                }

                const effectiveType = rule.type || 'mock';

                if (effectiveType === 'block') {
                    log(`Blocked XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name})`);
                    isMocked = true;
                    logInterception(rule, requestUrl, requestMethod, 0);

                    setTimeout(() => {
                        if (isAborted) return;

                        Object.defineProperty(xhr, 'status', { value: 0, writable: true, configurable: true });
                        Object.defineProperty(xhr, 'readyState', { value: 4, writable: true, configurable: true });
                        xhr.dispatchEvent(new ProgressEvent('error', { bubbles: false }));
                        if (xhr.onerror) xhr.onerror(new ProgressEvent('error'));
                        if (xhr.onloadend) xhr.onloadend(new ProgressEvent('loadend'));
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
                    const mode = (rule.response && rule.response.mode) || 'static';

                    if (mode === 'patch') {
                        isMocked = true;

                        (async () => {
                            try {
                                const real = await originalFetch(requestUrl, {
                                    method: requestMethod,
                                    headers: requestHeaders,
                                    body: body ?? undefined,
                                    credentials: 'include'
                                });

                                if (isAborted) return;

                                const data = await real.clone().json();
                                const patchPayload = window.TurboMockPlaceholders.processDynamicResponse(rule.response.patch, { url: requestUrl, method: requestMethod });
                                const merged = window.TurboMockPatch.jsonMergePatch(data, patchPayload);
                                const mergedText = JSON.stringify(merged);

                                log(`Patched XHR ${requestMethod} ${requestUrl} (Rule: ${rule.name})`);
                                logInterception(rule, requestUrl, requestMethod, real.status);

                                finishMock(mergedText, real.status, real.statusText || 'OK');
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
                    logInterception(rule, requestUrl, requestMethod, rule.response.statusCode || 200);
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
    }

    // --- SYNC STATE ---
    window.addEventListener('message', (event) => {
        if (event.data && event.data.source === 'turbomock-extension' && event.data.type === 'syncState') {
            const payload = event.data.payload;

            // Validate payload
            if (!payload || typeof payload !== 'object') {
                console.warn('Invalid state payload received');
                return;
            }

            tmState.active = payload.active !== false;
            tmState.rules = Array.isArray(payload.rules) ? payload.rules : [];
            tmState.settings = payload.settings || {};

            if (tmState.settings.debugMode) {
                log('State synced:', {
                    active: tmState.active,
                    rulesCount: tmState.rules.length,
                    settings: tmState.settings
                });
            }
        }
    });

    log(turboMockGlobalsReady ? 'Interceptor injected and active' : 'Interceptor injected but INACTIVE (missing shared modules)');

})();
