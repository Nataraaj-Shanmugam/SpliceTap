/**
 * Batch 2, group G5 (editor), end to end, in both hosts of the one editor: the
 * in-page overlay (CLOSED shadow root, driven through CDP) and the options page
 * (OPEN root). F7/F8/F9/PER-66 fields, F10/PER-59 "Try a URL", PER-60 captured
 * response panel, PER-63 drafts. The pure form-to-rule mapping and the DOM
 * behaviour are in tests/b2-editor.test.js.
 */

const { launch, waitFor, sleep, auditA11y } = require('./harness');
const ed = require('./editor-driver');

const HOSTS = ['overlay', 'options'];

// The schema, background and interceptor changes for F7/F8/F9/PER-66/F10/PER-63
// are other groups' work and are not in this tree. A test that can only pass
// once they are merged is marked with this: it must FAIL here (test.failing
// passes when it does), and the coordinator flips it to a plain `test` after the
// merge. Do not put a test that already passes behind it.
const afterMerge = test; // flipped after the batch-2 merge

// ---- stubbing the background's side of the conversation ------------------------
// explainMatch and the draft messages are G1's. Until that merges, the editor's
// side is tested against a stub of chrome.runtime.sendMessage in the world the
// editor itself runs in: the extension page for the options host, the content
// script's ISOLATED world for the overlay (reached through CDP — page.evaluate
// runs in the page's own world and cannot see it).

const STUB_SOURCE = `(() => {
    if (globalThis.__b2Stub) return 'already';
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    const stub = globalThis.__b2Stub = { calls: [], canned: {}, drafts: false };
    chrome.runtime.sendMessage = (message, ...rest) => {
        const type = message && message.type;
        stub.calls.push(JSON.parse(JSON.stringify(message)));
        if (type && stub.canned[type] !== undefined) return Promise.resolve(stub.canned[type]);
        if (stub.drafts && type === 'saveEditorDraft') {
            return chrome.storage.local.set({ b2StubDraft: message.draft }).then(() => ({ success: true }));
        }
        if (stub.drafts && type === 'getEditorDraft') {
            return chrome.storage.local.get('b2StubDraft').then((r) => ({ success: true, draft: r.b2StubDraft || null }));
        }
        if (stub.drafts && type === 'clearEditorDraft') {
            return chrome.storage.local.remove('b2StubDraft').then(() => ({ success: true }));
        }
        return real(message, ...rest);
    };
    return 'installed';
})()`;

const setupStub = (stub) => `${STUB_SOURCE}; Object.assign(globalThis.__b2Stub, ${JSON.stringify(stub)});`;

/** Evaluate in the world the editor runs in: the content script's, or the extension page's. */
async function inEditorWorld(page, hostKind, extensionId, expression) {
    if (hostKind === 'options') return page.evaluate(expression);
    const client = await page.createCDPSession();
    try {
        const contexts = [];
        client.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
        await client.send('Runtime.enable');
        const ctx = contexts.find((c) => c.auxData && c.auxData.type === 'isolated'
            && String(c.origin).startsWith('chrome-extension://' + extensionId));
        if (!ctx) throw new Error('no content-script world on the page');
        const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
            contextId: ctx.id, expression, awaitPromise: true, returnByValue: true
        });
        if (exceptionDetails) throw new Error('evaluation in the content script failed: ' + (exceptionDetails.exception && exceptionDetails.exception.description || exceptionDetails.text));
        return result.value;
    } finally {
        await client.detach().catch(() => {});
    }
}

