/**
 * SpliceTap Options Page Script
 * Handles settings, data management, and configuration
 * 
 * FIXED: Race conditions, validation, cleanup, duplicate code
 */

// Constants at top of file
const MODAL_OPEN_DELAY = 200;
// CQ-10: one definition of the rule-schema limits, in src/common.js.
const LIMITS = globalThis.SpliceTapCommon.LIMITS;
const MAX_NAME_LENGTH = LIMITS.NAME_MAX;
const MAX_URL_LENGTH = LIMITS.URL_MAX;
const MIN_STATUS_CODE = LIMITS.STATUS_MIN;
const MAX_STATUS_CODE = LIMITS.STATUS_MAX;
const MIN_DELAY = LIMITS.DELAY_MIN;
const MAX_DELAY = LIMITS.DELAY_MAX;
const MIN_DELAY_MS = LIMITS.DELAY_MS_MIN;
const MAX_DELAY_MS = LIMITS.DELAY_MS_MAX;
const PREFILL_MAX_AGE_MS = 30000;

// Tab -> page title map (U-7: the top-bar heading never updated on tab switch).
// 'general' was retired when theme / debug / chaos moved into the popup's
// Settings tab; Rules is now the default landing tab.
const TAB_TITLES = {
    rules: 'Rules Management',
    advanced: 'Advanced Configuration'
};

/**
 * Q-10/S-2: options.js is a classic (non-module) script, but the shared
 * `SpliceTapUtils.validateUrlPattern` lives in src/utils.js, an ES module
 * (`export class SpliceTapUtils`). Rather than reimplementing pattern
 * validation here, lazily dynamic-import the real module and cache the
 * promise - dynamic `import()` is valid inside a classic script (unlike a
 * static `import` declaration, which would require `type="module"`).
 */
// UX-1: options.html hard-codes class="theme-dark" and applyTheme() only runs
// after loadData()'s async round-trip, so a light-theme user got a dark flash
// on every open. popup.js fixed this for itself and its own comment named
// options.html as having the same bug; the fix was never ported. Apply the
// last resolved theme synchronously, before any await.
(function applyCachedThemeEarly() {
    try {
        const cached = window.localStorage.getItem('tm-theme');
        // This script is the last element in <body>, so document.body already
        // exists and the swap happens before first paint — no DOMContentLoaded
        // wait, which would land after the dark frame the user would see.
        if ((cached === 'dark' || cached === 'light') && document.body) {
            document.body.classList.remove('theme-dark', 'theme-light');
            document.body.classList.add(`theme-${cached}`);
        }
    } catch (error) {
        // localStorage unavailable — applyTheme() still runs once data loads.
    }
})();

let _spliceTapUtilsPromise = null;
function getSpliceTapUtils() {
    if (!_spliceTapUtilsPromise) {
        _spliceTapUtilsPromise = import(chrome.runtime.getURL('src/utils.js'))
            .then(mod => mod.SpliceTapUtils);
    }
    return _spliceTapUtilsPromise;
}

class OptionsManager {
    constructor() {
        this.settings = {};
        this.shortcuts = {};
        this.rules = [];
        this.listeners = []; // Track listeners for cleanup

        // U-4: dirty-tracking for the rule editor, the longest form in the
        // product. Set true by genuine user edits (see setupEventListeners'
        // #ruleForm input/change listener) and reset whenever the form is
        // freshly populated or successfully saved.
        this.ruleFormDirty = false;

        // A-4: remembers what had focus before a modal opened, so it can be
        // restored on close.
        this._lastFocusedBeforeModal = null;

        this.init();
    }

    async init() {
        try {
            this.setupEventListeners();
            await this.loadData();
            this.updateUI();
            this.initThemeSystem(); // Single theme initialization
            this.loadStatistics();
            this.enableAutoSave();
            this.setupKeyboardShortcuts();
            this.startPerformanceMonitoring();

            const prefilled = await this.checkPrefill();
            if (!prefilled) {
                this.checkUrlParams();
            }

            console.log('SpliceTap options page initialized');
        } catch (error) {
            console.error('Failed to initialize options page:', error);
            this.showMessage('Failed to load options page', 'error');
        }
    }

