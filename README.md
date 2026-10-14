<div align="center">

<img src="assets/icons/icon-128.png" width="88" height="88" alt="">

# SpliceTap

**Mock, block, delay, redirect and rewrite any API call — right in your browser.**

No proxy. No backend changes. No build step.

[![Version](https://img.shields.io/badge/version-0.0.1-1e63f5?style=flat-square)](https://github.com/Nataraaj-Shanmugam/SpliceTap/releases)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-0bbcd4?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Tests](https://img.shields.io/badge/tests-761%20unit%20%C2%B7%20408%20headless-22c55e?style=flat-square)](#contributing)
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

Coming from Requestly? [PARITY.md](PARITY.md) compares the two feature by
feature — what SpliceTap matches, where it goes further, and what it does not
do yet — with every claim backed by a headless test.

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
   - Use **Check syntax** on a rule to validate its structure (Valid / Invalid).
   - Rule rows show "N hits" or "No hits yet".
   - Each rule card's check glyph reads "Valid (syntax check only)", "Invalid"
     with the reason, or "Not checked". Valid means well-formed, not that the
     rule has matched anything — the hit count is that evidence.

## Rule Types

Every rule has a `type`. Legacy rules exported without a `type` field are automatically migrated to `mock` on load.

### `mock` — Return a synthetic or patched response
Two response **modes**:
- **`static`** (default): Return a fully synthetic response you define — `statusCode`, `statusText`, `headers`, `body`, optional `delay`. Placeholders in the body are expanded at request time.
- **`patch`**: Let the **real** request go to the network, then apply an RFC 7386 **JSON Merge Patch** to the response body. Objects merge recursively, `null` deletes a key, and arrays/scalars replace the existing value. A patch is skipped (the real response passes through, and the log notes why) when the response is not JSON, or its root is not an object. An empty patch `{}` changes nothing. Patch mode keeps the original status code.

Mock rules also support two optional matching conditions:
- **`match.graphql.operationName`** — matches `operationName` for POST bodies, batched (array) bodies, GET requests with `?operationName=`, and names declared in the `query`. This is the key to mocking a single query/mutation on a shared single-endpoint GraphQL API. (Method: POST, GET or Any (`*`).)
- **`match.headers`** — an object of `{ 'header-name': 'value-substring' }`; **all** entries must match. Names are compared case-insensitively; values by substring.

All successful mock/patch responses carry `x-splicetap: true` and `x-splicetap-rule: <rule name>` headers so you can confirm interception in the console/Network response headers. `x-splicetap-rule` carries the rule name, percent-encoded when the name has non-ASCII characters.

### `block` — Fail the request
`fetch` rejects with a `TypeError('Failed to fetch')`; XHR fires an `error` event with `status: 0`. Useful for testing error and offline states.

### `delay` — Slow a request down, then let it through
Waits `delayMs` milliseconds, then passes the request through to the real network unchanged. Useful for testing spinners and latency handling.

### `redirect` — Send the request somewhere else
Rewrites the request URL to `redirect.destination` before it hits the network. With a `/regex/` pattern, the destination replaces the whole URL and `$1`–`$9` come from the match. For example, the *Redirect to localhost* template's pattern `/^https?:\/\/[^/]+\/(api\/.*)/` sends `…/api/…` on any host to `http://localhost:3000/$1`. `$n` is refused with a wildcard pattern, because wildcards don't capture.

### `headers` — Add/remove request or response headers
Handled by `chrome.declarativeNetRequest` (see Architecture). `headersMod.request` and `headersMod.response` are each arrays of `{ op: 'set' | 'remove', name, value }`. Common use: a "CORS Unblock" preset that sets `Access-Control-Allow-Origin: *` on responses, or overriding `User-Agent` on requests.

### `queryparams` — Add or remove URL query parameters
Also handled by declarativeNetRequest. `queryParams.add` is an array of `{ key, value }`; `queryParams.remove` is an array of keys to strip.

### Validation
- Status codes must be 200–599, because 1xx are interim responses.
- Header names and values must not contain characters above U+00FF.
- `/regex/flags` is refused (matching is already case-insensitive).
- Bodies and patches can be nested at most 64 levels.
- `Access-Control-Allow-Credentials: true` needs a URL pattern that names a host.

## Matching & Precedence

- **Which URL is matched**: Rules match the request's absolute URL, with the URL as the page wrote it as a fallback. A host or full-URL pattern also matches relative calls such as `fetch('/api/users')`.
- **URL pattern semantics** (case-insensitive):
  - Contains `*` → wildcard, anchored full-match (`*` alone matches everything)
  - Wrapped in `/.../` → treated as a regular expression
  - Otherwise → substring match
- **Header and query-param rules** use the same anchored wildcard semantics as other rules: `*/echo` does not match `/echo/sub` or `/echo?x=1`.
- **Method** `*` matches any method.
- **What they reach**: `mock`, `block`, `delay` and `redirect` act on requests the page makes with `fetch` or `XMLHttpRequest`. They do not reach scripts, stylesheets, images or page navigations — a `<script src>` is not redirected and an `<img>` is not blocked.
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
- `Alt+Shift+E`: Create new rule (**E**ditor) — opens the in-page overlay on the active tab, falling back to the options page where the overlay can't run (global, works on any page). Either shortcut can be changed at `chrome://extensions/shortcuts`
- `Ctrl+N`: Create new rule (in popup)
- `Ctrl+F`: Focus search box (in popup)
- `Ctrl+T`: Check all rules' syntax (in popup)
- `Ctrl+R`: Refresh data (in popup)
- `Escape`: Close popup

## Advanced Features

### Rule Templates
The rule editor — the same one whether it opens over your page or on the
options page — offers seven presets: GraphQL Mock, Patch Response, Block Request, Slow Request,
Redirect to localhost, CORS Unblock (headers), and Custom User-Agent (headers).

The two header templates are deliberately scoped to `localhost` and `127.0.0.1` (any port) rather
than every site, because a CORS-disabling rule left on `*` is a real security
downgrade, not just a mocking convenience. Widen them only when you mean to.

- **Redirect to localhost** uses the anchored regex `/^https?:\/\/[^/]+\/(api\/.*)/` and sends `…/api/…` on any host to `http://localhost:3000/$1`.
- **CORS Unblock** also sets `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`. Credentialed requests need a specific origin plus `Access-Control-Allow-Credentials: true` on a host-scoped pattern.

### Import/Export
Both live in the popup's **Data** tab.
- Export downloads your rules as a JSON file, for backup or sharing. Export omits hit counts and other runtime fields.
- Import takes JSON pasted into the panel, with a "Keep existing rules" option
  for merge-versus-replace. "Keep existing rules" appends after your rules and skips exact duplicates. Replace mode asks for confirmation. There is no file picker: a Chrome popup closes the
  moment an OS dialog takes focus, which would discard the import mid-flow
- Every imported rule is validated, and invalid ones are skipped rather than
  failing the whole batch. Skipped or invalid rules are listed with reasons.
- **Migration**: v1 rule files (no `type` field) load transparently — each rule is normalized to `type: 'mock'` with `response.mode: 'static'`

### Popup & editor
- After a Delete, Ctrl+Z or Alt+Z undoes it. Action toasts stay until dismissed.
- **Move to top** is available in the rule list.
- A new rule's method defaults to Any (`*`).
- A blank response body is served empty.
- A dirty in-page editor prompts before a page reload.
- The context-menu entry is "New SpliceTap rule for this site…".
- The popup footer counter is labelled "today".

### Capture — build a rule from a real response
Mocking an endpoint normally starts with retyping its payload by hand, and patch
mode is worse: you have to know the real response's shape before you can decide
which fields to change.

Capture removes that step. Switch it on in the popup's **Data** tab, trigger the
request you care about, and the real response is recorded. Each capture then
offers two buttons:

- **Mock** — a rule replaying that exact status, content type and body, ready to
  edit.
- **Patch** — a rule that lets the real response through and merges your changes
  into it. Offered only when the captured body is a JSON object; open the
  capture's response in Chrome's Network tab to see which fields exist to change.

New rules are created **disabled**, so nothing starts intercepting while you are
still looking at it. Captured URLs are redacted like the log, so a URL that
carried a secret parameter yields a pattern containing `[redacted]` — edit it
before enabling the rule.

Capture is the one feature that records response bodies, so it is deliberately
bounded: off until you switch it on, a **REC** badge on the toolbar icon the
whole time it is running, at most 25 textual responses of up to 100 KB each, and
session storage only — cleared when the browser closes, or by you, at any time.

### Chaos Mode
Fails a configurable percentage of requests at random, for exercising retry and
error handling. Enable it in the popup's **Settings** tab.

**It is global and unscoped.** Unlike rules, it has no URL pattern — while it is
on it fails requests on *every* site, not just the one you are testing. The
toolbar icon shows a red **CHAOS** badge the entire time it is active, so you
can see at a glance that failures are being injected deliberately rather than
debugging a problem that isn't real.

### DevTools Panel
Open Chrome DevTools and select the **SpliceTap** panel. Because mocked/blocked/delayed/redirected requests never reach the real network stack (and so can't appear in the normal Network tab), the panel instead shows SpliceTap's own interception log: it polls the background service worker every 3 seconds and renders each applied rule (method, URL, rule name, type, status, relative time), newest first. Delays and redirects show the status the page finally received (and where a redirect went); chaos failures and skipped patches appear too, with a note saying why. Header and query-param rules are applied by Chrome's network layer and do not appear — check the Network tab for those. A "Clear" button empties the log.

## Technical Details

### Architecture
SpliceTap intercepts requests through **two independent mechanisms**, depending on rule type:

- **MAIN-world fetch/XHR monkey-patching** (`content/injected.js`) handles `mock`, `block`, `delay`, and `redirect`. A content script declared with `"world": "MAIN"` and `run_at: "document_start"` injects the interceptor before any page script runs, in all frames, including about:blank, srcdoc, blob: and data: frames. The interceptor wraps `window.fetch` and `XMLHttpRequest` so it can synthesize, reject, delay, or reroute requests entirely in-page — these requests never touch the network stack.
- **`chrome.declarativeNetRequest` dynamic rules** (`service_worker/dnr.js`) handle `headers` and `queryparams`. These are real network-layer modifications applied by the browser, so they affect traffic the in-page interceptor can't see (and correctly show up in the normal DevTools Network tab).

Supporting pieces:
- **Shared UMD modules** (`src/placeholders.js`, `src/matcher.js`, `src/patch.js`) contain the single canonical copy of the placeholder engine, matcher, and JSON Merge Patch logic. The same files load in the MAIN world (as plain scripts), in the service worker (via side-effect import + global), and under Jest (as CommonJS), so the logic never diverges.
- **Service Worker** (`service_worker/background.js`): holds rules/settings/stats in memory, persists via `src/storage.js`, broadcasts state to all tabs on every change, syncs declarativeNetRequest rules, and keeps the in-memory interception-log ring buffer.
- **Content relay** (`content/content.js`): an ISOLATED-world script that syncs rule state between the background worker and the page, and forwards interception-log messages from the interceptor to the background worker.

### Frames and lifecycle
- **Frames**: about:blank, srcdoc, blob: and data: frames, and about:blank popups, are intercepted. A request a data: frame makes while its own HTML is still loading may not be.
- **After installing or updating SpliceTap, reload open tabs.** Until then a tab with no content script ignores rules, and the popup shows a "Reload this tab" banner. A tab left open across an extension update stops mocking.

### Permissions
- `storage` — persist rules and settings locally
- `contextMenus` — the right-click "create rule" entry
- `declarativeNetRequestWithHostAccess` — apply `headers` / `queryparams` rules at the network layer, scoped to the host(s) a rule's URL pattern matches
- `<all_urls>` (host permission) — the in-page interceptor and rule-editor overlay need to run on whatever site you're mocking; there's no way to know that site in advance. Both scripts are injected on every page load (even when SpliceTap is toggled off or has no rules for that origin) because MV3 content-script injection is static, declared per-manifest, not computed per-request; the interceptor checks the active/rules state internally before doing anything, and the overlay stays dormant until invoked. Scoping injection to only origins with enabled rules (e.g. via `chrome.scripting.registerContentScripts`) is a possible future tightening, tracked as a follow-up rather than done here.

### Single Purpose & Privacy
SpliceTap's single purpose is local API request mocking and modification for development/testing. It does not collect, transmit, or sell any data: every rule, setting, and log entry stays in `chrome.storage` on your device (see Privacy & Security below), and nothing in the codebase makes a network request on the extension's own behalf.

### Browser Compatibility
- **Chrome**: 120+ (`minimum_chrome_version` is 120), and what the test suites run against
- **Other Chromium browsers** (Edge, Brave, …): expected to work, not yet tested
- **Firefox / Safari**: not supported in this release (out of scope)

### Privacy & Security
- **Local Storage Only**: All rules and settings are stored locally on your device
- **No Data Collection**: No analytics, tracking, or remote data sharing
- **Interception log**: The DevTools log holds only request metadata (URL, method, rule name/type, status) for the last 200 intercepted requests, in session storage that clears when the browser closes — never bodies
- **Capture**: The one feature that stores response bodies, only while you switch it on, in the same session storage (see [PRIVACY.md](PRIVACY.md))
- **CSP Compliant**: No inline scripts in extension pages; DevTools panel logic lives in `devtools/panel.js`

### Known Limitations

#### What each rule type reaches

| Request source | mock / block / delay / redirect | headers / query params |
|---|---|---|
| Page and frame fetch / XHR | yes | yes |
| Web Worker, SharedWorker, Service Worker fetch | no | yes |
| EventSource | no | yes |
| navigator.sendBeacon | no | no |
| WebSocket | no | no |
| `<script src>`, images, navigation | no | no |

- Rules act on **fetch and XHR only** — not scripts, styles, images or navigations (see Matching & Precedence).
- Requests fired by the page **before the first state sync** arrives pass through unmocked.
- A **delayed XHR** fires `loadstart` when the request actually leaves, after the delay, rather than immediately. `fetch` is unaffected.
- Rules created from the *CORS Unblock* or *Custom User-Agent* templates before 10 October 2026 used a pattern that missed local ports; recreate them from the template.
- XHR **patch mode** re-fetches the original response via `fetch(url, { method, headers, body, credentials })` — an approximation of the original XHR request. `credentials` is `include` only when `xhr.withCredentials` is set, otherwise `same-origin`, and the request's headers are forwarded.
- `headers` / `queryparams` (declarativeNetRequest) rules **cannot** use `match.headers` or `match.graphql` conditions — the network layer can't express them, so the editor rejects those combinations.
- **Firefox** support is out of scope for this release.
- Headers a page adds by patching `XMLHttpRequest.prototype.send` are not visible to `match.headers`.
- A mocked **3xx** is followed for `fetch` (honouring `redirect: 'manual'` and `'error'`), but delivered as-is to XHR.
- A mocked cross-origin `no-cors` fetch is readable, where a real one would be opaque.
- URL redaction matches parameter names that *contain* words such as `key` or `code`, so harmless names like `keyword` are redacted too.
- On pages whose CSP restricts Trusted Types policy names, a mocked `responseType: 'document'` holds the response as plain text and the page records one policy violation.

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
npm test                              # Unit suites (fast)
npm run test:e2e                      # Headless Chrome suites (~3 min)
npm run validate                      # Manifest + shipped-file checks
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
├── src/                       # Shared modules (UMD — one copy, loaded everywhere)
│   ├── rule-schema.js         # The one definition of a valid rule (editors + save boundary)
│   ├── rule-editor.js         # The one rule editor (in-page overlay + options page)
│   ├── placeholders.js        # Dynamic-response placeholder engine
│   ├── matcher.js             # URL / header / GraphQL / rule matching
│   ├── patch.js               # RFC 7386 JSON Merge Patch
│   ├── templates.js           # Rule templates + HTTP status reason phrases
│   ├── common.js              # escapeHtml, id generation, shared limits
│   ├── storage.js             # chrome.storage wrapper + rule migration
│   └── index.js               # CommonJS entry for tests
├── service_worker/
│   ├── background.js          # State, sync, interception log, context menu
│   └── dnr.js                 # declarativeNetRequest rule mapping/sync
├── content/
│   ├── injected.js            # MAIN-world fetch/XHR interceptor
│   ├── content.js             # ISOLATED-world state relay
│   └── overlay.js             # Mounts the rule editor over the current page
├── popup/                     # Toolbar popup (rules, data, settings)
├── options/                   # Fallback host for the rule editor
├── devtools/
│   ├── devtools.js            # Panel registration
│   ├── panel.html             # DevTools panel markup
│   └── panel.js               # Interception-log polling + rendering
├── scripts/
│   ├── validate-manifest.js   # Manifest + shipped-file validation
│   ├── package-extension.js   # Allowlist ZIP packager
│   └── chromium-text.js       # Chrome's stricter UTF-8 check for shipped files
├── docs/                      # GitHub Pages site (landing page + privacy policy)
├── build.sh                   # One-command store build → dist/
└── tests/                     # Jest unit suites; tests/e2e/ runs headless Chrome
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
