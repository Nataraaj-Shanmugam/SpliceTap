/**
 * Tests for service_worker/background.js (CQ-8).
 *
 * These drive the real `chrome.runtime.onMessage` listener the service worker
 * registers, rather than calling methods on the class directly, because the
 * message handler *is* the trust boundary: every rule write in the extension
 * funnels through it, and QA-1's actual defect lived in the handler (it
 * discarded the storage layer's result), not in validateRule.
 *
 * See tests/helpers/load-esm.js for how an ESM service worker is loaded under
 * CommonJS Jest, and tests/helpers/chrome-mock.js for the chrome stand-in.
 */

const { loadEsmModule, installChrome } = require('./helpers/load-esm');
const { createChromeMock } = require('./helpers/chrome-mock');
const path = require('path');

const BACKGROUND = path.resolve(__dirname, '..', 'service_worker', 'background.js');

const quietConsole = Object.assign({}, console, { log() {}, error() {}, warn() {} });

let restoreChrome = null;
let activeBackground = null;

async function setup(options) {
    const mock = createChromeMock(options);
    // UMD modules (dnr.js) are require()'d as real CommonJS and resolve
    // `chrome` from globalThis, so the mock has to be visible there too.
    restoreChrome = installChrome(mock.chrome);

    const exports = loadEsmModule(BACKGROUND, { chrome: mock.chrome, console: quietConsole });
    const bg = exports.default;
    activeBackground = bg;
    await bg.ready;

    return { mock, bg, send: mock.dispatchMessage };
}

afterEach(() => {
    // Q-16's trailing flush schedules a real timer. Left running it outlives
    // the test, holds the (now-restored) chrome mock, and keeps Jest's event
    // loop alive after the suite finishes.
    if (activeBackground && activeBackground._trailingFlushTimer) {
        clearTimeout(activeBackground._trailingFlushTimer);
        activeBackground._trailingFlushTimer = null;
    }
    activeBackground = null;

    if (restoreChrome) restoreChrome();
    restoreChrome = null;
});

/** A rule that passes validation, for tests that need a valid baseline. */
function validMockRule(overrides = {}) {
    return {
        id: 'r1',
        name: 'Test rule',
        type: 'mock',
        enabled: true,
        match: { url: '*/api/*', method: 'GET' },
        response: { statusCode: 200, headers: {}, body: {}, delay: 0, mode: 'static' },
        ...overrides
    };
}

/** Collect validateRule's failure messages as one string. */
async function messagesFor(bg, rule) {
    const result = await bg.validateRule(rule);
    return result.results.map((r) => r.message).join('; ');
}

describe('validateRule — common fields', () => {
    test('accepts a well-formed mock rule', async () => {
        const { bg } = await setup();
        const result = await bg.validateRule(validMockRule());

        expect(result.passed).toBe(true);
    });

    test('rejects a missing rule object', async () => {
        const { bg } = await setup();
        expect((await bg.validateRule(null)).passed).toBe(false);
        expect((await bg.validateRule('nope')).passed).toBe(false);
    });

    test('requires a non-blank name', async () => {
        const { bg } = await setup();
        expect(await messagesFor(bg, validMockRule({ name: '   ' }))).toMatch(/name is required/i);
    });

    test('requires a URL pattern and a method', async () => {
        const { bg } = await setup();
        const messages = await messagesFor(bg, validMockRule({ match: {} }));

        expect(messages).toMatch(/URL pattern is required/i);
        expect(messages).toMatch(/method is required/i);
    });

    test('rejects a URL pattern that can backtrack catastrophically', async () => {
        // Guards the ReDoS check in SpliceTapUtils.validateUrlPattern: a rule
        // pattern runs against every request URL, so a pathological regex
        // hangs the page, not just the editor.
        const { bg } = await setup();
        const rule = validMockRule({ match: { url: '/(a+)+$/', method: 'GET' } });

        expect(await messagesFor(bg, rule)).toMatch(/Invalid URL pattern/i);
    });
});

