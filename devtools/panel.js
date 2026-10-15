/**
 * SpliceTap DevTools Panel
 *
 * Plain script (no import/export) — MV3 devtools panel pages load scripts
 * via a plain <script src> tag, not modules, and the default extension-page
 * CSP forbids inline scripts, hence this separate file.
 *
 * Mocked/blocked/delayed/redirected requests never touch the real network
 * stack, so chrome.devtools.network can never see them. This
 * panel instead polls the background service worker's in-memory
 * interception log (populated by content/injected.js -> content/content.js
 * -> service_worker/background.js) via chrome.runtime.sendMessage and
 * renders whatever comes back.
 */
(function () {
    'use strict';

    // Slightly less aggressive than the original 2s (P-12) — the bigger win
    // is pausing entirely below, this is just a modest extra cut to the
    // steady-state cost while the panel is visible and running.
    const POLL_INTERVAL_MS = 3000;

    // Method -> existing CSS class in panel.html. Methods without a
    // dedicated class (PATCH, HEAD, OPTIONS, ...) fall back to the base
    // .request-method styling (no extra class).
    const METHOD_CLASSES = {
        GET: 'method-get',
        POST: 'method-post',
        PUT: 'method-put',
        DELETE: 'method-delete'
    };

    let entries = [];
    let entryByKey = new Map();
    let ruleStats = { intercepted: 0, activeRules: 0 };
    let lastSettings = { theme: 'auto' };
    let pollTimer = null;

    // Manual pause (WCAG 2.2.2 — user-facing control) and visibility-driven
    // pause (P-12 — stop polling, and stop resetting the SW idle timer,
    // whenever nobody can actually see the panel) are independent switches;
    // polling only runs when neither is set.
    let userPaused = false;
    let panelHidden = typeof document !== 'undefined' ? !!document.hidden : false;

    // Diff-rendering state (P-12 / A-10): rows are only created once per
    // logical entry and reused across polls, keyed by a stable identity
    // derived from the entry's own fields (the log has no server-issued id).
    // `lastKeySignature` lets a poll tick that changed nothing skip DOM
    // structure work entirely.
    let rowElements = new Map(); // key -> row element
    let lastKeySignature = '';
    let hasFetchedOnce = false;

    // Per-entry client-side affordances (U-9 / S-8): which rows the user has
    // dismissed from view, and which rows have had their full (query-string
    // included) URL explicitly revealed. Both are pruned to entries still
    // present in the buffer so they can't grow unbounded across a long
    // session.
    let dismissedKeys = new Set();
    let revealedKeys = new Set();
    // Every key ever seen this session, used only to detect genuinely new
    // entries for the aria-live announcer (independent of any active
    // filter/dismiss state).
    let knownKeys = new Set();

    let filterState = { text: '', type: 'all' };

    // PER-57: captured responses (for "View response"), the rules this panel
    // has switched off (so their button reads "Enable rule"), and which rows
    // have their response open. Captures are fetched when new rows arrive, not
    // on every poll: they can be large.
    let captures = [];
    let capturesKeySignature = null;
    let disabledRuleIds = new Set();
    let openResponseKeys = new Set();
    let toolSeq = 0;

    // Gives each row's note a unique id for the URL button's aria-describedby.
    let noteSeq = 0;

    function byId(id) {
        return document.getElementById(id);
    }

    // S-6: the textContent->innerHTML idiom does not escape quotes, which
    // matters wherever the result lands inside an HTML attribute. Row
    // rendering below has moved entirely to DOM APIs (createElement /
    // textContent / setAttribute), which side-steps this class of bug by
    // construction, but this helper is kept — correctly, this time — for the
    // remaining innerHTML sink (the error banner) and for anyone reusing it.
    // CQ-6: shared implementation — see src/common.js.
    function escapeHtml(value) {
        return window.SpliceTapCommon.escapeHtml(value);
    }

    // A stable-ish identity for a log entry. The background's ring buffer
    // entries have no server-issued id, so this is a best-effort composite
    // key; collisions would require the same rule to fire for the same URL
    // in the same millisecond, which is harmless here (worst case, two
    // entries briefly share one row) and not worth a schema change to a file
    // this group doesn't own.
    function entryKey(entry) {
        return (entry.ruleId || '') + '|' + (entry.ts || '') + '|' + (entry.url || '');
    }

    // S-8: strip the query string (and hash) so the default, always-visible
    // text/tooltip never leaks tokens/params that might be sitting in a URL.
    function stripQueryAndHash(url) {
        if (!url) return '';
        const idx = url.search(/[?#]/);
        return idx === -1 ? url : url.substring(0, idx);
    }

    function truncateUrl(url, max) {
        const limit = max || 80;
        if (!url) return '';
        return url.length > limit ? url.substring(0, limit - 3) + '...' : url;
    }

    function methodClass(method) {
        const key = (method || '').toUpperCase();
        return METHOD_CLASSES[key] || '';
    }

    // PER-54: chaos failures belong to no rule; they are told apart by `kind`
    // (their ruleType may be anything), and filtered and badged as "chaos".
    function entryType(entry) {
        return entry.kind === 'chaos' ? 'chaos' : (entry.ruleType || 'mock');
    }

    // F3: the badge says what a person would say; every other type reads as
    // its own key ("mock", "headers"). Display only — filtering and the badge's
    // data-type use the key.
    const TYPE_LABELS = { requestBody: 'Request body' };

    function typeLabel(type) {
        return Object.prototype.hasOwnProperty.call(TYPE_LABELS, type) ? TYPE_LABELS[type] : type;
    }

    // F2: header, query-param and all-request rules are applied by Chrome, not
    // by SpliceTap, so their entries come from the network observer with a note
    // that says so (not from the interceptor, which would set a status).
    function isObserved(entry) {
        return typeof entry.note === 'string' && entry.note.indexOf('Seen on the network') === 0;
    }

    // Maps a status to a CSS class + label. A status is: 0 for block, null for
    // a delay that had not settled when it was logged, 302 for a redirect
    // (synthetic: no response was ever a 302), 'failed' for a request that
    // errored, or a real/mock HTTP status code otherwise.
    function statusInfo(status) {
        if (status === null || status === undefined) {
            return { cls: 'status-pending', text: 'pending' };
        }
        if (status === 'failed') {
            return { cls: 'status-error', text: 'failed' };
        }
        if (status === 0) {
            return { cls: 'status-error', text: 'blocked' };
        }
        if (status >= 200 && status < 300) {
            return { cls: 'status-success', text: String(status) };
        }
        return { cls: 'status-error', text: String(status) };
    }

    function isCount(value) {
        return typeof value === 'number' && isFinite(value) && value >= 0;
    }

    // PER-56: the status the page finally received. `finalStatus` arrives once
    // a delay or redirect settles; before that (and for rules that answer at
    // once) it is the status logged with the entry. A redirect's logged 302 is
    // a marker for "redirected", not a response, so without a finalStatus a
    // redirect has no final status yet. Returns a number, 'failed' or null.
    function finalStatusOf(entry) {
        if (entry.finalStatus !== undefined) return entry.finalStatus;
        if (entryType(entry) === 'redirect') return null;
        return entry.status === undefined ? null : entry.status;
    }

    // PER-54 / PER-56: what the Status cell says about an entry, and in which
    // class. `detail` marks the longer wordings, which wrap instead of sitting
    // in a fixed-width pill.
    //   redirect  neutral, "→ 200 via https://dest/" (a redirect is not an error)
    //   delay     "200 after 1500 ms", and never "pending" once finalStatus exists
    //   chaos     "failed (chaos)"
    function outcomeInfo(entry) {
        const type = entryType(entry);
        if (type === 'chaos') {
            return { cls: 'status-error', text: 'failed (chaos)', detail: true };
        }
        if (type === 'redirect') {
            const via = entry.redirectedTo ? ' via ' + truncateUrl(entry.redirectedTo, 160) : '';
            const shown = entry.finalStatus === undefined ? 'redirected' : String(entry.finalStatus);
            return { cls: 'status-neutral', text: '→ ' + shown + via, detail: true };
        }
        const settled = entry.finalStatus !== undefined ? entry.finalStatus : entry.status;
        const unsettled = settled === undefined || settled === null;
        // F2: an observed entry that carries no status (a request-side rule,
        // seen before any response) is not "pending" — nothing is waiting.
        if (unsettled && isObserved(entry)) {
            return type === 'block'
                ? { cls: 'status-error', text: 'blocked', detail: false }
                : { cls: 'status-neutral', text: 'applied', detail: false };
        }
        // F3: a request-body rule changes what is sent; the response is
        // whatever the server then says, so with no status it is "modified",
        // not a request that never settled.
        if (unsettled && type === 'requestBody') {
            return { cls: 'status-neutral', text: 'modified', detail: false };
        }
        const shown = statusInfo(settled);
        if (type === 'delay' && entry.finalStatus !== undefined && isCount(entry.elapsedMs)) {
            return { cls: shown.cls, text: shown.text + ' after ' + entry.elapsedMs + ' ms', detail: true };
        }
        return { cls: shown.cls, text: shown.text, detail: false };
    }

    function formatRelativeTime(ts) {
        if (!ts) return '';
        const diffSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
        if (diffSec < 5) return 'just now';
        if (diffSec < 60) return diffSec + 's ago';
        const diffMin = Math.round(diffSec / 60);
        if (diffMin < 60) return diffMin + 'm ago';
        const diffHr = Math.round(diffMin / 60);
        if (diffHr < 24) return diffHr + 'h ago';
        const diffDay = Math.round(diffHr / 24);
        return diffDay + 'd ago';
    }

    function sendMessage(message) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('SpliceTap panel: sendMessage failed for', message.type, chrome.runtime.lastError.message);
                        resolve(null);
                        return;
                    }
                    resolve(response);
                });
            } catch (error) {
                console.error('SpliceTap panel: sendMessage threw for', message.type, error);
                resolve(null);
            }
        });
    }

    function pruneKeySets() {
        const valid = entryByKey; // Map keyed the same way
        [dismissedKeys, revealedKeys, knownKeys, openResponseKeys].forEach((set) => {
            Array.from(set).forEach((key) => {
                if (!valid.has(key)) set.delete(key);
            });
        });
    }

    async function fetchInterceptionLog() {
        // QA-3: scope the log to the tab this panel is inspecting. Without
        // this the panel showed traffic intercepted in every other tab too.
        const response = await sendMessage({ type: 'getInterceptionLog', tabId: inspectedTabId() });
        if (response && response.success) {
            clearError();
            // Background stores entries oldest-first (ring buffer push order);
            // show newest first.
            const nextEntries = (response.entries || []).slice().reverse();
            const nextKeys = nextEntries.map(entryKey);

            // Figure out which entries are genuinely new (never seen this
            // session) before overwriting state, so the live region (A-10)
            // announces arrivals rather than restating the whole log.
            const newlyLogged = [];
            if (hasFetchedOnce) {
                nextEntries.forEach((entry, i) => {
                    if (!knownKeys.has(nextKeys[i])) newlyLogged.push(entry);
                });
            }

            entries = nextEntries;
            entryByKey = new Map(nextEntries.map((e, i) => [nextKeys[i], e]));
            nextKeys.forEach((k) => knownKeys.add(k));
            pruneKeySets();
            hasFetchedOnce = true;

            if (newlyLogged.length > 0) {
                announceNewEntries(newlyLogged);
            }
        } else if (response === null) {
            showError('Could not reach the SpliceTap background service worker.');
        }
        renderEntries();
        updateBufferStats();
        refreshCapturesIfNeeded();
    }

    // PER-57: a capture is only offered for a row that exists, so look again
    // when the set of rows changes (and the first time), not every 3 s.
    function refreshCapturesIfNeeded(force) {
        const signature = entries.map(entryKey).join('\n');
        if (!force && signature === capturesKeySignature) return;
        capturesKeySignature = signature;
        if (entries.length === 0) {
            captures = [];
            refreshAllTools();
            return;
        }
        sendMessage({ type: 'getCaptures' }).then((response) => {
            if (!response || !response.success) return;
            captures = Array.isArray(response.captures) ? response.captures : [];
            refreshAllTools();
        });
    }

    async function fetchRuleStats() {
        // PERF-2: this used 'getRules', which returns every rule object
        // (mock bodies included) every 3 seconds to derive two numbers.
        // 'getRuleStats' returns just the numbers.
        const response = await sendMessage({ type: 'getRuleStats' });
        if (response && response.success) {
            clearError();
            ruleStats.intercepted = response.intercepted || 0;
            ruleStats.activeRules = response.activeRules || 0;
            updateRuleStats();
            lastSettings = response.settings || lastSettings;
            applyTheme(lastSettings);
        }
    }

    // U-9: every other surface (popup.js, options.js) reads settings.theme
    // this same way and mirrors a theme-{dark,light} class on <body>; the
    // panel had no equivalent at all. `getRules` already carries `settings`
    // and the panel already polls it every tick for the stats cards, so no
    // new message type is needed.
    function applyTheme(settings) {
        const theme = (settings && settings.theme) || 'auto';
        const resolved = theme === 'auto'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : theme;
        document.body.classList.remove('theme-dark', 'theme-light');
        document.body.classList.add('theme-' + resolved);
    }

    function setupThemeMediaListener() {
        if (!window.matchMedia) return;
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = () => {
            if ((lastSettings && lastSettings.theme) === 'auto' || !lastSettings || !lastSettings.theme) {
                applyTheme(lastSettings);
            }
        };
        if (typeof mediaQuery.addEventListener === 'function') {
            mediaQuery.addEventListener('change', handler);
        }
    }

    function updateBufferStats() {
        const totalEl = byId('totalRequests');
        if (totalEl) totalEl.textContent = String(entries.length);

        // PER-56: only entries with a numeric final status are in the rate. A
        // delay that settled with 200 counts as a 2xx; a chaos failure, a
        // 'failed' outcome and a delay not yet settled have no status to
        // count, and used to drag the rate to 0% when everything succeeded.
        const finals = entries.map(finalStatusOf).filter((status) => typeof status === 'number');
        const successCount = finals.filter((status) => status >= 200 && status < 300).length;
        const rateEl = byId('successRate');
        if (rateEl) {
            const rate = finals.length > 0 ? Math.round((successCount / finals.length) * 100) : 0;
            rateEl.textContent = rate + '%';
        }
    }

    function updateRuleStats() {
        const mockedEl = byId('mockedRequests');
        if (mockedEl) mockedEl.textContent = String(ruleStats.intercepted);

        const activeEl = byId('activeRules');
        if (activeEl) activeEl.textContent = String(ruleStats.activeRules);
    }

    function visibleEntries() {
        const q = filterState.text.trim().toLowerCase();
        const type = filterState.type;
        return entries.filter((entry) => {
            const key = entryKey(entry);
            if (dismissedKeys.has(key)) return false;
            if (type && type !== 'all' && entryType(entry) !== type) return false;
            if (q) {
                const haystack = ((entry.url || '') + ' ' + (entry.ruleName || '')).toLowerCase();
                if (haystack.indexOf(q) === -1) return false;
            }
            return true;
        });
    }

    // Updates only the bits of a row that can change without the entry
    // itself changing identity: the reveal state of the URL cell and the
    // relative/absolute timestamp (A-10 — "just now" -> "5s ago" mutates on
    // its own even with zero new traffic).
    function updateRowContent(row, entry) {
        const key = row.dataset.key;
        updateUrlCell(row.querySelector('.url-toggle'), entry, revealedKeys.has(key));
        updateTimestampCell(row.querySelector('.timestamp'), entry);
        updateRowTools(row, entry);
    }

    function refreshAllTools() {
        rowElements.forEach((row, key) => {
            const entry = entryByKey.get(key);
            if (entry) updateRowTools(row, entry);
        });
    }

    // PER-57: the row's own actions. "View response" exists only while a capture
    // for the same method and URL does; "Disable rule" (which turns into "Enable
    // rule" once this panel has used it) only for a row that came from a rule.
    // Rebuilt only when what it shows changes, so a poll tick leaves a focused
    // button, and an open response a reader is scrolling, alone.
    function updateRowTools(row, entry) {
        const toolsEl = row.querySelector('.row-tools');
        if (!toolsEl) return;
        const key = row.dataset.key;
        const capture = window.SpliceTapHar.findCapture(entry, captures);
        const hasRule = !!entry.ruleId && entry.kind !== 'chaos';
        const disabled = hasRule && disabledRuleIds.has(entry.ruleId);
        const open = !!capture && openResponseKeys.has(key);
        const signature = [capture ? capture.id : '', hasRule ? 1 : 0, disabled ? 1 : 0, open ? 1 : 0].join('|');
        if (toolsEl.dataset.sig === signature) return;
        toolsEl.dataset.sig = signature;

        const focusedTool = toolsEl.contains(document.activeElement) ? document.activeElement.dataset.tool : null;
        toolsEl.replaceChildren();
        toolsEl.hidden = !capture && !hasRule;
        if (toolsEl.hidden) return;

        const target = (entry.method || 'GET') + ' ' + truncateUrl(stripQueryAndHash(entry.url), 60);
        let viewer = null;
        if (capture) {
            const viewId = 'responseView' + (++toolSeq);
            const viewBtn = document.createElement('button');
            viewBtn.type = 'button';
            viewBtn.className = 'row-tool-btn';
            viewBtn.dataset.tool = 'view';
            viewBtn.dataset.key = key;
            viewBtn.textContent = 'View response';
            viewBtn.setAttribute('aria-label', 'View response, ' + target);
            viewBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            viewBtn.setAttribute('aria-controls', viewId);
            toolsEl.appendChild(viewBtn);
            viewer = buildResponseView(capture, viewId, target);
            viewer.hidden = !open;
        }
        if (hasRule) {
            const ruleBtn = document.createElement('button');
            ruleBtn.type = 'button';
            ruleBtn.className = 'row-tool-btn';
            ruleBtn.dataset.tool = 'toggle';
            ruleBtn.dataset.ruleId = entry.ruleId;
            ruleBtn.dataset.ruleName = entry.ruleName || '';
            const verb = disabled ? 'Enable rule' : 'Disable rule';
            ruleBtn.textContent = verb;
            ruleBtn.setAttribute('aria-label', verb + ' ' + (entry.ruleName || '(unnamed rule)'));
            toolsEl.appendChild(ruleBtn);
        }
        if (viewer) toolsEl.appendChild(viewer);
        if (focusedTool) {
            const again = toolsEl.querySelector('[data-tool="' + focusedTool + '"]');
            if (again) again.focus({ preventScroll: true });
        }
    }

    // Read-only: status, headers, body of the captured response, built with DOM
    // APIs like the rest of the row. The body can scroll, so it takes focus.
    function buildResponseView(capture, id, target) {
        const helpers = window.SpliceTapPanelHelpers;
        const view = document.createElement('div');
        view.className = 'response-view';
        view.id = id;
        view.setAttribute('role', 'region');
        view.setAttribute('aria-label', 'Captured response for ' + target);

        const status = document.createElement('p');
        status.className = 'response-status';
        status.textContent = helpers.formatStatus(capture) + (capture.contentType ? ' · ' + capture.contentType : '');
        view.appendChild(status);

        const headerLines = helpers.formatHeaders(capture.headers);
        const headersLabel = document.createElement('p');
        headersLabel.className = 'response-label';
        headersLabel.textContent = 'Headers';
        const headers = document.createElement('pre');
        headers.className = 'response-pre response-headers';
        headers.tabIndex = 0;
        headers.setAttribute('aria-label', 'Response headers');
        headers.textContent = headerLines.length ? headerLines.join('\n') : '(none recorded)';
        view.appendChild(headersLabel);
        view.appendChild(headers);

        const bodyLabel = document.createElement('p');
        bodyLabel.className = 'response-label';
        bodyLabel.textContent = 'Body';
        const formatted = helpers.formatBody(capture.body);
        const body = document.createElement('pre');
        body.className = 'response-pre response-body';
        body.tabIndex = 0;
        body.setAttribute('aria-label', 'Response body');
        body.textContent = formatted.text || '(empty)';
        view.appendChild(bodyLabel);
        view.appendChild(body);
        if (formatted.truncated) {
            const more = document.createElement('p');
            more.className = 'response-label';
            more.textContent = 'Shown up to the first ' + helpers.BODY_VIEW_MAX + ' characters.';
            view.appendChild(more);
        }
        return view;
    }

    // PER-57: open a rule in the full editor, in a new tab. DevTools pages have
    // no chrome.tabs, so fall back to window.open on the extension's own URL.
    function openRuleInEditor(ruleId) {
        const url = chrome.runtime.getURL(window.SpliceTapPanelHelpers.editRulePath(ruleId));
        try {
            if (chrome.tabs && typeof chrome.tabs.create === 'function') {
                chrome.tabs.create({ url });
                return;
            }
        } catch (error) {
            // fall through to window.open
        }
        window.open(url, '_blank', 'noopener');
    }

    async function toggleRuleFromRow(button) {
        const ruleId = button.dataset.ruleId;
        const name = button.dataset.ruleName || '(unnamed rule)';
        const disabling = !disabledRuleIds.has(ruleId);
        const announcer = byId('logAnnouncer');
        const say = (text) => { if (announcer) announcer.textContent = text; };
        button.setAttribute('aria-busy', 'true');
        const response = await sendMessage({ type: 'toggleRule', ruleId, enabled: !disabling });
        button.removeAttribute('aria-busy');
        if (!response || !response.success) {
            say('Could not ' + (disabling ? 'disable' : 'enable') + ' rule "' + name + '"' +
                (response && response.error ? ': ' + response.error : '.'));
            return;
        }
        if (disabling) disabledRuleIds.add(ruleId);
        else disabledRuleIds.delete(ruleId);
        refreshAllTools();
        say('Rule "' + name + '" ' + (disabling ? 'disabled' : 'enabled') + '.');
    }

    function updateUrlCell(btn, entry, revealed) {
        if (!btn) return;
        const strippedUrl = stripQueryAndHash(entry.url);
        const hasQuery = !!(entry.url && strippedUrl.length !== entry.url.length);
        if (revealed) {
            btn.textContent = truncateUrl(entry.url || '', 300);
            btn.title = entry.url || '';
        } else {
            btn.textContent = truncateUrl(strippedUrl, 80) + (hasQuery ? ' ⋯' : '');
            btn.title = hasQuery
                ? strippedUrl + ' (query string hidden — click to reveal full URL)'
                : strippedUrl;
        }
        btn.setAttribute('aria-expanded', revealed ? 'true' : 'false');
    }

    function updateTimestampCell(cell, entry) {
        if (!cell) return;
        cell.textContent = formatRelativeTime(entry.ts);
        cell.title = entry.ts ? new Date(entry.ts).toLocaleString() : '';
    }

    // PER-80: "Dismiss GET http://host/api/users" — the query string stays out
    // for the same reason it is hidden in the row (S-8).
    function dismissLabel(entry) {
        return 'Dismiss ' + (entry.method || 'GET') + ' ' + truncateUrl(stripQueryAndHash(entry.url), 60);
    }

    // Two rows for the same call (the same URL with different queries, or a
    // repeat) would still share a name; number those oldest-first, so a row's
    // number does not shift when newer traffic arrives above it.
    function labelDismissButtons(visible, keys) {
        const bases = visible.map(dismissLabel);
        const totals = new Map();
        bases.forEach((base) => totals.set(base, (totals.get(base) || 0) + 1));
        const counted = new Map();
        for (let i = visible.length - 1; i >= 0; i--) {
            const row = rowElements.get(keys[i]);
            const btn = row && row.querySelector('.dismiss-btn');
            const n = (counted.get(bases[i]) || 0) + 1;
            counted.set(bases[i], n);
            if (btn) btn.setAttribute('aria-label', totals.get(bases[i]) > 1 ? `${bases[i]} (#${n})` : bases[i]);
        }
    }

    // Builds a row entirely via DOM APIs rather than an HTML string. This is
    // the S-6 fix for the row templates: textContent/setAttribute cannot be
    // used to break out of an attribute or inject markup, so there is no
    // escaping to get wrong here (unlike the old `title="${escapeHtml(...)}"`
    // string-interpolation sink).
    function buildRowElement(entry, key) {
        const method = entry.method || 'GET';
        const status = outcomeInfo(entry);
        const ruleType = entryType(entry);

        const row = document.createElement('div');
        row.className = 'request-item' + (status.detail ? ' request-item-detail' : '');
        row.setAttribute('role', 'row');
        row.dataset.key = key;

        const methodCell = document.createElement('div');
        methodCell.className = 'request-method ' + methodClass(method);
        methodCell.setAttribute('role', 'cell');
        methodCell.textContent = method;
        row.appendChild(methodCell);

        const urlCell = document.createElement('div');
        urlCell.className = 'request-url';
        urlCell.setAttribute('role', 'cell');
        const urlBtn = document.createElement('button');
        urlBtn.type = 'button';
        urlBtn.className = 'url-toggle';
        urlBtn.dataset.key = key;
        urlCell.appendChild(urlBtn);
        // PER-57: View response / Disable rule go under the URL, so the grid
        // columns (and the narrow stacked layout of PER-79) are unchanged.
        const toolsEl = document.createElement('div');
        toolsEl.className = 'row-tools';
        toolsEl.hidden = true;
        // PER-54: what the interceptor did instead of what the rule says (a
        // skipped patch and why). It is text in the row, and the URL button
        // carries it as its description, so it is read with the request
        // whether a screen reader walks the cells or tabs to the button.
        if (entry.note) {
            const noteEl = document.createElement('div');
            noteEl.className = 'request-note';
            noteEl.id = 'requestNote' + (++noteSeq);
            noteEl.textContent = entry.note;
            urlBtn.setAttribute('aria-describedby', noteEl.id);
            urlCell.appendChild(noteEl);
        }
        urlCell.appendChild(toolsEl);
        row.appendChild(urlCell);

        const ruleCell = document.createElement('div');
        ruleCell.className = 'rule-info';
        ruleCell.setAttribute('role', 'cell');
        const displayName = entry.ruleName || (ruleType === 'chaos' ? 'Chaos mode' : '(unnamed rule)');
        // PER-57: a rule's name is a button that opens it in the editor. Chaos
        // failures belong to no rule, so theirs stays plain text. The text is
        // exactly the name; ", edit rule" is only in the accessible name.
        const ruleNameSpan = document.createElement(entry.ruleId ? 'button' : 'span');
        ruleNameSpan.className = 'rule-name' + (entry.ruleId ? ' rule-name-btn' : '');
        ruleNameSpan.textContent = displayName;
        if (entry.ruleId) {
            ruleNameSpan.type = 'button';
            ruleNameSpan.dataset.ruleId = entry.ruleId;
            ruleNameSpan.setAttribute('aria-label', displayName + ', edit rule');
            ruleNameSpan.title = 'Edit this rule (ID: ' + entry.ruleId + ')';
        }
        const ruleTypeSpan = document.createElement('span');
        ruleTypeSpan.className = 'rule-type-badge';
        ruleTypeSpan.dataset.type = ruleType;
        ruleTypeSpan.textContent = typeLabel(ruleType);
        ruleCell.appendChild(ruleNameSpan);
        ruleCell.appendChild(ruleTypeSpan);
        row.appendChild(ruleCell);

        const statusCell = document.createElement('div');
        statusCell.className = 'request-status ' + status.cls + (status.detail ? ' status-detail' : '');
        statusCell.setAttribute('role', 'cell');
        statusCell.textContent = status.text;
        row.appendChild(statusCell);

        const tsCell = document.createElement('div');
        tsCell.className = 'timestamp';
        tsCell.setAttribute('role', 'cell');
        row.appendChild(tsCell);

        const actionsCell = document.createElement('div');
        actionsCell.className = 'request-actions';
        actionsCell.setAttribute('role', 'cell');
        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'dismiss-btn';
        dismissBtn.dataset.key = key;
        // PER-80: every button used to be named the same, so a list of them
        // was "Dismiss, Dismiss, Dismiss". renderEntries() adds a number when
        // two rows would still read alike.
        dismissBtn.setAttribute('aria-label', dismissLabel(entry));
        dismissBtn.textContent = '×';
        actionsCell.appendChild(dismissBtn);
        row.appendChild(actionsCell);

        updateRowContent(row, entry);
        return row;
    }

    function updateEmptyStateMessage(visibleCount) {
        if (visibleCount > 0) return;
        const titleEl = document.querySelector('#emptyState .empty-title');
        const descEl = document.querySelector('#emptyState .empty-description');
        if (!titleEl || !descEl) return;
        const filtering = !!(filterState.text.trim() || (filterState.type && filterState.type !== 'all'));
        if (entries.length > 0 && filtering) {
            titleEl.textContent = 'No matching requests';
            descEl.textContent = 'Try clearing the filter or search text.';
        } else {
            titleEl.textContent = 'No intercepted requests yet';
            descEl.textContent = 'Trigger a request that matches one of your rules to see it here.';
        }
    }

    // P-12 / A-10: this replaces the old "wholesale innerHTML rebuild every
    // tick" renderer. Rows are keyed and reused; a tick whose visible key
    // sequence is unchanged only refreshes per-row timestamps (cheap text
    // writes, no structural DOM churn, no lost focus/selection/scroll).
    function renderEntries() {
        const itemsContainer = byId('requestItems');
        const tableEl = byId('requestTable');
        const emptyState = byId('emptyState');
        if (!itemsContainer) return;

        const visible = visibleEntries();
        updateEmptyStateMessage(visible.length);

        if (visible.length === 0) {
            if (rowElements.size > 0) {
                itemsContainer.replaceChildren();
                rowElements = new Map();
            }
            lastKeySignature = '';
            if (emptyState) emptyState.style.display = '';
            if (tableEl) tableEl.style.display = 'none';
            return;
        }

        if (emptyState) emptyState.style.display = 'none';
        if (tableEl) tableEl.style.display = '';

        const keys = visible.map(entryKey);
        const signature = keys.join('');

        if (signature === lastKeySignature) {
            visible.forEach((entry, i) => {
                const el = rowElements.get(keys[i]);
                if (el) updateRowContent(el, entry);
            });
            return;
        }

        const newRowElements = new Map();
        const nodes = visible.map((entry, i) => {
            const key = keys[i];
            let el = rowElements.get(key);
            if (el) {
                updateRowContent(el, entry);
            } else {
                el = buildRowElement(entry, key);
            }
            newRowElements.set(key, el);
            return el;
        });

        // Re-inserting a kept row drops focus from the control inside it (a new
        // request arriving would knock a keyboard user off the button they were
        // on), so put it back if it is still in the list.
        const focused = document.activeElement;
        const hadFocus = !!(focused && itemsContainer.contains(focused));
        itemsContainer.replaceChildren(...nodes);
        if (hadFocus && focused.isConnected) focused.focus({ preventScroll: true });
        rowElements = newRowElements;
        lastKeySignature = signature;
        labelDismissButtons(visible, keys);
    }

    // A-10: politely announce arrivals instead of leaving screen-reader
    // users with zero notification that the log is even live.
    function announceNewEntries(newlyLogged) {
        const el = byId('logAnnouncer');
        if (!el) return;
        if (newlyLogged.length === 1) {
            const entry = newlyLogged[0];
            const status = outcomeInfo(entry);
            el.textContent = 'New request logged: ' + (entry.method || 'GET') + ' ' +
                truncateUrl(stripQueryAndHash(entry.url), 60) + ' — ' + status.text +
                (entry.ruleName ? ' (' + entry.ruleName + ')' : '');
        } else {
            el.textContent = newlyLogged.length + ' new requests logged.';
        }
    }

    function showError(message) {
        const container = byId('errorContainer');
        if (!container) return;
        container.innerHTML = `<div class="error-state"><strong>Error:</strong> ${escapeHtml(message)}</div>`;
    }

    function clearError() {
        const container = byId('errorContainer');
        if (container) container.innerHTML = '';
    }

    function setupClearButton() {
        const btn = byId('clearRequestsBtn');
        if (!btn) return;
        // No confirmation. This blocked on a native window.confirm(): a
        // DevTools extension panel is a cross-origin frame inside DevTools,
        // not a place to depend on native dialogs, and the popup already
        // retired them for the same reason (U-11). Clearing a session's
        // diagnostic log destroys no rules or settings, and new traffic
        // refills it — Chrome's own Network panel clears without asking.
        btn.addEventListener('click', async () => {
            await sendMessage({ type: 'clearInterceptionLog' });
            dismissedKeys.clear();
            revealedKeys.clear();
            knownKeys.clear();
            entryByKey = new Map();
            lastKeySignature = '';
            const announcer = byId('logAnnouncer');
            if (announcer) announcer.textContent = 'Log cleared.';
            await fetchInterceptionLog();
        });
    }

    function inspectedTabId() {
        return (typeof chrome !== 'undefined' && chrome.devtools && chrome.devtools.inspectedWindow)
            ? chrome.devtools.inspectedWindow.tabId
            : undefined;
    }

    // F5: hand a string to the browser as a file, through a Blob and a link
    // with a download name (extension pages have no downloads permission here
    // and need none for this).
    function downloadText(fileName, text, mimeType) {
        const blob = new Blob([text], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // The click has queued the download; release the blob afterwards.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    // F5: every entry in the log (not only the rows the filter or Dismiss
    // leaves on screen), with response bodies from captures where the same
    // method and URL was captured. The log is fetched fresh rather than taken
    // from the last poll, so the file is what the background holds right now.
    async function exportHar() {
        const announcer = byId('logAnnouncer');
        const say = (text) => { if (announcer) announcer.textContent = text; };

        const [logResponse, captureResponse] = await Promise.all([
            sendMessage({ type: 'getInterceptionLog', tabId: inspectedTabId() }),
            sendMessage({ type: 'getCaptures' })
        ]);
        if (!logResponse || !logResponse.success) {
            showError('Could not read the log to export it.');
            say('Export failed.');
            return;
        }
        clearError();

        const logged = logResponse.entries || [];
        if (logged.length === 0) {
            say('Nothing to export yet. Trigger a request that matches one of your rules.');
            return;
        }
        // A missing captures list only costs the response bodies.
        const captures = (captureResponse && captureResponse.success && captureResponse.captures) || [];

        let version = '';
        try { version = chrome.runtime.getManifest().version; } catch (e) { /* shown blank */ }
        const har = window.SpliceTapHar.buildHar(logged, captures, { version });
        const fileName = window.SpliceTapHar.harFileName(new Date());
        downloadText(fileName, JSON.stringify(har, null, 2), 'application/json');
        say('Exported ' + logged.length + (logged.length === 1 ? ' request' : ' requests') + ' to ' + fileName + '.');
    }

    function setupExportButton() {
        const btn = byId('exportHarBtn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            exportHar().catch((error) => {
                console.error('SpliceTap panel: HAR export failed', error);
                showError('Export failed: ' + error.message);
            });
        });
    }

    // WCAG 2.2.2 Pause, Stop, Hide — a real user-facing control, independent
    // of the visibility-driven pause below (a keyboard/screen-reader user
    // can't rely on "switch to another DevTools tab" to get relief from
    // auto-updating content).
    function setupPauseButton() {
        const btn = byId('pauseBtn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            userPaused = !userPaused;
            // PER-80: the label stays "Pause"; only aria-pressed changes. Swapping
            // it to "Resume" as well made a screen reader say "Resume, pressed".
            btn.setAttribute('aria-pressed', userPaused ? 'true' : 'false');
            updatePollingState();
            const announcer = byId('logAnnouncer');
            if (announcer) announcer.textContent = userPaused ? 'Auto-refresh paused.' : 'Auto-refresh resumed.';
            if (!userPaused) refresh();
        });
    }

    function setupFilterControls() {
        const textInput = byId('filterText');
        const typeSelect = byId('filterType');
        if (textInput) {
            textInput.addEventListener('input', (e) => {
                filterState.text = e.target.value || '';
                renderEntries();
            });
        }
        if (typeSelect) {
            typeSelect.addEventListener('change', (e) => {
                filterState.type = e.target.value || 'all';
                renderEntries();
            });
        }
    }

    // Event delegation on the row container: rows are created/reused
    // incrementally now, so binding once here (rather than per-row) keeps
    // click handling correct across the diff-based re-renders above.
    function setupRowDelegation() {
        const container = byId('requestItems');
        if (!container) return;
        container.addEventListener('click', (event) => {
            // PER-57
            const nameBtn = event.target.closest('.rule-name-btn');
            if (nameBtn) {
                openRuleInEditor(nameBtn.dataset.ruleId);
                return;
            }
            const toolBtn = event.target.closest('.row-tool-btn');
            if (toolBtn) {
                if (toolBtn.dataset.tool === 'view') {
                    const key = toolBtn.dataset.key;
                    if (openResponseKeys.has(key)) openResponseKeys.delete(key);
                    else openResponseKeys.add(key);
                    const row = rowElements.get(key);
                    const entry = entryByKey.get(key);
                    if (row && entry) updateRowTools(row, entry);
                } else if (toolBtn.dataset.tool === 'toggle') {
                    toggleRuleFromRow(toolBtn);
                }
                return;
            }

            const urlBtn = event.target.closest('.url-toggle');
            if (urlBtn) {
                const key = urlBtn.dataset.key;
                const entry = entryByKey.get(key);
                if (!entry) return;
                if (revealedKeys.has(key)) {
                    revealedKeys.delete(key);
                } else {
                    revealedKeys.add(key);
                }
                updateUrlCell(urlBtn, entry, revealedKeys.has(key));
                return;
            }

            const dismissBtn = event.target.closest('.dismiss-btn');
            if (dismissBtn) {
                const key = dismissBtn.dataset.key;
                // PER-80: the row is about to be removed, and with it the focused
                // button, so focus fell to <body> and a keyboard user lost their
                // place. Note the neighbours first; land on the next row's
                // dismiss button, else the previous one, else the list.
                const rowKeys = Array.from(container.children).map((r) => r.dataset.key);
                const at = rowKeys.indexOf(key);
                const neighbours = [rowKeys[at + 1], rowKeys[at - 1]].filter((k) => k !== undefined && at !== -1);
                dismissedKeys.add(key);
                renderEntries();
                let next = null;
                for (const k of neighbours) {
                    const row = rowElements.get(k);
                    next = row && row.querySelector('.dismiss-btn');
                    if (next) break;
                }
                (next || byId('requestsList')).focus();
                const announcer = byId('logAnnouncer');
                if (announcer) announcer.textContent = 'Entry dismissed from view.';
            }
        });
    }

    function refresh() {
        fetchInterceptionLog();
        fetchRuleStats();
    }

    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // P-12: the single choke point that decides whether the timer should be
    // running at all. Called from the manual pause button, the panel's own
    // visibilitychange (covers the whole DevTools window being backgrounded),
    // and the onShown/onHidden bridge below (covers switching to a different
    // DevTools panel while the window stays focused — visibilitychange does
    // not fire for that).
    function updatePollingState() {
        if (!userPaused && !panelHidden) {
            startPolling();
        } else {
            stopPolling();
        }
    }

    // Bridge for devtools.js: chrome.devtools.panels.ExtensionPanel's
    // onShown/onHidden are the only reliable signal for "is this panel the
    // one currently selected in the DevTools window" — the standard Page
    // Visibility API (below) does not fire when the user merely switches to
    // a different DevTools panel (Elements/Console/Network/...) without
    // touching the DevTools window itself.
    window.__spliceTapPanelShown = function () {
        panelHidden = false;
        updatePollingState();
        capturesKeySignature = null; // captures may have been recorded while it was away
        if (!userPaused) refresh();
    };

    window.__spliceTapPanelHidden = function () {
        panelHidden = true;
        updatePollingState();
    };

    function init() {
        try {
            applyTheme({ theme: 'auto' }); // sane default before the first getRules resolves
            setupThemeMediaListener();
            setupClearButton();
            setupPauseButton();
            setupExportButton();
            setupFilterControls();
            setupRowDelegation();
            refresh();
            updatePollingState();
        } catch (error) {
            console.error('SpliceTap panel: init failed', error);
            showError('Failed to initialize panel: ' + error.message);
        }
    }

    // panel.js is loaded via <script src> at the end of <body>, so the DOM
    // is already parsed by the time this runs — but guard anyway in case
    // load order ever changes.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Covers the DevTools window itself being backgrounded/minimized (the
    // per-panel onShown/onHidden bridge above covers switching panels within
    // a focused DevTools window; this covers the window-level case).
    document.addEventListener('visibilitychange', () => {
        panelHidden = document.hidden;
        updatePollingState();
        if (!panelHidden && !userPaused) refresh();
    });

    // Stop polling if the panel window unloads (defensive; devtools tears
    // the whole document down on close anyway).
    window.addEventListener('unload', () => {
        stopPolling();
    });
})();
