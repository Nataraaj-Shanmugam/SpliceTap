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
import '../src/redact.js';
import './dnr.js';

const { syncDnrRules, deepEqual, isDnrRule, isNetworkRule, ruleToDnr } = globalThis.SpliceTapDnr;
const { generateId } = globalThis.SpliceTapCommon;
const RuleSchema = globalThis.SpliceTapRuleSchema;
const { matchUrl } = globalThis.SpliceTapMatcher;
const { redactUrl } = globalThis.SpliceTapRedact;

// F2: the network observer (optional webRequest permission). Each listener
// has its own precomputed candidate list; see _refreshNetworkObserver.
const OBSERVED_NOTE = 'Seen on the network — Chrome applied this rule; SpliceTap matched it independently';
const OBSERVER_PHASES = ['beforeRequest', 'sendHeaders', 'headersReceived'];
const OBSERVER_EVENTS = { beforeRequest: 'onBeforeRequest', sendHeaders: 'onSendHeaders', headersReceived: 'onHeadersReceived' };
// Events that woke the worker before its rules loaded, replayed once they have.
const OBSERVER_PENDING_MAX = 50;
// Request ids already logged per rule: a redirect re-runs the listeners
// under the same id, and the rule must not count twice.
const OBSERVER_SEEN_MAX = 500;
const SETTINGS_BOOLEANS = ['observeNetworkRules', 'allowCodeResponses']; // F2, F4

// PER-34: the rule types the page-side interceptor runs (src/matcher.js
// INTERCEPTOR_TYPES). headers/queryparams rules are applied by Chrome (DNR).
// F3: plus requestBody, which the interceptor runs in its own pass before
// the main first-match (so it is not in the matcher's INTERCEPTOR_TYPES).
const INTERCEPTOR_TYPES = new Set(['mock', 'block', 'delay', 'redirect', 'requestBody']);

// PER-6: the only messages content scripts send — the relay (content.js:
// getRules, logInterceptionBatch, logCapture; logInterception is its older
// single-entry form) and the in-page editor (rule-editor.js via overlay.js:
// getRules, saveRule; B2-F10: explainMatch). Everything else is for extension
// pages only.
const CONTENT_SCRIPT_MESSAGES = new Set([
    'getRules', 'saveRule', 'logInterception', 'logInterceptionBatch', 'logCapture', 'explainMatch',
    'saveEditorDraft', 'getEditorDraft', 'clearEditorDraft' // PER-63
]);
// The in-page editor only ever runs in the top frame, so its messages are
// refused from any other frame.
const TOP_FRAME_MESSAGES = new Set(['saveRule', 'explainMatch', 'saveEditorDraft', 'getEditorDraft', 'clearEditorDraft']);

// PER-63: unsaved editor drafts, in session storage, one per tab (or the
// options page). Each is capped and expires; the oldest go past the count.
const DRAFTS_KEY = 'spliceTapDrafts';
const DRAFT_MAX_BYTES = 200 * 1024;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const DRAFTS_MAX = 20;

// B2-F10: explainMatch's bounds on what a caller can hand it.
const EXPLAIN_URL_MAX = 4096;
const EXPLAIN_BODY_MAX = 1024 * 1024;
const EXPLAIN_HOST = 'https://example.test';

