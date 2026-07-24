# QA / Edge-Case Audit — TurboMock

_Reviewer lens: adversarial functional testing. Method: static trace of ~30 code paths across
`content/injected.js`, `content/content.js`, `content/overlay.js`, `src/matcher.js`, `src/storage.js`,
`service_worker/background.js`, `service_worker/dnr.js`, `options/options.js`, `popup/popup.js`,
plus Node-executed verification of the `Response`/`Request`/`Headers` constructors and `matchUrl`._

Branch: `V1`. Scope: functional correctness, race conditions, error paths, boundary values.
Findings the prompt listed as already fixed are excluded.

## Summary

- **Every mocked XHR fires its `on*` handlers twice** (`onload`, `onreadystatechange`, `onloadend`,
  `onerror`, `onprogress`). `finishMock` both `dispatchEvent`s and manually invokes the handler.
  Any app using the `xhr.onload = …` style runs its success path twice per mocked request (Q-1).
- **Mocking a `204`/`304` or any 1xx status turns the request into a network error**, because
  `new Response(body, {status})` throws for null-body statuses and for statuses outside 200–599 —
  but the rule editors validate 100–599 (Q-2). Verified by execution.
- **Regex URL patterns containing `*` silently never match**, because `matchUrl` checks
  `pattern.includes('*')` before the `/regex/` branch. The shipped **"Redirect to localhost"
  quick template ships a pattern that can never fire** (Q-3). Verified by execution.
- **One malformed imported rule bricks the rule UI.** Import does zero validation; a rule without
  `match` throws in `popup.js:165`, the popup renders nothing, and the options page has no rule
  list — leaving Factory Reset as the only recovery (Q-4).
- **The options page never refreshes its rules snapshot**, so saving or importing after deleting a
  rule from the popup silently resurrects the deleted rule (Q-9).
- Advertised keyboard shortcuts (`Ctrl+Shift+M` / `Ctrl+Shift+N`) are declared in the manifest and
  displayed in the options UI, but **no `chrome.commands.onCommand` listener exists anywhere** (Q-20).

## Findings

---

### [Critical] Q-1: Mocked XHR invokes every `on*` handler twice

- **Where:** `content/injected.js:284-301` (`finishMock`), also `:337`, `:348-359`, `:471-473`,
  `:508-510`, `:443-445`, `:377-379`
- **Repro:**
  1. Rule: type `mock`, method `GET`, url `*/api/ping*`, static body `{"n":1}`.
  2. Page runs:
     ```js
     let calls = 0;
     const x = new XMLHttpRequest();
     x.open('GET', '/api/ping');
     x.onload = () => { calls++; console.log('onload', calls); };
     x.send();
     ```
- **Expected:** `onload 1`.
- **Actual:** `onload 1` then `onload 2`. Same doubling for `onreadystatechange` and `onloadend`.
  `addEventListener('load', …)` fires only once, so the two registration styles disagree.
- **Why it happens:** `xhr` is a real `XMLHttpRequest` instance, so `xhr.onload = fn` installs a
  DOM event-handler IDL attribute. `xhr.dispatchEvent(new ProgressEvent('load'))` already invokes
  it; the following line `if (xhr.onload) xhr.onload(new ProgressEvent('load'))` invokes it a
  second time. The same double-invoke pattern is repeated in every event-emitting path: the
  block path (`error` + `loadend`), the chaos path, the timeout path, the abort path, and the
  progress emitter.
- **Impact:** duplicated application side effects — double list rendering, double POST retries,
  double analytics events. Silent and easy to blame on the app, not the extension.
- **Recommended fix:** drop every manual `if (xhr.onX) xhr.onX(...)` call; `dispatchEvent` alone
  is sufficient and delivers a correctly-typed event object to both registration styles.
- **Confidence:** Confirmed (traced). Standard DOM behaviour: `dispatchEvent` runs `on*` handlers.

---

### [Critical] Q-2: Mock statuses 100–199, 204, 205 and 304 make `fetch` reject instead of returning

- **Where:** `content/injected.js:243-247`; validation at `options/options.js:382` and
  `content/overlay.js:470`
- **Repro:**
  1. Rule: type `mock`, url `*/api/delete-item*`, method `DELETE`, **Status Code `204`**, body left
     empty (options page stores `response.body = ""`; the overlay stores `{}`).
  2. Page runs `await fetch('/api/delete-item', {method:'DELETE'})`.
- **Expected:** a `Response` with `status === 204`.
- **Actual:** the promise rejects with
  `TypeError: Failed to construct 'Response': Response with null body status cannot have body`.
  The app sees a network failure. With Status Code `100` it rejects with
  `RangeError: Failed to construct 'Response': The status provided (100) is outside the range [200, 599]`.
- **Why it happens:** `new Response(responseBody, {status, …})` is called with an unconditional
  string body. The spec forbids a non-null body for statuses 101/204/205/304 and forbids any
  status below 200. Both editors validate only `100 <= status <= 599`
  (`MIN_STATUS_CODE = 100` at `options/options.js:13`), and `utils.js:84` uses the same range.
  Note the same rule works fine over XHR (no `Response` constructor involved), so behaviour
  diverges by transport.
- **Recommended fix:** in `injected.js`, pass `null` as the body when
  `[101,204,205,304].includes(status)`; clamp/reject statuses < 200 at save time in both editors
  and in `TurboMockUtils.validateStatusCode`.
- **Confidence:** Confirmed (traced **and** executed — `node -e "new Response('',{status:204})"`
  throws `TypeError`; `{status:100}` throws `RangeError`).

---

### [High] Q-3: A `/regex/` URL pattern containing `*` is treated as a wildcard and never matches — including a shipped template

- **Where:** `src/matcher.js:25-34`; broken template at `options/options.js:679-684`
- **Repro:**
  1. Options → rule editor → Quick Template → **"Redirect to localhost"**. It fills URL Pattern
     with `/\/(api\/.*)/` and destination `http://localhost:3000/$1`.
  2. Save with any name. Load a page that calls `fetch('/api/users')`.
- **Expected:** the request is redirected to `http://localhost:3000/api/users`.
- **Actual:** nothing is intercepted; the request goes to the real origin.
- **Why it happens:** `matchUrl` tests `pattern.includes('*')` **first** (`matcher.js:25`), so any
  regex containing `*`, `+?*`, `.*` etc. takes the wildcard branch, gets every metacharacter
  escaped, and is anchored as `^…$`. `/\/(api\/.*)/` becomes the literal-ish regex
  `^/\\/\(api\\/\..*$`, which no real URL can satisfy. Executed check:
  `matchUrl('https://x.com/api/users', '/\\/(api\\/.*)/') === false`.
  Two further inconsistencies flow from the same ordering bug:
  `dnr.js:32` and `injected.js:90` both check the `/…/` regex form **first**, so the identical
  pattern is treated as a regex by the DNR layer and by `computeRedirectUrl`, but as a wildcard
  by the matcher.
