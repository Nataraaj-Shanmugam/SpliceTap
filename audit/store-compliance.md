# Chrome Web Store & MV3 Compliance Audit — SpliceTap
_Reviewer lens: store review + MV3 platform correctness._

_Scope: branch `V1`, working tree as of this audit (includes uncommitted changes to
`manifest.json`, `content/content.js`, `service_worker/background.js`, `popup/*`, `options/*`
and the untracked `content/overlay.js`). Findings are static-review claims unless marked
**verified by execution**. Overlaps with [security.md](security.md) are cross-referenced
rather than re-argued; here they are framed as store-review and platform risk._

## Verdict

**No — it would not pass review today, and in its current state it cannot even be
uploaded successfully.**

- **Hard blocker:** all four icon files are base64 *text*, not binary PNG (`assets/icons/*.png`),
  and three of the four decode to a 1×1 pixel. Chrome cannot decode them, and the store
  requires a real 128×128 icon. This alone fails packaging/load. **Verified by execution** (C-1).
- **Hard blocker:** an extension that requests `<all_urls>` and intercepts/rewrites network
  traffic must supply a privacy policy URL, permission justification strings, and a single-purpose
  statement in the Developer Dashboard. None of these artifacts exist anywhere in the repo (C-2).
- **High review risk:** `<all_urls>` is requested unconditionally with no optional-host-permission
  path and no per-site opt-in, while `activeTab` is declared and never used and
  `declarativeNetRequest` is broader than needed (`declarativeNetRequestWithHostAccess` is the
  correct permission here). This is exactly the shape reviewers push back on (C-3, C-8, C-9).
- **Functional gap a reviewer will hit in five minutes:** `manifest.json` declares two
  `commands` but there is no `chrome.commands.onCommand` listener anywhere in the codebase —
  both shortcuts are dead, and both suggested keys collide with reserved Chrome shortcuts (C-6, C-14).
- **Good news:** no remote code, no `eval`/`new Function`, no CDN or external network dependency,
  no analytics/telemetry, no obfuscation or minification, and `web_accessible_resources` is
  correctly absent. The "Uses remote code?" answer is a clean *No*. See _Checked and ruled out_.

## Summary

Highest-impact first:

1. **The package is not loadable.** The icons are corrupt (base64 text saved with a `.png`
   extension). `npm run validate` reports "✅ All icons exist" because it only does an
   `fs.existsSync` check — it never opens the files.
2. **The packaging script cannot run on the development machine** (`zip` is not on PATH under
   Windows/Git Bash — **verified**), and when it does run it sweeps in `.claude/settings.local.json`,
   `TODO.md`, `changes.txt`, `SpliceTap.txt`, `CONTRIBUTING.md`, `demo.html`, `scripts/`,
   `index.js`, and `audit/`.
3. **Zero store-listing artifacts exist**: no privacy policy, no justification strings, no
   screenshots, no promo assets, no LICENSE, and `package.json` points at a placeholder GitHub org.
4. **Permission surface is wider than the code needs** in three independent ways.
5. **Two MV3 lifecycle defects** will produce intermittent "my mocks stopped working" reports:
   a stale-state broadcast on service-worker cold start, and unchecked/silently-swallowed
   `declarativeNetRequest` failures.
6. **Rule state (including any auth headers the user typed into a match condition) is broadcast
   to every frame of every page via `postMessage(..., '*')`**, and the in-page interceptor accepts
   state from any page script. This is the finding most likely to draw a User Data Policy question.

---

## Findings

### [Critical] C-1: All extension icons are base64 text, not PNG — three are 1×1 pixels

- **Where:** `assets/icons/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`;
  referenced from `manifest.json:43-48` (`action.default_icon`) and `manifest.json:50-55` (`icons`),
  plus `devtools/devtools.js:19` (`chrome.devtools.panels.create` icon argument).
- **What:** The files do not begin with the PNG signature (`\x89PNG`). They begin with the ASCII
  characters `iVBORw0KGgo...` — i.e. the *base64 encoding* of a PNG was written to disk verbatim
  instead of the decoded bytes. **Verified by execution:**
  - `icon-16.png` — 1024 bytes of base64; decodes to a 16×16 PNG.
  - `icon-32.png`, `icon-48.png`, `icon-128.png` — 96 bytes each, byte-identical
    (`md5 d74c3b09387c6218d1d88b7418cb4aca`); each decodes to a **1×1** PNG.
- **Policy / API rule:** Chrome Web Store listing requirements mandate a 128×128 PNG store icon,
  and `manifest.icons` entries must be valid images at the declared size. Chrome logs
  `Could not load icon '...' specified in 'icons'` and refuses to load the extension when the
  file is not a decodable image.
- **Impact:** Rejection / upload failure. Also breaks unpacked local loading, the toolbar action
  icon, and the DevTools panel icon.
- **Recommended fix:** Regenerate real binary PNGs at 16/32/48/128 (base64-decode the existing
  payloads only for `icon-16`; the other three are placeholder 1×1s and need actual artwork).
  Add a real image check to `scripts/validate-manifest.js` — assert the PNG magic bytes
  `89 50 4E 47 0D 0A 1A 0A` and parse width/height from the IHDR chunk (bytes 16–23), comparing
  against the manifest key.
- **Confidence:** High (verified by decoding the files).

---

### [Critical] C-2: No privacy policy, permission justifications, or single-purpose statement exist

- **Where:** Repo-wide. No `PRIVACY.md`, no privacy URL in `manifest.json` or `package.json`,
  no `store/` or listing-assets directory. `README.md:190-194` has a "Privacy & Security" section
  but it is developer documentation, not a hosted policy, and it is already stale (C-18).
