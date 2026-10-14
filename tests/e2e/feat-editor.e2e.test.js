/**
 * Editor feature group (G4a), end to end, in both hosts of the one editor:
 * the in-page overlay (CLOSED shadow root, driven through CDP) and the options
 * page (OPEN root). F1 appliesTo checkbox, F3 "Modify request body", F4 code
 * responses. The pure form-to-rule mapping is in tests/feat-editor.test.js.
 */

const { launch, pageFetch, waitFor, sleep, auditA11y } = require('./harness');
const ed = require('./editor-driver');

const HOSTS = ['overlay', 'options'];

// TODO(coordinator): the schema group's change (type 'requestBody', response
// mode 'code', the appliesTo rules) is not in this worktree, so the current
// schema refuses what these tests save and they are expected to fail here.
// After the merge, change this line to `const afterSchemaMerge = test;`.
const afterSchemaMerge = test.failing;
// TODO(coordinator): the two tests that go on to send a real request also need
// the interceptor's runtime (requestBody rules, code responses) and the network
// group's plumbing. After those merge, `const afterRuntimeMerge = test;`.
// (Checked against the schema group's files alone: every afterSchemaMerge
// test passes and only these four, two per host, still fail.)
const afterRuntimeMerge = test.failing;

describe.each(HOSTS)('editor features — %s host', (hostKind) => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    beforeEach(async () => { await h.reset(); });
    const opened = []; // extra pages a test opened; a stale one would answer the next test's openOverlay
    afterEach(async () => {
        for (const p of opened.splice(0)) if (!p.isClosed()) await p.close();
        if (page && !page.isClosed()) await page.close();
        page = null;
    });

    async function openEditor(rule) {
        if (rule) await h.saveRule(rule);
        if (hostKind === 'overlay') {
            page = await h.openPage();
            await h.openOverlay(page, rule ? { mode: 'edit', rule } : { mode: 'new' });
        } else {
            page = await h.browser.newPage();
            await page.setViewport({ width: 1100, height: 900 });
            const query = rule ? `?editRule=${encodeURIComponent(rule.id)}` : '?action=new';
            await page.goto(h.extUrl('options/options.html' + query), { waitUntil: 'load' });
        }
        await waitFor(() => ed.isOpen(page), { label: 'the editor to open' });
        await sleep(100);
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

    const baseRule = (over = {}) => ({
        id: 'seed-1', name: 'Seed', enabled: true,
        match: { url: '*/api/seed*', method: '*' },
        hitCount: 0, created: '2026-01-02T03:04:05.000Z', ...over
    });

    // ---- F1: appliesTo -----------------------------------------------------------

    describe('F1: "Also apply to scripts, images, styles and pages"', () => {
        test.each(['redirect', 'block'])('is offered for %s with its hint linked, and for no other type', async (type) => {
            await openEditor();
            for (const other of ['mock', 'delay', 'headers', 'queryparams']) {
                await ed.fill(page, 'tmType', other);
                expect(await ed.visibleFieldIds(page)).not.toContain('tmAppliesAll');
            }
            await ed.fill(page, 'tmType', type);
            expect(await ed.visibleFieldIds(page)).toContain('tmAppliesAll');

            const wiring = await ed.inShadow(page, (root) => {
                const box = root.getElementById('tmAppliesAll');
                const hint = root.getElementById(box.getAttribute('aria-describedby'));
                return { label: box.closest('label').textContent.trim(), hint: hint && hint.textContent };
            });
            expect(wiring.label).toBe('Also apply to scripts, images, styles and pages');
            expect(wiring.hint).toBe("fetch/XHR are handled in the page; everything else by Chrome's network layer.");
        });

        test.each([
            ['redirect', [['tmRedirect', 'https://example.test/elsewhere']]],
            ['block', []]
        ])('a new %s rule is ticked by default and saves appliesTo "all"', async (type, fields) => {
            await openEditor();
            await ed.fill(page, 'tmType', type);
            await ed.fill(page, 'tmName', `New ${type}`);
            await ed.fill(page, 'tmUrl', '*/api/everything*');
            for (const [id, v] of fields) await ed.fill(page, id, v);
            expect(await ed.value(page, 'tmAppliesAll')).toBe(true);
            const rules = await saveAndWait((r) => r.length === 1, `the ${type} rule to save`);
            expect(rules[0]).toMatchObject({ type, appliesTo: 'all' });
        });

        test.each([
            ['redirect', [['tmRedirect', 'https://example.test/elsewhere']]],
            ['block', []]
        ])('unticking a new %s rule saves appliesTo "page"', async (type, fields) => {
            await openEditor();
            await ed.fill(page, 'tmType', type);
            await ed.fill(page, 'tmName', `Page-only ${type}`);
            await ed.fill(page, 'tmUrl', '*/api/pageonly*');
            for (const [id, v] of fields) await ed.fill(page, id, v);
            await ed.fill(page, 'tmAppliesAll', false);
            const rules = await saveAndWait((r) => r.length === 1, `the ${type} rule to save`);
            expect(rules[0]).toMatchObject({ type, appliesTo: 'page' });
        });

        test.each([
            ['absent', undefined, false],
            ['"page"', 'page', false],
            ['"all"', 'all', true]
        ])('editing a stored redirect with appliesTo %s shows the checkbox as %s', async (label, appliesTo, ticked) => {
            const seed = baseRule({ type: 'redirect', redirect: { destination: 'https://example.test/x' } });
            if (appliesTo) seed.appliesTo = appliesTo;
            await openEditor(seed);
            expect(await ed.value(page, 'tmAppliesAll')).toBe(ticked);
        });

        test('editing a block rule and ticking the box stores "all", and the edit keeps its identity', async () => {
            await openEditor(baseRule({ type: 'block', hitCount: 7 }));
            expect(await ed.value(page, 'tmAppliesAll')).toBe(false);
            await ed.fill(page, 'tmAppliesAll', true);
            const rules = await saveAndWait((r) => r[0] && r[0].appliesTo === 'all', 'the edit to save');
            expect(rules).toHaveLength(1);
            expect(rules[0]).toMatchObject({ id: 'seed-1', type: 'block', hitCount: 7 });
        });

        afterSchemaMerge('a new block rule with a header condition is refused beside the checkbox, and saves once it is unticked', async () => {
            // "All requests" cannot be combined with header/GraphQL conditions
            // (only fetch/XHR can be checked against them). The editor does
            // not untick the box for the user; it shows the schema's refusal
            // on it, takes focus there, and lets the user choose.
            await openEditor();
            await ed.fill(page, 'tmType', 'block');
            await ed.fill(page, 'tmName', 'Block dev only');
            await ed.fill(page, 'tmUrl', '*/api/x*');
            await ed.fill(page, 'tmMatchHeaders', '{"x-env": "dev"}');
            await ed.click(page, 'tmSave');
            await waitFor(async () => /apply to all requests/i.test(await ed.errorText(page)), { label: 'the schema refusal' });
            expect(await ed.activeElementId(page)).toBe('tmAppliesAll');
            expect(await ed.inShadow(page, (root) => root.getElementById('tmAppliesAll').getAttribute('aria-invalid'))).toBe('true');
            expect(await stored()).toEqual([]);

            await ed.fill(page, 'tmAppliesAll', false);
            const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
            expect(rules[0]).toMatchObject({ appliesTo: 'page', match: { headers: { 'x-env': 'dev' } } });
        });

        afterSchemaMerge('a new redirect with a root-relative destination is refused on the destination field', async () => {
            await openEditor();
            await ed.fill(page, 'tmType', 'redirect');
            await ed.fill(page, 'tmName', 'Relative');
            await ed.fill(page, 'tmUrl', '*/api/rel*');
            await ed.fill(page, 'tmRedirect', '/other');
            await ed.click(page, 'tmSave');
            await waitFor(async () => /Use a full URL/.test(await ed.errorText(page)), { label: 'the schema refusal' });
            expect(await ed.activeElementId(page)).toBe('tmRedirect');
            expect(await stored()).toEqual([]);
        });
    });

    // ---- F3: Modify request body ---------------------------------------------------

    describe('F3: Modify request body', () => {
        const ownFields = ['tmReqMode', 'tmReqBody', 'tmReqPatch'];

        async function pickType() {
            await openEditor();
            await ed.fill(page, 'tmType', 'requestBody');
        }

        test('the type is offered, and picking it shows the mode and body fields in place of the mock ones', async () => {
            await openEditor();
            const label = await ed.inShadow(page, (root) => {
                const o = Array.from(root.getElementById('tmType').options).find((x) => x.value === 'requestBody');
                return o && o.textContent;
            });
            expect(label).toBe('Modify Request Body');

            await ed.fill(page, 'tmType', 'requestBody');
            const visible = await ed.visibleFieldIds(page);
            expect(visible).toEqual(expect.arrayContaining(['tmReqMode', 'tmReqBody', 'tmMatchHeaders', 'tmGraphql']));
            for (const id of ['tmReqPatch', 'tmBody', 'tmPatch', 'tmCode', 'tmStatus', 'tmResHeaders', 'tmRedirect', 'tmAppliesAll']) {
                expect(visible).not.toContain(id);
            }
        });

        test('the mode select swaps the body for the patch, and the hint on placeholders is linked to the body', async () => {
            await pickType();
            expect(await ed.inShadow(page, (root) => Array.from(root.getElementById('tmReqMode').options).map((o) => [o.value, o.textContent])))
                .toEqual([['static', 'Replace body'], ['patch', 'JSON patch']]);

            const wiring = await ed.inShadow(page, (root) => {
                const hint = root.getElementById(root.getElementById('tmReqBody').getAttribute('aria-describedby'));
                return hint && hint.textContent;
            });
            expect(wiring).toMatch(/Placeholders like \{\{guid\}\}/);

            await ed.fill(page, 'tmReqMode', 'patch');
            let visible = await ed.visibleFieldIds(page);
            expect(visible).toContain('tmReqPatch');
            expect(visible).not.toContain('tmReqBody');
            await ed.fill(page, 'tmReqMode', 'static');
            visible = await ed.visibleFieldIds(page);
            expect(visible).toContain('tmReqBody');
            expect(visible).not.toContain('tmReqPatch');
        });

        test('its fields are gone again when the type changes back', async () => {
            await pickType();
            await ed.fill(page, 'tmType', 'mock');
            const visible = await ed.visibleFieldIds(page);
            for (const id of ownFields) expect(visible).not.toContain(id);
        });

        test('GET and HEAD are not selectable for this type, and a GET rule switched over becomes Any (*)', async () => {
            await openEditor();
            await ed.fill(page, 'tmMethod', 'GET');
            await ed.fill(page, 'tmType', 'requestBody');
            expect(await ed.value(page, 'tmMethod')).toBe('*');
            const options = await ed.inShadow(page, (root) => Array.from(root.getElementById('tmMethod').options)
                .map((o) => ({ value: o.value, usable: !o.disabled && !o.hidden })));
            expect(options.filter((o) => !o.usable).map((o) => o.value).sort()).toEqual(['GET', 'HEAD']);
            // the reason is announced with the select
            const reason = await ed.inShadow(page, (root) => {
                const el = root.getElementById(root.getElementById('tmMethod').getAttribute('aria-describedby'));
                return el && el.textContent;
            });
            expect(reason).toMatch(/GET and HEAD have no body/);

            await ed.fill(page, 'tmType', 'mock');
            const back = await ed.inShadow(page, (root) => Array.from(root.getElementById('tmMethod').options).every((o) => !o.disabled && !o.hidden));
            expect(back).toBe(true);
        });

        test('a malformed patch is reported on the patch field before anything is sent', async () => {
            await pickType();
            await ed.fill(page, 'tmName', 'Bad patch');
            await ed.fill(page, 'tmUrl', '*/api/x*');
            await ed.fill(page, 'tmReqMode', 'patch');
            await ed.fill(page, 'tmReqPatch', '{"debug": ');
            await ed.click(page, 'tmSave');
            await waitFor(async () => /Request Body Patch: invalid JSON/.test(await ed.errorText(page)), { label: 'the JSON error' });
            expect(await ed.activeElementId(page)).toBe('tmReqPatch');
            const wiring = await ed.inShadow(page, (root) => {
                const el = root.getElementById('tmReqPatch');
                return { invalid: el.getAttribute('aria-invalid'), described: el.getAttribute('aria-describedby').split(' ') };
            });
            expect(wiring.invalid).toBe('true');
            expect(wiring.described).toEqual(['tmReqPatchHint', 'tmReqPatchErr']);
            expect(await stored()).toEqual([]);
        });

        (hostKind === 'options' ? test : test.skip)('the form sends the rule the user described (payload captured at the message boundary)', async () => {
            // The options page's main world can see chrome.runtime, so the
            // saveRule message can be captured here; the overlay's isolated
            // world cannot be reached that way (its mapping is in the unit
            // suite). The editor's own schema pre-check is skipped so the
            // message goes out whatever the schema in this tree accepts.
            await pickType();
            await page.evaluate(() => {
                window.SpliceTapRuleSchema = undefined;
                window.__sentRules = [];
                const original = chrome.runtime.sendMessage.bind(chrome.runtime);
                chrome.runtime.sendMessage = (message, ...rest) => {
                    if (message && message.type === 'saveRule') window.__sentRules.push(message.rule);
                    return original(message, ...rest);
                };
            });
            await ed.fill(page, 'tmName', 'Rewrite order');
            await ed.fill(page, 'tmUrl', '*/api/orders*');
            await ed.fill(page, 'tmMethod', 'POST');
            await ed.fill(page, 'tmReqBody', '{"qty": 3}');
            await ed.click(page, 'tmSave');
            const sent = await waitFor(() => page.evaluate(() => window.__sentRules.length && window.__sentRules), { label: 'the saveRule message' });
            expect(sent[0]).toMatchObject({
                name: 'Rewrite order', type: 'requestBody', enabled: true,
                match: { url: '*/api/orders*', method: 'POST' },
                requestBody: { mode: 'static', body: { qty: 3 } }
            });
            expect(sent[0].response).toBeUndefined();
            expect(sent[0].appliesTo).toBeUndefined();
        });

        afterSchemaMerge('saves a replace-body rule', async () => {
            await pickType();
            await ed.fill(page, 'tmName', 'Rewrite order');
            await ed.fill(page, 'tmUrl', '*/api/orders*');
            await ed.fill(page, 'tmMethod', 'POST');
            await ed.fill(page, 'tmReqBody', '{"qty": 3}');
            const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
            expect(rules[0]).toMatchObject({
                type: 'requestBody', match: { url: '*/api/orders*', method: 'POST' },
                requestBody: { mode: 'static', body: { qty: 3 } }
            });
        });

        afterSchemaMerge('saves a JSON-patch rule with the default method (Any)', async () => {
            await pickType();
            await ed.fill(page, 'tmName', 'Patch order');
            await ed.fill(page, 'tmUrl', '*/api/orders*');
            await ed.fill(page, 'tmReqMode', 'patch');
            await ed.fill(page, 'tmReqPatch', '{"debug": true}');
            const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
            expect(rules[0]).toMatchObject({
                type: 'requestBody', match: { method: '*' },
                requestBody: { mode: 'patch', patch: { debug: true } }
            });
            expect(rules[0].requestBody.body).toBeUndefined();
        });

        afterSchemaMerge('editing a saved rule shows its mode and body, and an edit keeps its identity', async () => {
            await openEditor(baseRule({
                type: 'requestBody', hitCount: 9,
                match: { url: '*/api/seed*', method: 'PUT' },
                requestBody: { mode: 'patch', patch: { debug: true } }
            }));
            expect(await ed.value(page, 'tmReqMode')).toBe('patch');
            expect(JSON.parse(await ed.value(page, 'tmReqPatch'))).toEqual({ debug: true });
            expect(await ed.value(page, 'tmMethod')).toBe('PUT');
            await ed.fill(page, 'tmName', 'Renamed');
            const rules = await saveAndWait((r) => r[0] && r[0].name === 'Renamed', 'the edit to save');
            expect(rules[0]).toMatchObject({ id: 'seed-1', hitCount: 9, requestBody: { mode: 'patch', patch: { debug: true } } });
        });

        afterRuntimeMerge('a rule made in the editor changes the request the page sends', async () => {
            await pickType();
            await ed.fill(page, 'tmName', 'Patch graphql body');
            await ed.fill(page, 'tmUrl', '*/graphql*');
            await ed.fill(page, 'tmMethod', 'POST');
            await ed.fill(page, 'tmReqMode', 'patch');
            await ed.fill(page, 'tmReqPatch', '{"debug": true}');
            await saveAndWait((r) => r.length === 1, 'the rule to save');

            const target = await h.openPage();
            opened.push(target); // closed in afterEach even if an assertion throws
            const res = await waitFor(async () => {
                const r = await pageFetch(target, '/graphql', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ a }' })
                });
                return r.ok && /debug/.test(String(r.body && r.body.received)) ? r : null;
            }, { label: 'the patched body to reach the server' });
            expect(JSON.parse(res.body.received)).toEqual({ query: '{ a }', debug: true });
        });
    });

    // ---- F4: code responses --------------------------------------------------------

    describe('F4: code responses', () => {
        async function setCodeResponses(on) {
            const { settings } = await h.bg({ type: 'getRules' });
            await h.bg({ type: 'settingsUpdated', settings: { ...settings, allowCodeResponses: on } });
        }
        const noteState = () => ed.inShadow(page, (root) => {
            const note = root.getElementById('tmCodeOffNote');
            return { hidden: note.hidden, visible: note.offsetParent !== null, text: note.textContent };
        });

        beforeEach(async () => { await setCodeResponses(false); });
        afterEach(async () => { await setCodeResponses(false); });

        async function pickCode() {
            await openEditor();
            await ed.fill(page, 'tmMode', 'code');
        }

        test('the response mode select offers "Code (JavaScript)"', async () => {
            await openEditor();
            const options = await ed.inShadow(page, (root) => Array.from(root.getElementById('tmMode').options).map((o) => [o.value, o.textContent]));
            expect(options).toEqual([['static', 'Static'], ['patch', 'Patch (merge into real)'], ['code', 'Code (JavaScript)']]);
        });

        test('code mode shows the code field in place of body, patch, status and response headers; delay stays', async () => {
            await pickCode();
            const visible = await ed.visibleFieldIds(page);
            expect(visible).toEqual(expect.arrayContaining(['tmCode', 'tmDelay', 'tmMode']));
            for (const id of ['tmBody', 'tmPatch', 'tmStatus', 'tmResHeaders']) expect(visible).not.toContain(id);

            await ed.fill(page, 'tmMode', 'static');
            const back = await ed.visibleFieldIds(page);
            expect(back).toEqual(expect.arrayContaining(['tmBody', 'tmStatus', 'tmResHeaders']));
            expect(back).not.toContain('tmCode');
        });

        test('the code field is monospace and left-to-right, with the help and security lines linked', async () => {
            await pickCode();
            const info = await ed.inShadow(page, (root) => {
                const el = root.getElementById('tmCode');
                const cs = window.getComputedStyle(el);
                const lines = el.getAttribute('aria-describedby').split(' ').map((id) => root.getElementById(id).textContent);
                return { dir: el.getAttribute('dir'), direction: cs.direction, family: cs.fontFamily, wrap: cs.whiteSpace, lines };
            });
            expect(info.dir).toBe('ltr');
            expect(info.direction).toBe('ltr');
            expect(info.family).toMatch(/monospace|Consolas|Menlo/i);
            expect(info.wrap).toBe('pre');
            expect(info.lines).toEqual(expect.arrayContaining([
                'Body of an async function. request has url, method, headers, body, json. Return a body or {status, headers, body}.',
                'Runs inside the page you are testing.'
            ]));
        });

        test('the code field stays left-to-right on a right-to-left page', async () => {
            if (hostKind === 'options') {
                page = await h.browser.newPage();
                await page.goto(h.extUrl('options/options.html?action=new'), { waitUntil: 'load' });
                await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
            } else {
                page = await h.openPage();
                await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
                await h.openOverlay(page, { mode: 'new' });
            }
            await waitFor(() => ed.isOpen(page), { label: 'the editor to open' });
            await ed.fill(page, 'tmMode', 'code');
            const direction = await ed.inShadow(page, (root) => window.getComputedStyle(root.getElementById('tmCode')).direction);
            expect(direction).toBe('ltr');
        });

        test('with code responses off, the note says so; with them on, it is gone', async () => {
            await setCodeResponses(false);
            await pickCode();
            await waitFor(async () => (await noteState()).visible, { label: 'the off note' });
            expect((await noteState()).text).toBe('Code responses are off — turn them on in SpliceTap Settings.');
            // linked to the field, ahead of the help lines
            const described = await ed.inShadow(page, (root) => root.getElementById('tmCode').getAttribute('aria-describedby'));
            expect(described.split(' ')[0]).toBe('tmCodeOffNote');

            await page.close();
            await setCodeResponses(true);
            await pickCode();
            await sleep(400); // settings are read after the editor opens
            expect((await noteState()).visible).toBe(false);
            const describedOn = await ed.inShadow(page, (root) => root.getElementById('tmCode').getAttribute('aria-describedby'));
            expect(describedOn).toBe('tmCodeHint tmCodeSecurity');
        });

        test('the note is not shown in static mode', async () => {
            await openEditor();
            await sleep(400);
            expect((await noteState()).visible).toBe(false);
        });

        afterSchemaMerge('a code rule can be saved while code responses are off', async () => {
            await setCodeResponses(false);
            await pickCode();
            await ed.fill(page, 'tmName', 'Code mock');
            await ed.fill(page, 'tmUrl', '*/api/code*');
            await ed.fill(page, 'tmCode', 'return { ok: true };');
            const rules = await saveAndWait((r) => r.length === 1, 'the rule to save');
            expect(rules[0].response).toMatchObject({ mode: 'code', code: 'return { ok: true };' });
            expect(rules[0].response.body).toBeUndefined();
        });

        afterSchemaMerge('a blank code field is refused on the code field', async () => {
            await pickCode();
            await ed.fill(page, 'tmName', 'Empty code');
            await ed.fill(page, 'tmUrl', '*/api/code*');
            await ed.click(page, 'tmSave');
            await waitFor(async () => /^Code response|Code response needs code/.test(await ed.errorText(page)), { label: 'the schema refusal' });
            expect(await ed.activeElementId(page)).toBe('tmCode');
            expect(await stored()).toEqual([]);
        });

        afterSchemaMerge('editing a saved code rule fills the code and keeps its identity', async () => {
            await openEditor(baseRule({
                type: 'mock', hitCount: 4,
                response: { statusCode: 200, statusText: 'OK', headers: {}, delay: 0, mode: 'code', code: 'return 7;' }
            }));
            expect(await ed.value(page, 'tmMode')).toBe('code');
            expect(await ed.value(page, 'tmCode')).toBe('return 7;');
            await ed.fill(page, 'tmName', 'Renamed code');
            const rules = await saveAndWait((r) => r[0] && r[0].name === 'Renamed code', 'the edit to save');
            expect(rules[0]).toMatchObject({ id: 'seed-1', hitCount: 4, response: { mode: 'code', code: 'return 7;' } });
        });

        afterRuntimeMerge('a code rule made in the editor answers a real request once code responses are on', async () => {
            await setCodeResponses(true);
            await pickCode();
            await ed.fill(page, 'tmName', 'Code mock');
            await ed.fill(page, 'tmUrl', '*/api/code*');
            await ed.fill(page, 'tmCode', 'return { status: 201, body: { from: "code", method: request.method } };');
            await saveAndWait((r) => r.length === 1, 'the rule to save');

            const target = await h.openPage();
            opened.push(target); // closed in afterEach even if an assertion throws
            const res = await waitFor(async () => {
                const r = await pageFetch(target, '/api/code');
                return r.marker === 'true' ? r : null;
            }, { label: 'the code response' });
            expect(res.status).toBe(201);
            expect(res.body).toEqual({ from: 'code', method: 'GET' });
        });
    });
});

