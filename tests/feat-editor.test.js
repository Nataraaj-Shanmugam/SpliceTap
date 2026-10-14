/** @jest-environment jsdom */
/**
 * Editor feature group (G4a): F1 appliesTo checkbox, F3 "Modify request body",
 * F4 code responses. The form is mounted for real under jsdom (open shadow
 * root) and driven through its fields; `editor.collect()` is the rule the form
 * describes before the schema judges it. What needs a real Chrome (axe, the
 * closed overlay root, focus) is in tests/e2e/feat-editor.e2e.test.js.
 */

require('../src/templates'); // statusText comes from it, as in the extension
const { create, fieldForError } = require('../src/rule-editor');

function mount({ rules = [], settings } = {}) {
    const sent = [];
    window.chrome = {
        runtime: {
            lastError: null,
            sendMessage: jest.fn(async (message) => {
                sent.push(message);
                if (message.type === 'getRules') return { success: true, rules, settings };
                if (message.type === 'saveRule') return { success: true, rule: message.rule };
                return { success: true };
            })
        },
        storage: { local: { get: (keys, cb) => cb({ tmOverlayHintSeen: true }), set: () => {} } }
    };
    // jsdom has neither; the editor calls both.
    window.Element.prototype.scrollIntoView = () => {};
    window.matchMedia = window.matchMedia || (() => ({ matches: true }));

    const mountPoint = document.createElement('div');
    document.body.appendChild(mountPoint);
    const editor = create({ shadowMode: 'open', mountPoint });
    const root = () => mountPoint.firstChild.shadowRoot;
    const $ = (id) => root().getElementById(id);

    return {
        editor, sent, mountPoint, $,
        /** Set a field the way a user's input does, firing the events the editor listens to. */
        set(id, value) {
            const el = $(id);
            if (el.type === 'checkbox') el.checked = !!value;
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        /** Fields the type's [data-types] rules currently reveal. */
        visible: () => Array.from(root().querySelectorAll('.tm-visible')).map((el) => el.id).filter(Boolean),
        isShown: (id) => $(id).classList.contains('tm-visible'),
        cleanup() {
            editor.close();
            mountPoint.remove();
        }
    };
}

let h;
afterEach(() => { if (h) h.cleanup(); h = null; });

/** Let open()'s fire-and-forget settings read finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const redirectRule = (over = {}) => ({
    id: 'r1', name: 'Redirect', enabled: true, type: 'redirect',
    match: { url: '*/api/*', method: '*' },
    redirect: { destination: 'https://example.test/x' },
    hitCount: 3, created: '2026-01-01T00:00:00.000Z', ...over
});
const blockRule = (over = {}) => ({
    id: 'b1', name: 'Block', enabled: true, type: 'block',
    match: { url: '*/ads/*', method: '*' },
    hitCount: 0, created: '2026-01-01T00:00:00.000Z', ...over
});

// ---- F1 ----------------------------------------------------------------------

describe('F1: "Also apply to scripts, images, styles and pages"', () => {
    test('the checkbox exists with the specified label and a hint linked by aria-describedby', async () => {
        h = mount();
        h.editor.open({});
        await settle();
        const box = h.$('tmAppliesAll');
        expect(box.type).toBe('checkbox');
        expect(box.closest('label').textContent.trim()).toBe('Also apply to scripts, images, styles and pages');
        expect(box.getAttribute('aria-describedby')).toBe('tmAppliesAllHint');
        expect(h.$('tmAppliesAllHint').textContent)
            .toBe("fetch/XHR are handled in the page; everything else by Chrome's network layer.");
    });

    test.each(['redirect', 'block'])('it is shown for %s rules only', async (type) => {
        h = mount();
        h.editor.open({});
        for (const other of ['mock', 'delay', 'headers', 'queryparams', 'requestBody']) {
            h.set('tmType', other);
            expect(h.isShown('tmAppliesAllField')).toBe(false);
        }
        h.set('tmType', type);
        expect(h.isShown('tmAppliesAllField')).toBe(true);
    });

    test.each(['redirect', 'block'])('a new %s rule defaults to ticked and saves appliesTo "all"', (type) => {
        h = mount();
        h.editor.open({});
        h.set('tmType', type);
        h.set('tmName', 'New');
        h.set('tmUrl', '*/a*');
        h.set('tmRedirect', 'https://example.test/y');
        expect(h.$('tmAppliesAll').checked).toBe(true);
        expect(h.editor.collect().rule.appliesTo).toBe('all');
    });

    test.each(['redirect', 'block'])('unticking a %s rule saves appliesTo "page", explicitly', (type) => {
        h = mount();
        h.editor.open({});
        h.set('tmType', type);
        h.set('tmName', 'New');
        h.set('tmUrl', '*/a*');
        h.set('tmAppliesAll', false);
        expect(h.editor.collect().rule.appliesTo).toBe('page');
    });

    test.each([
        ['absent is unticked', undefined, false],
        ['"page" is unticked', 'page', false],
        ['"all" is ticked', 'all', true]
    ])('editing a stored redirect: %s', (label, stored, ticked) => {
        h = mount();
        const rule = redirectRule();
        if (stored !== undefined) rule.appliesTo = stored;
        h.editor.open({ rule });
        expect(h.$('tmAppliesAll').checked).toBe(ticked);
    });

    test('editing a stored block rule reflects its stored value too', () => {
        h = mount();
        h.editor.open({ rule: blockRule({ appliesTo: 'all' }) });
        expect(h.$('tmAppliesAll').checked).toBe(true);
        h.editor.close();
        h.editor.open({ rule: blockRule() });
        expect(h.$('tmAppliesAll').checked).toBe(false);
    });

    test('an edit that changes nothing keeps the stored value (absent becomes an explicit "page")', () => {
        h = mount();
        h.editor.open({ rule: redirectRule() });
        expect(h.editor.collect().rule.appliesTo).toBe('page');
    });

    test('appliesTo is dropped when the type changes to one that cannot carry it', () => {
        h = mount();
        h.editor.open({ rule: redirectRule({ appliesTo: 'all' }) });
        h.set('tmType', 'delay');
        const { rule } = h.editor.collect();
        expect('appliesTo' in rule).toBe(false);
        expect('redirect' in rule).toBe(false);
    });

    test('a redirect to "all" with a relative destination is tied to the destination field', () => {
        const message = 'Use a full URL (https://…) to redirect scripts, images and pages, or untick "all requests".';
        expect(fieldForError(message, { type: 'redirect' })).toBe('tmRedirect');
    });

    test('the schema\'s messages about the checkbox itself are tied to it', () => {
        expect(fieldForError('"appliesTo" must be "page" or "all"', { type: 'block' })).toBe('tmAppliesAll');
        expect(fieldForError('"appliesTo" is only for redirect and block rules, not mock rules', { type: 'mock' })).toBe('tmAppliesAll');
        expect(fieldForError('Rules that apply to all requests cannot use header or GraphQL match conditions, because only fetch and XHR requests can be checked against them. Untick "all requests", or remove the condition.', { type: 'block' }))
            .toBe('tmAppliesAll');
        // the ASCII-only URL rule is about the URL field
        expect(fieldForError('URL patterns for rules that apply to all requests can only contain plain ASCII characters', { type: 'block' }))
            .toBe('tmUrl');
    });

    test('a new block rule with a header condition is collected as "all" + condition, for the schema to refuse on the checkbox', () => {
        // Decision: the editor does not untick the box behind the user's back;
        // the schema's refusal is shown beside the checkbox (see the real-schema
        // block below, which runs once the schema group's change is merged).
        h = mount();
        h.editor.open({});
        h.set('tmType', 'block');
        h.set('tmName', 'Block dev');
        h.set('tmUrl', '*/a*');
        h.set('tmMatchHeaders', '{"x-env": "dev"}');
        const { rule } = h.editor.collect();
        expect(rule.appliesTo).toBe('all');
        expect(rule.match.headers).toEqual({ 'x-env': 'dev' });
    });

    test('toggling the checkbox, or reporting an error on it, keeps its hint linked', () => {
        h = mount();
        h.editor.open({});
        h.set('tmType', 'block');
        h.set('tmAppliesAll', false); // fires the input/change the editor uses to clear a field's error
        expect(h.$('tmAppliesAll').getAttribute('aria-describedby')).toBe('tmAppliesAllHint');
        h.set('tmAppliesAll', true);
        expect(h.$('tmAppliesAll').getAttribute('aria-describedby')).toBe('tmAppliesAllHint');
    });
});

