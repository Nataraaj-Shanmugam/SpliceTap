/**
 * Documented limitations, pinned as tests (see PARITY.md).
 *
 * These assert what SpliceTap does NOT do today, where Requestly does. They
 * exist so the comparison stays honest: if a limitation is ever lifted, the
 * test fails and PARITY.md has to be updated with it, rather than drifting.
 */

const { launch, waitFor } = require('./harness');

describe('documented limitations vs Requestly', () => {
    let h;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });

    // Lifted on 15 October 2026, so no longer pinned here: block/redirect now
    // reach scripts, images and pages (appliesTo 'all', tests/e2e/feat-network),
    // and request bodies can be modified (tests/e2e/feat-interceptor).
    // B2-F8: patch mode can now change the status code of a real response
    // (response.patchStatus, tests/e2e/b2-interceptor).

    test('ran without errors', async () => {
        await waitFor(async () => true, { label: 'noop' });
        expect(h.allErrors).toEqual([]);
    });
});
