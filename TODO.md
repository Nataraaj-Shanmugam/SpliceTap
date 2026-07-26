# SpliceTap — Requestly Parity Implementation TODO

> **How to use this document (read first):**
> This is the single source of truth for the implementation. All architectural decisions are
> already made — do NOT redesign, do NOT ask which approach to take, do NOT explore files
> outside the group you are working on. Work through groups **in order** (G1 → G8); later
> groups depend on earlier ones. Within a group, open ONLY the files listed under
> "Files to open". Match the existing code style (vanilla JS, no build step, no new
> dependencies except what package.json already has). Check off tasks as you complete them.

---

## 0. Context (do not re-explore the repo to learn this)

**What SpliceTap is:** MV3 Chrome extension that mocks API calls. Interception works by
monkey-patching `window.fetch` and `XMLHttpRequest` in the page's MAIN world
(`content/injected.js`). There is **no build step** — files are loaded as-is.

**Current architecture:**
- `content/injected.js` — MAIN-world interceptor (fetch + XHR patch, chaos mode, placeholders). Currently injected via a `<script>` tag by `content/content.js`.
- `content/content.js` — ISOLATED-world relay: injects the interceptor, syncs rule state between background and page via `window.postMessage`.
- `service_worker/background.js` — ESM service worker. Holds rules/settings/stats in memory, persists via `src/storage.js`, broadcasts `syncState` to all tabs on every change.
- `src/storage.js` — chrome.storage.local wrapper (rules, settings, stats, backups). ESM + window global.
- `src/utils.js` — validation, URL matching, placeholder engine (a DIVERGED duplicate of the one in injected.js). ESM + window global.
- `options/` — settings page + rule editor modal (`#ruleEditorModal` in options.html).
- `popup/` — rule list, search, toggle, test (validation only), stats.
- `devtools/` — panel exists but shows nothing real (see G7).
- `tests/` — Jest 30 + jsdom. **`npm test` is currently BROKEN**: `src/index.js` uses `require()` on ESM files. G1 fixes this.

**Current rule schema (v1):**
```js
{ id, name, enabled, created, lastModified,
  match: { method: 'GET'|'*', url: '<pattern>', headers: {} },   // headers currently IGNORED by matcher
  response: { statusCode, statusText, headers: {}, body, delay },
  testStatus, hitCount }
```
URL pattern semantics: contains `*` → wildcard (full match), wrapped in `/.../` → regex, else substring.

---

## 1. Global design decisions (the spec — every group conforms to this)

### 1.1 Rule schema v2 (backward compatible)

Add a `type` field. Rules without `type` are treated as `type: 'mock'` (migration in G4).

```js
{
  id, name, enabled, created, lastModified, testStatus, hitCount,
  type: 'mock' | 'block' | 'delay' | 'redirect' | 'headers' | 'queryparams',

  match: {
    method: 'GET' | 'POST' | ... | '*',
    url: '<pattern>',                          // same 3 pattern semantics as v1
    headers: { 'x-name': 'value-substring' },  // optional; ALL must match; name case-insensitive, value substring match
    graphql: { operationName: 'getUsers' }     // optional; only meaningful for type mock; matches request JSON body
  },

  // type 'mock' only:
  response: {
    statusCode, statusText, headers: {}, body, delay,
    mode: 'static' | 'patch',   // default 'static'
    patch: { ... }              // JSON Merge Patch applied to the REAL response body when mode==='patch'
  },

  // type 'delay' only:
  delayMs: 2000,                // then request passes through to the network

  // type 'redirect' only:
  redirect: { destination: 'https://...' },  // if match.url is a /regex/, $1..$9 capture refs allowed

  // type 'headers' only (handled by DNR, not the interceptor):
  headersMod: {
    request:  [ { op: 'set'|'remove', name: 'User-Agent', value: '...' } ],
    response: [ { op: 'set'|'remove', name: 'Access-Control-Allow-Origin', value: '*' } ]
  },

  // type 'queryparams' only (handled by DNR):
  queryParams: { add: [ { key, value } ], remove: [ 'key' ] },

  // internal, managed by background only — never edited in UI:
  dnrRuleId: 12   // integer DNR id, allocated on first sync for DNR-backed types
}
```

### 1.2 Routing table — which layer handles which type

