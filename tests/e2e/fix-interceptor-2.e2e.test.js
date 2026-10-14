/**
 * Fix group A2a, "interceptor-2", in a real browser: XHR and fetch fidelity
 * (PERSONA-REVIEW PER-7, 14–18, 39–43, 45–48, 52), the contract-A log fields
 * (PER-19, 54, 56) as the relay forwards them, and contract B (PER-2
 * residual). Pages that need their own markup or headers come from a second
 * local server, `aux`; the content scripts run on every origin.
 */

const http = require('http');
const zlib = require('zlib');
const { launch, pageFetch, pageXHR, waitFor, sleep } = require('./harness');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const mock = (id, url, body = { mocked: id }, response = {}) => ({
    id, name: id, enabled: true, type: 'mock', match: { url, method: '*' },
    response: { statusCode: 200, headers: JSON_HEADERS, body, delay: 0, mode: 'static', ...response }
});
const control = mock('control', '*/api/control*', { control: true });

const html = (body, headers = {}) => (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', ...headers });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>aux</title>' + body + '</html>');
};

/** A second origin for pages with their own scripts, headers or timing. */
function startAux() {
    const hits = [];
    const gz = zlib.gzipSync(JSON.stringify({ a: 1, b: 'real' }));
    const routes = {
        '/plain': html('</head><body>aux</body>'),
        '/frozen': html('<script>Object.freeze(XMLHttpRequest.prototype);</script></head><body>frozen</body>'),
        '/tt': html('</head><body>tt</body>', { 'Content-Security-Policy': "require-trusted-types-for 'script'" }),
        '/gz': (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
            res.end(gz);
        },
        '/len': (req, res) => {
            const body = JSON.stringify({ a: 1 });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
            res.end(body);
        },
        '/array': (req, res) => { res.writeHead(200, JSON_HEADERS); res.end('[1,2,3]'); },
        '/slow': (req, res, url) => {
            setTimeout(() => { res.writeHead(200, JSON_HEADERS); res.end('{"slow":true}'); }, Number(url.searchParams.get('ms')) || 300);
        },
        '/target': (req, res) => { res.writeHead(200, JSON_HEADERS); res.end(JSON.stringify({ target: true, method: req.method })); },
        '/sw.js': (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/javascript' });
            res.end(`
                self.addEventListener('install', () => self.skipWaiting());
                self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
                self.addEventListener('fetch', (e) => {
                    const path = new URL(e.request.url).pathname;
                    if (!path.startsWith('/sws/')) return;
                    const enc = new TextEncoder();
                    if (path === '/sws/big') {
                        // An endless text stream: 16 KB a tick, never closed.
                        const chunk = enc.encode('x'.repeat(16384));
                        const body = new ReadableStream({ pull(c) { return new Promise((r) => setTimeout(() => { c.enqueue(chunk); r(); }, 5)); } });
                        e.respondWith(new Response(body, { headers: { 'Content-Type': 'text/plain' } }));
                        return;
                    }
                    let i = 0;
                    const type = path === '/sws/ndjson' ? 'application/x-ndjson' : 'text/event-stream';
                    const body = new ReadableStream({ pull(c) { return new Promise((r) => setTimeout(() => {
                        c.enqueue(enc.encode(type === 'text/event-stream' ? 'data: ' + i + '\\n\\n' : '{"n":' + i + '}\\n'));
                        if (++i === 5) c.close();
                        r();
                    }, 250)); } });
                    e.respondWith(new Response(body, { headers: { 'Content-Type': type } }));
                });`);
        }
    };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            hits.push({ method: req.method, path: url.pathname, body, headers: req.headers });
            const route = routes[url.pathname];
            if (route) return route(req, res, url);
            if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify({ real: true, path: url.pathname }));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        hits,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r))
    })));
}

