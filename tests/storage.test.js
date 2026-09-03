/**
 * Tests for src/storage.js (CQ-8).
 *
 * Before this suite the storage layer — every persistence path in the
 * extension — had no coverage at all, because it is an ESM module that plain
 * CommonJS Jest cannot require (tests/utils.test.js documents the same
 * constraint). tests/helpers/load-esm.js removes that blocker.
 *
 * The concurrency tests here are the point of the file: they fail against the
 * pre-QA-2 unserialized code and pass against the current chain, so they can
 * actually catch a regression rather than merely describing one.
 */

const { loadEsm } = require('./helpers/load-esm');
const { createChromeMock } = require('./helpers/chrome-mock');

function setup(options) {
    const mock = createChromeMock(options);
    const SpliceTapStorage = loadEsm('src/storage.js', 'SpliceTapStorage', {
        chrome: mock.chrome,
        // Storage logs expected failures via console.error; keep suite output
        // readable while still letting a genuine unexpected throw surface.
        console: Object.assign({}, console, { error() {}, warn() {} })
    });
    return { mock, storage: new SpliceTapStorage() };
}

describe('mutation serialization (QA-2)', () => {
    test('two concurrent saveRule calls both persist', async () => {
        const { mock, storage } = setup();

        await Promise.all([
            storage.saveRule({ id: 'r1', name: 'A' }),
            storage.saveRule({ id: 'r2', name: 'B' })
        ]);

        const ids = mock.raw.spliceTapRules.map((r) => r.id);
        expect(ids).toEqual(['r1', 'r2']);
    });

    test('a burst of concurrent saves loses none', async () => {
        const { mock, storage } = setup();

        await Promise.all(
            Array.from({ length: 8 }, (_, i) => storage.saveRule({ id: 'r' + i, name: 'Rule ' + i }))
        );

        expect(mock.raw.spliceTapRules).toHaveLength(8);
    });

    test('a delete concurrent with a save does not resurrect the deleted rule', async () => {
        const { mock, storage } = setup({
            initial: { spliceTapRules: [{ id: 'old', name: 'Old' }] }
        });

        await Promise.all([
            storage.deleteRule('old'),
            storage.saveRule({ id: 'new', name: 'New' })
        ]);

        const ids = mock.raw.spliceTapRules.map((r) => r.id);
        expect(ids).toEqual(['new']);
    });

    test('a toggle concurrent with a save keeps both effects', async () => {
        const { mock, storage } = setup({
            initial: { spliceTapRules: [{ id: 'a', name: 'A', enabled: false }] }
        });

        await Promise.all([
            storage.toggleRule('a', true),
            storage.saveRule({ id: 'b', name: 'B' })
        ]);

        const stored = mock.raw.spliceTapRules;
        expect(stored).toHaveLength(2);
        expect(stored.find((r) => r.id === 'a').enabled).toBe(true);
    });

    test('replaceRules queued behind a saveRule does not deadlock', async () => {
        // replaceRules() serializes, and saveRule() calls saveRules() from
        // *inside* the chain. Serializing at the saveRules level instead would
        // make saveRule await a lock it already holds — this test is what
        // pins that structural choice rather than a comment about it.
        const { mock, storage } = setup();

        const pending = Promise.all([
            storage.saveRule({ id: 'r1', name: 'A' }),
            storage.replaceRules([{ id: 'z', name: 'Z' }])
        ]);

        await expect(pending).resolves.toBeDefined();
        expect(mock.raw.spliceTapRules.map((r) => r.id)).toEqual(['z']);
    });

    test('a failed mutation does not wedge later mutations', async () => {
        const { mock, storage } = setup();

        mock.fail.set = 'boom';
        const failed = await storage.saveRule({ id: 'r1', name: 'A' });
        expect(failed.success).toBe(false);

        mock.fail.set = null;
        const ok = await storage.saveRule({ id: 'r2', name: 'B' });
        expect(ok.success).toBe(true);
    });
});

