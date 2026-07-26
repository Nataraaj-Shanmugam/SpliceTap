
// src/utils.js (and src/storage.js) are ESM modules and cannot be loaded via
// require() under plain CommonJS Jest — that was the original break (see
// the shared-module design). The three shared UMD modules (src/placeholders.js,
// src/matcher.js, src/patch.js) are dual-loadable, so require them directly
// and re-export their APIs for tests.
const SpliceTapPlaceholders = require('./placeholders');
const SpliceTapMatcher = require('./matcher');
const SpliceTapPatch = require('./patch');

module.exports = {
    SpliceTapPlaceholders,
    SpliceTapMatcher,
    SpliceTapPatch
};
