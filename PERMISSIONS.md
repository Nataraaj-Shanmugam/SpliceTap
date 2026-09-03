# Why SpliceTap asks for what it asks for

SpliceTap intercepts and rewrites network requests, which means it necessarily
requests some powerful permissions. Broad permissions are exactly what a
malicious extension asks for too, so "trust us" is not good enough — this
document says precisely what each permission is for, and which code uses it, so
you can check rather than take our word for it.

Every claim below is verifiable against the source in this repository.

## The permissions

| Permission | Why it is needed | Where it is used |
|---|---|---|
| `storage` | Saves your rules, settings and statistics on your own device. | [`src/storage.js`](src/storage.js) — every read and write goes through `chrome.storage.local`, plus `chrome.storage.session` for the DevTools interception log. |
| `contextMenus` | Adds the right-click "Mock this request" entry that opens the rule editor with the current site pre-filled. | [`service_worker/background.js`](service_worker/background.js), `setupContextMenus()`. |
| `declarativeNetRequestWithHostAccess` | Applies the `headers` and `queryparams` rule types. These edit requests at the network layer, which the page-level interceptor cannot reach. The `WithHostAccess` variant only acts on sites your own rules match. | [`service_worker/dnr.js`](service_worker/dnr.js). |
| `host_permissions: <all_urls>` | The interceptor has to run on whichever site you are debugging, and there is no way to know in advance which site that is — it is your app, on your machine. | Declared in [`manifest.json`](manifest.json); the interceptor is [`content/injected.js`](content/injected.js). |

## What SpliceTap does not do

- **No network requests of its own.** There is no backend, no analytics, no
  error reporting, no update check. The only outbound request the extension ever
  makes is the pass-through `fetch()` that patch-mode rules perform against
  *your own* API, so the real response can be modified.
- **No account, no sign-in, no sync.** Nothing to log into and nothing to sync
  to. Your rules exist only on the device you created them on.
- **The DevTools log never stores bodies.** It keeps metadata only — timestamp,
  URL, method, rule name and type, status code — capped at 200 entries in
  session storage, which is cleared when the browser closes.
- **One feature does record response bodies, on request.** Capture (popup →
  Data) exists so you can build a rule from a real payload rather than retyping
  it. It is off by default, shows a **REC** badge on the toolbar icon the whole
  time it is on, keeps at most 25 textual responses of up to 100 KB each, stores
  them in session storage only, and lets you clear them at any time. Nothing
  captured is transmitted — there is nowhere for it to go.
- **Sensitive URL parameters are redacted before logging.** Common token, key
  and session parameter names are stripped from URLs before they reach the log.
- **No remote code.** Everything that runs ships in the package. There is no
  `eval`, no `new Function`, no remotely-hosted script, and no remotely-fetched
  rule payload. Manifest V3 forbids remote code, but note that it did not stop
  the July 2026 ModHeader incident — the collector there shipped *inside* the
  reviewed bundle. Which is the point of this document: the check that matters
  is the one you can run yourself.

## How to verify this yourself

1. **Read the interceptor.** [`content/injected.js`](content/injected.js) is the
   file with the most access. Search it for `fetch(` — every call is either the
   saved original being invoked on your behalf, or the pass-through for patch
   mode.
2. **Search for exfiltration.** `grep -rn "XMLHttpRequest\|fetch(\|sendBeacon\|WebSocket" content/ service_worker/ src/ popup/ options/ devtools/`
   should turn up nothing sending anywhere but your own API.
3. **Check the packaged build matches this source.** The store package is built
   by [`scripts/package-extension.js`](scripts/package-extension.js), which
   copies only files `manifest.json` actually references — no bundler, no
   minifier, no transformation. What you read here is what ships.
4. **Watch it at runtime.** Open `chrome://net-export`, start a capture, use
   SpliceTap normally, and confirm no request goes anywhere you did not ask for.

## What has not been done

Being straight about the limits, since a security claim without its caveats is
the pattern that keeps failing in this category:

- **No third-party security audit.** This is a free, solo-maintained project and
  a professional audit has not been paid for.
- **The MAIN-world interceptor shares a realm with the page.** That is inherent
  to how fetch/XHR patching works. The state channel between the extension and
  the interceptor is keyed by a per-page random nonce handed over before any
  page script can run, which removes trivial eavesdropping — but a determined
  same-realm adversary is a limitation of the technique, not something a nonce
  fully solves.
- **This project is new.** It has no track record yet. Judge it on the code.

Found something that contradicts any of this? Please
[open a security advisory](https://github.com/Nataraaj-Shanmugam/SpliceTap/security/advisories/new)
rather than a public issue.
