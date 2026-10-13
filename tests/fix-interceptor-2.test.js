/**
 * Regression tests for fix group A2a, "interceptor-2": content/injected.js
 * (PERSONA-REVIEW PER-2 residual, 4, 7, 14–19, 39–43, 45–48, 52, 54, 56).
 *
 * The harness runs the shipped interceptor against Node's real
 * Response/Headers/Request and a simulated XMLHttpRequest (mock-xhr.js).
 * Behaviour only Chrome can show (upload events, Trusted Types, streaming,
 * keepalive) is covered by tests/e2e/fix-interceptor-2.e2e.test.js.
 */

const { ReadableStream } = require('stream/web');
const { createInterceptor } = require('./helpers/injected-harness');

function mockRule(overrides = {}) {
    return {
        id: 'r1',
        name: 'Mock users',
        enabled: true,
        type: 'mock',
        match: { url: '*/api/users*', method: '*' },
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

/** An interceptor holding these rules. */
function withRules(rules, options = {}) {
    const h = createInterceptor(options);
    h.syncState({ rules, ...(options.state || {}) });
    return h;
}

/** Drive one XHR to loadend and report what the page would observe. */
function settle(xhr) {
    return new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('XHR never settled')), 3000);
        xhr.addEventListener('loadend', () => {
            clearTimeout(guard);
            setTimeout(() => resolve({
                status: xhr.status,
                readyState: xhr.readyState,
                responseText: xhr.responseText,
                marker: xhr.getResponseHeader('x-splicetap')
            }), 0);
        });
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------

describe('PER-14 / PER-7: the XMLHttpRequest wrapper behaves like the native constructor', () => {
    const states = {
        'rules on': () => withRules([mockRule()]),
        'no rules': () => withRules([]),
        'extension off': () => withRules([mockRule()], { state: { active: false } })
    };

    for (const [label, make] of Object.entries(states)) {
        test(`a subclass keeps its own methods (${label})`, () => {
            const h = make();
            class Sub extends h.window.XMLHttpRequest {
                hello() { return 'hi'; }
            }
            const sub = new Sub();
            expect(sub instanceof Sub).toBe(true);
            expect(sub instanceof h.window.XMLHttpRequest).toBe(true);
            expect(sub.hello()).toBe('hi');
        });
    }

    test('a subclass instance is still mocked', async () => {
        const h = withRules([mockRule()]);
        class Sub extends h.window.XMLHttpRequest {}
        const xhr = new Sub();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.send();
        const result = await done;
        expect(result.marker).toBe('true');
        expect(JSON.parse(result.responseText)).toEqual({ mocked: true });
    });

    test('a subclass overriding open() still runs its override', async () => {
        const h = withRules([mockRule()]);
        const seen = [];
        class Sub extends h.window.XMLHttpRequest {
            open(method, url) { seen.push(url); return super.open(method, url); }
        }
        const xhr = new Sub();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.send();
        expect((await done).marker).toBe('true');
        expect(seen).toEqual(['/api/users']);
    });

    test('is named XMLHttpRequest, needs `new`, and its prototype points back at it', () => {
        const h = withRules([mockRule()]);
        const XHR = h.window.XMLHttpRequest;
        expect(XHR.name).toBe('XMLHttpRequest');
        expect(XHR.length).toBe(0);
        expect(() => XHR()).toThrow(TypeError);
        expect(new XHR().constructor).toBe(XHR);
        expect(XHR.prototype.constructor).toBe(XHR);
        expect(XHR.DONE).toBe(4);
        expect(Object.getOwnPropertyDescriptor(XHR, 'prototype').writable).toBe(false);
    });

    test('the fetch wrapper is named and sized like the native fetch', () => {
        const h = withRules([mockRule()]);
        expect(h.window.fetch.name).toBe('fetch');
        expect(h.window.fetch.length).toBe(1);
    });
});

describe('PER-43: a frozen XMLHttpRequest.prototype does not disable mocking', () => {
    test('overrides are defined on the instance', async () => {
        const h = withRules([mockRule()]);
        Object.freeze(h.window.XMLHttpRequest.prototype);

        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.send();
        const result = await done;
        expect(result.marker).toBe('true');
        expect(h.xhrCalls).toHaveLength(0);
    });
});

describe('PER-46: open(method, url, undefined) is synchronous', () => {
    test('a mocked request has finished when send() returns', () => {
        const h = withRules([mockRule()]);
        const xhr = h.newXHR();
        xhr.open('GET', '/api/users', undefined);
        xhr.send();
        expect(xhr.readyState).toBe(4);
        expect(xhr.status).toBe(200);
        expect(JSON.parse(xhr.responseText)).toEqual({ mocked: true });
    });

    test('omitting the argument is still asynchronous', () => {
        const h = withRules([mockRule()]);
        const xhr = h.newXHR();
        xhr.open('GET', '/api/users');
        xhr.send();
        expect(xhr.readyState).not.toBe(4);
    });
});

/** Record events (with readyState) on an XHR and, if it has one, its upload. */
function recordEvents(xhr) {
    const events = [];
    for (const type of ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend']) {
        xhr.addEventListener(type, () => events.push(`${type}@${xhr.readyState}`));
        if (xhr.upload) xhr.upload.addEventListener(type, () => events.push(`up.${type}`));
    }
    return events;
}

/** Give the harness XHR an upload object, as a browser's has. */
function withUpload(h) {
    Object.defineProperty(h.window.XMLHttpRequest.prototype, 'upload', {
        configurable: true,
        get() { return this._upload || (this._upload = new EventTarget()); }
    });
    return h;
}

const delayedMock = (delay) => mockRule({
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { mocked: true }, delay, mode: 'static' }
});

