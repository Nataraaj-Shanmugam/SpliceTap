/**
 * API Mocker Extension - Content Script
 * Handles page-level interactions, context menus, and DevTools integration
 */

class APIContentScript {
    constructor() {
        this.isInitialized = false;
        this.interceptedRequests = new Map();
        this.ruleEditor = null;
        
        this.init();
    }

    /**
     * Initialize content script
     */
    async init() {
        if (this.isInitialized) return;
        
        try {
            // Only initialize on pages that can make API requests
            if (this.shouldInitialize()) {
                await this.setupRequestInterception();
                this.setupMessageListeners();
                this.injectNetworkMonitor();
                this.isInitialized = true;
                
                console.log('🎭 API Mocker content script initialized');
            }
        } catch (error) {
            console.error('Failed to initialize API Mocker content script:', error);
        }
    }

    /**
     * Check if we should initialize on this page
     */
    shouldInitialize() {
        // Skip initialization on extension pages and certain URLs
        const skipPatterns = [
            'chrome-extension://',
            'chrome:///',
            'moz-extension://',
            'about:'
        ];
        
        return !skipPatterns.some(pattern => window.location.href.startsWith(pattern));
    }

    /**
     * Setup request interception monitoring
     */
    async setupRequestInterception() {
        // Monitor XMLHttpRequest
        this.interceptXHR();
        
        // Monitor Fetch API
        this.interceptFetch();
        
        // Monitor WebSocket connections (future enhancement)
        // this.interceptWebSocket();
    }

    /**
     * Intercept XMLHttpRequest
     */
    interceptXHR() {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        
        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
            this._apiMocker = {
                method: method.toUpperCase(),
                url: url,
                startTime: Date.now(),
                requestId: Math.random().toString(36).substr(2, 9)
            };
            
            return originalOpen.apply(this, arguments);
        };
        
