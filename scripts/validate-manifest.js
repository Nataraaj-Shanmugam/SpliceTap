/**
 * Manifest Validation Script
 * Validates the extension manifest for common issues
 */

const fs = require('fs');
const path = require('path');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/**
 * Validate that `buf` is a real, decodable PNG whose IHDR-declared width/height
 * match `declaredSize`x`declaredSize`. Returns { ok, reason?, width?, height? }.
 *
 * This exists because a prior bug (audit finding C-1) shipped icon files that
 * were plain-text base64 (the ASCII string "iVBORw0KGgo...") saved with a
 * `.png` extension — `fs.existsSync` alone happily reports such files as
 * "present" even though Chrome cannot load them as images. This check reads
 * the actual bytes and parses the IHDR chunk instead of trusting the filename.
 */
function validatePngFile(buf, declaredSize, label) {
    if (!buf || buf.length < 8 || !buf.slice(0, 8).equals(PNG_SIGNATURE)) {
        const looksLikeBase64Text = buf && buf.slice(0, 11).toString('ascii') === 'iVBORw0KGgo';
        return {
            ok: false,
            reason: `${label} does not start with the PNG magic bytes (89 50 4E 47 0D 0A 1A 0A)` +
                (looksLikeBase64Text
                    ? ' — it looks like base64-ENCODED TEXT ("iVBORw0KGgo...") saved with a .png extension, not a real binary PNG.'
                    : '.')
        };
    }

    if (buf.length < 8 + 8 + 13) {
        return { ok: false, reason: `${label} is too short to contain a valid IHDR chunk.` };
    }

    const chunkType = buf.slice(12, 16).toString('ascii');
    if (chunkType !== 'IHDR') {
        return { ok: false, reason: `${label}'s first chunk is "${chunkType}", expected "IHDR".` };
    }

    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);

    if (width !== declaredSize || height !== declaredSize) {
        return {
            ok: false,
            reason: `${label} is declared/named as ${declaredSize}x${declaredSize} but its IHDR chunk says ` +
                `${width}x${height}.`
        };
    }

    return { ok: true, width, height };
}

function validateManifest() {
    const manifestPath = path.join(__dirname, '..', 'manifest.json');
    
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        
        console.log('🎭 TurboMock Manifest Validation');
        console.log('================================');
        
        // Check manifest version
        if (manifest.manifest_version !== 3) {
            console.error('❌ Manifest version should be 3');
            return false;
        }
        console.log('✅ Manifest version: 3');
        
        // Check required fields
        const requiredFields = ['name', 'version', 'description'];
        for (const field of requiredFields) {
            if (!manifest[field]) {
                console.error(`❌ Missing required field: ${field}`);
                return false;
            }
        }
        console.log('✅ All required fields present');
        
        // Check permissions
        if (!manifest.permissions || !Array.isArray(manifest.permissions)) {
            console.error('❌ Permissions should be an array');
            return false;
        }
        console.log(`✅ Permissions defined: ${manifest.permissions.length} items`);
        
        // Check service worker
        if (!manifest.background || !manifest.background.service_worker) {
            console.error('❌ Service worker not defined');
            return false;
        }
        
        const serviceWorkerPath = path.join(__dirname, '..', manifest.background.service_worker);
        if (!fs.existsSync(serviceWorkerPath)) {
            console.error(`❌ Service worker file not found: ${manifest.background.service_worker}`);
            return false;
        }
        console.log('✅ Service worker exists');
        
        // Check content scripts
        if (manifest.content_scripts) {
            for (const script of manifest.content_scripts) {
                for (const js of script.js || []) {
                    const jsPath = path.join(__dirname, '..', js);
                    if (!fs.existsSync(jsPath)) {
                        console.error(`❌ Content script not found: ${js}`);
                        return false;
                    }
                }
            }
            console.log('✅ All content scripts exist');
        }
        
        // Check popup
        if (manifest.action && manifest.action.default_popup) {
            const popupPath = path.join(__dirname, '..', manifest.action.default_popup);
            if (!fs.existsSync(popupPath)) {
                console.error(`❌ Popup file not found: ${manifest.action.default_popup}`);
                return false;
            }
            console.log('✅ Popup file exists');
        }
        
        // Check icons — existence AND real, correctly-sized PNG bytes.
        // Collect every declared icon path from both `icons` and
        // `action.default_icon` (both reference the same files here, but a
        // future edit could point them at different assets).
        const declaredIcons = new Map(); // iconPath -> declared size (number)
        if (manifest.icons) {
            for (const [size, iconPath] of Object.entries(manifest.icons)) {
                declaredIcons.set(iconPath, parseInt(size, 10));
            }
        }
        if (manifest.action && manifest.action.default_icon) {
            for (const [size, iconPath] of Object.entries(manifest.action.default_icon)) {
                declaredIcons.set(iconPath, parseInt(size, 10));
            }
        }

        if (declaredIcons.size > 0) {
            for (const [iconPath, declaredSize] of declaredIcons.entries()) {
                const fullPath = path.join(__dirname, '..', iconPath);
                if (!fs.existsSync(fullPath)) {
                    console.error(`❌ Icon not found: ${iconPath} (${declaredSize}x${declaredSize})`);
                    return false;
                }

                const buf = fs.readFileSync(fullPath);
                const result = validatePngFile(buf, declaredSize, iconPath);
                if (!result.ok) {
                    console.error(`❌ Icon failed PNG validation: ${result.reason}`);
                    return false;
                }
            }
            console.log(`✅ All icons exist and are valid, correctly-sized PNGs (${declaredIcons.size} files checked)`);
        }
        
        // Check options page
        if (manifest.options_ui && manifest.options_ui.page) {
            const optionsPath = path.join(__dirname, '..', manifest.options_ui.page);
            if (!fs.existsSync(optionsPath)) {
                console.error(`❌ Options page not found: ${manifest.options_ui.page}`);
                return false;
            }
            console.log('✅ Options page exists');
        }
        
        // Check version format
        const versionRegex = /^\d+\.\d+\.\d+$/;
        if (!versionRegex.test(manifest.version)) {
            console.error('❌ Version should follow semantic versioning (x.y.z)');
            return false;
        }
        console.log(`✅ Version format: ${manifest.version}`);

        // Check manifest.version stays in sync with package.json's version.
        // manifest.json is the single source of truth (it's what the Chrome
        // Web Store sees); package.json must be kept matching it manually
        // (or by a release script) rather than drifting silently.
        const packageJsonPath = path.join(__dirname, '..', 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            if (pkg.version !== manifest.version) {
                console.error(
                    `❌ Version mismatch: manifest.json is "${manifest.version}" but package.json is "${pkg.version}"`
                );
                return false;
            }
            console.log(`✅ package.json version matches manifest.json (${manifest.version})`);
        }

        console.log('\n🎉 Manifest validation passed!');
        console.log(`Extension: ${manifest.name} v${manifest.version}`);
        console.log(`Description: ${manifest.description}`);
        
        return true;
        
    } catch (error) {
        console.error('❌ Failed to validate manifest:', error.message);
        return false;
    }
}

// Run validation
if (require.main === module) {
    const isValid = validateManifest();
    process.exit(isValid ? 0 : 1);
}

module.exports = validateManifest;