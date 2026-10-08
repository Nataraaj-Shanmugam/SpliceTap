/**
 * Does the extension install and start — from source, and from the packaged
 * zip that actually gets uploaded?
 *
 * This is the suite that would have caught a80e8a4's bug the day it was
 * introduced: a content script Chrome refused to load, while every unit test
 * passed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, pageFetch, waitFor } = require('./harness');
const { extractZip } = require('./unzip');

const ROOT = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const mockRule = {
    id: 'install-mock',
    name: 'Install check',
    enabled: true,
    type: 'mock',
    match: { url: '*/api/install-check*', method: 'GET' },
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { mocked: true }, delay: 0, mode: 'static' }
};

/** One full round trip: save a rule, load a page, observe the mock. */
async function proveInterceptionWorks(h) {
    await h.reset();
    await h.saveRule(mockRule);
    const page = await h.openPage();
    const result = await waitFor(async () => {
        const r = await pageFetch(page, '/api/install-check');
        return r.marker === 'true' ? r : null;
    }, { label: 'the mock to apply' });
    await page.close();
    return result;
}

describe('install from the source tree', () => {
    let h;
    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });

    test('the service worker starts and reports the manifest identity', async () => {
        const identity = await h.extensionEval(() => {
            const m = chrome.runtime.getManifest();
            return { name: m.name, version: m.version };
        });
        expect(identity).toEqual({ name: manifest.name, version: manifest.version });
    });

    test('installing does not open a page on its own', async () => {
        // The first-install options tab was removed deliberately; an extension
        // that opens tabs nobody asked for is a review flag and an annoyance.
        const extensionPages = h.initialPages.filter((u) => u.startsWith('chrome-extension://'));
        expect(extensionPages).toEqual([]);
    });

    test('a rule intercepts a real page request', async () => {
        const result = await proveInterceptionWorks(h);
        expect(result.body).toEqual({ mocked: true });
        expect(h.requests.some((r) => r.path === '/api/install-check')).toBe(false);
    });

    test('startup logged no errors in any extension context', async () => {
        // startupErrors is snapshotted before any test can reset the log.
        expect(h.startupErrors).toEqual([]);
        expect(h.allErrors).toEqual([]);
    });
});

describe('install from the packaged Web Store zip', () => {
    let h;
    let extractDir;

    beforeAll(async () => {
        execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'package-extension.js')], { stdio: 'pipe' });
        const zipPath = path.join(ROOT, 'dist', `splicetap-v${manifest.version}.zip`);
        extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'splicetap-zip-'));
        extractZip(zipPath, extractDir);
        h = await launch({ extensionPath: extractDir });
    });

    afterAll(async () => {
        if (h) await h.close();
        if (extractDir) fs.rmSync(extractDir, { recursive: true, force: true });
    });

    test('the zip contains no development files', () => {
        // The packager is allowlist-based; this confirms nothing from the dev
        // tree (tests, scripts, node_modules, docs, dotfiles) leaked in.
        const all = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else all.push(path.relative(extractDir, full).split(path.sep).join('/'));
            }
        };
        walk(extractDir);

        const leaked = all.filter((f) => /^(tests|scripts|node_modules|docs|dist)\/|^\.|package(-lock)?\.json$|\.md$/.test(f));
        expect(leaked).toEqual([]);
        expect(all).toContain('manifest.json');
    });

    test('the packaged build installs and intercepts', async () => {
        const result = await proveInterceptionWorks(h);
        expect(result.body).toEqual({ mocked: true });
    });

    test('the packaged build starts without errors', async () => {
        expect(h.startupErrors).toEqual([]);
        expect(h.allErrors).toEqual([]);
    });
});