describe('editor features — accessibility (options host, open shadow root)', () => {
    // axe cannot see into the overlay's CLOSED root; the options page mounts
    // the same editor in an open one (see editors.e2e.test.js), so the new
    // states are audited there.
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => { if (page && !page.isClosed()) await page.close(); page = null; });

    async function openOnOptionsPage(theme, allowCodeResponses) {
        await h.reset();
        await h.bg({ type: 'settingsUpdated', settings: { theme, allowCodeResponses } });
        page = await h.browser.newPage();
        await page.setViewport({ width: 1100, height: 900 });
        await page.goto(h.extUrl('options/options.html?action=new'), { waitUntil: 'load' });
        await waitFor(() => ed.isOpen(page), { label: 'the editor to open' });
        await sleep(300); // theme and settings are read after the editor opens
    }

    const audit = async (label, violations) => {
        for (const v of await auditA11y(page)) violations.push({ state: label, ...v });
    };

    test.each([
        ['dark', false], ['light', false], ['dark', true], ['light', true]
    ])('the new states have no WCAG A/AA violations (%s theme, allowCodeResponses %s)', async (theme, allowCode) => {
        await openOnOptionsPage(theme, allowCode);
        const violations = [];

        // F1: the checkbox, ticked (new rule default) and unticked, redirect and block
        for (const type of ['redirect', 'block']) {
            await ed.fill(page, 'tmType', type);
            await audit(`${type}, all requests ticked`, violations);
            await ed.fill(page, 'tmAppliesAll', false);
            await audit(`${type}, all requests unticked`, violations);
            await ed.fill(page, 'tmAppliesAll', true);
        }

        // F3: both modes, then with the required-field errors showing
        await ed.fill(page, 'tmType', 'requestBody');
        await audit('requestBody, replace', violations);
        await ed.fill(page, 'tmReqMode', 'patch');
        await audit('requestBody, patch', violations);
        await ed.fill(page, 'tmReqPatch', '{"debug": ');
        await ed.click(page, 'tmSave');
        await waitFor(async () => /invalid JSON/.test(await ed.errorText(page)), { label: 'the error state' });
        await audit('requestBody, patch with an error', violations);

        // F4: code mode (the note shows when code responses are off)
        await ed.fill(page, 'tmType', 'mock');
        await ed.fill(page, 'tmMode', 'code');
        const noteVisible = await ed.inShadow(page, (root) => root.getElementById('tmCodeOffNote').offsetParent !== null);
        expect(noteVisible).toBe(!allowCode);
        await audit(`mock, code mode, note ${noteVisible ? 'shown' : 'hidden'}`, violations);
        await ed.fill(page, 'tmCode', 'return 1;');
        await ed.fill(page, 'tmName', 'x');
        await ed.fill(page, 'tmUrl', '');
        await ed.click(page, 'tmSave');
        await waitFor(async () => /URL pattern/i.test(await ed.errorText(page)), { label: 'the error state' });
        await audit('mock, code mode with an error', violations);

        expect(violations).toEqual([]);
    });
});
