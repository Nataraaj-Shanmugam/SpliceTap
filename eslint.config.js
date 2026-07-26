/**
 * Minimal ESLint config for a no-build-step vanilla-JS Chrome extension
 * (audit finding CQ-Q10 — `npm run lint` previously just echoed a string and
 * always exited 0). Deliberately light-touch: catches real mistakes
 * (undefined variables, unreachable code, duplicate keys) without imposing
 * a house style on code that predates this config.
 */
'use strict';

module.exports = [
    {
        ignores: ['node_modules/**', 'audit/**', 'tests/*.html', 'dist/**', 'docs/**']
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                chrome: 'readonly',
                window: 'readonly',
                document: 'readonly',
                console: 'readonly',
                fetch: 'readonly',
                Request: 'readonly',
                Response: 'readonly',
                Headers: 'readonly',
                XMLHttpRequest: 'writable',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                FormData: 'readonly',
                Blob: 'readonly',
                CustomEvent: 'readonly',
                ProgressEvent: 'readonly',
                DOMException: 'readonly',
                AbortController: 'readonly',
                globalThis: 'readonly',
                module: 'writable',
                require: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                Event: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
                requestAnimationFrame: 'readonly',
                cancelAnimationFrame: 'readonly',
                performance: 'readonly',
                confirm: 'readonly',
                alert: 'readonly',
                FileReader: 'readonly',
                crypto: 'readonly'
            }
        },
        rules: {
            // caughtErrors: 'none' — `catch (e) { /* deliberately swallowed */ }`
            // is a legitimate, common pattern in this codebase (non-fatal
            // fallback paths); it isn't a bug worth flagging on every run.
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
            'no-undef': 'error',
            'no-dupe-keys': 'error',
            'no-unreachable': 'error',
            'no-fallthrough': 'error',
            'no-const-assign': 'error',
            'no-redeclare': 'error'
        }
    },
    {
        files: ['tests/**/*.test.js'],
        languageOptions: {
            globals: {
                describe: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                jest: 'readonly'
            }
        }
    },
    {
        // These files use top-level `export`/`import` (ESM); everything else
        // in the repo is a classic script or UMD (checked at runtime via
        // `typeof module !== 'undefined'`), so parsing them as sourceType
        // 'module' would misreport their top-level `this`/strict-mode rules.
        files: ['src/storage.js', 'src/utils.js', 'service_worker/background.js'],
        languageOptions: { sourceType: 'module' }
    },
    {
        // scripts/*.js run under plain Node (via `npm run validate`/`package`),
        // never in a browser or extension context.
        files: ['scripts/**/*.js'],
        languageOptions: {
            globals: {
                __dirname: 'readonly',
                __filename: 'readonly',
                Buffer: 'readonly',
                process: 'readonly',
                module: 'writable',
                require: 'readonly',
                console: 'readonly'
            }
        }
    }
];