- **What:** The Developer Dashboard blocks publication until the "Privacy practices" tab is
  completed. For this extension that means, at minimum: a hosted privacy policy URL, a
  disclosure/certification of what data is handled, a single-purpose description, a justification
  string for **each** of `storage`, `activeTab`, `contextMenus`, `declarativeNetRequest`, and a
  separate justification for the `<all_urls>` host permission.
- **Policy / API rule:** Chrome Web Store Developer Program Policies — *User Data Privacy*
  ("Posting a Privacy Policy & Complying with the Limited Use policy") and *Use of Permissions*.
  A privacy policy URL is mandatory whenever an extension handles personal or sensitive user
  data; `<all_urls>` plus request interception means the extension can observe website content
  and browsing activity, which falls squarely inside that definition regardless of whether the
  data is transmitted.
- **Impact:** Submission is impossible without these; the host-permission justification is the
  single most common cause of multi-round review for extensions of this shape.
- **Recommended fix:** Write and host a privacy policy stating plainly that (a) all rules and
  settings live in `chrome.storage.local` on-device, (b) the interception log holds only
  URL/method/rule-name/type/status for the last 200 requests in `chrome.storage.session`
  (`service_worker/background.js:34-35`, `:282`), (c) nothing is transmitted off-device, and
  (d) there is no analytics or telemetry. Add `homepage_url` and the policy URL to the listing.
  Draft the per-permission justifications (see _Pre-submission checklist_).
- **Confidence:** High.

---

### [High] C-3: `<all_urls>` is unconditional, with no optional-host-permission or per-site opt-in path

- **Where:** `manifest.json:12-14` (`host_permissions: ["<all_urls>"]`), plus three
  `content_scripts` entries all matching `<all_urls>` at `manifest.json:21`, `:28`, `:34`.
  Two of the three use `all_frames: true` (`:24`, `:31`), and the first runs in
  `world: "MAIN"` at `document_start` (`:23`, `:25`).
- **What:** The extension injects and monkey-patches `window.fetch` / `XMLHttpRequest`
  (`content/injected.js:119`, `:253`) inside *every frame of every site* the user visits —
  banking, webmail, third-party ad iframes included — from the moment the extension is
  installed, whether or not any rule is enabled. There is no `optional_host_permissions`,
  no site allowlist in the settings UI, and no `chrome.permissions.request` flow anywhere
  (`grep` for `chrome.permissions` returns nothing).
- **Policy / API rule:** Chrome Web Store *Use of Permissions* policy — "Request access to
  the narrowest permissions necessary to implement your Product's features." Chrome's own
  guidance for this pattern is `optional_host_permissions` with a runtime
  `chrome.permissions.request()`, or `activeTab`.
- **Impact:** High rejection/clarification risk. Even when approved, `<all_urls>` extensions
  land in the slower, deeper review queue and are subject to re-review on every update.
  It is also the difference between a scary "Read and change all your data on all websites"
  install warning and an opt-in one.
- **Recommended fix:** Move `<all_urls>` to `optional_host_permissions` and register the
  content scripts dynamically with `chrome.scripting.registerContentScripts()` for hosts the
  user has actually granted. If that is too large a change for v1.1, at minimum ship a
  documented per-site allowlist and make the justification string explicit that the interceptor
  is inert until a rule matches.
- **Confidence:** High (permission shape verified); the review outcome itself is a judgement call.

---

### [High] C-4: Full rule set — including user-entered auth headers — is broadcast to every page with `postMessage(..., '*')`

- **Where:** `content/content.js:54-58` (`window.postMessage({... payload: state}, '*')`),
  called from `:35` and `:96`. State originates at `service_worker/background.js:109-116`
  and `:363-380`.
- **What:** The relay forwards the *entire* `getRules` response — every rule object plus
  `settings` — into the page's MAIN world with a wildcard target origin. Rule objects can
  contain `match.headers` values the user typed in (the editor explicitly offers
  `{"x-api-key": "abc"}` as the placeholder — `content/overlay.js:244`), mock response bodies,
  and redirect destinations pointing at internal/localhost services. Because the relay runs
  with `all_frames: true` (`manifest.json:31`), this happens in every cross-origin iframe too,
  so any third-party script on any page the user visits can `addEventListener('message')` and
  read the user's complete rule library across all sites.
- **Policy / API rule:** Chrome Web Store *User Data Privacy* — Limited Use; the extension
  must not expose user data beyond what the user-facing feature requires. Also the standard
  `postMessage` guidance: never use `'*'` as `targetOrigin` when the message contains data
  that should not be readable by the destination.
- **Impact:** A reviewer who reads the content script will ask about this. Independent of
  review, it is a real cross-site data-exposure bug.
- **Recommended fix:** Only send the fields the interceptor actually consumes, and strip
  `match.headers` values before forwarding — the MAIN world needs the *presence* of a header
  condition, and comparison can stay on the isolated side, or the value can be hashed.
  There is no way to make `postMessage` into the MAIN world private (the MAIN world *is* the
  page), so the correct mitigation is minimisation, not a different transport.
- **Confidence:** High. See also security.md.

---

### [High] C-5: The interceptor accepts state and log entries from any page script

- **Where:** `content/injected.js:593-615` (accepts any message where
  `event.data.source === 'splicetap-extension'`); `content/content.js:112-130` (accepts any
  message where `event.data.source === 'splicetap-injected'` and relays it to the background).
  Neither listener checks `event.source === window` or `event.origin`.
- **What:** Any script on the page — including a cross-origin child iframe posting to its
  parent — can (a) inject an arbitrary rule set into the interceptor for that page, e.g. a
  `redirect` rule pointing `*/api/*` at an attacker origin (`content/injected.js:183-189`),
  or a `patch` rule that silently rewrites real API responses; and (b) forge
  `logInterception` entries, which the background pushes into the ring buffer and counts in
  `stats.intercepted` (`service_worker/background.js:212-221`, `:250-266`).
