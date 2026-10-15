/**
 * Batch 2, group G1 "network", in Chrome:
 *   B2-F7 — match.pageDomains (initiatorDomains) and match.resourceTypes on
 *           the DNR layer;
 *   B2-F9 — response-header append and queryParams.removeAll, through /echo;
 *   B2-F10 / PER-63 — explainMatch and editor drafts in the real worker;
 *   Reach — what an appliesTo:'all' block does to sendBeacon, WebSocket and
 *           EventSource (observed outcomes, pinned).
 */

/* global navigator, WebSocket, EventSource -- used inside page.evaluate */

const { createHash } = require('crypto');
const http = require('http');
const dnr = require('../../service_worker/dnr');
const { launch, pageFetch, sleep } = require('./harness');

// Tests that need the schema group's (G3) validation of the new fields: the
// save boundary refuses them until it merges.
const afterMerge = test.failing; // coordinator flips

/** Load an <img> and report whether it loaded. */
function loadImage(page, src) {
    return page.evaluate((s) => new Promise((resolve) => {
        const img = document.createElement('img');
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = s;
    }), src);
}

const unique = () => Math.random().toString(36).slice(2);

describe('B2-F7: page domains and resource types in Chrome', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });

    beforeEach(async () => {
        await h.reset();
        page = await h.openPage();
    });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    const port = () => new URL(h.baseUrl).port;
    const served = (pathname) => h.requests.filter((r) => r.path === pathname);
    const dynamicRules = () => h.extensionEval(() => chrome.declarativeNetRequest.getDynamicRules());

    test('an all-request block with pageDomains ["localhost"] blocks an <img> on localhost, not on 127.0.0.1', async () => {
        const saved = await h.saveRule({
            id: 'blk-local', name: 'Block pixel on localhost', enabled: true, type: 'block', appliesTo: 'all',
            match: { url: '*/assets/pixel.png*', method: '*', pageDomains: ['localhost'] }
        });
        expect(saved.dnrWarning).toBeUndefined();

        // Same server, same port: only the page's host differs.
        await page.goto(`http://localhost:${port()}/page`, { waitUntil: 'load' });
        expect(await loadImage(page, '/assets/pixel.png?n=' + unique())).toBe(false);
        expect(served('/assets/pixel.png')).toHaveLength(0);

        await page.goto(`http://127.0.0.1:${port()}/page`, { waitUntil: 'load' });
        expect(await loadImage(page, '/assets/pixel.png?n=' + unique())).toBe(true);
        expect(served('/assets/pixel.png')).toHaveLength(1);

        // Chrome holds exactly what the next sync would build, so the rule is
        // not re-registered on every save (PER-37).
        const [registered] = await dynamicRules();
        const stored = (await h.bg({ type: 'getRules' })).rules[0];
        expect(registered.condition.initiatorDomains).toEqual(['localhost']);
        expect(dnr.dnrRuleEqual(registered, dnr.ruleToDnr(stored, 0))).toBe(true);
    });

    test('a headers rule limited to "document" sets its header on a page navigation, not on a fetch', async () => {
        await h.saveRule({
            id: 'hdr-doc', name: 'Header on navigations', enabled: true, type: 'headers',
            match: { url: '*/echo*', method: '*', resourceTypes: ['document'] },
            headersMod: { request: [{ op: 'set', name: 'X-Nav', value: 'doc' }], response: [] }
        });

        await page.goto(h.baseUrl + '/echo?nav=' + unique(), { waitUntil: 'load' });
        const [navigation] = served('/echo');
        expect(navigation.headers['x-nav']).toBe('doc');
        // The page shows what the server received: the probe echoes it back.
        const echoed = JSON.parse(await page.evaluate(() => document.body.innerText));
        expect(echoed.headers['x-nav']).toBe('doc');

        const fetched = await pageFetch(page, '/echo?f=' + unique());
        expect(fetched.body.headers['x-nav']).toBeUndefined();

        const [registered] = await dynamicRules();
        expect(registered.condition.resourceTypes).toEqual(['main_frame']);
        const stored = (await h.bg({ type: 'getRules' })).rules[0];
        expect(dnr.dnrRuleEqual(registered, dnr.ruleToDnr(stored, 0))).toBe(true);
    });

    test('without a list, the same headers rule leaves navigations alone (today\'s default)', async () => {
        await h.saveRule({
            id: 'hdr-api', name: 'Header on API calls', enabled: true, type: 'headers',
            match: { url: '*/echo*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X-Nav', value: 'api' }], response: [] }
        });
        await page.goto(h.baseUrl + '/echo?nav=' + unique(), { waitUntil: 'load' });
        expect(served('/echo')[0].headers['x-nav']).toBeUndefined();
        expect((await pageFetch(page, '/echo?f=' + unique())).body.headers['x-nav']).toBe('api');
    });

    test('an all-request block limited to "image" blocks the <img> but not a fetch of the same URL', async () => {
        await h.saveRule({
            id: 'blk-img', name: 'Images only', enabled: true, type: 'block', appliesTo: 'all',
            match: { url: '*/assets/pixel.png*', method: '*', resourceTypes: ['image'] }
        });
        expect(await loadImage(page, '/assets/pixel.png?n=' + unique())).toBe(false);
        const fetched = await pageFetch(page, '/assets/pixel.png?n=' + unique());
        expect(fetched.ok).toBe(true);
        expect(fetched.status).toBe(200);
        expect(served('/assets/pixel.png')).toHaveLength(1);
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});

