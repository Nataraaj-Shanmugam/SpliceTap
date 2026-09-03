/**
 * Tests for content/content.js — the ISOLATED-world relay (PERF-4).
 *
 * The batching added for PERF-4 sits on the hottest path in the extension:
 * every intercepted request passes through it. Its failure modes are quiet
 * ones — a timer that is never cleared, or entries dropped by a navigation —
 * so they are worth pinning rather than eyeballing.
 */

const { createRelay } = require('./helpers/relay-harness');

const LOG_BATCH_WINDOW_MS = 250;
const LOG_BATCH_MAX = 25;

function entry(n) {
    return { url: `https://example.test/api/${n}`, method: 'GET', ruleId: 'r1', status: 200 };
}

describe('interception log batching (PERF-4)', () => {
    test('coalesces several entries into one message', async () => {
        const relay = createRelay();

        relay.emitLog(entry(1));
        relay.emitLog(entry(2));
        relay.emitLog(entry(3));

        // Nothing sent yet — that is the point of the window.
        expect(relay.sentOfType('logInterceptionBatch')).toHaveLength(0);

        await relay.wait(LOG_BATCH_WINDOW_MS + 60);

        const batches = relay.sentOfType('logInterceptionBatch');
        expect(batches).toHaveLength(1);
        expect(batches[0].entries).toHaveLength(3);
    });

    test('preserves entry order and content', async () => {
        const relay = createRelay();

        relay.emitLog(entry(1));
        relay.emitLog(entry(2));
        await relay.wait(LOG_BATCH_WINDOW_MS + 60);

        const [batch] = relay.sentOfType('logInterceptionBatch');
        expect(batch.entries.map((e) => e.url)).toEqual([
            'https://example.test/api/1',
            'https://example.test/api/2'
        ]);
    });

    test('flushes early once the queue fills, without waiting out the window', async () => {
        const relay = createRelay();

        for (let i = 0; i < LOG_BATCH_MAX; i++) relay.emitLog(entry(i));

        // Sent immediately, before the timer could possibly have fired.
        const batches = relay.sentOfType('logInterceptionBatch');
        expect(batches).toHaveLength(1);
        expect(batches[0].entries).toHaveLength(LOG_BATCH_MAX);
    });

    test('a burst larger than one batch sends the remainder on the timer', async () => {
        const relay = createRelay();

        for (let i = 0; i < LOG_BATCH_MAX + 3; i++) relay.emitLog(entry(i));
        await relay.wait(LOG_BATCH_WINDOW_MS + 60);

        const batches = relay.sentOfType('logInterceptionBatch');
        expect(batches).toHaveLength(2);
        expect(batches[0].entries).toHaveLength(LOG_BATCH_MAX);
        expect(batches[1].entries).toHaveLength(3);
    });

    test('one message per window, not one per request', async () => {
        // The regression PERF-4 exists to prevent: N requests must not mean N
        // wake-ups for the service worker.
        const relay = createRelay();

        for (let i = 0; i < 10; i++) relay.emitLog(entry(i));
        await relay.wait(LOG_BATCH_WINDOW_MS + 60);

        expect(relay.sentOfType('logInterceptionBatch')).toHaveLength(1);
        expect(relay.sentOfType('logInterception')).toHaveLength(0);
    });

    test('a later entry opens a fresh window rather than being dropped', async () => {
        const relay = createRelay();

        relay.emitLog(entry(1));
        await relay.wait(LOG_BATCH_WINDOW_MS + 60);
        relay.emitLog(entry(2));
        await relay.wait(LOG_BATCH_WINDOW_MS + 60);

        const batches = relay.sentOfType('logInterceptionBatch');
        expect(batches).toHaveLength(2);
        expect(batches[1].entries[0].url).toBe('https://example.test/api/2');
    });

    test('sends nothing when no entries were queued', async () => {
        const relay = createRelay();
        await relay.wait(LOG_BATCH_WINDOW_MS + 60);

        expect(relay.sentOfType('logInterceptionBatch')).toHaveLength(0);
    });

    test('ignores a malformed entry', async () => {
        const relay = createRelay();

        relay.emitLog(null);
        relay.emitLog('not an object');
        relay.emitLog(entry(1));
        await relay.wait(LOG_BATCH_WINDOW_MS + 60);

        const [batch] = relay.sentOfType('logInterceptionBatch');
        expect(batch.entries).toHaveLength(1);
    });
});

