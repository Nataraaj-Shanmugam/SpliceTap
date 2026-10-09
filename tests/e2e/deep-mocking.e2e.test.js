/**
 * Deep feature test — what a mock returns. Every README claim about mocked and
 * patched responses, and the response-fidelity details page code relies on
 * (Requestly's "Modify API Response" covers the same ground).
 */

const { launch, pageFetch, pageXHR, waitFor } = require('./harness');

const mockRule = (id, url, response, extra = {}) => ({
    id,
    name: `Mock ${id}`,
    enabled: true,
    type: 'mock',
    match: { url, method: '*' },
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: {}, delay: 0, mode: 'static', ...response },
    ...extra
});
const control = mockRule('control', '*/api/control*', { body: { control: true } });

describe('deep: mocked responses', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    async function withRules(...rules) {
        await h.reset();
        for (const r of [control, ...rules]) await h.saveRule(r);
        page = await h.openPage();
        await waitFor(async () => (await pageFetch(page, '/api/control')).marker === 'true', { label: 'rules on page' });
        return page;
    }

    // ---- bodies ------------------------------------------------------------------

    test('an object, an array, a string and an empty body each come back as written', async () => {
        await withRules(
            mockRule('obj', '*/api/obj*', { body: { a: { b: [1, 2] } } }),
            mockRule('arr', '*/api/arr*', { body: [1, 'two', { three: 3 }] }),
            mockRule('str', '*/api/str*', { headers: { 'Content-Type': 'text/plain' }, body: 'hello, world' }),
            mockRule('empty', '*/api/empty*', { body: '' })
        );
        expect((await pageFetch(page, '/api/obj')).body).toEqual({ a: { b: [1, 2] } });
        expect((await pageFetch(page, '/api/arr')).body).toEqual([1, 'two', { three: 3 }]);
        expect((await pageFetch(page, '/api/str')).body).toBe('hello, world');
        const empty = await pageFetch(page, '/api/empty');
        expect(empty.status).toBe(200);
    });

    test('Unicode survives intact', async () => {
        const text = { greeting: 'नमस्ते — 你好 — مرحبا — 👋🏽' };
        await withRules(mockRule('uni', '*/api/uni*', { body: text }));
        expect((await pageFetch(page, '/api/uni')).body).toEqual(text);
        expect((await pageXHR(page, '/api/uni')).body).toEqual(text);
    });

    test('a 1 MB body is served whole, over fetch and XHR', async () => {
        const big = { blob: 'x'.repeat(1024 * 1024) };
        await withRules(mockRule('big', '*/api/big*', { body: big }));
        expect((await pageFetch(page, '/api/big')).body.blob.length).toBe(1024 * 1024);
        expect((await pageXHR(page, '/api/big')).body.blob.length).toBe(1024 * 1024);
    });

    // ---- status and headers -----------------------------------------------------------

    test.each([
        [201, 'Created', true], [202, 'Accepted', true], [400, 'Bad Request', false],
        [401, 'Unauthorized', false], [403, 'Forbidden', false], [404, 'Not Found', false],
        [429, 'Too Many Requests', false], [500, 'Internal Server Error', false],
        [502, 'Bad Gateway', false], [503, 'Service Unavailable', false]
    ])('status %i reports "%s" and ok=%s, over fetch and XHR', async (code, text, ok) => {
        await withRules(mockRule('st', '*/api/st*', { statusCode: code, statusText: undefined }));
        const f = await pageFetch(page, '/api/st');
        const okFlag = await page.evaluate(() => fetch('/api/st').then((r) => r.ok));
        const x = await pageXHR(page, '/api/st');
        expect([f.status, f.statusText, okFlag]).toEqual([code, text, ok]);
        expect([x.status, x.statusText]).toEqual([code, text]);
    });

    test('custom response headers reach the page, alongside the SpliceTap markers', async () => {
        await withRules(mockRule('hd', '*/api/hd*', {
            headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'abc-123', 'Cache-Control': 'no-store' }
        }));
        const headers = await page.evaluate(async () => {
            const r = await fetch('/api/hd');
            return Object.fromEntries(r.headers.entries());
        });
        expect(headers['x-request-id']).toBe('abc-123');
        expect(headers['cache-control']).toBe('no-store');
        expect(headers['x-splicetap']).toBe('true');
        expect(headers['x-splicetap-rule']).toBe('Mock hd');
    });

    test('a Content-Type given in any letter case replaces the default instead of joining it', async () => {
        // Users type headers however they like. The default Content-Type must
        // be overridden, not comma-joined into "application/json, text/html".
        await withRules(mockRule('ct', '*/api/ct*', { headers: { 'content-type': 'text/html' }, body: '<b>hi</b>' }));
        const viaFetch = await pageFetch(page, '/api/ct');
        const viaXhr = await page.evaluate(() => new Promise((resolve) => {
            const x = new XMLHttpRequest();
            x.onload = () => resolve(x.getResponseHeader('content-type'));
            x.open('GET', '/api/ct');
            x.send();
        }));
        expect(viaFetch.contentType).toBe('text/html');
        expect(viaXhr).toBe('text/html');
    });

    test('a mock with no Content-Type defaults to application/json', async () => {
        await withRules(mockRule('noct', '*/api/noct*', { headers: {}, body: { a: 1 } }));
        expect((await pageFetch(page, '/api/noct')).contentType).toBe('application/json');
    });

    // ---- delay, abort, timeout -----------------------------------------------------------

    test('a mock response delay is honoured over fetch and XHR', async () => {
        await withRules(mockRule('slow', '*/api/slow*', { delay: 700, body: { slow: true } }));
        const f = await pageFetch(page, '/api/slow');
        const x = await pageXHR(page, '/api/slow');
        expect(f.ms).toBeGreaterThanOrEqual(650);
        expect(x.ms).toBeGreaterThanOrEqual(650);
        expect(f.body).toEqual({ slow: true });
    });

    test('aborting a delayed fetch mock rejects with AbortError', async () => {
        await withRules(mockRule('slow', '*/api/slow*', { delay: 2000 }));
        const result = await page.evaluate(async () => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 100);
            const start = performance.now();
            try {
                await fetch('/api/slow', { signal: controller.signal });
                return { outcome: 'resolved' };
            } catch (e) {
                return { outcome: e.name, ms: performance.now() - start };
            }
        });
        expect(result.outcome).toBe('AbortError');
        expect(result.ms).toBeLessThan(1000);
    });

    test('an XHR timeout shorter than the mock delay fires timeout, not load', async () => {
        await withRules(mockRule('slow', '*/api/slow*', { delay: 2000 }));
        const events = await page.evaluate(() => new Promise((resolve) => {
            const seen = [];
            const x = new XMLHttpRequest();
            x.timeout = 200;
            for (const t of ['timeout', 'load', 'error', 'loadend']) x.addEventListener(t, () => {
                seen.push(t);
                if (t === 'loadend') resolve(seen);
            });
            x.open('GET', '/api/slow');
            x.send();
        }));
        expect(events).toEqual(['timeout', 'loadend']);
    });

    test('a synchronous XHR receives the mock immediately (Q-12)', async () => {
        await withRules(mockRule('sync', '*/api/sync*', { body: { sync: true } }));
        const r = await page.evaluate(() => {
            const x = new XMLHttpRequest();
            x.open('GET', '/api/sync', false);
            x.send();
            return { status: x.status, body: x.responseText };
        });
        expect(r.status).toBe(200);
        expect(JSON.parse(r.body)).toEqual({ sync: true });
    });

    // ---- the fetch and XHR APIs page code actually uses ---------------------------------

    test('a mocked fetch Response supports json, text, blob, arrayBuffer and clone', async () => {
        await withRules(mockRule('api', '*/api/surface*', { body: { n: 1 } }));
        const r = await page.evaluate(async () => {
            const res = await fetch('/api/surface');
            const copy = res.clone();
            const [json, text, blob, buf] = await Promise.all([
                res.json(),
                copy.text(),
                fetch('/api/surface').then((x) => x.blob()),
                fetch('/api/surface').then((x) => x.arrayBuffer())
            ]);
            return { json, text, blobType: blob.type, blobSize: blob.size, bufSize: buf.byteLength };
        });
        expect(r.json).toEqual({ n: 1 });
        expect(r.text).toBe('{"n":1}');
        expect(r.blobType).toMatch(/application\/json/);
        expect(r.blobSize).toBe(7);
        expect(r.bufSize).toBe(7);
    });

    test.each([
        ['json', (v) => v && v.n === 1],
        ['text', (v) => v === '{"n":1}'],
        ['blob', (v) => v === 'Blob:7'],
        ['arraybuffer', (v) => v === 'ArrayBuffer:7']
    ])('XHR responseType "%s" yields the right type', async (type, check) => {
        await withRules(mockRule('rt', '*/api/rt*', { body: { n: 1 } }));
        const value = await page.evaluate((t) => new Promise((resolve) => {
            const x = new XMLHttpRequest();
            x.responseType = t;
            x.onload = () => {
                const v = x.response;
                if (v instanceof Blob) resolve('Blob:' + v.size);
                else if (v instanceof ArrayBuffer) resolve('ArrayBuffer:' + v.byteLength);
                else resolve(v);
            };
            x.open('GET', '/api/rt');
            x.send();
        }), type);
        expect(check(value)).toBe(true);
    });

    test('a mocked XHR fires the same events, in the same order, as a real one', async () => {
        await withRules(mockRule('ev', '*/api/ev*', { body: { n: 1 } }));
        const sequence = (path) => page.evaluate((p) => new Promise((resolve) => {
            const seen = [];
            const x = new XMLHttpRequest();
            for (const t of ['loadstart', 'load', 'loadend', 'error', 'abort']) x.addEventListener(t, () => {
                seen.push(t);
                if (t === 'loadend') resolve(seen);
            });
            x.open('GET', p);
            x.send();
        }), path);
        const real = await sequence('/api/real-one');
        const mocked = await sequence('/api/ev');
        expect(mocked).toEqual(real);
    });

    test('a mocked XHR reports responseURL as a real one does', async () => {
        await withRules(mockRule('ru', '*/api/ru*', { body: {} }));
        const url = await page.evaluate(() => new Promise((resolve) => {
            const x = new XMLHttpRequest();
            x.onload = () => resolve(x.responseURL);
            x.open('GET', '/api/ru?x=1');
            x.send();
        }));
        expect(url).toMatch(/\/api\/ru\?x=1$/);
    });

    // ---- dynamic placeholders (README table) ---------------------------------------------

    test('every documented placeholder expands to the documented shape', async () => {
        await withRules(mockRule('ph', '*/api/ph*', {
            body: {
                timestamp: '{{timestamp}}', timestamp_ms: '{{timestamp_ms}}', date: '{{date}}', time: '{{time}}',
                guid: '{{guid}}', randomInt: '{{randomInt}}', randomInt50: '{{randomInt:50}}',
                randomFloat: '{{randomFloat}}', randomString: '{{randomString}}', randomString8: '{{randomString:8}}',
                randomEmail: '{{randomEmail}}', randomBool: '{{randomBool}}',
                url: '{{request.url}}', method: '{{request.method}}'
            }
        }));
        const { body: b } = await pageFetch(page, '/api/ph?q=1', { method: 'PUT' });
        expect(b.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(Math.abs(Number(b.timestamp_ms) - Date.now())).toBeLessThan(60000);
        expect(b.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(b.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
        expect(b.guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(Number(b.randomInt)).toBeGreaterThanOrEqual(0);
        expect(Number(b.randomInt)).toBeLessThanOrEqual(999);
        expect(Number(b.randomInt50)).toBeLessThanOrEqual(50);
        expect(b.randomFloat).toMatch(/^\d{1,3}\.\d{2}$/);
        expect(b.randomString).toMatch(/^[a-z0-9]{10}$/);
        expect(b.randomString8).toMatch(/^[a-z0-9]{8}$/);
        expect(b.randomEmail).toMatch(/^[a-z]+\d+@[a-z]+\.com$/);
        expect(['true', 'false']).toContain(b.randomBool);
        expect(b.url).toMatch(/\/api\/ph\?q=1$/);
        expect(b.method).toBe('PUT');
    });

    test('{{randomString:N}} returns exactly N characters, for any N', async () => {
        await withRules(mockRule('rs', '*/api/rs*', { body: { s4: '{{randomString:4}}', s20: '{{randomString:20}}', s64: '{{randomString:64}}' } }));
        // Many samples: a length that only sometimes falls short still fails.
        for (let i = 0; i < 25; i++) {
            const { body } = await pageFetch(page, '/api/rs');
            expect([body.s4.length, body.s20.length, body.s64.length]).toEqual([4, 20, 64]);
        }
    });

    test('{{randomString}} is always 10 characters', async () => {
        await withRules(mockRule('rs10', '*/api/rs10*', { body: { s: '{{randomString}}' } }));
        for (let i = 0; i < 40; i++) {
            const r = await pageFetch(page, '/api/rs10');
            // Report the whole response on failure, not just a missing field.
            expect({ i, marker: r.marker, length: r.body && r.body.s && r.body.s.length, body: r.body })
                .toMatchObject({ i, marker: 'true', length: 10 });
        }
    });

    test('placeholders are fresh on every request', async () => {
        await withRules(mockRule('fresh', '*/api/fresh*', { body: { id: '{{guid}}' } }));
        const a = (await pageFetch(page, '/api/fresh')).body.id;
        const b = (await pageFetch(page, '/api/fresh')).body.id;
        expect(a).not.toBe(b);
    });

    test('placeholders work in a plain-text body and inside nested arrays', async () => {
        await withRules(
            mockRule('txt', '*/api/txt*', { headers: { 'Content-Type': 'text/plain' }, body: 'method={{request.method}}' }),
            mockRule('nest', '*/api/nest*', { body: { items: [{ id: '{{guid}}' }, { id: '{{guid}}' }] } })
        );
        expect((await pageFetch(page, '/api/txt')).body).toBe('method=GET');
        const items = (await pageFetch(page, '/api/nest')).body.items;
        expect(items[0].id).not.toBe(items[1].id);
    });

    test('a request URL containing quotes is substituted safely into JSON (QA-4)', async () => {
        await withRules(mockRule('q', '*/api/q*', { body: { url: '{{request.url}}' } }));
        const r = await pageFetch(page, '/api/q?name="quoted"\\path');
        expect(typeof r.body).toBe('object');
        expect(r.body.url).toContain('quoted');
    });

    // ---- patch mode (README example) --------------------------------------------------------

    test('patch mode produces exactly the README example', async () => {
        await withRules(mockRule('readme', '*/api/readme-user*', { mode: 'patch', patch: { user: { role: 'admin' }, count: null } }));
        expect((await pageFetch(page, '/api/readme-user')).body).toEqual({ user: { name: 'Real', role: 'admin' } });
    });

    test('patch mode keeps the real status code', async () => {
        await withRules(mockRule('p404', '*/api/missing*', { mode: 'patch', patch: { hint: 'patched' } }));
        const r = await pageFetch(page, '/api/missing');
        expect(r.status).toBe(404);
        expect(r.body).toEqual({ error: 'missing', hint: 'patched' });
    });

    test('patch mode keeps the real response headers, plus the markers', async () => {
        // The generic /api/* route is the one that sends X-Origin-Server.
        await withRules(mockRule('phdr', '*/api/patch-headers*', { mode: 'patch', patch: { extra: 1 } }));
        const r = await pageFetch(page, '/api/patch-headers');
        expect(r.originHeader).toBe('yes');
        expect(r.marker).toBe('true');
    });

    test('a patch that is not an object is refused, pointing at static mode', async () => {
        // RFC 7386: a non-object patch replaces the whole body — which is what
        // static mode is for, so the schema says so rather than accept it.
        await h.reset();
        const r = await h.bg({ type: 'saveRule', rule: mockRule('parr', '*/api/list*', { mode: 'patch', patch: [9] }) });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/must be a JSON object/);
    });

    test('patch mode passes a non-JSON response through untouched', async () => {
        await withRules(mockRule('ptxt', '*/text/plain*', { mode: 'patch', patch: { a: 1 } }));
        const r = await pageFetch(page, '/text/plain');
        expect(r.body).toBe('plain real text');
    });

    test('patch values can use placeholders', async () => {
        await withRules(mockRule('pph', '*/api/readme-user*', { mode: 'patch', patch: { requestId: '{{guid}}' } }));
        expect((await pageFetch(page, '/api/readme-user')).body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
