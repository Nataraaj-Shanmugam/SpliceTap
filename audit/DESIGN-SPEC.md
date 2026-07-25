# Design Spec — align every surface to the popup

`popup/popup.css` is the **reference implementation**. It is already correct and
must not be restyled. This spec exists so the other three surfaces adopt the
identical system without drifting (three different accent blues were live before
this pass).

Surfaces to update:
| Surface | File | Notes |
|---|---|---|
| Options page | `options/options.css` | Normal stylesheet |
| DevTools panel | `devtools/panel.html` | Inline `<style>` block |
| In-page overlay | `content/overlay.js` | `getStyles()` template literal — **hardcoded literals only** |

---

## 1. Tokens — copy verbatim

The overlay cannot use CSS variables from the page, so it must inline the literal
hex values. Options and DevTools use the variables.

### Dark (default, `:root`)
```css
--bg-app: #0b1018;
--bg-elevated: #0d141e;
--bg-card: #111a27;
--bg-card-hover: #101a27;
--bg-chip: #1b2735;
--text-main: #e7eefb;
--text-muted: #8b9ab3;
--text-dim: #8391a8;
--accent: #1e63f5;
--accent-hover: #1d4fd7;
--accent-bright: #2f7dfa;
--signal: #0bbcd4;
--signal-text: #5fdcf0;
--success: #22c55e;
--danger: #ef4444;
--border: rgba(148, 163, 184, 0.12);
--hairline: rgba(148, 163, 184, 0.09);
--border-strong: rgba(148, 163, 184, 0.6);
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
--shadow-md: 0 6px 20px rgba(0, 0, 0, 0.4);
--font-main: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
--font-mono: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, 'Liberation Mono', Menlo, monospace;
--ease: cubic-bezier(0.4, 0, 0.2, 1);
color-scheme: dark;
```

### Light (`body.theme-light`)
```css
--bg-app: #ffffff;
--bg-elevated: #fafbfd;
--bg-card: #f4f6fa;
--bg-card-hover: #f5f9ff;
--bg-chip: #eef2f7;
--text-main: #101828;
--text-muted: #5d6a80;
--text-dim: #667383;
--accent: #1e63f5;
--accent-hover: #1d4fd7;
--accent-bright: #2f7dfa;
--signal: #0694aa;
--signal-text: #03707f;
--success: #15803d;
--danger: #dc2626;
--border: #e6ebf2;
--hairline: #eef1f6;
--border-strong: rgba(15, 23, 42, 0.5);
--shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.08);
--shadow-md: 0 6px 20px rgba(15, 23, 42, 0.14);
color-scheme: light;
```

### ⚠️ Accent roles are NOT interchangeable
Measured, do not "improve" these:

| Token | Use for | Contrast |
|---|---|---|
| `--accent` `#1e63f5` | any fill carrying **white text** — primary buttons, active nav, checked states | white on it = **5.05:1** ✓ AA |
| `--accent-hover` `#1d4fd7` | hover of the above | 6.66:1 ✓ |
| `--accent-bright` `#2f7dfa` | **non-text only** — focus rings, focus outlines, input borders, decorative icons | 4.93:1 vs bg ✓ (3:1 bar) |
| `--accent-text` dark `#8ab6ff` / light `#1d4fd7` | accent used **as a text colour** on a normal surface — stat figures, active tab labels, tinted info banners | 8.51:1 on `--bg-card` ✓ |

**Never use `--accent` as a text colour on a dark surface** — `#1e63f5` on
`--bg-card` is only **3.46:1**, and on `--bg-app` 3.78:1. Both fail. That is what
`--accent-text` exists for. (`accent-color:` the CSS *property* — for native
checkbox/radio tinting — is not text and correctly takes `--accent`.)

Putting white text on `#2f7dfa` yields **3.86:1 and fails AA** — that is the exact
regression this pass exists to remove. Never use `--accent-bright` as a fill
behind text.

---

## 2. Token mapping (old → new)

| Old token | Replace with |
|---|---|
| `--bg-sidebar` (options) | `--bg-elevated` |
| `--bg-input` (options) | `--bg-app` |
| `--accent: #3355e0` / `#4f6ef7` | per the role table above |
| any hardcoded `#0f1420` / `#1a2130` / `#141b28` / `#0b0f19` | matching new token |
| any hardcoded `#4f6ef7` / `#3355e0` | `--accent` or `--accent-bright` per role |

---

## 3. Structural conventions

**Radii** — tighten. The popup uses only:
- `4px` tiny badges · `6px` small buttons/inputs · `7px` icon buttons, logo
- `8px` inputs, buttons, cards · `9px` larger cards · `999px` pills/toggles

Options currently uses 10/12/16/24px — map: `10→8`, `12→8`, `16→12` (modals only), `24→999` (pills).

**Type scale**
- Page/section title `14px/600`, `letter-spacing: -0.01em`
- Body `12.5px`
- Secondary/meta `11px`, `--text-muted`
- Micro-labels & pills `10px/600`, `letter-spacing: 0.08em`, `text-transform: uppercase`, `--text-dim`
- Monospace (URLs, hosts, counts) `--font-mono`, `10–12.5px`

**Components**
- *Pill / status chip*: `border-radius: 999px`, `padding: 5px 9px`, `min-height: 24px`, 10px uppercase, `1px solid var(--border)`, background `rgba(148,163,184,0.08)`, hover `0.16`
- *Icon button*: `26×26`, `border-radius: 7px`, transparent, `svg 17px`, hover `background: rgba(148,163,184,0.12)`
- *Input / search*: `height: 32px`, `border-radius: 8px`, `background: var(--bg-card)`, `1px solid var(--border)`
- *Focus*: `border-color: var(--accent-bright)` + `box-shadow: 0 0 0 3px rgba(47,125,250,0.18)`; keyboard outlines `outline: 2px solid var(--accent-bright)`
- *Chip / tag*: `background: var(--bg-chip)`, `border-radius: 6px`
- *Row dividers*: `1px solid var(--hairline)` (subtler than `--border`, which is for outer edges)
- *Transitions*: `0.2s` standard, `0.15s` for small hovers; use `var(--ease)` for movement

**"Active/on" state uses `--signal` (cyan), not green.** This is deliberate and
distinctive — the popup's master toggle uses `--signal-text` on
`rgba(11,188,212,0.10)` with a `--signal` dot. Mirror it for any equivalent
"live/enabled/recording" indicator.

**Rule-type badge palette** — keep the existing per-type hues already present in
each file; only re-tint the surface they sit on if it changed. Do not invent new
per-type colours; the six types must look identical across all four surfaces.

---

## 4. Hard constraints

1. **Do not rename or remove any class, id, or `data-*` attribute.** The JS in
   every surface queries these; the popup file header lists its selector contract
   as an example. CSS values change, selectors do not.
2. **Preserve every existing accessibility fix** already in these files —
   `prefers-reduced-motion`, `forced-colors`, `:focus-visible` rules,
   `.visually-hidden`, `color-scheme`, `::placeholder` colours, and the ≥24px
   target sizes. If a restyle would shrink a target below 24×24, keep the size.
3. **Both themes must be complete.** Anything you restyle needs its
   `body.theme-light` counterpart. Translucent bars hardcoded for dark
   (`rgba(15,23,42,…)` overlays) need light equivalents.
4. **No new dependencies, no build step, no CSS nesting or `@layer`** — plain CSS
   that Chrome 120 parses directly.
5. Contrast: body text ≥4.5:1, large text/UI ≥3:1, in **both** themes. The token
   set above already satisfies this — you only need to re-check any bespoke
   colour you introduce.
