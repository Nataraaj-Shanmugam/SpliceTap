/**
 * declarativeNetRequest-backed rules (headers, queryparams), observed on the
 * wire.
 *
 * These rules act inside Chrome's network stack, so page JavaScript cannot
 * see a request header they add — the harness's /echo endpoint reports what
 * actually arrived. That is the only honest way to test them: the unit suite
 * can check the DNR rule objects SpliceTap builds, but only Chrome decides
 * whether it accepts them.
 */

const { launch, pageFetch, waitFor, sleep } = require('./harness');

const headersRule = (overrides = {}) => ({
    id: 'hdr-a',
    name: 'Add X-SpliceTap-A',
    enabled: true,
    type: 'headers',
    match: { url: '*/echo*', method: '*' },
    headersMod: { request: [{ op: 'set', name: 'X-SpliceTap-A', value: 'on' }], response: [] },
    ...overrides
});

describe('declarativeNetRequest rules on the wire', () => {
    let h;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });

    beforeEach(async () => {
        await h.reset();
        page = await h.openPage();
    });
    afterEach(async () => { if (page) await page.close(); });

    /** What the server received for one /echo request from the page. */
    async function echo(query = '') {
        const result = await pageFetch(page, '/echo' + query);
        return result.body;
    }

    async function dynamicRules() {
        return h.extensionEval(() => chrome.declarativeNetRequest.getDynamicRules());
    }

    test('a headers rule adds a request header the server actually receives', async () => {
        await h.saveRule(headersRule());

        const seen = await waitFor(async () => {
            const body = await echo();
            return body.headers['x-splicetap-a'] === 'on' ? body : null;
        }, { label: 'X-SpliceTap-A to reach the server' });

        expect(seen.headers['x-splicetap-a']).toBe('on');
    });

    test('a headers rule can set a response header the page can read', async () => {
        await h.saveRule(headersRule({
            headersMod: { request: [], response: [{ op: 'set', name: 'X-Injected', value: 'yes' }] }
        }));

        const header = await waitFor(async () => page.evaluate(async () => {
            const r = await fetch('/echo');
            return r.headers.get('x-injected');
        }), { label: 'X-Injected on the response' });

        expect(header).toBe('yes');
    });

    test('a queryparams rule rewrites the query the server receives', async () => {
        await h.saveRule({
            id: 'qp-a',
            name: 'Rewrite query',
            enabled: true,
            type: 'queryparams',
            match: { url: '*/echo*', method: '*' },
            queryParams: { add: [{ key: 'injected', value: '1' }], remove: ['drop'] }
        });

        const seen = await waitFor(async () => {
            const body = await echo('?drop=me&keep=yes');
            return body.query.injected === '1' ? body : null;
        }, { label: 'the query rewrite' });

        expect(seen.query).toEqual({ keep: 'yes', injected: '1' });
    });

    test('switching the extension off withdraws the network-level effect', async () => {
        await h.saveRule(headersRule());
        await waitFor(async () => (await echo()).headers['x-splicetap-a'] === 'on', { label: 'rule active' });

        await h.bg({ type: 'toggleExtension', active: false });

        await waitFor(async () => (await echo()).headers['x-splicetap-a'] === undefined, { label: 'rule withdrawn' });
        expect(await dynamicRules()).toEqual([]);
    });

    test('disabling the rule withdraws it', async () => {
        await h.saveRule(headersRule());
        await waitFor(async () => (await echo()).headers['x-splicetap-a'] === 'on', { label: 'rule active' });

        await h.bg({ type: 'toggleRule', ruleId: 'hdr-a', enabled: false });

        await waitFor(async () => (await echo()).headers['x-splicetap-a'] === undefined, { label: 'rule withdrawn' });
    });

    // ---- One bad rule must not take the others down ----------------------
    //
    // updateDynamicRules is all-or-nothing: if Chrome rejects any one rule in
    // the batch, it rejects every rule in it. So a single malformed rule that
    // reaches the DNR layer silently disables every headers and queryparams
    // rule the user has. The trust boundary has to stop it first. Rules come
    // in by import, which bypasses both editors' client-side checks.

    const malformedRules = [
        ['a set op with no value', { request: [{ op: 'set', name: 'X-Bad' }], response: [] }],
        ['an op with no name', { request: [{ op: 'set', value: 'x' }], response: [] }],
        ['an unknown op', { request: [{ op: 'append-ish', name: 'X-Bad', value: 'x' }], response: [] }],
        ['a header op that is not an object', { request: ['X-Bad: x'], response: [] }]
    ];

    test.each(malformedRules)('an imported headers rule with %s does not break the others', async (label, headersMod) => {
        await h.saveRule(headersRule());
        await waitFor(async () => (await echo()).headers['x-splicetap-a'] === 'on', { label: 'good rule active' });

        const response = await h.bg({
            type: 'setRules',
            rules: [headersRule(), { ...headersRule(), id: 'hdr-bad', name: 'Bad', dnrRuleId: undefined, headersMod }]
        });
        await sleep(300);

        // The good rule must still be on the wire...
        expect((await echo()).headers['x-splicetap-a']).toBe('on');
        // ...and the bad one must not have been stored as if it were valid.
        const stored = await h.bg({ type: 'getRules' });
        expect(stored.rules.map((r) => r.id)).not.toContain('hdr-bad');
        expect(response.success).toBe(true);
    });

    test('an imported queryparams rule with an add entry missing its key does not break the others', async () => {
        await h.saveRule(headersRule());
        await waitFor(async () => (await echo()).headers['x-splicetap-a'] === 'on', { label: 'good rule active' });

        await h.bg({
            type: 'setRules',
            rules: [headersRule(), {
                id: 'qp-bad', name: 'Bad query', enabled: true, type: 'queryparams',
                match: { url: '*/echo*', method: '*' },
                queryParams: { add: [{ value: 'no-key' }], remove: [] }
            }]
        });
        await sleep(300);

        expect((await echo()).headers['x-splicetap-a']).toBe('on');
    });

    test('a bad rule already in storage cannot freeze the network layer', async () => {
        // Users who imported a malformed rule before the save boundary checked
        // op shape already have one stored. Planted directly in storage here,
        // bypassing validation exactly as an older build would have.
        await h.saveRule(headersRule());
        await waitFor(async () => (await echo()).headers['x-splicetap-a'] === 'on', { label: 'good rule active' });

        const stored = (await h.bg({ type: 'getRules' })).rules;
        const planted = {
            id: 'legacy-bad', name: 'Legacy bad rule', enabled: true, type: 'headers', dnrRuleId: 9001,
            match: { url: '*/echo*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'X-Legacy' }], response: [] }
        };
        await h.extensionEval((rules) => chrome.storage.local.set({ spliceTapRules: rules }), [...stored, planted]);

        // Any write makes the background reload from storage and re-sync.
        await h.saveRule(headersRule({
            id: 'hdr-c', name: 'Add C',
            headersMod: { request: [{ op: 'set', name: 'X-SpliceTap-C', value: 'on' }], response: [] }
        }));

        // The new rule applies despite the bad one...
        await waitFor(async () => (await echo()).headers['x-splicetap-c'] === 'on', { label: 'new rule applied' });

        // ...disabling a rule really withdraws it (this is what used to lie)...
        const toggled = await h.bg({ type: 'toggleRule', ruleId: 'hdr-a', enabled: false });
        await waitFor(async () => (await echo()).headers['x-splicetap-a'] === undefined, { label: 'disabled rule withdrawn' });

        // ...and the refused rule is named, both in the response and per rule.
        expect(toggled.dnrWarning).toMatch(/Legacy bad rule/);
        const after = await h.bg({ type: 'getRules' });
        expect(Object.keys(after.dnrErrors)).toEqual(['legacy-bad']);
    });

    test('a regex Chrome\'s network rules cannot run is refused at save time', async () => {
        // JavaScript accepts lookarounds; declarativeNetRequest's RE2 does not.
        const response = await h.bg({
            type: 'saveRule',
            rule: headersRule({ id: 'hdr-re2', match: { url: '/\\/echo(?=\\?)/', method: '*' } })
        });
        expect(response.success).toBe(false);
        expect(response.error).toMatch(/cannot be used for header or query-parameter rules/);
    });

    test('ran without extension errors', async () => {
        await h.saveRule(headersRule());
        await waitFor(async () => (await echo()).headers['x-splicetap-a'] === 'on', { label: 'rule active' });
        expect(h.allErrors).toEqual([]);
    });
});