describe('PER-15: open() resets a reused or in-flight mocked XHR', () => {
    test('a reused object reads the real response after a mocked one', async () => {
        const h = withRules([mockRule()]);
        const xhr = h.newXHR();
        let done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.send();
        expect((await done).marker).toBe('true');

        done = settle(xhr);
        xhr.open('GET', '/api/real');
        expect(xhr.readyState).toBe(1);
        xhr.send();
        const second = await done;
        expect(second.marker).toBeNull();
        expect(second.responseText).toBe('{"origin":true}');
    });

    test('a mock still pending when open() is called again never fires', async () => {
        const h = withRules([delayedMock(80)]);
        const xhr = h.newXHR();
        const loads = [];
        xhr.addEventListener('load', () => loads.push(xhr.responseText));
        xhr.open('GET', '/api/users');
        xhr.send();
        await sleep(10);
        xhr.open('GET', '/api/real');
        xhr.send();
        await sleep(250);
        expect(loads).toEqual(['{"origin":true}']);
        expect(xhr.responseText).toBe('{"origin":true}');
    });

    test('a request after abort() is not swallowed', async () => {
        const h = withRules([delayedMock(80)]);
        const xhr = h.newXHR();
        xhr.open('GET', '/api/users');
        xhr.send();
        xhr.abort();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.send();
        expect((await done).marker).toBe('true');
    });
});

describe('PER-16: upload events for mocked requests with a body', () => {
    test('a mock fires loadstart, progress, load and loadend on xhr.upload before the headers', async () => {
        const h = withUpload(withRules([mockRule()]));
        const xhr = h.newXHR();
        const events = recordEvents(xhr);
        const done = settle(xhr);
        xhr.open('POST', '/api/users');
        xhr.send('x'.repeat(5000));
        await done;
        const upload = events.filter((e) => e.startsWith('up.'));
        expect(upload).toEqual(['up.loadstart', 'up.progress', 'up.load', 'up.loadend']);
        expect(events.indexOf('up.loadend')).toBeLessThan(events.indexOf('readystatechange@2'));
        expect(events.indexOf('loadstart@1')).toBeLessThan(events.indexOf('up.loadstart'));
    });

    test('a GET sends no body, so no upload events', async () => {
        const h = withUpload(withRules([mockRule()]));
        const xhr = h.newXHR();
        const events = recordEvents(xhr);
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.send();
        await done;
        expect(events.filter((e) => e.startsWith('up.'))).toEqual([]);
    });

    test('a block fires error and loadend on xhr.upload', async () => {
        const h = withUpload(withRules([mockRule({ type: 'block' })]));
        const xhr = h.newXHR();
        const events = recordEvents(xhr);
        const done = settle(xhr);
        xhr.open('POST', '/api/users');
        xhr.send('payload');
        await done;
        expect(events.filter((e) => e.startsWith('up.'))).toEqual(['up.loadstart', 'up.error', 'up.loadend']);
        expect(events.slice(-5)).toEqual(['readystatechange@4', 'up.error', 'up.loadend', 'error@4', 'loadend@4']);
    });
});

