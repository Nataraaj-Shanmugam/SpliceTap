# Code Quality & Maintainability Audit — SpliceTap

_Reviewer lens: maintainability, duplication, testability. Method: static review of 33 files — 22 JS files (6,517 LOC), `manifest.json`, `package.json`, 2 CSS files (1,445 LOC) and 7 HTML files. Test suite executed (`npx jest`: 5 suites, 51 tests, all passing). Branch `V1` @ `9921ee9`._

## Summary

SpliceTap is in decent shape for a no-build-step vanilla extension. The pure core (`src/matcher.js`, `src/patch.js`, `src/placeholders.js`, `service_worker/dnr.js`) is well-factored, well-commented, and genuinely tested. The problems are all at the seams where the parallel work streams met.

Highest leverage first:

1. **The v2 rule schema has no definition — only five implementations of it.** It is *constructed* in two places (`options/options.js:311`, `content/overlay.js:429`), *validated* in four (`options.js:311`, `overlay.js:429`, `background.js:292`, `utils.js:389`), *normalized* in one (`storage.js:117`) and *labelled* in four. They have already drifted: `background.js validateRule` still requires `rule.response`, so the popup's **Test** and **Test All** buttons report "failed" for every `block`/`delay`/`redirect`/`headers`/`queryparams` rule (Q-2). A single `src/rule-schema.js` fixes Q-1, Q-2 and a chunk of Q-12 at once, and is immediately unit-testable via the existing `src/index.js` seam. **This is the one change to make.**
2. **Two rule editors that agree on nothing but the field names.** ~430 LOC of validation/schema logic duplicated between the options modal and the Shadow-DOM overlay, with five verified behavioural divergences (Q-1), plus a bulk-write path in `options.js` that can silently delete rules created by the other editor (Q-3).
3. **Nothing that touches `chrome.*` or the DOM is testable, and the structural reasons are small and fixable.** `new SpliceTapStorage()` throws under Jest because of one line in the constructor; `background.js` self-instantiates at module scope; the entire interceptor is one anonymous IIFE. Three surgical changes open up ~1,600 LOC to testing (Q-4).
4. **`npm run lint` is `echo 'Linting would go here'`** — it exits 0. Any CI you add will pass a lint gate that does nothing (Q-10).

Two things are worth stating up front because they run counter to the usual advice: **do not add a bundler**, and **do not run Prettier across the repo**. The UMD/ESM split is a deliberate, documented response to real constraints and it works. See _Explicitly fine as-is_.

## Module system map

| File | Pattern | Consumed by | Notes |
|---|---|---|---|
| `src/matcher.js` | UMD (`module.exports` + `global.SpliceTapMatcher`) | manifest MAIN-world script; `src/index.js`; `injected.js` via `window.` | Coherent. The tri-load comment at `:3-5` earns its keep. |
| `src/patch.js` | UMD | same | Coherent. |
| `src/placeholders.js` | UMD | same | Coherent. |
| `service_worker/dnr.js` | UMD (no manifest entry) | `background.js:14` side-effect `import` + `globalThis.SpliceTapDnr:16`; `tests/dnr.test.js` | Coherent; the *why* is documented at `dnr.js:7-15`. |
| `src/storage.js` | ESM (`export class`) + `window` global at `:518` | `background.js:9` only | The `window` fallback is dead — no HTML page loads this file. |
| `src/utils.js` | ESM (`export class`) + `window` global at `:420` | `background.js:10` (2 of 19 statics); `tests/browser_test.html:17` (**broken**, Q-13) | Weakest link. See Q-6. |
| `src/index.js` | CommonJS re-export | 4 of 5 test files | **Sensible seam — keep.** Correctly re-exports only the require-able UMD trio. |
| `index.js` (root) | CommonJS | nothing | **Broken.** See Q-7. |
| `service_worker/background.js` | ESM (`"type": "module"` in manifest) | Chrome | Self-instantiates at `:496`; not importable by a test. |
| `content/injected.js` | IIFE, MAIN world | Chrome | No exports at all. |
| `content/content.js` | IIFE, ISOLATED | Chrome | — |
| `content/overlay.js` | IIFE, ISOLATED | Chrome | — |
| `popup/popup.js` | Classic script, implicit global | `popup.html:97` | No `module.exports` despite root `index.js` requiring it. |
| `options/options.js` | Classic script, implicit global | `options.html:475` | — |
| `devtools/devtools.js`, `devtools/panel.js` | IIFE, classic script | `<script src>` | `panel.js:3-6` documents why. Correct. |
| `scripts/validate-manifest.js` | CommonJS | `npm run validate` (never invoked by anything) | — |

**Is it coherent?** The *UMD tier* is coherent and deliberate — four files, one pattern, each carrying a comment explaining the constraint. The *ESM tier* (`storage.js`, `utils.js`) is coherent only because exactly one consumer exists. Everything else is ambient globals.

**What breaks if someone adds a file?** The failure mode is silent and depends entirely on which directory it lands in:
- A new file in `src/` written as ESM cannot be `require`d by Jest and cannot be added to `src/index.js` — it is untestable by construction. Nothing warns you.
- A new file in `src/` written as UMD works everywhere, but you must remember to add it to `src/index.js` *and* to `manifest.json:22`'s ordered array *before* `content/injected.js`. Miss the ordering and `injected.js:51-62`'s readiness guard silently disables all interception for the page — it logs one `console.error` on a page nobody is watching.
- A new page script must be classic; an accidental `export` yields a `SyntaxError` at load. This has already happened once — `tests/browser_test.html:17` (Q-13).

**Recommendation:** write this down as a 12-line `src/README.md` (or a comment block at the top of `src/index.js`) stating the three tiers and the manifest-ordering rule. Cheaper and more durable than any config change.

## Findings

### [High] Q-1: Two independent rule editors with divergent validation and schema construction