describe('fix-interceptor-2: XHR and fetch fidelity in a real browser', () => {
    let h;
    let aux;
    let page;

    beforeAll(async () => {
        h = await launch();
        aux = await startAux();
    });
    afterAll(async () => {
        if (h) await h.close();
        if (aux) await aux.close();
    });
    afterEach(async () => {
        if (page && !page.isClosed()) await page.close();
        page = null;
    });

    /** Replace every rule (plus a control rule), and wait until a fresh page has them. */
    async function setRules(...rules) {
        await h.reset();
        const response = await h.bg({ type: 'setRules', rules: [control, ...rules] });
        expect(response && response.success).toBe(true);
    }

    /** Open `url` (default: the harness page) once the control rule is live there. */
    async function open(url) {
        page = url ? await h.browser.newPage() : await h.openPage();
        if (url) {
            page.on('pageerror', (e) => h.record({ where: 'page', text: 'pageerror: ' + e.message }));
            await page.goto(url, { waitUntil: 'load' });
        }
        await waitFor(async () => (await pageFetch(page, '/api/control')).marker === 'true', { label: 'rules on page' });
        return page;
    }

    // ---- PER-14 / PER-7 / PER-43 / PER-46 ----------------------------------

    test('PER-14: subclassing XMLHttpRequest works with rules on, no rules, and SpliceTap off', async () => {
        const subclass = () => page.evaluate(() => new Promise((resolve) => {
            class Sub extends XMLHttpRequest { hello() { return 'hi'; } }
            const x = new Sub();
            const result = { instanceofSub: x instanceof Sub, hello: typeof x.hello === 'function' ? x.hello() : null };
            x.open('GET', '/api/users');
            x.onloadend = () => resolve({ ...result, marker: x.getResponseHeader('x-splicetap') });
            x.send();
        }));

        await setRules(mock('m', '*/api/users*'));
        await open();
        expect(await subclass()).toEqual({ instanceofSub: true, hello: 'hi', marker: 'true' });
        await page.close();

        await h.reset();
        page = await h.openPage();
        await sleep(300);
        expect(await subclass()).toEqual({ instanceofSub: true, hello: 'hi', marker: null });
        await page.close();

        await h.saveRule(mock('m', '*/api/users*'));
        await h.bg({ type: 'toggleExtension', active: false });
        page = await h.openPage();
        await sleep(300);
        expect(await subclass()).toEqual({ instanceofSub: true, hello: 'hi', marker: null });
        await h.bg({ type: 'toggleExtension', active: true });
    });

    test('PER-7: the constructor is named, needs `new`, and is its prototype\'s constructor', async () => {
        await setRules(mock('m', '*/api/users*'));
        await open();
        const shape = await page.evaluate(() => ({
            name: XMLHttpRequest.name,
            length: XMLHttpRequest.length,
            withoutNew: (() => { try { XMLHttpRequest(); return 'no throw'; } catch (e) { return e.name; } })(),
            ctor: new XMLHttpRequest().constructor === XMLHttpRequest,
            protoCtor: XMLHttpRequest.prototype.constructor === XMLHttpRequest,
            done: XMLHttpRequest.DONE
        }));
        expect(shape).toEqual({ name: 'XMLHttpRequest', length: 0, withoutNew: 'TypeError', ctor: true, protoCtor: true, done: 4 });
    });

    test('PER-43: a page that freezes XMLHttpRequest.prototype is still mocked', async () => {
        await setRules(mock('m', '*/api/users*'));
        await open(aux.base + '/frozen');
        expect(await page.evaluate(() => Object.isFrozen(XMLHttpRequest.prototype))).toBe(true);
        const xhr = await pageXHR(page, '/api/users');
        expect(xhr.marker).toBe('true');
        expect(xhr.body).toEqual({ mocked: 'm' });
    });

    test('PER-46: open(m, u, undefined) is synchronous for a mocked request, as natively', async () => {
        await setRules(mock('m', '*/api/users*'));
        await open();
        const result = await page.evaluate(() => {
            const out = {};
            for (const path of ['/api/real-sync', '/api/users']) {
                const x = new XMLHttpRequest();
                x.open('GET', path, undefined);
                x.send();
                out[path] = { readyState: x.readyState, status: x.status };
            }
            return out;
        });
        expect(result).toEqual({
            '/api/real-sync': { readyState: 4, status: 200 },
            '/api/users': { readyState: 4, status: 200 }
        });
    });

    // ---- PER-15 / 16 / 17 / 39 / 40 / 47 / 52 ----------------------------

    test('PER-15: open() resets a reused XHR, and an abandoned mock never fires', async () => {
        await setRules(mock('m', '*/api/mock*', { mocked: 1 }), mock('slow', '*/api/slow*', { first: true }, { delay: 300 }));
        await open();
        const r = await page.evaluate(async () => {
            const done = (x) => new Promise((res) => x.addEventListener('loadend', () => setTimeout(res, 0), { once: true }));
            const out = {};
            const x = new XMLHttpRequest();
            x.open('GET', '/api/mock'); x.send(); await done(x);
            x.open('GET', '/api/real-second');
            out.afterOpen = { rs: x.readyState, st: x.status, txt: x.responseText };
            x.send(); await done(x);
            out.second = { st: x.status, real: JSON.parse(x.responseText).real, marker: x.getResponseHeader('x-splicetap'), url: x.responseURL.endsWith('/api/real-second') };

            const y = new XMLHttpRequest();
            const events = [];
            ['load', 'abort', 'loadend'].forEach((t) => y.addEventListener(t, () => events.push(t + ':' + (y.responseText.includes('first') ? 'mock' : 'real'))));
            y.open('GET', '/api/slow'); y.send();
            await new Promise((res) => setTimeout(res, 50));
            y.open('GET', '/api/real-reopen'); y.send();
            await new Promise((res) => setTimeout(res, 700));
            out.reopen = events;
            return out;
        });
        expect(r).toEqual({
            afterOpen: { rs: 1, st: 0, txt: '' },
            second: { st: 200, real: true, marker: null, url: true },
            reopen: ['load:real', 'loadend:real']
        });
    });

    test('PER-16: a mocked request with a body fires the upload events a real one does', async () => {
        await setRules(mock('m', '*/api/mock*'), { id: 'b', name: 'b', enabled: true, type: 'block', match: { url: '*/api/blocked*', method: '*' } });
        await open();
        const r = await page.evaluate(async () => {
            const out = {};
            for (const path of ['/api/mock-up', '/api/real-up', '/api/blocked-up']) {
                const x = new XMLHttpRequest();
                const ev = [];
                ['loadstart', 'progress', 'load', 'error', 'loadend'].forEach((t) => x.upload.addEventListener(t, () => ev.push(t)));
                const done = new Promise((res) => x.addEventListener('loadend', () => setTimeout(res, 0)));
                x.open('POST', path); x.send('x'.repeat(5000));
                await done;
                out[path] = ev;
            }
            return out;
        });
        expect(r['/api/real-up']).toEqual(['loadstart', 'progress', 'load', 'loadend']);
        expect(r['/api/mock-up']).toEqual(['loadstart', 'progress', 'load', 'loadend']);
        expect(r['/api/blocked-up']).toEqual(['loadstart', 'error', 'loadend']);
    });

    test('PER-17: a delay rule counts toward xhr.timeout', async () => {
        const delay = (id, url, delayMs) => ({ id, name: id, enabled: true, type: 'delay', match: { url, method: '*' }, delayMs });
        await setRules(delay('long', '*/api/long*', 800), delay('short', '*/slow*', 300), delay('fine', '*/api/fine*', 100));
        await open(aux.base + '/plain');
        const r = await page.evaluate(async () => {
            const run = (url, timeout) => new Promise((res) => {
                const x = new XMLHttpRequest();
                const ev = [];
                const t0 = performance.now();
                ['readystatechange', 'load', 'timeout', 'loadend'].forEach((t) => x.addEventListener(t, () => ev.push(t + '@' + x.readyState)));
                x.addEventListener('loadend', () => setTimeout(() => res({ ev: ev.filter((e) => e !== 'readystatechange@1'), ms: Math.round(performance.now() - t0), timeoutProp: x.timeout }), 0));
                x.open('GET', url);
                x.timeout = timeout;
                x.send();
            });
            return {
                holdLonger: await run('/api/long', 200),
                budget: await run('/slow?ms=400', 500),
                fits: await run('/api/fine', 2000)
            };
        });
        expect(r.holdLonger.ev).toEqual(['readystatechange@4', 'timeout@4', 'loadend@4']);
        expect(r.holdLonger.ms).toBeLessThan(600);
        // 300 ms held + 400 ms server > 500 ms: only 200 ms were left.
        expect(r.budget.ev.slice(-3)).toEqual(['readystatechange@4', 'timeout@4', 'loadend@4']);
        expect(r.budget.timeoutProp).toBe(500);
        expect(r.fits.ev.slice(-2)).toEqual(['load@4', 'loadend@4']);
    });

    test('PER-39: abort() after a mocked response is silent; in flight it reports DONE first', async () => {
        await setRules(mock('m', '*/api/mock*'), mock('slow', '*/api/slow*', { slow: true }, { delay: 400 }));
        await open();
        const r = await page.evaluate(async () => {
            const out = {};
            for (const path of ['/api/mock', '/api/real-abort']) {
                const x = new XMLHttpRequest();
                await new Promise((res) => { x.addEventListener('loadend', () => setTimeout(res, 0), { once: true }); x.open('GET', path); x.send(); });
                const ev = [];
                ['readystatechange', 'abort', 'loadend'].forEach((t) => x.addEventListener(t, () => ev.push(t + '@' + x.readyState)));
                x.abort();
                await new Promise((res) => setTimeout(res, 30));
                out[path] = { ev, rs: x.readyState, st: x.status, txt: x.responseText };
            }
            const y = new XMLHttpRequest();
            const ev = [];
            ['readystatechange', 'abort', 'loadend'].forEach((t) => y.addEventListener(t, () => ev.push(t + '@' + y.readyState)));
            y.open('GET', '/api/slow'); y.send();
            await new Promise((res) => setTimeout(res, 50));
            ev.length = 0; // headers have arrived (readyState 2, 3); what does abort() fire?
            y.abort();
            out.inFlight = { ev, rs: y.readyState };
            return out;
        });
        expect(r['/api/real-abort']).toEqual({ ev: [], rs: 0, st: 0, txt: '' });
        expect(r['/api/mock']).toEqual(r['/api/real-abort']);
        expect(r.inFlight).toEqual({ ev: ['readystatechange@4', 'abort@4', 'loadend@4'], rs: 0 });
    });

    test('PER-40 / PER-52: responseXML for XML and documents; no body for a 204', async () => {
        const xml = '<a><b>1</b></a>';
        await setRules(
            mock('xml', '*/api/xml*', xml, { headers: { 'Content-Type': 'application/xml' } }),
            mock('html', '*/api/html*', '<p id="x">hi</p>', { headers: { 'Content-Type': 'text/html' } }),
            mock('empty', '*/api/empty*', { ignored: true }, { statusCode: 204 })
        );
        await open();
        const r = await page.evaluate(async () => {
            const get = (path, responseType) => new Promise((res) => {
                const x = new XMLHttpRequest();
                if (responseType) x.responseType = responseType;
                x.onloadend = () => res(x);
                x.open('GET', path); x.send();
            });
            const a = await get('/api/xml');
            const b = await get('/api/xml', 'document');
            const c = await get('/api/html', 'document');
            const d = await get('/api/html');
            const e = await get('/api/empty');
            return {
                xmlDefault: a.responseXML && a.responseXML.documentElement.nodeName,
                xmlDocument: b.response && b.response.documentElement.nodeName,
                sameObject: b.response === b.responseXML,
                htmlDocument: c.response && c.response.getElementById('x').textContent,
                htmlDefault: d.responseXML,
                empty: { status: e.status, text: e.responseText }
            };
        });
        expect(r).toEqual({ xmlDefault: 'a', xmlDocument: 'a', sameObject: true, htmlDocument: 'hi', htmlDefault: null, empty: { status: 204, text: '' } });
    });

    test('PER-47: on a Trusted Types page a mocked document is a Document, without a violation', async () => {
        await setRules(mock('doc', '*/api/doc*', '<p id="x">hi</p>', { headers: { 'Content-Type': 'text/html' } }));
        await open(aux.base + '/tt');
        const messages = [];
        page.on('console', (m) => messages.push(m.text()));
        const r = await page.evaluate(() => new Promise((res) => {
            const x = new XMLHttpRequest();
            x.responseType = 'document';
            x.open('GET', '/api/doc');
            x.onloadend = () => res({ isDoc: x.response instanceof window.Document, text: x.response && x.response.getElementById('x').textContent });
            x.send();
        }));
        await sleep(200);
        expect(r).toEqual({ isDoc: true, text: 'hi' });
        expect(messages.filter((m) => /Trusted/i.test(m))).toEqual([]);
    });

    // ---- contract A: PER-19, PER-54, PER-56 --------------------------------

    /**
     * Record, inside the service worker, every log entry the relay forwards.
     * The background's own acceptance of the new fields belongs to group A2b;
     * this checks what the interceptor emits and the relay passes on.
     */
    async function recordForwarded() {
        await h.worker.evaluate(() => {
            if (!globalThis.__forwarded) {
                globalThis.__forwarded = [];
                chrome.runtime.onMessage.addListener((message) => {
                    if (message && message.type === 'logInterceptionBatch') globalThis.__forwarded.push(...message.entries);
                    return false;
                });
            }
            globalThis.__forwarded.length = 0;
        });
        return () => h.worker.evaluate(() => globalThis.__forwarded.slice());
    }

    test('PER-56 / PER-19: delay, redirect and skipped-patch entries carry their outcome', async () => {
        await setRules(
            { id: 'd', name: 'd', enabled: true, type: 'delay', match: { url: '*/api/slowpath*', method: '*' }, delayMs: 150 },
            { id: 'rd', name: 'rd', enabled: true, type: 'redirect', match: { url: '*/api/moved*', method: '*' }, redirect: { destination: h.baseUrl + '/redirect-target' } },
            mock('p', '*/api/list*', {}, { mode: 'patch', patch: { added: true } })
        );
        await open();
        const forwarded = await recordForwarded();

        await pageFetch(page, '/api/slowpath');
        await pageXHR(page, '/api/slowpath');
        await pageFetch(page, '/api/moved');
        await pageXHR(page, '/api/moved');
        const list = await pageFetch(page, '/api/list');
        expect(list.body).toEqual([1, 2, 3]);

        const entries = await waitFor(async () => {
            const all = await forwarded();
            return all.length >= 5 ? all : null;
        }, { label: 'five forwarded entries' });

        const delays = entries.filter((e) => e.ruleId === 'd');
        expect(delays).toHaveLength(2);
        for (const e of delays) {
            expect(e).toMatchObject({ ruleType: 'delay', status: 200, finalStatus: 200 });
            expect(e.elapsedMs).toBeGreaterThanOrEqual(140);
        }
        const redirects = entries.filter((e) => e.ruleId === 'rd');
        expect(redirects).toHaveLength(2);
        for (const e of redirects) {
            expect(e).toMatchObject({ ruleType: 'redirect', status: 200, finalStatus: 200, redirectedTo: h.baseUrl + '/redirect-target' });
            expect(e.url).toMatch(/\/api\/moved$/);
        }
        expect(entries.find((e) => e.ruleId === 'p')).toMatchObject({
            status: 200, note: 'Patch skipped — response is not a JSON object (array)'
        });
    });

    test('PER-54: chaos failures are forwarded as kind "chaos"', async () => {
        await setRules();
        const { settings } = await h.bg({ type: 'getRules' });
        await h.bg({ type: 'settingsUpdated', settings: { ...settings, chaosMode: { enabled: true, failureRate: 1 } } });
        try {
            page = await h.openPage();
            await sleep(400);
            const forwarded = await recordForwarded();
            const f = await pageFetch(page, '/api/chaos-fetch');
            const x = await pageXHR(page, '/api/chaos-xhr');
            expect(f.ok).toBe(false);
            expect(x.outcome).toBe('error');

            const entries = await waitFor(async () => {
                const all = await forwarded();
                return all.length >= 2 ? all : null;
            }, { label: 'two chaos entries' });
            for (const path of ['/api/chaos-fetch', '/api/chaos-xhr']) {
                const entry = entries.find((e) => e.url.endsWith(path));
                expect(entry).toMatchObject({ kind: 'chaos', ruleId: null, ruleName: 'Chaos mode', status: 'failed' });
                expect(entry.elapsedMs).toBeGreaterThanOrEqual(0);
            }
        } finally {
            await h.bg({ type: 'settingsUpdated', settings: { ...settings, chaosMode: { enabled: false, failureRate: 0.1 } } });
        }
    });

    // ---- fetch fidelity: PER-18, 41, 42, 45, 48 ----------------------------

    test('PER-18: a patch rule lets event streams and NDJSON through as they arrive (fetch and XHR)', async () => {
        // A page service worker serves the streams: a local security agent on
        // the test machine buffers text/event-stream from the network.
        await setRules(mock('pt', '*/sws/*', {}, { mode: 'patch', patch: { x: 1 } }));
        await open(aux.base + '/plain');
        await page.evaluate(async () => { await window.navigator.serviceWorker.register('/sw.js'); await window.navigator.serviceWorker.ready; });
        await page.reload({ waitUntil: 'load' });
        await waitFor(() => page.evaluate(() => !!window.navigator.serviceWorker.controller), { label: 'service worker control' });
        await waitFor(async () => (await pageFetch(page, '/api/control')).marker === 'true', { label: 'rules after reload' });

        const timings = await page.evaluate(async () => {
            const viaFetch = async (path) => {
                const t0 = performance.now();
                const reader = (await fetch(path)).body.getReader();
                const at = [];
                for (;;) { const { done } = await reader.read(); if (done) break; at.push(performance.now() - t0); }
                return at;
            };
            const viaXHR = (path) => new Promise((res) => {
                const t0 = performance.now();
                const x = new XMLHttpRequest();
                const at = [];
                x.onprogress = () => at.push(performance.now() - t0);
                x.onloadend = () => res({ at, text: x.responseText });
                x.open('GET', path); x.send();
            });
            return { sse: await viaFetch('/sws/feed'), ndjson: await viaFetch('/sws/ndjson'), xhr: await viaXHR('/sws/feed') };
        });
        // Five chunks 250 ms apart: the first arrives long before the last.
        for (const at of [timings.sse, timings.ndjson, timings.xhr.at]) {
            expect(at.length).toBeGreaterThanOrEqual(4);
            expect(at[at.length - 1] - at[0]).toBeGreaterThan(600);
        }
        expect(timings.xhr.text).toBe('data: 0\n\ndata: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n');
    });

    test('PER-18: with capture armed, an endless stream is not buffered and an event stream not captured', async () => {
        await setRules();
        await open(aux.base + '/plain');
        await page.evaluate(async () => { await window.navigator.serviceWorker.register('/sw.js'); await window.navigator.serviceWorker.ready; });
        await page.reload({ waitUntil: 'load' });
        await waitFor(() => page.evaluate(() => !!window.navigator.serviceWorker.controller), { label: 'service worker control' });
        await h.bg({ type: 'setCaptureArmed', armed: true });
        await sleep(300);

        const read = await page.evaluate(async () => {
            const reader = (await fetch('/sws/big')).body.getReader();
            let bytes = 0;
            while (bytes < 400 * 1024) bytes += (await reader.read()).value.byteLength;
            reader.cancel();
            const feed = await fetch('/sws/feed');
            await feed.text();
            return bytes;
        });
        expect(read).toBeGreaterThanOrEqual(400 * 1024);
        await sleep(400);
        const { captures } = await h.bg({ type: 'getCaptures' });
        expect((captures || []).filter((c) => /\/sws\//.test(c.url))).toEqual([]);
    });

    test('PER-41: a patched response loses the real Content-Length and Content-Encoding', async () => {
        await setRules(mock('gz', '*/gz*', {}, { mode: 'patch', patch: { added: 'x'.repeat(50) } }),
            mock('len', '*/len*', {}, { mode: 'patch', patch: { added: 'y'.repeat(50) } }));
        await open(aux.base + '/plain');
        const r = await page.evaluate(async () => {
            const viaFetch = async (path) => {
                const res = await fetch(path);
                const body = await res.json();
                return { ce: res.headers.get('content-encoding'), cl: res.headers.get('content-length'), added: body.added.length, marker: res.headers.get('x-splicetap') };
            };
            const viaXHR = (path) => new Promise((res) => {
                const x = new XMLHttpRequest();
                x.onloadend = () => res({ ce: x.getResponseHeader('content-encoding'), cl: x.getResponseHeader('content-length'), added: JSON.parse(x.responseText).added.length, marker: x.getResponseHeader('x-splicetap') });
                x.open('GET', path); x.send();
            });
            return { gz: await viaFetch('/gz'), len: await viaFetch('/len'), xhr: await viaXHR('/len') };
        });
        for (const result of [r.gz, r.len, r.xhr]) {
            expect(result).toEqual({ ce: null, cl: null, added: 50, marker: 'true' });
        }
    });

    test('PER-42: clone, HEAD and 3xx redirect modes match real fetch', async () => {
        await setRules(
            mock('m', '*/api/mock*'),
            mock('m302', '*/api/m302*', '', { statusCode: 302, headers: { Location: '/target' } })
        );
        await open(aux.base + '/plain');
        const r = await page.evaluate(async () => {
            const out = {};
            const res = await fetch('/api/mock');
            out.clone = { url: res.clone().url === res.url && res.url.endsWith('/api/mock'), type: res.type };
            const head = await fetch('/api/mock', { method: 'HEAD' });
            out.head = { status: head.status, body: await head.text() };
            try { await fetch('/api/m302', { redirect: 'error' }); out.error = 'resolved'; } catch (e) { out.error = e.name; }
            const manual = await fetch('/api/m302', { redirect: 'manual' });
            out.manual = { status: manual.status, type: manual.type };
            const followed = await fetch('/api/m302');
            out.follow = { status: followed.status, redirected: followed.redirected, url: followed.url.endsWith('/target'), body: await followed.json() };
            return out;
        });
        expect(r).toEqual({
            clone: { url: true, type: 'basic' },
            head: { status: 200, body: '' },
            error: 'TypeError',
            manual: { status: 0, type: 'opaqueredirect' },
            follow: { status: 200, redirected: true, url: true, body: { target: true, method: 'GET' } }
        });
    });

    test('PER-45: a delay rule does not lose a keepalive request sent on pagehide', async () => {
        await setRules({ id: 'd', name: 'd', enabled: true, type: 'delay', match: { url: '*/ka/*', method: '*' }, delayMs: 300 });
        await open(aux.base + '/plain');
        await page.evaluate(() => window.addEventListener('pagehide', () => { fetch('/ka/delayed', { method: 'POST', body: 'bye', keepalive: true }); }));
        await page.goto(aux.base + '/plain?next', { waitUntil: 'load' });
        await waitFor(() => aux.hits.some((x) => x.path === '/ka/delayed'), { label: 'keepalive request at the server' });
    });

    test('PER-48: chaos mode leaves blob: and data: fetches alone', async () => {
        await setRules();
        const { settings } = await h.bg({ type: 'getRules' });
        await h.bg({ type: 'settingsUpdated', settings: { ...settings, chaosMode: { enabled: true, failureRate: 1 } } });
        try {
            page = await h.openPage();
            await sleep(400);
            const r = await page.evaluate(async () => {
                const out = {};
                const blobUrl = URL.createObjectURL(new Blob(['{"local":1}'], { type: 'application/json' }));
                for (const [k, url] of [['blob', blobUrl], ['data', 'data:application/json,{"a":1}'], ['http', '/api/x']]) {
                    try { await fetch(url); out[k] = 'ok'; } catch (e) { out[k] = 'failed'; }
                }
                return out;
            });
            expect(r).toEqual({ blob: 'ok', data: 'ok', http: 'failed' });
        } finally {
            await h.bg({ type: 'settingsUpdated', settings: { ...settings, chaosMode: { enabled: false, failureRate: 0.1 } } });
        }
    });

    // ---- contract B: PER-2 residual ----------------------------------------

    // Tokens that exist only in rule data: a mock body, a regex pattern's
    // source and a wildcard pattern no request ever uses.
    const SECRETS = ['ZEBRA-SECRET-7731', 'q[x]-match', 'never-ZQ9', 'never-zq9'];
    let hookLeaks = null;

    /**
     * Runs in the page, before its first request: every hook contract B
     * lists, plus the event plumbing. Each hit that carries a secret (or, for
     * the event hooks, a nonced channel name) is recorded with the extension
     * script nearest on the stack — 'content/injected.js', a shared module
     * under 'src/', or null for the page's own calls, which are ignored.
     */
    function installHooks(secrets) {
        'use strict';
        Error.stackTraceLimit = 100;
        const stringify = JSON.stringify;
        const includes = String.prototype.includes;
        const startsWith = String.prototype.startsWith;
        const leaks = [];
        window.__hookLeaks = leaks;
        window.__hookHits = 0;
        let busy = false;
        const scriptOnStack = () => {
            const match = /chrome-extension:\/\/[a-p]+\/([\w/.-]+\.js)/.exec(new Error().stack || '');
            return match ? match[1] : null;
        };
        const asText = (value) => {
            if (typeof value === 'string') return value;
            if (value instanceof RegExp) return value.source;
            try { return stringify(value) || ''; } catch (e) { return ''; }
        };
        const carriesSecret = (values) => {
            for (let i = 0; i < values.length; i++) {
                const text = asText(values[i]);
                for (let j = 0; j < secrets.length; j++) if (includes.call(text, secrets[j])) return true;
            }
            return false;
        };
        const isChannel = (type) => typeof type === 'string' && startsWith.call(type, '__splicetap_');
        function record(label, values, test) {
            if (busy) return;
            busy = true;
            try {
                window.__hookHits++;
                if ((test || carriesSecret)(values)) leaks.push({ label, script: scriptOnStack() });
            } finally {
                busy = false;
            }
        }
        const wrap = (owner, name, label) => {
            const original = owner[name];
            if (typeof original !== 'function') return;
            owner[name] = function (...args) {
                record(label, [this, ...args]);
                return original.apply(this, args);
            };
        };

        // Getters on Object.prototype, fired by a read of a property the
        // object lacks; setters keep ordinary assignment working.
        const names = ['patch', 'headers', 'graphql', 'body', 'mode', 'delay', 'delayMs', 'statusText', 'statusCode',
            'redirect', 'destination', 'response', 'match', 'url', 'type', 'operationName', 'toJSON', 'then', Symbol.iterator];
        for (const name of names) {
            Object.defineProperty(Object.prototype, name, {
                configurable: true,
                get() { record('Object.prototype.' + String(name), [this]); return undefined; },
                set(value) { Object.defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true }); }
            });
        }
        for (const name of ['startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'slice', 'substring', 'substr', 'split',
            'toLowerCase', 'toUpperCase', 'replace', 'replaceAll', 'trim', 'match', 'search', 'charAt', 'charCodeAt', 'concat', 'padStart', 'at']) {
            wrap(String.prototype, name, 'String.prototype.' + name);
        }
        for (const name of ['map', 'forEach', 'filter', 'some', 'every', 'find', 'findIndex', 'indexOf', 'includes', 'join', 'slice', 'concat', 'reduce']) {
            wrap(Array.prototype, name, 'Array.prototype.' + name);
        }
        const arrayIterator = Array.prototype[Symbol.iterator];
        Array.prototype[Symbol.iterator] = function () { record('Array.prototype[Symbol.iterator]', [this]); return arrayIterator.call(this); };
        const iteratorProto = Object.getPrototypeOf([][Symbol.iterator]());
        const iteratorNext = iteratorProto.next;
        iteratorProto.next = function () { const step = iteratorNext.call(this); record('ArrayIterator.next', [step && step.value]); return step; };
        wrap(Array, 'isArray', 'Array.isArray');
        for (const name of ['get', 'set', 'has', 'delete']) wrap(Map.prototype, name, 'Map.prototype.' + name);
        for (const name of ['has', 'add']) wrap(Set.prototype, name, 'Set.prototype.' + name);
        for (const name of ['exec', 'test']) wrap(RegExp.prototype, name, 'RegExp.prototype.' + name);
        wrap(RegExp.prototype, Symbol.replace, 'RegExp.prototype[Symbol.replace]');
        for (const name of ['stringify', 'parse']) wrap(JSON, name, 'JSON.' + name);
        for (const name of ['keys', 'assign', 'entries', 'values']) wrap(Object, name, 'Object.' + name);

        // The nonced channel: a page that learns it can read every rule.
        const channel = (values) => isChannel(values[0] && values[0].type);
        const dispatch = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function (event) {
            record('EventTarget.prototype.dispatchEvent', [event], channel);
            return dispatch.call(this, event);
        };
        const NativeCustomEvent = window.CustomEvent;
        window.CustomEvent = function CustomEvent(type, init) {
            record('CustomEvent', [{ type }], channel);
            return new NativeCustomEvent(type, init);
        };
        window.CustomEvent.prototype = NativeCustomEvent.prototype;
        const detail = Object.getOwnPropertyDescriptor(NativeCustomEvent.prototype, 'detail');
        Object.defineProperty(NativeCustomEvent.prototype, 'detail', {
            configurable: true,
            get() { record('CustomEvent.prototype.detail', [this], channel); return detail.get.call(this); }
        });
    }

    test('contract B (injected.js half): no hook the page installs receives rule data from injected.js', async () => {
        await setRules(
            mock('secret', '/\\/api\\/q[x]-match-(\\d+)/', { token: 'ZEBRA-SECRET-7731' }),
            mock('unused', '*/api/never-ZQ9*', { token: 'ZEBRA-SECRET-7731' })
        );
        await open();
        await page.evaluate(installHooks, SECRETS);

        // Matching and non-matching requests through both APIs, then a rule
        // change, so a state sync happens under the hooks too.
        const outcome = await page.evaluate(async () => {
            const viaFetch = async (path) => (await fetch(path)).headers.get('x-splicetap');
            const viaXHR = (path) => new Promise((resolve) => {
                const x = new XMLHttpRequest();
                x.onloadend = () => resolve(x.getResponseHeader('x-splicetap'));
                x.open('GET', path);
                x.send();
            });
            return [await viaFetch('/api/qx-match-1'), await viaFetch('/api/other'), await viaXHR('/api/qx-match-2'), await viaXHR('/api/other')];
        });
        await h.saveRule(mock('another', '*/api/another*'));
        await sleep(400);
        const after = await page.evaluate(async () => [(await fetch('/api/qx-match-3')).headers.get('x-splicetap'), (await fetch('/api/another')).headers.get('x-splicetap')]);
        hookLeaks = await page.evaluate(() => window.__hookLeaks.slice());
        const hits = await page.evaluate(() => window.__hookHits);

        expect(outcome).toEqual(['true', null, 'true', null]);
        expect(after).toEqual(['true', 'true']);
        expect(hits).toBeGreaterThan(0); // the hooks were live
        expect(hookLeaks.filter((leak) => leak.script === 'content/injected.js')).toEqual([]);
    });

    // Contract B, both halves: matcher.js, placeholders.js and patch.js now
    // take their built-ins at load too, so no hook sees rule data from any
    // SpliceTap script.
    test('contract B: no hook the page installs receives rule data from any SpliceTap script', () => {
        expect(hookLeaks).not.toBeNull();
        expect(hookLeaks.filter((leak) => leak.script !== null)).toEqual([]);
    });
});