describe('PER-17: a delay rule honours xhr.timeout', () => {
    const delayRule = (delayMs) => ({ id: 'd', name: 'Slow', enabled: true, type: 'delay', match: { url: '*/api/users*', method: '*' }, delayMs });

    test('a hold at least as long as the timeout times out, at the timeout', async () => {
        const h = withRules([delayRule(400)]);
        const xhr = h.newXHR();
        const events = recordEvents(xhr);
        const start = Date.now();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.timeout = 60;
        xhr.send();
        await done;
        expect(Date.now() - start).toBeLessThan(300);
        expect(events).toEqual(['readystatechange@1', 'readystatechange@4', 'timeout@4', 'loadend@4']);
        expect(h.xhrCalls).toHaveLength(0);
    });

    test('a shorter hold still reaches the network', async () => {
        const h = withRules([delayRule(30)]);
        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.timeout = 1000;
        xhr.send();
        expect((await done).responseText).toBe('{"origin":true}');
        expect(h.xhrCalls).toHaveLength(1);
    });

    test('a static mock longer than the timeout times out', async () => {
        const h = withRules([delayedMock(300)]);
        const xhr = h.newXHR();
        const events = recordEvents(xhr);
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.timeout = 50;
        xhr.send();
        await done;
        expect(events.slice(-3)).toEqual(['readystatechange@4', 'timeout@4', 'loadend@4']);
        expect(events).not.toContain('load@4');
    });
});

describe('PER-39: abort() on a mocked XHR', () => {
    test('after completion it is silent and leaves the object UNSENT', async () => {
        const h = withRules([mockRule()]);
        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.send();
        await done;
        const events = recordEvents(xhr);
        xhr.abort();
        await sleep(20);
        expect(events).toEqual([]);
        expect(xhr.readyState).toBe(0);
        expect(xhr.getResponseHeader('x-splicetap')).toBeNull();
        expect(xhr.getAllResponseHeaders()).toBe('');
    });

    test('in flight it reports DONE before abort, then is UNSENT', async () => {
        const h = withRules([delayedMock(200)]);
        const xhr = h.newXHR();
        xhr.open('GET', '/api/users');
        xhr.send();
        await sleep(20);
        const events = recordEvents(xhr);
        xhr.abort();
        expect(events).toEqual(['readystatechange@4', 'abort@4', 'loadend@4']);
        expect(xhr.readyState).toBe(0);
        expect(xhr.status).toBe(0);
        await sleep(250);
        expect(events).toHaveLength(3);
    });
});

describe('PER-40 / PER-47: responseXML and document responses', () => {
    const xmlRule = (contentType, body) => mockRule({
        response: { statusCode: 200, headers: { 'Content-Type': contentType }, body, delay: 0, mode: 'static' }
    });

    test("an XML response with responseType '' has a responseXML", async () => {
        const h = withRules([xmlRule('application/xml', '<a><b>1</b></a>')]);
        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.send();
        await done;
        expect(xhr.responseText).toBe('<a><b>1</b></a>');
        expect(typeof xhr.responseXML).toBe('object');
        expect(xhr.responseXML).not.toBeNull();
    });

    test("HTML is parsed for 'document' only; JSON never", async () => {
        const read = async (contentType, body, responseType) => {
            const h = withRules([xmlRule(contentType, body)]);
            const xhr = h.newXHR();
            xhr.responseType = responseType;
            const done = settle(xhr);
            xhr.open('GET', '/api/users');
            xhr.send();
            await done;
            return { response: xhr.response, responseXML: xhr.responseXML };
        };

        const htmlDefault = await read('text/html', '<p>hi</p>', '');
        expect(htmlDefault.responseXML).toBeNull();

        const htmlDocument = await read('text/html', '<p>hi</p>', 'document');
        expect(typeof htmlDocument.response).toBe('object');
        expect(htmlDocument.response).not.toBeNull();
        expect(htmlDocument.responseXML).toBe(htmlDocument.response);

        const jsonDocument = await read('application/json', '{"a":1}', 'document');
        expect(jsonDocument.response).toBeNull();
        expect(jsonDocument.responseXML).toBeNull();
    });
});

describe('PER-52: no XHR body for 204/205/304 or HEAD, matching fetch', () => {
    for (const status of [204, 205, 304]) {
        test(`a ${status} mock delivers an empty body`, async () => {
            const h = withRules([mockRule({
                response: { statusCode: status, headers: {}, body: { ignored: true }, delay: 0, mode: 'static' }
            })]);
            const xhr = h.newXHR();
            const done = settle(xhr);
            xhr.open('GET', '/api/users');
            xhr.send();
            const result = await done;
            expect(result.status).toBe(status);
            expect(result.responseText).toBe('');
        });
    }

    test('a HEAD mock delivers an empty body', async () => {
        const h = withRules([mockRule()]);
        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('HEAD', '/api/users');
        xhr.send();
        expect((await done).responseText).toBe('');
    });
});

// ---- PER-4: redaction --------------------------------------------------------

