/** @jest-environment jsdom */
/**
 * Batch 2, group G5 (editor): the fields for F7 (page domains, resource types,
 * payload filter), F8 (status override), F9 (header append, remove all query
 * parameters) and PER-66 (call filter); the "Try a URL" box (F10 / PER-59); the
 * captured-response panel (PER-60); restorable drafts (PER-63).
 *
 * Mounted for real under jsdom (open shadow root), as tests/feat-editor.test.js
 * does. What needs a real Chrome (focus, axe, the closed overlay root, the
 * background) is in tests/e2e/b2-editor.e2e.test.js.
 */

require('../src/templates'); // statusText comes from it, as in the extension
const {
    create, fieldForError, parseDomains, resourceTypesApply, inPageFiltersApply, RESOURCE_TYPES
} = require('../src/rule-editor');

function mount({ rules = [], settings, handlers = {}, draftKey } = {}) {
    const sent = [];
    window.chrome = {
        runtime: {
            lastError: null,
            sendMessage: jest.fn(async (message) => {
                sent.push(message);
                if (handlers[message.type]) return handlers[message.type](message);
                if (message.type === 'getRules') return { success: true, rules, settings };
                if (message.type === 'saveRule') return { success: true, rule: message.rule };
                return { success: true };
            })
        },
        storage: { local: { get: (keys, cb) => cb({ tmOverlayHintSeen: true }), set: () => {} } }
    };
    window.Element.prototype.scrollIntoView = () => {};
    window.matchMedia = window.matchMedia || (() => ({ matches: true }));

    const mountPoint = document.createElement('div');
    document.body.appendChild(mountPoint);
    const editor = create({ shadowMode: 'open', mountPoint, draftKey });
    const root = () => mountPoint.firstChild.shadowRoot;
    const $ = (id) => root().getElementById(id);

    return {
        editor, sent, mountPoint, $, root,
        set(id, value) {
            const el = $(id);
            if (el.type === 'checkbox') el.checked = !!value;
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        isShown: (id) => $(id).classList.contains('tm-visible'),
        cleanup() {
            editor.close();
            mountPoint.remove();
        }
    };
}

let h;
afterEach(() => { if (h) h.cleanup(); h = null; });

const settle = () => new Promise((r) => setTimeout(r, 0));

// jsdom has no layout, so offsetParent is always null and the editor would think
// every field hidden. A field is visible here when nothing above it is switched
// off by [data-types] or an inline display:none, which is what the editor's own
// rules amount to.
beforeAll(() => {
    Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get() {
            for (let el = this; el && el.nodeType === 1; el = el.parentElement) {
                if (el.style && el.style.display === 'none') return null;
                if (el.hasAttribute('data-types') && !el.classList.contains('tm-visible')) return null;
            }
            return this.parentNode;
        }
    });
});

