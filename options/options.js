/**
 * TurboMock Options Page Script
 * Handles settings, data management, and configuration
 * 
 * FIXED: Race conditions, validation, cleanup, duplicate code
 */

// Constants at top of file
const ANIMATION_DELAY = 150;
const MODAL_OPEN_DELAY = 200;
const MAX_NAME_LENGTH = 100;
const MAX_URL_LENGTH = 500;
const MIN_STATUS_CODE = 100;
const MAX_STATUS_CODE = 599;
const MIN_DELAY = 0;
const MAX_DELAY = 30000;
const MIN_DELAY_MS = 1;
const MAX_DELAY_MS = 30000;
const PREFILL_MAX_AGE_MS = 30000;

const RULE_TYPE_LABELS = {
    mock: 'Mock',
    block: 'Block',
    delay: 'Delay',
    redirect: 'Redirect',
    headers: 'Headers',
    queryparams: 'Query Params'
};

class OptionsManager {
    constructor() {
        this.settings = {};
        this.shortcuts = {};
        this.rules = [];
        this.pendingConfirmAction = null;
        this.listeners = []; // Track listeners for cleanup

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

            console.log('TurboMock options page initialized');
        } catch (error) {
            console.error('Failed to initialize options page:', error);
            this.showMessage('Failed to load options page', 'error');
        }
    }

    /**
     * G5.4: Prefill the rule editor from a context-menu-triggered request.
     * background.js writes { turboMockPrefill: { url, ts } } before opening this page.
     * Returns true if a prefill was found (and handled), false otherwise.
     */
    async checkPrefill() {
        try {
            const result = await chrome.storage.local.get(['turboMockPrefill']);
            const prefill = result.turboMockPrefill;

            if (!prefill || typeof prefill.ts !== 'number' || !prefill.url) {
                return false;
            }

            if (Date.now() - prefill.ts > PREFILL_MAX_AGE_MS) {
                await chrome.storage.local.remove('turboMockPrefill');
                return false;
            }

            await chrome.storage.local.remove('turboMockPrefill');

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
     * G5.2: also populates the type-specific field groups per the v2 rule schema (§1.1)
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

        // Track the rule being edited (used by save-time validation, e.g. §1.7 combos)
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

        modal.classList.add('show');
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
     * G5.2/G5.3: Comprehensive input validation and v2 schema construction (§1.1).
     * Builds the appropriate rule shape per rule.type from only the visible fields,
     * and enforces the type-specific restrictions from §1.7 / G5.3.
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

        const match = { method, url };
        const extra = {};

        // §1.7 / G5.3: redirect/headers/queryparams (DNR-backed) rules cannot express
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
                    'Redirect rules cannot specify header or GraphQL match conditions (declarativeNetRequest cannot express them). Recreate this rule without those conditions.',
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

        // Update local rules array. Replace (not shallow-merge) so switching a rule's
        // type doesn't leave stale fields from its previous type (e.g. an old
        // `response` object surviving a mock -> redirect conversion).
        const existingIndex = this.rules.findIndex(r => r.id === rule.id);
        if (existingIndex >= 0) {
            const old = this.rules[existingIndex];
            this.rules[existingIndex] = {
                ...rule,
                created: old.created || rule.created,
                hitCount: old.hitCount,
                testStatus: old.testStatus
            };
        } else {
            this.rules.push(rule);
        }

        try {
            // Persist through the background so it allocates dnrRuleId for
            // headers/queryparams rules, updates its in-memory rules, rebroadcasts
            // to open tabs, and re-syncs declarativeNetRequest. Writing storage
            // directly here would leave all of that stale.
            const response = await chrome.runtime.sendMessage({ type: 'setRules', rules: this.rules });
            if (!response || !response.success) {
                throw new Error((response && response.error) || 'Background did not accept the rules');
            }
            // Adopt the authoritative rules (with any dnrRuleId the background
            // allocated) so subsequent edits preserve them.
            if (Array.isArray(response.rules)) {
                this.rules = response.rules;
            }

            this.showMessage('Rule saved successfully!', 'success');
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
        const templates = {
            graphqlMock: {
                type: 'mock',
                method: 'POST',
                url: '*/graphql*',
                graphqlOperation: 'getUsers',
                status: 200,
                body: '{\n  "data": {}\n}'
            },
            patchResponse: {
                type: 'mock',
                method: 'GET',
                url: '*/api/*',
                mode: 'patch',
                patch: '{\n  "data": null\n}'
            },
            blockRequest: {
                type: 'block',
                method: '*',
                url: '*/api/*'
            },
            redirectLocalhost: {
                type: 'redirect',
                method: '*',
                url: '/\\/(api\\/.*)/',
                redirectDestination: 'http://localhost:3000/$1'
            },
            corsUnblock: {
                type: 'headers',
                method: '*',
                url: '*',
                headersModResponse: JSON.stringify([
                    { op: 'set', name: 'Access-Control-Allow-Origin', value: '*' },
                    { op: 'set', name: 'Access-Control-Allow-Headers', value: '*' }
                ], null, 2)
            },
            customUserAgent: {
                type: 'headers',
                method: '*',
                url: '*',
                headersModRequest: JSON.stringify([
                    { op: 'set', name: 'User-Agent', value: 'Mozilla/5.0 (TurboMock)' }
                ], null, 2)
            }
        };

        const tpl = templates[name];
        if (!tpl) return;

        const typeEl = document.getElementById('ruleType');
        if (typeEl) {
            typeEl.value = tpl.type;
            this.updateRuleTypeVisibility(tpl.type);
        }

        const methodEl = document.getElementById('ruleMethod');
        if (methodEl && tpl.method) methodEl.value = tpl.method;

        const urlEl = document.getElementById('ruleUrl');
        if (urlEl && tpl.url) urlEl.value = tpl.url;

        if (tpl.type === 'mock') {
            if (tpl.mode) {
                const modeEl = document.getElementById('responseMode');
                if (modeEl) {
                    modeEl.value = tpl.mode;
                    this.updateResponseModeVisibility(tpl.mode);
                }
            }
            if (tpl.graphqlOperation !== undefined) {
                const gqlEl = document.getElementById('graphqlOperation');
                if (gqlEl) gqlEl.value = tpl.graphqlOperation;
            }
            if (tpl.status !== undefined) {
                const statusEl = document.getElementById('ruleStatus');
                if (statusEl) statusEl.value = tpl.status;
            }
            if (tpl.body !== undefined) {
                const bodyEl = document.getElementById('ruleBody');
                if (bodyEl) bodyEl.value = tpl.body;
            }
            if (tpl.patch !== undefined) {
                const patchEl = document.getElementById('rulePatch');
                if (patchEl) patchEl.value = tpl.patch;
            }
        } else if (tpl.type === 'redirect') {
            const destEl = document.getElementById('redirectDestination');
            if (destEl) destEl.value = tpl.redirectDestination || '';
        } else if (tpl.type === 'headers') {
            if (tpl.headersModRequest !== undefined) {
                const el = document.getElementById('headersModRequest');
                if (el) el.value = tpl.headersModRequest;
            }
            if (tpl.headersModResponse !== undefined) {
                const el = document.getElementById('headersModResponse');
                if (el) el.value = tpl.headersModResponse;
            }
        }

        this.showMessage('Template applied — review and adjust before saving.', 'info');
    }

    getStatusText(code) {
        const statuses = {
            200: 'OK', 201: 'Created', 204: 'No Content',
            400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
            500: 'Internal Server Error', 503: 'Service Unavailable'
        };
        return statuses[code] || 'Unknown';
    }

    async loadData() {
        try {
            const result = await chrome.storage.local.get([
                'turboMockSettings',
                'turboMockShortcuts',
                'turboMockRules'
            ]);

            this.settings = result.turboMockSettings || this.getDefaultSettings();
            this.shortcuts = result.turboMockShortcuts || this.getDefaultShortcuts();
            this.rules = result.turboMockRules || [];

        } catch (error) {
            console.error('Error loading data:', error);
            this.settings = this.getDefaultSettings();
            this.shortcuts = this.getDefaultShortcuts();
            this.rules = [];
        }
    }

    getDefaultSettings() {
        return {
            theme: 'auto',
            notifications: true,
            autoBackup: true,
            debugMode: false,
            defaultHeaders: '{"Content-Type": "application/json", "X-Mock-Source": "TurboMock"}',
            maxResponseSize: 1024,
            requestTimeout: 30000,
            cacheSize: 100
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
        // Tab navigation
        this.addListeners('.nav-item', 'click', (e) => {
            this.switchTab(e.target.dataset.tab);
        });

        // Header actions
        this.addListener('saveBtn', 'click', () => this.saveSettings());
        this.addListener('exportBtn', 'click', () => this.exportSettings());
        this.addListener('importBtn', 'click', () => this.importSettings());

        // Rules management
        this.addListener('importRulesBtn', 'click', () => this.importRules());
        this.addListener('exportRulesBtn', 'click', () => this.exportRules());

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

        // Toggle switches
        ['notifications', 'autoBackup', 'debugMode'].forEach(id => {
            this.addListener(id, 'change', (e) => {
                this.settings[id] = e.target.checked;
            });
        });

        // Advanced settings with validation
        this.addListener('defaultHeaders', 'input', (e) => {
            this.settings.defaultHeaders = e.target.value;
        });

        this.addListener('maxResponseSize', 'input', (e) => {
            const value = parseInt(e.target.value, 10);
            if (!isNaN(value) && value > 0) {
                this.settings.maxResponseSize = value;
            }
        });

        this.addListener('requestTimeout', 'input', (e) => {
            const value = parseInt(e.target.value, 10);
            if (!isNaN(value) && value >= 100) {
                this.settings.requestTimeout = value;
            }
        });

        this.addListener('cacheSize', 'input', (e) => {
            const value = parseInt(e.target.value, 10);
            if (!isNaN(value) && value > 0) {
                this.settings.cacheSize = value;
            }
        });

        // Modal close events
        this.addListeners('.modal-close', 'click', (e) => {
            const modal = e.target.closest('.modal');
            if (modal) {
                modal.classList.remove('show');
            }
        });

        // Click outside modal to close
        this.addDocumentListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                e.target.classList.remove('show');
            }
        });

        // Confirmation modal
        this.addListener('confirmBtn', 'click', () => this.executeConfirmAction());
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
        ['notifications', 'autoBackup', 'debugMode'].forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.checked = this.settings[id] || false;
            }
        });

        // Update advanced settings
        ['defaultHeaders', 'maxResponseSize', 'requestTimeout', 'cacheSize'].forEach(id => {
            const element = document.getElementById(id);
            if (element && this.settings[id] !== undefined) {
                element.value = this.settings[id];
            }
        });

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
        
        if (theme === 'auto') {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            document.body.className = prefersDark ? 'theme-dark' : 'theme-light';
        } else {
            document.body.className = `theme-${theme}`;
        }
    }

    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });

        // Update tab content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.dataset.tab === tabName);
        });
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
                turboMockSettings: this.settings,
                turboMockShortcuts: this.shortcuts
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

        ['notifications', 'autoBackup', 'debugMode'].forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                this.settings[id] = element.checked;
            }
        });

        ['defaultHeaders', 'maxResponseSize', 'requestTimeout', 'cacheSize'].forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                this.settings[id] = element.value;
            }
        });
    }

    async exportSettings() {
        const exportData = {
            version: '1.0.0',
            exported: new Date().toISOString(),
            settings: this.settings,
            shortcuts: this.shortcuts
        };

        this.downloadJSON(exportData, `turbomock-settings-${new Date().toISOString().split('T')[0]}.json`);
        this.showMessage('Settings exported successfully!', 'success');
    }

    async importSettings() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';

        input.onchange = async (e) => {
            try {
                const file = e.target.files[0];
                if (!file) return;

                const text = await file.text();
                const data = JSON.parse(text);

                if (data.settings) {
                    this.settings = { ...this.getDefaultSettings(), ...data.settings };
                }

                if (data.shortcuts) {
                    this.shortcuts = { ...this.getDefaultShortcuts(), ...data.shortcuts };
                }

                this.updateUI();
                this.showMessage('Settings imported successfully!', 'success');

            } catch (error) {
                this.showMessage('Failed to import settings: ' + error.message, 'error');
            }
        };

        input.click();
    }

    async importRules() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';

        input.onchange = async (e) => {
            try {
                const file = e.target.files[0];
                if (!file) return;

                const text = await file.text();
                const data = JSON.parse(text);

                let importedRules = [];
                if (Array.isArray(data)) {
                    importedRules = data;
                } else if (data.rules && Array.isArray(data.rules)) {
                    importedRules = data.rules;
                } else {
                    throw new Error('Invalid file format');
                }

                const mergeImport = document.getElementById('mergeImport')?.checked ?? true;

                if (mergeImport) {
                    // Merge with existing rules
                    importedRules.forEach(rule => {
                        rule.id = this.generateId();
                        rule.imported = new Date().toISOString();
                    });
                    this.rules = [...importedRules, ...this.rules];
                } else {
                    // Replace all rules
                    this.rules = importedRules;
                }

                // Route through the background so imported headers/queryparams
                // rules get a dnrRuleId and DNR is re-synced (a direct storage
                // write would leave them non-functional).
                const response = await chrome.runtime.sendMessage({ type: 'setRules', rules: this.rules });
                if (!response || !response.success) {
                    throw new Error((response && response.error) || 'Background did not accept the rules');
                }
                if (Array.isArray(response.rules)) {
                    this.rules = response.rules;
                }
                this.loadStatistics();
                this.showMessage(`Imported ${importedRules.length} rules successfully!`, 'success');

            } catch (error) {
                this.showMessage('Failed to import rules: ' + error.message, 'error');
            }
        };

        input.click();
    }

    async exportRules() {
        const exportData = {
            version: '1.0.0',
            exported: new Date().toISOString(),
            totalRules: this.rules.length,
            enabledRules: this.rules.filter(r => r.enabled).length,
            rules: this.rules
        };

        this.downloadJSON(exportData, `turbomock-rules-${new Date().toISOString().split('T')[0]}.json`);
        this.showMessage(`Exported ${this.rules.length} rules successfully!`, 'success');
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
        messageEl.className = `message message-${type}`;
        messageEl.textContent = message;

        container.appendChild(messageEl);

        setTimeout(() => {
            if (messageEl.parentNode) {
                messageEl.remove();
            }
        }, 5000);

        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showConfirmation(title, message, onConfirm) {
        const modal = document.getElementById('confirmModal');
        const titleEl = document.getElementById('confirmTitle');
        const messageEl = document.getElementById('confirmMessage');

        if (!modal || !titleEl || !messageEl) return;

        titleEl.textContent = title;
        messageEl.textContent = message;

        this.pendingConfirmAction = onConfirm;
        modal.classList.add('show');
    }

    closeConfirmModal() {
        const modal = document.getElementById('confirmModal');
        if (modal) {
            modal.classList.remove('show');
        }
        this.pendingConfirmAction = null;
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('show');
        }
    }

    executeConfirmAction() {
        if (this.pendingConfirmAction) {
            this.pendingConfirmAction();
            this.closeConfirmModal();
        }
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
                    openModal.classList.remove('show');
                }
            }
        };
        
        document.addEventListener('keydown', handler);
        this.listeners.push({ element: document, event: 'keydown', handler });
    }

    validateSettings() {
        const errors = [];

        // Validate numeric settings
        const maxResponseSize = parseInt(this.settings.maxResponseSize, 10);
        if (isNaN(maxResponseSize) || maxResponseSize < 1 || maxResponseSize > 10240) {
            errors.push('Max response size must be between 1 and 10240 KB');
        }

        const requestTimeout = parseInt(this.settings.requestTimeout, 10);
        if (isNaN(requestTimeout) || requestTimeout < 100 || requestTimeout > 30000) {
            errors.push('Request timeout must be between 100 and 30000 ms');
        }

        const cacheSize = parseInt(this.settings.cacheSize, 10);
        if (isNaN(cacheSize) || cacheSize < 10 || cacheSize > 1000) {
            errors.push('Cache size must be between 10 and 1000 rules');
        }

        // Validate default headers JSON
        try {
            if (this.settings.defaultHeaders && this.settings.defaultHeaders.trim()) {
                const parsed = JSON.parse(this.settings.defaultHeaders);
                if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                    errors.push('Default headers must be a JSON object');
                }
            }
        } catch (e) {
            errors.push('Default headers must be valid JSON: ' + e.message);
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

    generateId() {
        return 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    }
}

