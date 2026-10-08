/**
 * Chromium's definition of "UTF-8 encoded", for files the extension ships.
 *
 * Chrome refuses to load an extension whose content script is not UTF-8 —
 * and "UTF-8" there means base::IsStringUTF8, which is stricter than the
 * encoding itself. Valid UTF-8 can still be rejected if it contains:
 *
 *   - a Unicode noncharacter: U+FDD0..U+FDEF, or any code point whose low
 *     sixteen bits are FFFE or FFFF (U+FFFE, U+FFFF, U+1FFFE, ...);
 *   - an encoded surrogate (U+D800..U+DFFF).
 *
 * This is not hypothetical. A literal U+FFFF in src/matcher.js's ReDoS probe
 * made the whole extension uninstallable — "Could not load file
 * 'src/matcher.js' for content script. It isn't UTF-8 encoded." — while every
 * unit test passed, because Node decodes the same bytes without complaint.
 * Write such characters as escapes ('￿') so the source bytes stay
 * ASCII; the runtime string is identical.
 */

const TEXT_EXTENSIONS = /\.(js|mjs|json|html|css|md|txt|svg)$/i;

function isTextFile(relPath) {
    return TEXT_EXTENSIONS.test(relPath);
}

/**
 * Returns null if Chrome would accept the bytes, otherwise a description of
 * the first offending position (line-numbered, for a usable error message).
 */
function findChromiumTextProblem(buffer) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (error) {
        return 'not valid UTF-8';
    }

    let line = 1;
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp === 0x0A) { line++; continue; }

        const surrogate = cp >= 0xD800 && cp <= 0xDFFF;
        const noncharacter = (cp >= 0xFDD0 && cp <= 0xFDEF) || (cp & 0xFFFE) === 0xFFFE;

        if (surrogate || noncharacter) {
            const hex = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
            return `line ${line}: ${hex} is a Unicode ${surrogate ? 'surrogate' : 'noncharacter'} — ` +
                `Chrome rejects the file as "not UTF-8 encoded". Write it as an escape instead.`;
        }
    }
    return null;
}

module.exports = { findChromiumTextProblem, isTextFile };