- **Where:** `options/options.js:152-275` (`openRuleEditor`, 124 LOC), `:280-304` (visibility, 25 LOC), `:311-639` (`saveRuleFromEditor`, 329 LOC) vs `content/overlay.js:387-423` (`populate`, 37 LOC), `:352-364` (`applyTypeVisibility`, 13 LOC), `:429-525` (`collect`, 97 LOC).
- **What:** Both build the same v2 rule object from the same eight logical field groups. They are not copies — they are independent reimplementations, and they already disagree:

  | Behaviour | `options.js` | `overlay.js` |
  |---|---|---|
  | Name length cap | 100 (`:327`) | none |
  | URL length cap | 500 (`:340`) | none |
  | `statusText` | `getStatusText(status)` (`:435`) | hardcoded `'OK'` (`:477`) — a 404 mock is stored as "404 OK" |
  | Header-op shape check | `op ∈ {set,remove}` + non-empty `name` (`:526-531`) | none |
  | Query-param `key` check | non-empty required (`:564`) | none |
  | §1.7 forbidden-match guard | checks the **original** rule (`:354-358`), rejects the save | checks the **newly built** rule (`:520`) — **unreachable**, see below |
  | Generated id prefix | `item-…` (`:1518`) | `rule_…` (`:439`) |
  | Persist verb | `setRules` (bulk) | `saveRule` (single) |

  The overlay's §1.7 guard is dead code: `rule.match.headers` and `rule.match.graphql` are assigned only inside the `type === 'mock'` branch (`overlay.js:458`, `:465`), while `dnrBacked` is true only for `headers`/`queryparams` (`:454`). The condition at `:520` can never be true. Editing an imported `headers` rule that carries a stale `match.headers` **silently drops** the condition in the overlay, while `options.js` correctly refuses the save.
- **Maintenance cost:** Every future schema change is two edits in two languages of expression (DOM `getElementById` chains vs Shadow-DOM `$()` chains), and every divergence is invisible until a user reports "it works in the popup editor but not the settings page." There are already six.
- **Recommended fix:** Extract `src/rule-schema.js` (UMD, so both an ISOLATED content script and a classic page script can load it, and Jest can `require` it via `src/index.js`). Export:
  - `RULE_TYPES` — `[{ value, label, dnrBacked, fields }]`, replacing four separate label maps.
  - `buildRule(values, existingRule)` → `{ rule }` or throws `ValidationError` — a **pure function over a plain values object**, no DOM. `options.js` and `overlay.js` each keep only their DOM-reading `gatherValues()` (~30 LOC each) and their own error presentation.
  - `validateRule(rule)` → `{ valid, errors[] }` — consumed by `background.js:292` too (Q-2).
  - `getStatusText(code)` — one map (Q-12).

  Net: ~430 LOC of duplicated logic collapses to ~180 LOC of shared, tested code plus two thin DOM adapters. Do `buildRule` first; the visibility/populate logic can stay duplicated (it is genuinely DOM-shaped and only ~50 LOC each).
- **Effort:** M
- **Confidence:** High

### [High] Q-2: The v2 rule schema exists only as tribal knowledge; `background.js validateRule` has already drifted out of sync

- **Where:** `service_worker/background.js:292-358`; also `src/utils.js:389-416`, `src/storage.js:117-130`, `options/options.js:645-652`.
- **What:** There are **four** rule validators and no schema definition. `background.js validateRule` is still the v1 shape:
  ```js
  if (!rule.response) {
      errors.push('Response configuration is required');
  }
  ```
  (`background.js:314-316`). In the v2 schema only `type: 'mock'` rules have a `response` (see `overlay.js:456-495` and `popup.js:236-257`, both of which correctly guard on it). `popup.js:476` (**Test**) and `:583` (**Test All**) route every rule through this handler, so testing any `block`, `delay`, `redirect`, `headers` or `queryparams` rule always reports failure — and `testAllRules` counts them into the "N failed" toast. A user's only feedback mechanism tells them their working rules are broken.

  Meanwhile `src/utils.js:389-416 validateRuleStructure` is a *fifth* variant (also v1-only, also requires `response.statusText`) with **zero callers anywhere in the repo**, and `options.js:645-652 validateRuleForEditing` is a sixth that correctly handles v2 — the only one that does.
- **Maintenance cost:** Adding a seventh rule type means finding and updating six validators, three label maps, one normalizer and one DNR mapper, with nothing to tell you when you have missed one. You will miss one — this finding *is* that having already happened.
- **Recommended fix:** Make `src/rule-schema.js` (Q-1) the single definition and have `background.js:292` delegate to its `validateRule`. Delete `utils.js:389-416` outright (no callers). Keep `storage.js normalizeRule` as the migration layer but move the shape constants it references into the schema module.
- **Effort:** M (S if done as part of Q-1)
- **Confidence:** High

### [High] Q-3: `options.js` bulk-writes a rule array it read once and never refreshes

- **Where:** `options/options.js:44` (single `loadData()` call), `:769-787` (direct `chrome.storage.local.get`), `:622` and `:1204` (`sendMessage({ type: 'setRules', rules: this.rules })`).
- **What:** `OptionsManager.loadData()` runs exactly once, at construction, reading `spliceTapRules` **directly from storage** — bypassing both the background's authoritative in-memory copy and `storage.js normalizeRule`. `this.rules` is then never re-read: there is no `chrome.storage.onChanged` listener anywhere in the codebase (verified: zero occurrences), and no `syncState` listener on the options page. Every save posts the whole stale array with `setRules`, which `background.js:140-161` treats as a full replace.

  So: open the options tab, then create a rule via the popup/overlay/context menu (all of which use `saveRule`), then save anything in the options tab — the new rule is gone. The window is unbounded; an options tab left open all day accumulates arbitrary staleness.