        XMLHttpRequest.prototype.send = function(data) {
            const xhr = this;
            
            if (xhr._apiMocker) {
                xhr._apiMocker.requestBody = data;
                xhr._apiMocker.requestHeaders = this.getAllRequestHeaders?.() || {};
                
                // Store request for context menu
                window.apiMockerContentScript?.storeRequest({
                    id: xhr._apiMocker.requestId,
                    method: xhr._apiMocker.method,
                    url: xhr._apiMocker.url,
                    headers: xhr._apiMocker.requestHeaders,
                    body: data,
                    timestamp: new Date().toISOString(),
                    type: 'xhr'
                });
                
                // Monitor response
                const originalOnReadyStateChange = xhr.onreadystatechange;
                xhr.onreadystatechange = function() {
                    if (xhr.readyState === 4) {
                        xhr._apiMocker.endTime = Date.now();
                        xhr._apiMocker.duration = xhr._apiMocker.endTime - xhr._apiMocker.startTime;
                        xhr._apiMocker.status = xhr.status;
                        xhr._apiMocker.responseText = xhr.responseText;
                        
                        window.apiMockerContentScript?.notifyRequestComplete(xhr._apiMocker);
                    }
                    
                    if (originalOnReadyStateChange) {
                        originalOnReadyStateChange.apply(this, arguments);
                    }
                };
            }
            
            return originalSend.apply(this, arguments);
        };
    }

    /**
     * Intercept Fetch API
     */
    interceptFetch() {
        const originalFetch = window.fetch;
        
        window.fetch = async function(resource, init = {}) {
            const method = (init.method || 'GET').toUpperCase();
            const url = typeof resource === 'string' ? resource : resource.url;
            const requestId = Math.random().toString(36).substr(2, 9);
            const startTime = Date.now();
            
            // Extract headers
            const headers = {};
            if (init.headers) {
                if (init.headers instanceof Headers) {
                    for (const [key, value] of init.headers.entries()) {
                        headers[key] = value;
                    }
                } else if (typeof init.headers === 'object') {
                    Object.assign(headers, init.headers);
                }
            }
            
            // Store request
            window.apiMockerContentScript?.storeRequest({
                id: requestId,
                method,
                url,
                headers,
                body: init.body,
                timestamp: new Date().toISOString(),
                type: 'fetch'
            });
            
            try {
                const response = await originalFetch.apply(this, arguments);
                const endTime = Date.now();
                
                // Notify completion
                window.apiMockerContentScript?.notifyRequestComplete({
                    requestId,
                    method,
                    url,
                    startTime,
                    endTime,
                    duration: endTime - startTime,
                    status: response.status,
                    statusText: response.statusText
                });
                
                return response;
            } catch (error) {
                const endTime = Date.now();
                
                window.apiMockerContentScript?.notifyRequestComplete({
                    requestId,
                    method,
                    url,
                    startTime,
                    endTime,
                    duration: endTime - startTime,
                    status: 0,
                    error: error.message
                });
                
                throw error;
            }
        };
    }

    /**
     * Store request information for context menu
     */
    storeRequest(request) {
        this.interceptedRequests.set(request.id, request);
        
        // Clean up old requests (keep last 50)
        if (this.interceptedRequests.size > 50) {
            const firstKey = this.interceptedRequests.keys().next().value;
            this.interceptedRequests.delete(firstKey);
        }
    }

    /**
     * Notify when request completes
     */
    notifyRequestComplete(requestInfo) {
        // Update stored request with completion info
        const request = this.interceptedRequests.get(requestInfo.requestId);
        if (request) {
            Object.assign(request, requestInfo);
        }
        
        // Send to background script for rule matching
        chrome.runtime.sendMessage({
            type: 'requestComplete',
            request: requestInfo
        }).catch(() => {
            // Background script might not be ready
        });
    }

    /**
     * Setup message listeners
     */
    setupMessageListeners() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            switch (message.type) {
                case 'openRuleEditor':
                    this.openRuleEditor(message.rule);
                    break;
                case 'getPageRequests':
                    sendResponse(Array.from(this.interceptedRequests.values()));
                    break;
                case 'testRule':
                    this.testRule(message.rule).then(sendResponse);
                    return true; // Async response
                case 'createRuleFromRequest':
                    this.createRuleFromRequest(message.requestId);
                    break;
            }
        });
    }

    /**
     * Inject network monitor for DevTools integration
     */
    injectNetworkMonitor() {
        // Create a script element to inject monitoring code
        const script = document.createElement('script');
        script.textContent = `
            // DevTools Network Panel Integration
            (function() {
                const originalConsoleLog = console.log;
                
                // Listen for our custom events
                window.addEventListener('apiMockerRequest', (event) => {
                    // Add visual indicators to DevTools Network panel
                    console.groupCollapsed('🎭 API Mock Applied');
                    console.log('Rule:', event.detail.ruleName);
                    console.log('Request:', event.detail.url);
                    console.log('Response:', event.detail.response);
                    console.groupEnd();
                });
            })();
        `;
        
        document.documentElement.appendChild(script);
        script.remove();
    }

    /**
     * Open rule editor modal
     */
    openRuleEditor(rule = null) {
        if (this.ruleEditor) {
            this.ruleEditor.remove();
        }
        
        this.ruleEditor = this.createRuleEditorModal(rule);
        document.body.appendChild(this.ruleEditor);
        
        // Focus on first input
        setTimeout(() => {
            const firstInput = this.ruleEditor.querySelector('input');
            if (firstInput) {
                firstInput.focus();
            }
        }, 100);
    }

    /**
     * Create rule editor modal
     */
    createRuleEditorModal(rule) {
        const modal = document.createElement('div');
        modal.className = 'api-mocker-modal';
        modal.innerHTML = `
            <div class="api-mocker-modal-overlay">
                <div class="api-mocker-modal-content">
                    <div class="api-mocker-modal-header">
                        <h3>${rule ? 'Edit Rule' : 'Create New Rule'}</h3>
                        <button class="api-mocker-close-btn">&times;</button>
                    </div>
                    
                    <form class="api-mocker-rule-form">
                        <div class="form-group">
                            <label for="ruleName">Rule Name:</label>
                            <input type="text" id="ruleName" name="name" placeholder="My API Rule" 
                                   value="${rule?.name || ''}" required>
                        </div>
                        
                        <div class="form-group">
                            <label for="ruleUrl">URL Pattern:</label>
                            <input type="text" id="ruleUrl" name="url" 
                                   placeholder="*/api/users/* or https://api.example.com/users"
                                   value="${rule?.url || ''}" required>
                            <small>Use * for wildcards or provide exact URL</small>
                        </div>
                        
                        <div class="form-row">
                            <div class="form-group">
                                <label for="ruleMethod">Method:</label>
                                <select id="ruleMethod" name="method">
                                    <option value="GET" ${rule?.method === 'GET' ? 'selected' : ''}>GET</option>
                                    <option value="POST" ${rule?.method === 'POST' ? 'selected' : ''}>POST</option>
                                    <option value="PUT" ${rule?.method === 'PUT' ? 'selected' : ''}>PUT</option>
                                    <option value="DELETE" ${rule?.method === 'DELETE' ? 'selected' : ''}>DELETE</option>
                                    <option value="PATCH" ${rule?.method === 'PATCH' ? 'selected' : ''}>PATCH</option>
                                    <option value="*" ${rule?.method === '*' ? 'selected' : ''}>Any</option>
                                </select>
                            </div>
                            
                            <div class="form-group">
                                <label for="ruleStatus">Status Code:</label>
                                <select id="ruleStatus" name="statusCode">
                                    <option value="200" ${rule?.statusCode === 200 ? 'selected' : ''}>200 - OK</option>
                                    <option value="201" ${rule?.statusCode === 201 ? 'selected' : ''}>201 - Created</option>
                                    <option value="400" ${rule?.statusCode === 400 ? 'selected' : ''}>400 - Bad Request</option>
                                    <option value="401" ${rule?.statusCode === 401 ? 'selected' : ''}>401 - Unauthorized</option>
                                    <option value="403" ${rule?.statusCode === 403 ? 'selected' : ''}>403 - Forbidden</option>
                                    <option value="404" ${rule?.statusCode === 404 ? 'selected' : ''}>404 - Not Found</option>
                                    <option value="500" ${rule?.statusCode === 500 ? 'selected' : ''}>500 - Server Error</option>
                                </select>
                            </div>
                        </div>
                        
                        <div class="form-group">
                            <label for="ruleDelay">Delay (ms):</label>
                            <input type="number" id="ruleDelay" name="delay" min="0" max="10000" 
                                   value="${rule?.delay || 0}" placeholder="0">
                            <small>Add artificial delay to simulate slow network</small>
                        </div>
                        
                        <div class="form-group">
                            <label for="ruleHeaders">Custom Headers:</label>
                            <textarea id="ruleHeaders" name="headers" rows="3" 
                                      placeholder='{"Content-Type": "application/json", "X-Custom": "value"}'>${
                                rule?.headers ? JSON.stringify(rule.headers, null, 2) : ''
                            }</textarea>
                        </div>
                        
                        <div class="form-group">
                            <label for="ruleBody">Response Body:</label>
                            <div class="response-type-tabs">
                                <button type="button" class="tab-btn active" data-type="json">JSON</button>
                                <button type="button" class="tab-btn" data-type="text">Text</button>
                            </div>
                            <textarea id="ruleBody" name="body" rows="8" 
                                      placeholder='{"message": "Hello World", "status": "success"}'>${
                                rule?.body ? (typeof rule.body === 'object' ? JSON.stringify(rule.body, null, 2) : rule.body) : ''
                            }</textarea>
                        </div>
                        
                        <div class="form-actions">
                            <button type="button" class="btn-secondary" data-action="cancel">Cancel</button>
                            <button type="button" class="btn-test" data-action="test">🧪 Test</button>
                            <button type="submit" class="btn-primary">💾 Save Rule</button>
                        </div>
                    </form>
                    
                    <div class="test-results" style="display: none;">
                        <h4>Test Results</h4>
                        <div class="test-output"></div>
                    </div>
                </div>
            </div>
        `;
        
        // Add styles
        modal.appendChild(this.createModalStyles());
        
        // Attach event listeners
        this.attachModalEventListeners(modal, rule);
        
        return modal;
    }

    /**
     * Create modal styles
     */
    createModalStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .api-mocker-modal {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                z-index: 10000;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            
            .api-mocker-modal-overlay {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.5);
                backdrop-filter: blur(5px);
                display: flex;
                align-items: center;
                justify-content: center;
                animation: fadeIn 0.3s ease;
            }
            
            .api-mocker-modal-content {
                background: white;
                border-radius: 12px;
                width: 90%;
                max-width: 600px;
                max-height: 90vh;
                overflow-y: auto;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                animation: slideUp 0.3s ease;
            }
            
            .api-mocker-modal-header {
                padding: 20px 24px 16px;
                border-bottom: 1px solid #e5e7eb;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }
            
            .api-mocker-modal-header h3 {
                margin: 0;
                font-size: 18px;
                font-weight: 600;
                color: #1f2937;
            }
            
            .api-mocker-close-btn {
                background: none;
                border: none;
                font-size: 24px;
                color: #6b7280;
                cursor: pointer;
                padding: 0;
                width: 32px;
                height: 32px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            
            .api-mocker-close-btn:hover {
                background: #f3f4f6;
                color: #374151;
            }
            
            .api-mocker-rule-form {
                padding: 24px;
            }
            
            .form-group {
                margin-bottom: 20px;
            }
            
            .form-row {
                display: flex;
                gap: 16px;
            }
            
            .form-row .form-group {
                flex: 1;
            }
            
            .form-group label {
                display: block;
                margin-bottom: 6px;
                font-weight: 500;
                color: #374151;
                font-size: 14px;
            }
            
            .form-group input,
            .form-group select,
            .form-group textarea {
                width: 100%;
                padding: 10px 12px;
                border: 1px solid #d1d5db;
                border-radius: 8px;
                font-size: 14px;
                color: #1f2937;
                transition: border-color 0.2s ease;
            }
            
            .form-group input:focus,
            .form-group select:focus,
            .form-group textarea:focus {
                outline: none;
                border-color: #6366f1;
                box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
            }
            
            .form-group small {
                display: block;
                margin-top: 4px;
                font-size: 12px;
                color: #6b7280;
            }
            
            .response-type-tabs {
                display: flex;
                margin-bottom: 8px;
                border-radius: 6px;
                overflow: hidden;
                border: 1px solid #d1d5db;
                width: fit-content;
            }
            
            .tab-btn {
                background: #f9fafb;
                border: none;
                padding: 6px 12px;
                font-size: 12px;
                font-weight: 500;
                cursor: pointer;
                color: #6b7280;
                transition: all 0.2s ease;
            }
            
            .tab-btn.active {
                background: #6366f1;
                color: white;
            }
            
            .tab-btn:hover:not(.active) {
                background: #f3f4f6;
                color: #374151;
            }
            
            .form-actions {
                display: flex;
                gap: 12px;
                justify-content: flex-end;
                margin-top: 32px;
                padding-top: 20px;
                border-top: 1px solid #e5e7eb;
            }
            
            .btn-primary,
            .btn-secondary,
            .btn-test {
                padding: 10px 16px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s ease;
                border: none;
            }
            
            .btn-primary {
                background: linear-gradient(135deg, #6366f1, #8b5cf6);
                color: white;
                box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
            }
            
            .btn-primary:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 16px rgba(99, 102, 241, 0.4);
            }
            
            .btn-secondary {
                background: #f9fafb;
                color: #374151;
                border: 1px solid #d1d5db;
            }
            
            .btn-secondary:hover {
                background: #f3f4f6;
                border-color: #9ca3af;
            }
            
            .btn-test {
                background: #f0f9ff;
                color: #0369a1;
                border: 1px solid #bae6fd;
            }
            
            .btn-test:hover {
                background: #e0f2fe;
                border-color: #7dd3fc;
            }
            
            .test-results {
                padding: 20px 24px;
                border-top: 1px solid #e5e7eb;
                background: #f9fafb;
            }
            
            .test-results h4 {
                margin: 0 0 12px;
                font-size: 16px;
                font-weight: 600;
                color: #1f2937;
            }
            
            .test-output {
                background: white;
                padding: 16px;
                border-radius: 8px;
                font-family: ui-monospace, Monaco, 'Cascadia Code', 'Roboto Mono', monospace;
                font-size: 13px;
                line-height: 1.5;
                border: 1px solid #e5e7eb;
                max-height: 200px;
                overflow-y: auto;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            
            @keyframes slideUp {
                from { 
                    opacity: 0; 
                    transform: translateY(20px) scale(0.95); 
                }
                to { 
                    opacity: 1; 
                    transform: translateY(0) scale(1); 
                }
            }
        `;
        
        return style;
    }

    /**
     * Attach event listeners to modal
     */
    attachModalEventListeners(modal, rule) {
        // Close button
        modal.querySelector('.api-mocker-close-btn').addEventListener('click', () => {
            this.closeModal(modal);
        });
        
        // Cancel button
        modal.querySelector('[data-action="cancel"]').addEventListener('click', () => {
            this.closeModal(modal);
        });
        
        // Test button
        modal.querySelector('[data-action="test"]').addEventListener('click', () => {
            this.testRuleFromForm(modal);
        });
        
        // Form submission
        modal.querySelector('.api-mocker-rule-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveRuleFromForm(modal, rule);
        });
        
        // Response type tabs
        modal.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });
        
        // Close on overlay click
        modal.querySelector('.api-mocker-modal-overlay').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) {
                this.closeModal(modal);
            }
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', this.handleModalKeydown.bind(this));
    }

    /**
     * Handle modal keyboard shortcuts
     */
    handleModalKeydown(e) {
        if (!this.ruleEditor) return;
        
        if (e.key === 'Escape') {
            e.preventDefault();
            this.closeModal(this.ruleEditor);
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            this.saveRuleFromForm(this.ruleEditor);
        }
    }

    /**
     * Close modal
     */
    closeModal(modal) {
        // Remove keyboard listener
        document.removeEventListener('keydown', this.handleModalKeydown.bind(this));
        
        // Animate out
        modal.style.animation = 'fadeOut 0.2s ease';
        setTimeout(() => {
            if (modal.parentNode) {
                modal.parentNode.removeChild(modal);
            }
            if (this.ruleEditor === modal) {
                this.ruleEditor = null;
            }
        }, 200);
    }

    /**
     * Test rule from form
     */
    async testRuleFromForm(modal) {
        const formData = this.getFormData(modal);
        const testBtn = modal.querySelector('[data-action="test"]');
        const resultsSection = modal.querySelector('.test-results');
        const testOutput = modal.querySelector('.test-output');
        
        // Show loading state
        testBtn.textContent = '⏳ Testing...';
        testBtn.disabled = true;
        resultsSection.style.display = 'block';
        testOutput.innerHTML = '<div style="color: #6b7280;">Running tests...</div>';
        
        try {
            // Perform validation tests
            const testResults = await this.performRuleTests(formData);
            
            // Display results
            testOutput.innerHTML = this.formatTestResults(testResults);
            
        } catch (error) {
            testOutput.innerHTML = `<div style="color: #ef4444;">Test failed: ${error.message}</div>`;
        } finally {
            testBtn.textContent = '🧪 Test';
            testBtn.disabled = false;
        }
    }

    /**
     * Perform comprehensive rule tests
     */
    async performRuleTests(ruleData) {
        const tests = {
            urlPattern: this.testUrlPattern(ruleData.url),
            jsonSyntax: this.testJsonSyntax(ruleData.body),
            httpStatus: this.testHttpStatus(ruleData.statusCode),
            headers: this.testHeaders(ruleData.headers),
            simulation: await this.testSimulation(ruleData)
        };
        
        return tests;
    }

    /**
     * Test URL pattern validity
     */
    testUrlPattern(pattern) {
        try {
            if (pattern.includes('*')) {
                // Test wildcard pattern
                const regexPattern = pattern.replace(/\*/g, '.*');
                new RegExp(regexPattern);
                return { valid: true, message: 'Wildcard pattern is valid' };
            } else {
                // Test as URL
                new URL(pattern);
                return { valid: true, message: 'URL format is valid' };
            }
        } catch (error) {
            return { valid: false, message: `Invalid pattern: ${error.message}` };
        }
    }

    /**
     * Test JSON syntax
     */
    testJsonSyntax(body) {
        if (!body.trim()) {
            return { valid: true, message: 'Empty body (valid)' };
        }
        
        try {
            JSON.parse(body);
            return { valid: true, message: 'Valid JSON syntax' };
        } catch (error) {
            return { valid: false, message: `JSON Error: ${error.message}` };
        }
    }

    /**
     * Test HTTP status code
     */
    testHttpStatus(statusCode) {
        const code = parseInt(statusCode);
        
        if (code >= 100 && code < 600) {
            return { valid: true, message: `Valid HTTP status code (${code})` };
        } else {
            return { valid: false, message: 'Invalid HTTP status code' };
        }
    }

    /**
     * Test headers
     */
    testHeaders(headers) {
        if (!headers.trim()) {
            return { valid: true, message: 'No custom headers' };
        }
        
        try {
            const parsedHeaders = JSON.parse(headers);
            if (typeof parsedHeaders === 'object' && !Array.isArray(parsedHeaders)) {
                return { valid: true, message: 'Headers format is valid' };
            } else {
                return { valid: false, message: 'Headers must be an object' };
            }
        } catch (error) {
            return { valid: false, message: `Headers Error: ${error.message}` };
        }
    }

    /**
     * Test rule simulation
     */
    async testSimulation(ruleData) {
        try {
            // Simulate the rule execution
            const mockResponse = {
                status: parseInt(ruleData.statusCode),
                headers: ruleData.headers ? JSON.parse(ruleData.headers) : {},
                body: ruleData.body
            };
            
            // Simulate delay if specified
            if (ruleData.delay > 0) {
                await new Promise(resolve => setTimeout(resolve, Math.min(ruleData.delay, 1000)));
            }
            
            return { 
                valid: true, 
                message: `Simulation successful (${mockResponse.status})`,
                response: mockResponse
            };
        } catch (error) {
            return { valid: false, message: `Simulation failed: ${error.message}` };
        }
    }

    /**
     * Format test results for display
     */
    formatTestResults(results) {
        let html = '';
        
        Object.entries(results).forEach(([testName, result]) => {
            const icon = result.valid ? '✅' : '❌';
            const color = result.valid ? '#10b981' : '#ef4444';
            const title = testName.charAt(0).toUpperCase() + testName.slice(1);
            
            html += `
                <div style="margin-bottom: 8px;">
                    <span style="color: ${color};">${icon} ${title}</span>
                    <div style="margin-left: 20px; color: #6b7280; font-size: 12px;">
                        ${result.message}
                    </div>
                </div>
            `;
        });
        
        // Add response preview if simulation was successful
        if (results.simulation?.valid && results.simulation?.response) {
            html += `
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
                    <div style="font-weight: 600; margin-bottom: 8px; color: #374151;">Response Preview:</div>
                    <div style="background: #f9fafb; padding: 12px; border-radius: 6px; border: 1px solid #e5e7eb;">
                        <div style="margin-bottom: 4px;">Status: ${results.simulation.response.status}</div>
                        <div style="margin-bottom: 8px;">Headers: ${JSON.stringify(results.simulation.response.headers)}</div>
                        <pre style="margin: 0; white-space: pre-wrap; word-break: break-word;">${results.simulation.response.body}</pre>
                    </div>
                </div>
            `;
        }
        
        return html;
    }

    /**
     * Save rule from form
     */
    async saveRuleFromForm(modal, existingRule = null) {
        const formData = this.getFormData(modal);
        const saveBtn = modal.querySelector('button[type="submit"]');
        
        // Show loading state
        saveBtn.textContent = '⏳ Saving...';
        saveBtn.disabled = true;
        
        try {
            // Validate form data
            const validation = this.validateFormData(formData);
            if (!validation.valid) {
                throw new Error(validation.message);
            }
            
            // Create rule object
            const rule = {
                id: existingRule?.id || this.generateId(),
                name: formData.name,
                enabled: true,
                method: formData.method,
                url: formData.url,
                statusCode: parseInt(formData.statusCode),
                statusText: this.getStatusText(formData.statusCode),
                delay: parseInt(formData.delay) || 0,
                headers: formData.headers ? JSON.parse(formData.headers) : {},
                body: formData.body ? JSON.parse(formData.body) : {},
                created: existingRule?.created || new Date().toISOString(),
                lastModified: new Date().toISOString(),
                testStatus: 'pending',
                hitCount: existingRule?.hitCount || 0
            };
            
            // Send to background script to save
            const response = await chrome.runtime.sendMessage({
                type: 'saveRule',
                rule: rule
            });
            
            if (response.success) {
                this.showNotification(`Rule "${rule.name}" saved successfully!`);
                this.closeModal(modal);
            } else {
                throw new Error(response.error || 'Failed to save rule');
            }
            
        } catch (error) {
            this.showError(`Failed to save rule: ${error.message}`);
        } finally {
            saveBtn.textContent = '💾 Save Rule';
            saveBtn.disabled = false;
        }
    }

    /**
     * Get form data
     */
    getFormData(modal) {
        const form = modal.querySelector('.api-mocker-rule-form');
        const formData = new FormData(form);
        
        return {
            name: formData.get('name'),
            url: formData.get('url'),
            method: formData.get('method'),
            statusCode: formData.get('statusCode'),
            delay: formData.get('delay'),
            headers: formData.get('headers'),
            body: formData.get('body')
        };
    }

    /**
     * Validate form data
     */
    validateFormData(data) {
        if (!data.name.trim()) {
            return { valid: false, message: 'Rule name is required' };
        }
        
        if (!data.url.trim()) {
            return { valid: false, message: 'URL pattern is required' };
        }
        
        // Validate JSON fields
        if (data.headers.trim()) {
            try {
                JSON.parse(data.headers);
            } catch (error) {
                return { valid: false, message: 'Invalid headers JSON' };
            }
        }
        
        if (data.body.trim()) {
            try {
                JSON.parse(data.body);
            } catch (error) {
                return { valid: false, message: 'Invalid body JSON' };
            }
        }
        
        // Validate delay
        const delay = parseInt(data.delay);
        if (delay < 0 || delay > 30000) {
            return { valid: false, message: 'Delay must be between 0 and 30000ms' };
        }
        
        return { valid: true };
    }

    /**
     * Get HTTP status text
     */
    getStatusText(statusCode) {
        const statusTexts = {
            200: 'OK',
            201: 'Created',
            204: 'No Content',
            400: 'Bad Request',
            401: 'Unauthorized',
            403: 'Forbidden',
            404: 'Not Found',
            500: 'Internal Server Error',
            502: 'Bad Gateway',
            503: 'Service Unavailable'
        };
        
        return statusTexts[statusCode] || 'Unknown';
    }

    /**
     * Create rule from intercepted request
     */
    createRuleFromRequest(requestId) {
        const request = this.interceptedRequests.get(requestId);
        if (!request) {
            this.showError('Request not found');
            return;
        }
        
        // Create rule with request details
        const rule = {
            name: `Mock ${request.method} ${new URL(request.url).pathname}`,
            url: request.url,
            method: request.method,
            statusCode: 200,
            delay: 0,
            headers: { 'Content-Type': 'application/json' },
            body: { message: 'Mock response', timestamp: new Date().toISOString() }
        };
        
        this.openRuleEditor(rule);
    }

    /**
     * Test existing rule
     */
    async testRule(rule) {
        try {
            const testResults = await this.performRuleTests({
                url: rule.url,
                body: JSON.stringify(rule.body),
                statusCode: rule.statusCode.toString(),
                headers: JSON.stringify(rule.headers),
                delay: rule.delay.toString()
            });
            
            const passed = Object.values(testResults).every(result => result.valid);
            
            return {
                success: true,
                passed: passed,
                results: testResults
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Generate unique ID
     */
    generateId() {
        return 'rule-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * Show success notification
     */
    showNotification(message, duration = 3000) {
        const notification = document.createElement('div');
        notification.className = 'api-mocker-notification success';
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10001;
            box-shadow: 0 10px 25px rgba(16, 185, 129, 0.3);
            animation: slideInRight 0.3s ease, slideOutRight 0.3s ease ${duration - 300}ms;
            max-width: 350px;
            word-break: break-word;
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, duration);
    }

    /**
     * Show error notification
     */
    showError(message, duration = 4000) {
        const notification = document.createElement('div');
        notification.className = 'api-mocker-notification error';
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: linear-gradient(135deg, #ef4444, #dc2626);
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            z-index: 10001;
            box-shadow: 0 10px 25px rgba(239, 68, 68, 0.3);
            animation: slideInRight 0.3s ease, slideOutRight 0.3s ease ${duration - 300}ms;
            max-width: 350px;
            word-break: break-word;
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, duration);
    }
}

// Initialize content script
let apiMockerContentScript = null;

// Wait for DOM to be ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeContentScript);
} else {
    initializeContentScript();
}

function initializeContentScript() {
    if (!apiMockerContentScript) {
        apiMockerContentScript = new APIContentScript();
        
        // Make available globally for intercept functions
        window.apiMockerContentScript = apiMockerContentScript;
    }
}

// Add CSS animations for notifications
const notificationStyles = document.createElement('style');
notificationStyles.textContent = `
    @keyframes slideInRight {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOutRight {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(100%);
            opacity: 0;
        }
    }
    
    @keyframes fadeOut {
        from {
            opacity: 1;
        }
        to {
            opacity: 0;
        }
    }
`;

if (document.head) {
    document.head.appendChild(notificationStyles);
} else {
    document.addEventListener('DOMContentLoaded', () => {
        document.head.appendChild(notificationStyles);
    });
}