// SEC2-7: size caps for what a page-side relay can make the background keep.
// CAPTURE_MAX_BODY matches the interceptor's own limit (injected.js).
const LOG_TEXT_MAX = 256;
// PER-54: a redirect destination is a URL, so it gets the URL cap; the note is a sentence.
const LOG_REDIRECT_MAX = 2048;
const LOG_NOTE_MAX = 200;
const CAPTURE_MAX_BODY = 100 * 1024;
const CAPTURE_MAX_HEADERS = 100;
const CAPTURE_HEADER_VALUE_MAX = 8192;

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

        // F2: the network observer's state. Candidates are rebuilt whenever
        // rules, settings, the master switch or the permission change.
        this._observerCandidates = { beforeRequest: [], sendHeaders: [], headersReceived: [] };
        this._observerPending = []; // null once the stored state has loaded
        this._observerSeen = new Map(); // requestId -> Set of ruleIds logged
        this._observerHandlers = {};
        for (const phase of OBSERVER_PHASES) {
            this._observerHandlers[phase] = (details) => this._observeRequest(phase, details);
        }

        // Register event listeners synchronously, in the first turn of the
        // service-worker script. MV3 workers are ephemeral; a listener added
        // only after an `await` can miss the very event that woke the worker.
        // Handlers await `this.ready` before reading state.
        this.setupMessageHandlers();
        this.setupContextMenus();
        this.setupExtensionLifecycle();
        this.setupCommands();
        this.setupSuspendFlush();
        this.setupNetworkObserver();

        this.ready = this.loadStoredData()
            .then(() => console.log('SpliceTap background service worker initialized (Config Mode)'))
            .catch((error) => console.error('Failed to initialize background service worker:', error))
            .then(() => this._drainObserverPending());
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
        // SEC2-7: copied field by field. Spreading the entry kept any extra
        // field a page put on it, uncapped, in the log and in session storage.
        // PER-54: a chaos-mode failure belongs to no rule, so it is kept with
        // a null ruleId whatever the page put there.
        const isChaos = entry.kind === 'chaos';
        this.interceptionLog.push({
            ts: entry.ts,
            url: entry.url,
            method: entry.method,
            ruleId: isChaos ? null : entry.ruleId,
            // Display only; a rule stored by an older build may have a long name.
            ruleName: entry.ruleName === undefined ? undefined : entry.ruleName.slice(0, LOG_TEXT_MAX),
            ruleType: entry.ruleType,
            status: entry.status,
            // PER-54 / PER-56: each of these is dropped, not the entry, when
            // its value is malformed (see _logOutcomeFields).
            ...this._logOutcomeFields(entry),
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
        if (!isChaos && entry.ruleId) {
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
        // PER-54: a chaos entry names no rule; its ruleId, if any, is ignored.
        const isChaos = entry.kind === 'chaos';
        if (!isChaos && (typeof entry.ruleId !== 'string' || entry.ruleId.length > LOG_TEXT_MAX)) return false;
        if (entry.ruleName !== undefined && typeof entry.ruleName !== 'string') return false;
        if (entry.ruleType !== undefined && (typeof entry.ruleType !== 'string' || entry.ruleType.length > 32)) return false;
        // 'failed': the request errored before any status existed (chaos mode,
        // or a real request that threw).
        if (entry.status !== undefined && entry.status !== null && entry.status !== 'failed' && typeof entry.status !== 'number') return false;
        if (entry.ts !== undefined && typeof entry.ts !== 'number') return false;

        return isChaos || !!this._ruleById(entry.ruleId);
    }

    /**
     * PER-54 / PER-56 (Contract A): the optional outcome fields of a log
     * entry, each copied only if it has the stated type and size, so a
     * malformed value costs the field and never the entry.
     *   kind         'rule' | 'chaos'
     *   elapsedMs    integer >= 0
     *   finalStatus  integer | 'failed'
     *   redirectedTo string <= 2048
     *   note         string <= 200
     */
    _logOutcomeFields(entry) {
        const fields = {};
        if (entry.kind === 'rule' || entry.kind === 'chaos') fields.kind = entry.kind;
        if (Number.isInteger(entry.elapsedMs) && entry.elapsedMs >= 0) fields.elapsedMs = entry.elapsedMs;
        if (Number.isInteger(entry.finalStatus) || entry.finalStatus === 'failed') fields.finalStatus = entry.finalStatus;
        if (typeof entry.redirectedTo === 'string' && entry.redirectedTo.length <= LOG_REDIRECT_MAX) fields.redirectedTo = entry.redirectedTo;
        if (typeof entry.note === 'string' && entry.note.length <= LOG_NOTE_MAX) fields.note = entry.note;
        return fields;
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
            // PER-6: any frame of any page runs a content script, so a
            // compromised renderer (or PER-1) could otherwise reach setRules,
            // resetAll, getCaptures and the rest. Content scripts get the
            // messages they actually send; extension pages are unaffected.
            if (this._isContentScript(sender)) {
                const type = request && request.type;
                // The in-page editor only ever runs in the top frame.
                const allowed = CONTENT_SCRIPT_MESSAGES.has(type)
                    && (!TOP_FRAME_MESSAGES.has(type) || (sender && sender.frameId === 0));
                if (!allowed) {
                    console.warn(`SpliceTap: "${type}" is not accepted from a web page`);
                    return { success: false, error: 'This request is not available to web pages' };
                }
            }

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
                    // F1: appliesTo:'all' redirect/block rules are network
                    // rules too. One flipped back to 'page' keeps its id; the
                    // sync withdraws its DNR rule.
                    if (isDnrRule(ruleToSave) && !ruleToSave.dnrRuleId) {
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
                    this._draftsFallback = null; // PER-63: drafts are in session storage, cleared below

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

                case 'explainMatch':
                    return this._explainMatch(request);

                case 'saveEditorDraft':
                case 'getEditorDraft':
                case 'clearEditorDraft':
                    return this._editorDraft(request, sender);

                case 'settingsUpdated': {
                    if (request.settings) {
                        const settings = request.settings;
                        if (typeof settings !== 'object' || Array.isArray(settings)) {
                            return { success: false, error: 'Settings must be an object' };
                        }
                        // F2/F4: switches that widen what SpliceTap does
                        // (observe all traffic, run rule code in pages) are
                        // turned on only by a literal true, never by a
                        // truthy string a caller got wrong.
                        const invalid = SETTINGS_BOOLEANS.find((key) =>
                            settings[key] !== undefined && typeof settings[key] !== 'boolean');
                        if (invalid) {
                            return { success: false, error: `"${invalid}" must be true or false` };
                        }
                        this.settings = settings;
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
                    // SEC2-7: the interceptor never sends a larger body, so a
                    // larger one did not come from it. Every field below is
                    // copied and capped here rather than trusting page-side
                    // limits; headers kept the page's object as-is.
                    if (e.body.length > CAPTURE_MAX_BODY) return { success: true };

                    const headers = {};
                    if (e.headers && typeof e.headers === 'object') {
                        for (const [name, value] of Object.entries(e.headers).slice(0, CAPTURE_MAX_HEADERS)) {
                            if (typeof value === 'string' && name.length <= LOG_TEXT_MAX) {
                                headers[name] = value.slice(0, CAPTURE_HEADER_VALUE_MAX);
                            }
                        }
                    }
                    const status = Number(e.status);

                    this.captures.push({
                        id: `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        ts: Number(e.ts) || Date.now(),
                        url: String(e.url || '').slice(0, 4096),
                        method: String(e.method || 'GET').toUpperCase().slice(0, 16),
                        status: (Number.isInteger(status) && status >= 100 && status <= 999) ? status : 200,
                        statusText: String(e.statusText || '').slice(0, LOG_TEXT_MAX),
                        contentType: String(e.contentType || '').slice(0, LOG_TEXT_MAX),
                        headers,
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
            // This wrote `this.rules` whole, outside storage's mutation chain,
            // so it could land between a saveRule's write and the reload after
            // it: storage got back a snapshot without the rule just saved, the
            // reload adopted it, and the rule vanished from storage and from
            // every tab while the save answered success (1 in 120 headless
            // runs under load). Only the counts are written now, inside the
            // chain, onto whatever is stored.
            await this.storage.mergeHitCounts(() => {
                const counts = {};
                for (const rule of this.rules) {
                    if (rule && rule.id && rule.hitCount) counts[rule.id] = rule.hitCount;
                }
                return counts;
            });
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

        const isDnr = (r) => isDnrRule(r); // F1: includes appliesTo:'all' redirect/block
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
        const pattern = rule && rule.match && rule.match.url;
        // F1: an appliesTo:'all' redirect/block rule's regex runs in RE2 too.
        const networkRule = isNetworkRule(rule);
        const dnrBacked = isDnrRule(rule);
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
                    errors.push(networkRule
                        ? `Invalid URL pattern: this regex cannot be used for a rule that applies to all requests — ${why}. Untick "all requests" or simplify it.`
                        : `Invalid URL pattern: this regex cannot be used for header or query-parameter rules — ${why}`);
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
     * B2-F10: "Try a URL". Would this rule match this request, condition by
     * condition, and which earlier rules would win it instead?
     *
     * In:  { rule? | ruleId?, url?, method?, pageUrl?, resourceType?, body? }
     * Out: { success, url, result, shadowedBy: [{ ruleId, ruleName }], network }
     *
     * With no url, one is made from a wildcard pattern (each * becomes x,
     * https://example.test in front when there is no scheme), and the rest of
     * the request from the rule — its method, page domain, resource type,
     * header conditions and GraphQL/payload filter — so it describes a request
     * the rule targets. A regex pattern cannot be turned into a URL:
     * needsUrl:true.
     *
     * shadowedBy: earlier enabled rules, in stored order, of the same family
     * (in-page: mock/block/delay/redirect; requestBody among its own kind;
     * network: headers/queryparams/all-request — see familyFor) that also
     * match. A rule not yet stored would be saved last, so every stored rule
     * is earlier. network: the rule is applied by Chrome, so the result is
     * SpliceTap's own judgement of what Chrome does.
     */
    _explainMatch(request) {
        let rule = request.rule;
        if (rule === undefined && request.ruleId !== undefined) {
            rule = typeof request.ruleId === 'string' ? this._ruleById(request.ruleId) : null;
            if (!rule) return { success: false, error: 'Rule not found' };
        }
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
            return { success: false, error: 'A rule or ruleId is required' };
        }

        const match = (rule.match && typeof rule.match === 'object') ? rule.match : {};
        const network = ruleFamily(rule) === 'network';
        const resourceTypes = Array.isArray(match.resourceTypes) ? match.resourceTypes : [];
        // A request of a type the rule targets: the one named, else the
        // rule's first, else a fetch/XHR call.
        const resourceType = (typeof request.resourceType === 'string' && request.resourceType)
            || (typeof resourceTypes[0] === 'string' ? resourceTypes[0] : 'fetch-xhr');
        const family = familyFor(rule, resourceType);

        if (request.url !== undefined && (typeof request.url !== 'string' || request.url.length > EXPLAIN_URL_MAX)) {
            return { success: false, error: `The URL must be text of at most ${EXPLAIN_URL_MAX} characters` };
        }
        const given = typeof request.url === 'string' ? request.url.trim() : '';
        const synthesized = !given;
        let example = null;
        if (synthesized) {
            example = synthesizeUrl(match.url, family);
            if (!example) {
                return {
                    success: false,
                    needsUrl: true,
                    error: RuleSchema.isRegexPattern(match.url)
                        ? 'Enter a URL to try: an example cannot be made from a regex pattern'
                        : 'Enter a URL to try',
                    url: null,
                    result: null,
                    shadowedBy: [],
                    network
                };
            }
        }

        const pageUrl = typeof request.pageUrl === 'string' ? request.pageUrl.slice(0, EXPLAIN_URL_MAX) : '';
        let forms = example;
        if (!forms) {
            // A relative URL is resolved against the page, as the page would.
            try {
                forms = { absolute: new URL(given, hostOf(pageUrl) ? pageUrl : EXPLAIN_HOST + '/').href, raw: given };
            } catch (error) {
                return { success: false, error: 'That is not a URL that can be tried' };
            }
        }
        const absolute = forms.absolute;

        let bodyText = request.body;
        if (bodyText !== undefined && bodyText !== null && typeof bodyText !== 'string') {
            try {
                bodyText = JSON.stringify(bodyText);
            } catch (error) {
                bodyText = undefined;
            }
        }
        if (typeof bodyText !== 'string') bodyText = synthesized ? synthesizedBody(match) : undefined;
        if (bodyText !== undefined && bodyText.length > EXPLAIN_BODY_MAX) {
            return { success: false, error: 'The request body is too large to try' };
        }

        const methodGiven = typeof request.method === 'string' && request.method.trim();
        const ruleMethod = String(match.method || '*').toUpperCase();
        const pageDomains = Array.isArray(match.pageDomains) ? match.pageDomains : [];
        const req = {
            method: methodGiven ? request.method.trim().toUpperCase().slice(0, 16) : (ruleMethod !== '*' ? ruleMethod : 'GET'),
            headers: (request.headers && typeof request.headers === 'object' && !Array.isArray(request.headers))
                ? request.headers
                : (synthesized ? synthesizedHeaders(match) : {}),
            bodyText,
            // The page making the request: the one named, else one the rule
            // targets, else the request's own host (a same-origin call).
            pageHost: hostOf(pageUrl)
                || (typeof pageDomains[0] === 'string' ? pageDomains[0].toLowerCase() : '')
                || hostOf(absolute),
            resourceType
        };

        let result;
        try {
            result = explainRule(rule, req, forms);
        } catch (error) {
            return { success: false, error: 'This rule could not be tried: ' + String((error && error.message) || error) };
        }

        const stored = this.rules || [];
        const ownIndex = typeof rule.id === 'string' ? stored.findIndex((r) => r && r.id === rule.id) : -1;
        const earlier = ownIndex === -1 ? stored : stored.slice(0, ownIndex);
        const shadowedBy = [];
        // Chrome applies every matching modifyHeaders rule on top of whatever
        // else wins, so a headers rule neither hides nor is hidden by another
        // network rule; reporting it would put false "Shadowed by" chips in
        // the popup. Query transforms and all-request block/redirect do
        // compete — only one of those actions applies to a request.
        const combines = (r) => r && r.type === 'headers';
        for (const other of earlier) {
            if (!family || !other || other.enabled !== true || other.id === rule.id || familyFor(other, resourceType) !== family) continue;
            if (family === 'network' && (combines(rule) || combines(other))) continue;
            let hit = false;
            try {
                hit = !!explainRule(other, req, forms).matches;
            } catch (error) {
                hit = false; // a malformed stored rule matches nothing
            }
            if (hit) shadowedBy.push({ ruleId: other.id, ruleName: other.name });
        }

        return { success: true, url: absolute, result, shadowedBy, network };
    }

    /**
     * PER-63: saveEditorDraft {draft} / getEditorDraft / clearEditorDraft.
     *
     * A content script's draft is keyed by the tab it runs in — never by a
     * tab id it names, so a page cannot read or overwrite another tab's
     * draft. Extension pages name the tab explicitly (`tabId`), or 'options'.
     * Drafts live in chrome.storage.session under spliceTapDrafts — gone
     * when the browser closes, not readable from content scripts — each at
     * most DRAFT_MAX_BYTES and DRAFT_TTL_MS old.
     */
    async _editorDraft(request, sender) {
        let key;
        if (this._isContentScript(sender)) {
            if (!sender || !sender.tab || typeof sender.tab.id !== 'number') {
                return { success: false, error: 'Drafts need a tab' };
            }
            key = String(sender.tab.id);
        } else if (request.tabId === 'options') {
            key = 'options';
        } else if (Number.isInteger(request.tabId) && request.tabId >= 0) {
            key = String(request.tabId);
        } else {
            return { success: false, error: 'tabId must be a tab id or "options"' };
        }

        if (request.type === 'getEditorDraft') {
            let found = null;
            await this._updateDrafts((drafts) => { found = drafts[key] || null; });
            return { success: true, draft: found ? found.draft : null, savedAt: found ? found.ts : null };
        }

        if (request.type === 'clearEditorDraft') {
            await this._updateDrafts((drafts) => { delete drafts[key]; });
            return { success: true };
        }

        const draft = request.draft;
        if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
            return { success: false, error: 'The draft must be an object' };
        }
        let size;
        try {
            size = new TextEncoder().encode(JSON.stringify(draft)).length;
        } catch (error) {
            return { success: false, error: 'The draft cannot be stored' };
        }
        if (size > DRAFT_MAX_BYTES) {
            return { success: false, error: `The draft is too large to keep (over ${DRAFT_MAX_BYTES / 1024} KB)` };
        }
        const ts = Date.now();
        await this._updateDrafts((drafts) => {
            drafts[key] = { draft, ts };
            // Past the count, the least recently saved go (tab-id keys are
            // integer-like, so key order says nothing about age).
            const byAge = Object.keys(drafts).sort((a, b) => drafts[a].ts - drafts[b].ts || (a === key) - (b === key));
            for (const old of byAge.slice(0, Math.max(0, byAge.length - DRAFTS_MAX))) delete drafts[old];
        });
        return { success: true, savedAt: ts };
    }

    /**
     * PER-63: read-modify-write the drafts map, one at a time, dropping
     * expired drafts on the way. `change` edits the map in place.
     */
    _updateDrafts(change) {
        const run = (this._draftChain || Promise.resolve()).then(async () => {
            let stored = {};
            try {
                stored = (await chrome.storage.session.get(DRAFTS_KEY))[DRAFTS_KEY] || {};
            } catch (error) {
                stored = this._draftsFallback || {};
            }
            const now = Date.now();
            const drafts = {};
            for (const [key, entry] of Object.entries(stored)) {
                if (entry && typeof entry.ts === 'number' && now - entry.ts < DRAFT_TTL_MS && entry.ts <= now) drafts[key] = entry;
            }
            const before = JSON.stringify(stored);
            change(drafts);
            if (JSON.stringify(drafts) === before) return;
            this._draftsFallback = drafts;
            try {
                await chrome.storage.session.set({ [DRAFTS_KEY]: drafts });
            } catch (error) {
                // Kept in memory for this worker's lifetime instead.
            }
        });
        this._draftChain = run.catch(() => undefined);
        return run;
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
            rule && rule.enabled && INTERCEPTOR_TYPES.has(rule.type || 'mock') && !networkOnly(rule));
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
        // badge needs to be refreshed from — and (F2) the network observer's
        // candidate lists.
        this.updateBadge();
        this._refreshNetworkObserver();
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
                    // PER-67: it opens a blank editor prefilled with this
                    // site's host; "Mock this request" promised a request it
                    // never had.
                    title: "New SpliceTap rule for this site…",
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
            // PER-63: a closed tab's draft can never be restored.
            this._updateDrafts((drafts) => { delete drafts[String(tabId)]; }).catch(() => undefined);
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

    /**
     * F2: header, query-param and all-request rules run inside Chrome (DNR),
     * which reports nothing back, so they never reached the log (PER-54).
     * With the optional webRequest permission and the observeNetworkRules
     * setting, non-blocking listeners match each request against those rules
     * independently and log the ones Chrome applied. They only observe:
     * nothing waits on them, and they never read storage.
     *
     * The listeners are attached here, in the first turn, whenever the
     * permission is held, so the event that woke the worker is not lost; it
     * is queued until the rules have loaded, and the listeners are detached
     * then if the setting is off.
     */
    setupNetworkObserver() {
        const permissions = chrome.permissions;
        if (permissions && permissions.onAdded && permissions.onRemoved) {
            const refresh = () => this.ready.then(() => this._refreshNetworkObserver());
            permissions.onAdded.addListener(refresh);
            permissions.onRemoved.addListener(refresh);
        }
        if (chrome.webRequest) {
            for (const phase of OBSERVER_PHASES) this._setObserverListener(phase, true);
        }
    }

    _setObserverListener(phase, on) {
        const api = chrome.webRequest;
        const event = api && api[OBSERVER_EVENTS[phase]];
        if (!event) return;
        const handler = this._observerHandlers[phase];
        const attached = event.hasListener(handler);
        if (on && !attached) event.addListener(handler, { urls: ['<all_urls>'] });
        else if (!on && attached) event.removeListener(handler);
    }

    /**
     * F2: rebuild each listener's candidate list and attach only the
     * listeners that have candidates. Called from broadcastState (every rule,
     * settings and on/off change) and on permission changes.
     *
     * A candidate is a rule as Chrome holds it: compiled by ruleToDnr, so the
     * resource types and methods are exactly the DNR rule's, and skipped when
     * Chrome refused it (this.dnrRejected).
     */
    _refreshNetworkObserver() {
        const candidates = { beforeRequest: [], sendHeaders: [], headersReceived: [] };
        const queryRedirects = [];
        const on = !!chrome.webRequest && this.isActive
            && !!this.settings && this.settings.observeNetworkRules === true;

        if (on) {
            const rejected = this.dnrRejected || new Map();
            (this.rules || []).forEach((rule, index) => {
                if (!rule || !rule.enabled || rejected.has(rule.id)) return;
                const compiled = ruleToDnr(rule, index);
                if (!compiled) return;
                const { condition, action } = compiled;
                const candidate = {
                    rule,
                    pattern: rule.match && rule.match.url,
                    types: new Set(condition.resourceTypes),
                    methods: condition.requestMethods ? new Set(condition.requestMethods) : null,
                    // B2-F7: the DNR rule's initiatorDomains (match.pageDomains).
                    domains: condition.initiatorDomains || null,
                    // A query-param rule's transform (queryTransform, or
                    // B2-F9's whole-query replacement).
                    transform: action.redirect && action.redirect.transform ? action.redirect.transform : null
                };
                if (rule.type === 'headers') {
                    if (action.requestHeaders) candidates.sendHeaders.push(candidate);
                    if (action.responseHeaders) candidates.headersReceived.push(candidate);
                } else if (isNetworkRule(rule)) {
                    candidates.beforeRequest.push(candidate);
                } else {
                    queryRedirects.push(candidate);
                }
            });
            // Network rules (priority 100000 - index) outrank every
            // query-param redirect (priority 1), wherever they sit in the list.
            candidates.beforeRequest.push(...queryRedirects);
        }

        this._observerCandidates = candidates;
        // While the stored state is still loading, stay attached to queue.
        if (this._observerPending) return;
        try {
            for (const phase of OBSERVER_PHASES) {
                this._setObserverListener(phase, candidates[phase].length > 0);
            }
        } catch (error) {
            // The log is a view; never let it fail a rule or settings change.
            console.error('SpliceTap: could not update the network observer:', error);
        }
    }

    /** Replay what arrived before the rules loaded, then settle the listeners. */
    _drainObserverPending() {
        const pending = this._observerPending || [];
        this._observerPending = null;
        // `ready` must resolve whatever happens here: every handler awaits it.
        try {
            this._refreshNetworkObserver();
            for (const [phase, details] of pending) this._observeRequest(phase, details);
        } catch (error) {
            console.error('SpliceTap: could not replay network events:', error);
        }
    }

    _observeRequest(phase, details) {
        if (this._observerPending) {
            if (this._observerPending.length < OBSERVER_PENDING_MAX) this._observerPending.push([phase, details]);
            return;
        }
        const candidates = this._observerCandidates[phase];
        if (!candidates || candidates.length === 0 || !details) return;

        const url = details.url;
        const method = String(details.method || '').toLowerCase();
        let logged = 0;
        for (const candidate of candidates) {
            if (!candidate.types.has(details.type)) continue;
            if (candidate.methods && !candidate.methods.has(method)) continue;
            if (candidate.domains && !initiatorInDomains(details.initiator, candidate.domains)) continue;
            if (!observedUrlMatches(url, candidate.pattern)) continue;
            // Chrome skips a query transform that would not change the URL —
            // including on the request it just redirected.
            if (candidate.transform && !queryTransformChanges(url, candidate.transform)) continue;

            if (this._markObserved(details.requestId, candidate.rule.id) && this._logObserved(candidate.rule, phase, details)) {
                logged++;
            }
            // Only one block or redirect applies to a request: the highest
            // priority, i.e. the first network rule, else a query-param
            // redirect. Every matching headers rule applies.
            if (phase === 'beforeRequest') break;
        }
        if (logged > 0) this._persistVolatile().catch(() => undefined);
    }

    /** True the first time this rule is seen for this request. */
    _markObserved(requestId, ruleId) {
        const key = String(requestId);
        let ruleIds = this._observerSeen.get(key);
        if (!ruleIds) {
            ruleIds = new Set();
            this._observerSeen.set(key, ruleIds);
            if (this._observerSeen.size > OBSERVER_SEEN_MAX) {
                this._observerSeen.delete(this._observerSeen.keys().next().value);
            }
        }
        if (ruleIds.has(ruleId)) return false;
        ruleIds.add(ruleId);
        return true;
    }

    /** One hit, through the same path (and checks) as the interceptor's. */
    _logObserved(rule, phase, details) {
        const entry = {
            ts: Date.now(),
            kind: 'rule',
            ruleId: rule.id,
            ruleName: rule.name,
            ruleType: rule.type,
            method: String(details.method || 'GET').toUpperCase(),
            url: redactUrl(details.url),
            note: OBSERVED_NOTE
        };
        if (phase === 'headersReceived' && Number.isInteger(details.statusCode)) {
            entry.finalStatus = details.statusCode;
        }
        const sender = (typeof details.tabId === 'number' && details.tabId >= 0) ? { tab: { id: details.tabId } } : null;
        return this._recordLogEntry(entry, sender);
    }
}

/**
 * F2: does a URL Chrome reports match a rule's pattern, as the DNR condition
 * does? matchUrl compares the absolute URL; a wildcard pattern starting with
 * '/' is matched from the path (and '//' from after the scheme), as the DNR
 * condition anchors it (PER-21) and the interceptor matches a relative URL.
 */
function observedUrlMatches(url, pattern) {
    return networkUrlForm(url, pattern) !== null;
}

/**
 * The form of `url` a network rule's pattern matches, as the DNR condition
 * judges it — the URL itself, or for a wildcard pattern starting with '/' its
 * path ('//': from after the scheme) — or null when it does not match.
 */
function networkUrlForm(url, pattern) {
    if (typeof url !== 'string' || !pattern) return null;
    if (matchUrl(url, pattern)) return url;
    if (pattern[0] !== '/' || RuleSchema.isRegexPattern(pattern) || pattern.indexOf('*') === -1) return null;
    const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(url);
    if (!scheme) return null;
    const afterScheme = url.slice(scheme[0].length);
    const form = pattern.startsWith('//') ? afterScheme : afterScheme.replace(/^\/\/[^/?#]*/, '');
    return matchUrl(form, pattern) ? form : null;
}

// ---- B2-F10: explainMatch -----------------------------------------------------

const PAGE_FAMILY_TYPES = new Set(['mock', 'block', 'delay', 'redirect']);

/**
 * B2-F10: which rules can shadow which. 'page': the interceptor's
 * first-match (mock/block/delay/redirect); 'requestBody': its own pass;
 * 'network': what Chrome applies (headers, queryparams, all-request
 * redirect/block). null for a type SpliceTap does not know.
 */
function ruleFamily(rule) {
    const type = (rule && rule.type) || 'mock';
    if (type === 'requestBody') return 'requestBody';
    if (type === 'headers' || type === 'queryparams' || isNetworkRule(rule)) return 'network';
    return PAGE_FAMILY_TYPES.has(type) ? 'page' : null;
}

/**
 * The family a rule competes in for a request of this resource type. An
 * all-request redirect/block is a network rule, except for a fetch/XHR call
 * the interceptor runs it for: there it is in the page's first-match, where
 * an earlier mock wins over it and it wins over a later one.
 */
function familyFor(rule, resourceType) {
    const family = ruleFamily(rule);
    if (family === 'network' && resourceType === 'fetch-xhr' && isNetworkRule(rule) && !networkOnly(rule)) return 'page';
    return family;
}

/**
 * The form of the tried URL a rule's pattern is judged on: the interceptor
 * tries the absolute URL and the URL as the page wrote it (PER-8); Chrome
 * judges the absolute URL, a '/'-wildcard from the path (PER-21). The
 * absolute URL when no form matches, so the url check says so.
 */
function urlFormFor(rule, forms, family) {
    const pattern = rule.match && rule.match.url;
    if (family === 'network') return networkUrlForm(forms.absolute, pattern) || forms.absolute;
    if (matchUrl(forms.absolute, pattern)) return forms.absolute;
    if (forms.raw && forms.raw !== forms.absolute && matchUrl(forms.raw, pattern)) return forms.raw;
    return forms.absolute;
}

/**
 * One rule against one request: { matches, checks }. Uses the matcher's
 * explainRuleMatch (B2-F10, src/matcher.js) when it exists; until then, a
 * url and method check built here.
 */
function explainRule(rule, req, forms) {
    const full = { ...req, url: urlFormFor(rule, forms, familyFor(rule, req.resourceType)) };
    const matcher = globalThis.SpliceTapMatcher;
    if (matcher && typeof matcher.explainRuleMatch === 'function') {
        return matcher.explainRuleMatch(rule, full);
    }
    const match = rule.match || {};
    const urlOk = matchUrl(full.url, match.url);
    const ruleMethod = String(match.method || '*').toUpperCase();
    const methodOk = ruleMethod === '*' || ruleMethod === String(full.method || '').toUpperCase();
    const checks = [
        {
            condition: 'url',
            ok: urlOk,
            detail: urlOk ? `The URL matches "${match.url}".` : `The URL does not match "${match.url}".`
        },
        {
            condition: 'method',
            ok: methodOk,
            detail: ruleMethod === '*'
                ? 'Any method matches.'
                : (methodOk ? `The method is ${ruleMethod}.` : `The rule needs ${ruleMethod}, not ${full.method}.`)
        }
    ];
    return { matches: urlOk && methodOk, checks };
}

/**
 * B2-F10: an example request URL for a wildcard or substring pattern, as
 * { absolute, raw } (raw: the URL as a page would write it). Each * becomes
 * x, with https://example.test in front when there is no scheme. A pattern
 * starting with '/' is a call the page makes to its own origin ('/api/x'),
 * and one starting with '//' a scheme-relative call (https:). '*://host/*'
 * is tried as https://host/x, whose scheme the rule matches. null for a
 * regex pattern, which has no example.
 */
function synthesizeUrl(pattern, family) {
    if (typeof pattern !== 'string' || !pattern.trim() || RuleSchema.isRegexPattern(pattern)) return null;
    const trimmed = pattern.trim();
    const filled = trimmed.replace(/\*/g, 'x');
    const parse = (u) => {
        try {
            return new URL(u).href;
        } catch (error) {
            return null;
        }
    };

    if (filled.startsWith('/')) {
        const absolute = parse(filled.startsWith('//') ? 'https:' + filled : EXPLAIN_HOST + filled);
        return absolute ? { absolute, raw: filled } : null;
    }

    const candidates = [];
    if (trimmed.startsWith('*://')) candidates.push('https://' + filled.slice(4));
    candidates.push(/^[a-z][a-z0-9+.-]*:/i.test(filled) ? filled : EXPLAIN_HOST + filled);
    let first = null;
    for (const candidate of candidates) {
        const absolute = parse(candidate);
        if (!absolute) continue;
        const forms = { absolute, raw: candidate };
        if (!first) first = forms;
        const hit = family === 'network'
            ? networkUrlForm(absolute, trimmed) !== null
            : matchUrl(absolute, trimmed) || matchUrl(candidate, trimmed);
        if (hit) return forms;
    }
    return first;
}

/** B2-F10: the rule's own header conditions, as a request that meets them. */
function synthesizedHeaders(match) {
    const headers = {};
    if (match.headers && typeof match.headers === 'object' && !Array.isArray(match.headers)) {
        for (const [name, value] of Object.entries(match.headers)) {
            if (typeof value === 'string') headers[name] = value;
        }
    }
    return headers;
}

/**
 * B2-F10: a JSON body meeting the rule's GraphQL operation and payload
 * filter (a dot path holding the value), or undefined when it has neither.
 */
function synthesizedBody(match) {
    const body = {};
    let any = false;
    if (match.graphql && typeof match.graphql.operationName === 'string' && match.graphql.operationName) {
        body.operationName = match.graphql.operationName;
        any = true;
    }
    const payload = match.payload;
    if (payload && typeof payload.path === 'string' && payload.path && typeof payload.value === 'string') {
        const keys = payload.path.split('.');
        let at = body;
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') return any ? JSON.stringify(body) : undefined;
            if (!at[key] || typeof at[key] !== 'object') at[key] = {};
            at = at[key];
        }
        const last = keys[keys.length - 1];
        if (last !== '__proto__' && last !== 'constructor' && last !== 'prototype') {
            at[last] = payload.value;
            any = true;
        }
    }
    return any ? JSON.stringify(body) : undefined;
}

/**
 * B2-F7: an appliesTo:'all' rule whose resource types leave out 'fetch-xhr'
 * is Chrome's alone — the interceptor has nothing to do with it, so it is not
 * sent to tabs (PER-34).
 */
function networkOnly(rule) {
    const types = rule.match && rule.match.resourceTypes;
    return isNetworkRule(rule) && Array.isArray(types) && !types.includes('fetch-xhr');
}

/**
 * B2-F7: is the request's initiator (an origin, as webRequest reports it) on
 * one of these domains or a subdomain, as DNR's initiatorDomains judges it?
 * No initiator (a navigation from the address bar) or an opaque one never is.
 */
function initiatorInDomains(initiator, domains) {
    const host = hostOf(initiator);
    if (!host) return false;
    return domains.some((domain) => host === domain || host.endsWith('.' + domain));
}

/** Lowercase hostname of a URL or origin, or '' when it has none. */
function hostOf(url) {
    if (typeof url !== 'string' || !url || url === 'null') return '';
    try {
        return new URL(url).hostname.toLowerCase();
    } catch (error) {
        return '';
    }
}

/** F2: would Chrome's queryTransform (B2-F9: or query replacement) change this URL? */
function queryTransformChanges(url, transform) {
    if (typeof transform.query === 'string') {
        // B2-F9: removeAll. The query as the URL spells it, '?' included.
        const noFragment = String(url).split('#')[0];
        const at = noFragment.indexOf('?');
        return (at === -1 ? '' : noFragment.slice(at)) !== transform.query;
    }
    const queryTransform = transform.queryTransform || {};
    let params;
    try {
        params = new URL(url).searchParams;
    } catch (error) {
        return true;
    }
    for (const key of queryTransform.removeParams || []) {
        if (params.has(key)) return true;
    }
    for (const param of queryTransform.addOrReplaceParams || []) {
        if (params.get(param.key) !== param.value) return true;
    }
    return false;
}

// Initialize
const backgroundService = new SpliceTapBackground();

// Export for testing if needed
export default backgroundService;