// ---- F3 ----------------------------------------------------------------------

const bodyRule = (over = {}) => ({
    id: 'rb1', name: 'Body', enabled: true, type: 'requestBody',
    match: { url: '*/api/*', method: 'POST' },
    requestBody: { mode: 'static', body: { id: 1 } },
    hitCount: 5, created: '2026-01-01T00:00:00.000Z', ...over
});

describe('F3: Modify request body', () => {
    const open = (rule) => { h = mount(); h.editor.open(rule ? { rule } : {}); };
    const inVisibleField = (id) => h.$(id).closest('.tm-field').classList.contains('tm-visible');

    test('the type select offers it', () => {
        open();
        const option = Array.from(h.$('tmType').options).find((o) => o.value === 'requestBody');
        expect(option && option.textContent).toBe('Modify Request Body');
    });

    test('the mode select offers Replace body and JSON patch', () => {
        open();
        expect(Array.from(h.$('tmReqMode').options).map((o) => [o.value, o.textContent]))
            .toEqual([['static', 'Replace body'], ['patch', 'JSON patch']]);
    });

    test('its fields show for the type and no other, and the mode swaps body for patch', () => {
        open();
        h.set('tmType', 'mock');
        expect(h.isShown('tmReqBodyField')).toBe(false);
        expect(h.isShown('tmReqPatchField')).toBe(false);
        expect(inVisibleField('tmReqMode')).toBe(false);

        h.set('tmType', 'requestBody');
        expect(inVisibleField('tmReqMode')).toBe(true);
        expect(h.isShown('tmReqBodyField')).toBe(true);
        expect(h.isShown('tmReqPatchField')).toBe(false);
        h.set('tmReqMode', 'patch');
        expect(h.isShown('tmReqBodyField')).toBe(false);
        expect(h.isShown('tmReqPatchField')).toBe(true);

        // not the mock response fields, nor another type's
        for (const f of ['tmBodyField', 'tmPatchField', 'tmCodeField', 'tmStatusField', 'tmAppliesAllField']) {
            expect(h.isShown(f)).toBe(false);
        }
        // the match conditions are part of this rule's shape
        expect(inVisibleField('tmGraphql')).toBe(true);
        expect(inVisibleField('tmMatchHeaders')).toBe(true);
    });

    test('a hint on placeholders sits with the body, and the patch has its own hint', () => {
        open();
        expect(h.$('tmReqBody').getAttribute('aria-describedby')).toBe('tmReqBodyHint');
        expect(h.$('tmReqBodyHint').textContent).toMatch(/Placeholders like \{\{guid\}\}/);
        expect(h.$('tmReqPatch').getAttribute('aria-describedby')).toBe('tmReqPatchHint');
        expect(h.$('tmReqPatchHint').textContent).toMatch(/RFC 7386/);
    });

    describe('collect', () => {
        const fillBasics = () => {
            h.set('tmType', 'requestBody');
            h.set('tmName', 'Rewrite');
            h.set('tmUrl', '*/api/orders*');
            h.set('tmMethod', 'POST');
        };

        test('replace body: plain text is stored exactly as typed', () => {
            open();
            fillBasics();
            h.set('tmReqBody', 'hello {{guid}}');
            const { rule, problems } = h.editor.collect();
            expect(problems).toEqual([]);
            expect(rule).toMatchObject({
                type: 'requestBody',
                match: { url: '*/api/orders*', method: 'POST' },
                requestBody: { mode: 'static', body: 'hello {{guid}}' }
            });
            expect('patch' in rule.requestBody).toBe(false);
        });

        test('replace body: a JSON object or array is stored parsed', () => {
            open();
            fillBasics();
            h.set('tmReqBody', '{"qty": 3}');
            expect(h.editor.collect().rule.requestBody.body).toEqual({ qty: 3 });
            h.set('tmReqBody', '[1, 2]');
            expect(h.editor.collect().rule.requestBody.body).toEqual([1, 2]);
        });

        test('replace body: an empty body is kept as the empty string, which the schema allows', () => {
            open();
            fillBasics();
            h.set('tmReqBody', '');
            expect(h.editor.collect().rule.requestBody).toEqual({ mode: 'static', body: '' });
        });

        test('JSON patch: the patch is parsed and no body is stored', () => {
            open();
            fillBasics();
            h.set('tmReqMode', 'patch');
            h.set('tmReqBody', 'ignored while patching');
            h.set('tmReqPatch', '{"debug": true, "user": {"role": null}}');
            const { rule, problems } = h.editor.collect();
            expect(problems).toEqual([]);
            expect(rule.requestBody).toEqual({ mode: 'patch', patch: { debug: true, user: { role: null } } });
        });

        test('JSON patch: malformed JSON is a problem on the patch field, not a crash', () => {
            open();
            fillBasics();
            h.set('tmReqMode', 'patch');
            h.set('tmReqPatch', '{"debug": ');
            const { problems } = h.editor.collect();
            expect(problems).toHaveLength(1);
            expect(problems[0].fieldId).toBe('tmReqPatch');
            expect(problems[0].message).toMatch(/^Request Body Patch: invalid JSON/);
        });

        test('match conditions on the rule are collected, as for mock/block/delay', () => {
            open();
            fillBasics();
            h.set('tmGraphql', 'placeOrder');
            h.set('tmMatchHeaders', '{"x-env": "dev"}');
            expect(h.editor.collect().rule.match).toMatchObject({
                graphql: { operationName: 'placeOrder' }, headers: { 'x-env': 'dev' }
            });
        });

        test('the type\'s own field is dropped when the type changes, and appliesTo is not invented', () => {
            open(bodyRule());
            h.set('tmType', 'delay');
            const { rule } = h.editor.collect();
            expect('requestBody' in rule).toBe(false);
            expect('appliesTo' in rule).toBe(false);
        });
    });

    describe('editing', () => {
        test('a stored replace-body rule fills the form (object body pretty-printed)', () => {
            open(bodyRule());
            expect(h.$('tmType').value).toBe('requestBody');
            expect(h.$('tmReqMode').value).toBe('static');
            expect(JSON.parse(h.$('tmReqBody').value)).toEqual({ id: 1 });
            expect(h.$('tmMethod').value).toBe('POST');
            expect(h.isShown('tmReqBodyField')).toBe(true);
        });

        test('a stored patch rule fills the patch and shows its field', () => {
            open(bodyRule({ requestBody: { mode: 'patch', patch: { debug: true } } }));
            expect(h.$('tmReqMode').value).toBe('patch');
            expect(JSON.parse(h.$('tmReqPatch').value)).toEqual({ debug: true });
            expect(h.isShown('tmReqPatchField')).toBe(true);
            expect(h.isShown('tmReqBodyField')).toBe(false);
        });

        test('an edit that changes nothing round-trips the rule, identity and unshown fields included', () => {
            const original = bodyRule({ imported: true, notes: 'qa', requestBody: { mode: 'static', body: { id: 1 }, extra: 'kept' } });
            open(original);
            expect(h.editor.collect().rule).toEqual(original);
        });

        test('switching the mode on an edit removes the other mode\'s data', () => {
            open(bodyRule());
            h.set('tmReqMode', 'patch');
            h.set('tmReqPatch', '{"a": 1}');
            expect(h.editor.collect().rule.requestBody).toEqual({ mode: 'patch', patch: { a: 1 } });
        });
    });

    describe('the method list', () => {
        const methodOption = (value) => Array.from(h.$('tmMethod').options).find((o) => o.value === value);

        test('GET and HEAD are not offered for this type, and come back for the others', () => {
            open();
            h.set('tmType', 'requestBody');
            for (const m of ['GET', 'HEAD']) {
                expect(methodOption(m).disabled).toBe(true);
                expect(methodOption(m).hidden).toBe(true);
            }
            for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '*']) {
                expect(methodOption(m).disabled).toBe(false);
            }
            h.set('tmType', 'mock');
            for (const m of ['GET', 'HEAD']) {
                expect(methodOption(m).disabled).toBe(false);
                expect(methodOption(m).hidden).toBe(false);
            }
        });

        test('a rule switched over from GET falls back to Any (*), which the schema allows', () => {
            open();
            h.set('tmMethod', 'GET');
            h.set('tmType', 'requestBody');
            expect(h.$('tmMethod').value).toBe('*');
            expect(h.editor.collect().rule.match.method).toBe('*');
        });

        test('a method that can carry a body is left alone', () => {
            open();
            h.set('tmMethod', 'PUT');
            h.set('tmType', 'requestBody');
            expect(h.$('tmMethod').value).toBe('PUT');
        });

        test('the reason is linked to the method select while it applies, and only then', () => {
            open();
            expect(h.$('tmMethod').hasAttribute('aria-describedby')).toBe(false);
            h.set('tmType', 'requestBody');
            expect(h.$('tmMethod').getAttribute('aria-describedby')).toBe('tmReqModeHint');
            expect(h.$('tmReqModeHint').textContent).toMatch(/GET and HEAD have no body/);
            h.set('tmType', 'block');
            expect(h.$('tmMethod').hasAttribute('aria-describedby')).toBe(false);
        });
    });

    test('a template with the flat requestBody fields fills the form', () => {
        const realTemplates = window.SpliceTapTemplates;
        window.SpliceTapTemplates = {
            listTemplates: () => [{ id: 'rb', label: 'Body', description: '' }],
            getTemplate: () => ({ type: 'requestBody', method: '*', url: '*/api/*', requestBodyMode: 'patch', requestBodyPatch: '{\n  "debug": true\n}' }),
            getStatusText: () => ''
        };
        try {
            open();
            h.set('tmTemplate', 'rb');
            expect(h.$('tmType').value).toBe('requestBody');
            expect(h.$('tmReqMode').value).toBe('patch');
            expect(h.editor.collect().rule.requestBody).toEqual({ mode: 'patch', patch: { debug: true } });
        } finally {
            window.SpliceTapTemplates = realTemplates;
        }
    });
});

