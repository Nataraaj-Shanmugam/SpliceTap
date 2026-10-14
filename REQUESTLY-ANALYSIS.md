# How Requestly works — an analysis

**Date:** 14 October 2026 · **Purpose:** understand Requestly's architecture well enough to decide
what SpliceTap should copy, what it should avoid, and where it already differs. This complements
[PARITY.md](PARITY.md), which compares features; this document is about *mechanisms*.

## How this was analysed

Every claim below carries its basis:

| Tag | Meaning |
|---|---|
| **[source]** | Read in Requestly's open-source extension and web app, [requestly/interceptor](https://github.com/requestly/interceptor) at `6209537` (29 Sep 2026). Read only, not executed: the extension was not installed or run, so these describe the code as written, not measured behaviour. |
| **[REA]** | Static analysis of the public web app's JavaScript bundle (`app.requestly.io`, signed out) with REA 6.5.0 (`analyze-web-bundle`). |
| **[observed]** | Hosts the public web app contacted while loading in headless Chrome, signed out, with nothing submitted. |
| **[site]** | requestly.com's own product pages. |

Not covered:

- the desktop proxy app and the API Client, which is proprietary;
- anything behind sign-in;
- the shipped `.crx`, which wasn't downloaded, since its source is public.

---

## 1. The product today

