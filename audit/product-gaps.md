# Product & Competitive Audit — TurboMock
_Reviewer lens: developer-tools product strategy. Method: code verification + competitive analysis._

_Scope: branch `V1`, working tree as of this review. Every TurboMock claim below is cited to
`file:line` in the source. `README.md`, `TODO.md` and `changes.txt` were treated as claims and
verified independently — several README claims did not survive verification (see G-13)._

_Competitor note: Requestly/Charles/Mockoon/MSW capabilities below come from product knowledge,
not from running the products during this audit. Rows I am confident about are stated plainly;
rows where I am not are marked **[verify]**. No pricing is asserted anywhere in this document._

---

## Positioning today

TurboMock is a solid, no-build, zero-infrastructure **request interceptor for a single developer
on a single machine**. It genuinely does six rule types across two interception mechanisms —
`mock`/`block`/`delay`/`redirect` via a MAIN-world fetch/XHR monkey-patch
(`content/injected.js:119`, `content/injected.js:253`) and `headers`/`queryparams` via
declarativeNetRequest (`service_worker/dnr.js:99`) — and two of its capabilities (RFC 7386 patch
mode, `src/patch.js:17`; GraphQL `operationName` matching, `src/matcher.js:73`) are genuinely
ahead of what most browser-extension interceptors expose declaratively.

But the product is currently **an engine with no cockpit**. Rules can only be listed and managed
in a 380×560 popup (`popup/popup.css:101-103`); the options page's "Rules" tab contains nothing
but Import and Export cards (`options/options.html:147-185`) and has **no button anywhere that
creates a rule** — `openRuleEditor()` is reachable only via a URL parameter or a context-menu
prefill (`options/options.js:90`, `:125`, `:137`). There is no way to get from "I see a request
in DevTools" to "I have a rule for it". And the one affordance that would tell a user whether
their rule works — the Test button — never fires a request and hard-fails for five of the six
rule types (`service_worker/background.js:314`).

Honest one-line positioning: **a capable interception engine, a demo-grade product.**

---

## Competitive matrix vs Requestly

Severity = severity of the gap for TurboMock's stated goal of Requestly parity.

| Capability | Requestly | TurboMock | Evidence (file:line) | Gap severity |
|---|---|---|---|---|
| Mock/modify response body | Yes | Yes (static) | `content/injected.js:226-247` | — |
| Modify response by merge-patch into the **real** response | Partial (full-body replace or JS function) **[verify]** | **Yes, declaratively** | `content/injected.js:194-224`, `src/patch.js:17` | **TurboMock ahead** |
| GraphQL operation-level targeting | Yes, in Modify Response **[verify]** | Yes, as a first-class match condition | `src/matcher.js:73-85` | **Parity/ahead** |
| Block / cancel request | Yes | Yes | `content/injected.js:170-174`, `:498-513` | — |
| Delay request | Yes | Yes | `content/injected.js:176-181`, `:515-527` | — |
| Redirect (with regex capture refs) | Yes | Yes (`$1..$9`) | `content/injected.js:88-99` | — |
| Modify request/response headers | Yes | Yes (DNR) | `service_worker/dnr.js:62-73` | — |
| Query param add/remove | Yes | Yes (DNR) | `service_worker/dnr.js:79-92` | — |
| Modify User-Agent (as its own rule type) | Yes | Only via a headers-rule template | `options/options.js:694-701` | Low |
| **Modify request body** | Yes | **Absent** | absent — grepped `requestBody`, `modifyBody`; interceptor never touches `config.body` (`content/injected.js:119-248`) | **High** |
| **Replace string in URL** | Yes | **Absent** (only whole-URL redirect) | `content/injected.js:88-99` | Medium |
| **Insert Script (JS/CSS injection)** | Yes | **Absent** | absent — grepped `insertScript`, `injectScript` | Medium |
| **Response body from local file / remote URL** | Yes **[verify]** | **Absent** — body is an inline textarea only | `options/options.html:399-411`, `content/overlay.js:252-255` | Medium |
| **Rule groups / folders** | Yes | **Absent** — flat array, no `group` field | `src/storage.js:75-100`, grepped `group`/`folder` | **High** |
| **Rule ordering / priority UI** | Yes **[verify]** | **Absent** — first-match on array order, invisible & unchangeable | `src/matcher.js:96-112`; grepped `reorder`/`drag` → none | **High** |
| **Pinned / favorite rules** | **[verify]** | Absent | grepped `pinned`/`favorite` | Low |
| **Test a rule against a real URL** | Yes **[verify]** | **Structural validation only, and broken for 5/6 types** | `service_worker/background.js:198-202`, `:292-358` | **Critical** |
| **Create a rule from an observed request** | Yes (DevTools integration) **[verify]** | **Absent** — context menu prefills only `*<host>*` | `service_worker/background.js:428-431` | **Critical** |
| DevTools panel | Yes | Yes, but metadata-only, 2s poll, no bodies, no filter, no actions | `devtools/panel.js:18`, `:159-174` | Medium |
| **Cloud sync across machines** | Yes | **Absent** — `chrome.storage.local` only | `src/storage.js:50`, `:80`; grepped `storage.sync` → none | Medium |
| **Workspaces / team sharing** | Yes | **Absent** — JSON file export only | `options/options.js:1222-1233` | Medium (see roadmap: deliberate) |
| **Shareable rule links** | Yes **[verify]** | Absent | — | Medium |
| **Session recording & sharing** | Yes (SessionBook) | **Absent** | — | Low (deliberate non-goal) |
| **Hosted mock server / file server** | Yes | **Absent** | — | Low (deliberate non-goal) |
| **HAR import/export** | Yes **[verify]** | **Absent** | grepped `har` → none | Medium |
| **Environment variables / user-defined vars** | **[verify]** | **Absent** — only 14 fixed placeholders | `src/placeholders.js:15-85` | Medium |
| **Per-rule source filters** (page URL, resource type, tab scope) | Yes | **Absent** — every rule is global to every tab | `src/matcher.js:92-114` (only url/method/headers/graphql) | **High** |
| Rule templates gallery | Yes | 6 templates, options-modal only; a second unused set is dead code | `options/options.js:658-702`; dead: `src/utils.js:277-351` | Medium |
| Chaos / random failure injection | No | **Yes — but no UI to turn it on** | `content/injected.js:127-132`; grepped all HTML → no control | **TurboMock ahead, unshipped** |
| Desktop app / system-wide proxy | Yes | No | — | Low (deliberate non-goal) |
| Firefox / Safari | Yes **[verify]** | No | `manifest.json` `minimum_chrome_version: 120` | Low |

