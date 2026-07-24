# Fix Dispatch Plan — 155 findings → 8 parallel work packages

Every finding from the 7 audit reports is assigned to exactly one group. Groups own
**disjoint file sets**, so all 8 can run in parallel with zero write conflicts.

## ID disambiguation
Two reports both number findings `Q-n`. Throughout this plan:
- `QA-Qn` → `qa-edge-cases.md`
- `CQ-Qn` → `code-quality.md`

Other prefixes are unique: `S-` security, `C-` store-compliance, `P-` performance,
`A-`/`U-` accessibility-ux, `G-` product-gaps.

## File ownership (disjoint — the parallelism guarantee)

| Group | Owns (exclusive write access) |
|---|---|
| **F1 Interceptor + bridge** | `content/injected.js`, `content/content.js` |
| **F2 Shared logic modules** | `src/matcher.js`, `src/patch.js`, `src/placeholders.js`, `src/utils.js`, `tests/*.test.js` |
| **F3 Background + DNR + storage** | `service_worker/background.js`, `service_worker/dnr.js`, `src/storage.js` |
| **F4 Options page** | `options/options.html`, `options/options.css`, `options/options.js` |
| **F5 Popup** | `popup/popup.html`, `popup/popup.css`, `popup/popup.js` |
| **F6 In-page overlay** | `content/overlay.js` |
| **F7 Manifest / assets / tooling / docs** | `manifest.json`, `assets/icons/*`, `scripts/*`, `package.json`, `README.md`, `index.js`, `tests/*.html`, new lint/CI config |
| **F8 DevTools panel** | `devtools/devtools.js`, `devtools/panel.html`, `devtools/panel.js` |

Nobody edits `audit/**`, `TODO.md`, or `changes.txt`.

---

## F1 — Interceptor + message bridge
**Files:** `content/injected.js`, `content/content.js`

Correctness (do first): `QA-Q1` (XHR handlers fire twice — Critical), `QA-Q2` (204/205/304
make fetch reject — Critical), `QA-Q5`, `QA-Q6`, `QA-Q7`, `QA-Q8`, `QA-Q12`, `QA-Q13`,
`QA-Q17`, `QA-Q18`, `QA-Q23`, `QA-Q24`, `QA-Q25`, `QA-Q27`, `QA-Q28`, `QA-Q33`.

Bridge security (coordinated pair — both halves live in this group): `S-4`, `C-4`, `C-5`,
`QA-Q14`, `QA-Q11`, `S-7`, `S-8` (injected side), `S-9`.

Performance: `P-1` (zero-rule early-out), `P-2`, `P-3`, `P-8`, `P-10`, `P-11`, `P-13`,
`P-15`, `P-16` (injected half), `P-18`, `P-7` (caller side only).

## F2 — Shared logic modules
**Files:** `src/matcher.js`, `src/patch.js`, `src/placeholders.js`, `src/utils.js`, `tests/*.test.js`

