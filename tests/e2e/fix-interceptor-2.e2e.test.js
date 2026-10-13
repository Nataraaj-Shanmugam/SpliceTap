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
});