// Global functions for HTML onclick handlers
function editShortcut(shortcutName) {
    alert('Shortcut editing will be available in a future version.');
}

function switchDataTab(tabName) {
    document.querySelectorAll('.data-tab').forEach(tab => {
        tab.classList.toggle('active', tab.textContent.toLowerCase() === tabName);
    });
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
    }
}

function resetSettingsOnly() {
    if (window.optionsManager) {
        window.optionsManager.showConfirmation(
            'Reset Settings',
            'Reset all settings to default values? Your rules will be preserved.',
            async () => {
                window.optionsManager.settings = window.optionsManager.getDefaultSettings();
                await window.optionsManager.saveSettings();
                window.optionsManager.updateUI();
                window.optionsManager.showMessage('Settings reset successfully!', 'success');
            }
        );
    }
}

function factoryReset() {
    if (window.optionsManager) {
        window.optionsManager.showConfirmation(
            'Factory Reset',
            'Reset everything to default state? This will delete all data and cannot be undone.',
            async () => {
                await chrome.storage.local.clear();
                window.optionsManager.settings = window.optionsManager.getDefaultSettings();
                window.optionsManager.shortcuts = window.optionsManager.getDefaultShortcuts();
                window.optionsManager.rules = [];
                await window.optionsManager.saveSettings();
                window.optionsManager.updateUI();
                window.optionsManager.showMessage('Factory reset completed!', 'success');
            }
        );
    }
}

