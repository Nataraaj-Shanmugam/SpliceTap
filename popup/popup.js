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
        // PER-55: the per-rule "Test" is only a syntax check. Its outcome is
        // kept here (ruleId -> { valid, message }) rather than written onto the
        // rule objects, which are later saved back (Undo) and exported.
        this.checks = new Map();
        // PER-62: what the last import skipped, shown inline until dismissed.
        this.importReport = null;
        // PER-62: replace-mode import needs a second, confirming click.
        this.replaceArmed = false;
        // B2-F6: set while the pasted JSON is a Requestly export that the
        // converter can take: { count } - the number of rules found in it.
        this.requestlyOffer = null;

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
            // PER-58: after the first render, so it never holds the list up.
            this.startTabStatus();

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
                // Rules Chrome's network layer refused (ruleId -> reason).
                this.dnrErrors = response.dnrErrors || {};
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
     * PER-58: "This tab: N intercepted · last 5 s ago". The footer counter is
     * global and daily; this is the active tab's own log, which the background
     * already filters when given a tabId. Refetched every few seconds while
     * the popup is open so the age keeps moving.
     */
    startTabStatus() {
        this.refreshTabStatus();
        clearInterval(this._tabStatusTimer);
        this._tabStatusTimer = setInterval(() => this.refreshTabStatus(), 5000);
    }

    async refreshTabStatus() {
        const el = document.getElementById('tabStatus');
        if (!el) return;
        let tab = null;
        try {
            [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        } catch (error) {
            tab = null;
        }
        if (!tab || typeof tab.id !== 'number') {
            el.hidden = true;
            return;
        }
        const response = await this.sendMessage({ type: 'getInterceptionLog', tabId: tab.id });
        if (!response || !response.success) return; // keep what is showing
        this.tabLogEntries = Array.isArray(response.entries) ? response.entries : [];
        el.textContent = window.SpliceTapPopupHelpers.tabStatusText(this.tabLogEntries, Date.now());
        el.hidden = false;
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
            tabStrip.addEventListener('keydown', (e) => this.handleTabKeydown(e));
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
        // F2: this handler must reach chrome.permissions.request before any
        // await — Chrome only shows the prompt inside a user gesture.
        this.addListener('observeNetworkRules', 'change', (e) => this.onObserveToggle(e.target));
        // F4
        this.addListener('allowCodeResponses', 'change', (e) => this.onCodeResponsesToggle(e.target));
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
        // PER-62: the confirm button's wording follows the mode, and changing
        // the mode or the JSON cancels a pending replace confirmation.
        this.addListener('importMerge', 'change', () => this.updateImportMode());
        this.addListener('importJson', 'input', () => {
            this.disarmReplace();
            this.scheduleRequestlyCheck();
        });
        // B2-F6: the action that takes the place of the old "this is a Requestly export" message.
        this.addListener('importConvertBtn', 'click', () => this.convertRequestly());
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
            // PER-55: it only checks syntax, so it no longer promises a "test".
            ['testAllBtn', 'Check all rules (Ctrl+T)'],
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
            // PER-61: the first-run screen offers the two real ways in.
            container.querySelectorAll('[data-empty-action]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    if (btn.dataset.emptyAction === 'record') this.startRecording();
                    else this.createNewRule();
                });
            });
            return;
        }

        // Q-4: one malformed rule (e.g. from a hand-edited storage entry, or
        // a future schema change) throwing inside getRuleCardHTML previously
        // took the whole .map() down with it, leaving the entire rule list
        // blank with no way to recover except deleting all rules via
        // devtools. Render each card independently so one bad rule becomes
        // an inline error placeholder instead of an empty popup.
        // A real list again: each row is a listitem holding its own controls,
        // so assistive tech announces "list, N items" and can reach every
        // button in a row (see getRuleCardHTML for why rows stopped being
        // buttons). The empty and loading states render outside the list, so
        // it only ever contains listitems.
        const cards = this.filteredRules
            .map((rule, index) => {
                try {
                    return this.getRuleCardHTML(rule, index);
                } catch (error) {
                    console.error('Failed to render rule card:', rule && rule.id, error);
                    const safeId = this.escapeHtml((rule && rule.id) || '');
                    return `<div class="rule-card rule-card-error" role="listitem" data-rule-id="${safeId}">
                        <div class="rule-details">⚠ This rule could not be displayed (${this.escapeHtml(error.message)}).
                        <button class="rule-action" data-action="delete" data-rule-id="${safeId}">Delete it</button></div>
                    </div>`;
                }
            })
            .join('');
        container.innerHTML = `<div class="rule-list" role="list" aria-label="Rules">${cards}</div>`;

        // Attach event listeners to newly rendered cards
        this.attachRuleEventListeners();

        // PER-59: chips already worked out go back on at once; anything not
        // yet known is asked for after this render has painted.
        this.applyShadowChips();
        this.scheduleShadowChips();
    }

    /**
     * PER-59: "Shadowed by <name>" on a row whose rule an earlier enabled rule
     * answers first. The background's explainMatch does the matching; the
     * popup only asks, and only after the list is on screen. Results are kept
     * until the rule set changes, so typing in the search box does not ask again.
     */
    shadowSignature() {
        return (this.rules || []).map((r) => `${r && r.id}:${r && r.enabled ? 1 : 0}:${(r && r.lastModified) || ''}`).join('|');
    }

    scheduleShadowChips() {
        clearTimeout(this._shadowTimer);
        // A timeout rather than requestAnimationFrame: a popup in a background tab never gets a frame.
        this._shadowTimer = setTimeout(() => this.computeShadowChips(), 30);
    }

    async computeShadowChips() {
        const helpers = window.SpliceTapPopupHelpers;
        const signature = this.shadowSignature();
        if (this._shadowSignature !== signature) {
            this._shadowSignature = signature;
            this._shadowCache = new Map();
        }
        const cache = this._shadowCache;
        const generation = (this._shadowGeneration = (this._shadowGeneration || 0) + 1);
        // A regex pattern has no sample URL; skip it without asking.
        const queue = (this.rules || []).filter((r) => r && r.id && !cache.has(r.id)
            && !helpers.isRegexPattern(r.match && r.match.url));

        const work = async () => {
            while (queue.length && generation === this._shadowGeneration) {
                const target = queue.shift();
                const response = await this.sendMessage({ type: 'explainMatch', ruleId: target.id });
                if (generation !== this._shadowGeneration || cache !== this._shadowCache) return;
                const usable = response && response.success && !response.needsUrl && Array.isArray(response.shadowedBy);
                cache.set(target.id, usable ? response.shadowedBy : []);
                this.applyShadowChip(target.id);
            }
        };
        await Promise.all([work(), work(), work(), work()]);
    }

    applyShadowChips() {
        if (!this._shadowCache || this._shadowSignature !== this.shadowSignature()) return;
        for (const id of this._shadowCache.keys()) this.applyShadowChip(id);
    }

    /** Put (or take off) one row's chip from what is known about it. */
    applyShadowChip(ruleId) {
        const card = this.findRuleCard(ruleId);
        const details = card && card.querySelector('.rule-details');
        if (!details) return;
        const existing = details.querySelector('.rule-shadow-chip');
        if (existing) existing.remove();
        const shadowedBy = this._shadowCache && this._shadowCache.get(ruleId);
        const text = window.SpliceTapPopupHelpers.shadowChipText(shadowedBy);
        if (!text) return;
        const names = shadowedBy.map((s) => s && s.ruleName).filter(Boolean).join(', ');
        const chip = document.createElement('span');
        chip.className = 'rule-shadow-chip';
        chip.textContent = text;
        chip.title = `An earlier rule (${names}) matches the same requests, so this rule never answers them. Move this rule above it to change that.`;
        const url = details.querySelector('.rule-url');
        if (url) details.insertBefore(chip, url);
        else details.appendChild(chip);
    }

    /**
     * Get HTML for a rule card
     */
    getRuleCardHTML(rule, index = 0) {
        // PER-55: the glyph reports the syntax check ("Valid"/"Invalid"), not
        // whether the rule works — hits (below) are the evidence of that.
        const check = this.getCheckStatus(rule);
        const statusIcon = this.getStatusIcon(check.key);

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
        const statusTooltip = this.escapeHtml(check.label);

        // A-12: disabled rules used to be signalled purely by `opacity: 0.5`
        // + `grayscale()`, which dropped several text pairs under 4.5:1.
        // Add an explicit "Disabled" chip instead of relying on dimming.
        const disabledChip = rule.enabled ? '' : this.getDisabledChipHTML();
        // A headers/queryparams rule Chrome's network layer refused. Shown on
        // the row itself — a toast is gone in seconds, and the rule keeps
        // silently not applying until someone fixes it.
        const dnrError = this.dnrErrors && this.dnrErrors[rule.id];
        const notAppliedChip = dnrError
            ? `<span class="rule-error-chip" title="Chrome refused this rule: ${this.escapeHtml(dnrError)}">Not applied<span class="visually-hidden"> — Chrome refused this rule: ${this.escapeHtml(dnrError)}</span></span>`
            : '';

        return `
            <!-- A11Y-10, revised. Making the whole row role="button" let a
                 keyboard user hear that it was activatable, but a button may
                 not contain other controls, and this row contains a checkbox
                 and six buttons: assistive tech flattens a button's contents,
                 so those controls became unreachable or unnamed for screen
                 reader users (axe: nested-interactive). Its aria-label also
                 replaced the visible text, so a voice-control user saying the
                 rule's name could not activate it (WCAG 2.5.3).

                 The row is a listitem again, and the rule's name is the real
                 button that opens the editor — named by its visible text, so
                 both problems go. Clicking anywhere else on the row still
                 opens the editor for mouse users; that is a convenience the
                 card's click handler provides, not a role it claims. -->
            <div class="rule-card ${enabledClass}" data-rule-id="${safeId}" role="listitem">
                <div class="rule-header">
                    <div class="rule-info">
                        <div class="rule-name" title="${safeName}">
                            <div class="rule-checkbox ${checkedClass}"
                                 data-rule-id="${safeId}"
                                 role="checkbox"
                                 aria-checked="${rule.enabled ? 'true' : 'false'}"
                                 tabindex="0"
                                 aria-label="Enable ${safeName}"></div>
                            <button type="button" class="rule-name-btn" data-rule-id="${safeId}">${safeName}<span class="visually-hidden">, edit rule</span></button>
                            ${disabledChip}
                            ${notAppliedChip}
                            ${this.getRuleTypeBadgeHTML(rule)}
                            ${this.getHitCountHTML(rule)}
                        </div>
                        <!-- PER-70: the outcome comes before the URL so a long
                             pattern is what gets truncated, and the full text
                             is in the title. -->
                        <div class="rule-details" title="${this.escapeHtml(this.getRuleDetailsTitle(rule))}">
                            <span class="rule-method ${methodClass}">${safeMethod}</span><span class="rule-outcome">→ ${this.escapeHtml(this.getRuleSummaryText(rule))}</span> ${this.getRuleScopeChipHTML(rule)}<span class="rule-url">${safeUrl}</span>${this.getRuleDestinationHTML(rule)}
                        </div>
                    </div>
                    <div class="status-indicator" role="img" aria-label="${statusTooltip}" title="${statusTooltip}">${statusIcon}</div>
                </div>
                <div class="rule-actions">
                    ${this.getReorderHTML(safeId, safeName, index)}
                    <button class="rule-action" title="Edit" data-action="edit" data-rule-id="${safeId}" aria-label="Edit ${safeName}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                    </button>
                    <button class="rule-action" title="Duplicate" data-action="copy" data-rule-id="${safeId}" aria-label="Duplicate ${safeName}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                    <button class="rule-action" title="Check syntax" data-action="test" data-rule-id="${safeId}" aria-label="Check syntax of ${safeName}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>
                    </button>
                    <button class="rule-action" title="Delete" data-action="delete" data-rule-id="${safeId}" aria-label="Delete ${safeName}">
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
     *
     * PER-71: it used to always pick row 1, which left the acted-on row — and
     * Undo, which sits after the footer — a screen's worth of Tab presses away.
     * `target` is a rule id (focus that row, e.g. the copy a Duplicate just
     * made) or the visible index the removed row had (focus whichever row now
     * sits there, or the last one when it was the last). With neither it still
     * falls back to the first row, then the New rule button.
     */
    restoreListFocus(target) {
        // The row's focusable entry point is its name button (see
        // getRuleCardHTML); the card itself is no longer focusable.
        const buttons = Array.from(document.querySelectorAll('.rule-name-btn'));
        let next = null;
        if (typeof target === 'string') {
            // Matched by dataset, not a selector string: a rule id is arbitrary.
            next = buttons.find((el) => el.dataset.ruleId === target) || null;
        } else if (typeof target === 'number' && buttons.length) {
            next = buttons[Math.min(Math.max(target, 0), buttons.length - 1)];
        }
        if (!next) next = buttons[0] || null;
        if (next) {
            next.focus();
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
    getReorderHTML(safeId, safeName, index = 0) {
        if (this.searchTerm) return '';
        // PER-59: precedence is position, and a new broad rule far down the list
        // is shadowed by anything above it, so "Move to top" is one press
        // instead of N. Pointless on the row that is already first.
        const toTop = index > 0 ? `
                    <button class="rule-action" title="Move to top — matched before every other rule" data-action="move-top" data-rule-id="${safeId}" aria-label="Move ${safeName} to top">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/></svg>
                    </button>` : '';
        return `${toTop}
                    <button class="rule-action" title="Move up — matched before the rules below it" data-action="move-up" data-rule-id="${safeId}" aria-label="Move ${safeName} up">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m18 15-6-6-6 6"/></svg>
                    </button>
                    <button class="rule-action" title="Move down — matched after the rules above it" data-action="move-down" data-rule-id="${safeId}" aria-label="Move ${safeName} down">
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
            // PER-27: setRules validates what it is given and answers with the
            // rules it refused. This used to ignore that list and announce
            // success for the whole set.
            const rejected = this.normalizeRejected(response.rejected);
            const done = Math.max(rules.length - rejected.length, 0);
            const verb = anyEnabled ? 'Disabled' : 'Enabled';
            if (rejected.length) {
                this.showError(`${verb} ${done} of ${rules.length} — ${this.describeRejected(rejected)}`);
            } else {
                this.showNotification(`${verb} ${rules.length} rule${rules.length === 1 ? '' : 's'}`);
            }
        } catch (error) {
            console.error('Failed to toggle all rules:', error);
            this.showError('Could not update rules');
        }
    }

    /**
     * PROD-4: move a rule one position earlier or later (PER-59: or to the top).
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
        const toTop = delta === 'top';
        try {
            const fresh = await this.sendMessage({ type: 'getRules' });
            const rules = (fresh && fresh.success && Array.isArray(fresh.rules))
                ? fresh.rules
                : (this.rules || []);

            const from = rules.findIndex((r) => r && r.id === ruleId);
            if (from < 0) return;

            const to = toTop ? 0 : from + delta;
            if (to < 0 || to >= rules.length || to === from) return; // already at an end

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

            // PER-27: surface what the background refused rather than leaving
            // a rule missing from the list with no explanation.
            const rejected = this.normalizeRejected(response.rejected);
            if (rejected.length) {
                this.showError(`Could not save ${rejected.length} rule${rejected.length === 1 ? '' : 's'} — ${this.describeRejected(rejected)}`);
            }

            // Keep focus on the button that was pressed — renderRules() rebuilds
            // the list wholesale, which would otherwise drop focus to <body> and
            // make repeated presses impossible for keyboard users (A11Y-4).
            // Matched by dataset rather than built into a selector string: an
            // imported rule's id is arbitrary text and would need escaping to
            // be safe (and legal) inside an attribute selector.
            const action = toTop ? 'move-top' : (delta < 0 ? 'move-up' : 'move-down');
            const find = (name) => Array.from(document.querySelectorAll(`.rule-action[data-action="${name}"]`))
                .find((el) => el.dataset.ruleId === ruleId);
            // The row that reached the top no longer has a "Move to top".
            const btn = find(action) || (toTop ? find('move-down') : null);
            if (btn) btn.focus();
            else this.restoreListFocus(ruleId);
        } catch (error) {
            console.error('Failed to reorder rule:', error);
            this.showError('Could not reorder rules');
        }
    }

    /**
     * PER-27: `setRules` answers with the rules it refused, each as
     * { name, errors }. Older builds sent bare strings; accept both.
     */
    normalizeRejected(list) {
        return (Array.isArray(list) ? list : []).map((item) => {
            if (item && typeof item === 'object') {
                const errors = Array.isArray(item.errors) ? item.errors : (item.error ? [item.error] : []);
                return { name: item.name ? String(item.name) : '', errors: errors.map(String) };
            }
            return { name: '', errors: [String(item)] };
        });
    }

    /** One line naming the first few refused rules and why, for a toast. */
    describeRejected(rejected, limit = 3) {
        const shown = rejected.slice(0, limit).map((r) =>
            `${r.name ? `"${r.name}"` : 'a rule'}: ${r.errors.join('; ') || 'not valid'}`);
        const more = rejected.length > limit ? ` (+${rejected.length - limit} more)` : '';
        return shown.join(' · ') + more;
    }

    /**
     * PROD-7 / PER-55: the rule's hit count is the evidence that it works.
     * hitCount was incremented and persisted but rendered nowhere, so the most
     * basic question — "did my rule actually fire?" — could only be answered by
     * discovering the custom DevTools panel. The old per-rule "Test" could not
     * answer it either (it only re-ran the save-time validation, so it passed
     * for a rule that never matched), so an untouched rule now says so
     * explicitly instead of staying silent.
     */
    getHitCountHTML(rule) {
        const hits = Number(rule && rule.hitCount) || 0;
        if (hits <= 0) {
            return '<span class="hit-count is-none" title="This rule has not matched a request yet">No hits yet</span>';
        }
        const shown = hits > 999 ? '999+' : String(hits);
        const label = hits === 1 ? '1 hit' : `${shown} hits`;
        return `<span class="hit-count" title="Times this rule has been applied">${label}</span>`;
    }

    /** The "Disabled" chip markup, shared by the renderer and toggleRule. */
    getDisabledChipHTML() {
        return '<span class="disabled-chip">Disabled</span>';
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
            queryparams: 'Query Params',
            // F3: the badge is the short name; the long one, "Modify request
            // body", is the row's outcome and what search matches.
            requestBody: 'Request body'
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
     * Get the short human-readable outcome shown at the start of a rule row's
     * detail line. Plain text — callers escape it. Guards on `rule.response`
     * since only `type: 'mock'` rules have a response object in the v2 schema
     * (block/delay/redirect/headers/queryparams do not).
     */
    getRuleSummaryText(rule) {
        const type = rule.type || 'mock';

        switch (type) {
            case 'block':
                return 'Blocked';
            case 'delay':
                return `Delayed ${rule.delayMs || 0}ms`;
            case 'redirect':
                return 'Redirect';
            case 'headers':
                return 'Modify headers';
            case 'queryparams':
                return 'Modify query params';
            case 'requestBody': {
                // F3: what happens to the body, not just that it is modified.
                const mode = rule.requestBody && rule.requestBody.mode;
                if (mode === 'patch') return 'Patch body';
                if (mode === 'static') return 'Replace body';
                return 'Modify request body';
            }
            case 'mock':
            default: {
                if (!rule.response) return '200 OK';
                const delaySuffix = rule.response.delay ? ` (+${rule.response.delay}ms)` : '';
                // F4: a code response has no status of its own to show; the
                // function picks it at run time.
                if (rule.response.mode === 'code') return `Code response${delaySuffix}`;
                return `${rule.response.statusCode || 200} ${rule.response.statusText || 'OK'}${delaySuffix}`;
            }
        }
    }

    /**
     * F1 / F4: the small chips that say how far a rule reaches or how it
     * answers — "All requests" for a redirect or block that also covers
     * scripts, images and pages, and "Code" for a mock that runs JavaScript.
     * A code rule says so when Settings has code responses switched off, since
     * then it lets the request through instead of answering.
     *
     * They sit on the detail line, after the outcome. The name line already
     * carries Disabled, the type and the hit count, and a fourth chip there
     * squeezed the rule's name down to a letter.
     */
    getRuleScopeChipHTML(rule) {
        const type = rule.type || 'mock';
        let html = '';
        if ((type === 'redirect' || type === 'block') && rule.appliesTo === 'all') {
            html += '<span class="rule-scope-chip" title="Also applies to scripts, images, pages and every other resource type, not only fetch and XHR">All requests</span>';
        }
        if (type === 'mock' && rule.response && rule.response.mode === 'code') {
            const allowed = !!(this.settings && this.settings.allowCodeResponses);
            html += allowed
                ? '<span class="rule-scope-chip" title="Answers with your JavaScript">Code</span>'
                : '<span class="rule-scope-chip is-off" title="Code responses are turned off in Settings, so this rule lets requests through">Code<span class="visually-hidden"> (off in Settings)</span></span>';
        }
        return html;
    }

    /**
     * PER-70: a redirect's destination follows the URL it replaces. It is what
     * a long pattern would otherwise push out of the row, so it goes last.
     */
    getRuleDestinationHTML(rule) {
        if ((rule.type || 'mock') !== 'redirect') return '';
        const destination = (rule.redirect && rule.redirect.destination) || '(no destination)';
        return ` <span class="rule-dest">→ ${this.escapeHtml(destination)}</span>`;
    }

    /** PER-70: the full, untruncated detail line, for the row's tooltip. */
    getRuleDetailsTitle(rule) {
        const method = (rule.match && rule.match.method) || 'GET';
        const url = (rule.match && rule.match.url) || '';
        const destination = (rule.type === 'redirect')
            ? ` → ${(rule.redirect && rule.redirect.destination) || '(no destination)'}`
            : '';
        return `${method} ${url} → ${this.getRuleSummaryText(rule)}${destination}`;
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
                <p>Create a rule, or record a real response from your app and turn it into one.</p>
                <!-- PER-61: the first-run screen had no buttons; the only
                     way in was a footer control or an undocumented shortcut. -->
                <div class="empty-actions">
                    <button type="button" class="mini-btn is-primary empty-btn" data-empty-action="create">Create a rule</button>
                    <button type="button" class="mini-btn empty-btn" data-empty-action="record">Record a real response</button>
                </div>
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

            // A-16's keyboard path now comes from the rule-name <button>: a
            // native button turns Enter/Space into a click, which bubbles to
            // this handler like a mouse click does. No separate keydown path.
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
                    // PER-76: the chip is rendered once with the row, so it was
                    // left behind (or never added) when the switch moved.
                    const chip = card.querySelector('.disabled-chip');
                    if (rule.enabled) {
                        if (chip) chip.remove();
                    } else if (!chip) {
                        const nameBtn = card.querySelector('.rule-name-btn');
                        if (nameBtn) nameBtn.insertAdjacentHTML('afterend', this.getDisabledChipHTML());
                    }
                }

                this.updateStatus();
                // PER-59: which rules shadow which depends on what is enabled.
                this.scheduleShadowChips();
                if (response.dnrWarning) {
                    // The toggle is stored, but Chrome did not apply part of
                    // the network ruleset — say so rather than "enabled".
                    this.showError(`Rule ${rule.enabled ? 'enabled' : 'disabled'}, but ${response.dnrWarning}`);
                } else {
                    this.showNotification(`Rule ${rule.enabled ? 'enabled' : 'disabled'}`);
                }
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
            case 'move-top':
                await this.moveRule(ruleId, 'top');
                break;
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
        await this.openEditor(
            { mode: 'edit', rule },
            `options/options.html?editRule=${encodeURIComponent(ruleId)}`
        );
    }

    /**
     * Open the in-page editor on the active tab and close the popup — or, when
     * that is not possible, say why (PER-32) or fall back to the full editor.
     */
    async openEditor(payload, optionsPath) {
        const outcome = await this.openRuleOverlay(payload);
        if (outcome.needsReload) {
            // PER-32: an http(s) tab with no content script was open before
            // SpliceTap was installed or updated. The editor cannot open there
            // and, worse, rules would not apply until it reloads — so say so,
            // instead of silently opening a different page and leaving the user
            // to find out why their first rule does nothing.
            this.renderReloadNotice(outcome.tabId);
            return;
        }
        if (!outcome.opened) {
            // Overlay can't be injected here (chrome://, Web Store, PDF viewer,
            // etc.) — fall back to the full options editor in a tab.
            await chrome.tabs.create({ url: chrome.runtime.getURL(optionsPath) });
        }
        window.close();
    }

    /**
     * Ask the active tab's content script to show the in-page rule editor.
     * Resolves { opened } — or { needsReload, tabId } when the tab is an
     * ordinary web page that has no content script to ask (PER-32).
     */
    async openRuleOverlay(payload) {
        let tab = null;
        try {
            [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) {
                return { opened: false };
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

            return { opened: !!(response && response.success) };
        } catch (error) {
            // No content script on this page (or it hasn't loaded yet). On a
            // page that could host one, a reload fixes it; on the Web Store and
            // the like it never will, so those keep the options-page fallback.
            const noReceiver = /Receiving end does not exist|Could not establish connection/i
                .test(String(error && error.message));
            if (noReceiver && tab && tab.id && this.canHostContentScript(tab.url)) {
                return { opened: false, needsReload: true, tabId: tab.id };
            }
            return { opened: false };
        }
    }

    /** http(s) pages Chrome lets extensions script — i.e. where a reload helps. */
    canHostContentScript(url) {
        try {
            const u = new URL(url);
            if (!/^https?:$/.test(u.protocol)) return false;
            if (u.hostname === 'chromewebstore.google.com') return false;
            if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return false;
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * PER-32: "Reload this tab to start intercepting" with a Reload button.
     * Sits under the header so it shows on every tab.
     */
    renderReloadNotice(tabId) {
        const existing = document.getElementById('reloadNotice');
        if (existing) existing.remove();

        const header = document.querySelector('.header');
        if (!header || !header.parentNode) return;

        const notice = document.createElement('div');
        notice.id = 'reloadNotice';
        notice.className = 'site-access-notice reload-notice';
        notice.setAttribute('role', 'note');

        const text = document.createElement('span');
        text.textContent = 'Reload this tab to start intercepting.';
        notice.appendChild(text);

        const reloadBtn = document.createElement('button');
        reloadBtn.type = 'button';
        reloadBtn.id = 'reloadTabBtn';
        reloadBtn.className = 'site-access-grant-btn';
        reloadBtn.textContent = 'Reload';
        reloadBtn.addEventListener('click', async () => {
            try {
                await chrome.tabs.reload(tabId);
                notice.remove();
                this.showNotification('Tab reloaded — click New rule again');
                const newRule = document.getElementById('newRuleBtn');
                if (newRule) newRule.focus();
            } catch (error) {
                console.error('Failed to reload the tab:', error);
                this.showError('Could not reload the tab');
            }
        });
        notice.appendChild(reloadBtn);

        header.parentNode.insertBefore(notice, header.nextSibling);
        this.announce('Reload this tab to start intercepting.', 'info');
        reloadBtn.focus();
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
            const suffix = ' (Copy)';
            newRule.name = `${String(rule.name || 'Unnamed Rule').slice(0, 100 - suffix.length)}${suffix}`;
            newRule.enabled = false;
            newRule.created = new Date().toISOString();
            // PROD-1: dnrRuleId identifies a declarativeNetRequest rule, and
            // saveRule only allocates one when it is missing. Cloning it meant
            // enabling the copy sent Chrome two DNR rules with the same id;
            // updateDynamicRules rejects the whole batch, so EVERY headers and
            // queryparams rule silently stopped applying. Drop it so the copy
            // gets its own.
            delete newRule.dnrRuleId;
            // The counter describes the original's traffic, not the copy's.
            delete newRule.hitCount;

            // PER-59: saveRule appends to the end of the list — below every
            // rule that could shadow the copy, and far from the rule it copies.
            // Insert it directly below its original instead, via the bulk path.
            const fresh = await this.sendMessage({ type: 'getRules' });
            const current = (fresh && fresh.success && Array.isArray(fresh.rules)) ? fresh.rules : (this.rules || []);
            const at = current.findIndex((r) => r && r.id === ruleId);
            const next = current.slice();
            next.splice(at < 0 ? next.length : at + 1, 0, newRule);

            const response = await this.sendMessage({ type: 'setRules', rules: next });
            const rejected = this.normalizeRejected(response && response.rejected);
            const saved = response && response.success
                && (!Array.isArray(response.rules) || response.rules.some((r) => r.id === newRule.id));

            if (saved) {
                await this.loadData();
                // U-15: loadData() resets filteredRules to the full list —
                // re-apply whatever search is active instead of dropping it.
                this.applySearchFilter();
                this.updateStatus();
                this.updateTabCount();
                // A11Y-4 / PER-71: same rebuild-destroys-focus problem as
                // delete; land on the new copy, which sits just below.
                this.restoreListFocus(newRule.id);
                this.showNotification('Rule duplicated');
            } else if (rejected.length) {
                this.showError(`Could not duplicate — ${this.describeRejected(rejected)}`);
            } else {
                this.showError((response && response.error) || 'Failed to duplicate rule');
            }
        } catch (error) {
            console.error('Failed to copy rule:', error);
            this.showError('Failed to duplicate rule');
        }
    }

    /**
     * PER-55: what the per-rule check currently says about a rule, as the
     * glyph key and its accessible name. It is a syntax check — the save-time
     * validation run again — so it can say "Valid" for a rule that has never
     * matched a single request; that is why it no longer calls itself a pass.
     */
    getCheckStatus(rule) {
        const check = this.checks.get(rule.id);
        if (!check) return { key: 'pending', label: 'Not checked' };
        if (check.valid) return { key: 'valid', label: 'Valid (syntax check only)' };
        return { key: 'failed', label: `Invalid: ${check.message || 'the rule failed validation'}` };
    }

    /** The rendered row for a rule id, or null. */
    findRuleCard(ruleId) {
        return Array.from(document.querySelectorAll('.rule-card'))
            .find((el) => el.dataset.ruleId === ruleId) || null;
    }

    /** Re-draw one row's check glyph and its accessible name. */
    updateStatusIndicator(rule) {
        const card = this.findRuleCard(rule.id);
        const indicator = card && card.querySelector('.status-indicator');
        if (!indicator) return;
        const status = this.getCheckStatus(rule);
        // A-9/A-18: keep the accessible name in sync with the new status, not
        // just the visual icon.
        indicator.innerHTML = this.getStatusIcon(status.key);
        indicator.title = status.label;
        indicator.setAttribute('aria-label', status.label);
    }

    /**
     * Check rule. PER-55: this re-runs the save-time validation and nothing
     * else, so the result is "Valid"/"Invalid" — it used to be a green "Test
     * passed" for a rule that had never matched anything.
     */
    async testRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        const card = this.findRuleCard(ruleId);
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
                const message = response.passed ? '' : this.firstCheckMessage(response);
                this.checks.set(ruleId, { valid: !!response.passed, message });
                this.updateStatusIndicator(rule);

                if (response.passed) {
                    this.showNotification('Valid (syntax check only)');
                } else {
                    this.showError(`Invalid: ${message || 'the rule failed validation'}`);
                }
            } else {
                this.showError('Could not check the rule');
            }

        } catch (error) {
            console.error('Check failed:', error);
            this.showError('Could not check the rule');
        } finally {
            if (statusIndicator) {
                statusIndicator.classList.remove('is-busy');
                statusIndicator.removeAttribute('aria-busy');
            }
        }
    }

    /** The first validation message in a testRule response. */
    firstCheckMessage(response) {
        const found = (response.results || []).find((r) => r && r.message);
        return found ? String(found.message) : '';
    }

    /**
     * Delete rule
     */
    async deleteRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        // PER-29 / PER-71: remember where the rule sat — in the stored order,
        // for Undo, and in the visible list, for focus.
        const position = this.rules.findIndex(r => r.id === ruleId);
        const where = {
            index: position,
            afterId: position > 0 ? this.rules[position - 1].id : null,
            visibleIndex: this.filteredRules.findIndex(r => r.id === ruleId)
        };

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
                this.checks.delete(ruleId);
                await this.loadData();
                this.applySearchFilter();
                this.updateStatus();
                this.updateTabCount();
                // A11Y-4: renderRules() rebuilds the list via innerHTML, which
                // destroys the Delete button that was just activated — focus
                // then falls to <body> and a keyboard user has to Tab from the
                // top of the popup again. Park focus on the neighbouring row
                // (PER-71); the toast below then takes it for Undo.
                this.restoreListFocus(where.visibleIndex);
                this.showUndoToast(`Deleted "${rule.name}"`, rule, where);
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
            // F3: the type's long name, so "modify request body" finds these
            // (the key above is the one-word "requestBody").
            rule.type === 'requestBody' ? 'modify request body' : '',
            rule.requestBody ? JSON.stringify(rule.requestBody) : '',
            // F1: the chip text on the row.
            rule.appliesTo === 'all' ? 'all requests' : '',
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
        await this.openEditor({ mode: 'new' }, 'options/options.html?action=new');
    }

    /**
     * Check all enabled rules (PER-55: syntax only — see testRule).
     */
    async testAllRules() {
        const enabledRules = this.rules.filter(r => r.enabled);

        if (enabledRules.length === 0) {
            this.showNotification('No enabled rules to check');
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
                    this.checks.set(rule.id, {
                        valid: !!response.passed,
                        message: response.passed ? '' : this.firstCheckMessage(response)
                    });
                    if (response.passed) passed++;
                    else failed++;
                }

                await this.delay(200);
            }

            this.renderRules();
            const summary = `Checked ${passed + failed}: ${passed} valid, ${failed} invalid (syntax only)`;
            if (failed) this.showError(summary);
            else this.showNotification(summary);
        } catch (error) {
            this.showError('Checking failed');
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
        } else if (this.rules.length > 0) {
            // PER-69: "No rules" was wrong here — there are rules, none are on.
            statusText.textContent = `Active (0/${this.rules.length})`;
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
            // PER-53: the counter restarts daily (see the background's stats
            // reset), so an unqualified "N intercepts" read as an all-time total.
            statsText.textContent = `${count} ${count === 1 ? 'intercept' : 'intercepts'} today`;
            statsText.title = 'Counts requests handled today; resets daily';
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
            if (tab) {
                tab.setAttribute('aria-selected', String(on));
                // PER-85: roving tabindex — the tablist is one Tab stop (the
                // selected tab) and arrow keys move within it, as the tabs
                // pattern says; all three used to be separate stops.
                tab.setAttribute('tabindex', on ? '0' : '-1');
            }
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

        const codeEl = document.getElementById('allowCodeResponses');
        if (codeEl) codeEl.checked = !!s.allowCodeResponses;
        this.updateCodeWarning();

        this.refreshObserveToggle();
    }

    // ── F2: header, query-param and all-request rules in the log ───────────

    /** The optional permission the background's network observer needs. */
    static get OBSERVE_PERMISSIONS() {
        return { permissions: ['webRequest'] };
    }

    /** The inline note under the switch; empty text hides it. */
    setObserveNote(text) {
        const note = document.getElementById('observeNote');
        if (!note) return;
        note.textContent = text || '';
        note.hidden = !text;
    }

    /**
     * Show the switch as on only while the setting is on AND Chrome still
     * holds the permission. The user can take the permission back from
     * chrome://extensions at any time, which leaves the stored setting on but
     * the observer unable to run; the switch must not claim otherwise.
     */
    async refreshObserveToggle() {
        const input = document.getElementById('observeNetworkRules');
        if (!input || this._observeBusy) return;

        const wanted = !!(this.settings && this.settings.observeNetworkRules);
        input.checked = wanted;
        if (!wanted) return;

        // A newer render, or a click, supersedes this check.
        const seq = (this._observeSeq = (this._observeSeq || 0) + 1);
        let held = false;
        try {
            held = !!(await chrome.permissions.contains(SpliceTapPopup.OBSERVE_PERMISSIONS));
        } catch (error) {
            console.warn('SpliceTap popup: could not check the webRequest permission', error);
        }
        if (seq !== this._observeSeq || this._observeBusy) return;

        input.checked = held;
        this.setObserveNote(held ? '' : 'Chrome\'s "webRequest" permission is no longer granted, so this is off. Switch it on to grant it again.');
    }

    onObserveToggle(input) {
        // A second click while Chrome's prompt or the save is pending would
        // race the first; put the switch back where the pending change left it.
        if (this._observeBusy) {
            input.checked = !input.checked;
            return;
        }
        this._observeSeq = (this._observeSeq || 0) + 1;

        if (input.checked) {
            // F2: called synchronously, inside the click's user gesture.
            let request;
            try {
                request = Promise.resolve(chrome.permissions.request(SpliceTapPopup.OBSERVE_PERMISSIONS));
            } catch (error) {
                request = Promise.reject(error);
            }
            this._observeBusy = true;
            this.setObserveNote('');
            this.completeObserveOn(input, request);
        } else {
            this._observeBusy = true;
            this.completeObserveOff(input);
        }
    }

    async completeObserveOn(input, request) {
        try {
            let granted = false;
            try {
                granted = !!(await request);
            } catch (error) {
                console.warn('SpliceTap popup: webRequest permission request failed', error);
                input.checked = false;
                this.setObserveNote('Chrome could not ask for the permission, so this stays off.');
                this.announce('Could not ask for the permission. The setting stays off.', 'error');
                return;
            }

            if (!granted) {
                // Declined (or dismissed): nothing was changed, so say so.
                input.checked = false;
                const note = 'Permission was declined, so these rules still won\'t appear in the log. Nothing else changed.';
                this.setObserveNote(note);
                this.announce(note);
                return;
            }

            this.settings.observeNetworkRules = true;
            if (await this.saveSettings()) {
                this.announce('Header, query-param and all-request rules will now appear in the log.');
            } else {
                this.settings.observeNetworkRules = false;
                input.checked = false;
            }
        } finally {
            this._observeBusy = false;
        }
    }

    async completeObserveOff(input) {
        try {
            this.settings.observeNetworkRules = false;
            this.setObserveNote('');
            if (!(await this.saveSettings())) {
                // The background still has it on; keep the permission with it.
                this.settings.observeNetworkRules = true;
                input.checked = true;
                return;
            }
            try {
                await chrome.permissions.remove(SpliceTapPopup.OBSERVE_PERMISSIONS);
            } catch (error) {
                // Setting is off already, so the observer is stopped either way.
                console.warn('SpliceTap popup: could not release the webRequest permission', error);
            }
            this.announce('These rules no longer appear in the log. The permission was given back.');
        } finally {
            this._observeBusy = false;
        }
    }

    // ── F4: code responses ──────────────────────────────────────────────────

    /** The one-line warning shows exactly while code responses are allowed. */
    updateCodeWarning() {
        const warning = document.getElementById('codeWarn');
        if (warning) warning.hidden = !(this.settings && this.settings.allowCodeResponses);
    }

    async onCodeResponsesToggle(input) {
        const allowed = input.checked;
        this.settings.allowCodeResponses = allowed;
        this.updateCodeWarning();
        if (await this.saveSettings()) {
            // Rows say "Code" or "Code (off in Settings)"; keep them current.
            if ((this.rules || []).some((r) => r && r.response && r.response.mode === 'code')) this.renderRules();
            this.announce(allowed ? 'Code responses are on. Rules set to Code will run JavaScript.' : 'Code responses are off.');
        } else {
            // Not stored, so don't leave the switch claiming it is.
            this.settings.allowCodeResponses = !allowed;
            input.checked = !allowed;
            this.updateCodeWarning();
        }
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
                return false;
            }
            return true;
        } catch (error) {
            console.error('Failed to save settings:', error);
            this.showError('Could not save settings');
            return false;
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

    /**
     * PER-61: the empty state's "Record a real response". Arms Capture and
     * shows where the recordings will appear.
     */
    async startRecording() {
        await this.setCaptureArmed(true);
        if (!(this.settings && this.settings.captureArmed)) return; // refused; the error is shown
        this.switchTab('data');
        const toggle = document.getElementById('captureArmed');
        if (toggle) toggle.focus();
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
            // PER-82: every capture's buttons were just "Mock" and "Patch", so
            // a screen reader user could not tell which request each one acts
            // on. The visible word stays first in the name (WCAG 2.5.3).
            const target = `${c.method} ${this.capturePath(c.url)}`;
            const mockLabel = this.escapeHtml(`Mock ${target}`);
            const patchLabel = this.escapeHtml(`Patch ${target}`);
            // PER-19: a patch is a merge into a JSON *object*. Against an array
            // or a scalar the only rule it can express is `{}`, which replaces
            // the real response — so Patch is not offered for those.
            const patchButton = this.isPatchableBody(c.body)
                ? `<button type="button" class="mini-btn" data-capture-action="patch" data-capture-id="${this.escapeHtml(c.id)}" title="Create a rule that edits this response, keeping the rest live" aria-label="${patchLabel}">Patch</button>`
                : '';
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
                        <button type="button" class="mini-btn" data-capture-action="mock" data-capture-id="${this.escapeHtml(c.id)}" title="Create a rule returning this exact response" aria-label="${mockLabel}">Mock</button>
                        ${patchButton}
                    </div>
                </div>`;
        }).join('');

        // Listeners die with the buttons: renderCaptures replaces this list's
        // markup wholesale, so there is nothing to track for later removal.
        // An earlier version recorded them in a registry copied from
        // options.js that the popup never declared — the push threw on every
        // popup open and stopped init() before the rules were ever loaded.
        list.querySelectorAll('[data-capture-action]').forEach((btn) => {
            btn.addEventListener('click', () => this.createRuleFromCapture(btn.dataset.captureId, btn.dataset.captureAction));
        });
    }

    /**
     * PER-60: open the editor on the rule a capture just produced, on the active
     * tab, with the captured body as a read-only reference. A tab with no content
     * script (the "Receiving end does not exist" error, or a page that can't host
     * one) gets the full editor in a new tab instead. The rule exists either way,
     * so this never shows PER-32's reload notice: that would leave it unedited.
     */
    async handOffToEditor(rule, referenceBody) {
        let opened = false;
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && typeof tab.id === 'number' && /^https?:/i.test(tab.url || '')) {
                const response = await chrome.tabs.sendMessage(tab.id, {
                    type: 'openRuleOverlay', mode: 'edit', rule, referenceBody
                });
                opened = !!(response && response.success);
            }
        } catch (error) {
            opened = false; // no receiver: fall back below
        }
        if (!opened) {
            try {
                await chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html?editRule=${encodeURIComponent(rule.id)}`) });
            } catch (error) {
                console.warn('Could not open the editor for the new rule:', error);
                return;
            }
        }
        window.close();
    }

    /** Path (no origin or query) of a captured URL, for button names. */
    capturePath(url) {
        try {
            return new URL(url).pathname;
        } catch (error) {
            return String(url || '').split(/[?#]/)[0] || '/';
        }
    }

    /** PER-19: true when a captured body is a JSON object (patchable). */
    isPatchableBody(body) {
        try {
            const parsed = JSON.parse(body);
            return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        } catch (error) {
            return false;
        }
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

        // PER-19: the list does not offer Patch for these; refuse here too.
        if (mode === 'patch' && !this.isPatchableBody(capture.body)) {
            this.showError('Patch needs a JSON object response — use Mock for this one');
            return;
        }

        let parsedBody = null;
        try {
            parsedBody = JSON.parse(capture.body);
        } catch (error) {
            parsedBody = null; // not JSON — keep the raw text
        }

        // Pattern the exact path, not the whole origin: capturing /api/users/42
        // should not produce a rule that swallows every request on the host.
        // Always a wildcard around the path. Captures now record absolute URLs,
        // but one that still cannot be parsed must not fall back to the raw
        // string: that kept the query string, and a path such as "/api/" is
        // read by the matcher as the regex /api/ — a mock for every URL that
        // contains "api".
        let path;
        try {
            path = new URL(capture.url).pathname;
        } catch (error) {
            path = String(capture.url || '').split(/[?#]/)[0] || '/';
        }
        const urlPattern = `*${path.startsWith('/') ? path : '/' + path}*`;

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
            // PER-60: this used to leave the user on the Data tab with nothing
            // to show for the click. Go to the new rule, and land on it: clear
            // any search that would hide it, then focus (which scrolls) its row.
            const search = document.getElementById('searchInput');
            if (search && search.value) {
                search.value = '';
                this.searchTerm = '';
                if (this.searchClearBtn) this.searchClearBtn.hidden = true;
            }
            this.applySearchFilter();
            this.updateStatus();
            this.updateTabCount();
            this.switchTab('rules');
            const row = this.findRuleCard(rule.id);
            if (row) row.scrollIntoView({ block: 'nearest' });
            this.restoreListFocus(rule.id);
            this.showNotification(
                isPatch
                    ? 'Patch rule created (off) — add the fields to change, then switch it on'
                    : 'Mock rule created (off) — switch it on when you are ready'
            );
            // PER-60: and open it in the editor, with the captured response beside it.
            await this.handOffToEditor(this.rules.find((r) => r.id === rule.id) || rule, capture.body);
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
        // PER-62: hitCount and friends are this browser's own bookkeeping.
        // Exporting them made a shared pack arrive with someone else's traffic
        // counts ("40 hits" on a rule that has never run here).
        const payload = {
            exportedAt: new Date().toISOString(),
            rules: rules.map((rule) => this.stripRuntimeFields(rule))
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

    /** Fields that describe this browser's use of a rule, not the rule. */
    stripRuntimeFields(rule) {
        const clean = { ...rule };
        for (const key of ['hitCount', 'testStatus', 'testError', 'dnrRuleId']) delete clean[key];
        return clean;
    }

    /**
     * PER-62: a stable fingerprint of what a rule DOES — type, match and
     * payload — ignoring identity and bookkeeping (id, name, enabled, dates,
     * counters). Two rules with the same fingerprint are exact duplicates.
     */
    ruleSignature(rule) {
        const IGNORED = new Set(['id', 'name', 'enabled', 'created', 'lastModified', 'hitCount', 'testStatus', 'testError', 'dnrRuleId']);
        const canon = (value) => {
            if (Array.isArray(value)) return value.map(canon);
            if (value && typeof value === 'object') {
                return Object.keys(value).sort().reduce((out, key) => { out[key] = canon(value[key]); return out; }, {});
            }
            return value;
        };
        const body = {};
        for (const key of Object.keys(rule)) if (!IGNORED.has(key)) body[key] = rule[key];
        if (!body.type) body.type = 'mock'; // legacy v1 rules have no type
        return JSON.stringify(canon(body));
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
            this.updateImportMode();
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
     * PER-62: keep the confirm button's wording in step with the mode. With
     * "Keep existing rules" off the import REPLACES everything, so the button
     * says exactly what it will do, and a pending confirmation is cancelled.
     */
    updateImportMode() {
        const merge = document.getElementById('importMerge');
        const btn = document.getElementById('importConfirmBtn');
        const convert = document.getElementById('importConvertBtn');
        const warn = document.getElementById('importReplaceWarn');
        const count = (this.rules || []).length;
        const replacing = !!merge && !merge.checked && count > 0;
        const offer = this.requestlyOffer;

        this.replaceArmed = 0;
        // B2-F6: while the pasted JSON is a Requestly export, "Convert N
        // Requestly rules" is the primary action and the plain Import (which
        // could only refuse it) steps aside.
        const style = (button, label) => {
            button.textContent = label;
            button.classList.toggle('is-danger', replacing);
            button.classList.toggle('is-primary', !replacing);
        };
        if (btn) {
            btn.hidden = !!offer;
            style(btn, replacing ? `Replace all ${count} rule${count === 1 ? '' : 's'}` : 'Import');
        }
        if (convert) {
            convert.hidden = !offer;
            if (offer) {
                style(convert, replacing
                    ? `Replace all ${count} with ${offer.count} converted`
                    : window.SpliceTapPopupHelpers.convertLabel(offer.count));
            }
        }
        const note = document.getElementById('importOffer');
        if (note) {
            note.hidden = !offer;
            note.textContent = offer
                ? `This looks like a Requestly export with ${offer.count} rule${offer.count === 1 ? '' : 's'}. SpliceTap converts what it can and lists anything it could not.`
                : '';
        }
        if (warn) {
            warn.hidden = true;
            warn.textContent = '';
        }
    }

    /**
     * B2-F6: look at the pasted text a moment after the last keystroke and, if
     * it is a Requestly export, offer to convert it. Nothing here can throw: a
     * half-typed paste is simply not JSON yet.
     */
    scheduleRequestlyCheck() {
        clearTimeout(this._requestlyTimer);
        this._requestlyTimer = setTimeout(() => this.refreshRequestlyOffer({ announce: true }), 150);
    }

    /** Parse the import box. Returns { parsed } or { error }. */
    readImportJson() {
        const ta = document.getElementById('importJson');
        const raw = ((ta && ta.value) || '').trim();
        if (!raw) return { empty: true };
        try {
            return { parsed: JSON.parse(raw) };
        } catch (error) {
            return { error };
        }
    }

    /**
     * Decide whether the box holds a Requestly export and show or hide the
     * "Convert N Requestly rules" action to match. Returns the offer or null.
     */
    refreshRequestlyOffer({ announce = false } = {}) {
        const helpers = window.SpliceTapPopupHelpers;
        const read = this.readImportJson();
        const importer = helpers.requestlyImporter();
        let next = null;
        if (read.parsed !== undefined && importer && helpers.detectRequestly(importer, read.parsed)) {
            next = { count: helpers.countRequestlyRules(read.parsed) };
        }
        const was = this.requestlyOffer;
        if (!next && !was) return null;
        if (next && was && next.count === was.count) return next;
        this.requestlyOffer = next;
        // A replace confirmation was for the other action; start it over.
        this.updateImportMode();
        if (next && announce && (!was || was.count !== next.count)) {
            this.announce(`This looks like a Requestly export with ${next.count} rule${next.count === 1 ? '' : 's'}. Use "${helpers.convertLabel(next.count)}" to import them.`, 'info');
        }
        return next;
    }

    /** Typing or toggling after the warning appeared cancels the confirmation. */
    disarmReplace() {
        if (this.replaceArmed) this.updateImportMode();
    }

    /** First click of a replace-mode import: say what is about to be lost. */
    armReplace(count) {
        // B2-F6: the Convert button is the primary action while it is showing.
        const btn = document.getElementById(this.requestlyOffer ? 'importConvertBtn' : 'importConfirmBtn');
        const warn = document.getElementById('importReplaceWarn');
        const noun = `${count} rule${count === 1 ? '' : 's'}`;
        this.replaceArmed = count;
        if (btn) {
            btn.textContent = `Replace all ${noun} — confirm`;
            btn.classList.add('is-danger');
            btn.classList.remove('is-primary');
        }
        const message = `This deletes your ${noun} and cannot be undone. Click again to replace them, or tick "Keep existing rules".`;
        if (warn) {
            warn.textContent = message;
            warn.hidden = false;
        }
        this.announce(message, 'error');
    }

    /**
     * PER-62: say what the last import skipped and why, in the Data tab, until
     * dismissed. It used to be a 3-second green toast with a count and no
     * names; the background had already worked out each reason.
     */
    renderImportReport() {
        const el = document.getElementById('importReport');
        if (!el) return;
        const report = this.importReport;
        if (!report) {
            el.hidden = true;
            el.innerHTML = '';
            return;
        }

        const skipped = report.skipped || [];
        const warnings = report.warnings || [];
        const converted = report.converted || [];
        el.hidden = false;
        el.className = `import-report${skipped.length ? ' is-error' : ''}`;
        el.setAttribute('role', 'group');
        el.setAttribute('aria-labelledby', 'importReportTitle');
        const items = skipped.map((item) => `
            <li><span class="ir-name">${this.escapeHtml(item.name || '(unnamed rule)')}</span><span class="ir-reason">${this.escapeHtml((item.errors || []).join('; ') || 'not valid')}</span></li>`).join('');
        // B2-F6: a conversion report has three parts - converted, skipped with
        // reasons, and warnings (the rule was kept, but behaves a little
        // differently from Requestly's). A plain import only ever had the middle one.
        const sectioned = !!report.conversion;
        const warningItems = warnings.map((item) => `
            <li><span class="ir-name">${this.escapeHtml(item.name || '(unnamed rule)')}</span><span class="ir-warn">${this.escapeHtml(item.message)}</span></li>`).join('');
        const convertedItems = converted.map((name) => `<li>${this.escapeHtml(name || '(unnamed rule)')}</li>`).join('');
        el.innerHTML = `
            <h3 class="import-report-title" id="importReportTitle">${this.escapeHtml(report.summary)}</h3>
            ${sectioned && convertedItems ? `<details class="import-report-converted"><summary>Converted (${converted.length})</summary><ul class="import-report-names">${convertedItems}</ul></details>` : ''}
            ${items ? `${sectioned ? `<h4 class="import-report-heading">Skipped (${skipped.length})</h4>` : ''}<ul class="import-report-list">${items}</ul>` : ''}
            ${warningItems ? `<h4 class="import-report-heading">Warnings (${warnings.length})</h4><ul class="import-report-list">${warningItems}</ul>` : ''}
            <div class="sub-actions"><button type="button" class="mini-btn" id="importReportDismiss">Dismiss</button></div>`;
        const dismiss = document.getElementById('importReportDismiss');
        if (dismiss) {
            dismiss.addEventListener('click', () => {
                this.importReport = null;
                this.renderImportReport();
                const trigger = document.getElementById('importToggleBtn');
                if (trigger) trigger.focus();
            });
        }
    }

    /**
     * Parse pasted JSON and hand it to the background's bulk `setRules`,
     * which validates each rule, skips the bad ones and allocates DNR ids —
     * so this deliberately does not re-implement that validation.
     *
     * PER-5 / PER-62: "Keep existing rules" appends the import AFTER the rules
     * already there (it used to put it first, so a teammate's broad mock
     * silently out-ranked the user's own), skips exact duplicates instead of
     * doubling every rule on a re-import, and reports every rule it did not
     * import with its reason. Replace mode needs a second, confirming click.
     */
    async confirmImport() {
        const ta = document.getElementById('importJson');
        const read = this.readImportJson();
        if (read.empty) {
            this.showError('Paste some JSON first');
            return;
        }
        if (read.error) {
            this.showError('That is not valid JSON');
            return;
        }
        const parsed = read.parsed;
        const incoming = Array.isArray(parsed) ? parsed : parsed && parsed.rules;

        // A Requestly export (rules with `ruleType` and `pairs`, plus group
        // objects) is well-formed — just not SpliceTap's schema. It used to be
        // reported as "Imported 0 rules, skipped N invalid", which tells
        // someone switching tools their file is broken.
        // B2-F6: and then it was explained but not converted. With the
        // converter loaded, the explanation is now the "Convert N Requestly
        // rules" action; this click shows it (the paste already did, if the
        // box saw the input event) and hands focus to it.
        const offer = this.refreshRequestlyOffer({ announce: false });
        if (offer) {
            const label = window.SpliceTapPopupHelpers.convertLabel(offer.count);
            this.announce(`This looks like a Requestly export with ${offer.count} rule${offer.count === 1 ? '' : 's'}. Use "${label}" to import them.`, 'info');
            const convert = document.getElementById('importConvertBtn');
            if (convert) convert.focus();
            return;
        }
        if (!Array.isArray(incoming) || !incoming.length) {
            this.showError('No rules found in that JSON');
            return;
        }
        const isRequestlyItem = (item) => item && typeof item === 'object'
            && (Array.isArray(item.pairs) && typeof item.ruleType === 'string' || item.objectType === 'group');
        if (incoming.some(isRequestlyItem)) {
            // The converter did not load (src/importers/requestly.js), so all that can be done is say what the file is.
            this.showError('This looks like a Requestly export, but the converter is not available here — nothing was imported.');
            return;
        }

        await this.importRules(incoming, { ta });
    }

    /**
     * B2-F6: the "Convert N Requestly rules" action. Runs the converter over
     * what is in the box now, then imports the result through the same
     * append-and-dedupe path as any other import; the conversion report
     * (converted / skipped with reasons / warnings) lands in the persistent
     * import-report area.
     */
    async convertRequestly() {
        const ta = document.getElementById('importJson');
        const helpers = window.SpliceTapPopupHelpers;
        const importer = helpers.requestlyImporter();
        const read = this.readImportJson();
        if (!importer || read.parsed === undefined || !helpers.detectRequestly(importer, read.parsed)) {
            // The text changed under the button, or the converter is gone.
            this.refreshRequestlyOffer({ announce: false });
            this.showError('That is no longer a Requestly export');
            return;
        }

        let result;
        try {
            result = helpers.normalizeConversion(importer.convert(read.parsed));
        } catch (error) {
            // Handled: the user is told below, so this is a warning, not a crash.
            console.warn('Requestly conversion failed:', error);
            this.showError(`Could not convert the Requestly rules: ${error && error.message ? error.message : 'unexpected error'}`);
            return;
        }

        const found = helpers.countRequestlyRules(read.parsed);
        const conversion = {
            total: Math.max(found, result.rules.length + result.skipped.length),
            converted: result.rules.length,
            skipped: result.skipped.map((item) => ({ name: item.name, errors: [item.reason], notConverted: true })),
            warnings: result.warnings,
            names: result.rules.map((rule) => rule.name)
        };
        await this.importRules(result.rules, { ta, conversion });
    }

    /**
     * The shared back half of every import: fresh ids on merge, exact
     * duplicates skipped, the background's own validation, and the report.
     * `conversion` is set when the rules came out of the Requestly converter.
     */
    async importRules(incoming, { ta, conversion = null } = {}) {
        const merge = document.getElementById('importMerge');
        const keepExisting = merge ? merge.checked : true;

        // Re-fetch before merging: `this.rules` is a snapshot that may predate
        // rules added from the overlay or another surface while this popup was
        // open, and "keep existing" promises not to lose those. Replace mode
        // needs the live count too, for its confirmation.
        let existing = [];
        try {
            const fresh = await this.sendMessage({ type: 'getRules' });
            existing = (fresh && fresh.success && Array.isArray(fresh.rules)) ? fresh.rules : (this.rules || []);
        } catch (error) {
            existing = this.rules || [];
        }

        // B2-F6: a conversion that produced nothing replaces nothing, so it
        // has no loss to confirm.
        const nothingToWrite = !!conversion && incoming.length === 0;
        if (!keepExisting && existing.length > 0 && !nothingToWrite && this.replaceArmed !== existing.length) {
            this.armReplace(existing.length);
            return;
        }

        // What the converter itself left out comes first in the report.
        const skipped = conversion ? conversion.skipped.slice() : [];
        const known = new Map(); // fingerprint -> name of the rule that holds it
        if (keepExisting) {
            for (const rule of existing) {
                if (rule && typeof rule === 'object') known.set(this.ruleSignature(rule), rule.name);
            }
        }

        // Fresh ids on merge so imported rules can never collide with, and
        // therefore overwrite, a rule already stored under the same id.
        const prepared = [];
        for (const rule of incoming) {
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
                skipped.push({ name: '', errors: ['Not a rule object'] });
                continue;
            }
            const signature = this.ruleSignature(rule);
            if (known.has(signature)) {
                skipped.push({ name: rule.name, errors: [`Exact duplicate of "${known.get(signature)}"`], duplicate: true });
                continue;
            }
            known.set(signature, rule.name);

            const next = {
                ...this.stripRuntimeFields(rule),
                id: keepExisting || !rule.id ? this.generateId() : rule.id
            };
            // Same collision as duplicating a rule (PROD-1): exports carry
            // dnrRuleId, and setRules only allocates one when it is missing.
            // Re-importing alongside the originals would hand Chrome two DNR
            // rules with the same id, which rejects the entire batch and takes
            // every headers/queryparams rule down with it. The id is an
            // internal allocation, never user data, so always re-issue it.
            // (stripRuntimeFields drops it, and the counters of whoever
            // exported the file.)
            prepared.push(next);
        }

        if (!prepared.length) {
            // Everything was a duplicate or malformed: nothing to write.
            this.finishImport({ added: 0, skipped, replaced: 0, ta, dnrWarning: undefined, conversion });
            return;
        }

        try {
            const response = await this.sendMessage({
                type: 'setRules',
                rules: keepExisting ? [...existing, ...prepared] : prepared
            });
            if (!response || !response.success) {
                this.showError(`Import failed${response && response.error ? `: ${response.error}` : ''}`);
                return;
            }
            this.rules = response.rules || [];

            // PER-27: the background names each rule it refused and why.
            const rejected = this.normalizeRejected(response.rejected);
            const landed = new Set(this.rules.map((r) => r.id));
            const added = Array.isArray(response.rules)
                ? prepared.filter((r) => landed.has(r.id)).length
                : prepared.length - rejected.length;
            this.finishImport({
                added,
                skipped: skipped.concat(rejected),
                replaced: keepExisting ? 0 : existing.length,
                ta,
                dnrWarning: response.dnrWarning,
                conversion
            });
        } catch (error) {
            console.error('Import failed:', error);
            this.showError('Import failed');
        }
    }

    /** Summarise an import: toast it, record the details, refresh the views. */
    finishImport({ added, skipped, replaced, ta, dnrWarning, conversion = null }) {
        const duplicates = skipped.filter((item) => item.duplicate).length;
        const notConverted = skipped.filter((item) => item.notConverted).length;
        const invalid = skipped.length - duplicates - notConverted;
        const summary = window.SpliceTapPopupHelpers.importSummary({
            added, replaced, duplicates, notConverted, invalid,
            ...(conversion ? { total: conversion.total, converted: conversion.converted } : {})
        });

        // B2-F6: a conversion always leaves a report (what became what, and any
        // warnings), even when nothing was skipped; a plain import only when it skipped something.
        this.importReport = (skipped.length || conversion)
            ? {
                summary,
                skipped,
                ...(conversion ? { conversion: true, warnings: conversion.warnings, converted: conversion.names } : {})
            }
            : null;
        this.renderImportReport();

        // CQ-3: an imported headers/queryparams rule can be stored yet
        // rejected by declarativeNetRequest, which previously left the user
        // with an unqualified success message for a rule that never applies.
        if (dnrWarning) {
            this.showError(`${summary} — but the network-layer rules could not be applied: ${dnrWarning}`);
        } else if (skipped.length) {
            // Error styling whenever anything was left out (PER-62).
            this.showError(summary);
        } else {
            this.showNotification(summary);
        }

        if (ta) ta.value = '';
        this.refreshRequestlyOffer({ announce: false }); // the box is empty now: no offer
        this.togglePanel('importPanel', 'importToggleBtn', false);
        this.updateImportMode();
        this.applySearchFilter();
        this.updateStatus();
        this.updateTabCount();
        this.renderDataSection();
    }

    /**
     * Wipe every SpliceTap key. Rules go through the background so DNR is
     * re-synced and tabs are told to stop intercepting; the remaining keys are
     * removed directly since nothing else observes them.
     */
    async confirmReset() {
        try {
            // The background owns the reset: it is the only place holding the
            // in-memory state (an armed Capture, the log, captured bodies), so
            // removing storage keys from here left those alive — see the
            // resetAll handler for what that used to miss.
            const response = await this.sendMessage({ type: 'resetAll' });
            if (!response || !response.success) {
                throw new Error((response && response.error) || 'reset failed');
            }
            try {
                window.localStorage.removeItem('tm-theme'); // cached theme for first paint
            } catch (e) {
                // localStorage unavailable — nothing cached
            }

            // PER-83: the confirmation used to show for 0.6 s and then reload
            // the whole popup, dropping focus to <body> and the message with
            // it. Re-render from the (now empty) state instead, say it once
            // through the live region, and park focus on the tab strip.
            this.checks.clear();
            this.importReport = null;
            this.renderImportReport();
            this.captures = [];
            const search = document.getElementById('searchInput');
            if (search) search.value = '';
            this.searchTerm = '';
            if (this.searchClearBtn) this.searchClearBtn.hidden = true;

            await this.loadData();
            this.applyTheme();
            this.applySearchFilter();
            this.updateStatus();
            this.updateStats();
            this.updateTabCount();
            this.renderSettings();
            this.updateImportMode();
            this.renderDataSection();
            this.renderCaptureSection();

            this.togglePanel('resetPanel', 'resetAllBtn', false);
            this.showNotification('All SpliceTap data deleted');
            const selected = document.querySelector('.tab[aria-selected="true"]');
            if (selected) selected.focus();
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
            this.refreshTabStatus();

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
        // PER-71: while an Undo toast is showing, Ctrl+Z (or Alt+Z, which also
        // works from a text field) undoes it, wherever focus is. In a text
        // field Ctrl+Z stays the field's own undo.
        const typing = e.target && e.target.closest
            && e.target.closest('input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]');
        if (((e.ctrlKey || e.metaKey) && !e.altKey && !typing && String(e.key).toLowerCase() === 'z')
            || (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyZ')) {
            if (this.triggerToastAction()) e.preventDefault();
            return;
        }

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
            // PER-81: Escape dismisses the newest toast first — a toast could
            // only be dismissed by clicking it, which a keyboard user could not.
            if (this.dismissTopToast()) {
                e.preventDefault();
                return;
            }

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
            // PER-55: "valid" is not "working", so it is not the green tick.
            valid: `<svg viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2.2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>`,
            failed: `<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>`,
            warning: `<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.2" aria-hidden="true" focusable="false"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
            pending: `<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
            never: `<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2.2" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`
        };
        return icons[status] || icons.pending;
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
     * immediate with an undo toast instead.
     *
     * PER-29: Undo puts the rule back where it was. It used to re-save it
     * through saveRule, which appends — so a rule deleted from the top came
     * back at the bottom, silently changing which rule wins a request. It now
     * re-reads the stored order and splices the rule in after the one that
     * preceded it, through the bulk path.
     *
     * PER-71: the toast takes focus (Undo is otherwise a screen of Tab presses
     * away, after the footer), stays until acted on or dismissed instead of
     * vanishing after 8 s, and Ctrl+Z / Alt+Z trigger it.
     */
    showUndoToast(message, rule, where = {}) {
        return this.createToast(message, 'success', {
            actionLabel: 'Undo',
            actionHint: 'Ctrl+Z',
            focusAction: true,
            announce: `${message}. Press Ctrl+Z to undo.`,
            restoreFocus: () => this.restoreListFocus(where.visibleIndex),
            onAction: async () => {
                try {
                    const fresh = await this.sendMessage({ type: 'getRules' });
                    const current = (fresh && fresh.success && Array.isArray(fresh.rules)) ? fresh.rules : (this.rules || []);
                    if (current.some((r) => r && r.id === rule.id)) {
                        this.showNotification('Rule already restored');
                        this.restoreListFocus(rule.id);
                        return;
                    }

                    let at = 0;
                    if (where.afterId) {
                        const after = current.findIndex((r) => r && r.id === where.afterId);
                        at = after >= 0 ? after + 1 : Math.min(Math.max(where.index, 0), current.length);
                    }
                    const next = current.slice();
                    next.splice(at, 0, rule);

                    const response = await this.sendMessage({ type: 'setRules', rules: next });
                    const rejected = this.normalizeRejected(response && response.rejected);
                    const restored = response && response.success
                        && (!Array.isArray(response.rules) || response.rules.some((r) => r.id === rule.id));
                    if (restored) {
                        await this.loadData();
                        this.applySearchFilter();
                        this.updateStatus();
                        this.updateTabCount();
                        this.restoreListFocus(rule.id);
                        this.showNotification('Rule restored');
                    } else {
                        this.showError(rejected.length
                            ? `Could not undo delete — ${this.describeRejected(rejected)}`
                            : 'Could not undo delete');
                        this.restoreListFocus(where.visibleIndex);
                    }
                } catch (error) {
                    console.error('Undo failed:', error);
                    this.showError('Could not undo delete');
                    this.restoreListFocus(where.visibleIndex);
                }
            }
        });
    }

    /**
     * PER-81 / A-6: the single place a status message is announced. Every
     * toast used to announce twice — once through its own role="alert"/"status"
     * and once through this region — and its accessible name was its tooltip,
     * "Click to dismiss". Errors are assertive; everything else is polite.
     */
    announce(message, type = 'info') {
        const region = document.getElementById('liveRegion');
        if (!region) return;
        const assertive = type === 'error';
        region.setAttribute('role', assertive ? 'alert' : 'status');
        region.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
        clearTimeout(this._announceTimer);
        if (region.textContent === message) {
            // An identical message is not a change, so it would not be read
            // again: clear it first.
            region.textContent = '';
            this._announceTimer = setTimeout(() => { region.textContent = message; }, 60);
        } else {
            region.textContent = message;
        }
    }

    /** The toasts currently on screen, oldest first. */
    liveToasts() {
        const container = document.getElementById('toastContainer');
        return container ? Array.from(container.querySelectorAll('.toast:not(.closing)')) : [];
    }

    /** PER-81: Escape — dismiss the newest toast. Returns whether one existed. */
    dismissTopToast() {
        const toasts = this.liveToasts();
        const top = toasts[toasts.length - 1];
        if (!top || typeof top._dismiss !== 'function') return false;
        top._dismiss({ restore: true });
        return true;
    }

    /** PER-71: run the newest toast's action (Undo). Returns whether there was one. */
    triggerToastAction() {
        const toasts = this.liveToasts().filter((t) => typeof t._action === 'function');
        const top = toasts[toasts.length - 1];
        if (!top) return false;
        top._action();
        return true;
    }

    /**
     * Utility: Create toast notification
     *
     * U-18: toasts used to be individually `position: fixed; top: 10px;
     * right: 10px`, landing directly on the header/Settings button, with
     * consecutive toasts stacking unreadably at the identical coordinates.
     * They now flow inside the single `#toastContainer` (popup.html),
     * anchored above the footer.
     *
     * A-6 / PER-81: announced once, through `#liveRegion`; the toast itself
     * has no live role, and no tooltip to become its accessible name.
     *
     * PER-68: a toast sits over whatever is beneath it — after Import, the
     * Import button — and used to swallow the click meant for it. Clicks now
     * pass through everything but the toast's own buttons (see popup.css), so
     * there is no control it can hide from a pointer.
     *
     * PER-71: a toast with an action is not on a timer. It stays until it is
     * used, dismissed (Escape, or its × button) or superseded by a newer one.
     */
    createToast(message, type = 'info', options = {}) {
        const container = document.getElementById('toastContainer');
        if (!container) return null;

        const hasAction = !!(options.actionLabel && typeof options.onAction === 'function');

        // Only the newest action can be undone with the keyboard shortcut, so
        // an older, still-visible one would offer something it no longer can.
        if (hasAction) {
            this.liveToasts().filter((t) => t._action).forEach((t) => t._dismiss({ restore: false }));
        }

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}${hasAction ? ' has-action' : ''}`;

        const text = document.createElement('span');
        text.className = 'toast-message';
        text.textContent = message;
        toast.appendChild(text);

        let dismissTimer;
        let dismissed = false;
        const dismissToast = ({ restore = false } = {}) => {
            if (dismissed) return;
            dismissed = true;
            clearTimeout(dismissTimer);
            const hadFocus = toast.contains(document.activeElement);
            toast.classList.add('closing');
            setTimeout(() => toast.remove(), 300);
            // Focus on a control that is going away would fall to <body>.
            if (hadFocus && restore && typeof options.restoreFocus === 'function') options.restoreFocus();
        };
        const scheduleDismiss = () => {
            clearTimeout(dismissTimer);
            if (hasAction) return;
            // Long error text (a list of refused rules) needs longer to read.
            const base = options.duration || (type === 'error' ? 6000 : 3000);
            const duration = type === 'error' ? Math.min(Math.max(base, message.length * 60), 20000) : base;
            dismissTimer = setTimeout(() => dismissToast(), duration);
        };
        toast._dismiss = dismissToast;

        let actionBtn = null;
        if (hasAction) {
            actionBtn = document.createElement('button');
            actionBtn.type = 'button';
            actionBtn.className = 'toast-action';
            actionBtn.textContent = options.actionLabel;
            if (options.actionHint) {
                actionBtn.title = `${options.actionLabel} (${options.actionHint})`;
                actionBtn.setAttribute('aria-keyshortcuts', options.actionHint.replace('Ctrl', 'Control'));
            }
            const run = () => {
                if (dismissed) return;
                // The action puts focus where it belongs (e.g. the restored row).
                dismissToast({ restore: false });
                options.onAction();
            };
            actionBtn.addEventListener('click', run);
            toast._action = run;
            toast.appendChild(actionBtn);

            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'toast-dismiss';
            closeBtn.setAttribute('aria-label', 'Dismiss');
            closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
            closeBtn.addEventListener('click', () => dismissToast({ restore: true }));
            toast.appendChild(closeBtn);
        }

        container.appendChild(toast);
        scheduleDismiss();

        this.announce(options.announce || message, type);

        // PER-71: Undo is after the footer in tab order; bring focus to it.
        if (hasAction && options.focusAction && actionBtn) actionBtn.focus({ preventScroll: true });

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
    // CQ-6: delegates to src/common.js so every surface escapes identically.
    escapeHtml(text) {
        return window.SpliceTapCommon.escapeHtml(text);
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
    // CQ-6: shared implementation — see src/common.js.
    generateId() {
        return window.SpliceTapCommon.generateId();
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