/**
 * Package the extension into a Chrome-Web-Store-ready ZIP.
 *
 * Why this exists (audit finding C-12): the previous "package" script shelled
 * out to the system `zip` binary, which is not installed on the stated dev
 * platform (win32 + Git Bash) — `npm run build` failed at this step even when
 * tests passed. It also used a denylist of `-x` excludes that missed several
 * internal-only files (`.claude/`, `TODO.md`, `changes.txt`, `TurboMock.txt`,
 * `CONTRIBUTING.md`, `demo.html`, `scripts/`, `index.js`, `audit/`), so a
 * successful run would still have shipped them.
 *
 * This script has no dependency on any external tool or npm package — it
 * writes a valid ZIP (stored/uncompressed entries) using only Node's `fs`,
 * `path`, and `zlib` (for CRC32 by way of `zlib.crc32`, added in Node 20+;
 * falls back to a pure-JS CRC32 table on older Node).
 *
 * Instead of a denylist, it builds an ALLOWLIST by walking manifest.json's
 * own references: icons, the background service worker (and its static
 * `import` graph), every content script, and every HTML page manifest.json
 * points at (popup, options, devtools panel) plus each page's own
 * <script src> / <link href> assets. Anything manifest.json does not
 * actually need — audit/, TODO.md, changes.txt, TurboMock.txt,
 * CONTRIBUTING.md, demo.html, tests/, scripts/, node_modules/, package*.json,
 * README.md, .claude/, .git — is excluded by construction, not by an
 * ever-growing denylist that has to be kept in sync by hand.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUTPUT_ZIP = path.join(ROOT, 'turbomock-extension.zip');

// ---------------------------------------------------------------------------
// CRC32 (PNG/ZIP share the same algorithm — PNG spec Annex D "Sample CRC code")
// ---------------------------------------------------------------------------
const crc32 = (() => {
    if (zlib.crc32) {
        // Node 20.12+ exposes zlib.crc32(data[, seed]) natively.
        return (buf) => zlib.crc32(buf) >>> 0;
    }
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return (buf) => {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    };
})();

function toDosTime(date) {
    return ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() / 2) & 0x1F);
}
function toDosDate(date) {
    return (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
}

/** Build a ZIP archive (stored, i.e. uncompressed entries) from a list of { name, data } */
function buildZip(entries) {
    const now = new Date();
    const dosTime = toDosTime(now);
    const dosDate = toDosDate(now);

    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
        const crc = crc32(data);
        const size = data.length;

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);   // version needed
        localHeader.writeUInt16LE(0, 6);    // flags
        localHeader.writeUInt16LE(0, 8);    // compression: stored
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(size, 18); // compressed size
        localHeader.writeUInt32LE(size, 22); // uncompressed size
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(0, 28);   // extra field length

        localParts.push(localHeader, nameBuf, data);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);  // version made by
        centralHeader.writeUInt16LE(20, 6);  // version needed
        centralHeader.writeUInt16LE(0, 8);   // flags
        centralHeader.writeUInt16LE(0, 10);  // compression: stored
        centralHeader.writeUInt16LE(dosTime, 12);
        centralHeader.writeUInt16LE(dosDate, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(size, 20);
        centralHeader.writeUInt32LE(size, 24);
        centralHeader.writeUInt16LE(nameBuf.length, 28);
        centralHeader.writeUInt16LE(0, 30);  // extra field length
        centralHeader.writeUInt16LE(0, 32);  // comment length
        centralHeader.writeUInt16LE(0, 34);  // disk number start
        centralHeader.writeUInt16LE(0, 36);  // internal attrs
        centralHeader.writeUInt32LE(0, 38);  // external attrs
        centralHeader.writeUInt32LE(offset, 42); // offset of local header

        centralParts.push(centralHeader, nameBuf);

        offset += localHeader.length + nameBuf.length + data.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const centralDirectoryOffset = offset;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);   // disk number
    end.writeUInt16LE(0, 6);   // disk with central dir
    end.writeUInt16LE(entries.length, 8);  // entries on this disk
    end.writeUInt16LE(entries.length, 10); // total entries
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(centralDirectoryOffset, 16);
    end.writeUInt16LE(0, 20); // comment length

    return Buffer.concat([...localParts, centralDirectory, end]);
}