function saveRule() {
    if (window.optionsManager) {
        window.optionsManager.saveRuleFromEditor();
    }
}

function formatJSON(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    try {
        const obj = JSON.parse(el.value);
        el.value = JSON.stringify(obj, null, 2);
    } catch (e) {
        alert('Invalid JSON: ' + e.message);
    }
}

function applyRuleTemplate(name) {
    if (!name || !window.optionsManager) return;
    window.optionsManager.applyTemplate(name);
}

/**
 * G5.6: rule-type badge markup. Contract shared with popup/* (G6) - a single
 * `.rule-type-badge` class with a `data-type` attribute carrying the raw rule.type
 * value (default 'mock' for legacy rules with no type field).
 */
function getRuleTypeLabel(type) {
    return RULE_TYPE_LABELS[type] || RULE_TYPE_LABELS.mock;
}

function renderRuleTypeBadge(rule) {
    const type = (rule && rule.type) || 'mock';
    return `<span class="rule-type-badge" data-type="${type}">${getRuleTypeLabel(type)}</span>`;
}

function insertTemplate(template) {
    const el = document.getElementById('ruleBody');
    if (!el) return;

    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = el.value;
    const before = text.substring(0, start);
    const after = text.substring(end, text.length);
    el.value = before + template + after;
    el.selectionStart = el.selectionEnd = start + template.length;
    el.focus();
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