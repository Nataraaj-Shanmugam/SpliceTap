/**
 * B2-F6: the Requestly importer (src/importers/requestly.js).
 *
 * The fixtures mirror Requestly's real export (a flat JSON array of rule and
 * group records; see tests/fixtures/requestly). Every rule type, operator,
 * source key and filter is converted and the exact result asserted, together
 * with the skips and warnings. URL conditions are also checked by behaviour:
 * the converted pattern goes through SpliceTap's own matcher against URLs it
 * must and must not match.
 */

const fs = require('fs');
const path = require('path');
const S = require('../src/rule-schema');
const M = require('../src/matcher');
const importer = require('../src/importers/requestly');

// Schema fields that arrive with the merge (pageDomains, resourceTypes,
// payload, removeAll, header append) are not validated in this tree, so tests
// that need the merged validator are marked here. The coordinator flips this
// to `test` after merging.
const afterMerge = test.failing; // coordinator flips

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'requestly', name), 'utf8'));

let seq = 0;
const src = (key, operator, value, filters) => {
    const s = { key, operator, value };
    if (filters !== undefined) s.filters = filters;
    return s;
};
const pair = (source, rest) => Object.assign({ id: `p${++seq}`, source }, rest);
const rec = (ruleType, pairs, extra) => Object.assign({
    id: `${ruleType}_t${++seq}`,
    name: `${ruleType} test`,
    objectType: 'rule',
    ruleType,
    status: 'Active',
    groupId: '',
    schemaVersion: '3.0.0',
    pairs: Array.isArray(pairs) ? pairs : [pairs]
}, extra);
const run = (record, options) => importer.convert([record], options);
const bare = (rule) => {
    const rest = Object.assign({}, rule);
    delete rest.id;
    delete rest.created;
    return rest;
};
// One record in, exactly one rule out, nothing skipped.
const one = (record, options) => {
    const out = run(record, options);
    expect(out.skipped).toEqual([]);
    expect(out.rules).toHaveLength(1);
    return { rule: out.rules[0], warnings: out.warnings.map((w) => w.message), all: out };
};
const skipOf = (record, options) => {
    const out = run(record, options);
    expect(out.rules).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    return out.skipped[0].reason;
};
const cancel = (source, extra) => rec('Cancel', pair(source), extra);
const patternOf = (source) => one(cancel(source)).rule.match.url;
const urlWarnings = (source) => one(cancel(source)).warnings;
const hits = (pattern, url) => M.matchUrl(url, pattern);

describe('detect', () => {
    test('a Requestly export (array of records) is detected', () => {
        expect(importer.detect(fixture('export-full.json'))).toBe(true);
        expect(importer.detect(fixture('groups.json'))).toBe(true);
    });
    test('a JSON string, an object with rules, and a single record are detected', () => {
        const records = fixture('export-full.json');
        expect(importer.detect(JSON.stringify(records))).toBe(true);
        expect(importer.detect({ rules: records })).toBe(true);
        expect(importer.detect(records[0])).toBe(true);
    });
    test('a file of groups only is still a Requestly file', () => {
        expect(importer.detect([{ objectType: 'group', name: 'G', id: 'Group_1', status: 'Active' }])).toBe(true);
    });
    test('SpliceTap\'s own export and unrelated JSON are not detected', () => {
        const spliceTap = { exportedAt: '2026-01-01', rules: [{ id: 'rule_1', name: 'x', type: 'block', enabled: true, match: { url: '*', method: '*' } }] };
        expect(importer.detect(spliceTap)).toBe(false);
        expect(importer.detect([spliceTap.rules[0]])).toBe(false);
        for (const junk of [null, undefined, 7, 'text', '{bad json', [], {}, [null, 3], { rules: 'no' }, [{ objectType: 'widget' }]]) {
            expect(importer.detect(junk)).toBe(false);
        }
    });
    test('registers itself on SpliceTapImporters', () => {
        expect(globalThis.SpliceTapImporters.requestly).toBe(importer);
        expect(Object.keys(importer).sort()).toEqual(['convert', 'detect']);
    });
});