- **Policy / API rule:** Not a specific store policy, but a security defect a reviewer may
  cite under the "must not harm users" clause of the Developer Program Policies. Platform-wise
  it is the standard MAIN-world trust boundary: a `world: "MAIN"` content script shares the
  page's global object and cannot hold secrets from it.
- **Impact:** Rule-injection and log-poisoning on any page. Attack requires the victim to
  have SpliceTap installed, so blast radius is limited, but the redirect vector is genuinely
  dangerous.
- **Recommended fix:** At minimum add `if (event.source !== window) return;` to both listeners
  and generate a per-page-load nonce in `content.js` that the MAIN world must echo. Full
  isolation is not achievable while the interceptor lives in the MAIN world; the more robust
  path is to do rule matching in the ISOLATED world and pass the MAIN world only per-request
  verdicts.
- **Confidence:** High. See also security.md.

---

### [High] C-6: `commands` are declared but never handled — no `chrome.commands.onCommand` listener exists

- **Where:** `manifest.json:61-76` declares `toggle-extension` and `new-rule`. A repo-wide
  grep for `onCommand` / `chrome.commands` returns **zero** matches in any extension source
  file (`service_worker/`, `popup/`, `options/`, `content/`, `devtools/`).
- **What:** Both shortcuts are inert. `options/options.js:1009-1013` renders shortcut *labels*
  from a `spliceTapShortcuts` storage key, and `options/options.js:1437-1455` binds
  Ctrl/Cmd+S and Escape on the options *document* — none of that is connected to the manifest
  `commands` API. `src/storage.js:25-28` stores a decorative `shortcuts` object with the same
  key strings, reinforcing the illusion.
- **Policy / API rule:** `chrome.commands` — a declared command does nothing without a
  registered `chrome.commands.onCommand.addListener` in the service worker (the listener must
  also be registered synchronously at top level, per MV3 lifecycle rules).
- **Impact:** Advertised functionality is missing. A reviewer testing the listing description
  ("keyboard shortcuts") will find it non-functional; `README.md:149` also documents a
  Ctrl+R popup shortcut. Chrome will still show both entries at
  `chrome://extensions/shortcuts`, which makes it look like a bug rather than an omission.
- **Recommended fix:** Add a top-level `chrome.commands.onCommand.addListener` in
  `service_worker/background.js` (alongside `setupMessageHandlers()` at `:46-48`) that awaits
  `this.ready` and then toggles `isActive` / opens the rule overlay. Or remove the `commands`
  block from the manifest until it is implemented.
- **Confidence:** High (verified by grep).

---

### [High] C-7: Service-worker cold start broadcasts empty rules and silently disables mocking

- **Where:** `service_worker/background.js:472-486` (`chrome.tabs.onUpdated` handler).
  Compare with `:101-106`, where `handleMessage` correctly does `await this.ready`.
- **What:** The `onUpdated` handler builds its state snapshot **synchronously** at
  `:474-479`, reading `this.rules` / `this.isActive` / `this.settings` — but it never awaits
  `this.ready` (`:50-53`). On an MV3 cold start (the service worker is terminated after ~30s
  idle and re-spun by the next event), the constructor has run but `loadStoredData()` has not
  resolved, so the snapshot is `rules: []`, `active: true`, `settings: {}`. The stale snapshot
  is then delivered 500ms later via `setTimeout` (`:482-484`). `content/content.js:64-81`
  validates only *shape*, so an empty array passes and overwrites the correct state the page
  already got from `requestInitialState()`.
- **Policy / API rule:** MV3 service-worker lifecycle — the worker is ephemeral and holds no
  guaranteed in-memory state across events; every handler that reads hydrated state must await
  its hydration. Related: `setTimeout` in a service worker is not durable — the worker can be
  torn down before the callback fires, which also affects the retry chain at `:399-401`
  (1s/2s/3s backoff).
- **Impact:** Intermittent "SpliceTap stopped mocking after I left the tab alone" — one of
  the hardest classes of bug for a user to report, and a plausible source of one-star reviews.
- **Recommended fix:** `await this.ready` at the top of the `onUpdated` handler (and read
  the state *after* the await, not before). Replace the `setTimeout` retry chain with
  `chrome.alarms` (minimum 30s granularity) or drop it — `content/content.js:20-42` already
  retries from the page side, which is the more reliable direction.
- **Confidence:** High.

---

### [Medium] C-8: `declarativeNetRequest` should be `declarativeNetRequestWithHostAccess`

- **Where:** `manifest.json:10`. Actions used: `modifyHeaders` (`service_worker/dnr.js:62-73`)
  and `redirect` (`service_worker/dnr.js:79-92`).
- **What:** The broad `declarativeNetRequest` permission grants the ability to block/modify
  requests *without* host permissions and produces the additional
  "Block content on any page" install warning. Both actions this extension actually uses
  (`modifyHeaders`, `redirect`) require host permissions for the request URL and initiator
  regardless — and the extension already holds `<all_urls>`.
- **Policy / API rule:** `chrome.declarativeNetRequest` permissions —
  `declarativeNetRequestWithHostAccess` provides the same API but scopes rule application to
  granted host permissions and carries no extra permission warning. *Use of Permissions*
  policy requires the narrowest sufficient permission.
- **Impact:** An avoidable extra install warning and an avoidable review question. No runtime
  behaviour change for this codebase.
- **Recommended fix:** Swap `"declarativeNetRequest"` → `"declarativeNetRequestWithHostAccess"`
  in `manifest.json:10`. This also composes correctly with the C-3 fix (optional hosts).
- **Confidence:** High.

---

### [Medium] C-9: `activeTab` is declared but never used, and is redundant given `<all_urls>`

