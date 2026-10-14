/** @jest-environment jsdom */
/**
 * Editor feature group (G4a): F1 appliesTo checkbox, F3 "Modify request body",
 * F4 code responses. The form is mounted for real under jsdom (open shadow
 * root) and driven through its fields; `editor.collect()` is the rule the form
 * describes before the schema judges it. What needs a real Chrome (axe, the
 * closed overlay root, focus) is in tests/e2e/feat-editor.e2e.test.js.
 */

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
});
