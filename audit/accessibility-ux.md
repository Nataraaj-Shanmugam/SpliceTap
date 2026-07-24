# Accessibility & UX Audit — TurboMock

_Reviewer lens: WCAG 2.1 AA + product usability. Method: static review of 12 files
(`popup/popup.{html,css,js}`, `options/options.{html,css,js}`, `devtools/panel.{html,js}`,
`content/overlay.js`, `manifest.json`, `service_worker/background.js`, `README.md`) on branch `V1`.
No runtime/AT verification was performed — all findings are static claims with per-finding confidence._

All contrast ratios in this report were **computed**, not estimated, from the literal hex/rgba values
found in the CSS, with translucent layers alpha-composited over their actual parent surfaces
(sRGB relative luminance, WCAG 2.x formula). The exact input values used are listed in the
[Contrast audit table](#contrast-audit-table). Two items are explicitly marked *needs manual check*.

---

## Summary

Highest-impact first:

1. **The extension's master on/off control cannot be operated by keyboard** (A-1). It is a `div`
   with `role="button" tabindex="0"` and a `click`-only listener; `Enter`/`Space` do nothing on a
   non-native button. Combined with U-6 (the declared `Ctrl+Shift+M` command has no handler at all),
   a keyboard-only user has **no way to disable TurboMock**.
2. **Most settings controls have no accessible name** (A-2). The three toggle switches on the General
   tab, plus *Default Headers* and *Request Timeout*, use `<label>` elements with no `for` attribute
   and no wrapped control. A screen reader announces "checkbox, not checked" with no indication of
   what it controls.
3. **Validation errors in the rule editor are invisible** (U-1). Three independent defects compound:
   the message element gets class `message-error` while the CSS styles `.message.error` (so no
   colour at all), `#messageContainer` lives *outside* the modal so the message renders **behind**
   the modal's `rgba(0,0,0,0.6)` blurred backdrop, and the "scroll to it" call targets `window`
   rather than the real scroll container. A failed save looks like nothing happened.
4. **No dialog semantics or focus management on the options modals** (A-4), and no focus trap or
   focus restoration on the Shadow-DOM overlay (A-5). Tab walks straight out of every dialog into
   the page behind it.
5. **Focus is invisible on every visually-hidden input** (A-3) — the theme radio picker and all four
   toggle switches hide their real `<input>` with `opacity: 0`, and nothing replaces the focus ring.
6. **24 computed contrast failures** (A-7), concentrated in the newly-added light theme (badge text
   on tinted pills at 4.07–4.32:1) and in non-text UI boundaries — in light theme the input fields
   and rule cards are `#ffffff` on `#ffffff` with a 1.28:1 border, i.e. **no visible boundary at all**.
7. **Rules can only be managed from the 380 px popup** (U-2) — the options page's "Rules" tab is
   import/export only — and there are now **two divergent rule editors** (U-3) whose selection
   depends silently on whether the current tab happens to be an `http(s)` page.

Counts: **20 accessibility findings** (1 Critical, 5 High, 7 Medium, 7 Low/Nit) and
**18 UX findings** (4 High, 8 Medium, 6 Low/Nit).

---

## Accessibility findings

### [Critical] A-1: Global status toggle is focusable but not keyboard-operable
- **Where:** `D:\Professional\AI_Generated\TurboMock\popup\popup.html:22`;
  `D:\Professional\AI_Generated\TurboMock\popup\popup.js:103`
- **WCAG:** 2.1.1 Keyboard — Level A; 4.1.2 Name, Role, Value — Level A
- **What:** The control is `<div class="status-badge" id="statusToggle" role="button" tabindex="0">`
  and the only listener attached is
  `this.addListener('statusToggle', 'click', () => this.toggleGlobalStatus())`.
  Unlike a native `<button>`, an element with `role="button"` gets **no implicit activation
  behaviour** — pressing `Enter` or `Space` while it is focused fires no `click` event. The element
  is reachable by Tab (so it advertises itself as actionable) but cannot be actuated. The rule-card
  checkbox two files over *does* implement `keydown` (`popup.js:300-306`), so the omission here looks
  accidental. Secondary problems on the same element: its accessible name is the *state*
  ("Active"/"Disabled"/"No rules", `popup.js:664-670`) rather than an action, and there is no
  `aria-pressed`, so the on/off state is never exposed.
- **Who it affects:** keyboard-only, switch-device, and screen-reader users — for whom the master
  kill-switch of a network-intercepting extension becomes unreachable. Note that `Ctrl+Shift+M` is
  *not* a fallback: see U-6.
- **Recommended fix:** make it a real
  `<button type="button" id="statusToggle" aria-pressed="false">` with a visually persistent label
  ("TurboMock enabled"), update `aria-pressed` in `updateStatus()`, and keep the status text as
  visible content. A native button gets Enter/Space for free.
- **Confidence:** High

### [High] A-2: Settings controls have no accessible name (`<label>` without `for`)
- **Where:** `options\options.html:65` (Theme), `:104` (Show Notifications), `:118` (Auto Backup),
  `:131` (Debug Mode), `:196` (Default Headers), `:208` (Request Timeout) — each is
  `<label>Text</label>` inside `.setting-info`, with the control in a sibling `.setting-control` div
- **WCAG:** 1.3.1 Info and Relationships — A; 3.3.2 Labels or Instructions — A; 4.1.2 — A
- **What:** A `<label>` with neither a `for` attribute nor a wrapped form control is inert markup —
  it labels nothing. The actual checkboxes at `options.html:110`, `:123`, `:137` are wrapped in a
  *second*, text-free `<label class="toggle-switch">`, so their accessible name computes to the
  empty string. `#defaultHeaders` (`:201`) and `#requestTimeout` (`:212`) get no name either;
  `#defaultHeaders` may fall back to its `placeholder` (itself a known anti-pattern), and
  `#requestTimeout` has no placeholder, so it is announced as a bare "spin button".
- **Who it affects:** screen-reader users (cannot tell what any General-tab toggle does), and
  speech-input users (cannot say "click Debug Mode"). Also enlarges the click target problem: the
  visible text is not a label, so clicking "Debug Mode" does not toggle it.
- **Recommended fix:** give each control an id-matched label —
  `<label for="notifications">Show Notifications</label>` — and remove the redundant wrapping
  `<label class="toggle-switch">` (make it a `<span>`). Wire the descriptive paragraph in with
  `aria-describedby`.
- **Confidence:** High

### [High] A-3: No visible focus indicator on any visually-hidden input
- **Where:** `options\options.css:420-424` (`.toggle-switch input { opacity: 0; width: 0; height: 0 }`)
  and `options\options.css:743-746` (`.theme-option input { position: absolute; opacity: 0 }`).
  Affects `#notifications`, `#autoBackup`, `#debugMode`, `#ruleEnabled`, and the
  Light/Dark/Auto radios (`options.html:71,78,85`)
- **WCAG:** 2.4.7 Focus Visible — AA
- **What:** The real inputs are hidden with `opacity: 0` (and 0×0 dimensions for the toggles). The
  browser paints its default focus ring **on the input itself**, and `opacity: 0` makes the outline
  transparent along with everything else. There is no compensating `input:focus + .slider` or
  `input:focus + label` rule anywhere in `options.css`. A keyboard user tabbing through the General
  tab passes through four controls with **zero** on-screen feedback about where focus is.
- **Who it affects:** keyboard-only, low-vision, and cognitive-load users.
- **Recommended fix:** add
  `.toggle-switch input:focus-visible + .slider,`
  `.theme-option input:focus-visible + label .theme-preview { outline: 2px solid var(--accent); outline-offset: 2px; }`.
  Prefer the `clip-path` visually-hidden pattern over `opacity: 0` so ring geometry stays sane.
- **Confidence:** High

### [High] A-4: Options modals have no dialog semantics and no focus management
- **Where:** `options\options.html:248` (`#dataModal`), `:271` (`#confirmModal`), `:288`
  (`#ruleEditorModal`); open/close logic at `options\options.js:274`, `:1295`, `:1306-1311`,
  `:1363`; Escape at `options.js:1445-1450`; backdrop click at `options.js:897-901`
- **WCAG:** 4.1.2 Name, Role, Value — A; 2.4.3 Focus Order — A; 1.3.1 — A
- **What:** All three modals are plain `<div class="modal">`. Opening is `modal.classList.add('show')`
  and nothing else. Consequently:
  - no `role="dialog"`, no `aria-modal="true"`, no `aria-labelledby` pointing at the `<h3>` —
    a screen reader is never told a dialog opened, and the "Edit Rule" heading is not the accessible
    name of anything;
  - **focus is never moved into the dialog** — it stays on the `.reset-card` button or nav item that
    opened it, i.e. on content that is now visually behind a blurred backdrop;
  - **focus is not trapped** — Tab from the last field walks out of the dialog into the sidebar and
    the settings form behind it, which are neither `inert` nor `aria-hidden`;
  - **focus is not restored** on close (`closeModal` only removes the class), so after saving a rule
    the user is dropped wherever the browser decides.
  Escape *does* close (`options.js:1445`), which is the one part that is right — but see U-4 for the
  data-loss consequence.
- **Who it affects:** screen-reader users (unannounced context change, no boundary), keyboard-only
  users (focus escapes to unreachable-looking content), magnification users (viewport chases focus
  off-dialog).
- **Recommended fix:** add `role="dialog" aria-modal="true" aria-labelledby="ruleEditorTitle"` to
  each `.modal-content`; on open, store `document.activeElement`, move focus to the first field (or
  the dialog container with `tabindex="-1"`), add a `keydown` Tab handler that cycles within the
  dialog, mark the `.app-container` `inert` while open, and restore the stored element on close.
  Migrating to a native `<dialog>` + `showModal()` gets trapping and top-layer behaviour for free.
- **Confidence:** High

### [High] A-5: Shadow-DOM overlay has dialog roles but no focus trap or restoration
- **Where:** `content\overlay.js:183` (`role="dialog" aria-modal="true" aria-label="..."`),
  `:576-584` (`open()`), `:555-561` (`close()`), `:338-340` (backdrop click), `:345-350` (Escape)
- **WCAG:** 2.4.3 Focus Order — A; 2.1.2 No Keyboard Trap — A (inverse: escape *is* handled, the
  problem is the missing containment)
- **What:** This surface does more right than the options modals — it declares
  `role="dialog" aria-modal="true"`, and `open()` focuses `#tmName` (`overlay.js:582-583`). But:
  - **no focus trap.** After the last control (`#tmSave`) Tab moves into the *host web page* —
    an arbitrary third-party site sitting under a full-viewport backdrop. The user is typing into a
    page they cannot see. `aria-modal="true"` suppresses the outside content for a screen reader's
    virtual cursor but has **no effect on Tab order**;
  - **no focus restoration.** `close()` removes the host element from the DOM outright, so
    `document.activeElement` collapses to `<body>` — a keyboard user must Tab from the top of the
    host page again;
  - the host page is not `inert` and not `aria-hidden`;
  - `aria-label="TurboMock rule editor"` is static while the visible title toggles between "New
    Rule" and "Edit Rule" (`overlay.js:391`) — prefer `aria-labelledby="tmTitle"`;
  - `#tmTitle` is a `<div>`, so the dialog contributes no heading to the page outline.
- **Who it affects:** keyboard-only and screen-reader users, on every site the overlay is opened over.
- **Recommended fix:** capture `document.activeElement` in `open()`; add a Tab/Shift+Tab handler on
  the shadow root that wraps between first and last focusable; set
  `document.body.inert = true` while open and clear it in `close()`; restore focus in `close()`;
  switch to `aria-labelledby` and promote `.tm-title` to an `<h2>`.
- **Confidence:** High

### [High] A-6: No status messages are announced (toasts, form errors, panel errors)
- **Where:** `popup\popup.js:792-820` (`createToast` — a bare `<div>` appended to body);
  `options\options.js:1263-1282` (`showMessage` — `messageContainer.innerHTML = ''` then append);
  `content\overlay.js:366-371` (`showError` — `.tm-error` div toggled with a class);
  `devtools\panel.js:177-181` (`showError` — `errorContainer.innerHTML = ...`)
- **WCAG:** 4.1.3 Status Messages — AA
- **What:** Every feedback channel in the product writes text into a plain container with no
  `role="status"`, `role="alert"`, or `aria-live`. A screen-reader user who deletes a rule, toggles a
  rule, runs "Test All", saves a rule, hits a JSON parse error, or loses the service-worker
  connection receives **no notification of any kind**. In the popup this is total: `showNotification`
  and `showError` are the only feedback mechanisms for six different destructive/asynchronous
  actions (`popup.js:358, 463, 502, 537, 618, 640`).
- **Who it affects:** screen-reader users; also low-vision users, since `popup.js:797-812` pins the
  toast to `top: 10px; right: 10px` — outside the reading zoom viewport of anyone magnifying the
  rule list.
- **Recommended fix:** add a persistent `<div id="liveRegion" role="status" aria-live="polite">` to
  each surface at load time (live regions must exist *before* text is inserted to fire reliably) and
  write messages into it; use `role="alert"`/`aria-live="assertive"` for the error variants and for
  the overlay's `.tm-error`.
- **Confidence:** High

### [High] A-7: Contrast failures — 24 computed, concentrated in the new light theme and in UI boundaries
- **Where:** see the [Contrast audit table](#contrast-audit-table) for exact `file:line` per row.
  Principal clusters: `popup\popup.css:81-92` (light method/type badges),
  `popup\popup.css:403-408` (dark method badges), `options\options.css:262-307` (accent buttons),
  `options\options.css:426-436` + `:72-74` (toggle track), `popup\popup.css:323-326`
  (disabled rule cards), and the shared `--border` token in both stylesheets.
- **WCAG:** 1.4.3 Contrast (Minimum) — AA (4.5:1 text); 1.4.11 Non-text Contrast — AA (3:1 UI
  components and their state indicators)
- **What:** Notable failures (full list below):
  - **White on `--accent`** (`#ffffff` on `#4f6ef7`) = **4.28:1** — fails 4.5:1. This is the primary
    button colour (`options.css:262-272`) and the active nav item (`:206-209`) on *every* dark-theme
    screen, at 13 px/600 and 14 px/500 — comfortably "normal" text. The light theme fixed this by
    darkening the accent to `#3355e0` (5.97:1); the dark theme kept the old value.
  - **Light theme badge text on tinted pills**: `.method-post` / `[data-type="headers"]`
    (`#15803d` on a 12 %-alpha green over white) = **4.27:1**, and `.method-put` /
    `[data-type="delay"]` (`#b45309` on 14 %-alpha amber) = **4.32:1**. Near-misses, but these are
    10–11 px uppercase glyphs — the worst possible size to be short on contrast.
  - **`.method-delete` in dark theme** (`#f43f5e` on a 20 %-alpha rose over the card) = **3.78:1**.
  - **`.btn-danger`** = 4.17:1 dark / 4.24:1 light — the *destructive* action label is the least
    legible one on the page.
  - **Non-text (1.4.11)**: the shared `--border` token — `rgba(148,163,184,0.14)` dark and
    `rgba(15,23,42,0.12)` light — yields **1.11–1.28:1** against every surface it borders. Because
    the light theme sets `--bg-input: #ffffff` *and* `--bg-card`/`--bg-sidebar: #ffffff`, every text
    input, textarea, select, and popup rule card in the light theme is **white on white with a
    1.28:1 outline** — the control boundary is, for practical purposes, not rendered. The unchecked
    toggle track is 1.66:1 (dark `#334155`) / 1.48:1 (light `#cbd5e1`), and the unchecked
    `.rule-checkbox` border is 1.27:1, so a control's *off* state is signalled almost entirely by the
    absence of fill.
  - **Disabled rule cards** (`popup.css:323-326`, `opacity: 0.5` + `grayscale(0.8)`): the URL/detail
    line drops to **2.67:1** dark / **2.07:1** light. `opacity` on a container multiplies through to
    text; the grayscale filter additionally flattens the coloured badges, so the real figures are
    marginally worse than computed.
- **Who it affects:** low-vision users, users on poor/glare-affected displays, and anyone using the
  light theme outdoors — badges and field boundaries are the primary scanning affordance in this UI.
- **Recommended fix:** darken `--accent` in the dark theme to match the light theme's `#3355e0`
  family, or use a dark foreground on the primary button; deepen the four failing badge foregrounds
  by ~one Tailwind step (`#166534`, `#92400e`, `#e11d48`→`#fb7185`-on-darker-tint); raise `--border`
  to ≥ `rgba(148,163,184,0.35)` / `rgba(15,23,42,0.30)` so it clears 3:1; give the light theme a
  distinct `--bg-input` (e.g. `#f8fafc`) so fields are not white-on-white; replace `opacity: 0.5` on
  disabled cards with explicit muted-but-compliant colours.
- **Confidence:** High for the computed ratios (values are literal from the CSS); Medium for the
  disabled-card rows, where the `grayscale()` filter is not modelled.

### [Medium] A-8: Icon-only close buttons are named "×"
- **Where:** `options\options.html:252`, `:275`, `:292` (`<button class="modal-close">×</button>`);
  `content\overlay.js:189` (`<button class="tm-x" id="tmClose" title="Close">&times;</button>`)
- **WCAG:** 4.1.2 Name, Role, Value — A
- **What:** These buttons have text content (`×` / `&times;` U+00D7), so name-from-content wins and
  the accessible name becomes the multiplication sign — announced as "times" or silently skipped
  depending on AT punctuation settings. The `title="Close"` on the overlay's button does **not**
  override content-derived naming; it only surfaces as a tooltip. For `#dataModal` the `×` is the
  only visible close control (there is no Cancel button), so the affected user has to guess.
- **Who it affects:** screen-reader users; speech-input users (cannot say "click Close").
- **Recommended fix:** `aria-label="Close dialog"` on each, plus `aria-hidden="true"` on the glyph
  itself.
- **Confidence:** High

### [Medium] A-9: Rule test status is conveyed by icon shape/colour with no text equivalent
- **Where:** `popup\popup.js:192` (`<div class="status-indicator" title="...">${statusIcon}</div>`)
  and `:750-759` (`getStatusIcon` returns bare `<svg>` with no `<title>`/`role`)
- **WCAG:** 1.1.1 Non-text Content — A; 1.4.1 Use of Color — A (partially mitigated)
- **What:** Pass/fail/pending state is a coloured SVG glyph inside a non-interactive `<div>` whose
  only text alternative is a `title` attribute. `title` on a plain `div` is not reliably exposed by
  screen readers and is unreachable by keyboard (no hover, and divs are not focusable). The glyphs do
  differ in shape (check / cross / clock / triangle), so 1.4.1 is arguably met for sighted users, but
  there is no programmatic alternative at all. Note also that the SVG markup is emitted as a raw
  string and later assigned via `textContent` on the retest path — see U-5.
- **Who it affects:** screen-reader users; the `title`-only pattern also excludes touch users.
- **Recommended fix:** `<span class="status-indicator" role="img" aria-label="Test passed">` and add
  `aria-hidden="true"` to the inner `<svg>`; or render a visually-hidden `<span>` with the status word.
- **Confidence:** High

### [Medium] A-10: DevTools log auto-updates every 2 s with no live region, no pause, and no table semantics
- **Where:** `devtools\panel.js:18` (`POLL_INTERVAL_MS = 2000`), `:197-206` (`setInterval(refresh, …)`),
  `:146-175` (`renderEntries` — full `itemsContainer.innerHTML = …` replacement);
  `devtools\panel.html:293-308`
- **WCAG:** 2.2.2 Pause, Stop, Hide — A; 1.3.1 Info and Relationships — A; 4.1.3 Status Messages — AA
- **What:** Three separate issues on the same widget:
  1. The whole list is destroyed and rebuilt every 2 seconds. Relative timestamps
     (`formatRelativeTime`, `:71-82`) also mutate on their own ("just now" → "5s ago"), so the
     content changes even with no new traffic. There is no pause/stop control, only a destructive
     "Clear". This is the classic 2.2.2 auto-updating-content pattern.
  2. `innerHTML` replacement discards any DOM node inside the list — including a focused one — so a
     screen-reader virtual cursor or keyboard focus placed in the log is reset twice a minute.
  3. The log is a semantic "table" (method / URL / rule / status / time) built from nested `<div>`s
     with no `role="table"`/`row`/`cell` and no column headers, so the relationship between a value
     and its meaning is only visual. The four stat cards (`panel.html:266-286`) have the same
     problem in miniature — value and label are adjacent divs with no association.
- **Who it affects:** screen-reader users (unstructured, constantly-changing content), keyboard users
  (focus loss), users with attention/vestibular sensitivities.
- **Recommended fix:** diff-and-patch rows instead of re-rendering (or key rows by id); add a
  Pause/Resume toggle for the poll; wrap the list in `role="log" aria-live="polite"` (or `<table>`
  with a `<thead>`); associate each stat value with its label via `aria-labelledby`.
- **Confidence:** High

### [Medium] A-11: Active navigation and tab state is not exposed programmatically
- **Where:** `options\options.html:21-35` (`.nav-item` buttons) with `options\options.js:1053-1063`
  (`switchTab` toggles only a CSS class); `options\options.html:256-261` (data-viewer tabs) with
  `options\options.js:1372-1378`
- **WCAG:** 1.3.1 Info and Relationships — A; 4.1.2 — A
- **What:** "Which section am I in?" is communicated purely by `.active` styling (a background-colour
  change). The nav buttons carry no `aria-current="page"`, and the data-viewer tabs implement none of
  the tab pattern (`role="tablist"` / `role="tab"` + `aria-selected` / `role="tabpanel"` +
  `aria-controls`). A screen-reader user hears three identical buttons and four identical buttons.
  This is compounded by U-7 (the page's `<h2>` never updates), so there is no textual signal either.
- **Who it affects:** screen-reader users; also colour-blind users, since `.nav-item.active` differs
  from its siblings only by hue+weight of background.
- **Recommended fix:** add `aria-current="page"` to the active `.nav-item` inside `switchTab()`;
  implement the ARIA tabs pattern (or at minimum `aria-selected`) for `.data-tab`.
- **Confidence:** High

### [Medium] A-12: Disabled rule cards fall below contrast minimums
- **Where:** `popup\popup.css:323-326` (`.rule-card.disabled { opacity: 0.5; filter: grayscale(0.8) }`)
- **WCAG:** 1.4.3 Contrast (Minimum) — AA
- **What:** `opacity` on the card composites *all* descendant text against the page. The detail line
  (rule URL, 11 px monospace) computes to **2.67:1** in dark theme and **2.07:1** in light — well
  under 4.5:1. The rule name lands at 4.83:1 (dark) but **3.23:1** (light). Disabled *content* is
  exempt from 1.4.3 only when it is an inactive **user-interface component**; here the whole card,
  including its still-clickable Edit/Duplicate/Test/Delete buttons and its still-operable checkbox,
  remains fully interactive — so the exemption does not apply.
- **Who it affects:** low-vision users, who lose the ability to read exactly the rules they most need
  to find (the ones they turned off and want to turn back on).
- **Recommended fix:** drop the `opacity`/`grayscale` treatment; signal disabled state with a
  dedicated muted token that still clears 4.5:1, a "Disabled" text chip, and a left border.
- **Confidence:** High

### [Medium] A-13: `:host { all: initial }` resets inherited direction and typography for the overlay
- **Where:** `content\overlay.js:39`
- **WCAG:** 1.3.2 Meaningful Sequence — A (RTL); 1.4.4 Resize Text — AA (indirect)
- **What:** `all: initial` is the right instinct for isolating from a hostile host page, but it is a
  blunt instrument: it resets **every** inherited property to its initial value, not to a sane
  default. Concretely:
  - `direction` becomes `ltr` regardless of the host page. On an RTL site the extension's editor
    renders LTR while the surrounding page is RTL, and the fields' text direction no longer matches
    the user's locale.
  - `font-size` resets to `medium`, discarding the user's browser text-size preference — and every
    size in `STYLES` is then re-declared in **px** (`overlay.js:85, 98, 108, 116, 127, 139`), so the
    overlay ignores user font-size settings entirely. (Browser page zoom still works.)
  - `color-scheme` is reset, so native form-control chrome inside the overlay (the `<select>` popup,
    scrollbars, the `#tmEnabled` checkbox) renders in light-mode chrome over the dark panel.
  It does **not** break label/`for` association or ARIA — those are same-root and work correctly (see
  *Checked and ruled out*).
- **Who it affects:** RTL-locale users, users who have raised their browser's default font size,
  users relying on `color-scheme`-aware native controls.
- **Recommended fix:** keep `all: initial` but immediately re-establish the properties you want
  inherited: `:host { all: initial; direction: inherit; color-scheme: dark light; }` and express
  sizes in `rem`.
- **Confidence:** Medium (the `direction` and `color-scheme` consequences are certain from spec;
  the practical font-size impact is muted because px sizes dominate)

### [Medium] A-14: No reduced-motion, forced-colors, or `color-scheme` support anywhere
- **Where:** verified absent across all CSS: no `@media (prefers-reduced-motion)`, no
  `@media (forced-colors)`, no `color-scheme` declaration. Motion sources:
  `options\options.css:486-500` (`fadeIn` with `translateY` on every tab switch),
  `popup\popup.css:553-581` (`slideInRight`/`slideOutRight` toasts),
  `popup\popup.css:316-321` (`.rule-card:hover { transform: translateY(-2px) }`),
  `popup\popup.css:361-364` (`.rule-checkbox:hover { transform: scale(1.1) }`)
- **WCAG:** 1.4.12/2.3.3 (motion — AAA in 2.1, but 2.2.2 applies to the auto-playing devtools
  refresh); 1.4.11 + Windows High Contrast behaviour
- **What:** Every animated affordance is unconditional. Hovering the rule list makes each card jump
  2 px and each checkbox scale 10 %, which for a dense list under a mouse is continuous motion.
  Separately, because no `color-scheme: dark` is declared, native form controls, scrollbars, and
  (importantly) the **default `::placeholder` colour** are computed as if the page were light —
  over `--bg-input: #0b0f19`. Finally, all colours are hard-coded hex/rgba with no
  `forced-colors` handling, so Windows High Contrast Mode users get the extension's palette forced to
  system colours in unpredictable places (the SVG `stroke="currentColor"` icons will survive; the
  tinted badge backgrounds will not).
- **Who it affects:** users with vestibular disorders, users of Windows High Contrast Mode, low-vision
  users relying on OS-level colour inversion.
- **Recommended fix:** wrap transforms/animations in
  `@media (prefers-reduced-motion: no-preference)`, add `color-scheme: dark` to the dark theme and
  `light` to `body.theme-light`, and add a `@media (forced-colors: active)` block that restores
  `border`/`outline` on the badge and toggle components.
- **Confidence:** High for the absence; Medium for the severity of the forced-colors impact.

### [Medium] A-15: Placeholder text colour is unspecified — needs manual check
- **Where:** No `::placeholder` rule exists in `popup.css`, `options.css`, `panel.html`, or
  `overlay.js`. Placeholders in use: `popup\popup.html:47` ("Search rules…"),
  `options\options.html:201, 328, 354, 381, 388, 402, 415, 431, 441, 446, 457, 461`,
  `content\overlay.js:202, 213, 244, 254, 259, 273, 280, 284, 290, 294`
- **WCAG:** 1.4.3 Contrast (Minimum) — AA
- **What:** With no author rule, the placeholder colour comes from the UA stylesheet, which Blink
  derives from the computed `color-scheme` of the field. Since **no `color-scheme` is declared**
  (A-14), Chrome will use its light-mode placeholder colour over `--bg-input: #0b0f19`
  (near-black) — a mid/dark grey on near-black. **I could not compute this reliably** because the
  exact UA value is version-dependent and not present in the repo. Flagging for manual verification
  rather than asserting a ratio. Note that several placeholders here carry *instructional* content
  (JSON shapes such as `[{"op":"set","name":"User-Agent",…}]`), which is itself a 3.3.2 concern —
  placeholders vanish on input and should not be the only place the format is documented.
- **Who it affects:** low-vision users; anyone relying on the placeholder to learn the JSON schema.
- **Recommended fix:** declare `::placeholder { color: var(--text-muted); opacity: 1 }` explicitly in
  all three stylesheets (this measures ≥ 4.5:1 in both themes per the table below), add
  `color-scheme`, and promote the JSON-shape examples from placeholders to `.help-text`.
- **Confidence:** Low on the current ratio (needs manual check); High that the rule is absent.

### [Low] A-16: `role="listitem"` without a list container; card click-to-edit has no keyboard path
- **Where:** `popup\popup.js:174` (`<div class="rule-card" … role="listitem">`);
  parent `<main class="rules-list" id="rulesContainer">` at `popup\popup.html:52` has no
  `role="list"`; card click handler at `popup\popup.js:310-316`
- **WCAG:** 1.3.1 Info and Relationships — A; 2.1.1 Keyboard — A (mitigated)
- **What:** An orphaned `role="listitem"` has no owning list, so browsers may drop it from the
  accessibility tree entirely — the user gets no "list of N items" count, which is the main benefit
  of the role. Separately, the entire card is click-to-edit with `cursor: pointer`
  (`popup.css:310`) but is not focusable and has no key handler; that particular affordance is
  mouse-only. 2.1.1 is *not* failed, because a dedicated Edit button exists in the same card
  (`popup.js:195`), but the mouse and keyboard affordances are unequal.
- **Who it affects:** screen-reader users (lost list structure), keyboard users (a redundant but
  unavailable shortcut).
- **Recommended fix:** add `role="list"` to `#rulesContainer` (note this requires overriding the
  implicit `main` role — better to nest an inner `<ul>`/`<li>`), and either make the card a
  focusable `role="button"` with a key handler or drop `cursor: pointer` from the card body.
- **Confidence:** High

### [Low] A-17: Popup icon buttons rely on `title` alone; decorative SVGs are not hidden
- **Where:** `popup\popup.html:30` (`#settingsBtn`), `:69` (`#newRuleBtn`), `:81` (`#testAllBtn`),
  `:86` (`#refreshBtn`) — `title` only, no `aria-label`. Every inline `<svg>` across all four
  surfaces lacks `aria-hidden="true"`/`focusable="false"`.
- **WCAG:** 4.1.2 — A (met, but fragilely); 1.1.1 — A
- **What:** `title` is the *last* fallback in the accessible-name computation. It works in current
  Chrome + NVDA/JAWS, but it is silent on touch, ignored by some voice-control implementations, and
  fails if a future refactor adds any text content. The rule-card action buttons already do this
  correctly (`aria-label` **and** `title`, `popup.js:195-205`) — the four chrome buttons are the
  inconsistent ones. Separately, an inline `<svg>` with no `aria-hidden` may be exposed as a graphics
  node and read as "image" noise inside each already-named button.
- **Who it affects:** screen-reader and speech-input users.
- **Recommended fix:** add `aria-label` to the four buttons (keep `title` for the sighted tooltip),
  and `aria-hidden="true" focusable="false"` to all decorative `<svg>`s.
- **Confidence:** High

### [Low] A-18: Rule-toggle accessible name does not reflect state (and breaks on quotes in rule names)
- **Where:** `popup\popup.js:178-183`, `:349-350`
- **WCAG:** 4.1.2 Name, Role, Value — A
- **What:** The name is hard-coded `aria-label="Enable rule: ${safeName}"` and never changes; a
  screen reader announces "Enable rule: X, checked" when the correct reading is a stable name plus a
  state. Prefer `aria-label="${safeName}"` and let `aria-checked` (which *is* updated correctly at
  `:350`) carry the state. Separately, `escapeHtml` (`popup.js:837-841`) round-trips through
  `textContent`→`innerHTML`, which escapes `& < >` but **not** `"` — so a rule named `My "test" rule`
  terminates the `aria-label` attribute early and corrupts the element. That is primarily a markup
  injection concern and belongs to `security.md`; noted here only because the accessible name is a
  casualty.
- **Who it affects:** screen-reader users.
- **Recommended fix:** name = rule name; state = `aria-checked`. Escape `"` and `'` in `escapeHtml`,
  or build the element with `document.createElement` + `setAttribute` instead of string templating.
- **Confidence:** High

### [Low] A-19: Heading hierarchy skips levels; DevTools panel has no landmarks
- **Where:** `popup\popup.html:21` (`<h1>`) → `:62` (`<h3>No rules yet</h3>` — no `h2`);
  `options\options.html:17` (`<h1>`) → `:46`/`:59` (`h2`) → `:223`, `:233`, `:238`
  (`<h4>` with no intervening `h3`); `devtools\panel.html:258-312` (no `<main>`/`<nav>`/`<header>`,
  only `<h1 class="panel-title">`)
- **WCAG:** 1.3.1 Info and Relationships — A; 2.4.1 Bypass Blocks — A (landmarks)
- **What:** Popup and options both skip a level. The DevTools panel is landmark-free, so a screen
  reader user has no structural jump targets between the stat cards and the log. (The popup and
  options pages *do* use `header`/`main`/`footer`/`nav`/`aside` correctly — this is panel-only.)
- **Recommended fix:** demote the empty-state `h3` to `h2`, promote the reset-card `h4`s to `h3`, and
  wrap the panel's content in `<main>` with the stats in a `<section aria-labelledby>`.
- **Confidence:** High

### [Nit] A-20: Target sizes below 24×24 CSS px, and unclosed `<main>` in options.html
- **Where:** `popup\popup.css:350-353` (`.rule-checkbox` is 16×16 px);
  `options\options.css:674-684` (`.modal-close` — 22 px glyph, `padding: 0 4px`);
  `popup\popup.css:155-160` (`.status-badge` — `padding: 2px 8px`, 10 px text).
  Markup: `options\options.html:244-245` — `<main class="main-content">` opened at `:44` is never
  closed (the parser recovers, so the DOM is usable, but the document does not validate).
- **WCAG:** 2.5.8 Target Size (Minimum) — **AA in WCAG 2.2, not 2.1** — flagged for forward
  compatibility, not as a 2.1 AA failure
- **What:** The per-rule enable checkbox is the most-used control in the product and is a 16 px
  square with no padded hit area. The modal close `×` is similarly tight. If the project ever targets
  2.2 AA these become real failures; today they are a motor-accessibility quality gap.
- **Recommended fix:** give `.rule-checkbox` a transparent 24 px hit area via padding or a `::before`
  overlay; pad `.modal-close` to 24×24; add the missing `</main>`.
- **Confidence:** High

---

## Contrast audit table

Method: sRGB relative luminance per WCAG 2.x; translucent layers composited over their real parent
surface before measuring. "BG (composited)" shows the effective colour actually rendered.
Thresholds: **4.5:1** for text under 18.66 px bold / 24 px regular, **3:1** for non-text UI
components and state indicators (1.4.11).

### Text — failures

| Element | Source | FG | BG (composited) | Ratio | Req | Pass? |
|---|---|---|---|---|---|---|
| `.btn-primary` label (dark) | `options.css:262-272` | `#ffffff` | `#4f6ef7` | **4.28:1** | 4.5 | ❌ |
| `.nav-item.active` label (dark) | `options.css:206-209` | `#ffffff` | `#4f6ef7` | **4.28:1** | 4.5 | ❌ |
| `.rule-checkbox` ✓ glyph | `popup.css:371-380` | `#ffffff` | `#4f6ef7` | **4.28:1** | 4.5 | ❌ |
| `.method-delete` (dark) | `popup.css:406` | `#f43f5e` | `#432232` ← `rgba(244,63,94,.2)`/card | **3.78:1** | 4.5 | ❌ |
| `.btn-danger` label (dark) | `options.css:296-303` | `#ef4444` | `#2c1f2a` ← `rgba(239,68,68,.1)`/item | **4.17:1** | 4.5 | ❌ |
| `.btn-danger` label (light) | `options.css:296` + `:43` | `#dc2626` | `#fdecec` ← `rgba(239,68,68,.1)`/white | **4.24:1** | 4.5 | ❌ |
| `.method-post` (light) | `popup.css:82` | `#15803d` | `#e3f0e8` ← `rgba(21,128,61,.12)`/white | **4.27:1** | 4.5 | ❌ |
| `.rule-type-badge[headers]` (light) | `popup.css:91`, `options.css:95` | `#15803d` | `#e3f0e8` | **4.27:1** | 4.5 | ❌ |
| `.method-put` (light) | `popup.css:83` | `#b45309` | `#faecdc` ← `rgba(217,119,6,.14)`/white | **4.32:1** | 4.5 | ❌ |
| `.rule-type-badge[delay]` (light) | `popup.css:89`, `options.css:93` | `#b45309` | `#faecdc` | **4.32:1** | 4.5 | ❌ |
| `.message.success` (light) | `options.css:98-102` | `#15803d` | `#dfeae5` ← `rgba(21,128,61,.1)`/`#f5f6f8` | **4.07:1** | 4.5 | ❌ |
| `.rule-card.disabled` URL (dark) | `popup.css:323-326` | `#94a3b8` @50 % | `#161b27` | **2.67:1** | 4.5 | ❌ |
| `.rule-card.disabled` URL (light) | `popup.css:323-326` | `#5b6b7f` @50 % | `#ffffff` | **2.07:1** | 4.5 | ❌ |
| `.rule-card.disabled` name (light) | `popup.css:323-326` | `#16202e` @50 % | `#ffffff` | **3.23:1** | 4.5 | ❌ |

### Non-text / UI components (1.4.11, 3:1) — failures

| Element | Source | FG | BG (composited) | Ratio | Req | Pass? |
|---|---|---|---|---|---|---|
| Input border vs input fill (dark) | `options.css:368-381` | `rgba(148,163,184,.14)` → `#1a1f2a` | `#0b0f19` | **1.23:1** | 3.0 | ❌ |
| Input border vs modal surface (dark) | `options.css:368-381`, `:518-525` | `#1a1f2a` | `#141b28` | **1.11:1** | 3.0 | ❌ |
| Input border vs fill (light) | `options.css:43`, `:32` | `rgba(15,23,42,.12)` → `#e0e2e5` | `#ffffff` | **1.28:1** | 3.0 | ❌ |
| **Input fill vs modal surface (light)** | `options.css:31-33` | `#ffffff` | `#ffffff` | **1.00:1** | 3.0 | ❌ |
| **Popup rule card vs page (light)** | `popup.css:46-48`, `:27` | `#ffffff` | `#ffffff` | **1.00:1** | 3.0 | ❌ |
| `.rule-checkbox` unchecked border (dark) | `popup.css:350-355` | `#1e2531` | `#161b27` | **1.27:1** | 3.0 | ❌ |
| `.rule-checkbox` unchecked border (light) | `popup.css:36` | `#e0e2e5` | `#ffffff` | **1.28:1** | 3.0 | ❌ |
| `.slider` OFF track (dark) | `options.css:426-436` | `#334155` | `#161b27` | **1.66:1** | 3.0 | ❌ |
| `.slider` OFF track (light) | `options.css:72-74` | `#cbd5e1` | `#ffffff` | **1.48:1** | 3.0 | ❌ |
| `.theme-preview` border (dark) | `options.css:758-764` | `#1e2531` | `#161b27` | **1.27:1** | 3.0 | ❌ |
| `.theme-preview.light` swatch (light) | `options.css:766` | `#f8fafc` | `#ffffff` | **1.05:1** | 3.0 | ❌ |

### Representative passes (sample — 70 of 94 measured rows passed)

| Element | FG | BG (composited) | Ratio | Req | Pass? |
|---|---|---|---|---|---|
| `--text-main` on `--bg-app` (dark) | `#f1f5f9` | `#0f1420` | 16.80:1 | 4.5 | ✅ |
| `--text-muted` on `--bg-app` (dark) | `#94a3b8` | `#0f1420` | 7.18:1 | 4.5 | ✅ |
| `.rule-details` URL on card (dark) | `#94a3b8` | `#161b27` | 6.71:1 | 4.5 | ✅ |
| `--text-muted` on `--bg-app` (light, options) | `#5b6b7f` | `#f5f6f8` | 5.04:1 | 4.5 | ✅ |
| `--text-muted` on white (light, popup) | `#5b6b7f` | `#ffffff` | 5.45:1 | 4.5 | ✅ |
| `.btn-primary` label (light) | `#ffffff` | `#3355e0` | 5.97:1 | 4.5 | ✅ |
| `.rule-type-badge[mock]` (dark) | `#8ea2ff` | `#202a4c` | 5.85:1 | 4.5 | ✅ |
| `.rule-type-badge[mock]` (light) | `#2846c9` | `#e7ebfb` | 6.27:1 | 4.5 | ✅ |
| `.method-get` (dark) | `#38bdf8` | `#1d3b51` | 5.43:1 | 4.5 | ✅ |
| `.method-patch` (dark) | `#a78bfa` | `#333151` | 4.52:1 | 4.5 | ✅ (marginal) |
| `.method-post` (dark) | `#10b981` | `#153b39` | 4.85:1 | 4.5 | ✅ |
| devtools `.status-pending` | `#94a3b8` | `#2e3646` | 4.75:1 | 4.5 | ✅ |
| devtools `.status-error` | `#f87171` | `#3c2733` | 4.98:1 | 4.5 | ✅ |
| overlay `.tm-hint` | `#94a3b8` | `#1a2130` | 6.28:1 | 4.5 | ✅ |
| overlay `.tm-error` | `#f87171` | `#342532` | 5.21:1 | 4.5 | ✅ |
| `.message.error` (dark) | `#f87171` | `#251924` | 6.11:1 | 4.5 | ✅ |
| Focus border `--accent` vs input fill (dark) | `#4f6ef7` | `#0b0f19` | 4.47:1 | 3.0 | ✅ |
| Focus border `--accent` vs input fill (light) | `#3355e0` | `#ffffff` | 5.97:1 | 3.0 | ✅ |
| `.slider` ON (dark) | `#22c55e` | `#161b27` | 7.55:1 | 3.0 | ✅ |
| `.status-dot` ON vs header (dark) | `#22c55e` | `#0f1628` | 7.89:1 | 3.0 | ✅ |

**Not computed / needs manual check:**
- `::placeholder` in all three surfaces — no author rule; UA-derived and version-dependent (A-15).
- `.rule-card.disabled` — the `grayscale(0.8)` filter is not modelled; the tabulated ratios are the
  `opacity`-only figures and are therefore slightly optimistic for the coloured badges.
- Windows High Contrast / forced-colors rendering — cannot be determined statically (A-14).

---

## UX findings

### [High] U-1: Rule-editor validation errors are invisible — three compounding defects
- **Where:** `options\options.js:1270` (`messageEl.className = \`message message-${type}\``) vs
  `options\options.css:854-864` (`.message.success` / `.message.error`);
  `options\options.html:55` (`#messageContainer` inside `.content-scroll`, i.e. **outside** every
  modal) vs `options\options.css:503-510` (`.modal { position: fixed; inset: 0; background:
  rgba(0,0,0,.6); backdrop-filter: blur(4px); z-index: 100 }`);
  `options\options.js:1281` (`window.scrollTo(...)` while `body` is `overflow: hidden`
  — `options.css:123-131` — and the real scroller is `.content-scroll`, `options.css:310-314`)
- **Friction:** `saveRuleFromEditor()` has **23** failure exits, each calling `showMessage(..., 'error')`
  (`options.js:322, 328, 335, 341, 373, 383, 398, 413, 421, 446, 476, 485, 490, 508, 516, 522, 529,
  534, 552, 560, 565, 570, 637`). Every one of them renders a message that (a) has no error styling because the
  class names don't match the stylesheet, (b) is painted **underneath** the modal's dimmed, blurred
  backdrop, and (c) is scrolled toward using the wrong scroll container. From the user's seat,
  pressing "Save Rule" with a malformed JSON body simply *does nothing* — the modal stays open with
  no explanation. The only partial mitigation is that the offending field is focused, which a sighted
  user may or may not notice.
- **Recommendation:** fix the class names (`message ${type}` or add `.message-error` to CSS); add a
  second message host **inside** `.modal-body` and route messages there whenever a modal is open;
  replace `window.scrollTo` with `container.scrollIntoView({ block: 'nearest' })`. Then pair with A-6
  (`role="alert"`). The Shadow-DOM overlay already gets this right (`overlay.js:193, 366-371`) —
  mirror its inline `.tm-error` pattern.
- **Severity note:** this is the single highest-impact usability defect found; it turns every
  validation rule in the options editor into a silent failure.

### [High] U-2: Rules cannot be browsed or managed anywhere except the 380 px popup
- **Where:** `options\options.html:147-185` — the "Rules" tab contains only two import/export cards;
  there is no list. Rule CRUD lives at `popup\popup.js:143-158` (render), `:396-407` (edit),
  `:443-471` (duplicate), `:519-545` (delete)
- **Friction:** The product's core object has no full-size management surface. Consequences:
  a rule list is confined to a 380 × 560 popup with a ~360 px content column; the URL pattern —
  the single most important field for identifying a rule — is truncated by that width; there is no
  sorting, no multi-select, no bulk enable/disable/delete, no grouping; the popup dismisses itself on
  any outside click, so an interrupted triage session is lost. `options.html?editRule=<id>` exists
  (`options.js:129-144`) and works, but it is reachable *only* as a fallback from the popup when the
  overlay can't inject — there is no in-page path to it. Meanwhile the "Rules" nav item promises a
  management screen and delivers two file-picker cards.
- **Recommendation:** render the rule list in the options "Rules" tab — reuse the `.rule-type-badge`
  contract already shared between popup and options (`popup.css:410-426`, `options.css:546-563`) —
  with search, type filter, enable/disable, and bulk actions. Keep the popup as the quick-toggle
  surface it is good at.

### [High] U-3: Two divergent rule editors, chosen silently by the current tab's URL
- **Where:** `content\overlay.js:177-308` (in-page editor) vs
  `options\options.html:288-473` (modal editor); routing at `popup\popup.js:413-438`
  (`openRuleOverlay` returns `false` for any non-`http(s)` tab) and `:396-407` / `:569-578`
  (fallback to `chrome.tabs.create(options.html?...)`)
- **Friction:** The same task ("edit this rule") opens one of two different UIs depending on whether
  the user happens to be on a web page or a `chrome://`/Web Store/PDF tab — with **no indication that
  a substitution happened**. The two are not feature-equivalent:
  | Capability | Options modal | In-page overlay |
  |---|---|---|
  | Quick Template dropdown | ✅ `options.html:312-321` | ❌ |
  | Format JSON / Insert GUID / Insert Timestamp | ✅ `options.html:403-410` | ❌ |
  | `{{guid}}` / `{{timestamp}}` discoverability | ✅ | ❌ |
  | Wildcard/regex help text | ✅ `:355` | ✅ `overlay.js:214` |
  | Header/GraphQL conflict guardrail | ✅ `options.js:489-495, 533-539, 569-575` | ⚠️ different rule (`overlay.js:520-522`) |
  | Empty mock body behaviour | keeps `''` (`options.js:452-464`) | coerces to `{}` (`overlay.js:491`) |
  Two implementations of the same form is also a standing correctness risk: the validation logic has
  already diverged (the options page checks `hasForbiddenMatch` against the *original* rule; the
  overlay checks the *collected* rule).
- **Recommendation:** pick one editor. The cleanest path is to keep the overlay (it is the better
  flow — no context switch) and have the options page host the *same* component, or at minimum reach
  feature parity and tell the user which one they're getting ("Opening in a new tab — TurboMock can't
  draw over this page").

### [High] U-4: Closing the rule editor discards unsaved work with no confirmation
- **Where:** `options\options.js:897-901` (any click on `.modal` backdrop → `classList.remove('show')`);
  `options\options.js:1445-1450` (Escape closes any `.modal.show`);
  `content\overlay.js:338-340` (backdrop click → `close()`);
  `content\overlay.js:345-350` (Escape → `close()`);
  `content\overlay.js:555-561` (`close()` removes the host element outright)
- **Friction:** The rule editor is the longest form in the product — up to 8 textareas including
  hand-written JSON bodies and header-operation arrays. A single stray click on the dimmed area, or
  an Escape press intended to dismiss an autocomplete or a `<select>` dropdown, destroys all of it
  with no prompt and no recovery. The overlay is worse: `close()` deletes the shadow host, so even
  the DOM state is gone. There is no draft persistence anywhere.
- **Recommendation:** track a dirty flag (compare against the values set in `populate()` /
  `openRuleEditor()`); on backdrop-click or Escape while dirty, show a "Discard changes?" confirm; or
  simply require the explicit Cancel button for a dirty form. Consider persisting a draft to
  `chrome.storage.session`.

### [Medium] U-5: Loading states destroy button icons and render raw SVG markup as visible text
- **Where:** `popup\popup.js:483-486` and `:496-500` (`statusIndicator.textContent = '⏳'`, then
  `statusIndicator.textContent = this.getStatusIcon(...)`); `popup\popup.js:594-595` and `:622`
  (`testAllBtn`); `popup\popup.js:699-702` and `:715` (`refreshBtn`)
- **Friction:** These are leftovers from the emoji→SVG icon migration and they are actively broken:
  1. `const originalText = testBtn.textContent` on a button whose only child is an `<svg>` evaluates
     to `''`. Setting `textContent = '⏳'` **deletes the SVG**, and the `finally` block restores `''`
     — so after one "Test All" or one "Refresh", the button is permanently blank until the popup is
     reopened.
  2. `getStatusIcon()` returns an HTML **string** (`popup.js:750-759`). Assigning it to
     `textContent` at `:498` renders the literal characters `<svg viewBox="0 0 24 24" …>` inside the
     rule card. Testing a single rule visibly corrupts its row.
  Users also get a stray `⏳` emoji in an otherwise emoji-free SVG icon set.
- **Recommendation:** don't mutate icon content for loading states. Add a `.is-busy` class that swaps
  in a CSS spinner (or animates the existing icon), set `aria-busy="true"`, and use `innerHTML`/
  `replaceChildren` — never `textContent` — anywhere `getStatusIcon()` is consumed.

### [Medium] U-6: The advertised keyboard shortcuts do nothing
- **Where:** `manifest.json:61-76` declares `toggle-extension` (Ctrl+Shift+M) and `new-rule`
  (Ctrl+Shift+N); `README.md:142-145` documents both to users. There is **no
  `chrome.commands.onCommand` listener anywhere in the repo** (verified by search across all `.js`).
- **Friction:** Both shortcuts are registered with Chrome, appear in `chrome://extensions/shortcuts`,
  and are consumed from the page — but nothing happens. `Ctrl+Shift+N` in particular is the standard
  "new Incognito window" binding, so the extension *steals* a familiar browser shortcut and then
  discards it. This also removes the only potential keyboard fallback for A-1.
- **Recommendation:** implement `chrome.commands.onCommand.addListener` in
  `service_worker/background.js` (route `toggle-extension` to the existing `toggleExtension` handler,
  `new-rule` to the same overlay-then-options-tab path used by the context menu at
  `background.js:423-445`), or remove the `commands` block and the README section.

### [Medium] U-7: The options page heading never changes; there is no textual "where am I"
- **Where:** `options\options.html:46` (`<h2 id="pageTitle">General Settings</h2>`);
  `options\options.js:1053-1063` (`switchTab` toggles `.active` on nav items and tab panels and
  touches nothing else)
- **Friction:** Selecting "Rules" or "Advanced" leaves the top bar reading "General Settings". The
  heading is the largest text on screen and is now actively wrong on two of three tabs. Combined with
  A-11 (no `aria-current`), there is no correct signal of location for anyone.
- **Recommendation:** set `pageTitle.textContent` from a tab→title map inside `switchTab()`, and
  update `document.title` too.

### [Medium] U-8: "Save Changes" validates two settings that have no UI, creating an unfixable dead end
- **Where:** `options\options.js:1457-1489` (`validateSettings` requires `maxResponseSize` ∈ [1,10240]
  and `cacheSize` ∈ [10,1000]); neither `maxResponseSize` nor `cacheSize` exists anywhere in
  `options\options.html` (verified by search). Same for `toggleShortcut`, `newRuleShortcut`,
  `totalRulesCount`, `enabledRulesCount`, `rulesDataSize`, `metricsDataSize`, all read in
  `options.js:1009-1013` and `:1239-1260`.
- **Friction:** Defaults happen to pass, so this is latent — but any settings JSON imported via
  `importSettings()` (`options.js:1133-1163`, which merges arbitrary values with no validation) that
  carries an out-of-range `cacheSize` makes **Save Changes fail forever** with "Cache size must be
  between 10 and 1000 rules", pointing at a field the user cannot see or edit. The only escape is
  Factory Reset. Separately, `#requestTimeout` declares `max="60000"` (`options.html:212`) while
  `validateSettings` rejects anything over `30000` (`options.js:1467`) — the browser accepts a value
  the app then refuses, with the mismatch surfaced only through the (invisible, per U-1) message bar.
- **Recommendation:** validate only settings the UI exposes, or expose the missing fields; align
  `max="30000"` with the validator; validate imported settings against the same rules before merging;
  remove the dead element lookups.

### [Medium] U-9: DevTools panel ignores the theme setting and offers no log affordances
- **Where:** `devtools\panel.html:8-18` (hard-coded dark `:root`, no `body.theme-light` block, no
  `prefers-color-scheme` query); `devtools\panel.js:188-195` (Clear, no confirmation);
  `:45-48` (`truncateUrl` at 80 chars, full URL only in a `title` tooltip);
  `:71-82` (relative timestamps only)
- **Friction:** Every other surface honours `settings.theme` (`popup.js:77-85`,
  `options.js:1040-1051`, `overlay.js:563-574`); the panel alone is permanently dark, so a user on
  the light theme with light DevTools gets one dark island. Beyond theming, the log is
  under-equipped for its job: **Clear wipes the buffer instantly with no confirmation and no undo**;
  URLs are cut at 80 characters with the remainder available only via a mouse-only tooltip; times are
  relative-only ("3m ago") with no absolute timestamp, so entries can't be correlated with the
  Network panel; and there is no filter, search, or per-entry detail/expand — the one thing you
  actually want when debugging why a rule did or didn't match.
- **Recommendation:** read the theme via the existing `getRules` message and mirror the
  `theme-light` class; add a confirm (or an undo toast) to Clear; show the full URL with CSS
  `text-overflow` instead of string truncation; add an absolute timestamp on hover/second line; add a
  text filter and a rule-type filter.

### [Medium] U-10: `user-select: none` on `*` makes the popup's content uncopyable
- **Where:** `popup\popup.css:94-99` (`* { box-sizing: border-box; margin: 0; padding: 0;
  user-select: none; }`)
- **Friction:** The universal selector kills text selection across the entire popup — including the
  rule name, the URL pattern, and the intercept count. Copying a URL pattern out of a rule (to paste
  into a browser, a ticket, or another rule) is a routine developer action and is simply impossible.
  The intent was presumably to stop drag-select artefacts on the card UI; the blast radius is the
  whole document.
- **Recommendation:** scope it — `user-select: none` on `.rule-actions`, `.status-badge`, `.fab-btn`
  and the icon buttons; explicitly `user-select: text` on `.rule-name`, `.rule-details`, and
  `.footer-stats`.

### [Medium] U-11: Destructive-action patterns are inconsistent and unrecoverable
- **Where:** `popup\popup.js:523` (native `confirm()` for rule delete);
  `options\options.js:1284-1296` + `:1320-1357` (custom confirm modal for Reset/Factory Reset);
  `options\options.html:282` (the confirm modal's action button is always `.btn-danger`);
  `devtools\panel.js:191-194` (Clear, no confirmation)
- **Friction:** Three different confirmation experiences for four destructive actions, plus one with
  none. The native `confirm()` in the popup is styled by the OS and looks nothing like the product.
  The custom modal's action button is hard-coded red and labelled "Confirm" for **both** "Reset
  Settings" (which explicitly preserves rules) and "Factory Reset" (which deletes everything) — the
  destructive-intent signal carries no information. Nothing anywhere is undoable, and there is no
  "export before reset" nudge on Factory Reset despite the export feature sitting one tab away.
- **Recommendation:** route all destructive actions through the one custom modal; make the action
  button label the verb ("Delete rule", "Reset settings", "Erase all data"); vary the button style by
  actual severity; offer an undo toast for rule delete (keep the rule in memory for ~10 s); on
  Factory Reset, offer "Export rules first".

### [Medium] U-12: Theme flash on every popup open
- **Where:** `popup\popup.html:11` (`<body>` with **no** theme class) + `popup\popup.js:21-36`
  (`init()` awaits `loadData()` — a `chrome.runtime.sendMessage` round-trip — before
  `applyTheme()` runs at `:52`); `options\options.html:11` (`<body class="theme-dark">` hard-coded,
  overwritten later by `applyTheme()` at `options.js:1040-1051`)
- **Friction:** A light-theme user sees the dark palette (`popup.css:3-21` `:root` defaults) for the
  duration of the message round-trip on **every single popup open**, then a hard flip to light. The
  options page is worse in kind — the dark class is committed in the HTML, so the flash is guaranteed
  rather than race-dependent. Additionally, if the background service worker is cold or fails to
  respond, `applyTheme()` is never called at all (it is only reached on the success path,
  `popup.js:46-53`) and the popup is stuck in dark theme regardless of the user's setting.
- **Recommendation:** read the theme from `chrome.storage.local` synchronously-first (or cache the
  resolved theme in `localStorage` on the extension origin) and apply the class before first paint;
  move `applyTheme()` out of the success branch into `init()`'s `finally`; drop the hard-coded
  `theme-dark` from `options.html`.

### [Low] U-13: The in-page overlay is undiscoverable and unannounced
- **Where:** `popup\popup.js:569-578` (`createNewRule` → overlay, then `window.close()`);
  `service_worker\background.js:410-445` (context menu "Mock this request" → overlay)
- **Friction:** Clicking "+" in the popup closes the popup and draws a full-screen dialog over
  whatever page the user was on. Nothing in the popup, the options page, or the README explains that
  the editor is an in-page overlay, that it will appear over the current tab, or that it can't appear
  on `chrome://` pages. The context menu entry is labelled "Mock this request" but is registered for
  the `page` context — it fires on a right-click anywhere on the page and prefills a host-wide
  pattern (`*host*`), not "this request", so the label overpromises.
- **Recommendation:** add a one-line hint near the "+" button ("Opens an editor on the current
  page"), show a first-run tip the first time the overlay appears, and rename the context item to
  "Mock requests on this site".

### [Low] U-14: Popup flashes "No rules yet" before data loads
- **Where:** `popup\popup.html:53-64` (empty state is hard-coded in the initial markup);
  `popup\popup.js:21-28` (`init()` awaits `loadData()` before `renderCurrentView()`)
- **Friction:** There is no loading state — the static empty state is what the user sees during the
  background round-trip. For a user with 20 rules, every popup open briefly claims they have none.
  Since the empty state also contains the primary call to action ("Create your first mock rule"), the
  false negative is actively misleading.
- **Recommendation:** ship the markup with a skeleton/spinner (or nothing) and render the empty state
  only after `loadData()` resolves with zero rules.

### [Low] U-15: Popup search is shallow and gives no result feedback
- **Where:** `popup\popup.js:550-564` (`handleSearch` filters on `name`, `match.url`, `match.method`
  only); `popup\popup.html:41-49`
- **Friction:** Search misses rule **type** ("show me my redirects"), response body, redirect
  destination, and header names — all things a developer would search for. There is no clear (×)
  button, no result count, no debounce (re-renders the whole list on every keystroke), and the
  filter is silently reset whenever `renderRules()` is called from another path (e.g. after
  duplicate at `popup.js:461`, which calls `loadData()` → resets `filteredRules` → the visible list
  jumps back to unfiltered while the search box still shows the query).
- **Recommendation:** extend the predicate to `type`, `redirect.destination`, and stringified
  response; add a clear button and an "N of M rules" count; re-apply the active filter after any
  reload.

### [Low] U-16: The popup captures browser shortcuts with no on-screen discoverability
- **Where:** `popup\popup.js:722-745`
- **Friction:** `Ctrl+F`, `Ctrl+N`, `Ctrl+T`, `Ctrl+R` are all `preventDefault()`ed inside the popup.
  `Ctrl+F` is the one that stings — it removes find-in-page from a scrolling list and replaces it
  with "focus the search field", which is close enough to be defensible but is nowhere documented.
  None of the four shortcuts is shown in the UI (no tooltip suffix, no help affordance), so they are
  effectively undiscoverable while still being disruptive to muscle memory.
- **Recommendation:** append the shortcut to each button's `title` ("New Rule (Ctrl+N)"), drop the
  `Ctrl+T`/`Ctrl+R` overrides (Chrome largely reserves them anyway), and add a `?` help row.

### [Nit] U-17: `.method-*` is an invalid CSS selector, so the "Any method" badge is unstyled
- **Where:** `popup\popup.css:408` (`.method-* { background: rgba(148,163,184,.2); color: #94a3b8; }`)
  consumed by `popup\popup.js:165` (`method-${(rule.match.method || 'GET').toLowerCase()}` → literal
  `method-*` for the `*` method); `devtools\panel.js:23-28` has no class for `*`, `PATCH`, `HEAD`, or
  `OPTIONS` either
- **Friction:** `.method-*` is not a valid compound selector (the universal selector may not follow a
  class in the same compound), so the browser discards the whole rule. A rule matching "Any (*)" —
  which is the default for four of the six rule types' templates (`options.js:672, 682, 687, 696`) —
  renders its method badge with no pill background at all, inconsistent with every other row. Same
  for PATCH/OPTIONS/HEAD rows in the DevTools panel.
- **Recommendation:** emit a sanitised class (`method-any`) from `popup.js:165` and rename the CSS
  rule; add `PATCH`/`OPTIONS`/`HEAD`/`*` entries to `METHOD_CLASSES` in `panel.js`.

### [Nit] U-18: Toasts overlap the header and stack on top of each other
- **Where:** `popup\popup.js:797-812` (`position: fixed; top: 10px; right: 10px`) over
  `popup\popup.css:117-126` (`.header { padding: 20px 24px }`, contains `#settingsBtn` at the right)
- **Friction:** Every toast lands directly on top of the Settings button in a 380 px-wide popup, and
  consecutive toasts (e.g. Test All emitting several) are absolutely positioned at the identical
  coordinates, so they render stacked and unreadable. The 3 s auto-dismiss with no pause-on-hover is
  also short for an error message the user is meant to act on.
- **Recommendation:** anchor toasts to the bottom (above the footer), use a flow container so
  multiples stack vertically, pause the dismiss timer on hover/focus, and give errors a longer or
  manual dismissal.

---

## Checked and ruled out

Verified against the code and found **not** to be problems:

- **Rule-card checkbox keyboard support** — `popup\popup.js:300-306` correctly handles both `Enter`
  and `' '` (Space) with `preventDefault()`, and `:349-350` updates `aria-checked` on toggle. Genuine
  keyboard operability confirmed. (The *global* status toggle, A-1, is the one that lacks this.)
- **Focus indicators on native buttons** — `outline: none` appears in exactly three places
  (`options.css:379`, `popup.css:251`, `overlay.js:112`) and each is scoped to
  `input`/`textarea`/`select` with a replacement `:focus` treatment (border + `box-shadow`) supplied
  at `options.css:383-388`, `popup.css:229-232`, `overlay.js:122-125`. The focus border measures
  4.47:1 (dark) / 5.97:1 (light) against the field fill, clearing 1.4.11. No button, link, or
  `tabindex` element has its outline suppressed, so the UA default ring remains. The failures are
  limited to *visually hidden* inputs (A-3).
- **Shadow DOM does not break label association** — `for`/`id` pairs in `overlay.js` (`tmType`,
  `tmName`, `tmMethod`, `tmUrl`, `tmStatus`, `tmDelay`, `tmMode`, `tmGraphql`, `tmMatchHeaders`,
  `tmResHeaders`, `tmBody`, `tmPatch`, `tmDelayMs`, `tmRedirect`, `tmHdrReq`, `tmHdrRes`, `tmQpAdd`,
  `tmQpRemove`) are all within the same shadow root, where IDREF resolution is scoped and works
  normally. Every overlay control has a correctly associated label — this surface is the *best*
  labelled in the product. `#tmEnabled` uses the label-wraps-control pattern with real text
  (`overlay.js:298`) and is correctly named.
- **Overlay does not double-register its Escape handler** — `ensureHost()` early-returns when the
  host is still connected (`overlay.js:315`), and `close()` removes the listener (`:556`), so
  repeated `open()` calls do not stack `keydown` listeners.
- **Hidden modals are not focus traps** — `.modal { display: none }` (`options.css:503`) removes the
  subtree from the tab order entirely when closed, so there are no off-screen focusable controls.
  Similarly, inactive `.tab-content` panels are `display: none` (`options.css:481-483`).
- **Landmarks in popup and options** — `popup.html` uses `<header>`/`<main>`/`<footer>`;
  `options.html` uses `<aside>`/`<nav>`/`<main>`/`<header>`. Both are reasonable. (Only the DevTools
  panel lacks landmarks — A-19.)
- **`lang` attributes** — present and correct on `popup.html:2`, `options.html:2`, `panel.html:2`.
  (The overlay inherits the host page's `lang`, which is the correct behaviour for injected UI.)
- **Escape closes dialogs** — implemented on all three surfaces (`options.js:1445-1450`,
  `overlay.js:345-350`, and the popup's own `window.close()` at `popup.js:742-744`). The problem is
  the *absence of a dirty check* (U-4), not the absence of the behaviour.
- **Rule-action buttons** — `popup.js:195-205` are native `<button>`s with both `aria-label` and
  `title`. Correctly named, focusable, and keyboard-activatable.
- **Empty states** — present and well-written on all three list surfaces: popup default
  (`popup.html:53-64`), popup no-search-results (`popup.js:265-275`, which echoes the query back),
  and DevTools (`panel.html:294-306`, which explains *how* to populate the list). Each pairs an icon,
  a title, and an actionable next step. This is a genuine strength.
- **Overlay save feedback** — `overlay.js:538-552` disables the button, shows "Saving…", and
  re-enables with the original label on failure. Correct pattern; the popup's equivalents are the
  broken ones (U-5).
- **Missing `</main>` in `options.html`** — checked whether it breaks the DOM: the HTML parser's
  `</div>` recovery closes the open `<main>` implicitly at `options.html:245`, so the three modals
  still land as children of `<body>` (which is where they belong). A validation error, not a
  functional one — folded into A-20 as a Nit.
- **Colour is not the sole state carrier for rule test status** — `getStatusIcon` (`popup.js:750-759`)
  varies *shape* (check / cross / triangle / clock) as well as hue, so 1.4.1 is satisfied for sighted
  users. The gap is the missing text alternative (A-9), not the use of colour.
