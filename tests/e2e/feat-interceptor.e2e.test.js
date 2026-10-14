/**
 * Feature group G2, "interceptor", in a real browser: F3 request-body rules
 * (what the server actually receives) and F4 code responses (including a
 * page whose CSP forbids eval). Pages that echo request bodies come from a
 * second local server, `aux`; the content scripts run on every origin.
 */

const http = require('http');
const { launch, pageFetch, pageXHR, waitFor } = require('./harness');

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const mock = (id, url, body = { mocked: id }, response = {}, match = {}) => ({
    id, name: id, enabled: true, type: 'mock', match: { url, method: '*', ...match },
    response: { statusCode: 200, headers: JSON_HEADERS, body, delay: 0, mode: 'static', ...response }
});
const control = mock('control', '*/api/control*', { control: true });

const bodyRule = (id, url, requestBody, match = {}) => ({
    id, name: id, enabled: true, type: 'requestBody', match: { url, method: '*', ...match }, requestBody
});

const codeRule = (id, url, code, response = {}) => ({
    id, name: id, enabled: true, type: 'mock', match: { url, method: '*' },
    response: { mode: 'code', code, statusCode: 200, delay: 0, ...response }
});

/** A second origin whose /echo reports the request exactly as it arrived. */
function startAux() {
    const hits = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            hits.push({ method: req.method, path: url.pathname, body, contentType: req.headers['content-type'] || null });
            if (url.pathname === '/page') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<!doctype html><html><head><meta charset="utf-8"><title>aux</title></head><body>aux</body></html>');
                return;
            }
            if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
            res.writeHead(200, JSON_HEADERS);
            res.end(JSON.stringify({ real: true, path: url.pathname, method: req.method, contentType: req.headers['content-type'] || null, body }));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        hits,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r))
    })));
}