| Rule type | Handled by | Mechanism |
|---|---|---|
| `mock` (static + patch), `block`, `delay`, `redirect` | `content/injected.js` | fetch/XHR monkey-patch |
| `headers`, `queryparams` | `service_worker/dnr.js` | `chrome.declarativeNetRequest` dynamic rules |

There is **no** "User-Agent" rule type — it is a `headers` template preset (G5).

**Interceptor precedence:** evaluate enabled interceptor-handled rules in array order; the
FIRST rule whose match succeeds wins; apply only that rule. (Document this in README, G8.)

### 1.3 Shared modules — UMD pattern (fixes the broken tests AND the diverged duplicates)

Three new files in `src/`, each written in this exact UMD shape so the SAME file loads as
(a) a plain MAIN-world script, (b) a CommonJS module under Jest, (c) via ESM side-effect import:

```js
(function (global) {
    'use strict';
    function fnA(...) { ... }
    const api = { fnA, ... };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.SpliceTapXxx = api;   // exact global names below
})(typeof window !== 'undefined' ? window : globalThis);
```

| File | Global name | Contents |
|---|---|---|
| `src/placeholders.js` | `SpliceTapPlaceholders` | `processDynamicResponse(body, requestDetails)` — the SUPERSET of both current engines (G1) |
| `src/matcher.js` | `SpliceTapMatcher` | `matchUrl`, `matchHeaders`, `matchGraphQL`, `findMatchingRule` (G1) |
| `src/patch.js` | `SpliceTapPatch` | `jsonMergePatch(original, patch)` — RFC 7386 semantics: objects merge recursively, `null` deletes a key, arrays/scalars replace (G1) |

These load in the MAIN world BEFORE `injected.js` via the manifest content_scripts array (G3).
`injected.js` DELETES its local copies and uses the globals. `src/utils.js` DELETES its
copies and delegates. **Never let the logic diverge again.**

### 1.4 MAIN-world injection — declarative, not script-tag

Replace the script-tag injection with a second `content_scripts` entry using
`"world": "MAIN"` (supported since Chrome 111; manifest requires 120). This makes the
interceptor run before ANY page script, in ALL frames, with no retry logic. (G3)

### 1.5 Interception log pipeline (replaces the broken DevTools detection)

**Critical fact:** mocked requests NEVER hit the network stack, so
`chrome.devtools.network.onRequestFinished` can never see them. The `x-splicetap` header
check in `devtools/devtools.js` is dead code. The working design:

1. `injected.js` — on every applied rule, `window.postMessage({ source: 'splicetap-injected', type: 'logInterception', entry })` where `entry = { ts: Date.now(), url, method, ruleId, ruleName, ruleType, status }`.
2. `content.js` — forwards it: `chrome.runtime.sendMessage({ type: 'logInterception', entry })`.
3. `background.js` — keeps an in-memory ring buffer, max **200** entries; increments stats from this message (the old separate `updateStats` message from injected.js is removed; keep the background handler for compatibility). New message types: `getInterceptionLog` → `{ success, entries }`, `clearInterceptionLog` → `{ success }`.
4. DevTools panel polls `getInterceptionLog` every 2 s while visible. (G7)

Still ADD `x-splicetap: true` and `x-splicetap-rule: <name>` headers to mocked/patched
responses — useful for users inspecting responses in the console.

### 1.6 New message types (complete list of additions)

| Message | Direction | Payload | Response |
|---|---|---|---|
| `logInterception` | content → background | `{ entry }` | `{ success }` |
| `getInterceptionLog` | popup/devtools → background | — | `{ success, entries }` |
| `clearInterceptionLog` | devtools → background | — | `{ success }` |

### 1.7 Known accepted limitations (do NOT try to solve these)

