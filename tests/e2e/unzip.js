/**
 * Extract the packaged Web Store zip so the e2e suite can install the exact
 * artifact that gets uploaded, not just the source tree it was built from.
 *
 * Hand-rolled rather than shelling out: there is no zip extractor common to
 * every platform this might run on, and reading the central directory
 * ourselves lets the test also verify each entry's CRC-32 — a corrupt or
 * truncated package fails here rather than at Web Store review.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buf) {
    // The EOCD record is at least 22 bytes and may be followed by a comment.
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xFFFF); i--) {
        if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
    }
    throw new Error('not a zip: end-of-central-directory record not found');
}

/** Extract `zipPath` into `destDir`; returns the list of entry names. */
function extractZip(zipPath, destDir) {
    const buf = fs.readFileSync(zipPath);
    const eocd = findEndOfCentralDirectory(buf);
    const entryCount = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);

    const names = [];
    for (let n = 0; n < entryCount; n++) {
        if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
            throw new Error(`corrupt central directory at entry ${n}`);
        }
        const method = buf.readUInt16LE(offset + 10);
        const crc = buf.readUInt32LE(offset + 16);
        const compressedSize = buf.readUInt32LE(offset + 20);
        const nameLength = buf.readUInt16LE(offset + 28);
        const extraLength = buf.readUInt16LE(offset + 30);
        const commentLength = buf.readUInt16LE(offset + 32);
        const localOffset = buf.readUInt32LE(offset + 42);
        const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
        offset += 46 + nameLength + extraLength + commentLength;

        if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
            throw new Error(`corrupt local header for ${name}`);
        }
        const localNameLength = buf.readUInt16LE(localOffset + 26);
        const localExtraLength = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const raw = buf.subarray(dataStart, dataStart + compressedSize);

        let data;
        if (method === 0) data = raw;
        else if (method === 8) data = zlib.inflateRawSync(raw);
        else throw new Error(`unsupported compression method ${method} for ${name}`);

        if (zlib.crc32(data) >>> 0 !== crc) {
            throw new Error(`CRC mismatch for ${name}: the package is corrupt`);
        }

        // Guard against path traversal from a malformed entry name.
        const target = path.resolve(destDir, name);
        if (!target.startsWith(path.resolve(destDir) + path.sep)) {
            throw new Error(`refusing entry outside the destination: ${name}`);
        }
        if (name.endsWith('/')) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
        names.push(name);
    }
    return names;
}

module.exports = { extractZip };