describe('F3: fieldForError for the messages the schema produces', () => {
    const rb = { type: 'requestBody', requestBody: { mode: 'static' } };
    const rbPatch = { type: 'requestBody', requestBody: { mode: 'patch' } };

    test.each([
        ['Request body mode is required: "static" or "patch"', rb, 'tmReqMode'],
        ['Request body mode must be "static" or "patch", not "merge"', rb, 'tmReqMode'],
        ['Request body (static) needs a "body" — an empty string is allowed', rb, 'tmReqBody'],
        ['Request body (static) must be text, a JSON object or a JSON array', rb, 'tmReqBody'],
        ['Request body (static) is nested more than 64 levels deep, which cannot be stored reliably. Flatten it.', rb, 'tmReqBody'],
        ['Request body (patch) must be a JSON object, like {"debug": true}', rbPatch, 'tmReqPatch'],
        ['Request body (patch) is nested more than 64 levels deep, which cannot be stored reliably. Flatten it.', rbPatch, 'tmReqPatch'],
        // no part named: the mode select, which is always there
        ['Request body settings are required', rb, 'tmReqMode'],
        ['Request body settings are required', rbPatch, 'tmReqMode'],
        // GET/HEAD is about the method, not the body
        ['HTTP method for a request body rule cannot be GET or HEAD, because those requests carry no body. Use POST, PUT, PATCH, DELETE or Any (*).', rb, 'tmMethod']
    ])('%s -> %s', (message, rule, field) => {
        expect(fieldForError(message, rule)).toBe(field);
    });
});

