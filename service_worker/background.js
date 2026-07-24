/**
 * TurboMock Background Service Worker
 * Manages extension state, rules storage, and communication with content scripts.
 * 
 * NOTE: Interception logic has moved to content/content.js (Monkey Patching) 
 * to support dynamic responses and chaos mode in Manifest V3 without blocking permissions.
 */

import { TurboMockStorage } from '../src/storage.js';
import { TurboMockUtils } from '../src/utils.js';
// dnr.js is UMD-only (see its file header for why) — side-effect import it,
// then read the API off globalThis, the same pattern injected.js uses for
// the G1 shared modules via `window.TurboMockMatcher` etc.
import './dnr.js';

const { syncDnrRules } = globalThis.TurboMockDnr;

class TurboMockBackground {
    constructor() {
        this.storage = new TurboMockStorage();
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

        // Register event listeners synchronously, in the first turn of the
        // service-worker script. MV3 workers are ephemeral; a listener added
        // only after an `await` can miss the very event that woke the worker.
        // Handlers await `this.ready` before reading state.
        this.setupMessageHandlers();
        this.setupContextMenus();
        this.setupExtensionLifecycle();

        this.ready = this.loadStoredData()
            .then(() => console.log('TurboMock background service worker initialized (Config Mode)'))
            .catch((error) => console.error('Failed to initialize background service worker:', error));
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
                const sess = await chrome.storage.session.get('turboMockInterceptionLog');
                if (Array.isArray(sess.turboMockInterceptionLog)) {
                    this.interceptionLog = sess.turboMockInterceptionLog;
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
                    const ruleToSave = { ...request.rule };
                    if ((ruleToSave.type === 'headers' || ruleToSave.type === 'queryparams') && !ruleToSave.dnrRuleId) {
                        ruleToSave.dnrRuleId = await this.storage.allocateDnrId();
                    }
                    const savedRule = await this.storage.saveRule(ruleToSave);
                    this.rules = await this.storage.getRules();
                    await this.broadcastState();
                    await syncDnrRules(this.rules, this.isActive);
                    return { success: true, rule: savedRule };
                }

                case 'setRules': {
                    // Bulk persist path used by the options editor and import.
                    // Allocates a dnrRuleId for any headers/queryparams rule that
                    // lacks one (so DNR-backed rules actually register), then
                    // persists, refreshes in-memory rules, broadcasts, and syncs DNR.
                    if (!Array.isArray(request.rules)) {
                        throw new Error('rules array is required');
                    }
                    const prepared = [];
                    for (const incoming of request.rules) {
                        const rule = { ...incoming };
                        if ((rule.type === 'headers' || rule.type === 'queryparams') && !rule.dnrRuleId) {
                            rule.dnrRuleId = await this.storage.allocateDnrId();
                        }
                        prepared.push(rule);
                    }
                    await this.storage.saveRules(prepared);
                    this.rules = await this.storage.getRules();
                    await this.broadcastState();
                    await syncDnrRules(this.rules, this.isActive);
                    return { success: true, rules: this.rules };
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
                        await this._persistVolatile();
                    }
                    return { success: true };

                case 'getInterceptionLog':
                    return { success: true, entries: this.interceptionLog };

                case 'clearInterceptionLog':
                    this.interceptionLog = [];
                    try {
                        await chrome.storage.session.remove('turboMockInterceptionLog');
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
        const daysSinceReset = Math.floor((now - lastReset) / (1000 * 60 * 60 * 24));

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
     * Persist the interception log (to session storage) and stats (to local
     * storage), throttled so a busy page making many mocked requests doesn't
     * trigger a storage write per request. In-memory state is always current;
     * this only bounds how often it is flushed to disk/session.
     */
    async _persistVolatile(force = false) {
        const now = Date.now();
        if (!force && (now - this._lastPersist) < this.PERSIST_THROTTLE_MS) {
            return;
        }
        this._lastPersist = now;

        try {
            await chrome.storage.session.set({ turboMockInterceptionLog: this.interceptionLog });
        } catch (e) {
            // session storage unavailable — non-fatal
        }
        await this.storage.updateStats(this.stats);
    }

    /**
     * Validate a rule structure
     */
    async validateRule(rule) {
        const errors = [];

        // Validate required fields
        if (!rule.name || rule.name.trim().length === 0) {
            errors.push('Rule name is required');
        }

        if (!rule.match || !rule.match.url) {
            errors.push('URL pattern is required');
        } else {
            // Validate URL pattern
            const urlValidation = TurboMockUtils.validateUrlPattern(rule.match.url);
            if (!urlValidation.isValid) {
                errors.push(`Invalid URL pattern: ${urlValidation.error}`);
            }
        }

        if (!rule.match || !rule.match.method) {
            errors.push('HTTP method is required');
        }

        if (!rule.response) {
            errors.push('Response configuration is required');
        } else {
            // Validate status code
            const statusValidation = TurboMockUtils.validateStatusCode(rule.response.statusCode);
            if (!statusValidation.isValid) {
                errors.push(`Invalid status code: ${statusValidation.error}`);
            }

            // Validate headers JSON if present
            if (rule.response.headers) {
                if (typeof rule.response.headers !== 'object') {
                    errors.push('Headers must be an object');
                }
            }

            // Validate delay
            if (rule.response.delay !== undefined) {
                const delay = parseInt(rule.response.delay, 10);
                if (isNaN(delay) || delay < 0 || delay > 30000) {
                    errors.push('Delay must be between 0 and 30000 ms');
                }
            }
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
                    id: "turbomock-add-rule",
                    title: "Mock this request",
                    contexts: ["action", "page"]
                });
            } catch (error) {
                console.error('Failed to create context menu:', error);
            }
        });

        chrome.contextMenus.onClicked.addListener(async (info, tab) => {
            if (info.menuItemId !== "turbomock-add-rule") return;

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
                        turboMockPrefill: { url: prefillUrl, ts: Date.now() }
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
                console.log('TurboMock installed, opening options page');
                chrome.runtime.openOptionsPage();
            } else if (details.reason === 'update') {
                console.log('TurboMock updated to version', chrome.runtime.getManifest().version);
                // Could trigger migration here if needed
            }
        });

        // Handle tab updates - broadcast state to newly loaded pages
        chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
            if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://')) {
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
}

// Initialize
const backgroundService = new TurboMockBackground();

// Export for testing if needed
export default backgroundService;