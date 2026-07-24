
const { TurboMockMatcher } = require('../src/index');

// NOTE (G1.5): src/utils.js (TurboMockUtils) is an ESM module and cannot be
// require()'d under plain CommonJS Jest — that is the exact breakage this
// group fixes. TurboMockUtils.validateUrlPattern is utils-only validation
// logic that was never moved to one of the UMD modules (src/placeholders.js,
// src/matcher.js, src/patch.js), so it has no CommonJS-loadable target to
// test against here; those tests are intentionally removed. matchUrl DID
// move to TurboMockMatcher (src/matcher.js), so those tests now target it
// directly (see also the fuller matchUrl coverage in tests/matcher.test.js).

describe('TurboMockMatcher.matchUrl (formerly TurboMockUtils.matchUrl)', () => {
    test('should match wildcard pattern', () => {
        const pattern = '*/api/users/*';
        const url = 'https://example.com/api/users/123';
        expect(TurboMockMatcher.matchUrl(url, pattern)).toBe(true);
    });

    test('should not match incorrect pattern', () => {
        const pattern = '*/api/users/*';
        const url = 'https://example.com/api/products/123';
        expect(TurboMockMatcher.matchUrl(url, pattern)).toBe(false);
    });
});
