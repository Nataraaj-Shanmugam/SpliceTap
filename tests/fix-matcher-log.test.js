/**
 * Regression tests for fix group A2b ("matcher-log"): src/matcher.js,
 * src/placeholders.js, src/patch.js, the log-entry ingestion in
 * service_worker/background.js, and the DevTools panel's reading of those
 * entries (the panel itself is covered in tests/e2e/fix-panel-2.e2e.test.js).
 *
 * Contract B (PER-2 residual): a page can install hooks on the built-in
 * prototypes before its first request. The interceptor runs in the page's
 * realm, so a rule's URL pattern or body must never be handed to one.
 * Contract A (PER-54, PER-56): the log entry gains kind, elapsedMs,
 * finalStatus, redirectedTo and note.
 */

'use strict';

const path = require('path');
const { loadEsmModule, installChrome } = require('./helpers/load-esm');
const { createChromeMock } = require('./helpers/chrome-mock');

// ─── Contract B: hostile prototypes ──────────────────────────────────────────

// Every string that carries rule data holds "zq7" (any case), so a hook that
// sees one is easy to recognise. Request URLs necessarily contain the literal
// part of a pattern they match, so those pieces are compared by equality; the
// pieces that no URL contains (a regex's escaped text, a wildcard with its
// stars, any body or header value) by containment.
const EXACT_SECRETS = new Set();
const FRAGMENT_SECRETS = [];

function addSecrets({ exact = [], fragments = [] }) {
    for (const s of exact) { EXACT_SECRETS.add(s); EXACT_SECRETS.add(s.toLowerCase()); }
    for (const s of fragments) { FRAGMENT_SECRETS.push(s); FRAGMENT_SECRETS.push(s.toLowerCase()); }
}

const regexPattern = '/^https?:\\/\\/zq7-regex\\.test\\/v\\d+\\/(users|orders)(\\?|$)/';
const regexBody = regexPattern.slice(1, -1);

addSecrets({
    exact: [
        'zq7-substring-needle',
        'https://zq7-prefix.test/*', 'https://zq7-prefix.test/',
        '*/zq7-suffix.json', '/zq7-suffix.json',
        '*/zq7-contains/*', '/zq7-contains/',
        '*/zq7-multi/*/detail/*', '/zq7-multi/', '/detail/',
        'X-Zq7-Header', 'ZQ7-HEADER-VALUE',
        'Zq7Operation', 'Zq7Operation\\.Weird\\$',
        '*/zq7-graphql',
        regexPattern, regexBody
    ],
    fragments: [
        'zq7-regex\\', 'zq7\\-', '*/zq7', 'zq7-multi/*', 'ZQ7-SECRET', 'ZQ7-PATCH', 'ZQ7-DEEP', 'ZQ7-DEST'
    ]
});

const rule = (id, match, extra = {}) => ({
    id,
    name: id,
    enabled: true,
    type: 'mock',
    match: { method: 'GET', ...match },
    response: { statusCode: 200, body: { id, secret: 'ZQ7-SECRET-' + id } },
    ...extra
});

function plainRules() {
    return [
        rule('disabled', { url: '*/zq7-contains/*' }, { enabled: false }),
        rule('dnr-type', { url: 'zq7-substring-needle' }, { type: 'headers' }),
        rule('cat', { url: '/(a|a)+$/' }),
        rule('headers', { url: '*/zq7-headers/*', headers: { 'X-Zq7-Header': 'ZQ7-HEADER-VALUE' } }),
        rule('graphql', { url: '*/zq7-graphql', method: 'POST', graphql: { operationName: 'Zq7Operation.Weird$' } }),
        rule('regex', { url: regexPattern }),
        rule('multi', { url: '*/zq7-multi/*/detail/*' }),
        rule('prefix', { url: 'https://zq7-prefix.test/*' }),
        rule('suffix', { url: '*/zq7-suffix.json' }),
        rule('contains', { url: '*/zq7-contains/*' }),
        rule('substr', { url: 'zq7-substring-needle', method: '*' }),
        rule('redirect', { url: '*/zq7-redirect/*' }, { type: 'redirect', redirect: { destination: 'https://ZQ7-DEST.test/' } })
    ];
}