describe('B2-F9: header append and query "remove all" in Chrome', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });

    beforeEach(async () => {
        await h.reset();
        page = await h.openPage();
    });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    const echoHeaders = (pathname) => page.evaluate(async (u) => {
        const response = await fetch(u);
        return { multi: response.headers.get('x-multi'), body: await response.json() };
    }, pathname);
    const appendRule = (id, value) => ({
        id, name: 'Append ' + value, enabled: true, type: 'headers',
        match: { url: '*/echo*', method: '*' },
        headersMod: { request: [], response: [{ op: 'append', name: 'X-Multi', value }] }
    });

    afterMerge('two rules appending to one response header both land, where "set" keeps only one', async () => {
        expect((await h.saveRule(appendRule('app-a', 'a'))).dnrWarning).toBeUndefined();
        expect((await h.saveRule(appendRule('app-b', 'b'))).dnrWarning).toBeUndefined();
        const appended = await echoHeaders('/echo?n=' + unique());
        expect(appended.body.real).toBe(true);
        expect(appended.multi.split(/,\s*/).sort()).toEqual(['a', 'b']);

        // The contrast: two "set" rules on one header — only one value lands.
        await h.reset();
        await h.saveRule({ ...appendRule('set-a', 'a'), headersMod: { request: [], response: [{ op: 'set', name: 'X-Multi', value: 'a' }] } });
        await h.saveRule({ ...appendRule('set-b', 'b'), headersMod: { request: [], response: [{ op: 'set', name: 'X-Multi', value: 'b' }] } });
        expect((await echoHeaders('/echo?n=' + unique())).multi).toMatch(/^[ab]$/);
    });

    afterMerge('removeAll alone drops the whole query', async () => {
        const saved = await h.saveRule({
            id: 'qp-clear', name: 'Drop the query', enabled: true, type: 'queryparams',
            match: { url: '*/echo*', method: '*' },
            queryParams: { removeAll: true }
        });
        expect(saved.dnrWarning).toBeUndefined();
        const fetched = await pageFetch(page, '/echo?a=1&b=2');
        expect(fetched.body.query).toEqual({});
        expect(h.requests.filter((r) => r.path === '/echo').map((r) => r.query)).toEqual(['']);
    });

    test('B2-F10: explainMatch runs in the real worker — an example URL, the result and who shadows it', async () => {
        const mock = (id, name) => ({
            id, name, enabled: true, type: 'mock', match: { url: '*/api/*', method: '*' },
            response: { statusCode: 200, headers: {}, body: {}, delay: 0 }
        });
        await h.saveRule(mock('first', 'Catch-all API'));
        await h.saveRule(mock('second', 'Users'));
        const response = await h.bg({ type: 'explainMatch', ruleId: 'second' });
        expect(response).toMatchObject({
            success: true,
            url: 'https://example.testx/api/x',
            network: false,
            shadowedBy: [{ ruleId: 'first', ruleName: 'Catch-all API' }]
        });
        expect(response.result.matches).toBe(true);
        expect(response.result.checks.find((c) => c.condition === 'url').ok).toBe(true);

        const regex = await h.bg({ type: 'explainMatch', rule: { ...mock('r', 'Regex'), match: { url: '/\\/api\\//', method: '*' } } });
        expect(regex).toMatchObject({ success: false, needsUrl: true });
    });

    test('PER-63: a draft saved for the options page is kept in session storage and survives a page reload', async () => {
        const draft = { rule: { name: 'Half-written', type: 'mock', match: { url: '*/api/*', method: '*' } } };
        expect((await h.bg({ type: 'saveEditorDraft', tabId: 'options', draft })).success).toBe(true);
        await h.control.reload({ waitUntil: 'load' });
        expect((await h.bg({ type: 'getEditorDraft', tabId: 'options' })).draft).toEqual(draft);
        const session = await h.extensionEval(() => chrome.storage.session.get('spliceTapDrafts'));
        expect(session.spliceTapDrafts.options.draft).toEqual(draft);
        const local = await h.extensionEval(() => chrome.storage.local.get('spliceTapDrafts'));
        expect(local).toEqual({});
        await h.bg({ type: 'clearEditorDraft', tabId: 'options' });
        expect((await h.bg({ type: 'getEditorDraft', tabId: 'options' })).draft).toBeNull();
    });

    test('removeAll with params to add leaves exactly those, encoded', async () => {
        const saved = await h.saveRule({
            id: 'qp-only', name: 'Only these params', enabled: true, type: 'queryparams',
            match: { url: '*/echo*', method: '*' },
            queryParams: { removeAll: true, add: [{ key: 'flag', value: 'on' }, { key: 'q x', value: 'a&b=c' }], remove: [] }
        });
        expect(saved.dnrWarning).toBeUndefined();
        const fetched = await pageFetch(page, '/echo?a=1&flag=off&b=2');
        expect(fetched.body.query).toEqual({ flag: 'on', 'q x': 'a&b=c' });
        expect(h.requests.filter((r) => r.path === '/echo').map((r) => r.query)).toEqual(['?flag=on&q%20x=a%26b%3Dc']);

        // Already exactly those: Chrome leaves the request alone.
        h.requests.length = 0;
        await pageFetch(page, '/echo?flag=on&q%20x=a%26b%3Dc');
        expect(h.requests.filter((r) => r.path === '/echo')).toHaveLength(1);
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});

