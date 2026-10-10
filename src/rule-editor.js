/**
 * SpliceTap Rule Editor
 * The one rule editor, mounted wherever a rule is created or edited (UMD).
 *
 * R1 / CQ-1: there used to be two complete editors — the in-page overlay
 * (content/overlay.js) and the options page's own form (options/options.js,
 * with a 400-line save function) — and they had drifted. Verified headless:
 *
 *   - Saving an edit dropped every field the form did not display, so an
 *     imported rule lost its `imported` provenance and any notes it carried.
 *   - Header and GraphQL match conditions were only shown for mock rules, so
 *     editing a block or delay rule that had them (valid, and importable)
 *     silently removed them — widening a "block requests with X-Env: dev"
 *     rule into "block every request to this URL".
 *   - Each editor validated differently, and neither the way the background
 *     did. Validation now comes from src/rule-schema.js, the same module the
 *     background uses as its trust boundary.
 *
 * This module is that editor; content/overlay.js and options/options.js are
 * now thin hosts that mount it. Both hosts get identical behaviour because
 * there is only one implementation to behave.
 *
 * Loads as a content script (ISOLATED world) and as a plain script on an
 * extension page; needs chrome.runtime and chrome.storage, which both have.
 *
 * Usage:
 *   const editor = SpliceTapRuleEditor.create({ shadowMode, onClose });
 *   editor.open({ rule, prefillUrl });   // rule omitted => new rule
 */