- **Where:** `manifest.json:8`. A repo-wide grep for `activeTab` finds it only in
  `manifest.json:8`, `README.md:181`, and the spec dump `SpliceTap.txt:498` — no code path
  depends on it.
- **What:** `README.md:181` claims it is used to "read the active tab's host for the
  context-menu prefill", but that code path (`popup/popup.js:415-425`,
  `service_worker/background.js:427-432`) reads `tab.url`, which is already available via the
  `<all_urls>` host permission. `activeTab` grants nothing additional here.
- **Policy / API rule:** *Use of Permissions* — do not declare permissions the extension does
  not use. Reviewers do check declared-vs-used.
- **Impact:** Low runtime impact; a small but real credibility hit during review, and a
  justification string you would have to write for a permission you cannot justify.
- **Recommended fix:** Remove it from `manifest.json:8` and from `README.md:181`. (If C-3 is
  adopted and `<all_urls>` becomes optional, `activeTab` becomes genuinely useful and should
  be re-added *then*, with the popup switched to `chrome.scripting.executeScript`.)
- **Confidence:** High.

---

### [Medium] C-10: DNR sync ignores rule-count/regex quotas and swallows every failure

- **Where:** `service_worker/dnr.js:121-140` (`syncDnrRules`), specifically the
  `getDynamicRules()` / `updateDynamicRules()` pair at `:130-136` and the bare
  `catch { console.error(...) }` at `:137-139`.
- **What:** Three related gaps:
  1. **No quota check.** The desired rule array is passed to `updateDynamicRules` with no
     comparison against the dynamic-rule cap. The governing constants are
     `chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES` and, for
     `regexFilter` rules, `MAX_NUMBER_OF_REGEX_RULES`. *(I am not confident enough in the
     exact current numeric values to hardcode them — read the constants off the API at
     runtime rather than assuming; the point stands regardless of the exact figures.)*
  2. **No regex validation.** `buildCondition` (`:32-34`) copies a user-supplied `/.../`
     pattern straight into `regexFilter` with no call to
     `chrome.declarativeNetRequest.isRegexSupported()`. DNR uses RE2 and rejects constructs
     that JavaScript's `RegExp` accepts (backreferences, lookaround) — and the in-page
     matcher at `src/matcher.js:33` uses `new RegExp`, so a pattern can work for `mock`
     rules and be rejected for `headers`/`queryparams` rules.
  3. **Atomic failure, silent.** `updateDynamicRules` applies `removeRuleIds` + `addRules`
     as one transaction. If *any* rule in the batch is invalid or the quota is exceeded, the
     whole call rejects, **no** rules change, and the only signal is a `console.error` in
     the service-worker console. The user sees a saved, enabled rule that does nothing —
     `handleMessage` still returns `{ success: true }` (`:137`, `:160`, `:171`).
- **Policy / API rule:** `chrome.declarativeNetRequest` — dynamic rule limits, RE2 regex
  support via `isRegexSupported()`, and the all-or-nothing semantics of `updateDynamicRules`.
- **Impact:** Silent, user-invisible breakage of the entire `headers`/`queryparams` feature
  the moment one bad rule is saved.
- **Recommended fix:** Have `syncDnrRules` return a result object; `await isRegexSupported()`
  per regex rule at save time in `validateRule` (`service_worker/background.js:292-358`) and
  surface the failure through the existing `testRule` result path; check
  `desired.length` against the quota constant before calling; propagate the caught error to
  the caller so `saveRule`/`setRules` can return `success: false`.
- **Confidence:** High on the code paths; Medium on the exact quota constants (deliberately
  not asserted).

---

### [Medium] C-11: DNR conditions omit `resourceTypes`, and `urlFilter` semantics differ from the in-page matcher

- **Where:** `service_worker/dnr.js:27-49` (`buildCondition`).
- **What:** Two distinct mismatches:
  1. **`resourceTypes` is never set.** Per the DNR `RuleCondition` docs, when neither
     `resourceTypes` nor `excludedResourceTypes` is specified, the rule matches all resource
     types **except `main_frame`**. So a `headers` rule intended to add/strip a header on the
     top-level document navigation silently never fires. The `corsUnblock` and
     `customUserAgent` templates (`options/options.js:685-703`) are precisely the cases users
     will expect to apply to a page load.
  2. **`urlFilter` is not the same language as the app's wildcard patterns.** The overlay
     tells users "Use * for wildcards, or wrap in /.../ for regex"
     (`content/overlay.js:214`). `src/matcher.js:25-30` implements that as an *anchored,
     case-insensitive full match* (`'^' + escaped + '$'`). `buildCondition` at
     `dnr.js:36` passes the same string through as `urlFilter`, where the DNR pattern
     language is a *substring* match with its own metacharacters: `*` (wildcard),
     `^` (separator), `|` (start/end anchor), `||` (domain anchor). A pattern containing
     `^` or `|` means something entirely different on the DNR path, and the anchoring
     differs even for plain `*` patterns.
- **Policy / API rule:** `chrome.declarativeNetRequest.RuleCondition` — `resourceTypes`
  default behaviour and `urlFilter` pattern syntax.
- **Impact:** Same rule text behaves differently depending on rule type. Users will file this
  as "headers rules don't work".
- **Recommended fix:** Set an explicit `resourceTypes` list that includes `main_frame`
  (or expose it in the editor). Translate the app's wildcard syntax into DNR `urlFilter`
  syntax deliberately (escape `^` and `|`, decide on anchoring) instead of passing it
  through, and document the divergence in the editor hint.
- **Confidence:** High on the code; Medium on the exact `resourceTypes` default wording —
  worth re-reading the current DNR docs before implementing.

---

### [Medium] C-12: `npm run package` cannot run here, and ships internal files when it does

