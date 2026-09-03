# SpliceTap — Consolidated Review Findings

**Version reviewed:** 0.0.1 (commit `54c9381`)
**Date:** 2026-08-28
**Scope:** Full codebase, docs and store-readiness, ahead of first Chrome Web Store submission.

## Status — updated 3 September 2026

**50 of 57 closed.** Every Critical, every High, and every Medium is fixed
and verified. The report below is the original audit and is kept as written;
this section records what has changed since.

Closed in the order the analysis recommended: SEC-1, QA-1, QA-2, A11Y-1 and
A11Y-2 first (silent failure and data loss), then PROD-1, CQ-3/PROD-9,
PROD-2, then the trust and workflow tier (SEC-2, SEC-3, QA-3, CQ-4, PROD-3
through PROD-10, the A11Y set, UX-1/2/3), then the structural cleanup
(CQ-5, CQ-6, CQ-7, CQ-10, CWS-2) and the performance items PERF-2/3/5/6/9/10.

### Deliberately not fixed

**PERF-1 — content scripts ship unminified (~86 KB parsed per frame).**
Real, and the largest remaining performance item. Both available fixes cost
more than they save:

- *Minify at package time.* PERMISSIONS.md tells users the packaged build has
  "no bundler, no minifier, no transformation — what you read here is what
  ships", and points them at reading the source to verify the privacy claim.
  Minifying would make that claim false. The market analysis identified
  auditability as this product's only durable advantage over a
  better-resourced competitor; trading it for parse bytes is the wrong way
  round.
- *Inject the overlay on demand* (it is 47 KB of editor loaded on every top
  frame, and most page loads never open it). This needs the `scripting`
  permission, which the extension does not currently request. Adding a
  permission to an extension already asking for `<all_urls>` works directly
  against CWS-1's Extended Review risk, and widens the surface the trust
  pitch rests on.

Revisit if the extension ever gains `scripting` for another reason, or if
real users report page-load impact.

**CQ-9 — the ESLint config is narrow.** Accurate, and a documented trade-off
for a no-build-step extension. `no-unused-vars` structurally cannot see an
unused class method, so no config change would have caught the dead code in
CQ-5. It did catch two real mistakes during remediation (an undefined
`DOMParser`, a duplicate globals key), which is the job it is there for.

**CWS-1 — broad permissions invite Extended Review.** Not a defect. Every
permission is used and justified; the combination is what a network
interception tool requires. Mitigation is preparation, not code.

### Still open (4, all Low)

`PERF-4` unbatched per-request messages · `PERF-7` linear rule scan (fine
below ~50 rules) · `PERF-8` per-instance XHR closures · `CQ-8` no tests for
`storage.js`, `background.js` handlers or `injected.js` — partially
addressed: the shared modules now have 18 tests (59 → 77 total), but the
three highest-risk files remain untested.

---

## Method

Seven independent read-only reviewers examined the codebase in parallel, each from a
single perspective: security, Web Store compliance, QA/edge cases, performance,
accessibility & UX, code quality, and product. Each was required to cite `file:line`
and quote real code rather than speculate.

Findings marked **✅ verified** below were then re-confirmed independently, by running
the code rather than re-reading it. That mattered: it turned one theoretical ReDoS
claim into a measured 42-second browser hang, and it protected against the
false-positive classes this codebase has already produced (dynamically-built CSS class
names, methods invoked via `window.*` rather than `this.*`, and stylesheet load races
that mimic missing rules).

**57 findings: 5 Critical, 14 High, 22 Medium, 16 Low.**

---

## Verdict

The engineering here is well above what "v0.0.1" implies. The matcher, DNR sync,
placeholder engine and packaging script are careful and defensively written; 59 tests
pass; the privacy policy's specific claims hold up against the code; and the store
package provably contains only what the manifest references.

**No Web Store blocker was found — the extension is submittable today.**

But it is not yet ready to be a stranger's daily tool. Five Critical issues cause
**silent** data loss or failure — the class of bug where the UI reports success while
the work is discarded — and the single most-used editing surface (the in-page overlay)
is measurably weaker than its duplicate on validation, accessibility and data-loss
protection.