- **Recommended fix:** test the `/…/` delimiter form before the `*` wildcard form in `matchUrl`,
  matching the order already used in `dnr.js` and `computeRedirectUrl`. Add a regression test for
  a regex pattern containing `.*`.
- **Confidence:** Confirmed (traced and executed).

---

### [High] Q-4: One malformed imported rule breaks the popup rule list permanently, with no in-product recovery

- **Where:** `popup/popup.js:165` and `:558`; import path `options/options.js:1165-1220`;
  background pass-through `service_worker/background.js:140-161`
- **Repro:**
  1. Save `{"rules":[{"id":"x","name":"broken","enabled":true}]}` to a file (note: no `match`).
  2. Options → Rules → Import Rules → choose the file. It reports "Imported 1 rules successfully!".
  3. Open the popup.
- **Expected:** the malformed rule is rejected at import, or rendered defensively.
- **Actual:** `getRuleCardHTML` throws `TypeError: Cannot read properties of undefined (reading 'method')`.
  The throw unwinds through `renderRules` → `renderCurrentView` → `init`'s catch, so the popup shows
  only the "Failed to load extension data" toast and an empty list. Typing in the search box throws
  the same error (`popup.js:558`). Because the options page has **no rule list at all** (the Rules
  tab is import/export only — see Q-27), the user cannot delete the offending rule from any surface.
  Only Factory Reset recovers.
- **Why it happens:** `options.js:importRules` accepts any array and forwards it to
  `setRules`; the background only spreads each entry (`{...incoming}`) and persists.
  `TurboMockUtils.importRulesFromFile` (`src/utils.js:243-275`) *does* filter entries lacking
  `id`/`name`/`match`/`response` — but nothing calls it (see Q-21).
- **Recommended fix:** validate imported entries in `options.js:importRules` (reuse
  `TurboMockUtils.validateRuleStructure`), report skipped counts, and additionally guard
  `rule.match` in `getRuleCardHTML`/`handleSearch`/`getRuleSummaryText`.
- **Confidence:** Confirmed (traced).

---

### [High] Q-5: A `mock` rule with no `response` object throws inside the page's `fetch`/`send`

- **Where:** `content/injected.js:229`, `:233`, `:324`; redirect variant at `:98`
- **Repro:**
  1. Import `{"rules":[{"id":"r1","name":"legacy","enabled":true,"match":{"method":"*","url":"*/api/*"}}]}`
     (a plausible hand-written or v1 rule).
  2. Page runs `fetch('/api/anything')`.
- **Expected:** either the rule is ignored, or a default `{}` 200 response is returned.
- **Actual:** the fetch promise rejects with
  `TypeError: Cannot read properties of undefined (reading 'delay')`. Over XHR the same rule makes
  `xhr.send()` **throw synchronously** from `runStaticMockFlow` (`injected.js:324`), which most
  callers do not expect and do not catch.
- **Why it happens:** `normalizeRule` (`src/storage.js:117-130`) defaults `type` to `'mock'` but
  only touches `response` if it already exists. The interceptor then dereferences
  `rule.response.delay` / `rule.response.body` unguarded. The redirect path has the same shape:
  a `redirect` rule with no `redirect` object throws at `injected.js:98`, and for XHR that throw
  escapes from `xhr.open()`.
- **Recommended fix:** treat a `mock` rule with no usable `response` as non-matching (skip it in
  `findMatchingRule`), or have `normalizeRule` synthesise `{statusCode:200, body:{}, mode:'static'}`.
  Wrap the whole interceptor branch in try/catch that falls back to `originalFetch`/`originalSend`.
- **Confidence:** Confirmed (traced).

---

### [High] Q-6: `fetch(new URL(...))` breaks matching, and breaks harder when it *does* match

- **Where:** `content/injected.js:123`, `:66-78`; `src/matcher.js:36`
- **Repro A (silent miss):**
  1. Rule with a plain substring pattern, e.g. url `api/users`.
  2. Page runs `fetch(new URL('/api/users', location.origin))`.
- **Expected:** rule matches (same as `fetch('/api/users')`).
- **Actual:** no match, plus one `Error matching URL pattern: TypeError: url.toLowerCase is not a
  function` in the console per rule per request.
- **Repro B (hard failure):**
  1. Same call, but the rule pattern is `*/api/users*` (wildcard branch, which coerces via
     `regex.test`, so it **does** match).
  2. `logInterception` posts `{ url: <URL object> }` through `window.postMessage`.
- **Expected:** the mock response.
- **Actual:** `window.postMessage` raises `DataCloneError` (a `URL` instance is not a structured-
  cloneable type), the exception escapes the async `fetch` wrapper, and the page's `fetch` rejects.
- **Why it happens:** `injected.js:123` computes
  `const url = (resource instanceof Request) ? resource.url : resource;` — it handles `Request` but
  not `URL`. Contrast `xhr.open` at `injected.js:393`, which *does* normalise
  (`url instanceof URL ? url.href : String(url)`), so the two transports disagree.
- **Recommended fix:** apply the same normalisation on the fetch path:
  `const url = resource instanceof Request ? resource.url : String(resource);`
- **Confidence:** Repro A **Confirmed** (traced and executed — `matchUrl(new URL(...), 'api/u')`
  logs the TypeError and returns `false`). Repro B **Suspected** — the `DataCloneError` follows
  from `URL` not being on the serializable-objects list, but needs a runtime check in Chrome.

---

### [High] Q-7: XHR mocks ignore `responseType` and drop all response headers

- **Where:** `content/injected.js:277-280` (`finishMock`); rule headers used only at `:236`
- **Repro:**
  1. Rule: type `mock`, url `*/api/user*`, response headers `{"Content-Type":"application/json"}`,
     body `{"id":1}`.
  2. Page runs:
     ```js
     const x = new XMLHttpRequest();
     x.responseType = 'json';
     x.open('GET','/api/user');
     x.onload = () => console.log(typeof x.response, x.getAllResponseHeaders());
     x.send();
     ```
- **Expected:** `object` and a header block containing `content-type: application/json`.
- **Actual:** `string` and `""`. With `responseType = 'blob'` or `'arraybuffer'`, `x.response` is a
  string, so `x.response.size` / `.byteLength` are `undefined` and any consumer
  (`URL.createObjectURL(x.response)`, `new DataView(x.response)`) throws.