describe('feat-interceptor: request-body rules and code responses in a real browser', () => {
    let h;
    let aux;
    let page;
    let baseSettings;

    beforeAll(async () => {
        h = await launch();
        aux = await startAux();
        baseSettings = (await h.bg({ type: 'getRules' })).settings;
    });
    afterAll(async () => {
        if (h) {
            await h.bg({ type: 'settingsUpdated', settings: baseSettings });
            await h.close();
        }
        if (aux) await aux.close();
    });
    afterEach(async () => {
        if (page && !page.isClosed()) await page.close();
        page = null;
    });

    /** Replace every rule (plus a control rule), with code responses on or off. */
    async function setRules(rules, { code = false } = {}) {
        await h.reset();
        aux.hits.length = 0;
        const settings = await h.bg({ type: 'settingsUpdated', settings: { ...baseSettings, allowCodeResponses: code } });
        expect(settings && settings.success).toBe(true);
        const response = await h.bg({ type: 'setRules', rules: [control, ...rules] });
        expect(response && response.success).toBe(true);
    }

    /** Open an aux page (default) or a harness path once the control rule is live there. */
    async function open(where = aux.base + '/page') {
        page = await h.browser.newPage();
        page.on('pageerror', (e) => h.record({ where: 'page', text: 'pageerror: ' + e.message }));
        page.on('console', (msg) => { if (msg.type() === 'error') h.record({ where: 'page', text: msg.text() }); });
        await page.goto(where.startsWith('http') ? where : h.baseUrl + where, { waitUntil: 'load' });
        await waitFor(async () => (await pageFetch(page, '/api/control')).marker === 'true', { label: 'rules on page' });
        return page;
    }

    /** Log entries for `ruleId`, once at least `count` have arrived. */
    async function logFor(ruleId, count = 1) {
        return waitFor(async () => {
            const { entries } = await h.bg({ type: 'getInterceptionLog' });
            const mine = entries.filter((e) => e.ruleId === ruleId);
            return mine.length >= count ? mine : null;
        }, { label: `log entries for ${ruleId}` });
    }

    const pageErrors = () => h.errors.filter((e) => e.where === 'page');

    // --- F3 ------------------------------------------------------------------

    describe('F3: request-body rules', () => {
        test('static, fetch: the server receives the new body with a JSON Content-Type', async () => {
            await setRules([bodyRule('rb-static', '*/echo*', { mode: 'static', body: { replaced: true, at: '{{request.method}}' } })]);
            await open();
            const res = await pageFetch(page, '/echo', { method: 'POST', body: 'original' });
            expect(res.body).toEqual(expect.objectContaining({ real: true, contentType: 'application/json' }));
            expect(JSON.parse(res.body.body)).toEqual({ replaced: true, at: 'POST' });
            const [entry] = await logFor('rb-static');
            expect(entry).toEqual(expect.objectContaining({ ruleType: 'requestBody', note: 'Request body replaced', finalStatus: 200 }));
            expect(pageErrors()).toEqual([]);
        });

        test('static, fetch(Request): the rebuilt request reaches the server (PER-11)', async () => {
            await setRules([bodyRule('rb-request', '*/echo*', { mode: 'static', body: 'as text' })]);
            await open();
            const result = await page.evaluate(async () => {
                const response = await fetch(new Request('/echo?r=1', {
                    method: 'PUT', body: 'original', headers: { 'X-Keep': 'yes' }, credentials: 'include'
                }));
                return response.json();
            });
            expect(result).toEqual(expect.objectContaining({ method: 'PUT', body: 'as text', path: '/echo' }));
        });

        test('static, XHR: the server receives the new body', async () => {
            await setRules([bodyRule('rb-xhr', '*/echo*', { mode: 'static', body: [1, 2] })]);
            await open();
            const res = await pageXHR(page, '/echo', { method: 'POST', body: 'original' });
            expect(res.status).toBe(200);
            expect(res.body).toEqual(expect.objectContaining({ body: '[1,2]', contentType: 'application/json' }));
            expect(res.loads).toBe(1);
        });

        test('patch, fetch and XHR: the server receives the merged JSON', async () => {
            await setRules([bodyRule('rb-patch', '*/echo*', { mode: 'patch', patch: { role: 'admin', drop: null } })]);
            await open();
            const sent = JSON.stringify({ name: 'n', role: 'user', drop: 1 });
            const viaFetch = await pageFetch(page, '/echo', { method: 'POST', headers: JSON_HEADERS, body: sent });
            expect(JSON.parse(viaFetch.body.body)).toEqual({ name: 'n', role: 'admin' });
            expect(viaFetch.body.contentType).toBe('application/json');
            const viaXHR = await pageXHR(page, '/echo', { method: 'PATCH', headers: JSON_HEADERS, body: sent });
            expect(JSON.parse(viaXHR.body.body)).toEqual({ name: 'n', role: 'admin' });
            const entries = await logFor('rb-patch', 2);
            expect(entries.map((e) => e.note)).toEqual(['Request body patched', 'Request body patched']);
        });

        test('patch: FormData is sent unchanged, and the log says why', async () => {
            await setRules([bodyRule('rb-form', '*/echo*', { mode: 'patch', patch: { p: 1 } })]);
            await open();
            const echoed = await page.evaluate(async () => {
                const form = new FormData();
                form.append('field', 'value');
                return (await fetch('/echo', { method: 'POST', body: form })).json();
            });
            expect(echoed.contentType).toMatch(/^multipart\/form-data; boundary=/);
            expect(echoed.body).toContain('name="field"');
            const [entry] = await logFor('rb-form');
            expect(entry.note).toBe('Request body not patched — the body is FormData, not JSON text');
        });

        test('a GET is never rewritten', async () => {
            await setRules([bodyRule('rb-get', '*/echo*', { mode: 'static', body: 'x' })]);
            await open();
            const res = await pageFetch(page, '/echo');
            expect(res.body.body).toBe('');
            expect(aux.hits.filter((hit) => hit.path === '/echo')).toEqual([expect.objectContaining({ method: 'GET', body: '' })]);
        });

        for (const via of ['fetch', 'XHR']) {
            test(`then a mock keyed on the modified body (match.graphql) answers — ${via}`, async () => {
                const graphMock = mock('gql-mock', '*/graphql*', { data: { rewritten: true } }, {}, { method: 'POST', graphql: { operationName: 'Rewritten' } });
                await setRules([
                    graphMock,
                    bodyRule('rb-gql', '*/graphql*', { mode: 'patch', patch: { operationName: 'Rewritten' } })
                ]);
                await open();
                const body = JSON.stringify({ operationName: 'Original', query: 'query Original { x }' });
                const res = via === 'fetch'
                    ? await pageFetch(page, '/graphql', { method: 'POST', headers: JSON_HEADERS, body })
                    : await pageXHR(page, '/graphql', { method: 'POST', headers: JSON_HEADERS, body });
                expect(res.marker).toBe('true');
                expect(res.body).toEqual({ data: { rewritten: true } });
                expect(aux.hits.filter((hit) => hit.path === '/graphql')).toEqual([]);
                const [bodyEntry] = await logFor('rb-gql');
                expect(bodyEntry).toEqual(expect.objectContaining({ note: 'Request body patched', finalStatus: 200 }));
                await logFor('gql-mock');
            });
        }

        test('without the body rule, the same mock does not match the original body (control)', async () => {
            const graphMock = mock('gql-mock', '*/graphql*', { data: { rewritten: true } }, {}, { method: 'POST', graphql: { operationName: 'Rewritten' } });
            await setRules([graphMock]);
            await open();
            const res = await pageFetch(page, '/graphql', { method: 'POST', headers: JSON_HEADERS, body: '{"operationName":"Original"}' });
            expect(res.marker).toBe(null);
            expect(res.body.real).toBe(true);
        });

        for (const via of ['fetch', 'XHR']) {
            test(`a redirect sends the modified body — ${via}`, async () => {
                await setRules([
                    { id: 'rd', name: 'rd', enabled: true, type: 'redirect', match: { url: '*/submit*', method: '*' }, redirect: { destination: '/echo?from=redirect' } },
                    bodyRule('rb-rd', '*/submit*', { mode: 'static', body: { sent: 'modified' } })
                ]);
                await open();
                const res = via === 'fetch'
                    ? await pageFetch(page, '/submit', { method: 'POST', body: 'original' })
                    : await pageXHR(page, '/submit', { method: 'POST', body: 'original' });
                expect(res.body).toEqual(expect.objectContaining({ path: '/echo', body: '{"sent":"modified"}', contentType: 'application/json' }));
            });
        }
    });

    // --- F4 ------------------------------------------------------------------

    describe('F4: code responses', () => {
        test('returning an object: a JSON 200 on fetch and XHR, with markers and fidelity', async () => {
            await setRules([codeRule('code-obj', '*/api/code*', 'return { from: "code", method: request.method, url: request.url };')], { code: true });
            await open();
            const viaFetch = await pageFetch(page, '/api/code?x=1');
            expect(viaFetch).toEqual(expect.objectContaining({
                status: 200, marker: 'true', contentType: 'application/json', url: aux.base + '/api/code?x=1'
            }));
            expect(viaFetch.body).toEqual({ from: 'code', method: 'GET', url: aux.base + '/api/code?x=1' });
            const clone = await page.evaluate(async () => {
                const response = await fetch('/api/code');
                const copy = response.clone();
                return { status: copy.status, url: copy.url, body: await copy.json() };
            });
            expect(clone).toEqual({ status: 200, url: aux.base + '/api/code', body: expect.objectContaining({ from: 'code' }) });

            const viaXHR = await pageXHR(page, '/api/code', { method: 'POST', body: '{}' });
            expect(viaXHR).toEqual(expect.objectContaining({ outcome: 'load', status: 200, marker: 'true', loads: 1 }));
            expect(viaXHR.states).toEqual([1, 2, 3, 4]);
            expect(viaXHR.body).toEqual(expect.objectContaining({ from: 'code', method: 'POST' }));
            expect(aux.hits.filter((hit) => hit.path === '/api/code')).toEqual([]);
            expect(pageErrors()).toEqual([]);
        });

        test('returning {status: 201, headers, body}', async () => {
            await setRules([codeRule('code-201', '*/api/code*',
                'return { status: 201, headers: { "X-Made-By": "code" }, body: { id: request.json && request.json.n } };')], { code: true });
            await open();
            const viaFetch = await page.evaluate(async () => {
                const response = await fetch('/api/code', { method: 'POST', body: '{"n":5}' });
                return { status: response.status, made: response.headers.get('x-made-by'), body: await response.json() };
            });
            expect(viaFetch).toEqual({ status: 201, made: 'code', body: { id: 5 } });
            const viaXHR = await page.evaluate(() => new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.onloadend = () => resolve({ status: xhr.status, made: xhr.getResponseHeader('x-made-by'), body: xhr.responseText });
                xhr.open('POST', '/api/code');
                xhr.send('{"n":6}');
            }));
            expect(viaXHR).toEqual({ status: 201, made: 'code', body: '{"id":6}' });
            const entries = await logFor('code-201', 2);
            expect(entries.map((e) => e.status)).toEqual([201, 201]);
        });

        test('async code is awaited', async () => {
            await setRules([codeRule('code-async', '*/api/code*',
                'await new Promise((r) => setTimeout(r, 150)); return "late " + request.method;')], { code: true });
            await open();
            const res = await pageFetch(page, '/api/code', { method: 'PUT', body: 'x' });
            expect(res.body).toBe('late PUT');
            expect(res.contentType).toBe('text/plain');
            expect(res.ms).toBeGreaterThanOrEqual(140);
        });

        test('code that throws: the request goes to the network, with the message logged', async () => {
            await setRules([codeRule('code-throws', '*/api/code*', 'throw new Error("deliberate failure");')], { code: true });
            await open();
            const viaFetch = await pageFetch(page, '/api/code');
            expect(viaFetch.body).toEqual(expect.objectContaining({ real: true, path: '/api/code' }));
            const viaXHR = await pageXHR(page, '/api/code', { method: 'POST', body: 'b' });
            expect(viaXHR.body).toEqual(expect.objectContaining({ real: true, body: 'b' }));
            expect(viaXHR.loads).toBe(1);
            expect(aux.hits.filter((hit) => hit.path === '/api/code')).toHaveLength(2);
            const entries = await logFor('code-throws', 2);
            expect(entries.map((e) => [e.note, e.finalStatus])).toEqual([
                ['Code response threw: deliberate failure', 200],
                ['Code response threw: deliberate failure', 200]
            ]);
        });

        test('off in Settings: the request goes to the network, noted', async () => {
            await setRules([codeRule('code-off', '*/api/code*', 'return "never";')], { code: false });
            await open();
            expect((await pageFetch(page, '/api/code')).body).toEqual(expect.objectContaining({ real: true }));
            expect((await pageXHR(page, '/api/code')).body).toEqual(expect.objectContaining({ real: true }));
            const entries = await logFor('code-off', 2);
            expect(entries.map((e) => e.note)).toEqual(['Code responses are turned off in Settings', 'Code responses are turned off in Settings']);
        });

        test('switching the setting on reaches an open page without a reload', async () => {
            await setRules([codeRule('code-live', '*/api/code*', 'return { live: true };')], { code: false });
            await open();
            expect((await pageFetch(page, '/api/code')).body.real).toBe(true);
            await h.bg({ type: 'settingsUpdated', settings: { ...baseSettings, allowCodeResponses: true } });
            await waitFor(async () => (await pageFetch(page, '/api/code')).marker === 'true', { label: 'code on after the setting' });
        });

        test('a page whose CSP forbids eval: passed through, noted, and the code never quoted', async () => {
            const marker = 'SECRET_CODE_MARKER_42';
            await setRules([codeRule('code-csp', '*/api/csp-code*', `const tag = "${marker}"; return { tag };`)], { code: true });
            await open('/csp-page');
            // From a page task, as page code would: DevTools lets eval
            // through CSP for code on page.evaluate's own stack.
            const result = await page.evaluate(() => new Promise((resolve) => {
                const samples = [];
                document.addEventListener('securitypolicyviolation', (e) => samples.push(String(e.sample)));
                setTimeout(async () => {
                    const first = await (await fetch('/api/csp-code')).json();
                    const second = await (await fetch('/api/csp-code')).json();
                    const third = await new Promise((done) => {
                        const xhr = new XMLHttpRequest();
                        xhr.onloadend = () => done(JSON.parse(xhr.responseText));
                        xhr.open('GET', '/api/csp-code');
                        xhr.send();
                    });
                    setTimeout(() => resolve({ first, second, third, samples }), 200);
                }, 0);
            }));
            expect(result.first).toEqual(expect.objectContaining({ real: true }));
            expect(result.second).toEqual(expect.objectContaining({ real: true }));
            expect(result.third).toEqual(expect.objectContaining({ real: true }));
            expect(result.samples.join(' ')).not.toContain(marker);
            // One refusal (the probe), not one per request.
            expect(result.samples.length).toBeLessThanOrEqual(1);
            const entries = await logFor('code-csp', 3);
            expect(entries.map((e) => e.note)).toEqual(Array(3).fill("Blocked by this page's Content-Security-Policy"));
            // Chrome reports the refused probe in the console; nothing else.
            expect(pageErrors().filter((e) => !/unsafe-eval|Content Security Policy|evaluate a string/i.test(e.text))).toEqual([]);
            for (const e of pageErrors()) expect(e.text).not.toContain(marker);
        });

        test('the code sees the body a request-body rule wrote', async () => {
            await setRules([
                codeRule('code-sees', '*/api/code*', 'return { got: request.json, type: request.headers["content-type"] };'),
                bodyRule('rb-for-code', '*/api/code*', { mode: 'static', body: { rewritten: 1 } })
            ], { code: true });
            await open();
            const res = await pageFetch(page, '/api/code', { method: 'POST', body: 'original' });
            expect(res.body).toEqual({ got: { rewritten: 1 }, type: 'application/json' });
        });
    });
});