- **Maintenance cost:** Intermittent, unreproducible "my rule disappeared" reports. This is the most expensive class of bug to diagnose because the failing action (options save) is unrelated to the lost data.
- **Recommended fix:** Two lines of principle, small in practice: (a) `options.js loadData()` should go through `chrome.runtime.sendMessage({ type: 'getRules' })` like `popup.js:44` does, so there is one read path; (b) add a `chrome.runtime.onMessage` listener for the `syncState` broadcast the background already sends (`background.js:363-380`) and refresh `this.rules` from it. If you want the minimum: re-fetch rules immediately before building the `setRules` payload and merge by id. Longer term, `setRules` as a bulk-replace verb is the hazard — prefer `saveRule`/`deleteRule` for single-rule edits and reserve `setRules` for import.
- **Effort:** S
- **Confidence:** High

### [High] Q-4: The interceptor and background logic are structurally untestable, for three small and separable reasons

- **Where:** `content/injected.js:15-619`, `service_worker/background.js:496`, `src/storage.js:43`.
- **What:** 51 tests cover four pure modules (~409 LOC). The remaining ~6,100 LOC has zero coverage, and not because nobody wrote tests — because it cannot be loaded:

  1. **`src/storage.js:43`** — `this.QUOTA_BYTES = chrome.storage.local.QUOTA_BYTES || 10485760;` runs in the constructor. Under Jest, `chrome` is undefined, so `new SpliceTapStorage()` throws `ReferenceError` before any method can be reached. **26 methods** blocked by one line.
  2. **`service_worker/background.js:496`** — `const backgroundService = new SpliceTapBackground();` at module scope, and the constructor registers four `chrome.*` listeners (`:46-48`). Importing the module for a test is impossible; the class is not exported (only the instance, at `:499`).
  3. **`content/injected.js`** — a single 605-line IIFE with no exports. The XHR patch (`:252-590`) is a 334-line closure with six pieces of mutable per-request state (`:257-266`); the `send` override alone is 124 LOC (`:453-576`).

- **Maintenance cost:** The three highest-risk behaviours in the product — redirect URL rewriting with `$1..$9` capture groups, the XHR mock lifecycle (readyState/progress/timeout/abort ordering), and patch-mode fallback — are exactly the parts with no test. `computeRedirectUrl` (`injected.js:88-99`) is a pure 12-line function implementing capture-group substitution and it has never been executed by a test.
- **Recommended fix:** Named seams, in ascending cost, each independently shippable:
  - **Seam A (S, do today):** move `computeRedirectUrl` (`injected.js:88-99`) and `collectHeadersInto` (`:101-115`) into `src/matcher.js`. Both are pure. `injected.js` already reads that module off `window`. Add ~15 tests; cost is one afternoon and it covers the redirect regex path.
  - **Seam B (S):** in `src/storage.js:43`, make quota lazy — `get QUOTA_BYTES() { return (typeof chrome !== 'undefined' && chrome?.storage?.local?.QUOTA_BYTES) || 10485760; }` — and accept an optional backend in the constructor (`constructor(backend = chrome.storage.local)`). A ~25-line in-memory fake then exercises all 26 methods, including the backup rotation in `cleanOldBackups:352-379` which is currently untested and does date arithmetic on user data.
  - **Seam C (S):** `export class SpliceTapBackground` from `background.js` and guard the instantiation at `:496` with `if (typeof chrome !== 'undefined' && chrome.runtime)`. This makes `validateRule:292` and `_applyStatsIncrement:250` (the daily-reset boundary logic — off-by-one bugs live here) directly testable.
  - **Seam D (M, only if the interceptor keeps growing):** extract `src/interceptor.js` exporting `createInterceptor({ originalFetch, OriginalXHR, matcher, placeholders, patch, postMessage, getState })`. `injected.js` becomes a ~25-line bootstrap. jsdom plus a fake `originalFetch` then covers all five rule-type branches and both response modes.
- **Effort:** S per seam (A–C), M for D
- **Confidence:** High

### [Medium] Q-5: `OptionsManager` is a god object; `saveRuleFromEditor` is the worst single function in the repo

- **Where:** `options/options.js:30-1520` — 48 methods, 1,490 LOC.
- **What:** Measured worst offenders across the repo:

  | Function | Location | LOC | Distinct responsibilities |
  |---|---|---|---|
  | `saveRuleFromEditor` | `options.js:311-639` | **329** | DOM read, 12 validations, 6 type branches, schema construction, local-array merge, IPC, UI feedback |
  | `handleMessage` | `background.js:101-242` | 142 | 13-case router, storage, broadcast, DNR sync, stats |
  | `openRuleEditor` | `options.js:152-275` | 124 | form reset (20 sequential `getElementById().value =`), validation, 5 type branches, populate |
  | `xhr.send` override | `injected.js:453-576` | 124 | chaos, redirect passthrough, matching, 4 type branches, 2 response modes |
  | `applyTemplate` | `options.js:657-758` | 102 | 6 template literals + 20 guarded DOM writes |
  | `collect` | `overlay.js:429-525` | 97 | (duplicate of `saveRuleFromEditor`, Q-1) |
  | `setupEventListeners` | `options.js:812-905` | 94 | 20 unrelated wirings |

  `OptionsManager`'s responsibility list: settings CRUD, shortcuts CRUD, rules CRUD, rule-editor form, templates, theme system, tab navigation, modals, confirmations, import/export (settings **and** rules), the stored-data viewer, statistics, autosave, keyboard shortcuts, performance monitoring, listener lifecycle. `SpliceTapPopup` (39 methods, 866 LOC) is better-behaved — its longest method is 48 LOC — and needs no restructuring beyond Q-12's shared helpers.
