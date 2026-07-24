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

    const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', '*'];

    const RULE_TYPES = [
        ['mock', 'Mock Response'],
        ['block', 'Block'],
        ['delay', 'Delay'],
        ['redirect', 'Redirect'],
        ['headers', 'Modify Headers'],
        ['queryparams', 'Query Params']
    ];

    const STYLES = `
        :host { all: initial; }
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
            font-size: 11px; font-weight: 700; letter-spacing: -0.3px;
        }

        .tm-title { font-size: 15px; font-weight: 600; }

        .tm-x {
            background: transparent; border: none; cursor: pointer;
            color: #94a3b8; font-size: 22px; line-height: 1;
            padding: 2px 6px; border-radius: 6px;
        }
        .tm-x:hover { background: rgba(148, 163, 184, 0.14); color: #f1f5f9; }

        .tm-body { padding: 18px 20px; max-height: 65vh; overflow-y: auto; }

        .tm-row { display: flex; gap: 12px; }
        .tm-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; flex: 1; min-width: 0; }
        .tm-field > label { font-size: 12.5px; font-weight: 600; color: #f1f5f9; }

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
            font-size: 13px;
            font-family: inherit;
            outline: none;
        }

        .tm-field textarea {
            font-family: ui-monospace, 'SF Mono', Consolas, Menlo, monospace;
            font-size: 12.5px;
            line-height: 1.5;
            resize: vertical;
        }

        .tm-field input:focus, .tm-field select:focus, .tm-field textarea:focus {
            border-color: #4f6ef7;
            box-shadow: 0 0 0 3px rgba(79, 110, 247, 0.18);
        }

        .tm-hint { font-size: 11.5px; color: #94a3b8; line-height: 1.4; }

        .tm-check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #f1f5f9; }
        .tm-check input { width: 15px; height: 15px; accent-color: #4f6ef7; }

        .tm-foot {
            display: flex; justify-content: flex-end; gap: 10px;
            padding: 14px 20px;
            border-top: 1px solid rgba(148, 163, 184, 0.16);
        }

        .tm-btn {
            border-radius: 8px; padding: 9px 18px; font-size: 13px;
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
            font-size: 12.5px;
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

    function markup() {
        const typeOptions = RULE_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
        const methodOptions = METHODS.map(m => `<option value="${m}">${m === '*' ? 'Any (*)' : m}</option>`).join('');

        return `
        <div class="tm-backdrop" part="backdrop">
          <div class="tm-panel" role="dialog" aria-modal="true" aria-label="TurboMock rule editor">
            <div class="tm-head">
              <div class="tm-brand">
                <div class="tm-logo">TM</div>
                <div class="tm-title" id="tmTitle">New Rule</div>
              </div>
              <button class="tm-x" id="tmClose" title="Close">&times;</button>
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
        shadow = hostEl.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = STYLES;
        shadow.appendChild(style);

        const wrap = document.createElement('div');
        wrap.innerHTML = markup();
        shadow.appendChild(wrap);

        document.documentElement.appendChild(hostEl);

        $('tmClose').addEventListener('click', close);
        $('tmCancel').addEventListener('click', close);
        $('tmSave').addEventListener('click', save);
        $('tmType').addEventListener('change', () => applyTypeVisibility());
        $('tmMode').addEventListener('change', () => applyTypeVisibility());

        // Close on backdrop click (but not when clicking inside the panel).
        shadow.querySelector('.tm-backdrop').addEventListener('click', (e) => {
            if (e.target.classList.contains('tm-backdrop')) close();
        });

        document.addEventListener('keydown', onKeydown, true);
    }

    function onKeydown(e) {
        if (e.key === 'Escape' && hostEl && hostEl.isConnected) {
            e.stopPropagation();
            close();
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
        ensureHost();
        editingRule = message.rule || null;
        populate(editingRule, message.prefillUrl);
        applyTheme();

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