---

## Differentiation opportunities

**Do not try to out-feature Requestly.** Requestly has years of surface area, a desktop proxy, a
hosted backend, and a team plan. A solo-maintained extension that chases that list ships a worse
version of every item. TurboMock has two assets that are *architecturally* differentiated, and it
should spend the next two quarters compounding on them.

### The wedge: surgical mutation of a *live* backend

Every other tool in this space assumes you are **replacing** the API. MSW replaces handlers in
code. Mockoon and Postman run a mock server. Requestly's Modify Response, in its declarative form,
replaces the body. Charles/Fiddler map to a local file.

TurboMock's `patch` mode does something categorically different: it lets the **real request go to
the real backend**, then merges a small declarative patch into the response
(`content/injected.js:194-224`). Your auth still works. Your pagination still works. Your 40 other
endpoints still work. You change `subscription.status` to `"expired"` and the app flips into the
expired-trial state — against staging, with real data, in ten seconds, with no code change and no
branch.

That is the single most common real-world need — *"reproduce this one state"* — and it is exactly
the case that whole-API mocking serves badly, because whole-API mocking makes you author the other
95% of the response you didn't care about.

**Ideal user:** a frontend engineer on a mature app with a real dev/staging backend, who spends
their day reproducing states they can't easily create (expired trial, empty state, 47 unread,
rate-limited, partially-failed batch, feature-flag-off). Not the greenfield dev with no backend —
MSW already owns that person, and owns them properly, in code, in CI.

### The product this wedge implies: **Scenarios**

The wedge is currently a checkbox in a dropdown (`options/options.html:376`). The product it
implies is *named, one-click application states*:

> `Trial expired` · `Empty inbox` · `Payment declined` · `Rate limited` · `Slow network (3G)`

A Scenario is a **named group of patch + delay + block rules that activate together**. One click
puts the whole app into that state. Screenshot it, demo it, hand the scenario to QA, commit it to
the repo alongside the feature. Nobody in the extension market ships this. It is a small step from
the existing schema (rules already have `enabled`; they need a `groupId` and a group-level toggle)
and it turns a low-level rule editor into something a PM or designer could also use.

### The second asset: GraphQL operation targeting

On a single-endpoint GraphQL API, URL matching is worthless — every request is `POST /graphql`.
TurboMock already matches on `operationName` (`src/matcher.js:73-85`), which makes it one of the
few browser tools that can mock *one query* on a GraphQL app. Combined with patch mode
("return the real `viewer`, but set `viewer.permissions.canEdit` to false") this is a strong,
defensible, easy-to-demo story for the large and growing population of GraphQL frontends.

Current limitation to close: matching is `operationName`-only and the fetch path only reads the
body when a rule already demands it (`content/injected.js:145-159`). Extending to variable
matching (`variables.id === "..."`) and patching `data.<field>` by path is the natural next step
and stays inside the wedge.

### What the wedge is NOT

It is not "a better rule list". Fix the rule list because it's table stakes (G-1), not because
it differentiates. The differentiation budget goes to Scenarios and to capture-to-patch (G-2).

---

## Onboarding / time-to-first-value analysis

Traced from code, step by step.

1. **Install.** `chrome.runtime.onInstalled` with `reason === 'install'` calls
   `chrome.runtime.openOptionsPage()` (`service_worker/background.js:461-464`). A second
   `onInstalled` listener registers the context menu (`:411-421`).
2. **The user lands on the wrong page.** `options_ui.open_in_tab` is true (`manifest.json`), and
   the options page opens on the **General** tab — Theme, Notifications, Auto Backup, Debug Mode
   (`options/options.html:21-25`, `:57-143`). There is no welcome text, no explanation of what
   TurboMock does, and no call to action. The first thing a new user sees is a theme picker.