describe('a realistic export', () => {
    const out = importer.convert(fixture('export-full.json'));

    test('converts one rule per pair, in file order, and says what it left out', () => {
        expect(out.rules.map((r) => [r.name, r.type, r.enabled])).toEqual([
            ['Redirect API to staging', 'redirect', true],
            ['Block analytics', 'block', true],
            ['Slow search', 'delay', true],
            ['Debug headers', 'headers', true],
            ['Debug on, tracking off', 'queryparams', true],
            ['Mock the user', 'mock', true],
            ['Dynamic user', 'mock', true],
            ['Patch request body', 'requestBody', true],
            ['Pretend to be an iPhone', 'headers', true],
            // The condition names https, so there is no http twin.
            ['Point example.com at staging', 'redirect', true],
            ['Block ads (off)', 'block', false]
        ]);
        expect(out.skipped).toEqual([
            { name: 'Inject banner', reason: 'Script rules (injecting JavaScript or CSS into pages) are not supported by SpliceTap.' }
        ]);
    });

    test('exact converted rules', () => {
        const byName = Object.fromEntries(out.rules.map((r) => [r.name, bare(r)]));
        expect(byName['Redirect API to staging']).toEqual({
            name: 'Redirect API to staging', type: 'redirect', enabled: true, appliesTo: 'all',
            match: { url: '*https://api.example.com/v1*', method: '*' },
            redirect: { destination: 'https://staging.example.com/v1' }
        });
        expect(byName['Block analytics']).toEqual({
            name: 'Block analytics', type: 'block', enabled: true, appliesTo: 'all',
            match: { url: '*analytics.example.com*', method: '*' }
        });
        expect(byName['Slow search']).toEqual({
            name: 'Slow search', type: 'delay', enabled: true,
            match: { url: 'https://api.example.com/search*', method: '*' }, delayMs: 1500
        });
        expect(byName['Debug headers']).toEqual({
            name: 'Debug headers', type: 'headers', enabled: true,
            match: { url: '*https://api.example.com/*', method: '*', resourceTypes: ['fetch-xhr'] },
            headersMod: {
                request: [{ op: 'set', name: 'X-Debug', value: '1' }, { op: 'remove', name: 'X-Trace' }],
                response: [{ op: 'set', name: 'X-Env', value: 'staging' }]
            }
        });
        expect(byName['Debug on, tracking off']).toEqual({
            name: 'Debug on, tracking off', type: 'queryparams', enabled: true,
            match: { url: '*https://api.example.com/*', method: '*', resourceTypes: ['fetch-xhr'] },
            queryParams: { add: [{ key: 'debug', value: '1' }], remove: ['utm_source'] }
        });
        expect(byName['Mock the user']).toEqual({
            name: 'Mock the user', type: 'mock', enabled: true,
            match: { url: '/^https:\\/\\/api\\.example\\.com\\/user$/', method: 'GET' },
            response: { mode: 'static', statusCode: 201, statusText: 'Created', headers: {}, delay: 0, body: '{"id":7,"name":"Ada"}' }
        });
        expect(byName['Patch request body']).toEqual({
            name: 'Patch request body', type: 'requestBody', enabled: true,
            match: { url: '*https://api.example.com/orders*', method: 'POST' },
            requestBody: { mode: 'static', body: '{"debug":true}' }
        });
        expect(byName['Pretend to be an iPhone']).toEqual({
            name: 'Pretend to be an iPhone', type: 'headers', enabled: true,
            match: { url: '*https://api.example.com/*', method: '*' },
            headersMod: { request: [{ op: 'set', name: 'User-Agent', value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' }] }
        });
        expect(byName['Block ads (off)'].enabled).toBe(false);
    });

    test('every converted rule has a fresh, unique id and passes the schema', () => {
        const ids = out.rules.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^rule_/);
        for (const id of fixture('export-full.json').map((r) => r.id)) expect(ids).not.toContain(id);
        for (const rule of out.rules) expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
    });

    test('warnings name the rule and say what differs', () => {
        expect(out.warnings).toEqual(expect.arrayContaining([
            { name: 'Slow search', message: 'SpliceTap delays fetch and XHR requests only; Requestly delays every request.' },
            { name: 'Dynamic user', message: 'Code responses are off by default; turn them on in SpliceTap\'s settings.' },
            { name: 'Pretend to be an iPhone', message: 'Requestly applies this to every resource type; this rule affects fetch and XHR requests only unless you add resource types in the editor.' }
        ]));
    });
});

describe('rule types', () => {
    test('Redirect: absolute destination -> redirect applying to all requests', () => {
        const { rule, warnings } = one(rec('Redirect', pair(src('Url', 'Equals', 'https://a.test/x'), { destination: 'https://b.test/y', destinationType: 'url' })));
        expect(bare(rule)).toEqual({
            name: 'Redirect test', type: 'redirect', enabled: true, appliesTo: 'all',
            match: { url: '/^https:\\/\\/a\\.test\\/x$/', method: '*' }, redirect: { destination: 'https://b.test/y' }
        });
        expect(warnings).toEqual([]);
        expect(S.validateRule(rule).valid).toBe(true);
    });
    test('Redirect: a relative destination becomes a page rule, with a warning', () => {
        const { rule, warnings } = one(rec('Redirect', pair(src('Url', 'Contains', '/api/v1/'), { destination: '/api/v2/', destinationType: 'url' })));
        expect(rule.appliesTo).toBe('page');
        expect(rule.redirect).toEqual({ destination: '/api/v2/' });
        expect(warnings).toEqual(['The destination is relative, so the redirect stays on the page\'s own origin and applies to fetch and XHR requests only.']);
        expect(S.validateRule(rule).valid).toBe(true);
    });
    test('Redirect: $1 in the destination needs a regex pattern, and keeps its capture groups', () => {
        const wild = one(rec('Redirect', pair(src('Url', 'Wildcard_Matches', 'https://old.test/*/items/*'), { destination: 'https://new.test/$2/$1' }))).rule;
        expect(wild.match.url).toBe('/^https://old\\.test/(.*)/items/(.*)$/');
        expect(hits(wild.match.url, 'https://old.test/a/items/9')).toBe(true);
        expect(S.validateRule(wild).valid).toBe(true);
        const re = one(rec('Redirect', pair(src('Url', 'Matches', '/^https:\\/\\/old\\.test\\/(\\d+)$/'), { destination: 'https://new.test/$1' }))).rule;
        expect(re.match.url).toBe('/^https:\\/\\/old\\.test\\/(\\d+)$/');
        expect(S.validateRule(re).valid).toBe(true);
        // Contains cannot carry $1 as a wildcard, so it becomes an escaped regex.
        const contains = one(rec('Redirect', pair(src('Url', 'Contains', '/v1/'), { destination: 'https://new.test/$1' })));
        expect(contains.rule.match.url).toBe('/\\/v1\\//');
        expect(contains.warnings).toEqual(['The destination contains $1-$9 but the condition has no capture groups, so it is used as written.']);
        expect(S.validateRule(contains.rule).valid).toBe(true);
    });
    test('Redirect: $n beyond the pattern\'s groups is flagged', () => {
        const { warnings } = one(rec('Redirect', pair(src('Url', 'Matches', '/a(\\d)/'), { destination: 'https://b.test/$3' })));
        expect(warnings).toEqual(['The destination refers to $3 but the pattern captures only 1 group(s); Requestly would insert nothing there, SpliceTap leaves the text.']);
    });
    test('Redirect: Requestly-hosted mocks are flagged', () => {
        const { warnings } = one(rec('Redirect', pair(src('Url', 'Contains', 'a.test'), { destination: 'https://requestly.tech/api/mockv2/ping?teamId=1', destinationType: 'mock_or_file_picker' })));
        expect(warnings).toEqual(['The destination is a Requestly-hosted mock; it keeps working only while that mock exists.']);
    });
    test('Redirect: local files, empty and non-http destinations are skipped', () => {
        const dest = (destination, destinationType) => skipOf(rec('Redirect', pair(src('Url', 'Contains', 'a.test'), { destination, destinationType })));
        expect(dest('file:///tmp/x.json', 'url')).toBe('This redirect points at a local file, which a browser extension cannot read.');
        expect(dest('/Users/me/x.json', 'map_local')).toBe('This redirect points at a local file, which a browser extension cannot read.');
        expect(dest('', 'url')).toBe('The redirect has no destination.');
        expect(dest('localhost:3000/x', 'url')).toBe('The destination is not an http(s) URL or a path starting with "/".');
        expect(dest('ftp://x.test/', 'url')).toBe('The destination is not an http(s) URL or a path starting with "/".');
    });

    test('Cancel -> block applying to all requests', () => {
        const { rule } = one(cancel(src('Url', 'Contains', 'tracker.test')));
        expect(bare(rule)).toEqual({ name: 'Cancel test', type: 'block', enabled: true, appliesTo: 'all', match: { url: '*tracker.test*', method: '*' } });
        expect(S.validateRule(rule).valid).toBe(true);
    });

    test('Delay -> delay, with the fetch/XHR warning', () => {
        const { rule, warnings } = one(rec('Delay', pair(src('Url', 'Contains', 'slow.test'), { delay: '800' })));
        expect(bare(rule)).toEqual({ name: 'Delay test', type: 'delay', enabled: true, match: { url: '*slow.test*', method: '*' }, delayMs: 800 });
        expect(warnings).toEqual(['SpliceTap delays fetch and XHR requests only; Requestly delays every request.']);
        expect(S.validateRule(rule).valid).toBe(true);
    });
    test('Delay: long delays are capped with a warning; zero and junk are skipped', () => {
        const capped = one(rec('Delay', pair(src('Url', 'Contains', 'a'), { delay: '45000' })));
        expect(capped.rule.delayMs).toBe(30000);
        expect(capped.warnings[0]).toBe('The delay of 45000 ms was capped at 30000 ms.');
        expect(skipOf(rec('Delay', pair(src('Url', 'Contains', 'a'), { delay: '0' })))).toBe('A delay of 0 ms does nothing.');
        expect(skipOf(rec('Delay', pair(src('Url', 'Contains', 'a'), { delay: '2s' })))).toBe('The delay "2s" is not a whole number of milliseconds.');
        expect(skipOf(rec('Delay', pair(src('Url', 'Contains', 'a'), {})))).toBe('The delay "" is not a whole number of milliseconds.');
    });

    describe('Headers', () => {
        const headers = (modifications, source) => rec('Headers', pair(source || src('Url', 'Contains', 'a.test'), { modifications }));
        test('Add and Modify -> set, Remove -> remove, per side', () => {
            const { rule, warnings } = one(headers({
                Request: [{ header: 'X-A', type: 'Add', value: '1' }, { header: 'X-B', type: 'Modify', value: '2' }, { header: 'X-C', type: 'Remove', value: '' }],
                Response: [{ header: 'X-D', type: 'Modify', value: '4' }, { header: 'X-E', type: 'Remove', value: '' }]
            }));
            expect(rule.headersMod).toEqual({
                request: [{ op: 'set', name: 'X-A', value: '1' }, { op: 'set', name: 'X-B', value: '2' }, { op: 'remove', name: 'X-C' }],
                response: [{ op: 'set', name: 'X-D', value: '4' }, { op: 'remove', name: 'X-E' }]
            });
            expect(warnings).toEqual(['Requestly applies this to every resource type; this rule affects fetch and XHR requests only unless you add resource types in the editor.']);
            expect(S.validateRule(rule).valid).toBe(true);
        });
        test('Add on a response header is an append in Requestly: warned about, or mapped to append with the option', () => {
            const record = headers({ Response: [{ header: 'X-A', type: 'Add', value: '1' }], Request: [{ header: 'Accept-Language', type: 'Add', value: 'fr' }] });
            const plain = one(record);
            expect(plain.rule.headersMod.response).toEqual([{ op: 'set', name: 'X-A', value: '1' }]);
            expect(plain.warnings).toContain('Requestly appends added headers to an existing value (Accept-Language, X-A); SpliceTap sets them, replacing any existing value.');

            const appended = one(record, { appendResponseAdd: true, validate: false });
            expect(appended.rule.headersMod.response).toEqual([{ op: 'append', name: 'X-A', value: '1' }]);
            // A request header cannot be appended, so that one is still a warning.
            expect(appended.rule.headersMod.request).toEqual([{ op: 'set', name: 'Accept-Language', value: 'fr' }]);
            expect(appended.warnings).toContain('Requestly appends added headers to an existing value (Accept-Language); SpliceTap sets them, replacing any existing value.');
        });
        afterMerge('append is accepted on the response side only by the merged schema', () => {
            const out = run(headers({ Response: [{ header: 'X-A', type: 'Add', value: '1' }] }), { appendResponseAdd: true });
            const rule = out.rules[0];
            expect(S.validateRule(rule).valid).toBe(true);
            const request = JSON.parse(JSON.stringify(rule));
            request.headersMod = { request: [{ op: 'append', name: 'X-A', value: '1' }] };
            expect(S.validateRule(request).valid).toBe(false);
        });
        test('rq_request_initiator_origin() cannot be reproduced, so that operation is dropped', () => {
            const { rule, warnings } = one(headers({ Response: [
                { header: 'Access-Control-Allow-Origin', type: 'Add', value: 'rq_request_initiator_origin()' },
                { header: 'X-Keep', type: 'Add', value: 'yes' }
            ] }));
            expect(rule.headersMod).toEqual({ response: [{ op: 'set', name: 'X-Keep', value: 'yes' }] });
            expect(warnings).toContain('Dropped header operation(s): Access-Control-Allow-Origin (its value is filled in with the page\'s origin at request time by Requestly, which SpliceTap cannot do; set a fixed value in the editor).');
        });
        test('security headers, bad names, duplicates and unknown operations are dropped; nothing usable means a skip', () => {
            const { rule, warnings } = one(headers({ Request: [
                { header: 'X-Ok', type: 'Add', value: '1' },
                { header: 'Content-Security-Policy', type: 'Remove', value: '' },
                { header: 'Bad Name', type: 'Add', value: '1' },
                { header: 'x-ok', type: 'Add', value: '2' },
                { header: 'X-Line', type: 'Add', value: 'a\nb' },
                { header: 'X-Odd', type: 'Frobnicate', value: '1' },
                { header: '', type: 'Add', value: '1' },
                null
            ] }));
            expect(rule.headersMod).toEqual({ request: [{ op: 'set', name: 'X-Ok', value: '1' }] });
            const dropped = warnings.find((w) => w.startsWith('Dropped header operation(s)'));
            expect(dropped).toContain('Content-Security-Policy (Header "Content-Security-Policy" cannot be modified');
            expect(dropped).toContain('Bad Name ("Bad Name" is not a valid header name)');
            expect(dropped).toContain('x-ok (listed twice on the request side; only the first applies)');
            expect(dropped).toContain('X-Line (header values cannot contain line breaks)');
            expect(dropped).toContain('X-Odd (unknown operation "Frobnicate")');
            expect(dropped).toContain('an operation without a header name; an entry that is not a header operation');
            expect(skipOf(headers({ Request: [{ header: 'Cookie', type: 'Remove', value: '' }] })))
                .toMatch(/^No header operation could be imported: Cookie \(Header "Cookie" cannot be modified/);
            expect(skipOf(headers({ Request: [], Response: [] }))).toBe('No header operation could be imported.');
        });
        test('version-1 header rules (one header per pair, with a target) are read too', () => {
            const { rule } = one(rec('Headers', pair(src('Url', 'Contains', 'a.test'), { target: 'Response', header: 'X-Old', type: 'Add', value: 'v' })));
            expect(rule.headersMod).toEqual({ response: [{ op: 'set', name: 'X-Old', value: 'v' }] });
        });
        test('credentialed CORS without a host in the pattern is refused by the schema, and the reason is shown', () => {
            const reason = skipOf(headers({ Response: [{ header: 'Access-Control-Allow-Credentials', type: 'Add', value: 'true' }] }, src('Url', 'Contains', 'requestly')));
            expect(reason).toMatch(/^Access-Control-Allow-Credentials: true needs a URL pattern that names a host/);
        });
    });

    describe('QueryParam', () => {
        const query = (modifications, source) => rec('QueryParam', pair(source || src('Url', 'Contains', 'a.test'), { modifications }));
        test('Add -> add, Remove -> remove', () => {
            const { rule } = one(query([
                { type: 'Add', param: 'a', value: '1', actionWhenParamExists: 'Overwrite' },
                { type: 'Remove', param: 'b', value: '' },
                { type: 'Remove', param: 'b', value: '' }
            ]));
            expect(rule.queryParams).toEqual({ add: [{ key: 'a', value: '1' }], remove: ['b'] });
            expect(S.validateRule(rule).valid).toBe(true);
        });
        test('a parameter added twice keeps the later value, with a warning', () => {
            const { rule, warnings } = one(query([{ type: 'Add', param: 'a', value: '1' }, { type: 'Add', param: 'a', value: '2' }]));
            expect(rule.queryParams.add).toEqual([{ key: 'a', value: '2' }]);
            expect(warnings).toContain('Dropped query-parameter change(s): "a" was added twice; the later value wins.');
        });
        test('Remove All -> removeAll, and Requestly ignores the other changes next to it', () => {
            const { rule, warnings } = one(query([{ type: 'Add', param: 'a', value: '1' }, { type: 'Remove All', param: '', value: '' }]), { validate: false });
            expect(rule.queryParams).toEqual({ add: [], remove: [], removeAll: true });
            expect(warnings).toContain('Dropped query-parameter change(s): Add/Remove entries next to "Remove All" (Requestly ignores them).');
        });
        afterMerge('Remove All passes the merged schema (and a non-boolean removeAll does not)', () => {
            const out = run(query([{ type: 'Remove All', param: '', value: '' }]));
            const rule = out.rules[0];
            expect(S.validateRule(rule).valid).toBe(true);
            const bad = JSON.parse(JSON.stringify(rule));
            bad.queryParams.removeAll = 'yes';
            expect(S.validateRule(bad).valid).toBe(false);
        });
        test('nothing usable is skipped', () => {
            expect(skipOf(query([]))).toBe('No query-parameter change could be imported.');
            expect(skipOf(query([{ type: 'Add', param: '', value: '1' }]))).toBe('No query-parameter change could be imported: a change without a parameter name.');
        });
    });

    describe('Response', () => {
        const response = (r, source, extra) => rec('Response', pair(source || src('Url', 'Contains', 'a.test'), Object.assign({ response: r }, extra)));
        test('static: status, status text and the body exactly as exported', () => {
            const body = '{"big":12345678901234567890,"1":"a","b":"\\u00e9"}';
            const { rule, warnings } = one(response({ type: 'static', resourceType: 'restApi', statusCode: '404', statusText: 'Not Found', value: body }));
            expect(rule.response).toEqual({ mode: 'static', statusCode: 404, statusText: 'Not Found', headers: {}, delay: 0, body });
            expect(warnings).toEqual([]);
            expect(S.validateRule(rule).valid).toBe(true);
        });
        test('static: no status code means 200, with a warning', () => {
            const { rule, warnings } = one(response({ type: 'static', statusCode: '', value: 'ok' }));
            expect(rule.response.statusCode).toBe(200);
            expect(rule.response).not.toHaveProperty('statusText');
            expect(warnings).toEqual(['No status code is set: Requestly keeps the server\'s status; SpliceTap answers 200.']);
        });
        test('static: headers, if present, are carried over and checked', () => {
            const { rule, warnings } = one(response({ type: 'static', statusCode: '200', value: '{}', headers: { 'X-One': '1', 'Bad Name': 'x', 'Set-Cookie': 'a=b' } }));
            expect(rule.response.headers).toEqual({ 'X-One': '1' });
            expect(warnings.join(' ')).toContain('Dropped response header "Bad Name"');
            expect(warnings.join(' ')).toContain('Dropped response header "Set-Cookie"');
            const list = one(response({ type: 'static', statusCode: '200', value: '', headers: [{ name: 'X-Two', value: '2' }] }));
            expect(list.rule.response.headers).toEqual({ 'X-Two': '2' });
        });
        test('code: wrapped so their function is called with Requestly\'s args; the status rides in an envelope', () => {
            const code = 'function modifyResponse(args) {\n  return { n: args.requestData };\n}';
            const { rule } = one(response({ type: 'code', statusCode: '202', value: code }));
            expect(rule.response.mode).toBe('code');
            expect(rule.response.code).toBe([
                'const args = { method: request.method, url: request.url, requestHeaders: request.headers, requestData: request.json !== undefined ? request.json : request.body };',
                'const body = await (',
                code,
                ')(args);',
                'return { status: 202, body };'
            ].join('\n'));
            expect(rule.response).not.toHaveProperty('statusCode');
            expect(S.validateRule(rule).valid).toBe(true);
        });
        test('code: runs, in SpliceTap\'s own shape, and returns what the function returns', async () => {
            const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
            const { rule } = one(response({ type: 'code', statusCode: '', value: 'async function modifyResponse(args) { return { m: args.method, u: args.url, h: args.requestHeaders.a, d: args.requestData }; };' }));
            const fn = new AsyncFunction('request', rule.response.code);
            const result = await fn({ url: 'https://a.test/x', method: 'POST', headers: { a: '1' }, json: { k: 1 }, body: '{"k":1}' });
            expect(result).toEqual({ body: { m: 'POST', u: 'https://a.test/x', h: '1', d: { k: 1 } } });
            const text = await fn({ url: 'u', method: 'POST', headers: {}, json: undefined, body: 'raw' });
            expect(text.body.d).toBe('raw');
        });
        test('code: warns about the real response, $sharedState, and the code-responses setting', () => {
            const reads = one(response({ type: 'code', statusCode: '', value: 'function modifyResponse(args) {\n  const { response } = args;\n  return response;\n}' }));
            expect(reads.warnings).toEqual([
                'The code reads the real response (response, responseJSON or responseType). SpliceTap\'s code mode does not fetch it, so those values are undefined.',
                'Code responses are off by default; turn them on in SpliceTap\'s settings.',
                'No status code is set: Requestly keeps the server\'s status; SpliceTap answers 200 unless the code says otherwise.'
            ]);
            const shared = one(response({ type: 'code', statusCode: '200', value: 'function f(args) { $sharedState.n = 1; return args.responseJSON.x; }' }));
            expect(shared.warnings).toEqual(expect.arrayContaining([
                expect.stringContaining('reads the real response'),
                'The code uses $sharedState, which SpliceTap does not provide; it will throw and the request goes to the network.'
            ]));
            // The default template mentions every field in its destructuring and a comment; that is not a use.
            const template = one(response({ type: 'code', statusCode: '200', value: 'function modifyResponse(args) {\n  const {method, url, response, responseType, requestHeaders, requestData, responseJSON} = args;\n  // Change response below\n  return {a: 1};\n}' }));
            expect(template.warnings).toEqual(['Code responses are off by default; turn them on in SpliceTap\'s settings.']);
        });
        test('code: a trailing semicolon or line comment cannot break the wrapper', () => {
            const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
            for (const value of ['function f() { return 1; };\n', 'function f() { return 1; } // done']) {
                const { rule } = one(response({ type: 'code', statusCode: '', value }));
                expect(() => new AsyncFunction('request', rule.response.code)).not.toThrow();
            }
        });
        test('skips: local files, compressed bodies, HTML/JS/CSS, bad status, empty code', () => {
            expect(skipOf(response({ type: 'local_file', value: '/tmp/x.json' }))).toBe('This response is served from a local file, which a browser extension cannot read.');
            expect(skipOf(response({ type: 'static', value: 'H4sI' }, null, { isCompressed: true }))).toBe('The response body is stored compressed in this export. Open the rule in Requestly and export it again.');
            expect(skipOf(response({ type: 'static', resourceType: 'static', value: '<html></html>' }))).toBe('This rule serves HTML, JS or CSS; SpliceTap mocks fetch and XHR responses only.');
            expect(skipOf(response({ type: 'static', statusCode: '99', value: '' }))).toBe('The status code "99" is not a whole number between 200 and 599.');
            expect(skipOf(response({ type: 'static', statusCode: 'ok', value: '' }))).toBe('The status code "ok" is not a whole number between 200 and 599.');
            expect(skipOf(response({ type: 'code', statusCode: '', value: '  ' }))).toBe('The response code is empty.');
            expect(skipOf(response({ type: 'carrier-pigeon', value: '' }))).toBe('Unknown response type "carrier-pigeon".');
            expect(skipOf(rec('Response', pair(src('Url', 'Contains', 'a'))))).toBe('It has no response settings.');
        });
    });

    describe('Request', () => {
        const request = (r, source) => rec('Request', pair(source || src('Url', 'Contains', 'a.test'), { request: r }));
        test('static -> requestBody static, text kept as exported', () => {
            const { rule } = one(request({ type: 'static', value: '{"a":1}' }, src('Url', 'Contains', 'a.test', [{ requestMethod: ['POST'] }])));
            expect(bare(rule)).toEqual({
                name: 'Request test', type: 'requestBody', enabled: true,
                match: { url: '*a.test*', method: 'POST' }, requestBody: { mode: 'static', body: '{"a":1}' }
            });
            expect(S.validateRule(rule).valid).toBe(true);
        });
        test('code is skipped with a reason; GET-only is refused by the schema', () => {
            expect(skipOf(request({ type: 'code', value: 'function f(){}' }))).toBe('Request bodies written as code are not supported; only a fixed (static) request body can be imported.');
            expect(skipOf(request({ type: 'static', value: '{}' }, src('Url', 'Contains', 'a', [{ requestMethod: ['GET'] }])))).toMatch(/^HTTP method for a request body rule cannot be GET or HEAD/);
            expect(skipOf(rec('Request', pair(src('Url', 'Contains', 'a'))))).toBe('It has no request settings.');
        });
    });

    test('UserAgent -> headers rule with a request User-Agent', () => {
        const { rule } = one(rec('UserAgent', pair(src('Url', 'Contains', 'a.test'), { userAgent: 'Googlebot/2.1' })));
        expect(rule.type).toBe('headers');
        expect(rule.headersMod).toEqual({ request: [{ op: 'set', name: 'User-Agent', value: 'Googlebot/2.1' }] });
        expect(S.validateRule(rule).valid).toBe(true);
        expect(skipOf(rec('UserAgent', pair(src('Url', 'Contains', 'a.test'), { userAgent: ' ' })))).toBe('The rule has no User-Agent value.');
        expect(skipOf(rec('UserAgent', pair(src('Url', 'Contains', 'a.test'), { userAgent: 'café—' })))).toMatch(/^The User-Agent value cannot be sent:/);
    });

    describe('Replace', () => {
        const replace = (source, from, to) => rec('Replace', pair(source, { from, to }));
        test('a URL Contains condition that includes the text: one rule per scheme', () => {
            const out = run(replace(src('Url', 'Contains', 'example.com'), 'example', 'example1'));
            expect(out.skipped).toEqual([]);
            expect(out.rules.map((r) => [r.name, r.match.url, r.redirect.destination, r.appliesTo])).toEqual([
                ['Replace test (http)', '/^http:\\/\\/(.*?)example(\\.com.*)/', 'http://$1example1$2', 'all'],
                ['Replace test (https)', '/^https:\\/\\/(.*?)example(\\.com.*)/', 'https://$1example1$2', 'all']
            ]);
            expect(out.warnings).toEqual([{ name: 'Replace test (http)', message: 'Imported as one rule per scheme (http and https), because a SpliceTap redirect destination has to start with a full URL.' }]);
            for (const rule of out.rules) expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
        });
        test('the pattern matches the URLs Requestly would rewrite, and the destination is the rewritten URL', () => {
            const { rules } = run(replace(src('Url', 'Contains', 'https://api.example.com/v1'), '/v1', '/v2'));
            expect(rules).toHaveLength(1);
            const [rule] = rules;
            const rewrite = (url) => {
                const m = new RegExp(rule.match.url.slice(1, -1), 'i').exec(url);
                return m && rule.redirect.destination.replace(/\$(\d)/g, (_, n) => m[Number(n)]);
            };
            expect(rewrite('https://api.example.com/v1/users?x=1')).toBe('https://api.example.com/v2/users?x=1');
            expect(rewrite('https://api.example.com/v1/v1/z')).toBe('https://api.example.com/v2/v1/z');
            expect(rewrite('https://other.test/v1/users')).toBeNull();
            expect(rewrite('http://api.example.com/v1/users')).toBeNull();
        });
        test('Equals replaces within the whole URL; repeated text is replaced each time', () => {
            const { rule } = one(replace(src('Url', 'Equals', 'https://a.test/x/x'), 'x', 'y'));
            const m = new RegExp(rule.match.url.slice(1, -1), 'i').exec('https://a.test/x/x');
            expect(rule.redirect.destination).toBe('https://$1y$2y$3');
            expect([m[1], m[2], m[3]]).toEqual(['a.test/', '/', '']);
            expect(new RegExp(rule.match.url.slice(1, -1), 'i').test('https://a.test/x/x/more')).toBe(false);
        });
        test('an empty condition replaces the first occurrence in any URL', () => {
            const out = run(replace(src('Url', 'Contains', ''), 'cdn.test', 'localhost'));
            expect(out.rules.map((r) => r.redirect.destination)).toEqual(['http://$1localhost$2', 'https://$1localhost$2']);
            expect(out.warnings.map((w) => w.message)).toContain('The URL condition is empty, so this rule applies to every request whose URL contains the replaced text.');
        });
        test('skips what cannot be expressed faithfully', () => {
            expect(skipOf(replace(src('Url', 'Matches', '/a+/'), 'a', 'b'))).toMatch(/^SpliceTap cannot combine this Replace rule's URL condition/);
            expect(skipOf(replace(src('Url', 'Contains', 'a.test'), 'zzz', 'b'))).toMatch(/^SpliceTap cannot combine/);
            expect(skipOf(replace(src('host', 'Equals', 'a.test'), 'a', 'b'))).toMatch(/^SpliceTap cannot combine/);
            expect(skipOf(replace(src('Url', 'Contains', 'a.test'), '/a/', 'b'))).toMatch(/^The text to replace is wrapped in slashes/);
            expect(skipOf(replace(src('Url', 'Contains', 'a.test'), 'a', '$1'))).toMatch(/^The replacement text contains \$ followed by a digit/);
            expect(skipOf(replace(src('Url', 'Contains', 'https://a.test'), 'https://', 'http://'))).toBe('The replacement changes the URL scheme, which SpliceTap cannot express.');
            expect(skipOf(replace(src('Url', 'Equals', 'a.test/x'), 'x', 'y'))).toBe('An "equals" condition without a scheme can never match a full URL.');
            expect(skipOf(replace(src('Url', 'Contains', 'a.test'), '', 'y'))).toBe('The Replace rule has no text to replace.');
        });
        test('a replacement the schema cannot take as a URL is skipped with its reason', () => {
            const reason = skipOf(replace(src('Url', 'Contains', 'https://api.example.com'), 'example.com', 'localhost:3000'));
            expect(reason).toMatch(/^Redirect destination must be an http\(s\) URL/);
        });
    });

    test('Script and unknown types are skipped', () => {
        expect(skipOf(rec('Script', pair(src('Url', 'Contains', 'a'), { scripts: [] })))).toBe('Script rules (injecting JavaScript or CSS into pages) are not supported by SpliceTap.');
        expect(skipOf(rec('Teleport', pair(src('Url', 'Contains', 'a'))))).toBe('Unknown Requestly rule type "Teleport".');
    });

    test('a rule with several pairs becomes several rules, numbered', () => {
        const record = rec('Cancel', [pair(src('Url', 'Contains', 'a.test')), pair(src('Url', 'Contains', 'b.test')), null], { name: 'Two and a half' });
        const out = run(record);
        expect(out.rules.map((r) => [r.name, r.match.url])).toEqual([['Two and a half #1', '*a.test*'], ['Two and a half #2', '*b.test*']]);
        expect(out.skipped).toEqual([{ name: 'Two and a half #3', reason: 'The pair is not an object.' }]);
    });
});

describe('source conditions: key x operator', () => {
    // [key, operator, value, urls it must match, urls it must not]
    const table = [
        ['Url', 'Equals', 'https://a.test/x?y=1', ['https://a.test/x?y=1'], ['https://a.test/x?y=12', 'https://a.test/x', 'xhttps://a.test/x?y=1']],
        ['Url', 'Contains', '/api/', ['https://a.test/api/x'], ['https://a.test/v1']],
        ['Url', 'Wildcard_Matches', 'https://a.test/*/items', ['https://a.test/9/items'], ['https://a.test/9/items/1']],
        ['Url', 'Wildcard_Matches', 'https://a.test/x', ['https://a.test/x'], ['https://a.test/x/y', 'https://a.test/xy']],
        ['Url', 'Matches', '/^https:\\/\\/a\\.test\\/\\d+$/', ['https://a.test/12'], ['https://a.test/ab', 'https://a.test/12/3']],
        ['host', 'Equals', 'api.example.com', ['https://api.example.com/x', 'http://api.example.com', 'https://api.example.com?x=1'], ['https://api.example.com:8443/x', 'https://xapi.example.com/', 'https://evil.test/api.example.com']],
        ['host', 'Equals', 'localhost:3000', ['http://localhost:3000/a'], ['http://localhost:3001/a']],
        ['host', 'Contains', 'example', ['https://api.example.com/x'], ['https://a.test/example']],
        ['host', 'Matches', '/^api\\.(dev|stage)\\.test$/', ['https://api.dev.test/x', 'https://api.stage.test'], ['https://api.dev.test.evil.com/x', 'https://x.api.dev.test/']],
        ['host', 'Matches', '/example\\.(com|org)/', ['https://a.example.org/'], ['https://a.test/example.com']],
        ['host', 'Wildcard_Matches', '*.example.com', ['https://api.example.com/x'], ['https://example.com/', 'https://api.example.com.evil.test/']],
        ['path', 'Equals', '/api/users', ['https://a.test/api/users', 'https://a.test/api/users?x=1'], ['https://a.test/api/users/1', 'https://a.test/x?p=/api/users']],
        ['path', 'Equals', '/', ['https://a.test', 'https://a.test/', 'https://a.test/?x'], ['https://a.test/a']],
        ['path', 'Contains', '/api/', ['https://a.test/v1/api/x'], ['https://api.test/', 'https://a.test/x?q=/api/']],
        ['path', 'Contains', 'users', ['https://a.test/api/users/1'], ['https://users.test/', 'https://a.test/x?q=users']],
        ['path', 'Matches', '/^\\/api\\/\\d+$/', ['https://a.test/api/12', 'https://a.test/api/12?x'], ['https://a.test/api/12/3', 'https://a.test/z/api/12']],
        ['path', 'Matches', '/users\\/\\d+/', ['https://a.test/api/users/5'], ['https://a.test/?q=users/5']],
        ['path', 'Wildcard_Matches', '/api/*', ['https://a.test/api/x/y?q=1'], ['https://a.test/v1/api/x']]
    ];
    test.each(table)('%s %s %p', (key, operator, value, yes, no) => {
        const out = run(cancel(src(key, operator, value)));
        expect(out.skipped).toEqual([]);
        const [rule] = out.rules;
        expect(S.validateRule(rule)).toEqual({ valid: true, errors: [] });
        for (const url of yes) expect([url, hits(rule.match.url, url)]).toEqual([url, true]);
        for (const url of no) expect([url, hits(rule.match.url, url)]).toEqual([url, false]);
    });

    test('exact patterns', () => {
        expect(patternOf(src('Url', 'Equals', 'https://a.test/x?y=1'))).toBe('/^https:\\/\\/a\\.test\\/x\\?y=1$/');
        expect(patternOf(src('Url', 'Contains', '/api/'))).toBe('*/api/*');
        expect(patternOf(src('Url', 'Contains', 'a*b'))).toBe('/a\\*b/');
        expect(patternOf(src('Url', 'Wildcard_Matches', 'https://a.test/*'))).toBe('https://a.test/*');
        expect(patternOf(src('Url', 'Wildcard_Matches', 'https://a.test/x'))).toBe('/^https://a\\.test/x$/');
        expect(patternOf(src('Url', 'Matches', 'a\\.test'))).toBe('/a\\.test/');
        expect(patternOf(src('host', 'Equals', 'api.example.com'))).toBe('/^https?:\\/\\/api\\.example\\.com(?:[\\/?#]|$)/');
        expect(patternOf(src('host', 'Contains', 'example'))).toBe('/^https?:\\/\\/[^\\/?#]*example/');
        expect(patternOf(src('path', 'Equals', '/api/users'))).toBe('/^https?:\\/\\/[^\\/?#]*\\/api\\/users(?:[?#]|$)/');
        expect(patternOf(src('path', 'Contains', '/api/'))).toBe('/^https?:\\/\\/[^?#]*\\/api\\//');
    });

    test('regex special characters in Equals and Contains values are escaped', () => {
        const nasty = 'https://a.test/(x)+[y]{2}|z^$?.*\\';
        const equals = patternOf(src('Url', 'Equals', nasty));
        expect(hits(equals, nasty)).toBe(true);
        expect(hits(equals, 'https://a.test/xxyyz')).toBe(false);
        const contains = patternOf(src('Url', 'Contains', 'a(b)+c.d?e*f'));
        expect(hits(contains, 'https://z.test/a(b)+c.d?e*f/more')).toBe(true);
        expect(hits(contains, 'https://z.test/abbc_d_eeef')).toBe(false);
        const host = patternOf(src('host', 'Equals', 'a+b.test'));
        expect(hits(host, 'https://a+b.test/x')).toBe(true);
        expect(hits(host, 'https://aab.test/x')).toBe(false);
        const pathContains = patternOf(src('path', 'Contains', '/a.b'));
        expect(hits(pathContains, 'https://x.test/a.b')).toBe(true);
        expect(hits(pathContains, 'https://x.test/aXb')).toBe(false);
    });

    test('a wildcard that would read as /regex/ becomes a regex that still means the wildcard', () => {
        const pattern = patternOf(src('Url', 'Wildcard_Matches', '/a/*/b/'));
        expect(hits(pattern, '/a/zz/b/')).toBe(true);
        expect(hits(pattern, '/a/zz/b/c')).toBe(false);
    });

    test('regex flags are dropped with a warning; a bare pattern is accepted', () => {
        const flagged = one(cancel(src('Url', 'Matches', '/^https:\\/\\/a\\.test\\/(\\d+)$/gi')));
        expect(flagged.rule.match.url).toBe('/^https:\\/\\/a\\.test\\/(\\d+)$/');
        expect(flagged.warnings).toEqual(['Regex flags "gi" were dropped: SpliceTap matches case-insensitively and has no flags.']);
        expect(urlWarnings(src('Url', 'Matches', '/a\\.test/'))).toEqual([]);
        expect(urlWarnings(src('Url', 'Matches', 'a\\.test'))).toEqual([]);
    });

    test('a host or path regex is rewritten for the whole URL, and the warning says so', () => {
        expect(urlWarnings(src('host', 'Matches', '/^api\\./'))).toEqual(['The host pattern was rewritten to look only at the URL\'s host; check it still matches what you expect.']);
        expect(urlWarnings(src('path', 'Matches', '/^\\/a/'))).toEqual(['The path pattern was rewritten to look only at the URL\'s path; check it still matches what you expect.']);
    });

    test('a wildcard written with regex characters is read as Requestly reads it, with a warning', () => {
        const { rule, warnings } = one(cancel(src('Url', 'Wildcard_Matches', 'https://a.test/(x|y)/*')));
        expect(hits(rule.match.url, 'https://a.test/y/1')).toBe(true);
        expect(hits(rule.match.url, 'https://a.test/(x|y)/1')).toBe(false);
        expect(warnings).toEqual(['The wildcard contains regex characters; Requestly evaluates them as a regular expression, and so does this import.']);
    });

    test('an empty condition matches everything, and says so', () => {
        const { rule, warnings } = one(cancel(src('Url', 'Contains', '')));
        expect(rule.match.url).toBe('*');
        expect(warnings).toEqual(['The URL condition is empty, so this rule matches every request.']);
    });

    test('keys and operators are read case-insensitively; Wildcard is accepted for Wildcard_Matches', () => {
        expect(patternOf(src('URL', 'contains', 'a.test'))).toBe('*a.test*');
        expect(patternOf(src('Host', 'EQUALS', 'a.test'))).toBe('/^https?:\\/\\/a\\.test(?:[\\/?#]|$)/');
        expect(patternOf(src('Url', 'Wildcard', 'a*'))).toBe('a*');
    });

    test('skips: bad regexes, unreachable paths, host values with path characters, over-long patterns', () => {
        expect(skipOf(cancel(src('Url', 'Matches', '/(unclosed/')))).toBe('The regular expression "/(unclosed/" is not valid.');
        expect(skipOf(cancel(src('Url', 'Matches', '//')))).toBe('The regular expression "//" is not written as /pattern/.');
        expect(skipOf(cancel(src('Url', 'Matches', '/abc')))).toBe('The regular expression "/abc" is not written as /pattern/.');
        expect(skipOf(cancel(src('path', 'Equals', 'api')))).toMatch(/^A path condition has to start with "\/"/);
        expect(skipOf(cancel(src('path', 'Wildcard_Matches', 'api/*')))).toMatch(/^A path condition has to start with "\/"/);
        expect(skipOf(cancel(src('host', 'Equals', 'a.test/x')))).toBe('A host condition cannot contain "/", "?" or "#".');
        expect(skipOf(cancel(src('host', 'Matches', '/^a|b$/')))).toMatch(/mixes anchors with alternatives/);
        expect(skipOf(cancel(src('Url', 'Contains', 'x'.repeat(600))))).toMatch(/^Invalid URL pattern: Pattern is too long/);
    });

    test('a regex Chrome\'s network layer cannot run is skipped only for rules applied there', () => {
        const lookahead = src('Url', 'Matches', '/a(?=b)/');
        expect(skipOf(cancel(lookahead))).toMatch(/^The regular expression uses a lookahead/);
        expect(skipOf(rec('Headers', pair(lookahead, { modifications: { Request: [{ header: 'X-A', type: 'Add', value: '1' }] } })))).toMatch(/^The regular expression uses a lookahead/);
        // In the page the same pattern is fine.
        expect(one(rec('Delay', pair(lookahead, { delay: '100' }))).rule.match.url).toBe('/a(?=b)/');
    });
});

describe('filters', () => {
    const withFilters = (filters, ruleType, extra) => rec(ruleType || 'Cancel', pair(src('Url', 'Contains', 'a.test', filters), extra));
    const headerPair = { modifications: { Request: [{ header: 'X-A', type: 'Add', value: '1' }] } };
    const delayPair = { delay: '100' };

    describe('requestMethod -> match.method', () => {
        test('one method', () => {
            expect(one(withFilters([{ requestMethod: ['POST'] }])).rule.match.method).toBe('POST');
            expect(one(withFilters([{ requestMethod: ['delete'] }])).rule.match.method).toBe('DELETE');
        });
        test('several: the first is used and the rest are named in a warning', () => {
            const { rule, warnings } = one(withFilters([{ requestMethod: ['PUT', 'PATCH', 'PUT'] }]));
            expect(rule.match.method).toBe('PUT');
            expect(warnings).toEqual(['SpliceTap matches one method per rule: kept PUT, dropped PATCH. Duplicate the rule for each method.']);
        });
        test('every supported method means any; none given means any', () => {
            const all = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
            const { rule, warnings } = one(withFilters([{ requestMethod: all }]));
            expect(rule.match.method).toBe('*');
            expect(warnings).toEqual([]);
            expect(one(withFilters([{ requestMethod: [] }])).rule.match.method).toBe('*');
        });
        test('methods SpliceTap cannot match: ignored if others remain, a skip if none do', () => {
            const mixed = one(withFilters([{ requestMethod: ['CONNECT', 'GET'] }]));
            expect(mixed.rule.match.method).toBe('GET');
            expect(mixed.warnings).toEqual(['Ignored request method(s) SpliceTap cannot match: CONNECT.']);
            expect(skipOf(withFilters([{ requestMethod: ['CONNECT'] }]))).toBe('The rule only applies to CONNECT requests, which SpliceTap cannot match.');
        });
    });

    describe('pageDomains and pageUrl -> match.pageDomains', () => {
        test('pageDomains are lowercased, cleaned and de-duplicated', () => {
            const { rule } = one(withFilters([{ pageDomains: ['Example.com', 'https://app.example.org/x', 'example.com', 'localhost:3000', '*.shop.test', '10.0.0.1'] }]));
            expect(rule.match.pageDomains).toEqual(['example.com', 'app.example.org', 'localhost', 'shop.test', '10.0.0.1']);
        });
        test('names that are not hosts are dropped with a warning; none left means the filter is gone, loudly', () => {
            const some = one(withFilters([{ pageDomains: ['ok.test', 'not a host', 'under_score.test', '[::1]'] }]));
            expect(some.rule.match.pageDomains).toEqual(['ok.test']);
            expect(some.warnings).toEqual([
                'Page domain "not a host" was dropped: it is not a plain host name.',
                'Page domain "under_score.test" was dropped: it is not a plain host name.',
                'Page domain "[::1]" was dropped: it is not a plain host name.'
            ]);
            const none = one(withFilters([{ pageDomains: ['not a host'] }]));
            expect(none.rule.match).not.toHaveProperty('pageDomains');
            expect(none.warnings).toContain('The page-domain filter was dropped, so this rule applies on every page.');
        });
        test('more than 20 are cut to 20, with a warning', () => {
            const many = Array.from({ length: 23 }, (_, i) => `h${i}.test`);
            const { rule, warnings } = one(withFilters([{ pageDomains: many }]));
            expect(rule.match.pageDomains).toEqual(many.slice(0, 20));
            expect(warnings).toEqual(['SpliceTap allows 20 page domains; the first 20 of 23 were kept.']);
        });
        test('pageUrl: the host is taken for each operator that can carry one', () => {
            const domains = (pageUrl) => one(withFilters([{ pageUrl }])).rule.match.pageDomains;
            expect(domains({ operator: 'Equals', value: 'https://app.example.com' })).toEqual(['app.example.com']);
            expect(domains({ operator: 'Contains', value: 'example.com' })).toEqual(['example.com']);
            expect(domains({ operator: 'Wildcard_Matches', value: '*://*.example.com/*' })).toEqual(['example.com']);
            expect(domains({ operator: 'Wildcard_Matches', value: 'https://app.example.com/*' })).toEqual(['app.example.com']);
        });
        test('pageUrl with a path says the whole site is now matched', () => {
            const { rule, warnings } = one(withFilters([{ pageUrl: { operator: 'Equals', value: 'https://app.example.com/dashboard' } }]));
            expect(rule.match.pageDomains).toEqual(['app.example.com']);
            expect(warnings).toEqual(['The page URL "https://app.example.com/dashboard" became the page domain "app.example.com": SpliceTap matches the whole site, not one page.']);
        });
        test('pageUrl that gives no host (a regex, junk) is dropped with a warning', () => {
            for (const pageUrl of [{ operator: 'Matches', value: '/^https:\\/\\/app\\./' }, { operator: 'Equals', value: 'two words' }]) {
                const { rule, warnings } = one(withFilters([{ pageUrl }]));
                expect(rule.match).not.toHaveProperty('pageDomains');
                expect(warnings).toEqual([`The page URL filter "${pageUrl.value}" was dropped because no host could be taken from it, so this rule applies on every page.`]);
            }
        });
        test('pageDomains wins over pageUrl, as in Requestly\'s own migration', () => {
            const { rule, warnings } = one(withFilters([{ pageDomains: ['a.test'], pageUrl: { operator: 'Contains', value: 'b.test' } }]));
            expect(rule.match.pageDomains).toEqual(['a.test']);
            expect(warnings).toEqual([]);
        });
        afterMerge('pageDomains pass the merged schema (and a malformed one does not)', () => {
            const out = run(withFilters([{ pageDomains: ['example.com'] }]));
            const rule = out.rules[0];
            expect(S.validateRule(rule).valid).toBe(true);
            const bad = JSON.parse(JSON.stringify(rule));
            bad.match.pageDomains = ['Not A Host!'];
            expect(S.validateRule(bad).valid).toBe(false);
        });
    });

    describe('resourceType -> match.resourceTypes', () => {
        test('block and redirect (all requests): every Requestly type is mapped', () => {
            const types = ['xmlhttprequest', 'main_frame', 'sub_frame', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket'];
            const { rule } = one(withFilters([{ resourceType: types }]));
            expect(rule.match.resourceTypes).toEqual(['fetch-xhr', 'document', 'subdocument', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket']);
            expect(rule.appliesTo).toBe('all');
        });
        test('older Chrome names are folded in; duplicates are removed', () => {
            const { rule } = one(withFilters([{ resourceType: ['object', 'other', 'ping', 'csp_report', 'xhr'] }]));
            expect(rule.match.resourceTypes).toEqual(['other', 'ping', 'fetch-xhr']);
        });
        test('headers and query parameters keep the filter', () => {
            const { rule, warnings } = one(withFilters([{ resourceType: ['image'] }], 'Headers', headerPair));
            expect(rule.match.resourceTypes).toEqual(['image']);
            expect(warnings).toEqual([]);
        });
        test('unknown names are ignored with a warning; only unknown ones is a skip', () => {
            const some = one(withFilters([{ resourceType: ['script', 'teleport'] }]));
            expect(some.rule.match.resourceTypes).toEqual(['script']);
            expect(some.warnings).toEqual(['Ignored unknown resource type(s): teleport.']);
            expect(skipOf(withFilters([{ resourceType: ['teleport'] }]))).toBe('The rule is limited to resource types SpliceTap does not know (teleport).');
        });
        test('in-page rules (mock, delay, request body): fetch/XHR is the only type, so the filter is dropped; others are a skip', () => {
            const xhr = one(withFilters([{ resourceType: ['xmlhttprequest'] }], 'Delay', delayPair));
            expect(xhr.rule.match).not.toHaveProperty('resourceTypes');
            const both = one(withFilters([{ resourceType: ['xmlhttprequest', 'image'] }], 'Delay', delayPair));
            expect(both.rule.match).not.toHaveProperty('resourceTypes');
            expect(both.warnings).toContain('The rule also listed image; SpliceTap applies this kind of rule to fetch and XHR requests only.');
            expect(skipOf(withFilters([{ resourceType: ['image', 'script'] }], 'Delay', delayPair)))
                .toBe('The rule only applies to image, script requests, but SpliceTap applies this kind of rule to fetch and XHR requests only.');
        });
        afterMerge('resourceTypes pass the merged schema (and an unknown one does not)', () => {
            const rule = run(withFilters([{ resourceType: ['image'] }])).rules[0];
            expect(S.validateRule(rule).valid).toBe(true);
            const bad = JSON.parse(JSON.stringify(rule));
            bad.match.resourceTypes = ['nonsense'];
            expect(S.validateRule(bad).valid).toBe(false);
        });
    });

    describe('requestPayload -> match.payload', () => {
        const payload = (p) => [{ requestPayload: p }];
        const mockPair = { response: { type: 'static', statusCode: '200', value: '{}' } };
        test('Equals and Contains (any case) on a mock', () => {
            const equals = one(withFilters(payload({ key: 'user.id', operator: 'Equals', value: '7' }), 'Response', mockPair));
            expect(equals.rule.match.payload).toEqual({ path: 'user.id', operator: 'equals', value: '7' });
            const contains = one(withFilters(payload({ key: 'items.0.sku', operator: 'Contains', value: 'AB' }), 'Response', mockPair));
            expect(contains.rule.match.payload).toEqual({ path: 'items.0.sku', operator: 'contains', value: 'AB' });
            const bare = one(withFilters(payload({ key: 'operationName', value: 'GetUser' }), 'Response', mockPair));
            expect(bare.rule.match.payload).toEqual({ path: 'operationName', operator: 'equals', value: 'GetUser' });
            expect(one(withFilters(payload({ key: 'n', operator: 'Equals', value: 3 }), 'Response', mockPair)).rule.match.payload.value).toBe('3');
        });
        test('block and redirect become page rules, because only the page can read a request body', () => {
            const block = one(withFilters(payload({ key: 'a', operator: 'Equals', value: '1' }), 'Cancel'));
            expect(block.rule.appliesTo).toBe('page');
            expect(block.rule.match.payload).toEqual({ path: 'a', operator: 'equals', value: '1' });
            expect(block.warnings).toEqual(['A request-payload filter can only be checked in the page, so this rule now applies to fetch and XHR requests only.']);
            const redirect = one(withFilters(payload({ key: 'a', value: '1' }), 'Redirect', { destination: 'https://b.test/' }));
            expect(redirect.rule.appliesTo).toBe('page');
            expect(redirect.rule.match.payload).toBeDefined();
            const delay = one(withFilters(payload({ key: 'a', value: '1' }), 'Delay', delayPair));
            expect(delay.rule.match.payload).toBeDefined();
            const body = one(withFilters(payload({ key: 'a', value: '1' }), 'Request', { request: { type: 'static', value: '{}' } }));
            expect(body.rule.match.payload).toBeDefined();
        });
        test('headers and query-parameter rules cannot read a body, so they are skipped', () => {
            expect(skipOf(withFilters(payload({ key: 'a', value: '1' }), 'Headers', headerPair))).toMatch(/^A request-payload filter needs the request body/);
            expect(skipOf(withFilters(payload({ key: 'a', value: '1' }), 'QueryParam', { modifications: [{ type: 'Add', param: 'a', value: '1' }] }))).toMatch(/^A request-payload filter needs the request body/);
        });
        test('a block with a payload filter and a non-fetch resource type is a skip', () => {
            expect(skipOf(withFilters([{ requestPayload: { key: 'a', value: '1' }, resourceType: ['image'] }], 'Cancel')))
                .toBe('The rule only applies to image requests, but SpliceTap applies this kind of rule to fetch and XHR requests only.');
        });
        test('filters Requestly never matches, or SpliceTap cannot hold, are skipped', () => {
            expect(skipOf(withFilters(payload({ key: 'a', operator: 'Matches', value: '1' }), 'Cancel')))
                .toMatch(/^The request-payload filter uses the "Matches" operator/);
            expect(skipOf(withFilters(payload({ key: '', value: '1' }), 'Cancel'))).toMatch(/has no usable key path/);
            expect(skipOf(withFilters(payload({ key: 'a..b', value: '1' }), 'Cancel'))).toMatch(/has no usable key path/);
            expect(skipOf(withFilters(payload({ key: 'a' }), 'Cancel'))).toMatch(/has no value/);
            expect(skipOf(withFilters(payload({ key: 'k'.repeat(201), value: '1' }), 'Cancel'))).toBe('The request-payload key path is longer than 200 characters.');
            expect(skipOf(withFilters(payload({ key: 'a', value: 'v'.repeat(1001) }), 'Cancel'))).toBe('The request-payload value is longer than 1000 characters.');
        });
        test('an empty payload object is no filter', () => {
            const { rule } = one(withFilters(payload({}), 'Cancel'));
            expect(rule.appliesTo).toBe('all');
            expect(rule.match).not.toHaveProperty('payload');
        });
        afterMerge('payload passes the merged schema (and a bad operator does not)', () => {
            const rule = run(withFilters(payload({ key: 'a.b', operator: 'Equals', value: '1' }), 'Response', mockPair)).rules[0];
            expect(S.validateRule(rule).valid).toBe(true);
            const bad = JSON.parse(JSON.stringify(rule));
            bad.match.payload.operator = 'regex';
            expect(S.validateRule(bad).valid).toBe(false);
        });
    });

    test('filters may be an object, null, empty, or have several groups', () => {
        expect(one(withFilters({ requestMethod: ['PUT'] })).rule.match.method).toBe('PUT');
        expect(one(withFilters(null)).rule.match.method).toBe('*');
        expect(one(withFilters([])).rule.match.method).toBe('*');
        expect(one(withFilters([{}, { requestMethod: [] }])).rule.match.method).toBe('*');
        const several = one(withFilters([{ requestMethod: ['PUT'] }, { requestMethod: ['POST'] }]));
        expect(several.rule.match.method).toBe('PUT');
        expect(several.warnings).toEqual(['The condition has 2 filter groups; only the first was imported, as Requestly\'s in-page matcher does.']);
    });

    test('all filters at once', () => {
        const { rule } = one(rec('Response', pair(
            src('Url', 'Contains', 'a.test', [{
                requestMethod: ['POST'], pageDomains: ['app.test'], resourceType: ['xmlhttprequest'],
                requestPayload: { key: 'q', operator: 'Contains', value: 'x' }
            }]),
            { response: { type: 'static', statusCode: '200', value: 'ok' } }
        )));
        expect(rule.match).toEqual({
            url: '*a.test*', method: 'POST', pageDomains: ['app.test'], payload: { path: 'q', operator: 'contains', value: 'x' }
        });
    });
});

describe('status, groups and inactive rules', () => {
    test('enabled follows status "Active"', () => {
        expect(one(cancel(src('Url', 'Contains', 'a'), { status: 'Active' })).rule.enabled).toBe(true);
        expect(one(cancel(src('Url', 'Contains', 'a'), { status: 'Inactive' })).rule.enabled).toBe(false);
        expect(one(cancel(src('Url', 'Contains', 'a'), { status: undefined })).rule.enabled).toBe(false);
    });
    test('a condition switched off (source.isActive false) imports turned off, with a warning', () => {
        const { rule, warnings } = one(cancel(Object.assign(src('Url', 'Contains', 'a'), { isActive: false })));
        expect(rule.enabled).toBe(false);
        expect(warnings).toEqual(['The condition is switched off in Requestly, so the rule is imported turned off.']);
    });
    test('groups are not supported: rules are kept, one warning is given, and an inactive group switches its rules off', () => {
        const out = importer.convert(fixture('groups.json'));
        expect(out.skipped).toEqual([]);
        expect(out.rules.map((r) => [r.name, r.enabled])).toEqual([['Block metrics', true], ['Block pixels', false], ['Block beacons', true]]);
        expect(out.warnings).toEqual([
            { name: 'Block pixels', message: 'Turned off because its group "Retired" is inactive in Requestly.' },
            { name: 'Requestly file', message: 'Groups are not supported yet: 2 group(s) (Staging, Retired) were ignored and their rules imported without them.' }
        ]);
        for (const rule of out.rules) expect(rule).not.toHaveProperty('groupId');
    });
    test('rules naming a group that is not in the file get the same single warning', () => {
        const out = importer.convert([cancel(src('Url', 'Contains', 'a'), { groupId: 'Group_x' }), cancel(src('Url', 'Contains', 'b'), { groupId: 'Group_y' })]);
        expect(out.rules).toHaveLength(2);
        expect(out.warnings).toEqual([{ name: 'Requestly file', message: 'Groups are not supported yet: rules that belonged to a group were imported without it.' }]);
    });
    test('no groups, no warning', () => {
        expect(importer.convert([cancel(src('Url', 'Contains', 'a'))]).warnings).toEqual([]);
    });
    test('groups can arrive beside the rules in an object', () => {
        const out = importer.convert({ rules: [cancel(src('Url', 'Contains', 'a'), { groupId: 'G' })], groups: [{ objectType: 'group', id: 'G', name: 'Grp', status: 'Active' }] });
        expect(out.rules).toHaveLength(1);
        expect(out.warnings[0].message).toContain('1 group(s) (Grp)');
    });
});

describe('malformed input', () => {
    test('each bad entry is skipped with a reason and the good one survives', () => {
        const out = importer.convert(fixture('malformed.json'));
        expect(out.rules.map((r) => r.name)).toEqual(['Survivor']);
        expect(out.skipped).toEqual([
            { name: 'Entry 1', reason: 'It is not a rule object.' },
            { name: 'Entry 2', reason: 'It is not a rule object.' },
            { name: 'Entry 3', reason: 'It is not a rule object.' },
            { name: 'Entry 4', reason: 'It is not a rule or a group (no objectType "rule" or "group").' },
            { name: 'No type', reason: 'It has no rule type.' },
            { name: 'Unknown type', reason: 'Unknown Requestly rule type "Teleport".' },
            { name: 'No pairs', reason: 'It has no pairs (conditions).' },
            { name: 'Empty pairs', reason: 'It has no pairs (conditions).' },
            { name: 'Pair is null', reason: 'The pair is not an object.' },
            { name: 'No source', reason: 'It has no URL condition (source).' },
            { name: 'Bad key', reason: 'Unsupported condition key "Header".' },
            { name: 'Bad operator', reason: 'Unsupported condition operator "StartsWith".' },
            { name: 'Bad regex', reason: 'The regular expression "/(unclosed/" is not valid.' }
        ]);
    });
    test('input that is not a Requestly file converts nothing and says why', () => {
        for (const junk of [null, 7, '{bad', {}, { rules: 3 }]) {
            expect(importer.convert(junk)).toEqual({
                rules: [], warnings: [],
                skipped: [{ name: 'Requestly file', reason: 'This is not a Requestly rules export (expected a JSON list of rules and groups).' }]
            });
        }
        expect(importer.convert([])).toEqual({ rules: [], skipped: [], warnings: [] });
    });
    test('a hostile export cannot reach Object.prototype or crash the converter', () => {
        const hostile = JSON.parse('[{"objectType":"rule","ruleType":"Response","name":"h","status":"Active","pairs":[{"source":{"key":"Url","operator":"Contains","value":"a"},"response":{"type":"static","statusCode":"200","value":"x","headers":{"__proto__":"polluted","X-A":"1"}}}]},{"objectType":"rule","ruleType":"Headers","name":"p","status":"Active","pairs":[{"source":{"key":"Url","operator":"Contains","value":"a"},"modifications":{"Request":[{"header":"__proto__","type":"Add","value":"x"}]}}]}]');
        const out = importer.convert(hostile);
        expect(({}).polluted).toBeUndefined();
        expect(out.rules).toHaveLength(1);
        expect(Object.keys(out.rules[0].response.headers)).toEqual(['X-A']);
        expect(out.skipped).toHaveLength(1);
    });
});

describe('names and ids', () => {
    test('names are cleaned and cut to SpliceTap\'s 100 characters', () => {
        const long = 'n'.repeat(150);
        const { rule } = one(cancel(src('Url', 'Contains', 'a'), { name: long }));
        expect(rule.name).toHaveLength(100);
        expect(rule.name.endsWith('…')).toBe(true);
        expect(S.validateRule(rule).valid).toBe(true);
        expect(one(cancel(src('Url', 'Contains', 'a'), { name: '  two\n lines\t here ' })).rule.name).toBe('two lines here');
        expect(one(cancel(src('Url', 'Contains', 'a'), { name: '' })).rule.name).toBe('Unnamed Cancel');
        expect(one(cancel(src('Url', 'Contains', 'a'), { name: undefined })).rule.name).toBe('Unnamed Cancel');
    });
    test('numbered and scheme suffixes still fit in 100 characters, and no surrogate pair is cut', () => {
        const name = '\u{1F600}'.repeat(80);
        const out = run(rec('Cancel', [pair(src('Url', 'Contains', 'a')), pair(src('Url', 'Contains', 'b'))], { name }));
        for (const r of out.rules) {
            expect(r.name.length).toBeLessThanOrEqual(100);
            expect(r.name.endsWith(' #' + (out.rules.indexOf(r) + 1))).toBe(true);
            expect(/[\uD800-\uDBFF]…/.test(r.name)).toBe(false);
        }
        const replaced = run(rec('Replace', pair(src('Url', 'Contains', 'a.test'), { from: 'a', to: 'b' }), { name: 'r'.repeat(120) }));
        expect(replaced.rules.map((r) => r.name.length)).toEqual([100, 100]);
    });
    test('skipped entries and warnings use the same trimmed name', () => {
        const out = run(rec('Script', pair(src('Url', 'Contains', 'a')), { name: 's'.repeat(150) }));
        expect(out.skipped[0].name).toHaveLength(100);
    });
    test('ids are fresh on every conversion, even of the same file', () => {
        const records = fixture('export-full.json');
        const a = importer.convert(records).rules.map((r) => r.id);
        const b = importer.convert(records).rules.map((r) => r.id);
        expect(a.filter((id) => b.includes(id))).toEqual([]);
    });
    test('the input is not modified', () => {
        const records = fixture('export-full.json');
        const before = JSON.stringify(records);
        importer.convert(records);
        expect(JSON.stringify(records)).toBe(before);
    });
});

describe('options', () => {
    test('validate:false returns what the converter built, without the schema\'s verdict', () => {
        const record = rec('Headers', pair(src('Url', 'Contains', 'requestly'), { modifications: { Response: [{ header: 'Access-Control-Allow-Credentials', type: 'Add', value: 'true' }] } }));
        expect(run(record).rules).toEqual([]);
        expect(run(record, { validate: false }).rules).toHaveLength(1);
    });
    test('without the shared schema loaded, conversion still works', () => {
        const saved = globalThis.SpliceTapRuleSchema;
        const resolved = require.resolve('../src/rule-schema');
        // The importer finds the schema through the global first, then require();
        // hide both for this call.
        const cached = require.cache[resolved];
        delete require.cache[resolved];
        require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: null };
        globalThis.SpliceTapRuleSchema = undefined;
        try {
            const out = importer.convert([cancel(src('Url', 'Contains', 'a'))]);
            expect(out.rules).toHaveLength(1);
        } finally {
            require.cache[resolved] = cached;
            globalThis.SpliceTapRuleSchema = saved;
        }
    });
});
