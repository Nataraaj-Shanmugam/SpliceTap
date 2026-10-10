/**
 * SpliceTap Background Service Worker
 * Manages extension state, rules storage, and communication with content scripts.
 * 
 * NOTE: Interception logic has moved to content/content.js (Monkey Patching) 
 * to support dynamic responses and chaos mode in Manifest V3 without blocking permissions.
 */

import { SpliceTapStorage } from '../src/storage.js';
// UMD shared modules: side-effect import, then read the API off globalThis —
// the same pattern injected.js uses via `window.SpliceTapMatcher`. Order
// matters: ES modules evaluate in import order, and rule-schema reads common
// (LIMITS) and matcher (the ReDoS probe) at load, while dnr reads rule-schema.
import '../src/common.js';
import '../src/templates.js'; // status reason phrases, read by storage.normalizeRule
import '../src/matcher.js';
import '../src/rule-schema.js';
import './dnr.js';

const { syncDnrRules, deepEqual } = globalThis.SpliceTapDnr;
const { generateId } = globalThis.SpliceTapCommon;
const RuleSchema = globalThis.SpliceTapRuleSchema;

// PER-34: the rule types the page-side interceptor runs (src/matcher.js
// INTERCEPTOR_TYPES). headers/queryparams rules are applied by Chrome (DNR).
const INTERCEPTOR_TYPES = new Set(['mock', 'block', 'delay', 'redirect']);

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
        this.stateVersion = Date.now(); // see _bumpStateVersion
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
    /**
     * Validate one interception-log entry and fold it into the in-memory log,
     * stats and the rule's hit count. Returns whether it was accepted.
     *
     * SEC-3: the relay runs in a page context, so an entry is untrusted input.
     * It used to be accepted on a bare truthiness check, letting a page fill
     * the DevTools panel with fabricated rows a developer would read as fact,
     * and inflate any rule's persisted hitCount by replaying a known ruleId.
     * The shape is validated, and only an entry whose ruleId names a rule that
     * actually exists is kept.
     *
     * Persistence is deliberately NOT done here — the caller decides, so a
     * batch pays for one write instead of one per entry (PERF-4).
     */
    _recordLogEntry(entry, sender) {
        if (!entry || !this._isPlausibleLogEntry(entry)) return false;

        // An entry for a request made before the log was last cleared, that
        // was still in a tab's batch queue at the time. Dropped, not shown:
        // the user asked for those to be gone. (ts is page-supplied, so a page
        // could only use this to hide its own entries, which it can already do
        // by not sending them.)
        if (this._logClearedAt && typeof entry.ts === 'number' && entry.ts < this._logClearedAt) {
            return false;
        }

        // QA-3: entries carried no tab identity, so the DevTools panel showed
        // every tab's intercepted traffic at once — breaking its premise as a
        // per-tab inspector and leaking one site's request URLs into a window
        // inspecting another. The sender's tab id is taken here rather than
        // trusted from the message body, since the page-side relay could
        // otherwise claim any tab.
        this.interceptionLog.push({
            ...entry,
            tabId: (sender && sender.tab && typeof sender.tab.id === 'number')
                ? sender.tab.id
                : null
        });
        if (this.interceptionLog.length > this.MAX_INTERCEPTION_LOG) {
            this.interceptionLog.splice(0, this.interceptionLog.length - this.MAX_INTERCEPTION_LOG);
        }
        this._applyStatsIncrement(1);

        // Q-26/G-6: hitCount was defined in the schema and rendered in the UI
        // but nothing ever incremented it. Bumped in-memory immediately (so a
        // getRules() call right after reflects it); the write to storage rides
        // the same throttle as stats/log persistence rather than a save per
        // intercepted request.
        if (entry.ruleId) {
            // PERF-5: this was an Array.find per intercepted request —
            // O(rules × requests) on a busy page.
            const rule = this._ruleById(entry.ruleId);
            if (rule) {
                rule.hitCount = (rule.hitCount || 0) + 1;
                this._rulesDirty = true;
            }
        }

        return true;
    }

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

            // PER-31: the broadcast is not awaited — `ready` gates every
            // handler, and one tab paused at a breakpoint held it forever.
            await this._syncThenBroadcast();
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
                        version: this.stateVersion,
                        // PER-34: the relay in every frame asks for state on
                        // load. A subframe has no use for disabled rules' mock
                        // bodies or DNR rules — only the top frame hosts the
                        // in-page editor, which checks any rule still exists.
                        rules: (request.scope === 'interceptor'
                            || (this._isContentScript(sender) && sender.frameId !== 0))
                            ? this._interceptorRules()
                            : this.rules,
                        active: this.isActive,
                        stats: this.stats,
                        settings: this.settings,
                        // ruleId -> Chrome's reason, for rules declarativeNetRequest
                        // refused; lets the popup flag the specific rule instead
                        // of only a transient toast.
                        dnrErrors: this.dnrRejected ? Object.fromEntries(this.dnrRejected) : {}
                    };

                case 'toggleExtension': {
                    // PER-31: every mutation persists, syncs the network layer
                    // and answers without waiting on tabs; see broadcastState.
                    this.isActive = request.active;
                    await this.storage.saveActiveState(this.isActive);
                    const dnrWarning = await this._syncThenBroadcast();
                    return { success: true, active: this.isActive, dnrWarning };
                }

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
                    if (typeof ruleToSave.id !== 'string' || !ruleToSave.id.trim()) {
                        ruleToSave.id = generateId();
                    }
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
                    const dnrWarning = await this._syncThenBroadcast();
                    return { success: true, rule: saveResult.rule, dnrWarning };
                }

                case 'setRules': {
                    // Bulk persist path used by reorder, toggle-all and import.
                    // S-2: new and changed rules are validated; invalid ones
                    // are skipped (not silently accepted, not a hard failure
                    // for the whole batch — one bad rule in an imported file
                    // shouldn't block the N good ones). See _prepareBulkRules
                    // for what happens to stored rules (PER-27) and ids
                    // (PER-28). The per-rule decision runs inside the storage
                    // chain, against the exact copy this write replaces.
                    if (!Array.isArray(request.rules)) {
                        throw new Error('rules array is required');
                    }
                    let rejected = [];
                    const bulkResult = await this.storage.replaceRules(async (stored) => {
                        const prepared = await this._prepareBulkRules(request.rules, stored);
                        rejected = prepared.rejected;
                        return prepared.rules;
                    });
                    if (!bulkResult || !bulkResult.success) {
                        return { success: false, error: (bulkResult && bulkResult.error) || 'Failed to save rules' };
                    }
                    await this.reloadRulesPreservingHits();
                    const dnrWarning = await this._syncThenBroadcast();
                    return {
                        success: true,
                        rules: this.rules,
                        rejected: rejected.length ? rejected : undefined,
                        dnrWarning
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
                    // This path used to discard the sync result, so a toggle
                    // Chrome had not applied still answered plain success.
                    return { success: true, dnrWarning: await this._syncThenBroadcast() };

                case 'deleteRule':
                    if (!request.ruleId) {
                        throw new Error('Rule ID is required');
                    }
                    const deleteResult = await this.storage.deleteRule(request.ruleId);
                    if (!deleteResult || !deleteResult.success) {
                        return { success: false, error: (deleteResult && deleteResult.error) || 'Failed to delete rule' };
                    }
                    await this.reloadRulesPreservingHits();
                    return { success: true, dnrWarning: await this._syncThenBroadcast() };

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
                    return { success: true, dnrWarning: await this._syncThenBroadcast() };
                }

                case 'resetAll': {
                    // "Delete all SpliceTap data". The popup used to do this
                    // itself — clearRules plus removing a list of local keys —
                    // and announced "All SpliceTap data deleted" while leaving
                    // session storage untouched: captured response BODIES and
                    // the interception log survived. Worse, it removed the
                    // stored settings but not this worker's in-memory copy, so
                    // an armed Capture kept recording response bodies after the
                    // user had been told everything was wiped. Verified
                    // headless. Only this worker holds the in-memory state, so
                    // the reset lives here.
                    if (this._trailingFlushTimer) {
                        clearTimeout(this._trailingFlushTimer);
                        this._trailingFlushTimer = null;
                    }
                    this._rulesDirty = false;
                    this.rules = [];
                    this.captures = [];
                    this.interceptionLog = [];
                    this.settings = {};
                    this.isActive = true;
                    this.stats = { intercepted: 0, lastReset: new Date().toISOString() };
                    this.dnrRejected = new Map();
                    this._logClearedAt = Date.now();

                    const cleared = await this.storage.clearAll();
                    try {
                        await chrome.storage.session.clear();
                    } catch (e) {
                        // session storage unavailable — nothing was stored there
                    }
                    if (!cleared || !cleared.success) {
                        return { success: false, error: (cleared && cleared.error) || 'Failed to delete stored data' };
                    }

                    // Tell every tab: no rules, nothing armed, interception on.
                    return { success: true, dnrWarning: await this._syncThenBroadcast() };
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
                        this.broadcastState();
                    }
                    return { success: true };
                }

                case 'logInterception':
                    // SEC-3 validation and the per-entry bookkeeping both live
                    // in _recordLogEntry; see there for the threat model.
                    if (this._recordLogEntry(request.entry, sender)) {
                        await this._persistVolatile();
                    }
                    return { success: true };

                case 'logInterceptionBatch': {
                    // PERF-4: the relay coalesces a busy page's entries into
                    // one message. Each is validated individually — batching
                    // is a transport change, not a relaxation of SEC-3 — but
                    // the storage write happens once for the whole batch
                    // rather than once per intercepted request.
                    const batch = Array.isArray(request.entries) ? request.entries : [];
                    let accepted = 0;
                    for (const entry of batch.slice(0, this.MAX_INTERCEPTION_LOG)) {
                        if (this._recordLogEntry(entry, sender)) accepted++;
                    }
                    if (accepted > 0) {
                        await this._persistVolatile();
                    }
                    return { success: true, accepted };
                }

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
                    this.broadcastState();
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
                    // Requests made just before the clear may still be in a
                    // tab's batch queue (PERF-4's 250ms window) and would land
                    // afterwards, refilling a log the user just emptied. Clear
                    // means "forget everything before now"; see _recordLogEntry.
                    this._logClearedAt = Date.now();
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
    /**
     * Apply the current rules to declarativeNetRequest and return a warning
     * string if Chrome refused any of them (undefined when all applied).
     *
     * Every handler goes through here. Several used to call the sync and
     * discard its result, so a toggle or delete Chrome did not apply still
     * answered plain success. Refused rules are also kept by rule id, so
     * getRules can tell the popup which specific rule is not being applied.
     */
    async _syncNetworkRules() {
        const outcome = await syncDnrRules(this.rules, this.isActive);
        this.dnrRejected = new Map((outcome.rejected || []).map((r) => [r.id, r.error]));
        return outcome.success ? undefined : outcome.error;
    }

    /**
     * PER-31: the tail of every rule or on/off mutation, once the change is
     * persisted. The network layer is synced before the caller is answered —
     * its warning is part of the answer — while tabs are told without waiting.
     */
    async _syncThenBroadcast() {
        const dnrWarning = await this._syncNetworkRules();
        this.broadcastState();
        return dnrWarning;
    }

    /**
     * Decide what a bulk write (setRules) stores, rule by rule.
     *
     * PER-27: every incoming rule used to be re-validated, and any that failed
     * was dropped — so Move up/down, Toggle-all and a merge import permanently
     * deleted stored rules an earlier build had accepted, once a later build
     * tightened the schema (a 120-character name, for one). Now:
     *   - a rule identical to its stored copy (ignoring runtime-only fields)
     *     is kept as stored, without re-validation — nothing about it changed;
     *   - a new or changed rule is validated, and refused if invalid;
     *   - a refused change to a stored rule keeps the stored copy, so a bulk
     *     write can never delete a rule the caller did not leave out.
     *
     * PER-28: a replace-mode import could store two rules under one id, and
     * toggle/delete by id then hit the wrong one or both. A repeated id is
     * re-issued. Network-rule ids must be unique too (Chrome refuses the
     * whole batch otherwise): stored copies keep theirs, and a new rule never
     * trusts one it brought — it came from another profile's counter.
     */
    async _prepareBulkRules(incoming, stored) {
        const storedById = new Map();
        for (const rule of stored) {
            if (rule && typeof rule.id === 'string' && !storedById.has(rule.id)) storedById.set(rule.id, rule);
        }

        const seenIds = new Set();
        const rejected = [];
        const chosen = []; // { rule, previous, asStored }
        for (const raw of incoming) {
            const rule = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? { ...raw } : raw;
            let previous = null;
            if (rule && typeof rule === 'object') {
                if (typeof rule.id !== 'string' || !rule.id.trim() || seenIds.has(rule.id)) {
                    rule.id = generateId();
                } else {
                    previous = storedById.get(rule.id) || null;
                }
                seenIds.add(rule.id);
            }

            if (previous && this._sameStoredRule(rule, previous)) {
                chosen.push({ rule: previous, previous, asStored: true });
                continue;
            }

            const validation = await this.validateRule(rule);
            if (!validation.passed) {
                rejected.push({
                    id: rule && rule.id,
                    name: rule && rule.name,
                    errors: validation.results.map((r) => r.message),
                    // The change was refused; the rule itself is still there.
                    keptStored: previous ? true : undefined
                });
                if (previous) chosen.push({ rule: previous, previous, asStored: true });
                continue;
            }
            chosen.push({ rule, previous, asStored: false });
        }

        const isDnr = (r) => r.type === 'headers' || r.type === 'queryparams';
        const usedDnrIds = new Set();
        const keepsOwnId = new Set();
        for (const entry of chosen) {
            const id = entry.rule.dnrRuleId;
            if (entry.asStored && isDnr(entry.rule) && id && !usedDnrIds.has(id)) {
                usedDnrIds.add(id);
                keepsOwnId.add(entry);
            }
        }

        const rules = [];
        for (const entry of chosen) {
            let rule = entry.rule;
            if (isDnr(rule) && !keepsOwnId.has(entry)) {
                const own = entry.previous && entry.previous.dnrRuleId;
                const dnrRuleId = (own && !usedDnrIds.has(own)) ? own : await this.allocateDnrIdSerialized();
                usedDnrIds.add(dnrRuleId);
                rule = { ...rule, dnrRuleId };
            }
            rules.push(rule);
        }
        return { rules, rejected };
    }

    /**
     * PER-27: is an incoming rule the stored rule, unchanged? hitCount moves
     * on its own and testStatus is popup display state, so neither counts.
     */
    _sameStoredRule(incoming, stored) {
        const comparable = (rule) => {
            const copy = { ...this.storage.normalizeRule(rule) };
            delete copy.hitCount;
            delete copy.testStatus;
            return copy;
        };
        return deepEqual(comparable(incoming), comparable(stored));
    }

    async validateRule(rule) {
        // The checks themselves live in src/rule-schema.js, shared with both
        // editors, so a rule the editor accepts is a rule this boundary
        // accepts — and an import, which bypasses the editors, meets the
        // exact same rules (CQ-1).
        const { errors } = RuleSchema.validateRule(rule);

        // The one check that needs Chrome: declarativeNetRequest evaluates
        // regexFilter with RE2, not JavaScript's engine. Lookarounds,
        // backreferences and oversized patterns are valid JS but rejected by
        // DNR — and a rejected rule takes its whole updateDynamicRules batch
        // down with it. Ask Chrome rather than approximate RE2 here.
        const type = rule && (rule.type || 'mock');
        const pattern = rule && rule.match && rule.match.url;
        const dnrBacked = type === 'headers' || type === 'queryparams';
        if (errors.length === 0 && dnrBacked && RuleSchema.isRegexPattern(pattern)
            && chrome.declarativeNetRequest && typeof chrome.declarativeNetRequest.isRegexSupported === 'function') {
            try {
                const support = await chrome.declarativeNetRequest.isRegexSupported({
                    regex: pattern.slice(1, -1),
                    isCaseSensitive: false
                });
                if (support && support.isSupported === false) {
                    const why = support.reason === 'memoryLimitExceeded'
                        ? "it is too complex for Chrome's network rules"
                        : "Chrome's network rules do not support its syntax (no lookarounds or backreferences)";
                    errors.push(`Invalid URL pattern: this regex cannot be used for header or query-parameter rules — ${why}`);
                }
            } catch (error) {
                // Availability check only; the resilient sync in dnr.js still
                // isolates a rule Chrome refuses.
            }
        }

        if (errors.length > 0) {
            return {
                success: true,
                passed: false,
                results: errors.map((message) => ({ status: 'failed', message }))
            };
        }
        return {
            success: true,
            passed: true,
            results: [{ status: 'passed', message: 'Rule validation passed' }]
        };
    }

    /**
     * Broadcast current rules/settings to all content scripts with retry logic
     */
    /**
     * The state message tabs receive, built from the CURRENT state at the
     * moment it is sent.
     *
     * Every delayed send used to carry a snapshot captured earlier: the
     * load-complete push captured state and sent it 500ms later, and a failed
     * broadcast retried 1-3s later with the state of its first attempt. Any
     * change in between was overwritten in that tab by the older snapshot.
     * Verified headless: saving rules while a page loaded left it running an
     * older rule set in 29 of 30 trials — the newest rule silently missing.
     *
     * `version` lets the relay discard anything older than what it already
     * applied, which also covers a reply to its own initial getRules arriving
     * after a newer push: two channels, no ordering guarantee between them.
     */
    _stateMessage() {
        return {
            type: 'syncState',
            rules: this._interceptorRules(),
            active: this.isActive,
            settings: this.settings,
            version: this.stateVersion
        };
    }

    /**
     * PER-34 (contract 3): what tabs are sent — enabled interceptor rules
     * only. Every frame of every tab got the whole rule list, disabled rules'
     * mock bodies included: 58 MB retained on a page with 20 iframes with
     * every rule disabled, and more for PER-1/PER-2 to expose.
     */
    _interceptorRules() {
        return (this.rules || []).filter((rule) =>
            rule && rule.enabled && INTERCEPTOR_TYPES.has(rule.type || 'mock'));
    }

    /**
     * PER-6: is this message from a content script — code running in a web
     * page's frame — rather than one of the extension's own pages? Extension
     * pages (popup, options, DevTools panel) send from this extension's
     * chrome-extension:// URL; a content script's sender URL is the page's.
     * Anything not shown to be an extension page counts as a content script.
     */
    _isContentScript(sender) {
        const base = chrome.runtime.getURL
            ? chrome.runtime.getURL('').replace(/\/$/, '')
            : `chrome-extension://${chrome.runtime.id}`;
        const from = (sender && (sender.url || sender.origin)) || '';
        return !(from === base || from.startsWith(base + '/'));
    }

    /**
     * Advance the state version. Time-based so it keeps increasing across
     * service-worker restarts without persisting anything (a restarted worker
     * starting from 0 would have every open tab ignore it), and +1 so two
     * changes in the same millisecond still order.
     */
    _bumpStateVersion() {
        this.stateVersion = Math.max(Date.now(), (this.stateVersion || 0) + 1);
        return this.stateVersion;
    }

    /**
     * Push the current state to every tab. Callers do NOT await this.
     *
     * PER-31: every mutation used to await it, and it waited on
     * tabs.sendMessage to every tab — which never settles for a tab paused at
     * a breakpoint. Saving, toggling and the master switch all hung until the
     * developer resumed, and switching off withdrew the network rules only
     * after the broadcast. The version is bumped synchronously here, and each
     * message is built when it is sent, so a late delivery is never stale:
     * the relay drops anything older than what it already applied.
     */
    broadcastState() {
        // Every state change funnels through here, so this is the one place the
        // badge needs to be refreshed from.
        this.updateBadge();
        this._bumpStateVersion();
        return this._sendStateToTabs();
    }

    async _sendStateToTabs() {
        try {
            // PERF-6: this queried every tab in every window and sent the full
            // rules array to each on every edit — including chrome:// tabs,
            // extension pages and the PDF viewer, none of which can have a
            // content script. The manifest only injects into http(s), so
            // filtering here removes work that could never have landed.
            const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
            // Settled per tab (with retries); one unresponsive tab delays nobody.
            await Promise.allSettled(tabs.map((tab) => this.broadcastToTab(tab.id)));
        } catch (error) {
            console.error('Failed to query tabs for broadcast:', error);
        }
    }

    /**
     * Broadcast to a specific tab with retry logic
     */
    async broadcastToTab(tabId) {
        try {
            await chrome.tabs.sendMessage(tabId, this._stateMessage());

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
                
                // The retry sends the state as it is THEN, not this attempt's.
                setTimeout(() => {
                    this.broadcastToTab(tabId);
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

                // Give the content script time to load, then send the state as
                // it is at that moment — not as it was when the load finished.
                setTimeout(() => {
                    this.broadcastToTab(tabId);
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
                    await this._syncThenBroadcast();
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