3. **The obvious next click is a dead end.** Clicking "Rules" in the sidebar shows two cards:
   *Import Rules* and *Export Rules* (`options/options.html:147-185`). There is no "New Rule"
   button. Verified: `openRuleEditor()` has exactly three call sites, all triggered by a URL
   param or a stored context-menu prefill (`options/options.js:90`, `:125`, `:137`).
4. **The real path is undiscoverable from here.** The user must close the tab, find the toolbar
   icon, and open the popup, where the empty state reads *"No rules yet — Create your first mock
   rule to get started. Click the + button below."* (`popup/popup.js:277-286`).
5. **The + button behaves differently depending on which tab is open.** `createNewRule()` first
   tries the in-page Shadow-DOM overlay (`popup/popup.js:570`), which requires the active tab to
   be `http(s)` (`popup/popup.js:416`). Right after install the active tab is very likely
   `chrome://extensions` or the options page, so this fails and it falls back to opening
   `options/options.html?action=new` in a **new tab** (`popup/popup.js:573-575`), which opens the
   modal after two `requestAnimationFrame`s plus a 200 ms timer (`options/options.js:117-128`).
   Two different users on two different tabs get two different editors.
6. **Now the user must already know the answer.** The form asks for a URL pattern
   (`options/options.html:352-356`) with no request picker, no host list, no autocomplete, and no
   way to see what the page is actually requesting. The Quick Template dropdown
   (`options/options.html:313-321`, `options/options.js:658-702`) is the only assist — and every
   template still ships a placeholder pattern (`*/api/*`) the user has to replace.
7. **Save, then guess whether it worked.** The rule broadcasts to open tabs
   (`service_worker/background.js:363-380`) but requests fired before the first sync pass through
   unmocked, so the page must be reloaded. Verification means either looking for the
   `x-turbomock: true` response header (`content/injected.js:237-238`) or opening the DevTools
   TurboMock panel, which polls every 2 seconds (`devtools/panel.js:18`).

**Realistic time-to-first-value:** ~90 seconds *if the user already knows the exact endpoint URL
and finds the popup.* Unbounded if they don't — there is no path in the product from "a request
happened" to "a rule exists".

### Named friction points

| # | Friction | Evidence |
|---|---|---|
| F1 | First-run lands on Settings/General, not on rules; no welcome, no CTA | `service_worker/background.js:461-464`, `options/options.html:57` |
| F2 | Options → Rules is a dead end with no create button | `options/options.html:147-185` |
| F3 | The + button silently routes to one of two different editors based on the active tab | `popup/popup.js:570-577`, `:413-438` |
| F4 | The two editors have different capabilities — the overlay has no template dropdown, no Format JSON, no placeholder-insert buttons | `content/overlay.js:181-307` vs `options/options.html:288-473` |
| F5 | No URL discovery anywhere in the product; "Mock this request" prefills only `*<host>*` | `service_worker/background.js:428-431` |
| F6 | No verification loop: Test is structural, `hitCount` is never incremented, the panel only shows what already matched | `service_worker/background.js:292-358`; `hitCount` only copied, never `++` (`options/options.js:611`, `content/overlay.js:446`) |
| F7 | The 6 templates are the best onboarding asset in the codebase and they are on the *second* path, absent from the primary one | `options/options.js:658-702`; absent from `content/overlay.js` |
| F8 | `demo.html` — a working sandbox page with buttons that fire real requests — is referenced from nowhere | grepped `demo.html` across all `*.js`/`*.html`/`*.json`/`*.md` → zero references |

---

## Findings

### [Critical] G-1: No rule-management surface outside a 380×560 popup, and no way to create a rule from the options page at all

- **Gap:** The only place rules can be listed, searched, toggled, duplicated, or deleted is the
  toolbar popup (`popup/popup.js:143-158`), fixed at 380×560 (`popup/popup.css:101-103`), with a
  scrolling list and no grouping, no type filter, no sorting, and no bulk actions. Search covers
  only name/url/method (`popup/popup.js:556-560`). The full-page options "Rules" tab contains only
  Import and Export cards. The rule editor modal exists in that page but has **no entry point** —
  `openRuleEditor()` is only reachable via `?action=new`, `?editRule=`, or a context-menu prefill.
- **User impact / who cares:** Everyone, immediately. Ten rules is uncomfortable; thirty is
  unusable. This is also the single largest contributor to bad first-run: a user who follows the
  install flow into the options page cannot create a rule from where the product put them.
- **Evidence:** `options/options.html:147-185`; `options/options.js:90`, `:125`, `:137`, `:152`;
  `popup/popup.css:101-103`; `popup/popup.js:143-158`, `:556-560`.
- **Effort:** M — the editor modal, the save path (`setRules`), and the badge helpers already
  exist; `renderRuleTypeBadge()` (`options/options.js:1531`) is already written and unused.
- **Recommendation:** Build a real rule manager in the options page: table view, "New Rule"
  button, filter by type/status, search, multi-select enable/disable/delete/duplicate, and
  drag-to-reorder. Make the options page the primary surface and demote the popup to a
  quick-toggle + recent-rules panel. Change first-run to open the Rules tab.