- **Maintenance cost:** `saveRuleFromEditor` has 14 early-`return` exit points interleaved with mutation of `match` and `extra`. Adding a field means finding the right one of six branches and the right point in the return chain. It is the function most likely to acquire a bug on next edit.
- **Recommended fix:** Q-1 removes ~200 LOC from `saveRuleFromEditor` by delegating validation + construction to `buildRule`; what remains is `gatherValues()` → `buildRule()` → `persist()`, about 60 LOC. That is sufficient — do **not** split `OptionsManager` into classes. If you want one more cheap win, move `applyTemplate`'s six template objects (`:658-702`) into a `RULE_TEMPLATES` const beside the schema module and let it merge generically; that deletes ~60 LOC of guarded DOM writes and also retires the unused `SpliceTapUtils.createRuleTemplate` (`utils.js:277-351`, a seventh template set).
- **Effort:** M (mostly subsumed by Q-1)
- **Confidence:** High

### [Medium] Q-6: `src/utils.js` no longer pulls its weight and two of its methods are landmines in the service worker

- **Where:** `src/utils.js:1-422` (19 static methods, 421 LOC).
- **What:** After the delegation refactor, the only production consumer is `background.js`, which uses exactly **two** methods: `validateUrlPattern` (`:304`) and `validateStatusCode` (`:318`). The other 17 have no production callers. Worse, two of them are actively dangerous in their only importing context:
  ```js
  static matchUrl(url, pattern) {
      return window.SpliceTapMatcher.matchUrl(url, pattern);   // utils.js:59
  }
  static processDynamicResponse(body, requestDetails = {}) {
      return window.SpliceTapPlaceholders.processDynamicResponse(body, requestDetails);  // utils.js:360
  }
  ```
  There is no `window` in an MV3 service worker, and `SpliceTapMatcher` is not loaded there. Both throw `ReferenceError` on first call. The comments at `:55-57` and `:354-357` describe them as kept "for backward compatibility with existing callers" — there are no existing callers. `escapeHtml` (`:113`) and `exportRules` (`:214`) likewise use `document`.

  The file's `window` global export at `:420-422` is also dead: no HTML page loads `src/utils.js` (the one that tries is broken — Q-13).
- **Maintenance cost:** The next person who needs URL matching in `background.js` will reach for the `SpliceTapUtils` already imported at line 10, call `.matchUrl`, and get a runtime crash in the service worker — the hardest context in the extension to debug.
- **Recommended fix:** Reduce `src/utils.js` to the two validators actually used and move it to UMD so it joins `src/index.js` and gets tested (`validateUrlPattern` has real regex-construction logic worth covering). Delete `matchUrl:58-60`, `processDynamicResponse:359-361`, `validateRuleStructure:389-416`, `createRuleTemplate:277-351`, and the `window` block at `:420-422`. Move `getStatusText:91-111` into the schema module (Q-1 needs it). Move `formatFileSize`, `formatTimestamp`, `escapeHtml`, `debounce`, `deepClone`, `parseHeaders`, `createDataUrl`, `exportRules`, `importRulesFromFile`, `validateJSON`, `sanitizeInput`, `generateId` — all currently unused — to wherever a real caller appears, or delete them. That is ~330 of 421 LOC removed.
- **Effort:** S
- **Confidence:** High

### [Medium] Q-7: Root `index.js` is broken in two independent ways and is referenced by nothing

- **Where:** `index.js:1-8`.
- **What:**
  ```js
  const SpliceTapPopup = require('./popup/popup.js');                       // :1
  const { SpliceTapUtils, SpliceTapStorage } = require('./src/index.js');   // :2
  ```
  `popup/popup.js` has no `module.exports`, so line 1 yields `{}` — and executing it under Node runs `document.readyState` at `popup.js:866`, throwing `ReferenceError: document is not defined`. Line 2 destructures two names that `src/index.js` does not export (it exports `SpliceTapPlaceholders`, `SpliceTapMatcher`, `SpliceTapPatch`) — both would be `undefined` even if line 1 survived. `package.json:5` declares `"main": "manifest.json"`, so this file is not even the package entry point.
- **Maintenance cost:** It is a decoy. It reads as "the module map of this project" and is the first file a new contributor opens. It is also the kind of file a future `npm test` glob or CI step will happily try to load and then fail on cryptically.
- **Recommended fix:** Delete `index.js`. `src/index.js` is the real, working, correct seam — keep it and let it be the only one.
- **Effort:** S
- **Confidence:** High

### [Medium] Q-8: `TODO.md` — the normative spec cited by 27 code comments across 13 files — is not in version control

- **Where:** `TODO.md` (untracked; `git ls-files --error-unmatch TODO.md` → *did not match any file known to git*). Citations in `src/index.js:3`, `src/matcher.js:5`, `src/patch.js:5`, `src/placeholders.js:5`, `src/storage.js:113`, `src/utils.js:55,355`, `service_worker/dnr.js:5,8`, `service_worker/background.js:31,246,248`, `content/overlay.js:427,453`, `options/options.js:149,278,295,307,349,591,1523`, `devtools/devtools.js:8`, `devtools/panel.js:10`, `tests/dnr.test.js:7`.
- **What:** Comments throughout the codebase defer to `TODO.md §1.1` (the v2 rule schema), `§1.3` (the module-loading contract), `§1.5` (the interception log pipeline), `§1.7` and `§G5.3` (which match conditions each rule type may express), `§G4.1`–`§G4.4`. These are the *only* written record of the schema and the module rules — and a fresh clone does not contain the file. `changes.txt` (22 KB) is likewise untracked. Neither is in `.gitignore`; they were simply never added.
- **Maintenance cost:** This is the mechanism by which Q-2 happened and by which it will happen again. Every constraint the code says is documented is, from the repository's point of view, undocumented. It also means `git log` cannot explain any of these decisions.
- **Recommended fix:** Either `git add TODO.md` (fastest), or — better, and it composes with Q-1 — promote the two sections the code actually cites into durable homes: `§1.1`/`§1.7` become JSDoc on `src/rule-schema.js`, `§1.3` becomes the `src/README.md` from the module-map section above. Then the comments can cite a file that ships. Decide about `changes.txt` explicitly (track it or delete it) rather than leaving it in limbo.
- **Effort:** S
- **Confidence:** High