describe('flush on page teardown', () => {
    test('pagehide flushes what is queued', async () => {
        // A navigation would otherwise discard the window's entries.
        const relay = createRelay();

        relay.emitLog(entry(1));
        expect(relay.sentOfType('logInterceptionBatch')).toHaveLength(0);

        relay.window.dispatchEvent(new Event('pagehide'));

        const batches = relay.sentOfType('logInterceptionBatch');
        expect(batches).toHaveLength(1);
        expect(batches[0].entries).toHaveLength(1);
    });

    test('becoming hidden flushes what is queued', async () => {
        const relay = createRelay();

        relay.emitLog(entry(1));
        relay.document.visibilityState = 'hidden';
        relay.document.dispatchEvent(new Event('visibilitychange'));

        expect(relay.sentOfType('logInterceptionBatch')).toHaveLength(1);
    });

    test('staying visible does not flush early', async () => {
        const relay = createRelay();

        relay.emitLog(entry(1));
        relay.document.visibilityState = 'visible';
        relay.document.dispatchEvent(new Event('visibilitychange'));

        expect(relay.sentOfType('logInterceptionBatch')).toHaveLength(0);
    });

    test('a flush on teardown does not leave the entries queued for a second send', async () => {
        const relay = createRelay();

        relay.emitLog(entry(1));
        relay.window.dispatchEvent(new Event('pagehide'));
        await relay.wait(LOG_BATCH_WINDOW_MS + 60);

        // The pending timer must have been cleared by the flush.
        expect(relay.sentOfType('logInterceptionBatch')).toHaveLength(1);
    });
});

describe('captures stay unbatched', () => {
    test('a capture is relayed immediately', async () => {
        // Captures are explicit, rare, and carry response bodies up to 100 KB;
        // batching them would build large messages for no benefit.
        const relay = createRelay();

        relay.emitCapture({ url: 'https://example.test/api', body: '{"a":1}' });

        expect(relay.sentOfType('logCapture')).toHaveLength(1);
    });

    test('a capture without a string body is dropped', async () => {
        const relay = createRelay();

        relay.emitCapture({ url: 'https://example.test/api', body: { a: 1 } });

        expect(relay.sentOfType('logCapture')).toHaveLength(0);
    });
});

describe('relay resilience', () => {
    test('a rejected sendMessage does not throw into the page', async () => {
        // The service worker may be asleep or the page closing; the relay must
        // swallow that rather than surfacing an unhandled rejection.
        const relay = createRelay({
            onMessage: async () => { throw new Error('Receiving end does not exist'); }
        });

        relay.emitLog(entry(1));
        await relay.wait(LOG_BATCH_WINDOW_MS + 60);

        expect(relay.sentOfType('logInterceptionBatch')).toHaveLength(1);
    });

    test('does not wire itself up on a browser-internal page', async () => {
        const relay = createRelay({ href: 'chrome://extensions' });

        // No state request, and no listeners, so nothing relays.
        expect(relay.sent).toHaveLength(0);

        relay.emitLog(entry(1));
        await relay.wait(LOG_BATCH_WINDOW_MS + 60);
        expect(relay.sentOfType('logInterceptionBatch')).toHaveLength(0);

        // The nonce handover still happens: it is dispatched at document_start,
        // ahead of shouldInject(), because it has to precede any page script.
        // Harmless — with no listeners wired, nothing can act on it.
        expect(relay.nonce).toEqual(expect.any(String));
    });
});
