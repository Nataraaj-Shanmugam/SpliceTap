// DevTools Panel Logic for API Mocker Extension
class DevToolsPanel {
    constructor() {
        this.rules = [];
        this.selectedRule = null;
        this.isMonitoring = false;
        this.requestLog = [];
        this.analytics = {};
        this.backgroundConnection = null;
        this.networkFilters = {
            showMocked: true,
            showUnmocked: true,
            methodFilter: '*',
            statusFilter: '*'
        };
        
        this.init();
    }

    async init() {
        await this.connectToBackground();
        await this.loadRules();
        await this.loadAnalytics();
        this.setupEventListeners();
        this.setupTabs();
        this.setupSections();
        this.setupNetworkListener();
        this.updateUI();
        this.startPerformanceMonitoring();
    }

    // Background Script Communication
    async connectToBackground() {
        try {
            this.backgroundConnection = chrome.runtime.connect({ name: 'devtools' });
            
            this.backgroundConnection.onMessage.addListener((message) => {
                this.handleBackgroundMessage(message);
            });
            
            this.backgroundConnection.onDisconnect.addListener(() => {
                console.warn('DevTools disconnected from background script');
                setTimeout(() => this.connectToBackground(), 1000);
            });
            
            // Notify background that DevTools is ready
            this.backgroundConnection.postMessage({ type: 'devtools_ready' });
        } catch (error) {
            console.error('Failed to connect to background script:', error);
        }
    }

    handleBackgroundMessage(message) {
        switch (message.type) {
            case 'request_intercepted':
                this.handleInterceptedRequest(message.data);
                break;
            case 'rule_applied':
                this.handleRuleApplied(message.data);
                break;
            case 'performance_data':
                this.handlePerformanceData(message.data);
                break;
            case 'error':
                this.handleError(message.data);
                break;
        }
    }

    sendToBackground(type, data = {}) {
        if (this.backgroundConnection) {
            this.backgroundConnection.postMessage({ type, data });
        }
    }

    // Rule Management
    async loadRules() {
        try {
            const result = await chrome.storage.local.get(['mockRules']);
            this.rules = result.mockRules || [];
            this.renderRuleList();
            this.updateStatus();
        } catch (error) {
            console.error('Failed to load rules:', error);
            this.showNotification('Failed to load rules', 'error');
        }
    }

    async saveRules() {
        try {
            await chrome.storage.local.set({ mockRules: this.rules });
            this.updateStatus();
            this.sendToBackground('rules_updated', this.rules);
        } catch (error) {
            console.error('Failed to save rules:', error);
            this.showNotification('Failed to save rules', 'error');
        }
    }

    // Analytics Management
    async loadAnalytics() {
        try {
            const result = await chrome.storage.local.get(['apiMockerAnalytics']);
            this.analytics = result.apiMockerAnalytics || {
                metadata: {
                    version: '1.0.0',
                    created: new Date().toISOString(),
                    lastUpdated: new Date().toISOString()
                },
                rulesCreated: { total: 0, thisWeek: 0, byType: {} },
                requestsIntercepted: { today: 0, thisWeek: 0, allTime: 0 },
                testResults: { passed: 0, failed: 0, averageTestTime: 0 },
                performance: { averageMatchTime: 0, averageResponseTime: 0 },
                errors: { total: 0, byType: {} },
                usage: { sessionsToday: 1, totalSessions: 1 }
            };
            this.renderAnalytics();
        } catch (error) {
            console.error('Failed to load analytics:', error);
        }
    }

    async updateAnalytics(type, data) {
        try {
            const now = new Date();
            this.analytics.metadata.lastUpdated = now.toISOString();

            switch (type) {
                case 'ruleCreated':
                    this.analytics.rulesCreated.total++;
                    this.analytics.rulesCreated.thisWeek++;
                    const ruleType = data.statusCode < 300 ? 'success' : 
                                   data.statusCode < 400 ? 'redirect' : 'error';
                    this.analytics.rulesCreated.byType[ruleType] = 
                        (this.analytics.rulesCreated.byType[ruleType] || 0) + 1;
                    break;

                case 'requestIntercepted':
                    this.analytics.requestsIntercepted.today++;
                    this.analytics.requestsIntercepted.thisWeek++;
                    this.analytics.requestsIntercepted.allTime++;
                    
                    // Update performance metrics
                    if (data.matchTime) {
                        const currentAvg = this.analytics.performance.averageMatchTime;
                        const totalRequests = this.analytics.requestsIntercepted.allTime;
                        this.analytics.performance.averageMatchTime = 
                            ((currentAvg * (totalRequests - 1)) + data.matchTime) / totalRequests;
                    }
                    break;

                case 'testCompleted':
                    if (data.passed) {
                        this.analytics.testResults.passed++;
                    } else {
                        this.analytics.testResults.failed++;
                    }
                    
                    const totalTests = this.analytics.testResults.passed + this.analytics.testResults.failed;
                    this.analytics.testResults.averageTestTime = 
                        ((this.analytics.testResults.averageTestTime * (totalTests - 1)) + data.duration) / totalTests;
                    break;

                case 'error':
                    this.analytics.errors.total++;
                    this.analytics.errors.byType[data.errorType] = 
                        (this.analytics.errors.byType[data.errorType] || 0) + 1;
                    break;
            }

            await chrome.storage.local.set({ apiMockerAnalytics: this.analytics });
            this.renderAnalytics();
        } catch (error) {
            console.error('Failed to update analytics:', error);
        }
    }

    // UI Rendering
    renderRuleList() {
        const ruleList = document.getElementById('ruleList');
        
        if (this.rules.length === 0) {
            ruleList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">🎭</div>
                    <div class="empty-state-title">No Rules Created</div>
                    <div class="empty-state-description">
                        Create your first mock rule to get started
                    </div>
                </div>
            `;
            return;
        }

        // Apply search filter
        const searchTerm = document.getElementById('ruleSearch')?.value?.toLowerCase() || '';
        const filteredRules = this.rules.filter(rule => 
            rule.name.toLowerCase().includes(searchTerm) ||
            rule.match.url.toLowerCase().includes(searchTerm) ||
            rule.match.method.toLowerCase().includes(searchTerm)
        );

        if (filteredRules.length === 0) {
            ruleList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">🔍</div>
                    <div class="empty-state-title">No Matching Rules</div>
                    <div class="empty-state-description">
                        Try adjusting your search terms
                    </div>
                </div>
            `;
            return;
        }

        ruleList.innerHTML = filteredRules.map(rule => `
            <div class="rule-item ${!rule.enabled ? 'disabled' : ''} ${this.selectedRule?.id === rule.id ? 'active' : ''}" 
                 data-rule-id="${rule.id}" onclick="devToolsPanel.selectRule('${rule.id}')">
                <div class="rule-header">
                    <div class="rule-name">${this.escapeHtml(rule.name)}</div>
                    <div class="rule-status">
                        ${this.getStatusIcon(rule)}
                    </div>
                </div>
                <div class="rule-details">
                    <div class="rule-url">${rule.match.method} ${this.escapeHtml(rule.match.url)}</div>
                    <div style="display: flex; justify-content: space-between; margin-top: 4px;">
                        <span>→ ${rule.response.statusCode} ${rule.response.statusText || ''}</span>
                        <span style="color: #569cd6;">${rule.response.delay ? `+${rule.response.delay}ms` : ''}</span>
                    </div>
                    <div class="rule-stats">
                        <div class="stat">
                            <span>📊</span>
                            <span>${rule.hitCount || 0} hits</span>
                        </div>
                        <div class="stat">
                            <span>🕒</span>
                            <span>${rule.lastUsed ? this.formatDate(rule.lastUsed) : 'Never'}</span>
                        </div>
                    </div>
                </div>
            </div>
        `).join('');
    }