### [Medium] Q-9: Dead code, dead DOM references, and dead configuration

Verified by cross-referencing every `getElementById` against the page HTML and every declared name against its call sites.

- **Where / What:**
  - `popup/popup.js:130` and `:133` call `this.renderSettings()` and `this.renderAbout()`. **Neither method exists** on `SpliceTapPopup`. Unreachable today only because `this.currentView` (`:13`) is never reassigned — the `switch` at `:125` always takes the `'rules'` branch. Any future line setting `currentView` produces an instant `TypeError`.
  - `options/options.js:1527-1534` — `getRuleTypeLabel` and `renderRuleTypeBadge`: **zero callers.** `options.html` has no rules list (the Rules tab is import/export cards only, `options.html:146-182`), so the badge is never rendered there. The matching `body.theme-light .rule-type-badge[data-type=…]` rules at `options.css:91-96` are dead alongside them.
  - `options/options.js:9` — `ANIMATION_DELAY`: declared, never referenced.
  - `options/options.js` writes to **six element ids absent from `options.html`**: `totalRulesCount`, `enabledRulesCount`, `rulesDataSize`, `metricsDataSize` (`:1239-1259`) and `toggleShortcut`, `newRuleShortcut` (`:1009-1013`). All guarded by `if (element)`, so `loadStatistics()` is ~25 LOC that computes values and discards them.
  - `maxResponseSize` and `cacheSize` have no input in `options.html` at all, yet appear in `getDefaultSettings:789`, `setupEventListeners:875,889`, `updateUI:1001`, `collectSettingsFromUI:1113` and `validateSettings:1461-1473`. Settings with validation, persistence and listeners — and no way to set them.
  - `settings.chaosMode` is read by the interceptor at `injected.js:127` and `:461` and defaulted in `storage.js:29-32`, but **no UI anywhere sets it** (verified across all JS and HTML). Additionally `options.js getDefaultSettings:789-799` omits `chaosMode` entirely while `options.js:1078` writes `spliceTapSettings` directly — so an options-page save drops the key, and the subsequent `settingsUpdated` round-trip through `storage.js saveSettings:260` restores it to the *default* (disabled). Chaos mode is unreachable and would be silently reset even if it weren't.
  - `storage.js:15` `chaos: 'spliceTapChaos'` — key never read or written. `:14` `metrics: 'spliceTapMetrics'` — read by `loadAll:57`, never written by anything.
  - `manifest.json:61-76` declares two `commands` (`toggle-extension`, `new-rule`) with suggested keybindings. There is **no `chrome.commands.onCommand` listener anywhere** in the codebase (verified: zero occurrences). Both shortcuts appear in Chrome's shortcut UI and do nothing.
  - `options.js:1078-1081` writes `spliceTapSettings` directly *and* `:1084` sends `settingsUpdated`, which makes `background.js:207` write the same key again. Two writers, one key, no ordering guarantee.
- **Maintenance cost:** Individually trivial; collectively this is why nobody trusts the file. Roughly 120 LOC of code that looks live, reads as live, and does nothing — plus two user-visible features (keyboard shortcuts, chaos mode) that appear to exist.
- **Recommended fix:** Delete the unreachable code (`popup.js:129-134` branches, `options.js:9,1527-1534`, the six phantom element writes, `storage.js:15`). For the three that are *features missing their other half* — `commands`, `chaosMode`, `maxResponseSize`/`cacheSize` — decide per item: wire it up or remove the remnant. Do not leave them half-present. `commands` is ~15 LOC in `background.js` to finish.
- **Effort:** S
- **Confidence:** High

### [Medium] Q-10: No linter, no formatter, no CI, no type checking — and `npm run lint` lies

- **Where:** `package.json:11`, absence of `.eslintrc*` / `eslint.config.*` / `.prettierrc` / `jsconfig.json` / `tsconfig.json` / `.github/`.
- **What:** `"lint": "echo 'Linting would go here'"` exits 0. `npm run validate` (`scripts/validate-manifest.js`, a genuinely useful 126-line checker) is wired up but invoked by nothing. `npm run build` chains `test && package`, where `package` shells out to `zip` — not present on the stated dev platform (win32). No workflow file exists, so nothing runs on push.
- **Maintenance cost:** Every finding in Q-9 is a class of bug that a five-minute config change catches mechanically, forever. See the ranked table below for exactly which tool catches which.
- **Recommended fix:** See _Recommended tooling_. Start with ESLint + a real `lint` script + a 15-line CI workflow.
- **Effort:** S
- **Confidence:** High

### [Medium] Q-11: Error handling uses four conventions with no rule for which applies where

- **Where:** repo-wide. Measured: 92 `catch` blocks, 60 `console.error`, 19 `{ success: false }` returns, 28 `throw new Error`.
- **What:** Four coexisting styles, and the boundary between them is not predictable:
  1. **Return `{ success: false, error }`** — `src/storage.js` (16 of 21 catches), `background.js:95,240`.
  2. **Log and return a fallback** — `storage.js:61` (returns defaults), `:108` (returns `[]`), `:224` (returns `true`), `matcher.js:39` (returns `false`).
  3. **Throw** — `overlay.js` (13 throws, all user-facing validation, caught at `:531`), `background.js` (6, caught by its own `:238`).
  4. **Swallow with a comment** — 10 sites, listed below.

  The predictability problem is concrete: `storage.saveRule` (`:150-174`) returns **the rule** on success and **`{success:false, error}`** on failure — two different shapes. Its caller `background.js:133` assigns that to `savedRule` and returns `{ success: true, rule: savedRule }` regardless, so a storage failure is reported to the popup as `success: true` with a `{success:false}` object in the `rule` field. Similarly `storage.js:61 loadAll` swallows a storage read failure and returns empty defaults; `background.js:57` cannot distinguish "no rules yet" from "storage is broken," and the user sees an empty rule list with no error.

  The comment-only catches — `injected.js:155`, `overlay.js:571`, `background.js:73,230,283,442`, `popup.js:434`, `options.js:459,1348` — are mostly *legitimate* and well-commented (`// session storage unavailable — non-fatal`, `// No content script on this page`). Two are not: `overlay.js:571` swallows any failure of the `getRules` round-trip, so an unreachable background silently yields a dark-themed editor rather than an error; `options.js:1348` swallows the `clearRules` message during **factory reset**, meaning a failed DNR teardown leaves live network rules behind with the UI reporting "Factory reset completed!" (`:1354`).
