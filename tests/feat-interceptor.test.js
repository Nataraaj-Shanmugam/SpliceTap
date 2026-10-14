/**
 * Feature group G2, "interceptor": F3 (request-body rules) and F4 (code
 * responses) in src/matcher.js and content/injected.js.
 *
 * The interceptor runs under the shared harness (Node's real
 * Request/Response/Headers and a simulated XMLHttpRequest). What only Chrome
 * can show — the bytes a server receives, a page's CSP refusing eval — is in
 * tests/e2e/feat-interceptor.e2e.test.js.
 */

const { createInterceptor } = require('./helpers/injected-harness');
const matcher = require('../src/matcher.js');

const { findMatchingRule, findMatchingRequestBodyRule } = matcher;

function bodyRule(overrides = {}) {
    return {
        id: 'rb1',
        name: 'Rewrite body',
        enabled: true,
        type: 'requestBody',
        match: { url: '*/api/submit*', method: '*' },
        requestBody: { mode: 'static', body: { replaced: true } },
        ...overrides
    };
}

function mockRule(overrides = {}) {
    return {
        id: 'm1',
        name: 'Mock submit',
        enabled: true,
        type: 'mock',
        match: { url: '*/api/submit*', method: '*' },
        response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { mocked: true }, delay: 0, mode: 'static' },
        ...overrides
    };
}

const req = (overrides = {}) => ({ url: 'https://example.test/api/submit', method: 'POST', headers: {}, bodyText: null, ...overrides });

// ---------------------------------------------------------------------------

describe('F3: findMatchingRequestBodyRule', () => {
    test('is exported next to findMatchingRule', () => {
        expect(typeof findMatchingRequestBodyRule).toBe('function');
    });

    test('returns the first enabled requestBody rule in list order', () => {
        const first = bodyRule({ id: 'a' });
        const second = bodyRule({ id: 'b' });
        expect(findMatchingRequestBodyRule([first, second], req())).toBe(first);
    });

    test('skips disabled rules and every other rule type', () => {
        const off = bodyRule({ id: 'off', enabled: false });
        const on = bodyRule({ id: 'on' });
        const mock = mockRule();
        expect(findMatchingRequestBodyRule([mock, off, on], req())).toBe(on);
        expect(findMatchingRequestBodyRule([mock, off], req())).toBeNull();
    });

    test('the main pass never returns a requestBody rule', () => {
        const body = bodyRule();
        const mock = mockRule();
        expect(findMatchingRule([body], req())).toBeNull();
        expect(findMatchingRule([body, mock], req())).toBe(mock);
    });

    test('url and method are matched like the main pass', () => {
        const putOnly = bodyRule({ match: { url: '*/api/submit*', method: 'PUT' } });
        expect(findMatchingRequestBodyRule([putOnly], req())).toBeNull();
        expect(findMatchingRequestBodyRule([putOnly], req({ method: 'put' }))).toBe(putOnly);
        expect(findMatchingRequestBodyRule([bodyRule()], req({ url: 'https://example.test/other' }))).toBeNull();
        const regex = bodyRule({ match: { url: '/\\/api\\/sub/', method: '*' } });
        expect(findMatchingRequestBodyRule([regex], req())).toBe(regex);
    });

    test('header conditions are honoured', () => {
        const rule = bodyRule({ match: { url: '*/api/submit*', method: '*', headers: { 'X-Tenant': 'acme' } } });
        expect(findMatchingRequestBodyRule([rule], req())).toBeNull();
        expect(findMatchingRequestBodyRule([rule], req({ headers: { 'x-tenant': 'acme-eu' } }))).toBe(rule);
    });

    test('GraphQL conditions are honoured against the body', () => {
        const rule = bodyRule({ match: { url: '*/api/submit*', method: '*', graphql: { operationName: 'Save' } } });
        expect(findMatchingRequestBodyRule([rule], req({ bodyText: '{"operationName":"Load"}' }))).toBeNull();
        expect(findMatchingRequestBodyRule([rule], req({ bodyText: '{"operationName":"Save"}' }))).toBe(rule);
        expect(findMatchingRequestBodyRule([rule], req({ bodyText: '{"query":"mutation Save { x }"}' }))).toBe(rule);
    });

    test('null-prototype rules (as the state sync delivers them) match', () => {
        const rule = Object.assign(Object.create(null), bodyRule());
        rule.match = Object.assign(Object.create(null), rule.match);
        const list = [rule];
        Object.setPrototypeOf(list, null);
        expect(findMatchingRequestBodyRule(list, req())).toBe(rule);
    });

    test('a non-array rule list matches nothing', () => {
        expect(findMatchingRequestBodyRule(null, req())).toBeNull();
        expect(findMatchingRequestBodyRule({}, req())).toBeNull();
    });
});