describe.each(HOSTS)('B2 editor fields — %s host', (hostKind) => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    beforeEach(async () => {
        await h.reset();
        await h.extensionEval(() => chrome.storage.local.remove('b2StubDraft'));
    });
    afterEach(async () => {
        if (page && !page.isClosed()) await page.close({ runBeforeUnload: false });
        page = null;
    });

    const inWorld = (expression) => inEditorWorld(page, hostKind, h.extensionId, expression);
    const stubCalls = async () => JSON.parse(await inWorld('JSON.stringify(globalThis.__b2Stub.calls)'));

    /** @param {{stub?: {canned?: object, drafts?: boolean}}} [extra] stand in for the background's side of explainMatch / the draft messages */
    async function openEditor(rule, { stub, payload } = {}) {
        if (rule) await h.saveRule(rule);
        if (hostKind === 'overlay') {
            page = await h.openPage();
            if (stub) await inWorld(setupStub(stub));
            await h.openOverlay(page, payload || (rule ? { mode: 'edit', rule } : { mode: 'new' }));
        } else {
            page = await h.browser.newPage();
            await page.setViewport({ width: 1100, height: 900 });
            if (stub) await page.evaluateOnNewDocument(setupStub(stub));
            const query = rule ? `?editRule=${encodeURIComponent(rule.id)}` : '?action=new';
            await page.goto(h.extUrl('options/options.html' + query), { waitUntil: 'load' });
        }
        await waitFor(() => ed.isOpen(page), { label: 'the editor to open' });
        await sleep(150);
        return page;
    }

    const stored = async () => (await h.bg({ type: 'getRules' })).rules;
    async function saveAndWait(predicate, label) {
        await ed.click(page, 'tmSave');
        return waitFor(async () => {
            const rules = await stored();
            return predicate(rules) ? rules : null;
        }, { label });
    }
    const shown = async () => new Set(await ed.visibleFieldIds(page));

    const seed = (over = {}) => ({
        id: 'seed-1', name: 'Seed', enabled: true, hitCount: 0, created: '2026-01-02T03:04:05.000Z', ...over
    });

    // ---- which fields show where -------------------------------------------

    test('the new fields show only on the rule types where they are valid', async () => {
        await openEditor();

        // a new mock rule: sites, payload and call filters; no resource types, no status override
        let ids = await shown();
        for (const id of ['tmPageDomains', 'tmPayloadPath', 'tmPayloadOp', 'tmPayloadValue', 'tmCallMode']) expect(ids.has(id)).toBe(true);
        expect(ids.has('tmPatchStatus')).toBe(false);
        expect(ids.has('tmRt_image')).toBe(false);
        expect(ids.has('tmCallN')).toBe(false); // no mode chosen yet

        await ed.fill(page, 'tmCallMode', 'every');
        expect((await shown()).has('tmCallN')).toBe(true);

        await ed.fill(page, 'tmMode', 'patch');
        expect((await shown()).has('tmPatchStatus')).toBe(true);
        await ed.fill(page, 'tmMode', 'static');
        expect((await shown()).has('tmPatchStatus')).toBe(false);

        // a new block rule is "all requests": resource types in, payload and call filters out
        await ed.fill(page, 'tmType', 'block');
        ids = await shown();
        expect(ids.has('tmRt_image')).toBe(true);
        expect(ids.has('tmPayloadPath')).toBe(false);
        expect(ids.has('tmCallMode')).toBe(false);
        expect(ids.has('tmPageDomains')).toBe(true);

        // unticking it swaps them
        await ed.fill(page, 'tmAppliesAll', false);
        ids = await shown();
        expect(ids.has('tmRt_image')).toBe(false);
        expect(ids.has('tmPayloadPath')).toBe(true);
        expect(ids.has('tmCallMode')).toBe(true);

        // headers and query rules: resource types, never the in-page filters
        for (const type of ['headers', 'queryparams']) {
            await ed.fill(page, 'tmType', type);
            ids = await shown();
            expect(ids.has('tmRt_script')).toBe(true);
            expect(ids.has('tmPayloadPath')).toBe(false);
            expect(ids.has('tmCallMode')).toBe(false);
            expect(ids.has('tmPageDomains')).toBe(true);
        }
        expect((await shown()).has('tmQpRemoveAll')).toBe(true);
        await ed.fill(page, 'tmType', 'headers');
        expect((await shown()).has('tmQpRemoveAll')).toBe(false);
    });

    // ---- a real Save carries the fields -------------------------------------

    test('F7 + PER-66: page domains, a payload filter and a call filter are saved from a real Save', async () => {
        await openEditor();
        await ed.fill(page, 'tmName', 'Targeted');
        await ed.fill(page, 'tmUrl', '*/api/b2*');
        await ed.fill(page, 'tmPageDomains', 'Example.com, app.test');
        await ed.fill(page, 'tmPayloadPath', 'user.id');
        await ed.fill(page, 'tmPayloadOp', 'contains');
        await ed.fill(page, 'tmPayloadValue', '42');
        await ed.fill(page, 'tmCallMode', 'after');
        await ed.fill(page, 'tmCallN', '2');
        await ed.fill(page, 'tmBody', '{"ok": true}');

        const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
        expect(rules[0].match.pageDomains).toEqual(['example.com', 'app.test']);
        expect(rules[0].match.payload).toEqual({ path: 'user.id', operator: 'contains', value: '42' });
        expect(rules[0].match.callFilter).toEqual({ mode: 'after', n: 2 });
    });

    test('F7 + PER-66: opening that rule again shows the same values', async () => {
        await openEditor(seed({
            type: 'mock',
            match: {
                url: '*/api/b2*', method: '*', pageDomains: ['example.com', 'app.test'],
                payload: { path: 'items.0.sku', operator: 'equals', value: 'A1' },
                callFilter: { mode: 'every', n: 4 }
            },
            response: { statusCode: 200, headers: {}, body: { ok: 1 }, delay: 0, mode: 'static' }
        }));
        expect(await ed.value(page, 'tmPageDomains')).toBe('example.com\napp.test');
        expect(await ed.value(page, 'tmPayloadPath')).toBe('items.0.sku');
        expect(await ed.value(page, 'tmPayloadOp')).toBe('equals');
        expect(await ed.value(page, 'tmPayloadValue')).toBe('A1');
        expect(await ed.value(page, 'tmCallMode')).toBe('every');
        expect(await ed.value(page, 'tmCallN')).toBe('4');
    });

    test('F7: resource types on a headers rule are saved from a real Save', async () => {
        await openEditor();
        await ed.fill(page, 'tmType', 'headers');
        await ed.fill(page, 'tmName', 'Typed headers');
        await ed.fill(page, 'tmUrl', '*/assets/*');
        await ed.fill(page, 'tmHdrRes', '[{"op":"set","name":"X-B2","value":"1"}]');
        await ed.fill(page, 'tmRt_image', true);
        await ed.fill(page, 'tmRt_stylesheet', true);
        const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
        expect(rules[0].match.resourceTypes).toEqual(['stylesheet', 'image']);
    });

    test('F7: ticked resource types come back ticked; unticking "all requests" drops them from the saved rule', async () => {
        await openEditor(seed({
            type: 'block', appliesTo: 'all',
            match: { url: '*/ads/*', method: '*', resourceTypes: ['script', 'image'] }
        }));
        expect(await ed.value(page, 'tmRt_script')).toBe(true);
        expect(await ed.value(page, 'tmRt_image')).toBe(true);
        expect(await ed.value(page, 'tmRt_font')).toBe(false);

        await ed.fill(page, 'tmAppliesAll', false);
        const rules = await saveAndWait((r) => r[0] && r[0].appliesTo === 'page', 'the rule to save');
        expect(rules[0].match).not.toHaveProperty('resourceTypes');
    });

    test('F8: a status override is saved in patch mode only', async () => {
        await openEditor();
        await ed.fill(page, 'tmName', 'Patch with status');
        await ed.fill(page, 'tmUrl', '*/api/patch*');
        await ed.fill(page, 'tmMode', 'patch');
        await ed.fill(page, 'tmPatch', '{"data": null}');
        await ed.fill(page, 'tmPatchStatus', '503');
        const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
        expect(rules[0].response.mode).toBe('patch');
        expect(rules[0].response.patchStatus).toBe(503);
    });

    afterMerge('F9: an append op in the response headers is accepted and saved', async () => {
        await openEditor();
        await ed.fill(page, 'tmType', 'headers');
        await ed.fill(page, 'tmName', 'Append cookie');
        await ed.fill(page, 'tmUrl', '*/api/*');
        await ed.fill(page, 'tmHdrRes', '[{"op":"append","name":"X-B2","value":"a"}]');
        const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
        expect(rules[0].headersMod.response).toEqual([{ op: 'append', name: 'X-B2', value: 'a' }]);
    });

    afterMerge('F9: "Remove all query parameters" alone is a valid rule', async () => {
        await openEditor();
        await ed.fill(page, 'tmType', 'queryparams');
        await ed.fill(page, 'tmName', 'Strip query');
        await ed.fill(page, 'tmUrl', '*/api/*');
        await ed.fill(page, 'tmQpRemoveAll', true);
        const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
        expect(rules[0].queryParams.removeAll).toBe(true);
    });

    // ---- failed saves are marked on the field --------------------------------

    test('PER-66: a call filter number that is not whole marks its field, describes it and takes focus', async () => {
        await openEditor();
        await ed.fill(page, 'tmName', 'Bad call filter');
        await ed.fill(page, 'tmUrl', '*/api/*');
        await ed.fill(page, 'tmCallMode', 'first');
        await ed.fill(page, 'tmCallN', '2.5');
        await ed.click(page, 'tmSave');
        await waitFor(async () => /whole number/.test(await ed.errorText(page)), { label: 'the error' });

        const state = await ed.inShadow(page, (root) => {
            const el = root.getElementById('tmCallN');
            return {
                invalid: el.getAttribute('aria-invalid'),
                described: el.getAttribute('aria-describedby'),
                errText: root.getElementById('tmCallNErr') && root.getElementById('tmCallNErr').textContent,
                focused: root.activeElement === el
            };
        });
        expect(state.invalid).toBe('true');
        expect(state.described).toContain('tmCallNErr');
        expect(state.described).toContain('tmCallHint');
        expect(state.errText).toMatch(/whole number/);
        expect(state.focused).toBe(true);
        expect(await stored()).toEqual([]);
    });

    // ---- F10 / PER-59: Try a URL ---------------------------------------------

    const tryText = () => ed.inShadow(page, (root) => root.getElementById('tmTryResult').textContent);

    test('F10: Check sends explainMatch with the form\'s rule, the URL and the method, and the answer is listed', async () => {
        await openEditor(null, { stub: { canned: { explainMatch: {
            success: true,
            url: 'http://127.0.0.1/api/users/7',
            result: { matches: true, checks: [
                { condition: 'url', ok: true, detail: 'The URL matches the pattern.' },
                { condition: 'method', ok: false, detail: 'The rule is for POST, but this request is GET.' }
            ] },
            shadowedBy: [{ ruleId: 'e1', ruleName: 'Earlier mock' }],
            network: true
        } } } });
        await ed.fill(page, 'tmName', 'Users');
        await ed.fill(page, 'tmUrl', '*/api/users/*');
        await ed.fill(page, 'tmTryUrl', 'http://127.0.0.1/api/users/7');
        await ed.fill(page, 'tmTryMethod', 'GET');
        await ed.click(page, 'tmTryCheck');
        await waitFor(async () => /would handle/.test(await tryText()), { label: 'the result' });

        const text = await tryText();
        expect(text).toContain('This rule would handle http://127.0.0.1/api/users/7');
        expect(text).toContain('✓Passed: The URL matches the pattern.');
        expect(text).toContain('✗Failed: The rule is for POST, but this request is GET.');
        expect(text).toContain("Would be handled by Chrome's network layer");
        expect(text).toContain('An earlier rule, Earlier mock, also matches this request and takes precedence');

        const [call] = (await stubCalls()).filter((m) => m.type === 'explainMatch');
        expect(call.url).toBe('http://127.0.0.1/api/users/7');
        expect(call.method).toBe('GET');
        expect(call.rule).toMatchObject({ name: 'Users', type: 'mock', match: { url: '*/api/users/*' } });
        // nothing was saved by trying
        expect(await stored()).toEqual([]);
    });

    test('F10: the result sits in a polite live region, and typing in the box does not make the form dirty', async () => {
        await openEditor(null, { stub: { canned: { explainMatch: { success: true, url: 'http://x/', result: { matches: false, checks: [] }, shadowedBy: [], network: false } } } });
        const region = await ed.inShadow(page, (root) => {
            const el = root.getElementById('tmTryResult');
            return { role: el.getAttribute('role'), live: el.getAttribute('aria-live') };
        });
        expect(region).toEqual({ role: 'status', live: 'polite' });

        await ed.fill(page, 'tmTryUrl', 'http://x/');
        await ed.click(page, 'tmTryCheck');
        await waitFor(async () => /would not handle/.test(await tryText()), { label: 'the result' });
        await page.keyboard.press('Escape'); // a clean form closes at once
        await waitFor(async () => !(await ed.isOpen(page)), { label: 'the editor to close' });
    });

    afterMerge('F10: with the real background, a matching and a non-matching URL are told apart', async () => {
        await openEditor();
        await ed.fill(page, 'tmName', 'Users');
        await ed.fill(page, 'tmUrl', '*/api/users/*');
        await ed.fill(page, 'tmTryUrl', 'http://127.0.0.1/api/users/7');
        await ed.click(page, 'tmTryCheck');
        await waitFor(async () => /would handle/.test(await tryText()), { label: 'the match' });
        expect(await tryText()).toMatch(/✓/);

        await ed.fill(page, 'tmTryUrl', 'http://127.0.0.1/other');
        await ed.click(page, 'tmTryCheck');
        await waitFor(async () => /would not handle/.test(await tryText()), { label: 'the non-match' });
        expect(await tryText()).toMatch(/✗/);
    });

    // ---- PER-63: restorable drafts ---------------------------------------------

    const draftStub = { drafts: true };
    const storedDraft = async () => (await h.extensionEval(() => chrome.storage.local.get('b2StubDraft'))).b2StubDraft || null;
    const bannerText = () => ed.inShadow(page, (root) => {
        const bar = root.getElementById('tmDraftBar');
        return bar.hidden ? null : root.getElementById('tmDraftText').textContent;
    });

    /** Reload the page the way a dev server does, and open the editor again. */
    async function reloadAndReopen({ stub, realBackground } = {}) {
        const dialogs = [];
        const onDialog = async (d) => { dialogs.push(d.type()); await d.accept(); };
        page.on('dialog', onDialog);
        await page.reload({ waitUntil: 'load' });
        page.off('dialog', onDialog);
        if (hostKind === 'overlay') {
            if (stub && !realBackground) await inWorld(setupStub(stub));
            await h.openOverlay(page, { mode: 'new' });
        }
        await waitFor(() => ed.isOpen(page), { label: 'the editor to open again' });
        await sleep(200);
        return dialogs;
    }

    test('PER-63: a dirty form is kept as a draft; after a reload the editor offers it back, and Restore puts it back', async () => {
        await openEditor(null, { stub: draftStub });
        await ed.fill(page, 'tmName', 'Kept across reload');
        await ed.fill(page, 'tmUrl', '*/api/kept*');
        await ed.fill(page, 'tmType', 'delay');
        await ed.fill(page, 'tmDelayMs', '1500');
        await waitFor(async () => (await storedDraft()) !== null, { timeout: 4000, label: 'the draft to be kept (800 ms debounce)' });
        const draft = await storedDraft();
        expect(draft.values).toMatchObject({ tmName: 'Kept across reload', tmUrl: '*/api/kept*', tmType: 'delay' });

        // the reload raises no "leave site?" prompt, and nothing is lost
        const dialogs = await reloadAndReopen({ stub: draftStub });
        expect(dialogs).toEqual([]);
        await waitFor(async () => (await bannerText()) !== null, { label: 'the offer' });
        expect(await bannerText()).toBe("Restore your unsaved rule 'Kept across reload'?");
        expect(await ed.value(page, 'tmName')).toBe(''); // not applied until asked

        await ed.click(page, 'tmDraftRestore');
        expect(await ed.value(page, 'tmName')).toBe('Kept across reload');
        expect(await ed.value(page, 'tmUrl')).toBe('*/api/kept*');
        expect(await ed.value(page, 'tmType')).toBe('delay');
        expect(await ed.value(page, 'tmDelayMs')).toBe('1500');
        expect(await bannerText()).toBeNull();
        expect(await ed.activeElementId(page)).toBe('tmName');

        // saving the restored rule ends the draft
        const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
        expect(rules[0]).toMatchObject({ name: 'Kept across reload', type: 'delay', delayMs: 1500 });
        await waitFor(async () => (await storedDraft()) === null, { label: 'the draft to be cleared on save' });
    });

    test('PER-63: Discard removes the draft and leaves a blank form', async () => {
        await openEditor(null, { stub: draftStub });
        await ed.fill(page, 'tmName', 'Throw me away');
        await waitFor(async () => (await storedDraft()) !== null, { timeout: 4000, label: 'the draft' });
        await reloadAndReopen({ stub: draftStub });
        await waitFor(async () => (await bannerText()) !== null, { label: 'the offer' });

        await ed.click(page, 'tmDraftDiscard');
        await waitFor(async () => (await storedDraft()) === null, { label: 'the draft to be cleared' });
        expect(await bannerText()).toBeNull();
        expect(await ed.value(page, 'tmName')).toBe('');
        expect(await ed.activeElementId(page)).toBe('tmName');
    });

    test('PER-63: Cancel after typing clears the draft, and nothing is offered the next time', async () => {
        await openEditor(null, { stub: draftStub });
        await ed.fill(page, 'tmName', 'Cancelled');
        await waitFor(async () => (await storedDraft()) !== null, { timeout: 4000, label: 'the draft' });
        await ed.click(page, 'tmCancel');
        await waitFor(async () => (await storedDraft()) === null, { label: 'the draft to be cleared on cancel' });
        await reloadAndReopen({ stub: draftStub });
        expect(await bannerText()).toBeNull();
    });

    test('PER-63: closing the offer\'s editor without answering is a clean close and clears it', async () => {
        await openEditor(null, { stub: draftStub });
        await ed.fill(page, 'tmName', 'Unanswered');
        await waitFor(async () => (await storedDraft()) !== null, { timeout: 4000, label: 'the draft' });
        await reloadAndReopen({ stub: draftStub });
        await waitFor(async () => (await bannerText()) !== null, { label: 'the offer' });
        await page.keyboard.press('Escape');
        await waitFor(async () => !(await ed.isOpen(page)), { label: 'the editor to close' });
        await waitFor(async () => (await storedDraft()) === null, { label: 'the draft to be cleared' });
    });

    test('PER-63: the banner is a labelled group with the question in a polite status, and Restore/Discard are buttons', async () => {
        await openEditor(null, { stub: draftStub });
        await ed.fill(page, 'tmName', 'Semantics');
        await waitFor(async () => (await storedDraft()) !== null, { timeout: 4000, label: 'the draft' });
        await reloadAndReopen({ stub: draftStub });
        await waitFor(async () => (await bannerText()) !== null, { label: 'the offer' });
        const shape = await ed.inShadow(page, (root) => {
            const bar = root.getElementById('tmDraftBar');
            const text = root.getElementById('tmDraftText');
            return {
                role: bar.getAttribute('role'),
                labelledby: bar.getAttribute('aria-labelledby'),
                live: text.getAttribute('aria-live'),
                statusRole: text.getAttribute('role'),
                buttons: Array.from(bar.querySelectorAll('button')).map((b) => [b.type, b.textContent])
            };
        });
        expect(shape).toEqual({
            role: 'group', labelledby: 'tmDraftText', live: 'polite', statusRole: 'status',
            buttons: [['button', 'Restore'], ['button', 'Discard']]
        });
    });

    afterMerge('PER-63: with the real background, a draft survives a reload and is offered back', async () => {
        await openEditor();
        await ed.fill(page, 'tmName', 'Real draft');
        await sleep(1500); // the 800 ms debounce, and the round trip
        await reloadAndReopen({ realBackground: true });
        await waitFor(async () => (await bannerText()) !== null, { label: 'the offer' });
        expect(await bannerText()).toBe("Restore your unsaved rule 'Real draft'?");
        await ed.click(page, 'tmDraftDiscard');
        await reloadAndReopen({ realBackground: true });
        expect(await bannerText()).toBeNull();
    });

    afterMerge('PER-59: with the real background, an earlier rule that also matches is named in a warning', async () => {
        await h.saveRule(seed({
            id: 'earlier', name: 'Earlier rule', type: 'mock',
            match: { url: '*/api/users/*', method: '*' },
            response: { statusCode: 200, headers: {}, body: {}, delay: 0, mode: 'static' }
        }));
        await openEditor();
        await ed.fill(page, 'tmName', 'Later rule');
        await ed.fill(page, 'tmUrl', '*/api/users/*');
        await ed.fill(page, 'tmTryUrl', 'http://127.0.0.1/api/users/7');
        await ed.click(page, 'tmTryCheck');
        await waitFor(async () => /An earlier rule, Earlier rule, also matches this request and takes precedence/.test(await tryText()), { label: 'the warning' });
    });
});