- **Owner [site].** "A BrowserStack product"; the site footer is BrowserStack, Inc.
- **Product lines [site] [source]:**
  - **HTTP Interceptor:** browser extension for Chrome, Edge, Firefox and Safari, plus a desktop proxy
    app ([http-interceptor-desktop-app](https://github.com/requestly/http-interceptor-desktop-app)).
  - **API Client:** desktop, Git-native, proprietary.
  - **Mock servers.**
  - **File Server.**
  - **SessionBear:** a separate session-recording extension, found in
    `browser-extension/sessionbear/`.
  - **Also:** an MCP server, a web SDK, and Cypress/Selenium/Playwright integrations.
- **Data [site].** Local projects (files kept in Git), team workspaces that sync, or self-hosted.
  Flat per-user pricing; SOC 2 and SSO.
- **Rule types [source]**, from `common/rule-processor/src/processors`: Redirect, Replace,
  Query Params, Cancel (block), Headers, User-Agent, Delay, Modify Response, Modify Request
  (body), Insert Script.

---

## 2. Architecture of the extension

```
 app.requestly.io (web app: rule editor, account, sync)
        │  app.cs.js — content script injected on Requestly's own domains only
        ▼
 Service worker ──────────────► declarativeNetRequest
   rulesManager                   • dynamic rules: one Requestly rule → its precompiled
   clientHandler                    `extensionRules` (redirect, replace, query params,
   webRequestInterceptor            cancel, headers, user-agent), all resource types
   requestProcessor               • static rule sets: delay_rules, header_rules
   desktopApp, proxy              • per-request session rules (see §4)
        │
        │  chrome.scripting.registerContentScripts  (MAIN world, document_start, all frames)
        │  chrome.scripting.executeScript on every navigation → window.__REQUESTLY__
        ▼
 Page (MAIN world): ajaxRequestInterceptor — fetch + XHR wrappers
   reads rules from window.__REQUESTLY__.{responseRules, requestRules, delayRules}
        │  window.postMessage({ source: "requestly:client", … })
        ▼
 client.cs.js (isolated world, all http(s) frames) — relays to the service worker
```

**How each rule type is executed [source]:**

| Rule type | Mechanism | Reach |
|---|---|---|
| Redirect, Replace, Query Params, Cancel, Headers, User-Agent | DNR dynamic rules. The extension installs each rule's ready-made `extensionRules`: `rulesManager.ts` only copies them, so they are compiled before they reach the extension. | Every resource type by default (`ALL_RESOURCE_TYPES`): documents, scripts, images, fonts, websockets… |
| Modify Response | Page-script fetch/XHR wrappers. **By default the real request is still made** and its body replaced. A "serve without request" option skips the network for static bodies. | fetch/XHR only |
| Modify Response / Request with **code** | The rule's JavaScript is compiled with `new Function` and run in the page, with a shared `$sharedState` object. | fetch/XHR only, and the page's CSP can block it (`handleCSPError.ts`) |
| Modify Request body | Page script rebuilds the `Request`. | fetch/XHR only |
| Delay, fetch/XHR | Page script awaits a `setTimeout`. | fetch/XHR |
| Delay, everything else | A static DNR rule redirects any URL carrying `_rq_delay_=<ms>` to **`https://app.requestly.io/delay/<ms>/<original URL>`**. The delay happens on Requestly's server. | All resource types, via Requestly's server |
| Insert Script | `chrome.scripting` injection into matching documents on navigation. | Documents |
| Desktop app | The extension scans localhost ports with a WebSocket handshake to find the app, then sets Chrome's proxy (`chrome.proxy`, `fixed_servers`) to it. The app is a MITM proxy, so it sees every body. | Everything, via the desktop proxy |

**Matching [source]** (`common/ruleMatcher.ts`):

- **Source key:** URL, Host or Path.
- **Operators:** Equals, Contains, Matches (regex) and Wildcard-Matches.
- **Filters:** page URL, resource type, method, and request payload (GraphQL).
- **URLs are resolved to absolute before matching**: `getAbsoluteUrl` uses an `<a>` element's
  `href`.
- **Precedence:** response and request rules are chosen with `findLast`, so the **last** enabled
  matching rule wins.

**Execution visibility [source]:**

- **Page-script rules (response, request):** these post a "rule applied" message.
- **Network-layer rules:** Chrome gives no per-request feedback for DNR rules. Requestly attaches
  non-blocking `chrome.webRequest` listeners (`onBeforeRequest`, `onBeforeSendHeaders`,
  `onHeadersReceived`) that **re-run its own matcher against every request** and record a
  "rule executed" event when it matches. This is an inference that the rule applied, not
  confirmation from Chrome.
- **Network recording:** a side panel ("Network Interceptor v2") builds HAR files, with bodies
  captured by a page script.

---

## 3. The web app [REA] [observed]

- **Bundle:** one JavaScript bundle of **12.9 MB** (Vite build; React). REA's static pass found the
  rule-sync endpoint `https://api2.requestly.io/v1/rules`, GraphQL queries, and Sentry tracing
  headers.
- **Third parties:** signed out, a page load contacted about 30 third-party hosts:
  - **payments:** Stripe (`js.stripe.com`, `m.stripe.network`, `q|r|m.stripe.com`);
  - **support and AI chat:** Freshchat (`browserstackhelp.freshchat.com`) and a Botsonic/Writesonic
    chat widget;
  - **analytics and ads:** Google Analytics, Tag Manager and DoubleClick;
  - **feature flags:** GrowthBook;
  - **error tracking:** Sentry;
  - **IP geolocation:** two services (`geolocation-db.com`, `api.ipgeolocation.io`);
  - **sign-in:** Google;
  - **other:** Cloudflare Insights and the GitHub API (star count).
- **Sync:** accounts, sync and team workspaces sit behind sign-in, which this analysis did not
  enter.

---

## 4. Security, privacy and performance observations

These come from reading the source, not from running the extension. Treat them as strong leads,
not measurements.

1. **Every page can read your rules [source].**
   - `clientHandler.ts` injects `{ responseRules, requestRules, delayRules }` into
     `window.__REQUESTLY__` in the page's own JavaScript world. It does this in every frame, on
     every navigation and every rule change.
   - Any script on any site you visit can read your mock bodies, response *code* and URL patterns
     with `window.__REQUESTLY__.responseRules`.
   - *SpliceTap fixed exactly this class of leak in PER-1/PER-2.* Its rules travel on a
     single-use, nonce-keyed channel and are never exposed as a page global.
2. **The page channel is unauthenticated [source].** The page script and content script talk
   over `window.postMessage` with `source: "requestly:client"`, so any page script can send
   those messages too: forged "rule applied" events, `onBeforeAjaxRequest` round trips.
3. **User code runs inside the site [source].** Code-type rules are compiled with `new Function`
   in the page's origin, with the page's privileges and next to its secrets. That's powerful,
   but the code runs wherever the rule matches.
4. **Delayed resources pass through Requestly's server [source].** Non-fetch/XHR delays redirect
   the full original URL, query string included, to `app.requestly.io/delay/…`. Tokens in
   those URLs leave the machine.
5. **A round trip before every fetch and XHR [source].**
   - Unless a static mock is served without a request, every wrapped fetch/XHR first awaits
     `notifyOnBeforeAjaxRequest`. That's a page → content script → service worker round trip,
     with up to **2 s** before it gives up, *even when no rule matches*.
   - The service worker uses it to install per-request DNR **session** rules: header forwarding
     on redirect, and initiator-dependent header rules.
   - Not measured here, but its cost grows exactly when the worker is asleep.
6. **Broad permissions [source].**
   - `proxy`, `webRequest`, `scripting`, `tabs`, `browsingData`, `webNavigation`,
     `unlimitedStorage` and `<all_urls>`, plus `externally_connectable` for `*.browserstack.com`,
     `*.bsstag.com` and one other extension.
   - SpliceTap asks for `storage`, `contextMenus` and `declarativeNetRequestWithHostAccess`, plus
     host access to all sites. It has no `externally_connectable` and no web-accessible resources.
7. **Possible bug: only the first delay rule is checked [source].**
   `getMatchedDelayRule` returns inside the first loop iteration. If the first enabled delay rule
   doesn't match, later delay rules are never consulted for fetch/XHR. Read from the code; not
   reproduced.

---

## 5. What this means for SpliceTap

**Worth adopting** — all five were built on 15 October 2026, the SpliceTap way described in the
third column: the network observer behind an optional permission, all-request block/redirect
via declarativeNetRequest, opt-in code responses (global switch, off by default), request-body
rules, and HAR export from the DevTools panel. See README and PARITY.md.

| Idea | Requestly's way | Suggested SpliceTap way |
|---|---|---|
| Header/query rules appear in the log (closes the PER-54 gap) | `webRequest` listeners re-match every request | Ask for `webRequest` as an **optional** permission at runtime (`chrome.permissions.request`) when the user wants the log, so the install-time permission set stays minimal. |
| Redirect and block for scripts, images and documents (Map Remote parity) | DNR for all resource types | Add a "network layer" option to redirect/block rules that compiles to DNR with all resource types. fetch/XHR keep the in-page path, which gives bodies, delays and GraphQL conditions. |
| Programmatic responses | `new Function` in the page | Extend placeholders and patch before considering page-context code. If added, keep it opt-in per rule, off on sites the user hasn't allowed, and documented as running in the page. |
| Modify request body | page-script `Request` rebuild | A natural fit for the existing interceptor; the PER-11 code already rebuilds a full `Request`. |
| Network recording / HAR export | side panel + body recorder | Capture already records bodies; a HAR export of the log plus captures is a modest step. |

**Where SpliceTap is already ahead**, each verified on SpliceTap's side by its own test suite:

- **No page-visible rules:** a single-use, nonce-keyed channel, with built-ins captured at load
  (PER-1, PER-2 and the contract-B hardening).
- **No per-request round trip:** rules live in the interceptor, and matching is synchronous.
- **Delays never leave the page.**
- **No account, no cloud, no third-party scripts, and a much smaller permission set.**
- **Precedence:** one documented rule, *first* enabled match wins, consistent across fetch,
  XHR and redirect (PER-10). Requestly uses last-match for response rules.

**Deliberately different:**

- **Desktop MITM proxy:** out of scope. SpliceTap stays proxy-free.
- **Insert Script:** declined, as a Web Store review risk.
- **Team sync:** declined; SpliceTap stores nothing off-device.

---

## Reproducing the REA parts

REA is registered for this project as a local-scope MCP server (`rea`, pinned to `rea-agents@6.5.0`;
remove with `claude mcp remove rea -s local`). Its MCP tools load in new sessions. The same
analysis runs from the CLI:

```bash
npx -y rea-agents@6.5.0 list-browser-targets http://127.0.0.1:9333
```

```bash
npx -y rea-agents@6.5.0 analyze-web-bundle http://127.0.0.1:9333 <targetId> --observation-ms 8000 --format json
```

These attach to any Chrome started with `--remote-debugging-port=9333` on 127.0.0.1.