describe('saveRule contract (QA-1)', () => {
    test('resolves { success: true, rule } on success', async () => {
        const { storage } = setup();
        const result = await storage.saveRule({ id: 'r1', name: 'A' });

        expect(result.success).toBe(true);
        expect(result.rule).toEqual({ id: 'r1', name: 'A' });
    });

    test('resolves { success: false, error } when the write fails', async () => {
        // QA-1 was exactly this: the old contract returned a bare rule on
        // success and an object on failure, so background.js could hold an
        // error object in `savedRule` and still answer success:true.
        const { mock, storage } = setup();
        mock.fail.set = 'disk on fire';

        const result = await storage.saveRule({ id: 'r1', name: 'A' });

        expect(result.success).toBe(false);
        expect(result.error).toBe('disk on fire');
        expect(result.rule).toBeUndefined();
    });

    test('translates a quota failure into an actionable message', async () => {
        const { mock, storage } = setup();
        mock.fail.set = 'QUOTA_BYTES quota exceeded';

        const result = await storage.saveRule({ id: 'r1', name: 'A' });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/quota exceeded/i);
        expect(result.error).toMatch(/delete some rules/i);
    });

    test('upserts by id rather than appending a duplicate', async () => {
        const { mock, storage } = setup();

        await storage.saveRule({ id: 'r1', name: 'First' });
        await storage.saveRule({ id: 'r1', name: 'Second' });

        expect(mock.raw.spliceTapRules).toHaveLength(1);
        expect(mock.raw.spliceTapRules[0].name).toBe('Second');
    });

    test('stamps created and lastModified on a new rule', async () => {
        const { mock, storage } = setup();
        await storage.saveRule({ id: 'r1', name: 'A' });

        const stored = mock.raw.spliceTapRules[0];
        expect(stored.created).toEqual(expect.any(String));
        expect(stored.lastModified).toEqual(expect.any(String));
    });

    test('preserves created across an update that omits it', async () => {
        // An editor rebuilds a rule from form inputs and has no reason to
        // carry `created`; spreading the incoming rule alone dropped it.
        const { mock, storage } = setup();

        await storage.saveRule({ id: 'r1', name: 'A' });
        const created = mock.raw.spliceTapRules[0].created;

        await storage.saveRule({ id: 'r1', name: 'A renamed' });

        expect(mock.raw.spliceTapRules[0].created).toBe(created);
        expect(mock.raw.spliceTapRules[0].name).toBe('A renamed');
    });
});

describe('normalizeRule (schema v2 migration)', () => {
    test('defaults a legacy rule with no type to mock', () => {
        const { storage } = setup();
        expect(storage.normalizeRule({ id: 'r1' }).type).toBe('mock');
    });

    test('defaults a mock response with no mode to static', () => {
        const { storage } = setup();
        const out = storage.normalizeRule({ id: 'r1', response: { statusCode: 200 } });
        expect(out.response.mode).toBe('static');
    });

    test('leaves an explicit type and mode alone', () => {
        const { storage } = setup();
        const out = storage.normalizeRule({ id: 'r1', type: 'headers', response: { mode: 'patch' } });
        expect(out.type).toBe('headers');
        expect(out.response.mode).toBe('patch');
    });

    test('does not add a response block to a rule that has none', () => {
        const { storage } = setup();
        expect(storage.normalizeRule({ id: 'r1', type: 'headers' }).response).toBeUndefined();
    });

    test('is non-destructive', () => {
        const { storage } = setup();
        const input = { id: 'r1', response: { statusCode: 200 } };
        storage.normalizeRule(input);
        expect(input.type).toBeUndefined();
        expect(input.response.mode).toBeUndefined();
    });

    test('passes non-objects straight through', () => {
        const { storage } = setup();
        expect(storage.normalizeRule(null)).toBeNull();
        expect(storage.normalizeRule('nope')).toBe('nope');
    });

    test('getRules normalizes every stored rule', async () => {
        const { storage } = setup({
            initial: { spliceTapRules: [{ id: 'a' }, { id: 'b', response: {} }] }
        });

        const rules = await storage.getRules();
        expect(rules.map((r) => r.type)).toEqual(['mock', 'mock']);
        expect(rules[1].response.mode).toBe('static');
    });
});

describe('deleteRule / toggleRule', () => {
    test('deleteRule removes the matching rule', async () => {
        const { mock, storage } = setup({
            initial: { spliceTapRules: [{ id: 'a' }, { id: 'b' }] }
        });

        await storage.deleteRule('a');
        expect(mock.raw.spliceTapRules.map((r) => r.id)).toEqual(['b']);
    });

    test('deleting an unknown id succeeds and changes nothing', async () => {
        const { mock, storage } = setup({ initial: { spliceTapRules: [{ id: 'a' }] } });

        const result = await storage.deleteRule('missing');
        expect(result.success).toBe(true);
        expect(mock.raw.spliceTapRules).toHaveLength(1);
    });

    test('toggleRule reports a missing rule instead of silently succeeding', async () => {
        const { storage } = setup({ initial: { spliceTapRules: [] } });

        const result = await storage.toggleRule('missing', true);
        expect(result.success).toBe(false);
        expect(result.error).toBe('Rule not found');
    });

    test('toggleRule sets enabled and touches lastModified', async () => {
        const { mock, storage } = setup({
            initial: { spliceTapRules: [{ id: 'a', enabled: false, lastModified: 'old' }] }
        });

        await storage.toggleRule('a', true);
        const stored = mock.raw.spliceTapRules[0];
        expect(stored.enabled).toBe(true);
        expect(stored.lastModified).not.toBe('old');
    });
});

