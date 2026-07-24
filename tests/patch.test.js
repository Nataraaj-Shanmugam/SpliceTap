
const { TurboMockPatch } = require('../src/index');
const { jsonMergePatch } = TurboMockPatch;

describe('TurboMockPatch.jsonMergePatch (RFC 7386)', () => {
    test('nested objects merge recursively', () => {
        const original = { a: { b: 1, c: 2 }, d: 3 };
        const patch = { a: { b: 99 } };
        expect(jsonMergePatch(original, patch)).toEqual({ a: { b: 99, c: 2 }, d: 3 });
    });

    test('null deletes a top-level key', () => {
        const original = { a: 1, b: 2 };
        const patch = { a: null };
        expect(jsonMergePatch(original, patch)).toEqual({ b: 2 });
    });

    test('null deletes a nested key', () => {
        const original = { a: { b: 1, c: 2 } };
        const patch = { a: { b: null } };
        expect(jsonMergePatch(original, patch)).toEqual({ a: { c: 2 } });
    });

    test('arrays replace entirely, not merged element-wise', () => {
        const original = { list: [1, 2, 3] };
        const patch = { list: [4, 5] };
        expect(jsonMergePatch(original, patch)).toEqual({ list: [4, 5] });
    });

    test('scalars replace', () => {
        const original = { count: 1, label: 'old' };
        const patch = { count: 2 };
        expect(jsonMergePatch(original, patch)).toEqual({ count: 2, label: 'old' });
    });

    test('patching into a missing branch creates it', () => {
        const original = { a: 1 };
        const patch = { b: { c: 2 } };
        expect(jsonMergePatch(original, patch)).toEqual({ a: 1, b: { c: 2 } });
    });

    test('a non-object patch (or array) replaces the whole target', () => {
        expect(jsonMergePatch({ a: 1 }, 'replaced')).toBe('replaced');
        expect(jsonMergePatch({ a: 1 }, [1, 2, 3])).toEqual([1, 2, 3]);
        expect(jsonMergePatch({ a: 1 }, null)).toBeNull();
        expect(jsonMergePatch({ a: 1 }, 42)).toBe(42);
    });

    test('missing/undefined original is treated as an empty object', () => {
        expect(jsonMergePatch(undefined, { a: 1 })).toEqual({ a: 1 });
        expect(jsonMergePatch(null, { a: 1 })).toEqual({ a: 1 });
    });

    test('does not mutate the original object', () => {
        const original = { a: { b: 1 } };
        const patch = { a: { b: 2 } };
        jsonMergePatch(original, patch);
        expect(original).toEqual({ a: { b: 1 } });
    });
});