- **Maintenance cost:** Callers cannot tell success from failure without reading the callee. Real failures surface as empty states, which read as "no data" and get triaged as feature requests.
- **Recommended fix:** Adopt one rule and write it in `src/README.md`: **`src/*` and `service_worker/*` return `{ ok, value?, error? }` and never log; UI layers (`popup`, `options`, `overlay`, `devtools`) catch, log, and present.** Then fix the two concrete cases: make `storage.saveRule` return the uniform shape and have `background.js:133` check it; make `options.js factoryReset` surface a failed `clearRules` instead of claiming success. Leave the well-commented non-fatal swallows alone — they are correct and documented.
- **Effort:** M (S for just the two concrete bugs)
- **Confidence:** High

### [Low] Q-12: Small utilities reimplemented 2–5 times, sometimes with different semantics

- **Where:** see the duplication report below.
- **What:** `generateId` ×5 (`utils.js:8`, `storage.js:512`, `popup.js:853` — all three byte-identical; `options.js:1517` with an `item-` prefix; `overlay.js:439` inline with `slice` instead of `substr`). `escapeHtml` ×3 (`utils.js:113`, `popup.js:837`, `panel.js:38`) — same `div.textContent` trick. `formatBytes`/`formatFileSize` ×2 (`storage.js:501`, `utils.js:149`) — identical bodies, different names. `getStatusText` ×2 (`utils.js:91` with 35 codes, `options.js:760` with 9) plus `overlay.js:477`'s hardcoded `'OK'`. `applyTheme` ×3 (`popup.js:77`, `options.js:1040`, `overlay.js:563`) — the `theme === 'auto' ? matchMedia(…) : theme` resolution is identical in all three; only the application target differs. Rule-type labels ×4 (`options.js:21`, `popup.js:219`, `overlay.js:29`, and `panel.js:168` which renders the **raw** type — DevTools shows `queryparams` where the popup shows `Query Params`).

  The one that is genuinely a hazard: `deepClone` exists twice with **different semantics** — `utils.js:120-135` is a recursive clone that preserves `Date` objects; `popup.js:846-848` is `JSON.parse(JSON.stringify(obj))`, which converts `Date` to string and drops `undefined`. Same name, same apparent contract, different behaviour. `popup.js copyRule:448` uses the JSON one on rules carrying `created`/`lastModified` — harmless today only because those are already ISO strings.
- **Maintenance cost:** Low individually. The `deepClone` name collision and the DevTools label mismatch are the two that will actually bite.
- **Recommended fix:** The rule-type labels and `getStatusText` come free with Q-1's schema module — do those. Rename `popup.js deepClone` → `cloneViaJSON` (or delete it and use `structuredClone`, available in Chrome 120+ per `manifest.json:77`). Have `panel.js:168` import the label map. Leave `escapeHtml` and `generateId` duplicated unless a shared module already exists in that context — three lines each, and forcing a module dependency on `devtools/panel.js` to save three lines is a bad trade.
- **Effort:** S
- **Confidence:** High

### [Low] Q-13: Both manual browser test harnesses are broken and have been for a while

- **Where:** `tests/browser_test.html:17`, `tests/simulation.html:85`.
- **What:** `browser_test.html:17` is `<script src="../src/utils.js"></script>` — a classic-script tag loading a file whose first statement is `export class SpliceTapUtils` (`utils.js:7`). That is a `SyntaxError`; `window.SpliceTapUtils` is never assigned, and every handler in the page (`:49`, `:63`, `:69`) throws `SpliceTapUtils is not defined`. `simulation.html:85` loads `../content/injected.js` as its only script — but `injected.js:51-62` requires `SpliceTapPlaceholders`, `SpliceTapMatcher` and `SpliceTapPatch` to be present first (they are loaded ahead of it by `manifest.json:22`). The guard trips, interception is disabled, and the simulation exercises nothing but the unpatched `fetch`.
- **Maintenance cost:** Two files that present as a manual QA safety net and provide none. Worse, `simulation.html` fails *silently* — it looks like it ran.
- **Recommended fix:** `browser_test.html` — either delete it (Q-6 removes most of what it tests anyway) or point it at the UMD modules it can actually load. `simulation.html` — add the three prerequisite `<script src>` tags in manifest order before `injected.js`. Two-line fix; do it, because this is the only harness that exercises the interceptor at all until Seam D lands.
- **Effort:** S
- **Confidence:** High

### [Low] Q-14: `jest-environment-jsdom` is installed but no Jest configuration exists

- **Where:** `package.json:38`; no `jest` key in `package.json`, no `jest.config.*` file.
- **What:** Jest 30 defaults to the `node` environment. The jsdom environment is a declared dependency that nothing selects. The five current suites are pure and don't need it — but the first person to write a DOM test (which Q-4's Seams B and D both invite) will hit `document is not defined` and have to work out why the dependency that is right there isn't being used.
- **Recommended fix:** Add a five-line `jest.config.js` with `testEnvironment: 'node'` as the default and a `projects`/`testEnvironmentOptions` override — or simply the `@jest-environment jsdom` docblock convention documented in a comment. Also set `collectCoverageFrom: ['src/**/*.js', 'service_worker/dnr.js']` so coverage is measurable against the modules that can actually be covered.
- **Effort:** S
- **Confidence:** High