// Once the schema group's change is merged these also run against the real
// validator, so the editor's field names cannot drift from its messages.
const schemaModule = require('../src/rule-schema');
const schemaKnowsRequestBody = schemaModule.RULE_TYPES.includes('requestBody');

(schemaKnowsRequestBody ? describe : describe.skip)('F3: fieldForError against the real schema', () => {
    const base = { name: 'x', type: 'requestBody', match: { url: '*/a*', method: 'POST' } };
    const deep = (n) => { let v = {}; for (let i = 0; i < n; i++) v = { a: v }; return v; };

    test.each([
        [{ ...base, requestBody: {} }, 'tmReqMode'],
        [{ ...base, requestBody: { mode: 'merge' } }, 'tmReqMode'],
        [{ ...base, requestBody: { mode: 'static' } }, 'tmReqBody'],
        [{ ...base, requestBody: { mode: 'static', body: deep(70) } }, 'tmReqBody'],
        [{ ...base, requestBody: { mode: 'patch', patch: [1] } }, 'tmReqPatch'],
        [{ ...base, requestBody: { mode: 'patch', patch: deep(70) } }, 'tmReqPatch'],
        [{ ...base, match: { url: '*/a*', method: 'GET' }, requestBody: { mode: 'static', body: '' } }, 'tmMethod']
    ])('rule %#', (rule, field) => {
        const verdict = schemaModule.validateRule(rule);
        expect(verdict.valid).toBe(false);
        expect(verdict.errors.map((m) => fieldForError(m, rule))).toContain(field);
    });
});