/** What A2a's state sync produces: null-prototype objects and arrays. */
function nullProto(value) {
    if (Array.isArray(value)) {
        const out = [];
        Object.setPrototypeOf(out, null);
        for (let i = 0; i < value.length; i++) out[i] = nullProto(value[i]);
        return out;
    }
    if (value !== null && typeof value === 'object') {
        const out = Object.create(null);
        for (const key of Object.keys(value)) out[key] = nullProto(value[key]);
        return out;
    }
    return value;
}

const REQUESTS = [
    { url: 'https://x.test/a/zq7-substring-needle/z', method: 'GET', expect: 'substr' },
    { url: 'https://zq7-prefix.test/anything', method: 'GET', expect: 'prefix' },
    { url: 'https://x.test/files/zq7-suffix.json', method: 'GET', expect: 'suffix' },
    { url: 'https://x.test/zq7-contains/1', method: 'GET', expect: 'contains' },
    { url: 'https://x.test/zq7-multi/42/detail/9', method: 'GET', expect: 'multi' },
    { url: 'https://zq7-regex.test/v2/orders?x=1', method: 'GET', expect: 'regex' },
    { url: 'https://x.test/zq7-headers/1', method: 'GET', headers: { 'x-zq7-header': 'has zq7-header-value inside' }, expect: 'headers' },
    { url: 'https://x.test/zq7-graphql', method: 'POST', bodyText: '{"operationName":"Zq7Operation.Weird$"}', expect: 'graphql' },
    { url: 'https://x.test/zq7-graphql', method: 'POST', bodyText: 'not json "operationName": "Zq7Operation.Weird$" tail', expect: 'graphql' },
    { url: 'https://x.test/zq7-graphql', method: 'POST', bodyText: '[{"query":"query Other { a }"},{"query":"mutation Zq7Operation.Weird { a }"}]', expect: null },
    { url: 'https://x.test/zq7-redirect/1', method: 'GET', expect: 'redirect' },
    { url: 'https://x.test/nothing-here', method: 'GET', expect: null },
    { url: 'https://x.test/zq7-headers/1', method: 'GET', headers: { 'x-other': 'zzz' }, expect: null }
];

const hasSecret = (s) => EXACT_SECRETS.has(s) || FRAGMENT_SECRETS.some((f) => s.includes(f));

/**
 * Wrap every function and accessor on the built-in prototypes the modules
 * touch, and put recording getters/setters on Object.prototype for the names
 * a rule may lack. Records what each one was called with. Returns
 * { seen, restore }. Hooks only push with a push captured beforehand, so they
 * cannot recurse into each other.
 */
