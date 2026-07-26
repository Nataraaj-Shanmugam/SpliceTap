/**
 * SpliceTap Patch
 * RFC 7386 JSON Merge Patch implementation (UMD).
 * Loads as: (a) a plain MAIN-world script, (b) a CommonJS module under Jest,
 * (c) via ESM side-effect import. See TODO.md §1.3.
 */
(function (global) {
    'use strict';

    /**
     * Apply an RFC 7386 JSON Merge Patch to `original`.
     * - If patch is not an object, or is an array -> return patch (replaces).
     * - Otherwise copy original (or {} if original isn't a mergeable object),
     *   then for each key in patch: null deletes the key, an object recurses,
     *   anything else replaces the value.
     */
    function jsonMergePatch(original, patch) {
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            return patch;
        }

        const target = (original && typeof original === 'object' && !Array.isArray(original))
            ? Object.assign({}, original)
            : {};

        Object.keys(patch).forEach((key) => {
            const value = patch[key];
            if (value === null) {
                delete target[key];
            } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                target[key] = jsonMergePatch(target[key], value);
            } else {
                target[key] = value;
            }
        });

        return target;
    }

    const api = { jsonMergePatch };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapPatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
