/**
 * Every file that ships must be one Chrome will actually load.
 *
 * Chrome rejects a content script as "not UTF-8 encoded" if it contains a
 * Unicode noncharacter or surrogate, even when the bytes are valid UTF-8 and
 * Node decodes them without a murmur. A literal U+FFFF in src/matcher.js made
 * the extension uninstallable while every other test passed; this suite is
 * what would have caught it.
 *
 * It walks the same allowlist the packager uses, so it checks exactly the
 * set of files that goes into the Web Store zip — no more, no less.
 */

const fs = require('fs');
const path = require('path');
const { buildAllowlist, ROOT } = require('../scripts/package-extension');
const { findChromiumTextProblem, isTextFile } = require('../scripts/chromium-text');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const shipped = [...buildAllowlist(manifest)].sort();

describe('shipped files', () => {
    test('the allowlist is non-trivial and includes every content script', () => {
        const contentScripts = manifest.content_scripts.flatMap((cs) => cs.js || []);
        for (const script of contentScripts) {
            expect(shipped).toContain(script);
        }
    });

    test.each(shipped.filter(isTextFile))('%s passes Chrome\'s UTF-8 check', (relPath) => {
        const problem = findChromiumTextProblem(fs.readFileSync(path.join(ROOT, relPath)));
        expect(problem).toBeNull();
    });
});

describe('findChromiumTextProblem', () => {
    const check = (text) => findChromiumTextProblem(Buffer.from(text, 'utf8'));

    test('accepts ordinary text, including non-ASCII', () => {
        expect(check('const a = 1; // em dash — and café')).toBeNull();
    });

    test('accepts the escape sequence form of a noncharacter', () => {
        // What src/matcher.js now uses: same runtime string, ASCII source.
        expect(check("re.test(x + '\\uFFFF');")).toBeNull();
    });

    test('rejects a literal U+FFFF, naming the line', () => {
        expect(check('line one\nre.test(x + \'￿\');')).toMatch(/line 2: U\+FFFF is a Unicode noncharacter/);
    });

    test('rejects the other noncharacter ranges', () => {
        expect(check('￾')).toMatch(/noncharacter/);
        expect(check('﷐')).toMatch(/noncharacter/);
        expect(check(String.fromCodePoint(0x1FFFF))).toMatch(/noncharacter/);
    });

    test('rejects invalid UTF-8 bytes', () => {
        expect(findChromiumTextProblem(Buffer.from([0x61, 0xC3, 0x28]))).toBe('not valid UTF-8');
    });
});
