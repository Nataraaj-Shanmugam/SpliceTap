/**
 * Tests for the XMLHttpRequest half of content/injected.js (CQ-8).
 *
 * XHR is not a legacy afterthought here — jQuery.ajax and Angular's HttpClient
 * both use it, so this is half the interception surface, and it carries most
 * of the accumulated bug fixes in the repo. It had no coverage at all.
 *
 * These lean on tests/helpers/mock-xhr.js, which simulates the network and
 * dispatches events the way a browser does (including `on*` as real
 * event-handler attributes, which is what makes the Q-1 double-dispatch
 * regression detectable).
 */

const { createInterceptor } = require('./helpers/injected-harness');

function mockRule(overrides = {}) {
    return {
        id: 'r1',
        name: 'Mock users',
        enabled: true,
        type: 'mock',
        match: { url: '*/api/users*', method: 'GET' },
        response: {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: { mocked: true },
            delay: 0,
            mode: 'static'
        },
        ...overrides
    };
}

/** Drive one XHR to completion and report what the page would observe. */
function request(h, url, options = {}) {
    const { method = 'GET', headers = {}, body = null, responseType = '', configure } = options;

    return new Promise((resolve, reject) => {
        const xhr = h.newXHR();
        if (responseType) xhr.responseType = responseType;

        const done = (outcome) => resolve({
            outcome,
            status: xhr.status,
            statusText: xhr.statusText,
            responseText: xhr.responseText,
            response: xhr.response,
            readyState: xhr.readyState,
            marker: xhr.getResponseHeader('x-splicetap'),
            allHeaders: xhr.getAllResponseHeaders(),
            xhr
        });

        xhr.addEventListener('load', () => done('load'));
        xhr.addEventListener('error', () => done('error'));
        xhr.addEventListener('abort', () => done('abort'));
        setTimeout(() => reject(new Error('XHR never settled for ' + url)), 3000);

        xhr.open(method, url);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        if (configure) configure(xhr);
        xhr.send(body);
    });
}

describe('XHR interception — the core path', () => {
    test('a matching rule answers from the mock, without touching the network', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule({ response: { statusCode: 201, body: { mocked: true }, mode: 'static' } })] });

        const result = await request(h, 'https://example.test/api/users/1');

        expect(result.status).toBe(201);
        expect(JSON.parse(result.responseText)).toEqual({ mocked: true });
        expect(h.xhrCalls).toHaveLength(0);
    });

    test('a non-matching URL reaches the network', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        const result = await request(h, 'https://example.test/other');

        expect(JSON.parse(result.responseText)).toEqual({ origin: true });
        expect(h.xhrCalls).toHaveLength(1);
    });

    test('a method mismatch reaches the network', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        await request(h, 'https://example.test/api/users', { method: 'POST' });

        expect(h.xhrCalls).toHaveLength(1);
    });

    test('a disabled rule does not intercept', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule({ enabled: false })] });

        await request(h, 'https://example.test/api/users/1');

        expect(h.xhrCalls).toHaveLength(1);
    });

    test('nothing is intercepted while the extension is inactive', async () => {
        const h = createInterceptor();
        h.syncState({ active: false, rules: [mockRule()] });

        await request(h, 'https://example.test/api/users/1');

        expect(h.xhrCalls).toHaveLength(1);
    });

    test('reaches readyState 4 on a mocked response', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        const result = await request(h, 'https://example.test/api/users/1');

        expect(result.readyState).toBe(4);
    });
});

describe('XHR response headers (Q-7)', () => {
    test('exposes the configured headers plus the SpliceTap markers', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [mockRule({ response: { statusCode: 200, headers: { 'X-Mock': 'yes' }, body: {}, mode: 'static' } })]
        });

        const result = await request(h, 'https://example.test/api/users');

        expect(result.xhr.getResponseHeader('X-Mock')).toBe('yes');
        expect(result.marker).toBe('true');
        expect(result.xhr.getResponseHeader('x-splicetap-rule')).toBe('Mock users');
    });

    test('getAllResponseHeaders reports the mocked set', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule({ response: { statusCode: 200, headers: { 'X-Mock': 'yes' }, body: {}, mode: 'static' } })] });

        const result = await request(h, 'https://example.test/api/users');

        expect(result.allHeaders).toMatch(/x-mock: yes/i);
        expect(result.allHeaders).toMatch(/x-splicetap: true/i);
    });

    test('a passed-through response keeps the real headers and no marker', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        const result = await request(h, 'https://example.test/other');

        expect(result.marker).toBeNull();
    });
});

describe('XHR responseType (Q-7)', () => {
    test("responseType 'json' yields a parsed object, not text", async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule({ response: { statusCode: 200, body: { parsed: true }, mode: 'static' } })] });

        const result = await request(h, 'https://example.test/api/users', { responseType: 'json' });

        expect(result.response).toEqual({ parsed: true });
    });

    test("responseType 'text' yields the raw string", async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule({ response: { statusCode: 200, body: { a: 1 }, mode: 'static' } })] });

        const result = await request(h, 'https://example.test/api/users', { responseType: 'text' });

        expect(typeof result.response).toBe('string');
        expect(JSON.parse(result.response)).toEqual({ a: 1 });
    });
});