describe('PER-4: secrets in the URL are redacted in the log and in captures', () => {
    const SECRET = 'LEAKME7f3a';
    const token = 'f3a9c2e8b1d4a7c6e5f8a2b3c4d5e6f7';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

    // Every case SEC2-4 found leaking, plus the path forms.
    const leaked = [
        `/api/users?session_id=${SECRET}`,
        `/api/users?sessionid=${SECRET}`,
        `/api/users?JSESSIONID=${SECRET}`,
        `/api/users?id_token=${SECRET}`,
        `/api/users?refresh_token=${SECRET}`,
        `/api/users?access-token=${SECRET}`,
        `/api/users?code=${SECRET}`,
        `/api/users?client_secret=${SECRET}`,
        `/api/users?jwt=${SECRET}`,
        `/api/users?X-Amz-Signature=${SECRET}`,
        `/api/users?sig=${SECRET}`,
        `/api/users?user[token]=${SECRET}`,
        `/api/users#access_token=${SECRET}&state=s1`,
        `/api/users#/callback?id_token=${SECRET}`,
        `/api/users/reset/${token}${SECRET}`,
        `/api/users/verify/${jwt}${SECRET}`,
        `/api/users;jsessionid=${SECRET}`
    ];

    async function logged(path) {
        const h = withRules([mockRule()]);
        const entries = h.collect(h.channels.log);
        await h.fetch('https://example.test' + path);
        return entries[0].url;
    }

    for (const path of leaked) {
        test(`redacts ${path.replace(SECRET, '<secret>')}`, async () => {
            const url = await logged(path);
            expect(url).not.toContain(SECRET);
            expect(url).toMatch(/redacted/i);
        });
    }

    test('keeps what is not sensitive', async () => {
        expect(await logged('/api/users/42?page=2&q=shoes#section')).toBe('https://example.test/api/users/42?page=2&q=shoes#section');
        expect(await logged('/api/users/report-2024-final.pdf')).toBe('https://example.test/api/users/report-2024-final.pdf');
    });

    test('keeps the rest of the URL around a redacted value', async () => {
        const url = await logged(`/api/users?page=2&refresh_token=${SECRET}#access_token=${SECRET}&state=s1`);
        expect(url).toBe('https://example.test/api/users?page=2&refresh_token=%5Bredacted%5D#access_token=%5Bredacted%5D&state=s1');
    });

    test('captures are redacted the same way', async () => {
        const h = withRules([], { state: { settings: { captureArmed: true } } });
        const captured = h.collect(h.channels.capture);
        await h.fetch(`https://example.test/api/other/${token}?X-Amz-Signature=${SECRET}`);
        await h.flush();
        expect(captured).toHaveLength(1);
        expect(captured[0].url).not.toContain(SECRET);
        expect(captured[0].url).not.toContain(token);
    });
});

// ---- contract A: PER-19, PER-54, PER-56 -------------------------------------

const chaosOn = { settings: { chaosMode: { enabled: true, failureRate: 1 } } };
const delayRule = (delayMs, url = '*/api/users*') => ({ id: 'd', name: 'Slow', enabled: true, type: 'delay', match: { url, method: '*' }, delayMs });
const redirectRule = (destination) => ({ id: 'rd', name: 'Move', enabled: true, type: 'redirect', match: { url: '*/api/old*', method: '*' }, redirect: { destination } });
const patchRule = (patch) => mockRule({
    response: { statusCode: 200, headers: {}, body: {}, patch, delay: 0, mode: 'patch' }
});
const jsonResponder = (text, status = 200, contentType = 'application/json') =>
    async () => new Response(text, { status, headers: { 'Content-Type': contentType } });

describe('PER-54: chaos failures are logged as kind "chaos"', () => {
    test('fetch', async () => {
        const h = withRules([], { state: chaosOn });
        const logged = h.collect(h.channels.log);
        await expect(h.fetch('https://example.test/api/any?token=abc')).rejects.toThrow(TypeError);
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ kind: 'chaos', ruleId: null, ruleName: 'Chaos mode', status: 'failed', method: 'GET' });
        expect(logged[0].elapsedMs).toBeGreaterThanOrEqual(0);
        expect(logged[0].url).not.toMatch(/abc/);
    });

    test('XHR', async () => {
        const h = withRules([], { state: chaosOn });
        const logged = h.collect(h.channels.log);
        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('POST', '/api/any');
        xhr.send('x');
        expect((await done).status).toBe(0);
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ kind: 'chaos', ruleId: null, ruleName: 'Chaos mode', status: 'failed', method: 'POST' });
    });
});