/**
 * A probe server for the transports the harness server does not speak: a
 * beacon sink, a server-sent event stream and a WebSocket endpoint (a bare
 * RFC 6455 handshake plus one text frame — enough to tell "connected" from
 * "refused"). It records every request that reaches it.
 */
function startReachServer() {
    const hits = [];
    const server = http.createServer((req, res) => {
        const { pathname, searchParams } = new URL(req.url, 'http://probe');
        hits.push({ kind: 'http', path: pathname, method: req.method, query: Object.fromEntries(searchParams) });
        if (pathname === '/page') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<!doctype html><html><head><meta charset="utf-8"><title>Reach</title></head><body>reach</body></html>');
        } else if (pathname.startsWith('/reach/sse')) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write('data: hello\n\n');
            setTimeout(() => res.end(), 200);
        } else if (pathname.startsWith('/reach/beacon')) {
            req.resume();
            req.on('end', () => { res.writeHead(204); res.end(); });
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    server.on('upgrade', (req, socket) => {
        const { pathname } = new URL(req.url, 'http://probe');
        hits.push({ kind: 'upgrade', path: pathname });
        const accept = createHash('sha1')
            .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('hello')]));
        socket.on('error', () => undefined);
        setTimeout(() => socket.destroy(), 500);
    });
    return new Promise((resolve) => {
        server.listen(0, () => resolve({ server, hits, base: `127.0.0.1:${server.address().port}` }));
    });
}

