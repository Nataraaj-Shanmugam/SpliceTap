# SpliceTap vs Requestly — feature parity, gaps and bugs

**Compared:** SpliceTap 0.0.1 against Requestly's browser extension, as
documented in its current interceptor docs (sources at the end), on
10 October 2026.

**How SpliceTap was tested:** headlessly, in Chrome for Testing 148, with the
real unpacked extension, driving real pages and reading what actually reached
the network from the test server's side. Every ✅ below is backed by a test in
`tests/e2e/` — 244 headless tests in total — not by reading the code. Every
"SpliceTap cannot" claim is pinned in `tests/e2e/parity-limits.e2e.test.js`,
so it fails, and forces this page to be updated, if it ever stops being true.

Requestly was **not** run; its column comes from its documentation.

---

## Verdict

For **mocking and shaping API calls a page makes with `fetch` or
`XMLHttpRequest`** — the core of what both products are used for — SpliceTap
is at parity, and ahead in places: chaos mode, capture-to-mock, declarative
JSON-merge patching, request-header match conditions, delays beyond
Requestly's 5-second extension cap, and no account or telemetry at all.

It is **not** a full Requestly replacement. The largest gaps:

1. **Reach.** Block, redirect and delay act only on `fetch`/XHR. Requestly
   also reaches scripts, stylesheets, images and documents — which is how its
   most common workflow, "point the production bundle at my local build",
   works. SpliceTap cannot do that today.
2. **Migration.** There is no importer for Requestly rules (or ModHeader,
   Charles, Resource Override). A Requestly export is now *recognised* and
   explained, but not converted.
3. **Targeting.** No "only on these sites" (page-domain) filter, and no
   resource-type filter.
4. **Programmability.** No request-body rule, and no JavaScript response
   transform; SpliceTap's answer is merge patches and placeholders, which cover
   most cases without code but not all.
5. **The surrounding platform** — team sync, session recording, an API client,
   hosted mocks — is out of scope by design: SpliceTap is local-only.

## Rule types

| Requestly | SpliceTap | Notes |
|---|---|---|
| Modify API Response — static | ✅ | `mock` rule. Status, headers, body, delay; served without the network. Verified for 10 status codes, Unicode, 1 MB bodies, every fetch/XHR body reader. |
| Modify API Response — dynamic (JavaScript) | ◑ | No code. Covered instead by JSON Merge Patch (`patch` mode) and 14 placeholders (`{{guid}}`, `{{request.url}}`, …). Not covered: logic that depends on the response. |
| Modify API Response — status override, keep real body | ✗ | `patch` mode always keeps the real status (pinned). |
| Modify API Response — GraphQL operation | ✅ | `match.graphql.operationName`, over fetch, XHR and `Request` bodies. |
| Modify Request Body | ✗ | No rule type (pinned). |
| Modify Headers | ◑ | Set and remove, request and response, applied by declarativeNetRequest and verified on the wire. No "append". Deliberately fetch/XHR only (C-11), where Requestly also reaches documents and subresources. |
| Cancel Request | ◑ | `block`, fetch/XHR only — an `<img>` or `<script>` is not blocked (pinned). |
| Modify Query Params | ◑ | Add, replace and remove, on the wire. No "Remove All". |
| Modify User Agent | ◑ | Via a headers rule (and the *Custom User-Agent* template); the header changes, `navigator.userAgent` does not. No device presets. |
| Redirect / Map Remote | ◑ | `redirect`, with `$1`–`$9` from a regex; keeps method, body and headers. fetch/XHR only — a `<script src>` is not redirected (pinned). |
| Replace String (in URL) | ◑ | Achievable with a regex redirect and capture groups, for fetch/XHR. |
| Delay | ✅ ★ | fetch/XHR up to 30 s (verified at 6 s); Requestly's extension caps fetch/XHR at 5 s. Not applicable to other resources. |
| Insert Script (JS/CSS) | ✗ | Not planned: arbitrary page injection is a Web Store review risk and overlaps userscript managers. |
| Map Local (local file) | ✗ | A Requestly desktop-app feature. |

## Matching

| Requestly | SpliceTap | Notes |
|---|---|---|
| Source on URL | ✅ | Full URL, case-insensitive. |
| Source on Host / Path | ◑ | No separate fields; expressed in the pattern. |
| Contains / Wildcard / Regex | ✅ | Substring, anchored wildcard, `/regex/` — 21 matching tests. |
| Equals | ◑ | Via `/^…$/`. |
| Filter: request method | ✅ | Including `*`. |
| Filter: page domain | ✗ | No "only when I am on site X". |
| Filter: resource type | ✗ | Interception is fetch/XHR only. |
| Filter: payload key/value | ◑ | GraphQL `operationName` only. |
| Request **header** conditions | ★ | `match.headers`, case-insensitive name, substring value, all must match — no Requestly equivalent in its documented filters. |
| Cross-origin APIs | ✅ | Mocks answer a third-party URL whose server sends no CORS headers. |

## Workflow and platform

| Requestly | SpliceTap | Notes |
|---|---|---|
| Enable/disable rules, master switch | ✅ | Plus toggle-all; badge shows count / OFF / REC. |
| Rule order / precedence | ✅ | First match wins; reordering changes the winner. |
| Rule groups | ✗ | Ordering only. |
| "Test" a rule | ◑ | SpliceTap's Test re-checks structure only; Requestly opens a page and reports whether the rule applied. |
| Templates | ✅ | Seven, each verified for its stated purpose (two were broken — see bugs). |
| Export / import own rules | ✅ | Including v1 files and replace-vs-merge. |
| Import from Requestly / ModHeader / Charles / Resource Override | ✗ | A Requestly export is now detected and explained instead of rejected as "invalid". |
| Execution visibility | ✅ | DevTools panel log (redacted), per-rule hit counts, "Not applied" marker for rules Chrome refused. |
| Session recording / HAR | ✗ | No recording or HAR export. |
| Team sync, sharing, workspaces | ✗ | Not planned: SpliceTap stores nothing off-device. |
| API client, hosted mock server, file server | ✗ | Separate products; out of scope. |
| Browsers | ◑ | Chrome 120+, tested. Requestly lists Chrome, Firefox, Edge, Brave, Arc, Vivaldi and Opera. |

