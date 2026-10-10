# SpliceTap — Persona Review (fourth pass)

**Date:** 10 October 2026 · **Build:** 0.0.1 at `6ae2dd4` (branch `V0.0.1`)
**Method:** seven reviewers, each taking one persona, tested the real unpacked extension in headless
Chrome for Testing 148 through the project's e2e harness (`tests/e2e/harness.js`). The personas
were product owner, QA edge-case tester, end-user frontend developer, compatibility tester,
security reviewer, accessibility reviewer and performance engineer. Each persona wrote its own
probes and was told to skip everything already recorded in README, PARITY.md and FINDINGS.md.

| | |
|---|---|
| Raw findings from the personas | 110 (PO 21 · QA 20 · end-user 14 · compatibility 23 · security 8 · accessibility 18 · performance 6) |
| After merging duplicates | **89**: 17 High · 39 Medium · 33 Low |
| By type | 44 functional bugs · 7 security · 3 performance · 16 accessibility · 11 UX · 5 enhancement · 3 docs |
| Items recorded as **fixed** that are not | **9** (see below) |
| High items | 15 of 17 independently re-run by the review coordinator (✔✔ below); the other two (PER-59, PER-60) are value-rated UX/enhancements whose mechanism was confirmed in the code |

How to read the status column:

- **✔✔ Re-verified:** the coordinator reproduced it with a separate probe.
- **Verified:** the persona reproduced it in headless Chrome and quoted the output.
- **Suspected:** found by reading the code only.

Where several personas found the same thing independently, every source ID is listed. Three
personas hit the top bug (PER-8) from different directions.

No code was changed in this pass. This document is the finding; fixes are a separate step.

---

## Recorded as fixed, but still broken

| ID in FINDINGS / docs | What was claimed | What the personas found | Now |
|---|---|---|---|
| **SEC-2** | Page scripts can no longer read the rule set (nonce-keyed channel) | Any page gets the nonce by replaying the ready handshake (5/5), or by wrapping a page-visible global (5/5) | PER-1, PER-2 |
| **SEC-1** | ReDoS guard rejects catastrophic patterns | `/(api\|api)+$/`, `/(-\|-)+$/`, `/(\.\|\.)+$/` pass; ×4 cost per 2 more characters | PER-3 |
| **PROD-5** | Chaos documented in README *and landing page* | README fixed; `docs/index.html` still omits Chaos and Capture and says "Response bodies never stored" | PER-87 |
| **UX-2** | Keyboard users can reach Undo in time | Focus jumps to row 1; Undo is 27 Tab presses away with 3 rules, toast lives 8 s | PER-71 |
| **UX-3** | Required fields marked | Markers were on the old options form; the R1 editor merge dropped them | PER-77 |
| **A11Y-4** | Focus no longer lost after Delete/Duplicate | Focus no longer falls to `<body>`, but goes to row 1, away from the acted-on row and from Undo | PER-71 |
| **A11Y-8** | Tablist follows the APG | Arrow keys work; all three tabs are still separate Tab stops (no roving tabindex) | PER-85 |
| **E2E-7** | Toasts no longer swallow clicks | After Import, the toast spawns under the pointer and the next Import click only dismisses it | PER-68 |
| **PERF-10** (C-16) | DNR sync skipped when nothing changed | The equality check never matches (key order), so every save and every worker wake re-registers all network rules | PER-37 |

Documentation claims that the personas showed to be wrong:

- **PARITY.md, "Execution visibility ✅".** Header and query-param rules, chaos failures and
  skipped patches never appear in hit counts or the log (PER-54).
- **PARITY.md, "Templates ✅ — each verified for its stated purpose".** The "Redirect to
  localhost" template fails for absolute URLs, its stated case (PER-9). The CORS Unblock template
  fails PUT, DELETE and credentialed requests (PER-24).
- **PARITY.md, redirect "keeps method, body and headers".** A `fetch(Request)` with a body fails
  outright (PER-11).
- **README, "anchored full-match" wildcards.** True for mock/block/delay/redirect; false for
  headers and query-param rules (PER-21).
- **README, "in all frames".** False for about:blank, srcdoc, data: and blob: frames (PER-20).
- **README, "All successful mock/patch responses carry `x-splicetap`".** False on fetch when the
  rule name has any character above U+00FF (PER-12).
- **Test gaps behind three of these.**
  - The e2e test "a page script cannot read the rule set" listened only on the unkeyed event
    names, so it could not detect PER-1 or PER-2.
  - The redirect tests (`deep-rule-types.e2e.test.js:122, :336`) use only relative URLs, and one
    asserts only that the request failed.
  - The CORS template test covers only a simple GET.

---

## High (17)

### PER-1 · Any page script can obtain the channel nonce and read every rule, including mock bodies
**Security · ✔✔ Re-verified (5/5) · SEC2-1 · reopens SEC-2**

A page script listens for `__splicetap_bootstrap__`, dispatches `__splicetap_ready__`, and
receives the nonce synchronously. It then listens on `__splicetap_sync_state__:<nonce>`. The next
rule change delivers `{active, rules, settings}` with every mock body (coordinator probe: secret
body leaked 5/5).

- **Cause:** `content/content.js` sets `readyHandled` only when a ready event arrives. When the
  injected script runs first, its ready fires before the relay listens, so the relay's ready
  listener stays armed. The first ready a page sends later makes the relay re-dispatch the
  bootstrap, nonce included.
- **Impact:** every site the developer visits can read all rules for all sites: captured real
  payloads, internal endpoint patterns, redirect targets.