---

## Severity summary

| Area | Critical | High | Medium | Low | Total |
|---|---:|---:|---:|---:|---:|
| Security | 1 | 1 | 1 | 0 | 3 |
| QA / correctness | 2 | 1 | 3 | 1 | 7 |
| Accessibility & UX | 2 | 5 | 5 | 3 | 15 |
| Code quality | 0 | 3 | 4 | 3 | 10 |
| Product | 0 | 3 | 5 | 2 | 10 |
| Performance | 0 | 2 | 4 | 4 | 10 |
| Store compliance | 0 | 0 | 1 | 1 | 2 |
| **Total** | **5** | **14** | **22** | **16** | **57** |

---

## Cross-cutting root causes

Three underlying causes account for 16 of the 57 findings. Fixing these is worth more
than fixing their symptoms individually.

### R1 — Two hand-written rule editors that have already drifted

`options/options.js` (1,516 lines) and `content/overlay.js` (983 lines) each
independently implement schema construction, per-type field handling and validation
for all six rule types. The overlay is the **primary** surface — the popup's New rule
button, the context menu and `Alt+Shift+N` all open it, falling back to options only
on `chrome://` pages — yet it is the weaker of the two.

Confirmed divergences, all in the more-used editor:

| Behaviour | options.js | overlay.js |
|---|---|---|
| URL pattern validated | Yes | **No** — invalid patterns save silently and never fire |
| Name/URL length limits | Yes (100/500) | **No** |
| `statusText` for a mock | Derived from status code | **Hardcoded `'OK'`** — a 404 mock reports "OK" |
| Unsaved-changes guard | Yes (`ruleFormDirty`) | **No** — Escape or a backdrop click discards everything |
| Error announced to screen readers | Yes (`role="status"`) | **No** `role`/`aria-live` at all |
| Rule templates | Six presets | **None** |

**Causes findings:** CQ-1, CQ-2, PROD-3, A11Y-6, A11Y-7.

### R2 — Failures are computed, then discarded

The system detects several failure modes correctly and then throws the result away, so
the user is told everything worked.

- `saveRule`/`setRules`/`toggleRule`/`deleteRule` all ignore the storage layer's
  `{success:false}` return and unconditionally answer `{success:true}` (QA-1).
- `dnrWarning` is produced in exactly two places and **read in zero** (CQ-3 / PROD-9).
- A malformed `queryparams` rule is accepted, breaks the whole DNR batch, and reports
  success (CQ-3).
- Duplicating a headers rule collides its DNR id and silently disables **all**
  DNR-backed rules (PROD-1).

These compound: PROD-1 creates the failure, CQ-3 guarantees nobody sees it.

### R3 — Guards that don't guard, and comments that assert the opposite of the code

Several defences were added, documented, and are wrong:

- The ReDoS guard catches `(a+)+` but not `(a|a)+` — a 42-second hang (SEC-1).
- `.message-container` carries a comment saying it is "fixed-positioned above every
  modal"; it has no `position` and no `z-index`, so every rule-editor validation error
  renders **behind** the modal backdrop (A11Y-1).
- `.rule-checkbox`'s comment claims a "24×24 hit target"; it is 28×18 (A11Y-11).
- The XHR redirect path skips header matching because "G5 enforces this"; nothing
  enforces it, so `fetch` and XHR behave differently for the same rule (CQ-4).
- `popup.js` documents a theme-flash fix and names `options.html` as sharing the bug;
  the fix was never ported there (UX-1).

---

## Critical

### C1 · SEC-1 — ReDoS guard is bypassable; a rule can freeze the tab ✅ verified
**`src/matcher.js:25`, `:53`** · also unguarded at **`content/injected.js:190`**

`NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)[+*]/` only catches the `(a+)+` shape.
Measured directly:

```
(a+)+$       caught by guard: true
(a|a)+$      caught by guard: false     ← textbook ReDoS shape
(a|b|ab)+$   caught by guard: false
backtracking time for a 28-char URL: 42194 ms
```

