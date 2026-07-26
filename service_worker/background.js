/**
 * SpliceTap Background Service Worker
 * Manages extension state, rules storage, and communication with content scripts.
 * 
 * NOTE: Interception logic has moved to content/content.js (Monkey Patching) 
 * to support dynamic responses and chaos mode in Manifest V3 without blocking permissions.
 */

import { SpliceTapStorage } from '../src/storage.js';
import { SpliceTapUtils } from '../src/utils.js';
// dnr.js is UMD-only (see its file header for why) — side-effect import it,
// then read the API off globalThis, the same pattern injected.js uses for
// the G1 shared modules via `window.SpliceTapMatcher` etc.
import './dnr.js';

const { syncDnrRules } = globalThis.SpliceTapDnr;

class SpliceTapBackground {
    constructor() {
        this.storage = new SpliceTapStorage();
        this.isActive = true;
        this.rules = [];
        this.stats = {
            intercepted: 0,
            lastReset: new Date().toISOString()
        };
        this.settings = {};
        this.broadcastRetryCount = new Map(); // Track retry attempts per tab
        this.MAX_BROADCAST_RETRIES = 3;

        // Ring buffer of applied-rule log entries (TODO.md §1.5 / §G4.4).
        // Backed by chrome.storage.session so it survives service-worker
        // suspensions within a browser session (the SW is ephemeral in MV3).
        this.interceptionLog = [];
        this.MAX_INTERCEPTION_LOG = 200;

        // Throttle for persisting stats + the interception log, to avoid a
        // storage write on every single intercepted request.
        this._lastPersist = 0;
        this.PERSIST_THROTTLE_MS = 1500;
        this._trailingFlushTimer = null; // Q-16
        this._rulesDirty = false; // Q-26/G-6: hitCount changed in-memory, not yet flushed

        // Q-15: serializes chrome.storage.local read-modify-write DNR-id
        // allocations through a single promise chain. allocateDnrId() itself
        // is a get-then-set with no atomicity; without this, two rules saved
        // in quick succession (e.g. a bulk import) can read the same counter
        // value and be handed the same dnrRuleId, which corrupts the whole
        // DNR ruleset since two rules would collide on one id. Every call is
        // funneled through this single instance, and JS is single-threaded,
        // so chaining through one promise variable serializes the critical
        // section completely.
        this._dnrIdChain = Promise.resolve();

        // Register event listeners synchronously, in the first turn of the
        // service-worker script. MV3 workers are ephemeral; a listener added
        // only after an `await` can miss the very event that woke the worker.
        // Handlers await `this.ready` before reading state.
        this.setupMessageHandlers();
        this.setupContextMenus();
        this.setupExtensionLifecycle();
        this.setupCommands();
        this.setupSuspendFlush();

        this.ready = this.loadStoredData()
            .then(() => console.log('SpliceTap background service worker initialized (Config Mode)'))
            .catch((error) => console.error('Failed to initialize background service worker:', error));
    }

    /**
     * Serialized wrapper around storage.allocateDnrId() (Q-15).
     */
    allocateDnrIdSerialized() {
        // .catch(() => {}) so a prior failed allocation doesn't permanently
        // wedge the chain into a rejected state for every call after it.
        this._dnrIdChain = this._dnrIdChain
            .catch(() => {})
            .then(() => this.storage.allocateDnrId());
        return this._dnrIdChain;
    }

    async loadStoredData() {
        try {
            const data = await this.storage.loadAll();
            this.isActive = data.active;
            this.rules = data.rules || [];
            this.stats = data.stats || {
                intercepted: 0,
                lastReset: new Date().toISOString()
            };
            this.settings = data.settings || {};

            // Restore the volatile interception log from session storage so the
            // DevTools panel keeps its history across SW suspensions.
            try {
                const sess = await chrome.storage.session.get('spliceTapInterceptionLog');
                if (Array.isArray(sess.spliceTapInterceptionLog)) {
                    this.interceptionLog = sess.spliceTapInterceptionLog;
                }
            } catch (e) {
                // session storage unavailable — non-fatal
            }

            await this.broadcastState();
            await syncDnrRules(this.rules, this.isActive);
        } catch (error) {
            console.error('Failed to load stored data:', error);
            // Initialize with defaults on error
            this.isActive = true;
            this.rules = [];
            this.stats = { intercepted: 0, lastReset: new Date().toISOString() };
            this.settings = {};
        }
    }

