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

    // Maps an interception log entry's `status` to a CSS class + label.
    // status is: 0 for block, null for delay (unresolved at log time),
    // 302 for redirect, or a real/mock HTTP status code otherwise.
    function statusInfo(status) {
        if (status === null || status === undefined) {
            return { cls: 'status-pending', text: 'pending' };
        }
        if (status === 0) {
            return { cls: 'status-error', text: 'blocked' };
        }
        if (status >= 200 && status < 300) {
            return { cls: 'status-success', text: String(status) };
        }
        return { cls: 'status-error', text: String(status) };
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
        [dismissedKeys, revealedKeys, knownKeys].forEach((set) => {
            Array.from(set).forEach((key) => {
                if (!valid.has(key)) set.delete(key);
            });
        });
    }

    async function fetchInterceptionLog() {
        // QA-3: scope the log to the tab this panel is inspecting. Without
        // this the panel showed traffic intercepted in every other tab too.
        const inspectedTabId = (typeof chrome !== 'undefined'
            && chrome.devtools
            && chrome.devtools.inspectedWindow)
            ? chrome.devtools.inspectedWindow.tabId
            : undefined;
        const response = await sendMessage({ type: 'getInterceptionLog', tabId: inspectedTabId });
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

        const successCount = entries.filter((e) => e.status >= 200 && e.status < 300).length;
        const rateEl = byId('successRate');
        if (rateEl) {
            const rate = entries.length > 0 ? Math.round((successCount / entries.length) * 100) : 0;
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
            if (type && type !== 'all' && (entry.ruleType || 'mock') !== type) return false;
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

    // Builds a row entirely via DOM APIs rather than an HTML string. This is
    // the S-6 fix for the row templates: textContent/setAttribute cannot be
    // used to break out of an attribute or inject markup, so there is no
    // escaping to get wrong here (unlike the old `title="${escapeHtml(...)}"`
    // string-interpolation sink).
    function buildRowElement(entry, key) {
        const method = entry.method || 'GET';
        const status = statusInfo(entry.status);
        const ruleType = entry.ruleType || 'mock';

        const row = document.createElement('div');
        row.className = 'request-item';
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
        row.appendChild(urlCell);

        const ruleCell = document.createElement('div');
        ruleCell.className = 'rule-info';
        ruleCell.setAttribute('role', 'cell');
        const ruleNameSpan = document.createElement('span');
        ruleNameSpan.className = 'rule-name';
        ruleNameSpan.textContent = entry.ruleName || '(unnamed rule)';
        if (entry.ruleId) ruleNameSpan.title = 'Rule ID: ' + entry.ruleId;
        const ruleTypeSpan = document.createElement('span');
        ruleTypeSpan.className = 'rule-type-badge';
        ruleTypeSpan.dataset.type = ruleType;
        ruleTypeSpan.textContent = ruleType;
        ruleCell.appendChild(ruleNameSpan);
        ruleCell.appendChild(ruleTypeSpan);
        row.appendChild(ruleCell);

        const statusCell = document.createElement('div');
        statusCell.className = 'request-status ' + status.cls;
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
        dismissBtn.setAttribute('aria-label', 'Dismiss this entry from the log view');
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

        itemsContainer.replaceChildren(...nodes);
        rowElements = newRowElements;
        lastKeySignature = signature;
    }

    // A-10: politely announce arrivals instead of leaving screen-reader
    // users with zero notification that the log is even live.
    function announceNewEntries(newlyLogged) {
        const el = byId('logAnnouncer');
        if (!el) return;
        if (newlyLogged.length === 1) {
            const entry = newlyLogged[0];
            const status = statusInfo(entry.status);
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
        btn.addEventListener('click', async () => {
            if (!window.confirm('Clear all intercepted request logs? This cannot be undone.')) {
                return;
            }
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

    // WCAG 2.2.2 Pause, Stop, Hide — a real user-facing control, independent
    // of the visibility-driven pause below (a keyboard/screen-reader user
    // can't rely on "switch to another DevTools tab" to get relief from
    // auto-updating content).
    function setupPauseButton() {
        const btn = byId('pauseBtn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            userPaused = !userPaused;
            btn.textContent = userPaused ? 'Resume' : 'Pause';
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
                dismissedKeys.add(key);
                renderEntries();
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
