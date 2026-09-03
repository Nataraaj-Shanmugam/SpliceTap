/**
 * Tests for content/injected.js — the MAIN-world fetch interceptor (CQ-8).
 *
 * This is the file that delivers the product's core promise: a matching
 * request gets the user's mock instead of the network. It had no coverage,
 * so nothing verified that a rule actually intercepts, that a disabled rule
 * does not, or that SEC-2's nonce-keyed channel really keeps a page script
 * from reading the user's rules.
 *
 * See tests/helpers/injected-harness.js for why this runs under node rather
 * than jsdom (short version: the real Response/Headers are what correctness
 * depends on, and jsdom does not supply them).
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

describe('fetch interception — the core path', () => {
    test('a matching enabled rule answers from the mock, without touching the network', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        const response = await h.fetch('https://example.test/api/users/1');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ mocked: true });
        expect(h.passthroughCalls).toHaveLength(0);
    });

    test('applies the configured status and headers', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [mockRule({
                response: {
                    statusCode: 201,
                    headers: { 'X-Mock': 'yes', 'Content-Type': 'application/json' },
                    body: { created: true },
                    mode: 'static'
                }
            })]
        });

        const response = await h.fetch('https://example.test/api/users');

        expect(response.status).toBe(201);
        expect(response.headers.get('X-Mock')).toBe('yes');
    });

    test('a non-matching URL passes through to the real fetch', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        const response = await h.fetch('https://example.test/other');

        expect(await response.json()).toEqual({ origin: true });
        expect(h.passthroughCalls).toHaveLength(1);
    });

    test('a method mismatch passes through', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        await h.fetch('https://example.test/api/users', { method: 'POST' });

        expect(h.passthroughCalls).toHaveLength(1);
    });

    test('a disabled rule does not intercept', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule({ enabled: false })] });

        await h.fetch('https://example.test/api/users/1');

        expect(h.passthroughCalls).toHaveLength(1);
    });

    test('nothing is intercepted while the extension is inactive', async () => {
        // The popup's master toggle has to actually stop interception, not
        // just stop showing it.
        const h = createInterceptor();
        h.syncState({ active: false, rules: [mockRule()] });

        await h.fetch('https://example.test/api/users/1');

        expect(h.passthroughCalls).toHaveLength(1);
    });

    test('with no rules synced at all, fetch is a passthrough', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [] });

        await h.fetch('https://example.test/api/users/1');

        expect(h.passthroughCalls).toHaveLength(1);
    });

    test('accepts a Request object as the fetch argument', async () => {
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        const response = await h.fetch(new Request('https://example.test/api/users/1'));

        expect(await response.json()).toEqual({ mocked: true });
    });

    test('accepts a URL object as the fetch argument (Q-6)', async () => {
        // A URL object used to survive as a non-string and break matchUrl's
        // .toLowerCase(), crashing the request rather than mocking it.
        const h = createInterceptor();
        h.syncState({ rules: [mockRule()] });

        const response = await h.fetch(new URL('https://example.test/api/users/1'));

        expect(await response.json()).toEqual({ mocked: true });
    });

    test('the first matching rule wins when several match', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [
                mockRule({ id: 'first', response: { statusCode: 200, body: { which: 'first' }, mode: 'static' } }),
                mockRule({ id: 'second', response: { statusCode: 200, body: { which: 'second' }, mode: 'static' } })
            ]
        });

        const response = await h.fetch('https://example.test/api/users');

        expect(await response.json()).toEqual({ which: 'first' });
    });
});

describe('fetch interception — response shaping', () => {
    test('a 204 yields a null body rather than throwing', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [mockRule({ response: { statusCode: 204, body: { ignored: true }, mode: 'static' } })]
        });

        const response = await h.fetch('https://example.test/api/users');

        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
    });

    test('serves a string body verbatim', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [mockRule({
                response: { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'plain text', mode: 'static' }
            })]
        });

        const response = await h.fetch('https://example.test/api/users');

        expect(await response.text()).toBe('plain text');
    });

    test('patch mode merges into the real response instead of replacing it', async () => {
        const h = createInterceptor({
            originalFetch: async () => new Response(
                JSON.stringify({ id: 1, name: 'real', nested: { keep: true, replace: 'old' } }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
        });
        h.syncState({
            rules: [mockRule({
                response: { mode: 'patch', patch: { name: 'patched', nested: { replace: 'new' } } }
            })]
        });

        const response = await h.fetch('https://example.test/api/users/1');
        const body = await response.json();

        expect(body).toEqual({ id: 1, name: 'patched', nested: { keep: true, replace: 'new' } });
        expect(h.passthroughCalls).toHaveLength(1); // patch needs the real response
    });

    test('patch mode removes a key when the patch sets it to null (RFC 7386)', async () => {
        const h = createInterceptor({
            originalFetch: async () => new Response(
                JSON.stringify({ keep: 1, drop: 2 }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
        });
        h.syncState({
            rules: [mockRule({ response: { mode: 'patch', patch: { drop: null } } })]
        });

        const body = await (await h.fetch('https://example.test/api/users/1')).json();

        expect(body).toEqual({ keep: 1 });
    });
});

describe('match conditions', () => {
    test('a header condition is honoured', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [mockRule({ match: { url: '*/api/users*', method: 'GET', headers: { 'X-Env': 'dev' } } })]
        });

        await h.fetch('https://example.test/api/users', { headers: { 'X-Env': 'prod' } });
        expect(h.passthroughCalls).toHaveLength(1);

        const matched = await h.fetch('https://example.test/api/users', { headers: { 'X-Env': 'dev' } });
        expect(await matched.json()).toEqual({ mocked: true });
    });

    test('a GraphQL operationName condition is honoured', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [mockRule({
                match: { url: '*/graphql', method: 'POST', graphql: { operationName: 'GetUser' } }
            })]
        });

        await h.fetch('https://example.test/graphql', {
            method: 'POST',
            body: JSON.stringify({ operationName: 'GetOrders', query: '{orders{id}}' })
        });
        expect(h.passthroughCalls).toHaveLength(1);

        const matched = await h.fetch('https://example.test/graphql', {
            method: 'POST',
            body: JSON.stringify({ operationName: 'GetUser', query: '{user{id}}' })
        });
        expect(await matched.json()).toEqual({ mocked: true });
    });

    test('a regex URL pattern matches', async () => {
        const h = createInterceptor();
        h.syncState({
            rules: [mockRule({ match: { url: '/\\/api\\/v[0-9]+\\/users/', method: 'GET' } })]
        });

        const response = await h.fetch('https://example.test/api/v2/users');

        expect(await response.json()).toEqual({ mocked: true });
    });
});