This regex runs synchronously on **every request in every frame of every page**
(`<all_urls>`, `all_frames: true`). A single rule pattern like `/(a|a)+$/` — plausibly
arrived at by hand or via an imported rule pack — hangs the tab until force-quit.
`validateUrlPattern` only checks that the pattern *compiles*, so it saves cleanly.

**Fix:** validate by behaviour, not by shape — run the compiled regex against
adversarial probe strings under a few-millisecond budget at save time, and reject on
timeout. Shape blocklists will always be incomplete. Apply the same guard to the
second, currently unguarded `new RegExp()` at `injected.js:190`.

### C2 · QA-1 — Storage failures are reported to the user as success ✅ verified
**`service_worker/background.js:175-179`**, same pattern at `:211`, `:227`, `:237`, `:264`

```js
const savedRule = await this.storage.saveRule(ruleToSave);   // may return {success:false}
this.rules = await this.storage.getRules();
await this.broadcastState();
const dnrResult = await syncDnrRules(this.rules, this.isActive);
return { success: true, rule: savedRule, ... };              // ← always true
```

`storage.saveRule` returns `{success:false, error}` on quota exhaustion. It is never
checked. The reviewer reproduced it: with `chrome.storage.local.set` rejecting on
quota, the handler still answers `success:true`, and `options.js` shows *"Rule saved
successfully!"* and closes the editor. The rule is gone; the user finds out later.

**Fix:** propagate the storage layer's own result in all five handlers.

### C3 · QA-2 — Concurrent saves silently drop one rule ✅ reproduced by reviewer
**`src/storage.js:150-174`** (also `:176-204`)

`saveRule`/`toggleRule`/`deleteRule` are unserialized read-modify-write
(`getRules()` → mutate → `saveRules()`). Two near-simultaneous saves — popup and
options open together, a routine state — lose one:

```
saveRule('b') and saveRule('c') fired concurrently
Final stored rules: [ 'a', 'c' ]      ← 'b' silently gone, both reported success
```

The codebase already solved exactly this for DNR id allocation
(`allocateDnrIdSerialized`, `background.js:44-53`) and never applied the same fix to
the rules array itself.

**Fix:** route all rule mutations through one serialized promise chain.

### C4 · A11Y-1 — Rule-editor validation errors render behind the modal ✅ verified
**`options/options.css:624-629`** vs **`:436-441`**

```css
.modal            { position: fixed; inset: 0; z-index: 1000; background: rgba(4,8,14,.68); }
.message-container{ margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px; }
```

No `position`, no `z-index` — despite `options.js:1289` asserting it is "fixed-positioned
above every modal". Since Save lives outside the `<form>`, submission never happens
natively and the modal stays open, so every validation error ("Name is required",
"Invalid JSON") appears **behind** an opaque, blurred backdrop.

Screen-reader users are unaffected (the live region still fires) — which is precisely
why an AT-only check would miss this.

**Fix:** give `.message-container` `position: fixed` and a `z-index` above 1000, or move
the error surface inside the modal.

### C5 · A11Y-2 — Disabled rules fall below contrast minimums ✅ ratios computed
**`popup/popup.css:920-941`**

`.rule-card.disabled { opacity: 0.62 }` dims the whole row, including the "Disabled"
chip that `popup.js:492` says was added *"instead of relying on dimming"* for exactly
this reason. Composited ratios (WCAG 2.1 SC 1.4.3, needs 4.5:1):

| Element | Theme | Ratio |
|---|---|---|
| `.disabled-chip` text | dark | **2.91:1** |
| rule name / details | dark | **3.27:1** |
| rule name / details | light | **2.54:1** |
| same token, not dimmed | dark | 6.69:1 ✓ |

The correct pattern already exists 500 lines earlier in the same file
(`popup.css:402-413` dims via colour, not opacity, with a comment explaining why).

**Fix:** drop `opacity` on disabled rows; dim via contrast-checked colour tokens.

---

## High