    getStatusIcon(rule) {
        if (!rule.enabled) return '<span class="status-icon" style="color: #666;" title="Disabled">⏸️</span>';
        
        switch (rule.testStatus) {
            case 'passed':
                return '<span class="status-icon" style="color: #28a745;" title="Test passed">✅</span>';
            case 'failed':
                return '<span class="status-icon" style="color: #dc3545;" title="Test failed">❌</span>';
            case 'pending':
                return '<span class="status-icon" style="color: #ffc107;" title="Needs testing">⚠️</span>';
            default:
                return '<span class="status-icon" style="color: #6c757d;" title="Not tested">🔄</span>';
        }
    }

    selectRule(ruleId) {
        this.selectedRule = this.rules.find(rule => rule.id === ruleId);
        this.renderRuleList();
        this.renderRuleInspector();
        this.populateRuleEditor();
    }

    renderRuleInspector() {
        const inspector = document.querySelector('[data-tab="inspector"] .request-inspector');
        
        if (!this.selectedRule) {
            inspector.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">🔍</div>
                    <div class="empty-state-title">No Rule Selected</div>
                    <div class="empty-state-description">
                        Select a rule from the sidebar to inspect its configuration and test results
                    </div>
                </div>
            `;
            return;
        }

        const rule = this.selectedRule;
        inspector.innerHTML = `
            <div class="inspector-section">
                <div class="inspector-header">
                    🎯 Rule Configuration
                    <div style="display: flex; gap: 8px;">
                        <button class="btn secondary" onclick="devToolsPanel.testRule('${rule.id}')">🧪 Test</button>
                        <button class="btn secondary" onclick="devToolsPanel.toggleRuleStatus('${rule.id}')">
                            ${rule.enabled ? '⏸️ Disable' : '▶️ Enable'}
                        </button>
                    </div>
                </div>
                <div class="code-block">
                    <div><span class="json-key">ID:</span> <span class="json-string">"${rule.id}"</span></div>
                    <div><span class="json-key">Name:</span> <span class="json-string">"${this.escapeHtml(rule.name)}"</span></div>
                    <div><span class="json-key">Enabled:</span> <span class="json-boolean">${rule.enabled}</span></div>
                    <div><span class="json-key">Created:</span> <span class="json-string">"${this.formatDate(rule.created)}"</span></div>
                    <div><span class="json-key">URL Pattern:</span> <span class="json-string">"${this.escapeHtml(rule.match.url)}"</span></div>
                    <div><span class="json-key">Method:</span> <span class="json-string">"${rule.match.method}"</span></div>
                    <div><span class="json-key">Status Code:</span> <span class="json-number">${rule.response.statusCode}</span></div>
                    ${rule.response.delay ? `<div><span class="json-key">Delay:</span> <span class="json-number">${rule.response.delay}ms</span></div>` : ''}
                </div>
            </div>

            <div class="inspector-section">
                <div class="inspector-header">📋 Response Headers</div>
                <div class="code-block">
                    ${Object.entries(rule.response.headers || {}).length > 0 
                        ? Object.entries(rule.response.headers).map(([key, value]) => 
                            `<div><span class="json-key">"${this.escapeHtml(key)}":</span> <span class="json-string">"${this.escapeHtml(value)}"</span></div>`
                          ).join('')
                        : '<div style="color: #666;">No custom headers</div>'
                    }
                </div>
            </div>

            <div class="inspector-section">
                <div class="inspector-header">📄 Response Body</div>
                <div class="code-block">
                    ${this.formatJson(rule.response.body)}
                </div>
            </div>

            ${rule.testResults ? `
                <div class="inspector-section">
                    <div class="inspector-header">
                        🧪 Test Results 
                        <span style="font-size: 10px; color: #666;">
                            Last run: ${this.formatDate(rule.testResults.lastRun)}
                        </span>
                    </div>
                    <div class="code-block">
                        <div><span class="json-key">Status:</span> 
                            <span class="json-boolean" style="color: ${rule.testResults.passed ? '#28a745' : '#dc3545'}">
                                ${rule.testResults.passed ? 'PASSED' : 'FAILED'}
                            </span>
                        </div>
                        ${rule.testResults.errors && rule.testResults.errors.length > 0 ? `
                            <div><span class="json-key">Errors:</span></div>
                            ${rule.testResults.errors.map(error => 
                                `<div style="margin-left: 20px; color: #dc3545;">• ${this.escapeHtml(error)}</div>`
                            ).join('')}
                        ` : ''}
                        <div><span class="json-key">Duration:</span> <span class="json-number">${rule.testResults.duration || 0}ms</span></div>
                    </div>
                </div>
            ` : ''}

            <div class="inspector-section">
                <div class="inspector-header">📊 Usage Statistics</div>
                <div class="code-block">
                    <div><span class="json-key">Hit Count:</span> <span class="json-number">${rule.hitCount || 0}</span></div>
                    <div><span class="json-key">Success Rate:</span> <span class="json-number">${this.calculateSuccessRate(rule)}%</span></div>
                    <div><span class="json-key">Created:</span> <span class="json-string">"${this.formatDate(rule.created)}"</span></div>
                    <div><span class="json-key">Last Used:</span> 
                        <span class="json-string">"${rule.lastUsed ? this.formatDate(rule.lastUsed) : 'Never'}"</span>
                    </div>
                    <div><span class="json-key">Last Tested:</span> 
                        <span class="json-string">"${rule.lastTested ? this.formatDate(rule.lastTested) : 'Never'}"</span>
                    </div>
                    <div><span class="json-key">Last Modified:</span> 
                        <span class="json-string">"${rule.lastModified ? this.formatDate(rule.lastModified) : this.formatDate(rule.created)}"</span>
                    </div>
                </div>
            </div>

            ${this.renderPatternMatching(rule)}
        `;
    }

    renderPatternMatching(rule) {
        const testUrls = [
            'https://api.example.com/users/123',
            'https://api.example.com/posts',
            'https://jsonplaceholder.typicode.com/users',
            'https://localhost:3000/api/auth'
        ];

        return `
            <div class="inspector-section">
                <div class="inspector-header">🔗 Pattern Matching Test</div>
                <div class="code-block">
                    <div><span class="json-key">Pattern:</span> <span class="json-string">"${this.escapeHtml(rule.match.url)}"</span></div>
                    <div style="margin-top: 8px;"><span class="json-key">Test URLs:</span></div>
                    ${testUrls.map(url => {
                        const matches = this.urlMatches(url, rule.match.url);
                        return `<div style="margin-left: 20px; color: ${matches ? '#28a745' : '#dc3545'};">
                            ${matches ? '✅' : '❌'} ${this.escapeHtml(url)}
                        </div>`;
                    }).join('')}
                </div>
            </div>
        `;
    }

    populateRuleEditor() {
        if (!this.selectedRule) {
            this.clearRuleEditor();
            return;
        }

        const rule = this.selectedRule;
        document.getElementById('ruleName').value = rule.name;
        document.getElementById('ruleUrl').value = rule.match.url;
        document.getElementById('ruleMethod').value = rule.match.method;
        document.getElementById('responseStatus').value = rule.response.statusCode;
        document.getElementById('responseStatusText').value = rule.response.statusText || '';
        document.getElementById('responseDelay').value = rule.response.delay || '';
        document.getElementById('responseBody').value = JSON.stringify(rule.response.body, null, 2);

        // Populate headers
        this.renderHeaders(rule.response.headers || {});

        // Enable/disable buttons based on selection
        document.getElementById('saveRuleBtn').disabled = false;
        document.getElementById('testRuleBtn').disabled = false;
        document.getElementById('duplicateRuleBtn').disabled = false;
        document.getElementById('deleteRuleBtn').disabled = false;
    }

    renderHeaders(headers) {
        const headerManager = document.getElementById('headerManager');
        const headerEntries = Object.entries(headers);
        
        if (headerEntries.length === 0) {
            headerManager.innerHTML = `
                <div class="header-row">
                    <input type="text" placeholder="Header name" data-header="name">
                    <div class="separator"></div>
                    <input type="text" placeholder="Header value" data-header="value">
                    <button class="remove-btn" onclick="removeHeader(this)">×</button>
                </div>
            `;
        } else {
            headerManager.innerHTML = headerEntries.map(([key, value]) => `
                <div class="header-row">
                    <input type="text" value="${this.escapeHtml(key)}" data-header="name">
                    <div class="separator"></div>
                    <input type="text" value="${this.escapeHtml(value)}" data-header="value">
                    <button class="remove-btn" onclick="removeHeader(this)">×</button>
                </div>
            `).join('');
        }
    }

    renderAnalytics() {
        const analyticsData = document.getElementById('analyticsData');
        if (!analyticsData) return;

        const analyticsDisplay = {
            overview: {
                totalRules: this.rules.length,
                enabledRules: this.rules.filter(r => r.enabled).length,
                requestsInterceptedToday: this.analytics.requestsIntercepted.today,
                requestsInterceptedTotal: this.analytics.requestsIntercepted.allTime
            },
            performance: {
                averageMatchTime: `${this.analytics.performance.averageMatchTime.toFixed(2)}ms`,
                averageResponseTime: `${this.analytics.performance.averageResponseTime.toFixed(2)}ms`,
                testSuccessRate: `${this.calculateOverallSuccessRate()}%`
            },
            ruleBreakdown: this.analytics.rulesCreated.byType,
            recentActivity: {
                rulesCreatedThisWeek: this.analytics.rulesCreated.thisWeek,
                testsPassedTotal: this.analytics.testResults.passed,
                testsFailedTotal: this.analytics.testResults.failed,
                errorsTotal: this.analytics.errors.total
            },
            topRules: this.getTopRulesByUsage()
        };

        analyticsData.innerHTML = this.formatJson(analyticsDisplay);
    }

    // Network Monitoring
    setupNetworkListener() {
        // Listen for messages from background script about network requests
        this.sendToBackground('start_network_monitoring');
    }

    handleInterceptedRequest(requestData) {
        if (!this.isMonitoring) return;

        this.addRequestToLog({
            id: requestData.requestId || this.generateId(),
            method: requestData.method,
            url: requestData.url,
            status: requestData.status || 'pending',
            size: requestData.size || '0B',
            time: requestData.responseTime || '0ms',
            isMocked: requestData.isMocked || false,
            ruleId: requestData.ruleId,
            timestamp: new Date().toISOString()
        });

        if (requestData.isMocked) {
            this.updateAnalytics('requestIntercepted', {
                matchTime: requestData.matchTime
            });
        }
    }

    handleRuleApplied(data) {
        // Update rule hit count
        const rule = this.rules.find(r => r.id === data.ruleId);
        if (rule) {
            rule.hitCount = (rule.hitCount || 0) + 1;
            rule.lastUsed = new Date().toISOString();
            this.saveRules();
            this.renderRuleList();
            this.renderRuleInspector();
        }
    }

    handlePerformanceData(data) {
        // Update performance analytics
        if (data.responseTime) {
            const currentAvg = this.analytics.performance.averageResponseTime;
            const totalRequests = this.analytics.requestsIntercepted.allTime;
            this.analytics.performance.averageResponseTime = 
                totalRequests > 0 ? ((currentAvg * (totalRequests - 1)) + data.responseTime) / totalRequests : data.responseTime;
        }
    }

    handleError(error) {
        console.error('Background script error:', error);
        this.updateAnalytics('error', error);
        this.showNotification(error.message || 'Unknown error occurred', 'error');
    }

    startMonitoring() {
        this.isMonitoring = true;
        const btn = document.getElementById('startMonitorBtn');
        btn.innerHTML = '⏸️ Stop Monitoring';
        btn.onclick = () => this.stopMonitoring();
        
        this.sendToBackground('start_monitoring');
        this.showNotification('Network monitoring started', 'success');
    }

    stopMonitoring() {
        this.isMonitoring = false;
        const btn = document.getElementById('startMonitorBtn');
        btn.innerHTML = '▶️ Start Monitoring';
        btn.onclick = () => this.startMonitoring();
        
        this.sendToBackground('stop_monitoring');
        this.showNotification('Network monitoring stopped', 'info');
    }

    addRequestToLog(request) {
        this.requestLog.unshift(request);

        // Keep only last 500 requests for performance
        if (this.requestLog.length > 500) {
            this.requestLog = this.requestLog.slice(0, 500);
        }

        this.renderRequestLog();
    }

    renderRequestLog() {
        const tableBody = document.getElementById('requestTableBody');
        
        if (this.requestLog.length === 0) {
            tableBody.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📡</div>
                    <div class="empty-state-title">No Requests Monitored</div>
                    <div class="empty-state-description">
                        ${this.isMonitoring ? 'Waiting for requests...' : 'Click "Start Monitoring" to track network requests'}
                    </div>
                </div>
            `;
            return;
        }

        // Apply filters
        const filteredRequests = this.requestLog.filter(request => {
            if (!this.networkFilters.showMocked && request.isMocked) return false;
            if (!this.networkFilters.showUnmocked && !request.isMocked) return false;
            if (this.networkFilters.methodFilter !== '*' && request.method !== this.networkFilters.methodFilter) return false;
            return true;
        });

        if (filteredRequests.length === 0) {
            tableBody.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">🔍</div>
                    <div class="empty-state-title">No Matching Requests</div>
                    <div class="empty-state-description">
                        Try adjusting your filters
                    </div>
                </div>
            `;
            return;
        }

        tableBody.innerHTML = filteredRequests.map(request => {
            const statusNum = typeof request.status === 'string' ? 0 : request.status;
            return `
                <div class="request-row ${request.isMocked ? 'mocked' : ''}" 
                     onclick="devToolsPanel.inspectRequest('${request.id}', '${request.url}')">
                    <div class="table-cell" style="flex: 0 0 60px;">
                        <span class="method-badge ${request.method.toLowerCase()}">${request.method}</span>
                    </div>
                    <div class="table-cell" style="flex: 1; font-family: monospace; font-size: 10px;">
                        <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" 
                             title="${this.escapeHtml(request.url)}">
                            ${this.escapeHtml(request.url)}
                        </div>
                    </div>
                    <div class="table-cell" style="flex: 0 0 80px;">
                        <span class="status-badge ${statusNum < 300 ? 'success' : statusNum < 400 ? 'redirect' : 'error'}">
                            ${request.status}
                        </span>
                    </div>
                    <div class="table-cell" style="flex: 0 0 80px;">${request.size}</div>
                    <div class="table-cell" style="flex: 0 0 80px;">${request.time}</div>
                    <div class="table-cell" style="flex: 0 0 60px;">
                        ${request.isMocked ? '<span class="mock-indicator" title="Request mocked">🎭</span>' : ''}
                    </div>
                </div>
            `;
        }).join('');

        // Auto-scroll if enabled
        if (document.getElementById('autoScrollCheckbox')?.checked) {
            tableBody.scrollTop = 0;
        }
    }

    inspectRequest(requestId, url) {
        // Find matching rule and select it
        const matchingRule = this.rules.find(rule => 
            rule.enabled && this.urlMatches(url, rule.match.url)
        );
        
        if (matchingRule) {
            this.selectRule(matchingRule.id);
            this.switchTab('inspector');
        } else {
            // Offer to create a new rule for this request
            if (confirm(`No matching rule found for:\n${url}\n\nWould you like to create a new rule?`)) {
                this.createRuleFromRequest(url);
            }
        }
    }

    // Rule Operations
    async createRule() {
        const rule = {
            id: this.generateId(),
            name: 'New Rule',
            enabled: true,
            created: new Date().toISOString(),
            lastUsed: null,
            lastTested: null,
            lastModified: null,
            testStatus: 'pending',
            hitCount: 0,
            match: {
                url: '*/api/*',
                method: '*'
            },
            response: {
                statusCode: 200,
                statusText: 'OK',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Mock-Source': 'api-mocker-extension'
                },
                body: {
                    message: 'Auto-generated mock response',
                    success: true,
                    data: {},
                    timestamp: new Date().toISOString()
                },
                delay: 0
            },
            testResults: null
        };

        this.rules.unshift(rule);
        await this.saveRules();
        this.selectRule(rule.id);
        this.switchTab('editor');
        this.updateAnalytics('ruleCreated', rule.response);
        this.showNotification('Rule created from request', 'success');
    }

    async saveRule() {
        if (!this.selectedRule) return;

        try {
            // Collect form data
            const formData = this.collectFormData();
            
            // Validate form data
            this.validateRuleData(formData);
            
            // Update rule
            Object.assign(this.selectedRule, formData);
            this.selectedRule.lastModified = new Date().toISOString();
            this.selectedRule.testStatus = 'pending'; // Reset test status after changes
            
            await this.saveRules();
            this.renderRuleList();
            this.renderRuleInspector();
            
            this.showNotification('Rule saved successfully', 'success');
        } catch (error) {
            this.showNotification('Failed to save rule: ' + error.message, 'error');
        }
    }

    validateRuleData(data) {
        if (!data.name || data.name.trim().length === 0) {
            throw new Error('Rule name is required');
        }
        
        if (!data.match.url || data.match.url.trim().length === 0) {
            throw new Error('URL pattern is required');
        }
        
        if (data.response.statusCode < 100 || data.response.statusCode > 599) {
            throw new Error('Invalid HTTP status code');
        }
        
        if (data.response.delay && (isNaN(data.response.delay) || data.response.delay < 0)) {
            throw new Error('Delay must be a positive number');
        }

        // Test URL pattern
        try {
            const pattern = data.match.url.replace(/\*/g, '.*');
            new RegExp(pattern);
        } catch (e) {
            throw new Error('Invalid URL pattern: ' + e.message);
        }

        // Validate JSON body
        if (typeof data.response.body === 'string' && data.response.body.trim()) {
            try {
                JSON.parse(data.response.body);
            } catch (e) {
                throw new Error('Invalid JSON in response body: ' + e.message);
            }
        }
    }

    async testRule(ruleId) {
        const rule = ruleId ? this.rules.find(r => r.id === ruleId) : this.selectedRule;
        if (!rule) return;

        const startTime = performance.now();
        
        try {
            this.showNotification('Testing rule...', 'info');
            
            const testResults = {
                lastRun: new Date().toISOString(),
                passed: true,
                errors: [],
                warnings: [],
                duration: 0
            };

            // Test 1: URL pattern validation
            try {
                const pattern = rule.match.url.replace(/\*/g, '.*');
                const regex = new RegExp(pattern);
                
                // Test against some common URLs
                const testUrls = [
                    'https://api.example.com/users/123',
                    'https://jsonplaceholder.typicode.com/posts',
                    'https://localhost:3000/api/auth'
                ];
                
                const matches = testUrls.filter(url => regex.test(url));
                if (matches.length === 0 && !rule.match.url.includes('localhost')) {
                    testResults.warnings.push('URL pattern may be too restrictive');
                }
            } catch (e) {
                testResults.errors.push('Invalid URL pattern: ' + e.message);
                testResults.passed = false;
            }

            // Test 2: JSON validation
            if (typeof rule.response.body === 'string') {
                try {
                    const parsed = JSON.parse(rule.response.body);
                    const jsonSize = JSON.stringify(parsed).length;
                    if (jsonSize > 1024 * 1024) { // 1MB
                        testResults.warnings.push('Response body is very large (>1MB)');
                    }
                } catch (e) {
                    testResults.errors.push('Invalid JSON in response body: ' + e.message);
                    testResults.passed = false;
                }
            } else {
                try {
                    JSON.stringify(rule.response.body);
                } catch (e) {
                    testResults.errors.push('Response body cannot be serialized to JSON');
                    testResults.passed = false;
                }
            }

            // Test 3: HTTP status validation
            if (rule.response.statusCode < 100 || rule.response.statusCode > 599) {
                testResults.errors.push('Invalid HTTP status code: ' + rule.response.statusCode);
                testResults.passed = false;
            } else if (rule.response.statusCode >= 400 && !rule.response.statusText) {
                testResults.warnings.push('Error status code without status text');
            }

            // Test 4: Header validation
            Object.entries(rule.response.headers || {}).forEach(([key, value]) => {
                if (!key || typeof key !== 'string') {
                    testResults.errors.push('Invalid header name: ' + key);
                    testResults.passed = false;
                }
                if (value === undefined || value === null) {
                    testResults.errors.push('Invalid header value for: ' + key);
                    testResults.passed = false;
                }
                // Check for potentially problematic headers
                if (key.toLowerCase() === 'content-length') {
                    testResults.warnings.push('Content-Length header will be overridden by browser');
                }
            });

            // Test 5: Delay validation
            if (rule.response.delay) {
                if (isNaN(rule.response.delay) || rule.response.delay < 0) {
                    testResults.errors.push('Invalid delay value: ' + rule.response.delay);
                    testResults.passed = false;
                } else if (rule.response.delay > 30000) {
                    testResults.warnings.push('Very long delay (>30s) may cause timeouts');
                }
            }

            // Test 6: Simulate actual request matching
            const simulationResults = await this.simulateRuleApplication(rule);
            if (!simulationResults.success) {
                testResults.errors.push('Rule simulation failed: ' + simulationResults.error);
                testResults.passed = false;
            }

            const endTime = performance.now();
            testResults.duration = Math.round(endTime - startTime);

            rule.testResults = testResults;
            rule.testStatus = testResults.passed ? 'passed' : 'failed';
            rule.lastTested = new Date().toISOString();

            await this.saveRules();
            this.renderRuleList();
            this.renderRuleInspector();

            this.updateAnalytics('testCompleted', testResults);
            
            const message = testResults.passed ? 
                `Rule test passed ✅${testResults.warnings.length ? ` (${testResults.warnings.length} warnings)` : ''}` :
                `Rule test failed ❌ (${testResults.errors.length} errors)`;
            
            this.showNotification(message, testResults.passed ? 'success' : 'error');

            // Show detailed results if there are warnings or errors
            if (testResults.warnings.length > 0 || testResults.errors.length > 0) {
                this.showTestResultsModal(testResults);
            }

        } catch (error) {
            this.showNotification('Test failed: ' + error.message, 'error');
            this.updateAnalytics('error', { errorType: 'test_failure', message: error.message });
        }
    }

    async simulateRuleApplication(rule) {
        try {
            // Create a mock request that should match this rule
            const testUrl = this.generateTestUrl(rule.match.url);
            const matches = this.urlMatches(testUrl, rule.match.url);
            
            if (!matches) {
                return { success: false, error: 'Generated test URL does not match pattern' };
            }

            // Simulate response creation
            const mockResponse = {
                status: rule.response.statusCode,
                statusText: rule.response.statusText || '',
                headers: { ...rule.response.headers },
                body: typeof rule.response.body === 'string' ? 
                    rule.response.body : JSON.stringify(rule.response.body)
            };

            // Validate response can be created
            if (!mockResponse.body) {
                return { success: false, error: 'Empty response body' };
            }

            return { success: true, mockResponse };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    generateTestUrl(pattern) {
        // Convert pattern to a realistic test URL
        let testUrl = pattern
            .replace(/^\*/, 'https://api.example.com')
            .replace(/\/\*/g, '/test-resource')
            .replace(/\*$/, '123');
        
        if (!testUrl.startsWith('http')) {
            testUrl = 'https://api.example.com' + (testUrl.startsWith('/') ? '' : '/') + testUrl;
        }
        
        return testUrl;
    }

    showTestResultsModal(results) {
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        modal.innerHTML = `
            <div style="background: #2d2d30; border: 1px solid #3e3e42; border-radius: 4px; max-width: 600px; max-height: 80vh; overflow-y: auto; padding: 20px;">
                <h3 style="color: #ffffff; margin: 0 0 16px 0;">Test Results Details</h3>
                
                ${results.errors.length > 0 ? `
                    <div style="margin-bottom: 16px;">
                        <h4 style="color: #dc3545; margin: 0 0 8px 0;">❌ Errors (${results.errors.length})</h4>
                        ${results.errors.map(error => `
                            <div style="background: #1e1e1e; padding: 8px; margin-bottom: 4px; border-left: 3px solid #dc3545; font-family: monospace; font-size: 11px;">
                                ${this.escapeHtml(error)}
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
                
                ${results.warnings.length > 0 ? `
                    <div style="margin-bottom: 16px;">
                        <h4 style="color: #ffc107; margin: 0 0 8px 0;">⚠️ Warnings (${results.warnings.length})</h4>
                        ${results.warnings.map(warning => `
                            <div style="background: #1e1e1e; padding: 8px; margin-bottom: 4px; border-left: 3px solid #ffc107; font-family: monospace; font-size: 11px;">
                                ${this.escapeHtml(warning)}
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
                
                <div style="text-align: right; margin-top: 16px; padding-top: 16px; border-top: 1px solid #3e3e42;">
                    <button onclick="this.closest('[style*=fixed]').remove()" style="background: #0e639c; color: white; border: none; padding: 8px 16px; border-radius: 3px; cursor: pointer;">
                        Close
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
    }

    async toggleRuleStatus(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        rule.enabled = !rule.enabled;
        rule.lastModified = new Date().toISOString();
        
        await this.saveRules();
        this.renderRuleList();
        this.renderRuleInspector();
        
        this.showNotification(
            `Rule ${rule.enabled ? 'enabled' : 'disabled'}`, 
            rule.enabled ? 'success' : 'info'
        );
    }

    async duplicateRule() {
        if (!this.selectedRule) return;

        const duplicatedRule = {
            ...JSON.parse(JSON.stringify(this.selectedRule)),
            id: this.generateId(),
            name: this.selectedRule.name + ' (Copy)',
            created: new Date().toISOString(),
            lastUsed: null,
            lastTested: null,
            lastModified: null,
            testStatus: 'pending',
            hitCount: 0,
            testResults: null
        };

        this.rules.unshift(duplicatedRule);
        await this.saveRules();
        this.selectRule(duplicatedRule.id);
        this.updateAnalytics('ruleCreated', duplicatedRule.response);
        this.showNotification('Rule duplicated', 'success');
    }

    async deleteRule() {
        if (!this.selectedRule) return;

        const ruleName = this.selectedRule.name;
        if (confirm(`Delete rule "${ruleName}"?\n\nThis action cannot be undone.`)) {
            this.rules = this.rules.filter(rule => rule.id !== this.selectedRule.id);
            this.selectedRule = null;
            
            await this.saveRules();
            this.renderRuleList();
            this.renderRuleInspector();
            this.clearRuleEditor();
            this.showNotification('Rule deleted', 'success');
        }
    }

    // Utility Functions
    collectFormData() {
        return {
            name: document.getElementById('ruleName').value.trim(),
            enabled: this.selectedRule ? this.selectedRule.enabled : true,
            match: {
                url: document.getElementById('ruleUrl').value.trim(),
                method: document.getElementById('ruleMethod').value
            },
            response: {
                statusCode: parseInt(document.getElementById('responseStatus').value),
                statusText: document.getElementById('responseStatusText').value.trim(),
                headers: this.collectHeaders(),
                body: this.parseResponseBody(),
                delay: parseInt(document.getElementById('responseDelay').value) || 0
            }
        };
    }

    collectHeaders() {
        const headers = {};
        const headerRows = document.querySelectorAll('#headerManager .header-row');
        
        headerRows.forEach(row => {
            const nameInput = row.querySelector('[data-header="name"]');
            const valueInput = row.querySelector('[data-header="value"]');
            
            if (nameInput && valueInput && nameInput.value.trim() && valueInput.value.trim()) {
                headers[nameInput.value.trim()] = valueInput.value.trim();
            }
        });

        return headers;
    }

    parseResponseBody() {
        const bodyText = document.getElementById('responseBody').value.trim();
        if (!bodyText) return {};

        try {
            return JSON.parse(bodyText);
        } catch (e) {
            // If it's not valid JSON, treat as string
            return bodyText;
        }
    }

    clearRuleEditor() {
        document.getElementById('ruleName').value = '';
        document.getElementById('ruleUrl').value = '';
        document.getElementById('ruleMethod').value = '*';
        document.getElementById('responseStatus').value = '200';
        document.getElementById('responseStatusText').value = '';
        document.getElementById('responseDelay').value = '';
        document.getElementById('responseBody').value = '{\n  "message": "Mock response",\n  "success": true\n}';
        this.renderHeaders({});

        // Disable buttons when no rule selected
        document.getElementById('saveRuleBtn').disabled = true;
        document.getElementById('testRuleBtn').disabled = true;
        document.getElementById('duplicateRuleBtn').disabled = true;
        document.getElementById('deleteRuleBtn').disabled = true;
    }

    urlMatches(url, pattern) {
        try {
            // Convert wildcard pattern to regex
            const regexPattern = pattern
                // .replace(/[.+^${}()|[\]\\]/g, '\\                    'X-Mock-Source': '') // Escape regex special chars
                .replace(/\\\*/g, '.*'); // Convert * to .*
            
            const regex = new RegExp(regexPattern, 'i');
            return regex.test(url);
        } catch (e) {
            console.warn('Invalid pattern:', pattern, e);
            return false;
        }
    }

    generateId() {
        return 'rule_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatDate(dateString) {
        try {
            const date = new Date(dateString);
            return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
        } catch (e) {
            return dateString;
        }
    }

    formatJson(obj) {
        if (typeof obj === 'string') {
            try {
                obj = JSON.parse(obj);
            } catch (e) {
                return this.escapeHtml(obj);
            }
        }
        
        return JSON.stringify(obj, null, 2)
            .replace(/"([^"]+)":/g, '<span class="json-key">"$1":</span>')
            .replace(/: "([^"]*)"/g, ': <span class="json-string">"$1"</span>')
            .replace(/: (-?\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
            .replace(/: (true|false|null)/g, ': <span class="json-boolean">$1</span>')
            .replace(/\n/g, '<br>')
            .replace(/  /g, '&nbsp;&nbsp;');
    }

    calculateSuccessRate(rule) {
        if (!rule.testResults || !rule.hitCount) return 0;
        // This is a simplified calculation - in a real implementation,
        // you'd track success/failure rates based on actual usage
        return rule.testResults.passed ? 100 : 0;
    }

    calculateOverallSuccessRate() {
        const total = this.analytics.testResults.passed + this.analytics.testResults.failed;
        if (total === 0) return 0;
        return Math.round((this.analytics.testResults.passed / total) * 100);
    }

    getTopRulesByUsage() {
        return this.rules
            .filter(rule => rule.hitCount > 0)
            .sort((a, b) => (b.hitCount || 0) - (a.hitCount || 0))
            .slice(0, 5)
            .map(rule => ({
                name: rule.name,
                hitCount: rule.hitCount,
                lastUsed: rule.lastUsed
            }));
    }

    showNotification(message, type = 'info') {
        // Remove existing notifications
        document.querySelectorAll('.devtools-notification').forEach(n => n.remove());
        
        const notification = document.createElement('div');
        notification.className = 'devtools-notification';
        notification.style.cssText = `
            position: fixed;
            top: 60px;
            right: 20px;
            background: ${this.getNotificationColor(type)};
            color: white;
            padding: 12px 20px;
            border-radius: 4px;
            font-size: 12px;
            z-index: 10000;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            max-width: 300px;
            word-wrap: break-word;
            animation: slideIn 0.3s ease-out;
        `;
        
        notification.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span>${this.getNotificationIcon(type)}</span>
                <span>${this.escapeHtml(message)}</span>
                <button onclick="this.parentElement.parentElement.remove()" 
                        style="background: none; border: none; color: white; font-size: 16px; cursor: pointer; margin-left: auto;">×</button>
            </div>
        `;
        
        document.body.appendChild(notification);

        setTimeout(() => {
            if (notification.parentNode) {
                notification.style.animation = 'slideOut 0.3s ease-in forwards';
                setTimeout(() => notification.remove(), 300);
            }
        }, 5000);

        // Add CSS animations if not already added
        if (!document.getElementById('notification-styles')) {
            const style = document.createElement('style');
            style.id = 'notification-styles';
            style.textContent = `
                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }
    }

    getNotificationColor(type) {
        switch (type) {
            case 'success': return '#28a745';
            case 'error': return '#dc3545';
            case 'warning': return '#ffc107';
            default: return '#17a2b8';
        }
    }

    getNotificationIcon(type) {
        switch (type) {
            case 'success': return '✅';
            case 'error': return '❌';
            case 'warning': return '⚠️';
            default: return 'ℹ️';
        }
    }

    updateStatus() {
        const enabledRules = this.rules.filter(rule => rule.enabled).length;
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        
        if (enabledRules > 0) {
            statusDot.classList.remove('disabled');
            statusText.textContent = `Active (${enabledRules} rules)`;
        } else {
            statusDot.classList.add('disabled');
            statusText.textContent = 'Disabled';
        }
    }

    startPerformanceMonitoring() {
        // Monitor extension performance
        setInterval(() => {
            const memUsage = performance.memory ? {
                used: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
                total: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024),
                limit: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024)
            } : null;

            if (memUsage && memUsage.used > 50) { // Over 50MB
                console.warn('High memory usage detected:', memUsage);
            }
        }, 30000); // Check every 30 seconds
    }

