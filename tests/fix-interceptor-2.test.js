/**
 * Regression tests for fix group A2a, "interceptor-2": content/injected.js
 * (PERSONA-REVIEW PER-2 residual, 4, 7, 14–19, 39–43, 45–48, 52, 54, 56).
 *
 * The harness runs the shipped interceptor against Node's real
 * Response/Headers/Request and a simulated XMLHttpRequest (mock-xhr.js).
 * Behaviour only Chrome can show (upload events, Trusted Types, streaming,
 * keepalive) is covered by tests/e2e/fix-interceptor-2.e2e.test.js.
 */

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