| ID | Finding | Location |
|---|---|---|
| **SEC-2** | Any page — or any third-party iframe — can read the user's entire rule set and forge state via the unauthenticated `__splicetap_sync_state__` CustomEvent. Event name is static, payload validation is shape-only. Enables exfiltration of mock bodies and internal endpoints, and lets a hostile page disable interception for itself while the popup still shows rules as active. | `content/content.js:103`, `content/injected.js:955` |
| **QA-3** | The DevTools interception log has no tab scoping at all — no `tabId` is attached anywhere. Inspecting tab A shows requests intercepted in tab B, breaking the panel's premise and leaking between unrelated sites. | `background.js:272-296`, `devtools/panel.js` |
| **CQ-3 / PROD-9** ✅ | `dnrWarning` is produced in 2 places and consumed in **0**. A DNR sync failure is completely invisible. | `background.js:179,219` |
| **CQ-4** | A `redirect` rule's header/GraphQL match condition is honoured by `fetch` but ignored by XHR, which pre-matches on url+method only — justified by a comment whose premise is false. Same rule, same request, different outcome by API. | `content/injected.js:671-694` vs `:362-389` |
| **PROD-1** ✅ | "Duplicate" copies `dnrRuleId` verbatim; `saveRule` only allocates when absent. Enabling the copy sends two DNR rules with the same id, Chrome rejects the whole batch, and **every** headers/queryparams rule stops working. | `popup/popup.js:796-799` |
| **PROD-2** | Both privacy documents describe importing via a file picker. No `<input type="file">` exists anywhere; import is paste-only. `PRIVACY.md` also directs users to "Options → Rules → Import", which no longer exists. | `docs/privacy.html:420`, `PRIVACY.md:45` |
| **PROD-3** | README sells six rule templates as the fast path to a first mock. They exist only in options.js — and every documented way to create a rule opens the overlay, which has none. | `README.md:239`, `content/overlay.js` |
| **CQ-1** | Two full rule editors, already drifted (see R1). | `options/options.js`, `content/overlay.js` |
| **A11Y-3** | Escape unconditionally calls `window.close()`, discarding a half-pasted import JSON. options.js scopes Escape correctly; the popup does not. | `popup/popup.js:1410` |
| **A11Y-4** | `renderRules()` rebuilds via `innerHTML`; after Delete/Duplicate, focus falls to `<body>`. The DevTools panel already solved this with diff-rendering. | `popup/popup.js:433` |
| **A11Y-5** | `#statusToggle` ships `aria-pressed="true"` and nothing ever updates it — screen readers always announce "pressed", even when the label says "Disabled". WCAG 4.1.2. | `popup/popup.html:42` |
| **A11Y-6** | The overlay's error box has no `role`/`aria-live` and no `aria-invalid` — validation failures are silent for screen-reader users on the most-used editor. | `content/overlay.js:440,660` |
| **A11Y-7** | The overlay closes on Escape/backdrop with no dirty check, discarding in-progress rule JSON. options.js has this guard; the overlay never got it. | `content/overlay.js:600-604,880` |
| **PERF-1** | ~71 KB of unminified, comment-dense content script is parsed in **every frame of every page** at `document_start`. On a 20-50 iframe page that is 1.4–3.5 MB of source lexed per page load, all of it avoidable. No minifier exists in the pipeline. | `manifest.json:18-31` |
| **PERF-2** | While the DevTools panel is open it sends `getRules` every 3s — returning the **full** rules array including every mock body — to compute two integers. | `devtools/panel.js:214-223` |

---

## Medium