- **Where:** `package.json:9`:
  `zip -r splicetap-extension.zip . -x '*.git*' 'node_modules/*' '*.DS_Store' 'package*.json' 'README.md' 'tests/*'`
- **What:**
  1. **`zip` is not available** on the development machine (`which zip` → not found, Windows
     + Git Bash — **verified by execution**). `npm run build` (`package.json:7`) therefore
     fails at the packaging step even when tests pass.
  2. **Wrongly included** (none of these are in the exclude list): `.claude/settings.local.json`
     (local agent configuration — should never leave the machine), `TODO.md` (29 KB internal
     plan), `changes.txt` (22 KB internal issue list), `SpliceTap.txt` (25 KB PRD),
     `CONTRIBUTING.md`, `demo.html` (contains an inline `<script>` at `demo.html:188` that the
     extension-pages CSP will block anyway), `scripts/validate-manifest.js`, `index.js` and
     `src/index.js` (CommonJS test glue — `index.js:1` `require`s `./popup/popup.js`, which
     is not a module), and this `audit/` directory.
  3. **Correctly excluded:** `node_modules/`, `tests/`, `README.md`, `package.json`,
     `package-lock.json`, `.git*`.
  4. **Nothing required is missing** from the archive — all manifest-referenced paths are
     present (verified) and none fall under an exclude pattern.
- **Policy / API rule:** Not a hard policy violation, but shipping unused files enlarges the
  review surface, and CWS review explicitly looks at every file in the package. Local config
  files in a public package are also a straightforward information-disclosure problem.
- **Impact:** Larger, noisier package; leaked local config; a build script that does not run
  on the author's own OS.
- **Recommended fix:** Replace the ad-hoc `zip` with an explicit *allowlist* build — copy only
  `manifest.json`, `assets/`, `src/{placeholders,matcher,patch,storage,utils}.js`,
  `content/`, `service_worker/`, `popup/`, `options/`, `devtools/` into a `dist/` directory,
  then archive `dist/`. Use a cross-platform archiver (Node's `archiver`, or
  `Compress-Archive` on Windows) so `npm run build` works everywhere. Add
  `.claude/`, `audit/`, `TODO.md`, `changes.txt`, `SpliceTap.txt` to `.gitignore` or at least
  to the exclude list.
- **Confidence:** High (zip absence and file set both verified).

---

### [Medium] C-13: Version mismatch between `manifest.json` and `package.json`

- **Where:** `manifest.json:4` → `"version": "1.1.0"`; `package.json:3` → `"version": "1.0.0"`.
  Also `src/storage.js:326` writes `version: '1.0.0'` into every backup blob, hardcoded rather
  than read from `chrome.runtime.getManifest().version`.
- **What:** Three independent version sources that can (and already do) disagree. The manifest
  version is the only one the store sees, but a release process driven off `package.json`
  will silently upload the wrong number.
- **Policy / API rule:** Chrome Web Store requires each uploaded package to have a *strictly
  greater* version than the published one; the format is 1–4 dot-separated integers in the
  range 0–65535. `1.1.0` is valid.
- **Impact:** Upload rejections ("version must be greater than the published version") and
  backup files that misreport their schema version.
- **Recommended fix:** Make `manifest.json` the single source of truth; have the build script
  read it and sync `package.json`. Replace the literal at `src/storage.js:326` with
  `chrome.runtime.getManifest().version`. Add a version-monotonicity check to
  `scripts/validate-manifest.js` (it currently only regex-checks the format at `:102-107`).
- **Confidence:** High.

---

### [Medium] C-14: Both suggested keyboard shortcuts collide with reserved Chrome shortcuts

- **Where:** `manifest.json:63-66` (`Ctrl+Shift+M` / `Command+Shift+M`) and
  `manifest.json:71-74` (`Ctrl+Shift+N` / `Command+Shift+N`).
- **What:** `Ctrl/Cmd+Shift+N` is Chrome's built-in *New Incognito Window*, and
  `Ctrl/Cmd+Shift+M` is Chrome's built-in *profile / avatar menu*. Chrome's browser-level
  shortcuts take priority over extension commands and cannot be overridden, so the suggested
  bindings will not be assigned — the commands appear unassigned at
  `chrome://extensions/shortcuts` even after C-6 is fixed. `src/storage.js:25-28` and
  `options/options.js:802` bake the same two strings into the settings UI, so the options
  page will *display* shortcuts that do not work.
- **Policy / API rule:** `chrome.commands` — reserved Chrome shortcuts always take priority
  over extension command shortcuts and cannot be overwritten. (The separate limit of **4**
  `suggested_key` entries per extension is not exceeded here — only 2 are declared.)
- **Impact:** Even after wiring up `onCommand`, neither shortcut fires. Users see a
  documented shortcut that does nothing.
- **Recommended fix:** Pick unreserved combinations (e.g. `Alt+Shift+M` / `Alt+Shift+N`, or
  `Ctrl+Shift+U`), and verify empirically at `chrome://extensions/shortcuts` after loading —
  Chrome shows an explicit conflict there. Drive the options-page labels from
  `chrome.commands.getAll()` rather than a hardcoded settings object so the display can never
  drift from reality.
- **Confidence:** Medium — the reserved-shortcut behaviour is well established, but the exact
  reserved list varies by platform and Chrome version. Verify at
  `chrome://extensions/shortcuts` before shipping.

---

### [Medium] C-15: The `corsUnblock` template applies `Access-Control-Allow-Origin: *` to every URL on every site

- **Where:** `options/options.js:685-694`. `url: '*'`, `method: '*'`, response headers set to
  `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Headers: *`, applied through
  `service_worker/dnr.js:62-73` as a real network-layer `modifyHeaders` rule.
- **What:** One click installs a rule that disables the same-origin protections CORS provides,
  for *all* traffic in the browser, for as long as the rule is enabled. `customUserAgent`
  (`:695-702`) is similarly scoped to `url: '*'`.