describe('the nonce-keyed channel (SEC-2)', () => {
    test('state pushed on the un-nonced legacy channel is ignored', async () => {
        // This is the whole point of SEC-2: before it, any page script could
        // dispatch on the fixed name to install its own rules, or listen on it
        // to read the user's.
        const h = createInterceptor();

        h.document.dispatchEvent(new CustomEvent('__splicetap_sync_state__', {
            detail: { active: true, rules: [mockRule()], settings: {} }
        }));

        await h.fetch('https://example.test/api/users/1');
        expect(h.passthroughCalls).toHaveLength(1);
    });

    test('state pushed on a wrong nonce is ignored', async () => {
        const h = createInterceptor();

        h.document.dispatchEvent(new CustomEvent('__splicetap_sync_state__:guessed', {
            detail: { active: true, rules: [mockRule()], settings: {} }
        }));

        await h.fetch('https://example.test/api/users/1');
        expect(h.passthroughCalls).toHaveLength(1);
    });

    test('a second bootstrap cannot re-key the channel', async () => {
        // The handshake is one-shot; otherwise a page script could dispatch
        // its own bootstrap afterwards and take over the channel.
        const h = createInterceptor();

        h.document.dispatchEvent(new CustomEvent(h.BOOTSTRAP_EVENT, {
            detail: { nonce: 'attacker-nonce' }
        }));
        h.document.dispatchEvent(new CustomEvent('__splicetap_sync_state__:attacker-nonce', {
            detail: { active: true, rules: [mockRule()], settings: {} }
        }));

        await h.fetch('https://example.test/api/users/1');
        expect(h.passthroughCalls).toHaveLength(1);

        // The legitimate channel still works.
        h.syncState({ rules: [mockRule()] });
        const response = await h.fetch('https://example.test/api/users/1');
        expect(await response.json()).toEqual({ mocked: true });
    });

    test('without a bootstrap, no state can be injected at all', async () => {
        const h = createInterceptor({ bootstrap: false });

        h.document.dispatchEvent(new CustomEvent(h.channels.sync, {
            detail: { active: true, rules: [mockRule()], settings: {} }
        }));

        await h.fetch('https://example.test/api/users/1');
        expect(h.passthroughCalls).toHaveLength(1);
    });
});