describe('validateRule — per-type rules', () => {
    test('mock: rejects an out-of-range status code', async () => {
        const { bg } = await setup();
        const rule = validMockRule({ response: { statusCode: 99 } });

        expect(await messagesFor(bg, rule)).toMatch(/status code/i);
    });

    test('mock: rejects a delay outside the shared limits', async () => {
        const { bg } = await setup();
        const tooLong = validMockRule({ response: { statusCode: 200, delay: 30001 } });
        const negative = validMockRule({ response: { statusCode: 200, delay: -1 } });

        expect(await messagesFor(bg, tooLong)).toMatch(/Delay must be between/i);
        expect(await messagesFor(bg, negative)).toMatch(/Delay must be between/i);
    });

    test('mock: accepts the delay boundaries', async () => {
        const { bg } = await setup();
        const atMax = validMockRule({ response: { statusCode: 200, delay: 30000 } });

        expect((await bg.validateRule(atMax)).passed).toBe(true);
    });

    test('mock: requires a response block', async () => {
        const { bg } = await setup();
        const rule = validMockRule();
        delete rule.response;

        expect(await messagesFor(bg, rule)).toMatch(/Response configuration is required/i);
    });

    test('delay: requires delayMs within limits', async () => {
        const { bg } = await setup();
        const base = { name: 'D', type: 'delay', match: { url: '*/api/*', method: 'GET' } };

        expect((await bg.validateRule({ ...base, delayMs: 500 })).passed).toBe(true);
        expect(await messagesFor(bg, { ...base, delayMs: 0 })).toMatch(/Delay must be between/i);
        expect(await messagesFor(bg, { ...base, delayMs: 30001 })).toMatch(/Delay must be between/i);
    });

    test('redirect: requires a destination', async () => {
        const { bg } = await setup();
        const rule = { name: 'R', type: 'redirect', match: { url: '*/api/*', method: 'GET' } };

        expect(await messagesFor(bg, rule)).toMatch(/Redirect destination is required/i);
    });

    test('headers: requires at least one operation', async () => {
        const { bg } = await setup();
        const rule = { name: 'H', type: 'headers', match: { url: '*/api/*', method: 'GET' }, headersMod: {} };

        expect(await messagesFor(bg, rule)).toMatch(/at least one request or response header/i);
    });

    test('headers: rejects a security-sensitive header (S-3)', async () => {
        const { bg } = await setup();
        const rule = {
            name: 'H',
            type: 'headers',
            match: { url: '*/api/*', method: 'GET' },
            headersMod: { response: [{ name: 'Content-Security-Policy', op: 'remove' }] }
        };

        expect(await messagesFor(bg, rule)).toMatch(/security-sensitive/i);
    });

    test('headers: accepts an ordinary header', async () => {
        const { bg } = await setup();
        const rule = {
            name: 'H',
            type: 'headers',
            match: { url: '*/api/*', method: 'GET' },
            headersMod: { request: [{ name: 'X-Test', op: 'set', value: '1' }] }
        };

        expect((await bg.validateRule(rule)).passed).toBe(true);
    });

    test('queryparams: requires at least one add or remove', async () => {
        const { bg } = await setup();
        const rule = { name: 'Q', type: 'queryparams', match: { url: '*/api/*', method: 'GET' }, queryParams: {} };

        expect(await messagesFor(bg, rule)).toMatch(/at least one query parameter/i);
    });

    test('block: needs no extra configuration', async () => {
        const { bg } = await setup();
        const rule = { name: 'B', type: 'block', match: { url: '*/api/*', method: 'GET' } };

        expect((await bg.validateRule(rule)).passed).toBe(true);
    });

    test('rejects an unknown rule type', async () => {
        const { bg } = await setup();
        const rule = { name: 'X', type: 'teleport', match: { url: '*/api/*', method: 'GET' } };

        expect(await messagesFor(bg, rule)).toMatch(/Unknown rule type: teleport/i);
    });
});