describe('PER-56: delay and redirect rules are logged once the real response settles', () => {
    test('a fetch delay reports the final status and the time taken', async () => {
        const h = withRules([delayRule(60)]);
        const logged = h.collect(h.channels.log);
        const pending = h.fetch('https://example.test/api/users');
        await sleep(20);
        expect(logged).toHaveLength(0);
        await pending;
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ ruleId: 'd', ruleType: 'delay', status: 200, finalStatus: 200 });
        expect(logged[0].elapsedMs).toBeGreaterThanOrEqual(55);
    });

    test('a fetch delay whose request fails reports "failed"', async () => {
        const h = withRules([delayRule(5)], { originalFetch: async () => { throw new TypeError('Failed to fetch'); } });
        const logged = h.collect(h.channels.log);
        await expect(h.fetch('https://example.test/api/users')).rejects.toThrow(TypeError);
        expect(logged[0]).toMatchObject({ ruleType: 'delay', status: null, finalStatus: 'failed' });
    });

    test('a fetch redirect reports where it went and what came back', async () => {
        const h = withRules([redirectRule('https://other.test/v2?secret=s3cr3t')], { originalFetch: jsonResponder('{"moved":true}', 201) });
        const logged = h.collect(h.channels.log);
        await h.fetch('https://example.test/api/old');
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ ruleType: 'redirect', status: 201, finalStatus: 201 });
        expect(logged[0].redirectedTo).toMatch(/^https:\/\/other\.test\/v2\?secret=/);
        expect(logged[0].redirectedTo).not.toMatch(/s3cr3t/);
        expect(logged[0].elapsedMs).toBeGreaterThanOrEqual(0);
    });

    test('an XHR delay is logged at loadend', async () => {
        const h = withRules([delayRule(40)]);
        const logged = h.collect(h.channels.log);
        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.send();
        await sleep(10);
        expect(logged).toHaveLength(0);
        await done;
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ ruleType: 'delay', status: 200, finalStatus: 200 });
        expect(logged[0].elapsedMs).toBeGreaterThanOrEqual(35);
    });

    test('an XHR delay that times out reports "failed"', async () => {
        const h = withRules([delayRule(200)]);
        const logged = h.collect(h.channels.log);
        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.timeout = 20;
        xhr.send();
        await done;
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ ruleType: 'delay', status: null, finalStatus: 'failed' });
    });

    test('an XHR redirect is logged once, after the response, with its destination', async () => {
        const h = withRules([redirectRule('https://other.test/v2')]);
        const logged = h.collect(h.channels.log);
        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('GET', '/api/old');
        expect(logged).toHaveLength(0);
        xhr.send();
        await done;
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({ ruleType: 'redirect', status: 200, finalStatus: 200, redirectedTo: 'https://other.test/v2' });
        expect(h.xhrCalls[0].url).toBe('https://other.test/v2');
    });

    test('an XHR opened for a redirect but never sent logs nothing', async () => {
        const h = withRules([redirectRule('https://other.test/v2')]);
        const logged = h.collect(h.channels.log);
        const xhr = h.newXHR();
        xhr.open('GET', '/api/old');
        xhr.open('GET', '/api/elsewhere');
        await sleep(10);
        expect(logged).toHaveLength(0);
    });
});

describe('PER-19: a patch that does not apply leaves the response alone and says why', () => {
    const cases = [
        ['an array root', '[1,2,3]', { added: 1 }, 'Patch skipped — response is not a JSON object (array)'],
        ['a scalar root', '42', { added: 1 }, 'Patch skipped — response is not a JSON object (number)'],
        ['an empty patch', '{"a":1}', {}, 'Patch skipped — the patch is empty'],
        ['invalid JSON', '{not json', { added: 1 }, 'Patch skipped — response body is not valid JSON']
    ];

    for (const [label, real, patch, note] of cases) {
        test(`fetch: ${label}`, async () => {
            const h = withRules([patchRule(patch)], { originalFetch: jsonResponder(real) });
            const logged = h.collect(h.channels.log);
            const response = await h.fetch('https://example.test/api/users');
            expect(await response.text()).toBe(real);
            expect(response.headers.get('x-splicetap')).toBeNull();
            expect(logged).toHaveLength(1);
            expect(logged[0]).toMatchObject({ ruleId: 'r1', status: 200, note });
        });

        test(`XHR: ${label}`, async () => {
            const h = withRules([patchRule(patch)], { originalFetch: jsonResponder(real) });
            const logged = h.collect(h.channels.log);
            const xhr = h.newXHR();
            const done = settle(xhr);
            xhr.open('GET', '/api/users');
            xhr.send();
            const result = await done;
            expect(result.responseText).toBe(real);
            expect(result.marker).toBeNull();
            expect(logged).toHaveLength(1);
            expect(logged[0]).toMatchObject({ ruleId: 'r1', status: 200, note });
        });
    }

    test('an object patch on an object still applies, with no note', async () => {
        const h = withRules([patchRule({ added: 1 })], { originalFetch: jsonResponder('{"a":1}') });
        const logged = h.collect(h.channels.log);
        const response = await h.fetch('https://example.test/api/users');
        expect(await response.json()).toEqual({ a: 1, added: 1 });
        expect(logged[0].note).toBeUndefined();
    });
});