- **Why it happens:** `finishMock` unconditionally `defineProperty`s both `responseText` and
  `response` to the same string, never consulting `xhr.responseType`. Nothing overrides
  `getAllResponseHeaders()` / `getResponseHeader()`, so `rule.response.headers` is applied only on
  the fetch path. `responseURL` and `responseXML` are likewise never set.
- **Impact:** libraries that sniff `Content-Type` (axios' default `transformResponse`, most
  file-download flows) misbehave on XHR mocks while working on fetch mocks.
- **Recommended fix:** branch on `xhr.responseType` in `finishMock` (`''`/`'text'` → string,
  `'json'` → `JSON.parse`, `'arraybuffer'`/`'blob'` → encode via `TextEncoder`/`new Blob`), and
  override `getResponseHeader`/`getAllResponseHeaders` from `rule.response.headers`.
- **Confidence:** Confirmed (traced).

---

### [High] Q-8: `block`, chaos-mode and XHR-timeout paths never dispatch `readystatechange`, hanging `onreadystatechange`-only code

- **Where:** `content/injected.js:503-512` (block), `:466-474` (chaos), `:368-380` (timeout)
- **Repro:**
  1. Rule: type `block`, method `*`, url `*/api/*`.
  2. Page runs classic XHR-level-1 code:
     ```js
     const x = new XMLHttpRequest();
     x.open('GET','/api/thing');
     x.onreadystatechange = () => { if (x.readyState === 4) console.log('done', x.status); };
     x.send();
     ```
- **Expected:** `done 0` (the request was blocked).
- **Actual:** nothing ever logs. The app's loading spinner never clears.
- **Why it happens:** all three paths set `readyState` to 4 via `defineProperty` and then dispatch
  only `error`/`timeout` + `loadend`. `readystatechange` is dispatched only by `finishMock`
  (`:284`) and by `runStaticMockFlow`'s readyState-3 step (`:337`). A `readyState` mutation without
  a `readystatechange` event is invisible to handler-based code.