function installHostileHooks() {
    const seen = [];
    const undo = [];
    const rawPush = Array.prototype.push;
    const rawApply = Function.prototype.apply;
    const note = (label, self, args) => { rawPush.call(seen, [label, self, args]); };

    function wrap(target, key, label) {
        const desc = Object.getOwnPropertyDescriptor(target, key);
        if (!desc || !desc.configurable) return;
        const next = Object.assign({}, desc);
        if (typeof desc.value === 'function') {
            const original = desc.value;
            next.value = function () { 'use strict'; note(label, this, arguments); return rawApply.call(original, this, arguments); };
        } else if (desc.get || desc.set) {
            if (desc.get) { const g = desc.get; next.get = function () { 'use strict'; note(label + ' (get)', this, []); return rawApply.call(g, this, []); }; }
            if (desc.set) { const s = desc.set; next.set = function () { 'use strict'; note(label + ' (set)', this, arguments); return rawApply.call(s, this, arguments); }; }
        } else {
            return;
        }
        Object.defineProperty(target, key, next);
        rawPush.call(undo, () => Object.defineProperty(target, key, desc));
    }

    const protos = [
        ['String.prototype', String.prototype],
        ['Array.prototype', Array.prototype],
        ['Map.prototype', Map.prototype],
        ['Set.prototype', Set.prototype],
        ['RegExp.prototype', RegExp.prototype],
        ['Object.prototype', Object.prototype],
        ['MapIterator.prototype', Object.getPrototypeOf(new Map().keys())],
        ['SetIterator.prototype', Object.getPrototypeOf(new Set().values())],
        ['ArrayIterator.prototype', Object.getPrototypeOf([][Symbol.iterator]())]
    ];
    const plan = [];
    for (let p = 0; p < protos.length; p++) {
        const keys = Reflect.ownKeys(protos[p][1]);
        for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            if (key === 'constructor' || key === '__proto__' || key === 'length') continue;
            rawPush.call(plan, [protos[p][1], key, protos[p][0] + '.' + String(key)]);
        }
    }
    for (let i = 0; i < plan.length; i++) wrap(plan[i][0], plan[i][1], plan[i][2]);

    // Properties a rule or its match may lack: the read falls through to a
    // getter on Object.prototype with `this` = the object read.
    const absent = ['patch', 'headers', 'graphql', 'body', 'mode', 'type', 'match', 'enabled', 'url', 'method',
        'delay', 'operationName', 'response', 'redirect', 'toJSON', 'then', 'kind', 'regex', 'lower'];
    for (const name of absent) {
        if (Object.prototype.hasOwnProperty.call(Object.prototype, name)) continue;
        Object.defineProperty(Object.prototype, name, {
            configurable: true,
            get() { 'use strict'; note('Object.prototype.' + name + ' (get)', this, []); return undefined; },
            set(v) { 'use strict'; note('Object.prototype.' + name + ' (set)', this, [v]); Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true }); }
        });
        rawPush.call(undo, () => { delete Object.prototype[name]; });
    }

    // Globals a page can replace outright.
    const replaceFn = (holder, name, label) => {
        const original = holder[name];
        if (typeof original !== 'function') return;
        const hook = function () {
            'use strict';
            note(label, new.target ? undefined : this, arguments); // under new, `this` is a bare object made from the prototype
            return new.target ? Reflect.construct(original, arguments, new.target) : rawApply.call(original, this, arguments);
        };
        Object.defineProperty(hook, 'prototype', { value: original.prototype });
        holder[name] = hook;
        rawPush.call(undo, () => { holder[name] = original; });
    };
    replaceFn(Array, 'isArray', 'Array.isArray');
    replaceFn(Object, 'keys', 'Object.keys');
    replaceFn(Object, 'entries', 'Object.entries');
    replaceFn(Object, 'assign', 'Object.assign');
    replaceFn(Object, 'create', 'Object.create');
    replaceFn(Object, 'defineProperty', 'Object.defineProperty');
    replaceFn(Object, 'getPrototypeOf', 'Object.getPrototypeOf');
    replaceFn(Object, 'setPrototypeOf', 'Object.setPrototypeOf');
    replaceFn(JSON, 'parse', 'JSON.parse');
    replaceFn(JSON, 'stringify', 'JSON.stringify');
    replaceFn(Math, 'max', 'Math.max');
    replaceFn(Math, 'min', 'Math.min');
    replaceFn(Math, 'floor', 'Math.floor');
    replaceFn(globalThis, 'parseInt', 'parseInt');
    replaceFn(globalThis, 'String', 'String');
    replaceFn(globalThis, 'RegExp', 'RegExp');
    replaceFn(globalThis, 'Map', 'Map');
    replaceFn(globalThis, 'Set', 'Set');
    replaceFn(console, 'error', 'console.error');
    replaceFn(console, 'warn', 'console.warn');

    return {
        seen,
        restore() { for (let i = undo.length - 1; i >= 0; i--) undo[i](); }
    };
}

/** Every string reachable from a value, keys included. */
function collectStrings(value, out, depth, visited) {
    if (typeof value === 'string') { out.push(value); return; }
    if (value === null || typeof value !== 'object' || depth > 7 || visited.has(value)) return;
    visited.add(value);
    if (value instanceof Map) {
        value.forEach((v, k) => { collectStrings(k, out, depth + 1, visited); collectStrings(v, out, depth + 1, visited); });
        return;
    }
    if (value instanceof Set) {
        value.forEach((v) => collectStrings(v, out, depth + 1, visited));
        return;
    }
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'string') out.push(key);
        let child;
        try { child = value[key]; } catch (e) { continue; }
        collectStrings(child, out, depth + 1, visited);
    }
}