## SpliceTap-only (★)

- **Chaos mode** — fail a chosen percentage of all requests (verified at 100 % and ~50 %).
- **Capture → mock** — record a real response and turn it into a mock or a patch, locally.
- **JSON Merge Patch** — edit part of a real response without code.
- **Dynamic placeholders** — 14, verified for format.
- **Request-header match conditions.**
- **Delays beyond 5 s** for fetch/XHR.
- **Local-only** — no account, no backend, no telemetry; unminified, auditable source.

---

## Bugs found by this pass — all fixed

Each has a test that was shown failing on the code before the fix.

| # | Severity | Bug |
|---|---|---|
| P-1 | **High** | A page that was loading while rules changed ended up running an **older** rule set — in 29 of 30 trials. The load-complete push sent a snapshot captured 500 ms earlier, and broadcast retries resent their first attempt's snapshot. States now carry a version; the relay discards anything older, and delayed sends build the current state. |
| P-2 | **High** | The **CORS Unblock** and **Custom User-Agent** templates matched `*://localhost/*`, which needs `localhost/` literally — so neither worked for a local API on a port (`localhost:3000`), their main use. Now a regex for `localhost`/`127.0.0.1` with any port, which still refuses `localhost.attacker.com`. Rules already created from the old templates keep the old pattern. |
| P-3 | Medium | The documented **Alt+Shift+N** shortcut was never assigned: Chrome refuses it as a conflict, leaving "new rule" with no shortcut. Now **Alt+Shift+E**, verified assigned. |
| P-4 | Medium | **Capture from a relative URL** built a rule from the raw path — query string included — and a path like `/api/` became the regex `/api/`, mocking every URL containing "api". Logs and captures now record absolute URLs, and captured patterns are always `*<path>*`. |
| P-5 | Medium | A mock header `content-type: text/html` (lowercase) was **joined** with the default, serving `application/json, text/html`. |
| P-6 | Low | `{{randomString:20}}` returned 11 characters; `{{randomString}}` was occasionally shorter than 10. |
| P-7 | Low | `{{randomInt:max}}` never returned `max`, though documented as 0–max. |
| P-8 | Low | Mocked XHRs never fired `loadstart`. |
| P-9 | Low | A mocked XHR's `responseURL` was empty. |
| P-10 | Low | The DevTools log recorded relative URLs, losing the origin. |
| P-11 | Low | A Requestly export was reported as "skipped N invalid". |
| P-12 | Low | The editor showed a Status Code field in patch mode, where it has no effect. |

**Known limitation (not fixed):** a *delayed* XHR fires `loadstart` when the
request leaves after the delay, not immediately. Announcing it early as well
would deliver it twice, and the native one cannot be suppressed — on an XHR,
listeners run in registration order even when ours is capture-phase (verified
in Chrome). `fetch` is unaffected.

---

## Closing the gaps — recommended order

| | Gap | Effort | Recommendation |
|---|---|---|---|
| 1 | **Import Requestly rules** — convert Redirect, Cancel, Delay, Headers, QueryParam, static Response and UserAgent; name the rest as unconvertible | Small–medium | **Build.** The most direct adoption lever, and Requestly itself ships importers for three competitors. |
| 2 | **Page-domain filter** — "only on these sites" | Medium | **Build.** Matcher, schema, editor, and `initiatorDomains` for network rules. |
| 3 | **Reach scripts, styles, images** for redirect and block | Medium | **Build** the redirect half via declarativeNetRequest — "point prod's bundle at localhost" is a headline Requestly use. |
| 4 | **Real Test** — try a URL against a rule, live, in the editor | Small | **Build.** Pattern mistakes are the commonest rule bug. |
| 5 | **Status override in patch mode** | Small | Build. |
| 6 | **HAR export** of the interception log and captures | Small | Build. |
| 7 | Query param *Remove All*, header *Append* | Small | Build when convenient. |
| 8 | Modify request body (static, merge patch) | Medium | Consider. |
| 9 | Rule groups | Medium | Consider. |
| 10 | JavaScript response transforms | — | Not recommended: page CSP decides whether it can run at all; patch and placeholders cover most cases. |
| 11 | Insert Script | — | Not recommended: Web Store review risk. |
| 12 | Sync, sharing, recording, API client, hosted mocks | — | Not recommended: contradicts local-only, and each is a product of its own. |

---

## Sources (Requestly)

- [HTTP rule types](https://interceptor-docs.requestly.com/http-rules/rule-types)
- [Rules API schema](https://interceptor-docs.requestly.com/public-apis/create-rule)
- [Modify API Response](https://interceptor-docs.requestly.com/http-rules/rule-types/modify-response-body)
- [Delay Network Requests](https://interceptor-docs.requestly.com/http-rules/rule-types/delay-network-requests)
- [Advanced filters](https://interceptor-docs.requestly.com/http-rules/advanced-usage/advance-filters.md)
- [Modify Request Body](https://docs.requestly.com/general/rule-types/modify-request-body)
- [Import from ModHeader](https://docs.requestly.com/general/imports/modheader), [Resource Override](https://docs.requestly.com/general/imports/resource-override), [Charles](https://requestly.com/blog/how-to-migrate-from-charles-proxy/)
- [Product overview](https://requestly.com)