### [Critical] G-2: Nothing in the product turns an observed request into a rule

- **Gap:** There is no request picker, no traffic list you can act on, and no capture. The context
  menu is labelled "Mock this request" but is registered on the `action` and `page` contexts and
  prefills only `*<host>*` derived from the tab URL — it has no knowledge of any request. The
  DevTools panel only shows requests that *already matched a rule*, so it cannot help you author
  the first one.
- **User impact / who cares:** Every new user, and every user working on an unfamiliar app. This
  is the difference between "I mocked it in 15 seconds" and "I alt-tabbed to the Network tab,
  copied a URL, guessed a wildcard, saved, reloaded, and it didn't fire." It is also the direct
  cause of the unbounded TTFV in the onboarding trace.
- **Evidence:** `service_worker/background.js:423-456` (context menu prefills host only);
  `devtools/panel.js:102-114` (panel reads `getInterceptionLog`, i.e. matched requests only);
  `devtools/devtools.js` header comment explicitly declines to use
  `chrome.devtools.network.onRequestFinished`.
- **Effort:** L
- **Recommendation:** Make the DevTools panel show **all** requests via
  `chrome.devtools.network.onRequestFinished`, merged with the interception log, with per-row
  actions: **Mock this** (prefills URL, method, and the *captured real response body*),
  **Patch this** (prefills URL + method in patch mode), **Block**, **Delay**. Capturing the real
  body into the editor is what makes patch mode usable by someone who hasn't memorised the
  response shape — this feature and the wedge reinforce each other.

### [Critical] G-3: "Test rule" never fires a request, and hard-fails for five of the six rule types

- **Gap:** `testRule` routes to `validateRule`, which checks structure only. Worse, it
  unconditionally requires `rule.response` and `rule.match.method` — but `block`, `delay`,
  `redirect`, `headers`, and `queryparams` rules have no `response` object by design
  (`options/options.js:469-578` builds them without one). Every such rule therefore fails with
  *"Response configuration is required"*. The popup's "Test All" walks every enabled rule
  (`popup/popup.js:583-625`) and will paint a red ✗ on every non-mock rule the user owns.
- **User impact / who cares:** Anyone who trusts the affordance. A red ✗ on a rule that works
  perfectly is worse than no test button — it actively sends users to debug a non-problem. And the
  users most likely to press it are new ones.
- **Evidence:** `service_worker/background.js:198-202` (dispatch), `:314-316` (`if (!rule.response)
  → 'Response configuration is required'`), `:310-312` (method required);
  `popup/popup.js:495` (maps `passed` straight to the status icon).
- **Effort:** M
- **Recommendation:** Two fixes, both required. (a) Make `validateRule` type-aware immediately —
  this is a ~20-line change and stops the false failures. (b) Then make Test *actually test*: let
  the user supply a sample URL (or pick one from the capture list, G-2), run the matcher against
  it, and report which rule would win, why the others didn't, and what body would be returned. A
  dry-run matcher explanation is more valuable than a live fetch and has none of the side effects.

### [High] G-4: No rule organization — no groups, no ordering control, no scoping

- **Gap:** Rules are a flat array. Precedence is first-match in array order (`src/matcher.js:96-112`)
  — which means the array order is load-bearing behaviour that the user can neither see nor change.
  There is no `group`/`folder` concept, no tags, no pinning, no per-rule enable-by-domain, and no
  way to activate a set of rules together.
- **User impact / who cares:** Anyone past their first week. Two rules matching `*/api/*` silently
  shadow each other with no indication which one won. Anyone maintaining rules for more than one
  project has to hand-toggle a dozen checkboxes when they switch context.