describe('PER-60 captured response panel (overlay host, as the popup opens it)', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    beforeEach(async () => { await h.reset(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close({ runBeforeUnload: false }); page = null; });

    async function openWithReference(referenceBody) {
        page = await h.openPage();
        await h.openOverlay(page, { mode: 'new', ...(referenceBody === undefined ? {} : { referenceBody }) });
        await waitFor(() => ed.isOpen(page), { label: 'the editor to open' });
        await sleep(150);
    }

    const panel = () => ed.inShadow(page, (root) => {
        const field = root.getElementById('tmRefField');
        const box = root.getElementById('tmRefBody');
        const toggle = root.getElementById('tmRefToggle');
        const cs = window.getComputedStyle(box);
        return {
            shown: field.offsetParent !== null,
            value: box.value,
            readOnly: box.readOnly,
            expanded: toggle.getAttribute('aria-expanded'),
            boxVisible: box.offsetParent !== null,
            direction: cs.direction,
            fontFamily: cs.fontFamily,
            beforeBody: field.nextElementSibling.id
        };
    });

    test('the body text from a capture shows in a read-only, monospace, left-to-right panel before the body field', async () => {
        await openWithReference('{"id":7,"items":[1,2]}');
        const p = await panel();
        expect(p.shown).toBe(true);
        expect(p.readOnly).toBe(true);
        expect(JSON.parse(p.value)).toEqual({ id: 7, items: [1, 2] });
        expect(p.direction).toBe('ltr');
        expect(p.fontFamily).toMatch(/mono|Consolas|Menlo/i);
        expect(p.beforeBody).toBe('tmBodyField');
    });

    test('it can be collapsed and expanded with the keyboard, and typing into it changes nothing', async () => {
        await openWithReference('hello');
        await ed.inShadow(page, (root) => root.getElementById('tmRefToggle').focus());
        await page.keyboard.press('Enter');
        expect((await panel()).expanded).toBe('false');
        expect((await panel()).boxVisible).toBe(false);
        await page.keyboard.press('Space');
        expect((await panel()).expanded).toBe('true');
        expect((await panel()).boxVisible).toBe(true);

        await ed.inShadow(page, (root) => root.getElementById('tmRefBody').focus());
        await page.keyboard.type('zzz');
        expect((await panel()).value).toBe('hello');
    });

    test('with the patch field showing, the panel is still on screen beside it', async () => {
        await openWithReference('{"a":1}');
        await ed.fill(page, 'tmMode', 'patch');
        const p = await panel();
        expect(p.shown).toBe(true);
        expect(p.beforeBody).toBe('tmBodyField');
        expect(await ed.visibleFieldIds(page)).toContain('tmPatch');
    });

    test('there is no panel when the editor is opened without a capture', async () => {
        await openWithReference(undefined);
        expect((await panel()).shown).toBe(false);
    });

    test('a mock written beside the panel saves as an ordinary rule, without the capture in it', async () => {
        await openWithReference('{"secret-ish":"CAPTURED-MARKER"}');
        await ed.fill(page, 'tmName', 'From capture');
        await ed.fill(page, 'tmUrl', '*/api/cap*');
        await ed.fill(page, 'tmBody', '{"ok": true}');
        await ed.click(page, 'tmSave');
        const rules = await waitFor(async () => {
            const r = (await h.bg({ type: 'getRules' })).rules;
            return r.length === 1 ? r : null;
        }, { label: 'the rule to save' });
        expect(JSON.stringify(rules[0])).not.toContain('CAPTURED-MARKER');
    });
});