(function (global) {
    'use strict';

    const HOST_ID = 'splicetap-rule-overlay-host';
    const HINT_SEEN_KEY = 'tmOverlayHintSeen'; // U-13: one-time first-run tip

    const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', '*'];

    const RULE_TYPES = [
        ['mock', 'Mock Response'],
        ['block', 'Block'],
        ['delay', 'Delay'],
        ['redirect', 'Redirect'],
        ['headers', 'Modify Headers'],
        ['queryparams', 'Query Params']
    ];

    // Rule types the in-page interceptor handles, and so the ones that can
    // carry header/GraphQL match conditions. headers/queryparams are applied
    // by declarativeNetRequest, which cannot express them; redirect must pick
    // its target before request headers exist (CQ-4).
    const CONDITION_TYPES = ['mock', 'block', 'delay'];

    // Fields that belong to exactly one rule type. When an edit changes the
    // type, the old type's field is removed rather than carried as dead data.
    const TYPE_FIELDS = {
        mock: 'response',
        delay: 'delayMs',
        redirect: 'redirect',
        headers: 'headersMod',
        queryparams: 'queryParams'
    };

    // CQ-10: limits come from the one shared definition (src/common.js).
    function L() {
        return (global.SpliceTapCommon && global.SpliceTapCommon.LIMITS) || {
            STATUS_MIN: 100, STATUS_MAX: 599,
            DELAY_MIN: 0, DELAY_MAX: 30000,
            DELAY_MS_MIN: 1, DELAY_MS_MAX: 30000
        };
    }

    function newRuleId() {
        // CQ-6 consolidated id generation, but this editor kept its own
        // inline copy; use the shared one so every surface mints the same shape.
        if (global.SpliceTapCommon && typeof global.SpliceTapCommon.generateId === 'function') {
            return global.SpliceTapCommon.generateId();
        }
        return `rule_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }

    /**
     * PER-77: which form field a validation message is about, so the editor
     * can mark that field invalid and describe it. The messages come from
     * src/rule-schema.js (and the background, which uses the same module),
     * which owns their wording; this only reads them. A message that matches
     * nothing returns null and is shown in the summary alone.
     *
     * @param {string} message
     * @param {object} [rule] The rule being saved; disambiguates messages that
     *        do not say which header list or delay field they are about.
     * @returns {string|null} an element id inside the editor
     */
    function fieldForError(message, rule) {
        const m = String(message || '');
        const type = (rule && rule.type) || 'mock';

        const forbidden = /^Header "(.+)" cannot be modified/.exec(m);
        if (forbidden) {
            const name = forbidden[1].toLowerCase();
            const inList = (list) => Array.isArray(list)
                && list.some((op) => op && typeof op.name === 'string' && op.name.toLowerCase() === name);
            const hm = (rule && rule.headersMod) || {};
            return !inList(hm.request) && inList(hm.response) ? 'tmHdrRes' : 'tmHdrReq';
        }

        if (/^Rule name/i.test(m)) return 'tmName';
        if (/^Unknown rule type/i.test(m)) return 'tmType';
        if (/URL pattern/i.test(m)) return 'tmUrl';
        if (/GraphQL operation matching requires method|^HTTP method/i.test(m)) return 'tmMethod';
        if (/GraphQL condition/i.test(m)) return 'tmGraphql';
        if (/^Match request headers/i.test(m)) return 'tmMatchHeaders';
        if (/^Response mode/i.test(m)) return 'tmMode';
        if (/status code/i.test(m)) return 'tmStatus';
        if (/^Response headers/i.test(m)) return 'tmResHeaders';
        if (/^Delay must/i.test(m)) return type === 'delay' ? 'tmDelayMs' : 'tmDelay';
        if (/response patch/i.test(m)) return 'tmPatch';
        if (/^Redirect destination/i.test(m)) return 'tmRedirect';
        if (/^Request header #|^request header operations|^At least one request or response header/i.test(m)) return 'tmHdrReq';
        if (/^Response header #|^response header operations|^Access-Control-Allow-Origin/i.test(m)) return 'tmHdrRes';
        if (/^"add"|^Added parameter|^At least one query parameter/i.test(m)) return 'tmQpAdd';
        if (/^"remove"|^Every parameter to remove/i.test(m)) return 'tmQpRemove';
        return null;
    }

    /**
     * PER-50: a whole number from a number field's text. This was parseInt,
     * which stops at the first non-digit: "2e3" saved as 2 ms and "1.9" as 1,
     * silently. A number field accepts both spellings, so the full string is
     * read as a number and anything that is not an integer is refused.
     *
     * @returns {{value:number, empty?:boolean, invalid?:boolean}} value is NaN
     *          when the field is empty or not a whole number.
     */
    function parseWholeNumber(text) {
        const t = String(text === undefined || text === null ? '' : text).trim();
        if (t === '') return { value: NaN, empty: true };
        const n = Number(t);
        if (!Number.isFinite(n) || !Number.isInteger(n)) return { value: NaN, invalid: true };
        return { value: n };
    }

    /**
     * A response body: a JSON object or array is stored parsed; anything
     * else is stored as the exact text typed. (Parsing every value meant a
     * body of "hello" — with quotes — was stored as the string hello and
     * served without them; what you type is now what is served.)
     *
     * PER-26: an empty (or whitespace-only) body stays '' — an empty 200 is a
     * real thing to mock. It used to become {}, so merely renaming a rule that
     * served "" quietly changed what it served.
     */
    function readBody(raw) {
        const text = String(raw === undefined || raw === null ? '' : raw).trim();
        if (!text) return '';
        try {
            const parsed = JSON.parse(text);
            if (parsed !== null && typeof parsed === 'object') return parsed;
        } catch (e) {
            // plain text
        }
        return raw;
    }

    // The ~4 KB style string and the markup builder are the bulk of this
    // module's cost. Neither runs until an editor is actually opened, so the
    // great majority of page loads — which never open it — pay only for
    // defining these functions (P-9).
    let _stylesCache = null;

    function getStyles() {
        if (_stylesCache !== null) return _stylesCache;

        _stylesCache = `
        :host {
            all: initial;
            /* all: initial resets inherited direction/color-scheme too;
               re-establish sane values so RTL pages and native form-control
               chrome aren't broken by our isolation (A-13). */
            /* PER-78: the UI is English and its URL/JSON fields are code, so an
               RTL host page must not mirror them (A-13 used "inherit"). */
            direction: ltr;
            color-scheme: dark light;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }

        /* Design tokens are inlined as literal
           hex/rgba values rather than declared as custom properties. This
           sheet lives in a shadow root grafted onto arbitrary third-party
           pages, and for normal declarations the *outer* tree wins on the
           host element — so a page rule touching custom properties on our
           host could repaint the dialog. Literals cannot be reached at all.
             bg-app #0b1018 · bg-card #111a27
             text-main #e7eefb · text-muted #8b9ab3 · text-dim #8391a8
             accent #1e63f5 (only fill allowed under white text, 5.05:1)
             accent-hover #1d4fd7
             accent-bright #2f7dfa (focus rings / borders / tints ONLY —
                                    as a fill under white text it is 3.86:1)
             border rgba(148,163,184,0.12) · hairline rgba(148,163,184,0.09)
           Light-theme values are in the .tm-light block at the bottom. */

        .tm-backdrop {
            position: fixed;
            inset: 0;
            background: rgba(8, 12, 20, 0.6);
            z-index: 2147483647;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding: 48px 16px;
            overflow-y: auto;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            /* PER-73: the one fixed base. Every size below is in em against
               this, never rem: rem resolves against the HOST page's <html>,
               so a site with html{font-size:62.5%} (a common reset) rendered
               the labels at 6.25px, and :host{all:initial} cannot isolate it. */
            font-size: 16px;
        }

        .tm-panel {
            position: relative;
            width: 100%;
            max-width: 620px;
            background: #111a27;
            color: #e7eefb;
            border: 1px solid rgba(148, 163, 184, 0.12);
            border-radius: 12px;
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
        }

        /* Brand gradient hairline along the dialog's top edge. Decorative
           only — no text sits on it, so the ramp's low-contrast cyan end is
           not a legibility concern. Inset by the 1px border and clipped to
           the panel's corner radius. */
        .tm-panel::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0;
            height: 3px;
            border-radius: 11px 11px 0 0;
            background: linear-gradient(135deg, #1e63f5, #0bbcd4);
        }

        .tm-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 14px 16px;
            border-bottom: 1px solid rgba(148, 163, 184, 0.09);
        }

        .tm-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }

        .tm-logo {
            width: 26px; height: 26px;
            flex-shrink: 0;
            border-radius: 7px;
            overflow: hidden;
            background: #1e63f5;
            color: #fff;
            display: flex; align-items: center; justify-content: center;
            font-size: 0.6875em; font-weight: 700; letter-spacing: -0.01em;
        }
        .tm-logo svg { width: 100%; height: 100%; display: block; }

        .tm-title {
            font-size: 0.875em;
            font-weight: 600;
            letter-spacing: -0.01em;
            line-height: 1.15;
            min-width: 0;
        }

        .tm-x {
            width: 26px; height: 26px;
            flex-shrink: 0;
            display: inline-flex; align-items: center; justify-content: center;
            background: transparent; border: none; cursor: pointer;
            color: #8b9ab3; font-size: 1.125em; line-height: 1;
            font-family: inherit;
            border-radius: 7px;
            transition: background-color 0.15s, color 0.15s;
        }
        .tm-x:hover { background: rgba(148, 163, 184, 0.12); color: #e7eefb; }
        .tm-x:focus-visible { outline: 2px solid #2f7dfa; outline-offset: 1px; }

        .tm-hintbar {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            margin: 12px 16px 0;
            padding: 9px 11px;
            border-radius: 9px;
            font-size: 0.75em;
            line-height: 1.45;
            background: rgba(47, 125, 250, 0.12);
            color: #e7eefb;
            border: 1px solid rgba(47, 125, 250, 0.3);
        }
        .tm-hintbar[hidden] { display: none; }
        .tm-hintbar-text { flex: 1; min-width: 0; }
        .tm-hintbar-x {
            width: 24px; height: 24px;
            flex-shrink: 0;
            margin: -3px -3px -3px 0;
            display: inline-flex; align-items: center; justify-content: center;
            background: transparent; border: none; cursor: pointer;
            /* 1.25em of the hint bar's 12px = the original 15px (em compounds, PER-73) */
            color: inherit; font-size: 1.25em; line-height: 1;
            font-family: inherit;
            border-radius: 6px;
            transition: background-color 0.15s;
        }
        .tm-hintbar-x:hover { background: rgba(148, 163, 184, 0.18); }
        .tm-hintbar-x:focus-visible { outline: 2px solid #2f7dfa; outline-offset: 1px; }

        .tm-body {
            padding: 16px;
            max-height: 65vh;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: rgba(148, 163, 184, 0.3) transparent;
        }
        .tm-body::-webkit-scrollbar { width: 4px; }
        .tm-body::-webkit-scrollbar-thumb {
            background: rgba(148, 163, 184, 0.3);
            border-radius: 4px;
        }

        .tm-row { display: flex; gap: 10px; }
        .tm-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; flex: 1; min-width: 0; }

        /* Micro-label. :not(.tm-check) keeps the checkbox row's own <label>
           — a direct child of .tm-field too — out of the uppercase scale.
           --text-muted rather than --text-dim: #8391a8 on the #111a27 panel
           is 4.13:1, under the 4.5:1 bar for 10px text. #8b9ab3 is 6.07:1. */
        .tm-field > label:not(.tm-check) {
            font-size: 0.625em;
            font-weight: 600;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            line-height: 1.35;
            color: #8b9ab3;
        }

        .tm-field input[type="text"],
        .tm-field input[type="number"],
        .tm-field select,
        .tm-field textarea {
            width: 100%;
            background: #0b1018;
            border: 1px solid rgba(148, 163, 184, 0.12);
            color: #e7eefb;
            border-radius: 8px;
            font-size: 0.78125em;
            font-family: inherit;
            outline: none;
            transition: border-color 0.2s, box-shadow 0.2s;
        }

        .tm-field input[type="text"],
        .tm-field input[type="number"],
        .tm-field select {
            height: 32px;
            padding: 0 10px;
        }

        .tm-field textarea {
            padding: 8px 10px;
            font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, 'Liberation Mono', Menlo, monospace;
            font-size: 0.75em;
            line-height: 1.5;
            resize: vertical;
        }

        .tm-field input::placeholder,
        .tm-field textarea::placeholder { color: #8391a8; opacity: 1; }

        .tm-field input[type="text"]:focus,
        .tm-field input[type="number"]:focus,
        .tm-field select:focus,
        .tm-field textarea:focus {
            border-color: #2f7dfa;
            box-shadow: 0 0 0 3px rgba(47, 125, 250, 0.18);
        }

        .tm-hint { font-size: 0.6875em; color: #8b9ab3; line-height: 1.45; }

        /* PER-77: required-field marker (the glyph, not the colour, carries
           the meaning; aria-required carries it for assistive tech) and the
           per-field error that aria-describedby points at. */
        .tm-req { color: #f87171; font-weight: 700; margin-left: 0.25em; }
        .tm-legend { font-size: 0.6875em; color: #8b9ab3; line-height: 1.45; margin-bottom: 12px; }
        .tm-field-err { font-size: 0.6875em; color: #f87171; line-height: 1.45; }
        .tm-field [aria-invalid="true"] { border-color: #f87171 !important; }

        .tm-check {
            display: flex; align-items: center; gap: 8px;
            min-height: 24px;
            font-size: 0.78125em;
            font-weight: 500;
            color: #e7eefb;
            cursor: pointer;
        }
        .tm-check input {
            width: 16px; height: 16px;
            flex-shrink: 0;
            accent-color: #1e63f5;
            cursor: pointer;
        }
        .tm-check input:focus-visible { outline: 2px solid #2f7dfa; outline-offset: 2px; }

        .tm-foot {
            display: flex; justify-content: flex-end; gap: 8px;
            padding: 12px 16px;
            border-top: 1px solid rgba(148, 163, 184, 0.09);
        }

        .tm-btn {
            display: inline-flex; align-items: center; justify-content: center;
            height: 32px;
            padding: 0 14px;
            border-radius: 8px;
            font-size: 0.78125em;
            font-weight: 600;
            font-family: inherit;
            cursor: pointer;
            border: 1px solid transparent;
            transition: background-color 0.15s, border-color 0.15s, color 0.15s;
        }
        .tm-btn:focus-visible { outline: 2px solid #2f7dfa; outline-offset: 2px; }
        .tm-btn:disabled { opacity: 0.6; cursor: default; }

        /* White label => the AA-safe accent, never #2f7dfa (3.86:1 as a fill). */
        .tm-btn-primary { background: linear-gradient(135deg, #1e63f5, #0e7490); color: #fff; }
        .tm-btn-primary:hover:not(:disabled) { background: linear-gradient(135deg, #1d4fd7, #0c6179); }

        .tm-btn-secondary {
            background: rgba(148, 163, 184, 0.08);
            color: #e7eefb;
            border-color: rgba(148, 163, 184, 0.12);
        }
        .tm-btn-secondary:hover:not(:disabled) { background: rgba(148, 163, 184, 0.16); }

        .tm-error {
            display: none;
            margin-bottom: 12px;
            padding: 9px 11px;
            border-radius: 8px;
            font-size: 0.75em;
            line-height: 1.45;
            background: rgba(239, 68, 68, 0.12);
            color: #f87171;
            border: 1px solid rgba(239, 68, 68, 0.3);
            white-space: pre-line;
        }
        .tm-error.tm-show { display: block; }

        [data-types] { display: none; }
        [data-types].tm-visible { display: block; }
        .tm-row[data-types].tm-visible { display: flex; }
        /* .tm-field is a flex column; restore that when it is a [data-types]
           block being revealed, so its label/control gap still applies. */
        .tm-field[data-types].tm-visible { display: flex; }

        /* ── Light theme (class set on .tm-backdrop by applyTheme) ──────── */
        .tm-light { color-scheme: light; background: rgba(15, 23, 42, 0.32); }
        .tm-light .tm-panel {
            background: #ffffff;
            color: #101828;
            border-color: #e6ebf2;
            box-shadow: 0 6px 20px rgba(15, 23, 42, 0.14);
        }
        .tm-light .tm-head { border-bottom-color: #eef1f6; }
        .tm-light .tm-foot { border-top-color: #eef1f6; }
        .tm-light .tm-title { color: #101828; }
        .tm-light .tm-field > label:not(.tm-check) { color: #5d6a80; }
        .tm-light .tm-hint,
        .tm-light .tm-legend { color: #5d6a80; }
        .tm-light .tm-req,
        .tm-light .tm-field-err { color: #b91c1c; }
        .tm-light .tm-field [aria-invalid="true"] { border-color: #b91c1c !important; }
        .tm-light .tm-check { color: #101828; }
        .tm-light .tm-x { color: #5d6a80; }
        .tm-light .tm-x:hover { background: rgba(15, 23, 42, 0.07); color: #101828; }
        .tm-light .tm-field input[type="text"],
        .tm-light .tm-field input[type="number"],
        .tm-light .tm-field select,
        .tm-light .tm-field textarea {
            background: #f4f6fa; color: #101828; border-color: #e6ebf2;
        }
        .tm-light .tm-field input::placeholder,
        .tm-light .tm-field textarea::placeholder { color: #667383; }
        .tm-light .tm-hintbar {
            background: rgba(30, 99, 245, 0.07);
            color: #101828;
            border-color: rgba(30, 99, 245, 0.22);
        }
        .tm-light .tm-hintbar-x:hover { background: rgba(15, 23, 42, 0.07); }
        .tm-light .tm-error {
            background: rgba(220, 38, 38, 0.08);
            color: #b91c1c;
            border-color: rgba(220, 38, 38, 0.22);
        }
        .tm-light .tm-btn-secondary {
            background: rgba(15, 23, 42, 0.05);
            color: #101828;
            border-color: #e6ebf2;
        }
        .tm-light .tm-btn-secondary:hover:not(:disabled) { background: rgba(15, 23, 42, 0.09); }
        .tm-light .tm-body { scrollbar-color: rgba(15, 23, 42, 0.22) transparent; }
        .tm-light .tm-body::-webkit-scrollbar-thumb { background: rgba(15, 23, 42, 0.22); }

        /* ── Motion / forced colours ───────────────────────────────────── */
        @media (prefers-reduced-motion: reduce) {
            .tm-backdrop,
            .tm-backdrop *,
            .tm-backdrop *::before,
            .tm-backdrop *::after {
                transition-duration: 0.01ms !important;
                animation-duration: 0.01ms !important;
                animation-iteration-count: 1 !important;
            }
        }

        @media (forced-colors: active) {
            .tm-panel,
            .tm-error,
            .tm-hintbar,
            .tm-btn,
            .tm-field input[type="text"],
            .tm-field input[type="number"],
            .tm-field select,
            .tm-field textarea {
                border-color: CanvasText;
            }
        }
    `;

        return _stylesCache;
    }

    function markup() {
        const typeOptions = RULE_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
        const methodOptions = METHODS.map(m => `<option value="${m}">${m === '*' ? 'Any (*)' : m}</option>`).join('');

        // Read from the shared definition (src/templates.js) rather than a
        // second copy, so options and overlay can never drift apart on these.
        const templates = (global.SpliceTapTemplates && global.SpliceTapTemplates.listTemplates())
            || [];
        const templateOptions = ['<option value="">Blank rule</option>']
            .concat(templates.map((t) => `<option value="${t.id}" title="${t.description}">${t.label}</option>`))
            .join('');

        // PER-77: the marker is decoration for sighted users; aria-required
        // on the control is what assistive tech reads.
        const REQ = '<span class="tm-req" aria-hidden="true">*</span>';

        // PER-78: dir="ltr" on the root, not just direction in the host CSS,
        // so native controls and bidi text resolve left-to-right on an RTL page.
        return `
        <div class="tm-backdrop" part="backdrop" dir="ltr">
          <div class="tm-panel" role="dialog" aria-modal="true" aria-labelledby="tmTitle">
            <div class="tm-head">
              <div class="tm-brand">
                <div class="tm-logo">
                  <svg viewBox="0 0 128 128" aria-hidden="true" focusable="false">
                    <defs>
                      <linearGradient id="tmLogo" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stop-color="#1e63f5" />
                        <stop offset="100%" stop-color="#0bbcd4" />
                      </linearGradient>
                    </defs>
                    <rect x="0" y="0" width="128" height="128" rx="30" fill="url(#tmLogo)" />
                    <circle cx="28" cy="44" r="6.5" fill="#fff" opacity="0.5" />
                    <circle cx="52" cy="44" r="6.5" fill="#fff" opacity="0.5" />
                    <circle cx="76" cy="44" r="6.5" fill="#fff" opacity="0.5" />
                    <path d="M88 32 L100 44 L88 56" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" opacity="0.5" />
                    <path d="M100 86 L44 86" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round" />
                    <path d="M42 72 L28 86 L42 100" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </div>
                <h2 class="tm-title" id="tmTitle">New Rule</h2>
              </div>
              <button type="button" class="tm-x" id="tmClose" title="Close" aria-label="Close editor">&times;</button>
            </div>

            <div class="tm-hintbar" id="tmHintBar" hidden>
              <span class="tm-hintbar-text">SpliceTap opens this editor over your current page. Press Esc or click outside to close it.</span>
              <button type="button" class="tm-hintbar-x" id="tmHintClose" aria-label="Dismiss tip">&times;</button>
            </div>

            <div class="tm-body">
              <!-- A11Y-6: role="alert" so validation failures are announced.
                 This is the primary editor — every documented way to create a
                 rule opens it — yet it was the one surface where a screen
                 reader user got no feedback at all on a failed save, while the
                 options-page fallback announced correctly. -->
            <div class="tm-error" id="tmError" role="alert" aria-live="assertive"></div>

              <div class="tm-legend">${REQ} Required field</div>

              <!-- PROD-3: the README advertises these presets as the fast path
                   to a first rule, but they existed only on the options page,
                   which none of the documented entry points open. -->
              <div class="tm-row">
                <div class="tm-field tm-field-wide">
                  <label for="tmTemplate">Start from a template</label>
                  <select id="tmTemplate">${templateOptions}</select>
                </div>
              </div>

              <div class="tm-row">
                <div class="tm-field">
                  <label for="tmType">Rule Type</label>
                  <select id="tmType">${typeOptions}</select>
                </div>
                <div class="tm-field">
                  <label for="tmName">Rule Name${REQ}</label>
                  <input type="text" id="tmName" placeholder="e.g. User Profile API" aria-required="true">
                </div>
              </div>

              <div class="tm-row">
                <div class="tm-field" style="flex:1">
                  <label for="tmMethod">Method</label>
                  <select id="tmMethod">${methodOptions}</select>
                </div>
                <div class="tm-field" style="flex:3">
                  <label for="tmUrl">URL Pattern${REQ}</label>
                  <input type="text" id="tmUrl" placeholder="*/api/users*" aria-required="true" aria-describedby="tmUrlHint">
                  <span class="tm-hint" id="tmUrlHint">Use * for wildcards, or wrap in /.../ for regex.</span>
                </div>
              </div>

              <!-- mock -->
              <div class="tm-row" data-types="mock">
                <div class="tm-field" id="tmStatusField">
                  <label for="tmStatus">Status Code</label>
                  <input type="number" id="tmStatus" value="200" min="${L().STATUS_MIN}" max="${L().STATUS_MAX}">
                </div>
                <div class="tm-field">
                  <label for="tmDelay">Delay (ms)</label>
                  <input type="number" id="tmDelay" value="0" min="${L().DELAY_MIN}" max="${L().DELAY_MAX}">
                </div>
                <div class="tm-field">
                  <label for="tmMode">Response Mode</label>
                  <select id="tmMode">
                    <option value="static">Static</option>
                    <option value="patch">Patch (merge into real)</option>
                  </select>
                </div>
              </div>

              <!-- Match conditions apply to every rule the in-page interceptor
                   handles (mock, block, delay). They were shown for mocks
                   only, so editing a block or delay rule that carried them
                   (valid, and importable) silently dropped them on save. -->
              <div class="tm-field" data-types="mock block delay">
                <label for="tmGraphql">GraphQL Operation Name (optional)</label>
                <input type="text" id="tmGraphql" placeholder="e.g. getUsers">
              </div>

              <div class="tm-field" data-types="mock block delay">
                <label for="tmMatchHeaders">Match Request Headers (JSON, optional)</label>
                <textarea id="tmMatchHeaders" rows="2" placeholder='{"x-api-key": "abc"}'></textarea>
              </div>

              <div class="tm-field" data-types="mock">
                <label for="tmResHeaders">Response Headers (JSON)</label>
                <textarea id="tmResHeaders" rows="2">{"Content-Type": "application/json"}</textarea>
              </div>

              <div class="tm-field" data-types="mock" id="tmBodyField">
                <label for="tmBody">Response Body</label>
                <textarea id="tmBody" rows="7" placeholder='{"id": 1, "name": "Test User"}'></textarea>
              </div>

              <div class="tm-field" data-types="mock" id="tmPatchField">
                <label for="tmPatch">Response Patch (JSON Merge Patch)</label>
                <textarea id="tmPatch" rows="7" placeholder='{"data": null}' aria-describedby="tmPatchHint"></textarea>
                <span class="tm-hint" id="tmPatchHint">Merged into the real response (RFC 7386). null deletes a key.</span>
              </div>

              <!-- delay -->
              <div class="tm-field" data-types="delay">
                <label for="tmDelayMs">Delay (ms)</label>
                <input type="number" id="tmDelayMs" value="1000" min="${L().DELAY_MS_MIN}" max="${L().DELAY_MS_MAX}" aria-describedby="tmDelayMsHint">
                <span class="tm-hint" id="tmDelayMsHint">Request passes through to the network after this delay.</span>
              </div>

              <!-- redirect -->
              <div class="tm-field" data-types="redirect">
                <label for="tmRedirect">Redirect Destination${REQ}</label>
                <input type="text" id="tmRedirect" placeholder="https://localhost:3000/api" aria-required="true" aria-describedby="tmRedirectHint">
                <span class="tm-hint" id="tmRedirectHint">If URL Pattern is a /regex/, use $1-$9 for capture groups.</span>
              </div>

              <!-- headers -->
              <div class="tm-field" data-types="headers">
                <label for="tmHdrReq">Request Headers (JSON array of {op, name, value})</label>
                <textarea id="tmHdrReq" rows="3" placeholder='[{"op":"set","name":"User-Agent","value":"MyAgent/1.0"}]'></textarea>
              </div>
              <div class="tm-field" data-types="headers">
                <label for="tmHdrRes">Response Headers (JSON array of {op, name, value})</label>
                <textarea id="tmHdrRes" rows="3" placeholder='[{"op":"set","name":"Access-Control-Allow-Origin","value":"*"}]'></textarea>
              </div>

              <!-- queryparams -->
              <div class="tm-field" data-types="queryparams">
                <label for="tmQpAdd">Add Query Params (JSON array of {key, value})</label>
                <textarea id="tmQpAdd" rows="2" placeholder='[{"key":"debug","value":"1"}]'></textarea>
              </div>
              <div class="tm-field" data-types="queryparams">
                <label for="tmQpRemove">Remove Query Params (comma-separated)</label>
                <input type="text" id="tmQpRemove" placeholder="token, session_id">
              </div>

              <div class="tm-field">
                <label class="tm-check"><input type="checkbox" id="tmEnabled" checked> Rule enabled</label>
              </div>
            </div>

            <div class="tm-foot">
              <button type="button" class="tm-btn tm-btn-secondary" id="tmCancel">Cancel</button>
              <button type="button" class="tm-btn tm-btn-primary" id="tmSave">Save Rule</button>
            </div>
          </div>
        </div>`;
    }

    /**
     * Create an editor controller. One per document is the expected use.
     *
     * @param {object} [options]
     * @param {'open'|'closed'} [options.shadowMode='closed'] Closed on web
     *        pages, so the page's own scripts cannot read field values or
     *        script a click on Save (S-1). An extension page has no hostile
     *        script to defend against, so it may use 'open'.
     * @param {Element} [options.mountPoint=document.documentElement]
     * @param {function({saved: boolean, rule?: object})} [options.onClose]
     */
    function create(options = {}) {
        const shadowMode = options.shadowMode === 'open' ? 'open' : 'closed';
        const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};

        let hostEl = null;
        let shadow = null;
        let editingRule = null;
        let previousActiveElement = null; // A-5: focus to restore on close
        let bodyWasInert = false;         // A-5: the page's own inert state, to restore
        let formDirty = false;            // A11Y-7: has the user typed anything?
        // A11Y-7: a second Escape discards. PER-84: it stays armed until the
        // next non-Escape input rather than for a fixed 4 s that nobody was told about.
        let closeArmed = false;
        let closeWarningShown = false;    // PER-84: the unsaved-changes message is what's in the error box
        let unloadGuarded = false;        // PER-63: a beforeunload handler is registered

        const $ = (id) => shadow && shadow.getElementById(id);
        const send = (message) => chrome.runtime.sendMessage(message);

        // PER-86: the hint under each of these fields, so aria-describedby can
        // point at it (and keep pointing at it when an error is added, PER-77).
        const FIELD_HINTS = {
            tmUrl: 'tmUrlHint',
            tmPatch: 'tmPatchHint',
            tmDelayMs: 'tmDelayMsHint',
            tmRedirect: 'tmRedirectHint'
        };

        /**
         * PER-63: a dev-server reload used to throw away a half-written rule
         * with no warning. While the form is dirty, ask the browser to prompt
         * before the page unloads. Restoring the draft after a reload would
         * need storage that the page cannot read and this module does not own
         * (a per-tab storage.session mirror in the background); until then the
         * prompt is the safeguard. The draft is never written anywhere.
         */
        function onBeforeUnload(e) {
            if (!formDirty) return;
            e.preventDefault();
            e.returnValue = '';
        }

        function guardUnload(on) {
            if (on === unloadGuarded) return;
            unloadGuarded = on;
            if (on) window.addEventListener('beforeunload', onBeforeUnload);
            else window.removeEventListener('beforeunload', onBeforeUnload);
        }

        function markDirty() {
            formDirty = true;
            guardUnload(true);
        }

        function mountPoint() {
            return options.mountPoint || document.documentElement;
        }

        function ensureHost() {
            if (hostEl && hostEl.isConnected) return;

            hostEl = document.createElement('div');
            hostEl.id = HOST_ID;
            // S-1: in 'closed' mode `hostEl.shadowRoot` is null to the page's
            // scripts; the real reference lives only in this closure. Not
            // airtight — a page that patched attachShadow before this ran
            // could still intercept it — but that residual risk is accepted.
            shadow = hostEl.attachShadow({ mode: shadowMode });

            const style = document.createElement('style');
            style.textContent = getStyles();
            shadow.appendChild(style);

            const wrap = document.createElement('div');
            wrap.innerHTML = markup();
            shadow.appendChild(wrap);

            mountPoint().appendChild(hostEl);

            $('tmClose').addEventListener('click', () => close(false));
            $('tmCancel').addEventListener('click', () => close(false));
            // S-1 (defence in depth): also refuse any non-user-generated click.
            $('tmSave').addEventListener('click', (e) => {
                if (!e.isTrusted) return;
                save();
            });
            $('tmTemplate').addEventListener('change', (e) => {
                const id = e.target.value;
                if (id) applyTemplate(id);
                e.target.value = ''; // a template is a starting point, not a mode
            });
            $('tmType').addEventListener('change', () => applyTypeVisibility());
            $('tmMode').addEventListener('change', () => applyTypeVisibility());
            $('tmHintClose').addEventListener('click', dismissHint);

            // Close on backdrop click (but not when clicking inside the panel).
            shadow.querySelector('.tm-backdrop').addEventListener('click', (e) => {
                if (e.target.classList.contains('tm-backdrop')) requestClose();
            });

            // A11Y-7: track whether the form has been touched, so an accidental
            // dismissal can be told apart from a deliberate one.
            const panel = shadow.querySelector('.tm-panel');
            const onEdit = (e) => {
                markDirty();
                disarmClose();
                // PER-77: editing a field answers its error.
                if (e.target && e.target.id) clearFieldError(e.target.id);
            };
            panel.addEventListener('input', onEdit, true);
            panel.addEventListener('change', onEdit, true);
            // PER-84: a click inside the dialog is also "the next input". (Not
            // on the backdrop: clicking outside twice is how that discards.)
            panel.addEventListener('pointerdown', disarmClose, true);

            document.addEventListener('keydown', onKeydown, true);
        }

        /**
         * PROD-3: fill the form from a shared template definition. Only fields
         * the template specifies are written, so picking one after typing a
         * name keeps the name.
         */
        function applyTemplate(id) {
            const t = global.SpliceTapTemplates && global.SpliceTapTemplates.getTemplate(id);
            if (!t) return;

            const set = (elId, value) => {
                if (value === undefined || value === null) return;
                const el = $(elId);
                if (el) el.value = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            };

            set('tmType', t.type);
            set('tmMethod', t.method);
            set('tmUrl', t.url);
            set('tmStatus', t.status);
            set('tmMode', t.mode);
            set('tmBody', t.body);
            set('tmPatch', t.patch);
            set('tmDelayMs', t.delayMs);
            set('tmRedirect', t.redirectDestination);
            set('tmGraphql', t.graphqlOperation);
            set('tmHdrReq', t.headersModRequest);
            set('tmHdrRes', t.headersModResponse);

            applyTypeVisibility();
            markDirty();
            clearError();
        }

        /**
         * A11Y-7: accidental dismissals (Escape, backdrop click) are ignored
         * while the form has unsaved input; Cancel still closes outright, and
         * a second Escape confirms — so nobody gets stuck.
         */
        function requestClose() {
            if (!formDirty || closeArmed) {
                close(false);
                return;
            }
            closeArmed = true;
            showError('You have unsaved changes. Press Escape again, or use Cancel, to discard them.');
            closeWarningShown = true;
        }

        /**
         * PER-84: the arming used to lapse after a hidden 4 s, so a slower
         * second Escape (a screen-reader user reading the message first)
         * silently went back to the warning. It now lasts until the next
         * input that is not Escape; the message is withdrawn with it, because
         * it would no longer be true.
         */
        function disarmClose() {
            if (!closeArmed) return;
            closeArmed = false;
            if (closeWarningShown) clearError();
        }

        function getFocusableElements() {
            if (!shadow) return [];
            const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
            return Array.from(shadow.querySelectorAll(selector)).filter((el) => !el.disabled && el.offsetParent !== null);
        }

        function onKeydown(e) {
            if (!hostEl || !hostEl.isConnected) return;

            if (e.key === 'Escape') {
                e.stopPropagation();
                // PER-84: a held key must not stand in for the second press.
                if (!e.repeat) requestClose();
                return;
            }

            // PER-84: any other key (bare modifiers aside) is "the next input".
            if (!['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) disarmClose();

            // A-5: trap Tab/Shift+Tab within the dialog.
            if (e.key === 'Tab') {
                const focusable = getFocusableElements();
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                const active = shadow.activeElement;

                if (e.shiftKey) {
                    if (active === first || !shadow.contains(active)) {
                        e.preventDefault();
                        last.focus();
                    }
                } else if (active === last || !shadow.contains(active)) {
                    e.preventDefault();
                    first.focus();
                }
            }
        }

        function applyTypeVisibility() {
            const type = $('tmType').value;
            shadow.querySelectorAll('[data-types]').forEach((el) => {
                el.classList.toggle('tm-visible', el.dataset.types.split(' ').includes(type));
            });
            if (type === 'mock') {
                const patch = $('tmMode').value === 'patch';
                $('tmBodyField').classList.toggle('tm-visible', !patch);
                $('tmPatchField').classList.toggle('tm-visible', patch);
                // Patch mode keeps the real response's status, so a Status Code
                // field there was a control with no effect: set 503 and the
                // page still got the real 200. Hidden while it cannot apply.
                // (Inline style: the field's own display rule outranks [hidden].)
                $('tmStatusField').style.display = patch ? 'none' : '';
            }
        }

        function showError(msg) {
            const box = $('tmError');
            box.textContent = msg;
            box.classList.add('tm-show');
            closeWarningShown = false;
            box.scrollIntoView({ block: 'nearest' });
        }

        function clearError() {
            $('tmError').classList.remove('tm-show');
            closeWarningShown = false;
            clearFieldErrors();
        }

        // ---- per-field errors (PER-77) ------------------------------------
        // The summary box stays (it is the announced alert); each invalid field
        // also gets aria-invalid and an aria-describedby error of its own, and
        // the first one takes focus — focus used to stay on Save, so a
        // keyboard user had to hunt for what the alert was about.

        function clearFieldError(id) {
            const el = $(id);
            if (!el) return;
            el.removeAttribute('aria-invalid');
            const err = $(id + 'Err');
            if (err) err.remove();
            if (FIELD_HINTS[id]) el.setAttribute('aria-describedby', FIELD_HINTS[id]);
            else el.removeAttribute('aria-describedby');
        }

        function clearFieldErrors() {
            if (!shadow) return;
            shadow.querySelectorAll('[aria-invalid]').forEach((el) => clearFieldError(el.id));
        }

        function setFieldError(id, message) {
            const el = $(id);
            if (!el || el.offsetParent === null) return false; // hidden: the user could never reach it
            let err = $(id + 'Err');
            if (!err) {
                err = document.createElement('span');
                err.id = id + 'Err';
                err.className = 'tm-field-err';
                el.closest('.tm-field').appendChild(err);
                err.textContent = message;
            } else {
                err.textContent += ' · ' + message;
            }
            el.setAttribute('aria-invalid', 'true');
            el.setAttribute('aria-describedby', [FIELD_HINTS[id], err.id].filter(Boolean).join(' '));
            return true;
        }

        /**
         * Show a failed save: the summary, every field it can be tied to, and
         * focus on the first of those in form order.
         * @param {{message:string, fieldId:(string|null)}[]} problems
         * @param {string} [summary]
         */
        function reportProblems(problems, summary) {
            showError(summary || problems.map((p) => p.message).join(' · '));
            for (const p of problems) {
                if (p.fieldId) setFieldError(p.fieldId, p.message);
            }
            const first = shadow.querySelector('[aria-invalid="true"]');
            if (first) first.focus();
        }

        function parseJson(id, label, fallback, problems) {
            const raw = ($(id).value || '').trim();
            if (!raw) return fallback;
            try {
                return JSON.parse(raw);
            } catch (e) {
                problems.push({ fieldId: id, message: `${label}: invalid JSON — ${e.message}` });
                return fallback;
            }
        }

        /** PER-50: a whole number from a number field; see parseWholeNumber. */
        function readInteger(id, label, problems) {
            const el = $(id);
            // A number input reports unparseable text (a lone "e", "1e") as an
            // empty value; badInput tells that apart from a field left blank.
            const parsed = el.validity && el.validity.badInput
                ? { value: NaN, invalid: true }
                : parseWholeNumber(el.value);
            if (parsed.invalid) problems.push({ fieldId: id, message: `${label} must be a whole number` });
            return parsed.value;
        }

        function populate(rule, prefillUrl) {
            const r = rule || {};
            const type = r.type || 'mock';
            const match = r.match || {};

            $('tmTitle').textContent = rule ? 'Edit Rule' : 'New Rule';
            $('tmType').value = type;
            $('tmName').value = r.name || '';
            $('tmEnabled').checked = r.enabled !== false;
            // PER-55: a new rule matches any method. GET was a trap: a rule
            // for a POST (or a GraphQL operation, which needs POST or Any)
            // saved cleanly and then never fired.
            $('tmMethod').value = match.method || '*';
            $('tmUrl').value = match.url || prefillUrl || '';

            const res = r.response || {};
            $('tmStatus').value = res.statusCode || 200;
            $('tmDelay').value = res.delay || 0;
            $('tmMode').value = res.mode || 'static';
            $('tmGraphql').value = (match.graphql && match.graphql.operationName) || '';
            $('tmMatchHeaders').value = (match.headers && Object.keys(match.headers).length)
                ? JSON.stringify(match.headers, null, 2) : '';
            $('tmResHeaders').value = JSON.stringify(res.headers || { 'Content-Type': 'application/json' }, null, 2);
            $('tmBody').value = res.body === undefined
                ? ''
                : (typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2));
            $('tmPatch').value = res.patch ? JSON.stringify(res.patch, null, 2) : '';

            $('tmDelayMs').value = r.delayMs || 1000;
            $('tmRedirect').value = (r.redirect && r.redirect.destination) || '';

            const hm = r.headersMod || {};
            $('tmHdrReq').value = hm.request && hm.request.length ? JSON.stringify(hm.request, null, 2) : '';
            $('tmHdrRes').value = hm.response && hm.response.length ? JSON.stringify(hm.response, null, 2) : '';

            const qp = r.queryParams || {};
            $('tmQpAdd').value = qp.add && qp.add.length ? JSON.stringify(qp.add, null, 2) : '';
            $('tmQpRemove').value = (qp.remove || []).join(', ');

            applyTypeVisibility();
        }

        /**
         * Build the rule from the form. Anything that cannot be read at all
         * (malformed JSON, a number field that is not a whole number) is
         * collected into `problems` for the caller, with the field it
         * belongs to; everything else is judged by the shared schema in save().
         *
         * Starts from the rule being edited, so every field this form does not
         * show — provenance flags, notes, anything a future version adds — is
         * carried through untouched instead of silently dropped.
         *
         * @returns {{rule: object, problems: {message:string, fieldId:string}[]}}
         */
        function collect() {
            const problems = [];
            const type = $('tmType').value;
            const method = $('tmMethod').value;

            const rule = Object.assign({}, editingRule || {});
            for (const [ruleType, field] of Object.entries(TYPE_FIELDS)) {
                if (ruleType !== type) delete rule[field];
            }

            rule.id = (editingRule && editingRule.id) || newRuleId();
            rule.name = $('tmName').value.trim();
            rule.type = type;
            rule.enabled = $('tmEnabled').checked;
            if (!rule.created) rule.created = new Date().toISOString();
            if (rule.hitCount === undefined) rule.hitCount = 0;

            // Start from the stored match so unknown keys survive, then set
            // what this form owns.
            const match = Object.assign({}, (editingRule && editingRule.match) || {});
            match.method = method;
            match.url = $('tmUrl').value.trim();
            delete match.headers;
            delete match.graphql;

            if (CONDITION_TYPES.includes(type)) {
                const matchHeaders = parseJson('tmMatchHeaders', 'Match Request Headers', null, problems);
                if (matchHeaders && typeof matchHeaders === 'object' && Object.keys(matchHeaders).length) {
                    match.headers = matchHeaders;
                }
                const op = $('tmGraphql').value.trim();
                if (op) match.graphql = { operationName: op };
            }
            rule.match = match;

            if (type === 'mock') {
                const mode = $('tmMode').value;
                // Patch mode hides the Status Code field, so a bad value there
                // could not be fixed; it falls back to the field's default.
                const statusCode = mode === 'patch'
                    ? (parseWholeNumber($('tmStatus').value).value || 200)
                    : readInteger('tmStatus', 'Status Code', problems);
                const delay = readInteger('tmDelay', 'Delay (ms)', problems);
                const response = Object.assign({}, (editingRule && editingRule.response) || {}, {
                    statusCode,
                    // CQ-2: derived from the code, not hardcoded 'OK'.
                    statusText: (global.SpliceTapTemplates && global.SpliceTapTemplates.getStatusText(statusCode)) || '',
                    headers: parseJson('tmResHeaders', 'Response Headers', {}, problems),
                    delay: delay || 0, // blank means no delay
                    mode
                });
                if (mode === 'patch') {
                    response.patch = parseJson('tmPatch', 'Response Patch', {}, problems);
                    delete response.body;
                } else {
                    response.body = readBody($('tmBody').value);
                    delete response.patch;
                }
                rule.response = response;
            } else if (type === 'delay') {
                rule.delayMs = readInteger('tmDelayMs', 'Delay (ms)', problems);
            } else if (type === 'redirect') {
                rule.redirect = { destination: $('tmRedirect').value.trim() };
            } else if (type === 'headers') {
                rule.headersMod = {
                    request: parseJson('tmHdrReq', 'Request Headers', [], problems),
                    response: parseJson('tmHdrRes', 'Response Headers', [], problems)
                };
            } else if (type === 'queryparams') {
                rule.queryParams = {
                    add: parseJson('tmQpAdd', 'Add Query Params', [], problems),
                    remove: $('tmQpRemove').value.split(',').map((s) => s.trim()).filter(Boolean)
                };
            }

            return { rule, problems };
        }

        /**
         * Q-19: an edit whose rule was deleted elsewhere (another tab, the
         * popup) must not silently resurrect it — saveRule upserts. Fails open
         * if the check itself cannot run, rather than blocking the user on an
         * unrelated transient error.
         */
        async function ruleStillExistsUpstream(ruleId) {
            try {
                const state = await send({ type: 'getRules' });
                if (!state || !Array.isArray(state.rules)) return true;
                return state.rules.some((r) => r.id === ruleId);
            } catch (e) {
                return true;
            }
        }

        function setSaving(saving) {
            const btn = $('tmSave');
            if (!btn) return;
            btn.disabled = saving;
            btn.textContent = saving ? 'Saving…' : 'Save Rule';
        }

        async function save() {
            clearError();

            let rule;
            try {
                const collected = collect();
                rule = collected.rule;
                if (collected.problems.length) {
                    reportProblems(collected.problems);
                    return;
                }
            } catch (e) {
                showError(e.message);
                return;
            }

            // The same check the background applies at its trust boundary, run
            // here first so the person sees every problem immediately.
            const schema = global.SpliceTapRuleSchema;
            if (schema) {
                const verdict = schema.validateRule(rule);
                if (!verdict.valid) {
                    reportProblems(verdict.errors.map((message) => ({ message, fieldId: fieldForError(message, rule) })));
                    return;
                }
            }

            setSaving(true);
            try {
                if (editingRule && editingRule.id) {
                    const stillExists = await ruleStillExistsUpstream(editingRule.id);
                    if (!stillExists) {
                        showError('This rule was deleted elsewhere and no longer exists. Close this editor and create a new rule instead of saving this edit.');
                        setSaving(false);
                        return;
                    }
                }

                const response = await send({ type: 'saveRule', rule });
                if (!response || !response.success) {
                    throw new Error((response && response.error) || 'Background rejected the rule.');
                }
                // CQ-3: saved, but Chrome's network layer refused part of the
                // ruleset. Keep the editor open and say so rather than closing
                // on a false success.
                if (response.dnrWarning) {
                    showError('Rule saved, but it could not be applied to the network layer: ' + response.dnrWarning);
                    setSaving(false);
                    return;
                }
                close(true, response.rule || rule);
            } catch (e) {
                // The background judges with the same schema, so a rejection
                // names the same things; tie each to its field where it can
                // (it joins several with "; ").
                const rejected = String(e.message).split('; ')
                    .map((message) => ({ message, fieldId: fieldForError(message, rule) }));
                reportProblems(rejected, 'Failed to save: ' + e.message);
                setSaving(false);
            }
        }

        function close(saved, savedRule) {
            document.removeEventListener('keydown', onKeydown, true);
            // PER-63: nothing left to lose, so stop prompting before unload.
            formDirty = false;
            guardUnload(false);
            if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
            hostEl = null;
            shadow = null;
            editingRule = null;

            // A-5: give the page back control of its own document, and
            // restore focus to wherever it was before the editor opened.
            if (document.body && 'inert' in document.body && !bodyWasInert) {
                document.body.inert = false;
            }
            bodyWasInert = false;

            if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
                try {
                    previousActiveElement.focus({ preventScroll: true });
                } catch (e) {
                    // no longer focusable/attached; nothing to do
                }
            }
            previousActiveElement = null;

            onClose({ saved: !!saved, rule: savedRule });
        }

        function dismissHint() {
            const bar = $('tmHintBar');
            if (bar) bar.hidden = true;
            try {
                chrome.storage.local.set({ [HINT_SEEN_KEY]: true });
            } catch (e) {
                // storage unavailable; the hint will just show again next time
            }
        }

        /** U-13: a one-time tip the first time the editor ever appears. */
        function maybeShowHint() {
            const bar = $('tmHintBar');
            if (!bar) return;
            try {
                chrome.storage.local.get([HINT_SEEN_KEY], (result) => {
                    if (chrome.runtime.lastError) return;
                    if (!result || !result[HINT_SEEN_KEY]) bar.hidden = false;
                });
            } catch (e) {
                // storage unavailable; skip the hint rather than fail the editor
            }
        }

        async function applyTheme() {
            try {
                const state = await send({ type: 'getRules' });
                const theme = (state && state.settings && state.settings.theme) || 'auto';
                const resolved = theme === 'auto'
                    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
                    : theme;
                const backdrop = shadow && shadow.querySelector('.tm-backdrop');
                if (backdrop) backdrop.classList.toggle('tm-light', resolved === 'light');
            } catch (e) {
                // keep the default dark styling if settings can't be read
            }
        }

        function open(request = {}) {
            const isFreshOpen = !(hostEl && hostEl.isConnected);

            if (isFreshOpen) {
                // A-5: remember what had focus, and make the underlying page
                // non-interactive and hidden from assistive tech while the
                // dialog is up (the host is a sibling of <body>, so unaffected).
                previousActiveElement = document.activeElement;
                if (document.body && 'inert' in document.body) {
                    bodyWasInert = document.body.inert === true;
                    document.body.inert = true;
                }
            }

            ensureHost();
            editingRule = request.rule || null;
            populate(editingRule, request.prefillUrl);
            // A11Y-7: populate() fires input/change events as it fills the
            // form; reset the dirty flags afterwards, or every editor would
            // open already considering itself modified.
            formDirty = false;
            guardUnload(false);
            closeArmed = false;
            setSaving(false);
            clearError();
            applyTheme();
            maybeShowHint();

            const nameInput = $('tmName');
            if (nameInput) nameInput.focus();
        }

        return {
            open,
            close: () => close(false),
            isOpen: () => !!(hostEl && hostEl.isConnected)
        };
    }

    // fieldForError, parseWholeNumber and readBody are pure; exported so they
    // can be unit-tested without a browser.
    const api = { create, HOST_ID, fieldForError, parseWholeNumber, readBody };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    global.SpliceTapRuleEditor = api;
})(typeof window !== 'undefined' ? window : globalThis);