describe('validateRule — match conditions the transport cannot honour (CQ-4)', () => {
    test('rejects a redirect rule with header match conditions', async () => {
        // XHR must pick the redirect target in open(), before request headers
        // exist — so the same rule would redirect fetch but not XHR.
        const { bg } = await setup();
        const rule = {
            name: 'R',
            type: 'redirect',
            match: { url: '*/api/*', method: 'GET', headers: { 'X-Env': 'dev' } },
            redirect: { destination: 'https://example.test/' }
        };

        expect(await messagesFor(bg, rule)).toMatch(/Redirect rules cannot use header or GraphQL/i);
    });

    test('rejects a redirect rule with GraphQL match conditions', async () => {
        const { bg } = await setup();
        const rule = {
            name: 'R',
            type: 'redirect',
            match: { url: '*/graphql', method: 'POST', graphql: { operationName: 'GetUser' } },
            redirect: { destination: 'https://example.test/' }
        };

        expect(await messagesFor(bg, rule)).toMatch(/Redirect rules cannot use header or GraphQL/i);
    });

    test('rejects a DNR-backed rule with header match conditions', async () => {
        const { bg } = await setup();
        const rule = {
            name: 'H',
            type: 'headers',
            match: { url: '*/api/*', method: 'GET', headers: { 'X-Env': 'dev' } },
            headersMod: { request: [{ name: 'X-Test', op: 'set', value: '1' }] }
        };

        expect(await messagesFor(bg, rule)).toMatch(/not supported for this rule type/i);
    });

    test('allows header match conditions on an interceptor-handled mock rule', async () => {
        const { bg } = await setup();
        const rule = validMockRule({ match: { url: '*/api/*', method: 'GET', headers: { 'X-Env': 'dev' } } });

        expect((await bg.validateRule(rule)).passed).toBe(true);
    });
});

describe('saveRule handler', () => {
    test('persists a valid rule and answers success', async () => {
        const { mock, send } = await setup();

        const response = await send({ type: 'saveRule', rule: validMockRule() });

        expect(response.success).toBe(true);
        expect(mock.raw.spliceTapRules).toHaveLength(1);
    });

    test('refuses an invalid rule without persisting it (S-2)', async () => {
        // Both editors validate client-side; this is the check that survives a
        // hand-edited import or any future caller.
        const { mock, send } = await setup();

        const response = await send({ type: 'saveRule', rule: validMockRule({ name: '' }) });

        expect(response.success).toBe(false);
        expect(response.error).toMatch(/name is required/i);
        expect(mock.raw.spliceTapRules).toBeUndefined();
    });

    test('reports failure when the write fails (QA-1)', async () => {
        // The regression: the storage result was discarded, so a
        // quota-exceeded write still answered success and the editor said
        // "Rule saved successfully!" over a rule that never persisted.
        const { mock, send } = await setup();
        mock.fail.set = 'QUOTA_BYTES exceeded';

        const response = await send({ type: 'saveRule', rule: validMockRule() });

        expect(response.success).toBe(false);
        expect(response.error).toMatch(/quota exceeded/i);
    });

    test('requires rule data', async () => {
        const { send } = await setup();
        const response = await send({ type: 'saveRule' });

        expect(response.success).toBe(false);
        expect(response.error).toMatch(/Rule data is required/i);
    });

    test('allocates a dnrRuleId for a headers rule that lacks one', async () => {
        const { mock, send } = await setup();
        const rule = {
            id: 'h1',
            name: 'H',
            type: 'headers',
            enabled: true,
            match: { url: '*/api/*', method: 'GET' },
            headersMod: { request: [{ name: 'X-Test', op: 'set', value: '1' }] }
        };

        await send({ type: 'saveRule', rule });

        expect(mock.raw.spliceTapRules[0].dnrRuleId).toBe(1);
    });

    test('does not reallocate a dnrRuleId a rule already owns', async () => {
        // Reallocating on every save would drift the id away from the DNR
        // ruleset entry the rule is registered under.
        const { mock, send } = await setup();
        const rule = {
            id: 'h1',
            name: 'H',
            type: 'headers',
            enabled: true,
            dnrRuleId: 7,
            match: { url: '*/api/*', method: 'GET' },
            headersMod: { request: [{ name: 'X-Test', op: 'set', value: '1' }] }
        };

        await send({ type: 'saveRule', rule });

        expect(mock.raw.spliceTapRules[0].dnrRuleId).toBe(7);
    });

    test('registers an enabled headers rule with the DNR layer', async () => {
        const { mock, send } = await setup();
        const rule = {
            id: 'h1',
            name: 'H',
            type: 'headers',
            enabled: true,
            match: { url: '*/api/*', method: 'GET' },
            headersMod: { request: [{ name: 'X-Test', op: 'set', value: '1' }] }
        };

        await send({ type: 'saveRule', rule });

        const dnr = mock.getDynamicRules();
        expect(dnr).toHaveLength(1);
        expect(dnr[0].action.type).toBe('modifyHeaders');
    });
});

