
// src/storage.js is an ES module and cannot be loaded via require() under
// plain CommonJS Jest (tests reach it through tests/helpers/load-esm.js). The
// shared UMD modules are dual-loadable, so require them directly and
// re-export their APIs for tests.
const SpliceTapPlaceholders = require('./placeholders');
const SpliceTapMatcher = require('./matcher');
const SpliceTapPatch = require('./patch');

module.exports = {
    SpliceTapPlaceholders,
    SpliceTapMatcher,
    SpliceTapPatch
};