    // Event Handlers
    setupEventListeners() {
        // Header controls
        document.getElementById('refreshBtn').onclick = () => this.refreshData();
        document.getElementById('clearBtn').onclick = () => this.clearAllData();
        document.getElementById('importBtn').onclick = () => this.importRules();
        document.getElementById('exportBtn').onclick = () => this.exportRules();
        document.getElementById('newRuleBtn').onclick = () => this.createRule();

        // Rule editor
        document.getElementById('saveRuleBtn').onclick = () => this.saveRule();
        document.getElementById('testRuleBtn').onclick = () => this.testRule();
        document.getElementById('duplicateRuleBtn').onclick = () => this.duplicateRule();
        document.getElementById('deleteRuleBtn').onclick = () => this.deleteRule();

        // Network monitor
        document.getElementById('startMonitorBtn').onclick = () => this.startMonitoring();
        document.getElementById('clearMonitorBtn').onclick = () => this.clearRequestLog();
        document.getElementById('exportLogsBtn').onclick = () => this.exportLogs();

        // Search
        document.getElementById('ruleSearch').oninput = (e) => this.filterRules(e.target.value);

        // Auto-save form data
        ['ruleName', 'ruleUrl', 'ruleMethod', 'responseStatus', 'responseStatusText', 'responseDelay', 'responseBody'].forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.onchange = () => this.markRuleAsModified();
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                switch (e.key) {
                    case 's':
                        e.preventDefault();
                        if (this.selectedRule) this.saveRule();
                        break;
                    case 'n':
                        e.preventDefault();
                        this.createRule();
                        break;
                    case 'd':
                        e.preventDefault();
                        if (this.selectedRule) this.duplicateRule();
                        break;
                    case 't':
                        e.preventDefault();
                        if (this.selectedRule) this.testRule();
                        break;
                }
            }
        });
    }

    markRuleAsModified() {
        // Visual indicator that rule has unsaved changes
        const saveBtn = document.getElementById('saveRuleBtn');
        if (saveBtn && this.selectedRule) {
            saveBtn.innerHTML = '💾 Save Rule *';
            saveBtn.style.background = '#ffc107';
            saveBtn.style.color = '#212529';
        }
    }

    setupTabs() {
        const tabs = document.querySelectorAll('.tab');
        
        tabs.forEach(tab => {
            tab.onclick = () => {
                const tabName = tab.dataset.tab;
                this.switchTab(tabName);
            };
        });
    }

    switchTab(tabName) {
        const tabs = document.querySelectorAll('.tab');
        const contents = document.querySelectorAll('.tab-content');

        tabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        contents.forEach(content => {
            content.classList.toggle('active', content.dataset.tab === tabName);
        });

        // Load tab-specific data
        if (tabName === 'analytics') {
            this.renderAnalytics();
        } else if (tabName === 'monitor') {
            this.renderRequestLog();
        }
    }

    setupSections() {
        const headers = document.querySelectorAll('.section-header');
        
        headers.forEach(header => {
            header.onclick = () => {
                const section = header.dataset.section;
                const content = document.querySelector(`[data-section="${section}"].section-content`);
                const isCollapsed = content.classList.contains('collapsed');
                
                content.classList.toggle('collapsed', !isCollapsed);
                header.classList.toggle('collapsed', !isCollapsed);
            };
        });
    }

    filterRules(searchTerm) {
        this.renderRuleList(); // Re-render with filter applied
    }

    async refreshData() {
        this.showNotification('Refreshing data...', 'info');
        await this.loadRules();
        await this.loadAnalytics();
        this.renderRequestLog();
        this.showNotification('Data refreshed', 'success');
    }

    async clearAllData() {
        if (confirm('Clear all data including rules, logs, and analytics?\n\nThis action cannot be undone.')) {
            try {
                await chrome.storage.local.clear();
                this.rules = [];
                this.selectedRule = null;
                this.requestLog = [];
                this.analytics = {};
                
                this.renderRuleList();
                this.renderRuleInspector();
                this.renderRequestLog();
                this.renderAnalytics();
                this.clearRuleEditor();
                
                this.showNotification('All data cleared', 'success');
            } catch (error) {
                this.showNotification('Failed to clear data', 'error');
            }
        }
    }

    clearRequestLog() {
        this.requestLog = [];
        this.renderRequestLog();
        this.showNotification('Request log cleared', 'success');
    }

    async importRules() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.multiple = false;
        
        input.onchange = async (e) => {
            try {
                const file = e.target.files[0];
                if (!file) return;
                
                const text = await file.text();
                const importedData = JSON.parse(text);
                
                if (Array.isArray(importedData)) {
                    // Import rules array
                    const validRules = importedData.filter(rule => 
                        rule.id && rule.name && rule.match && rule.response
                    );
                    
                    this.rules = [...validRules, ...this.rules];
                    await this.saveRules();
                    this.showNotification(`Imported ${validRules.length} rules`, 'success');
                } else if (importedData.rules && Array.isArray(importedData.rules)) {
                    // Import full export format
                    this.rules = [...importedData.rules, ...this.rules];
                    await this.saveRules();
                    this.showNotification(`Imported ${importedData.rules.length} rules`, 'success');
                } else {
                    throw new Error('Invalid file format. Expected array of rules or export object.');
                }
                
            } catch (error) {
                this.showNotification('Import failed: ' + error.message, 'error');
            }
        };
        
        input.click();
    }

    exportRules() {
        const exportData = {
            version: '1.0.0',
            exportDate: new Date().toISOString(),
            rules: this.rules,
            analytics: this.analytics
        };
        
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { 
            type: 'application/json' 
        });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `api-mocker-export-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
        this.showNotification(`Exported ${this.rules.length} rules`, 'success');
    }

    exportLogs() {
        const exportData = {
            version: '1.0.0',
            exportDate: new Date().toISOString(),
            totalRequests: this.requestLog.length,
            mockedRequests: this.requestLog.filter(r => r.isMocked).length,
            requests: this.requestLog
        };
        
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { 
            type: 'application/json' 
        });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `api-mocker-logs-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
        this.showNotification(`Exported ${this.requestLog.length} request logs`, 'success');
    }
}

