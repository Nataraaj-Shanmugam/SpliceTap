
// src/utils.js (and src/storage.js) are ESM modules and cannot be loaded via
// require() under plain CommonJS Jest — that was the original break (see
// TODO.md §0 / G1.5). The three shared UMD modules (src/placeholders.js,
// src/matcher.js, src/patch.js) are dual-loadable, so require them directly
// and re-export their APIs for tests.
const TurboMockPlaceholders = require('./placeholders');
const TurboMockMatcher = require('./matcher');
const TurboMockPatch = require('./patch');

module.exports = {
    TurboMockPlaceholders,
    TurboMockMatcher,
    TurboMockPatch
};