// ---------------------------------------------------------------------------
// Allowlist discovery — walk manifest.json's own references.
// ---------------------------------------------------------------------------
function readText(relPath) {
    return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function addFile(set, relPath) {
    const normalized = relPath.replace(/^\.\//, '');
    if (set.has(normalized)) return false;
    const abs = path.join(ROOT, normalized);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        throw new Error(`Manifest-referenced file is missing on disk: ${normalized}`);
    }
    set.add(normalized);
    return true;
}

/** Resolve a relative import/src/href path against the directory of the file that referenced it. */
function resolveRel(fromRelDir, ref) {
    return path.join(fromRelDir, ref).split(path.sep).join('/');
}

/** Follow static `import ... from '...'` / `import '...'` in a JS file, one level, recursively. */
function collectJsImports(set, relPath, seen) {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    const src = readText(relPath);
    const dir = path.posix.dirname(relPath.split(path.sep).join('/'));
    const importRe = /import\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(src))) {
        const ref = m[1];
        if (!ref.endsWith('.js')) continue; // only local JS modules
        const resolved = resolveRel(dir, ref);
        if (addFile(set, resolved)) {
            collectJsImports(set, resolved, seen);
        }
    }
}

/** Pull <script src="..."> and <link href="..."> (same-dir/relative, non-http) refs out of an HTML file. */
function collectHtmlAssets(set, relPath) {
    const src = readText(relPath);
    const dir = path.posix.dirname(relPath.split(path.sep).join('/'));
    const refRe = /<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"':]+)["']/g;
    let m;
    while ((m = refRe.exec(src))) {
        const ref = m[1];
        if (/^https?:/i.test(ref)) continue;
        const resolved = resolveRel(dir, ref);
        addFile(set, resolved);
    }
    // devtools.js creates the panel with a literal "panel.html" reference —
    // not a <script>/<link> tag, so scan quoted .html string literals too.
    const htmlRefRe = /["']([.\w/-]+\.html)["']/g;
    while ((m = htmlRefRe.exec(src))) {
        const ref = m[1];
        const resolved = resolveRel(dir, ref);
        const abs = path.join(ROOT, resolved);
        if (fs.existsSync(abs) && !set.has(resolved)) {
            addFile(set, resolved);
            collectHtmlAssets(set, resolved);
        }
    }
}

function buildAllowlist(manifest) {
    const files = new Set();

    files.add('manifest.json');

    const iconMaps = [manifest.icons, manifest.action && manifest.action.default_icon];
    for (const map of iconMaps) {
        if (!map) continue;
        for (const iconPath of Object.values(map)) addFile(files, iconPath);
    }

    if (manifest.background && manifest.background.service_worker) {
        const swPath = manifest.background.service_worker;
        addFile(files, swPath);
        collectJsImports(files, swPath, new Set());
    }

    for (const script of manifest.content_scripts || []) {
        for (const js of script.js || []) addFile(files, js);
    }

    if (manifest.action && manifest.action.default_popup) {
        addFile(files, manifest.action.default_popup);
        collectHtmlAssets(files, manifest.action.default_popup);
    }

    if (manifest.options_ui && manifest.options_ui.page) {
        addFile(files, manifest.options_ui.page);
        collectHtmlAssets(files, manifest.options_ui.page);
    }

    if (manifest.devtools_page) {
        addFile(files, manifest.devtools_page);
        collectHtmlAssets(files, manifest.devtools_page);
        // devtools.html's own <script src> (devtools.js) may itself reference
        // panel.html by string literal (chrome.devtools.panels.create), which
        // collectHtmlAssets already follows via the quoted-.html scan above —
        // but that scan only inspects HTML files, so also scan devtools.js.
        for (const f of [...files]) {
            if (f.endsWith('devtools.js')) {
                const dir = path.posix.dirname(f.split(path.sep).join('/'));
                const src = readText(f);
                const htmlRefRe = /["']([.\w/-]+\.html)["']/g;
                let m;
                while ((m = htmlRefRe.exec(src))) {
                    const resolved = resolveRel(dir, m[1]);
                    if (fs.existsSync(path.join(ROOT, resolved)) && !files.has(resolved)) {
                        addFile(files, resolved);
                        collectHtmlAssets(files, resolved);
                    }
                }
            }
        }
    }

    for (const resource of manifest.web_accessible_resources || []) {
        for (const r of resource.resources || []) {
            if (!r.includes('*')) addFile(files, r);
        }
    }

    return files;
}

function main() {
    const manifest = JSON.parse(readText('manifest.json'));
    const allowlist = buildAllowlist(manifest);

    const entries = [...allowlist].sort().map((relPath) => ({
        name: relPath,
        data: fs.readFileSync(path.join(ROOT, relPath)),
    }));

    console.log('Packaging extension — allowlisted files (derived from manifest.json):');
    for (const e of entries) console.log('  ' + e.name);
    console.log(`\n${entries.length} files, ${entries.reduce((n, e) => n + e.data.length, 0)} bytes uncompressed.`);

    const zipBuffer = buildZip(entries);
    fs.writeFileSync(OUTPUT_ZIP, zipBuffer);
    console.log(`\nWrote ${OUTPUT_ZIP} (${zipBuffer.length} bytes).`);
}

main();
