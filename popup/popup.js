/**
 * SpliceTap Extension - Enhanced Popup JavaScript
 * Fixed version with working navigation and proper state management
 */

// U-12: the theme class used to only get applied after the async loadData()
// round-trip resolved inside init(), so every popup open flashed the dark
// default (or, on options.html, a hard-coded dark class) for the duration
// of the round-trip. Apply the last-known theme synchronously, before the
// class below does anything, from this extension origin's own localStorage
// (persisted by applyTheme() every time it resolves the real setting).
(function applyCachedThemeEarly() {
    try {
        const cached = window.localStorage.getItem('tm-theme');
        if (cached === 'dark' || cached === 'light') {
            document.body.classList.add(`theme-${cached}`);
        }
    } catch (error) {
        // localStorage unavailable — applyTheme() will still run once
        // loadData() resolves.
    }
})();

class SpliceTapPopup {
    constructor() {
        this.rules = [];
        this.filteredRules = [];
        this.isActive = true;
        this.stats = { intercepted: 0, rulesCount: 0 };
        this.settings = {};
        this.searchTerm = '';
        this.searchClearBtn = null;
        this.siteAccessOrigin = null;

        this.init();
    }

    /**
     * Initialize the popup
     */
    async init() {
        try {
            // U-14: show a neutral loading state immediately instead of the
            // static "No rules yet" empty-state markup shipped in the HTML,
            // which otherwise briefly (and misleadingly) claims a user with
            // 20 rules has none, on every single popup open.
            this.showLoadingState();

            this.setupEventListeners();
            this.setupSearchEnhancements();

            await this.loadData();
            // U-12: moved out of loadData()'s success branch so the real
            // theme is always applied — including when the background is
            // cold/unreachable, where the popup previously stayed stuck in
            // the dark default regardless of the user's setting.
            this.applyTheme();

            // C-17: surface (rather than silently work around) the case
            // where the user has downgraded this tab's site access from
            // chrome://extensions.
            await this.checkSiteAccess();

            this.renderCurrentView();
            this.updateStatus();
            this.updateStats();
            this.updateTabCount();
            this.renderSettings();
            this.addShortcutHints();

            // NOTE: the popup must NOT clear the badge. It used to, back when
            // the badge was a one-off "NEW" install hint. The badge now shows
            // live state — enabled-rule count, OFF, or the red CHAOS warning —
            // and clearing it here would silently erase exactly the warning
            // that stops someone debugging an unrelated site while chaos mode
            // randomly fails their requests. The background owns it.

            // Animate popup entrance
            document.body.classList.add('loaded');
            console.log('SpliceTap popup initialized');
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

        // U-12: cache the resolved theme so the next popup open can apply it
        // synchronously (see applyCachedThemeEarly() above) instead of
        // waiting on the background round-trip.
        try {
            window.localStorage.setItem('tm-theme', resolved);
        } catch (error) {
            // localStorage unavailable — nothing to do, just skip the cache.
        }
    }

    /**
     * C-17: check whether the current tab's site access has been withheld
     * (the user set "On click"/"On specific sites" for this extension from
     * chrome://extensions) and surface it explicitly instead of letting
     * editRule()/createNewRule() silently fall back to the options tab with
     * no explanation.
     */
    async checkSiteAccess() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
                // chrome://, the Web Store, PDF viewer, etc. — not a site the
                // permission model applies to; nothing to request here.
                this.siteAccessOrigin = null;
            } else {
                const origin = `${new URL(tab.url).origin}/*`;
                const hasAccess = await chrome.permissions.contains({ origins: [origin] });
                this.siteAccessOrigin = hasAccess ? null : origin;
            }
        } catch (error) {
            console.error('Failed to check site access:', error);
            this.siteAccessOrigin = null;
        }

        this.renderSiteAccessNotice();
    }

    /**
     * Render (or clear) the "SpliceTap doesn't have access to this site"
     * banner based on this.siteAccessOrigin.
     */
    renderSiteAccessNotice() {
        const existing = document.getElementById('siteAccessNotice');
        if (existing) existing.remove();

        if (!this.siteAccessOrigin) return;

        const wrapper = document.querySelector('.search-wrapper');
        if (!wrapper || !wrapper.parentNode) return;

        const notice = document.createElement('div');
        notice.id = 'siteAccessNotice';
        notice.className = 'site-access-notice';
        notice.setAttribute('role', 'note');

        const text = document.createElement('span');
        text.textContent = "SpliceTap doesn't have access to this site.";
        notice.appendChild(text);

        const grantBtn = document.createElement('button');
        grantBtn.type = 'button';
        grantBtn.className = 'site-access-grant-btn';
        grantBtn.textContent = 'Grant access';
        grantBtn.addEventListener('click', () => this.requestSiteAccess());
        notice.appendChild(grantBtn);

        wrapper.parentNode.insertBefore(notice, wrapper.nextSibling);
    }

    /**
     * Ask Chrome to re-grant the withheld host permission for the current
     * tab's origin (already covered by manifest.json's mandatory
     * `host_permissions: ["<all_urls>"]` — this re-requests access the user
     * previously turned off for this site specifically, it doesn't expand
     * what the extension can ask for).
     */
    async requestSiteAccess() {
        if (!this.siteAccessOrigin) return;

        try {
            const granted = await chrome.permissions.request({ origins: [this.siteAccessOrigin] });
            if (granted) {
                this.siteAccessOrigin = null;
                this.renderSiteAccessNotice();
                this.showNotification('Access granted for this site');
            } else {
                this.showError('Access request was denied');
            }
        } catch (error) {
            console.error('Failed to request site access:', error);
            this.showError('Could not request site access');
        }
    }

    /**
     * Setup all event listeners
     */
    setupEventListeners() {
        // Tabs
        this.addListener('tabRules', 'click', () => this.switchTab('rules'));
        this.addListener('tabSettings', 'click', () => this.switchTab('settings'));
        this.addListener('tabData', 'click', () => this.switchTab('data'));

        // A11Y-8: role="tablist" promises arrow-key movement between tabs
        // (ARIA Authoring Practices). Click-only left the widget behaving
        // differently from how its role tells assistive tech it behaves.
        const tabStrip = document.querySelector('.tabs');
        if (tabStrip) {
            const handler = (e) => this.handleTabKeydown(e);
            tabStrip.addEventListener('keydown', handler);
            this.listeners.push({ element: tabStrip, event: 'keydown', handler });
        }

        // Settings pane — each control persists immediately (there is no
        // Save button in the popup), then notifies the background so the
        // interceptor picks the change up on its next syncState.
        this.addListeners('input[name="theme"]', 'change', (e) => {
            if (!e.target.checked) return;
            this.settings.theme = e.target.value;
            this.applyTheme();
            this.saveSettings();
        });
        this.addListener('debugMode', 'change', (e) => {
            this.settings.debugMode = e.target.checked;
            this.saveSettings();
        });
        this.addListener('chaosModeEnabled', 'change', (e) => {
            if (!this.settings.chaosMode) this.settings.chaosMode = {};
            this.settings.chaosMode.enabled = e.target.checked;
            this.updateChaosRateState();
            this.saveSettings();
        });
        this.addListener('chaosFailureRate', 'change', (e) => {
            const percent = parseFloat(e.target.value);
            if (isNaN(percent) || percent < 1 || percent > 100) {
                // Snap back to the stored value rather than persisting junk.
                e.target.value = Math.round(((this.settings.chaosMode || {}).failureRate || 0.1) * 100);
                return;
            }
            if (!this.settings.chaosMode) this.settings.chaosMode = {};
            this.settings.chaosMode.failureRate = percent / 100;
            this.saveSettings();
        });
        // Capture
        this.addListener('captureArmed', 'change', (e) => this.setCaptureArmed(e.target.checked));
        this.addListener('clearCapturesBtn', 'click', async () => {
            await this.sendMessage({ type: 'clearCaptures' });
            this.renderCaptureSection();
        });

        // Data management (moved out of the options page)
        this.addListener('exportRulesBtn', 'click', () => this.exportRules());
        this.addListener('importToggleBtn', 'click', () => this.togglePanel('importPanel', 'importToggleBtn'));
        this.addListener('importCancelBtn', 'click', () => this.togglePanel('importPanel', 'importToggleBtn', false));
        this.addListener('importConfirmBtn', 'click', () => this.confirmImport());
        this.addListener('resetAllBtn', 'click', () => this.togglePanel('resetPanel', 'resetAllBtn'));
        this.addListener('resetCancelBtn', 'click', () => this.togglePanel('resetPanel', 'resetAllBtn', false));
        this.addListener('resetConfirmBtn', 'click', () => this.confirmReset());

        // Header actions
        this.addListener('refreshBtn', 'click', () => this.refreshData());
        
        // Search
        this.addListener('searchInput', 'input', (e) => this.handleSearch(e));
        
        // Footer actions
        this.addListener('newRuleBtn', 'click', () => this.createNewRule());
        this.addListener('toggleAllBtn', 'click', () => this.toggleAllRules());
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
     * Attach the same handler to every match of a selector (e.g. a radio
     * group). Silent when nothing matches — callers treat that as "this
     * control isn't on this surface".
     */
    addListeners(selector, event, handler) {
        document.querySelectorAll(selector).forEach(el => el.addEventListener(event, handler));
    }

    /**
     * U-15: create the search clear (x) button and the "N of M rules"
     * result-count element at runtime (popup.html ships neither) and wire
     * the clear button up.
     */
    setupSearchEnhancements() {
        const bar = document.querySelector('.search-bar');
        const wrapper = document.querySelector('.search-wrapper');
        const input = document.getElementById('searchInput');
        if (!bar || !wrapper || !input) return;

        if (!document.getElementById('searchClearBtn')) {
            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.id = 'searchClearBtn';
            clearBtn.className = 'search-clear-btn';
            clearBtn.setAttribute('aria-label', 'Clear search');
            clearBtn.title = 'Clear search';
            clearBtn.hidden = true;
            clearBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
            clearBtn.addEventListener('click', () => {
                input.value = '';
                this.searchTerm = '';
                clearBtn.hidden = true;
                this.applySearchFilter();
                input.focus();
            });
            bar.appendChild(clearBtn);
            this.searchClearBtn = clearBtn;
        }

        if (!document.getElementById('searchResultCount')) {
            const countEl = document.createElement('div');
            countEl.id = 'searchResultCount';
            countEl.className = 'search-result-count';
            countEl.hidden = true;
            wrapper.appendChild(countEl);
        }
    }

    /**
     * U-16: the popup captures Ctrl+F/N/T/R with no on-screen hint that it
     * does so. Doesn't change behaviour — just makes the existing shortcuts
     * discoverable via the tooltip/accessible name every button already has.
     */
    addShortcutHints() {
        const hints = [
            ['newRuleBtn', 'New Rule (Ctrl+N)'],
            ['testAllBtn', 'Test all rules (Ctrl+T)'],
            ['refreshBtn', 'Refresh rules (Ctrl+R)']
        ];
        hints.forEach(([id, label]) => {
            const el = document.getElementById(id);
            if (el) {
                el.title = label;
                el.setAttribute('aria-label', label);
            }
        });

        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.title = 'Search rules (Ctrl+F)';
        }
    }

    /**
     * Render current view (main rendering method)
     */
    renderCurrentView() {
        // G-17: `renderSettings`/`renderAbout` were dead branches — nothing
        // in the file ever sets `currentView` to anything but 'rules', so
        // they were unreachable code that referenced two methods that don't
        // exist anywhere in this file (a TypeError waiting on any future
        // change). The popup only ever has one view.
        this.renderRules();
    }

    /**
     * U-14: neutral loading state shown while the initial loadData()
     * round-trip is in flight, instead of the static "No rules yet"
     * empty-state markup shipped in popup.html.
     */
    showLoadingState() {
        const container = document.getElementById('rulesContainer');
        if (container) {
            container.innerHTML = this.getLoadingStateHTML();
        }
    }

    getLoadingStateHTML() {
        return `
            <div class="loading-state" aria-hidden="true">
                <div class="skeleton-card"></div>
                <div class="skeleton-card"></div>
                <div class="skeleton-card"></div>
            </div>
        `;
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
        // U-17: `.method-*` is not a valid CSS selector, so the "Any (*)"
        // method badge silently rendered with no pill. Emit a sanitised
        // `method-any` class for it instead, and `method-other` for anything
        // outside the known-method allowlist (e.g. OPTIONS/HEAD).
        const KNOWN_METHODS = ['get', 'post', 'put', 'delete', 'patch'];
        const rawMethod = (rule.match && rule.match.method) || 'GET';
        const methodLower = String(rawMethod).toLowerCase();
        const methodClass = methodLower === '*'
            ? 'method-any'
            : (KNOWN_METHODS.includes(methodLower) ? `method-${methodLower}` : 'method-other');
        const safeMethod = this.escapeHtml(rawMethod);

        const enabledClass = rule.enabled ? '' : 'disabled';
        const checkedClass = rule.enabled ? 'checked' : '';

        // Safely escape HTML
        const safeName = this.escapeHtml(rule.name || 'Unnamed Rule');
        const safeUrl = this.escapeHtml((rule.match && rule.match.url) || '');
        const safeId = this.escapeHtml(rule.id);

        // A-9: the status glyph's only text alternative used to be a `title`
        // on a plain, non-focusable `div` — not reliably exposed by screen
        // readers and unreachable by keyboard. role="img" + aria-label makes
        // it a real accessible-name-bearing node; the inner SVG (from
        // getStatusIcon()) is aria-hidden so it isn't announced twice.
        const statusTooltip = this.escapeHtml(this.getStatusTooltip(rule.testStatus || 'pending'));

        // A-12: disabled rules used to be signalled purely by `opacity: 0.5`
        // + `grayscale()`, which dropped several text pairs under 4.5:1.
        // Add an explicit "Disabled" chip instead of relying on dimming.
        const disabledChip = rule.enabled ? '' : '<span class="disabled-chip">Disabled</span>';

        return `
            <div class="rule-card ${enabledClass}" data-rule-id="${safeId}" role="listitem" tabindex="0" aria-label="Edit ${safeName}">
                <div class="rule-header">
                    <div class="rule-info">
                        <div class="rule-name">
                            <div class="rule-checkbox ${checkedClass}"
                                 data-rule-id="${safeId}"
                                 role="checkbox"
                                 aria-checked="${rule.enabled ? 'true' : 'false'}"
                                 tabindex="0"
                                 aria-label="${safeName}"></div>
                            ${safeName}
                            ${disabledChip}
                            ${this.getRuleTypeBadgeHTML(rule)}
                        </div>
                        <div class="rule-details">
                            <span class="rule-method ${methodClass}">${safeMethod}</span>
                            ${safeUrl} → ${this.getRuleSummaryText(rule)}
                            ${this.getHitCountHTML(rule)}
                        </div>
                    </div>
                    <div class="status-indicator" role="img" aria-label="${statusTooltip}" title="${statusTooltip}">${statusIcon}</div>
                </div>
                <div class="rule-actions">
                    ${this.getReorderHTML(safeId)}
                    <button class="rule-action" title="Edit" data-action="edit" data-rule-id="${safeId}" aria-label="Edit rule">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                    </button>
                    <button class="rule-action" title="Duplicate" data-action="copy" data-rule-id="${safeId}" aria-label="Duplicate rule">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                    <button class="rule-action" title="Test" data-action="test" data-rule-id="${safeId}" aria-label="Test rule">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>
                    </button>
                    <button class="rule-action" title="Delete" data-action="delete" data-rule-id="${safeId}" aria-label="Delete rule">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * A11Y-8: Left/Right move between tabs, Home/End jump to the ends —
     * the interaction model the ARIA tabs pattern specifies. Selection follows
     * focus, which is the expected behaviour when switching panels is cheap.
     */
    handleTabKeydown(e) {
        const order = ['rules', 'data', 'settings'];
        const ids = { rules: 'tabRules', data: 'tabData', settings: 'tabSettings' };

        const current = order.findIndex((name) => {
            const el = document.getElementById(ids[name]);
            return el && el.getAttribute('aria-selected') === 'true';
        });
        if (current < 0) return;

        let next = null;
        if (e.key === 'ArrowRight') next = (current + 1) % order.length;
        else if (e.key === 'ArrowLeft') next = (current - 1 + order.length) % order.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = order.length - 1;
        else return;

        e.preventDefault();
        const name = order[next];
        this.switchTab(name);
        const el = document.getElementById(ids[name]);
        if (el) el.focus();
    }

    /**
     * A11Y-4: after a list-mutating action destroys the focused control,
     * move focus somewhere sensible rather than letting it fall to <body>.
     * Prefers the first remaining rule card, then the New rule button.
     */
    restoreListFocus() {
        const firstCard = document.querySelector('.rule-card');
        if (firstCard) {
            firstCard.focus();
            return;
        }
        const newRule = document.getElementById('newRuleBtn');
        if (newRule) newRule.focus();
    }

    /**
     * Reorder controls, omitted while a search filter is active.
     *
     * Position is precedence, but a filtered list shows a subset in which
     * "up" would move a rule past rules the user cannot currently see —
     * looking like nothing happened, or worse, like it moved the wrong way.
     * Rather than reorder within a filtered view (which cannot express the
     * real array), the controls only appear on the unfiltered list.
     */
    getReorderHTML(safeId) {
        if (this.searchTerm) return '';
        return `
                    <button class="rule-action" title="Move up — matched before the rules below it" data-action="move-up" data-rule-id="${safeId}" aria-label="Move rule up">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m18 15-6-6-6 6"/></svg>
                    </button>
                    <button class="rule-action" title="Move down — matched after the rules above it" data-action="move-down" data-rule-id="${safeId}" aria-label="Move rule down">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>
                    </button>`;
    }

    /**
     * PROD-8: enable or disable every rule at once.
     *
     * Previously the only options were the global on/off switch — which is
     * all-or-nothing and also stops chaos mode and capture — or clicking each
     * rule individually. Direction is inferred: if anything is enabled, this
     * disables everything; otherwise it enables everything. That matches what
     * the single visible affordance is for at any moment.
     */
    async toggleAllRules() {
        try {
            const fresh = await this.sendMessage({ type: 'getRules' });
            const rules = (fresh && fresh.success && Array.isArray(fresh.rules))
                ? fresh.rules
                : (this.rules || []);

            if (!rules.length) {
                this.showError('No rules to toggle');
                return;
            }

            const anyEnabled = rules.some((r) => r && r.enabled);
            const next = rules.map((r) => ({ ...r, enabled: !anyEnabled }));

            const response = await this.sendMessage({ type: 'setRules', rules: next });
            if (!response || !response.success) {
                this.showError((response && response.error) || 'Could not update rules');
                return;
            }

            this.rules = response.rules || next;
            this.applySearchFilter();
            this.updateStatus();
            this.updateTabCount();
            this.showNotification(anyEnabled
                ? `Disabled ${rules.length} rule${rules.length === 1 ? '' : 's'}`
                : `Enabled ${rules.length} rule${rules.length === 1 ? '' : 's'}`);
        } catch (error) {
            console.error('Failed to toggle all rules:', error);
            this.showError('Could not update rules');
        }
    }

    /**
     * PROD-4: move a rule one position earlier or later.
     *
     * For interceptor-handled types the FIRST matching rule in array order
     * wins, so array position is the precedence control — but there was no way
     * to change it short of deleting and recreating a rule, or hand-editing an
     * exported JSON file. The moment two rules can match the same request, that
     * made overlapping rules unmanageable.
     *
     * Reorders against the authoritative list from the background rather than
     * this popup's snapshot, which may predate a rule added from the overlay
     * while the popup was open, and persists via the bulk path so the whole
     * order is written atomically.
     */
    async moveRule(ruleId, delta) {
        try {
            const fresh = await this.sendMessage({ type: 'getRules' });
            const rules = (fresh && fresh.success && Array.isArray(fresh.rules))
                ? fresh.rules
                : (this.rules || []);

            const from = rules.findIndex((r) => r && r.id === ruleId);
            if (from < 0) return;

            const to = from + delta;
            if (to < 0 || to >= rules.length) return; // already at an end

            const reordered = rules.slice();
            const [moved] = reordered.splice(from, 1);
            reordered.splice(to, 0, moved);

            const response = await this.sendMessage({ type: 'setRules', rules: reordered });
            if (!response || !response.success) {
                this.showError((response && response.error) || 'Could not reorder rules');
                return;
            }

            this.rules = response.rules || reordered;
            this.applySearchFilter();
            this.updateTabCount();

            // Keep focus on the button that was pressed — renderRules() rebuilds
            // the list wholesale, which would otherwise drop focus to <body> and
            // make repeated presses impossible for keyboard users (A11Y-4).
            // Matched by dataset rather than built into a selector string: an
            // imported rule's id is arbitrary text and would need escaping to
            // be safe (and legal) inside an attribute selector.
            const action = delta < 0 ? 'move-up' : 'move-down';
            const btn = Array.from(document.querySelectorAll(`.rule-action[data-action="${action}"]`))
                .find((el) => el.dataset.ruleId === ruleId);
            if (btn) btn.focus();
        } catch (error) {
            console.error('Failed to reorder rule:', error);
            this.showError('Could not reorder rules');
        }
    }

    /**
     * PROD-7: hitCount was incremented and persisted but rendered nowhere, so
     * the most basic question — "did my rule actually fire?" — could only be
     * answered by discovering the custom DevTools panel. Show it on the card.
     * Rendered only once a rule has fired, to keep untouched rows quiet.
     */
    getHitCountHTML(rule) {
        const hits = Number(rule && rule.hitCount) || 0;
        if (hits <= 0) return '';
        const shown = hits > 999 ? '999+' : String(hits);
        const label = hits === 1 ? '1 hit' : `${shown} hits`;
        return `<span class="hit-count" title="Times this rule has been applied">${label}</span>`;
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

        // A-19: the static markup this replaces (popup.html) uses <h2> to
        // avoid skipping a level after the popup's single <h1> — mirror that
        // here so the heading hierarchy stays correct once JS takes over.
        if (searchTerm) {
            return `
                <div class="empty-state">
                    <div class="empty-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="url(#tmIconGrad)" stroke-width="1.5" aria-hidden="true" focusable="false"><defs><linearGradient id="tmIconGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1e63f5"/><stop offset="100%" stop-color="#0bbcd4"/></linearGradient></defs><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                    </div>
                    <h2>No matching rules</h2>
                    <p>No rules found matching "${this.escapeHtml(searchTerm)}"</p>
                </div>
            `;
        }

        return `
            <div class="empty-state">
                <div class="empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="url(#tmIconGrad)" stroke-width="1.5" aria-hidden="true" focusable="false"><defs><linearGradient id="tmIconGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1e63f5"/><stop offset="100%" stop-color="#0bbcd4"/></linearGradient></defs><path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2"/><path d="M3 7h18v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M9 12h6"/></svg>
                </div>
                <h2>No rules yet</h2>
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

            // A-16: the card is a mouse-only click-to-edit target — it's
            // now focusable (tabindex="0" in getRuleCardHTML) with a matching
            // keyboard path. Only fires when the card itself is the event
            // target: the checkbox's own keydown handler stops propagation,
            // and the nested <button>s turn Enter/Space into native click
            // events targeted at the button, not at the card, so there's no
            // double-handling.
            card.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
                    e.preventDefault();
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
            case 'move-up':
                await this.moveRule(ruleId, -1);
                break;
            case 'move-down':
                await this.moveRule(ruleId, 1);
                break;
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
            // PROD-1: dnrRuleId identifies a declarativeNetRequest rule, and
            // saveRule only allocates one when it is missing. Cloning it meant
            // enabling the copy sent Chrome two DNR rules with the same id;
            // updateDynamicRules rejects the whole batch, so EVERY headers and
            // queryparams rule silently stopped applying. Drop it so the copy
            // gets its own.
            delete newRule.dnrRuleId;

            const response = await this.sendMessage({
                type: 'saveRule',
                rule: newRule
            });

            if (response && response.success) {
                await this.loadData();
                // U-15: loadData() resets filteredRules to the full list —
                // re-apply whatever search is active instead of dropping it.
                this.applySearchFilter();
                this.updateStatus();
                // A11Y-4: same rebuild-destroys-focus problem as delete.
                this.restoreListFocus();
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

        const card = document.querySelector(`[data-rule-id="${ruleId}"]`);
        const statusIndicator = card?.querySelector('.status-indicator');

        try {
            // U-5: this used to do `statusIndicator.textContent = '⏳'`,
            // which deletes the SVG icon (the button's only child), and on
            // success `statusIndicator.textContent = this.getStatusIcon(...)`
            // — assigning an HTML *string* to textContent, which rendered the
            // raw `<svg …>` markup as visible text. A CSS-only busy state
            // never touches the icon's markup.
            if (statusIndicator) {
                statusIndicator.classList.add('is-busy');
                statusIndicator.setAttribute('aria-busy', 'true');
            }

            const response = await this.sendMessage({
                type: 'testRule',
                rule: rule
            });

            if (response && response.success) {
                rule.testStatus = response.passed ? 'passed' : 'failed';

                if (statusIndicator) {
                    // A-9/A-18: keep the accessible name in sync with the new
                    // status, not just the visual icon.
                    const tooltip = this.getStatusTooltip(rule.testStatus);
                    statusIndicator.innerHTML = this.getStatusIcon(rule.testStatus);
                    statusIndicator.title = tooltip;
                    statusIndicator.setAttribute('aria-label', tooltip);
                }

                this.showNotification(`Test ${response.passed ? 'passed' : 'failed'}`);
            } else {
                this.showError('Test failed');
            }

        } catch (error) {
            console.error('Test failed:', error);
            this.showError('Test failed');
        } finally {
            if (statusIndicator) {
                statusIndicator.classList.remove('is-busy');
                statusIndicator.removeAttribute('aria-busy');
            }
        }
    }

    /**
     * Delete rule
     */
    async deleteRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        // U-11: a native confirm() is OS-styled (nothing like the rest of the
        // product), and — like every destructive action in the app — offered
        // no way back once confirmed. Delete immediately and offer an undo
        // toast instead: the rule is kept in memory and can be restored for
        // a few seconds, which is both friendlier and (unlike confirm())
        // actually recoverable.
        try {
            const response = await this.sendMessage({
                type: 'deleteRule',
                ruleId: ruleId
            });

            if (response && response.success) {
                await this.loadData();
                this.applySearchFilter();
                this.updateStatus();
                // A11Y-4: renderRules() rebuilds the list via innerHTML, which
                // destroys the Delete button that was just activated — focus
                // then falls to <body> and a keyboard user has to Tab from the
                // top of the popup again. Park focus somewhere stable instead.
                this.restoreListFocus();
                this.showUndoToast(`Deleted "${rule.name}"`, rule);
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
        this.searchTerm = e.target.value.toLowerCase().trim();
        if (this.searchClearBtn) {
            this.searchClearBtn.hidden = !e.target.value;
        }

        // PERF-3: applySearchFilter() ends in a full innerHTML rebuild of the
        // list plus re-attaching listeners per row. Running that per keystroke
        // is visible lag once a user has a few dozen rules. The clear button
        // above still updates immediately, so typing stays responsive.
        if (this._searchDebounce) clearTimeout(this._searchDebounce);
        this._searchDebounce = setTimeout(() => {
            this._searchDebounce = null;
            this.applySearchFilter();
        }, 120);
    }

    /**
     * U-15: apply this.searchTerm against the current rule set and
     * re-render. Extracted from handleSearch() so it can also be called
     * after any reload (duplicate/delete/refresh) — previously those paths
     * called loadData() then renderRules() directly, which silently reset
     * filteredRules to the unfiltered list while the search box still
     * showed the (now ignored) query.
     */
    /**
     * PERF-3: the lowercased text a rule is searched against, computed once
     * and cached on a WeakMap keyed by the rule object. Any mutation replaces
     * the rule object (storage re-reads produce fresh objects), so a stale
     * entry cannot outlive the data it describes.
     */
    _searchHaystack(rule) {
        if (!this._haystacks) this._haystacks = new WeakMap();
        const cached = this._haystacks.get(rule);
        if (cached !== undefined) return cached;

        const text = [
            rule.name,
            rule.match && rule.match.url,
            rule.match && rule.match.method,
            rule.type || 'mock',
            rule.redirect && rule.redirect.destination,
            rule.response ? JSON.stringify(rule.response) : ''
        ].filter(Boolean).join(' ').toLowerCase();

        this._haystacks.set(rule, text);
        return text;
    }

    applySearchFilter() {
        const searchTerm = this.searchTerm || '';

        if (!searchTerm) {
            this.filteredRules = [...this.rules];
        } else {
            // U-15: search used to only look at name/url/method — extended
            // to the rule type, redirect destination, and the mock response
            // body/status, all things a developer would plausibly search for.
            // PERF-3: the haystack — including JSON.stringify of the whole
            // response — was rebuilt for every rule on every keystroke, even
            // though nothing about the rules changed between keystrokes. It is
            // now computed once per rule and cached until the rules do change.
            this.filteredRules = this.rules.filter(rule => this._searchHaystack(rule).includes(searchTerm));
        }

        this.renderRules();
        this.updateSearchResultCount();
    }

    /**
     * U-15: "N of M rules" feedback while a search is active.
     */
    updateSearchResultCount() {
        const countEl = document.getElementById('searchResultCount');
        if (!countEl) return;

        if (this.searchTerm) {
            countEl.hidden = false;
            const total = this.rules.length;
            countEl.textContent = `${this.filteredRules.length} of ${total} rule${total === 1 ? '' : 's'}`;
        } else {
            countEl.hidden = true;
            countEl.textContent = '';
        }
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

        // U-5: `testBtn.textContent` on a button whose only child is an
        // <svg> is '' — setting it to '⏳' deleted the icon permanently
        // (the `finally` block restored the now-empty string, not the
        // icon). A CSS-only busy state leaves the icon markup alone.
        testBtn.classList.add('is-busy');
        testBtn.setAttribute('aria-busy', 'true');
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
            testBtn.classList.remove('is-busy');
            testBtn.removeAttribute('aria-busy');
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

        // A11Y-5: the button ships aria-pressed="true" in markup and nothing
        // ever updated it, so screen readers announced "pressed" even when the
        // visible label read "Disabled" — the exposed state contradicted the
        // real one (WCAG 2.1 SC 4.1.2).
        const statusToggle = document.getElementById('statusToggle');
        if (statusToggle) statusToggle.setAttribute('aria-pressed', String(!!this.isActive));

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
     * Switch between the Rules and Settings panes.
     * The footer (New rule / Test all / Refresh) is Rules-only, so it is
     * hidden rather than shown disabled on Settings.
     */
    switchTab(name) {
        const TABS = {
            rules: ['tabRules', 'paneRules'],
            settings: ['tabSettings', 'paneSettings'],
            data: ['tabData', 'paneData']
        };
        const active = TABS[name] ? name : 'rules';

        for (const [key, [tabId, paneId]] of Object.entries(TABS)) {
            const tab = document.getElementById(tabId);
            const pane = document.getElementById(paneId);
            const on = key === active;
            if (tab) tab.setAttribute('aria-selected', String(on));
            if (pane) pane.hidden = !on;
        }

        const footer = document.getElementById('rulesFooter');
        if (footer) footer.hidden = active !== 'rules';

        // Re-read on open so each pane reflects what the background actually
        // holds, rather than whatever was true when the popup first loaded.
        if (active === 'settings') this.renderSettings();
        if (active === 'data') {
            this.renderDataSection();
            this.renderCaptureSection();
        }
    }

    /**
     * Populate the Settings controls from this.settings. Called after
     * loadData() and whenever the Settings tab is opened, so the controls
     * always reflect what the background actually holds.
     */
    renderSettings() {
        const s = this.settings || {};

        const theme = s.theme || 'auto';
        const themeRadio = document.querySelector(`input[name="theme"][value="${theme}"]`);
        if (themeRadio) themeRadio.checked = true;

        const debugEl = document.getElementById('debugMode');
        if (debugEl) debugEl.checked = !!s.debugMode;

        const chaos = s.chaosMode || {};
        const chaosEl = document.getElementById('chaosModeEnabled');
        if (chaosEl) chaosEl.checked = !!chaos.enabled;

        const rateEl = document.getElementById('chaosFailureRate');
        if (rateEl) {
            const pct = Math.round((typeof chaos.failureRate === 'number' ? chaos.failureRate : 0.1) * 100);
            rateEl.value = String(Math.min(100, Math.max(1, pct)));
        }

        this.updateChaosRateState();
    }

    /**
     * The failure-rate row is meaningless while chaos mode is off — dim and
     * disable it rather than letting the user tune an inert value.
     */
    updateChaosRateState() {
        const enabled = !!(this.settings && this.settings.chaosMode && this.settings.chaosMode.enabled);
        const rateEl = document.getElementById('chaosFailureRate');
        const row = document.getElementById('chaosRateRow');
        if (rateEl) rateEl.disabled = !enabled;
        if (row) row.classList.toggle('is-disabled', !enabled);
    }

    /**
     * Persist settings through the background so it updates its in-memory
     * copy and re-broadcasts syncState to every tab (the interceptor reads
     * debugMode and chaosMode from that broadcast).
     */
    async saveSettings() {
        try {
            const response = await this.sendMessage({
                type: 'settingsUpdated',
                settings: this.settings
            });
            if (!response || !response.success) {
                this.showError('Could not save settings');
            }
        } catch (error) {
            console.error('Failed to save settings:', error);
            this.showError('Could not save settings');
        }
    }

    /**
     * Keep the Rules tab's count badge in step with the rule list.
     */
    updateTabCount() {
        const el = document.getElementById('tabRuleCount');
        if (el) el.textContent = String((this.rules || []).length);
    }

    /**
     * Capture: record a real response, then build a rule from it.
     *
     * The gap this closes: patch mode edits a live response, and a mock needs a
     * body — both require knowing the real payload's shape, which previously
     * meant copying it out of DevTools by hand. Capture removes that step.
     */
    async setCaptureArmed(armed) {
        try {
            const response = await this.sendMessage({ type: 'setCaptureArmed', armed });
            if (!response || !response.success) {
                this.showError((response && response.error) || 'Could not change capture');
                return;
            }
            this.settings = { ...(this.settings || {}), captureArmed: !!armed };
            this.renderCaptureSection();
            if (armed) this.showNotification('Recording — trigger the request you want to mock');
        } catch (error) {
            console.error('Failed to toggle capture:', error);
            this.showError('Could not change capture');
        }
    }

    async renderCaptureSection() {
        const armed = !!(this.settings && this.settings.captureArmed);

        const toggle = document.getElementById('captureArmed');
        if (toggle) toggle.checked = armed;

        const note = document.getElementById('captureNote');
        if (note) note.hidden = !armed;

        let captures = [];
        try {
            const response = await this.sendMessage({ type: 'getCaptures' });
            if (response && response.success) captures = response.captures || [];
        } catch (error) {
            // Background asleep — leave the list empty rather than erroring.
        }
        this.captures = captures;

        const countEl = document.getElementById('captureCount');
        if (countEl) countEl.textContent = String(captures.length);

        const actionsRow = document.getElementById('captureActionsRow');
        if (actionsRow) actionsRow.hidden = captures.length === 0;

        const list = document.getElementById('captureList');
        if (!list) return;

        // Newest first — the request just triggered is the one being looked for.
        list.innerHTML = captures.slice().reverse().map((c) => {
            const isError = c.status >= 400;
            return `
                <div class="capture-item" role="listitem">
                    <div class="capture-main">
                        <div class="capture-url" title="${this.escapeHtml(c.url)}">${this.escapeHtml(c.url)}</div>
                        <div class="capture-meta">
                            <span>${this.escapeHtml(c.method)}</span>
                            <span class="capture-status ${isError ? 'is-error' : ''}">${Number(c.status) || 0}</span>
                            <span>${this.formatBytes((c.body || '').length)}</span>
                        </div>
                    </div>
                    <div class="capture-actions">
                        <button type="button" class="mini-btn" data-capture-action="mock" data-capture-id="${this.escapeHtml(c.id)}" title="Create a rule returning this exact response">Mock</button>
                        <button type="button" class="mini-btn" data-capture-action="patch" data-capture-id="${this.escapeHtml(c.id)}" title="Create a rule that edits this response, keeping the rest live">Patch</button>
                    </div>
                </div>`;
        }).join('');

        list.querySelectorAll('[data-capture-action]').forEach((btn) => {
            const handler = () => this.createRuleFromCapture(btn.dataset.captureId, btn.dataset.captureAction);
            btn.addEventListener('click', handler);
            this.listeners.push({ element: btn, event: 'click', handler });
        });
    }

    formatBytes(n) {
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
    }

    /**
     * Build a rule from a captured response.
     *
     * mock  — replay this exact payload, so the endpoint can be edited freely.
     * patch — start from an empty merge patch against the live response, which
     *         is the mode that has no equivalent elsewhere; the captured body
     *         is what tells you which fields are available to patch.
     */
    async createRuleFromCapture(captureId, mode) {
        const capture = (this.captures || []).find((c) => c.id === captureId);
        if (!capture) return;

        let parsedBody = null;
        try {
            parsedBody = JSON.parse(capture.body);
        } catch (error) {
            parsedBody = null; // not JSON — keep the raw text
        }

        // Pattern the exact path, not the whole origin: capturing /api/users/42
        // should not produce a rule that swallows every request on the host.
        let urlPattern = capture.url;
        try {
            const u = new URL(capture.url);
            urlPattern = `*${u.pathname}*`;
        } catch (error) {
            // Relative or already-redacted URL — match it as a substring.
        }

        const isPatch = mode === 'patch';
        const rule = {
            id: this.generateId(),
            name: isPatch ? `Patch ${urlPattern}` : `Mock ${urlPattern}`,
            enabled: false, // never start intercepting without the user looking
            type: 'mock',
            created: new Date().toISOString(),
            lastModified: new Date().toISOString(),
            match: { method: capture.method, url: urlPattern },
            response: {
                statusCode: capture.status,
                statusText: capture.statusText || '',
                headers: capture.contentType ? { 'Content-Type': capture.contentType } : {},
                body: isPatch ? {} : (parsedBody !== null ? parsedBody : capture.body),
                delay: 0,
                mode: isPatch ? 'patch' : 'static',
                patch: isPatch ? {} : {}
            }
        };
        if (isPatch) rule.response.patch = {};

        try {
            const response = await this.sendMessage({ type: 'saveRule', rule });
            if (!response || !response.success) {
                this.showError((response && response.error) || 'Could not create the rule');
                return;
            }
            await this.loadData();
            this.applySearchFilter();
            this.updateTabCount();
            this.showNotification(
                isPatch
                    ? 'Patch rule created — add the fields to change, then enable it'
                    : 'Mock rule created — enable it on the Rules tab'
            );
        } catch (error) {
            console.error('Failed to create rule from capture:', error);
            this.showError('Could not create the rule');
        }
    }

    /**
     * Refresh the Data/Stored-data rows. Storage size is read straight from
     * chrome.storage rather than measured off `this.rules`, so it reflects
     * settings, stats and backups too — not just the rule list.
     */
    async renderDataSection() {
        const count = (this.rules || []).length;
        const countEl = document.getElementById('exportCount');
        if (countEl) countEl.textContent = String(count);

        const infoEl = document.getElementById('storageInfo');
        if (!infoEl) return;
        try {
            const bytes = await chrome.storage.local.getBytesInUse(null);
            const kb = bytes / 1024;
            const size = kb < 1 ? `${bytes} B` : (kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`);
            infoEl.textContent = `${size} · ${count} rule${count === 1 ? '' : 's'}`;
        } catch (error) {
            infoEl.textContent = `${count} rule${count === 1 ? '' : 's'}`;
        }
    }

    /**
     * Download the current rules as JSON. A download does not need a file
     * picker, so unlike import this works from the popup — and because the
     * browser owns the transfer, it still completes if the popup closes.
     */
    exportRules() {
        const rules = this.rules || [];
        if (!rules.length) {
            this.showError('No rules to export');
            return;
        }
        const payload = {
            exportedAt: new Date().toISOString(),
            rules
        };
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `splicetap-rules-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoking immediately can cancel the download in some builds; give
        // the browser a moment to take ownership of the blob first.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        this.showNotification(`Exported ${rules.length} rule${rules.length === 1 ? '' : 's'}`);
    }

    /** Show/hide an inline disclosure panel and sync its trigger's aria-expanded. */
    togglePanel(panelId, triggerId, show) {
        const panel = document.getElementById(panelId);
        const trigger = document.getElementById(triggerId);
        if (!panel) return;
        const next = typeof show === 'boolean' ? show : panel.hidden;
        panel.hidden = !next;
        if (trigger) trigger.setAttribute('aria-expanded', String(next));
        if (next && panelId === 'importPanel') {
            const ta = document.getElementById('importJson');
            if (ta) ta.focus();
        }
        // A11Y-9: on close, send focus back to the control that opened the
        // panel. The Cancel button lives inside the panel being hidden, and
        // `.sub-panel[hidden]` sets display:none — so without this, focus falls
        // to <body> the instant it is clicked and the user loses their place.
        if (!next && trigger) trigger.focus();
    }

    /**
     * Parse pasted JSON and hand it to the background's bulk `setRules`,
     * which validates each rule, skips the bad ones and allocates DNR ids —
     * so this deliberately does not re-implement that validation.
     */
    async confirmImport() {
        const ta = document.getElementById('importJson');
        const raw = (ta && ta.value || '').trim();
        if (!raw) {
            this.showError('Paste some JSON first');
            return;
        }

        let incoming;
        try {
            const parsed = JSON.parse(raw);
            incoming = Array.isArray(parsed) ? parsed : parsed && parsed.rules;
        } catch (error) {
            this.showError('That is not valid JSON');
            return;
        }
        if (!Array.isArray(incoming) || !incoming.length) {
            this.showError('No rules found in that JSON');
            return;
        }

        const merge = document.getElementById('importMerge');
        const keepExisting = merge ? merge.checked : true;

        // Fresh ids on merge so imported rules can never collide with, and
        // therefore overwrite, a rule already stored under the same id.
        const prepared = incoming.map((rule) => {
            const next = {
                ...rule,
                id: keepExisting || !rule.id ? this.generateId() : rule.id
            };
            // Same collision as duplicating a rule (PROD-1): exports carry
            // dnrRuleId, and setRules only allocates one when it is missing.
            // Re-importing alongside the originals would hand Chrome two DNR
            // rules with the same id, which rejects the entire batch and takes
            // every headers/queryparams rule down with it. The id is an
            // internal allocation, never user data, so always re-issue it.
            delete next.dnrRuleId;
            return next;
        });

        // Re-fetch before merging: `this.rules` is a snapshot that may predate
        // rules added from the overlay or another surface while this popup was
        // open, and "keep existing" promises not to lose those.
        let existing = [];
        if (keepExisting) {
            try {
                const fresh = await this.sendMessage({ type: 'getRules' });
                existing = (fresh && fresh.success && Array.isArray(fresh.rules)) ? fresh.rules : (this.rules || []);
            } catch (error) {
                existing = this.rules || [];
            }
        }

        try {
            const response = await this.sendMessage({
                type: 'setRules',
                rules: [...prepared, ...existing]
            });
            if (!response || !response.success) {
                this.showError('Import failed');
                return;
            }
            this.rules = response.rules || [];
            const rejected = (response.rejected || []).length;
            const added = prepared.length - rejected;
            const summary = rejected
                ? `Imported ${added} rule${added === 1 ? '' : 's'}, skipped ${rejected} invalid`
                : `Imported ${added} rule${added === 1 ? '' : 's'}`;
            // CQ-3: an imported headers/queryparams rule can be stored yet
            // rejected by declarativeNetRequest, which previously left the user
            // with an unqualified success message for a rule that never applies.
            if (response.dnrWarning) {
                this.showError(`${summary} — but the network-layer rules could not be applied: ${response.dnrWarning}`);
            } else {
                this.showNotification(summary);
            }
            if (ta) ta.value = '';
            this.togglePanel('importPanel', 'importToggleBtn', false);
            this.renderRules();
            this.updateTabCount();
            this.renderDataSection();
        } catch (error) {
            console.error('Import failed:', error);
            this.showError('Import failed');
        }
    }

    /**
     * Wipe every SpliceTap key. Rules go through the background so DNR is
     * re-synced and tabs are told to stop intercepting; the remaining keys are
     * removed directly since nothing else observes them.
     */
    async confirmReset() {
        try {
            await this.sendMessage({ type: 'clearRules' });
            await chrome.storage.local.remove([
                'spliceTapSettings', 'spliceTapStats', 'spliceTapMetrics',
                'spliceTapChaos', 'spliceTapDnrCounter'
            ]);
            this.togglePanel('resetPanel', 'resetAllBtn', false);
            this.showNotification('All SpliceTap data deleted');
            setTimeout(() => window.location.reload(), 600);
        } catch (error) {
            console.error('Reset failed:', error);
            this.showError('Could not delete data');
        }
    }

    /**
     * Refresh data
     */
    async refreshData() {
        const refreshBtn = document.getElementById('refreshBtn');
        if (!refreshBtn) return;

        // U-5: same textContent/icon-destroying bug as testAllRules() above.
        refreshBtn.classList.add('is-busy');
        refreshBtn.setAttribute('aria-busy', 'true');
        refreshBtn.disabled = true;

        try {
            await this.loadData();
            // U-15: re-apply the active search filter instead of dropping it
            // (applySearchFilter() also calls renderRules()).
            this.applySearchFilter();
            this.updateStatus();
            this.updateStats();

            this.showNotification('Refreshed');
        } catch (error) {
            this.showError('Failed to refresh');
        } finally {
            refreshBtn.classList.remove('is-busy');
            refreshBtn.removeAttribute('aria-busy');
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
            // A11Y-3: Escape used to close the whole popup unconditionally,
            // which threw away a half-pasted import JSON on the reflex keystroke
            // people use to mean "cancel this". Close the innermost open thing
            // first, and only fall through to closing the popup when there is
            // nothing left to dismiss.
            const openPanel = document.querySelector('.sub-panel:not([hidden])');
            if (openPanel) {
                const trigger = openPanel.id === 'importPanel' ? 'importToggleBtn' : 'resetAllBtn';
                this.togglePanel(openPanel.id, trigger, false);
                return;
            }

            const search = document.getElementById('searchInput');
            if (search && search.value) {
                search.value = '';
                this.handleSearch({ target: search });
                search.focus();
                return;
            }

            window.close();
        }
    }

    /**
     * Utility: Get status icon
     */
    getStatusIcon(status) {
        // A-9: these render inside a `role="img" aria-label="…"` container
        // (getRuleCardHTML) that already carries the accessible name — mark
        // the glyph itself decorative so it isn't exposed as a second,
        // unlabelled graphics node.
        const icons = {
            passed: `<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>`,
            failed: `<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>`,
            warning: `<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.2" aria-hidden="true" focusable="false"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
            pending: `<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
            never: `<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`
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
     * U-11: delete used to be gated by a blocking native confirm(); it's now
     * immediate with an undo toast (~8s) instead. Restoring re-saves the
     * exact same rule object (same id) — storage.saveRule() upserts by id,
     * so this recreates it identically rather than as a new rule.
     */
    showUndoToast(message, rule) {
        this.createToast(message, 'success', {
            actionLabel: 'Undo',
            duration: 8000,
            onAction: async () => {
                try {
                    const response = await this.sendMessage({ type: 'saveRule', rule });
                    if (response && response.success) {
                        await this.loadData();
                        this.applySearchFilter();
                        this.updateStatus();
                        this.showNotification('Rule restored');
                    } else {
                        this.showError('Could not undo delete');
                    }
                } catch (error) {
                    console.error('Undo failed:', error);
                    this.showError('Could not undo delete');
                }
            }
        });
    }

    /**
     * Utility: Create toast notification
     *
     * U-18: toasts used to be individually `position: fixed; top: 10px;
     * right: 10px`, landing directly on the header/Settings button, with
     * consecutive toasts stacking unreadably at the identical coordinates.
     * They now flow inside the single `#toastContainer` (popup.html),
     * anchored above the footer, and pause their auto-dismiss on hover.
     *
     * A-6: no status message anywhere was ever announced to screen-reader
     * users. Every toast now also mirrors its text into `#liveRegion`
     * (persistent, `aria-live="polite"`) and carries its own
     * role="alert"/"status" as a second, redundant path.
     */
    createToast(message, type = 'info', options = {}) {
        const container = document.getElementById('toastContainer');
        if (!container) return null;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

        const text = document.createElement('span');
        text.className = 'toast-message';
        text.textContent = message;
        toast.appendChild(text);

        let dismissTimer;
        const dismissToast = () => {
            toast.classList.add('closing');
            setTimeout(() => toast.remove(), 300);
        };
        const scheduleDismiss = () => {
            clearTimeout(dismissTimer);
            const duration = options.duration || (type === 'error' ? 6000 : 3000);
            dismissTimer = setTimeout(dismissToast, duration);
        };

        if (options.actionLabel && typeof options.onAction === 'function') {
            const actionBtn = document.createElement('button');
            actionBtn.type = 'button';
            actionBtn.className = 'toast-action';
            actionBtn.textContent = options.actionLabel;
            actionBtn.addEventListener('click', () => {
                clearTimeout(dismissTimer);
                options.onAction();
                dismissToast();
            });
            toast.appendChild(actionBtn);
        }

        // U-18: pause the auto-dismiss while the user is reading/reaching
        // for the action button.
        toast.addEventListener('mouseenter', () => clearTimeout(dismissTimer));
        toast.addEventListener('mouseleave', scheduleDismiss);
        // UX-2: a mouse user could hold the toast open indefinitely by hovering,
        // but a keyboard user tabbing toward Undo got no such extension — and
        // the toast sits after the footer in tab order, so they had further to
        // travel. Pause on focus too.
        toast.addEventListener('focusin', () => clearTimeout(dismissTimer));
        toast.addEventListener('focusout', scheduleDismiss);

        container.appendChild(toast);
        scheduleDismiss();

        const liveRegion = document.getElementById('liveRegion');
        if (liveRegion) {
            liveRegion.textContent = message;
        }

        return toast;
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
        window.spliceTapPopup = new SpliceTapPopup();
    });
} else {
    window.spliceTapPopup = new SpliceTapPopup();
}