`QA-Q3` (regex-containing-`*` never matches — High, breaks a shipped template),
`QA-Q10` (pattern `/` matches everything), `QA-Q30`, `S-10` (ReDoS guard),
`P-4` (regex cache), `P-7` (placeholder guard + round-trip), `P-16` (matcher half),
`S-6` (the `src/utils.js` copy of `escapeHtml`), `CQ-Q6` (utils.js weight / SW landmines),
`G-16` (user-defined placeholders — design only, note don't build).

**Must add regression tests** for every behavioral fix, especially `QA-Q3`.

## F3 — Background + DNR + storage
**Files:** `service_worker/background.js`, `service_worker/dnr.js`, `src/storage.js`

`QA-Q21` / `G-3` (Test hard-fails 5 of 6 rule types), `C-6` / `QA-Q20` / `G-10` / `U-6`
(register `chrome.commands.onCommand` — shortcuts are inert), `QA-Q26` / `G-6`
(`hitCount` never incremented), `S-3` (DNR header denylist — CSP/HSTS strippable),
`S-2` (server-side rule validation on `setRules`/`saveRule`), `C-7` (cold start broadcasts
empty rules), `C-10`, `C-11`, `C-16`, `C-22`, `QA-Q15` (dnrRuleId race), `QA-Q16`
(trailing flush), `QA-Q29`, `QA-Q31`, `P-5`, `P-6`, `P-14`, `P-17`, `S-8` (persistence side).

Do **not** edit `manifest.json` — F7 owns the `declarativeNetRequestWithHostAccess` rename (`C-8`).

## F4 — Options page
**Files:** `options/options.html`, `options/options.css`, `options/options.js`

`U-1` (validation errors invisible — class mismatch + container outside modal),
`CQ-Q3` / `QA-Q9` (stale bulk write silently deletes rules — data loss), `QA-Q10` (run
`validateUrlPattern` on save), `S-2` (client-side import validation), `C-15` (corsUnblock
template applies `*` to every site), `U-4` (discards unsaved work), `U-7`, `U-8` (validates
settings with no UI → dead end), `G-11` (six dead settings), `G-8` (chaos mode has no UI),
`A-2`, `A-3`, `A-4`, `A-6` (options half), `A-7` (options CSS contrast), `A-8`, `A-11`,
`A-14`, `A-15`, `A-20` (options half).

`U-2` / `G-1` (no rule manager) is a **feature** — out of scope, see backlog.

## F5 — Popup
**Files:** `popup/popup.html`, `popup/popup.css`, `popup/popup.js`

`A-1` (Critical — keyboard cannot toggle the extension), `S-5` + `QA-Q22` (unescaped rule
fields → `innerHTML`), `S-6` (popup copy of `escapeHtml` — must escape quotes),
`QA-Q4` (one malformed rule permanently breaks the list), `C-17`, `A-9`, `A-12`, `A-16`,
`A-17`, `A-18`, `A-19` (popup half), `A-20` (popup half), `A-6` (toast live region),
`A-7` (popup CSS contrast), `A-14`, `A-15`, `U-5`, `U-10`, `U-11`, `U-12`, `U-14`, `U-15`,
`U-16`, `U-17`, `U-18`, `G-17`.

## F6 — In-page overlay
**Files:** `content/overlay.js`

`S-1` (open Shadow DOM lets host page read/drive the editor), `QA-Q19` (resurrects deleted
rules), `A-5` (no focus trap/restore), `A-13` (`all: initial` resets direction/typography),
`U-13` (undiscoverable), `P-9` (24 KB parsed per page load — make registration lazy).

## F7 — Manifest / assets / tooling / docs
**Files:** `manifest.json`, `assets/icons/*`, `scripts/*`, `package.json`, `README.md`, `index.js`, `tests/*.html`, lint config

`C-1` (**Critical** — icons are base64 text; 3 of 4 decode to 1×1), `C-20` (validator gives
false green — must verify PNG signature + dimensions), `C-2` (privacy policy, permission
justifications, single-purpose statement), `C-3`, `C-8` (`declarativeNetRequestWithHostAccess`),
`C-9` (drop unused `activeTab`), `C-12`, `C-13` (version mismatch), `C-14` (reserved
shortcut collision), `C-18`, `C-19`, `C-21`, `S-11`, `S-12`, `G-13` (README overstates
product), `CQ-Q7` (broken root `index.js`), `CQ-Q8` (track `TODO.md`), `CQ-Q10` (ESLint —
`npm run lint` currently lies), `CQ-Q13` (broken test harnesses), `CQ-Q14` (no Jest config),
`CQ-Q15` (stale comments/docs).

## F8 — DevTools panel
**Files:** `devtools/devtools.js`, `devtools/panel.html`, `devtools/panel.js`

`P-12` (2 s poll keeps SW permanently awake + full re-render), `A-10` (no live region,
no pause, no table semantics), `A-19` (panel landmarks), `U-9` (ignores theme setting),
`S-6` (panel copy of `escapeHtml`), `S-8` (full-URL tooltips), `G-12`.

---

## Deferred — not dispatched

**Refactor (F9, sequential — must run after F1–F8 land):**
`CQ-Q1`, `CQ-Q2` (extract `src/rule-schema.js` as single source of truth), `CQ-Q4`
(test seams), `CQ-Q5` (`OptionsManager` god object), `CQ-Q11` (error-handling
conventions), `CQ-Q12`, `U-3` / `G-9` (two divergent rule editors).
Deferred because it rewrites files owned by F1–F6 and would conflict.

**Feature backlog (not bugs):**
`G-1`/`U-2` rule manager, `G-2` request→rule capture, `G-4` groups/ordering, `G-5` source
filters, `G-7` modify-request-body / replace-string / script injection, `G-12` DevTools
workspace, `G-14` sync/sharing, `G-15` richer match conditions, `G-16` user-defined
placeholders.

## Shared contract (all groups)
- Fix **correctness before performance**; never trade a behavior change for a micro-optimization.
- Any `escapeHtml` you touch must escape `& < > " '` (three independent copies exist: F2, F5, F8).
- Do not change the v2 rule schema shape (`TODO.md §1.1`) — F9 owns consolidation.
- Gate before reporting: `npx jest` green, `node scripts/validate-manifest.js` passes,
  `node --check` on every edited `.js`.