describe('quota check throttling (PERF-9)', () => {
    test('scans storage on the first save but not on an immediate second', async () => {
        const { mock, storage } = setup();

        await storage.saveRules([]);
        expect(mock.calls.getBytesInUse).toBe(1);

        await storage.saveRules([]);
        expect(mock.calls.getBytesInUse).toBe(1);
    });

    test('scans again once the throttle window has passed', async () => {
        const { mock, storage } = setup();
        const realNow = Date.now;

        try {
            await storage.saveRules([]);
            expect(mock.calls.getBytesInUse).toBe(1);

            Date.now = () => realNow() + 61000;
            await storage.saveRules([]);
            expect(mock.calls.getBytesInUse).toBe(2);
        } finally {
            Date.now = realNow;
        }
    });

    test('a quota-check failure does not fail the save', async () => {
        // checkQuota is advisory; the real QUOTA_BYTES failure surfaces from
        // the write itself, so a failed pre-check must not block persistence.
        const { mock, storage } = setup();
        mock.fail.getBytesInUse = 'unavailable';

        const result = await storage.saveRules([{ id: 'a' }]);
        expect(result.success).toBe(true);
    });

    test('reports a warning above the threshold', async () => {
        const { mock, storage } = setup({ quotaBytes: 1000 });
        mock.setBytesInUse(900);

        const quota = await storage.checkQuota();
        expect(quota.warning).toBe(true);
        expect(Math.round(quota.percentUsed)).toBe(90);
    });

    test('reports no warning below the threshold', async () => {
        const { mock, storage } = setup({ quotaBytes: 1000 });
        mock.setBytesInUse(100);

        expect((await storage.checkQuota()).warning).toBe(false);
    });
});

describe('allocateDnrId', () => {
    test('starts at 1 and increments', async () => {
        const { storage } = setup();
        expect(await storage.allocateDnrId()).toBe(1);
        expect(await storage.allocateDnrId()).toBe(2);
    });

    test('continues from the persisted counter rather than reusing ids', async () => {
        // Reuse would hand a new rule a DNR id another rule already owns,
        // which is the PROD-1 failure mode (updateDynamicRules rejects the
        // whole batch, so every DNR-backed rule stops applying).
        const { storage } = setup({ initial: { spliceTapDnrCounter: 41 } });
        expect(await storage.allocateDnrId()).toBe(42);
    });
});

describe('read paths degrade safely', () => {
    test('getRules returns an empty array when storage throws', async () => {
        const { mock, storage } = setup();
        mock.fail.get = 'unavailable';
        expect(await storage.getRules()).toEqual([]);
    });

    test('getSettings merges stored settings over the defaults', async () => {
        const { storage } = setup({ initial: { spliceTapSettings: { theme: 'dark' } } });
        const settings = await storage.getSettings();

        expect(settings.theme).toBe('dark');
        expect(settings.shortcuts).toBeDefined();
        expect(settings.chaosMode).toBeDefined();
    });

    test('getSettings falls back to defaults when storage throws', async () => {
        const { mock, storage } = setup();
        mock.fail.get = 'unavailable';
        expect((await storage.getSettings()).theme).toBe('auto');
    });

    test('getStats merges stored stats over the defaults', async () => {
        const { storage } = setup({ initial: { spliceTapStats: { intercepted: 7 } } });
        const stats = await storage.getStats();

        expect(stats.intercepted).toBe(7);
        expect(stats.rulesCount).toBe(0);
    });

    test('getActiveState defaults to active when storage throws', async () => {
        const { mock, storage } = setup();
        mock.fail.get = 'unavailable';
        expect(await storage.getActiveState()).toBe(true);
    });
});

describe('setStatsDirect (P-14)', () => {
    test('writes without first reading storage', async () => {
        const { mock, storage } = setup();
        const before = mock.calls.get;

        await storage.setStatsDirect({ intercepted: 5, rulesCount: 2 });

        expect(mock.calls.get).toBe(before);
        expect(mock.raw.spliceTapStats.intercepted).toBe(5);
        expect(mock.raw.spliceTapStats.lastUpdated).toEqual(expect.any(String));
    });
});

describe('formatBytes', () => {
    test('formats across units', () => {
        const { storage } = setup();
        expect(storage.formatBytes(0)).toBe('0 Bytes');
        expect(storage.formatBytes(512)).toBe('512 Bytes');
        expect(storage.formatBytes(1024)).toBe('1 KB');
        expect(storage.formatBytes(1536)).toBe('1.5 KB');
        expect(storage.formatBytes(1048576)).toBe('1 MB');
    });
});

describe('clearAll', () => {
    test('empties storage', async () => {
        const { mock, storage } = setup({ initial: { spliceTapRules: [{ id: 'a' }] } });

        const result = await storage.clearAll();
        expect(result.success).toBe(true);
        expect(Object.keys(mock.raw)).toHaveLength(0);
    });
});