// ---- fetch fidelity: PER-18, 41, 42, 45, 48 ------------------------------------

/** A response whose body is a stream the test feeds by hand. */
function controlledStream(contentType) {
    let controller;
    let pulls = 0;
    const body = new ReadableStream({
        start(c) { controller = c; },
        pull() { pulls++; }
    });
    const response = new Response(body, { headers: { 'Content-Type': contentType } });
    return { response, push: (text) => controller.enqueue(new TextEncoder().encode(text)), close: () => controller.close(), pulls: () => pulls };
}

describe('PER-18: only JSON is patched; streams pass straight through', () => {
    for (const type of ['text/event-stream', 'application/x-ndjson', 'text/plain']) {
        test(`fetch: a ${type} response is returned at once, unread`, async () => {
            const stream = controlledStream(type);
            const h = withRules([patchRule({ added: 1 })], { originalFetch: async () => stream.response });
            const logged = h.collect(h.channels.log);
            // The stream never ends: awaiting its body would never resolve.
            const response = await h.fetch('https://example.test/api/users');
            expect(response).toBe(stream.response);
            expect(response.bodyUsed).toBe(false);
            expect(logged[0].note).toBe(`Patch skipped — response is not a JSON object (${type})`);
        });
    }

    test('fetch: application/problem+json is still patched', async () => {
        const h = withRules([patchRule({ added: 1 })], { originalFetch: jsonResponder('{"a":1}', 400, 'application/problem+json') });
        const response = await h.fetch('https://example.test/api/users');
        expect(await response.json()).toEqual({ a: 1, added: 1 });
    });

    test('XHR: an event stream reaches the page chunk by chunk', async () => {
        const stream = controlledStream('text/event-stream');
        const h = withRules([patchRule({ added: 1 })], { originalFetch: async () => stream.response });
        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.send();
        stream.push('data: 0\n\n');
        await sleep(20);
        expect(xhr.readyState).toBe(3);
        expect(xhr.responseText).toBe('data: 0\n\n');
        stream.push('data: 1\n\n');
        stream.close();
        const result = await done;
        expect(result.responseText).toBe('data: 0\n\ndata: 1\n\n');
        expect(result.marker).toBeNull();
    });

    test('capture reads no more than its cap from an endless stream', async () => {
        let pulls = 0;
        const chunk = new TextEncoder().encode('x'.repeat(16384));
        const endless = () => new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(chunk); } }), {
            headers: { 'Content-Type': 'text/plain' }
        });
        const h = withRules([], { originalFetch: async () => endless(), state: { settings: { captureArmed: true } } });
        const captured = h.collect(h.channels.capture);
        await h.fetch('https://example.test/api/stream');
        await sleep(50);
        const settled = pulls;
        await sleep(50);
        expect(pulls).toBe(settled);
        expect(pulls).toBeLessThan(20);
        expect(captured).toHaveLength(0);
    });

    test('capture skips an event stream', async () => {
        const stream = controlledStream('text/event-stream');
        const h = withRules([], { originalFetch: async () => stream.response, state: { settings: { captureArmed: true } } });
        const captured = h.collect(h.channels.capture);
        await h.fetch('https://example.test/api/feed');
        stream.push('data: 0\n\n');
        stream.close();
        await sleep(20);
        expect(captured).toHaveLength(0);
    });
});

describe('PER-41: a patched response drops the real length, encoding and digests', () => {
    const responder = async () => new Response('{"a":1}', {
        headers: {
            'Content-Type': 'application/json', 'Content-Length': '7', 'Content-Encoding': 'gzip',
            'Content-MD5': 'abc', Digest: 'sha-256=abc', 'X-Kept': 'yes'
        }
    });

    test('fetch', async () => {
        const h = withRules([patchRule({ added: 'x'.repeat(50) })], { originalFetch: responder });
        const response = await h.fetch('https://example.test/api/users');
        for (const name of ['content-length', 'content-encoding', 'content-md5', 'digest']) {
            expect(response.headers.get(name)).toBeNull();
        }
        expect(response.headers.get('x-kept')).toBe('yes');
        expect(response.headers.get('x-splicetap')).toBe('true');
    });

    test('XHR', async () => {
        const h = withRules([patchRule({ added: 'x'.repeat(50) })], { originalFetch: responder });
        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('GET', '/api/users');
        xhr.send();
        await done;
        expect(xhr.getResponseHeader('content-length')).toBeNull();
        expect(xhr.getResponseHeader('content-encoding')).toBeNull();
        expect(xhr.getResponseHeader('x-kept')).toBe('yes');
    });
});