describe('setRules handler (bulk import)', () => {
    test('keeps valid rules and skips invalid ones', async () => {
        // One bad rule in an imported file should not block the good ones,
        // but it must not be silently accepted either.
        const { mock, send } = await setup();

        const response = await send({
            type: 'setRules',
            rules: [validMockRule({ id: 'good' }), validMockRule({ id: 'bad', name: '' })]
        });

        expect(response.success).toBe(true);
        expect(mock.raw.spliceTapRules.map((r) => r.id)).toEqual(['good']);
    });

    test('rejects a non-array payload', async () => {
        const { send } = await setup();
        const response = await send({ type: 'setRules', rules: 'not an array' });

        expect(response.success).toBe(false);
        expect(response.error).toMatch(/rules array is required/i);
    });
});

describe('rule lifecycle handlers', () => {
    test('getRules returns the stored rules', async () => {
        const { send } = await setup({
            initial: { spliceTapRules: [validMockRule({ id: 'a' })] }
        });

        const response = await send({ type: 'getRules' });
        expect(response.rules.map((r) => r.id)).toEqual(['a']);
    });

    test('deleteRule removes a rule', async () => {
        const { mock, send } = await setup({
            initial: { spliceTapRules: [validMockRule({ id: 'a' }), validMockRule({ id: 'b' })] }
        });

        const response = await send({ type: 'deleteRule', ruleId: 'a' });

        expect(response.success).toBe(true);
        expect(mock.raw.spliceTapRules.map((r) => r.id)).toEqual(['b']);
    });

    test('toggleRule flips enabled', async () => {
        const { mock, send } = await setup({
            initial: { spliceTapRules: [validMockRule({ id: 'a', enabled: false })] }
        });

        await send({ type: 'toggleRule', ruleId: 'a', enabled: true });

        expect(mock.raw.spliceTapRules[0].enabled).toBe(true);
    });

    test('clearRules empties the ruleset and the DNR ruleset with it', async () => {
        const { mock, send } = await setup();
        const rule = {
            id: 'h1',
            name: 'H',
            type: 'headers',
            enabled: true,
            match: { url: '*/api/*', method: 'GET' },
            headersMod: { request: [{ name: 'X-Test', op: 'set', value: '1' }] }
        };
        await send({ type: 'saveRule', rule });
        expect(mock.getDynamicRules()).toHaveLength(1);

        await send({ type: 'clearRules' });

        expect(mock.raw.spliceTapRules).toEqual([]);
        expect(mock.getDynamicRules()).toHaveLength(0);
    });

    test('toggleExtension deactivating withdraws the DNR rules', async () => {
        const { mock, send } = await setup();
        const rule = {
            id: 'h1',
            name: 'H',
            type: 'headers',
            enabled: true,
            match: { url: '*/api/*', method: 'GET' },
            headersMod: { request: [{ name: 'X-Test', op: 'set', value: '1' }] }
        };
        await send({ type: 'saveRule', rule });

        await send({ type: 'toggleExtension', active: false });

        expect(mock.getDynamicRules()).toHaveLength(0);
    });
});

