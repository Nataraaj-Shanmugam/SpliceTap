# Performance Audit — TurboMock

_Reviewer lens: hot-path cost, memory, IPC. Method: static trace of 6 paths — (1) `fetch` with no matching rule, (2) `fetch` with a matching static mock, (3) `XMLHttpRequest` construct → `open` → `send` passthrough, (4) rule-mutation fan-out (`broadcastState` + `syncDnrRules`), (5) MV3 service-worker cold start, (6) page load / script injection. Branch: `V1`. No code was executed; all timing figures are labelled estimates with their reasoning shown._

Severity here means **performance impact**, not functional breakage: Critical/High = cost paid on every request or every page load; Medium = cost paid per page or per mutation; Low/Nit = bounded or rare.

---

## Summary

- **There is no early-out for the zero-rule case.** `injected.js:119-165` runs the full preamble — args array, async-function promise, header object, header enumeration, a `.some()` closure, a request-descriptor object literal — before it can discover there are no rules. Every `fetch()` on every page the user visits pays ~4 heap allocations and ~2 extra microtask turns *even with the rule list empty*. This is the single most broadly-felt cost in the extension because it applies to users who have configured nothing. (**P-1**, **P-2**, **P-3**)
- **`matchUrl` rebuilds two intermediate strings and a `RegExp` object per rule, per request** (`matcher.js:26-33`), with no compiled-pattern cache. The scan is linear over the whole rule list (`matcher.js:96-111`). Estimated ~0.5–2 µs per rule → **~25–100 µs/request at 50 rules, ~0.25–1 ms/request at 500 rules**. A pattern→RegExp `Map` cache removes essentially all of it. (**P-4**)
- **Every service-worker cold start broadcasts the full rule set to every tab and does a full-replace `updateDynamicRules`** (`background.js:50, 77-78`). In MV3 the SW dies after ~30 s idle and is re-woken by every page load's `getRules` (once *per frame*) and by every `logInterception`. So ordinary browsing repeatedly triggers an all-tabs fan-out plus a DNR rewrite that nothing asked for. (**P-5**, **P-11**)
- **`broadcastState` ships the entire rule array — including every mock response body — to every tab on every mutation** (`background.js:363-380`), and every unreachable tab (chrome://, Web Store, discarded) costs 3 more sends plus 3 SW timers (`background.js:391-407`). Cost scales `O(tabs × total rule bytes)`. (**P-6**)
- **The placeholder engine does 14 unconditional regex passes plus a stringify→parse→stringify round-trip on every mocked response**, even when the body contains no `{{` at all (`placeholders.js:15-85` + `injected.js:233-234`). A 3-line `indexOf('{{')` guard plus returning the string skips all of it. (**P-7**)
- **Memory: the full rule set is retained in the MAIN world of every frame** (`all_frames: true`, `manifest.json:19-32`; `injected.js:604`). Mock response bodies are the bulk of rule size, so an ad-heavy page with 20 iframes retains 20 copies of every mock payload. (**P-8**)

---

## Hot path analysis

### Path A — `fetch(url)` that matches **no** rule (the overwhelmingly common case)

Traced line by line through `content/injected.js:119-165`:

| # | Line | Work | Allocs | Scales with |
|---|---|---|---|---|
| 1 | `119` | `async function (...args)` — rest-parameter array materialised; async-function promise created | 2 | every call |
| 2 | `120` | `tmState.active` check — the only guard; **does not check `rules.length`** | 0 | — |
| 3 | `123` | `resource instanceof Request` | 0 | — |
| 4 | `124` | `(...).toUpperCase()` on method (V8 returns receiver unchanged if already uppercase) | 0–1 | — |
| 5 | `127` | `tmState.settings?.chaosMode?.enabled` — two optional-chain loads | 0 | — |
| 6 | `135` | `const headers = {}` — **allocated unconditionally** | 1 | every call |
| 7 | `136-140` | `collectHeadersInto` — full enumeration of request headers, `String(k).toLowerCase()` per header | 0 or H | # request headers |
| 8 | `145-150` | `tmState.rules.some(cb)` — closure allocated per call; predicate short-circuits on `!r.match.graphql` | 1 | N rules (cheap iters) |
| 9 | `162` | `{ url, method, headers, bodyText }` object literal | 1 | every call |
| 10 | `matcher.js:94` | destructure of that literal | 0 | — |
| 11 | `matcher.js:96-111` | linear scan; per surviving rule → `matchUrl` (see below) | 4N strings + N RegExp | **N rules** |
| 12 | `164` | `originalFetch.apply(this, args)` | 1 promise | — |
| 13 | — | async fn resolves its promise *with* a promise → `PromiseResolveThenableJob` + reaction ≈ **2 extra microtask turns** before the caller's `.then` runs | 2 jobs | every call |

**Fixed floor with 0 rules: ~4 heap allocations + ~2 extra microtask turns + 1 unnecessary object, per `fetch()`.** With `fetch(url, {headers})` add one `toLowerCase()` string per header.

### `matchUrl` per-rule cost (`src/matcher.js:21-42`)

Three branches, chosen per call, never cached:

| Pattern form | Per rule, per request |
|---|---|
| contains `*` (e.g. `*/api/users/*`, the shape the UI suggests at `overlay.js:213`) | `.includes('*')` scan; `.replace(/[.*+?^${}()\|[\]\\]/g, …)` → **1 string alloc + 1 regex scan of the pattern**; `.replace(/\\\*/g,'.*')` → **1 string alloc + 1 regex scan**; `'^' + p + '$'` → **1–2 string allocs**; `new RegExp(...)` → **1 JSRegExp alloc**; `.test(url)` → 1 regex execution over the URL |
| `/…/` regex | `.slice(1,-1)` → 1 string alloc; `new RegExp` → 1 alloc; `.test(url)` |
| plain substring | `url.toLowerCase()` → **a full copy of the URL string** + `pattern.toLowerCase()` → 1 copy, then `.includes` |

≈ **4 string allocations + 1 RegExp object + 3 regex executions per rule per request** in the wildcard branch.

Rule-count scaling (**estimate**, reasoning shown — no benchmark was run):

| Enabled rules whose method matches | RegExp objects/request | String allocs/request | Estimated added latency/request |
|---|---|---|---|
| 0 | 0 | 0 | ~0 (but the P-1 fixed floor still applies) |
| 5 | 5 | ~20 | ~3–10 µs |
| 50 | 50 | ~200 | ~25–100 µs |
| 500 | 500 | ~2 000 | ~0.25–1 ms |

Reasoning: two `String.prototype.replace` calls with a global RegExp over a short pattern plus a `JSRegExp` allocation is conservatively 0.5–2 µs on modern V8 desktop hardware. **Caveat:** V8 keeps a `CompilationCache` for `new RegExp(source, flags)`, so the pattern is usually not re-*parsed* on repeat calls — the recurring cost is the two `replace` calls, the string garbage, and the JSRegExp object, not full recompilation. The GC pressure (2 000 short-lived strings/request at 500 rules) is the more certain harm. On a SPA firing 200 requests during load with 50 rules, that is ~40 000 transient strings and 10 000 RegExp objects for a single page load.

### Path B — `fetch` that matches a static mock (`injected.js:227-247`)

`processDynamicResponse(rule.response.body, …)` → `JSON.stringify(body)` → **14 sequential `String.replace` passes** over the whole serialised body → `JSON.parse` back to an object (`placeholders.js:75-82`) → then `injected.js:234` **stringifies it again**. Net: **2 × stringify + 1 × parse + 14 full-string scans** per mocked response. Estimated ~1–3 ms for a 100 KB body, ~10–30 ms for a 1 MB body (**estimate**: 14 × B character scans plus three full JSON traversals of B).

### Path C — `new XMLHttpRequest()` (`injected.js:253-586`)

Per *construction*, before any request is made and regardless of rule count: 1 real XHR, a 7-binding closure scope, 4 reads of the original prototype methods, and **6 function objects** (`finishMock`, `runStaticMockFlow`, and the 4 overrides), each assigned as an **own property on the instance** (`391`, `426`, `453`, `580`) — which shadows the prototype and pushes the object off the fast shape shared by native XHRs. Then `open()` runs a second full rule scan (`404-410`) and `send()` runs a third (`485`). A passthrough XHR therefore scans the rule list **twice**.

### Path D — service-worker cold start

`new TurboMockBackground()` (`background.js:496`) → constructor calls `loadStoredData()` (`background.js:50`) → `chrome.storage.local.get` of 8 keys + `chrome.storage.session.get` → **`await this.broadcastState()`** (all tabs, full rule set) → **`await syncDnrRules(...)`** (`dnr.js:130-136`: `getDynamicRules` + full-replace `updateDynamicRules`). This entire sequence runs on *every* wake, and wakes are frequent (see P-5).

---

## Findings

### [High] P-1: No zero-rule / no-match early-out in the fetch hot path

- **Where:** `content/injected.js:119-165` (guard is only `if (!tmState.active)` at `:120`)
- **Cost:** Per `fetch()`, unconditionally: rest-args array, async-function promise, `headers = {}` object (`:135`), a `.some()` closure (`:145`), and a request-descriptor object literal (`:162`) — ~4 heap allocations — before `findMatchingRule` can report "nothing matched". Runs in every frame of every page (`manifest.json:21-25`, `all_frames: true`).
- **User impact:** A user who installs TurboMock and configures **zero rules** still pays this on 100 % of the browser's `fetch` traffic, including third-party iframes they never see. This is the cost most likely to show up as "the browser feels slower with this extension installed".
- **Recommended fix:** Add a first-line bail before any allocation:
  ```js
  if (!tmState.active || tmState.rules.length === 0) return originalFetch.apply(this, args);
  ```
  Better: maintain a derived `tmState._interceptorRules` (enabled ∧ type ∈ mock/block/delay/redirect) recomputed once in the `syncState` handler at `:603-605`, and bail when it is empty. Expected saving: the entire fixed floor for zero-rule users, and the `.some()`/scan cost for users whose rules are all DNR-backed or disabled.
- **Confidence:** High (code path read directly).

### [High] P-2: `fetch` wrapper is `async`, adding promise adoption to every request

- **Where:** `content/injected.js:119` (`window.fetch = async function (...args)`), passthrough return at `:164`
- **Cost:** Returning a promise *from* an async function resolves the outer promise via `PromiseResolveThenableJob`, costing roughly **2 extra microtask turns** plus one extra promise object per call, versus calling `originalFetch` directly. Also forces a rest-parameter array allocation on a function invoked as often as `fetch` itself.
- **User impact:** Every response on every page is delivered ~2 microtask turns later than native. Individually tiny; multiplied by hundreds of requests per page load it adds measurable scheduling jitter and allocation churn, and it applies with zero rules configured.
- **Recommended fix:** Split into a synchronous outer wrapper that returns `originalFetch.apply(this, args)` directly on the passthrough path, delegating to an `async` inner function only when a rule actually matches or the GraphQL body read is required:
  ```js
  window.fetch = function (...args) {
      if (!tmState.active || tmState.rules.length === 0) return originalFetch.apply(this, args);
      // ...cheap sync pre-checks; if no candidate, return originalFetch.apply(this, args)
      return handleIntercepted.apply(this, args); // the async path
  };
  ```
  Expected saving: 1 promise + 2 microtask turns + 1 array on every passthrough request.
- **Confidence:** High for the mechanism; the per-call wall-clock saving is sub-microsecond, so the win is allocation/scheduling pressure at volume rather than visible latency.

### [High] P-3: Request headers are collected on every fetch before any rule is consulted

- **Where:** `content/injected.js:134-140`, helper at `:102-115`
- **Cost:** `headers = {}` is allocated on every call, and `collectHeadersInto` fully enumerates the request's headers, calling `String(key).toLowerCase()` per header (`:105`, `:109`, `:113`) — one new string per header per request. A typical authenticated XHR carries 6–12 headers. This work is *only* ever consumed by `matchHeaders`, which returns `true` immediately when the rule has no header conditions (`matcher.js:50`) — i.e. for the vast majority of rules the collected object is discarded unread.
- **User impact:** ~6–12 wasted string allocations per request on API-heavy pages, paid whether or not any rule uses header matching, and paid with zero rules configured.
- **Recommended fix:** Compute a `_anyRuleUsesHeaders` boolean once in the `syncState` handler (`:593-615`) and gate the whole block:
  ```js
  const headers = tmState._anyRuleUsesHeaders ? collectHeaders(config, resource) : EMPTY_HEADERS; // frozen shared {}
  ```
  Expected saving: one object + H strings per request for essentially all users (header-match rules are a niche feature).
- **Confidence:** High.

### [High] P-4: `matchUrl` builds pattern strings and a `RegExp` on every call, for every rule, on every request

- **Where:** `src/matcher.js:21-42` (`:26-29` wildcard branch, `:32-33` regex branch, `:36` substring branch); driven by the linear scan at `src/matcher.js:96-111`; also called a second time per XHR from `injected.js:407`
- **Cost:** See the per-rule table above — ~4 string allocations + 1 RegExp object + 3 regex executions per rule per request in the wildcard branch. The substring branch allocates a **full lowercase copy of the request URL per rule** (`:36`), which for 500 rules and a 300-char URL is ~150 KB of transient string garbage per request. Scaling: **N rules × 1 pattern compile per request** — see the estimate table (~25–100 µs at N=50, ~0.25–1 ms at N=500).
- **User impact:** Directly proportional to how many rules the user keeps. Power users with large imported rule sets pay a per-request tax on *all* browsing, not just on the API they are mocking, because the scan runs before any origin filtering.
- **Recommended fix:** Two independent changes, both small:
  1. **Compiled-pattern cache.** A module-level `Map<string, {kind, regex, lowerPattern}>` keyed by the raw pattern string, populated on first use. Turns the per-rule cost into one `Map.get` + one `regex.test`. Cap it (e.g. 500 entries, or clear it in the `syncState` handler when rules change) so it cannot grow unbounded from dynamically-generated patterns.
  2. **Hoist `url.toLowerCase()`** out of the loop — compute it once per request in `findMatchingRule` and pass it down, instead of once per rule at `matcher.js:36`.
  Expected saving: ~90 % of the URL-matching cost; converts the scan from ~0.5–2 µs/rule to ~50–100 ns/rule (**estimate**).
- **Confidence:** High that the work is repeated per call; Medium on the absolute µs figures (marked as estimates; V8's RegExp `CompilationCache` absorbs the parse cost but not the string/object allocations).

### [High] P-5: Every service-worker cold start broadcasts to all tabs and full-replaces the DNR ruleset

- **Where:** `service_worker/background.js:50` (constructor → `loadStoredData()`), `:77-78` (`await this.broadcastState(); await syncDnrRules(...)`), `service_worker/dnr.js:130-136`
- **Cost:** Per SW wake: 8-key `chrome.storage.local.get` + `chrome.storage.session.get` + `chrome.tabs.query({})` + one `chrome.tabs.sendMessage` carrying the **full rule set** to **every open tab** + `getDynamicRules()` + `updateDynamicRules({removeRuleIds: [...all], addRules: [...all]})`. MV3 terminates the SW after ~30 s idle, and it is re-woken by: every frame's `getRules` at `document_start` (`content/content.js:170`), every `logInterception` (`content/content.js:123`), every DevTools poll (`devtools/panel.js:206`), popup/options opens, and context-menu clicks.
- **User impact:** During normal browsing the SW wakes constantly. Each wake re-broadcasts unchanged state to every tab and rewrites the DNR ruleset for no reason. With 20 tabs open and a 200 KB rule set, one wake ≈ 4 MB of structured-clone traffic plus a DNR round-trip — and this repeats many times per browsing session. It also lengthens the cold-start critical path, so the first request on a freshly-loaded page waits on `await this.ready` (`background.js:106`) behind a full-tabs broadcast.
- **Recommended fix:** Remove `broadcastState()` and `syncDnrRules()` from `loadStoredData()`. On cold start neither is needed: content scripts pull state themselves via `getRules`, and dynamic DNR rules are persisted by Chrome across SW restarts — they only need syncing when rules actually change. Keep both on the mutation handlers only, plus a one-time `chrome.runtime.onInstalled` / `onStartup` DNR reconcile. Expected saving: eliminates an all-tabs fan-out and a DNR rewrite from every wake, and shortens cold start by two awaited round-trips.
- **Confidence:** High.

### [High] P-6: `broadcastState` fan-out sends the full rule set to every tab, with retry amplification

- **Where:** `service_worker/background.js:363-380`, retry logic `:385-408`; triggered from 7 handlers (`:121, 135, 158, 169, 179, 194, 208`)
- **Cost:** `O(tabs × total rule bytes)` structured clone per mutation. The payload is the *whole* `this.rules` array, including every `response.body` and `response.patch` — the largest part of a rule. There is no diffing, no per-tab filtering by URL, and no dirty check (toggling one rule re-sends all rules). Every tab where `sendMessage` fails — `chrome://`, the Web Store, PDF viewer, discarded/sleeping tabs, and any tab loaded before the extension was installed — triggers **3 retries with 1 s/2 s/3 s SW timers** (`:394-401`), each re-sending the full payload. A user with 8 such tabs incurs 24 extra sends and 24 SW timers per mutation. (Those timers also do not reliably keep an MV3 SW alive, so many retries are silently dropped anyway — wasted setup either way.)
- **User impact:** Editing rules in the options page is the trigger; `options.js:622` calls `setRules` on every rule save, and `options.js:1204` does so again on reorder/bulk ops. With many tabs and a large rule set this produces a visible stall in the options UI and a burst of main-thread work in every tab.
- **Recommended fix:**
  1. Track a `lastBroadcastHash` (or a monotonically increasing `rulesVersion`) and skip the broadcast when nothing changed — a dirty flag.
  2. Send a slim projection: content scripts need `id, name, enabled, type, match, response, delayMs, redirect` — but DNR-only rules (`headers`, `queryparams`) are never matched in the interceptor (`matcher.js:12, 100`) and can be filtered out of the broadcast entirely. Mock bodies could be omitted and fetched lazily on first match.
  3. Drop the retry loop for tabs that structurally cannot receive messages (check `tab.url` against `chrome://`, `chrome-extension://`, `edge://`, `about:`, and `tab.discarded`) before ever calling `sendMessage`.
- **Confidence:** High.

### [High] P-7: Placeholder engine runs 14 regex passes and a redundant JSON round-trip on every mocked response

- **Where:** `src/placeholders.js:15-85`; callers `content/injected.js:233-234` (fetch static), `:324-325` (XHR static), `:205` and `:547` (patch mode)
- **Cost:** Three separate wastes, all per mocked response:
  1. **14 unconditional `String.replace` passes** (`:21, 22, 23, 24, 27, 36, 39, 42, 45, 48, 53, 62, 68, 71`) over the entire serialised body, executed even when the body contains no `{{` token at all — which is the case for the great majority of mock bodies.
  2. **Eager value construction:** `:21`, `:23` and `:24` each call `new Date()` and `:23`/`:24` each allocate a `.split()` array, and `:22` calls `Date.now()` — these are *arguments*, not callbacks, so all five are evaluated on every call regardless of whether the pattern matches anything.
  3. **Redundant serialisation:** an object body is `JSON.stringify`-ed at `:18`, `JSON.parse`-ed back at `:77`, then immediately `JSON.stringify`-ed *again* by the caller at `injected.js:234` / `:325`. Net **2 stringify + 1 parse** where 1 stringify suffices.
- **User impact:** Paid on every request the extension actually mocks — the extension's core function. Estimated ~1–3 ms for a 100 KB body and ~10–30 ms for a 1 MB body (**estimate**: 14 × B character scans + 3 full JSON traversals of B). Large fixture bodies are exactly what people mock, so this is the most likely source of "the mock is slower than the real API".
- **Recommended fix:**
  1. Guard the whole chain: `if (bodyStr.indexOf('{{') === -1) return body;` — for object input this also skips both JSON operations, returning the original object untouched. Expected saving: ~100 % of placeholder cost for bodies without placeholders.
  2. Convert `:21-24` to replacer callbacks so the `Date` objects are only constructed when a token is present.
  3. Add a `processDynamicResponseToString(body, details)` variant that returns the already-serialised string, so `injected.js:234` and `:325` stop parsing and re-stringifying. Expected saving: one full parse + one full stringify per mocked response.
  4. Optional larger win: replace the 14 passes with a single `/{{(\w+)(?::(\d+))?}}|{{request\.(\w+)}}/g` pass and a dispatch table — one scan instead of 14.
- **Confidence:** High.

### [Medium] P-8: Full rule set (including all mock bodies) is retained in the MAIN world of every frame

- **Where:** `manifest.json:19-32` (`all_frames: true` for both the MAIN-world and isolated entries); `content/injected.js:604` (`tmState.rules = ...`); `content/content.js:54-58` (postMessage clone into MAIN world)
- **Cost:** Each frame ends up with a durable MAIN-world copy of the entire rule array, plus a transient isolated-world copy from the `getRules` response. Rules include `response.body` / `response.patch`, which for realistic fixtures dominate size. A page with 20 ad/analytics iframes retains **20 copies** of every mock payload. With a 500 KB rule set that is ~10 MB of resident memory for a single tab, per tab.
- **User impact:** Memory growth proportional to `frames × rule bytes`, concentrated on exactly the pages that already have the most iframes. Also inflates the per-frame `syncState` structured-clone cost at page load.
- **Recommended fix:** (a) Strip `response.body`/`response.patch` from the broadcast payload and resolve them on demand via a `getRuleBody` message when a rule first matches in that frame — matching only needs `match`, `type`, `enabled`. (b) Filter DNR-only rule types out of the broadcast entirely (`matcher.js:12` already ignores them). (c) Consider restricting the MAIN-world content script to `all_frames: false` plus explicit opt-in, or filtering broadcast rules by the frame's origin against each rule's pattern where the pattern is origin-anchored.
- **Confidence:** High for the mechanism; Medium for the MB figures, which depend entirely on the user's rule sizes.

### [Medium] P-9: `overlay.js` (24 KB) is parsed on every top-level page load to register one message listener

- **Where:** `manifest.json:33-38`; `content/overlay.js` — 599 lines / 24 151 bytes, of which a ~4 KB `STYLES` template literal (`:38-175`) and the `markup()` builder (`:177-308`) are materialised or defined at script-eval time
- **Cost:** ~24 KB of script compiled and executed on **every** top-level navigation, purely so that `chrome.runtime.onMessage` at `:586` can respond if the user later opens the in-page rule editor — an action most page loads never see. (V8's code cache amortises re-compilation after the first load of a given script, but the execution, closure creation, and the ~4 KB string allocation happen every time.)
- **User impact:** Adds to the `document_idle` work of every page load, competing with the page's own initialisation.
- **Recommended fix:** Remove the declarative `overlay.js` content-script entry and inject it on demand with `chrome.scripting.executeScript({target:{tabId}, files:['content/overlay.js']})` from the two call sites that actually need it (`background.js:436` context menu, `popup/popup.js:427`). The existing `__TURBOMOCK_OVERLAY_INITIALIZED__` guard at `:18` already makes re-injection idempotent. Expected saving: ~24 KB of parse+exec removed from ~100 % of page loads. This is the largest single startup win available, and it is close to free.
- **Confidence:** High.

### [Medium] P-10: XHR constructor allocates ~10 objects per instance and de-optimises the instance shape

- **Where:** `content/injected.js:253-586`; own-property overrides at `:391`, `:426`, `:453`, `:580`; prototype reassignment at `:589`
- **Cost:** Per `new XMLHttpRequest()`, regardless of rule count: the closure scope for 7 mutable bindings (`:257-264`), 4 reads of the original methods (`:267-270`), and **6 function objects** (`finishMock` `:274`, `runStaticMockFlow` `:323`, plus the 4 overrides). Assigning `open`/`send`/`abort`/`setRequestHeader` as *own* properties shadows the prototype and moves the instance off the shape shared by native XHRs, costing an inline-cache miss at every call site in the page that uses XHR polymorphically. Additionally, a passthrough XHR scans the rule list **twice** — once in `open()` (`:404-410`) and once in `send()` (`:485`).
- **User impact:** XHR-heavy legacy pages (jQuery `$.ajax`, older analytics SDKs, ad tags) construct many XHRs; each now costs ~10 allocations more than native. Applies with zero rules configured.
- **Recommended fix:** (a) Bail to the untouched constructor when there is nothing to do: `if (!tmState.active || tmState.rules.length === 0) return new originalXHR();` as the first statement — this returns a pristine native object with zero added allocations. (b) Define the overrides once on a shared prototype rather than per instance, storing per-request state on a symbol-keyed slot. (c) Skip the `open()` pre-scan entirely unless at least one enabled `redirect` rule exists (precompute a `tmState._hasRedirectRules` flag in the `syncState` handler).
- **Confidence:** High.

### [Medium] P-11: One `getRules` round-trip **per frame** per page load, plus a duplicate broadcast 500 ms later

- **Where:** `content/content.js:170` (`requestInitialState()` at `document_start`, in every frame via `manifest.json:27-32`); duplicate at `service_worker/background.js:472-486`
- **Cost:** A page with 20 iframes sends **20** `chrome.runtime.sendMessage({type:'getRules'})` messages at `document_start`, each of which returns the **full** rule set + stats + settings and is structured-cloned into that frame's isolated world, then postMessage-cloned again into the MAIN world. The first of these also cold-starts the SW (triggering P-5). Then `chrome.tabs.onUpdated` fires at `status === 'complete'` and, 500 ms later, pushes the *same* full state to the tab again (`:482-484`) — so the state is delivered N+1 times per page load. On a failed retry path, `content.js:30/39` schedules another attempt every 2 s indefinitely (no retry cap), which can pin the SW awake on pages where the background is unreachable.
- **User impact:** Page-load-time IPC burst proportional to frame count, on every navigation, with the largest burst on the most iframe-heavy pages.
- **Recommended fix:** (a) Delete the `onUpdated` re-broadcast at `:472-486` — it is redundant with the content script's own pull, and it reads `this.rules` without awaiting `this.ready`, so on a cold start it can even push an empty rule set. (b) Cache the state in `chrome.storage.session` and have content scripts read it directly (no SW wake) with the message as fallback. (c) Cap the `content.js` retry loop (e.g. 5 attempts with backoff) instead of retrying forever.
- **Confidence:** High.

### [Medium] P-12: DevTools panel polls every 2 s, re-renders 200 rows unconditionally, and keeps the SW permanently awake

- **Where:** `devtools/panel.js:18` (`POLL_INTERVAL_MS = 2000`), `:197-206` (two messages per tick), `:159-174` (full `innerHTML` rebuild), `:108` (`.slice().reverse()`)
- **Cost:** Every 2 s: two `chrome.runtime.sendMessage` round-trips; the **entire 200-entry log** structured-cloned back; a `.slice().reverse()` array allocation; a 200-element `.map().join('')`; and a wholesale `innerHTML` assignment that destroys and rebuilds ~1 200 DOM nodes plus forces layout — **even when nothing changed**. Separately, a message every 2 s resets the SW idle timer, so **the service worker never suspends while the panel is open**.
- **User impact:** Continuous CPU/GC in the DevTools window and a permanently-resident service worker (battery cost on laptops) for as long as the panel stays open — including when the user has left it open on a background tab. The DOM rebuild also drops text selection and scroll position every 2 s.
- **Recommended fix:** (a) Have the background push updates (`chrome.runtime.sendMessage` on new entries, coalesced) instead of polling; if polling must stay, send a cheap `logVersion` counter and only fetch entries when it changes. (b) Return only entries newer than a client-supplied cursor, not the whole buffer. (c) Render incrementally — prepend new rows rather than rebuilding `innerHTML`. (d) Pause the timer on `document.visibilityState === 'hidden'`.
- **Confidence:** High.

### [Medium] P-13: A `message` listener in each world means every page `postMessage` is cloned across the world boundary

- **Where:** `content/content.js:112` (isolated world) and `content/injected.js:593` (MAIN world), both `all_frames: true`
- **Cost:** `window.addEventListener('message')` in the isolated world receives *every* message the page posts to itself, and each delivery requires the payload to be structured-cloned from the MAIN world into the isolated world before the `event.data.source !== 'turbomock-injected'` check at `content.js:113` can reject it. Pages that use `postMessage` heavily — ad frames, embedded video players, payment iframes, React DevTools bridges, Google Tag Manager — can post hundreds of messages per second, each now cloned twice (once for the page's own listeners, once for TurboMock's).
- **User impact:** On postMessage-heavy pages this can dominate TurboMock's total cost, and it is entirely unrelated to whether any rule exists.
- **Recommended fix:** Use a dedicated `MessageChannel` established once at injection time (MAIN world creates the channel and hands one port to the isolated world via a single `postMessage`), so subsequent interception logs travel on a private port and no page traffic is observed. Fallback: use a `CustomEvent` on `document` with a namespaced type, which is filtered by the event dispatcher before any cloning. Either eliminates the per-page-message clone entirely.
- **Confidence:** Medium — the clone-before-filter behaviour is the documented model for cross-world `message` events; the magnitude depends heavily on the page.

### [Low] P-14: Throttled persistence still rewrites the whole log array and does a read-modify-write of stats

- **Where:** `service_worker/background.js:274-287`; `src/storage.js:228-246` (`updateStats` = `getStats()` then `set`)
- **Cost:** (The 1 500 ms throttle at `:276` is already in place and is not being re-reported.) What remains: each flush writes the **entire** `interceptionLog` array (up to 200 entries, ~40–60 KB) to `chrome.storage.session`, not a delta, and `updateStats` performs a `chrome.storage.local.get` **followed by** a `set` — so sustained mocking costs ~0.67 × (1 session write of 40–60 KB + 1 local read + 1 local disk write) per second. `chrome.storage.local` is LevelDB-backed, so those are real disk writes.
- **User impact:** Background disk I/O during heavy mocking sessions; contributes to `chrome.storage.session`'s 10 MB budget churn, though the 200-entry cap keeps absolute size safe.
- **Recommended fix:** Keep the stats counter in memory and flush it on a much longer interval (e.g. 30 s) or on `chrome.runtime.onSuspend`; cache `this.stats` in `TurboMockStorage` so `updateStats` skips the read. Consider persisting only the last N *new* entries. Also add a `force`-flush on suspend so the final entries are not lost — `_persistVolatile(true)` already supports it but is never called with `force`.
- **Confidence:** High.

### [Low] P-15: XHR mock progress `setInterval` is created but usually cleared before its first tick

- **Where:** `content/injected.js:340-361`, cleared at `:314-317` / `:371-374` / `:435-438`
- **Cost:** `runStaticMockFlow` always installs a 50 ms `setInterval`, but the response is scheduled at `delay > 10 ? delay : 10` (`:387`) — so for the default `delay: 0` the interval is cleared at 10 ms, before it ever fires. Pure setup/teardown waste per mocked XHR. When it *does* tick (delayed mocks), it allocates **two** `ProgressEvent` objects per tick (`:348` and `:354`) where one would do, and reports fabricated `total: 1000` bytes unrelated to the real body length.
- **User impact:** Negligible except on pages issuing many delayed mocked XHRs. No leak: every exit path clears the interval, and the `timeout` branch (`:364-383`) is bounded by `xhr.timeout`.
- **Recommended fix:** Skip the interval entirely when `delay <= 50`; reuse a single `ProgressEvent` instance per tick; derive `total` from `responseText.length`.
- **Confidence:** High.

### [Low] P-16: Micro-costs inside the per-rule loop

- **Where:** `src/matcher.js:100` (`INTERCEPTOR_TYPES.indexOf(type)`), `src/matcher.js:103` (`.toUpperCase()` per rule per request), `content/injected.js:145-150` vs `:162`
- **Cost:** `indexOf` is a linear scan of a 4-element array executed **per rule per request**; `(match.method || '*').toUpperCase()` allocates a string per rule per request when the stored method is not already uppercase. Separately, a rule with a `graphql` condition has `matchUrl` invoked **twice** per fetch — once in the `needsBody` probe (`injected.js:149`) and again in `findMatchingRule` (`matcher.js:106`).
- **User impact:** Small, but it multiplies by the same N as P-4.
- **Recommended fix:** Replace `INTERCEPTOR_TYPES` with a `Set` (or a plain object lookup) and hoist it out of the loop; normalise `type` and `match.method` to uppercase **once**, in `storage.normalizeRule` (`storage.js:117-130`), so no per-request casing is needed. Have the `needsBody` probe record the matching rule and reuse it instead of re-matching.
- **Confidence:** High.

### [Low] P-17: Quota check on the rule-save path can read the entire storage area

- **Where:** `src/storage.js:284-298` (`checkQuota` → `cleanOldBackups`), `:352-379` and `:386` (`chrome.storage.local.get(null)`)
- **Cost:** `saveRules` calls `checkQuota()` first (`:78`); once usage crosses 80 %, that calls `cleanOldBackups`, which does `chrome.storage.local.get(null)` — deserialising **every key in local storage**, including all backups (up to 5 full snapshots of rules + settings + stats) into memory, just to read their `timestamp` fields. With a large rule set, each backup is itself a full copy, so this can be several MB of deserialisation on a user-facing save.
- **User impact:** A visible stall when saving a rule, but only for users near the quota ceiling — precisely the users with the most data, where the stall is worst.
- **Recommended fix:** Maintain a `turboMockBackupIndex` key holding just `[{key, timestamp}]`, and use it for both `cleanOldBackups` and `getAllBackups` so neither needs `get(null)`. Also skip `checkQuota()` on the hot save path and run it on a timer or after N saves.
- **Confidence:** High.

### [Nit] P-18: Small avoidable allocations in the fetch preamble

- **Where:** `content/injected.js:145` (`.some()` closure allocated per call), `:123/124/138/154/187` (`resource instanceof Request` recomputed up to 5×), `:162` (descriptor object literal), `:457/481/493/575` (`arguments` object materialised in XHR passthrough)
- **Cost:** One closure and one object literal per fetch; one `arguments` object per XHR passthrough.
- **Recommended fix:** Hoist `const isRequest = resource instanceof Request` once; replace `.some()` with an indexed `for` loop (no closure); reuse a single mutable descriptor object per call site, or pass the four values as positional arguments to `findMatchingRule`.
- **Confidence:** High.

---

## Quick wins

Ranked by payoff ÷ effort. The first four are each under ~20 lines and together remove most of the "installed but idle" cost.

| # | Change | Effort | Payoff |
|---|---|---|---|
| 1 | **Zero-rule early-out** in `fetch` (`injected.js:120`) and in the XHR constructor (`injected.js:254`) | ~5 lines | Removes the entire per-request floor for users with no/only-DNR rules. **P-1, P-10** |
| 2 | **`indexOf('{{')` guard + return-string variant** in `processDynamicResponse` (`placeholders.js:18`) | ~10 lines | Removes 14 regex passes, 5 eager `Date`/`split` allocations, and a parse+stringify from every mocked response. **P-7** |
| 3 | **Drop `overlay.js` from `content_scripts`**, inject on demand | ~10 lines (manifest + 2 call sites) | Removes ~24 KB parse+exec from every top-level page load. **P-9** |
| 4 | **Remove `broadcastState()` + `syncDnrRules()` from `loadStoredData()`** (`background.js:77-78`) | 2 lines | Removes an all-tabs fan-out and a DNR rewrite from every SW wake. **P-5** |
| 5 | **Compiled-pattern `Map` cache** in `matchUrl` + hoist `url.toLowerCase()` | ~25 lines | ~90 % of URL-matching cost; the dominant win at 50+ rules. **P-4** |
| 6 | **Gate header collection** behind an `_anyRuleUsesHeaders` flag (`injected.js:134`) | ~8 lines | 1 object + H strings per request saved. **P-3** |
| 7 | **Delete the `onUpdated` 500 ms re-broadcast** (`background.js:472-486`) | 15 lines removed | Halves per-page-load state delivery; also fixes a cold-start empty-rules push. **P-11** |
| 8 | **Skip unreachable tabs + add a dirty flag** in `broadcastState` | ~20 lines | Kills retry amplification and no-op broadcasts. **P-6** |
| 9 | **Sync fast path for the `fetch` wrapper** (non-async outer function) | ~20 lines | 1 promise + 2 microtask turns per passthrough request. **P-2** |
| 10 | **Slim the broadcast payload** (drop mock bodies + DNR-only rules) | ~30 lines | Cuts per-frame memory and per-mutation IPC proportionally. **P-6, P-8** |
| 11 | **Push-based / cursor-based DevTools log** + visibility-gated timer | ~40 lines | Stops pinning the SW awake; removes a 200-row DOM rebuild every 2 s. **P-12** |
| 12 | **`MessageChannel` instead of `window.postMessage`** for the log relay | ~40 lines | Stops cloning every page message into the isolated world. **P-13** |

---

## Checked and ruled out

- **Body reading for GraphQL matching (lens item 3) — correctly guarded.** `injected.js:146` short-circuits on `!r.match.graphql` *before* calling `matchUrl`, so `clone().text()` at `:155` never runs when no GraphQL rules exist. The residual costs are only the `.some()` closure (**P-18**) and the double `matchUrl` for GraphQL rules (**P-16**). `matchGraphQL` itself also early-returns at `matcher.js:74`, so **no `JSON.parse` of any request body occurs** unless a GraphQL rule already matched on URL + method. This is well built.
- **`matchHeaders` — correctly guarded.** `matcher.js:50` returns `true` immediately when the rule declares no header conditions, so the normalisation loop at `:52-57` never runs for ordinary rules. (The *caller* still builds the header object regardless — that is **P-3**, not a matcher problem.)
- **XHR `open()` redirect pre-scan.** `injected.js:406` checks `(rule.type || 'mock') === 'redirect'` *before* calling `matchUrl` at `:407`, so no regex work happens unless redirect rules exist. Correct ordering.
- **`jsonMergePatch` recursion** (`src/patch.js:17-38`). Depth and breadth are bounded by the **patch** document, not the response; the `Object.assign` shallow copy per level is proportional to that level's key count. Only runs on `mode: 'patch'` rules. Not a hot-path concern.
- **Stats written to storage per request** — already addressed by the `PERSIST_THROTTLE_MS` throttle at `background.js:274-287`; not re-reported. Only the residual payload/read-modify-write shape is raised (**P-14**).
- **Interception log unbounded growth** — bounded at 200 entries by `background.js:215-217`. Not a leak.
- **`try`/`catch` in `matchUrl`** (`matcher.js:24-41`) — not a de-optimisation on modern V8/TurboFan. No cost.
- **DevTools panel `setInterval` leak** — cleared on `unload` at `panel.js:224-226`, and DevTools tears the document down regardless. Not a leak; the cost is the polling itself (**P-12**).
- **XHR `progressInterval` / `mockTimeout` leaks** — every exit path clears both (`injected.js:309-318` `finally`, `:371-374`, `:430-438`), and the `timeout` branch is bounded by `xhr.timeout`. Not a leak; only wasted setup (**P-15**).
- **`broadcastRetryCount` Map growth** — entries are removed on success (`background.js:390`), on give-up (`:405`), and on `tabs.onRemoved` (`:489-491`). No unbounded growth.
- **`syncDnrRules` full-replace** (`dnr.js:130-136`) — a full `removeRuleIds` + `addRules` swap is heavy-handed, but it is triggered only by user rule mutations, not per request, and DNR rule counts are bounded by the user's `headers`/`queryparams` rule count. Not worth optimising **except** for its inclusion in the cold-start path, which is covered by **P-5**.
- **`getSecureRandom()`** (`injected.js:39-46`) — allocates a `Uint32Array(1)` and calls `crypto.getRandomValues` per request, which is comparatively expensive, but only when the user has explicitly enabled chaos mode (`:127`). Correctly gated; not a default-path cost.
- **Options-page autosave debounce** (`options.js:1420-1435`) — correctly debounced at 1 s and only calls `collectSettingsFromUI()` (in-memory); it does not hit storage or trigger a broadcast per keystroke.