// ---- F4 ----------------------------------------------------------------------

const codeRule = (over = {}) => ({
    id: 'c1', name: 'Code', enabled: true, type: 'mock',
    match: { url: '*/api/*', method: '*' },
    response: { statusCode: 200, statusText: 'OK', headers: { 'X-Kept': '1' }, delay: 40, mode: 'code', code: 'return { id: await Promise.resolve(1) };' },
    hitCount: 2, created: '2026-01-01T00:00:00.000Z', ...over
});

describe('F4: code responses', () => {
    const open = async (rule, settings) => {
        h = mount({ settings });
        h.editor.open(rule ? { rule } : {});
        await settle();
    };

    test('the response mode select gains "Code (JavaScript)"', async () => {
        await open();
        expect(Array.from(h.$('tmMode').options).map((o) => [o.value, o.textContent])).toEqual([
            ['static', 'Static'], ['patch', 'Patch (merge into real)'], ['code', 'Code (JavaScript)']
        ]);
    });

    test('the code field is a left-to-right monospace textarea with the help and security lines', async () => {
        await open();
        const code = h.$('tmCode');
        expect(code.tagName).toBe('TEXTAREA');
        expect(code.getAttribute('dir')).toBe('ltr');
        expect(code.classList.contains('tm-code')).toBe(true);
        expect(code.getAttribute('spellcheck')).toBe('false');
        expect(h.$('tmCodeHint').textContent)
            .toBe('Body of an async function. request has url, method, headers, body, json. Return a body or {status, headers, body}.');
        expect(h.$('tmCodeHint').querySelector('code').textContent).toBe('request');
        expect(h.$('tmCodeSecurity').textContent).toBe('Runs inside the page you are testing.');
        expect(code.getAttribute('aria-describedby').split(' ')).toEqual(expect.arrayContaining(['tmCodeHint', 'tmCodeSecurity']));
    });

    test('code mode shows the code field only, hiding body, patch, status and response headers', async () => {
        await open();
        expect(h.isShown('tmCodeField')).toBe(false);
        h.set('tmMode', 'code');
        expect(h.isShown('tmCodeField')).toBe(true);
        expect(h.isShown('tmBodyField')).toBe(false);
        expect(h.isShown('tmPatchField')).toBe(false);
        expect(h.$('tmStatusField').style.display).toBe('none');
        expect(h.$('tmResHeadersField').style.display).toBe('none');
        // the delay still applies to a code response
        expect(h.$('tmDelay').closest('[data-types]').classList.contains('tm-visible')).toBe(true);

        h.set('tmMode', 'static');
        expect(h.isShown('tmCodeField')).toBe(false);
        expect(h.isShown('tmBodyField')).toBe(true);
        expect(h.$('tmStatusField').style.display).toBe('');
        expect(h.$('tmResHeadersField').style.display).toBe('');
    });

    test('code mode is for mock rules: no other type shows the code field', async () => {
        await open();
        h.set('tmMode', 'code');
        for (const type of ['block', 'delay', 'redirect', 'headers', 'queryparams', 'requestBody']) {
            h.set('tmType', type);
            expect(h.isShown('tmCodeField')).toBe(false);
        }
    });

    describe('collect', () => {
        const fillBasics = () => {
            h.set('tmName', 'Code mock');
            h.set('tmUrl', '*/api/code*');
            h.set('tmMode', 'code');
        };

        test('stores mode "code" and the code exactly as typed, with no body or patch', async () => {
            await open();
            fillBasics();
            const src = 'const n = request.json.n;\n  return { n };';
            h.set('tmCode', src);
            const { rule, problems } = h.editor.collect();
            expect(problems).toEqual([]);
            expect(rule.response).toMatchObject({ mode: 'code', code: src, delay: 0 });
            expect('body' in rule.response).toBe(false);
            expect('patch' in rule.response).toBe(false);
        });

        test('a blank code field is stored as the empty string, for the schema to refuse', async () => {
            await open();
            fillBasics();
            h.set('tmCode', '  \n ');
            expect(h.editor.collect().rule.response.code).toBe('');
        });

        test('the delay is kept; the hidden status falls back to 200 and invalid hidden headers do not block saving', async () => {
            await open();
            fillBasics();
            h.set('tmCode', 'return 1;');
            h.set('tmDelay', '250');
            h.set('tmStatus', 'banana');
            h.set('tmResHeaders', '{not json');
            const { rule, problems } = h.editor.collect();
            expect(problems).toEqual([]);
            expect(rule.response).toMatchObject({ delay: 250, statusCode: 200, headers: {} });
        });

        test('a visible bad delay is still a problem', async () => {
            await open();
            fillBasics();
            h.set('tmCode', 'return 1;');
            h.set('tmDelay', '1.5');
            expect(h.editor.collect().problems.map((p) => p.fieldId)).toEqual(['tmDelay']);
        });

        test('switching a code rule to static or patch drops the code', async () => {
            await open(codeRule());
            h.set('tmMode', 'static');
            h.set('tmBody', '{"a":1}');
            expect('code' in h.editor.collect().rule.response).toBe(false);
            h.set('tmMode', 'patch');
            h.set('tmPatch', '{"a":1}');
            expect('code' in h.editor.collect().rule.response).toBe(false);
        });

        test('switching a code mock to another type drops the response, code included', async () => {
            await open(codeRule());
            h.set('tmType', 'block');
            expect('response' in h.editor.collect().rule).toBe(false);
        });
    });

    describe('editing', () => {
        test('a stored code rule fills the code and shows its field', async () => {
            await open(codeRule());
            expect(h.$('tmMode').value).toBe('code');
            expect(h.$('tmCode').value).toBe('return { id: await Promise.resolve(1) };');
            expect(h.isShown('tmCodeField')).toBe(true);
            expect(h.$('tmDelay').value).toBe('40');
        });

        test('an edit that changes nothing keeps the rule, including the headers the form hides', async () => {
            const original = codeRule();
            await open(original);
            expect(h.editor.collect().rule).toEqual(original);
        });
    });

    describe('the "code responses are off" note', () => {
        const noteShown = () => !h.$('tmCodeOffNote').hidden;
        const NOTE = 'Code responses are off — turn them on in SpliceTap Settings.';

        test('shows, with the specified wording, when the setting is false', async () => {
            await open(codeRule(), { allowCodeResponses: false });
            expect(noteShown()).toBe(true);
            expect(h.$('tmCodeOffNote').textContent).toBe(NOTE);
        });

        test('shows when the setting is absent, as the gate treats anything but true as off', async () => {
            await open(codeRule(), { theme: 'auto' });
            expect(noteShown()).toBe(true);
        });

        test('is hidden when the setting is on', async () => {
            await open(codeRule(), { allowCodeResponses: true });
            expect(noteShown()).toBe(false);
        });

        test('is hidden when the settings could not be read, rather than claiming a state', async () => {
            h = mount({ settings: undefined });
            window.chrome.runtime.sendMessage.mockRejectedValue(new Error('no background'));
            h.editor.open({ rule: codeRule() });
            await settle();
            expect(noteShown()).toBe(false);
        });

        test('is linked to the code field while it shows, and only then', async () => {
            await open(codeRule(), { allowCodeResponses: false });
            expect(h.$('tmCode').getAttribute('aria-describedby').split(' ')).toContain('tmCodeOffNote');
            h.editor.close();
            h.cleanup();
            await open(codeRule(), { allowCodeResponses: true });
            expect(h.$('tmCode').getAttribute('aria-describedby').split(' ')).not.toContain('tmCodeOffNote');
        });

        test('it is read again on each open, so a changed setting is not shown stale', async () => {
            h = mount({ settings: { allowCodeResponses: false } });
            h.editor.open({ rule: codeRule() });
            await settle();
            expect(noteShown()).toBe(true);
            h.editor.close();
            window.chrome.runtime.sendMessage.mockImplementation(async () => ({ success: true, rules: [], settings: { allowCodeResponses: true } }));
            h.editor.open({ rule: codeRule() });
            // between open() and the reply, nothing from the last open is shown
            expect(noteShown()).toBe(false);
            await settle();
            expect(noteShown()).toBe(false);
        });
    });
});