// Header management functions (global scope for onclick handlers)
function addHeader() {
    const headerManager = document.getElementById('headerManager');
    if (!headerManager) return;
    
    const newRow = document.createElement('div');
    newRow.className = 'header-row';
    newRow.innerHTML = `
        <input type="text" placeholder="Header name" data-header="name" onchange="devToolsPanel.markRuleAsModified()">
        <div class="separator"></div>
        <input type="text" placeholder="Header value" data-header="value" onchange="devToolsPanel.markRuleAsModified()">
        <button class="remove-btn" onclick="removeHeader(this)">×</button>
    `;
    headerManager.appendChild(newRow);
    
    // Focus on the new header name input
    const nameInput = newRow.querySelector('[data-header="name"]');
    if (nameInput) nameInput.focus();
}

function removeHeader(button) {
    const row = button.closest('.header-row');
    if (row) {
        row.remove();
        if (window.devToolsPanel) {
            window.devToolsPanel.markRuleAsModified();
        }
    }
}

// Global utility functions
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        if (window.devToolsPanel) {
            window.devToolsPanel.showNotification('Copied to clipboard', 'success');
        }
    }).catch(err => {
        console.error('Failed to copy to clipboard:', err);
    });
}

// DevTools specific integration
class DevToolsIntegration {
    static init() {
        // Create DevTools panel
        chrome.devtools.panels.create(
            'API Mocker',
            '/assets/icons/icon-16.png',
            '/devtools.html',
            (panel) => {
                console.log('API Mocker DevTools panel created');
            }
        );

        // Add sidebar pane to Network panel
        chrome.devtools.panels.network.onNavigated.addListener(() => {
            console.log('Navigation detected, refreshing mock rules');
        });

        // Listen for network requests
        chrome.devtools.network.onRequestFinished.addListener((request) => {
            // Send request data to our panel
            if (window.devToolsPanel) {
                window.devToolsPanel.handleInterceptedRequest({
                    requestId: request.request.url + '_' + Date.now(),
                    method: request.request.method,
                    url: request.request.url,
                    status: request.response.status,
                    size: formatBytes(request.response.content.size || 0),
                    responseTime: formatDuration(request.time),
                    isMocked: request.response.headers.some(h => 
                        h.name === 'X-Mock-Source' && h.value === 'api-mocker-extension'
                    )
                });
            }
        });
    }
}

