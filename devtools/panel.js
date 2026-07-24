/**
 * TurboMock DevTools Panel
 *
 * Plain script (no import/export) — MV3 devtools panel pages load scripts
 * via a plain <script src> tag, not modules, and the default extension-page
 * CSP forbids inline scripts, hence this separate file.
 *
 * Mocked/blocked/delayed/redirected requests never touch the real network
 * stack, so chrome.devtools.network can never see them (TODO.md §1.5). This
 * panel instead polls the background service worker's in-memory
 * interception log (populated by content/injected.js -> content/content.js
 * -> service_worker/background.js) via chrome.runtime.sendMessage and
 * renders whatever comes back.
 */
(function () {
    'use strict';

    const POLL_INTERVAL_MS = 2000;

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
    let ruleStats = { intercepted: 0, activeRules: 0 };
    let pollTimer = null;

    function byId(id) {
        return document.getElementById(id);
    }

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(value);
        return div.innerHTML;
    }

    function truncateUrl(url) {
        if (!url) return '';
        return url.length > 80 ? url.substring(0, 77) + '...' : url;
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
                        console.error('TurboMock panel: sendMessage failed for', message.type, chrome.runtime.lastError.message);
                        resolve(null);
                        return;
                    }
                    resolve(response);
                });
            } catch (error) {
                console.error('TurboMock panel: sendMessage threw for', message.type, error);
                resolve(null);
            }
        });
    }

    async function fetchInterceptionLog() {
        const response = await sendMessage({ type: 'getInterceptionLog' });
        if (response && response.success) {
            clearError();
            // Background stores entries oldest-first (ring buffer push order);
            // show newest first.
            entries = (response.entries || []).slice().reverse();
        } else if (response === null) {
            showError('Could not reach the TurboMock background service worker.');
        }
        renderEntries();
        updateBufferStats();
    }

    async function fetchRuleStats() {
        const response = await sendMessage({ type: 'getRules' });
        if (response && response.success) {
            clearError();
            ruleStats.intercepted = (response.stats && response.stats.intercepted) || 0;
            ruleStats.activeRules = (response.rules || []).filter((r) => r.enabled).length;
            updateRuleStats();
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

    function renderEntries() {
        const itemsContainer = byId('requestItems');
        const emptyState = byId('emptyState');
        if (!itemsContainer) return;

        if (entries.length === 0) {
            itemsContainer.innerHTML = '';
            if (emptyState) emptyState.style.display = '';
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        itemsContainer.innerHTML = entries.map((entry) => {
            const method = entry.method || 'GET';
            const status = statusInfo(entry.status);
            return `
                <div class="request-item">
                    <div class="request-method ${methodClass(method)}">${escapeHtml(method)}</div>
                    <div class="request-url" title="${escapeHtml(entry.url)}">${escapeHtml(truncateUrl(entry.url))}</div>
                    <div class="rule-info">
                        <span class="rule-name">${escapeHtml(entry.ruleName || '(unnamed rule)')}</span>
                        <span class="rule-type-badge" data-type="${escapeHtml(entry.ruleType || 'mock')}">${escapeHtml(entry.ruleType || '')}</span>
                    </div>
                    <div class="request-status ${status.cls}">${escapeHtml(status.text)}</div>
                    <div class="timestamp">${escapeHtml(formatRelativeTime(entry.ts))}</div>
                </div>
            `;
        }).join('');
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
            await sendMessage({ type: 'clearInterceptionLog' });
            await fetchInterceptionLog();
        });
    }

    function refresh() {
        fetchInterceptionLog();
        fetchRuleStats();
    }

    function init() {
        try {
            setupClearButton();
            refresh();
            pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
        } catch (error) {
            console.error('TurboMock panel: init failed', error);
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

    // Stop polling if the panel window unloads (defensive; devtools tears
    // the whole document down on close anyway).
    window.addEventListener('unload', () => {
        if (pollTimer) clearInterval(pollTimer);
    });
})();
