# Privacy Policy — SpliceTap

SpliceTap is a local development tool. It does not collect, transmit, sell,
or share any data with the developer or any third party.

## What SpliceTap stores, and where

Everything SpliceTap stores lives in `chrome.storage` on your own device —
Chrome's built-in extension storage, never a remote server:

- **Rules** (`chrome.storage.local`) — the mock/block/delay/redirect/headers/
  query-param rules you create: names, URL patterns, methods, response
  bodies/headers, and the internal DNR rule id used to register
  `headers`/`queryparams` rules with `chrome.declarativeNetRequest`.
- **Settings** (`chrome.storage.local`) — theme, debug mode, chaos mode
  configuration, keyboard shortcut preferences.
- **Stats** (`chrome.storage.local`) — a running count of intercepted
  requests and the last-reset timestamp, for the popup's stats display.
- **Interception log** (`chrome.storage.session`) — the last 200 intercepted
  requests' metadata (URL, method, rule name/type, response status) so the
  DevTools panel keeps history across service-worker restarts within a
  browser session. Session storage clears automatically when the browser
  closes. Response and request **bodies are never stored**, only metadata.
  Common sensitive query-string parameters (tokens, API keys, session ids)
  are redacted before a URL is written to this log.

None of the above ever leaves your device. SpliceTap has no backend, no
analytics SDK, and no telemetry — a repo-wide search confirms the only
network requests the extension code itself ever issues are the pass-through
`fetch()` calls the interceptor makes on your behalf when a rule is in
"patch" mode (to fetch the real response it then modifies) — never a request
initiated independently by the extension to any SpliceTap-controlled server,
because none exists.

## What SpliceTap can see

To do its job, SpliceTap's content scripts run on every page you visit
(`<all_urls>` host permission) and can observe `fetch`/`XMLHttpRequest`
traffic on those pages in order to match it against your rules. This access
is used only to apply your rules and log the metadata described above — it
is never transmitted anywhere.

## Rule import

If you import a rules JSON file (Options → Rules → Import), it is read
locally and validated before being applied; it is never uploaded anywhere.

## Questions

Open an issue at the project's GitHub repository.