describe('PER-42: mocked fetch responses behave like real ones', () => {
    const statusMock = (statusCode, headers = {}, body = { mocked: true }) => mockRule({
        response: { statusCode, headers: { 'Content-Type': 'application/json', ...headers }, body, delay: 0, mode: 'static' }
    });

    test('clone() keeps url, type and an overridden status', async () => {
        const h = withRules([statusMock(299), mockRule({ id: 'odd', match: { url: '*/api/odd*', method: '*' }, response: { statusCode: 601, headers: {}, body: '', delay: 0, mode: 'static' } })]);
        const response = await h.fetch('/api/users');
        const copy = response.clone();
        expect(copy.url).toBe('https://example.test/api/users');
        expect(copy.type).toBe('basic');
        expect(copy.clone().url).toBe('https://example.test/api/users');

        const odd = await h.fetch('/api/odd');
        expect(odd.clone().status).toBe(601);
        expect(odd.clone().ok).toBe(false);
    });

    test('type is basic from this origin and cors from another', async () => {
        const h = withRules([mockRule({ match: { url: '*', method: '*' } })]);
        expect((await h.fetch('/api/users')).type).toBe('basic');
        expect((await h.fetch('https://other.test/api/users')).type).toBe('cors');
    });

    test('a HEAD mock has a null body', async () => {
        const h = withRules([mockRule()]);
        const response = await h.fetch('/api/users', { method: 'HEAD' });
        expect(response.status).toBe(200);
        expect(response.body).toBeNull();
        expect(await response.text()).toBe('');
    });

    test("a 3xx mock rejects under redirect: 'error'", async () => {
        const h = withRules([statusMock(302, { Location: '/api/elsewhere' })]);
        const logged = h.collect(h.channels.log);
        await expect(h.fetch('/api/users', { redirect: 'error' })).rejects.toThrow(TypeError);
        expect(logged[0].note).toMatch(/redirect mode is 'error'/);
    });

    test("a 3xx mock is an opaque redirect under redirect: 'manual'", async () => {
        const h = withRules([statusMock(301, { Location: '/api/elsewhere' })]);
        const response = await h.fetch('/api/users', { redirect: 'manual' });
        expect(response.type).toBe('opaqueredirect');
        expect(response.status).toBe(0);
        expect(response.url).toBe('https://example.test/api/users');
        expect(response.body).toBeNull();
        expect(response.clone().type).toBe('opaqueredirect');
    });

    test('a 3xx mock with a Location is followed by default, to a mocked target', async () => {
        const target = mockRule({ id: 't', name: 'Target', match: { url: '*/api/target*', method: '*' }, response: { statusCode: 200, headers: {}, body: { target: true }, delay: 0, mode: 'static' } });
        const h = withRules([statusMock(302, { Location: '/api/target' }), target]);
        const response = await h.fetch('/api/users');
        expect(response.status).toBe(200);
        expect(response.redirected).toBe(true);
        expect(response.url).toBe('https://example.test/api/target');
        expect(await response.json()).toEqual({ target: true });
    });

    test('a 303 turns a POST into a GET without its body', async () => {
        const h = withRules([statusMock(303, { Location: 'https://example.test/next' })]);
        const response = await h.fetch('/api/users', { method: 'POST', body: 'payload', headers: { 'Content-Type': 'text/plain', 'X-Keep': '1' } });
        expect(response.redirected).toBe(true);
        const [url, init] = h.passthroughCalls[0];
        expect(url).toBe('https://example.test/next');
        expect(init.method).toBe('GET');
        expect(init.body).toBeUndefined();
        expect(init.headers.get('content-type')).toBeNull();
        expect(init.headers.get('x-keep')).toBe('1');
    });

    test('a redirect loop stops after 20 hops', async () => {
        const h = withRules([statusMock(307, { Location: '/api/users' })]);
        await expect(h.fetch('/api/users')).rejects.toThrow(TypeError);
    });

    test('a 3xx mock without a Location is returned as is', async () => {
        const h = withRules([statusMock(304)]);
        const response = await h.fetch('/api/users');
        expect(response.status).toBe(304);
        expect(response.redirected).toBe(false);
    });
});