describe('interception logging', () => {
    test('reports an applied rule over the nonced log channel', async () => {
        const h = createInterceptor();
        const logged = h.collect(h.channels.log);
        h.syncState({ rules: [mockRule()] });

        await h.fetch('https://example.test/api/users/1');

        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatchObject({
            ruleId: 'r1',
            ruleName: 'Mock users',
            ruleType: 'mock',
            method: 'GET',
            status: 200
        });
    });

    test('redacts sensitive query parameters before logging (S-8)', async () => {
        const h = createInterceptor();
        const logged = h.collect(h.channels.log);
        h.syncState({ rules: [mockRule()] });

        await h.fetch('https://example.test/api/users?access_token=super-secret&page=2');

        expect(logged[0].url).not.toMatch(/super-secret/);
        // URL.toString() percent-encodes the brackets, so it lands as
        // %5Bredacted%5D rather than [redacted]. Match either form: what
        // matters is that the token is gone and the placeholder is there.
        expect(logged[0].url).toMatch(/redacted/i);
        expect(logged[0].url).toMatch(/page=2/);
    });

    test('logs nothing when no rule applies', async () => {
        const h = createInterceptor();
        const logged = h.collect(h.channels.log);
        h.syncState({ rules: [mockRule()] });

        await h.fetch('https://example.test/untouched');

        expect(logged).toHaveLength(0);
    });
});

describe('capture', () => {
    test('emits nothing while disarmed', async () => {
        const h = createInterceptor();
        const captured = h.collect(h.channels.capture);
        h.syncState({ rules: [], settings: {} });

        await h.fetch('https://example.test/api/users/1');
        await h.flush();

        expect(captured).toHaveLength(0);
    });

    test('captures a passed-through JSON response once armed', async () => {
        const h = createInterceptor();
        const captured = h.collect(h.channels.capture);
        h.syncState({ rules: [], settings: { captureArmed: true } });

        const response = await h.fetch('https://example.test/api/users/1');
        await h.flush();

        // The page must still receive an unread body — capture takes a clone.
        expect(await response.json()).toEqual({ origin: true });
        expect(captured).toHaveLength(1);
        expect(captured[0]).toMatchObject({ status: 200, method: 'GET' });
        expect(captured[0].body).toBe('{"origin":true}');
    });

    test('skips non-textual content types', async () => {
        const h = createInterceptor({
            originalFetch: async () => new Response(' binary', {
                status: 200,
                headers: { 'Content-Type': 'application/octet-stream' }
            })
        });
        const captured = h.collect(h.channels.capture);
        h.syncState({ rules: [], settings: { captureArmed: true } });

        await h.fetch('https://example.test/download');
        await h.flush();

        expect(captured).toHaveLength(0);
    });

    test('skips a body over the size cap', async () => {
        const big = JSON.stringify({ data: 'x'.repeat(200 * 1024) });
        const h = createInterceptor({
            originalFetch: async () => new Response(big, {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        });
        const captured = h.collect(h.channels.capture);
        h.syncState({ rules: [], settings: { captureArmed: true } });

        await h.fetch('https://example.test/api/big');
        await h.flush();

        expect(captured).toHaveLength(0);
    });

    test('redacts sensitive query parameters in the captured URL', async () => {
        const h = createInterceptor();
        const captured = h.collect(h.channels.capture);
        h.syncState({ rules: [], settings: { captureArmed: true } });

        await h.fetch('https://example.test/api/users?api_key=leak-me');
        await h.flush();

        expect(captured[0].url).not.toMatch(/leak-me/);
    });
});

describe('missing shared modules', () => {
    test('leaves fetch unpatched rather than throwing', async () => {
        // If the UMD modules fail to load, the interceptor must degrade to a
        // no-op: a broken extension must not break the page's requests.
        const h = createInterceptor({ withGlobals: false });

        const response = await h.fetch('https://example.test/api/users/1');

        expect(await response.json()).toEqual({ origin: true });
        expect(h.passthroughCalls).toHaveLength(1);
        expect(h.logs.some(([level]) => level === 'error')).toBe(true);
    });
});
