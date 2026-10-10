/**
 * SpliceTap Patch
 * RFC 7386 JSON Merge Patch implementation (UMD).
 * Loads as: (a) a plain MAIN-world script, (b) a CommonJS module under Jest,
 * (c) via ESM side-effect import.
 */
(function (global) {
    'use strict';

    const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

    // PER-41: `target[key] = value` with key "__proto__" does not create a key,
    // it swaps the object's prototype — so a JSON document with a "__proto__"
    // property lost it in the merge (Object.assign did the same when copying
    // the original). Define the property instead. This also keeps the merge
    // from ever writing through to Object.prototype.
    function setOwn(target, key, value) {
        Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    }

    function copyOwn(source) {
        const copy = {};
        for (const key of Object.keys(source)) setOwn(copy, key, source[key]);
        return copy;
    }

    // The RFC 7386 algorithm, applied recursively.
    function merge(original, patch) {
        if (!isPlainObject(patch)) return patch;

        const target = isPlainObject(original) ? copyOwn(original) : {};
        for (const key of Object.keys(patch)) {
            const value = patch[key];
            if (value === null) {
                delete target[key];
            } else if (isPlainObject(value)) {
                // hasOwn: target["__proto__"] would otherwise read the prototype.
                setOwn(target, key, merge(hasOwn(target, key) ? target[key] : undefined, value));
            } else {
                setOwn(target, key, value);
            }
        }
        return target;
    }

    /**
     * PER-19 / PER-41: will jsonMergePatch actually change `target` with this
     * patch? False for an empty object patch (nothing to apply) and for an
     * object patch aimed at an array or a scalar (a merge needs an object to
     * merge into). True for anything else, including a non-object patch, which
     * replaces the target outright. The interceptor asks this to log a skip.
     */
    function isPatchApplicable(target, patch) {
        if (!isPlainObject(patch)) return true;
        if (Object.keys(patch).length === 0) return false;
        return target === undefined || target === null || isPlainObject(target);
    }

    /**
     * Apply an RFC 7386 JSON Merge Patch to `original`.
     * - If patch is not an object, or is an array -> return patch (replaces).
     * - PER-19: an empty object patch, or an object patch on an array or
     *   scalar `original`, returns `original` unchanged. RFC 7386 would
     *   replace the array with the merged `{}`, so patching an array-root
     *   response with `{}` served `{}` instead of the real data.
     * - Otherwise copy original (or {} if original is null/undefined), then
     *   for each key in patch: null deletes the key, an object recurses,
     *   anything else replaces the value. Nested levels follow the RFC:
     *   a non-object value is replaced by the merged object.
     */
    function jsonMergePatch(original, patch) {
        if (original !== undefined && original !== null && !isPatchApplicable(original, patch)) {
            return original;
        }
        return merge(original, patch);
    }

    const api = { jsonMergePatch, isPatchApplicable };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapPatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