/** The hook calls that were handed rule data, as readable lines. */
function leaksIn(seen) {
    const leaks = new Set();
    for (const [label, self, args] of seen) {
        const strings = [];
        const visited = new Set();
        collectStrings(self, strings, 0, visited);
        collectStrings(args, strings, 0, visited);
        const bad = strings.filter(hasSecret);
        if (bad.length) leaks.add(`${label} saw ${JSON.stringify(bad[0].slice(0, 60))}`);
    }
    // One line per distinct hook, so a failure names the hooks and stays short.
    const byHook = new Map();
    for (const line of leaks) {
        const hook = line.split(' saw ')[0];
        if (!byHook.has(hook)) byHook.set(hook, line);
    }
    return Array.from(byHook.values());
}

function loadFresh(file) {
    let loaded;
    jest.isolateModules(() => { loaded = require(path.join('..', 'src', file)); });
    return loaded;
}

describe('Contract B: rule data is not handed to hooks on the built-in prototypes', () => {
    test('the detector itself sees a leak when code is careless (so a clean result means something)', () => {
        const hooks = installHostileHooks();
        try {
            const careless = (pattern) => pattern.toLowerCase().split('*').filter(Boolean);
            careless('*/zq7-contains/*');
            const rules = nullProto(plainRules());
            for (let i = 0; i < rules.length; i++) {
                if (rules[i].enabled && rules[i].match.url.startsWith('/')) rules[i].match.url.slice(1);
            }
            Array.isArray(rules);
        } finally { hooks.restore(); }
        expect(leaksIn(hooks.seen).length).toBeGreaterThanOrEqual(3);
    });

    test('matcher: matching, header, GraphQL and regex analysis never show a hook a pattern', () => {
        // The module takes console.error at load, so the quiet one goes in first.
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const matcher = loadFresh('matcher.js');
        const rules = nullProto(plainRules());
        const results = [];
        const hooks = installHostileHooks();
        try {
            // Index loops: the hooks are on the iterators too.
            for (let q = 0; q < REQUESTS.length; q++) {
                const r = REQUESTS[q];
                const hit = matcher.findMatchingRule(rules, { url: r.url, method: r.method, headers: r.headers, bodyText: r.bodyText });
                results[results.length] = hit ? hit.id : null;
                // The direct entry points, as the interceptor's conditional-rule scan calls them.
                for (let i = 0; i < rules.length; i++) {
                    matcher.matchUrl(r.url, rules[i].match.url);
                    matcher.matchHeaders(r.headers, rules[i].match.headers);
                    matcher.matchGraphQL(r.bodyText, rules[i].match.graphql, r.url, {});
                }
            }
            matcher.isCatastrophicRegex(regexBody);
            matcher.isCatastrophicRegex('(a|a)+$');
            matcher.isCatastrophicRegex('^\\/zq7\\-[abc]{2,3}\\/(?:x|y)+$');
        } finally { hooks.restore(); }

        // The refusal notice reached the console the module captured, pattern and all.
        expect(errorSpy.mock.calls.some((c) => c[1] === '/(a|a)+$/')).toBe(true);
        errorSpy.mockRestore();
        expect(results).toEqual(REQUESTS.map((r) => r.expect));
        expect(leaksIn(hooks.seen)).toEqual([]);
    });

    test('matcher: a pattern cache past its cap evicts without showing a hook the keys', () => {
        const matcher = loadFresh('matcher.js');
        const patterns = [];
        for (let i = 0; i < 700; i++) patterns.push(`*/zq7-evict-${i}/*`);
        addSecrets({ exact: patterns });
        const hooks = installHostileHooks();
        try {
            for (let i = 0; i < patterns.length; i++) matcher.matchUrl('https://x.test/other', patterns[i]);
        } finally { hooks.restore(); }
        expect(leaksIn(hooks.seen)).toEqual([]);
    });

    test('matcher: ordinary rule objects are read through their own properties, so Object.prototype getters never fire', () => {
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const matcher = loadFresh('matcher.js');
        const rules = plainRules();
        const results = [];
        const hooks = installHostileHooks();
        try {
            for (let q = 0; q < REQUESTS.length; q++) {
                const r = REQUESTS[q];
                const hit = matcher.findMatchingRule(rules, { url: r.url, method: r.method, headers: r.headers, bodyText: r.bodyText });
                results[results.length] = hit ? hit.id : null;
            }
        } finally { hooks.restore(); }
        errorSpy.mockRestore();
        expect(results).toEqual(REQUESTS.map((r) => r.expect));
        expect(leaksIn(hooks.seen)).toEqual([]);
    });

    test('placeholders: a body (string or object) is substituted without a hook seeing it', () => {
        const placeholders = loadFresh('placeholders.js');
        const text = '{"secret":"ZQ7-SECRET-STR","id":"{{guid}}","at":"{{timestamp}}","ms":{{timestamp_ms}},"d":"{{date}}","t":"{{time}}",'
            + '"i":{{randomInt}},"n":{{randomInt:50}},"f":{{randomFloat}},"s":"{{randomString}}","s5":"{{randomString:5}}",'
            + '"e":"{{randomEmail}}","b":{{randomBool}},"u":"{{request.url}}","m":"{{request.method}}"}';
        const objectBody = nullProto({ secret: 'ZQ7-SECRET-OBJ', list: ['{{guid}}', { deep: 'ZQ7-DEEP' }], n: 5, u: '{{request.url}}' });
        const out = {};
        const hooks = installHostileHooks();
        try {
            out.text = placeholders.processDynamicResponse(text, { url: 'https://api.test/a?q=1', method: 'GET' });
            out.toString = placeholders.processDynamicResponseToString(text, { url: 'https://api.test/b', method: 'POST' }, false);
            out.object = placeholders.processDynamicResponse(objectBody, { url: 'https://api.test/c', method: 'PUT' });
            out.plain = placeholders.processDynamicResponse('{"secret":"ZQ7-SECRET-PLAIN"}');
        } finally { hooks.restore(); }

        const parsed = JSON.parse(out.text);
        expect(parsed.secret).toBe('ZQ7-SECRET-STR');
        expect(parsed.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(parsed.s).toHaveLength(10);
        expect(parsed.s5).toHaveLength(5);
        expect(parsed.n).toBeLessThanOrEqual(50);
        expect(parsed.u).toBe('https://api.test/a?q=1');
        expect(parsed.m).toBe('GET');
        expect(JSON.parse(out.toString).m).toBe('POST');
        expect(out.object.secret).toBe('ZQ7-SECRET-OBJ');
        expect(out.object.list[0]).toMatch(/^[0-9a-f-]{36}$/);
        expect(out.object.list[1].deep).toBe('ZQ7-DEEP');
        expect(out.object.u).toBe('https://api.test/c');
        expect(out.plain).toBe('{"secret":"ZQ7-SECRET-PLAIN"}');
        expect(leaksIn(hooks.seen)).toEqual([]);
    });

    test('patch: merging and the applicability check never show a hook the patch', () => {
        const patch = loadFresh('patch.js');
        const original = { keep: 1, nested: { a: 1, b: 2 }, list: [1], gone: 'x', ['__proto__']: undefined };
        delete original['__proto__'];
        const rulePatch = nullProto({
            nested: { b: null, c: 'ZQ7-PATCH-VALUE' },
            gone: null,
            added: ['ZQ7-PATCH-ARRAY', { x: 'ZQ7-PATCH-IN-ARRAY' }],
            zq7Key: { deep: { x: 'ZQ7-PATCH-DEEP' } }
        });
        const out = {};
        const replacePatch = nullProto(['ZQ7-PATCH-REPLACE']);
        const emptyPatch = nullProto({});
        const scalarPatch = 'ZQ7-PATCH-SCALAR';
        const hooks = installHostileHooks();
        try {
            out.merged = patch.jsonMergePatch(original, rulePatch);
            out.onNothing = patch.jsonMergePatch(undefined, rulePatch);
            out.onArray = patch.jsonMergePatch([1, 2], rulePatch);
            out.replace = patch.jsonMergePatch({ a: 1 }, replacePatch);
            out.applicable = [
                patch.isPatchApplicable({ a: 1 }, rulePatch),
                patch.isPatchApplicable([1], rulePatch),
                patch.isPatchApplicable({ a: 1 }, emptyPatch),
                patch.isPatchApplicable(5, scalarPatch)
            ];
        } finally { hooks.restore(); }

        expect(JSON.parse(JSON.stringify(out.merged))).toEqual({
            keep: 1,
            nested: { a: 1, c: 'ZQ7-PATCH-VALUE' },
            list: [1],
            added: ['ZQ7-PATCH-ARRAY', { x: 'ZQ7-PATCH-IN-ARRAY' }],
            zq7Key: { deep: { x: 'ZQ7-PATCH-DEEP' } }
        });
        expect(JSON.parse(JSON.stringify(out.onNothing)).nested).toEqual({ c: 'ZQ7-PATCH-VALUE' });
        expect(out.onArray).toEqual([1, 2]);
        expect(out.replace).toEqual(['ZQ7-PATCH-REPLACE']);
        expect(out.applicable).toEqual([true, false, false, true]);
        expect(leaksIn(hooks.seen)).toEqual([]);
    });
});

describe('Contract B: null-prototype rules and arrays work', () => {
    const matcher = require('../src/matcher');
    const placeholders = require('../src/placeholders');
    const patch = require('../src/patch');

    test('findMatchingRule returns the same rule for null-prototype and ordinary input', () => {
        const ordinary = plainRules();
        const bare = nullProto(ordinary);
        for (const r of REQUESTS) {
            const req = { url: r.url, method: r.method, headers: r.headers, bodyText: r.bodyText };
            const a = matcher.findMatchingRule(ordinary, req);
            const b = matcher.findMatchingRule(bare, req);
            expect(b && b.id).toBe(a && a.id);
            expect(b && b.id).toBe(r.expect);
        }
    });

    test('the returned rule is the caller\'s own object, not a copy', () => {
        const bare = nullProto(plainRules());
        const hit = matcher.findMatchingRule(bare, { url: 'https://x.test/zq7-contains/1', method: 'GET' });
        let found = false;
        for (let i = 0; i < bare.length; i++) if (bare[i] === hit) found = true;
        expect(found).toBe(true);
    });

    test('placeholders accept a null-prototype object body and return an ordinary one', () => {
        const out = placeholders.processDynamicResponse(nullProto({ a: { b: ['{{request.method}}'] } }), { method: 'GET', url: 'u' });
        expect(out).toEqual({ a: { b: ['GET'] } });
        expect(placeholders.processDynamicResponse(nullProto({ plain: 1 }))).toEqual({ plain: 1 });
    });

    test('jsonMergePatch accepts a null-prototype patch and array', () => {
        expect(patch.jsonMergePatch({ a: 1, b: 2 }, nullProto({ b: null, c: [1, 2] }))).toEqual({ a: 1, c: [1, 2] });
        expect(patch.jsonMergePatch({ a: 1 }, nullProto([1, 2]))).toEqual([1, 2]);
        expect(patch.isPatchApplicable({ a: 1 }, nullProto({ b: 1 }))).toBe(true);
    });

    test('a "__proto__" key in a patch or a response is data, never a prototype', () => {
        const patchWithProto = JSON.parse('{"__proto__":{"polluted":true},"x":1}');
        const merged = patch.jsonMergePatch(JSON.parse('{"__proto__":{"own":1}}'), patchWithProto);
        expect(Object.getPrototypeOf(merged)).not.toBe(patchWithProto.__proto__);
        expect({}.polluted).toBeUndefined();
        expect(Object.keys(merged).sort()).toEqual(['__proto__', 'x']);
    });
});

// ─── Contract A: log-entry ingestion ─────────────────────────────────────────

const BACKGROUND = path.resolve(__dirname, '..', 'service_worker', 'background.js');
const quietConsole = Object.assign({}, console, { log() {}, error() {}, warn() {} });
const EXTENSION_PAGE = { id: 'test-extension-id', url: 'chrome-extension://test-extension-id/popup/popup.html' };
const contentScript = (tabId = 7) => ({
    id: 'test-extension-id', url: 'https://site.test/app', origin: 'https://site.test', frameId: 0, tab: { id: tabId }
});

let restoreChrome = null;
let activeBackground = null;

async function setup(options) {
    const mock = createChromeMock(options);
    restoreChrome = installChrome(mock.chrome);
    const exports = loadEsmModule(BACKGROUND, { chrome: mock.chrome, console: quietConsole });
    const bg = exports.default;
    activeBackground = bg;
    await bg.ready;
    const send = (message, sender = EXTENSION_PAGE) => mock.dispatchMessage(message, sender);
    return { mock, bg, send };
}

afterEach(() => {
    if (activeBackground && activeBackground._trailingFlushTimer) {
        clearTimeout(activeBackground._trailingFlushTimer);
        activeBackground._trailingFlushTimer = null;
    }
    activeBackground = null;
    if (restoreChrome) restoreChrome();
    restoreChrome = null;
});

const mockRule = (id) => ({
    id, name: `Rule ${id}`, type: 'mock', enabled: true,
    match: { url: `*/api/${id}*`, method: 'GET' },
    response: { statusCode: 200, statusText: 'OK', headers: {}, body: {}, delay: 0, mode: 'static' }
});
const delayRule = (id) => ({ ...mockRule(id), type: 'delay', response: undefined, delay: { duration: 100 } });

const base = (overrides = {}) => ({ url: 'https://s.test/api/a', method: 'GET', ruleId: 'a', ruleName: 'Rule a', ruleType: 'mock', status: 200, ts: 5, ...overrides });

async function logOne(send, entry) {
    await send({ type: 'logInterceptionBatch', entries: [entry] }, contentScript());
    const { entries } = await send({ type: 'getInterceptionLog' });
    return entries[entries.length - 1];
}

describe('Contract A (PER-54, PER-56): the background keeps the new log-entry fields', () => {
    test('kind, elapsedMs, finalStatus, redirectedTo and note are kept', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [delayRule('a')] } });
        const entry = await logOne(send, base({
            ruleType: 'delay', status: null, kind: 'rule', elapsedMs: 1503, finalStatus: 200,
            redirectedTo: 'https://dest.test/x', note: 'Patch skipped — response is not a JSON object (text/plain)'
        }));
        expect(entry).toMatchObject({
            kind: 'rule', elapsedMs: 1503, finalStatus: 200, redirectedTo: 'https://dest.test/x',
            note: 'Patch skipped — response is not a JSON object (text/plain)'
        });
    });

    test('finalStatus may be the word "failed"; elapsedMs of 0 is kept', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });
        const entry = await logOne(send, base({ finalStatus: 'failed', elapsedMs: 0 }));
        expect(entry.finalStatus).toBe('failed');
        expect(entry.elapsedMs).toBe(0);
    });

    test('an entry without the new fields has none of them, so older entries read as before', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });
        const entry = await logOne(send, base());
        for (const key of ['kind', 'elapsedMs', 'finalStatus', 'redirectedTo', 'note']) expect(entry).not.toHaveProperty(key);
    });

    test.each([
        ['kind: an unknown word', { kind: 'other' }, 'kind'],
        ['kind: not a string', { kind: 5 }, 'kind'],
        ['elapsedMs: negative', { elapsedMs: -1 }, 'elapsedMs'],
        ['elapsedMs: fractional', { elapsedMs: 1.5 }, 'elapsedMs'],
        ['elapsedMs: a string', { elapsedMs: '12' }, 'elapsedMs'],
        ['elapsedMs: NaN', { elapsedMs: NaN }, 'elapsedMs'],
        ['elapsedMs: Infinity', { elapsedMs: Infinity }, 'elapsedMs'],
        ['finalStatus: a numeric string', { finalStatus: '200' }, 'finalStatus'],
        ['finalStatus: any other word', { finalStatus: 'ok' }, 'finalStatus'],
        ['finalStatus: fractional', { finalStatus: 200.5 }, 'finalStatus'],
        ['finalStatus: an object', { finalStatus: { a: 1 } }, 'finalStatus'],
        ['redirectedTo: not a string', { redirectedTo: 5 }, 'redirectedTo'],
        ['redirectedTo: over 2048 characters', { redirectedTo: 'https://x.test/' + 'a'.repeat(2048) }, 'redirectedTo'],
        ['note: not a string', { note: { a: 1 } }, 'note'],
        ['note: over 200 characters', { note: 'n'.repeat(201) }, 'note']
    ])('a malformed value is dropped, not the entry (%s)', async (label, bad, field) => {
        const { send } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });
        const entry = await logOne(send, base({ ...bad, note: bad.note === undefined && field !== 'note' ? 'kept' : bad.note }));
        expect(entry).toBeDefined();
        expect(entry.ruleId).toBe('a');
        expect(entry).not.toHaveProperty(field);
        if (field !== 'note') expect(entry.note).toBe('kept');
    });

    test('the limits are inclusive: a 2048-character redirectedTo and a 200-character note are kept whole', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });
        const entry = await logOne(send, base({ redirectedTo: 'r'.repeat(2048), note: 'n'.repeat(200) }));
        expect(entry.redirectedTo).toHaveLength(2048);
        expect(entry.note).toHaveLength(200);
    });

    test('a chaos entry needs no ruleId, is kept with ruleId null, and bumps no rule\'s hit count', async () => {
        const { send, bg } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });
        const before = bg.stats.intercepted;
        await send({
            type: 'logInterceptionBatch',
            entries: [{ url: 'https://s.test/api/a', method: 'GET', ruleId: null, ruleName: 'Chaos mode', status: 'failed', kind: 'chaos', ts: 9 }]
        }, contentScript());

        const { entries } = await send({ type: 'getInterceptionLog' });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ kind: 'chaos', ruleId: null, ruleName: 'Chaos mode', status: 'failed', tabId: 7 });
        expect(bg.stats.intercepted).toBe(before + 1); // still an interception in the stats
        expect(bg.rules.find((r) => r.id === 'a').hitCount || 0).toBe(0);
    });

    test('a chaos entry with the ruleId left out, or naming a real rule, still bumps nothing', async () => {
        const { send, bg } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });
        await send({
            type: 'logInterceptionBatch',
            entries: [
                { url: 'https://s.test/x', method: 'GET', ruleName: 'Chaos mode', status: 'failed', kind: 'chaos' },
                { url: 'https://s.test/y', method: 'GET', ruleId: 'a', ruleName: 'Chaos mode', status: 'failed', kind: 'chaos' },
                { url: 'https://s.test/z', method: 'GET', ruleId: 'no-such-rule', ruleName: 'Chaos mode', status: 'failed', kind: 'chaos' }
            ]
        }, contentScript());
        const { entries } = await send({ type: 'getInterceptionLog' });
        expect(entries).toHaveLength(3);
        expect(entries.every((e) => e.ruleId === null && e.kind === 'chaos')).toBe(true);
        expect(bg.rules.find((r) => r.id === 'a').hitCount || 0).toBe(0);
    });

    test('a rule entry still needs a ruleId that names a real rule, and still bumps its hit count', async () => {
        const { send, bg } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });
        await send({
            type: 'logInterceptionBatch',
            entries: [
                base({ ruleId: undefined }),
                base({ ruleId: null }),
                base({ ruleId: 'nope' }),
                base({ kind: 'rule' }),
                base()
            ]
        }, contentScript());
        const { entries } = await send({ type: 'getInterceptionLog' });
        expect(entries).toHaveLength(2);
        expect(bg.rules.find((r) => r.id === 'a').hitCount).toBe(2);
    });

    test('a rule entry may report a status of "failed"; any other word still refuses the entry', async () => {
        const { send } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });
        await send({
            type: 'logInterceptionBatch',
            entries: [base({ status: 'failed' }), base({ status: 'weird' })]
        }, contentScript());
        const { entries } = await send({ type: 'getInterceptionLog' });
        expect(entries).toHaveLength(1);
        expect(entries[0].status).toBe('failed');
    });

    test('a chaos entry\'s ruleName is capped like any other', async () => {
        const { send } = await setup();
        const entry = await logOne(send, { url: 'https://s.test/x', method: 'GET', kind: 'chaos', ruleName: 'c'.repeat(5000), status: 'failed' });
        expect(entry.ruleName).toHaveLength(256);
    });

    test('the new fields survive the session-storage round trip', async () => {
        const { send, mock, bg } = await setup({ initial: { spliceTapRules: [mockRule('a')] } });
        await send({
            type: 'logInterceptionBatch',
            entries: [base({ ruleType: 'redirect', finalStatus: 200, elapsedMs: 41, redirectedTo: 'https://dest.test/', note: 'n' })]
        }, contentScript());
        bg._lastPersist = 0;
        await bg._persistVolatile();
        const stored = await mock.chrome.storage.session.get('spliceTapInterceptionLog');
        expect(stored.spliceTapInterceptionLog[0]).toMatchObject({ finalStatus: 200, elapsedMs: 41, redirectedTo: 'https://dest.test/', note: 'n' });
    });
});
