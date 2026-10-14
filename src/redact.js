/**
 * SpliceTap URL redaction for the interception log.
 *
 * F2: the background's network observer logs URLs Chrome reports, and they
 * must be redacted exactly as the interceptor redacts the URLs it logs
 * (PER-4, sanitizeUrlForLog in content/injected.js). This is a port of that
 * logic; tests/feat-network.test.js checks both give identical output on the
 * SEC2-4 cases. injected.js keeps its own copy, built on built-ins it
 * captures at load (contract B), so a change here must be made there too.
 *
 * UMD, like src/matcher.js: the service worker side-effect imports it and
 * reads globalThis.SpliceTapRedact; Jest require()s it.
 */
(function (global) {
    'use strict';

    // PER-4: a query or fragment key is sensitive when its name CONTAINS any
    // of these, in any letter case and with any separator.
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

    /**
     * The URL as the log may keep it: absolute (resolved against `base` when
     * given), sensitive values redacted, capped in length. Best-effort: a URL
     * that can't be parsed is kept as-is rather than throwing.
     */
    function redactUrl(rawUrl, base) {
        let safeUrl = rawUrl;
        try {
            const parsed = base === undefined ? new URL(rawUrl) : new URL(rawUrl, base);
            redactParams(parsed.searchParams);
            if (parsed.hash) parsed.hash = redactFragment(parsed.hash);
            if (/^https?:$/.test(parsed.protocol)) {
                const path = redactPath(parsed.pathname);
                if (path !== parsed.pathname) parsed.pathname = path;
            }
            safeUrl = parsed.href;
        } catch (e) {
            safeUrl = rawUrl;
        }
        if (typeof safeUrl === 'string' && safeUrl.length > MAX_LOGGED_URL_LENGTH) {
            safeUrl = safeUrl.slice(0, MAX_LOGGED_URL_LENGTH) + '…[truncated]';
        }
        return safeUrl;
    }

    const api = { redactUrl, isSensitiveKey, MAX_LOGGED_URL_LENGTH };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapRedact = api;
})(typeof window !== 'undefined' ? window : globalThis);
