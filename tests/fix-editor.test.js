/**
 * Editor fix group (E1): the pure parts of src/rule-editor.js.
 *
 * What needs a browser (focus, aria state, the toast) is in
 * tests/e2e/fix-editor.e2e.test.js; these cover the logic that does not.
 */

const { fieldForError, parseWholeNumber, readBody } = require('../src/rule-editor');
const { validateRule } = require('../src/rule-schema');

describe('PER-26 readBody', () => {
    test('an empty or whitespace-only body stays empty, not {}', () => {
        expect(readBody('')).toBe('');
        expect(readBody('   \n  ')).toBe('');
    });

    test('a JSON object or array is stored parsed; anything else is the exact text typed', () => {
        expect(readBody('{"a": 1}')).toEqual({ a: 1 });
        expect(readBody('[1, 2]')).toEqual([1, 2]);
        expect(readBody('"hello"')).toBe('"hello"');
        expect(readBody('42')).toBe('42');
        expect(readBody('null')).toBe('null');
        expect(readBody(' plain text ')).toBe(' plain text ');
    });
});

describe('PER-50 parseWholeNumber', () => {
    test.each([
        ['2e3', 2000],
        ['1E2', 100],
        ['  750 ', 750],
        ['0', 0],
        ['-5', -5]
    ])('%j reads as %d', (text, value) => {
        expect(parseWholeNumber(text)).toEqual({ value });
    });

    test.each(['1.5', '2e-1', 'abc', '1e400', '0x', '12px', 'NaN', 'Infinity'])('%j is refused, not truncated', (text) => {
        const parsed = parseWholeNumber(text);
        expect(parsed.invalid).toBe(true);
        expect(parsed.value).toBeNaN();
    });

    test('a blank field is reported as empty, which is not the same as invalid', () => {
        expect(parseWholeNumber('')).toEqual({ value: NaN, empty: true });
        expect(parseWholeNumber('   ')).toEqual({ value: NaN, empty: true });
        expect(parseWholeNumber(undefined).empty).toBe(true);
    });
});