    setupMessageHandlers() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            this.handleMessage(request, sender)
                .then(sendResponse)
                .catch(error => {
                    console.error('Message handler error:', error);
                    sendResponse({ success: false, error: error.message });
                });
            return true; // Keep channel open for async response
        });
    }

    async handleMessage(request, sender) {
        try {
            // Ensure stored state is loaded before serving any message. On a
            // cold SW start the triggering message can arrive before
            // loadStoredData() resolves; this makes handlers wait for it.
            await this.ready;

            switch (request.type) {
                case 'getRules':
                    return {
                        success: true,
                        rules: this.rules,
                        active: this.isActive,
                        stats: this.stats,
                        settings: this.settings
                    };

                case 'toggleExtension':
                    this.isActive = request.active;
                    await this.storage.saveActiveState(this.isActive);
                    await this.broadcastState();
                    await syncDnrRules(this.rules, this.isActive);
                    return { success: true, active: this.isActive };

                case 'saveRule': {
                    if (!request.rule) {
                        throw new Error('Rule data is required');
                    }

                    // S-2: server-side validation before persisting. The
                    // options page and overlay both validate client-side, but
                    // a client-side-only check can be bypassed (a hand-edited
                    // storage entry, a future caller, a compromised page
                    // context) — this is the one place ALL rule writes funnel
                    // through, so it's the actual trust boundary.
                    const validation = await this.validateRule(request.rule);
                    if (!validation.passed) {
                        return {
                            success: false,
                            error: validation.results.map((r) => r.message).join('; ')
                        };
                    }

                    const ruleToSave = { ...request.rule };
                    if ((ruleToSave.type === 'headers' || ruleToSave.type === 'queryparams') && !ruleToSave.dnrRuleId) {
                        ruleToSave.dnrRuleId = await this.allocateDnrIdSerialized();
                    }
                    const savedRule = await this.storage.saveRule(ruleToSave);
                    this.rules = await this.storage.getRules();
                    await this.broadcastState();
                    const dnrResult = await syncDnrRules(this.rules, this.isActive);
                    return { success: true, rule: savedRule, dnrWarning: dnrResult.success ? undefined : dnrResult.error };
                }

                case 'setRules': {
                    // Bulk persist path used by the options editor and import.
                    // S-2: validate every incoming rule; invalid ones are
                    // skipped (not silently accepted, not a hard failure for
                    // the whole batch — one bad rule in an imported file
                    // shouldn't block the N good ones). Allocates a dnrRuleId
                    // for any headers/queryparams rule that lacks one, then
                    // persists, refreshes in-memory rules, broadcasts, and
                    // syncs DNR.
                    if (!Array.isArray(request.rules)) {
                        throw new Error('rules array is required');
                    }
                    const prepared = [];
                    const rejected = [];
                    for (const incoming of request.rules) {
                        const validation = await this.validateRule(incoming);
                        if (!validation.passed) {
                            rejected.push({
                                name: incoming && incoming.name,
                                errors: validation.results.map((r) => r.message)
                            });
                            continue;
                        }
                        const rule = { ...incoming };
                        if ((rule.type === 'headers' || rule.type === 'queryparams') && !rule.dnrRuleId) {
                            rule.dnrRuleId = await this.allocateDnrIdSerialized();
                        }
                        prepared.push(rule);
                    }
                    await this.storage.saveRules(prepared);
                    this.rules = await this.storage.getRules();
                    await this.broadcastState();
                    const dnrResult = await syncDnrRules(this.rules, this.isActive);
                    return {
                        success: true,
                        rules: this.rules,
                        rejected: rejected.length ? rejected : undefined,
                        dnrWarning: dnrResult.success ? undefined : dnrResult.error
                    };
                }

                case 'toggleRule':
                    if (!request.ruleId) {
                        throw new Error('Rule ID is required');
                    }
                    await this.storage.toggleRule(request.ruleId, request.enabled);
                    this.rules = await this.storage.getRules();
                    await this.broadcastState();
                    await syncDnrRules(this.rules, this.isActive);
                    return { success: true };

                case 'deleteRule':
                    if (!request.ruleId) {
                        throw new Error('Rule ID is required');
                    }
                    await this.storage.deleteRule(request.ruleId);
                    this.rules = await this.storage.getRules();
                    await this.broadcastState();
                    await syncDnrRules(this.rules, this.isActive);
                    return { success: true };

                case 'resetStats':
                    this.stats = {
                        intercepted: 0,
                        lastReset: new Date().toISOString()
                    };
                    await this.storage.updateStats(this.stats);
                    return { success: true, stats: this.stats };

                case 'clearRules':
                    await this.storage.saveRules([]);
                    this.rules = [];
                    await this.broadcastState();
                    await syncDnrRules(this.rules, this.isActive);
                    return { success: true };

                case 'testRule':
                    if (!request.rule) {
                        throw new Error('Rule data is required');
                    }
                    return await this.validateRule(request.rule);

                case 'settingsUpdated':
                    if (request.settings) {
                        this.settings = request.settings;
                        await this.storage.saveSettings(this.settings);
                        await this.broadcastState();
                    }
                    return { success: true };

                case 'logInterception':
                    if (request.entry) {
                        this.interceptionLog.push(request.entry);
                        if (this.interceptionLog.length > this.MAX_INTERCEPTION_LOG) {
                            this.interceptionLog.splice(0, this.interceptionLog.length - this.MAX_INTERCEPTION_LOG);
                        }
                        this._applyStatsIncrement(1);

                        // Q-26/G-6: hitCount was defined in the schema and
                        // rendered in the UI but nothing ever incremented it.
                        // Bumped in-memory immediately (so a getRules() call
                        // right after reflects it); the write to storage
                        // rides the same throttle as stats/log persistence
                        // rather than a save per intercepted request.
                        if (request.entry.ruleId) {
                            const rule = this.rules.find((r) => r && r.id === request.entry.ruleId);
                            if (rule) {
                                rule.hitCount = (rule.hitCount || 0) + 1;
                                this._rulesDirty = true;
                            }
                        }

                        await this._persistVolatile();
                    }
                    return { success: true };

                case 'getInterceptionLog':
                    return { success: true, entries: this.interceptionLog };

                case 'clearInterceptionLog':
                    this.interceptionLog = [];
                    try {
                        await chrome.storage.session.remove('spliceTapInterceptionLog');
                    } catch (e) {
                        // non-fatal
                    }
                    return { success: true };

                default:
                    throw new Error(`Unknown message type: ${request.type}`);
            }
        } catch (error) {
            console.error('Error handling message:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Apply a stats increment, honoring the daily-reset rule: if a day or
     * more has passed since `this.stats.lastReset`, stats restart at
     * `incrementBy` (default 1) instead of accumulating. Called by the
     * 'logInterception' handler (TODO.md §G4.4).
     */
    _applyStatsIncrement(incrementBy) {
        const amount = incrementBy || 1;
        const lastReset = new Date(this.stats.lastReset);
        const now = new Date();
        // Q-31: an unparseable/missing lastReset produces an Invalid Date;
        // (now - lastReset) is then NaN, and `NaN >= 1` is false, so the
        // reset silently never fires again for the lifetime of that stats
        // object. Treat "can't tell how long it's been" as "reset is due".
        const lastResetValid = !isNaN(lastReset.getTime());
        const daysSinceReset = lastResetValid
            ? Math.floor((now - lastReset) / (1000 * 60 * 60 * 24))
            : Infinity;

        if (daysSinceReset >= 1) {
            // Reset stats for new day
            this.stats = {
                intercepted: amount,
                lastReset: now.toISOString()
            };
        } else {
            // Increment existing stats
            this.stats.intercepted = (this.stats.intercepted || 0) + amount;
        }
    }

    /**
     * Persist the interception log (to session storage), stats, and any
     * dirty hitCount changes (to local storage), throttled so a busy page
     * making many mocked requests doesn't trigger a storage write per
     * request. In-memory state is always current; this only bounds how
     * often it is flushed to disk/session.
     *
     * Q-16: also schedules a trailing-edge flush so the last write inside a
     * throttle window isn't lost forever if no further event arrives to
     * trigger the next flush (previously: a burst of requests early in a
     * window, then silence, meant that window's tail was never persisted
     * until something else happened to call this again).
     */
    async _persistVolatile(force = false) {
        const now = Date.now();
        if (!force && (now - this._lastPersist) < this.PERSIST_THROTTLE_MS) {
            if (!this._trailingFlushTimer) {
                const remaining = this.PERSIST_THROTTLE_MS - (now - this._lastPersist);
                this._trailingFlushTimer = setTimeout(() => {
                    this._trailingFlushTimer = null;
                    this._persistVolatile(true);
                }, remaining);
            }
            return;
        }
        if (this._trailingFlushTimer) {
            clearTimeout(this._trailingFlushTimer);
            this._trailingFlushTimer = null;
        }
        this._lastPersist = now;

        try {
            await chrome.storage.session.set({ spliceTapInterceptionLog: this.interceptionLog });
        } catch (e) {
            // session storage unavailable — non-fatal
        }

        // P-14: write the already-authoritative in-memory stats object
        // directly rather than going through updateStats(), which does its
        // own get-then-merge — redundant here since `this.stats` already IS
        // the full, current stats object.
        await this.storage.setStatsDirect(this.stats);

        if (this._rulesDirty) {
            this._rulesDirty = false;
            await this.storage.saveRules(this.rules);
        }
    }

    /**
     * Validate a rule structure. Branches per rule type (Q-21/G-3) — only
     * `type: 'mock'` rules have a `response` object in the v2 schema; the
     * old unconditional `if (!rule.response)` check meant the Test button
     * (and, since this is also the S-2 save/import gate, saving itself)
     * hard-failed every block/delay/redirect/headers/queryparams rule even
     * when perfectly well-formed.
     */
    async validateRule(rule) {
        const errors = [];

        if (!rule || typeof rule !== 'object') {
            return { success: true, passed: false, results: [{ status: 'failed', message: 'Rule data is required' }] };
        }

        // Fields common to every rule type.
        if (!rule.name || rule.name.trim().length === 0) {
            errors.push('Rule name is required');
        }

        if (!rule.match || !rule.match.url) {
            errors.push('URL pattern is required');
        } else {
            const urlValidation = SpliceTapUtils.validateUrlPattern(rule.match.url);
            if (!urlValidation.isValid) {
                errors.push(`Invalid URL pattern: ${urlValidation.error}`);
            }
        }

        if (!rule.match || !rule.match.method) {
            errors.push('HTTP method is required');
        }

        const type = rule.type || 'mock';

        if (type === 'mock') {
            if (!rule.response) {
                errors.push('Response configuration is required');
            } else {
                const statusValidation = SpliceTapUtils.validateStatusCode(rule.response.statusCode);
                if (!statusValidation.isValid) {
                    errors.push(`Invalid status code: ${statusValidation.error}`);
                }

                if (rule.response.headers && typeof rule.response.headers !== 'object') {
                    errors.push('Headers must be an object');
                }

                if (rule.response.delay !== undefined) {
                    const delay = parseInt(rule.response.delay, 10);
                    if (isNaN(delay) || delay < 0 || delay > 30000) {
                        errors.push('Delay must be between 0 and 30000 ms');
                    }
                }
            }
        } else if (type === 'delay') {
            const ms = parseInt(rule.delayMs, 10);
            if (isNaN(ms) || ms < 1 || ms > 30000) {
                errors.push('Delay must be between 1 and 30000 ms');
            }
        } else if (type === 'redirect') {
            if (!rule.redirect || !rule.redirect.destination) {
                errors.push('Redirect destination is required');
            }
        } else if (type === 'headers') {
            if (!rule.headersMod || (!(rule.headersMod.request || []).length && !(rule.headersMod.response || []).length)) {
                errors.push('At least one request or response header operation is required');
            } else {
                const dnr = globalThis.SpliceTapDnr;
                if (dnr && typeof dnr.validateHeadersMod === 'function') {
                    const headerValidation = dnr.validateHeadersMod(rule.headersMod);
                    if (!headerValidation.valid) {
                        errors.push(...headerValidation.errors);
                    }
                }
            }
        } else if (type === 'queryparams') {
            const qp = rule.queryParams || {};
            if (!(qp.add || []).length && !(qp.remove || []).length) {
                errors.push('At least one query parameter to add or remove is required');
            }
        } else if (type !== 'block') {
            errors.push(`Unknown rule type: ${type}`);
        }

        // §1.7: headers/queryparams rules are DNR-backed and cannot express
        // header or GraphQL match conditions.
        if ((type === 'headers' || type === 'queryparams') && rule.match && (rule.match.headers || rule.match.graphql)) {
            errors.push('Header/GraphQL match conditions are not supported for this rule type');
        }

        if (errors.length > 0) {
            return {
                success: true,
                passed: false,
                results: errors.map(error => ({
                    status: 'failed',
                    message: error
                }))
            };
        }

        return {
            success: true,
            passed: true,
            results: [{
                status: 'passed',
                message: 'Rule validation passed'
            }]
        };
    }

    /**
     * Broadcast current rules/settings to all content scripts with retry logic
     */
    async broadcastState() {
        const state = {
            type: 'syncState',
            rules: this.rules,
            active: this.isActive,
            settings: this.settings
        };

        try {
            const tabs = await chrome.tabs.query({});
            const broadcastPromises = tabs.map(tab => this.broadcastToTab(tab.id, state));
            
            // Wait for all broadcasts to complete (but don't fail if some tabs fail)
            await Promise.allSettled(broadcastPromises);
        } catch (error) {
            console.error('Failed to query tabs for broadcast:', error);
        }
    }

    /**
     * Broadcast to a specific tab with retry logic
     */
    async broadcastToTab(tabId, state) {
        try {
            await chrome.tabs.sendMessage(tabId, state);

            // Reset retry count on success
            this.broadcastRetryCount.delete(tabId);
        } catch (error) {
            // Q-29: "Could not establish connection. Receiving end does not
            // exist." means this tab structurally has no (and will never
            // get, without a navigation) our content script — a chrome://
            // page, another extension's page, the Web Store, a PDF viewer,
            // etc. Retrying those wastes timers and CPU for a request that
            // can never succeed; give up immediately instead.
            if (error && /receiving end does not exist/i.test(error.message || '')) {
                this.broadcastRetryCount.delete(tabId);
                return;
            }

            const retries = this.broadcastRetryCount.get(tabId) || 0;

            if (retries < this.MAX_BROADCAST_RETRIES) {
                // Retry after delay
                this.broadcastRetryCount.set(tabId, retries + 1);
                console.warn(`Failed to sync state to tab ${tabId}, attempt ${retries + 1}/${this.MAX_BROADCAST_RETRIES}:`, error.message);
                
                setTimeout(() => {
                    this.broadcastToTab(tabId, state);
                }, 1000 * (retries + 1)); // Exponential backoff
            } else {
                // Max retries reached, give up and log
                console.error(`Failed to sync state to tab ${tabId} after ${this.MAX_BROADCAST_RETRIES} attempts, giving up`);
                this.broadcastRetryCount.delete(tabId);
            }
        }
    }

    setupContextMenus() {
        chrome.runtime.onInstalled.addListener(() => {
            try {
                chrome.contextMenus.create({
                    id: "splicetap-add-rule",
                    title: "Mock this request",
                    contexts: ["action", "page"]
                });
            } catch (error) {
                console.error('Failed to create context menu:', error);
            }
        });

        chrome.contextMenus.onClicked.addListener(async (info, tab) => {
            if (info.menuItemId !== "splicetap-add-rule") return;

            // Prefer the in-page overlay so the user never leaves the page.
            if (tab && tab.id && tab.url && /^https?:/i.test(tab.url)) {
                let prefillUrl;
                try {
                    prefillUrl = `*${new URL(tab.url).host}*`;
                } catch (e) {
                    prefillUrl = undefined;
                }

                try {
                    const response = await chrome.tabs.sendMessage(tab.id, {
                        type: 'openRuleOverlay',
                        mode: 'new',
                        prefillUrl
                    });
                    if (response && response.success) return;
                } catch (error) {
                    // Content script unavailable here — fall through to the tab.
                }

                try {
                    await chrome.storage.local.set({
                        spliceTapPrefill: { url: prefillUrl, ts: Date.now() }
                    });
                } catch (error) {
                    console.error('Failed to store rule prefill data:', error);
                }
            }

            chrome.runtime.openOptionsPage();
        });
    }

    setupExtensionLifecycle() {
        // Handle installation
        chrome.runtime.onInstalled.addListener((details) => {
            if (details.reason === 'install') {
                console.log('SpliceTap installed, opening options page');
                chrome.runtime.openOptionsPage();
            } else if (details.reason === 'update') {
                console.log('SpliceTap updated to version', chrome.runtime.getManifest().version);
                // Could trigger migration here if needed
            }
        });

        // Handle tab updates - broadcast state to newly loaded pages
        chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
            if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) {
                // C-7: on a cold SW start, this event can fire before
                // loadStoredData() resolves — at that point this.rules is
                // still [] and this.isActive is still its constructor
                // default, so the tab would be handed an empty ruleset and
                // mocking would look silently disabled until the next
                // unrelated broadcast. Wait for the real state first.
                await this.ready;

                const state = {
                    type: 'syncState',
                    rules: this.rules,
                    active: this.isActive,
                    settings: this.settings
                };

                // Give content script time to load
                setTimeout(() => {
                    this.broadcastToTab(tabId, state);
                }, 500);
            }
        });

        // Clean up retry counts when tabs close
        chrome.tabs.onRemoved.addListener((tabId) => {
            this.broadcastRetryCount.delete(tabId);
        });
    }

    /**
     * C-6/Q-20/G-10: the manifest declares two keyboard shortcuts
     * (toggle-extension, new-rule) but nothing ever handled
     * chrome.commands.onCommand — both were advertised in the UI and did
     * nothing when pressed.
     */
    setupCommands() {
        chrome.commands.onCommand.addListener(async (command) => {
            try {
                if (command === 'toggle-extension') {
                    await this.ready;
                    this.isActive = !this.isActive;
                    await this.storage.saveActiveState(this.isActive);
                    await this.broadcastState();
                    await syncDnrRules(this.rules, this.isActive);
                } else if (command === 'new-rule') {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab && tab.id && tab.url && /^https?:/i.test(tab.url)) {
                        let prefillUrl;
                        try {
                            prefillUrl = `*${new URL(tab.url).host}*`;
                        } catch (e) {
                            prefillUrl = undefined;
                        }
                        try {
                            const response = await chrome.tabs.sendMessage(tab.id, {
                                type: 'openRuleOverlay', mode: 'new', prefillUrl
                            });
                            if (response && response.success) return;
                        } catch (error) {
                            // Content script unavailable — fall through to the options tab.
                        }
                    }
                    chrome.runtime.openOptionsPage();
                }
            } catch (error) {
                console.error(`Failed to handle command "${command}":`, error);
            }
        });
    }

    /**
     * C-22/Q-16: chrome.runtime.onSuspend is not guaranteed to fire for an
     * abrupt service-worker termination, but it IS the closest available
     * hook, and attempting a flush here is strictly better than not trying —
     * it closes the window where up to PERSIST_THROTTLE_MS of buffered stats
     * and log entries would otherwise be silently dropped on suspend.
     */
    setupSuspendFlush() {
        if (chrome.runtime.onSuspend && chrome.runtime.onSuspend.addListener) {
            chrome.runtime.onSuspend.addListener(() => {
                this._persistVolatile(true);
            });
        }
    }
}

// Initialize
const backgroundService = new SpliceTapBackground();

// Export for testing if needed
export default backgroundService;