- **Policy / API rule:** Chrome Web Store Developer Program Policies — extensions must not
  disable or interfere with browser security features in a way users would not expect.
  Standalone "CORS unblock" extensions do exist on the store, but a *bundled, one-click,
  globally-scoped* variant inside an extension whose stated purpose is API mocking invites a
  single-purpose and security question.
- **Impact:** Elevated review scrutiny; a genuine security downgrade for any user who applies
  the template and forgets it.
- **Recommended fix:** Narrow the template's default `url` to something the user must edit
  (e.g. `*://localhost/*` or an empty field with a required-host hint), and surface an
  explicit warning in the UI when a `headers` rule targets `*`. The
  "Template applied — review and adjust before saving" toast (`options/options.js:759`) is
  not sufficient given the blast radius.
- **Confidence:** High on the code; Medium on how a reviewer would weigh it.

---

### [Medium] C-16: Every service-worker wake re-broadcasts to all tabs and fully rewrites the DNR ruleset

- **Where:** `service_worker/background.js:55-87` (`loadStoredData`) calls `broadcastState()`
  at `:77` and `syncDnrRules()` at `:78`; `broadcastState()` (`:363-380`) messages **every
  tab in every window**; `syncDnrRules` (`service_worker/dnr.js:130-136`) removes all current
  dynamic rules and re-adds the full desired set.
- **What:** In MV3 the service worker is torn down after ~30 seconds idle and re-spun on the
  next event — which for this extension is every `chrome.runtime.sendMessage` from any
  content script on any page, plus the DevTools panel's 2-second poll
  (`devtools/panel.js:18`, `:206`). Each wake therefore triggers a full `storage.local` read
  of all keys, an N-tab message fan-out, and a complete DNR remove-all/add-all — even when
  nothing changed.
- **Policy / API rule:** MV3 service-worker lifecycle. `updateDynamicRules` is a persistent,
  disk-backed operation; churning it on every wake is wasteful and (combined with C-10)
  widens the window where a transient failure leaves the ruleset wrong.
- **Impact:** Battery/CPU cost proportional to open-tab count, on a loop. Also the mechanism
  behind the C-7 race.
- **Recommended fix:** Only call `syncDnrRules` when the rule set actually changed — compare
  a hash of the desired rules against a value kept in `chrome.storage.session`, and skip the
  update when equal. Make `broadcastState()` push-on-change only; content scripts already
  pull their initial state (`content/content.js:170`), so the wake-time broadcast is redundant.
- **Confidence:** High.

---

### [Low] C-17: No handling for user-restricted site access

- **Where:** `popup/popup.js:413-438`, `service_worker/background.js:427-453`. No
  `chrome.permissions.contains` check exists anywhere in the codebase.
- **What:** Chrome lets users downgrade an extension's site access to "On click" or
  "On specific sites" from `chrome://extensions`. When they do, the content scripts stop
  injecting and `tab.url` becomes unavailable — `openRuleOverlay` returns `false`
  (`popup/popup.js:416`) and silently falls back to opening the options page in a new tab
  (`:399-405`), with no explanation of why the in-page editor did not appear and no
  indication that mocking is now off for that site.
- **Policy / API rule:** Not a policy violation — this is the user-controlled host-permission
  model working as designed. But the store *promotes* this control to users, so extensions
  are expected to degrade gracefully.
- **Impact:** Confusing silent degradation; likely support burden and negative reviews.
- **Recommended fix:** Check `chrome.permissions.contains({ origins: [tabOrigin] })` in the
  popup and show an explicit "SpliceTap doesn't have access to this site — grant access?"
  state with a `chrome.permissions.request()` button. This is also the natural on-ramp for
  the C-3 optional-permissions migration.
- **Confidence:** High.

---

### [Low] C-18: `README.md` still documents the removed `notifications` permission

- **Where:** `README.md:179-184` lists five permissions including `notifications`;
  `manifest.json:6-11` declares four and does not include it. `src/storage.js:22` also still
  carries a `notifications: true` default setting.
- **What:** Stale documentation. This matters more than usual because the README is the most
  likely source for the store listing's detailed description, and a listing that describes
  permissions the extension does not request (or vice versa) is a reviewer flag.
- **Policy / API rule:** Chrome Web Store *Deceptive Installation Tactics / Listing accuracy* —
  the listing must accurately describe what the extension does and what it accesses.
- **Impact:** Low on its own; contributes to a "not ready" impression.
- **Recommended fix:** Update `README.md:179-184` to match the manifest exactly, and reuse
  those same strings verbatim as the dashboard justification strings. Drop the dead
  `notifications` default from `src/storage.js:22`.
- **Confidence:** High.

---

### [Low] C-19: Dead and demo files would ship inside the package

- **Where:** `index.js` (root, 8 lines — `require('./popup/popup.js')`, which is not a
  CommonJS module and would throw), `src/index.js` (Jest-only re-export glue),
  `demo.html` (244 lines with an inline `<script>` at `:188`),
  `scripts/validate-manifest.js`, `devtools/devtools.html:10-34` (a large commented-out
  duplicate of the panel-creation logic that now lives in `devtools/devtools.js`).
- **What:** None of these are referenced from `manifest.json`. `demo.html` and the
  `tests/*.html` pages are not listed in `web_accessible_resources` (correctly), so no web
  page can load them — but they are still part of the reviewed package, and `demo.html`'s
  inline script would be blocked by the default MV3 extension-pages CSP
  (`script-src 'self'`) if anyone opened it via its `chrome-extension://` URL.
- **Policy / API rule:** No hard rule; CWS review reads every file in the package, and dead
  code invites questions.