- **Recommended fix:** dispatch `readystatechange` immediately after every `readyState`
  `defineProperty` in those three paths (and for the abort path's `readyState = 0`).
- **Confidence:** Confirmed (traced).

---

### [High] Q-9: The options page writes a stale rules snapshot, resurrecting rules deleted elsewhere

- **Where:** `options/options.js:769-787` (`loadData`), `:604-630` (save), `:1195-1210` (import)
- **Repro:**
  1. Create rules A and B. Open the options page in a tab and leave it open.
  2. Open the popup, delete rule B, close the popup.
  3. Back in the options tab, open the rule editor for A (via `?editRule=` or a template), change
     the name, Save.
- **Expected:** rules = [A'].
- **Actual:** rules = [A', B]. Rule B is back.
- **Why it happens:** `this.rules` is read once from `chrome.storage.local` during `init()`. There
  is no `chrome.storage.onChanged` listener and no re-read before save. Every save/import posts the
  **entire** in-memory array via `setRules`, and the background persists it wholesale
  (`background.js:156`). The reverse case loses data: create a rule in the popup while the options
  tab is open, then import in the options tab with "merge" checked — the popup-created rule is
  dropped, because merge merges against the stale snapshot.
- **Recommended fix:** re-fetch rules from the background immediately before building the payload
  in `saveRuleFromEditor`/`importRules`, or subscribe to `chrome.storage.onChanged` and refresh
  `this.rules`. Better: switch the options page to per-rule `saveRule`/`deleteRule` messages so it
  never owns the whole array.
- **Confidence:** Confirmed (traced).

---

### [Medium] Q-10: URL pattern `/` matches every request; `validateUrlPattern` is never run on save

- **Where:** `src/matcher.js:31-34`; `src/utils.js:38-45`; save paths `options/options.js:334-344`
  and `content/overlay.js:436`
- **Repro:**
  1. Create a rule with URL Pattern exactly `/` and a mock body.
  2. Load any page.
- **Expected:** save is rejected ("Regex pattern cannot be empty").
- **Actual:** the rule saves and intercepts **every** request on every site, because
  `'/'.slice(1,-1) === ''` and `new RegExp('', 'i').test(anything) === true`. Executed check:
  `matchUrl('https://anything.example/x', '/') === true`. `//` behaves identically.
- **Why it happens:** `TurboMockUtils.validateUrlPattern` explicitly rejects an empty regex body,
  but it is only reachable through the `testRule` message handler
  (`service_worker/background.js:304`) — i.e. the popup's Test button. Neither editor calls it on
  save; both only check non-empty and length.
- **Recommended fix:** call `validateUrlPattern` from both save paths, and add a
  `regexBody.length === 0` guard directly in `matchUrl`.
- **Confidence:** Confirmed (traced and executed).

---

### [Medium] Q-11: Requests fired before the first `syncState` arrives are never intercepted

- **Where:** `content/content.js:20-42`, `:170`; `content/injected.js:25-29`, `:593-615`
- **Repro:**
  1. Rule: type `mock`, url `*/api/bootstrap*`.
  2. Page with `<head><script>fetch('/api/bootstrap')</script></head>`, or any app whose first
     request lands within a few hundred ms of `document_start`.
  3. Ensure the service worker is asleep (wait ~30 s after the last extension activity), then load
     the page.
- **Expected:** the request is mocked.
- **Actual:** it goes to the network. `tmState.rules` is still `[]` until the
  `getRules` round-trip completes.
- **Why it happens:** the MAIN-world interceptor starts with `rules: []` and is populated only by a
  `postMessage` that content.js sends *after* an async `chrome.runtime.sendMessage` round-trip. On a
  cold MV3 service-worker start that round-trip also pays worker boot + `chrome.storage.local.get`.
  There is no queueing/holding of in-flight requests, and no synchronous seed. On failure
  content.js retries only every 2 s (`content.js:30`), widening the window further.
- **Recommended fix:** cache the last-known rules in a synchronously readable place the MAIN world
  can seed from (e.g. a small `world:"MAIN"` script generated from
  `chrome.scripting.registerContentScripts`, or buffering matched-but-unsynced requests behind a
  short promise gate until the first `syncState`).
- **Confidence:** Confirmed (traced). Exact window width needs a runtime measurement.

---

### [Medium] Q-12: Synchronous XHR is silently not mocked

- **Where:** `content/injected.js:387` (`setTimeout`), `:453-576`
- **Repro:**
  1. Rule: type `mock`, url `*/api/config*`, body `{"a":1}`.
  2. Page runs:
     ```js
     const x = new XMLHttpRequest();
     x.open('GET','/api/config', false);   // synchronous
     x.send();
     console.log(x.status, x.responseText);
     ```
- **Expected:** `200 {"a":1}`.
- **Actual:** `0 ""`. The mock is delivered ~10 ms later, long after the caller has moved on.
- **Why it happens:** `xhr.send` never inspects the `async` argument captured in `open`'s `...args`.
  `runStaticMockFlow` always schedules delivery through `setTimeout`, which cannot run before a
  synchronous `send()` returns. The `block` and `delay` paths have the same problem.
- **Recommended fix:** capture the `async` flag in `open`; for `async === false`, either deliver the
  mock synchronously inside `send()` (set the properties and dispatch before returning) or fall back
  to `originalSend` and log a warning.
- **Confidence:** Confirmed (traced).

---

### [Medium] Q-13: `fetch` ignores `AbortController` / `signal` on the mock and patch paths

- **Where:** `content/injected.js:229-247` (static), `:194-223` (patch)
- **Repro:**
  1. Rule: type `mock`, url `*/api/slow*`, **Delay 3000 ms**.
  2. Page runs:
     ```js
     const c = new AbortController();
     const p = fetch('/api/slow', { signal: c.signal })
                 .then(() => console.log('resolved'), e => console.log('rejected', e.name));
     setTimeout(() => c.abort(), 100);
     ```
- **Expected:** `rejected AbortError` at ~100 ms.
- **Actual:** `resolved` at ~3000 ms. Components that unmount and abort in-flight requests will
  apply a response they explicitly cancelled — a classic setState-after-unmount / stale-render bug.
- **Why it happens:** the mock branch never reads `config.signal`; `sleep()` is a bare `setTimeout`
  promise with no abort wiring. (The `delay` rule type happens to behave correctly, because it hands
  off to `originalFetch`, which rejects on an already-aborted signal.)
- **Recommended fix:** race `sleep()` against an `abort` listener on `config.signal ??
  (resource instanceof Request && resource.signal)` and reject with a `DOMException('…','AbortError')`.
  Check `signal.aborted` before constructing the `Response`.
- **Confidence:** Confirmed (traced).

---

### [Medium] Q-14: Any script in the page — or a cross-origin iframe — can replace, disable or read TurboMock's rules

- **Where:** `content/injected.js:593-615`; `content/content.js:54-58`, `:112-131`
- **Repro (hijack):** on any page with TurboMock active, run in the page console:
  ```js
  window.postMessage({ source:'turbomock-extension', type:'syncState',
                       payload:{ active:false, rules:[], settings:{} } }, '*');
  ```
  All mocking stops for the rest of the page's life. Substituting attacker-authored `rules` installs
  arbitrary mocks instead. A third-party iframe can do the same via `parent.postMessage(...)`.
- **Repro (disclosure):** run `addEventListener('message', e => { if (e.data?.source ===
  'turbomock-extension') console.log(e.data.payload.rules); })` before load. The page receives the
  **entire** rules array, including `match.headers` (which commonly holds API keys/bearer tokens)
  and mock response bodies.
- **Expected:** state sync is not forgeable or readable by page content.
- **Actual:** the injected listener checks only `event.data.source` — no `event.source === window`
  check, no `event.origin` check. Symmetrically, `content.js:112` accepts any
  `source:'turbomock-injected'` message and forwards it to the background, so a page can inject
  fabricated entries into the 200-entry DevTools log and inflate `stats.intercepted`.
- **Why it happens:** `postMessage` with `'*'` and no provenance validation in either direction.
- **Recommended fix:** in `injected.js`, require `event.source === window` and
  `event.origin === location.origin`; in `content.js`, require `event.source === window`. Consider a
  per-page nonce handed to the MAIN world at injection time. Longer term, prefer a
  `CustomEvent` on a private symbol or a dedicated `MessageChannel` port.
- **Note:** the MAIN-world design means a hostile page can already re-patch `fetch`, so this is
  primarily an integrity/disclosure issue for the *extension's own* data, not a page-isolation break.
- **Confidence:** Confirmed (traced).

---

### [Medium] Q-15: `allocateDnrId` is a read-modify-write race; a collision silently kills the whole DNR ruleset

- **Where:** `src/storage.js:137-148`; callers `service_worker/background.js:130-137`, `:149-155`;
  `service_worker/dnr.js:121-140`
- **Repro:**
  1. Open the options page and start importing a file with several `headers` rules.
  2. While that is in flight, use the popup to duplicate an existing `headers` rule (`saveRule`).
  3. Inspect `chrome://extensions` → service worker console.
- **Expected:** distinct DNR ids; all rules registered.
- **Actual (when the interleave hits):** both allocations read the same `turboMockDnrCounter` value
  and return the same id. `chrome.declarativeNetRequest.updateDynamicRules` then rejects with a
  duplicate-id error. `syncDnrRules` swallows it (`dnr.js:137-139` logs and returns), so **every**
  headers/queryparams rule stops working with no user-visible signal.
- **Why it happens:** `get` → `+1` → `set` is not atomic and the two message handlers interleave at
  the `await`. There is no post-write verification and no de-duplication before `updateDynamicRules`.
- **Recommended fix:** serialise allocation behind a single in-worker promise chain
  (`this._dnrLock = this._dnrLock.then(...)`), and defensively de-duplicate `desired` by `id` in
  `syncDnrRules`. Surface sync failures to the UI instead of only `console.error`.
- **Confidence:** Confirmed (traced); the interleave itself is Suspected without a runtime repro.

---

### [Medium] Q-16: Throttled persistence has no trailing flush — the last ≤1.5 s of stats and log entries are lost

- **Where:** `service_worker/background.js:274-287` (`_persistVolatile`), called only at `:219`
- **Repro:**
  1. Load a page that fires 20 mocked requests within one second.
  2. Wait ~30 s for the service worker to suspend (or click "terminate" in `chrome://extensions`).
  3. Reopen the popup / DevTools panel.
- **Expected:** 20 intercepts counted, 20 log entries.
- **Actual:** only the intercepts that happened to fall outside the throttle window survive; the
  rest are gone.
- **Why it happens:** when `now - _lastPersist < PERSIST_THROTTLE_MS`, `_persistVolatile` returns
  immediately and **schedules nothing**. There is no trailing timer and no `chrome.runtime.onSuspend`
  handler. The `force = true` parameter is never passed by any caller — it is dead code.
- **Recommended fix:** on the throttled path, schedule a single trailing flush
  (`setTimeout(() => this._persistVolatile(true), remaining)`), and add a
  `chrome.runtime.onSuspend` listener that forces a final write.
- **Confidence:** Confirmed (traced).

---

### [Medium] Q-17: Non-string request bodies silently defeat GraphQL matching

- **Where:** `content/injected.js:151-159` (fetch), `:484` (XHR)
- **Repro:**
  1. Rule: type `mock`, method `POST`, url `*/graphql*`, GraphQL Operation Name `getUsers`.
  2. Page posts the operation as multipart (the graphql-upload convention) or as urlencoded:
     ```js
     const fd = new FormData();
     fd.append('operations', JSON.stringify({ operationName: 'getUsers', query: '…' }));
     fetch('/graphql', { method: 'POST', body: fd });
     ```
- **Expected:** either a match, or at minimum a debug-log warning that the body could not be read.
- **Actual:** silent no-match. `bodyText` stays `null`, so `matchGraphQL` returns `false`
  (`matcher.js:75`).
- **Why it happens:** the fetch path reads the body only when `typeof config.body === 'string'` or
  the resource is a `Request` (whose `.clone().text()` does handle Blob/FormData/URLSearchParams).
  The XHR path is stricter still — `typeof body === 'string' ? body : null` — so
  `xhr.send(new URLSearchParams(...))` or `xhr.send(blob)` never matches a GraphQL rule.
- **Recommended fix:** handle `URLSearchParams` (`String(body)`), `Blob`/`File` (`await body.text()`),
  `ArrayBuffer`/`TypedArray` (`new TextDecoder().decode(...)`), and `FormData` (iterate string
  entries). Emit a debug-mode warning for unreadable body types so the miss isn't silent.
- **Confidence:** Confirmed (traced).

---

### [Medium] Q-18: XHR patch mode forces `credentials: 'include'` and ignores `withCredentials`

- **Where:** `content/injected.js:537-542`
- **Repro:**
  1. Rule: type `mock`, **mode `patch`**, url `*api.thirdparty.com/v1/*`, patch `{"flag":true}`.
  2. Page runs a plain cross-origin XHR (`withCredentials` left at its default `false`) to that host.
     The host allows `Access-Control-Allow-Origin: *` but not `Access-Control-Allow-Credentials`.
- **Expected:** the real response is fetched and patched.
- **Actual:** the internal `originalFetch(..., {credentials:'include'})` fails CORS. The `catch`
  falls back to `originalSend` (`:556-560`), so the patch is silently skipped and the raw response
  is delivered — the rule appears to do nothing.
- **Why it happens:** the re-issued request hard-codes `credentials: 'include'` rather than deriving
  it from `xhr.withCredentials`. Two related hazards on the same lines: forbidden headers captured
  from `setRequestHeader` are replayed into `fetch` (some throw), and the fallback re-send after a
  partial failure can produce a **duplicate** side-effecting POST.
- **Recommended fix:** use `credentials: xhr.withCredentials ? 'include' : 'same-origin'`, strip
  forbidden header names before the fetch, and do not auto-retry non-idempotent methods.
- **Confidence:** Confirmed (traced) for the hard-coded credentials; the CORS outcome is Suspected
  pending a runtime check.

---

### [Medium] Q-19: Editing a rule that was deleted elsewhere resurrects it

- **Where:** `content/overlay.js:439`, `:543`; `src/storage.js:150-174`
- **Repro:**
  1. Open the in-page overlay on rule A (popup → Edit).
  2. In a second window, open the popup and delete rule A.
  3. Return to the overlay and click Save Rule.
- **Expected:** an error such as "This rule no longer exists".
- **Actual:** save succeeds. `storage.saveRule` finds no matching `id` and takes the `else` branch,
  `rules.push(...)`, re-creating the deleted rule with its original id.
- **Why it happens:** `saveRule` is an unconditional upsert with no existence check and no
  optimistic-concurrency token. The overlay reuses `editingRule.id`, so the resurrected rule is
  indistinguishable from the original.
- **Recommended fix:** send an `isNew` flag (or `expectedLastModified`) with `saveRule`; reject an
  update whose id is absent, and surface "rule was deleted" in the overlay.
- **Confidence:** Confirmed (traced).

---

### [Medium] Q-20: Declared keyboard commands have no handler — the advertised shortcuts do nothing

- **Where:** `manifest.json:61-76`; options UI shows them at `options/options.js:1009-1013`;
  no `chrome.commands.onCommand` listener exists anywhere in the repo
- **Repro:**
  1. Open the options page — it displays "Ctrl+Shift+M" (Toggle) and "Ctrl+Shift+N" (New rule).
  2. On any page, press `Ctrl+Shift+M`.
- **Expected:** the extension toggles off.
- **Actual:** nothing happens. Same for `Ctrl+Shift+N`.
- **Why it happens:** the manifest registers the commands, and `storage.js:25-28` plus
  `options.js:802-807` carry them as user-facing settings, but no code ever subscribes to
  `chrome.commands.onCommand`. (`grep -rn "onCommand" --include=*.js` returns nothing.)
  Worse, the shortcuts are *reserved* by Chrome once declared, so `Ctrl+Shift+N` no longer opens an
  incognito window on some platforms — the feature is net-negative as shipped.
- **Recommended fix:** add `chrome.commands.onCommand.addListener` in `background.js` (registered
  synchronously alongside the other listeners) wiring `toggle-extension` to the existing
  `toggleExtension` logic and `new-rule` to the overlay/options path. Or remove the `commands` block.
- **Confidence:** Confirmed (traced).

---

### [Medium] Q-21: The Test button always fails for every non-`mock` rule type

- **Where:** `service_worker/background.js:292-337` (`validateRule`); callers
  `popup/popup.js:476-514`, `:583-625`
- **Repro:**
  1. Create a `block` rule (or `delay`, `redirect`, `headers`, `queryparams`) — all valid.
  2. In the popup, click the ✓ Test icon on that rule.
- **Expected:** "Test passed", or at least a type-appropriate check.
- **Actual:** "Test failed", and the rule shows a red ✗ badge. "Test All" reports every non-mock
  rule as failed.
- **Why it happens:** `validateRule` unconditionally requires `rule.response`
  (`background.js:314`) and validates `rule.response.statusCode` — but only `type: 'mock'` rules
  have a `response` in the v2 schema. Nothing in `validateRule` branches on `rule.type`.
- **Recommended fix:** branch on `rule.type`: validate `response` only for `mock`, `delayMs` for
  `delay`, `redirect.destination` for `redirect`, `headersMod`/`queryParams` for the DNR types.
- **Confidence:** Confirmed (traced).

---

### [Medium] Q-22: HTML injection into the popup via unescaped rule fields

- **Where:** `popup/popup.js:174-206` (`data-rule-id`, `rule.match.method`), `:228` (`data-type`),
  `:243` (`rule.delayMs`)
- **Repro:**
  1. Import `{"rules":[{"id":"a\" data-x=\"","name":"n","enabled":true,"type":"delay",
     "delayMs":"<img src=x onerror=alert(1)>","match":{"method":"GET\"><b>PWNED</b><span x=\"",
     "url":"*"}}]}`.
  2. Open the popup.
- **Expected:** the values render as inert text.
- **Actual:** the injected markup is parsed into the popup DOM. `rule.name` and `match.url` *are*
  escaped (`escapeHtml`), but `rule.id`, `rule.type`, `rule.match.method` and `rule.delayMs` are
  interpolated raw — including into `data-rule-id="…"` attribute positions on six elements.
- **Why it happens:** `getRuleCardHTML` builds an `innerHTML` string; escaping was applied
  selectively.
- **Impact — honest scoping:** the MV3 extension-page CSP (`script-src 'self'`) blocks inline event
  handlers and remote script/image loads, so this is **not** a working script XSS. The realistic
  damage is DOM clobbering (injecting `id="searchInput"` etc.), broken/spoofed rule rows, and
  attribute-boundary escapes that make the wrong rule get deleted when a button is clicked.
- **Recommended fix:** route every interpolation through `escapeHtml`, or build the cards with
  `document.createElement` + `textContent` / `dataset`.
- **Confidence:** Confirmed (traced). Script execution being blocked by CSP is Confirmed by the
  MV3 default policy; the DOM-clobbering consequence is Suspected pending a runtime check.

---

### [Medium] Q-23: XHR redirect logs an interception at `open()` time — phantom entries and inflated stats

- **Where:** `content/injected.js:412-419`
- **Repro:**
  1. Rule: type `redirect`, method `*`, url `*/api/*`, destination `http://localhost:3000/x`.
  2. Page runs `const x = new XMLHttpRequest(); x.open('GET','/api/thing');` and **never** calls
     `send()` (a common pattern in feature-detection and in aborted request pools).
  3. Open the TurboMock DevTools panel.
- **Expected:** no entry, `intercepted` unchanged.
- **Actual:** one entry with status 302 and `stats.intercepted` incremented. Re-`open()`ing the same
  XHR object (legal per spec) logs again each time.
- **Why it happens:** the redirect pre-match must happen in `open()` to rewrite the URL, and
  `logInterception` was placed there rather than deferred to `send()`.
- **Recommended fix:** stash the pending redirect entry on the instance in `open()` and emit it from
  `send()` (guarded so a re-`open()` discards the unsent entry).
- **Confidence:** Confirmed (traced).

---

### [Low] Q-24: An invalid response-header name turns a mock into a network error

- **Where:** `content/injected.js:236`; validation gap at `options/options.js:391-402`
- **Repro:** rule with Response Headers `{"Content Type": "application/json"}` (space, not hyphen —
  an easy typo), then `fetch('/api/x')`.
- **Expected:** a save-time error, or the bad header dropped.
- **Actual:** `new Headers({...})` throws
  `TypeError: Failed to construct 'Headers': "Content Type" is an invalid header name`, and the
  page's fetch rejects. Verified by execution in Node.
- **Why it happens:** both editors validate only that the headers value parses as a JSON object;
  header *names* are never checked, and the `new Headers()` call is not wrapped.
- **Recommended fix:** validate names against the HTTP token grammar at save time, and wrap
  `new Headers(...)` in try/catch with a fallback to `{'Content-Type':'application/json'}`.
- **Confidence:** Confirmed (traced and executed).

---

### [Low] Q-25: Header matching cannot see browser-generated request headers

- **Where:** `content/injected.js:134-140` (fetch), `:580-583` (XHR)
- **Repro:** rule with Match Request Headers `{"content-type":"application/json"}`; page runs
  `fetch('/api/x', {method:'POST', body: JSON.stringify({})})` without setting the header.
- **Expected (user's mental model):** matches — the request *is* sent with a `Content-Type`.
- **Actual:** no match. Only headers the page explicitly passed in `config.headers` /
  `setRequestHeader` are visible; UA, Accept, Cookie, Referer, and the body-derived `Content-Type`
  are added by the network stack after the patch point.
- **Recommended fix:** document the limitation in the editor hint text; optionally synthesise
  `content-type` from the body type for the match check.
- **Confidence:** Confirmed (traced).

---

### [Low] Q-26: `hitCount` is never incremented and `testStatus` is never persisted

- **Where:** `hitCount` written at `content/overlay.js:446`, `options/options.js:610`,
  `src/utils.js:289` — never incremented anywhere. `testStatus` set only in memory at
  `popup/popup.js:495` and `:609`.
- **Repro:** run 50 mocked requests through a rule, reopen the editor — `hitCount` is still 0.
  Click Test on a rule (it goes green), close and reopen the popup — the badge is back to "pending".
- **Why it happens:** `logInterception` (`background.js:212-221`) pushes to the log and bumps the
  global counter but never touches the matched rule's `hitCount`. The popup mutates its local
  `rule.testStatus` object and re-renders without any `saveRule`/`setRules` call.
- **Recommended fix:** increment `hitCount` in the `logInterception` handler (throttled with the
  existing persistence), and persist `testStatus` via `saveRule` after a test — or drop both fields.
- **Confidence:** Confirmed (traced).

---

### [Low] Q-27: The `XMLHttpRequest` static readyState constants are lost

- **Where:** `content/injected.js:253`, `:589`
- **Repro:** page runs `console.log(XMLHttpRequest.DONE)` → `undefined`. Any code shaped like
  `if (xhr.readyState === XMLHttpRequest.DONE)` never fires, mocked or not.
- **Why it happens:** `window.XMLHttpRequest` is replaced with a plain function. Only `.prototype`
  is reassigned; the interface's static constants (`UNSENT`, `OPENED`, `HEADERS_RECEIVED`,
  `LOADING`, `DONE`) are not copied onto the wrapper.
- **Note:** the *instance* constants (`xhr.DONE`) still work, since they live on
  `originalXHR.prototype`. This affects only the static form — but that form breaks for **all**
  requests on the page, not just mocked ones.
- **Recommended fix:** copy the five constants onto the wrapper (or `Object.setPrototypeOf(
  window.XMLHttpRequest, originalXHR)`).
- **Confidence:** Confirmed (traced).

---

### [Low] Q-28: Patch-mode fetch responses lose `url`, `redirected` and `type`

- **Where:** `content/injected.js:219-223`
- **Repro:** rule with mode `patch`; page runs
  `const r = await fetch('/api/x'); console.log(r.url, r.redirected, r.type)`.
- **Expected:** the real URL, redirect flag and response type.
- **Actual:** `""`, `false`, `"default"` — a freshly constructed `Response` cannot carry those.
  Code that resolves relative links against `response.url`, or checks `response.redirected` for
  auth-wall detection, breaks. Static-mock responses have the same gap, but there the mismatch is
  expected; in patch mode the user asked for "the real response, plus a merge".
- **Recommended fix:** where possible use `Object.defineProperty` on the new `Response` for `url`,
  or document the limitation in the patch-mode hint text.
- **Confidence:** Confirmed (traced).

---

### [Low] Q-29: Broadcast fan-out retries against every tab, including ones with no content script

- **Where:** `service_worker/background.js:363-408`
- **Repro:** open five `chrome://extensions` / Web Store / PDF-viewer tabs, then toggle a rule in
  the popup. Check the service-worker console.
- **Actual:** 3 failed `sendMessage` attempts per such tab, each followed by a `setTimeout` retry at
  1 s/2 s/3 s, and 3 warning lines each. `broadcastRetryCount` accumulates an entry per tab (cleaned
  only on `tabs.onRemoved` or on success). MV3 timers do not keep the worker alive, so late retries
  may simply never run — the retry logic is largely theatre.
- **Recommended fix:** filter `chrome.tabs.query({url: ['http://*/*','https://*/*']})` before
  broadcasting, and drop the retry ladder (content scripts request state themselves on load).
- **Confidence:** Confirmed (traced).

---

### [Low] Q-30: URL patterns are recompiled per rule per request, with no ReDoS guard

- **Where:** `src/matcher.js:24-37`; hot path `content/injected.js:145-162`
- **Repro (cost):** 40 enabled rules on a page issuing 200 XHRs → 8 000+ `new RegExp` compilations,
  and the fetch path walks the rule list twice (once in the `needsBody` pre-scan at `:145`, once in
  `findMatchingRule` at `:162`).
- **Repro (ReDoS):** rule pattern `/^(a+)+$/` and a page requesting a URL with a long run of `a`s →
  the page's main thread hangs inside the interceptor.
- **Why it happens:** no compiled-pattern cache and no complexity/length limit on the regex body
  (only a 500-char pattern length check in `validateUrlPattern`, which isn't run on save — see Q-10).
- **Recommended fix:** memoise compiled regexes keyed by pattern (invalidate on `syncState`), and
  compute `needsBody` and the match in a single pass.
- **Confidence:** Confirmed (traced). ReDoS is self-inflicted, hence Low.

---

### [Low] Q-31: Daily stats reset is a rolling 24 h and never fires if `lastReset` is unparseable

- **Where:** `service_worker/background.js:250-266`
- **Repro:** set `turboMockStats` to `{"intercepted":5}` (no `lastReset`) via the Raw Data viewer,
  then trigger an interception.
- **Actual:** `new Date(undefined)` → `Invalid Date` → `daysSinceReset` is `NaN` → `NaN >= 1` is
  `false` → the counter increments forever and never resets. Even in the healthy case the reset is
  "24 h since the last reset", not "at local midnight", so the reset boundary drifts.
- **Recommended fix:** guard with `Number.isFinite(lastReset.getTime())` and fall back to resetting;
  compare local calendar dates rather than elapsed milliseconds.
- **Confidence:** Confirmed (traced).

---

### [Nit] Q-32: Dead code that would throw if anyone required it

- `index.js` (repo root) does `require('./popup/popup.js')`, which references `document` at module
  scope (`popup/popup.js:866-871`) → `ReferenceError` under Node. It also destructures
  `TurboMockUtils` / `TurboMockStorage` from `src/index.js`, which exports neither. Nothing imports
  it; `package.json` `main` points at `manifest.json`.
- `options/options.js:1527-1534` defines `getRuleTypeLabel` / `renderRuleTypeBadge` and
  `RULE_TYPE_LABELS`, none of which are called — the options page's Rules tab has **no rule list at
  all** (`options.html:147-186` is import/export only). This is what makes Q-4 unrecoverable.
- `src/utils.js`: `importRulesFromFile`, `validateRuleStructure`, `createRuleTemplate` and
  `sanitizeInput` have zero call sites; `validateUrlPattern` is reachable only via the Test button.
- `_persistVolatile(force)`'s `force` parameter is never passed (see Q-16).
- **Confidence:** Confirmed (traced, `grep`-verified).

---

### [Nit] Q-33: XHR mock progress events are cosmetic and misleading

- **Where:** `content/injected.js:330-361`, `:387`
- `totalBytes` is hard-coded to `1000` regardless of the actual mock body size, so
  `ProgressEvent.total` is wrong for every mock and any percentage-based progress bar shows a
  fictitious value. The interval is 50 ms while the response is delivered after
  `delay > 10 ? delay : 10` — so for the common zero-delay mock **no progress event ever fires**,
  and the `readyState = 3` transition is dispatched synchronously inside `send()`, which a real XHR
  never does.
- **Recommended fix:** use `responseText.length` for `total`, and emit a single 100 % progress event
  immediately before `finishMock` rather than running an interval.
- **Confidence:** Confirmed (traced).

---

## Test coverage gaps

Current suites: `tests/matcher.test.js` (32 assertions), `tests/patch.test.js`,
`tests/dnr.test.js` (`ruleToDnr` only), `tests/dynamic.test.js`, `tests/utils.test.js`
(2 duplicated `matchUrl` cases). **Everything in `content/`, `service_worker/background.js`,
`src/storage.js`, `options/` and `popup/` is entirely untested** — which is exactly where Q-1
through Q-9 live.

### `src/matcher.js` — best-covered module, but the failure modes are missing
- `matchUrl` with a `/regex/` pattern that **contains `*`** (Q-3) — would have caught the broken
  shipped template.
- `matchUrl('anything', '/')` and `'//'` — empty regex body matching everything (Q-10).
- `matchUrl` with a `URL` object instead of a string (Q-6).
- `matchUrl` with a syntactically invalid regex, e.g. `'/[/'` — asserts the catch returns `false`.
- `findMatchingRule` where `rule.match` is missing entirely, and where `rule` is a non-object.
- `findMatchingRule` precedence: an enabled `redirect` rule listed *after* a matching `mock` rule
  (documents which one wins).
- `matchHeaders` where a request header value is a number or `null` rather than a string.
- `matchGraphQL` where `bodyText` is valid JSON but an array, or `{"operationName": null}`.

### `src/storage.js` — zero tests
- `normalizeRule` on a v1 rule with no `type` and **no `response`** (Q-5) — assert the interceptor
  contract holds.
- `normalizeRule` on `null`, a string, and a rule whose `response` is a string.
- `allocateDnrId` monotonicity, and a concurrent-allocation test with two overlapping promises
  (Q-15) — assert distinct ids.
- `saveRule` upsert-vs-insert: saving a rule whose id is absent must not silently insert (Q-19).
- `saveRules` when `chrome.storage.local.set` rejects with a QUOTA_BYTES error — assert the
  `{success:false}` shape and that in-memory state is not left inconsistent.
- `cleanOldBackups` when a backup entry has a missing/invalid `timestamp` (`new Date(undefined)`
  sorts unpredictably).

### `content/injected.js` — zero tests; highest defect density
This needs a jsdom harness with a fake `window.fetch`/`XMLHttpRequest`. Concretely missing:
- **Handler-invocation counts** for a mocked XHR: assert `onload` fires exactly once and that
  `addEventListener('load')` and `onload` agree (Q-1).
- `readystatechange` is dispatched on the `block`, chaos and timeout paths (Q-8).
- `Response` construction for statuses `204`, `304`, `100`, `599` (Q-2).
- A `mock` rule with no `response` object must not throw (Q-5).
- `fetch(new URL(...))`, `fetch(new Request(...))`, and `fetch(url, {headers: new Headers()})` all
  reach the matcher with a string URL (Q-6).
- `responseType` = `'json'` / `'blob'` / `'arraybuffer'` produce the right `response` shape (Q-7).
- Synchronous `open(..., false)` (Q-12).
- `AbortController` aborting a delayed mock rejects with `AbortError` (Q-13).
- Non-string bodies (`FormData`, `URLSearchParams`, `Blob`, `ArrayBuffer`) for GraphQL matching (Q-17).
- `syncState` from a foreign `event.source` is rejected (Q-14).
- Zero / negative / >30 000 ms `delay` and `delayMs`.
- `xhr.abort()` during the mock delay, during the `delay`-rule wait, and after completion.
- The chaos-mode branch with `failureRate` of `0` and `1`.

### `service_worker/background.js` — zero tests
- `validateRule` for each of the six rule types (Q-21) — currently every non-mock type fails.
- `_applyStatsIncrement` with `lastReset` `undefined`, a non-date string, and a future timestamp (Q-31).
- `_persistVolatile` trailing-flush behaviour under a burst of `logInterception` messages (Q-16).
- The interception-log ring buffer at exactly 200 and 201 entries.
- `setRules` with `null`, non-object and duplicate-`id` entries.
- `handleMessage` for an unknown `type` (assert the `{success:false}` envelope, not a throw).

### `service_worker/dnr.js`
- `syncDnrRules` is untested by design, but two **pure** cases are missing and cheap:
  duplicate `dnrRuleId`s in the input array, and a `queryparams` rule with both `add` and `remove`
  empty (currently emits an empty `queryTransform`, which Chrome rejects).
- `ruleToDnr` with a pattern containing `*` inside `/…/` — documents the divergence from
  `matchUrl` noted in Q-3.

### Cross-cutting integration gaps
- No test asserts that a single rule object produces **equivalent** observable behaviour over
  `fetch` and over `XHR`. Q-2 and Q-7 both come from that gap.
- No test asserts that `options.js`, `overlay.js` and `utils.createRuleTemplate` emit the *same*
  rule schema — they currently disagree (`statusText` is hard-coded `'OK'` in the overlay,
  derived in options, and `hitCount`/`testStatus` are present in some paths and not others).

## Checked and ruled out

- **`src/patch.js` (`jsonMergePatch`)** — traced against RFC 7386. Correct for nested merge, `null`
  deletion, array replacement, non-object patch replacement, and non-mutation of the input.
  Prototype pollution is not reachable: `Object.assign({}, original)` plus `Object.keys` iteration
  means a `__proto__` key in the patch becomes an own property of the copy, not a prototype write.
- **`findMatchingRule` first-match-wins with two overlapping rules** — deterministic array order,
  disabled rules skipped, `headers`/`queryparams` correctly excluded from the interceptor path
  (`matcher.js:100`). Behaves as documented.
- **Double injection of the interceptor** — `window.__TURBOMOCK_INITIALIZED__` (`injected.js:17`)
  and `window.__TURBOMOCK_OVERLAY_INITIALIZED__` (`overlay.js:18`) both guard correctly.
- **Overlay opened twice / overlay + popup interaction** — `ensureHost` is idempotent while the host
  is connected, `populate()` fully repaints every field including the type-specific groups, and
  `close()` removes the `keydown` listener it added. Escape and backdrop-click both close. (One
  latent leak: if the page removes the host node externally, `ensureHost` adds a second `keydown`
  listener — not worth a finding.)
- **Rule-type switching leaving stale fields** — both editors rebuild the rule object from scratch
  (`options.js:580-588` spreads only `...extra`; `overlay.js:438-518` likewise), so a
  `mock → redirect` switch does not carry `response` forward. `dnrRuleId` survives the switch but is
  harmless because `ruleToDnr` filters on `type` first (`dnr.js:100`).
- **Service-worker restart mid-session** — MV3 listeners are registered synchronously in the
  constructor and `handleMessage` awaits `this.ready` (`background.js:106`); `loadStoredData`
  re-broadcasts and re-syncs DNR on every cold start. Sound.
- **Rules changed while a page is open** — `broadcastState` → `content.js` → `postMessage` →
  `tmState` update works, and the interceptor reads `tmState.rules` fresh on every request.
- **Page navigation / multiple tabs / iframes** — content scripts re-run at `document_start` and
  self-request state; the overlay is correctly restricted to the top frame (`manifest.json:37`);
  `content.js:shouldInject` correctly skips `chrome://`/`about:`.
- **Redirect loops** — the fetch redirect path calls `originalFetch` (not the patched `window.fetch`)
  and the XHR path sets `redirectHandled` before `send`, so a redirect cannot re-enter the matcher.
- **`xhr.abort()` during a mocked request** — clears both `mockTimeout` and `progressInterval`, and
  every scheduled callback re-checks `isAborted`. No leaked timers. (The abort path does share the
  double-dispatch bug of Q-1.)
- **`escapeHtml` in `devtools/panel.js`** — every interpolation is escaped, including the
  `data-type` attribute. No injection there, in contrast to the popup (Q-22).
- **Storage quota warning path** — `checkQuota` runs before every `saveRules` and prunes backups at
  80 %/90 %; the QUOTA_BYTES error is caught and surfaced as a `{success:false}` message.
  Not airtight (the error string match at `storage.js:94` is brittle) but not a defect.
