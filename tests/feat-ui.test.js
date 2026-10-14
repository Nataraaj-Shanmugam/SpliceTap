/**
 * F5: the HAR builder behind the DevTools panel's "Export HAR" button.
 *
 * devtools/har.js is pure (no DOM, no chrome.*), so the whole mapping from log
 * entries and captures to a HAR 1.2 document is checked here. The button, the
 * download and the real log are covered by tests/e2e/feat-ui.e2e.test.js.
 */

const { buildHar, harFileName, findCapture, parseQueryString, HAR_VERSION } = require('../devtools/har');

const entry = (over = {}) => ({
    ts: Date.UTC(2026, 9, 14, 8, 30, 15, 250),
    url: 'http://127.0.0.1:3000/api/users?page=2&sort=name',
    method: 'GET',
    ruleId: 'r1',
    ruleName: 'Users mock',
    ruleType: 'mock',
    status: 200,
    kind: 'rule',
    ...over
});

const capture = (over = {}) => ({
    id: 'cap_1',
    ts: 1000,
    url: 'http://127.0.0.1:3000/api/users?page=2&sort=name',
    method: 'GET',
    status: 200,
    statusText: 'OK',
    contentType: 'application/json',
    headers: { 'content-type': 'application/json', 'x-trace': 'abc' },
    body: '{"users":[]}',
    ...over
});

/**
 * The required members of HAR 1.2 (http://www.softwareishard.com/blog/har-12-spec/),
 * checked structurally. Throws on the first one missing or mistyped.
 */
function assertHar12(har) {
    const need = (cond, what) => { if (!cond) throw new Error('HAR 1.2: ' + what); };
    const isStr = (v) => typeof v === 'string';
    const isNum = (v) => typeof v === 'number' && isFinite(v);
    const nameValue = (list, what) => {
        need(Array.isArray(list), what + ' is an array');
        for (const item of list) need(isStr(item.name) && isStr(item.value), what + ' items are {name, value}');
    };

    need(har && har.log, 'has log');
    const log = har.log;
    need(log.version === '1.2', 'version is 1.2');
    need(log.creator && isStr(log.creator.name) && isStr(log.creator.version), 'creator {name, version}');
    need(Array.isArray(log.entries), 'entries is an array');
    for (const e of log.entries) {
        need(isStr(e.startedDateTime) && !isNaN(Date.parse(e.startedDateTime)), 'startedDateTime is ISO 8601');
        need(isNum(e.time) && e.time >= 0, 'time is a non-negative number');

        const rq = e.request;
        need(isStr(rq.method) && isStr(rq.url) && isStr(rq.httpVersion), 'request method/url/httpVersion');
        nameValue(rq.cookies, 'request.cookies');
        nameValue(rq.headers, 'request.headers');
        nameValue(rq.queryString, 'request.queryString');
        need(isNum(rq.headersSize) && isNum(rq.bodySize), 'request sizes');

        const rs = e.response;
        need(isNum(rs.status) && isStr(rs.statusText) && isStr(rs.httpVersion), 'response status/statusText/httpVersion');
        nameValue(rs.cookies, 'response.cookies');
        nameValue(rs.headers, 'response.headers');
        need(isNum(rs.content.size) && isStr(rs.content.mimeType), 'response.content size/mimeType');
        need(rs.content.text === undefined || isStr(rs.content.text), 'response.content.text is a string');
        need(isStr(rs.redirectURL) && isNum(rs.headersSize) && isNum(rs.bodySize), 'response redirectURL and sizes');

        need(e.cache && typeof e.cache === 'object', 'cache is an object');
        need(isNum(e.timings.send) && isNum(e.timings.wait) && isNum(e.timings.receive), 'timings send/wait/receive');
    }
    return true;
}