- **Evidence:** `src/matcher.js:96-112`; `src/storage.js:75-100` (flat persist); grepped
  `group`, `folder`, `priority`, `reorder`, `drag`, `pinned`, `favorite` → no product usage
  (only CSS class names and `service_worker/dnr.js:109`'s constant DNR priority).
- **Effort:** M
- **Recommendation:** Add `groupId` + a `groups` collection with a group-level enabled toggle, and
  expose drag-to-reorder in the new rule manager (G-1) with an explicit "first match wins" hint.
  Then brand groups as **Scenarios** (see Differentiation) — same primitive, far better story.

### [High] G-5: Rules apply globally to every tab and every site; there is no source filter

- **Gap:** A rule's match block supports only `url`, `method`, `headers`, `graphql`
  (`src/matcher.js:92-114`). There is no page-URL condition, no resource-type condition, and no
  "this tab only" mode. State broadcasts to every tab (`service_worker/background.js:363-380`) and
  the interceptor is injected into `<all_urls>` in all frames (`manifest.json` content_scripts).
- **User impact / who cares:** Anyone who has more than one app open, which is everyone. A rule
  written for localhost silently fires on staging, on production, and on unrelated sites that
  happen to have `/api/` in a URL. The blast radius of a forgotten enabled rule is the entire
  browser — this is how users end up debugging a "production bug" that is their own mock.
- **Evidence:** `src/matcher.js:92-114`; `manifest.json` content_scripts `matches: ["<all_urls>"]`,
  `all_frames: true`; `service_worker/background.js:372-376`.
- **Effort:** M
- **Recommendation:** Add `match.source` — an optional page-origin/URL condition — plus a prominent
  "active tab only" toggle in the popup. Surface an unmissable badge/warning when rules are enabled
  on a domain the user isn't currently working on.

### [High] G-6: No feedback that a rule is (or isn't) matching

- **Gap:** `hitCount` exists in the schema and is faithfully copied on every save
  (`options/options.js:611`, `content/overlay.js:446`) but is **never incremented** anywhere. The
  rule list therefore shows no hit count, no "last matched", and no "never matched" warning. The
  DevTools panel shows matches but is a separate surface with a 2-second poll and no link back to
  the rule.
- **User impact / who cares:** Everyone debugging the #1 support question for every tool in this
  category: *"why isn't my rule firing?"* Today the answer requires reading response headers by
  hand. A rule that has never matched is the single highest-signal thing the UI could show and it
  shows nothing.
- **Evidence:** grepped `hitCount` across all JS — assignments only, no increment;
  `service_worker/background.js:212-221` (`logInterception` bumps the global counter only, not
  the per-rule one); `popup/popup.js:163-210` (card renders no hit data).
- **Effort:** S
- **Recommendation:** Increment `hitCount` and store `lastMatched` in the `logInterception`
  handler (the rule id is already in the entry, `content/injected.js:71`). Render "42 hits · 3m
  ago" on each rule card and a muted "never matched" chip on rules that have been enabled for a
  while with zero hits. This is the cheapest large UX win available.

### [High] G-7: Missing table-stakes rule types — modify request body, replace-string-in-URL, script injection

- **Gap:** The interceptor forwards `config`/`body` untouched on every non-mock path
  (`content/injected.js:164`, `:180`, `:188`, `:481`, `:493`), so request bodies cannot be
  modified. Redirect replaces the whole URL (`content/injected.js:88-99`) — there is no substring
  replacement. There is no JS/CSS injection rule type at all.
- **User impact / who cares:** Modify-request-body is a genuine daily need (force a flag in a
  request payload, test server-side validation, strip a field). Replace-string-in-URL is the
  fastest way to swap `v1`→`v2` or `prod`→`staging` across dozens of endpoints without a regex.
  Script injection is how people patch a broken third-party widget in production.
- **Evidence:** absent — grepped `requestBody`, `modifyBody`, `insertScript`, `injectScript`;
  `content/injected.js:119-248` never constructs a modified body.
- **Effort:** M for request-body + URL-replace (both fit the existing interceptor cleanly);
  M–L for script injection, which carries real Chrome Web Store review risk.
- **Recommendation:** Ship request-body modification and replace-string-in-URL. **Defer script
  injection** — see "Explicitly not doing".

### [High] G-8: Chaos mode is fully implemented and completely unreachable

- **Gap:** Random failure injection works in both fetch and XHR paths and has a persisted default
  shape, but there is **no control anywhere in the UI** to enable it. Grepping every HTML file,
  the popup, the options page and the overlay turns up zero chaos controls. The only place it is
  toggled is a test harness (`tests/simulation.html:140`) — which uses a *different, incompatible*
  shape (`chaosMode: <boolean>`, `chaosRate`) than the code reads
  (`settings.chaosMode.enabled`, `.failureRate`).
- **User impact / who cares:** Resilience testing is a real, differentiated use case ("does my app
  survive 10% failures?") that TurboMock has already paid the engineering cost for and ships to
  nobody. Free feature, zero distribution.
- **Evidence:** `content/injected.js:127-132`, `:461-476`; `src/storage.js:29-32`;
  grep of all `*.html` for "chaos" → only `tests/simulation.html`.
- **Effort:** S
- **Recommendation:** Add a chaos toggle + failure-rate slider to the options General tab and a
  one-click chaos switch in the popup. Market it as "Chaos mode" — it is a memorable, screenshot-
  able feature that no competitor in this category advertises. Fix the test harness shape mismatch
  at the same time.

### [Medium] G-9: Two divergent rule editors, and the primary one is the weaker one

- **Gap:** The Shadow-DOM overlay (`content/overlay.js:181-307`) and the options modal
  (`options/options.html:288-473`) are independent reimplementations of the same form with
  independent validation (`content/overlay.js:429-525` vs `options/options.js:311-639`). The
  overlay — which is the *default* path from the popup — lacks the Quick Template dropdown, the
  "Format JSON" button, and the Insert-GUID/Insert-Timestamp helpers. Meanwhile the overlay's
  ~600 lines are injected into every page at `document_idle` on `<all_urls>` whether or not the
  user ever opens it.
- **User impact / who cares:** New users, who get routed to the editor *without* the templates
  that would have taught them the product. Plus the maintenance tax: every future field must be
  built twice and validated twice, and the two already disagree (the modal blocks DNR-backed types
  from carrying header/GraphQL conditions via `hasForbiddenMatch` on the *original* rule,
  `options/options.js:354-358`; the overlay checks the *newly built* rule, `content/overlay.js:520`).
- **Evidence:** `content/overlay.js:181-307`, `:429-525`; `options/options.html:288-473`;
  `options/options.js:311-639`; `manifest.json` third content_scripts entry.
- **Effort:** M
- **Recommendation:** One editor, rendered into both hosts. At minimum, port templates + Format
  JSON + placeholder inserts into the overlay this release, and lazy-inject the overlay on demand
  via `chrome.scripting.executeScript` instead of on every page load.

### [Medium] G-10: Declared keyboard shortcuts do nothing

- **Gap:** `manifest.json` declares `toggle-extension` (Ctrl+Shift+M) and `new-rule`
  (Ctrl+Shift+N) with suggested keys. There is **no `chrome.commands.onCommand` listener anywhere
  in the codebase**. Both shortcuts are inert. `README.md:144-145` documents them as working, and
  the storage defaults carry a `shortcuts` object (`src/storage.js:25-28`) that nothing consumes.
- **User impact / who cares:** Power users — exactly the segment a dev tool needs as advocates —
  and Chrome surfaces these bindings on `chrome://extensions/shortcuts`, so users will find and
  try them.
- **Evidence:** `manifest.json` `commands` block; grepped `onCommand` and `chrome.commands` across
  all JS → zero hits; `README.md:144-145`.
- **Effort:** S — roughly 15 lines in `service_worker/background.js`.
- **Recommendation:** Implement the listener. `toggle-extension` reuses the existing
  `toggleExtension` path; `new-rule` reuses the existing `openRuleOverlay` message with the
  options-page fallback already written in `popup/popup.js:569-578`.

### [Medium] G-11: Six settings are collected, validated, and never used

- **Gap:** The options page persists and validates `defaultHeaders`, `requestTimeout`,
  `maxResponseSize`, `cacheSize`, `notifications`, and `autoBackup`. **None are read by any
  runtime code.** The interceptor never applies default headers; nothing enforces a timeout or a
  size cap; no notification is ever raised (and the `notifications` permission isn't even in the
  manifest, despite `README.md:184` listing it); no backup is ever created — `createBackup`,
  `getAllBackups`, `restoreFromBackup`, `restoreFromFile` and `getStorageUsage` in `src/storage.js`
  are all uncalled. `maxResponseSize` and `cacheSize` are validated against form fields that don't
  exist in the HTML at all.
- **User impact / who cares:** Trust. A settings page full of switches that do nothing teaches
  users not to believe the rest of the UI. "Auto Backup: on" is actively dangerous — a user who
  believes it will not export, and will lose their rules to a Factory Reset
  (`options/options.js:1333-1357`, which wipes storage with no export prompt).
- **Evidence:** `options/options.html:104-141`, `:193-215`; `options/options.js:789-800`,
  `:1457-1489`; `src/storage.js:315`, `:384`, `:406`, `:431`, `:468` (all uncalled — grepped);
  `manifest.json` permissions (no `notifications`).
- **Effort:** S to delete; M to implement backups + restore properly.
- **Recommendation:** Delete `maxResponseSize`, `cacheSize`, `requestTimeout` and `notifications`
  now. Either wire `defaultHeaders` into `content/injected.js:236` (three lines) or delete it.
  Implement Auto Backup for real — the storage layer is already written and tested-looking — and
  add a restore UI plus an "export first?" prompt on Factory Reset.

### [Medium] G-12: The DevTools panel is a log, not a workspace

- **Gap:** The panel polls every 2 seconds (`devtools/panel.js:18`, `:206`) and renders five
  metadata columns per entry (`devtools/panel.js:159-174`). No request or response bodies, no
  headers, no filter or search, no click-through to the rule, no "create rule from this entry",
  no export. The buffer is capped at 200 (`service_worker/background.js:35`) and lives in session
  storage, so it dies with the browser session.
- **User impact / who cares:** Anyone debugging a mock that fires but returns the wrong thing —
  the panel confirms *that* a rule matched but never *what it returned*, which is usually the
  actual question. Polling also makes the panel feel laggy next to Chrome's own Network tab.
- **Evidence:** `devtools/panel.js:18`, `:102-114`, `:159-174`;
  `service_worker/background.js:35`, `:212-221`, `:274-287`.
- **Effort:** M (bodies + filter + click-through); L if merged with full traffic capture (G-2).
- **Recommendation:** Fold this into G-2. One panel showing all traffic, with bodies, a filter,
  a "matched by <rule>" link, and per-row rule creation. Replace polling with a push message from
  the background on new entries.

### [Medium] G-13: The README materially overstates the shipped product

- **Gap:** Verified README claims that are false against the code: (a) "Rule Templates … including
  Success/Error/Not Found/Unauthorized responses, Delayed Response" (`README.md:155`) — those five
  live in `src/utils.js:277-351`, which is never called by any UI, and `src/utils.js` is not even
  loaded by `popup.html` or `options.html`; only the six templates in `options/options.js:658-702`
  exist in-product. (b) `notifications` listed as a requested permission (`README.md:184`) — not in
  `manifest.json`. (c) Keyboard shortcuts documented as working (`README.md:144-150`) — see G-10.
  (d) The context menu is described as opening the options page (`README.md:34`) — it now prefers
  the in-page overlay (`service_worker/background.js:426-445`).
- **User impact / who cares:** Anyone evaluating the extension, anyone contributing, and — if this
  README ships as the Chrome Web Store listing — Web Store reviewers, for whom a permissions
  mismatch is a real flag.
- **Evidence:** as cited above.
- **Effort:** S
- **Recommendation:** Treat the README as a shipping artifact and reconcile it against the code
  before any public release. Delete `src/utils.js`'s dead template/export/import helpers rather
  than documenting them.

### [Medium] G-14: No sharing or sync story beyond a JSON file

- **Gap:** Everything persists to `chrome.storage.local` (`src/storage.js:50`, `:80`); nothing
  uses `chrome.storage.sync`. The only distribution mechanism is downloading a JSON file
  (`options/options.js:1222-1233`) and re-uploading it (`:1165-1220`). Import assigns fresh ids on
  merge (`options/options.js:1191-1195`), so re-importing an updated bundle duplicates every rule
  rather than updating it.
- **User impact / who cares:** Anyone on two machines, and any team that wants a shared "staging
  overrides" set. This is where Requestly's workspaces do real work.
- **Evidence:** `src/storage.js:50`, `:80`; `options/options.js:1165-1233`.
- **Effort:** S for `chrome.storage.sync` on small rulesets; M for a stable-id import/update model;
  L for anything hosted.
- **Recommendation:** Do the cheap 80%: `chrome.storage.sync` for cross-machine sync, and make
  import **idempotent** by preserving rule ids and offering update-vs-duplicate. Then treat a
  committed `turbomock.json` in the repo as the team-sharing story. Do **not** build a backend.

### [Low] G-15: Matching cannot express common real-world conditions

- **Gap:** Match supports URL / method / request headers / GraphQL `operationName` only. There is
  no query-parameter matching, no request-body matching beyond `operationName` (no `variables`,
  no arbitrary JSON path), no response-status condition (you cannot say "patch only when the real
  response is 200"), and no negation.
- **User impact / who cares:** GraphQL users first — `operationName` alone can't distinguish two
  invocations of the same query with different variables. Also anyone whose API differentiates by
  query string rather than path.
- **Evidence:** `src/matcher.js:92-114`; `src/matcher.js:73-85` (operationName only);
  `content/injected.js:194-207` (patch runs regardless of the real status).
- **Effort:** M
- **Recommendation:** Add `match.graphql.variables` (subset match) and a response-status guard on
  patch mode. Both are small and both directly strengthen the wedge.

### [Low] G-16: Placeholders are a fixed list with no user-defined variables

- **Gap:** 14 hard-coded placeholders (`src/placeholders.js:15-85`). No user-defined variables, no
  environments, no faker-style locale data, no sequences, no request-derived values beyond
  `{{request.url}}` and `{{request.method}}` (`src/placeholders.js:67-72`) — notably no path
  segments or query params from the matched request.
- **User impact / who cares:** Anyone generating list responses or echoing a request id back.
  Being able to write `{{request.path.2}}` to echo the resource id is the single most-requested
  shape in tools like this.
- **Evidence:** `src/placeholders.js:15-85`.
- **Effort:** S for request-derived placeholders; M for user-defined variables/environments.
- **Recommendation:** Ship `{{request.path.N}}`, `{{request.query.NAME}}`, and `{{repeat:N}}` for
  arrays. Defer full environments until Scenarios (G-4) exist, since Scenarios are the natural
  scope for a variable set.

### [Low] G-17: Dead code in user-facing paths signals unfinished product

- **Gap:** `popup/popup.js:130` and `:133` call `this.renderSettings()` and `this.renderAbout()`,
  neither of which is defined anywhere in the file — a `TypeError` waiting on any future change to
  `currentView`. `renderRuleTypeBadge()` (`options/options.js:1531`) is written and unused.
  `src/utils.js`'s `exportRules`, `importRulesFromFile`, `createRuleTemplate` and `matchUrl` are
  all unreachable because neither `popup.html` nor `options.html` loads `src/utils.js` at all.
  `demo.html` is a genuinely useful sandbox referenced from nowhere.
- **User impact / who cares:** Indirect — but `demo.html` in particular is a wasted onboarding
  asset, and the popup's undefined methods are one refactor away from a broken popup.
- **Evidence:** `popup/popup.js:124-138`; `options/options.js:1531`; `src/utils.js:214`, `:243`,
  `:277`; `popup/popup.html:97` and `options/options.html:475` (single script tag each);
  grepped `demo.html` → zero references.
- **Effort:** S
- **Recommendation:** Delete the dead paths. **Keep `demo.html`** and promote it: link it from the
  first-run screen as "Try it on a live sandbox" — it is the fastest possible route to a first
  successful interception and it costs nothing to wire up.

---

## Roadmap

Sequencing principle: **fix the surfaces that block users from ever reaching the differentiated
capability, then build the differentiated capability, then consider sharing.** Nothing that isn't
in service of "reproduce a state against a real backend, fast" earns a slot before Later.

### Now (next release) — make the product usable and honest

1. **G-1 · Rule manager in the options page.** Table view, New Rule button, filter by type/status,
   search, multi-select bulk actions, drag-to-reorder with a visible "first match wins" hint. Make
   first-run open this tab. _(M — highest absolute user value; unblocks every other workflow.)_
2. **G-3 · Fix Test.** Make `validateRule` type-aware immediately so it stops flagging five of six
   rule types as broken, then add a dry-run "which rule would win for this URL, and why" mode.
   _(M — a tool that lies about its own state is worse than one that stays silent.)_
3. **G-6 · Hit feedback.** Increment `hitCount` + `lastMatched` in `logInterception`; render
   "42 hits · 3m ago" and a "never matched" chip. _(S — cheapest large win in the backlog; answers
   the #1 user question directly.)_
4. **G-9 partial + F7/F8 · Onboarding.** Port templates, Format JSON, and placeholder inserts into
   the overlay so both editors teach; link `demo.html` from first-run as a live sandbox; replace
   the General-tab landing with a Rules landing. _(S — pure conversion work on an existing asset.)_
5. **G-10 · Wire `chrome.commands`; G-11 · delete or wire the dead settings; G-13 · reconcile the
   README.** _(S each — credibility hygiene, and all three are pre-requisites for a Web Store
   listing that survives review.)_

_Rationale for this ordering: items 1–3 are the difference between a demo and a tool. Items 4–5
are small, and shipping them alongside 1–3 is what makes the release feel like a product rather
than a patch. None of this is differentiation — it is the price of being allowed to compete._

### Next — build the wedge

6. **G-2 + G-12 · Capture → rule.** DevTools panel shows *all* traffic, with bodies, filtering, and
   per-row **Mock this / Patch this / Block / Delay** actions that prefill the editor with the real
   captured response. _(L — the single highest-leverage feature in the document: it collapses TTFV
   from unbounded to seconds *and* it is what makes patch mode approachable, because you patch
   against a body you can see.)_
7. **G-4 · Scenarios.** Rule groups with a group-level one-click activation, named for app states.
   Export/import a Scenario as a single file. _(M on top of the G-1 manager — this is the product
   story, and it is the thing a competitor cannot copy without rethinking their data model.)_
8. **G-15 + G-16 · Deepen the wedge.** GraphQL `variables` matching, response-status guard on patch
   mode, `{{request.path.N}}` / `{{request.query.NAME}}` / `{{repeat:N}}`. _(M — small, compounding,
   all aimed at the same user.)_
9. **G-7 partial · Modify request body + replace-string-in-URL.** _(M — the two genuine table-stakes
   omissions; both fit the existing interceptor without new permissions.)_
10. **G-5 · Source filters + "active tab only".** _(M — becomes urgent the moment users have enough
    rules to forget one, which items 1 and 7 will cause.)_
11. **G-8 · Ship chaos mode.** Toggle + rate slider. _(S — already built; free differentiation and a
    memorable listing bullet.)_

### Later — distribution and depth

12. **G-14 · `chrome.storage.sync` + idempotent import.** Cross-machine sync and a committed
    `turbomock.json` as the team story. _(S–M, no backend.)_
13. **HAR import → generate rules.** Drop a HAR from a bug report, get a Scenario that reproduces
    it. _(L — natural extension of capture, and a strong QA-handoff story.)_
14. **G-11 · Real backups + restore UI.** The storage layer already exists; it needs invocation and
    a restore surface. _(M.)_
15. **Environments / user-defined variables**, scoped to Scenarios. _(M.)_
16. **Firefox**, only if usage data justifies the MV3 divergence cost. _(L.)_

### Explicitly not doing (and why)

- **A hosted mock server / cloud backend / hosted file server.** This converts a zero-infrastructure
  local tool into a SaaS with accounts, billing, abuse handling, and a privacy review, and it puts
  TurboMock into direct competition with Mockoon, Postman and Requestly on their strongest ground.
  The entire reason to use a browser extension is that there is nothing to run. Ship a JSON file
  and `storage.sync` instead.
- **Session recording with video/console replay.** Requestly's SessionBook is a bug-reporting
  product wearing an interceptor's clothes. It is enormous scope, it records everything the user
  sees (a serious privacy and Web Store surface), and it serves QA-to-dev handoff rather than the
  dev inner loop TurboMock is good at. HAR import (Later #13) captures most of the value at a
  fraction of the cost and risk.
- **A desktop app or system-wide proxy.** That is Charles, Proxyman and Requestly Desktop. It also
  contradicts the positioning: "no proxy, no certificates, no setup" is the reason someone picks
  this over Charles in the first place.
- **JS-function response mode (programmable responses).** Requestly-style "write a function to
  compute the response" is genuinely more powerful than a merge patch — and it is a CSP and
  Web Store review minefield under MV3, it makes rules unshareable-by-inspection, and it dilutes
  exactly the thing that makes patch mode approachable. Revisit only if Scenarios ship and users
  are demonstrably hitting the ceiling of declarative patching.
- **Insert Script (JS/CSS injection).** Same review-risk reasoning as above, plus it serves a
  different user (someone patching a live site) than the one this roadmap is built around. Defer
  until the core loop is winning.
- **Chasing per-rule-type parity with Requestly's full catalogue.** After request-body and
  URL-replace (Next #9), stop. The remaining Requestly rule types are long-tail, and every hour
  spent on them is an hour not spent on Scenarios — which is the only thing on this list that a
  competitor cannot ship next quarter.