// ---------------------------------------------------------------------------

/** An interceptor holding these rules (and settings). */
function withRules(rules, settings = {}, options = {}) {
    const h = createInterceptor(options);
    h.syncState({ rules, settings });
    return h;
}

/** The body and headers the network received for the last passed-through fetch. */
async function lastSent(h) {
    const [resource, init] = h.passthroughCalls[h.passthroughCalls.length - 1];
    const target = resource instanceof Request ? resource : new URL(String(resource), 'https://example.test/page').href;
    const request = new Request(target, init || undefined);
    return { url: request.url, method: request.method, body: await request.text(), contentType: request.headers.get('content-type'), request, init };
}

/** Drive one XHR to loadend. */
function sendXHR(h, { method = 'POST', url = 'https://example.test/api/submit', headers = {}, body = null } = {}) {
    const xhr = h.newXHR();
    return new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('XHR never settled')), 3000);
        xhr.addEventListener('loadend', () => {
            clearTimeout(guard);
            setTimeout(() => resolve({
                xhr,
                status: xhr.status,
                responseText: xhr.responseText,
                marker: xhr.getResponseHeader('x-splicetap')
            }), 0);
        });
        xhr.open(method, url);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        xhr.send(body);
    });
}

const settleLogs = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('F3: request-body rules on fetch', () => {
    test('static: an object body replaces the body and sets a JSON Content-Type', async () => {
        const h = withRules([bodyRule()]);
        const res = await h.fetch('https://example.test/api/submit', { method: 'POST', body: 'original' });
        expect(res.status).toBe(200);
        const sent = await lastSent(h);
        expect(sent.body).toBe('{"replaced":true}');
        expect(sent.contentType).toBe('application/json');
    });

    test('static: an existing Content-Type is kept', async () => {
        const h = withRules([bodyRule()]);
        await h.fetch('https://example.test/api/submit', {
            method: 'POST', headers: { 'Content-Type': 'application/vnd.api+json' }, body: 'x'
        });
        expect((await lastSent(h)).contentType).toBe('application/vnd.api+json');
    });

    test('static: a string body goes through placeholders and is not forced to JSON', async () => {
        const h = withRules([bodyRule({ requestBody: { mode: 'static', body: 'via {{request.method}} to {{request.url}}' } })]);
        await h.fetch('/api/submit', { method: 'PUT', body: 'x' });
        const sent = await lastSent(h);
        expect(sent.body).toBe('via PUT to https://example.test/api/submit');
        expect(sent.contentType).toBe('text/plain;charset=UTF-8');
    });

    test('static: an array body is JSON too', async () => {
        const h = withRules([bodyRule({ requestBody: { mode: 'static', body: [1, { a: 2 }] } })]);
        await h.fetch('https://example.test/api/submit', { method: 'POST', body: '{}' });
        const sent = await lastSent(h);
        expect(sent.body).toBe('[1,{"a":2}]');
        expect(sent.contentType).toBe('application/json');
    });

    test('static: an empty string body is honoured', async () => {
        const h = withRules([bodyRule({ requestBody: { mode: 'static', body: '' } })]);
        await h.fetch('https://example.test/api/submit', { method: 'POST', body: 'gone' });
        expect((await lastSent(h)).body).toBe('');
    });

    test('static: FormData, Blob and URLSearchParams bodies are replaced', async () => {
        for (const original of [new FormData(), new Blob(['b']), new URLSearchParams('a=1')]) {
            const h = withRules([bodyRule()]);
            await h.fetch('https://example.test/api/submit', { method: 'POST', body: original });
            const sent = await lastSent(h);
            expect(sent.body).toBe('{"replaced":true}');
            expect(sent.contentType).toBe('application/json');
        }
    });

    test('static: a Request is rebuilt with all its fields and the new body', async () => {
        const h = withRules([bodyRule()]);
        const controller = new AbortController();
        const original = new Request('https://example.test/api/submit?q=1', {
            method: 'POST', body: 'original', credentials: 'include', cache: 'no-store',
            redirect: 'manual', referrerPolicy: 'no-referrer', keepalive: false,
            headers: { 'X-Trace': 'abc' }, signal: controller.signal
        });
        await h.fetch(original);
        const sent = await lastSent(h);
        expect(sent.url).toBe('https://example.test/api/submit?q=1');
        expect(sent.method).toBe('POST');
        expect(sent.body).toBe('{"replaced":true}');
        expect(sent.request.headers.get('x-trace')).toBe('abc');
        expect(sent.init.credentials).toBe('include');
        expect(sent.init.cache).toBe('no-store');
        expect(sent.init.redirect).toBe('manual');
        expect(sent.init.referrerPolicy).toBe('no-referrer');
        expect(sent.init.signal).toBe(original.signal);
        // The Request already said text/plain (its string body): kept.
        expect(sent.contentType).toBe('text/plain;charset=UTF-8');
    });

    test('static: a multipart Content-Type no longer describes the body and is dropped', async () => {
        const h = withRules([bodyRule()]);
        const form = new FormData();
        form.append('a', '1');
        await h.fetch(new Request('https://example.test/api/submit', { method: 'POST', body: form }));
        const sent = await lastSent(h);
        expect(sent.body).toBe('{"replaced":true}');
        expect(sent.contentType).toBe('application/json');
    });

    test('patch: merges into a JSON object body', async () => {
        const h = withRules([bodyRule({ requestBody: { mode: 'patch', patch: { role: 'admin', drop: null, nested: { b: 2 } } } })]);
        await h.fetch('https://example.test/api/submit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'n', role: 'user', drop: 1, nested: { a: 1 } })
        });
        const sent = await lastSent(h);
        expect(JSON.parse(sent.body)).toEqual({ name: 'n', role: 'admin', nested: { a: 1, b: 2 } });
        expect(sent.contentType).toBe('application/json');
    });

    test('patch: works on a Request body and on bytes', async () => {
        const rule = bodyRule({ requestBody: { mode: 'patch', patch: { p: true } } });
        let h = withRules([rule]);
        await h.fetch(new Request('https://example.test/api/submit', { method: 'POST', body: '{"a":1}' }));
        expect(JSON.parse((await lastSent(h)).body)).toEqual({ a: 1, p: true });

        h = withRules([rule]);
        await h.fetch('https://example.test/api/submit', { method: 'POST', body: new TextEncoder().encode('{"b":1}') });
        expect(JSON.parse((await lastSent(h)).body)).toEqual({ b: 1, p: true });
    });

    test('patch: placeholders in the patch are filled', async () => {
        const h = withRules([bodyRule({ requestBody: { mode: 'patch', patch: { via: '{{request.method}}' } } })]);
        await h.fetch('https://example.test/api/submit', { method: 'PATCH', body: '{}' });
        expect(JSON.parse((await lastSent(h)).body)).toEqual({ via: 'PATCH' });
    });

    const skips = [
        ['not JSON', 'plain text', 'Request body not patched — the body is not valid JSON'],
        ['a JSON array', '[1,2]', 'Request body not patched — the body is not a JSON object (array)'],
        ['FormData', () => new FormData(), 'Request body not patched — the body is FormData, not JSON text'],
        ['a Blob', () => new Blob(['{}']), 'Request body not patched — the body is Blob, not JSON text'],
        ['URLSearchParams', () => new URLSearchParams('a=1'), 'Request body not patched — the body is URLSearchParams, not JSON text'],
        ['absent', undefined, 'Request body not patched — the request has no body']
    ];
    for (const [label, make, note] of skips) {
        test(`patch: a body that is ${label} is left unchanged, with a note`, async () => {
            const h = withRules([bodyRule({ requestBody: { mode: 'patch', patch: { p: 1 } } })]);
            const logged = h.collect(h.channels.log);
            const body = typeof make === 'function' ? make() : make;
            const init = { method: 'POST', body };
            await h.fetch('https://example.test/api/submit', init);
            await settleLogs();
            // Passed through exactly as the page called it.
            expect(h.passthroughCalls[0][1]).toBe(init);
            expect(logged).toEqual([expect.objectContaining({ ruleId: 'rb1', ruleType: 'requestBody', note, finalStatus: 200 })]);
        });
    }

    test('patch: an empty patch is a no-op, with a note', async () => {
        const h = withRules([bodyRule({ requestBody: { mode: 'patch', patch: {} } })]);
        const logged = h.collect(h.channels.log);
        await h.fetch('https://example.test/api/submit', { method: 'POST', body: '{"a":1}' });
        await settleLogs();
        expect((await lastSent(h)).body).toBe('{"a":1}');
        expect(logged[0].note).toBe('Request body not patched — the patch is empty');
    });

    test('GET and HEAD requests are never rewritten', async () => {
        const h = withRules([bodyRule()]);
        const logged = h.collect(h.channels.log);
        await h.fetch('https://example.test/api/submit');
        await h.fetch('https://example.test/api/submit', { method: 'HEAD' });
        await settleLogs();
        expect(h.passthroughCalls).toHaveLength(2);
        expect(logged).toEqual([]);
    });

    test('a disabled rule does nothing', async () => {
        const h = withRules([bodyRule({ enabled: false })]);
        const init = { method: 'POST', body: 'original' };
        await h.fetch('https://example.test/api/submit', init);
        expect(h.passthroughCalls[0][1]).toBe(init);
    });

    test('the log entry names the rule, the note and the final status', async () => {
        const h = withRules([bodyRule()]);
        const logged = h.collect(h.channels.log);
        await h.fetch('/api/submit', { method: 'POST', body: 'x' });
        await settleLogs();
        expect(logged).toEqual([expect.objectContaining({
            ruleId: 'rb1', ruleName: 'Rewrite body', ruleType: 'requestBody', method: 'POST',
            url: 'https://example.test/api/submit', status: 200, finalStatus: 200, note: 'Request body replaced'
        })]);
        expect(typeof logged[0].elapsedMs).toBe('number');
    });

    test('then the main pass matches the modified body (graphql) — and the mock wins', async () => {
        const graphMock = mockRule({ match: { url: '*/api/submit*', method: 'POST', graphql: { operationName: 'Rewritten' } } });
        const h = withRules([
            graphMock,
            bodyRule({ requestBody: { mode: 'static', body: { operationName: 'Rewritten', query: 'query Rewritten { x }' } } })
        ]);
        const logged = h.collect(h.channels.log);
        const res = await h.fetch('https://example.test/api/submit', { method: 'POST', body: '{"operationName":"Original"}' });
        expect(await res.json()).toEqual({ mocked: true });
        expect(h.passthroughCalls).toHaveLength(0);
        await settleLogs();
        expect(logged.map((e) => e.ruleType).sort()).toEqual(['mock', 'requestBody']);
    });

    test('the main pass no longer matches the original body', async () => {
        const graphMock = mockRule({ match: { url: '*/api/submit*', method: 'POST', graphql: { operationName: 'Original' } } });
        const h = withRules([graphMock, bodyRule()]);
        const res = await h.fetch('https://example.test/api/submit', { method: 'POST', body: '{"operationName":"Original"}' });
        expect(await res.json()).toEqual({ origin: true });
    });

    test('the main pass sees the Content-Type the rule set', async () => {
        const typed = mockRule({ match: { url: '*/api/submit*', method: '*', headers: { 'content-type': 'json' } } });
        const h = withRules([typed, bodyRule()]);
        const res = await h.fetch('https://example.test/api/submit', { method: 'POST', body: 'x' });
        expect(await res.json()).toEqual({ mocked: true });
    });

    test('a redirect sends the modified body', async () => {
        const redirect = {
            id: 'rd', name: 'Redirect', enabled: true, type: 'redirect',
            match: { url: '*/api/submit*', method: '*' }, redirect: { destination: 'https://other.test/v2' }
        };
        for (const make of [
            () => ['https://example.test/api/submit', { method: 'POST', body: 'x' }],
            () => [new Request('https://example.test/api/submit', { method: 'POST', body: 'x' })]
        ]) {
            const h = withRules([redirect, bodyRule()]);
            await h.fetch(...make());
            const sent = await lastSent(h);
            expect(sent.url).toBe('https://other.test/v2');
            expect(sent.body).toBe('{"replaced":true}');
        }
    });

    test('the first matching requestBody rule wins; later ones do not stack', async () => {
        const h = withRules([
            bodyRule({ id: 'a', requestBody: { mode: 'static', body: 'first' } }),
            bodyRule({ id: 'b', requestBody: { mode: 'static', body: 'second' } })
        ]);
        await h.fetch('https://example.test/api/submit', { method: 'POST', body: 'x' });
        expect((await lastSent(h)).body).toBe('first');
    });

    test('a relative URL pattern still matches (PER-8)', async () => {
        const h = withRules([bodyRule({ match: { url: '/api/submit*', method: 'POST' } })]);
        await h.fetch('/api/submit', { method: 'POST', body: 'x' });
        expect((await lastSent(h)).body).toBe('{"replaced":true}');
    });
});

