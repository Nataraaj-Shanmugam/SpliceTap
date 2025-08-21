/**
 * API Mocker Extension - Background Script (Service Worker)
 * Handles request interception, rule matching, and response modification
 * Compatible with Manifest V3
 */

class APIMockerBackground {
    constructor() {
        this.rules = [];
        this.isActive = true;
        this.stats = { intercepted: 0, rulesCount: 0 };
        this.requestCache = new Map();
        
        this.init();
    }

    /**
     * Initialize the background script
     */
    async init() {
        try {
            // Load stored data
            await this.loadStoredData();
            
            // Setup request interception
            this.setupRequestInterception();
            
            // Setup message listeners
            this.setupMessageListeners();
            
            // Setup context menus
            this.setupContextMenus();
            
            // Setup extension lifecycle handlers
            this.setupLifecycleHandlers();
            
            console.log('🎭 API Mocker background script initialized');
        } catch (error) {
            console.error('Failed to initialize background script:', error);
        }
    }

    /**
     * Load stored rules and settings
     */
    async loadStoredData() {
        try {
            const result = await chrome.storage.local.get([
                'apiMockerRules',
                'apiMockerActive', 
                'apiMockerStats'
            ]);

            this.rules = result.apiMockerRules || [];
            this.isActive = result.apiMockerActive !== false;
            this.stats = result.apiMockerStats || { intercepted: 0, rulesCount: this.rules.length };
            
            // Update badge
            this.updateBadge();
            
        } catch (error) {
            console.error('Error loading stored data:', error);
        }
    }

    /**
     * Setup request interception using webRequest API
     */
    setupRequestInterception() {
        // Intercept requests before they're sent
        chrome.webRequest.onBeforeRequest.addListener(
            this.handleBeforeRequest.bind(this),
            { urls: ['<all_urls>'] },
            ['requestBody']
        );

        // Intercept response headers
        chrome.webRequest.onHeadersReceived.addListener(
            this.handleHeadersReceived.bind(this),
            { urls: ['<all_urls>'] },
            ['responseHeaders', 'extraHeaders']
        );

        // Handle completed requests for statistics
        chrome.webRequest.onCompleted.addListener(
            this.handleRequestCompleted.bind(this),
            { urls: ['<all_urls>'] }
        );
    }

    /**
     * Handle request before it's sent - main interception point
     */
    handleBeforeRequest(details) {
        if (!this.isActive) return {};

        // Skip extension's own requests
        if (this.isExtensionRequest(details.url)) {
            return {};
        }

        // Find matching rule
        const matchingRule = this.findMatchingRule(details);
        
        if (matchingRule && matchingRule.enabled) {
            // Store request details for response modification
            this.requestCache.set(details.requestId, {
                rule: matchingRule,
                originalDetails: details,
                timestamp: Date.now()
            });

            // Update rule hit count
            matchingRule.hitCount = (matchingRule.hitCount || 0) + 1;
            matchingRule.lastUsed = new Date().toISOString();
            
            // Save updated rules
            this.saveRules();
            
            // Update statistics
            this.updateStats();
            
            // If rule has a delay, we need to handle it in headers received
            if (matchingRule.delay && matchingRule.delay > 0) {
                // Let the request continue, we'll handle the delay in response
                return {};
            }

            // For immediate response override, we need to redirect to data URL
            if (this.shouldOverrideImmediately(matchingRule)) {
                const mockResponse = this.createMockResponse(matchingRule, details);
                return this.createDataUrlRedirect(mockResponse);
            }
        }

        return {};
    }

    /**
     * Handle response headers - modify response if needed
     */
    handleHeadersReceived(details) {
        if (!this.isActive) return {};

        const cachedRequest = this.requestCache.get(details.requestId);
        if (!cachedRequest || !cachedRequest.rule) {
            return {};
        }

        const rule = cachedRequest.rule;
        
        // Handle delayed responses
        if (rule.delay && rule.delay > 0) {
            // Simulate delay by returning empty response first
            setTimeout(() => {
                this.sendDelayedResponse(details, rule);
            }, rule.delay);
        }

        // Modify response headers
        const modifiedHeaders = this.modifyResponseHeaders(details.responseHeaders, rule);
        
        // Clean up cache
        this.requestCache.delete(details.requestId);

        return {
            responseHeaders: modifiedHeaders
        };
    }