- **Impact:** Noise during review; a broken-looking demo page if a reviewer opens it.
- **Recommended fix:** Exclude via the allowlist build in C-12. Delete the commented block at
  `devtools/devtools.html:10-34`.
- **Confidence:** High.

---

### [Low] C-20: `scripts/validate-manifest.js` gives false confidence

- **Where:** `scripts/validate-manifest.js:79-89` (icons), `:36-40` (permissions).
- **What:** The validator prints "✅ All icons exist" (it only calls `fs.existsSync`) and
  "✅ Permissions defined: 4 items" (it only checks that the value is an array). It passes
  cleanly today — **verified by running `node scripts/validate-manifest.js`** — despite C-1
  (corrupt icons), C-6 (unhandled commands), and C-9 (unused permission).
- **Policy / API rule:** N/A — tooling gap.
- **Impact:** The one automated gate in the repo signals green on a package that cannot load.
- **Recommended fix:** Extend it to (a) validate PNG magic bytes and IHDR dimensions against
  the declared icon size, (b) cross-check each declared permission against a grep of the
  source for its corresponding `chrome.<api>` namespace, (c) assert a
  `chrome.commands.onCommand` listener exists whenever `commands` is declared, and (d) verify
  `manifest.version` matches `package.json`.
- **Confidence:** High.

---

### [Nit] C-21: Placeholder project metadata and missing LICENSE

- **Where:** `package.json:26-35` — `author: "SpliceTap Extension Team"`, `homepage` and
  `repository` both pointing at `https://github.com/splicetap/browser-extension`;
  `package.json:27` declares `"license": "MIT"` but there is no `LICENSE` file in the repo
  (verified — `git ls-files` shows none).
- **What:** The store listing requires a real publisher identity, a working homepage/support
  URL, and (for an open-source claim) an actual license file.
- **Policy / API rule:** Listing requirements — support/homepage URLs must resolve.
- **Impact:** A 404 homepage URL in the listing is a straightforward rejection reason.
- **Recommended fix:** Add a `LICENSE` file, and point `homepage`/`repository`/support at a
  URL that actually exists before submission.
- **Confidence:** High.

---

### [Nit] C-22: Throttled persistence can drop the last ~1.5s of log and stats on worker termination

- **Where:** `service_worker/background.js:274-287` (`_persistVolatile`, `PERSIST_THROTTLE_MS = 1500`
  at `:40`), called from the `logInterception` handler at `:219`.
- **What:** The throttle is a sensible optimisation, but there is no flush on suspension —
  MV3 provides no reliable "about to be terminated" hook, so up to 1.5 seconds of
  interception-log entries and stat increments are lost whenever the worker is torn down
  mid-window.
- **Policy / API rule:** MV3 lifecycle — no guaranteed teardown callback.
- **Impact:** Cosmetic (the DevTools panel and the popup counter under-report slightly).
- **Recommended fix:** Accept it and document it, or force a flush (`_persistVolatile(true)`)
  whenever the panel polls `getInterceptionLog` (`:223-224`), which is a natural checkpoint.
- **Confidence:** High.

---

## Pre-submission checklist

**Blocking — cannot submit without these**

- [ ] Replace all four icon files with real binary PNGs at their declared sizes (C-1).
- [ ] Write and host a privacy policy; add its URL to the Developer Dashboard (C-2).
- [ ] Complete the dashboard "Privacy practices" tab: data-use disclosures + Limited Use
      certification + single-purpose description (C-2).
- [ ] Write justification strings for `storage`, `contextMenus`, `declarativeNetRequest*`,
      and — separately and at length — for `<all_urls>` (C-2, C-3).
- [ ] Produce listing assets: at least one 1280×800 (or 640×400) screenshot, a 128×128 store
      icon, and a detailed description. None exist in the repo.
- [ ] Make `npm run package` runnable cross-platform and switch it to an allowlist build so
      `.claude/settings.local.json`, `TODO.md`, `changes.txt`, `SpliceTap.txt`, `demo.html`,
      `scripts/`, `index.js`, and `audit/` stay out of the zip (C-12).
- [ ] Reconcile `manifest.json` and `package.json` versions; establish a monotonic bump
      process (C-13).

**Strongly recommended before first submission**

- [ ] Remove `activeTab` (C-9) and switch `declarativeNetRequest` →
      `declarativeNetRequestWithHostAccess` (C-8).
- [ ] Either implement `chrome.commands.onCommand` or delete the `commands` block (C-6), and
      choose unreserved shortcut keys (C-14).
- [ ] Fix the cold-start stale-broadcast race in the `tabs.onUpdated` handler (C-7).
- [ ] Stop broadcasting `match.headers` values into the page (C-4); add
      `event.source !== window` guards to both `message` listeners (C-5).
- [ ] Surface DNR failures to the user instead of swallowing them; validate regexes with
      `isRegexSupported()` and check quotas before `updateDynamicRules` (C-10).
- [ ] Set explicit `resourceTypes` on DNR conditions and reconcile `urlFilter` vs. the in-page
      wildcard syntax (C-11).
- [ ] Narrow the `corsUnblock` / `customUserAgent` template scope away from `url: '*'` (C-15).
- [ ] Sync `README.md` permissions with the manifest and reuse the text as justification
      strings (C-18).
- [ ] Add `LICENSE`; fix the placeholder homepage/repository URLs (C-21).

**Post-launch / next iteration**

- [ ] Migrate `<all_urls>` to `optional_host_permissions` +
      `chrome.scripting.registerContentScripts()` (C-3); add the "grant access to this site"
      popup state (C-17).
- [ ] Skip redundant DNR resync and tab broadcasts on service-worker wake (C-16).
- [ ] Harden `scripts/validate-manifest.js` so it can actually catch C-1/C-6/C-9/C-13 (C-20).

---

## Checked and ruled out