// Context menu integration for DevTools
class DevToolsContextMenu {
    static init() {
        // Add context menu items to network requests
        chrome.devtools.panels.network.onRequestFinished.addListener((request) => {
            // This would be handled by the content script in a real implementation
            console.log('Request finished:', request);
        });
    }

    static createRuleFromRequest(request) {
        if (window.devToolsPanel) {
            window.devToolsPanel.createRuleFromRequest(request.url);
        }
    }
}

// Advanced rule templates
class RuleTemplates {
    static getTemplates() {
        return {
            userAuthentication: {
                name: 'User Authentication Success',
                match: { url: '*/api/auth/login', method: 'POST' },
                response: {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: {
                        success: true,
                        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
                        user: {
                            id: '12345',
                            username: 'testuser',
                            email: 'test@example.com',
                            role: 'user'
                        },
                        expiresIn: 3600
                    }
                }
            },

            userAuthError: {
                name: 'User Authentication Error',
                match: { url: '*/api/auth/login', method: 'POST' },
                response: {
                    statusCode: 401,
                    statusText: 'Unauthorized',
                    headers: { 'Content-Type': 'application/json' },
                    body: {
                        success: false,
                        error: 'Invalid credentials',
                        message: 'Username or password is incorrect'
                    }
                }
            },

            apiListResponse: {
                name: 'API List Response',
                match: { url: '*/api/*/list', method: 'GET' },
                response: {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: {
                        success: true,
                        data: [
                            { id: 1, name: 'Item 1', status: 'active' },
                            { id: 2, name: 'Item 2', status: 'inactive' },
                            { id: 3, name: 'Item 3', status: 'active' }
                        ],
                        pagination: {
                            page: 1,
                            limit: 10,
                            total: 3,
                            totalPages: 1
                        }
                    }
                }
            },

            apiCreateSuccess: {
                name: 'API Create Success',
                match: { url: '*/api/*', method: 'POST' },
                response: {
                    statusCode: 201,
                    statusText: 'Created',
                    headers: { 'Content-Type': 'application/json' },
                    body: {
                        success: true,
                        message: 'Resource created successfully',
                        data: {
                            id: '{{randomId}}',
                            created_at: '{{timestamp}}',
                            updated_at: '{{timestamp}}'
                        }
                    }
                }
            },

            serverError: {
                name: 'Server Error 500',
                match: { url: '*/api/*', method: '*' },
                response: {
                    statusCode: 500,
                    statusText: 'Internal Server Error',
                    headers: { 'Content-Type': 'application/json' },
                    body: {
                        success: false,
                        error: 'Internal server error',
                        message: 'Something went wrong on our end',
                        timestamp: '{{timestamp}}'
                    }
                }
            },

            slowResponse: {
                name: 'Slow Network Response',
                match: { url: '*/api/*', method: '*' },
                response: {
                    statusCode: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: {
                        success: true,
                        message: 'This response was delayed',
                        timestamp: '{{timestamp}}'
                    },
                    delay: 5000
                }
            },

            rateLimited: {
                name: 'Rate Limited Response',
                match: { url: '*/api/*', method: '*' },
                response: {
                    statusCode: 429,
                    statusText: 'Too Many Requests',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Retry-After': '60'
                    },
                    body: {
                        success: false,
                        error: 'Rate limit exceeded',
                        message: 'Too many requests. Please try again later.',
                        retryAfter: 60
                    }
                }
            }
        };
    }

    static applyTemplate(templateName) {
        const templates = this.getTemplates();
        const template = templates[templateName];
        
        if (template && window.devToolsPanel) {
            // Process template variables
            const processedTemplate = this.processTemplate(template);
            
            // Create rule from template
            const rule = {
                id: window.devToolsPanel.generateId(),
                name: processedTemplate.name,
                enabled: true,
                created: new Date().toISOString(),
                lastUsed: null,
                lastTested: null,
                lastModified: null,
                testStatus: 'pending',
                hitCount: 0,
                match: processedTemplate.match,
                response: processedTemplate.response,
                testResults: null
            };

            window.devToolsPanel.rules.unshift(rule);
            window.devToolsPanel.saveRules();
            window.devToolsPanel.selectRule(rule.id);
            window.devToolsPanel.switchTab('editor');
        }
    }

    static processTemplate(template) {
        // Process template variables like {{timestamp}}, {{randomId}}, etc.
        const processed = JSON.parse(JSON.stringify(template));
        const templateVars = {
            timestamp: new Date().toISOString(),
            randomId: Math.random().toString(36).substr(2, 9),
            uuid: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                const r = Math.random() * 16 | 0;
                const v = c == 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            })
        };

        // Replace template variables recursively
        const replaceVars = (obj) => {
            if (typeof obj === 'string') {
                return obj.replace(/\{\{(\w+)\}\}/g, (match, key) => templateVars[key] || match);
            } else if (Array.isArray(obj)) {
                return obj.map(replaceVars);
            } else if (obj && typeof obj === 'object') {
                const result = {};
                for (const [key, value] of Object.entries(obj)) {
                    result[key] = replaceVars(value);
                }
                return result;
            }
            return obj;
        };

        return replaceVars(processed);
    }
}

