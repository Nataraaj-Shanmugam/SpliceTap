/**
 * TurboMock Extension - Enhanced Popup JavaScript
 * Fixed version with working navigation and proper state management
 */

class TurboMockPopup {
    constructor() {
        this.rules = [];
        this.filteredRules = [];
        this.isActive = true;
        this.stats = { intercepted: 0, rulesCount: 0 };
        this.settings = {};
        this.currentView = 'rules'; // rules, settings, about
        
        this.init();
    }

    /**
     * Initialize the popup
     */
    async init() {
        try {
            this.setupEventListeners();
            await this.loadData();
            this.renderCurrentView();
            this.updateStatus();
            this.updateStats();

            // Animate popup entrance
            document.body.classList.add('loaded');
            console.log('TurboMock popup initialized');
        } catch (error) {
            console.error('Failed to initialize popup:', error);
            this.showError('Failed to load extension data');
        }
    }

    /**
     * Load rules and extension state from storage
     */
    async loadData() {
        try {
            // Try background script first
            const response = await this.sendMessage({ type: 'getRules' });

            if (response && response.success) {
                this.rules = response.rules || [];
                this.isActive = response.active !== false;
                this.stats = response.stats || { intercepted: 0, rulesCount: this.rules.length };
                this.settings = response.settings || {};
                this.filteredRules = [...this.rules];
                this.applyTheme();
                return;
            }

            // Background didn't return usable data — show the empty state.
            // (The popup talks to the background exclusively; it no longer
            // instantiates storage directly.)
            this.rules = [];
            this.filteredRules = [];
            this.isActive = true;
            this.stats = { intercepted: 0, rulesCount: 0 };
        } catch (error) {
            console.error('Error loading data:', error);
            // Use empty state as final fallback
            this.rules = [];
            this.filteredRules = [];
            this.isActive = true;
            this.stats = { intercepted: 0, rulesCount: 0 };
        }
    }

    /**
     * Apply the saved theme. 'auto' follows the OS preference. The popup
     * previously ignored this setting entirely and was always dark.
     */
    applyTheme() {
        const theme = (this.settings && this.settings.theme) || 'auto';
        const resolved = theme === 'auto'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : theme;

        document.body.classList.remove('theme-dark', 'theme-light');
        document.body.classList.add(`theme-${resolved}`);
    }