/** What the page sees of each transport, and what the server received. */
async function reachAll(page, probe) {
    probe.hits.length = 0;
    const seen = await page.evaluate(async (base) => {
        const n = Math.random().toString(36).slice(2);
        const settle = (start) => new Promise((resolve) => {
            const timer = setTimeout(() => resolve('timeout'), 3000);
            start((outcome) => { clearTimeout(timer); resolve(outcome); });
        });
        const beaconQueued = navigator.sendBeacon(`http://${base}/reach/beacon?n=${n}`, 'payload');
        const ws = await settle((done) => {
            const socket = new WebSocket(`ws://${base}/reach/ws?n=${n}`);
            socket.onmessage = (e) => { done('message:' + e.data); socket.close(); };
            socket.onerror = () => done('error');
        });
        const sse = await settle((done) => {
            const source = new EventSource(`http://${base}/reach/sse?n=${n}`);
            source.onmessage = (e) => { done('message:' + e.data); source.close(); };
            source.onerror = () => { done('error'); source.close(); };
        });
        return { beaconQueued, ws, sse };
    }, probe.base);
    await sleep(800); // the beacon is sent after the call returns
    const reached = (kind, path) => probe.hits.some((x) => x.kind === kind && x.path === path);
    return {
        ...seen,
        serverGotBeacon: reached('http', '/reach/beacon'),
        serverGotWebSocket: reached('upgrade', '/reach/ws'),
        serverGotEventSource: reached('http', '/reach/sse')
    };
}

describe('Reach: does an all-request block stop sendBeacon, WebSocket and EventSource?', () => {
    let h;
    let probe;
    let page;

    beforeAll(async () => {
        h = await launch();
        probe = await startReachServer();
    });
    afterAll(async () => {
        if (h) await h.close();
        if (probe) await new Promise((resolve) => probe.server.close(resolve));
    });

    beforeEach(async () => {
        await h.reset();
        page = await h.browser.newPage();
        await page.goto(`http://${probe.base}/page`, { waitUntil: 'load' });
    });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    test('with no rule, all three reach the server (the probe works)', async () => {
        const outcome = await reachAll(page, probe);
        expect(outcome).toEqual({
            beaconQueued: true, ws: 'message:hello', sse: 'message:hello',
            serverGotBeacon: true, serverGotWebSocket: true, serverGotEventSource: true
        });
    });

    test('an appliesTo:"all" block stops sendBeacon and WebSocket, but NOT EventSource (observed, pinned)', async () => {
        const saved = await h.saveRule({
            id: 'blk-reach', name: 'Block reach', enabled: true, type: 'block', appliesTo: 'all',
            match: { url: '*/reach/*', method: '*' }
        });
        expect(saved.dnrWarning).toBeUndefined();
        const outcome = await reachAll(page, probe);
        // Observed in Chrome for Testing (this suite's browser):
        //  - sendBeacon is a 'ping' request: DNR blocks it. The call still
        //    returns true — the beacon is queued, then refused off-page.
        //  - WebSocket is a 'websocket' request: DNR blocks the handshake and
        //    the page sees an error event.
        //  - EventSource is NOT blocked. Chrome classifies it as
        //    xmlhttprequest (next test), which the DNR rule leaves to the
        //    interceptor (F1: no request handled twice) — and the interceptor
        //    patches fetch and XHR only, not EventSource. A docs-visible gap.
        expect(outcome).toEqual({
            beaconQueued: true, ws: 'error', sse: 'message:hello',
            serverGotBeacon: false, serverGotWebSocket: false, serverGotEventSource: true
        });
    });

    test('EventSource is an xmlhttprequest to Chrome: a fetch-xhr-only query rule rewrites it', async () => {
        await h.saveRule({
            id: 'qp-sse', name: 'Tag XHR', enabled: true, type: 'queryparams',
            match: { url: '*/reach/sse*', method: '*', resourceTypes: ['fetch-xhr'] },
            queryParams: { add: [{ key: 'tagged', value: 'xhr' }], remove: [] }
        });
        const outcome = await reachAll(page, probe);
        expect(outcome.sse).toBe('message:hello');
        const sse = probe.hits.filter((x) => x.path === '/reach/sse');
        expect(sse.map((x) => x.query.tagged)).toEqual(['xhr']);
    });

    test('ran without errors in the extension', () => {
        // The probe page is not watched: the blocked WebSocket's console
        // error there is the outcome under test.
        expect(h.allErrors).toEqual([]);
    });
});