    /**
     * Handle request completion for statistics
     */
    handleRequestCompleted(details) {
        // Clean up any remaining cache entries
        this.requestCache.delete(details.requestId);
    }

    /**
     * Find matching rule for a request
     */
    findMatchingRule(details) {
        for (const rule of this.rules) {
            if (!rule.enabled) continue;
            
            // Check method match
            if (rule.method && rule.method !== '*' && rule.method !== details.method) {
                continue;
            }
            
            // Check URL match
            if (!this.matchesUrlPattern(details.url, rule.url)) {
                continue;
            }
            
            // Check headers match (if specified)
            if (rule.matchHeaders && !this.matchesHeaders(details, rule.matchHeaders)) {
                continue;
            }
            
            return rule;
        }
        
        return null;
    }

    /**
     * Check if URL matches pattern
     */
    matchesUrlPattern(url, pattern) {
        try {
            if (pattern.includes('*')) {
                // Convert wildcard pattern to regex
                const regexPattern = pattern
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
                    .replace(/\\\*/g, '.*'); // Convert * to .*
                
                const regex = new RegExp('^' + regexPattern + '$', 'i');
                return regex.test(url);
            } else if (pattern.startsWith('/') && pattern.endsWith('/')) {
                // Regex pattern
                const regexBody = pattern.slice(1, -1);
                const regex = new RegExp(regexBody, 'i');
                return regex.test(url);
            } else {
                // Exact match
                return url === pattern || url.includes(pattern);
            }
        } catch (error) {
            console.error('Error matching URL pattern:', error);
            return false;
        }
    }

    /**
     * Check if request headers match rule requirements
     */
    matchesHeaders(details, requiredHeaders) {
        if (!requiredHeaders || Object.keys(requiredHeaders).length === 0) {
            return true;
        }

        const requestHeaders = this.getRequestHeaders(details);
        
        for (const [headerName, expectedValue] of Object.entries(requiredHeaders)) {
            const actualValue = requestHeaders[headerName.toLowerCase()];
            if (!actualValue || actualValue !== expectedValue) {
                return false;
            }
        }
        
        return true;
    }

    /**
     * Get request headers from details
     */
    getRequestHeaders(details) {
        const headers = {};
        
        if (details.requestHeaders) {
            details.requestHeaders.forEach(header => {
                headers[header.name.toLowerCase()] = header.value;
            });
        }
        
        return headers;
    }

    /**
     * Check if request is from the extension itself
     */
    isExtensionRequest(url) {
        return url.startsWith(chrome.runtime.getURL('')) || 
               url.startsWith('chrome-extension://') ||
               url.startsWith('moz-extension://');
    }

    /**
     * Check if rule should override response immediately
     */
    shouldOverrideImmediately(rule) {
        // Override immediately for simple cases
        return !rule.delay || rule.delay === 0;
    }

    /**
     * Create mock response object
     */
    createMockResponse(rule, details) {
        const headers = {
            'Content-Type': 'application/json',
            'X-API-Mocker': 'true',
            'X-Mock-Rule': rule.name,
            ...rule.headers
        };

        return {
            statusCode: rule.statusCode || 200,
            statusText: rule.statusText || 'OK',
            headers: headers,
            body: rule.body || rule.responseBody || {}
        };
    }