- **Fix:** a single-use handover in both orders. The relay sets `readyHandled` and removes the
  listener after the first bootstrap whichever side starts. Add an e2e test that replays ready
  from the page and listens on the keyed channel.

### PER-2 · The interceptor passes all rules to page-replaceable globals on every request
**Security · ✔✔ Re-verified (5/5) · SEC2-2 · reopens SEC-2**

The injected script looks up `window.SpliceTapMatcher.findMatchingRule(tmState.rules, …)` and
`window.SpliceTapPlaceholders.processDynamicResponse(…)` at request time. A page that wraps either
one receives the full rule set on its next `fetch`; no nonce is needed.

- **Fix:** capture the functions in the interceptor's closure at `document_start`, then delete or
  freeze the globals (ideally one IIFE that publishes nothing). Capture the `JSON` and `Object`
  built-ins early too. This also removes most of the detectability in PER-7.

### PER-8 · Rules match the URL string as the page wrote it, so relative calls miss host-scoped and full-URL patterns
**Bug · ✔✔ Re-verified · PO-1, EU-1, QA2-1 (three personas independently)**

| Pattern | `fetch('/api/users')` | `fetch(absolute)` | `xhr.open('GET','/api/users')` |
|---|---|---|---|
| `*127.0.0.1:PORT*` (the editor's own prefill) | real | **mocked** | real |
| `http://127.0.0.1:PORT/api/users` (pasted from the address bar or log) | real | **mocked** | real |
| `*127.0.0.1:PORT/api/users*` | real | **mocked** | real |
| `*/api/users*` | mocked | mocked | mocked |

`fetch(new Request('/api/users'))` matches by its resolved absolute URL, so one endpoint can
match or not depending on call style. Percent-encoding and `{{request.url}}` vary the same way.
DNR-backed rules (headers, query params) see absolute URLs, so the same pattern behaves
differently by rule type.

- **Cause:** `content/injected.js:436` matches `String(resource)` and `:850` matches the raw XHR
  URL.
- **Impact:** the default first rule from "New rule", the context menu or Alt+Shift+E silently
  does nothing on a typical SPA, which calls its own API by relative URL. Test still says
  "passed" and nothing explains why.
- **Fix:** resolve with `new URL(raw, location.href).href` before matching, redirect computation
  and placeholders, in both paths. For backward compatibility, also try the raw string.

### PER-9 · A regex redirect substitutes into the source URL; absolute URLs become unparseable
**Bug · ✔✔ Re-verified · QA2-3, EU-2**

Rule `/\/api\/old\/(\d+)/` → `http://127.0.0.1:P/echo?id=$1`:

- relative `fetch('/api/old/5')` → `/echo?id=5` ✓
- absolute → `Failed to parse URL from http://127.0.0.1:Phttp://127.0.0.1:P/echo?id=5`
- XHR absolute → `open()` throws `SyntaxError` into page code

The **"Redirect to localhost" template** (`/\/(api\/.*)/` → `http://localhost:3000/$1`) sends
`https://api.staging.example.com/api/users/7` to
`https://api.staging.example.comhttp//localhost:3000/api/users/7`. That is the exact case it is
for: "point a production API at your local server".

- **Cause:** `computeRedirectUrl` does `sourceUrl.replace(regex, destination)`
  (`injected.js:286`), which keeps the unmatched prefix.
- **Fix:** build the destination from the match (`m = regex.exec(url)`, then substitute `$n` into
  the destination). Anchor the template at `^https?://[^/]+/(api/.*)`. Test with a cross-host
  absolute URL and assert where the request lands.

### PER-10 · XHR ignores first-match precedence: a redirect rule further down beats a mock or block above it
**Bug · ✔✔ Re-verified · QA2-2**

Mock `*/api/prec*` above redirect `*/api/*`: fetch returns the mock; XHR is redirected to the
real server. A block rule above the redirect is bypassed the same way.

- **Cause:** `xhr.open()` (`injected.js:872-889`) pre-scans only redirect rules and rewrites the
  URL; `send()` then skips matching because `redirectHandled` is set.
- **Impact:** axios and every other XHR client break the documented "first enabled match wins"
  contract, and hit the real backend.
- **Fix:** in `open()`, run the normal first-match over all interceptor types and redirect only
  if that first match is a redirect.

### PER-11 · A redirect rule fails every `fetch(Request)` that carries a body
**Bug · ✔✔ Re-verified · CP-2**

With a redirect rule matching, `fetch(url, {method:'POST', body})` → 200, but
`fetch(new Request(url, {method:'POST', body}))` → `TypeError: Failed to fetch`. The request
reaches no server.

- **Cause:** `new Request(newUrl, resource)` (`injected.js:503`) turns the body into a stream,
  and Chrome rejects a streaming upload over HTTP/1.1.
- **Impact:** ky, openapi-fetch and framework clients that build `Request` objects cannot have
  POST/PUT/PATCH redirected to localhost, which is the main redirect use case.
- **Fix:** for non-GET/HEAD, read `await resource.clone().arrayBuffer()` and call `fetch(newUrl,
  init)` with the request's method, headers, body, mode, credentials, cache, redirect, referrer,
  referrerPolicy, integrity, keepalive and signal.

### PER-12 · A rule name with any character above U+00FF strips every response header from fetch mocks
**Bug · ✔✔ Re-verified · QA2-4, EU-4**

429 mock with `Content-Type: text/plain` and `Retry-After: 30`, read through fetch:

| Rule name | status, content-type, retry-after, x-splicetap |
|---|---|
| `Orders 429` | `429, text/plain, 30, true` |
| `Bestellungen – 429` (en dash, as macOS and Word autocorrect type it) | `429, application/json, null, null` |
| `🚀 Orders`, CJK, Hebrew, Cyrillic | same as the en-dash row |

XHR is unaffected. A patch rule with such a name loses **all real** response headers. A header
*value* above U+00FF (`X-Note: café ☕`) does the same.

- **Cause:** `x-splicetap-rule: <rule.name>` (`injected.js:534, 568`) is not a valid ByteString,
  so `new Headers()` throws. `buildHeadersSafe` (`:349-360`) then replaces every header with
  `{Content-Type: application/json}`.
- **Fix:** encode the marker value (or send the rule id). Make `buildHeadersSafe` drop only the
  offending header. Reject or encode header values above U+00FF at the schema.

### PER-13 · XHR patch mode sends the request twice when the real response isn't JSON
**Bug · ✔✔ Re-verified · QA2-6**

A patch rule covering a POST whose response is text, or a 204: one XHR reaches the server
**twice**; the same call through fetch reaches it once.

- **Cause:** `injected.js:1132` re-fetches via `originalFetch`, `.json()` throws, and the catch
  (`:1156-1160`) calls `originalSend` again.
- **Impact:** duplicate writes against the user's real backend whenever a broad patch rule
  (`method: *`) covers a non-JSON write.
- **Fix:** on a parse failure, deliver the already-fetched response unchanged; never re-send.

### PER-14 · Subclassing `XMLHttpRequest` breaks on every page, even with SpliceTap off and no rules
**Bug · ✔✔ Re-verified · CP-1**

`class Sub extends XMLHttpRequest { hello(){} }; new Sub().hello()` → `TypeError`
(`instanceof Sub` is false). This happens with the extension switched OFF and zero rules. Without
the extension it works.

- **Cause:** the replacement constructor (`injected.js:588-595, :1186`) returns an object, and
  returning an object from a base constructor replaces `this` in a derived class.
- **Impact:** breaks any page or library that extends XHR (upload helpers, instrumentation, fake
  XHR), and the off switch does not help.
- **Fix:** `Reflect.construct(originalXHR, [], new.target || originalXHR)`, including the bail
  path, or implement the wrapper as `class extends originalXHR`.

### PER-27 · Reordering, Toggle-all and merge-import permanently delete stored rules that fail today's validator
**Bug (data loss) · ✔✔ Re-verified · QA2-5**

The coordinator's probe:

- **Stored:** `[old (120-character name, allowed by an earlier build), a, b]`.
- **Action:** "Move down" on `a`.
- **Result:** `[b, a]` with `success:true` and
  `rejected:["Rule name must be 100 characters or less"]`. No message is shown.

- **Cause:** `setRules` (`background.js:431-439`) validates and drops every rule.
  `moveRule` (`popup.js:723`) and `toggleAllRules` (`:673`) ignore `rejected`. Merge-import
  reports the dropped *existing* rules as "skipped N invalid" of the import.
- **Impact:** silent, permanent loss of user rules. Every future schema tightening re-arms it.
- **Fix:** validate only incoming or changed rules. Never drop stored rules on a bulk write.
  Surface `rejected` in every caller.

### PER-31 · One tab paused at a breakpoint freezes every rule change, and OFF keeps network rules applied
**Bug · ✔✔ Re-verified · PF-1**

With one tab paused at `debugger;`:

- `saveRule`, `toggleRule`, `toggleExtension` and `settingsUpdated` get **no response** (15 s in
  the persona's run, 8 s in the coordinator's), and complete about 2 s after the tab resumes.
- Clicking the popup's OFF switch leaves the popup showing ON with no toast, while storage says
  off. The header rule keeps being applied to requests from a *different* tab until the paused
  tab resumes.
- A tab busy for 4 s makes every save take 3.9 s.

- **Cause:** every mutation `await`s `broadcastState()`, which waits on `tabs.sendMessage` to
  every tab (`background.js:880-896`). `toggleExtension` syncs DNR only after that
  (`:369-374`).
- **Impact:** stepping through code at a breakpoint, a core developer workflow, makes the popup
  dead and the master switch ineffective.
- **Fix:** persist and sync DNR first, answer the caller, then broadcast without awaiting it, with
  a per-tab timeout. The content side already discards stale versions.

### PER-32 · Install and update lifecycle: open tabs ignore new rules, or keep old ones, with no prompt
**Bug + UX · ✔✔ Re-verified (update path) · PO-15, CP-8**

- **Install with the app already open:** the tab has no content script.
  - New rule cannot open the in-page editor and falls back to an options tab.
  - The rule saves and counts in the badge, but the app keeps getting real responses until
    reloaded (persona: `fetchBeforeReload {real:true}`, `fetchAfterReload {mocked:true}`).
- **Extension reload or update:** an already-open tab **keeps mocking with the old rules**.
  - After OFF succeeds, the old tab is still mocked while a fresh tab is not (coordinator re-run).
  - The orphaned relay throws an uncaught "Extension context invalidated" on each log flush.

- **Impact:**
  - The first run (install, then try it on the open app) fails.
  - After every auto-update, the popup can say OFF while open tabs serve mock data.
- **Fix:**
  - In the popup, detect a missing content script (ping, or the "Receiving end does not exist"
    error) and show "Reload this tab [Reload]". No new permission is needed.
  - In `content.js`, hold a `runtime.connect()` port. On disconnect, dispatch a nonce-keyed
    *deactivate* so the interceptor goes inactive.
  - Guard `sendMessage` with `chrome.runtime?.id`.
  - Document "reload open tabs after install or update".

### PER-59 · New, duplicated and captured rules are appended at the bottom, where an earlier broad rule shadows them
**Enhancement · High value · Verified · PO-4** (mechanism confirmed: `storage.saveRule` pushes unknown ids to the end)

With `*/api/*` present, a new `*/api/users*` rule never fires, and Test still says passed.
Duplicates also land at the very end rather than under their original, and so do captured rules.

- **Fix:**
  - On save, detect an earlier enabled interceptor rule with a compatible method that matches the
    new rule's sample URL. Warn inline with a "Move above it" button.
  - Add "Move to top" (and drag and drop).
  - Place duplicates directly below their original.
  - Show "shadowed by X" on the card.

### PER-60 · Capture → rule stops halfway
**UX · High value · Verified · PO-11** (mechanism confirmed: `createRuleFromCapture` sets `enabled:false`, patch `{}`)

After clicking Mock or Patch on a capture:

- the user stays on the Data tab and recording stays armed;
- the new rule is disabled, at the bottom, and Patch looks identical to Mock;
- the Patch rule is `{}`, and the captured body the README promises "showing you which fields
  exist to change" is never shown.

It takes about 8 more steps to get a working rule. Related: on an array response, `{}` wipes the
body (PER-19), and the capture buttons all share the same accessible names (PER-82).

- **Fix:**
  - Open the editor on the new rule, pre-filled, with the captured JSON as a read-only reference
    beside the patch.
  - Offer "Stop recording".
  - Give patch rules a distinct badge.

### PER-71 · Undo after Delete is unreachable by keyboard in time
**Accessibility · ✔✔ Re-verified · AX-1 · reopens UX-2, A11Y-4**

After Enter on "Delete Rule 3" (4 rules), focus goes to row 1. Undo is **27 Tab presses** away
(8 stops per row), and the toast lives 8.4 s, pausing only once it has focus. Delete has no
confirmation, so Undo is the only way back. Duplicate shares the same focus logic
(`restoreListFocus`, `popup.js:617`).

- **Fix:**
  - Move focus to Undo when the toast appears, or announce a Ctrl+Z shortcut.
  - Don't auto-dismiss toasts that carry an action.
  - After Delete or Duplicate, focus the neighbouring row.

WCAG 2.2.1, 2.4.3.

### PER-72 · The popup is cut off and cannot scroll at 200% and 400% zoom
**Accessibility · ✔✔ Re-verified · AX-2**

Popup at 400×300 CSS px, which is Chrome's popup cap at 200% zoom:

- `body{height:560px; overflow:hidden}` (`popup.css:109-116`); the wheel leaves `scrollTop` at 0;
- New rule sits at y=521, off-screen, as do Toggle all, Test all and Refresh;
- at 400% the right half is cut off as well;
- all text is in px.

- **Fix:** put `max-height:600px; overflow-y:auto` on the app container, let the footer wrap, and
  use rem.

WCAG 1.4.4, 1.4.10.

### PER-73 · In-page editor text follows the host page's root font size
**Accessibility · ✔✔ Re-verified · AX-3**

On a page with `html{font-size:62.5%}` (a very common reset) the editor renders:

- labels at 6.25 px
- the URL input at 7.8 px
- hints at 6.9 px

On a plain page the same elements are 10, 12.5 and 11 px.

- **Cause:** the shadow stylesheet uses `rem`, which resolves against the host `<html>`;
  `:host{all:initial}` cannot isolate it.
- **Fix:** set a fixed base on the panel and use `em`, or px.

---

## Medium (39)

### Security

**PER-3 · ReDoS guard bypass, so SEC-1 is still open.**
*✔✔ Re-verified for the three-character case (SEC2-3, in Node against the shipped schema and
matcher); the punctuation cases were Verified by QA · SEC2-3, QA2-10.*

- **Accepted patterns:**
  - repeated units of three or more characters: `/(api|api)+$/`, `/(xyz|xyz)+$/`;
  - punctuation: `/(-|-)+$/`, `/(\.|\.)+$/`, `/(_|_)+$/`, `/(\/|\/)+$/`.
- **Measured cost:** a saved `/(-|-)+$/` block rule kept the main thread busy 17, 49, 174 and
  671 ms at 20, 22, 24 and 26 dashes, about 11 s at 30.
- **Cause:** the probes use single alphanumeric runs plus one two-character alternation
  (`matcher.js:38-72`).
- **Fix:** build probes from the pattern's own literals and alternation branches, plus
  punctuation and class representatives. Better, a backtracking limit or a runtime watchdog that
  demotes slow patterns.

**PER-4 · URL redaction misses common secret parameters.** *Verified · SEC2-4.*

- **Redacted:** only exact names such as `token`.
- **Leaked:** `session_id`, `sessionid`, `JSESSIONID`, `id_token`, `refresh_token`,
  `access-token`, `code`, `client_secret`, `jwt`, `X-Amz-Signature`, `sig`, `user[token]`,
  `#access_token=` and `/reset/<token>`. These reach the log and captures.
- **Fix:** match by name component, strip fragments, and soften the PRIVACY.md and
  PERMISSIONS.md wording to "best effort".

**PER-5 · Imported rules take effect immediately and take precedence over the user's own rules.**
*Verified · SEC2-5, EU-6, PO-5.*

- **Placement:** with "Keep existing rules" (the default), imports are placed *before* existing
  rules and keep their own `enabled` flag. In the end-user probe, a teammate's broad
  `*/api/users*` mock immediately replaced the user's own fixture.
- **Schema:** the validator accepts credentialed CORS for a foreign origin on `*`
  (`Access-Control-Allow-Origin: https://other.example` with `Allow-Credentials: true`), removing
  `Origin` or `Referrer-Policy`, and redirect-everything-to-another-host. Any of these can arrive
  in a shared pack.
- **Fix:**
  - Append imports after existing rules, or ask.
  - Import disabled, or show a review step that flags risky rules.
  - Refuse `Allow-Credentials: true` unless the URL is host-scoped.

### Interception correctness

| ID | Finding | Sources | Status | Cause / fix |
|---|---|---|---|---|
| PER-15 | Reusing an XHR after a mocked response returns the old mock. `open()` reports readyState 4 and the mock status, and a later real load shows the mock body and URL. A mock pending while `open()` is called again fires a second `load` with the abandoned body. | CP-3, QA2-7 | Verified | Own-property overrides (`injected.js:654-658, 690, 734-738`) are never deleted in `open()`. Delete them, clear timers and reset flags in `open()`. |
| PER-16 | Mocked XHRs never fire `xhr.upload` events. Real: loadstart, progress, load, loadend. Mocked: none. Upload progress UIs stay at 0%. | CP-4, EU-10 | Verified | Dispatch the four upload events, sized to the body, before readyState 2. For block and chaos, dispatch upload `error` and `loadend`. |
| PER-17 | A delay rule doesn't count toward the XHR timeout. axios `timeout:1000` against a 3 s delay *succeeds* at 3009 ms (a static mock with `delay` times out correctly). The "Slow Request" template therefore can't test timeouts. | EU-5 | Verified | Honour `xhr.timeout` during the hold: fire readystatechange 4, then `timeout` and `loadend`. |
| PER-18 | A patch rule holds back streaming responses until the stream ends. With an SSE patch rule, six chunks arrive together at 1870 ms instead of 312…1869 ms; a stream that never ends is never delivered. | CP-5 | Verified | `await real.clone().json()` (`injected.js:515`). Patch only `application/json` and `*+json`. (Suspected side issue: with Capture armed, an endless text stream is read without bound.) |
| PER-19 | Patch mode wipes array-root responses: patch `{}` on `[1,2,3]` serves `{}`. Capture → Patch creates exactly this rule, and the schema forbids array patches. | QA2-8 | Verified | Treat an empty patch as a no-op. Refuse object patches on non-object roots, or support them. Don't offer Patch for array captures. |
| PER-20 | about:blank (synchronous and later), srcdoc, data: and blob: iframes, and `window.open('about:blank')`, bypass every mock, block, delay and redirect rule. Header rules still apply there. | CP-6 | Verified | Add `match_about_blank` and `match_origin_as_fallback`; allow `about:` in `shouldInject` (`content.js:308`). Correct the README's "all frames". |
| PER-21 | Header and query-param wildcards are not anchored: `*/echo` also matches `/echo?x=1` and `/echo/sub`, unlike every other rule type. | CP-10, QA2-11 | Verified | `dnr.js:50` passes the pattern as an unanchored `urlFilter`, where `\|` and `^` are special. Compile to an anchored `regexFilter`, or add `\|` anchors. |
| PER-22 | A wildcard redirect sends `$1` literally (the server receives `GET /$1`), or collapses every path to one URL. It saves with no warning; Requestly users expect `*` to capture. | EU-3 | Verified | Make `*` a capture group, or reject `$n` in the destination for non-regex patterns. |
| PER-23 | GraphQL `operationName` misses batched arrays, persisted-query GET (`?operationName=`) and Relay-style bodies without the field. GET plus operationName is refused with no hint. | EU-7 | Verified | `matchGraphQL` (`matcher.js:213-223`). Match any element of an array, read GET query strings, and parse the operation name from `query`. |
| PER-24 | The CORS Unblock template fails PUT and DELETE (the preflight fails) and credentialed requests. | CP-9 | Verified (spec-consistent; see environment note) | `templates.js:102-105` sets only Allow-Origin and Allow-Headers. Add `Access-Control-Allow-Methods`, and document the credentialed limits. |
| PER-25 | Wrongly typed fields pass validation and then misbehave. `statusCode:"404"` makes fetch serve 200 "Not Found" while XHR serves the string "404"; `"201abc"` is stored; `delay:"300ms"` gives about 0 ms; `enabled:"false"` intercepts but displays as enabled. | QA2-12 | Verified | `rule-schema.js:132, :292` parse with `parseInt` but store the original; `enabled` is never type-checked. Require integers and booleans, or coerce at the boundary. |
| PER-26 | The editor turns an empty body into `{}`, including on an unrelated edit: rename a rule serving `""` and it now serves `{}`. An empty 200 can't be authored. | QA2-9 | Verified | `readBody` (`rule-editor.js:869-870`) should return `''` for empty text. |

### Data integrity

| ID | Finding | Sources | Status | Fix |
|---|---|---|---|---|
| PER-28 | Duplicate ids survive a replace-mode import. Toggle affects only the first, and Delete removes both. | QA2-13 | Verified | Re-issue duplicate ids in `setRules`. |
| PER-29 | Undo after Delete restores the rule at the bottom, so precedence silently changes. | PO-3 | Verified | Remember the index and restore through `setRules` at that position. |

### Lifecycle and performance

**PER-33 · One rule Chrome refuses makes every service-worker wake clear and re-add all network
rules, one call each.** *Verified, mechanism confirmed in code · PF-2.*

- **Measured, 300 header rules plus 1 refused:**
  - `setRules` takes 1812 ms (107 ms without the bad rule);
  - the first message after a cold start is answered in 1669 ms (34 ms without it);
  - the registered rule count dips to 14 of 300 during the re-sync.
- **Measured, 1005 regex rules:** 1007 `updateDynamicRules` calls, 15.4 s.
- **Cause:** the fallback (`dnr.js:211-227`) removes everything and then adds rules one at a time.
  `knownRejected` is a module-level Map, lost each time the worker idles out, and PER-37 means
  the skip never applies.
- **Fix:** persist rejections in `storage.session`, isolate by bisection, and never clear the live
  set before the replacement is known good.

**PER-34 · Every frame receives every rule, including disabled rules' mock bodies.**
*Verified · PF-3.*

- **Measured, page with 20 iframes:**
  - retained heap is 17 MB with 0 rules and 58 MB with 2 MB of mock bodies;
  - it stays at 58 MB with **all rules disabled**, and reaches 120 MB with 5 MB of bodies;
  - the load event goes from 222 to 318 ms.
- **Measured, broadcast:** one save with 2 MB of rules to 15 tabs costs 328 ms.
- **Impact:** this also widens what PER-1 and PER-2 expose.
- **Fix:** send only enabled interceptor rules, and fetch mock bodies lazily on first match.

### Visibility and debugging

| ID | Finding | Sources | Status | Fix |
|---|---|---|---|---|
| PER-54 | Header and query-param rules never appear in hit counts or the log, though they apply on the wire (3/3 applied, hitCount 0, log 0). Chaos failures and patches skipped on non-JSON leave no trace. The panel's own "Headers" filter is always empty. | PO-8 | ✔✔ Re-verified (rated Medium; PO said High) | Log chaos and patch-skip as entries. For DNR rules, either say "Applied by Chrome — check the Network tab" or use `getMatchedRules`. Correct PARITY.md. |
| PER-55 | A rule that doesn't work gives no signal why. "Test" is a re-run of the save-time validation, so it always says passed, even for a rule that misses 3 of 4 calls or is fully shadowed. The result vanishes when the popup closes, debug mode is silent on misses, the editor defaults the method to GET, and the placeholder `*/api/users/*` doesn't match `/api/users`. | PO-16, EU-8 | Verified | Replace the indicator with live evidence ("N hits · 2 m ago" / "No hits yet"). Rename the action "Check syntax". Log near-misses in debug mode. Fix the placeholder. |
| PER-56 | The DevTools panel mislabels outcomes: a working redirect shows as a red "302", a finished delay stays "pending", and "0% 2xx" appears when everything succeeded. | PO-9 | Verified | Log the final status and elapsed time on completion, and use a neutral style for redirects. |
| PER-57 | *Enhancement:* from a log row you can't open or disable the rule, or see what was served. | PO-10 | Verified | Make the rule name open the editor (`?editRule=`), add a detail drawer, and add "Disable this rule". |
| PER-58 | *Enhancement:* the popup names the site but shows global numbers. Add "This tab: N intercepted" and put rules that can match this host first. | PO-19 | Verified | The log already records `tabId`. |

### Rule authoring workflow

| ID | Finding | Sources | Status | Fix |
|---|---|---|---|---|
| PER-61 | The first-rule path. The only required field is the name; the URL defaults to the whole host and the body to `{}`, enabled. Saving in the in-page editor gives no confirmation: no toast, no live region, and focus goes to `<body>`. The empty state has no buttons. | PO-2, AX-8 | Verified | Make the URL a placeholder the user must confirm, warn on whole-origin static mocks, show an in-page "Saved" toast with a live region, and add Create and Record buttons to the empty state. |
| PER-62 | Import semantics. Re-importing duplicates every rule; "skipped N invalid" is a 3-second green toast with no names or reasons (the background already returns them); replace mode deletes all rules with no confirmation or undo; exports carry `hitCount`. | PO-5, PO-6, EU-6, AX-12 | Verified | De-duplicate by content, list skipped rules persistently with their errors, label the option "Replace all N rules" and confirm, and strip runtime fields on export. |
| PER-63 | A draft in the in-page editor is lost when the dev server reloads the page, with no `beforeunload` prompt. | EU-9 | Verified | Mirror the form to `storage.session` per tab and offer to restore it. |
| PER-64 | Three header fields take three JSON shapes: an object, an op array, and comma-separated for query removal. `{"X-Debug":"1"}` in a headers rule fails with no example of the expected shape. | PO-17 | Verified | Key/value row editors, accept the object shorthand, and show an example in each error. |
| PER-65 | *Enhancement:* changing a rule's type deletes its body on save, with no warning and no undo. | PO-13 | Verified | Warn before discarding, offer "Undo edit", and keep the last few versions. |
| PER-66 | *Enhancement:* there is no way to vary a response across calls ("fail once, then succeed", "every 3rd poll fails"), so retry and backoff can't be tested. | EU-12 | Verified | `match.times` / `nth` or a `responses[]` sequence with per-rule counters. |

### Accessibility

| ID | Finding | Sources | Status | Fix |
|---|---|---|---|---|
| PER-74 | Switch states are invisible. In forced colors, Capture, Chaos and Debug look identical on and off. In the light theme, an enabled rule's switch matches a disabled one because `body.theme-light .rule-checkbox::before` out-specifies `.checked`. | AX-4, PO-20 | Verified | Add forced-colors styles (Highlight track) and `body.theme-light .rule-checkbox.checked::before { background: var(--accent) }`. |
| PER-75 | The popup search box has no focus indicator in forced colors (`outline:none`, and the replacement indicator is removed). | AX-5 | Verified | Add `.search-bar:focus-within { outline: 2px solid Highlight }`. |
| PER-76 | A rule row keeps the "Disabled" chip after being enabled, and gets none when disabled. | AX-6 | Verified | Update the chip in `toggleRule` (`popup.js:913-919`). |
| PER-77 | Required fields are unmarked and errors aren't tied to their fields. Focus stays on Save after a failed save. Reopens UX-3. | AX-7 | Verified | `aria-required` plus a visible marker; per-field `aria-invalid` and `aria-describedby`; focus the first invalid field. |
| PER-78 | On an RTL host page, the English editor and its URL and JSON fields render right-to-left (braces mirrored). | AX-9 | Verified | `dir="ltr"` on the panel (`rule-editor.js:96`). |
| PER-79 | DevTools panel at 320 px: the URL column collapses to 0 px wide, one character per line. | AX-10 | Verified | Use a stacked row layout below about 480 px. |
| PER-80 | DevTools panel: focus is lost after dismissing a row; every dismiss button has the same name; Pause reads as "Resume, pressed". | AX-11 | Verified | Refocus the adjacent row, name buttons by URL, and use a fixed label with `aria-pressed`. |

### Docs

| ID | Finding | Sources | Status | Fix |
|---|---|---|---|---|
| PER-87 | The landing page contradicts the product. It says "Response bodies never stored" (Capture stores them); "Every applied rule" is shown (false per PER-54); it lists 59 unit tests (now 312); it gives two different install statuses and "Chrome or Edge 120+"; and it never mentions Chaos or Capture. Reopens PROD-5. | PO-18 | Verified | Fix before Web Store submission: a false privacy claim is a review risk. |
| PER-88 | What each rule type can reach is undocumented and inconsistent. fetch and XHR from Workers, SharedWorkers and Service Workers, `sendBeacon`, `EventSource` and `WebSocket` all bypass mock and block. Header rules do reach Workers, Service Workers and EventSource, but not beacon or WebSocket. | CP-7, EU-11 | Verified | Add a reach table to Known Limitations, and consider the `ping` resource type for DNR. |

---

## Low (33)

| ID | Finding | Sources | Status |
|---|---|---|---|
| PER-6 | Background handlers have no sender checks: any content-script frame can call getRules, getCaptures, setRules or resetAll. The background trusts page-side size limits, and `...entry` keeps uncapped extra fields. Exploiting this needs a compromised renderer or PER-1. | SEC2-6, SEC2-7 | Suspected |
| PER-7 | Pages can detect the extension: `window.SpliceTap*` globals, `__SPLICETAP_INITIALIZED__`, a non-native XHR (toString, empty `name`, callable without `new`), and the `x-splicetap-rule` header, which exposes rule names. | SEC2-8, CP-17 | Verified |
| PER-30 | Mock bodies nested deeper than about 96 levels are silently truncated to `{}` on save. | QA2-14 | Verified |
| PER-35 | A prerendered page activated after a rule change runs the old rules for about 0.5–1 s. | CP-19 | Verified |
| PER-36 | Above 500 distinct patterns, the FIFO pattern cache misses every lookup: per-request cost goes from 30 µs to 2.7 ms (regex), and 1000 parallel fetches from 340 ms to 3.2 s. | PF-4 | Verified (mechanism `matcher.js:18, 151-155`) |
| PER-37 | The DNR "skip if unchanged" check never matches: Chrome returns keys in a different order and the comparison uses `JSON.stringify`. It also ignores `regexFilter`, a latent stale-rule bug once the order is fixed. Reopens PERF-10. | QA2-18, PF-5 | Verified |
| PER-38 | Each GraphQL rule re-parses the request body: 36 ms per request with 50 rules and a 565 KB body. | PF-6 | Verified |
| PER-39 | Calling `abort()` on a finished mocked XHR fires `abort` and a second `loadend`; an in-flight abort skips readyState 4. | CP-11 | Verified |
| PER-40 | Mocked XML and HTML responses have `responseXML === null`. | CP-12 | Verified |
| PER-41 | Patched responses keep the original `Content-Length` and `Content-Encoding`. Patch merge loses `__proto__` keys. | CP-13, QA2-15 | Verified |
| PER-42 | Mocked fetch responses differ from real ones: `clone()` loses `url`; `type` is "default"; a HEAD mock returns a body; a 3xx mock ignores `redirect`; a `no-cors` mock is readable. | CP-14 | Verified |
| PER-43 | A page that freezes `XMLHttpRequest.prototype` silently disables XHR mocking. | CP-15 | Verified |
| PER-44 | Headers a page adds in a prototype `send()` patch (CSRF, auth) are invisible to `match.headers` for XHR. | CP-16 | Verified |
| PER-45 | A delay rule drops `keepalive` requests sent during unload. | CP-18 | Verified |
| PER-46 | `xhr.open(m, u, undefined)` is treated as async; native XHR treats it as synchronous. | CP-20 | Verified |
| PER-47 | On Trusted Types pages, a mocked `responseType 'document'` returns a string and causes a policy violation. | CP-21 | Verified |
| PER-48 | Chaos mode fails `blob:` and `data:` fetches, which are not network requests. | CP-22 | Verified |
| PER-49 | `/regex/flags` patterns save silently and never match. | QA2-16 | Verified |
| PER-50 | Number fields are parsed with `parseInt`: a delay of `2e3` saves as 2 ms. | QA2-17 | Verified |
| PER-51 | Conflicting header operations in one rule are accepted, and only the first applies. | QA2-19 | Verified |
| PER-52 | 1xx statuses are accepted, and fetch and XHR disagree on bodies for 1xx/204/304. | QA2-20 | Verified |
| PER-53 | "Intercepted (all time)" resets daily and can read lower than "this buffer". | PO-12 | Verified |
| PER-67 | "Mock this request" (context menu) targets no request: it opens a blank editor for the whole host. | PO-21, EU-14 | Verified |
| PER-68 | After Import, the toast sits under the pointer and swallows the next Import click. Reopens E2E-7. | EU-13 | Verified |
| PER-69 | The header says "No rules" when rules exist but all are disabled. | PO-7 | Verified |
| PER-70 | Long rule names and URLs are truncated with no tooltip, and the response summary is pushed out. | PO-14 | Verified |
| PER-81 | An error toast is announced twice (the alert plus the `#liveRegion` mirror), its accessible name is "Click to dismiss", and it can't be dismissed by keyboard. | AX-13 | Verified (double announcement inferred) |
| PER-82 | Capture buttons are all named "Mock" and "Patch", with no request named. | AX-14 | Verified |
| PER-83 | The Reset confirmation shows for 0.6 s, then the popup reloads and focus is lost. | AX-15 | Verified |
| PER-84 | Editor "Press Escape again" has a hidden 4-second window. | AX-16 | Verified |
| PER-85 | All three popup tabs are separate Tab stops (no roving tabindex). Reopens A11Y-8 in part. | AX-17 | Verified |
| PER-86 | Editor hints aren't linked with `aria-describedby`; the search clear button is 23×23 px, under 24×24. | AX-18 | Verified |
| PER-89 | README:275 misstates the XHR patch re-fetch: it uses `withCredentials`-dependent credentials and forwards headers. | CP-23 | Verified |

---

## Prioritised roadmap

**Tier 0: before anything else ships (security and data loss)**

1. **PER-1 and PER-2.** Close both routes to the rule set, and add an e2e test that listens on the
   *keyed* channel and wraps the globals.
2. **PER-27.** Never drop stored rules on a bulk write.

**Tier 1: core interception correctness (one interceptor pass)**

3. **PER-8.** Match the absolute URL. This is the single highest-impact fix: three personas hit it
   on their first try.
4. **PER-9, PER-22, PER-11 and PER-10.** Redirect semantics: whole-URL substitution, wildcard
   captures, `Request` bodies, and precedence in XHR `open()`.
5. **PER-12 and PER-13.** Encode the rule-name header; never re-send on patch failure.
6. **PER-14 with PER-7 and PER-43.** A class-based XHR wrapper fixes subclassing, nativeness and
   frozen prototypes together.
7. **PER-31 and PER-32.** Don't await broadcasts; handle install, update and orphaned tabs.

**Tier 2: confidence and first run**

8. **PER-87.** Correct the landing page before store submission.
9. **PER-59, PER-29 and PER-55.** Shadowing warning, Undo at the original position, and live
   evidence instead of an always-green Test.
10. **PER-54 and PER-56.** Make the log tell the whole truth.
11. **PER-60 and PER-61.** Capture → editor handoff, and safer first-rule defaults.
12. **PER-71, PER-72 and PER-73.** The High accessibility items.

**Tier 3: the remaining Medium items, then Low.** Group them by file: the XHR fidelity set
(PER-15/16/17/39/40/46) in one `injected.js` pass; the schema set (PER-25/50/51/52/49) in one
`rule-schema.js` pass; the DNR set (PER-21/33/37) in one `dnr.js` pass.

---

## Environment notes

- **Kaspersky web protection** on the test machine injects an `x-kl-saas-ajax-request` header into
  page requests, which forces CORS preflights, and adds its own script. No finding depends on
  that header. PER-24's PUT/DELETE and credentialed failures follow from the CORS spec: no
  `Allow-Methods`, and `*` with credentials.
- **A second local agent** ("AvNs") wraps `window.fetch` on every page, so `fetch.toString()`
  results were not used as evidence. It also buffers `text/event-stream`, so PER-18 was measured
  through a page service worker.
- **The performance persona** finished all eleven probes but hit the account's usage limit before
  writing them up. The coordinator wrote PER-31 and PER-33 to PER-38 from its raw output, checked
  each against the code, and re-ran PER-31 independently.

## Checked and found sound

- **Security:**
  - the S-3 header denylist rejects case, space and lookalike variants;
  - there are no `web_accessible_resources` and no `externally_connectable`;
  - page-supplied fields are escaped when rendered;
  - Capture → rule copies only `Content-Type`;
  - Reset clears session storage.
- **Accessibility:**
  - focus rings meet 3:1 in both themes;
  - the editor traps focus, closes on Escape, returns focus and restores `inert`;
  - reduced motion is honoured;
  - rule-row targets are 24×24 px.
- **Interception:**
  - token-refresh flows via `match.headers`;
  - 429 with `Retry-After` (ASCII names);
  - AbortController timeouts on mocks and delays;
  - 16 hot reloads with 0 wrong outcomes;
  - 3 tabs agree immediately after a toggle;
  - 1500 mocked calls with exact stats;
  - surviving worker idle;
  - full-URL regex redirects with cookies, preflight and `withCredentials`;
  - sandboxed iframes;
  - bfcache restore;
  - fetch wrappers added after SpliceTap;
  - a fetch polyfill built on XHR;
  - `ReadableStream` request bodies;
  - `getAllResponseHeaders()` format.
- **Data and DNR:**
  - type change headers → mock cleans up DNR;
  - concurrent network-rule toggles (5/5 consistent);
  - 2000-rule import in 91 ms and popup render in 480 ms;
  - query params with spaces, unicode, `=` and `&`;
  - query-param rules keep the POST body;
  - first message after a clean cold start in 13–34 ms;
  - interception overhead within noise up to 300 rules.