describe('interception log (SEC-3)', () => {
    test('accepts a log entry that names a real rule', async () => {
        const { send } = await setup({
            initial: { spliceTapRules: [validMockRule({ id: 'a' })] }
        });

        await send({
            type: 'logInterception',
            entry: { url: 'https://example.test/api/x', method: 'GET', ruleId: 'a', status: 200 }
        });

        const response = await send({ type: 'getInterceptionLog' });
        expect(response.entries).toHaveLength(1);
    });

    test('drops an entry naming a rule that does not exist', async () => {
        // The relay runs in a page context, so a compromised page must not be
        // able to write arbitrary rows into the log the user reads.
        const { send } = await setup({
            initial: { spliceTapRules: [validMockRule({ id: 'a' })] }
        });

        await send({
            type: 'logInterception',
            entry: { url: 'https://evil.test/', method: 'GET', ruleId: 'not-a-rule' }
        });

        expect((await send({ type: 'getInterceptionLog' })).entries).toHaveLength(0);
    });

    test('drops entries with the wrong field types or an oversized URL', async () => {
        const { send } = await setup({
            initial: { spliceTapRules: [validMockRule({ id: 'a' })] }
        });

        await send({ type: 'logInterception', entry: { url: 123, method: 'GET', ruleId: 'a' } });
        await send({ type: 'logInterception', entry: { url: 'https://x.test/', method: 'GET', ruleId: 42 } });
        await send({
            type: 'logInterception',
            entry: { url: 'https://x.test/' + 'a'.repeat(2100), method: 'GET', ruleId: 'a' }
        });

        expect((await send({ type: 'getInterceptionLog' })).entries).toHaveLength(0);
    });

    test('clearInterceptionLog empties it', async () => {
        const { send } = await setup({
            initial: { spliceTapRules: [validMockRule({ id: 'a' })] }
        });
        await send({
            type: 'logInterception',
            entry: { url: 'https://example.test/api/x', method: 'GET', ruleId: 'a' }
        });

        await send({ type: 'clearInterceptionLog' });

        expect((await send({ type: 'getInterceptionLog' })).entries).toHaveLength(0);
    });
});

describe('capture', () => {
    test('ignores captures while disarmed', async () => {
        // Capture holds response bodies — the one thing the extension
        // otherwise never keeps — so a page context must not be able to push
        // them into storage unless the user armed it.
        const { send } = await setup();

        await send({ type: 'logCapture', entry: { url: 'https://x.test/', body: '{"a":1}' } });

        expect((await send({ type: 'getCaptures' })).captures).toHaveLength(0);
    });

    test('records captures once armed', async () => {
        const { send } = await setup();
        await send({ type: 'setCaptureArmed', armed: true });

        await send({
            type: 'logCapture',
            entry: { url: 'https://x.test/api', method: 'get', status: 201, body: '{"a":1}' }
        });

        const response = await send({ type: 'getCaptures' });
        expect(response.armed).toBe(true);
        expect(response.captures).toHaveLength(1);
        expect(response.captures[0].method).toBe('GET');
        expect(response.captures[0].status).toBe(201);
    });

    test('ignores an entry with a non-string body', async () => {
        const { send } = await setup();
        await send({ type: 'setCaptureArmed', armed: true });

        await send({ type: 'logCapture', entry: { url: 'https://x.test/', body: { a: 1 } } });

        expect((await send({ type: 'getCaptures' })).captures).toHaveLength(0);
    });

    test('caps the buffer at MAX_CAPTURES, keeping the newest', async () => {
        const { bg, send } = await setup();
        await send({ type: 'setCaptureArmed', armed: true });

        for (let i = 0; i < bg.MAX_CAPTURES + 5; i++) {
            await send({ type: 'logCapture', entry: { url: `https://x.test/${i}`, body: `${i}` } });
        }

        const { captures } = await send({ type: 'getCaptures' });
        expect(captures).toHaveLength(bg.MAX_CAPTURES);
        expect(captures[captures.length - 1].body).toBe(String(bg.MAX_CAPTURES + 4));
    });

    test('clearCaptures empties the buffer', async () => {
        const { send } = await setup();
        await send({ type: 'setCaptureArmed', armed: true });
        await send({ type: 'logCapture', entry: { url: 'https://x.test/', body: '{}' } });

        await send({ type: 'clearCaptures' });

        expect((await send({ type: 'getCaptures' })).captures).toHaveLength(0);
    });
});

describe('badge', () => {
    test('shows the enabled rule count when active', async () => {
        const { mock, send } = await setup();
        await send({ type: 'saveRule', rule: validMockRule({ id: 'a', enabled: true }) });

        expect(mock.badge.text).toBe('1');
    });

    test('shows OFF when the extension is toggled off', async () => {
        const { mock, send } = await setup();
        await send({ type: 'toggleExtension', active: false });

        expect(mock.badge.text).toBe('OFF');
    });

    test('shows REC while capture is armed', async () => {
        const { mock, send } = await setup();
        await send({ type: 'setCaptureArmed', armed: true });

        expect(mock.badge.text).toBe('REC');
    });
});
