/**
 * SpliceTap Patch
 * RFC 7386 JSON Merge Patch implementation (UMD).
 * Loads as: (a) a plain MAIN-world script, (b) a CommonJS module under Jest,
 * (c) via ESM side-effect import.
 */
(function (global) {
    'use strict';

    // PER-2 (Contract B): the patch is rule data and this runs in the page's
    // realm, so nothing here is looked up on a prototype at call time. This
    // file loads at document_start, before any page script, so what it
    // captures is the genuine built-in. The patch may be a null-prototype
    // object or array (the state sync copies rules that way), and the objects
    // a merge builds have no prototype either: the interceptor stringifies the
    // result, and JSON.stringify asks every object it visits for `toJSON`,
    // which on an ordinary object is a lookup a page getter on
    // Object.prototype would answer with the merged patch values.
    const uncurryThis = Function.prototype.bind.bind(Function.prototype.call);
    const isArray = Array.isArray;
    const objectKeys = Object.keys;
    const objectCreate = Object.create;
    const objectDefineProperty = Object.defineProperty;
    const hasOwnProperty = uncurryThis(Object.prototype.hasOwnProperty);

    const isPlainObject = (v) => v !== null && typeof v === 'object' && !isArray(v);
    const hasOwn = (object, key) => hasOwnProperty(object, key);

    // PER-41: `target[key] = value` with key "__proto__" does not create a key,
    // it swaps the object's prototype — so a JSON document with a "__proto__"
    // property lost it in the merge (Object.assign did the same when copying
    // the original). Define the property instead. This also keeps the merge
    // from ever writing through to Object.prototype.
    // The descriptor has no prototype: defineProperty reads `get`, `set` and the
    // rest from it through the prototype chain, so an ordinary object literal
    // would ask Object.prototype for `get` (a page getter there receives the
    // descriptor, patch value included, or makes the call throw).
    function setOwn(target, key, value) {
        objectDefineProperty(target, key, { __proto__: null, value, writable: true, enumerable: true, configurable: true });
    }

    function copyOwn(source) {
        const copy = objectCreate(null);
        const keys = objectKeys(source);
        for (let i = 0; i < keys.length; i++) setOwn(copy, keys[i], source[keys[i]]);
        return copy;
    }

    // The RFC 7386 algorithm, applied recursively.
    function merge(original, patch) {
        if (!isPlainObject(patch)) return patch;

        const target = isPlainObject(original) ? copyOwn(original) : objectCreate(null);
        const keys = objectKeys(patch);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
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
        if (objectKeys(patch).length === 0) return false;
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
     * The objects it builds have no prototype (see the top of the file); a
     * caller that stringifies the result sees no difference.
     */
    function jsonMergePatch(original, patch) {
        if (original !== undefined && original !== null && !isPatchApplicable(original, patch)) {
            return original;
        }
        return merge(original, patch);
    }

    // B2-F8: the reason phrase a patch-mode status override is served with,
    // from SpliceTap's table (src/templates.js getStatusText). That file is
    // not loaded in the page, so the table is repeated here; a unit test
    // (tests/b2-interceptor.test.js) keeps the two identical.
    const REASON_PHRASES = objectCreate(null);
    (function fill(entries) {
        const codes = objectKeys(entries);
        for (let i = 0; i < codes.length; i++) REASON_PHRASES[codes[i]] = entries[codes[i]];
    })({
        200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
        301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
        400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
        404: 'Not Found', 409: 'Conflict', 418: "I'm a Teapot",
        422: 'Unprocessable Entity', 429: 'Too Many Requests',
        500: 'Internal Server Error', 502: 'Bad Gateway',
        503: 'Service Unavailable', 504: 'Gateway Timeout'
    });

    /** B2-F8: the reason phrase for a status code, or '' for one the table lacks. */
    function reasonPhrase(code) {
        const key = typeof code === 'number' ? code : Number(code);
        return hasOwn(REASON_PHRASES, key) ? REASON_PHRASES[key] : '';
    }

    const api = { jsonMergePatch, isPatchApplicable, reasonPhrase };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapPatch = api;
})(typeof window !== 'undefined' ? window : globalThis);