describe('PER-45: a delay rule lets keepalive requests leave at once', () => {
    test('the hold is skipped and the log says so', async () => {
        const h = withRules([delayRule(500)]);
        const logged = h.collect(h.channels.log);
        const start = Date.now();
        await h.fetch('https://example.test/api/users', { method: 'POST', body: 'bye', keepalive: true });
        expect(Date.now() - start).toBeLessThan(200);
        expect(h.passthroughCalls).toHaveLength(1);
        expect(logged[0]).toMatchObject({ ruleType: 'delay', note: 'Delay skipped — keepalive request' });
    });
});

describe('PER-48: chaos mode only fails network requests', () => {
    test('fetch of data: and blob: URLs is untouched', async () => {
        const h = withRules([], { state: chaosOn });
        await expect(h.fetch('data:application/json,{"a":1}')).resolves.toBeDefined();
        await expect(h.fetch('blob:https://example.test/3f0c8b5e-1111-2222-3333-444455556666')).resolves.toBeDefined();
        await expect(h.fetch('https://example.test/api/x')).rejects.toThrow(/Chaos/);
    });

    test('XHR to a data: URL is untouched', async () => {
        const h = withRules([], { state: chaosOn });
        const xhr = h.newXHR();
        const done = settle(xhr);
        xhr.open('GET', 'data:application/json,{"a":1}');
        xhr.send();
        expect((await done).status).toBe(200);
    });
});

// ---- contract B: PER-2 residual (the injected.js half) -------------------------

describe('contract B: Object.prototype hooks never see rule data', () => {
    const SECRET = 'SECRET-BODY-91c3';
    const PATTERN = 'never-match-7Q2';
    const HOOKED = ['patch', 'headers', 'graphql', 'body', 'mode', 'delay', 'statusText', 'redirect', 'response', 'toJSON', 'then', SYMBOL_ITERATOR()];

    function SYMBOL_ITERATOR() { return Symbol.iterator; }

    /**
     * Getters (with pass-through setters) on Object.prototype, as a page can
     * install before its first request. Each records any `this` that carries
     * the secret body or the pattern.
     */
    function installHooks() {
        const stringify = JSON.stringify;
        const leaks = [];
        let busy = false;
        for (const name of HOOKED) {
            Object.defineProperty(Object.prototype, name, {
                configurable: true,
                get() {
                    if (busy) return undefined;
                    busy = true;
                    try {
                        const text = stringify(this);
                        if (typeof text === 'string' && (text.includes(SECRET) || text.includes(PATTERN))) leaks.push(String(name));
                    } catch (e) {
                        // not serialisable: nothing to learn from it here
                    } finally {
                        busy = false;
                    }
                    return undefined;
                },
                set(value) {
                    Object.defineProperty(this, name, { value, writable: true, enumerable: true, configurable: true });
                }
            });
        }
        return { leaks, remove: () => { for (const name of HOOKED) delete Object.prototype[name]; } };
    }

    test('rules synced, matched and mocked under the hooks leak nothing', async () => {
        const h = createInterceptor();
        const rules = [
            mockRule({ id: 'never', match: { url: `*/${PATTERN}*`, method: '*' } }),
            mockRule({
                response: { statusCode: 200, headers: { 'X-Note': SECRET }, body: { token: SECRET }, delay: 0, mode: 'static' }
            }),
            { id: 'd', name: 'Slow', enabled: true, type: 'delay', match: { url: '*/api/slow*', method: '*' }, delayMs: 5 }
        ];
        const hooks = installHooks();
        let results;
        try {
            h.syncState({ rules });
            const mocked = await h.fetch('https://example.test/api/users');
            const passed = await h.fetch('https://example.test/api/other');
            const slow = await h.fetch('https://example.test/api/slow');
            const xhr = h.newXHR();
            // Resolved with the marker only: the response text is the page's
            // own data, and a promise resolved with it reads `then`.
            const marker = new Promise((resolve) => xhr.addEventListener('loadend', () => resolve(xhr.getResponseHeader('x-splicetap'))));
            xhr.open('GET', '/api/users');
            xhr.send();
            results = { mocked: mocked.headers.get('x-splicetap'), passed: passed.headers.get('x-splicetap'), slow: slow.status, xhr: await marker };
        } finally {
            hooks.remove();
        }
        expect(results).toEqual({ mocked: 'true', passed: null, slow: 200, xhr: 'true' });
        expect(hooks.leaks).toEqual([]);
    });
});
