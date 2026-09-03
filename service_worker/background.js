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

        // Ring buffer of applied-rule log entries.
        // Backed by chrome.storage.session so it survives service-worker
        // suspensions within a browser session (the SW is ephemeral in MV3).
        this.interceptionLog = [];
        this.MAX_INTERCEPTION_LOG = 200;

        // Captured real responses, used to build a rule from an actual payload
        // instead of hand-writing one. Session-backed and capped: these hold
        // response BODIES, the one thing the extension otherwise never keeps,
        // so they are short-lived by construction and cleared when the browser
        // closes. Capture is off unless the user explicitly arms it.
        this.captures = [];
        this.MAX_CAPTURES = 25;

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

        // PERF-5: id -> rule index, rebuilt when this.rules is replaced.
        this._ruleIndex = new Map();
        this._ruleIndexSource = null;

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
     * PERF-5: O(1) rule lookup by id, for the per-request paths.
     *
     * The index is rebuilt lazily whenever this.rules is replaced — checked by
     * identity, so a reassignment invalidates it without every mutation site
     * having to remember to clear it.
     */
    _ruleById(id) {
        if (this._ruleIndexSource !== this.rules) {
            this._ruleIndex = new Map();
            for (const r of this.rules || []) {
                if (r && r.id) this._ruleIndex.set(r.id, r);
            }
            this._ruleIndexSource = this.rules;
        }
        return this._ruleIndex.get(id) || null;
    }

    /**
     * SEC-3: is this interception-log entry plausibly one of ours?
     *
     * The entry arrives via a content-script relay living in the page's own
     * document, so it is attacker-influenced input. Every genuine entry is
     * emitted by the interceptor immediately after applying a rule, so it must
     * name a rule that currently exists — a constraint a forging page cannot
     * satisfy without already knowing a real rule id, which SEC-2's nonce now
     * prevents it from learning.
     */
    _isPlausibleLogEntry(entry) {
        if (!entry || typeof entry !== 'object') return false;
        if (typeof entry.url !== 'string' || entry.url.length > 2048) return false;
        if (typeof entry.method !== 'string' || entry.method.length > 16) return false;
        if (typeof entry.ruleId !== 'string') return false;
        if (entry.ruleName !== undefined && typeof entry.ruleName !== 'string') return false;
        if (entry.ruleType !== undefined && typeof entry.ruleType !== 'string') return false;
        if (entry.status !== undefined && entry.status !== null && typeof entry.status !== 'number') return false;
        if (entry.ts !== undefined && typeof entry.ts !== 'number') return false;

        return !!this._ruleById(entry.ruleId);
    }

    /**
     * QA-5: reload rules from storage without discarding hitCount increments
     * still waiting on the throttled flush.
     *
     * logInterception bumps hitCount in memory and defers the write by up to
     * PERSIST_THROTTLE_MS. Any rule mutation in that window used to do a plain
     * `this.rules = await getRules()`, replacing the array with the disk copy —
     * which does not have the bump yet — so the increment was lost permanently
     * once the trailing flush wrote the replaced array back.
     */
    async reloadRulesPreservingHits() {
        const pending = new Map();
        if (this._rulesDirty) {
            for (const r of this.rules || []) {
                if (r && r.id && r.hitCount) pending.set(r.id, r.hitCount);
            }
        }

        const fresh = await this.storage.getRules();

        if (pending.size) {
            for (const rule of fresh) {
                const held = pending.get(rule.id);
                // Keep whichever is higher — a concurrent write may already
                // have persisted a later count than this worker held.
                if (held && (!rule.hitCount || held > rule.hitCount)) {
                    rule.hitCount = held;
                }
            }
        }

        this.rules = fresh;
    }

    /**
     * Captures live in session storage only — they contain response bodies, so
     * they must not survive the browser session or reach chrome.storage.local.
     */
    async _persistCaptures() {
        try {
            await chrome.storage.session.set({ spliceTapCaptures: this.captures });
        } catch (error) {
            // Session storage unavailable — captures stay in memory for this
            // service-worker lifetime, which is still useful.
        }
    }

    /**
     * Reflect current state on the toolbar icon.
     *
     * PROD-6: for a tool that silently rewrites network traffic there was no
     * passive signal that it was doing anything — the only way to know was to
     * open the popup.
     *
     * PROD-5: chaos mode matters most here. It fails a percentage of requests
     * on EVERY site with no per-origin scope, so the dangerous case is leaving
     * it on and later debugging something unrelated while requests randomly
     * fail. It therefore outranks the other states and is shown in red.
     */
    async updateBadge() {
        try {
            const chaosOn = !!(this.settings
                && this.settings.chaosMode
                && this.settings.chaosMode.enabled);
            const capturing = !!(this.settings && this.settings.captureArmed);
            const enabledCount = (this.rules || []).filter((r) => r && r.enabled).length;

            let text = '';
            let color = '#1e63f5';

            if (chaosOn && this.isActive) {
                text = 'CHAOS';
                color = '#b91c1c';
            } else if (capturing && this.isActive) {
                // Capture records real response bodies, so it gets the same
                // treatment as chaos mode: impossible to leave running unnoticed.
                text = 'REC';
                color = '#b45309';
            } else if (!this.isActive) {
                text = 'OFF';
                color = '#6b7280';
            } else if (enabledCount > 0) {
                text = String(enabledCount > 99 ? '99+' : enabledCount);
            }

            await chrome.action.setBadgeText({ text });
            if (text) await chrome.action.setBadgeBackgroundColor({ color });
        } catch (error) {
            // Badge is a hint, never a feature — never let it break a state change.
        }
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
                const sess = await chrome.storage.session.get([
                    'spliceTapInterceptionLog',
                    'spliceTapCaptures'
                ]);
                if (Array.isArray(sess.spliceTapInterceptionLog)) {
                    this.interceptionLog = sess.spliceTapInterceptionLog;
                }
                if (Array.isArray(sess.spliceTapCaptures)) {
                    this.captures = sess.spliceTapCaptures;
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
                    // QA-1: the storage layer's own result used to be discarded
                    // here, so a quota-exceeded write still answered
                    // success:true and the editor reported "Rule saved
                    // successfully!" over a rule that was never persisted.
                    const saveResult = await this.storage.saveRule(ruleToSave);
                    if (!saveResult || !saveResult.success) {
                        return { success: false, error: (saveResult && saveResult.error) || 'Failed to save rule' };
                    }
                    await this.reloadRulesPreservingHits();
                    await this.broadcastState();
                    const dnrResult = await syncDnrRules(this.rules, this.isActive);
                    return { success: true, rule: saveResult.rule, dnrWarning: dnrResult.success ? undefined : dnrResult.error };
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
                    const bulkResult = await this.storage.replaceRules(prepared);
                    if (!bulkResult || !bulkResult.success) {
                        return { success: false, error: (bulkResult && bulkResult.error) || 'Failed to save rules' };
                    }
                    await this.reloadRulesPreservingHits();
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
                    const toggleResult = await this.storage.toggleRule(request.ruleId, request.enabled);
                    if (!toggleResult || !toggleResult.success) {
                        return { success: false, error: (toggleResult && toggleResult.error) || 'Failed to toggle rule' };
                    }
                    await this.reloadRulesPreservingHits();
                    await this.broadcastState();
                    await syncDnrRules(this.rules, this.isActive);
                    return { success: true };

                case 'deleteRule':
                    if (!request.ruleId) {
                        throw new Error('Rule ID is required');
                    }
                    const deleteResult = await this.storage.deleteRule(request.ruleId);
                    if (!deleteResult || !deleteResult.success) {
                        return { success: false, error: (deleteResult && deleteResult.error) || 'Failed to delete rule' };
                    }
                    await this.reloadRulesPreservingHits();
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

                case 'clearRules': {
                    // QA-1: "delete everything" reporting success while the
                    // write failed is the worst version of this bug — the user
                    // believes their rules are gone when they are not.
                    const clearResult = await this.storage.replaceRules([]);
                    if (!clearResult || !clearResult.success) {
                        return { success: false, error: (clearResult && clearResult.error) || 'Failed to clear rules' };
                    }
                    this.rules = [];
                    await this.broadcastState();
                    await syncDnrRules(this.rules, this.isActive);
                    return { success: true };
                }

                case 'testRule':
                    if (!request.rule) {
                        throw new Error('Rule data is required');
                    }
                    return await this.validateRule(request.rule);

                case 'settingsUpdated': {
                    if (request.settings) {
                        this.settings = request.settings;
                        // QA-1: the popup's Settings tab saves on every change
                        // with no Save button, so a silently failed write would
                        // leave the UI showing a setting that was never stored.
                        const settingsResult = await this.storage.saveSettings(this.settings);
                        if (settingsResult && settingsResult.success === false) {
                            return { success: false, error: settingsResult.error || 'Failed to save settings' };
                        }
                        await this.broadcastState();
                    }
                    return { success: true };
                }

                case 'logInterception':
                    // SEC-3: the relay runs in a page context, so this entry is
                    // untrusted input. It used to be accepted on a bare
                    // truthiness check, letting a page fill the DevTools panel
                    // with fabricated rows a developer would be reading as fact,
                    // and inflate any rule's persisted hitCount by replaying a
                    // known ruleId. Validate the shape, and only accept an entry
                    // whose ruleId names a rule that actually exists.
                    if (request.entry && this._isPlausibleLogEntry(request.entry)) {
                        // QA-3: entries carried no tab identity, so the DevTools
                        // panel showed every tab's intercepted traffic at once —
                        // breaking its premise as a per-tab inspector and leaking
                        // one site's request URLs into a window inspecting
                        // another. The sender's tab id is taken here rather than
                        // trusted from the message body, since the page-side
                        // relay could otherwise claim any tab.
                        this.interceptionLog.push({
                            ...request.entry,
                            tabId: (sender && sender.tab && typeof sender.tab.id === 'number')
                                ? sender.tab.id
                                : null
                        });
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
                            // PERF-5: this was an Array.find per intercepted
                            // request — O(rules × requests) on a busy page.
                            const rule = this._ruleById(request.entry.ruleId);
                            if (rule) {
                                rule.hitCount = (rule.hitCount || 0) + 1;
                                this._rulesDirty = true;
                            }
                        }

                        await this._persistVolatile();
                    }
                    return { success: true };

                case 'logCapture': {
                    const e = request.entry;
                    if (!e || typeof e.body !== 'string') return { success: true };
                    // Only accept captures while armed. The relay runs in a page
                    // context, so a compromised one must not be able to push
                    // response bodies into storage when the user has not asked.
                    if (!(this.settings && this.settings.captureArmed)) return { success: true };

                    this.captures.push({
                        id: `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        ts: Number(e.ts) || Date.now(),
                        url: String(e.url || ''),
                        method: String(e.method || 'GET').toUpperCase(),
                        status: Number(e.status) || 200,
                        statusText: String(e.statusText || ''),
                        contentType: String(e.contentType || ''),
                        headers: (e.headers && typeof e.headers === 'object') ? e.headers : {},
                        body: e.body,
                        tabId: (sender && sender.tab && typeof sender.tab.id === 'number') ? sender.tab.id : null
                    });
                    if (this.captures.length > this.MAX_CAPTURES) {
                        this.captures.splice(0, this.captures.length - this.MAX_CAPTURES);
                    }
                    await this._persistCaptures();
                    return { success: true };
                }

                case 'getCaptures':
                    return { success: true, captures: this.captures, armed: !!(this.settings && this.settings.captureArmed) };

                case 'clearCaptures':
                    this.captures = [];
                    await this._persistCaptures();
                    return { success: true };

                case 'setCaptureArmed': {
                    this.settings = { ...this.settings, captureArmed: !!request.armed };
                    const armResult = await this.storage.saveSettings(this.settings);
                    if (armResult && armResult.success === false) {
                        return { success: false, error: armResult.error || 'Failed to change capture state' };
                    }
                    await this.broadcastState();
                    return { success: true, armed: !!this.settings.captureArmed };
                }

                case 'getRuleStats':
                    // PERF-2: the DevTools panel polls every 3s and needs two
                    // integers, but 'getRules' hands back every rule object —
                    // including embedded mock bodies — to be structured-cloned
                    // across the message boundary each time. Compute the
                    // numbers here instead.
                    return {
                        success: true,
                        intercepted: (this.stats && this.stats.intercepted) || 0,
                        activeRules: (this.rules || []).filter((r) => r && r.enabled).length,
                        settings: this.settings
                    };

                case 'getInterceptionLog': {
                    // The panel passes the tab it is inspecting. Entries logged
                    // before this change (or from a frame with no tab id) have
                    // no tabId and are kept, so an upgrade doesn't blank the
                    // panel; omitting tabId entirely returns everything.
                    const forTab = request.tabId;
                    const entries = (typeof forTab === 'number')
                        ? this.interceptionLog.filter((e) => e.tabId === forTab || e.tabId == null)
                        : this.interceptionLog;
                    return { success: true, entries };
                }

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
     * 'logInterception' handler.
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

        // headers/queryparams are DNR-backed: the network layer cannot express
        // these conditions at all.
        //
        // CQ-4: redirect is added here for a different reason. It IS
        // interceptor-handled, but XHR must choose the redirect URL in open(),
        // and request headers are not set until after open() — so the XHR path
        // matches on url+method only while fetch honours the full condition.
        // The same rule would then redirect an XHR call and skip the identical
        // fetch call. The options form already refused this combination, but
        // nothing stopped it arriving by import or hand-edit, so enforce it at
        // the one boundary every write passes through.
        const dnrBacked = type === 'headers' || type === 'queryparams';
        if ((dnrBacked || type === 'redirect') && rule.match && (rule.match.headers || rule.match.graphql)) {
            errors.push(dnrBacked
                ? 'Header/GraphQL match conditions are not supported for this rule type'
                : 'Redirect rules cannot use header or GraphQL match conditions, because the redirect target must be chosen before request headers exist');
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
        // Every state change funnels through here, so this is the one place the
        // badge needs to be refreshed from.
        this.updateBadge();

        const state = {
            type: 'syncState',
            rules: this.rules,
            active: this.isActive,
            settings: this.settings
        };

        try {
            // PERF-6: this queried every tab in every window and sent the full
            // rules array to each on every edit — including chrome:// tabs,
            // extension pages and the PDF viewer, none of which can have a
            // content script. The manifest only injects into http(s), so
            // filtering here removes work that could never have landed.
            const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
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
                // Deliberately does NOT open the options page. Everything a
                // user needs — rules, data, settings — now lives in the popup;
                // the options page only hosts the rule editor for cases the
                // in-page overlay can't reach, so opening it on install landed
                // people on a near-empty tab that explained nothing.
                //
                // No install badge either: the badge now carries live state
                // (rule count, OFF, CHAOS) and a one-off "NEW" would either be
                // overwritten by the first state change or, worse, mask the
                // CHAOS warning. Chrome's own "Extension added" pin prompt
                // already points at the toolbar, and the popup's empty state
                // carries the getting-started copy.
                this.updateBadge();
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