| Area | Result |
|---|---|
| **Remote code execution** | Clean. No `eval`, no `new Function`, no `importScripts`, no dynamic `import()`, no remote `<script src>`. The one `setTimeout` family usage is always a function reference, never a string. The store's "Uses remote code?" question is a legitimate **No**. |
| **External network dependencies in the UI** | Clean. The only non-`localhost` HTTP references in shipped code are `http://www.w3.org` SVG namespace declarations (`options/options.css:116`, `:569`), an `https://example.com` placeholder (`options/options.html:431`), and a `https://localhost:3000/api` input placeholder (`content/overlay.js:273`). No CDN, no Google Fonts, no webfont, no remote image. |
| **Analytics / telemetry** | None. Grep for `sendBeacon`, `WebSocket`, `gtag`, `analytics`, `mixpanel`, `amplitude`, `sentry` across `popup/`, `options/`, `devtools/`, `service_worker/`, `src/`, `content/` returns zero hits. The only `fetch`/`XHR` references are the interceptor's own originals in `content/injected.js`. Nothing leaves the device. |
| **Obfuscation / minification** | None. Longest line in any JS file is 229 chars (`popup/popup.js`); all sources are commented and readable. |
| **`web_accessible_resources`** | Correctly absent — confirmed nothing still needs it. `content/injected.js` is now loaded declaratively as a `world: "MAIN"` content script (`manifest.json:19-26`) rather than via an injected `<script src>`. The two `chrome.runtime.getURL()` calls (`popup/popup.js:403`, `:574`) target `options/options.html`, opened by the extension itself via `chrome.tabs.create` — extension-initiated navigation to an extension page does not require WAR. The DevTools panel icon path passed to `chrome.devtools.panels.create` (`devtools/devtools.js:19`) is extension-internal. `demo.html` and `tests/*.html` are not WAR-listed, so no web page can reach them. |
| **`minimum_chrome_version: 120` vs. APIs used** | Consistent and, if anything, conservative. `content_scripts[].world: "MAIN"` requires 111+; `chrome.storage.session` requires 102+; module service workers (`"type": "module"`) require 91+; `declarativeNetRequest` 84+; `getDynamicRules()` with a filter 111+. 120 covers all of them. |
| **`isUrlFilterCaseSensitive`** | Fine at this Chrome floor. The default flipped from `true` to `false` in Chrome 118, so the explicit `false` at `service_worker/dnr.js:40` is both supported and redundant-but-harmless at `minimum_chrome_version: 120`. (Worth re-confirming against current docs that the field applies to `regexFilter` and not only `urlFilter` — it is set unconditionally at `:40`, including on regex conditions.) |
| **Event listener registration timing** | Correct. `setupMessageHandlers()`, `setupContextMenus()`, `setupExtensionLifecycle()` all run synchronously in the constructor at module top level (`service_worker/background.js:46-48`), before any `await` — so no listener can miss the event that woke the worker. `handleMessage` correctly `await`s `this.ready` (`:106`). The one exception is the `tabs.onUpdated` *handler body*, which is C-7. |
| **`contextMenus.create` inside `onInstalled`** | Correct pattern (`service_worker/background.js:411-421`). Creating the menu at top level would throw a duplicate-id error on every worker restart. |
| **`chrome.storage.session` access level** | Correct. `setAccessLevel` is never called, leaving the default `TRUSTED_CONTEXTS`, and only the service worker touches it (`:69`, `:229`, `:282`). Content scripts never read it; the DevTools panel goes through `chrome.runtime.sendMessage` (`devtools/panel.js:103`). The 200-entry cap (`:35`) keeps it far under quota. |
| **`chrome.tabs` usage without the `tabs` permission** | Legitimate. `tabs.query`, `tabs.sendMessage`, `tabs.create`, `tabs.onUpdated`, `tabs.onRemoved` need no permission; `tab.url` is populated because `<all_urls>` is granted. (This does become fragile under user-restricted site access — C-17.) |
| **`commands` suggested-key count** | Within limits — 2 declared, the cap is 4. `_execute_action` is not used, so no reserved-name conflict. |
| **Manifest field lengths** | `name` (22 chars) and `description` (99 chars) are both within the manifest limits (45 and 132 respectively). `version` `1.1.0` matches the required 1–4 dot-separated 0–65535 integer format. |
| **Declared files present** | All verified to exist: the four MAIN-world scripts, `content/content.js`, `content/overlay.js`, `service_worker/background.js`, `popup/popup.html`, `options/options.html`, `devtools/devtools.html`, `devtools/panel.html`, and all four icon paths (they exist — they are just not valid PNGs, C-1). |
| **Extension-page CSP** | No `content_security_policy` key is declared, so the MV3 default (`script-src 'self'; object-src 'self'`) applies. All extension pages load their JS via external `<script src>` — `popup/popup.html:97`, `options/options.html:475`, `devtools/devtools.html:9`, and `devtools/panel.html`. No inline handlers, no `javascript:` URLs. The only inline `<script>` in the repo is `demo.html:188`, which is not a manifest-referenced page (C-19). |
| **Single-purpose policy** | Should pass. Mock / block / delay / redirect / modify-headers / modify-query-params, plus a DevTools panel and a chaos mode that is off by default (`src/storage.js:29-32`), all serve one coherent purpose: intercepting and shaping API traffic for development. The `corsUnblock` template is the only element that stretches this (C-15). |
| **Remote-code-by-proxy** | Considered and not treated as a violation. A user-authored `redirect` rule can point a page's script request at a third-party URL via DNR, and a `mock` rule can supply an arbitrary body — but the extension itself never fetches and executes remote code, and the in-page interceptor only patches `fetch`/`XHR`, not `<script src>` loading. This is the same capability Requestly ships with. Expect it to be *asked about* in review; it should not be a rejection. |
