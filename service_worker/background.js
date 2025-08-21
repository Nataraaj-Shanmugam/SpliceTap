/**
 * TurboMock Background Service Worker
 * Manifest V3 compliant request interception and rule management
 */

// Import utilities
importScripts(
  chrome.runtime.getURL('src/utils.js'),
  chrome.runtime.getURL('src/storage.js')
);


class TurboMockBackground {
    constructor() {
        this.storage = new TurboMockStorage();
        this.rules = [];
        this.isActive = true;
        this.stats = { intercepted: 0, rulesCount: 0 };
        this.requestCache = new Map();
        this.contextMenuCreated = false;
        this.declarativeRules = [];
        
        this.init();
    }

    async init() {
        try {
            await this.loadStoredData();
            await this.setupDeclarativeNetRequest();
            this.setupMessageHandlers();
            this.setupContextMenus();
            this.setupExtensionLifecycle();
            
            console.log('🎭 TurboMock background service worker initialized');
        } catch (error) {
            console.error('Failed to initialize background service worker:', error);
        }
    }

    // Data Management
    async loadStoredData() {
        try {
            const data = await this.storage.loadAll();
            this.rules = data.rules;
            this.isActive = data.active;
            this.stats = data.stats;
            this.settings = data.settings;
            
            this.updateBadge();
            
        } catch (error) {
            console.error('Error loading stored data:', error);
        }
    }

    async saveData() {
        try {
            await this.storage.saveRules(this.rules);
            await this.storage.saveActiveState(this.isActive);
            await this.storage.updateStats(this.stats);
        } catch (error) {
            console.error('Error saving data:', error);
        }
    }

    // Manifest V3 Request Interception using DeclarativeNetRequest
    async setupDeclarativeNetRequest() {
        try {
            // Clear existing rules
            const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
            if (existingRules.length > 0) {
                await chrome.declarativeNetRequest.updateDynamicRules({
                    removeRuleIds: existingRules.map(rule => rule.id)
                });
            }

            // Create rules for active mock rules
            await this.updateDeclarativeRules();
            
        } catch (error) {
            console.error('Failed to setup declarative net request:', error);
        }
    }

