/**
 * TurboMock Content Script
 * Handles page injection, request monitoring, and rule editor modal
 */

class TurboMockContent {
    constructor() {
        this.interceptedRequests = new Map();
        this.ruleEditor = null;
        this.networkMonitor = null;
        this.styleElement = null;
        
        this.init();
    }

    async init() {
        try {
            this.setupMessageListeners();
            this.injectRequestInterception();
            this.injectNetworkMonitor();
            
            console.log('🎭 TurboMock content script initialized');
        } catch (error) {
            console.error('Failed to initialize content script:', error);
        }
    }

    /**
     * Inject request interception code
     */
    injectRequestInterception() {
        // Inject script to intercept XMLHttpRequest and fetch
        const script = document.createElement('script');
        script.textContent = `
            (function() {
                // Store original methods
                const originalXHROpen = XMLHttpRequest.prototype.open;
                const originalXHRSend = XMLHttpRequest.prototype.send;
                const originalFetch = window.fetch;

                // Intercept XMLHttpRequest
                XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                    this._turboMockData = {
                        method: method,
                        url: url,
                        timestamp: Date.now(),
                        id: Math.random().toString(36).substr(2, 9)
                    };
                    
                    // Notify content script
                    window.postMessage({
                        type: 'TURBOMOCK_REQUEST_STARTED',
                        data: this._turboMockData
                    }, '*');
                    
                    return originalXHROpen.apply(this, arguments);
                };

                XMLHttpRequest.prototype.send = function() {
                    const originalOnReadyStateChange = this.onreadystatechange;
                    
                    this.onreadystatechange = function() {
                        if (this.readyState === 4 && this._turboMockData) {
                            window.postMessage({
                                type: 'TURBOMOCK_REQUEST_COMPLETED',
                                data: {
                                    ...this._turboMockData,
                                    status: this.status,
                                    statusText: this.statusText,
                                    responseHeaders: this.getAllResponseHeaders(),
                                    isMocked: this.getResponseHeader('X-TurboMock') === 'true'
                                }
                            }, '*');
                        }
                        
                        if (originalOnReadyStateChange) {
                            originalOnReadyStateChange.apply(this, arguments);
                        }
                    };
                    
                    return originalXHRSend.apply(this, arguments);
                };

                // Intercept fetch
                window.fetch = async function(resource, init = {}) {
                    const method = (init.method || 'GET').toUpperCase();
                    const url = typeof resource === 'string' ? resource : resource.url;
                    const requestData = {
                        method: method,
                        url: url,
                        timestamp: Date.now(),
                        id: Math.random().toString(36).substr(2, 9)
                    };
                    
                    // Notify content script
                    window.postMessage({
                        type: 'TURBOMOCK_REQUEST_STARTED',
                        data: requestData
                    }, '*');
                    
                    try {
                        const response = await originalFetch.apply(this, arguments);
                        
                        // Notify completion
                        window.postMessage({
                            type: 'TURBOMOCK_REQUEST_COMPLETED',
                            data: {
                                ...requestData,
                                status: response.status,
                                statusText: response.statusText,
                                isMocked: response.headers.get('X-TurboMock') === 'true'
                            }
                        }, '*');
                        
                        return response;
                    } catch (error) {
                        window.postMessage({
                            type: 'TURBOMOCK_REQUEST_COMPLETED',
                            data: {
                                ...requestData,
                                status: 0,
                                error: error.message
                            }
                        }, '*');
                        throw error;
                    }
                };
            })();
        `;
        
        // Inject the script
        (document.head || document.documentElement).appendChild(script);
        script.remove();

        // Listen for intercepted requests
        window.addEventListener('message', (event) => {
            if (event.source !== window) return;
            
            if (event.data.type === 'TURBOMOCK_REQUEST_STARTED') {
                this.handleRequestStarted(event.data.data);
            } else if (event.data.type === 'TURBOMOCK_REQUEST_COMPLETED') {
                this.handleRequestCompleted(event.data.data);
            }
        });
    }

    /**
     * Handle request started
     */
    handleRequestStarted(requestData) {
        this.interceptedRequests.set(requestData.id, requestData);
        
        // Notify background script
        chrome.runtime.sendMessage({
            type: 'requestIntercepted',
            data: requestData
        }).catch(() => {
            // Ignore errors if background script is not available
        });
    }