describe('B2 editor fields — accessibility (options host, open shadow root)', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    async function openOnOptionsPage(theme, { draft } = {}) {
        await h.reset();
        await h.bg({ type: 'settingsUpdated', settings: { theme } });
        // a kept draft for the restore offer, or none
        await h.extensionEval((d) => (d ? chrome.storage.local.set({ b2StubDraft: d }) : chrome.storage.local.remove('b2StubDraft')), draft || null);
        page = await h.browser.newPage();
        await page.setViewport({ width: 1100, height: 900 });
        // a canned answer for "Try a URL": failed and passed checks, a network note, two shadowing rules
        await page.evaluateOnNewDocument(setupStub({ canned: { explainMatch: {
            success: true,
            url: 'https://example.com/api/users/1',
            result: { matches: true, checks: [
                { condition: 'url', ok: true, detail: 'The URL matches the pattern.' },
                { condition: 'method', ok: false, detail: 'The rule is for POST, but this request is GET.' }
            ] },
            shadowedBy: [{ ruleId: 'a', ruleName: 'Earlier mock' }, { ruleId: 'b', ruleName: 'Another one' }],
            network: true
        } }, drafts: true }));
        await page.goto(h.extUrl('options/options.html?action=new'), { waitUntil: 'load' });
        await waitFor(() => ed.isOpen(page), { label: 'the editor to open' });
        await sleep(300);
    }

    const audit = async (label, violations) => {
        for (const v of await auditA11y(page)) violations.push({ state: label, ...v });
    };

    test.each(['dark', 'light'])('"Try a URL" — empty, expanded and with a result — has no WCAG A/AA violations (%s)', async (theme) => {
        await openOnOptionsPage(theme);
        const violations = [];
        await audit('try box, empty', violations);

        await ed.inShadow(page, (root) => { root.querySelector('#tmTry details').open = true; });
        await audit('try box, more details open', violations);

        await ed.fill(page, 'tmUrl', '*/api/users/*');
        await ed.fill(page, 'tmTryUrl', 'https://example.com/api/users/1');
        await ed.click(page, 'tmTryCheck');
        await waitFor(async () => ed.inShadow(page, (root) => /would handle/.test(root.getElementById('tmTryResult').textContent)), { label: 'the result' });
        await sleep(150);
        await audit('try box, with a result', violations);
        expect(violations).toEqual([]);
    });

    test.each(['dark', 'light'])('the restore-draft offer has no WCAG A/AA violations (%s)', async (theme) => {
        await openOnOptionsPage(theme, { draft: { v: 1, name: 'Offered', editingRule: null, values: { tmType: 'mock', tmName: 'Offered', tmUrl: '*/a*' } } });
        await waitFor(async () => ed.inShadow(page, (root) => !root.getElementById('tmDraftBar').hidden && root.getElementById('tmDraftText').textContent !== ''), { label: 'the offer' });
        const violations = [];
        await audit('restore offer showing', violations);
        await ed.click(page, 'tmDraftRestore');
        await audit('after Restore', violations);
        expect(violations).toEqual([]);
        await h.extensionEval(() => chrome.storage.local.remove('b2StubDraft'));
    });

    test.each(['dark', 'light'])('the captured-response panel, expanded and collapsed, has no WCAG A/AA violations (%s)', async (theme) => {
        await openOnOptionsPage(theme);
        // The options host is never handed a capture; put the panel in the state
        // setReference() leaves it in, so its markup and colours are audited.
        await ed.inShadow(page, (root) => {
            root.getElementById('tmRefField').style.display = '';
            root.getElementById('tmRefBody').value = '{\n  "id": 1\n}';
        });
        const violations = [];
        await audit('captured response, expanded', violations);
        await ed.click(page, 'tmRefToggle');
        await audit('captured response, collapsed', violations);
        expect(violations).toEqual([]);
    });

    test.each(['dark', 'light'])('every new field and its error state has no WCAG A/AA violations (%s)', async (theme) => {
        await openOnOptionsPage(theme);
        const violations = [];

        // mock, static: sites, payload and call filters
        await ed.fill(page, 'tmCallMode', 'every');
        await audit('mock, static, call filter set', violations);

        // mock, patch: the status override
        await ed.fill(page, 'tmMode', 'patch');
        await audit('mock, patch, status override', violations);
        await ed.fill(page, 'tmMode', 'static');

        // block, all requests: resource types
        await ed.fill(page, 'tmType', 'block');
        await ed.fill(page, 'tmRt_image', true);
        await audit('block, all requests, resource types', violations);
        await ed.fill(page, 'tmAppliesAll', false);
        await audit('block, page only, payload and call filters', violations);

        // headers (hints for append), query rules (remove all)
        await ed.fill(page, 'tmType', 'headers');
        await audit('headers, resource types and append hint', violations);
        await ed.fill(page, 'tmType', 'queryparams');
        await ed.fill(page, 'tmQpRemoveAll', true);
        await audit('queryparams, remove all', violations);

        // an error on a new field (a call filter number that is not whole)
        await ed.fill(page, 'tmType', 'delay');
        await ed.fill(page, 'tmName', 'x');
        await ed.fill(page, 'tmUrl', '*/a*');
        await ed.fill(page, 'tmCallMode', 'first');
        await ed.fill(page, 'tmCallN', '1.5');
        await ed.click(page, 'tmSave');
        await waitFor(async () => /whole number/.test(await ed.errorText(page)), { label: 'the error state' });
        await audit('delay, call filter error', violations);

        expect(violations).toEqual([]);
    });
});
