/**
 * Manifest Validation Script
 * Validates the extension manifest for common issues
 */

const fs = require('fs');
const path = require('path');

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
        
        // Check icons
        if (manifest.icons) {
            for (const [size, iconPath] of Object.entries(manifest.icons)) {
                const fullPath = path.join(__dirname, '..', iconPath);
                if (!fs.existsSync(fullPath)) {
                    console.error(`❌ Icon not found: ${iconPath} (${size}x${size})`);
                    return false;
                }
            }
            console.log('✅ All icons exist');
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