describe('F4: fieldForError for the messages the schema produces', () => {
    test.each([
        ['Code response needs code: 1 to 20000 characters of JavaScript, written as the body of an async function.', 'tmCode'],
        ['Code response is too long (max 20000 characters).', 'tmCode'],
        ['Code response is only available on mock rules, not block rules', 'tmCode'],
        // the mode select, not the code, is at fault when the mode is not one of ours
        ['Response mode must be "static", "patch" or "code", not "eval"', 'tmMode']
    ])('%s -> %s', (message, field) => {
        expect(fieldForError(message, { type: 'mock' })).toBe(field);
    });
});

(schemaKnowsRequestBody ? describe : describe.skip)('F4: fieldForError against the real schema', () => {
    const mock = (response) => ({ name: 'x', type: 'mock', match: { url: '*/a*', method: '*' }, response });

    test.each([
        [mock({ mode: 'code' }), 'tmCode'],
        [mock({ mode: 'code', code: '' }), 'tmCode'],
        [mock({ mode: 'code', code: 'x'.repeat(20001) }), 'tmCode']
    ])('rule %#', (rule, field) => {
        const verdict = schemaModule.validateRule(rule);
        expect(verdict.valid).toBe(false);
        expect(verdict.errors.map((m) => fieldForError(m, rule))).toContain(field);
    });
});