- Requests fired by the page before the first `syncState` arrives pass through unmocked.
- XHR patch-mode fetches the original via `fetch(url, { method, body, credentials: 'include' })` — an approximation of the original XHR.
- `headers` / `queryparams` (DNR) rules apply even to traffic the interceptor can't see (that's a feature), but ignore `match.headers` / `match.graphql` conditions (DNR can't express them). Validation in G5 must reject those combinations.
- Firefox support is out of scope for this pass.

---

## G1 — Shared modules + tests

**Files to open:** `src/utils.js`, `src/index.js`, `tests/utils.test.js`, `tests/dynamic.test.js`. **Create:** `src/placeholders.js`, `src/matcher.js`, `src/patch.js`, `tests/matcher.test.js`, `tests/patch.test.js`.
**Do not open:** anything else.

- [x] **G1.1** Create `src/placeholders.js` (UMD per §1.3, global `SpliceTapPlaceholders`). Port `processDynamicResponse` from `src/utils.js:378` as the canonical version. Must support ALL of: `{{timestamp}}`, `{{timestamp_ms}}`, `{{date}}`, `{{time}}`, `{{guid}}`, `{{randomInt}}`, `{{randomInt:max}}`, `{{randomFloat}}`, `{{randomString}}`, `{{randomString:len}}`, `{{randomEmail}}`, `{{randomBool}}`, `{{request.url}}`, `{{request.method}}`. Behavior: accepts object or string body; returns same shape (object in → object out via JSON round-trip, string in → string out).
- [x] **G1.2** Create `src/matcher.js` (UMD, global `SpliceTapMatcher`) with:
  - `matchUrl(url, pattern)` — port from `content/injected.js:77` (wildcard → full-match regex, `/re/` → regex test, else substring; `'*'` matches everything). NOTE: port the injected.js version, not the utils.js version, and ALSO handle the `/regex/` case which injected.js currently lacks — final behavior: `*`-wildcard full match, `/.../` regex, else substring, all case-insensitive.
  - `matchHeaders(requestHeaders, ruleHeaders)` — per §1.1: all rule entries must match; header name compare case-insensitive; value compare = substring. Empty/absent ruleHeaders → true.
  - `matchGraphQL(bodyText, graphqlMatch)` — parse bodyText as JSON, compare `parsed.operationName === graphqlMatch.operationName`; on parse failure fall back to regex `"operationName"\s*:\s*"<name>"`. Absent graphqlMatch → true.
  - `findMatchingRule(rules, { url, method, headers, bodyText })` — first enabled rule (array order) whose type is one of `mock|block|delay|redirect` and whose url+method+headers+graphql all match. Method `'*'` matches any.
- [x] **G1.3** Create `src/patch.js` (UMD, global `SpliceTapPatch`) with `jsonMergePatch(original, patch)` — RFC 7386: if patch is not an object or is an array → return patch; else copy original (object or `{}`), for each key: `null` deletes, object recurses, else replaces.
- [x] **G1.4** Rewrite `src/utils.js`: DELETE its `processDynamicResponse` and `matchUrl` bodies; keep the methods as thin delegates to the globals (utils.js is loaded after the UMD files in every context that uses it — in Jest via `src/index.js`, in pages via script order). Keep everything else (validation, export/import, templates) unchanged. Keep the ESM `export` AND window global as-is.
- [x] **G1.5** Fix `src/index.js` so `npm test` runs: `require('./utils')` fails because utils.js is ESM. Change `src/index.js` to require the three UMD modules directly and re-export `{ SpliceTapPlaceholders, SpliceTapMatcher, SpliceTapPatch }`. Then update `tests/utils.test.js` / `tests/dynamic.test.js` to import what they need from the UMD modules instead of `SpliceTapUtils` where the tested logic moved (placeholder tests → `SpliceTapPlaceholders.processDynamicResponse`). If a test targets utils-only logic that can't load under CommonJS, port that logic's test to target the UMD module or delete the test with a comment.
- [x] **G1.6** Write `tests/matcher.test.js`: wildcard/regex/substring/`'*'` URL cases; method wildcard; header match (case-insensitive name, substring value, multi-header AND); graphql operationName hit/miss/malformed JSON; `findMatchingRule` precedence (first match wins) and that disabled rules and DNR-type rules are skipped.
- [x] **G1.7** Write `tests/patch.test.js`: nested merge, null-deletes-key, array replaces, scalar replaces, patching into missing branch creates it.
- [x] **G1.8** Run `npx jest` — ALL tests must pass. Fix failures before moving on.

**Acceptance:** `npx jest` green; `src/utils.js` contains no duplicated matcher/placeholder logic.

---

## G2 — Interceptor rewrite

**Files to open:** `content/injected.js` only. (Globals `SpliceTapPlaceholders` / `SpliceTapMatcher` / `SpliceTapPatch` will exist at runtime after G3 — code against them now.)

- [x] **G2.1** Delete local `processDynamicContent` and `matchUrl`; use `window.SpliceTapPlaceholders.processDynamicResponse(body, { url, method })` and `window.SpliceTapMatcher.*`. Guard at top: if the globals are missing, log an error once and leave fetch/XHR unpatched.
- [x] **G2.2** Add helper `logInterception(rule, url, method, status)` implementing §1.5 step 1. Replace the existing `incrementStats()` calls with it (delete `incrementStats`).
- [x] **G2.3 Fetch path** — restructure `window.fetch` patch:
  1. If inactive → passthrough. Chaos check unchanged.
  2. Compute `url`, `method`. Read request headers into a plain lowercase-keyed object (from `config.headers` — plain object, `Headers`, or entries array — or from the `Request` object).
  3. Body text: only if some enabled rule has `match.graphql` AND its url+method match — then `bodyText = typeof config?.body === 'string' ? config.body : (resource instanceof Request ? await resource.clone().text() : null)`. Otherwise skip body reading entirely (perf).
  4. `const rule = SpliceTapMatcher.findMatchingRule(tmState.rules, { url, method, headers, bodyText })`. No rule → passthrough.
  5. By `rule.type`:
     - `block` → `logInterception(...)`, return `Promise.reject(new TypeError('Failed to fetch'))`.
     - `delay` → log, `await sleep(rule.delayMs)`, passthrough to `originalFetch`.
     - `redirect` → compute destination: if `rule.match.url` is `/regex/`, `newUrl = url.replace(new RegExp(body-of-regex, 'i'), rule.redirect.destination)` (enables `$1`), else `newUrl = rule.redirect.destination`. Log. `originalFetch(resource instanceof Request ? new Request(newUrl, resource) : newUrl, config)`.
     - `mock` + `mode !== 'patch'` → existing static behavior (delay, placeholders, `new Response`) PLUS headers `x-splicetap: true`, `x-splicetap-rule: <rule.name>`. Log.
     - `mock` + `mode === 'patch'` → `const real = await originalFetch(...args)`; try `const data = await real.clone().json()` — on failure return `real` unmodified (debug-log). Else `merged = SpliceTapPatch.jsonMergePatch(data, SpliceTapPlaceholders.processDynamicResponse(rule.response.patch, {url, method}))`; apply `rule.response.delay` if set; return `new Response(JSON.stringify(merged), { status: real.status, statusText: real.statusText, headers: copy-of-real-headers + x-splicetap headers })`. Log.
- [x] **G2.4 XHR path** — MOVE all rule matching from `open()` into `send(body)` (headers and body are only known there):
  - In `open()`: only record `requestMethod` / `requestUrl`; for `redirect`-type rules, matching must still happen here to rewrite the URL passed to `originalOpen` — do a redirect-only pre-match in `open()` (url+method only; a redirect rule with `match.headers`/`graphql` is invalid — G5 enforces).
  - Override `setRequestHeader` to RECORD `{ name: value }` into a local map AND always call through (headers must reach the network for the passthrough case).
  - In `send(body)`: chaos check (move from open), then `findMatchingRule` with recorded headers + `bodyText = typeof body === 'string' ? body : null`. Apply per type: `block` → existing chaos-style error path + log; `delay` → `setTimeout(() => originalSend.call(this, body), delayMs)` + log; `mock` static → existing defineProperty/event flow + log (keep the existing abort/timeout/progress handling intact); `mock` patch → `originalFetch(requestUrl, { method: requestMethod, body: body ?? undefined, credentials: 'include' })`, json-parse, merge-patch, then run the SAME defineProperty/event flow with the merged body and the real status; on any failure fall back to `originalSend` (debug-log).
- [x] **G2.5** Keep the existing state-sync `message` listener, double-injection guard, chaos mode, and prototype preservation untouched.

**Acceptance:** file has zero local copies of matcher/placeholder logic; every applied rule emits exactly one `logInterception` postMessage; static-mock behavior is byte-identical to before except the two new `x-splicetap-*` headers.

---

## G3 — Manifest + content-script relay

**Files to open:** `manifest.json`, `content/content.js`, `scripts/validate-manifest.js`.

- [x] **G3.1** `manifest.json` content_scripts — replace the single entry with two, order matters:
  ```json
  [
    { "matches": ["<all_urls>"], "js": ["src/placeholders.js", "src/matcher.js", "src/patch.js", "content/injected.js"],
      "run_at": "document_start", "all_frames": true, "world": "MAIN" },
    { "matches": ["<all_urls>"], "js": ["content/content.js"],
      "run_at": "document_start", "all_frames": true }
  ]
  ```
- [x] **G3.2** `manifest.json`: add `"declarativeNetRequest"` to `permissions`. Remove the `web_accessible_resources` block entirely (injected.js is no longer fetched via URL). Bump `"version"` to `1.1.0`.
- [x] **G3.3** `content/content.js`: DELETE `injectInterceptor`, `attemptInjection`, and the injection retry constants — the interceptor is now declarative. `initialize()` becomes: setup listeners → `requestInitialState()`, and must run IMMEDIATELY (drop the DOMContentLoaded wait; document_start is the point).
- [x] **G3.4** `content/content.js`: extend the window-message listener (`setupStatsListener` — rename to `setupPageMessageListener`) to also forward `type === 'logInterception'` messages per §1.5-2. Keep forwarding legacy `updateStats` if received.
- [x] **G3.5** `scripts/validate-manifest.js`: read it; if it asserts on content_scripts shape, permissions, or web_accessible_resources, update the assertions to the new manifest. Run `node scripts/validate-manifest.js` — must pass.

**Acceptance:** `node scripts/validate-manifest.js` passes; content.js contains no script-tag injection code.

---

## G4 — Background: DNR sync, log buffer, migration, context menu

**Files to open:** `service_worker/background.js`, `src/storage.js`. **Create:** `service_worker/dnr.js`, `tests/dnr.test.js`.

- [x] **G4.1** Create `service_worker/dnr.js` with a PURE function + a side-effecting sync:
  - `export function ruleToDnr(rule)` — pure, testable. Maps one v2 rule of type `headers`/`queryparams` to a DNR dynamic-rule object `{ id: rule.dnrRuleId, priority: 1, condition, action }`.
    - condition: url pattern → wildcard/substring patterns use `urlFilter` (substring patterns as-is — DNR urlFilter is substring by default; wildcard patterns as-is — DNR supports `*`), `/regex/` → `regexFilter` (strip the slashes). Method (if not `'*'`) → `requestMethods: [method.toLowerCase()]`.
    - `headers` action: `{ type: 'modifyHeaders', requestHeaders: [...], responseHeaders: [...] }` mapping `op:'set'` → `{ header: name, operation: 'set', value }`, `op:'remove'` → `{ header: name, operation: 'remove' }`. Omit empty arrays.
    - `queryparams` action: `{ type: 'redirect', redirect: { transform: { queryTransform: { addOrReplaceParams: add, removeParams: remove } } } }`.
  - `export async function syncDnrRules(rules, isActive)` — computes desired set = enabled `headers`/`queryparams` rules when `isActive`, else empty. Fetches current via `chrome.declarativeNetRequest.getDynamicRules()`, then one `updateDynamicRules({ removeRuleIds: allCurrentIds, addRules: desired })` call (full replace — simple and idempotent). Wrap in try/catch, log errors.
  - Make the file dual-loadable for Jest: after the `export`s, add the same `module.exports` guard as §1.3 (a file can have both when Jest requires it — if Jest chokes on `export` syntax here, instead write it UMD-only and import it in background.js via a side-effect `import './dnr.js'` + `globalThis.SpliceTapDnr`; pick whichever makes `npx jest` pass and note the choice in a one-line comment).
- [x] **G4.2** `src/storage.js`: add `normalizeRule(rule)` — sets `type: 'mock'` if absent, `response.mode: 'static'` if type mock and mode absent. Apply it in `getRules()` and `loadAll()` (map over rules). Add `allocateDnrId()` — reads/increments an integer counter under a new storage key `spliceTapDnrCounter` (start at 1), returns the new value.
- [x] **G4.3** `service_worker/background.js`: import dnr.js. Call `syncDnrRules(this.rules, this.isActive)` after every point where `this.rules` or `this.isActive` changes (`loadStoredData`, `saveRule`, `toggleRule`, `deleteRule`, `clearRules`, `toggleExtension`). In the `saveRule` handler: if the incoming rule is type `headers`/`queryparams` and has no `dnrRuleId`, assign one via `storage.allocateDnrId()` before saving.
- [x] **G4.4** `service_worker/background.js`: interception log per §1.5-3 — `this.interceptionLog = []`, cap 200 (drop oldest). Handle `logInterception` (push entry + increment `this.stats.intercepted` with the existing daily-reset logic — extract that logic from the `updateStats` case into a private method both cases call), `getInterceptionLog`, `clearInterceptionLog`.
- [x] **G4.5** `service_worker/background.js` context menu: change `contexts` to `["action", "page"]`. On click: `chrome.runtime.openOptionsPage()` then store the active tab's host pattern so options can prefill — implementation: write `{ spliceTapPrefill: { url: '*<host>*', ts: Date.now() } }` to `chrome.storage.local` before opening (options.js consumes it in G5; use `new URL(tab.url).host`, guard non-http tabs).
- [x] **G4.6** `tests/dnr.test.js` for `ruleToDnr`: headers set+remove mapping, queryparams mapping, wildcard→urlFilter, regex→regexFilter, method mapping, `'*'` method omits requestMethods.
- [x] **G4.7** Run `npx jest` — green.

**Acceptance:** tests green; every rules/active mutation path calls `syncDnrRules`.

---

## G5 — Options page: rule-type editor

**Files to open:** `options/options.html`, `options/options.js`, `options/options.css`.

- [x] **G5.1** `options.html` rule editor modal (`#ruleEditorModal`, starts line ~273): add at the top of the form a **Rule Type** `<select id="ruleType">` with options: Mock Response (`mock`), Block (`block`), Delay (`delay`), Redirect (`redirect`), Modify Headers (`headers`), Query Params (`queryparams`). Wrap the type-specific fields in container divs with `data-rule-types="mock"` etc. (space-separated list of types the group is visible for):
  - visible for all types: name, enabled, method, URL pattern.
  - `mock` only: existing status/delay/headers/body fields, PLUS new `<select id="responseMode">` (static/patch) and `<textarea id="rulePatch">` (shown only when mode=patch; hide body/status when patch — patch mode keeps original status), PLUS `<input id="graphqlOperation">` (optional operationName) and `<textarea id="matchHeaders">` (optional request-header match, JSON object).
  - `delay` only: `<input type="number" id="delayMs">`.
  - `redirect` only: `<input id="redirectDestination">` with a hint about `$1` for regex patterns.
  - `headers` only: `<textarea id="headersModRequest">` and `<textarea id="headersModResponse">` — each a JSON array of `{op, name, value}`; placeholder examples in the textarea.
  - `queryparams` only: `<textarea id="queryParamsAdd">` (JSON array of `{key, value}`) and `<input id="queryParamsRemove">` (comma-separated keys).
- [x] **G5.2** `options.js`: on `#ruleType` change, toggle visibility of `[data-rule-types]` groups (`el.dataset.ruleTypes.split(' ').includes(type)`). Update the rule save path to build the v2 schema per §1.1 from the visible fields, and the rule load path (edit) to populate them. Preserve `dnrRuleId` on edit (hidden field or carry-over from the loaded rule object).
- [x] **G5.3** `options.js` validation on save, per type: `mock`+graphql requires method POST or `'*'`; `redirect` requires non-empty destination and NO `match.headers`/`graphql`; `headers` requires at least one op and NO `match.headers`/`graphql` (per §1.7); `queryparams` same restriction; `delay` requires `delayMs` 1–30000; JSON textareas must parse (reuse the existing inline-error style of the form).
- [x] **G5.4** `options.js` prefill: on load, read `spliceTapPrefill` from `chrome.storage.local`; if present and `ts` within last 30 s, open the rule editor with URL pattern prefilled and type `mock`, then remove the key.
- [x] **G5.5** Templates (`insertTemplate` at options.js:951 + wherever templates render): add presets — "GraphQL Mock" (type mock, method POST, url `*/graphql*`, graphql.operationName placeholder), "Patch Response" (mode patch, patch `{"data": null}` example), "Block Request", "Redirect to localhost" (destination `http://localhost:3000$1`, regex hint), "CORS Unblock" (type headers, response ops: set `Access-Control-Allow-Origin: *`, set `Access-Control-Allow-Headers: *`), "Custom User-Agent" (type headers, request op: set `User-Agent`).
- [x] **G5.6** Rules list rendering in options (if it lists rules) — show a small type badge per rule. Add minimal badge CSS in options.css (one class per type is overkill — one `.rule-type-badge` class + text content is enough).

**Acceptance:** every rule type can be created, saved, re-opened for edit, and round-trips its fields exactly; invalid combos from G5.3 are rejected with a visible message.

---

## G6 — Popup

**Files to open:** `popup/popup.js`, `popup/popup.html`, `popup/popup.css`.

- [x] **G6.1** Rule row rendering: add the same type badge (reuse class name from G5.6, copy the small CSS block into popup.css).
- [x] **G6.2** "Test" action (popup.js case `'test'`): unchanged for `mock`; for other types it should still run background `testRule` validation — just ensure it doesn't crash on rules without `response` (guard in display code).
- [x] **G6.3** "New Rule" from popup opens the options page rule editor (existing behavior) — verify it still works with the modal changes; fix selectors if broken.

**Acceptance:** popup renders v1 rules (no `type`) and all v2 types without errors.

---

## G7 — DevTools: live interception log

**Files to open:** `devtools/devtools.js`, `devtools/panel.html`. **Create:** `devtools/panel.js`.

- [x] **G7.1** `devtools/devtools.js`: DELETE the `onRequestFinished` x-splicetap detection and the `onNavigated` listener (dead code per §1.5) — keep only panel creation.
- [x] **G7.2** Create `devtools/panel.js`; reference it from `panel.html` with `<script src="panel.js"></script>` (no inline JS — MV3 CSP). Implement: on load and every 2 s, `chrome.runtime.sendMessage({ type: 'getInterceptionLog' })`; render entries into the existing `.requests-list` markup (method badge — the CSS classes `method-get` etc. already exist — url, rule name, type, status, relative time); newest first; update the existing stat cards (total intercepted from `getRules` stats + entry count). Wire the existing `.clear-btn` to `clearInterceptionLog` + re-render.
- [x] **G7.3** `panel.html`: keep existing markup/CSS; only add the script tag, ids the panel.js needs, and an empty-state row ("No intercepted requests yet — trigger a mocked call").

**Acceptance:** with a mock rule active, triggering a fetch on any page shows a row in the panel within 2 s; Clear empties it.

---

## G8 — Docs + final verification

**Files to open:** `README.md`, `changes.txt`.

- [x] **G8.1** README: fix the architecture section — interception is MAIN-world fetch/XHR patching for mock/block/delay/redirect and declarativeNetRequest for headers/queryparams (the current DNR claim is false for mocking). Document: all rule types with their schema fields, the full placeholder list (G1.1), GraphQL matching, patch mode semantics (RFC 7386, `null` deletes), rule precedence (first match wins), the §1.7 limitations, and the DevTools log panel.
- [x] **G8.2** Append a dated section to `changes.txt` summarizing this implementation (one line per group).
- [x] **G8.3** Final gate — run and confirm ALL of: `npx jest` (green), `node scripts/validate-manifest.js` (pass). Then manual smoke test list (perform what's automatable, otherwise leave as a checklist for the user at the bottom of changes.txt): load unpacked → create one rule of each type via options → static mock returns mock body with `x-splicetap` header → patch mode alters one field of a real API → block makes fetch reject → delay visibly delays → redirect lands on destination → headers rule visible in DevTools Network on a real request → queryparams rule adds the param → DevTools SpliceTap panel logs entries → popup toggles still work → import of a v1 rules JSON still loads (migration).

**Acceptance:** both commands green; README contains no claims the code doesn't implement.

---

## Execution notes for the implementer

- Groups are dependency-ordered: G1 (shared modules) → G2 (interceptor) → G3 (loading) → G4 (background) → G5/G6/G7 (UIs, any order) → G8.
- Commit per group with message `feat(G<n>): <summary>` so progress is resumable.
- If something in this spec contradicts the code you find, the SPEC wins unless it's factually impossible — in that case stop and report the conflict instead of improvising.
- Do not rename existing functions/messages beyond what's listed; other files reference them.