| ID | Finding | Location |
|---|---|---|
| SEC-3 | Page can forge interception-log entries and inflate `hitCount`; handler validates only `typeof === 'object'`. Not XSS (panel uses `textContent`), but pollutes the log a developer is trusting. | `background.js:272-294` |
| QA-4 | `{{request.url}}` is substituted into stringified JSON without escaping. A URL containing `"` breaks the JSON, `JSON.parse` throws, and the body silently ships with the literal `{{request.url}}` token. | `src/placeholders.js:71-76` |
| QA-5 | `hitCount` increments live in memory until a 1.5s throttled flush; any rule mutation in that window reloads `this.rules` from disk and discards them permanently. | `background.js:286-292` |
| QA-6 | XHR `abort()` in patch mode doesn't cancel the real in-flight request — a POST with side effects completes against the live backend after the page cancelled it. | `content/injected.js:868-913` |
| CQ-2 | `statusText` hardcoded `'OK'` in the overlay; a 404 mock reports "OK". | `content/overlay.js:770-776` |
| CQ-5 | ~1/3 of `storage.js` and ~1/2 of `utils.js`'s public surface is dead — backup/restore, quota, templates, `importRulesFromFile` — but reads as live product functionality. | `src/storage.js:299-474`, `src/utils.js` |
| CQ-6 | `escapeHtml` in 3 copies with **different** behaviour (`panel.js` also escapes `/`); `generateId` in 4 copies with 2 different id formats (`rule_` vs `item-`). | multiple |
| CQ-8 | Zero tests for `storage.js`, `background.js` message handlers, or `injected.js` — the three highest-risk files. Both CQ-3 and CQ-4 would have been caught by a `validateRule` unit test. | `tests/` |
| A11Y-8 | `role="tablist"` with no arrow-key navigation; the ARIA APG requires it. | `popup/popup.js:234-237` |
| A11Y-9 | Disclosure panels never return focus to their trigger on close. | `popup/popup.js:1244-1256` |
| A11Y-10 | Rule card is `role="listitem"` but interactive and `tabindex="0"` — AT users may not learn it's activatable. | `popup/popup.js:498` |
| UX-1 | `options.html` hardcodes `theme-dark` and applies the real theme only after an async round-trip — light-theme users get a dark flash on every open. The popup's fix was never ported. | `options/options.html:11` |
| PERF-3 | Search does a full `innerHTML` rebuild plus a `JSON.stringify` per rule on **every keystroke**, with no debounce, and re-attaches ~5 listeners per rule. | `popup/popup.js:282,930-951` |
| PERF-4 | One `sendMessage` per intercepted request, unbatched — a busy mocked page can pin the service worker awake continuously. | `content/content.js:161-176` |
| PERF-5 | O(rules) `Array.find` per intercepted request just to bump `hitCount`. | `background.js:287` |
| PERF-6 | `broadcastState()` queries **all** tabs (including `chrome://`) and sends the full rules array to each, on every rule edit. | `background.js:514-531` |
| PROD-4 | No rule reordering, though precedence is explicitly first-match-in-array-order. Only recourse is delete-and-recreate or hand-editing exported JSON. | `src/matcher.js:153-175` |
| PROD-5 | Chaos mode fails a percentage of **every request on every site**, unscoped, and is absent from README and the landing page entirely. | `content/injected.js:70` |
| PROD-6 | No passive indicator that SpliceTap is active — the icon never changes and no badge shows rule counts. For a tool that silently rewrites traffic, this is a trust gap. | `background.js:635` |
| PROD-7 | `hitCount` is tracked and persisted but rendered nowhere; per-rule confirmation requires discovering a custom DevTools panel. | `popup/popup.js` |
| PROD-8 | No bulk actions, grouping, or per-site scoping; master toggle is all-or-nothing. | popup/options |
| CWS-1 | `<all_urls>` + `declarativeNetRequestWithHostAccess` + MAIN-world injection is the documented trigger profile for Extended Review. Not a rejection cause — every permission is used and justified — but expect a longer review. | `manifest.json:7-40` |

---

## Low