(schemaKnowsRequestBody ? describe : describe.skip)('F1: fieldForError against the real schema', () => {
    const match = (extra = {}) => ({ url: '*/a*', method: '*', ...extra });

    test.each([
        [{ name: 'r', type: 'redirect', appliesTo: 'all', match: match(), redirect: { destination: '/relative' } }, 'tmRedirect'],
        [{ name: 'b', type: 'block', appliesTo: 'all', match: match({ headers: { 'x-env': 'dev' } }) }, 'tmAppliesAll'],
        [{ name: 'b', type: 'block', appliesTo: 'all', match: match({ graphql: { operationName: 'op' } }) }, 'tmAppliesAll'],
        [{ name: 'b', type: 'block', appliesTo: 'everything', match: match() }, 'tmAppliesAll'],
        [{ name: 'd', type: 'delay', appliesTo: 'all', match: match(), delayMs: 5 }, 'tmAppliesAll'],
        [{ name: 'b', type: 'block', appliesTo: 'all', match: match({ url: '*/ünï*' }) }, 'tmUrl']
    ])('rule %#', (rule, field) => {
        const verdict = schemaModule.validateRule(rule);
        expect(verdict.valid).toBe(false);
        expect(verdict.errors.map((m) => fieldForError(m, rule))).toContain(field);
    });
});