### [Nit] Q-15: Stale comments, stale docs, misleading names

- **Where / What:**
  - `service_worker/background.js:5-6` — "Interception logic has moved to content/content.js (Monkey Patching)". It moved to `content/injected.js`; `content.js` is a pure relay (its own header at `:4-8` says so). Points a reader at the wrong file.
  - `CONTRIBUTING.md:54` — `node tests/test-extension.js`. No such file exists. `:60-69` promises Unit/Integration/Extension/Performance test categories and "All new features must include tests"; only unit tests exist, for four modules.
  - `options/options.js:5` — "FIXED: Race conditions, validation, cleanup, duplicate code"; also `:110`, `:148`, `:1017`, `:1066` (`FIXED:` prefixes). These describe a past editing session, not the code. Of the four claims in the header, "duplicate code" is contradicted by Q-1 and Q-12.
  - `popup/popup.js:2` — "Fixed version with working navigation" — the navigation it refers to is `renderSettings`/`renderAbout`, which do not exist (Q-9).
  - `src/utils.js:55-57` and `:354-357` — "Kept here as a thin wrapper for backward compatibility with existing callers." There are no callers (Q-6).
  - `.gitignore` is boilerplate from an unrelated stack: `next-env.d.ts`, `/.next/`, `chainlit.md`, `.chainlit`, `agenthub/agents/youtube/db`, `android-sdk/`, `venv/`, `dump.rdb`. Nothing extension-specific. (`**/*.zip` does usefully cover `npm run package`'s output.)
  - `popup.js deepClone` vs `utils.js deepClone` — same name, different semantics (Q-12).
  - Whitespace: 57 lines with trailing whitespace across 5 files (`storage.js` 14, `popup.js` 14, `options.js` 13, `utils.js` 9, `background.js` 7). JS indentation is consistently 4-space everywhere — **this is fine**. CSS/HTML is split: `popup.css`/`popup.html` 2-space, `options.css`/`options.html` 4-space.
- **Recommended fix:** Delete the `FIXED:`/"Fixed version" prefixes (git history is the changelog). Correct `background.js:5-6`. Fix or remove the `CONTRIBUTING.md` test section — a contributor guide that describes tests that do not exist is worse than one that admits the gap. Replace `.gitignore` with ~15 relevant lines. Whitespace and CSS indent: let `.editorconfig` handle it going forward, do not bulk-reformat (see below).
- **Effort:** S
- **Confidence:** High

## Duplication report

| Concept | Locations | LOC duplicated | Proposed home |
|---|---|---|---|
| v2 rule construction + validation | `options.js:311-639` (329) · `overlay.js:429-525` (97) | **~426** (≈180 after extraction) | `src/rule-schema.js` → `buildRule(values, existing)` |
| Rule-editor form population | `options.js:152-275` (124) · `overlay.js:387-423` (37) | ~161 | Leave duplicated — genuinely DOM-shaped; low churn |
| Type-visibility toggling | `options.js:280-304` (25) · `overlay.js:352-364` (13) | ~38 | Leave duplicated (different DOM roots) |
| Rule-editor markup | `options.html:288-466` (179) · `overlay.js:177-308` (131) | ~310 | Leave duplicated — Shadow DOM needs self-contained markup |
| Rule-type label map | `options.js:21-28` · `popup.js:219-226` · `overlay.js:29-36` · `panel.js:168` (unlabelled) | ~26 | `src/rule-schema.js` → `RULE_TYPES` |
| Rule-type badge markup | `options.js:1531-1534` (**dead**) · `popup.js:217-229` · `panel.js:168` | ~18 | `src/rule-schema.js` → `renderTypeBadge(type)`; delete the dead one |
| Rule validation | `options.js:311-639` · `overlay.js:429-525` · `background.js:292-358` · `utils.js:389-416` (**dead**) | ~100 (validators only) | `src/rule-schema.js` → `validateRule(rule)`; delete `utils.js:389-416` |
| `applyTheme` / theme resolution | `popup.js:77-85` · `options.js:1040-1051` · `overlay.js:563-574` | ~33 (≈12 truly identical) | `src/theme.js` → `resolveTheme(setting)`; keep the 3 application sites |
| `getStatusText` | `utils.js:91-111` (35 codes) · `options.js:760-767` (9) · `overlay.js:477` (hardcoded) | ~29 | `src/rule-schema.js` |
| `generateId` | `utils.js:8-10` · `storage.js:512-514` · `popup.js:853-855` · `options.js:1517-1519` · `overlay.js:439` | ~15 | One home if convenient; not worth a new dependency edge |
| `escapeHtml` | `utils.js:113-118` · `popup.js:837-841` · `panel.js:38-43` | ~17 | Leave — 3 LOC each, crosses context boundaries |
| `formatBytes` / `formatFileSize` | `storage.js:501-507` · `utils.js:149-155` | 14 (identical) | Keep `storage.js`'s; delete `utils.js`'s with Q-6 |
| `deepClone` | `utils.js:120-135` (recursive) · `popup.js:846-848` (JSON) | 19 | **Rename the popup one** — divergent semantics, not duplication |
| Rule templates | `options.js:658-702` (6) · `utils.js:277-351` (5, **dead**) | ~120 | `RULE_TEMPLATES` beside the schema; delete `utils.js`'s |

**Total addressable: ~750 LOC**, of which ~525 collapses into a single ~180-LOC `src/rule-schema.js`. The remaining ~500 LOC of markup/DOM duplication is listed for completeness and is **not** worth extracting — see below.

## Recommended tooling (ranked, with what each would have caught)

| # | Tool | Effort | What it would have caught **in this repo** |
|---|---|---|---|
| **1** | **ESLint** — flat config, `eslint:recommended`, `env: browser + webextensions + node`, `globals` for `SpliceTapMatcher`/`SpliceTapPatch`/`SpliceTapPlaceholders`/`SpliceTapDnr`. Replace the `echo` at `package.json:11`. | **S** — one config file, one afternoon of triage | `no-unused-vars`: `ANIMATION_DELAY` (`options.js:9`), `getRuleTypeLabel`/`renderRuleTypeBadge` (`options.js:1527,1531`). `no-undef`: any typo'd global in the five classic scripts — the highest-risk pattern in the repo, since `injected.js` reaches for `window.SpliceTap*` by string. `no-empty`: flags the 10 comment-only catches for an explicit decision (Q-11). `no-unused-private-class-members` / `no-dupe-class-members` on the four big classes. **Start here.** |
| **2** | **`tsc --checkJs --noEmit`** via a minimal `jsconfig.json` (`checkJs: true`, `strict: false`) + `@types/chrome`. Adopt file-by-file with `// @ts-check`, pure modules first. | **M** — noisy on day one; scope it | The class ESLint **cannot** see. Specifically: `this.renderSettings()` / `this.renderAbout()` at `popup.js:130,133` — methods that do not exist (Q-9). `require('./popup/popup.js')` returning `{}` and the non-existent `SpliceTapUtils`/`SpliceTapStorage` destructure at `index.js:1-2` (Q-7). `window.SpliceTapMatcher` inside an ESM module imported by a service worker (`utils.js:59`, Q-6). Shape drift between `storage.saveRule`'s two return types and its caller (`background.js:133`, Q-11). It would also have made Q-2 visible the moment `response` became optional. |
| **3** | **CI** — one `.github/workflows/ci.yml`: `npm ci && npm run lint && npm test && npm run validate`. | **S** — 15 lines | Nothing runs today. `npm run validate` (`scripts/validate-manifest.js`) already exists and already checks that every path in `manifest.json` resolves — it has never been executed automatically. Pair it with #1 so the lint gate isn't a no-op. |
| **4** | **`.editorconfig`** (+ Prettier in `--check` mode, **new/changed files only**) | **S** | 57 trailing-whitespace lines; the 2-space vs 4-space split between `popup/*` and `options/*` CSS/HTML. **Do not bulk-format** — a repo-wide Prettier run rewrites ~6,500 lines and destroys `git blame` on a codebase whose history is already only three commits deep. `.editorconfig` stops the bleeding at zero risk. |
| **5** | **Stylelint** — `stylelint-config-standard` over `popup.css`, `options.css`, and the `<style>` block in `panel.html` | **S** | The malformed-value class of bug (`font-family: , var(--font-main)`) that ESLint structurally cannot see, since it isn't JavaScript. Note the limit: it will **not** cover `overlay.js:38-175`, which is 137 lines of CSS living inside a JS template literal — the single least-inspectable stylesheet in the project. |

**If you do exactly one thing:** ESLint plus a real `lint` script plus the 15-line CI file (#1 + #3). That is under an hour and it makes every subsequent finding in Q-9 impossible to reintroduce.

## Explicitly fine as-is

These look like problems and are not. Changing them would cost more than it returns.

- **The UMD pattern in `matcher.js` / `patch.js` / `placeholders.js` / `dnr.js`.** Four files, one pattern, each with a header comment explaining the constraint (`dnr.js:7-15` is the best of them). It is the correct answer to "dual-load as a MAIN-world classic script and as a CommonJS module, with no build step." **Do not add a bundler to make this prettier** — a build step would cost more in reload friction and debuggability than the ~6 lines of boilerplate per file it saves.
- **`src/index.js` as the Jest seam.** It is a sensible, honest seam: it re-exports exactly the modules that are safely require-able and its comment says why the other two aren't. Keep it, and extend it as modules become UMD (Q-1, Q-6). Contrast with root `index.js`, which should be deleted (Q-7).
- **`background.js` registering listeners synchronously in the constructor before any `await`** (`:42-48`, with `this.ready` awaited in handlers at `:106`). This looks like a code smell and is in fact the correct MV3 pattern — a listener added after an `await` can miss the event that woke the worker. The comment already explains it. Leave it.
- **`content.js:87-103` returning `false` for messages it doesn't handle.** Subtle, correct, and correctly commented (`:88-90`): returning `true` unconditionally would hold the response channel open and break the overlay's `openRuleOverlay`. This is exactly the kind of non-obvious correctness that deserves its comment.
- **DevTools polling the background's log instead of using `chrome.devtools.network`** (`devtools.js:5-10`, `panel.js:8-13`). Mocked requests never touch the network stack, so the API genuinely cannot see them. Well-reasoned and well-documented.
- **`finishMock` shared between the static and patch XHR paths** (`injected.js:274-319`). This is already the right deduplication inside the interceptor — one response-delivery lifecycle, two callers. Preserve it through any Seam D refactor.
- **`INTERCEPTOR_TYPES` in `matcher.js:12` as the interceptor/DNR boundary.** A single explicit list that keeps `headers`/`queryparams` out of the fetch path. Clean, and the comment states the invariant.
- **The ring buffer + throttled persist in `background.js:212-287`.** `MAX_INTERCEPTION_LOG`, `PERSIST_THROTTLE_MS`, session-storage backing for SW suspension — this is thoughtful and correct for MV3. No change needed.
- **The ~500 LOC of duplicated *markup* between `options.html` and `overlay.js markup()`.** Real duplication, but a Shadow-DOM overlay must carry self-contained markup and styles, and templating it into a shared module means shipping a mini template engine or building strings in two dialects anyway. Extract the *logic* (Q-1); leave the markup alone.
- **4-space JS indentation.** Already consistent across all 22 JS files. Nothing to do.
- **`SpliceTapPopup`'s size** (39 methods, 866 LOC). It reads as a god object next to `OptionsManager`, but its longest method is 48 LOC, its responsibilities are cohesive (render a list, dispatch to the background), and it correctly delegates persistence rather than touching storage (`popup.js:56-58` documents this deliberately). Take the shared helpers from Q-1/Q-12 and otherwise leave it.