    async updateDeclarativeRules() {
        if (!this.isActive) {
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: this.declarativeRules.map(rule => rule.id)
            });
            this.declarativeRules = [];
            return;
        }

        const newRules = [];
        let ruleId = 1;

        for (const rule of this.rules) {
            if (!rule.enabled) continue;

            try {
                // Create URL filter from pattern
                const urlFilter = this.convertPatternToFilter(rule.match.url);
                if (!urlFilter) continue;

                // Create declarative rule
                const declarativeRule = {
                    id: ruleId++,
                    priority: 1,
                    action: {
                        type: 'redirect',
                        redirect: {
                            url: this.createMockResponseUrl(rule)
                        }
                    },
                    condition: {
                        urlFilter: urlFilter,
                        resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame']
                    }
                };

                // Add method filter if specified
                if (rule.match.method && rule.match.method !== '*') {
                    declarativeRule.condition.requestMethods = [rule.match.method.toLowerCase()];
                }

                newRules.push(declarativeRule);
            } catch (error) {
                console.error(`Failed to create declarative rule for ${rule.name}:`, error);
            }
        }

        // Update rules
        try {
            await chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: this.declarativeRules.map(rule => rule.id),
                addRules: newRules
            });
            this.declarativeRules = newRules;
        } catch (error) {
            console.error('Failed to update declarative rules:', error);
        }
    }

    convertPatternToFilter(pattern) {
        if (!pattern) return null;
        
        try {
            // Convert wildcard patterns to declarativeNetRequest format
            if (pattern.includes('*')) {
                return pattern.replace(/\*/g, '*');
            } else if (pattern.startsWith('/') && pattern.endsWith('/')) {
                // Regex patterns not directly supported, convert to wildcard
                const regexBody = pattern.slice(1, -1);
                return `*${regexBody}*`;
            } else {
                return `*${pattern}*`;
            }
        } catch (error) {
            console.error('Error converting pattern to filter:', error);
            return null;
        }
    }

    createMockResponseUrl(rule) {
        try {
            // Create a data URL with the mock response
            const responseBody = typeof rule.response.body === 'string' 
                ? rule.response.body 
                : JSON.stringify(rule.response.body);

            const contentType = rule.response.headers?.['Content-Type'] || 'application/json';
            return `data:${contentType};charset=utf-8,${encodeURIComponent(responseBody)}`;
        } catch (error) {
            console.error('Error creating mock response URL:', error);
            return 'data:application/json;charset=utf-8,{"error":"Mock response generation failed"}';
        }
    }

    // Context Menus
    setupContextMenus() {
        if (this.contextMenuCreated) return;

        chrome.contextMenus.removeAll(() => {
            chrome.contextMenus.create({
                id: 'turbomock-main',
                title: '🎭 TurboMock',
                contexts: ['page', 'link']
            });
            
            chrome.contextMenus.create({
                id: 'turbomock-create-rule',
                parentId: 'turbomock-main',
                title: 'Mock this Request',
                contexts: ['page', 'link']
            });
            
            chrome.contextMenus.create({
                id: 'turbomock-create-error',
                parentId: 'turbomock-main',
                title: 'Mock with Error',
                contexts: ['page', 'link']
            });
            
            chrome.contextMenus.create({
                id: 'turbomock-separator',
                parentId: 'turbomock-main',
                type: 'separator',
                contexts: ['page', 'link']
            });
            
            chrome.contextMenus.create({
                id: 'turbomock-toggle',
                parentId: 'turbomock-main',
                title: this.isActive ? 'Disable TurboMock' : 'Enable TurboMock',
                contexts: ['page', 'link']
            });

            this.contextMenuCreated = true;
        });
        
        chrome.contextMenus.onClicked.addListener((info, tab) => {
            this.handleContextMenuClick(info, tab);
        });
    }

    handleContextMenuClick(info, tab) {
        switch (info.menuItemId) {
            case 'turbomock-create-rule':
                this.createRuleFromContext(info, tab);
                break;
                
            case 'turbomock-create-error':
                this.createErrorRuleFromContext(info, tab);
                break;
                
            case 'turbomock-toggle':
                this.toggleExtension();
                break;
        }
    }

    createRuleFromContext(info, tab) {
        const rule = TurboMockUtils.createRuleTemplate('success');
        rule.name = `Mock ${this.extractUrlPath(info.pageUrl)}`;
        rule.match.url = this.createUrlPattern(info.pageUrl);
        
        this.notifyRuleCreation(tab, rule);
    }

    createErrorRuleFromContext(info, tab) {
        const rule = TurboMockUtils.createRuleTemplate('error');
        rule.name = `Error ${this.extractUrlPath(info.pageUrl)}`;
        rule.match.url = this.createUrlPattern(info.pageUrl);
        
        this.notifyRuleCreation(tab, rule);
    }

    extractUrlPath(url) {
        try {
            const urlObj = new URL(url);
            return urlObj.pathname || '/';
        } catch {
            return 'Request';
        }
    }

    createUrlPattern(url) {
        try {
            const urlObj = new URL(url);
            return `*${urlObj.pathname}*`;
        } catch {
            return '*';
        }
    }

    notifyRuleCreation(tab, rule) {
        chrome.tabs.sendMessage(tab.id, {
            type: 'openRuleEditor',
            rule: rule
        }).catch(() => {
            console.warn('Could not send rule creation message to tab');
        });
    }

    // Message Handling
    setupMessageHandlers() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
            return true; // Keep message channel open for async responses
        });
    }

    async handleMessage(message, sender, sendResponse) {
        try {
            switch (message.type) {
                case 'getRules':
                    sendResponse({ 
                        success: true,
                        rules: this.rules, 
                        active: this.isActive, 
                        stats: this.stats 
                    });
                    break;
                    
                case 'saveRule':
                    const saveResult = await this.storage.saveRule(message.rule);
                    if (saveResult.success) {
                        await this.loadStoredData();
                        await this.updateDeclarativeRules();
                        this.updateBadge();
                    }
                    sendResponse(saveResult);
                    break;
                    
                case 'deleteRule':
                    const deleteResult = await this.storage.deleteRule(message.ruleId);
                    if (deleteResult.success) {
                        await this.loadStoredData();
                        await this.updateDeclarativeRules();
                        this.updateBadge();
                    }
                    sendResponse(deleteResult);
                    break;
                    
                case 'toggleRule':
                    const toggleResult = await this.storage.toggleRule(message.ruleId, message.enabled);
                    if (toggleResult.success) {
                        await this.loadStoredData();
                        await this.updateDeclarativeRules();
                        this.updateBadge();
                    }
                    sendResponse(toggleResult);
                    break;
                    
                case 'updateStats':
                    const statsResult = await this.storage.updateStats(message.stats);
                    if (statsResult.success) {
                        this.stats = statsResult.stats;
                    }
                    sendResponse(statsResult);
                    break;
                    
                case 'getStats':
                    sendResponse({ 
                        success: true,
                        stats: this.stats 
                    });
                    break;
                    
                case 'testRule':
                    const testResult = await this.testRule(message.rule);
                    sendResponse(testResult);
                    break;
                    
                case 'toggleExtension':
                    await this.toggleExtension(message.active);
                    sendResponse({ 
                        success: true, 
                        active: this.isActive 
                    });
                    break;

                case 'statusChanged':
                    await this.toggleExtension(message.active);
                    sendResponse({ success: true });
                    break;

                case 'ruleToggled':
                    // Update stats when rule is toggled
                    await this.storage.updateStats({ 
                        rulesCount: this.rules.length,
                        lastUpdated: new Date().toISOString() 
                    });
                    sendResponse({ success: true });
                    break;

                case 'requestIntercepted':
                    // Update intercept stats
                    this.stats.intercepted = (this.stats.intercepted || 0) + 1;
                    await this.storage.updateStats(this.stats);
                    sendResponse({ success: true });
                    break;

                case 'getDevToolsData':
                    sendResponse({
                        success: true,
                        stats: {
                            total: this.stats.intercepted || 0,
                            mocked: Math.floor((this.stats.intercepted || 0) * 0.3), // Estimate
                            activeRules: this.rules.filter(r => r.enabled).length,
                            successRate: 85 // Estimate
                        },
                        requests: [] // Would be populated by content script
                    });
                    break;
                    
                default:
                    console.warn('Unknown message type:', message.type);
                    sendResponse({ success: false, error: 'Unknown message type' });
            }
        } catch (error) {
            console.error('Error handling message:', error);
            sendResponse({ success: false, error: error.message });
        }
    }

    async testRule(rule) {
        try {
            const testResults = {
                passed: true,
                errors: [],
                warnings: []
            };
            
            // Test URL pattern
            const urlValidation = TurboMockUtils.validateUrlPattern(rule.match.url);
            if (!urlValidation.isValid) {
                testResults.errors.push(`Invalid URL pattern: ${urlValidation.error}`);
                testResults.passed = false;
            }
            
            // Test response body JSON
            if (rule.response.body) {
                const jsonValidation = TurboMockUtils.validateJSON(JSON.stringify(rule.response.body));
                if (!jsonValidation.isValid) {
                    testResults.errors.push(`Invalid response body: ${jsonValidation.error}`);
                    testResults.passed = false;
                }
            }
            
            // Test status code
            const statusValidation = TurboMockUtils.validateStatusCode(rule.response.statusCode);
            if (!statusValidation.isValid) {
                testResults.errors.push(`Invalid status code: ${statusValidation.error}`);
                testResults.passed = false;
            }
            
            // Test delay
            if (rule.response.delay && (isNaN(rule.response.delay) || rule.response.delay < 0)) {
                testResults.errors.push('Invalid delay value: must be a positive number');
                testResults.passed = false;
            }
            
            // Warnings
            if (rule.response.delay && rule.response.delay > 10000) {
                testResults.warnings.push('Very long delay (>10s) may cause timeouts');
            }
            
            if (!rule.response.headers || Object.keys(rule.response.headers).length === 0) {
                testResults.warnings.push('No response headers specified');
            }
            
            return {
                success: true,
                passed: testResults.passed,
                results: testResults
            };
            
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Extension Management
    async toggleExtension(active = null) {
        this.isActive = active !== null ? active : !this.isActive;
        await this.storage.saveActiveState(this.isActive);
        await this.updateDeclarativeRules();
        this.updateBadge();
        this.updateContextMenus();
        
        // Show notification
        try {
            await chrome.notifications.create({
                type: 'basic',
                iconUrl: 'assets/icons/icon-48.png',
                title: 'TurboMock',
                message: `Extension ${this.isActive ? 'enabled' : 'disabled'}`
            });
        } catch (error) {
            // Notifications might be blocked
            console.warn('Could not show notification:', error);
        }
    }

    updateBadge() {
        const enabledRulesCount = this.rules.filter(r => r.enabled).length;
        
        try {
            if (this.isActive && enabledRulesCount > 0) {
                chrome.action.setBadgeText({ text: enabledRulesCount.toString() });
                chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
                chrome.action.setTitle({ title: `TurboMock: ${enabledRulesCount} active rules` });
            } else if (!this.isActive) {
                chrome.action.setBadgeText({ text: '!' });
                chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
                chrome.action.setTitle({ title: 'TurboMock: Disabled' });
            } else {
                chrome.action.setBadgeText({ text: '' });
                chrome.action.setTitle({ title: 'TurboMock: No active rules' });
            }
        } catch (error) {
            console.warn('Failed to update badge:', error);
        }
    }

    updateContextMenus() {
        if (!this.contextMenuCreated) return;
        
        try {
            chrome.contextMenus.update('turbomock-toggle', {
                title: this.isActive ? 'Disable TurboMock' : 'Enable TurboMock'
            });
        } catch (error) {
            console.warn('Failed to update context menus:', error);
        }
    }

    // Extension Lifecycle
    setupExtensionLifecycle() {
        chrome.runtime.onInstalled.addListener((details) => {
            this.handleInstall(details);
        });
        
        chrome.runtime.onStartup.addListener(() => {
            this.loadStoredData();
        });
        
        chrome.tabs.onActivated.addListener(() => {
            this.updateBadge();
        });

        // Handle command shortcuts
        chrome.commands.onCommand.addListener((command) => {
            this.handleCommand(command);
        });
    }

    async handleCommand(command) {
        switch (command) {
            case 'toggle-extension':
                await this.toggleExtension();
                break;
            case 'new-rule':
                // Open popup or options page
                try {
                    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tabs[0]) {
                        chrome.tabs.sendMessage(tabs[0].id, {
                            type: 'openRuleEditor',
                            rule: null
                        });
                    }
                } catch (error) {
                    chrome.runtime.openOptionsPage();
                }
                break;
        }
    }

    handleInstall(details) {
        if (details.reason === 'install') {
            this.showWelcomeNotification();
            this.setupContextMenus();
            // Open options page on first install
            chrome.runtime.openOptionsPage();
        } else if (details.reason === 'update') {
            this.handleUpdate(details.previousVersion);
        }
    }

    async showWelcomeNotification() {
        try {
            await chrome.notifications.create({
                type: 'basic',
                iconUrl: 'assets/icons/icon-48.png',
                title: '🎭 TurboMock Installed!',
                message: 'Right-click on any page to start mocking API requests.'
            });
        } catch (error) {
            console.warn('Could not show welcome notification:', error);
        }
    }

    handleUpdate(previousVersion) {
        console.log(`TurboMock updated from version ${previousVersion}`);
        this.setupContextMenus();
        
        // Migrate data if needed
        this.storage.migrateData(previousVersion, chrome.runtime.getManifest().version);
    }
}

// Initialize background service worker
let turboMockBackground;

// Handle service worker lifecycle
self.addEventListener('install', (event) => {
    console.log('TurboMock service worker installed');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('TurboMock service worker activated');
    event.waitUntil(
        clients.claim().then(() => {
            turboMockBackground = new TurboMockBackground();
        })
    );
});

// Keep service worker alive
chrome.runtime.onConnect.addListener((port) => {
    console.log('Port connected:', port.name);
    
    port.onDisconnect.addListener(() => {
        console.log('Port disconnected:', port.name);
    });
});

// Initialize if not already done
if (!turboMockBackground) {
    turboMockBackground = new TurboMockBackground();
}