describe('F3: request-body rules on XHR', () => {
    test('static: send() carries the new body and a JSON Content-Type', async () => {
        const h = withRules([bodyRule()]);
        const result = await sendXHR(h, { body: 'original' });
        expect(result.status).toBe(200);
        expect(h.xhrCalls[0].body).toBe('{"replaced":true}');
        expect(h.xhrCalls[0].headers['content-type']).toBe('application/json');
    });

    test('static: a Content-Type the page set is kept', async () => {
        const h = withRules([bodyRule()]);
        await sendXHR(h, { body: 'x', headers: { 'Content-Type': 'text/csv' } });
        expect(h.xhrCalls[0].headers['content-type']).toBe('text/csv');
    });

    test('patch: merges into a JSON body', async () => {
        const h = withRules([bodyRule({ requestBody: { mode: 'patch', patch: { added: 1 } } })]);
        await sendXHR(h, { body: '{"kept":true}' });
        expect(JSON.parse(h.xhrCalls[0].body)).toEqual({ kept: true, added: 1 });
    });

    test('patch: FormData is left unchanged, with a note', async () => {
        const h = withRules([bodyRule({ requestBody: { mode: 'patch', patch: { added: 1 } } })]);
        const logged = h.collect(h.channels.log);
        const form = new FormData();
        await sendXHR(h, { body: form });
        await settleLogs();
        expect(h.xhrCalls[0].body).toBe(form);
        expect(logged).toEqual([expect.objectContaining({
            ruleType: 'requestBody', note: 'Request body not patched — the body is FormData, not JSON text', finalStatus: 200
        })]);
    });

    test('the log entry carries the note and the final status', async () => {
        const h = withRules([bodyRule()]);
        const logged = h.collect(h.channels.log);
        await sendXHR(h, { url: '/api/submit', body: 'x' });
        await settleLogs();
        expect(logged).toEqual([expect.objectContaining({
            ruleId: 'rb1', ruleType: 'requestBody', url: 'https://example.test/api/submit',
            note: 'Request body replaced', finalStatus: 200
        })]);
    });

    test('GET is never rewritten', async () => {
        const h = withRules([bodyRule()]);
        await sendXHR(h, { method: 'GET' });
        expect(h.xhrCalls[0].body).toBeNull();
    });

    test('then a mock keyed on the modified body (graphql) wins, and both are logged', async () => {
        const graphMock = mockRule({ match: { url: '*/api/submit*', method: 'POST', graphql: { operationName: 'Rewritten' } } });
        const h = withRules([
            graphMock,
            bodyRule({ requestBody: { mode: 'patch', patch: { operationName: 'Rewritten' } } })
        ]);
        const logged = h.collect(h.channels.log);
        const result = await sendXHR(h, { body: '{"operationName":"Original"}' });
        expect(JSON.parse(result.responseText)).toEqual({ mocked: true });
        expect(result.marker).toBe('true');
        expect(h.xhrCalls).toHaveLength(0);
        await settleLogs();
        expect(logged.map((e) => [e.ruleType, e.finalStatus === undefined ? e.status : e.finalStatus]).sort())
            .toEqual([['mock', 200], ['requestBody', 200]]);
    });

    test('a redirect decided in open() still sends the modified body', async () => {
        const redirect = {
            id: 'rd', name: 'Redirect', enabled: true, type: 'redirect',
            match: { url: '*/api/submit*', method: '*' }, redirect: { destination: 'https://other.test/v2' }
        };
        const h = withRules([redirect, bodyRule()]);
        const logged = h.collect(h.channels.log);
        await sendXHR(h, { body: 'x' });
        await settleLogs();
        expect(h.xhrCalls[0].url).toBe('https://other.test/v2');
        expect(h.xhrCalls[0].body).toBe('{"replaced":true}');
        // The body rule matched the URL the page opened, not the destination.
        const entry = logged.find((e) => e.ruleType === 'requestBody');
        expect(entry.url).toBe('https://example.test/api/submit');
        expect(logged.map((e) => e.ruleType).sort()).toEqual(['redirect', 'requestBody']);
    });

    test('a redirect decided in send() replays the Content-Type the rule set', async () => {
        const redirect = {
            id: 'rd', name: 'Redirect', enabled: true, type: 'redirect',
            match: { url: '*/api/submit*', method: '*' }, redirect: { destination: 'https://other.test/v2' }
        };
        // A header-conditioned mock above the redirect defers it to send().
        const conditional = mockRule({ id: 'c', match: { url: '*/api/submit*', method: '*', headers: { 'x-never': 'y' } } });
        const h = withRules([conditional, redirect, bodyRule()]);
        await sendXHR(h, { body: 'x' });
        expect(h.xhrCalls[0].url).toBe('https://other.test/v2');
        expect(h.xhrCalls[0].body).toBe('{"replaced":true}');
        expect(h.xhrCalls[0].headers['content-type']).toBe('application/json');
    });

    test('a reused XHR does not log the previous request\'s body rule', async () => {
        const h = withRules([bodyRule()]);
        const logged = h.collect(h.channels.log);
        const xhr = h.newXHR();
        xhr.open('POST', 'https://example.test/api/submit');
        xhr.send('x');
        xhr.open('GET', 'https://example.test/api/other');
        await new Promise((resolve) => { xhr.addEventListener('loadend', resolve); xhr.send(); });
        await settleLogs();
        expect(logged).toEqual([]);
    });
});

describe('F3: contract B — rule data stays out of page-visible lookups', () => {
    test('the rewritten fetch init has no prototype', async () => {
        const h = withRules([bodyRule()]);
        await h.fetch('https://example.test/api/submit', { method: 'POST', body: 'x' });
        expect(Object.getPrototypeOf((await lastSent(h)).init)).toBeNull();
    });
});