describe('XHR event dispatch (Q-1 / Q-8)', () => {
    test('an assigned onload runs exactly once', async () => {
        // Q-1: the wrapper used to call `if (xhr.onload) xhr.onload(...)` after
        // dispatchEvent, which already invokes handler attributes — so every
        // handler ran twice. mock-xhr models on* as real IDL attributes so a
        // reintroduction of that shows up here.
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        let calls = 0;
        await new Promise((resolve) => {
            const xhr = h.newXHR();
            xhr.onload = () => { calls++; };
            xhr.addEventListener('loadend', resolve);
            xhr.open('GET', 'https://example.test/api/users');
            xhr.send();
        });

        expect(calls).toBe(1);
    });

    test('onreadystatechange sees the terminal state exactly once', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        const states = [];
        await new Promise((resolve) => {
            const xhr = h.newXHR();
            xhr.onreadystatechange = () => states.push(xhr.readyState);
            xhr.addEventListener('loadend', resolve);
            xhr.open('GET', 'https://example.test/api/users');
            xhr.send();
        });

        expect(states.filter((s) => s === 4)).toHaveLength(1);
    });

    test('a mocked response fires loadend', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        const seen = await new Promise((resolve) => {
            const events = [];
            const xhr = h.newXHR();
            for (const type of ['load', 'loadend']) {
                xhr.addEventListener(type, () => {
                    events.push(type);
                    if (type === 'loadend') resolve(events);
                });
            }
            xhr.open('GET', 'https://example.test/api/users');
            xhr.send();
        });

        expect(seen).toContain('load');
        expect(seen).toContain('loadend');
    });
});

describe('XHR rule types', () => {
    test('a delay rule holds the response for the configured time', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [mockRule({ response: { statusCode: 200, body: { mocked: true }, delay: 120, mode: 'static' } })]
        });

        const start = Date.now();
        await request(h, 'https://example.test/api/users');

        expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    });

    test('a block rule fails the request instead of answering it', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [{
                id: 'b1', name: 'Block', enabled: true, type: 'block',
                match: { url: '*/api/users*', method: 'GET' }
            }]
        });

        const result = await request(h, 'https://example.test/api/users');

        expect(result.outcome).toBe('error');
        expect(h.xhrCalls).toHaveLength(0);
    });

    test('patch mode merges into the real response', async () => {
        // Note the responder being stubbed: a patch-mode XHR fetches the real
        // response through originalFetch (injected.js:1047), not through a
        // nested XHR — which is what QA-6's AbortController is wired to. So
        // the real payload comes from originalFetch even on the XHR path, and
        // no XHR ever reaches the network.
        const h = createInterceptor({
            originalFetch: async () => new Response(
                JSON.stringify({ id: 1, name: 'real', keep: true }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
        });
        h.syncState({
            rules: [mockRule({ response: { mode: 'patch', patch: { name: 'patched' } } })]
        });

        const result = await request(h, 'https://example.test/api/users/1');

        expect(JSON.parse(result.responseText)).toEqual({ id: 1, name: 'patched', keep: true });
        expect(h.passthroughCalls).toHaveLength(1); // patch needs the real response
        expect(h.xhrCalls).toHaveLength(0);
    });

    test('a header match condition is honoured', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [mockRule({ match: { url: '*/api/users*', method: 'GET', headers: { 'X-Env': 'dev' } } })]
        });

        await request(h, 'https://example.test/api/users', { headers: { 'X-Env': 'prod' } });
        expect(h.xhrCalls).toHaveLength(1);

        const matched = await request(h, 'https://example.test/api/users', { headers: { 'X-Env': 'dev' } });
        expect(JSON.parse(matched.responseText)).toEqual({ mocked: true });
    });
});

describe('XHR abort (Q-13)', () => {
    test('aborting a delayed mock fires abort and never load', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [mockRule({ response: { statusCode: 200, body: {}, delay: 500, mode: 'static' } })]
        });

        const events = [];
        await new Promise((resolve) => {
            const xhr = h.newXHR();
            xhr.addEventListener('load', () => events.push('load'));
            xhr.addEventListener('abort', () => { events.push('abort'); resolve(); });
            xhr.open('GET', 'https://example.test/api/users');
            xhr.send();
            setTimeout(() => xhr.abort(), 20);
        });

        // Give the mock's delay time to elapse; nothing more should arrive.
        await new Promise((resolve) => setTimeout(resolve, 600));

        expect(events).toEqual(['abort']);
    });
});

describe('XHR statics (Q-27)', () => {
    test('the patched constructor still carries the readyState constants', async () => {
        // `xhr.readyState === XMLHttpRequest.DONE` is a common idiom; the
        // wrapper only copied .prototype at first, leaving these undefined for
        // every page, mocked or not.
        const h = createInterceptor();

        expect(h.window.XMLHttpRequest.UNSENT).toBe(0);
        expect(h.window.XMLHttpRequest.OPENED).toBe(1);
        expect(h.window.XMLHttpRequest.HEADERS_RECEIVED).toBe(2);
        expect(h.window.XMLHttpRequest.LOADING).toBe(3);
        expect(h.window.XMLHttpRequest.DONE).toBe(4);
    });

    test('instances still satisfy instanceof XMLHttpRequest', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        expect(h.newXHR()).toBeInstanceOf(h.window.XMLHttpRequest);
    });
});

describe('XHR interception logging', () => {
    test('reports an applied rule over the nonced log channel', async () => {
        const h = createInterceptor();
        const logged = h.collect(h.channels.log);
        h.syncState({ rules: [mockRule()] });

        await request(h, 'https://example.test/api/users/1');

        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ ruleId: 'r1', method: 'GET' });
    });

    test('logs nothing for a passed-through request', async () => {
        const h = createInterceptor();
        const logged = h.collect(h.channels.log);
        h.syncState({ rules: [mockRule()] });

        await request(h, 'https://example.test/untouched');

        expect(logged).toHaveLength(0);
    });
});