    /**
     * Create data URL redirect for mock response
     */
    createDataUrlRedirect(mockResponse) {
        const responseText = typeof mockResponse.body === 'string' 
            ? mockResponse.body 
            : JSON.stringify(mockResponse.body);
        
        const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(responseText)}`;
        
        return {
            redirectUrl: dataUrl
        };
    }

    /**
     * Modify response headers
     */
    modifyResponseHeaders(originalHeaders, rule) {
        const headers = originalHeaders ? [...originalHeaders] : [];
        
        // Add mock identification headers
        headers.push(
            { name: 'X-API-Mocker', value: 'true' },
            { name: 'X-Mock-Rule', value: rule.name }
        );
        
        // Add custom headers from rule
        if (rule.headers) {
            Object.entries(rule.headers).forEach(([name, value]) => {
                // Remove existing header with same name
                const existingIndex = headers.findIndex(h => 
                    h.name.toLowerCase() === name.toLowerCase()
                );
                
                if (existingIndex >= 0) {
                    headers[existingIndex] = { name, value };
                } else {
                    headers.push({ name, value });
                }
            });
        }
        
        // Modify status code header if needed
        if (rule.statusCode && rule.statusCode !== 200) {
            // Note: Can't change status code in headers, only in onBeforeRequest
            // This is a limitation of webRequest API
        }
        
        return headers;
    }

    /**
     * Send delayed response (for rules with delay)
     */
    sendDelayedResponse(details, rule) {
        // Note: This is a simplified approach
        // In a full implementation, you might need to use a more complex method
        // to properly handle delayed responses with different status codes
        
        try {
            // Dispatch custom event to content script if available
            chrome.tabs.sendMessage(details.tabId, {
                type: 'mockResponse',
                requestId: details.requestId,
                response: this.createMockResponse(rule, details)
            }).catch(() => {
                // Tab might not have content script
            });
        } catch (error) {
            console.error('Error sending delayed response:', error);
        }
    }

    /**
     * Setup message listeners for communication with popup and content scripts
     */
    setupMessageListeners() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true; // Keep message channel open for async responses
        });
    }

    /**
     * Handle messages from popup and content scripts
     */
    async handleMessage(message, sender, sendResponse) {
        try {
            switch (message.type) {
                case 'getRules':
                    sendResponse({ rules: this.rules, active: this.isActive, stats: this.stats });
                    break;
                    
                case 'saveRule':
                    await this.saveRule(message.rule);
                    sendResponse({ success: true });
                    break;
                    
                case 'deleteRule':
                    await this.deleteRule(message.ruleId);
                    sendResponse({ success: true });
                    break;
                    
                case 'toggleRule':
                    await this.toggleRule(message.ruleId, message.enabled);
                    sendResponse({ success: true });
                    break;
                    
                case 'toggleExtension':
                    await this.toggleExtension(message.active);
                    sendResponse({ success: true });
                    break;
                    
                case 'testRule':
                    const testResult = await this.testRule(message.rule);
                    sendResponse(testResult);
                    break;
                    
                case 'getStats':
                    sendResponse(this.stats);
                    break;
                    
                case 'exportRules':
                    const exportData = this.exportRules();
                    sendResponse({ data: exportData });
                    break;
                    
                case 'importRules':
                    await this.importRules(message.data);
                    sendResponse({ success: true });
                    break;
                    
                case 'requestComplete':
                    this.handleRequestComplete(message.request);
                    break;
                    
                default:
                    console.warn('Unknown message type:', message.type);
                    sendResponse({ error: 'Unknown message type' });
            }
        } catch (error) {
            console.error('Error handling message:', error);
            sendResponse({ error: error.message });
        }
    }

    /**
     * Save a rule
     */
    async saveRule(rule) {
        const existingIndex = this.rules.findIndex(r => r.id === rule.id);
        
        if (existingIndex >= 0) {
            this.rules[existingIndex] = rule;
        } else {
            this.rules.push(rule);
        }
        
        await this.saveRules();
        this.updateBadge();
    }

    /**
     * Delete a rule
     */
    async deleteRule(ruleId) {
        this.rules = this.rules.filter(r => r.id !== ruleId);
        await this.saveRules();
        this.updateBadge();
    }

    /**
     * Toggle a rule on/off
     */
    async toggleRule(ruleId, enabled) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (rule) {
            rule.enabled = enabled;
            await this.saveRules();
            this.updateBadge();
        }
    }

    /**
     * Toggle extension on/off
     */
    async toggleExtension(active) {
        this.isActive = active;
        await chrome.storage.local.set({ apiMockerActive: active });
        this.updateBadge();
    }

    /**
     * Test a rule
     */
    async testRule(rule) {
        try {
            // Perform validation tests
            const testResults = {
                urlPattern: this.testUrlPattern(rule.url),
                jsonSyntax: this.testJsonSyntax(rule.body || rule.responseBody),
                httpStatus: this.testHttpStatus(rule.statusCode),
                headers: this.testHeaders(rule.headers),
                simulation: await this.testSimulation(rule)
            };
            
            const passed = Object.values(testResults).every(result => result.valid);
            
            // Update rule test status
            const existingRule = this.rules.find(r => r.id === rule.id);
            if (existingRule) {
                existingRule.testStatus = passed ? 'passed' : 'failed';
                existingRule.lastTested = new Date().toISOString();
                existingRule.testResults = testResults;
                await this.saveRules();
            }
            
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
     * Test URL pattern validity
     */
    testUrlPattern(pattern) {
        try {
            if (pattern.includes('*')) {
                const regexPattern = pattern.replace(/\*/g, '.*');
                new RegExp(regexPattern);
                return { valid: true, message: 'Wildcard pattern is valid' };
            } else {
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
        if (!body || (typeof body === 'string' && !body.trim())) {
            return { valid: true, message: 'Empty body (valid)' };
        }
        
        try {
            if (typeof body === 'string') {
                JSON.parse(body);
            }
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
        if (!headers || Object.keys(headers).length === 0) {
            return { valid: true, message: 'No custom headers' };
        }
        
        try {
            if (typeof headers === 'object' && !Array.isArray(headers)) {
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
    async testSimulation(rule) {
        try {
            const mockResponse = this.createMockResponse(rule, {
                url: 'https://example.com/api/test',
                method: rule.method || 'GET'
            });
            
            // Simulate delay if specified
            if (rule.delay > 0) {
                await new Promise(resolve => setTimeout(resolve, Math.min(rule.delay, 1000)));
            }
            
            return { 
                valid: true, 
                message: `Simulation successful (${mockResponse.statusCode})`,
                response: mockResponse
            };
        } catch (error) {
            return { valid: false, message: `Simulation failed: ${error.message}` };
        }
    }

    /**
     * Setup context menus
     */
    setupContextMenus() {
        chrome.contextMenus.removeAll(() => {
            chrome.contextMenus.create({
                id: 'api-mocker-main',
                title: '🎭 API Mocker',
                contexts: ['all']
            });
            
            chrome.contextMenus.create({
                id: 'api-mocker-create-rule',
                parentId: 'api-mocker-main',
                title: 'Mock this Request',
                contexts: ['all']
            });
            
            chrome.contextMenus.create({
                id: 'api-mocker-create-error',
                parentId: 'api-mocker-main',
                title: 'Mock with Error',
                contexts: ['all']
            });
            
            chrome.contextMenus.create({
                id: 'api-mocker-toggle',
                parentId: 'api-mocker-main',
                title: this.isActive ? 'Disable API Mocker' : 'Enable API Mocker',
                contexts: ['all']
            });
        });
        
        chrome.contextMenus.onClicked.addListener((info, tab) => {
            this.handleContextMenuClick(info, tab);
        });
    }

    /**
     * Handle context menu clicks
     */
    handleContextMenuClick(info, tab) {
        switch (info.menuItemId) {
            case 'api-mocker-create-rule':
                this.createRuleFromContext(info, tab);
                break;
                
            case 'api-mocker-create-error':
                this.createErrorRuleFromContext(info, tab);
                break;
                
            case 'api-mocker-toggle':
                this.toggleExtension(!this.isActive);
                break;
        }
    }

    /**
     * Create rule from context menu
     */
    createRuleFromContext(info, tab) {
        const rule = {
            name: `Mock ${info.pageUrl ? new URL(info.pageUrl).pathname : 'Request'}`,
            url: info.pageUrl || '*',
            method: 'GET',
            statusCode: 200,
            statusText: 'OK',
            headers: { 'Content-Type': 'application/json' },
            body: { message: 'Mock response', timestamp: new Date().toISOString() }
        };
        
        // Send to content script to open rule editor
        chrome.tabs.sendMessage(tab.id, {
            type: 'openRuleEditor',
            rule: rule
        });
    }

    /**
     * Create error rule from context menu
     */
    createErrorRuleFromContext(info, tab) {
        const rule = {
            name: `Error ${info.pageUrl ? new URL(info.pageUrl).pathname : 'Request'}`,
            url: info.pageUrl || '*',
            method: 'GET',
            statusCode: 500,
            statusText: 'Internal Server Error',
            headers: { 'Content-Type': 'application/json' },
            body: { error: 'Mock server error', code: 'MOCK_ERROR' }
        };
        
        // Send to content script to open rule editor
        chrome.tabs.sendMessage(tab.id, {
            type: 'openRuleEditor',
            rule: rule
        });
    }

    /**
     * Setup extension lifecycle handlers
     */
    setupLifecycleHandlers() {
        // Handle extension startup
        chrome.runtime.onStartup.addListener(() => {
            this.loadStoredData();
        });
        
        // Handle extension install/update
        chrome.runtime.onInstalled.addListener((details) => {
            this.handleInstall(details);
        });
        
        // Handle tab activation (update badge)
        chrome.tabs.onActivated.addListener(() => {
            this.updateBadge();
        });
    }

    /**
     * Handle extension install/update
     */
    handleInstall(details) {
        if (details.reason === 'install') {
            // First time install
            this.showWelcomeNotification();
        } else if (details.reason === 'update') {
            // Extension updated
            this.handleUpdate(details.previousVersion);
        }
        
        this.setupContextMenus();
    }

    /**
     * Show welcome notification
     */
    showWelcomeNotification() {
        chrome.notifications.create({
            type: 'basic',
            iconUrl: 'assets/icons/icon48.png',
            title: '🎭 API Mocker Installed!',
            message: 'Right-click on any page to start mocking API requests.'
        });
    }

    /**
     * Handle extension update
     */
    handleUpdate(previousVersion) {
        // Perform data migration if needed
        this.migrateData(previousVersion);
        
        // Update context menus
        this.setupContextMenus();
    }

    /**
     * Migrate data from previous versions
     */
    migrateData(previousVersion) {
        // Add migration logic here if needed
        console.log(`Updated from version ${previousVersion}`);
    }

    /**
     * Handle request completion from content script
     */
    handleRequestComplete(request) {
        // Update statistics
        this.updateStats();
        
        // Notify popup if open
        this.notifyPopup('requestComplete', request);
    }

    /**
     * Update extension badge
     */
    updateBadge() {
        const enabledRulesCount = this.rules.filter(r => r.enabled).length;
        
        if (this.isActive && enabledRulesCount > 0) {
            chrome.action.setBadgeText({ text: enabledRulesCount.toString() });
            chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
        } else if (!this.isActive) {
            chrome.action.setBadgeText({ text: '!' });
            chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
        } else {
            chrome.action.setBadgeText({ text: '' });
        }
    }

    /**
     * Update statistics
     */
    updateStats() {
        this.stats.intercepted = (this.stats.intercepted || 0) + 1;
        this.stats.rulesCount = this.rules.length;
        this.stats.lastUpdated = new Date().toISOString();
        
        // Save stats
        chrome.storage.local.set({ apiMockerStats: this.stats });
        
        // Notify popup
        this.notifyPopup('statsUpdated', this.stats);
    }

    /**
     * Save rules to storage
     */
    async saveRules() {
        await chrome.storage.local.set({ 
            apiMockerRules: this.rules 
        });
    }

    /**
     * Export rules
     */
    exportRules() {
        return {
            version: '1.0',
            rules: this.rules,
            exported: new Date().toISOString()
        };
    }

    /**
     * Import rules
     */
    async importRules(data) {
        if (data.rules && Array.isArray(data.rules)) {
            this.rules = [...this.rules, ...data.rules];
            await this.saveRules();
            this.updateBadge();
        }
    }

    /**
     * Notify popup of changes
     */
    notifyPopup(type, data) {
        chrome.runtime.sendMessage({ type, data }).catch(() => {
            // Popup might not be open
        });
    }

    /**
     * Utility delay function
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Initialize background script
const apiMockerBackground = new APIMockerBackground();

// Handle extension lifecycle
chrome.runtime.onInstalled.addListener(() => {
    console.log('🎭 API Mocker extension installed/updated');
});

// Keep service worker alive
chrome.runtime.onMessage.addListener(() => {
    // This listener helps prevent the service worker from being terminated
    return true;
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = APIMockerBackground;
}