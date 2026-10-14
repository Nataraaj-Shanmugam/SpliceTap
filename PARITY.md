# SpliceTap vs Requestly — feature parity, gaps and bugs

**Compared:** SpliceTap 0.0.1 against Requestly's browser extension, as
documented in its current interceptor docs (sources at the end), on
10 October 2026. For *how* Requestly implements these features — read from
its open-source code, with the security and design differences that follow —
see [REQUESTLY-ANALYSIS.md](REQUESTLY-ANALYSIS.md).

**How SpliceTap was tested:** headlessly, in Chrome for Testing 148, with the
real unpacked extension, driving real pages and reading what actually reached
the network from the test server's side. Every ✅ below is backed by a test in
`tests/e2e/` — 408 headless tests in total — not by reading the code. Every
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

1. **Reach.** *Closed for block and redirect (15 October 2026):* with "all
   requests" ticked — the default for new rules — they reach scripts,
   stylesheets, images and page navigations through declarativeNetRequest, so
   "point the production bundle at my local build" works. Delay and mock still
   act only on `fetch`/XHR; Requestly delays other resources by routing them
   through its own server, which SpliceTap deliberately does not do.
2. **Migration.** There is no importer for Requestly rules (or ModHeader,
   Charles, Resource Override). A Requestly export is now *recognised* and
   explained, but not converted.
3. **Targeting.** No "only on these sites" (page-domain) filter, and no
   resource-type filter.
4. **Programmability.** *Closed (15 October 2026):* a **Modify request body**
   rule (static or JSON merge patch) and opt-in **code responses** (your
   JavaScript, run in the page, off until enabled in Settings). Requestly's
   code transforms can also read the *real* response; SpliceTap's code
   responses answer from the request alone, and patch mode still covers
   "change a few fields of the real response".
5. **The surrounding platform** — team sync, session recording, an API client,
   hosted mocks — is out of scope by design: SpliceTap is local-only.

## Rule types

| Requestly | SpliceTap | Notes |
|---|---|---|
| Modify API Response — static | ✅ | `mock` rule. Status, headers, body, delay; served without the network. Verified for 10 status codes, Unicode, 1 MB bodies, every fetch/XHR body reader. |
| Modify API Response — dynamic (JavaScript) | ◑ | `mock` with `response.mode: 'code'`: the body of an async function gets `request` (url, method, headers, body, json) and returns a body or `{status, headers, body}`. Opt-in in Settings; runs in the page, so the page's CSP can forbid it (the request then passes through, logged). Not covered: code that reads the *real* response — use `patch` mode for that. |
| Modify API Response — status override, keep real body | ✗ | `patch` mode always keeps the real status (pinned). |
| Modify API Response — GraphQL operation | ✅ | `match.graphql.operationName`, over fetch, XHR and `Request` bodies. |
| Modify Request Body | ✅ | `requestBody` rule: replace the body (text, JSON, placeholders) or JSON-merge-patch it, over fetch and XHR. The modified request is what later rules match and what a redirect sends. |
| Modify Headers | ◑ | Set and remove, request and response, applied by declarativeNetRequest and verified on the wire. No "append". Deliberately fetch/XHR only (C-11), where Requestly also reaches documents and subresources. |
| Cancel Request | ✅ | `block`. With "all requests" (default for new rules) it also blocks scripts, stylesheets, images and page navigations via declarativeNetRequest; unticked, fetch/XHR only. |
| Modify Query Params | ◑ | Add, replace and remove, on the wire. No "Remove All". |
| Modify User Agent | ◑ | Via a headers rule (and the *Custom User-Agent* template); the header changes, `navigator.userAgent` does not. No device presets. |
| Redirect / Map Remote | ✅ | `redirect`, with `$1`–`$9` from a regex; keeps method, body and headers, including `fetch(Request)` with a body. With "all requests" (default for new rules, needs a full destination URL) it also redirects scripts, stylesheets, images and page navigations — the "production bundle → local build" workflow. |
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
| "Test" a rule | ◑ | SpliceTap's "Check syntax" validates structure only, and each rule shows its live hit count ("N hits" / "No hits yet") as evidence it fired; Requestly opens a page and reports whether the rule applied. |
| Templates | ✅ | Eight (Modify request body added), each verified for its stated purpose. Two were broken (see bugs); the persona review found two more gaps — Redirect to localhost on absolute URLs, CORS Unblock on PUT/DELETE — now fixed (PER-9, PER-24). |
| Export / import own rules | ✅ | Including v1 files and replace-vs-merge. |
| Import from Requestly / ModHeader / Charles / Resource Override | ✗ | A Requestly export is now detected and explained instead of rejected as "invalid". |
| Execution visibility | ✅ | DevTools panel log (redacted) of every mock, block, delay, redirect and request-body rule — with the final status for delays and redirects — plus chaos failures and skipped patches; per-rule hit counts; a "Not applied" marker for rules Chrome refused. Header, query-param and all-request rules appear too once you switch on the opt-in network observer (optional `webRequest` permission), marked "Seen on the network" — like Requestly, SpliceTap infers these by matching the request itself, because Chrome does not report which network rule fired. |
| Session recording / HAR | ◑ | **HAR export** of the interception log from the DevTools panel, with response bodies from Capture where one matches. No session recording. |
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
| 3 | **Reach scripts, styles, images** for redirect and block | Medium | **Done** (15 Oct 2026): both halves, via declarativeNetRequest. |
| 4 | **Real Test** — try a URL against a rule, live, in the editor | Small | **Build.** Pattern mistakes are the commonest rule bug. |
| 5 | **Status override in patch mode** | Small | Build. |
| 6 | **HAR export** of the interception log and captures | Small | **Done** (15 Oct 2026). |
| 7 | Query param *Remove All*, header *Append* | Small | Build when convenient. |
| 8 | Modify request body (static, merge patch) | Medium | **Done** (15 Oct 2026). |
| 9 | Rule groups | Medium | Consider. |
| 10 | JavaScript response transforms | — | **Done, opt-in** (15 Oct 2026): off by default; where page CSP forbids it, the request passes through and the log says so. |
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