| ID | Finding | Location |
|---|---|---|
| QA-7 | Mocked XHR `responseType: 'document'` returns a string, not a `Document`. | `content/injected.js:516-543` |
| CQ-7 | One stale `TODO.md` citation survived the doc cleanup. | `tests/dnr.test.js:8` |
| CQ-9 | ESLint runs 7 rules and structurally cannot catch any bug class in this review; "0 lint errors" is not a quality signal here. | `eslint.config.js:56-67` |
| CQ-10 | Two files over 1,500 lines; one 377-line function; the 30000ms delay cap is duplicated in three files, named in only one. | `options/options.js:340-717` |
| A11Y-11 | `.rule-checkbox` is 28×18px, below the WCAG 2.2 SC 2.5.8 24×24 minimum — and its own comment claims 24×24. | `popup/popup.css:974-984` |
| A11Y-12 | `<main>` carries `role="list"`, overriding the landmark; the popup has no `main` landmark. | `popup/popup.html:90` |
| UX-2 | Undo toast sits after the footer in DOM order and only pauses its timer on hover, not focus — keyboard users can't reach Undo in time. | `popup/popup.js:1540` |
| UX-3 | Required fields have no visual indicator; the only signal is a post-save error. | `options/options.html:114` |
| PERF-7 | Rule matching is a full linear scan per request with no host-prefix fast path (fine below ~50 rules). | `src/matcher.js:153-175` |
| PERF-8 | Six closures allocated per `new XMLHttpRequest()` once any rule exists, instead of prototype patching + `WeakMap`. | `content/injected.js:462-936` |
| PERF-9 | Every rule save does a full `getBytesInUse()` scan plus a separate stats get+set — 4 storage round trips per single-field change. | `src/storage.js:75-100` |
| PERF-10 | DNR diff does a `JSON.stringify` pair per rule, and `syncDnrRules` runs on every save even when no DNR-backed rule changed. | `service_worker/dnr.js:248-257` |
| PROD-10 | README says the DevTools panel polls every 2s; it is 3s. | `README.md:187` |
| CWS-2 | ~24 lines of commented-out dead JS ship inside `devtools/devtools.html`. | `devtools/devtools.html:10-34` |

---

## Recommended order

**Before submission** — silent failure and data loss, all small and contained:

1. **C1 / SEC-1** — ReDoS. A user can freeze their own browser with a legal rule.
2. **C2 / QA-1** — stop reporting storage failures as success.
3. **C3 / QA-2** — serialize rule mutations.
4. **PROD-1** — reset `dnrRuleId` on duplicate (one line).
5. **CQ-3 / PROD-9** — surface `dnrWarning` (makes #4's failure mode visible).
6. **C4 / A11Y-1** — `position: fixed` + `z-index` so validation errors are visible.
7. **C5 / A11Y-2** — remove `opacity` dimming on disabled rules.
8. **PROD-2** — correct the privacy documents; they currently describe a feature that
   does not exist, in the document reviewers read most closely.

**Shortly after** — trust and daily usability: SEC-2 (token the sync channel), QA-3
(scope the log by tab), A11Y-3/4/5, PROD-3 (templates in the overlay), PROD-6 (active
indicator).

**Then** — the structural fix: **R1**, collapsing the two rule editors into one. That
single refactor closes CQ-1, CQ-2, PROD-3, A11Y-6 and A11Y-7, and stops the drift from
recurring. Roughly 1,500 lines removed.

**Opportunistic:** PERF-1 (add minification — zero risk, largest per-page win),
PERF-2/3, and the Low table.

---

## What is already sound

Worth recording, so it isn't re-litigated:

- **No Web Store blocker.** Every declared permission is used; every privileged API has
  its permission. No `eval`, no `new Function`, no remote code, no inline scripts or
  handlers anywhere in the four extension pages.
- **Privacy claims hold.** The 200-entry cap, session-only log, "bodies never stored"
  and query-param redaction were each checked against the code and match. No telemetry
  exists — verified by repo-wide search.
- **Packaging is provably clean.** All 26 zip entries are byte-identical to source; no
  tests, docs, `node_modules` or `.git` leak in.
- **No exploitable XSS and no exploitable prototype pollution**, both checked
  empirically rather than by inspection — every `innerHTML` sink traced, and the
  merge-patch clone semantics tested in both directions.
- **The DNR header denylist is correct**, blocking CSP/HSTS/X-Frame-Options/Set-Cookie
  at both save time and build time.
- **The hot path is already well optimised** — compiled-pattern caching, zero-rule
  bail-outs, throttled persistence, DNR no-op skip, visibility-gated polling with
  diff-rendering.
- **59/59 tests pass; ESLint reports 0 errors and 0 warnings.**
