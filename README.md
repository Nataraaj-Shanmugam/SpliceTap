<div align="center">

<img src="assets/icons/icon-128.png" width="88" height="88" alt="">

# SpliceTap

**Mock, block, delay, redirect and rewrite any API call — right in your browser.**

No proxy. No backend changes. No build step.

[![Version](https://img.shields.io/badge/version-0.0.1-1e63f5?style=flat-square)](https://github.com/Nataraaj-Shanmugam/SpliceTap/releases)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-0bbcd4?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Tests](https://img.shields.io/badge/tests-59%20passing-22c55e?style=flat-square)](#contributing)
[![License](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)

[Website](https://nataraaj-shanmugam.github.io/SpliceTap/)&nbsp;·&nbsp;[Privacy Policy](https://nataraaj-shanmugam.github.io/SpliceTap/privacy.html)&nbsp;·&nbsp;[Report a bug](https://github.com/Nataraaj-Shanmugam/SpliceTap/issues)

</div>

---

SpliceTap intercepts your app's HTTP traffic in the browser and answers it however you
need — a canned response, a surgical edit to the real one, a failure, a delay, or a
redirect to localhost. Useful when the endpoint isn't built yet, the error path won't
reproduce, or the network is too fast to catch a loading state.

## Features

- **Six rule types**: Mock, Block, Delay, Redirect, Modify Headers, and Query Params
- **Static & patch mocking**: Return a full synthetic response, or fetch the real one and surgically patch a few fields (RFC 7386 JSON Merge Patch)
- **GraphQL-aware matching**: Target a single `operationName` on a shared `/graphql` endpoint
- **Pattern Matching**: Wildcard, regex, and substring URL matching, plus optional header and GraphQL conditions
- **Dynamic placeholders**: Inject timestamps, GUIDs, random data, and request details into responses
- **Live DevTools panel**: A "SpliceTap" panel that logs every intercepted request
- **Dark/Light Theme**: Automatic theme detection or manual selection
- **Import/Export**: Backup and share your rules; v1 rule files migrate automatically
- **Keyboard Shortcuts & Context Menu**: Fast rule creation from anywhere

## Quick Start

### Installation

#### For Development:
1. Clone this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension directory
5. The SpliceTap icon should appear in your toolbar

#### For Production:
- Install from Chrome Web Store (coming soon)

### Basic Usage

1. **Create Your First Rule**:
   - Click the SpliceTap icon in your toolbar and click "New Rule", or right-click on any page and choose the SpliceTap context-menu entry — both open the in-page rule editor overlay with the current host prefilled, falling back to the full options page only where the overlay can't run (e.g. `chrome://` pages, the Web Store)
   - Pick a **Rule Type**, configure the matching and behavior fields
   - Save — the rule takes effect immediately on matching requests

2. **Rule Configuration** (fields shared by all types):
   - **Name**: Descriptive name for your rule
   - **Enabled**: Toggle the rule on/off
   - **Method**: HTTP method (GET, POST, etc.) or `*` for any method
   - **URL Pattern**: Wildcard like `*/api/users/*`, regex `/api/users/\d+/`, or a plain substring

3. **Testing Rules**:
   - Use the "Test" button in the popup to validate a rule's structure
   - Each rule card shows a status icon: a green check (passed), a red cross
     (failed), an amber triangle (warning), or a grey clock (not yet tested)

## Rule Types

Every rule has a `type`. Legacy rules exported without a `type` field are automatically migrated to `mock` on load.

### `mock` — Return a synthetic or patched response
Two response **modes**:
- **`static`** (default): Return a fully synthetic response you define — `statusCode`, `statusText`, `headers`, `body`, optional `delay`. Placeholders in the body are expanded at request time.
- **`patch`**: Let the **real** request go to the network, then apply an RFC 7386 **JSON Merge Patch** to the response body. Objects merge recursively, `null` deletes a key, and arrays/scalars replace the existing value. Only valid-JSON responses are patched; anything else passes through untouched. Patch mode keeps the original status code.

Mock rules also support two optional matching conditions:
- **`match.graphql.operationName`** — matches against the request body's `operationName`. This is the key to mocking a single query/mutation on a shared single-endpoint GraphQL API. (Requires method `POST` or `*`.)
- **`match.headers`** — an object of `{ 'header-name': 'value-substring' }`; **all** entries must match. Names are compared case-insensitively; values by substring.

All successful mock/patch responses carry `x-splicetap: true` and `x-splicetap-rule: <rule name>` headers so you can confirm interception in the console/Network response headers.

### `block` — Fail the request
`fetch` rejects with a `TypeError('Failed to fetch')`; XHR fires an `error` event with `status: 0`. Useful for testing error and offline states.

### `delay` — Slow a request down, then let it through
Waits `delayMs` milliseconds, then passes the request through to the real network unchanged. Useful for testing spinners and latency handling.

### `redirect` — Send the request somewhere else
Rewrites the request URL to `redirect.destination` before it hits the network. If `match.url` is a `/regex/` pattern, `$1`..`$9` capture references are supported in the destination (e.g. redirect `https://prod.example.com/api/$1` to `http://localhost:3000/$1`).

### `headers` — Add/remove request or response headers
Handled by `chrome.declarativeNetRequest` (see Architecture). `headersMod.request` and `headersMod.response` are each arrays of `{ op: 'set' | 'remove', name, value }`. Common use: a "CORS Unblock" preset that sets `Access-Control-Allow-Origin: *` on responses, or overriding `User-Agent` on requests.

### `queryparams` — Add or remove URL query parameters
Also handled by declarativeNetRequest. `queryParams.add` is an array of `{ key, value }`; `queryParams.remove` is an array of keys to strip.

## Matching & Precedence

- **URL pattern semantics** (case-insensitive):
  - Contains `*` → wildcard, anchored full-match (`*` alone matches everything)
  - Wrapped in `/.../` → treated as a regular expression
  - Otherwise → substring match
- **Method** `*` matches any method.
- **Precedence**: For interceptor-handled types (`mock`, `block`, `delay`, `redirect`), enabled rules are evaluated in array order and the **first** rule whose URL + method + headers + GraphQL conditions all match wins — only that rule is applied.
- `headers` / `queryparams` rules are applied independently by the browser's network layer via declarativeNetRequest and are not part of this first-match ordering.

## URL Pattern Examples

```
# Wildcard patterns (anchored full match)
*/api/users/*          # Matches any URL containing /api/users/
*/api/*/profile        # Matches /api/v1/profile, /api/v2/profile, etc.

# Substring match
api.example.com/users  # Matches any URL containing this substring

# Regex patterns (wrapped in forward slashes)
/api/users/\d+/        # Matches /api/users/123/, /api/users/456/, etc.
/api/(users|accounts)/ # Matches /api/users/ or /api/accounts/
```

## Dynamic Placeholders

Placeholders in a mock body (static mode) or patch payload are expanded per request. The full supported set:

| Placeholder | Expands to |
|---|---|
| `{{timestamp}}` | Current time as ISO 8601 (`2026-07-23T12:34:56.789Z`) |
| `{{timestamp_ms}}` | Current time as epoch milliseconds |
| `{{date}}` | Current date (`YYYY-MM-DD`) |
| `{{time}}` | Current time (`HH:MM:SS`) |
| `{{guid}}` | A random v4-style UUID |
| `{{randomInt}}` | Random integer 0–999 |
| `{{randomInt:max}}` | Random integer 0–`max` (e.g. `{{randomInt:50}}`) |
| `{{randomFloat}}` | Random float 0–100 with 2 decimals |
| `{{randomString}}` | Random 10-char alphanumeric string |
| `{{randomString:len}}` | Random string of `len` characters (e.g. `{{randomString:8}}`) |
| `{{randomEmail}}` | Random `name###@domain` email |
| `{{randomBool}}` | `true` or `false` |
| `{{request.url}}` | The intercepted request's URL |
| `{{request.method}}` | The intercepted request's method |

## Mock Response Examples

### Success Response (static mode)
```json
{
  "success": true,
  "data": { "id": "{{guid}}", "name": "John Doe", "email": "{{randomEmail}}" },
  "timestamp": "{{timestamp}}"
}
```

### Patch Response (patch mode)
Given a real API response of `{ "user": { "name": "Real", "role": "user" }, "count": 3 }`, this patch:
```json
{ "user": { "role": "admin" }, "count": null }
```
produces `{ "user": { "name": "Real", "role": "admin" } }` — `role` is overwritten, `count` is deleted, everything else is preserved.

## Keyboard Shortcuts

- `Alt+Shift+M`: Toggle extension on/off (global, works on any page)
- `Alt+Shift+N`: Create new rule — opens the in-page overlay on the active tab, falling back to the options page where the overlay can't run (global, works on any page)
- `Ctrl+N`: Create new rule (in popup)
- `Ctrl+F`: Focus search box (in popup)
- `Ctrl+T`: Test all rules (in popup)
- `Ctrl+R`: Refresh data (in popup)
- `Escape`: Close popup

## Advanced Features

### Rule Templates
The rule editor's "Quick Template" dropdown includes six ready-to-use presets: GraphQL Mock, Patch Response, Block Request, Redirect to localhost, CORS Unblock (headers), and Custom User-Agent (headers).

### Import/Export
Both live in the popup's **Data** tab.
- Export downloads your rules as a JSON file, for backup or sharing
- Import takes JSON pasted into the panel, with a "Keep existing rules" option
  for merge-versus-replace. There is no file picker: a Chrome popup closes the
  moment an OS dialog takes focus, which would discard the import mid-flow
- Every imported rule is validated, and invalid ones are skipped rather than
  failing the whole batch — the result reports how many were skipped
- **Migration**: v1 rule files (no `type` field) load transparently — each rule is normalized to `type: 'mock'` with `response.mode: 'static'`

### DevTools Panel
Open Chrome DevTools and select the **SpliceTap** panel. Because mocked/blocked/delayed/redirected requests never reach the real network stack (and so can't appear in the normal Network tab), the panel instead shows SpliceTap's own interception log: it polls the background service worker every 3 seconds and renders each applied rule (method, URL, rule name, type, status, relative time), newest first. A "Clear" button empties the log.

## Technical Details

### Architecture
SpliceTap intercepts requests through **two independent mechanisms**, depending on rule type:

- **MAIN-world fetch/XHR monkey-patching** (`content/injected.js`) handles `mock`, `block`, `delay`, and `redirect`. A content script declared with `"world": "MAIN"` and `run_at: "document_start"` injects the interceptor before any page script runs, in all frames. The interceptor wraps `window.fetch` and `XMLHttpRequest` so it can synthesize, reject, delay, or reroute requests entirely in-page — these requests never touch the network stack.
- **`chrome.declarativeNetRequest` dynamic rules** (`service_worker/dnr.js`) handle `headers` and `queryparams`. These are real network-layer modifications applied by the browser, so they affect traffic the in-page interceptor can't see (and correctly show up in the normal DevTools Network tab).

Supporting pieces:
- **Shared UMD modules** (`src/placeholders.js`, `src/matcher.js`, `src/patch.js`) contain the single canonical copy of the placeholder engine, matcher, and JSON Merge Patch logic. The same files load in the MAIN world (as plain scripts), in the service worker (via side-effect import + global), and under Jest (as CommonJS), so the logic never diverges.
- **Service Worker** (`service_worker/background.js`): holds rules/settings/stats in memory, persists via `src/storage.js`, broadcasts state to all tabs on every change, syncs declarativeNetRequest rules, and keeps the in-memory interception-log ring buffer.
- **Content relay** (`content/content.js`): an ISOLATED-world script that syncs rule state between the background worker and the page, and forwards interception-log messages from the interceptor to the background worker.

### Permissions
- `storage` — persist rules and settings locally
- `contextMenus` — the right-click "create rule" entry
- `declarativeNetRequestWithHostAccess` — apply `headers` / `queryparams` rules at the network layer, scoped to the host(s) a rule's URL pattern matches
- `<all_urls>` (host permission) — the in-page interceptor and rule-editor overlay need to run on whatever site you're mocking; there's no way to know that site in advance. Both scripts are injected on every page load (even when SpliceTap is toggled off or has no rules for that origin) because MV3 content-script injection is static, declared per-manifest, not computed per-request; the interceptor checks the active/rules state internally before doing anything, and the overlay stays dormant until invoked. Scoping injection to only origins with enabled rules (e.g. via `chrome.scripting.registerContentScripts`) is a possible future tightening, tracked as a follow-up rather than done here.

### Single Purpose & Privacy
SpliceTap's single purpose is local API request mocking and modification for development/testing. It does not collect, transmit, or sell any data: every rule, setting, and log entry stays in `chrome.storage` on your device (see Privacy & Security below), and nothing in the codebase makes a network request on the extension's own behalf.

### Browser Compatibility
- **Chrome / Edge**: 120+ (full support; `minimum_chrome_version` is 120)
- **Firefox / Safari**: not supported in this release (out of scope)

### Privacy & Security
- **Local Storage Only**: All rules and settings are stored locally on your device
- **No Data Collection**: No analytics, tracking, or remote data sharing
- **Interception log**: The DevTools log holds only request metadata (URL, method, rule name/type, status) for the last 200 intercepted requests, in memory — response bodies are never stored
- **CSP Compliant**: No inline scripts in extension pages; DevTools panel logic lives in `devtools/panel.js`

### Known Limitations
- Requests fired by the page **before the first state sync** arrives pass through unmocked.
- XHR **patch mode** re-fetches the original response via `fetch(url, { method, body, credentials: 'include' })` — an approximation of the original XHR request.
- `headers` / `queryparams` (declarativeNetRequest) rules **cannot** use `match.headers` or `match.graphql` conditions — the network layer can't express them, so the editor rejects those combinations.
- **Firefox** support is out of scope for this release.

## Data Management

### Storage Structure
```javascript
{
  "spliceTapRules": [
    {
      "id": "rule_123456789",
      "name": "User Profile API",
      "enabled": true,
      "type": "mock",                 // mock | block | delay | redirect | headers | queryparams
      "created": "2026-01-01T00:00:00Z",
      "lastModified": "2026-01-01T00:00:00Z",
      "match": {
        "method": "GET",
        "url": "*/api/users/*",
        "headers": {},                // optional; all must match (case-insensitive name, substring value)
        "graphql": { "operationName": "getUser" }  // optional; mock type only
      },
      "response": {                   // mock type only
        "statusCode": 200,
        "statusText": "OK",
        "headers": { "Content-Type": "application/json" },
        "body": { "id": 123, "name": "John Doe" },
        "delay": 0,
        "mode": "static",             // static | patch
        "patch": {}                   // JSON Merge Patch, used when mode === 'patch'
      },
      "testStatus": "passed",
      "hitCount": 42
    }
  ],
  "spliceTapActive": true,
  "spliceTapStats": { "intercepted": 156, "rulesCount": 12, "lastUpdated": "2026-01-01T00:00:00Z" },
  "spliceTapSettings": { "theme": "auto", "notifications": true, "autoBackup": true, "debugMode": false }
}
```
Type-specific fields also include `delayMs` (delay), `redirect.destination` (redirect), `headersMod` (headers), `queryParams` (queryparams), and an internal `dnrRuleId` allocated by the background worker for declarativeNetRequest-backed rules.

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup
```bash
git clone https://github.com/Nataraaj-Shanmugam/SpliceTap.git
cd SpliceTap
npm install
npm test                              # Jest test suite
node scripts/validate-manifest.js     # Manifest sanity check
# Then load unpacked in chrome://extensions/ (Developer mode)
```

### Building a Store Package
```bash
./build.sh          # validate + test + lint, then write dist/splicetap-v<version>.zip
./build.sh --fast   # package only, skipping the gates
```

The ZIP contains only files `manifest.json` actually references — the allowlist is
derived by walking the manifest, so docs, tests, and tooling can never leak into a
release by accident. Upload the result at the
[Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

### Project Structure
```
splicetap-extension/
├── manifest.json              # Extension manifest (MV3)
├── assets/                    # Icons and static assets
├── src/                       # Shared utilities (UMD — load everywhere, no divergence)
│   ├── placeholders.js        # Dynamic-response placeholder engine
│   ├── matcher.js             # URL / header / GraphQL / rule matching
│   ├── patch.js               # RFC 7386 JSON Merge Patch
│   ├── utils.js               # Validation, import/export, templates
│   ├── storage.js             # chrome.storage wrapper + rule migration
│   └── index.js               # CommonJS entry for tests
├── service_worker/
│   ├── background.js          # State, sync, interception log, context menu
│   └── dnr.js                 # declarativeNetRequest rule mapping/sync
├── content/
│   ├── injected.js            # MAIN-world fetch/XHR interceptor
│   └── content.js             # ISOLATED-world state relay
├── popup/                     # Toolbar popup (rule list, toggle, test)
├── options/                   # Settings page + rule-type editor
├── devtools/
│   ├── devtools.js            # Panel registration
│   ├── panel.html             # DevTools panel markup
│   └── panel.js               # Interception-log polling + rendering
├── scripts/
│   ├── validate-manifest.js   # Manifest validation
│   └── package-extension.js   # Allowlist ZIP packager
├── docs/                      # GitHub Pages site (landing page + privacy policy)
├── build.sh                   # One-command store build → dist/
└── tests/                     # Jest test suites
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- **Website**: [nataraaj-shanmugam.github.io/SpliceTap](https://nataraaj-shanmugam.github.io/SpliceTap/)
- **Privacy Policy**: [PRIVACY.md](PRIVACY.md) · [hosted version](https://nataraaj-shanmugam.github.io/SpliceTap/privacy.html)
- **Issues**: [GitHub Issues](https://github.com/Nataraaj-Shanmugam/SpliceTap/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Nataraaj-Shanmugam/SpliceTap/discussions)

---

<div align="center">

Built by [Nataraaj Shanmugam](https://github.com/Nataraaj-Shanmugam) · MIT Licensed

</div>