    /**
     * G5.4: Prefill the rule editor from a context-menu-triggered request.
     * background.js writes { spliceTapPrefill: { url, ts } } before opening this page.
     * Returns true if a prefill was found (and handled), false otherwise.
     */
    async checkPrefill() {
        try {
            const result = await chrome.storage.local.get(['spliceTapPrefill']);
            const prefill = result.spliceTapPrefill;

            if (!prefill || typeof prefill.ts !== 'number' || !prefill.url) {
                return false;
            }

            if (Date.now() - prefill.ts > PREFILL_MAX_AGE_MS) {
                await chrome.storage.local.remove('spliceTapPrefill');
                return false;
            }

            await chrome.storage.local.remove('spliceTapPrefill');

            this.switchTab('rules');

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        this.openRuleEditor();
                        const typeEl = document.getElementById('ruleType');
                        if (typeEl) {
                            typeEl.value = 'mock';
                            this.updateRuleTypeVisibility('mock');
                        }
                        const urlEl = document.getElementById('ruleUrl');
                        if (urlEl) urlEl.value = prefill.url;
                    }, MODAL_OPEN_DELAY);
                });
            });

            return true;
        } catch (error) {
            console.error('Failed to check rule prefill:', error);
            return false;
        }
    }

    /**
     * FIXED: Race condition with modal opening
     */
    checkUrlParams() {
        const urlParams = new URLSearchParams(window.location.search);
        const action = urlParams.get('action');
        const editRuleId = urlParams.get('editRule');

        if (action === 'new') {
            // Switch tab first
            this.switchTab('rules');
            
            // Wait for tab switch animation AND DOM paint
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        this.openRuleEditor();
                    }, MODAL_OPEN_DELAY);
                });
            });
        } else if (editRuleId) {
            this.switchTab('rules');
            
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        const rule = this.rules.find(r => r.id === editRuleId);
                        if (rule) {
                            this.openRuleEditor(rule);
                        } else {
                            this.showMessage('Rule not found', 'error');
                        }
                    }, MODAL_OPEN_DELAY);
                });
            });
        }
    }

    /**
     * FIXED: Validate rule data before populating
     * G5.2: also populates the type-specific field groups per the v2 rule schema
     * and preserves dnrRuleId across edits.
     */
    openRuleEditor(rule = null) {
        const modal = document.getElementById('ruleEditorModal');
        const form = document.getElementById('ruleForm');

        if (!modal || !form) {
            console.error('Rule editor modal or form not found');
            return;
        }

        // Reset form
        form.reset();
        document.getElementById('ruleId').value = '';
        document.getElementById('ruleDnrId').value = '';
        document.getElementById('ruleType').value = 'mock';
        document.getElementById('ruleHeaders').value = '{"Content-Type": "application/json"}';
        document.getElementById('ruleStatus').value = 200;
        document.getElementById('ruleDelay').value = 0;
        document.getElementById('ruleEnabled').checked = true;
        document.getElementById('responseMode').value = 'static';
        document.getElementById('rulePatch').value = '{}';
        document.getElementById('graphqlOperation').value = '';
        document.getElementById('matchHeaders').value = '';
        document.getElementById('delayMs').value = 1000;
        document.getElementById('redirectDestination').value = '';
        document.getElementById('headersModRequest').value = '';
        document.getElementById('headersModResponse').value = '';
        document.getElementById('queryParamsAdd').value = '';
        document.getElementById('queryParamsRemove').value = '';

        // Track the rule being edited (used by save-time validation, e.g. DNR-backed match combos)
        this.currentEditingRule = rule || null;

        if (rule) {
            // Validate rule has required fields
            if (!this.validateRuleForEditing(rule)) {
                this.showMessage('Rule data is invalid or incomplete', 'error');
                return;
            }

            const type = rule.type || 'mock';

            document.getElementById('ruleEditorTitle').textContent = 'Edit Rule';
            document.getElementById('ruleId').value = rule.id || '';
            document.getElementById('ruleDnrId').value = (rule.dnrRuleId !== undefined && rule.dnrRuleId !== null)
                ? rule.dnrRuleId
                : '';
            document.getElementById('ruleType').value = type;
            document.getElementById('ruleName').value = rule.name || '';
            document.getElementById('ruleEnabled').checked = rule.enabled !== false;
            document.getElementById('ruleMethod').value = rule.match?.method || 'GET';
            document.getElementById('ruleUrl').value = rule.match?.url || '';

            if (type === 'mock') {
                const mode = rule.response?.mode || 'static';
                document.getElementById('ruleStatus').value = rule.response?.statusCode || 200;
                document.getElementById('ruleDelay').value = rule.response?.delay || 0;
                document.getElementById('responseMode').value = mode;
                document.getElementById('graphqlOperation').value = rule.match?.graphql?.operationName || '';

                if (rule.match?.headers) {
                    try {
                        document.getElementById('matchHeaders').value = JSON.stringify(rule.match.headers, null, 2);
                    } catch (e) {
                        console.error('Failed to stringify match headers:', e);
                    }
                }

                if (rule.response?.headers) {
                    try {
                        document.getElementById('ruleHeaders').value = JSON.stringify(rule.response.headers, null, 2);
                    } catch (e) {
                        console.error('Failed to stringify headers:', e);
                    }
                }

                if (rule.response?.body !== undefined) {
                    const body = rule.response.body;
                    try {
                        document.getElementById('ruleBody').value = typeof body === 'object'
                            ? JSON.stringify(body, null, 2)
                            : String(body);
                    } catch (e) {
                        console.error('Failed to stringify body:', e);
                    }
                }

                if (rule.response?.patch !== undefined) {
                    try {
                        document.getElementById('rulePatch').value = JSON.stringify(rule.response.patch, null, 2);
                    } catch (e) {
                        console.error('Failed to stringify patch:', e);
                    }
                }
            } else if (type === 'delay') {
                document.getElementById('delayMs').value = rule.delayMs || 1000;
            } else if (type === 'redirect') {
                document.getElementById('redirectDestination').value = rule.redirect?.destination || '';
            } else if (type === 'headers') {
                try {
                    document.getElementById('headersModRequest').value =
                        JSON.stringify(rule.headersMod?.request || [], null, 2);
                    document.getElementById('headersModResponse').value =
                        JSON.stringify(rule.headersMod?.response || [], null, 2);
                } catch (e) {
                    console.error('Failed to stringify headersMod:', e);
                }
            } else if (type === 'queryparams') {
                try {
                    document.getElementById('queryParamsAdd').value =
                        JSON.stringify(rule.queryParams?.add || [], null, 2);
                } catch (e) {
                    console.error('Failed to stringify queryParams.add:', e);
                }
                document.getElementById('queryParamsRemove').value = (rule.queryParams?.remove || []).join(', ');
            }

            this.updateRuleTypeVisibility(type);
        } else {
            document.getElementById('ruleEditorTitle').textContent = 'New Rule';
            this.updateRuleTypeVisibility('mock');
        }

        // U-4: the form was just populated programmatically (not by the
        // user), so it isn't dirty yet. Reset after populate, since
        // programmatic `.value =` assignment doesn't fire input/change.
        this.ruleFormDirty = false;

        this.openModal(modal);
    }

    /**
     * G5.2: toggle the type-specific field groups based on the selected rule type.
     */
    updateRuleTypeVisibility(type) {
        document.querySelectorAll('[data-rule-types]').forEach(el => {
            const types = (el.dataset.ruleTypes || '').split(' ').filter(Boolean);
            el.style.display = types.includes(type) ? '' : 'none';
        });

        if (type === 'mock') {
            const modeEl = document.getElementById('responseMode');
            this.updateResponseModeVisibility(modeEl ? modeEl.value : 'static');
        }
    }

    /**
     * G5.1: within the mock type, static vs patch mode hide/show body & status.
     */
    updateResponseModeVisibility(mode) {
        const isPatch = mode === 'patch';
        const staticBodyGroup = document.getElementById('staticBodyGroup');
        const patchBodyGroup = document.getElementById('patchBodyGroup');
        const statusGroup = document.getElementById('ruleStatusGroup');

        if (staticBodyGroup) staticBodyGroup.style.display = isPatch ? 'none' : '';
        if (patchBodyGroup) patchBodyGroup.style.display = isPatch ? '' : 'none';
        if (statusGroup) statusGroup.style.display = isPatch ? 'none' : '';
    }

    /**
     * G5.2/G5.3: Comprehensive input validation and v2 schema construction.
     * Builds the appropriate rule shape per rule.type from only the visible fields,
     * and enforces the type-specific restrictions for DNR-backed rule types.
     */
    async saveRuleFromEditor() {
        const id = document.getElementById('ruleId').value;
        const dnrIdStr = document.getElementById('ruleDnrId').value;
        const type = document.getElementById('ruleType').value || 'mock';
        const name = document.getElementById('ruleName').value.trim();
        const enabled = document.getElementById('ruleEnabled').checked;
        const method = document.getElementById('ruleMethod').value;
        const url = document.getElementById('ruleUrl').value.trim();

        // Validate name
        if (!name) {
            this.showMessage('Name is required', 'error');
            document.getElementById('ruleName').focus();
            return;
        }

        if (name.length > MAX_NAME_LENGTH) {
            this.showMessage(`Name must be ${MAX_NAME_LENGTH} characters or less`, 'error');
            document.getElementById('ruleName').focus();
            return;
        }

        // Validate URL
        if (!url) {
            this.showMessage('URL Pattern is required', 'error');
            document.getElementById('ruleUrl').focus();
            return;
        }

        if (url.length > MAX_URL_LENGTH) {
            this.showMessage(`URL must be ${MAX_URL_LENGTH} characters or less`, 'error');
            document.getElementById('ruleUrl').focus();
            return;
        }

        // Q-10: `/` (and `//`) previously saved as a "regex" whose body is the
        // empty string, which matches every request on every site
        // (`new RegExp('', 'i').test(x) === true`). validateUrlPattern already
        // rejects that - it just wasn't being called from either save path.
        const SpliceTapUtils = await getSpliceTapUtils();
        const urlValidation = SpliceTapUtils.validateUrlPattern(url);
        if (!urlValidation.isValid) {
            this.showMessage(`Invalid URL pattern: ${urlValidation.error}`, 'error');
            document.getElementById('ruleUrl').focus();
            return;
        }

        const match = { method, url };
        const extra = {};

        // redirect/headers/queryparams (DNR-backed) rules cannot express
        // match.headers or match.graphql. The form never lets a user set those fields
        // for these types, but a rule loaded for editing may already carry them (e.g.
        // it was a 'mock' rule before the type was switched, or it was imported) -
        // reject the save rather than silently dropping the conditions.
        const originalRule = this.currentEditingRule;
        const hasForbiddenMatch = !!(originalRule && originalRule.match && (
            (originalRule.match.headers && Object.keys(originalRule.match.headers).length > 0) ||
            (originalRule.match.graphql && originalRule.match.graphql.operationName)
        ));

        if (type === 'mock') {
            const statusStr = document.getElementById('ruleStatus').value;
            const delayStr = document.getElementById('ruleDelay').value;
            const headersStr = document.getElementById('ruleHeaders').value.trim();
            const bodyStr = document.getElementById('ruleBody').value;
            const mode = document.getElementById('responseMode').value || 'static';
            const patchStr = document.getElementById('rulePatch').value;
            const graphqlOperation = document.getElementById('graphqlOperation').value.trim();
            const matchHeadersStr = document.getElementById('matchHeaders').value.trim();

            // Validate delay (applies in both static and patch mode)
            const delay = parseInt(delayStr, 10);
            if (isNaN(delay) || delay < MIN_DELAY || delay > MAX_DELAY) {
                this.showMessage(`Delay must be between ${MIN_DELAY} and ${MAX_DELAY} ms`, 'error');
                document.getElementById('ruleDelay').focus();
                return;
            }

            // Validate status code (only meaningful in static mode; patch mode keeps the real status)
            let status = 200;
            if (mode !== 'patch') {
                status = parseInt(statusStr, 10);
                if (isNaN(status) || status < MIN_STATUS_CODE || status > MAX_STATUS_CODE) {
                    this.showMessage(`Status code must be between ${MIN_STATUS_CODE} and ${MAX_STATUS_CODE}`, 'error');
                    document.getElementById('ruleStatus').focus();
                    return;
                }
            }

            // Validate response headers JSON
            let headers = {};
            if (headersStr) {
                try {
                    headers = JSON.parse(headersStr);
                    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
                        throw new Error('Headers must be a JSON object');
                    }
                } catch (e) {
                    this.showMessage('Invalid Response Headers JSON: ' + e.message, 'error');
                    document.getElementById('ruleHeaders').focus();
                    return;
                }
            }

            // Validate match headers JSON (optional)
            let matchHeaders = null;
            if (matchHeadersStr) {
                try {
                    matchHeaders = JSON.parse(matchHeadersStr);
                    if (typeof matchHeaders !== 'object' || matchHeaders === null || Array.isArray(matchHeaders)) {
                        throw new Error('Match headers must be a JSON object');
                    }
                } catch (e) {
                    this.showMessage('Invalid Match Request Headers JSON: ' + e.message, 'error');
                    document.getElementById('matchHeaders').focus();
                    return;
                }
            }

            // G5.3: mock+graphql requires method POST or '*'
            if (graphqlOperation && method !== 'POST' && method !== '*') {
                this.showMessage('GraphQL operation matching requires Method to be POST or Any (*)', 'error');
                document.getElementById('ruleMethod').focus();
                return;
            }

            if (matchHeaders && Object.keys(matchHeaders).length > 0) {
                match.headers = matchHeaders;
            }
            if (graphqlOperation) {
                match.graphql = { operationName: graphqlOperation };
            }

            const response = {
                statusCode: status,
                statusText: this.getStatusText(status),
                delay,
                headers,
                mode
            };

            if (mode === 'patch') {
                let patch;
                try {
                    patch = patchStr.trim() ? JSON.parse(patchStr) : {};
                } catch (e) {
                    this.showMessage('Invalid Response Patch JSON: ' + e.message, 'error');
                    document.getElementById('rulePatch').focus();
                    return;
                }
                response.patch = patch;
            } else {
                // Parse body (can be JSON or plain text)
                let body = bodyStr;
                if (bodyStr.trim()) {
                    try {
                        if (bodyStr.trim().startsWith('{') || bodyStr.trim().startsWith('[')) {
                            body = JSON.parse(bodyStr);
                        }
                    } catch (e) {
                        // Keep as string if not valid JSON - that's okay
                        console.log('Body is not JSON, keeping as string');
                    }
                }
                response.body = body;
            }

            extra.response = response;

        } else if (type === 'block') {
            // No extra fields - match alone is sufficient.

        } else if (type === 'delay') {
            const delayMsStr = document.getElementById('delayMs').value;
            const delayMs = parseInt(delayMsStr, 10);
            if (isNaN(delayMs) || delayMs < MIN_DELAY_MS || delayMs > MAX_DELAY_MS) {
                this.showMessage(`Delay (ms) must be between ${MIN_DELAY_MS} and ${MAX_DELAY_MS}`, 'error');
                document.getElementById('delayMs').focus();
                return;
            }
            extra.delayMs = delayMs;

        } else if (type === 'redirect') {
            const destination = document.getElementById('redirectDestination').value.trim();
            if (!destination) {
                this.showMessage('Redirect destination is required', 'error');
                document.getElementById('redirectDestination').focus();
                return;
            }
            if (hasForbiddenMatch) {
                this.showMessage(
                    // CQ-4: the old wording blamed declarativeNetRequest, which
                    // does not handle redirect rules at all. The real reason is
                    // that XHR must pick the redirect target in open(), before
                    // any request header has been set.
                    'Redirect rules cannot specify header or GraphQL match conditions, because the redirect target is chosen before request headers exist. Recreate this rule without those conditions.',
                    'error'
                );
                return;
            }
            extra.redirect = { destination };

        } else if (type === 'headers') {
            const reqStr = document.getElementById('headersModRequest').value.trim();
            const resStr = document.getElementById('headersModResponse').value.trim();

            let requestOps = [];
            let responseOps = [];
            try {
                requestOps = reqStr ? JSON.parse(reqStr) : [];
                if (!Array.isArray(requestOps)) throw new Error('Request headers must be a JSON array');
            } catch (e) {
                this.showMessage('Invalid Request Headers JSON: ' + e.message, 'error');
                document.getElementById('headersModRequest').focus();
                return;
            }
            try {
                responseOps = resStr ? JSON.parse(resStr) : [];
                if (!Array.isArray(responseOps)) throw new Error('Response headers must be a JSON array');
            } catch (e) {
                this.showMessage('Invalid Response Headers JSON: ' + e.message, 'error');
                document.getElementById('headersModResponse').focus();
                return;
            }

            if (requestOps.length === 0 && responseOps.length === 0) {
                this.showMessage('Modify Headers rules need at least one request or response header operation', 'error');
                return;
            }

            const opsValid = (arr) => arr.every(o => o && (o.op === 'set' || o.op === 'remove')
                && typeof o.name === 'string' && o.name.trim().length > 0);
            if (!opsValid(requestOps) || !opsValid(responseOps)) {
                this.showMessage('Each header operation needs an "op" ("set" or "remove") and a "name"', 'error');
                return;
            }

            if (hasForbiddenMatch) {
                this.showMessage(
                    'Modify Headers rules cannot specify header or GraphQL match conditions (declarativeNetRequest cannot express them). Recreate this rule without those conditions.',
                    'error'
                );
                return;
            }

            extra.headersMod = { request: requestOps, response: responseOps };

        } else if (type === 'queryparams') {
            const addStr = document.getElementById('queryParamsAdd').value.trim();
            const removeStr = document.getElementById('queryParamsRemove').value.trim();

            let addOps = [];
            try {
                addOps = addStr ? JSON.parse(addStr) : [];
                if (!Array.isArray(addOps)) throw new Error('Add params must be a JSON array');
            } catch (e) {
                this.showMessage('Invalid Add Query Params JSON: ' + e.message, 'error');
                document.getElementById('queryParamsAdd').focus();
                return;
            }

            const removeOps = removeStr ? removeStr.split(',').map(s => s.trim()).filter(Boolean) : [];

            if (addOps.length === 0 && removeOps.length === 0) {
                this.showMessage('Query Params rules need at least one param to add or remove', 'error');
                return;
            }

            if (!addOps.every(o => o && typeof o.key === 'string' && o.key.trim().length > 0)) {
                this.showMessage('Each "add" entry needs a non-empty "key"', 'error');
                return;
            }

            if (hasForbiddenMatch) {
                this.showMessage(
                    'Query Params rules cannot specify header or GraphQL match conditions (declarativeNetRequest cannot express them). Recreate this rule without those conditions.',
                    'error'
                );
                return;
            }

            extra.queryParams = { add: addOps, remove: removeOps };
        }

        const rule = {
            id: id || this.generateId(),
            name,
            enabled,
            type,
            match,
            ...extra,
            lastModified: new Date().toISOString()
        };

        // Preserve dnrRuleId across edits - never allocated/dropped by the form itself
        // (background.js allocates one on first sync for DNR-backed types per G4.3).
        if (dnrIdStr !== '' && !isNaN(parseInt(dnrIdStr, 10))) {
            rule.dnrRuleId = parseInt(dnrIdStr, 10);
        }

        // Add created timestamp only for new rules
        if (!id) {
            rule.created = new Date().toISOString();
        }

        // CQ-Q3 (data loss): `this.rules` is only a snapshot taken when this
        // tab last loaded/refreshed. If a rule was added or edited elsewhere
        // (popup, in-page overlay, another options tab) while this tab sat
        // open, `this.rules` no longer matches storage - and the previous
        // code mutated that stale array locally, then sent the WHOLE thing
        // back via `setRules` (a full bulk replace). That silently deleted
        // anything added since this tab's snapshot was taken.
        //
        // Fix, in two parts:
        //  1. Re-fetch the CURRENT authoritative rules from the background
        //     right before persisting, instead of trusting `this.rules`.
        //  2. Persist through `saveRule` (single-rule upsert) instead of
        //     `setRules` (bulk replace). `saveRule` re-reads storage itself
        //     inside the background (src/storage.js saveRule() calls
        //     getRules() fresh, then updates only this one id) - so even if
        //     another change lands in the gap between our getRules() below
        //     and this saveRule() call, the worst case is a race on this one
        //     rule id, never a wipe of every other rule.
        let authoritativeRules = this.rules;
        try {
            const fresh = await chrome.runtime.sendMessage({ type: 'getRules' });
            if (fresh && fresh.success && Array.isArray(fresh.rules)) {
                authoritativeRules = fresh.rules;
            }
        } catch (e) {
            // Background unreachable - fall back to the local snapshot;
            // saveRule() below still upserts safely against whatever
            // storage actually holds at that moment.
        }

        // The form only manages a subset of a rule's fields. Preserve
        // whatever else storage has for this id (hit counts, test status,
        // original creation time, import provenance) - storage.saveRule()
        // replaces the stored rule with exactly what we send, so anything
        // we don't carry forward here would be silently dropped.
        const existing = authoritativeRules.find(r => r.id === rule.id);
        if (existing) {
            rule.created = existing.created || rule.created;
            if (existing.hitCount !== undefined) rule.hitCount = existing.hitCount;
            if (existing.testStatus !== undefined) rule.testStatus = existing.testStatus;
            if (existing.imported !== undefined) rule.imported = existing.imported;
        }

        try {
            // Persist through the background so it allocates dnrRuleId for
            // headers/queryparams rules, updates its in-memory rules, rebroadcasts
            // to open tabs, and re-syncs declarativeNetRequest. Writing storage
            // directly here would leave all of that stale.
            const response = await chrome.runtime.sendMessage({ type: 'saveRule', rule });
            if (!response || !response.success) {
                throw new Error((response && response.error) || 'Background did not accept the rule');
            }

            // Adopt the full authoritative list after saving (rather than the
            // pre-save snapshot) so stats - and any later edit in this same
            // tab - reflect what's actually in storage, including rules this
            // tab never knew about.
            const after = await chrome.runtime.sendMessage({ type: 'getRules' });
            if (after && after.success && Array.isArray(after.rules)) {
                this.rules = after.rules;
            } else {
                const idx = this.rules.findIndex(r => r.id === rule.id);
                const savedRule = response.rule || rule;
                if (idx >= 0) this.rules[idx] = savedRule;
                else this.rules.push(savedRule);
            }

            this.ruleFormDirty = false;
            // CQ-3: the background reports a declarativeNetRequest sync failure
            // in `dnrWarning`, and nothing used to read it — so a headers or
            // queryparams rule that never reached the network layer still
            // showed "Rule saved successfully!". The rule IS stored, so this is
            // a warning rather than an error, but it must be said out loud.
            if (response.dnrWarning) {
                this.showMessage(
                    'Rule saved, but it could not be applied to the network layer: ' + response.dnrWarning,
                    'error'
                );
            } else {
                this.showMessage('Rule saved successfully!', 'success');
            }
            this.loadStatistics();
            this.closeModal('ruleEditorModal');
        } catch (error) {
            console.error('Failed to save rule:', error);
            this.showMessage('Failed to save rule: ' + error.message, 'error');
        }
    }

    /**
     * Validate rule structure for editing. `response` is only required for type 'mock' -
     * other v2 types (block/delay/redirect/headers/queryparams) don't have one.
     */
    validateRuleForEditing(rule) {
        if (!rule || typeof rule !== 'object') return false;
        if (!rule.id) return false;
        if (!rule.match || !rule.match.url) return false;
        const type = rule.type || 'mock';
        if (type === 'mock' && !rule.response) return false;
        return true;
    }

    /**
     * G5.5: apply a named quick-start template to the rule editor form.
     */
    applyTemplate(name) {
        // PROD-3/CQ-1: template definitions live in src/templates.js so this
        // editor and the in-page overlay read one source instead of two that
        // drift. This maps the shared, schema-shaped fields onto this form.
        const tpl = (globalThis.SpliceTapTemplates && globalThis.SpliceTapTemplates.getTemplate(name)) || null;
        if (!tpl) return;

        // Header-mod entries arrive as arrays; the form holds JSON text.
        const set = (elId, value) => {
            if (value === undefined || value === null) return;
            const el = document.getElementById(elId);
            if (el) el.value = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        };

        const typeEl = document.getElementById('ruleType');
        if (typeEl) {
            typeEl.value = tpl.type;
            this.updateRuleTypeVisibility(tpl.type);
        }

        set('ruleMethod', tpl.method);
        set('ruleUrl', tpl.url);

        if (tpl.type === 'mock') {
            if (tpl.mode) {
                const modeEl = document.getElementById('responseMode');
                if (modeEl) {
                    modeEl.value = tpl.mode;
                    this.updateResponseModeVisibility(tpl.mode);
                }
            }
            set('graphqlOperation', tpl.graphqlOperation);
            set('ruleStatus', tpl.status);
            set('ruleBody', tpl.body);
            set('rulePatch', tpl.patch);
        } else if (tpl.type === 'delay') {
            set('delayMs', tpl.delayMs);
        } else if (tpl.type === 'redirect') {
            set('redirectDestination', tpl.redirectDestination);
        } else if (tpl.type === 'headers') {
            set('headersModRequest', tpl.headersModRequest);
            set('headersModResponse', tpl.headersModResponse);
        }

        // C-15: headers rules are a real network-layer modifyHeaders rule
        // (declarativeNetRequest) - warn explicitly when the URL pattern is
        // (or stays) unscoped, since e.g. disabling CORS for every site is a
        // genuine security downgrade, not just a mocking convenience.
        if (tpl.type === 'headers') {
            this.showMessage(
                'Template applied - this modifies headers on every request matching the URL pattern. ' +
                'Narrow the pattern before saving; do not leave it as "*" (every site).',
                'info'
            );
        } else {
            this.showMessage('Template applied — review and adjust before saving.', 'info');
        }
    }

    // CQ-2: delegates to the shared table in src/templates.js so this editor
    // and the in-page overlay cannot disagree about a reason phrase.
    getStatusText(code) {
        return (globalThis.SpliceTapTemplates
            && globalThis.SpliceTapTemplates.getStatusText(code)) || '';
    }

    async loadData() {
        try {
            const result = await chrome.storage.local.get([
                'spliceTapSettings',
                'spliceTapShortcuts',
                'spliceTapRules'
            ]);

            this.settings = result.spliceTapSettings || this.getDefaultSettings();
            this.shortcuts = result.spliceTapShortcuts || this.getDefaultShortcuts();
            this.rules = result.spliceTapRules || [];

        } catch (error) {
            console.error('Error loading data:', error);
            this.settings = this.getDefaultSettings();
            this.shortcuts = this.getDefaultShortcuts();
            this.rules = [];
        }
    }

    // G-11: `notifications`, `autoBackup`, `defaultHeaders`, `maxResponseSize`,
    // `requestTimeout` and `cacheSize` used to be collected, validated and
    // (for two of them) saved from form fields that don't even exist in the
    // HTML - none of the six are read by any runtime code (interceptor,
    // background, storage). `maxResponseSize`/`cacheSize` had zero UI at
    // all, so validateSettings() (U-8) could fail forever on values the user
    // has no way to see or change. Wiring them into content/injected.js is
    // out of scope for this file; removed rather than left as switches that
    // silently do nothing (or, worse, an unfixable dead end). `debugMode` and
    // `chaosMode` are real - the interceptor actually reads them.
    getDefaultSettings() {
        return {
            theme: 'auto',
            debugMode: false,
            // G-8: chaos mode is fully implemented in content/injected.js
            // (random request-failure injection) but had no UI anywhere in
            // the product - shape matches src/storage.js's defaultSettings.
            chaosMode: {
                enabled: false,
                failureRate: 0.1
            }
        };
    }

    getDefaultShortcuts() {
        return {
            toggle: 'Ctrl+Shift+M',
            newRule: 'Ctrl+Shift+N'
        };
    }

    /**
     * FIXED: Better listener management with cleanup tracking
     */
    setupEventListeners() {
        // Tab navigation. Use closest() — the nav buttons contain an SVG icon,
        // so e.target is often the <svg>/<span>, whose dataset.tab is undefined.
        this.addListeners('.nav-item', 'click', (e) => {
            const item = e.target.closest('.nav-item');
            if (item && item.dataset.tab) {
                this.switchTab(item.dataset.tab);
            }
        });

        // Delegated action handler. MV3's extension CSP forbids inline
        // onclick/onchange attributes, so every control declares its intent via
        // data-action and is dispatched here instead.
        this.addDocumentListener('click', (e) => {
            const el = e.target.closest('[data-action]');
            if (el) {
                this.handleAction(el.dataset.action, el);
            }
        });

        // Rule editor "Quick Template" dropdown (was an inline onchange).
        this.addListener('ruleTemplateSelect', 'change', (e) => {
            const name = e.target.value;
            if (name) {
                this.applyTemplate(name);
                e.target.value = '';
            }
        });

        // Header actions
        this.addListener('newRuleBtn', 'click', () => this.openRuleEditor());

        // Rules management

        // Rule editor: type-specific field visibility (G5.2)
        this.addListener('ruleType', 'change', (e) => this.updateRuleTypeVisibility(e.target.value));
        this.addListener('responseMode', 'change', (e) => this.updateResponseModeVisibility(e.target.value));

        // Theme selection
        this.addListeners('input[name="theme"]', 'change', (e) => {
            if (e.target.checked) {
                this.settings.theme = e.target.value;
                this.applyTheme();
                this.saveSettings();
            }
        });

        // Toggle switches (G-11: notifications/autoBackup removed - dead, see
        // getDefaultSettings())
        ['debugMode'].forEach(id => {
            this.addListener(id, 'change', (e) => {
                this.settings[id] = e.target.checked;
            });
        });

        // G-8: Chaos Mode - enable toggle + failure-rate (shown as a 0-100%
        // field, stored internally as the 0-1 fraction content/injected.js
        // already reads via settings.chaosMode.failureRate).
        this.addListener('chaosModeEnabled', 'change', (e) => {
            if (!this.settings.chaosMode) this.settings.chaosMode = {};
            this.settings.chaosMode.enabled = e.target.checked;
        });
        this.addListener('chaosFailureRate', 'input', (e) => {
            const percent = parseFloat(e.target.value);
            if (!isNaN(percent) && percent >= 0 && percent <= 100) {
                if (!this.settings.chaosMode) this.settings.chaosMode = {};
                this.settings.chaosMode.failureRate = percent / 100;
            }
        });

        // Click outside modal to close
        this.addDocumentListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                this.requestCloseModal(e.target);
            }
        });

        // Confirmation modal

        // U-4: any genuine user edit inside the rule editor form marks it dirty.
        // Programmatic `.value = ...` writes during populate/reset don't fire
        // input/change, so this only reacts to real user interaction.
        this.addListener('ruleForm', 'input', () => { this.ruleFormDirty = true; });
        this.addListener('ruleForm', 'change', () => { this.ruleFormDirty = true; });
    }

    /**
     * Dispatch a [data-action] control to its handler. Replaces the inline
     * onclick attributes that MV3's CSP silently blocks.
     */
    handleAction(action, el) {
        switch (action) {
            case 'close-modal':
                // Explicit Cancel/X always closes, even with unsaved rule-editor
                // changes (U-4) - accidental closes (backdrop/Escape) are the ones
                // that get guarded, in requestCloseModal().
                this.requestCloseModal(document.getElementById(el.dataset.modal), { force: true });
                break;
            case 'save-rule':
                this.saveRuleFromEditor();
                break;
            case 'format-json':
                this.formatJSON(el.dataset.target);
                break;
            case 'insert-template':
                this.insertTemplate(el.dataset.template);
                break;
            default:
                console.warn('Unknown data-action:', action);
        }
    }

    /**
     * Helper to add single listener with tracking
     */
    addListener(elementId, event, handler) {
        const element = document.getElementById(elementId);
        if (element) {
            element.addEventListener(event, handler);
            this.listeners.push({ element, event, handler });
        }
    }

    /**
     * Helper to add multiple listeners with tracking
     */
    addListeners(selector, event, handler) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(element => {
            element.addEventListener(event, handler);
            this.listeners.push({ element, event, handler });
        });
    }

    /**
     * Helper to add document listener with tracking
     */
    addDocumentListener(event, handler) {
        document.addEventListener(event, handler);
        this.listeners.push({ element: document, event, handler });
    }

    /**
     * Cleanup all event listeners
     */
    destroy() {
        this.listeners.forEach(({ element, event, handler }) => {
            element.removeEventListener(event, handler);
        });
        this.listeners = [];
    }

    updateUI() {
        // Update theme selection
        const themeRadio = document.querySelector(`input[name="theme"][value="${this.settings.theme}"]`);
        if (themeRadio) {
            themeRadio.checked = true;
        }

        // Update toggles
        ['debugMode'].forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.checked = this.settings[id] || false;
            }
        });

        // G-8: Chaos Mode
        const chaosEnabledEl = document.getElementById('chaosModeEnabled');
        if (chaosEnabledEl) {
            chaosEnabledEl.checked = !!(this.settings.chaosMode && this.settings.chaosMode.enabled);
        }
        const chaosRateEl = document.getElementById('chaosFailureRate');
        if (chaosRateEl) {
            const rate = this.settings.chaosMode && typeof this.settings.chaosMode.failureRate === 'number'
                ? this.settings.chaosMode.failureRate
                : 0.1;
            chaosRateEl.value = Math.round(rate * 100);
        }

        // Update shortcut displays
        const toggleShortcut = document.getElementById('toggleShortcut');
        const newRuleShortcut = document.getElementById('newRuleShortcut');
        
        if (toggleShortcut) toggleShortcut.textContent = this.shortcuts.toggle;
        if (newRuleShortcut) newRuleShortcut.textContent = this.shortcuts.newRule;
    }

    /**
     * FIXED: Single theme initialization (removed duplicate setupTheme)
     */
    initThemeSystem() {
        // Apply initial theme
        this.applyTheme();
        
        // Watch for system changes
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = () => {
            if (this.settings.theme === 'auto') {
                this.applyTheme();
            }
        };
        
        mediaQuery.addEventListener('change', handler);
        this.listeners.push({ 
            element: mediaQuery, 
            event: 'change', 
            handler,
            isMediaQuery: true 
        });
    }

    applyTheme() {
        const theme = this.settings.theme || 'auto';

        const resolved = theme === 'auto'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : theme;

        // Toggle only the theme classes — assigning document.body.className
        // wholesale would wipe any other class on <body>.
        document.body.classList.remove('theme-dark', 'theme-light');
        document.body.classList.add(`theme-${resolved}`);

        // UX-1: cache the resolved theme so the next open can apply it before
        // any async work. Same key the popup uses — both pages share this
        // extension origin's localStorage.
        try {
            window.localStorage.setItem('tm-theme', resolved);
        } catch (error) {
            // localStorage unavailable — the flash returns, nothing else breaks.
        }
    }

    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.nav-item').forEach(btn => {
            const isActive = btn.dataset.tab === tabName;
            btn.classList.toggle('active', isActive);
            // A-11: the active section was communicated purely by a
            // background-colour class; expose it programmatically too.
            if (isActive) {
                btn.setAttribute('aria-current', 'page');
            } else {
                btn.removeAttribute('aria-current');
            }
        });

        // Update tab content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.dataset.tab === tabName);
        });

        // U-7: the top-bar heading is the largest text on screen and used to
        // always read "General Settings", even on the Rules/Advanced tabs.
        const pageTitle = document.getElementById('pageTitle');
        const title = TAB_TITLES[tabName] || TAB_TITLES.rules;
        if (pageTitle) pageTitle.textContent = title;
        document.title = `SpliceTap - ${title}`;
    }

    /**
     * FIXED: Enhanced validation with specific error messages
     */
    async saveSettings() {
        try {
            this.collectSettingsFromUI();

            const errors = this.validateSettings();
            if (errors.length > 0) {
                this.showMessage(`Validation errors:\n${errors.join('\n')}`, 'error');
                return;
            }

            await chrome.storage.local.set({
                spliceTapSettings: this.settings,
                spliceTapShortcuts: this.shortcuts
            });

            // Notify background script
            chrome.runtime.sendMessage({
                type: 'settingsUpdated',
                settings: this.settings,
                shortcuts: this.shortcuts
            });

            this.showMessage('Settings saved successfully!', 'success');
            this.applyTheme();

        } catch (error) {
            console.error('Failed to save settings:', error);
            this.showMessage('Failed to save settings: ' + error.message, 'error');
        }
    }

    collectSettingsFromUI() {
        // Collect from form elements
        const themeRadio = document.querySelector('input[name="theme"]:checked');
        if (themeRadio) {
            this.settings.theme = themeRadio.value;
        }

        ['debugMode'].forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                this.settings[id] = element.checked;
            }
        });

        // G-8: Chaos Mode
        const chaosEnabledEl = document.getElementById('chaosModeEnabled');
        const chaosRateEl = document.getElementById('chaosFailureRate');
        if (chaosEnabledEl || chaosRateEl) {
            if (!this.settings.chaosMode) this.settings.chaosMode = {};
            if (chaosEnabledEl) this.settings.chaosMode.enabled = chaosEnabledEl.checked;
            if (chaosRateEl) {
                const percent = parseFloat(chaosRateEl.value);
                if (!isNaN(percent) && percent >= 0 && percent <= 100) {
                    this.settings.chaosMode.failureRate = percent / 100;
                }
            }
        }
    }





    async loadStatistics() {
        const totalRules = this.rules.length;
        const enabledRules = this.rules.filter(rule => rule.enabled).length;

        const totalRulesElement = document.getElementById('totalRulesCount');
        const enabledRulesElement = document.getElementById('enabledRulesCount');
        const rulesCountElement = document.getElementById('rulesCount');

        if (totalRulesElement) totalRulesElement.textContent = totalRules;
        if (enabledRulesElement) enabledRulesElement.textContent = enabledRules;
        if (rulesCountElement) rulesCountElement.textContent = totalRules;

        // Calculate storage sizes
        const rulesData = JSON.stringify(this.rules);
        const settingsData = JSON.stringify(this.settings);

        const rulesSizeElement = document.getElementById('rulesDataSize');
        const metricsSizeElement = document.getElementById('metricsDataSize');

        if (rulesSizeElement) {
            rulesSizeElement.textContent = Math.ceil(rulesData.length / 1024);
        }

        if (metricsSizeElement) {
            metricsSizeElement.textContent = Math.ceil(settingsData.length / 1024);
        }
    }

    showMessage(message, type = 'info') {
        const container = document.getElementById('messageContainer');
        if (!container) return;

        container.innerHTML = '';

        const messageEl = document.createElement('div');
        // U-1: this used to write `message message-${type}`, but options.css
        // only styles `.message.success` / `.message.error` (space-separated
        // classes) - the hyphenated class never matched, so every error (23
        // failure exits in saveRuleFromEditor alone) rendered unstyled.
        messageEl.className = `message ${type}`;
        messageEl.textContent = message;

        container.appendChild(messageEl);

        setTimeout(() => {
            if (messageEl.parentNode) {
                messageEl.remove();
            }
        }, 5000);

        // U-1: `#messageContainer` lives inside `.content-scroll`, not inside
        // any modal - with the container now fixed-positioned above every
        // modal (options.css), it's always in view without needing to
        // scroll a (possibly wrong, possibly non-scrolling) container into
        // place, so the old `window.scrollTo` call is gone.
    }



    closeModal(modalId) {
        this.closeModalElement(document.getElementById(modalId));
    }

    /**
     * A-4: elements inside `modal` that can receive focus, in DOM order.
     * Shared by openModal()'s initial focus and its Tab-trap.
     */
    _focusableIn(modal) {
        const selector = 'a[href], button:not([disabled]), textarea:not([disabled]), ' +
            'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
        return Array.from(modal.querySelectorAll(selector))
            .filter(el => el.offsetParent !== null);
    }

    /**
     * A-4: open a modal with basic dialog focus management - previously the
     * three options modals only toggled a CSS class, so focus stayed on
     * whatever triggered the modal (now hidden behind a blurred backdrop),
     * Tab could walk out into the page behind it, and focus never returned
     * anywhere on close. This remembers what had focus, moves focus into the
     * dialog, and traps Tab within it until closeModalElement() runs.
     */
    openModal(modal) {
        if (!modal) return;
        this._lastFocusedBeforeModal = document.activeElement;
        modal.classList.add('show');

        const focusable = this._focusableIn(modal);
        if (focusable.length > 0) {
            focusable[0].focus();
        } else {
            const content = modal.querySelector('.modal-content');
            if (content) content.focus();
        }

        if (!modal._tmFocusTrap) {
            const trap = (e) => {
                if (e.key !== 'Tab') return;
                const items = this._focusableIn(modal);
                if (items.length === 0) return;
                const first = items[0];
                const last = items[items.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            };
            modal._tmFocusTrap = trap;
            modal.addEventListener('keydown', trap);
        }
    }

    /**
     * A-4: tear down the focus trap and restore focus to whatever had it
     * before the modal opened. Use requestCloseModal() instead when the
     * close might need to be guarded (e.g. the dirty rule editor, U-4).
     */
    closeModalElement(modal) {
        if (!modal) return;
        modal.classList.remove('show');
        if (modal._tmFocusTrap) {
            modal.removeEventListener('keydown', modal._tmFocusTrap);
            delete modal._tmFocusTrap;
        }
        if (this._lastFocusedBeforeModal && typeof this._lastFocusedBeforeModal.focus === 'function') {
            this._lastFocusedBeforeModal.focus();
        }
        this._lastFocusedBeforeModal = null;
    }

    /**
     * U-4: single entry point for every "close this modal" attempt
     * (backdrop click, Escape, explicit Cancel/X). The rule editor is the
     * longest form in the product with no draft persistence - an accidental
     * backdrop click or an Escape meant to dismiss something else used to
     * destroy it with zero warning. Accidental closes are now ignored while
     * the form is dirty; pass `force: true` (used by the explicit Cancel/X
     * button) to always close.
     */
    requestCloseModal(modal, { force = false } = {}) {
        if (!modal) return;
        if (!force && modal.id === 'ruleEditorModal' && this.ruleFormDirty) {
            this.showMessage('You have unsaved changes in this rule - click Cancel to discard them.', 'info');
            return;
        }
        this.closeModalElement(modal);
    }






    formatJSON(elementId) {
        const el = document.getElementById(elementId);
        if (!el) return;
        try {
            el.value = JSON.stringify(JSON.parse(el.value), null, 2);
        } catch (e) {
            this.showMessage('Invalid JSON: ' + e.message, 'error');
        }
    }

    insertTemplate(template) {
        const el = document.getElementById('ruleBody');
        if (!el || !template) return;

        const start = el.selectionStart;
        const end = el.selectionEnd;
        el.value = el.value.substring(0, start) + template + el.value.substring(end);
        el.selectionStart = el.selectionEnd = start + template.length;
        el.focus();
    }

    enableAutoSave() {
        let saveTimeout;

        const formElements = document.querySelectorAll('input, select, textarea');
        formElements.forEach(element => {
            const handler = () => {
                clearTimeout(saveTimeout);
                saveTimeout = setTimeout(() => {
                    this.collectSettingsFromUI();
                }, 1000);
            };
            
            element.addEventListener('input', handler);
            this.listeners.push({ element, event: 'input', handler });
        });
    }

    setupKeyboardShortcuts() {
        const handler = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this.collectSettingsFromUI();
                this.saveSettings();
            }

            if (e.key === 'Escape') {
                const openModal = document.querySelector('.modal.show');
                if (openModal) {
                    this.requestCloseModal(openModal);
                }
            }
        };
        
        document.addEventListener('keydown', handler);
        this.listeners.push({ element: document, event: 'keydown', handler });
    }

    // U-8/G-11: this used to validate maxResponseSize and cacheSize, neither
    // of which has ever had a corresponding form field - if an imported
    // settings file carried arbitrary unvalidated values, an
    // out-of-range value for either meant
    // "Save Changes" would fail forever with an error pointing at a field
    // the user cannot see or edit, and Factory Reset was the only way out.
    // Both settings (plus requestTimeout/defaultHeaders/notifications/
    // autoBackup) were also unread by any runtime code (G-11) and have been
    // removed entirely rather than kept as dead validation. Only validate
    // settings the UI actually exposes.
    validateSettings() {
        const errors = [];

        if (this.settings.chaosMode) {
            const rate = this.settings.chaosMode.failureRate;
            if (typeof rate !== 'number' || isNaN(rate) || rate < 0 || rate > 1) {
                errors.push('Chaos Mode failure rate must be between 0% and 100%');
            }
        }

        return errors;
    }

    startPerformanceMonitoring() {
        if ('performance' in window) {
            window.addEventListener('load', () => {
                setTimeout(() => {
                    const navigation = performance.getEntriesByType('navigation')[0];
                    if (navigation && this.settings.debugMode) {
                        console.log('Options page load time:', 
                            Math.round(navigation.loadEventEnd - navigation.fetchStart), 'ms');
                    }
                }, 0);
            });
        }
    }

    downloadJSON(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();

        setTimeout(() => URL.revokeObjectURL(url), 100);
    }

    // CQ-6: this produced ids shaped `item-...` while every other surface
    // produced `rule_...`. Shared implementation now — see src/common.js.
    generateId() {
        return globalThis.SpliceTapCommon.generateId();
    }
}

// Initialize the options manager when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.optionsManager = new OptionsManager();
});

// Handle unload to clean up listeners
window.addEventListener('beforeunload', () => {
    if (window.optionsManager) {
        window.optionsManager.destroy();
    }
});