    /**
     * Handle request completed
     */
    handleRequestCompleted(requestData) {
        const stored = this.interceptedRequests.get(requestData.id);
        if (stored) {
            Object.assign(stored, requestData);
        }
        
        // Update network monitor
        this.updateNetworkMonitor();
        
        // Notify background script
        chrome.runtime.sendMessage({
            type: 'requestCompleted',
            data: requestData
        }).catch(() => {
            // Ignore errors if background script is not available
        });
    }

    /**
     * Setup message listeners
     */
    setupMessageListeners() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true; // Keep message channel open for async responses
        });
    }

    /**
     * Handle messages from popup and background script
     */
    async handleMessage(message, sender, sendResponse) {
        try {
            switch (message.type) {
                case 'openRuleEditor':
                    await this.openRuleEditor(message.rule);
                    sendResponse({ success: true });
                    break;
                    
                case 'getInterceptedRequests':
                    sendResponse({ 
                        success: true,
                        requests: Array.from(this.interceptedRequests.values()) 
                    });
                    break;
                    
                case 'ping':
                    sendResponse({ success: true, pong: true });
                    break;
                    
                default:
                    sendResponse({ success: false, error: 'Unknown message type' });
            }
        } catch (error) {
            console.error('Error handling message:', error);
            sendResponse({ success: false, error: error.message });
        }
    }

    /**
     * Open rule editor modal
     */
    async openRuleEditor(rule) {
        if (this.ruleEditor) {
            this.ruleEditor.remove();
        }
        
        this.injectModalStyles();
        this.ruleEditor = this.createRuleEditorModal(rule);
        document.body.appendChild(this.ruleEditor);
        
        // Focus the modal
        setTimeout(() => {
            const firstInput = this.ruleEditor.querySelector('input, textarea');
            if (firstInput) firstInput.focus();
        }, 100);
    }

    /**
     * Create rule editor modal
     */
    createRuleEditorModal(rule) {
        const isNewRule = !rule;
        const ruleData = rule || TurboMockUtils.createRuleTemplate();
        
        const modal = document.createElement('div');
        modal.className = 'turbomock-modal';
        modal.innerHTML = `
            <div class="turbomock-modal-backdrop"></div>
            <div class="turbomock-modal-container">
                <div class="turbomock-modal-header">
                    <h2>${isNewRule ? 'Create New Rule' : 'Edit Rule'}</h2>
                    <button class="turbomock-close-btn" type="button">×</button>
                </div>
                <div class="turbomock-modal-body">
                    <form class="turbomock-rule-form">
                        <div class="turbomock-form-group">
                            <label for="turbomock-rule-name">Rule Name</label>
                            <input type="text" id="turbomock-rule-name" value="${TurboMockUtils.escapeHtml(ruleData.name)}" required>
                        </div>
                        
                        <div class="turbomock-form-group">
                            <label>Match Conditions</label>
                            <div class="turbomock-form-row">
                                <select id="turbomock-rule-method">
                                    <option value="*" ${ruleData.match.method === '*' ? 'selected' : ''}>Any</option>
                                    <option value="GET" ${ruleData.match.method === 'GET' ? 'selected' : ''}>GET</option>
                                    <option value="POST" ${ruleData.match.method === 'POST' ? 'selected' : ''}>POST</option>
                                    <option value="PUT" ${ruleData.match.method === 'PUT' ? 'selected' : ''}>PUT</option>
                                    <option value="DELETE" ${ruleData.match.method === 'DELETE' ? 'selected' : ''}>DELETE</option>
                                    <option value="PATCH" ${ruleData.match.method === 'PATCH' ? 'selected' : ''}>PATCH</option>
                                </select>
                                <input type="text" id="turbomock-rule-url" placeholder="URL pattern (e.g., */api/users/*)" value="${TurboMockUtils.escapeHtml(ruleData.match.url)}" required>
                            </div>
                        </div>
                        
                        <div class="turbomock-form-group">
                            <label>Response Configuration</label>
                            <div class="turbomock-form-row">
                                <select id="turbomock-response-status">
                                    <option value="200" ${ruleData.response.statusCode === 200 ? 'selected' : ''}>200 OK</option>
                                    <option value="201" ${ruleData.response.statusCode === 201 ? 'selected' : ''}>201 Created</option>
                                    <option value="400" ${ruleData.response.statusCode === 400 ? 'selected' : ''}>400 Bad Request</option>
                                    <option value="401" ${ruleData.response.statusCode === 401 ? 'selected' : ''}>401 Unauthorized</option>
                                    <option value="403" ${ruleData.response.statusCode === 403 ? 'selected' : ''}>403 Forbidden</option>
                                    <option value="404" ${ruleData.response.statusCode === 404 ? 'selected' : ''}>404 Not Found</option>
                                    <option value="500" ${ruleData.response.statusCode === 500 ? 'selected' : ''}>500 Internal Server Error</option>
                                </select>
                                <input type="number" id="turbomock-response-delay" placeholder="Delay (ms)" value="${ruleData.response.delay || ''}" min="0">
                            </div>
                        </div>
                        
                        <div class="turbomock-form-group">
                            <label for="turbomock-response-headers">Response Headers (JSON)</label>
                            <textarea id="turbomock-response-headers" placeholder='{"Content-Type": "application/json"}'>${JSON.stringify(ruleData.response.headers || {}, null, 2)}</textarea>
                        </div>
                        
                        <div class="turbomock-form-group">
                            <label for="turbomock-response-body">Response Body (JSON)</label>
                            <textarea id="turbomock-response-body" placeholder="Enter JSON response..." rows="6">${JSON.stringify(ruleData.response.body || {}, null, 2)}</textarea>
                        </div>
                    </form>
                </div>
                <div class="turbomock-modal-footer">
                    <button type="button" class="turbomock-btn turbomock-btn-secondary" id="turbomock-cancel-btn">Cancel</button>
                    <button type="button" class="turbomock-btn turbomock-btn-primary" id="turbomock-test-btn">🧪 Test</button>
                    <button type="button" class="turbomock-btn turbomock-btn-primary" id="turbomock-save-btn">💾 Save</button>
                </div>
            </div>
        `;
        
        // Add event listeners
        this.setupModalEventListeners(modal, ruleData, isNewRule);
        
        return modal;
    }

    /**
     * Setup modal event listeners
     */
    setupModalEventListeners(modal, ruleData, isNewRule) {
        // Close modal
        const closeBtn = modal.querySelector('.turbomock-close-btn');
        const backdrop = modal.querySelector('.turbomock-modal-backdrop');
        const cancelBtn = modal.querySelector('#turbomock-cancel-btn');
        
        [closeBtn, backdrop, cancelBtn].forEach(element => {
            element.addEventListener('click', () => {
                modal.remove();
                this.ruleEditor = null;
            });
        });
        
        // Test rule
        modal.querySelector('#turbomock-test-btn').addEventListener('click', () => {
            this.testRuleFromModal(modal);
        });
        
        // Save rule
        modal.querySelector('#turbomock-save-btn').addEventListener('click', () => {
            this.saveRuleFromModal(modal, ruleData, isNewRule);
        });
        
        // Keyboard shortcuts
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                this.ruleEditor = null;
            } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this.saveRuleFromModal(modal, ruleData, isNewRule);
            }
        });
    }

    /**
     * Test rule from modal
     */
    async testRuleFromModal(modal) {
        const testBtn = modal.querySelector('#turbomock-test-btn');
        const originalText = testBtn.textContent;
        
        try {
            testBtn.textContent = '⏳ Testing...';
            testBtn.disabled = true;
            
            const rule = this.collectRuleFromModal(modal);
            
            // Send test request to background script
            const response = await chrome.runtime.sendMessage({
                type: 'testRule',
                rule: rule
            });
            
            if (response.success) {
                this.showTestResults(modal, response.results);
            } else {
                this.showModalError(modal, 'Test failed: ' + response.error);
            }
            
        } catch (error) {
            this.showModalError(modal, 'Test failed: ' + error.message);
        } finally {
            testBtn.textContent = originalText;
            testBtn.disabled = false;
        }
    }

    /**
     * Save rule from modal
     */
    async saveRuleFromModal(modal, originalRule, isNewRule) {
        const saveBtn = modal.querySelector('#turbomock-save-btn');
        const originalText = saveBtn.textContent;
        
        try {
            saveBtn.textContent = '💾 Saving...';
            saveBtn.disabled = true;
            
            const rule = this.collectRuleFromModal(modal);
            
            // Validate rule
            const validation = this.validateRule(rule);
            if (!validation.isValid) {
                this.showModalError(modal, 'Validation failed: ' + validation.errors.join(', '));
                return;
            }
            
            // Preserve original rule properties
            if (!isNewRule) {
                rule.id = originalRule.id;
                rule.created = originalRule.created;
                rule.hitCount = originalRule.hitCount || 0;
            }
            
            rule.lastModified = new Date().toISOString();
            
            // Send to background script
            const response = await chrome.runtime.sendMessage({
                type: 'saveRule',
                rule: rule
            });
            
            if (response.success) {
                this.showModalSuccess(modal, 'Rule saved successfully');
                setTimeout(() => {
                    modal.remove();
                    this.ruleEditor = null;
                }, 1500);
            } else {
                this.showModalError(modal, 'Failed to save rule: ' + response.error);
            }
            
        } catch (error) {
            this.showModalError(modal, 'Save failed: ' + error.message);
        } finally {
            saveBtn.textContent = originalText;
            saveBtn.disabled = false;
        }
    }

    /**
     * Collect rule data from modal form
     */
    collectRuleFromModal(modal) {
        const rule = {
            id: TurboMockUtils.generateId(),
            name: modal.querySelector('#turbomock-rule-name').value.trim(),
            enabled: true,
            match: {
                method: modal.querySelector('#turbomock-rule-method').value,
                url: modal.querySelector('#turbomock-rule-url').value.trim(),
                headers: {}
            },
            response: {
                statusCode: parseInt(modal.querySelector('#turbomock-response-status').value),
                statusText: TurboMockUtils.getStatusText(parseInt(modal.querySelector('#turbomock-response-status').value)),
                headers: this.parseJSON(modal.querySelector('#turbomock-response-headers').value, {}),
                body: this.parseJSON(modal.querySelector('#turbomock-response-body').value, {}),
                delay: parseInt(modal.querySelector('#turbomock-response-delay').value) || 0
            },
            created: new Date().toISOString(),
            testStatus: 'pending',
            hitCount: 0
        };
        
        return rule;
    }

    /**
     * Parse JSON with fallback
     */
    parseJSON(text, fallback = null) {
        try {
            return JSON.parse(text.trim());
        } catch (e) {
            return fallback;
        }
    }

    /**
     * Validate rule
     */
    validateRule(rule) {
        const errors = [];
        
        if (!rule.name || rule.name.trim().length === 0) {
            errors.push('Rule name is required');
        }
        
        if (!rule.match.url || rule.match.url.trim().length === 0) {
            errors.push('URL pattern is required');
        }
        
        const urlValidation = TurboMockUtils.validateUrlPattern(rule.match.url);
        if (!urlValidation.isValid) {
            errors.push(urlValidation.error);
        }
        
        const statusValidation = TurboMockUtils.validateStatusCode(rule.response.statusCode);
        if (!statusValidation.isValid) {
            errors.push(statusValidation.error);
        }
        
        return {
            isValid: errors.length === 0,
            errors: errors
        };
    }

    /**
     * Show test results in modal
     */
    showTestResults(modal, results) {
        let existingResults = modal.querySelector('.turbomock-test-results');
        if (existingResults) {
            existingResults.remove();
        }
        
        const resultsDiv = document.createElement('div');
        resultsDiv.className = 'turbomock-test-results';
        
        const status = results.passed ? 'passed' : 'failed';
        const icon = results.passed ? '✅' : '❌';
        
        let html = `<div class="turbomock-test-result turbomock-test-${status}">
            <strong>${icon} Test ${status.charAt(0).toUpperCase() + status.slice(1)}</strong>
        </div>`;
        
        if (results.errors && results.errors.length > 0) {
            html += '<div class="turbomock-test-result turbomock-test-error"><strong>Errors:</strong><ul>';
            results.errors.forEach(error => {
                html += `<li>${TurboMockUtils.escapeHtml(error)}</li>`;
            });
            html += '</ul></div>';
        }
        
        if (results.warnings && results.warnings.length > 0) {
            html += '<div class="turbomock-test-result turbomock-test-warning"><strong>Warnings:</strong><ul>';
            results.warnings.forEach(warning => {
                html += `<li>${TurboMockUtils.escapeHtml(warning)}</li>`;
            });
            html += '</ul></div>';
        }
        
        resultsDiv.innerHTML = html;
        modal.querySelector('.turbomock-modal-footer').before(resultsDiv);
    }

    /**
     * Show modal success message
     */
    showModalSuccess(modal, message) {
        this.showModalMessage(modal, message, 'success');
    }

    /**
     * Show modal error message
     */
    showModalError(modal, message) {
        this.showModalMessage(modal, message, 'error');
    }

    /**
     * Show modal message
     */
    showModalMessage(modal, message, type) {
        let existingMessage = modal.querySelector('.turbomock-modal-message');
        if (existingMessage) {
            existingMessage.remove();
        }
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `turbomock-modal-message turbomock-modal-message-${type}`;
        messageDiv.textContent = message;
        
        modal.querySelector('.turbomock-modal-footer').before(messageDiv);
        
        setTimeout(() => {
            if (messageDiv.parentNode) {
                messageDiv.remove();
            }
        }, 5000);
    }

    /**
     * Inject network monitor
     */
    injectNetworkMonitor() {
        const monitor = document.createElement('div');
        monitor.id = 'turbomock-network-monitor';
        monitor.innerHTML = `
            <div class="turbomock-monitor-icon">🎭</div>
            <div class="turbomock-monitor-count">0</div>
        `;
        
        this.injectNetworkMonitorStyles();
        document.body.appendChild(monitor);
        this.networkMonitor = monitor;
        
        this.updateNetworkMonitor();
    }

    /**
     * Update network monitor display
     */
    async updateNetworkMonitor() {
        if (!this.networkMonitor) return;
        
        try {
            const count = this.interceptedRequests.size;
            const countElement = this.networkMonitor.querySelector('.turbomock-monitor-count');
            if (countElement) {
                countElement.textContent = count.toString();
            }
            
            if (count > 0) {
                this.networkMonitor.style.opacity = '1';
            } else {
                this.networkMonitor.style.opacity = '0.3';
            }
            
        } catch (error) {
            // Ignore errors
        }
    }

    /**
     * Inject modal styles
     */
    injectModalStyles() {
        if (document.getElementById('turbomock-modal-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'turbomock-modal-styles';
        style.textContent = `
            .turbomock-modal {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                z-index: 999999;
                display: flex;
                align-items: center;
                justify-content: center;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            }
            
            .turbomock-modal-backdrop {
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                backdrop-filter: blur(4px);
            }
            
            .turbomock-modal-container {
                background: white;
                border-radius: 12px;
                box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
                width: 90%;
                max-width: 600px;
                max-height: 90vh;
                overflow: hidden;
                position: relative;
                z-index: 1;
            }
            
            .turbomock-modal-header {
                padding: 20px 24px;
                border-bottom: 1px solid #e5e7eb;
                display: flex;
                justify-content: space-between;
                align-items: center;
                background: #f9fafb;
            }
            
            .turbomock-modal-header h2 {
                margin: 0;
                font-size: 18px;
                font-weight: 600;
                color: #111827;
            }
            
            .turbomock-close-btn {
                background: none;
                border: none;
                font-size: 24px;
                cursor: pointer;
                color: #6b7280;
                padding: 4px;
                line-height: 1;
            }
            
            .turbomock-close-btn:hover {
                color: #374151;
            }
            
            .turbomock-modal-body {
                padding: 24px;
                overflow-y: auto;
                max-height: 60vh;
            }
            
            .turbomock-form-group {
                margin-bottom: 20px;
            }
            
            .turbomock-form-group label {
                display: block;
                font-weight: 500;
                color: #374151;
                margin-bottom: 6px;
                font-size: 14px;
            }
            
            .turbomock-form-row {
                display: flex;
                gap: 12px;
            }
            
            .turbomock-form-row select {
                min-width: 120px;
            }
            
            .turbomock-form-row input[type="text"],
            .turbomock-form-row input[type="number"] {
                flex: 1;
            }
            
            .turbomock-form-group input,
            .turbomock-form-group select,
            .turbomock-form-group textarea {
                width: 100%;
                padding: 8px 12px;
                border: 1px solid #d1d5db;
                border-radius: 6px;
                font-size: 14px;
                transition: border-color 0.2s;
                box-sizing: border-box;
            }
            
            .turbomock-form-group input:focus,
            .turbomock-form-group select:focus,
            .turbomock-form-group textarea:focus {
                outline: none;
                border-color: #3b82f6;
                box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
            }
            
            .turbomock-form-group textarea {
                font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                font-size: 12px;
                resize: vertical;
            }
            
            .turbomock-modal-footer {
                padding: 20px 24px;
                border-top: 1px solid #e5e7eb;
                display: flex;
                gap: 12px;
                justify-content: flex-end;
                background: #f9fafb;
            }
            
            .turbomock-btn {
                padding: 8px 16px;
                border-radius: 6px;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
                border: 1px solid transparent;
            }
            
            .turbomock-btn-primary {
                background: #3b82f6;
                color: white;
                border-color: #3b82f6;
            }
            
            .turbomock-btn-primary:hover {
                background: #2563eb;
                border-color: #2563eb;
            }
            
            .turbomock-btn-secondary {
                background: white;
                color: #374151;
                border-color: #d1d5db;
            }
            
            .turbomock-btn-secondary:hover {
                background: #f9fafb;
                border-color: #9ca3af;
            }
            
            .turbomock-btn:disabled {
                opacity: 0.6;
                cursor: not-allowed;
            }
            
            .turbomock-test-results {
                margin: 20px 0;
                padding: 16px;
                border-radius: 8px;
                background: #f9fafb;
                border: 1px solid #e5e7eb;
            }
            
            .turbomock-test-result {
                margin-bottom: 12px;
                padding: 8px 12px;
                border-radius: 6px;
            }
            
            .turbomock-test-result:last-child {
                margin-bottom: 0;
            }
            
            .turbomock-test-passed {
                background: #dcfce7;
                color: #166534;
                border: 1px solid #bbf7d0;
            }
            
            .turbomock-test-failed {
                background: #fef2f2;
                color: #991b1b;
                border: 1px solid #fecaca;
            }
            
            .turbomock-test-error {
                background: #fef2f2;
                color: #991b1b;
                border: 1px solid #fecaca;
            }
            
            .turbomock-test-warning {
                background: #fefbf2;
                color: #92400e;
                border: 1px solid #fde68a;
            }
            
            .turbomock-test-result ul {
                margin: 8px 0 0 0;
                padding-left: 20px;
            }
            
            .turbomock-test-result li {
                margin-bottom: 4px;
            }
            
            .turbomock-modal-message {
                padding: 12px 16px;
                border-radius: 6px;
                margin: 16px 0;
                font-weight: 500;
            }
            
            .turbomock-modal-message-success {
                background: #dcfce7;
                color: #166534;
                border: 1px solid #bbf7d0;
            }
            
            .turbomock-modal-message-error {
                background: #fef2f2;
                color: #991b1b;
                border: 1px solid #fecaca;
            }
        `;
        
        document.head.appendChild(style);
        this.styleElement = style;
    }

    /**
     * Inject network monitor styles
     */
    injectNetworkMonitorStyles() {
        if (document.getElementById('turbomock-monitor-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'turbomock-monitor-styles';
        style.textContent = `
            #turbomock-network-monitor {
                position: fixed;
                top: 20px;
                right: 20px;
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 8px 12px;
                border-radius: 20px;
                font-size: 12px;
                font-weight: 500;
                z-index: 999998;
                display: flex;
                align-items: center;
                gap: 6px;
                transition: opacity 0.3s;
                backdrop-filter: blur(10px);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            }
            
            .turbomock-monitor-icon {
                font-size: 14px;
            }
            
            .turbomock-monitor-count {
                background: #3b82f6;
                color: white;
                padding: 2px 6px;
                border-radius: 10px;
                font-size: 11px;
                font-weight: 600;
                min-width: 16px;
                text-align: center;
            }
        `;
        
        document.head.appendChild(style);
    }
}

// Initialize content script when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.turboMockContent = new TurboMockContent();
    });
} else {
    window.turboMockContent = new TurboMockContent();
}

// Clean up on page unload
window.addEventListener('beforeunload', () => {
    if (window.turboMockContent) {
        if (window.turboMockContent.styleElement) {
            window.turboMockContent.styleElement.remove();
        }
        if (window.turboMockContent.networkMonitor) {
            window.turboMockContent.networkMonitor.remove();
        }
        if (window.turboMockContent.ruleEditor) {
            window.turboMockContent.ruleEditor.remove();
        }
    }
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TurboMockContent;
}