    /**
     * Setup all event listeners
     */
    setupEventListeners() {
        // Header actions
        this.addListener('settingsBtn', 'click', () => this.openSettings());
        this.addListener('refreshBtn', 'click', () => this.refreshData());
        
        // Search
        this.addListener('searchInput', 'input', (e) => this.handleSearch(e));
        
        // Footer actions
        this.addListener('newRuleBtn', 'click', () => this.createNewRule());
        this.addListener('testAllBtn', 'click', () => this.testAllRules());
        
        // Status toggle
        this.addListener('statusToggle', 'click', () => this.toggleGlobalStatus());
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));
    }

    /**
     * Helper to safely add event listeners
     */
    addListener(elementId, event, handler) {
        const element = document.getElementById(elementId);
        if (element) {
            element.addEventListener(event, handler);
        } else {
            console.warn(`Element ${elementId} not found`);
        }
    }

    /**
     * Render current view (main rendering method)
     */
    renderCurrentView() {
        switch (this.currentView) {
            case 'rules':
                this.renderRules();
                break;
            case 'settings':
                this.renderSettings();
                break;
            case 'about':
                this.renderAbout();
                break;
            default:
                this.renderRules();
        }
    }

    /**
     * Render rules list
     */
    renderRules() {
        const container = document.getElementById('rulesContainer');
        if (!container) return;

        if (this.filteredRules.length === 0) {
            container.innerHTML = this.getEmptyStateHTML();
            return;
        }

        // Q-4: one malformed rule (e.g. from a hand-edited storage entry, or
        // a future schema change) throwing inside getRuleCardHTML previously
        // took the whole .map() down with it, leaving the entire rule list
        // blank with no way to recover except deleting all rules via
        // devtools. Render each card independently so one bad rule becomes
        // an inline error placeholder instead of an empty popup.
        container.innerHTML = this.filteredRules
            .map(rule => {
                try {
                    return this.getRuleCardHTML(rule);
                } catch (error) {
                    console.error('Failed to render rule card:', rule && rule.id, error);
                    const safeId = this.escapeHtml((rule && rule.id) || '');
                    return `<div class="rule-card rule-card-error" data-rule-id="${safeId}" role="listitem">
                        <div class="rule-details">⚠ This rule could not be displayed (${this.escapeHtml(error.message)}).
                        <button class="rule-action" data-action="delete" data-rule-id="${safeId}">Delete it</button></div>
                    </div>`;
                }
            })
            .join('');

        // Attach event listeners to newly rendered cards
        this.attachRuleEventListeners();
    }

    /**
     * Get HTML for a rule card
     */
    getRuleCardHTML(rule) {
        const statusIcon = this.getStatusIcon(rule.testStatus || 'pending');

        // S-5/Q-22: an imported/hand-edited rule can set match.method or
        // rule.id to arbitrary strings. Deriving a CSS class name or an
        // unescaped attribute value directly from them would let a crafted
        // rule break out of an attribute or inject markup. Restrict the
        // class derivation to a known-safe set and fall back to a generic
        // class for anything else; escape every other rule-derived value
        // that lands in an attribute or text position.
        const KNOWN_METHODS = ['get', 'post', 'put', 'delete', 'patch', '*'];
        const rawMethod = (rule.match && rule.match.method) || 'GET';
        const methodLower = String(rawMethod).toLowerCase();
        const methodClass = KNOWN_METHODS.includes(methodLower) ? `method-${methodLower}` : 'method-other';
        const safeMethod = this.escapeHtml(rawMethod);

        const enabledClass = rule.enabled ? '' : 'disabled';
        const checkedClass = rule.enabled ? 'checked' : '';

        // Safely escape HTML
        const safeName = this.escapeHtml(rule.name || 'Unnamed Rule');
        const safeUrl = this.escapeHtml((rule.match && rule.match.url) || '');
        const safeId = this.escapeHtml(rule.id);

        return `
            <div class="rule-card ${enabledClass}" data-rule-id="${safeId}" role="listitem">
                <div class="rule-header">
                    <div class="rule-info">
                        <div class="rule-name">
                            <div class="rule-checkbox ${checkedClass}"
                                 data-rule-id="${safeId}"
                                 role="checkbox"
                                 aria-checked="${rule.enabled ? 'true' : 'false'}"
                                 tabindex="0"
                                 aria-label="Enable rule: ${safeName}"></div>
                            ${safeName}
                            ${this.getRuleTypeBadgeHTML(rule)}
                        </div>
                        <div class="rule-details">
                            <span class="rule-method ${methodClass}">${safeMethod}</span>
                            ${safeUrl} → ${this.getRuleSummaryText(rule)}
                        </div>
                    </div>
                    <div class="status-indicator" title="${this.escapeHtml(this.getStatusTooltip(rule.testStatus || 'pending'))}">${statusIcon}</div>
                </div>
                <div class="rule-actions">
                    <button class="rule-action" title="Edit" data-action="edit" data-rule-id="${safeId}" aria-label="Edit rule">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                    </button>
                    <button class="rule-action" title="Duplicate" data-action="copy" data-rule-id="${safeId}" aria-label="Duplicate rule">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                    <button class="rule-action" title="Test" data-action="test" data-rule-id="${safeId}" aria-label="Test rule">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
                    </button>
                    <button class="rule-action" title="Delete" data-action="delete" data-rule-id="${safeId}" aria-label="Delete rule">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * Get the rule-type badge markup for a rule row.
     * Contract shared with options/* (G5): `<span class="rule-type-badge" data-type="TYPE">LABEL</span>`.
     * TYPE defaults to 'mock' for legacy (v1) rules with no `type` field.
     */
    getRuleTypeBadgeHTML(rule) {
        const type = rule.type || 'mock';
        const labels = {
            mock: 'Mock',
            block: 'Block',
            delay: 'Delay',
            redirect: 'Redirect',
            headers: 'Headers',
            queryparams: 'Query Params'
        };
        // S-5/Q-22: `type` is placed in a `data-type="..."` attribute. An
        // imported rule with an arbitrary `type` string could otherwise break
        // out of the attribute. Restrict what's actually rendered to the
        // known type keys — anything else (which is already invalid per the
        // v2 schema) falls back to 'mock' for both the class hook and label.
        const safeType = Object.prototype.hasOwnProperty.call(labels, type) ? type : 'mock';
        const label = labels[safeType];
        return `<span class="rule-type-badge" data-type="${safeType}">${label}</span>`;
    }

    /**
     * Get the short human-readable summary shown after the URL in a rule row.
     * Guards on `rule.response` since only `type: 'mock'` rules have a response
     * object in the v2 schema (block/delay/redirect/headers/queryparams do not).
     */
    getRuleSummaryText(rule) {
        const type = rule.type || 'mock';

        switch (type) {
            case 'block':
                return 'Blocked';
            case 'delay':
                return `Delayed ${rule.delayMs || 0}ms`;
            case 'redirect':
                return this.escapeHtml(rule.redirect?.destination || '(no destination)');
            case 'headers':
                return 'Modify headers';
            case 'queryparams':
                return 'Modify query params';
            case 'mock':
            default: {
                if (!rule.response) return '200 OK';
                const delaySuffix = rule.response.delay ? ` (+${rule.response.delay}ms)` : '';
                return `${rule.response.statusCode || 200} ${rule.response.statusText || 'OK'}${delaySuffix}`;
            }
        }
    }

    /**
     * Get empty state HTML
     */
    getEmptyStateHTML() {
        const searchTerm = document.getElementById('searchInput')?.value;
        
        if (searchTerm) {
            return `
                <div class="empty-state">
                    <div class="empty-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    </div>
                    <h3>No matching rules</h3>
                    <p>No rules found matching "${this.escapeHtml(searchTerm)}"</p>
                </div>
            `;
        }

        return `
            <div class="empty-state">
                <div class="empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2"/><path d="M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M9 12h6"/></svg>
                </div>
                <h3>No rules yet</h3>
                <p>Create your first mock rule to get started. Click the + button below.</p>
            </div>
        `;
    }

    /**
     * Attach event listeners to rule cards
     */
    attachRuleEventListeners() {
        // Rule checkboxes
        document.querySelectorAll('.rule-checkbox').forEach(checkbox => {
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleRule(e);
            });
            
            // Keyboard support
            checkbox.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.toggleRule(e);
                }
            });
        });

        // Rule cards (click to edit)
        document.querySelectorAll('.rule-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (!e.target.closest('.rule-checkbox') && !e.target.closest('.rule-action')) {
                    this.editRule(card.dataset.ruleId);
                }
            });
        });

        // Rule action buttons
        document.querySelectorAll('.rule-action').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.handleRuleAction(e);
            });
        });
    }

    /**
     * Handle rule checkbox toggle
     */
    async toggleRule(e) {
        const ruleId = e.target.dataset.ruleId;
        const rule = this.rules.find(r => r.id === ruleId);

        if (!rule) return;

        const newEnabled = !rule.enabled;

        try {
            const response = await this.sendMessage({
                type: 'toggleRule',
                ruleId: ruleId,
                enabled: newEnabled
            });

            if (response && response.success) {
                rule.enabled = newEnabled;
                rule.lastModified = new Date().toISOString();

                e.target.classList.toggle('checked', rule.enabled);
                e.target.setAttribute('aria-checked', rule.enabled);

                const card = e.target.closest('.rule-card');
                if (card) {
                    card.classList.toggle('disabled', !rule.enabled);
                }

                this.updateStatus();
                this.showNotification(`Rule ${rule.enabled ? 'enabled' : 'disabled'}`);
            } else {
                this.showError('Failed to update rule');
            }
        } catch (error) {
            console.error('Failed to toggle rule:', error);
            this.showError('Failed to update rule');
        }
    }

    /**
     * Handle rule action buttons
     */
    async handleRuleAction(e) {
        const action = e.target.dataset.action || e.target.closest('[data-action]')?.dataset.action;
        const ruleId = e.target.dataset.ruleId || e.target.closest('[data-rule-id]')?.dataset.ruleId;

        if (!action || !ruleId) return;

        switch (action) {
            case 'edit':
                await this.editRule(ruleId);
                break;
            case 'copy':
                await this.copyRule(ruleId);
                break;
            case 'test':
                await this.testRule(ruleId);
                break;
            case 'delete':
                await this.deleteRule(ruleId);
                break;
        }
    }

    /**
     * Edit rule
     */
    async editRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        const opened = await this.openRuleOverlay({ mode: 'edit', rule });
        if (!opened) {
            // Overlay can't be injected here (chrome://, Web Store, PDF viewer,
            // etc.) — fall back to the full options editor in a tab.
            await chrome.tabs.create({
                url: chrome.runtime.getURL(`options/options.html?editRule=${ruleId}`)
            });
        }
        window.close();
    }

    /**
     * Ask the active tab's content script to show the in-page rule editor.
     * Returns false if the overlay could not be opened there.
     */
    async openRuleOverlay(payload) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) {
                return false;
            }

            let prefillUrl;
            try {
                prefillUrl = `*${new URL(tab.url).host}*`;
            } catch (e) {
                prefillUrl = undefined;
            }

            const response = await chrome.tabs.sendMessage(tab.id, {
                type: 'openRuleOverlay',
                prefillUrl,
                ...payload
            });

            return !!(response && response.success);
        } catch (error) {
            // No content script on this page (or it hasn't loaded yet).
            return false;
        }
    }

    /**
     * Copy rule
     */
    async copyRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        try {
            const newRule = this.deepClone(rule);
            newRule.id = this.generateId();
            newRule.name = `${rule.name} (Copy)`;
            newRule.enabled = false;
            newRule.created = new Date().toISOString();

            const response = await this.sendMessage({
                type: 'saveRule',
                rule: newRule
            });

            if (response && response.success) {
                await this.loadData();
                this.renderRules();
                this.updateStatus();
                this.showNotification('Rule duplicated');
            } else {
                this.showError('Failed to duplicate rule');
            }
        } catch (error) {
            console.error('Failed to copy rule:', error);
            this.showError('Failed to duplicate rule');
        }
    }

    /**
     * Test rule
     */
    async testRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        try {
            const card = document.querySelector(`[data-rule-id="${ruleId}"]`);
            const statusIndicator = card?.querySelector('.status-indicator');
            const originalIcon = statusIndicator?.textContent;
            
            if (statusIndicator) {
                statusIndicator.textContent = '⏳';
            }

            const response = await this.sendMessage({
                type: 'testRule',
                rule: rule
            });

            if (response && response.success) {
                rule.testStatus = response.passed ? 'passed' : 'failed';
                
                if (statusIndicator) {
                    statusIndicator.textContent = this.getStatusIcon(rule.testStatus);
                    statusIndicator.title = this.getStatusTooltip(rule.testStatus);
                }

                this.showNotification(`Test ${response.passed ? 'passed' : 'failed'}`);
            } else {
                if (statusIndicator && originalIcon) {
                    statusIndicator.textContent = originalIcon;
                }
                this.showError('Test failed');
            }

        } catch (error) {
            console.error('Test failed:', error);
            this.showError('Test failed');
        }
    }

    /**
     * Delete rule
     */
    async deleteRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        if (!confirm(`Delete "${rule.name}"?\n\nThis cannot be undone.`)) {
            return;
        }

        try {
            const response = await this.sendMessage({
                type: 'deleteRule',
                ruleId: ruleId
            });

            if (response && response.success) {
                await this.loadData();
                this.renderRules();
                this.updateStatus();
                this.showNotification('Rule deleted');
            } else {
                this.showError('Failed to delete rule');
            }
        } catch (error) {
            console.error('Failed to delete rule:', error);
            this.showError('Failed to delete rule');
        }
    }

    /**
     * Handle search input
     */
    handleSearch(e) {
        const searchTerm = e.target.value.toLowerCase().trim();

        if (!searchTerm) {
            this.filteredRules = [...this.rules];
        } else {
            this.filteredRules = this.rules.filter(rule =>
                (rule.name || '').toLowerCase().includes(searchTerm) ||
                (rule.match.url || '').toLowerCase().includes(searchTerm) ||
                (rule.match.method || '').toLowerCase().includes(searchTerm)
            );
        }

        this.renderRules();
    }

    /**
     * Create new rule
     */
    async createNewRule() {
        const opened = await this.openRuleOverlay({ mode: 'new' });
        if (!opened) {
            // Not injectable on this page — fall back to the options tab.
            await chrome.tabs.create({
                url: chrome.runtime.getURL('options/options.html?action=new')
            });
        }
        window.close();
    }

    /**
     * Test all rules
     */
    async testAllRules() {
        const enabledRules = this.rules.filter(r => r.enabled);

        if (enabledRules.length === 0) {
            this.showNotification('No enabled rules to test');
            return;
        }

        const testBtn = document.getElementById('testAllBtn');
        if (!testBtn) return;
        
        const originalText = testBtn.textContent;
        testBtn.textContent = '⏳';
        testBtn.disabled = true;

        try {
            let passed = 0;
            let failed = 0;

            for (const rule of enabledRules) {
                const response = await this.sendMessage({
                    type: 'testRule',
                    rule: rule
                });

                if (response && response.success) {
                    rule.testStatus = response.passed ? 'passed' : 'failed';
                    if (response.passed) passed++;
                    else failed++;
                }

                await this.delay(200);
            }

            this.renderRules();
            this.showNotification(`Tests: ${passed} passed, ${failed} failed`);
        } catch (error) {
            this.showError('Testing failed');
        } finally {
            testBtn.textContent = originalText;
            testBtn.disabled = false;
        }
    }

    /**
     * Toggle global extension status
     */
    async toggleGlobalStatus() {
        try {
            const response = await this.sendMessage({
                type: 'toggleExtension',
                active: !this.isActive
            });

            if (response && response.success) {
                this.isActive = response.active;
                this.updateStatus();
                this.showNotification(`Extension ${this.isActive ? 'enabled' : 'disabled'}`);
            } else {
                this.showError('Failed to toggle extension');
            }
        } catch (error) {
            console.error('Failed to toggle extension:', error);
            this.showError('Failed to toggle extension');
        }
    }

    /**
     * Update status display
     */
    updateStatus() {
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        
        if (!statusDot || !statusText) return;
        
        const enabledCount = this.rules.filter(r => r.enabled).length;

        // Update body class for CSS styling
        document.body.classList.toggle('is-active', this.isActive && enabledCount > 0);

        if (this.isActive && enabledCount > 0) {
            statusText.textContent = `Active (${enabledCount})`;
        } else if (!this.isActive) {
            statusText.textContent = 'Disabled';
        } else {
            statusText.textContent = 'No rules';
        }
    }

    /**
     * Update stats display
     */
    updateStats() {
        const statsText = document.getElementById('statsText');
        if (statsText) {
            const count = this.stats.intercepted || 0;
            statsText.textContent = `${count} ${count === 1 ? 'intercept' : 'intercepts'}`;
        }
    }

    /**
     * Open settings
     */
    openSettings() {
        chrome.runtime.openOptionsPage();
        window.close();
    }

    /**
     * Refresh data
     */
    async refreshData() {
        const refreshBtn = document.getElementById('refreshBtn');
        if (!refreshBtn) return;
        
        const originalText = refreshBtn.textContent;

        try {
            refreshBtn.textContent = '⏳';
            refreshBtn.disabled = true;

            await this.loadData();
            this.renderCurrentView();
            this.updateStatus();
            this.updateStats();

            this.showNotification('Refreshed');
        } catch (error) {
            this.showError('Failed to refresh');
        } finally {
            refreshBtn.textContent = originalText;
            refreshBtn.disabled = false;
        }
    }

    /**
     * Handle keyboard shortcuts
     */
    handleKeyboardShortcuts(e) {
        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'n':
                    e.preventDefault();
                    this.createNewRule();
                    break;
                case 'f':
                    e.preventDefault();
                    document.getElementById('searchInput')?.focus();
                    break;
                case 't':
                    e.preventDefault();
                    this.testAllRules();
                    break;
                case 'r':
                    e.preventDefault();
                    this.refreshData();
                    break;
            }
        } else if (e.key === 'Escape') {
            window.close();
        }
    }

    /**
     * Utility: Get status icon
     */
    getStatusIcon(status) {
        const icons = {
            passed: `<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>`,
            failed: `<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>`,
            warning: `<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
            pending: `<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
            never: `<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`
        };
        return icons[status] || icons.pending;
    }

    /**
     * Utility: Get status tooltip
     */
    getStatusTooltip(status) {
        const tooltips = {
            passed: 'Test passed',
            failed: 'Test failed',
            warning: 'Test passed with warnings',
            pending: 'Not tested',
            never: 'Never tested'
        };
        return tooltips[status] || 'Unknown';
    }

    /**
     * Utility: Show notification
     */
    showNotification(message) {
        this.createToast(message, 'success');
    }

    /**
     * Utility: Show error
     */
    showError(message) {
        this.createToast(message, 'error');
    }

    /**
     * Utility: Create toast notification
     */
    createToast(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        
        Object.assign(toast.style, {
            position: 'fixed',
            top: '10px',
            right: '10px',
            background: type === 'error' ? '#dc2626' : '#16a34a',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: '500',
            zIndex: '10000',
            maxWidth: '200px',
            wordWrap: 'break-word',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            animation: 'slideInRight 0.3s ease-out'
        });

        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOutRight 0.3s ease-out';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    /**
     * Utility: Send message to background
     */
    async sendMessage(message) {
        try {
            return await chrome.runtime.sendMessage(message);
        } catch (error) {
            console.error('Message failed:', error);
            return null;
        }
    }

    /**
     * Utility: Escape HTML for both text-node and attribute-value contexts.
     * S-6: the previous `div.textContent = x; return div.innerHTML` idiom
     * escapes `& < >` but NOT quote characters — this function's output is
     * placed inside HTML attributes (`aria-label="..."`, `data-rule-id="..."`)
     * throughout getRuleCardHTML, so an unescaped `"` in a rule's name/id
     * (e.g. from an imported rules JSON) could break out of the attribute
     * and inject arbitrary markup/attributes.
     */
    escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Utility: Deep clone
     */
    deepClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    /**
     * Utility: Generate ID
     */
    generateId() {
        return `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Utility: Delay
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.turboMockPopup = new TurboMockPopup();
    });
} else {
    window.turboMockPopup = new TurboMockPopup();
}