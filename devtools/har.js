/**
 * SpliceTap HAR export (F5) — pure, no DOM and no chrome.* (UMD).
 *
 * Loads as (a) a plain script in the DevTools panel, which builds the file
 * from the interception log and the captures, and (b) a CommonJS module under
 * Jest, so the mapping is unit-tested without a browser.
 *
 * What a log entry can and cannot say: SpliceTap sees the page's call and what
 * a rule did with it, not the wire. Request headers, cookies and sizes are
 * therefore empty or -1, which HAR allows ("unknown"). The response body and
 * headers come from a capture when one exists for the same method and URL —
 * captures are recorded (while armed) for responses no rule answered.
 *
 * URLs are already redacted by the interceptor, and a capture's URL goes
 * through the same redaction, so the two compare equal for the same request.
 */
(function (global) {
    'use strict';

    const HAR_VERSION = '1.2';

    function isCount(value) {
        return typeof value === 'number' && isFinite(value) && value >= 0;
    }

    /** ISO timestamp for a log entry; the export time when the entry has none. */
    function isoFrom(ts, fallback) {
        const date = new Date(typeof ts === 'number' ? ts : NaN);
        if (!isNaN(date.getTime())) return date.toISOString();
        const alt = new Date(fallback);
        return isNaN(alt.getTime()) ? new Date(0).toISOString() : alt.toISOString();
    }

    /** [{name, value}] from a URL's query string, in order, duplicates kept. */
    function parseQueryString(url) {
        const text = String(url || '');
        let search = '';
        try {
            search = new URL(text, 'http://placeholder.invalid').search;
        } catch (e) {
            const q = text.indexOf('?');
            search = q === -1 ? '' : text.slice(q).replace(/#.*$/, '');
        }
        if (!search) return [];
        const out = [];
        new URLSearchParams(search).forEach((value, name) => out.push({ name, value }));
        return out;
    }

    // HAR sizes are bytes, not UTF-16 units.
    function byteLength(text) {
        return new TextEncoder().encode(text).length;
    }

    function headerList(headers) {
        if (!headers || typeof headers !== 'object') return [];
        return Object.keys(headers)
            .filter((name) => typeof headers[name] === 'string')
            .map((name) => ({ name, value: headers[name] }));
    }

    /**
     * The most recent capture for the same method and URL, or null. Captures
     * are stored oldest first, but `ts` decides, so a reordered list still
     * picks the latest; on a tie the later one in the list wins.
     */
    function findCapture(entry, captures) {
        if (!entry || !Array.isArray(captures)) return null;
        const method = String(entry.method || 'GET').toUpperCase();
        let best = null;
        for (const capture of captures) {
            if (!capture || capture.url !== entry.url) continue;
            if (String(capture.method || 'GET').toUpperCase() !== method) continue;
            if (!best || (Number(capture.ts) || 0) >= (Number(best.ts) || 0)) best = capture;
        }
        return best;
    }

    // Same wording the panel uses for the Type column: chaos failures belong to
    // no rule, and a legacy entry without a type is a mock.
    function entryType(entry) {
        return entry.kind === 'chaos' ? 'chaos' : (entry.ruleType || 'mock');
    }

    /** The status as a HAR number: 'failed', a pending (null) status and junk are 0. */
    function harStatus(entry) {
        const status = entry.finalStatus !== undefined && entry.finalStatus !== null ? entry.finalStatus : entry.status;
        return typeof status === 'number' && isFinite(status) ? status : 0;
    }

    function buildEntry(entry, captures, now) {
        const time = isCount(entry.elapsedMs) ? entry.elapsedMs : 0;
        const capture = findCapture(entry, captures);

        const content = { size: 0, mimeType: '' };
        if (capture && typeof capture.body === 'string') {
            content.size = byteLength(capture.body);
            content.mimeType = capture.contentType || '';
            content.text = capture.body;
        }

        return {
            startedDateTime: isoFrom(entry.ts, now),
            time,
            request: {
                method: String(entry.method || 'GET'),
                url: String(entry.url || ''),
                httpVersion: '',
                headers: [],
                queryString: parseQueryString(entry.url),
                cookies: [],
                headersSize: -1,
                bodySize: -1
            },
            response: {
                status: harStatus(entry),
                statusText: '',
                httpVersion: '',
                headers: capture ? headerList(capture.headers) : [],
                cookies: [],
                content,
                redirectURL: typeof entry.redirectedTo === 'string' ? entry.redirectedTo : '',
                headersSize: -1,
                bodySize: -1
            },
            cache: {},
            timings: { send: 0, wait: time, receive: 0 },
            _splicetap: {
                ruleName: entry.ruleName === undefined ? '' : String(entry.ruleName),
                type: entryType(entry),
                kind: entry.kind === 'chaos' ? 'chaos' : 'rule',
                note: typeof entry.note === 'string' ? entry.note : ''
            }
        };
    }

    /**
     * Build a HAR 1.2 object from log entries (oldest first) and captures.
     * Never mutates its inputs. options: { version, now }.
     */
    function buildHar(entries, captures, options) {
        const opts = options || {};
        const now = opts.now === undefined ? Date.now() : opts.now;
        const list = Array.isArray(entries) ? entries : [];
        return {
            log: {
                version: HAR_VERSION,
                creator: { name: 'SpliceTap', version: String(opts.version || '') },
                entries: list.filter((e) => e && typeof e === 'object').map((e) => buildEntry(e, captures, now))
            }
        };
    }

    /** splicetap-YYYYMMDD-HHMMSS.har, in the user's local time. */
    function harFileName(date) {
        const d = date instanceof Date && !isNaN(date.getTime()) ? date : new Date();
        const p = (n) => String(n).padStart(2, '0');
        return 'splicetap-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
            '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.har';
    }

    const api = { buildHar, harFileName, findCapture, parseQueryString, HAR_VERSION };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapHar = api;
})(typeof window !== 'undefined' ? window : globalThis);
