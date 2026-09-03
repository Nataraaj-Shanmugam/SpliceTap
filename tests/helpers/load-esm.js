/**
 * Load SpliceTap's ESM-only sources under CommonJS Jest (CQ-8).
 *
 * src/storage.js, src/utils.js and service_worker/background.js use top-level
 * `import`/`export`, so `require()` throws on them — which is why, before this
 * helper, the three files holding the most consequential logic in the
 * extension had no test coverage at all (tests/utils.test.js says so in a
 * comment). The alternative is adding a Babel/ts-jest transform: a build
 * dependency plus a config that has to stay in step with what Chrome actually
 * parses. This keeps the shipped files byte-for-byte as they ship — the same
 * source Chrome loads is the source under test — and confines the workaround
 * to the test harness.
 *
 * The transformations are purely syntactic:
 *
 *   `import './umd.js';`            -> require() now (registers its globals)
 *   `import { A } from './x.js';`   -> recursively load x.js, bind A
 *   `export class X` / `function x` -> strip the `export` keyword
 *   `export default expr;`          -> bind it, reachable as `default`
 *
 * Side-effect imports are the UMD shared modules (matcher, placeholders,
 * patch, dnr, common); requiring them registers their API on globalThis,
 * which is exactly what the ESM consumer reads at runtime. Those modules
 * resolve `chrome` from globalThis, so a test that exercises code reaching
 * them must assign globalThis.chrome — see installChrome().
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const RE_SIDE_EFFECT_IMPORT = /^[ \t]*import\s+['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const RE_NAMED_IMPORT = /^[ \t]*import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const RE_EXPORT_DECL = /^([ \t]*)export\s+(?=(?:class|function|const|let|var|async)\b)/gm;
const RE_EXPORT_DEFAULT = /^[ \t]*export\s+default\s+/gm;

/** Names a file exports via `export <decl> <name>`. */
function exportedNames(src) {
    const names = [];
    const re = /^[ \t]*export\s+(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
    let match;
    while ((match = re.exec(src)) !== null) names.push(match[1]);
    return names;
}

/**
 * Evaluate an ESM file and return an object of its top-level exports.
 * `sandbox` values are injected as parameters, so they shadow globals —
 * that is how a test hands the module a mock `chrome` or a quiet `console`.
 */
function loadEsmModule(absPath, sandbox = {}, seen = new Map()) {
    if (seen.has(absPath)) return seen.get(absPath);

    let src = fs.readFileSync(absPath, 'utf8');
    const dir = path.dirname(absPath);
    const injected = { ...sandbox };

    // `export { A, B }` / `export * from` would need real module semantics.
    if (/^[ \t]*export\s*\{|^[ \t]*export\s*\*/m.test(src)) {
        throw new Error(`loadEsm: ${absPath} uses an export form this helper does not support`);
    }

    src = src.replace(RE_NAMED_IMPORT, (match, clause, spec) => {
        const target = path.resolve(dir, spec);
        const exports = loadEsmModule(target, sandbox, seen);
        for (const raw of clause.split(',')) {
            const name = raw.trim().split(/\s+as\s+/).pop().trim();
            if (!name) continue;
            if (!(name in exports)) {
                throw new Error(`loadEsm: ${spec} does not export ${name}`);
            }
            injected[name] = exports[name];
        }
        return '';
    });

    src = src.replace(RE_SIDE_EFFECT_IMPORT, (match, spec) => {
        require(path.resolve(dir, spec)); // UMD: registers onto globalThis
        return '';
    });

    const names = exportedNames(src);
    src = src.replace(RE_EXPORT_DECL, '$1');

    // `export default <expr>;` becomes a binding the caller can reach as
    // `default` — background.js exports its singleton that way, and tests
    // need the instance to assert on state the handlers mutate.
    const hasDefault = RE_EXPORT_DEFAULT.test(src);
    RE_EXPORT_DEFAULT.lastIndex = 0;
    src = src.replace(RE_EXPORT_DEFAULT, 'const __esmDefault = ');

    const keys = Object.keys(injected);
    const fields = names.map((n) => `${n}: ${n}`);
    if (hasDefault) fields.push('default: __esmDefault');
    const body = `${src}\n;return { ${fields.join(', ')} };`;
    const factory = new Function(...keys, body);
    const exports = factory(...keys.map((k) => injected[k]));

    seen.set(absPath, exports);
    return exports;
}

/** Load one named export from an ESM file, by repo-relative path. */
function loadEsm(relPath, exportName, sandbox = {}) {
    const exports = loadEsmModule(path.resolve(REPO_ROOT, relPath), sandbox);
    if (!(exportName in exports)) {
        throw new Error(`loadEsm: ${relPath} does not export ${exportName}`);
    }
    return exports[exportName];
}

/**
 * Publish a mock `chrome` on globalThis and return a restore function.
 *
 * Required whenever the code under test reaches a UMD module (dnr.js reads
 * chrome.declarativeNetRequest): those are require()'d as real CommonJS
 * modules, so they resolve `chrome` lexically from globalThis rather than
 * from the injected sandbox.
 */
function installChrome(chrome) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'chrome');
    const previous = globalThis.chrome;
    globalThis.chrome = chrome;
    return function restore() {
        if (had) globalThis.chrome = previous;
        else delete globalThis.chrome;
    };
}

module.exports = { loadEsm, loadEsmModule, installChrome };