describe('PER-77 fieldForError', () => {
    const mock = (over = {}) => ({
        name: 'x', type: 'mock', match: { url: '*/a*', method: '*' },
        response: { statusCode: 200, headers: {}, body: '', delay: 0, mode: 'static' }, ...over
    });

    // Every message the shared schema can currently produce for a form field
    // maps to that field, so a schema change that renames a message shows up
    // here rather than as an unmarked field in the editor.
    const deep = (n) => { let v = {}; for (let i = 0; i < n; i++) v = { a: v }; return v; };
    const cases = [
        [mock({ name: '' }), 'tmName'],
        [mock({ name: 'x'.repeat(101) }), 'tmName'],
        [mock({ match: { url: '', method: '*' } }), 'tmUrl'],
        [mock({ match: { url: '/', method: '*' } }), 'tmUrl'],
        [mock({ match: { url: '*/a*', method: 'FETCH' } }), 'tmMethod'],
        // PER-23 made GET valid for GraphQL (persisted queries), so PUT is the refused method.
        [mock({ match: { url: '*/a*', method: 'PUT', graphql: { operationName: 'op' } } }), 'tmMethod'],
        [mock({ match: { url: '*/a*', method: '*', graphql: { operationName: '' } } }), 'tmGraphql'],
        [mock({ match: { url: '*/a*', method: '*', headers: { 'bad name': 'v' } } }), 'tmMatchHeaders'],
        [mock({ response: { statusCode: 99, headers: {}, body: '', delay: 0, mode: 'static' } }), 'tmStatus'],
        [mock({ response: { statusCode: 150, headers: {}, body: '', delay: 0, mode: 'static' } }), 'tmStatus'],
        [mock({ response: { statusCode: 200, headers: { 'X-Note': 'café ☕' }, body: '', delay: 0, mode: 'static' } }), 'tmResHeaders'],
        [mock({ response: { statusCode: 200, headers: {}, body: deep(70), delay: 0, mode: 'static' } }), 'tmBody'],
        [mock({ match: { url: '/api\\/x/i', method: '*' } }), 'tmUrl'],
        [mock({ response: { statusCode: 200, headers: { 'bad name': 'v' }, body: '', delay: 0, mode: 'static' } }), 'tmResHeaders'],
        [mock({ response: { statusCode: 200, headers: {}, body: '', delay: 99999, mode: 'static' } }), 'tmDelay'],
        [mock({ response: { statusCode: 200, headers: {}, delay: 0, mode: 'patch', patch: [1] } }), 'tmPatch'],
        [{ name: 'd', type: 'delay', match: { url: '*/a*', method: '*' }, delayMs: 0 }, 'tmDelayMs'],
        [{ name: 'r', type: 'redirect', match: { url: '*/a*', method: '*' }, redirect: { destination: '' } }, 'tmRedirect'],
        [{ name: 'r', type: 'redirect', match: { url: '*/a*', method: '*' }, redirect: { destination: 'ftp://x' } }, 'tmRedirect'],
        // PER-22: $n needs a /regex/ pattern, so the pattern is the field at fault.
        [{ name: 'r', type: 'redirect', match: { url: '*/a/*', method: '*' }, redirect: { destination: 'http://localhost:3000/$1' } }, 'tmUrl'],
        [{ name: 'h', type: 'headers', match: { url: '*/a*', method: '*' }, headersMod: { request: [{ op: 'set', name: 'X-A', value: '1' }, { op: 'set', name: 'x-a', value: '2' }], response: [] } }, 'tmHdrReq'],
        [{ name: 'h', type: 'headers', match: { url: '*/a*', method: '*' }, headersMod: { request: [{ op: 'set', name: 'X-A' }], response: [] } }, 'tmHdrReq'],
        [{ name: 'h', type: 'headers', match: { url: '*/a*', method: '*' }, headersMod: { request: [], response: [{ op: 'set', name: 'X-A' }] } }, 'tmHdrRes'],
        [{ name: 'h', type: 'headers', match: { url: '*/a*', method: '*' }, headersMod: { request: [], response: [] } }, 'tmHdrReq'],
        [{ name: 'q', type: 'queryparams', match: { url: '*/a*', method: '*' }, queryParams: { add: [{ key: '', value: '1' }], remove: [] } }, 'tmQpAdd'],
        [{ name: 'q', type: 'queryparams', match: { url: '*/a*', method: '*' }, queryParams: { add: [], remove: [] } }, 'tmQpAdd']
    ];

    test.each(cases.map((c, i) => [i, ...c]))('schema error #%d is tied to %s', (i, rule, field) => {
        const verdict = validateRule(rule);
        expect(verdict.valid).toBe(false);
        const fields = verdict.errors.map((m) => fieldForError(m, rule));
        expect(fields).toContain(field);
    });

    test('a forbidden header is tied to the list that holds it', () => {
        const base = { name: 'h', type: 'headers', match: { url: '*/a*', method: '*' } };
        const inRequest = { ...base, headersMod: { request: [{ op: 'set', name: 'X-Frame-Options', value: 'x' }], response: [] } };
        const inResponse = { ...base, headersMod: { request: [], response: [{ op: 'set', name: 'X-Frame-Options', value: 'x' }] } };
        const message = validateRule(inRequest).errors.find((m) => /cannot be modified/.test(m));
        expect(message).toBeTruthy();
        expect(fieldForError(message, inRequest)).toBe('tmHdrReq');
        expect(fieldForError(message, inResponse)).toBe('tmHdrRes');
    });

    test('a message about no single field gets no field, only the summary', () => {
        expect(fieldForError('Rule data is required', {})).toBeNull();
        expect(fieldForError('Redirect rules cannot use header or GraphQL match conditions, because the redirect target must be chosen before request headers exist', { type: 'redirect' })).toBeNull();
        expect(fieldForError('', {})).toBeNull();
        expect(fieldForError(undefined)).toBeNull();
    });
});
