/**
 * TurboMock in-page rule editor overlay.
 *
 * Runs in the ISOLATED content-script world (needs chrome.runtime to talk to
 * the background) and renders the full rule editor inside a Shadow DOM so the
 * host page's CSS can never bleed in or break it.
 *
 * Opened by a message from the popup or the context menu:
 *   { type: 'openRuleOverlay', mode: 'new' | 'edit', rule?, prefillUrl? }
 *
 * Saving goes through the background's `saveRule` handler so dnrRuleId is
 * allocated, in-memory rules refresh, tabs re-broadcast, and DNR re-syncs.
 * Top frame only (see manifest: all_frames false for this entry).
 */
(function () {
    'use strict';

    if (window.__TURBOMOCK_OVERLAY_INITIALIZED__) return;
    window.__TURBOMOCK_OVERLAY_INITIALIZED__ = true;

    const HOST_ID = 'turbomock-rule-overlay-host';

    let hostEl = null;
    let shadow = null;
    let editingRule = null;
    let previousActiveElement = null; // A-5: focus to restore on close
    let bodyWasInert = false; // A-5: host page's own inert state, if any, to restore on close
    const HINT_SEEN_KEY = 'tmOverlayHintSeen'; // U-13: one-time first-run tip

    const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', '*'];

    const RULE_TYPES = [
        ['mock', 'Mock Response'],
        ['block', 'Block'],
        ['delay', 'Delay'],
        ['redirect', 'Redirect'],
        ['headers', 'Modify Headers'],
        ['queryparams', 'Query Params']
    ];

    // The ~4 KB style string and the markup() DOM builder below are the bulk
    // of this script's cost. Neither runs at content-script load time; both
    // are deferred until the first 'openRuleOverlay' message actually
    // arrives (see ensureHost(), called only from open()) so that the
    // overwhelming majority of page loads — which never open the editor —
    // pay only the cost of registering the message listener (P-9).
    let _stylesCache = null;

    function getStyles() {
        if (_stylesCache !== null) return _stylesCache;

        _stylesCache = `
        :host {
            all: initial;
            /* all: initial resets inherited direction/color-scheme too;
               re-establish sane values so RTL pages and native form-control
               chrome aren't broken by our isolation (A-13). */
            direction: inherit;
            color-scheme: dark light;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .tm-backdrop {
            position: fixed;
            inset: 0;
            background: rgba(8, 12, 20, 0.55);
            z-index: 2147483647;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding: 48px 16px;
            overflow-y: auto;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            font-size: 1rem;
        }

        .tm-panel {
            width: 100%;
            max-width: 620px;
            background: #1a2130;
            color: #f1f5f9;
            border: 1px solid rgba(148, 163, 184, 0.16);
            border-radius: 14px;
            box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
        }

        .tm-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 16px 20px;
            border-bottom: 1px solid rgba(148, 163, 184, 0.16);
        }

        .tm-brand { display: flex; align-items: center; gap: 10px; }

        .tm-logo {
            width: 26px; height: 26px;
            border-radius: 6px;
            background: #4f6ef7;
            color: #fff;
            display: flex; align-items: center; justify-content: center;
            font-size: 0.6875rem; font-weight: 700; letter-spacing: -0.3px;
        }

        .tm-title { font-size: 0.9375rem; font-weight: 600; }

        .tm-x {
            background: transparent; border: none; cursor: pointer;
            color: #94a3b8; font-size: 1.375rem; line-height: 1;
            padding: 2px 6px; border-radius: 6px;
        }
        .tm-x:hover { background: rgba(148, 163, 184, 0.14); color: #f1f5f9; }

        .tm-hintbar {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            margin: 14px 20px 0;
            padding: 10px 12px;
            border-radius: 8px;
            font-size: 0.75rem;
            line-height: 1.4;
            background: rgba(79, 110, 247, 0.14);
            color: #dbe4ff;
            border: 1px solid rgba(79, 110, 247, 0.28);
        }
        .tm-hintbar[hidden] { display: none; }
        .tm-hintbar-text { flex: 1; }
        .tm-hintbar-x {
            background: transparent; border: none; cursor: pointer;
            color: inherit; font-size: 1rem; line-height: 1;
            padding: 0 2px; flex-shrink: 0;
        }
        .tm-light .tm-hintbar {
            background: rgba(79, 110, 247, 0.08);
            color: #2c3e6b;
            border-color: rgba(79, 110, 247, 0.22);
        }

        .tm-body { padding: 18px 20px; max-height: 65vh; overflow-y: auto; }

        .tm-row { display: flex; gap: 12px; }
        .tm-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; flex: 1; min-width: 0; }
        .tm-field > label { font-size: 0.78125rem; font-weight: 600; color: #f1f5f9; }

        .tm-field input[type="text"],
        .tm-field input[type="number"],
        .tm-field select,
        .tm-field textarea {
            width: 100%;
            background: #0b0f19;
            border: 1px solid rgba(148, 163, 184, 0.16);
            color: #f1f5f9;
            border-radius: 6px;
            padding: 9px 11px;
            font-size: 0.8125rem;
            font-family: inherit;
            outline: none;
        }

        .tm-field textarea {
            font-family: ui-monospace, 'SF Mono', Consolas, Menlo, monospace;
            font-size: 0.78125rem;
            line-height: 1.5;
            resize: vertical;
        }

        .tm-field input:focus, .tm-field select:focus, .tm-field textarea:focus {
            border-color: #4f6ef7;
            box-shadow: 0 0 0 3px rgba(79, 110, 247, 0.18);
        }

        .tm-hint { font-size: 0.71875rem; color: #94a3b8; line-height: 1.4; }

        .tm-check { display: flex; align-items: center; gap: 8px; font-size: 0.8125rem; color: #f1f5f9; }
        .tm-check input { width: 15px; height: 15px; accent-color: #4f6ef7; }

        .tm-foot {
            display: flex; justify-content: flex-end; gap: 10px;
            padding: 14px 20px;
            border-top: 1px solid rgba(148, 163, 184, 0.16);
        }

        .tm-btn {
            border-radius: 8px; padding: 9px 18px; font-size: 0.8125rem;
            font-weight: 600; cursor: pointer; font-family: inherit;
            border: 1px solid transparent;
        }
        .tm-btn-primary { background: #4f6ef7; color: #fff; }
        .tm-btn-primary:hover { background: #3f5de6; }
        .tm-btn-secondary { background: #232c3d; color: #f1f5f9; border-color: rgba(148, 163, 184, 0.16); }
        .tm-btn-secondary:hover { background: #2b3547; }

        .tm-error {
            display: none;
            margin-bottom: 14px;
            padding: 10px 14px;
            border-radius: 8px;
            font-size: 0.78125rem;
            background: rgba(239, 68, 68, 0.12);
            color: #f87171;
            border: 1px solid rgba(239, 68, 68, 0.28);
            white-space: pre-line;
        }
        .tm-error.tm-show { display: block; }

        [data-types] { display: none; }
        [data-types].tm-visible { display: block; }
        .tm-row[data-types].tm-visible { display: flex; }

        /* Light theme (mirrors the extension's theme setting) */
        .tm-light { color-scheme: light; }
        .tm-light .tm-panel { background: #ffffff; color: #16202e; border-color: rgba(15, 23, 42, 0.12); }
        .tm-light .tm-head, .tm-light .tm-foot { border-color: rgba(15, 23, 42, 0.12); }
        .tm-light .tm-title, .tm-light .tm-field > label, .tm-light .tm-check { color: #16202e; }
        .tm-light .tm-field input, .tm-light .tm-field select, .tm-light .tm-field textarea {
            background: #ffffff; color: #16202e; border-color: rgba(15, 23, 42, 0.16);
        }
        .tm-light .tm-hint, .tm-light .tm-x { color: #5b6b7f; }
        .tm-light .tm-btn-secondary { background: #eceff4; color: #16202e; border-color: rgba(15, 23, 42, 0.12); }
        .tm-light .tm-btn-secondary:hover { background: #e2e8f0; }
    `;

        return _stylesCache;
    }

    function markup() {
        const typeOptions = RULE_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
        const methodOptions = METHODS.map(m => `<option value="${m}">${m === '*' ? 'Any (*)' : m}</option>`).join('');

        return `
        <div class="tm-backdrop" part="backdrop">
          <div class="tm-panel" role="dialog" aria-modal="true" aria-labelledby="tmTitle">
            <div class="tm-head">
              <div class="tm-brand">
                <div class="tm-logo">TM</div>
                <h2 class="tm-title" id="tmTitle">New Rule</h2>
              </div>
              <button class="tm-x" id="tmClose" title="Close">&times;</button>
            </div>

            <div class="tm-hintbar" id="tmHintBar" hidden>
              <span class="tm-hintbar-text">TurboMock opens this editor over your current page. Press Esc or click outside to close it.</span>
              <button type="button" class="tm-hintbar-x" id="tmHintClose" aria-label="Dismiss tip">&times;</button>
            </div>

            <div class="tm-body">
              <div class="tm-error" id="tmError"></div>

              <div class="tm-row">
                <div class="tm-field">
                  <label for="tmType">Rule Type</label>
                  <select id="tmType">${typeOptions}</select>
                </div>
                <div class="tm-field">
                  <label for="tmName">Rule Name</label>
                  <input type="text" id="tmName" placeholder="e.g. User Profile API">
                </div>
              </div>

              <div class="tm-row">
                <div class="tm-field" style="flex:1">
                  <label for="tmMethod">Method</label>
                  <select id="tmMethod">${methodOptions}</select>
                </div>
                <div class="tm-field" style="flex:3">
                  <label for="tmUrl">URL Pattern</label>
                  <input type="text" id="tmUrl" placeholder="*/api/users/*">
                  <span class="tm-hint">Use * for wildcards, or wrap in /.../ for regex.</span>
                </div>
              </div>

              <!-- mock -->
              <div class="tm-row" data-types="mock">
                <div class="tm-field">
                  <label for="tmStatus">Status Code</label>
                  <input type="number" id="tmStatus" value="200">
                </div>
                <div class="tm-field">
                  <label for="tmDelay">Delay (ms)</label>
                  <input type="number" id="tmDelay" value="0" min="0">
                </div>
                <div class="tm-field">
                  <label for="tmMode">Response Mode</label>
                  <select id="tmMode">
                    <option value="static">Static</option>
                    <option value="patch">Patch (merge into real)</option>
                  </select>
                </div>
              </div>

              <div class="tm-field" data-types="mock">
                <label for="tmGraphql">GraphQL Operation Name (optional)</label>
                <input type="text" id="tmGraphql" placeholder="e.g. getUsers">
              </div>

              <div class="tm-field" data-types="mock">
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
                <textarea id="tmPatch" rows="7" placeholder='{"data": null}'></textarea>
                <span class="tm-hint">Merged into the real response (RFC 7386). null deletes a key.</span>
              </div>

              <!-- delay -->
              <div class="tm-field" data-types="delay">
                <label for="tmDelayMs">Delay (ms)</label>
                <input type="number" id="tmDelayMs" value="1000" min="1" max="30000">
                <span class="tm-hint">Request passes through to the network after this delay.</span>
              </div>

              <!-- redirect -->
              <div class="tm-field" data-types="redirect">
                <label for="tmRedirect">Redirect Destination</label>
                <input type="text" id="tmRedirect" placeholder="https://localhost:3000/api">
                <span class="tm-hint">If URL Pattern is a /regex/, use $1-$9 for capture groups.</span>
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
              <button class="tm-btn tm-btn-secondary" id="tmCancel">Cancel</button>
              <button class="tm-btn tm-btn-primary" id="tmSave">Save Rule</button>
            </div>
          </div>
        </div>`;
    }

    function $(id) {
        return shadow.getElementById(id);
    }

    function ensureHost() {
        if (hostEl && document.documentElement.contains(hostEl)) return;

        hostEl = document.createElement('div');
        hostEl.id = HOST_ID;
        // S-1: 'closed' mode keeps `hostEl.shadowRoot` returning null to the
        // host page's own scripts (a page-level MutationObserver can still
        // spot the host element, but it can no longer read field values or
        // script a click on Save). We keep the real reference in the
        // `shadow` closure variable so our own code is unaffected. This is
        // not airtight — a page that pre-patches Element.prototype.attachShadow
        // before this content script runs could still intercept the call —
        // but that's a known, accepted residual risk.
        shadow = hostEl.attachShadow({ mode: 'closed' });

        const style = document.createElement('style');
        style.textContent = getStyles();
        shadow.appendChild(style);

        const wrap = document.createElement('div');
        wrap.innerHTML = markup();
        shadow.appendChild(wrap);

        document.documentElement.appendChild(hostEl);

        $('tmClose').addEventListener('click', close);
        $('tmCancel').addEventListener('click', close);
        // S-1 (defense in depth): closed mode already keeps the page from
        // getting a reference to click this button itself, but also refuse
        // any non-user-generated click event outright.
        $('tmSave').addEventListener('click', (e) => {
            if (!e.isTrusted) return;
            save();
        });
        $('tmType').addEventListener('change', () => applyTypeVisibility());
        $('tmMode').addEventListener('change', () => applyTypeVisibility());
        $('tmHintClose').addEventListener('click', dismissHint);

        // Close on backdrop click (but not when clicking inside the panel).
        shadow.querySelector('.tm-backdrop').addEventListener('click', (e) => {
            if (e.target.classList.contains('tm-backdrop')) close();
        });

        document.addEventListener('keydown', onKeydown, true);
    }

    function getFocusableElements() {
        if (!shadow) return [];
        const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
        return Array.from(shadow.querySelectorAll(selector)).filter((el) => {
            return !el.disabled && el.offsetParent !== null;
        });
    }

    function onKeydown(e) {
        if (!hostEl || !hostEl.isConnected) return;

        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
            return;
        }

        // A-5: trap Tab/Shift+Tab within the dialog so focus can't leak into
        // the underlying host page.
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
            const applies = el.dataset.types.split(' ').includes(type);
            el.classList.toggle('tm-visible', applies);
        });

        if (type === 'mock') {
            const patch = $('tmMode').value === 'patch';
            $('tmBodyField').classList.toggle('tm-visible', !patch);
            $('tmPatchField').classList.toggle('tm-visible', patch);
        }
    }

    function showError(msg) {
        const box = $('tmError');
        box.textContent = msg;
        box.classList.add('tm-show');
        box.scrollIntoView({ block: 'nearest' });
    }

    function clearError() {
        $('tmError').classList.remove('tm-show');
    }

    function parseJson(value, label, fallback) {
        const raw = (value || '').trim();
        if (!raw) return fallback;
        try {
            return JSON.parse(raw);
        } catch (e) {
            throw new Error(`${label}: invalid JSON — ${e.message}`);
        }
    }

    function populate(rule, prefillUrl) {
        const r = rule || {};
        const type = r.type || 'mock';

        $('tmTitle').textContent = rule ? 'Edit Rule' : 'New Rule';
        $('tmType').value = type;
        $('tmName').value = r.name || '';
        $('tmEnabled').checked = r.enabled !== false;
        $('tmMethod').value = (r.match && r.match.method) || 'GET';
        $('tmUrl').value = (r.match && r.match.url) || prefillUrl || '';

        const res = r.response || {};
        $('tmStatus').value = res.statusCode || 200;
        $('tmDelay').value = res.delay || 0;
        $('tmMode').value = res.mode || 'static';
        $('tmGraphql').value = (r.match && r.match.graphql && r.match.graphql.operationName) || '';
        $('tmMatchHeaders').value = (r.match && r.match.headers && Object.keys(r.match.headers).length)
            ? JSON.stringify(r.match.headers, null, 2) : '';
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
     * Build a v2 rule (TODO.md §1.1) from the form. Throws on validation
     * failure with a user-facing message.
     */
    function collect() {
        const type = $('tmType').value;
        const name = $('tmName').value.trim();
        const url = $('tmUrl').value.trim();
        const method = $('tmMethod').value;

        if (!name) throw new Error('Rule name is required.');
        if (!url) throw new Error('URL pattern is required.');

        const rule = {
            id: (editingRule && editingRule.id) || `rule_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            name,
            type,
            enabled: $('tmEnabled').checked,
            match: { method, url },
            created: (editingRule && editingRule.created) || new Date().toISOString(),
            testStatus: (editingRule && editingRule.testStatus) || 'pending',
            hitCount: (editingRule && editingRule.hitCount) || 0
        };

        if (editingRule && editingRule.dnrRuleId) {
            rule.dnrRuleId = editingRule.dnrRuleId;
        }

        // DNR-backed types can't express header/GraphQL match conditions (§1.7).
        const dnrBacked = type === 'headers' || type === 'queryparams';

        if (type === 'mock') {
            const matchHeaders = parseJson($('tmMatchHeaders').value, 'Match Request Headers', null);
            if (matchHeaders && Object.keys(matchHeaders).length) rule.match.headers = matchHeaders;

            const op = $('tmGraphql').value.trim();
            if (op) {
                if (method !== 'POST' && method !== '*') {
                    throw new Error('GraphQL operation matching requires method POST or Any (*).');
                }
                rule.match.graphql = { operationName: op };
            }

            const mode = $('tmMode').value;
            const statusCode = parseInt($('tmStatus').value, 10);
            if (isNaN(statusCode) || statusCode < 100 || statusCode > 599) {
                throw new Error('Status code must be between 100 and 599.');
            }
            const delay = parseInt($('tmDelay').value, 10) || 0;
            if (delay < 0 || delay > 30000) throw new Error('Delay must be between 0 and 30000 ms.');

            rule.response = {
                statusCode,
                statusText: 'OK',
                headers: parseJson($('tmResHeaders').value, 'Response Headers', {}),
                delay,
                mode
            };

            if (mode === 'patch') {
                const patch = parseJson($('tmPatch').value, 'Response Patch', null);
                if (!patch) throw new Error('Patch mode requires a JSON merge patch body.');
                rule.response.patch = patch;
            } else {
                const raw = $('tmBody').value.trim();
                try {
                    rule.response.body = raw ? JSON.parse(raw) : {};
                } catch (e) {
                    rule.response.body = raw; // plain-text body is allowed
                }
            }
        } else if (type === 'delay') {
            const ms = parseInt($('tmDelayMs').value, 10);
            if (isNaN(ms) || ms < 1 || ms > 30000) throw new Error('Delay must be between 1 and 30000 ms.');
            rule.delayMs = ms;
        } else if (type === 'redirect') {
            const dest = $('tmRedirect').value.trim();
            if (!dest) throw new Error('Redirect destination is required.');
            rule.redirect = { destination: dest };
        } else if (type === 'headers') {
            const req = parseJson($('tmHdrReq').value, 'Request Headers', []);
            const res = parseJson($('tmHdrRes').value, 'Response Headers', []);
            if (!req.length && !res.length) {
                throw new Error('Add at least one request or response header operation.');
            }
            rule.headersMod = { request: req, response: res };
        } else if (type === 'queryparams') {
            const add = parseJson($('tmQpAdd').value, 'Add Query Params', []);
            const remove = $('tmQpRemove').value.split(',').map(s => s.trim()).filter(Boolean);
            if (!add.length && !remove.length) {
                throw new Error('Add or remove at least one query parameter.');
            }
            rule.queryParams = { add, remove };
        }

        if (dnrBacked && (rule.match.headers || rule.match.graphql)) {
            throw new Error('Header/GraphQL match conditions are not supported for this rule type.');
        }

        return rule;
    }

    /**
     * Q-19: an edit whose underlying rule was deleted elsewhere (another tab,
     * the popup, the options page) must not silently resurrect it — saveRule
     * is an unconditional upsert on the background side, so a stale `id` gets
     * re-created as if it had never been removed. We can't change the
     * saveRule message contract (background.js is owned elsewhere), so we
     * do a best-effort existence check with the existing `getRules` message
     * immediately before saving. If the check itself fails (e.g. the
     * background is momentarily unreachable) we fail open and let the save
     * proceed rather than blocking the user on an unrelated transient error.
     */
    async function ruleStillExistsUpstream(ruleId) {
        try {
            const state = await chrome.runtime.sendMessage({ type: 'getRules' });
            if (!state || !Array.isArray(state.rules)) return true;
            return state.rules.some((r) => r.id === ruleId);
        } catch (e) {
            return true;
        }
    }

    async function save() {
        clearError();

        let rule;
        try {
            rule = collect();
        } catch (e) {
            showError(e.message);
            return;
        }

        const btn = $('tmSave');
        btn.disabled = true;
        btn.textContent = 'Saving…';

        try {
            if (editingRule && editingRule.id) {
                const stillExists = await ruleStillExistsUpstream(editingRule.id);
                if (!stillExists) {
                    showError('This rule was deleted elsewhere and no longer exists. Close this editor and create a new rule instead of saving this edit.');
                    btn.disabled = false;
                    btn.textContent = 'Save Rule';
                    return;
                }
            }

            const response = await chrome.runtime.sendMessage({ type: 'saveRule', rule });
            if (!response || !response.success) {
                throw new Error((response && response.error) || 'Background rejected the rule.');
            }
            close();
        } catch (e) {
            showError('Failed to save: ' + e.message);
            btn.disabled = false;
            btn.textContent = 'Save Rule';
        }
    }

    function close() {
        document.removeEventListener('keydown', onKeydown, true);
        if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
        hostEl = null;
        shadow = null;
        editingRule = null;

        // A-5: give the host page back control of its own document, and
        // restore focus to wherever it was before the overlay opened.
        if (document.body && 'inert' in document.body && !bodyWasInert) {
            document.body.inert = false;
        }
        bodyWasInert = false;

        if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
            try {
                previousActiveElement.focus({ preventScroll: true });
            } catch (e) {
                // Element may no longer be focusable/attached; nothing to do.
            }
        }
        previousActiveElement = null;
    }

    function dismissHint() {
        const bar = shadow && $('tmHintBar');
        if (bar) bar.hidden = true;
        try {
            chrome.storage.local.set({ [HINT_SEEN_KEY]: true });
        } catch (e) {
            // storage unavailable; the hint will just show again next time.
        }
    }

    /** U-13: show a lightweight, dismissible, one-time tip the first time
     *  the overlay ever appears in this browser profile, so users understand
     *  it's an in-page editor over their current tab. */
    function maybeShowHint() {
        const bar = $('tmHintBar');
        if (!bar) return;
        try {
            chrome.storage.local.get([HINT_SEEN_KEY], (result) => {
                if (chrome.runtime.lastError) return;
                if (!result || !result[HINT_SEEN_KEY]) {
                    bar.hidden = false;
                }
            });
        } catch (e) {
            // storage unavailable; skip the hint rather than fail the overlay.
        }
    }

    async function applyTheme() {
        try {
            const state = await chrome.runtime.sendMessage({ type: 'getRules' });
            const theme = (state && state.settings && state.settings.theme) || 'auto';
            const resolved = theme === 'auto'
                ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
                : theme;
            shadow.querySelector('.tm-backdrop').classList.toggle('tm-light', resolved === 'light');
        } catch (e) {
            // Keep the default dark styling if settings can't be read.
        }
    }

    function open(message) {
        const isFreshOpen = !(hostEl && document.documentElement.contains(hostEl));

        if (isFreshOpen) {
            // A-5: remember what had focus so we can put it back on close,
            // and make the underlying page non-interactive/non-readable by
            // assistive tech while the dialog is up (our host element is a
            // sibling of <body> under <html>, so this doesn't affect it).
            previousActiveElement = document.activeElement;
            if (document.body && 'inert' in document.body) {
                bodyWasInert = document.body.inert === true;
                document.body.inert = true;
            }
        }

        ensureHost();
        editingRule = message.rule || null;
        populate(editingRule, message.prefillUrl);
        applyTheme();
        maybeShowHint();

        const nameInput = $('tmName');
        if (nameInput) nameInput.focus();
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request && request.type === 'openRuleOverlay') {
            try {
                open(request);
                sendResponse({ success: true });
            } catch (e) {
                console.error('TurboMock: failed to open rule overlay', e);
                sendResponse({ success: false, error: e.message });
            }
            return true;
        }
        return false;
    });
})();