// Initialize the DevTools panel
const devToolsPanel = new DevToolsPanel();

// Export for use in HTML onclick handlers and other scripts
window.devToolsPanel = devToolsPanel;
window.addHeader = addHeader;
window.removeHeader = removeHeader;
window.RuleTemplates = RuleTemplates;
window.formatBytes = formatBytes;
window.formatDuration = formatDuration;
window.copyToClipboard = copyToClipboard;

// Initialize DevTools integration if in DevTools context
if (typeof chrome !== 'undefined' && chrome.devtools) {
    DevToolsIntegration.init();
    DevToolsContextMenu.init();
}

// Handle page unload to save any unsaved changes
window.addEventListener('beforeunload', () => {
    if (devToolsPanel.selectedRule) {
        // Auto-save current rule if modified
        try {
            devToolsPanel.saveRule();
        } catch (error) {
            console.warn('Failed to auto-save rule on unload:', error);
        }
    }
});

// Handle errors globally
window.addEventListener('error', (event) => {
    console.error('DevTools panel error:', event.error);
    if (devToolsPanel) {
        devToolsPanel.updateAnalytics('error', {
            errorType: 'javascript_error',
            message: event.error.message,
            stack: event.error.stack
        });
    }
});

// Performance monitoring
if (typeof performance !== 'undefined' && performance.mark) {
    performance.mark('devtools-panel-loaded');
    
    window.addEventListener('load', () => {
        performance.mark('devtools-panel-ready');
        performance.measure('devtools-init-time', 'devtools-panel-loaded', 'devtools-panel-ready');
        
        const measures = performance.getEntriesByType('measure');
        measures.forEach(measure => {
            if (measure.name === 'devtools-init-time') {
                console.log(`DevTools panel initialization took ${measure.duration.toFixed(2)}ms`);
            }
        });
    });
}
// api-mocker-extension'
//                 },
//                 body: {
//                     message: 'Mock response',
//                     success: true,
//                     timestamp: new Date().toISOString()
//                 },
//                 delay: 0
//             },
//             testResults: null
//         };

//         this.rules.unshift(rule);
//         await this.saveRules();
//         this.selectRule(rule.id);
//         this.switchTab('editor');
//         this.updateAnalytics('ruleCreated', rule.response);
//         this.showNotification('New rule created', 'success');
//     }

//     async createRuleFromRequest(url) {
//         const urlObj = new URL(url);
//         const pathPattern = urlObj.pathname.replace(/\/\d+/g, '/*').replace(/\/[^\/]+\.[^\/]+$/, '/*');
        
//         const rule = {
//             id: this.generateId(),
//             name: `Mock for ${urlObj.pathname}`,
//             enabled: true,
//             created: new Date().toISOString(),
//             lastUsed: null,
//             lastTested: null,
//             lastModified: null,
//             testStatus: 'pending',
//             hitCount: 0,
//             match: {
//                 url: `${urlObj.origin}${pathPattern}`,
//                 method: 'GET'
//             },
//             response: {
//                 statusCode: 200,
//                 statusText: 'OK',
//                 headers: {
//                     'Content-Type': 'application/json',
//                     'X-Mock-Source': '