const mockRule = (over = {}) => ({
    id: 'm1', name: 'Mock', enabled: true, type: 'mock',
    match: { url: '*/api/*', method: '*' },
    response: { statusCode: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' }, body: { a: 1 }, delay: 0, mode: 'static' },
    hitCount: 2, created: '2026-01-01T00:00:00.000Z', ...over
});
const blockRule = (over = {}) => ({
    id: 'b1', name: 'Block', enabled: true, type: 'block',
    match: { url: '*/ads/*', method: '*' }, hitCount: 0, created: '2026-01-01T00:00:00.000Z', ...over
});

// ---- pure helpers -------------------------------------------------------------

describe('B2-F7 parseDomains', () => {
    test('splits on commas, spaces and new lines, lowercases, drops blanks and repeats', () => {
        expect(parseDomains('Example.com, app.example.com\nLOCALHOST  ,, example.com;api.test')).toEqual([
            'example.com', 'app.example.com', 'localhost', 'api.test'
        ]);
        expect(parseDomains('')).toEqual([]);
        expect(parseDomains('  \n , ')).toEqual([]);
        expect(parseDomains(undefined)).toEqual([]);
    });

    test('leaves everything else wrong with a hostname for the schema to name', () => {
        expect(parseDomains('https://Example.com/x')).toEqual(['https://example.com/x']);
    });
});

describe('B2-F7 / PER-66 where each field can apply', () => {
    test.each([
        ['headers', false, true], ['queryparams', false, true],
        ['block', true, true], ['redirect', true, true],
        ['block', false, false], ['redirect', false, false],
        ['mock', false, false], ['mock', true, false], ['delay', false, false], ['requestBody', false, false]
    ])('resource types on %s (all requests: %s) -> %s', (type, all, expected) => {
        expect(resourceTypesApply(type, all)).toBe(expected);
    });

    test.each([
        ['mock', false, true], ['delay', false, true], ['requestBody', false, true],
        ['block', false, true], ['redirect', false, true],
        ['block', true, false], ['redirect', true, false],
        ['headers', false, false], ['queryparams', false, false]
    ])('payload / call filter on %s (all requests: %s) -> %s', (type, all, expected) => {
        expect(inPageFiltersApply(type, all)).toBe(expected);
    });

    test('the resource-type list is the schema\'s eleven', () => {
        expect(RESOURCE_TYPES.map(([v]) => v)).toEqual([
            'fetch-xhr', 'document', 'subdocument', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket', 'ping', 'other'
        ]);
    });
});

// ---- fieldForError ------------------------------------------------------------

describe('B2 fieldForError: the messages that open with a field name', () => {
    test.each([
        ['Page domains must be a list of 1 to 20 hostnames, like ["example.com", "localhost"]', 'tmPageDomains'],
        ['Page domains: "Example.com" must be lowercase', 'tmPageDomains'],
        ['Page domains: "example.com" is listed twice', 'tmPageDomains'],
        ['Resource types must be a non-empty list of: fetch-xhr, document', 'tmResourceTypes'],
        ['Resource types: "gif" is not a known type', 'tmResourceTypes'],
        ['Resource types need "all requests" on a block rule', 'tmResourceTypes'],
        ['Payload filter path is required: a dot path of 1 to 200 characters', 'tmPayloadPath'],
        ['Payload filter path cannot have empty parts', 'tmPayloadPath'],
        ['Payload filter operator must be "equals" or "contains"', 'tmPayloadOp'],
        ['Payload filter value must be text of up to 1000 characters', 'tmPayloadValue'],
        ['Payload filter value is too long (max 1000 characters)', 'tmPayloadValue'],
        ['Payload filter must be an object like {"path": "user.id"}', 'tmPayloadPath'],
        ['Payload filter is not available on rules that apply to all requests', 'tmPayloadPath'],
        ['Patch status must be a whole number from 200 to 599', 'tmPatchStatus'],
        ['Patch status code can only be set in patch mode', 'tmPatchStatus'],
        ['Call filter mode must be "first", "after" or "every"', 'tmCallMode'],
        ['Call filter n must be a whole number from 1 to 1000', 'tmCallN'],
        ['Call filter must be an object like {"mode": "first", "n": 3}', 'tmCallMode'],
        ['Call filter only works on rules handled in the page', 'tmCallMode'],
        ['Query parameters: removeAll must be true or false', 'tmQpRemoveAll'],
        ['Query parameters: removeAll cannot be combined with a list to remove', 'tmQpRemoveAll'],
        ['Query parameters need at least one parameter to add or remove', 'tmQpAdd'],
        ['Response header #2 has an unknown op "prepend": use set, append or remove', 'tmHdrRes'],
        ['Request header #1 cannot append: only response headers can', 'tmHdrReq']
    ])('%s -> %s', (message, field) => {
        expect(fieldForError(message, { type: 'mock' })).toBe(field);
    });

    test('a patch status message is not mistaken for the mock\'s own Status Code field', () => {
        expect(fieldForError('Patch status code must be 200-599', { type: 'mock' })).toBe('tmPatchStatus');
        expect(fieldForError('Status code must be 200-599', { type: 'mock' })).toBe('tmStatus');
    });
});

// ---- the fields: shown only where valid ---------------------------------------

describe('B2-F7 the fields exist, labelled, and show only where they are valid', () => {
    test('each new control has a label and a hint linked by aria-describedby', async () => {
        h = mount();
        h.editor.open({});
        await settle();
        const label = (id) => h.root().querySelector(`label[for="${id}"]`);
        expect(label('tmPageDomains').textContent).toBe('Only on these sites (optional)');
        expect(label('tmPayloadPath')).toBeTruthy();
        expect(label('tmPayloadOp')).toBeTruthy();
        expect(label('tmPayloadValue')).toBeTruthy();
        expect(label('tmPatchStatus').textContent).toBe('Status override (optional)');
        expect(label('tmCallMode')).toBeTruthy();
        expect(label('tmCallN')).toBeTruthy();
        expect(h.$('tmQpRemoveAll').closest('label').textContent.trim()).toBe('Remove all query parameters');
        expect(h.$('tmResourceTypes').getAttribute('role')).toBe('group');
        expect(h.$('tmResourceTypesLabel').textContent).toMatch(/resource types/i);
        for (const [id, hint] of [
            ['tmPageDomains', 'tmPageDomainsHint'], ['tmPatchStatus', 'tmPatchStatusHint'],
            ['tmQpRemoveAll', 'tmQpRemoveAllHint'], ['tmHdrReq', 'tmHdrReqHint'], ['tmHdrRes', 'tmHdrResHint'],
            ['tmCallMode', 'tmCallHint'], ['tmPayloadPath', 'tmPayloadHint']
        ]) {
            expect(h.$(id).getAttribute('aria-describedby')).toContain(hint);
            expect(h.$(hint)).toBeTruthy();
        }
        // every resource type has a labelled checkbox
        for (const [value, text] of RESOURCE_TYPES) {
            const box = h.$('tmRt_' + value);
            expect(box.type).toBe('checkbox');
            expect(box.closest('label').textContent.trim()).toBe(text);
        }
    });

    test('input limits come from the shared limits (with a fallback when common.js lacks them)', () => {
        h = mount();
        h.editor.open({});
        expect(h.$('tmPayloadPath').getAttribute('maxlength')).toBe('200');
        expect(h.$('tmPayloadValue').getAttribute('maxlength')).toBe('1000');
        expect(h.$('tmCallN').getAttribute('min')).toBe('1');
        expect(h.$('tmCallN').getAttribute('max')).toBe('1000');
        expect(h.$('tmPageDomainsHint').textContent).toContain('up to 20');
    });

    test('page domains are offered on every rule type', () => {
        h = mount();
        h.editor.open({});
        for (const type of ['mock', 'block', 'delay', 'redirect', 'headers', 'queryparams', 'requestBody']) {
            h.set('tmType', type);
            expect(h.$('tmPageDomains').offsetParent).not.toBeNull();
        }
    });

    test.each([
        // type, "all requests" ticked, resource types shown, payload+call filter shown
        ['mock', false, false, true],
        ['delay', false, false, true],
        ['requestBody', false, false, true],
        ['block', true, true, false],
        ['block', false, false, true],
        ['redirect', true, true, false],
        ['redirect', false, false, true],
        ['headers', false, true, false],
        ['queryparams', false, true, false]
    ])('%s (all requests: %s): resource types %s, payload/call filters %s', (type, all, types, filters) => {
        h = mount();
        h.editor.open({});
        h.set('tmType', type);
        if (type === 'block' || type === 'redirect') h.set('tmAppliesAll', all);
        expect(h.isShown('tmResourceTypes')).toBe(types);
        expect(h.isShown('tmPayloadField')).toBe(filters);
        expect(h.isShown('tmCallField')).toBe(filters);
    });

    test('ticking and unticking "all requests" swaps the two sets live', () => {
        h = mount();
        h.editor.open({});
        h.set('tmType', 'block'); // a new block rule starts ticked
        expect(h.isShown('tmResourceTypes')).toBe(true);
        expect(h.isShown('tmPayloadField')).toBe(false);
        h.set('tmAppliesAll', false);
        expect(h.isShown('tmResourceTypes')).toBe(false);
        expect(h.isShown('tmPayloadField')).toBe(true);
    });

    test('the status override shows in patch mode only', () => {
        h = mount();
        h.editor.open({});
        expect(h.isShown('tmPatchStatusField')).toBe(false); // static
        h.set('tmMode', 'patch');
        expect(h.isShown('tmPatchStatusField')).toBe(true);
        h.set('tmMode', 'code');
        expect(h.isShown('tmPatchStatusField')).toBe(false);
        h.set('tmMode', 'patch');
        h.set('tmType', 'delay');
        expect(h.isShown('tmPatchStatusField')).toBe(false);
    });

    test('the call filter\'s number shows once a mode is chosen', () => {
        h = mount();
        h.editor.open({});
        expect(h.$('tmCallNField').style.display).toBe('none');
        h.set('tmCallMode', 'every');
        expect(h.$('tmCallNField').style.display).toBe('');
        h.set('tmCallMode', '');
        expect(h.$('tmCallNField').style.display).toBe('none');
    });

    test('remove-all is on query rules only; the header hints say which side append is for', () => {
        h = mount();
        h.editor.open({});
        h.set('tmType', 'queryparams');
        expect(h.$('tmQpRemoveAll').offsetParent).not.toBeNull();
        h.set('tmType', 'headers');
        expect(h.$('tmQpRemoveAll').offsetParent).toBeNull();
        expect(h.$('tmHdrResHint').textContent).toMatch(/append/);
        expect(h.$('tmHdrReqHint').textContent).toMatch(/response headers only/);
    });
});

// ---- collect / fill -----------------------------------------------------------

describe('B2 collect and fill (populate)', () => {
    function fillBasics(type) {
        h.set('tmType', type);
        h.set('tmName', 'Rule');
        h.set('tmUrl', '*/api/*');
    }

    test('page domains: collected as a lowercase list, on any rule type, and filled back', () => {
        h = mount();
        h.editor.open({});
        fillBasics('delay');
        h.set('tmPageDomains', 'Example.com, app.example.com\nlocalhost');
        expect(h.editor.collect().rule.match.pageDomains).toEqual(['example.com', 'app.example.com', 'localhost']);

        h.set('tmPageDomains', '');
        expect(h.editor.collect().rule.match).not.toHaveProperty('pageDomains');

        h.editor.close();
        h.editor.open({ rule: mockRule({ match: { url: '*/a*', method: '*', pageDomains: ['a.test', 'b.test'] } }) });
        expect(h.$('tmPageDomains').value).toBe('a.test\nb.test');
        expect(h.editor.collect().rule.match.pageDomains).toEqual(['a.test', 'b.test']);
    });

    test('resource types: the ticked ones in list order; none ticked means the key is absent', () => {
        h = mount();
        h.editor.open({});
        fillBasics('headers');
        expect(h.editor.collect().rule.match).not.toHaveProperty('resourceTypes');
        h.set('tmRt_image', true);
        h.set('tmRt_fetch-xhr', true);
        expect(h.editor.collect().rule.match.resourceTypes).toEqual(['fetch-xhr', 'image']);
        h.set('tmRt_image', false);
        h.set('tmRt_fetch-xhr', false);
        expect(h.editor.collect().rule.match).not.toHaveProperty('resourceTypes');
    });

    test('resource types: filled from a stored all-requests block rule, and kept on save', () => {
        h = mount();
        h.editor.open({ rule: blockRule({ appliesTo: 'all', match: { url: '*/x*', method: '*', resourceTypes: ['script', 'font'] } }) });
        expect(h.$('tmRt_script').checked).toBe(true);
        expect(h.$('tmRt_font').checked).toBe(true);
        expect(h.$('tmRt_image').checked).toBe(false);
        expect(h.isShown('tmResourceTypes')).toBe(true);
        expect(h.editor.collect().rule.match.resourceTypes).toEqual(['script', 'font']);
    });

    test('resource types are dropped when the rule stops being all-requests, or changes to a type without them', () => {
        h = mount();
        h.editor.open({ rule: blockRule({ appliesTo: 'all', match: { url: '*/x*', method: '*', resourceTypes: ['script'] } }) });
        h.set('tmAppliesAll', false);
        const page = h.editor.collect().rule;
        expect(page.appliesTo).toBe('page');
        expect(page.match).not.toHaveProperty('resourceTypes');

        h.set('tmAppliesAll', true);
        h.set('tmType', 'mock');
        expect(h.editor.collect().rule.match).not.toHaveProperty('resourceTypes');

        h.set('tmType', 'queryparams');
        expect(h.editor.collect().rule.match.resourceTypes).toEqual(['script']);
    });

    test('resource types survive on headers and query rules', () => {
        h = mount();
        h.editor.open({ rule: {
            id: 'h1', name: 'Hdr', enabled: true, type: 'headers', hitCount: 0, created: '2026-01-01T00:00:00.000Z',
            match: { url: '*/a*', method: '*', resourceTypes: ['document', 'subdocument'] },
            headersMod: { request: [{ op: 'set', name: 'X-A', value: '1' }], response: [] }
        } });
        expect(h.$('tmRt_document').checked).toBe(true);
        expect(h.editor.collect().rule.match.resourceTypes).toEqual(['document', 'subdocument']);
    });

    test('payload filter: collected as path/operator/value, filled back, dropped where it cannot apply', () => {
        h = mount();
        h.editor.open({});
        fillBasics('mock');
        expect(h.editor.collect().rule.match).not.toHaveProperty('payload');
        h.set('tmPayloadPath', ' user.id ');
        h.set('tmPayloadOp', 'contains');
        h.set('tmPayloadValue', ' 4 2');
        expect(h.editor.collect().rule.match.payload).toEqual({ path: 'user.id', operator: 'contains', value: ' 4 2' });

        // not available on headers / queryparams / all-requests rules: dropped, not left to be refused
        h.set('tmType', 'headers');
        expect(h.editor.collect().rule.match).not.toHaveProperty('payload');
        h.set('tmType', 'block');
        expect(h.editor.collect().rule.match).not.toHaveProperty('payload'); // a new block rule is all-requests
        h.set('tmAppliesAll', false);
        expect(h.editor.collect().rule.match.payload.path).toBe('user.id');

        h.editor.close();
        h.editor.open({ rule: mockRule({ match: { url: '*/a*', method: '*', payload: { path: 'items.0.sku', operator: 'equals', value: 'A1' } } }) });
        expect(h.$('tmPayloadPath').value).toBe('items.0.sku');
        expect(h.$('tmPayloadOp').value).toBe('equals');
        expect(h.$('tmPayloadValue').value).toBe('A1');
        expect(h.editor.collect().rule.match.payload).toEqual({ path: 'items.0.sku', operator: 'equals', value: 'A1' });
    });

    test('payload filter: a value without a path is passed on so the schema can name the path', () => {
        h = mount();
        h.editor.open({});
        fillBasics('mock');
        h.set('tmPayloadValue', 'x');
        expect(h.editor.collect().rule.match.payload).toEqual({ path: '', operator: 'equals', value: 'x' });
    });

    test.each([['first', 3], ['after', 10], ['every', 2]])('call filter %s: collected with its number and filled back', (mode, n) => {
        h = mount();
        h.editor.open({});
        fillBasics('delay');
        expect(h.editor.collect().rule.match).not.toHaveProperty('callFilter');
        h.set('tmCallMode', mode);
        h.set('tmCallN', String(n));
        const { rule, problems } = h.editor.collect();
        expect(problems).toEqual([]);
        expect(rule.match.callFilter).toEqual({ mode, n });

        h.editor.close();
        h.editor.open({ rule });
        expect(h.$('tmCallMode').value).toBe(mode);
        expect(h.$('tmCallN').value).toBe(String(n));
        expect(h.editor.collect().rule.match.callFilter).toEqual({ mode, n });
    });

    test('call filter: a fraction is a problem on its field; a blank number is a problem on its field', () => {
        h = mount();
        h.editor.open({});
        fillBasics('delay');
        h.set('tmCallMode', 'first');
        h.set('tmCallN', '2.5');
        expect(h.editor.collect().problems.map((p) => p.fieldId)).toEqual(['tmCallN']);
        h.set('tmCallN', '');
        expect(h.editor.collect().problems).toEqual([
            { fieldId: 'tmCallN', message: 'Call filter N is required once a mode is chosen' }
        ]);
    });

    test('call filter is dropped where the rule is handled by the network layer', () => {
        h = mount();
        h.editor.open({});
        fillBasics('block'); // all requests, by default
        h.set('tmCallMode', 'first');
        expect(h.editor.collect().rule.match).not.toHaveProperty('callFilter');
        h.set('tmAppliesAll', false);
        expect(h.editor.collect().rule.match.callFilter).toEqual({ mode: 'first', n: 3 });
    });

    test('status override: collected in patch mode only; empty keeps the real status', () => {
        h = mount();
        h.editor.open({});
        fillBasics('mock');
        h.set('tmMode', 'patch');
        h.set('tmPatch', '{"a": 1}');
        expect(h.editor.collect().rule.response).not.toHaveProperty('patchStatus');
        h.set('tmPatchStatus', '503');
        expect(h.editor.collect().rule.response.patchStatus).toBe(503);
        h.set('tmMode', 'static');
        expect(h.editor.collect().rule.response).not.toHaveProperty('patchStatus');
        h.set('tmMode', 'patch');
        h.set('tmPatchStatus', '');
        expect(h.editor.collect().rule.response).not.toHaveProperty('patchStatus');
    });

    test('status override: a non-integer is a problem on its field', () => {
        h = mount();
        h.editor.open({});
        fillBasics('mock');
        h.set('tmMode', 'patch');
        h.set('tmPatchStatus', '503.5');
        expect(h.editor.collect().problems).toEqual([
            { fieldId: 'tmPatchStatus', message: 'Patch status must be a whole number' }
        ]);
    });

    test('status override: filled from a stored patch rule, and a stale one is cleared when the mode changes', () => {
        h = mount();
        const rule = mockRule({ response: { statusCode: 200, headers: {}, delay: 0, mode: 'patch', patch: { a: 1 }, patchStatus: 418 } });
        h.editor.open({ rule });
        expect(h.$('tmPatchStatus').value).toBe('418');
        expect(h.editor.collect().rule.response.patchStatus).toBe(418);
        h.set('tmMode', 'static');
        expect(h.editor.collect().rule.response).not.toHaveProperty('patchStatus');
    });

    test('header ops: append in a response list passes through; the request list is untouched', () => {
        h = mount();
        h.editor.open({});
        fillBasics('headers');
        h.set('tmHdrRes', '[{"op":"append","name":"Set-Cookie","value":"a=1"},{"op":"set","name":"X-B","value":"2"}]');
        h.set('tmHdrReq', '[{"op":"set","name":"X-A","value":"1"}]');
        const { rule, problems } = h.editor.collect();
        expect(problems).toEqual([]);
        expect(rule.headersMod.response).toEqual([
            { op: 'append', name: 'Set-Cookie', value: 'a=1' },
            { op: 'set', name: 'X-B', value: '2' }
        ]);

        h.editor.close();
        h.editor.open({ rule });
        expect(JSON.parse(h.$('tmHdrRes').value)[0].op).toBe('append');
        expect(h.editor.collect().rule.headersMod.response[0].op).toBe('append');
    });

    test('remove all query parameters: written only when ticked, filled back, and gone on a type change', () => {
        h = mount();
        h.editor.open({});
        fillBasics('queryparams');
        h.set('tmQpAdd', '[{"key":"debug","value":"1"}]');
        expect(h.editor.collect().rule.queryParams).not.toHaveProperty('removeAll');
        h.set('tmQpRemoveAll', true);
        const { rule } = h.editor.collect();
        expect(rule.queryParams).toEqual({ add: [{ key: 'debug', value: '1' }], remove: [], removeAll: true });

        h.editor.close();
        h.editor.open({ rule });
        expect(h.$('tmQpRemoveAll').checked).toBe(true);
        h.set('tmType', 'delay');
        expect(h.editor.collect().rule).not.toHaveProperty('queryParams');
    });

    test('a rule opened for editing keeps match keys the form does not own', () => {
        h = mount();
        h.editor.open({ rule: mockRule({ match: { url: '*/a*', method: '*', somethingNew: 1, pageDomains: ['a.test'] } }) });
        const { rule } = h.editor.collect();
        expect(rule.match.somethingNew).toBe(1);
        expect(rule.match.pageDomains).toEqual(['a.test']);
    });

    test('reopening for a new rule starts with every new field blank', () => {
        h = mount();
        h.editor.open({ rule: mockRule({ match: {
            url: '*/a*', method: '*', pageDomains: ['a.test'],
            payload: { path: 'a', operator: 'contains', value: 'b' }, callFilter: { mode: 'every', n: 5 }
        } }) });
        h.editor.close();
        h.editor.open({});
        expect(h.$('tmPageDomains').value).toBe('');
        expect(h.$('tmPayloadPath').value).toBe('');
        expect(h.$('tmPayloadOp').value).toBe('equals');
        expect(h.$('tmCallMode').value).toBe('');
        expect(h.$('tmPatchStatus').value).toBe('');
        expect(h.$('tmQpRemoveAll').checked).toBe(false);
        for (const [value] of RESOURCE_TYPES) expect(h.$('tmRt_' + value).checked).toBe(false);
    });
});

// ---- problems on the new fields -----------------------------------------------

describe('B2 problems are marked on the new fields', () => {
    test('a resource-types problem marks the group\'s first box invalid, describes it, and takes focus', () => {
        h = mount();
        h.editor.open({});
        h.set('tmType', 'headers');
        h.editor.showProblems([{ fieldId: 'tmResourceTypes', message: 'Resource types: "gif" is not a known type' }]);
        const first = h.$('tmRt_fetch-xhr');
        expect(first.getAttribute('aria-invalid')).toBe('true');
        expect(first.getAttribute('aria-describedby')).toContain('tmResourceTypesErr');
        expect(h.$('tmResourceTypesErr').textContent).toMatch(/gif/);
        expect(h.root().activeElement).toBe(first);

        // answering the error (ticking any box in the group) clears it
        h.set('tmRt_image', true);
        expect(first.hasAttribute('aria-invalid')).toBe(false);
        expect(h.$('tmResourceTypesErr')).toBeNull();
    });

    test('a problem on a hidden field is left to the summary', () => {
        h = mount();
        h.editor.open({});
        h.set('tmType', 'mock'); // resource types are not on screen
        h.editor.showProblems([{ fieldId: 'tmResourceTypes', message: 'Resource types need "all requests"' }]);
        expect(h.$('tmRt_image').hasAttribute('aria-invalid')).toBe(false);
        expect(h.$('tmError').textContent).toMatch(/Resource types/);
    });

    test.each([
        ['tmPageDomains', 'Page domains: "x" is listed twice'],
        ['tmPayloadValue', 'Payload filter value is too long'],
        ['tmCallN', 'Call filter n must be a whole number from 1 to 1000']
    ])('a problem on %s marks that input', (id, message) => {
        h = mount();
        h.editor.open({});
        h.set('tmType', 'mock');
        h.set('tmCallMode', 'first');
        h.editor.showProblems([{ fieldId: id, message }]);
        expect(h.$(id).getAttribute('aria-invalid')).toBe('true');
        expect(h.$(id).getAttribute('aria-describedby')).toContain(id + 'Err');
    });
});

// ---- F10 / PER-59: Try a URL --------------------------------------------------

describe('B2-F10 Try a URL', () => {
    const verdict = (over = {}) => ({
        success: true,
        url: 'https://example.com/api/users/1',
        result: {
            matches: true,
            checks: [
                { condition: 'url', ok: true, detail: 'The URL matches the pattern.' },
                { condition: 'method', ok: false, detail: 'The rule is for POST, but this request is GET.' }
            ]
        },
        shadowedBy: [],
        network: false,
        ...over
    });
    const explainCalls = (hh) => hh.sent.filter((m) => m.type === 'explainMatch');
    const click = (id) => h.$(id).click();
    const flush = async () => { for (let i = 0; i < 5; i++) await settle(); };

    function mountWith(response) {
        h = mount({ handlers: { explainMatch: jest.fn(async () => (typeof response === 'function' ? response() : response)) } });
        h.editor.open({});
        h.set('tmName', 'Users');
        h.set('tmUrl', '*/api/users/*');
        return h;
    }

    test('the box is there: labelled controls, a Check button and a polite live region that exists before any result', async () => {
        h = mount();
        h.editor.open({});
        await settle();
        expect(h.$('tmTry').getAttribute('role')).toBe('group');
        expect(h.root().querySelector('label[for="tmTryUrl"]')).toBeTruthy();
        expect(h.root().querySelector('label[for="tmTryMethod"]')).toBeTruthy();
        expect(h.$('tmTryCheck').type).toBe('button');
        expect(h.$('tmTryCheck').textContent).toBe('Check');
        const region = h.$('tmTryResult');
        expect(region.getAttribute('role')).toBe('status');
        expect(region.getAttribute('aria-live')).toBe('polite');
        expect(region.childNodes.length).toBe(0);
        // the method list: the rule's own first, then real methods
        expect(Array.from(h.$('tmTryMethod').options).map((o) => o.value)).toEqual(['', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']);
    });

    test('Check sends explainMatch with the rule the form describes now, the URL and the method', async () => {
        mountWith(verdict());
        h.set('tmTryUrl', ' https://example.com/api/users/1 ');
        h.set('tmTryMethod', 'GET');
        click('tmTryCheck');
        await flush();
        const [call] = explainCalls(h);
        expect(call.type).toBe('explainMatch');
        expect(call.url).toBe('https://example.com/api/users/1');
        expect(call.method).toBe('GET');
        expect(call.rule).toEqual(expect.objectContaining({
            name: 'Users', type: 'mock', match: expect.objectContaining({ url: '*/api/users/*' })
        }));
        expect(Object.keys(call).sort()).toEqual(['method', 'rule', 'type', 'url']);
    });

    test('an empty URL and method are left out, so the background makes the URL up and uses the rule\'s method', async () => {
        mountWith(verdict());
        click('tmTryCheck');
        await flush();
        const [call] = explainCalls(h);
        expect(call).not.toHaveProperty('url');
        expect(call).not.toHaveProperty('method');
        expect(h.$('tmTryResult').textContent).toMatch(/made up from the pattern/);
    });

    test('the page, resource type and body are sent when given', async () => {
        mountWith(verdict());
        h.set('tmTryPage', 'https://app.example.com/home');
        h.set('tmTryType', 'script');
        h.set('tmTryBody', '{"user":{"id":42}}');
        click('tmTryCheck');
        await flush();
        const [call] = explainCalls(h);
        expect(call.pageUrl).toBe('https://app.example.com/home');
        expect(call.resourceType).toBe('script');
        expect(call.body).toBe('{"user":{"id":42}}');
    });

    test('an unsaved rule with no name yet can still be tried', async () => {
        h = mount({ handlers: { explainMatch: async () => verdict() } });
        h.editor.open({});
        h.set('tmUrl', '*/api/*');
        click('tmTryCheck');
        await flush();
        expect(explainCalls(h)[0].rule.name).toBe('Untitled rule');
        expect(h.editor.collect().rule.name).toBe(''); // the form itself is untouched
    });

    test('the verdict and each check are listed with a glyph and a hidden pass/fail word', async () => {
        mountWith(verdict());
        click('tmTryCheck');
        await flush();
        const out = h.$('tmTryResult');
        expect(out.querySelector('.tm-try-sum').textContent).toBe('This rule would handle https://example.com/api/users/1 (made up from the pattern)');
        const items = Array.from(out.querySelectorAll('li'));
        expect(items.map((li) => li.textContent)).toEqual([
            '✓Passed: The URL matches the pattern.',
            '✗Failed: The rule is for POST, but this request is GET.'
        ]);
        expect(items.map((li) => li.querySelector('.tm-try-mark').getAttribute('aria-hidden'))).toEqual(['true', 'true']);
        expect(items[0].querySelector('.tm-try-ok')).toBeTruthy();
        expect(items[1].querySelector('.tm-try-no')).toBeTruthy();
    });

    test('a request the rule would not handle says so', async () => {
        mountWith(verdict({ result: { matches: false, checks: [{ condition: 'url', ok: false, detail: 'The URL does not match.' }] } }));
        h.set('tmTryUrl', 'https://example.com/other');
        click('tmTryCheck');
        await flush();
        expect(h.$('tmTryResult').querySelector('.tm-try-sum').textContent).toBe('This rule would not handle https://example.com/api/users/1');
    });

    test('"Would be handled by Chrome\'s network layer" appears when network is true, and only then', async () => {
        mountWith(verdict({ network: true }));
        click('tmTryCheck');
        await flush();
        expect(h.$('tmTryResult').textContent).toContain("Would be handled by Chrome's network layer");
        h.cleanup();
        mountWith(verdict({ network: false }));
        click('tmTryCheck');
        await flush();
        expect(h.$('tmTryResult').textContent).not.toContain('network layer');
    });

    test('each shadowing rule gets a warning naming it, built from text and never markup', async () => {
        mountWith(verdict({ shadowedBy: [
            { ruleId: 'a', ruleName: 'Earlier mock' },
            { ruleId: 'b', ruleName: '<img src=x onerror=alert(1)>' }
        ] }));
        click('tmTryCheck');
        await flush();
        const warnings = Array.from(h.$('tmTryResult').querySelectorAll('.tm-note')).map((n) => n.textContent);
        expect(warnings).toEqual([
            'An earlier rule, Earlier mock, also matches this request and takes precedence',
            'An earlier rule, <img src=x onerror=alert(1)>, also matches this request and takes precedence'
        ]);
        expect(h.$('tmTryResult').querySelector('img')).toBeNull();
    });

    test('a second Check replaces the first result rather than adding to it', async () => {
        mountWith(verdict({ shadowedBy: [{ ruleId: 'a', ruleName: 'One' }] }));
        click('tmTryCheck');
        await flush();
        expect(h.$('tmTryResult').querySelectorAll('.tm-note').length).toBe(1);
        window.chrome.runtime.sendMessage.mockImplementation(async (m) => (m.type === 'explainMatch' ? verdict() : { success: true }));
        click('tmTryCheck');
        await flush();
        expect(h.$('tmTryResult').querySelectorAll('.tm-note').length).toBe(0);
        expect(h.$('tmTryResult').querySelectorAll('li').length).toBe(2);
    });

    test('a regex pattern with no URL entered asks for one', async () => {
        mountWith({ success: false, needsUrl: true });
        click('tmTryCheck');
        await flush();
        expect(h.$('tmTryResult').textContent).toMatch(/regular expression.*Enter a URL/);
    });

    test('a refusal from the background is shown as the result', async () => {
        mountWith({ success: false, error: 'Unknown message type: explainMatch' });
        click('tmTryCheck');
        await flush();
        expect(h.$('tmTryResult').textContent).toBe('Unknown message type: explainMatch');
    });

    test('a failed send is shown as the result and the button comes back', async () => {
        h = mount({ handlers: { explainMatch: async () => { throw new Error('Extension context invalidated.'); } } });
        h.editor.open({});
        h.set('tmUrl', '*/a*');
        click('tmTryCheck');
        await flush();
        expect(h.$('tmTryResult').textContent).toBe('SpliceTap could not check that URL: Extension context invalidated.');
        expect(h.$('tmTryCheck').disabled).toBe(false);
        expect(h.$('tmTryCheck').textContent).toBe('Check');
    });

    test('JSON the form cannot read stops the check before anything is sent', async () => {
        mountWith(verdict());
        h.set('tmType', 'headers');
        h.set('tmHdrReq', '[{');
        click('tmTryCheck');
        await flush();
        expect(explainCalls(h)).toEqual([]);
        expect(h.$('tmTryResult').textContent).toMatch(/^Fix this first: Request Headers: invalid JSON/);
    });

    test('the button is disabled while the answer is awaited, then restored', async () => {
        let release;
        mountWith(() => new Promise((resolve) => { release = () => resolve(verdict()); }));
        click('tmTryCheck');
        await settle();
        expect(h.$('tmTryCheck').disabled).toBe(true);
        expect(h.$('tmTryCheck').textContent).toBe('Checking…');
        click('tmTryCheck'); // a second press while waiting sends nothing more
        await settle();
        expect(explainCalls(h).length).toBe(1);
        release();
        await flush();
        expect(h.$('tmTryCheck').disabled).toBe(false);
        expect(h.$('tmTryCheck').textContent).toBe('Check');
    });

    test('Enter in the URL box checks, like pressing the button', async () => {
        mountWith(verdict());
        h.set('tmTryUrl', 'https://example.com/x');
        h.$('tmTryUrl').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await flush();
        expect(explainCalls(h).length).toBe(1);
    });

    test('what is typed into the box is not an edit to the rule: Escape still closes at once', async () => {
        h = mount();
        h.editor.open({});
        h.set('tmTryUrl', 'https://example.com/x');
        h.set('tmTryMethod', 'POST');
        h.set('tmTryBody', '{}');
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(h.editor.isOpen()).toBe(false);
    });

    test('each time a rule is opened the box starts empty', async () => {
        mountWith(verdict());
        h.set('tmTryUrl', 'https://example.com/x');
        h.set('tmTryMethod', 'POST');
        click('tmTryCheck');
        await flush();
        expect(h.$('tmTryResult').childNodes.length).toBeGreaterThan(0);
        h.editor.close();
        h.editor.open({});
        expect(h.$('tmTryUrl').value).toBe('');
        expect(h.$('tmTryMethod').value).toBe('');
        expect(h.$('tmTryResult').childNodes.length).toBe(0);
    });

    test('closing the editor while a check is in flight is harmless', async () => {
        let release;
        mountWith(() => new Promise((resolve) => { release = () => resolve(verdict()); }));
        click('tmTryCheck');
        await settle();
        h.editor.close();
        release();
        await flush();
        expect(h.editor.isOpen()).toBe(false);
    });
});

// ---- PER-60: captured response panel ------------------------------------------

describe('PER-60 captured response panel', () => {
    const shownPanel = () => h.$('tmRefField').style.display !== 'none' && h.$('tmRefField').classList.contains('tm-visible');

    test('without a referenceBody there is no panel', () => {
        h = mount();
        h.editor.open({});
        expect(h.$('tmRefField').style.display).toBe('none');
        h.editor.close();
        h.editor.open({ referenceBody: '' });
        expect(h.$('tmRefField').style.display).toBe('none');
    });

    test('with one, a read-only, labelled, monospace, left-to-right textarea shows it beside the body', () => {
        h = mount();
        h.editor.open({ referenceBody: '{"id":1,"name":"Ann"}' });
        expect(shownPanel()).toBe(true);
        const box = h.$('tmRefBody');
        expect(box.readOnly).toBe(true);
        expect(box.getAttribute('dir')).toBe('ltr');
        expect(box.classList.contains('tm-code')).toBe(true);
        expect(box.getAttribute('aria-labelledby')).toBe('tmRefToggle');
        expect(h.$('tmRefToggle').textContent).toBe('Captured response');
        // it sits directly before the body field
        expect(h.$('tmRefField').nextElementSibling.id).toBe('tmBodyField');
        // JSON is laid out for reading; the text is otherwise the capture's
        expect(JSON.parse(box.value)).toEqual({ id: 1, name: 'Ann' });
        expect(box.value).toContain('\n');
    });

    test('text that is not a JSON object is shown exactly as received', () => {
        h = mount();
        h.editor.open({ referenceBody: '  <html>hi</html>\n' });
        expect(h.$('tmRefBody').value).toBe('  <html>hi</html>\n');
        h.editor.close();
        h.editor.open({ referenceBody: '42' });
        expect(h.$('tmRefBody').value).toBe('42');
    });

    test('the toggle collapses and expands it, with aria-expanded kept true to what is on screen', () => {
        h = mount();
        h.editor.open({ referenceBody: 'abc' });
        const toggle = h.$('tmRefToggle');
        expect(toggle.getAttribute('aria-controls')).toBe('tmRefRegion');
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(h.$('tmRefRegion').hidden).toBe(false);
        toggle.click();
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(h.$('tmRefRegion').hidden).toBe(true);
        toggle.click();
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(h.$('tmRefRegion').hidden).toBe(false);
    });

    test('it is only for mock rules, stays out of the rule, and does not dirty the form', () => {
        h = mount();
        h.editor.open({ referenceBody: '{"a":1}' });
        h.set('tmType', 'delay');
        expect(shownPanel()).toBe(false);
        h.set('tmType', 'mock');
        expect(shownPanel()).toBe(true);
        h.set('tmName', 'x');
        h.set('tmUrl', '*/a*');
        expect(JSON.stringify(h.editor.collect().rule)).not.toContain('Captured');
        h.$('tmRefToggle').click();
        h.editor.close();
        h.editor.open({ referenceBody: 'z' });
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(h.editor.isOpen()).toBe(false); // untouched form: closes at once
    });

    test('it is gone when the editor is opened again without one, and starts expanded again with one', () => {
        h = mount();
        h.editor.open({ referenceBody: 'one' });
        h.$('tmRefToggle').click();
        h.editor.close();
        h.editor.open({});
        expect(h.$('tmRefField').style.display).toBe('none');
        expect(h.$('tmRefBody').value).toBe('');
        h.editor.close();
        h.editor.open({ referenceBody: 'two' });
        expect(h.$('tmRefBody').value).toBe('two');
        expect(h.$('tmRefToggle').getAttribute('aria-expanded')).toBe('true');
    });

    test('an object is accepted, and a huge body is cut with a note saying so', () => {
        h = mount();
        h.editor.open({ referenceBody: { a: [1, 2] } });
        expect(JSON.parse(h.$('tmRefBody').value)).toEqual({ a: [1, 2] });
        h.editor.close();
        h.editor.open({ referenceBody: 'x'.repeat(150000) });
        expect(h.$('tmRefBody').value.length).toBe(100000);
        expect(h.$('tmRefHint').textContent).toMatch(/first 100,000 of 150,000 characters/);
    });
});

// ---- PER-63: restorable drafts ------------------------------------------------

describe('PER-63 drafts', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { if (h) h.cleanup(); h = null; jest.useRealTimers(); });

    const tick = (ms) => jest.advanceTimersByTimeAsync(ms);
    const of = (hh, type) => hh.sent.filter((m) => m.type === type);
    const draftSaved = (hh) => of(hh, 'saveEditorDraft');
    const kept = {
        v: 1, name: 'Half written', editingRule: null,
        values: { tmType: 'delay', tmName: 'Half written', tmUrl: '*/slow/*', tmMethod: 'POST', tmDelayMs: '2500', tmEnabled: false, tmCallMode: 'first', tmCallN: '4' }
    };

    test('the beforeunload prompt is gone: no listener, and an unload is never prevented', async () => {
        const add = jest.spyOn(window, 'addEventListener');
        h = mount();
        h.editor.open({});
        h.set('tmName', 'typing');
        expect(add.mock.calls.filter(([type]) => type === 'beforeunload')).toEqual([]);
        const event = new window.Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        add.mockRestore();
    });

    test('a dirty form is saved as a draft 800 ms after the last edit, once for a burst', async () => {
        h = mount();
        h.editor.open({});
        await tick(0);
        h.set('tmName', 'A');
        await tick(500);
        h.set('tmName', 'AB');
        await tick(500);
        expect(draftSaved(h)).toEqual([]); // 500 ms since the last edit
        await tick(300);
        expect(draftSaved(h).length).toBe(1);
        const { draft } = draftSaved(h)[0];
        expect(draft.name).toBe('AB');
        expect(draft.values.tmName).toBe('AB');
        expect(draft.values.tmType).toBe('mock');
        expect(draft.editingRule).toBeNull();
        await tick(5000);
        expect(draftSaved(h).length).toBe(1); // nothing new, nothing more
    });

    test('an untouched form saves nothing, and neither does typing in "Try a URL"', async () => {
        h = mount();
        h.editor.open({});
        await tick(3000);
        h.set('tmTryUrl', 'https://example.com');
        h.set('tmTryBody', '{}');
        await tick(3000);
        expect(draftSaved(h)).toEqual([]);
    });

    test('the draft carries the form and the rule being edited, but not scratch controls', async () => {
        h = mount();
        const rule = mockRule();
        h.editor.open({ rule, referenceBody: '{"x":1}' });
        await tick(0);
        h.set('tmTryUrl', 'https://example.com');
        h.set('tmName', 'Renamed');
        h.set('tmCallMode', 'every');
        h.set('tmPageDomains', 'a.test');
        await tick(800);
        const { draft } = draftSaved(h)[0];
        expect(draft.editingRule).toEqual(rule);
        expect(draft.values).toMatchObject({ tmName: 'Renamed', tmCallMode: 'every', tmPageDomains: 'a.test', tmEnabled: true });
        expect(Object.keys(draft.values).some((id) => /^tmTry|^tmTemplate|^tmRefBody/.test(id))).toBe(false);
    });

    test('an extension page names its key; a content script sends none', async () => {
        h = mount({ draftKey: 'options' });
        h.editor.open({});
        await tick(0);
        h.set('tmName', 'x');
        await tick(800);
        expect(of(h, 'getEditorDraft')[0].tabId).toBe('options');
        expect(draftSaved(h)[0].tabId).toBe('options');
        h.cleanup();
        h = mount();
        h.editor.open({});
        await tick(0);
        h.set('tmName', 'x');
        await tick(800);
        expect(of(h, 'getEditorDraft')[0]).not.toHaveProperty('tabId');
        expect(draftSaved(h)[0]).not.toHaveProperty('tabId');
    });

    test('closing before the debounce ends saves nothing; closing after a save clears it, in order', async () => {
        h = mount();
        h.editor.open({});
        await tick(0);
        h.set('tmName', 'quick');
        await tick(300);
        h.$('tmCancel').click();
        await tick(5000);
        expect(draftSaved(h)).toEqual([]);
        expect(of(h, 'clearEditorDraft')).toEqual([]); // nothing was stored, so nothing to clear

        h.editor.open({});
        await tick(0);
        h.set('tmName', 'longer');
        await tick(800);
        h.$('tmCancel').click();
        await tick(100);
        const order = h.sent.map((m) => m.type).filter((t) => /EditorDraft/.test(t));
        expect(order.slice(-2)).toEqual(['saveEditorDraft', 'clearEditorDraft']);
    });

    test('a reload within the debounce window hands over what was typed (pagehide)', async () => {
        h = mount();
        h.editor.open({});
        await tick(0);
        h.set('tmName', 'last second');
        window.dispatchEvent(new window.Event('pagehide'));
        await tick(0);
        expect(draftSaved(h).length).toBe(1);
        expect(draftSaved(h)[0].draft.values.tmName).toBe('last second');
        await tick(2000);
        expect(draftSaved(h).length).toBe(1);
    });

    test('a failing draft service never breaks the editor', async () => {
        h = mount({ handlers: {
            getEditorDraft: async () => { throw new Error('gone'); },
            saveEditorDraft: async () => { throw new Error('gone'); },
            clearEditorDraft: async () => ({ success: false, error: 'Unknown message type: clearEditorDraft' })
        } });
        h.editor.open({});
        await tick(0);
        h.set('tmName', 'x');
        await tick(800);
        h.$('tmCancel').click();
        await tick(100);
        expect(h.editor.isOpen()).toBe(false);
    });

    describe('the offer', () => {
        const withDraft = (draft = kept) => ({ getEditorDraft: async () => ({ success: true, draft }) });
        const bar = () => h.$('tmDraftBar');

        test('no draft, an unsupported service or a malformed one: no banner', async () => {
            for (const answer of [{ success: true, draft: null }, { success: false, error: 'Unknown message type' }, { success: true, draft: { v: 1 } }, undefined]) {
                h = mount({ handlers: { getEditorDraft: async () => answer } });
                h.editor.open({});
                await tick(200);
                expect(bar().hidden).toBe(true);
                h.cleanup();
            }
            h = null;
        });

        test('a draft is offered: "Restore your unsaved rule \'<name>\'?" with Restore and Discard', async () => {
            h = mount({ handlers: withDraft() });
            h.editor.open({});
            await tick(200);
            expect(bar().hidden).toBe(false);
            expect(h.$('tmDraftText').textContent).toBe("Restore your unsaved rule 'Half written'?");
            expect(h.$('tmDraftText').getAttribute('role')).toBe('status');
            expect(h.$('tmDraftRestore').textContent).toBe('Restore');
            expect(h.$('tmDraftDiscard').textContent).toBe('Discard');
            expect(bar().getAttribute('role')).toBe('group');
            // opening is not an edit
            expect(draftSaved(h)).toEqual([]);
        });

        test('a draft with no name is offered without one', async () => {
            h = mount({ handlers: withDraft({ ...kept, name: '', values: { ...kept.values, tmName: '' } }) });
            h.editor.open({});
            await tick(200);
            expect(h.$('tmDraftText').textContent).toBe('Restore your unsaved rule?');
        });

        test('a name that looks like markup is text', async () => {
            h = mount({ handlers: withDraft({ ...kept, values: { ...kept.values, tmName: '<b onclick=x>hi</b>' } }) });
            h.editor.open({});
            await tick(200);
            expect(h.$('tmDraftText').textContent).toBe("Restore your unsaved rule '<b onclick=x>hi</b>'?");
            expect(h.$('tmDraftText').querySelector('b')).toBeNull();
        });

        test('Restore puts the form back, and it counts as unsaved work again', async () => {
            h = mount({ handlers: withDraft() });
            h.editor.open({});
            await tick(200);
            h.$('tmDraftRestore').click();
            expect(h.$('tmType').value).toBe('delay');
            expect(h.$('tmName').value).toBe('Half written');
            expect(h.$('tmUrl').value).toBe('*/slow/*');
            expect(h.$('tmMethod').value).toBe('POST');
            expect(h.$('tmDelayMs').value).toBe('2500');
            expect(h.$('tmEnabled').checked).toBe(false);
            expect(h.$('tmCallMode').value).toBe('first');
            expect(h.$('tmCallN').value).toBe('4');
            expect(h.isShown('tmCallField')).toBe(true);
            expect(bar().hidden).toBe(true);
            const { rule } = h.editor.collect();
            expect(rule).toMatchObject({ type: 'delay', name: 'Half written', delayMs: 2500, enabled: false });
            expect(rule.match.callFilter).toEqual({ mode: 'first', n: 4 });
            // Escape now warns (dirty) instead of closing, and the draft keeps being kept
            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            expect(h.editor.isOpen()).toBe(true);
            await tick(800);
            expect(draftSaved(h).length).toBeGreaterThan(0);
            expect(h.root().activeElement).toBe(h.$('tmName'));
        });

        test('Restore on a draft of an edit brings back the rule\'s identity', async () => {
            const rule = mockRule();
            h = mount({ handlers: withDraft({ v: 1, name: 'Mock', editingRule: rule, values: { tmType: 'mock', tmName: 'Mock edited', tmUrl: '*/api/*', tmMethod: '*' } }) });
            h.editor.open({});
            await tick(200);
            h.$('tmDraftRestore').click();
            expect(h.$('tmTitle').textContent).toBe('Edit Rule');
            const collected = h.editor.collect().rule;
            expect(collected.id).toBe('m1');
            expect(collected.hitCount).toBe(2);
            expect(collected.name).toBe('Mock edited');
        });

        test('Restore skips values that no longer fit a control (an option that is gone)', async () => {
            h = mount({ handlers: withDraft({ ...kept, values: { ...kept.values, tmType: 'no-such-type', tmNoSuchField: 'x' } }) });
            h.editor.open({});
            await tick(200);
            h.$('tmDraftRestore').click();
            expect(h.$('tmType').value).toBe('mock'); // unchanged
            expect(h.$('tmName').value).toBe('Half written');
        });

        test('Discard removes the draft and leaves the form as it opened', async () => {
            h = mount({ handlers: withDraft() });
            h.editor.open({});
            await tick(200);
            h.$('tmDraftDiscard').click();
            await tick(0);
            expect(bar().hidden).toBe(true);
            expect(of(h, 'clearEditorDraft').length).toBe(1);
            expect(h.$('tmName').value).toBe('');
            expect(h.$('tmType').value).toBe('mock');
            // and a later clean close has nothing more to clear
            h.$('tmCancel').click();
            await tick(0);
            expect(of(h, 'clearEditorDraft').length).toBe(1);
        });

        test('closing without answering is a clean close: the draft is cleared', async () => {
            h = mount({ handlers: withDraft() });
            h.editor.open({});
            await tick(200);
            document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await tick(0);
            expect(h.editor.isOpen()).toBe(false);
            expect(of(h, 'clearEditorDraft').length).toBe(1);
        });

        test('starting to type answers the offer with no: the banner goes and the draft is replaced', async () => {
            h = mount({ handlers: withDraft() });
            h.editor.open({});
            await tick(200);
            h.set('tmName', 'Something else');
            expect(bar().hidden).toBe(true);
            await tick(800);
            expect(draftSaved(h)[0].draft.values.tmName).toBe('Something else');
        });

        test('an answer that arrives after the person has begun typing is not offered', async () => {
            let answer;
            h = mount({ handlers: { getEditorDraft: () => new Promise((resolve) => { answer = () => resolve({ success: true, draft: kept }); }) } });
            h.editor.open({});
            h.set('tmName', 'already typing');
            answer();
            await tick(200);
            expect(bar().hidden).toBe(true);
        });

        test('an answer that arrives after the editor is closed is dropped', async () => {
            let answer;
            h = mount({ handlers: { getEditorDraft: () => new Promise((resolve) => { answer = () => resolve({ success: true, draft: kept }); }) } });
            h.editor.open({});
            h.editor.close();
            answer();
            await tick(200);
            expect(h.editor.isOpen()).toBe(false);
        });

        test('opening again offers afresh, and the old banner does not linger', async () => {
            let draft = kept;
            h = mount({ handlers: { getEditorDraft: async () => ({ success: true, draft }) } });
            h.editor.open({});
            await tick(200);
            expect(bar().hidden).toBe(false);
            draft = null;
            h.editor.close();
            h.editor.open({});
            await tick(200);
            expect(bar().hidden).toBe(true);
            expect(h.$('tmDraftText').textContent).toBe('');
        });
    });
});