describe('F5: buildHar', () => {
    test('an empty log is a valid HAR with no entries', () => {
        const har = buildHar([], [], { version: '0.0.1' });
        expect(assertHar12(har)).toBe(true);
        expect(har.log.entries).toEqual([]);
        expect(har.log.version).toBe(HAR_VERSION);
    });

    test('the creator is SpliceTap with the manifest version it was given', () => {
        expect(buildHar([], [], { version: '1.2.3' }).log.creator).toEqual({ name: 'SpliceTap', version: '1.2.3' });
        expect(buildHar([], []).log.creator).toEqual({ name: 'SpliceTap', version: '' });
    });

    test('maps one entry field by field, as the contract lists them', () => {
        const har = buildHar([entry({ elapsedMs: 120, note: 'Patch skipped' })], [], { version: '0.0.1' });
        expect(assertHar12(har)).toBe(true);
        const e = har.log.entries[0];

        expect(e.startedDateTime).toBe('2026-10-14T08:30:15.250Z');
        expect(e.time).toBe(120);
        expect(e.request).toEqual({
            method: 'GET',
            url: 'http://127.0.0.1:3000/api/users?page=2&sort=name',
            httpVersion: '',
            headers: [],
            queryString: [{ name: 'page', value: '2' }, { name: 'sort', value: 'name' }],
            cookies: [],
            headersSize: -1,
            bodySize: -1
        });
        expect(e.response).toMatchObject({
            status: 200,
            statusText: '',
            headers: [],
            content: { size: 0, mimeType: '' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1
        });
        expect(e.response.content.text).toBeUndefined();
        expect(e.cache).toEqual({});
        expect(e.timings).toEqual({ send: 0, wait: 120, receive: 0 });
        expect(e._splicetap).toEqual({ ruleName: 'Users mock', type: 'mock', kind: 'rule', note: 'Patch skipped' });
    });

    test('time is 0 without elapsedMs, and negative or junk values are ignored', () => {
        for (const elapsedMs of [undefined, -5, 'fast', NaN, null]) {
            const e = buildHar([entry({ elapsedMs })], []).log.entries[0];
            expect(e.time).toBe(0);
            expect(e.timings).toEqual({ send: 0, wait: 0, receive: 0 });
        }
    });

    test('the status is finalStatus, else status, else 0 — and always a number', () => {
        const status = (over) => buildHar([entry(over)], []).log.entries[0].response.status;
        expect(status({ status: 200, finalStatus: 503 })).toBe(503);
        expect(status({ status: 404 })).toBe(404);
        expect(status({ status: 0 })).toBe(0);               // block
        expect(status({ status: 302, finalStatus: 200 })).toBe(200);
        expect(status({ status: null })).toBe(0);            // a delay that never settled
        expect(status({ status: undefined })).toBe(0);
        expect(status({ status: 200, finalStatus: 'failed' })).toBe(0);
        expect(status({ status: 'failed' })).toBe(0);
    });

    test('a redirect keeps its destination in redirectURL', () => {
        const e = buildHar([entry({ ruleType: 'redirect', status: 302, redirectedTo: 'https://example.com/new', finalStatus: 200 })], []).log.entries[0];
        expect(e.response.redirectURL).toBe('https://example.com/new');
        expect(e.response.status).toBe(200);
        expect(e._splicetap.type).toBe('redirect');
    });

    test('chaos failures are typed chaos and say so in kind', () => {
        const e = buildHar([entry({ kind: 'chaos', ruleType: 'mock', ruleId: null, ruleName: undefined, status: 'failed' })], []).log.entries[0];
        expect(e._splicetap).toEqual({ ruleName: '', type: 'chaos', kind: 'chaos', note: '' });
        expect(e.response.status).toBe(0);
    });

    test('an entry with no type is a mock, with no kind a rule, with no timestamp the export time', () => {
        const e = buildHar([{ url: 'http://a.test/x', method: 'POST' }], [], { now: Date.UTC(2026, 0, 2, 3, 4, 5) }).log.entries[0];
        expect(e._splicetap).toEqual({ ruleName: '', type: 'mock', kind: 'rule', note: '' });
        expect(e.startedDateTime).toBe('2026-01-02T03:04:05.000Z');
        expect(e.request.method).toBe('POST');
    });

    test('keeps the log order and skips non-objects', () => {
        const har = buildHar([entry({ url: 'http://a.test/1' }), null, 'x', entry({ url: 'http://a.test/2' })], []);
        expect(har.log.entries.map((e) => e.request.url)).toEqual(['http://a.test/1', 'http://a.test/2']);
        expect(buildHar(undefined, undefined).log.entries).toEqual([]);
    });

    test('does not mutate the entries or captures it was given', () => {
        const entries = [entry()];
        const captures = [capture()];
        const before = JSON.stringify([entries, captures]);
        buildHar(entries, captures);
        expect(JSON.stringify([entries, captures])).toBe(before);
    });

    test('is JSON-serialisable and survives a round trip unchanged', () => {
        const har = buildHar([entry({ elapsedMs: 5 }), entry({ ruleType: 'block', status: 0 })], [capture()], { version: '0.0.1' });
        expect(JSON.parse(JSON.stringify(har))).toEqual(har);
    });
});

describe('F5: response bodies from captures', () => {
    test('a capture with the same method and URL supplies body, size, mime type and headers', () => {
        const e = buildHar([entry()], [capture()]).log.entries[0];
        expect(assertHar12(buildHar([entry()], [capture()]))).toBe(true);
        expect(e.response.content).toEqual({ size: 12, mimeType: 'application/json', text: '{"users":[]}' });
        expect(e.response.headers).toEqual([
            { name: 'content-type', value: 'application/json' },
            { name: 'x-trace', value: 'abc' }
        ]);
    });

    test('the size is in bytes, not characters', () => {
        const body = 'héllo — 日本';
        const e = buildHar([entry()], [capture({ body })]).log.entries[0];
        expect(e.response.content.size).toBe(Buffer.byteLength(body, 'utf8'));
        expect(e.response.content.size).toBeGreaterThan(body.length);
        expect(e.response.content.text).toBe(body);
    });

    test('an empty captured body is still a body', () => {
        const e = buildHar([entry()], [capture({ body: '' })]).log.entries[0];
        expect(e.response.content).toEqual({ size: 0, mimeType: 'application/json', text: '' });
    });

    test('uses the most recent capture for that method and URL', () => {
        const captures = [
            capture({ id: 'old', ts: 1000, body: 'old' }),
            capture({ id: 'new', ts: 3000, body: 'new' }),
            capture({ id: 'mid', ts: 2000, body: 'mid' })
        ];
        expect(findCapture(entry(), captures).id).toBe('new');
        expect(buildHar([entry()], captures).log.entries[0].response.content.text).toBe('new');
    });

    test('on equal timestamps the later one in the list wins', () => {
        const captures = [capture({ id: 'a', ts: 5 }), capture({ id: 'b', ts: 5 })];
        expect(findCapture(entry(), captures).id).toBe('b');
    });

    test('a different method or URL is not matched; method case does not matter', () => {
        expect(findCapture(entry({ method: 'POST' }), [capture()])).toBeNull();
        expect(findCapture(entry({ url: 'http://127.0.0.1:3000/api/users?page=3' }), [capture()])).toBeNull();
        expect(findCapture(entry({ method: 'get' }), [capture({ method: 'GET' })])).not.toBeNull();
    });

    test('captures never leak onto an entry for another request', () => {
        const har = buildHar([entry({ url: 'http://a.test/one' }), entry({ url: 'http://a.test/two' })], [capture({ url: 'http://a.test/two', body: 'TWO' })]);
        expect(har.log.entries[0].response.content.text).toBeUndefined();
        expect(har.log.entries[1].response.content.text).toBe('TWO');
    });

    test('malformed captures and headers are ignored, not thrown on', () => {
        const captures = [null, 'x', { url: entry().url }, capture({ headers: { ok: 'yes', bad: 7, worse: null } })];
        const e = buildHar([entry()], captures).log.entries[0];
        expect(e.response.headers).toEqual([{ name: 'ok', value: 'yes' }]);
        expect(buildHar([entry()], 'not a list').log.entries).toHaveLength(1);
    });
});

describe('F5: queryString and file name', () => {
    test('parses a query string in order, with duplicates, decoding and redacted values', () => {
        expect(parseQueryString('http://a.test/p?a=1&a=2&q=hello%20world&token=%5Bredacted%5D#frag'))
            .toEqual([
                { name: 'a', value: '1' }, { name: 'a', value: '2' },
                { name: 'q', value: 'hello world' }, { name: 'token', value: '[redacted]' }
            ]);
        expect(parseQueryString('http://a.test/p?flag')).toEqual([{ name: 'flag', value: '' }]);
    });

    test('no query, a relative URL, a truncated URL and junk all give a list', () => {
        expect(parseQueryString('http://a.test/p')).toEqual([]);
        expect(parseQueryString('/api/x?id=7')).toEqual([{ name: 'id', value: '7' }]);
        expect(parseQueryString('http://a.test/p?x=1…[truncated]')).toEqual([{ name: 'x', value: '1…[truncated]' }]);
        expect(parseQueryString(undefined)).toEqual([]);
        expect(parseQueryString('')).toEqual([]);
    });

    test('splicetap-YYYYMMDD-HHMMSS.har, zero padded, in local time', () => {
        expect(harFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('splicetap-20260102-030405.har');
        expect(harFileName(new Date(2026, 11, 31, 23, 59, 59))).toBe('splicetap-20261231-235959.har');
        expect(harFileName()).toMatch(/^splicetap-\d{8}-\d{6}\.har$/);
        expect(harFileName(new Date('nope'))).toMatch(/^splicetap-\d{8}-\d{6}\.har$/);
    });
});
