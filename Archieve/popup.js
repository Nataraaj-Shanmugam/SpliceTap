/**
 * API Mocker Extension - Popup JavaScript
 * Handles all popup interactions, rule management, and Chrome extension APIs
 */

class APIPopup {
    constructor() {
        this.rules = [];
        this.filteredRules = [];
        this.isActive = true;
        this.stats = { intercepted: 0, rulesCount: 0 };
        
        this.init();
    }

    /**
     * Initialize the popup
     */
    async init() {
        try {
            await this.loadData();
            this.setupEventListeners();
            this.renderRules();
            this.updateStatus();
            this.updateStats();
            
            // Animate popup entrance
            document.body.classList.add('loaded');
        } catch (error) {
            console.error('Failed to initialize popup:', error);
            this.showError('Failed to load extension data');
        }
    }

    /**
     * Load rules and extension state from storage
     */
    async loadData() {
        try {
            // Load from Chrome storage
            const result = await chrome.storage.local.get([
                'apiMockerRules', 
                'apiMockerActive', 
                'apiMockerStats'
            ]);

            this.rules = result.apiMockerRules || this.getDefaultRules();
            this.isActive = result.apiMockerActive !== false; // Default to true
            this.stats = result.apiMockerStats || { intercepted: 23, rulesCount: this.rules.length };
            this.filteredRules = [...this.rules];

        } catch (error) {
            console.error('Error loading data:', error);
            // Fallback to default rules
            this.rules = this.getDefaultRules();
            this.filteredRules = [...this.rules];
        }
    }

    /**
     * Get default rules for demo/initial state
     */
    getDefaultRules() {
        return [
            {
                id: 'rule-1',
                name: 'User Profile Success',
                enabled: true,
                method: 'GET',
                url: '*/api/users/*',
                statusCode: 200,
                statusText: 'OK',
                responseBody: { id: 'user_123', name: 'John Doe', email: 'john@example.com' },
                testStatus: 'passed',
                hitCount: 15,
                created: new Date().toISOString()
            },
            {
                id: 'rule-2',
                name: 'Payment Error',
                enabled: false,
                method: 'POST',
                url: '*/api/payments',
                statusCode: 402,
                statusText: 'Payment Required',
                responseBody: { error: 'Insufficient funds', code: 'PAYMENT_FAILED' },
                testStatus: 'warning',
                hitCount: 3,
                created: new Date().toISOString()
            },
            {
                id: 'rule-3',
                name: 'Slow Network Test',
                enabled: true,
                method: 'GET',
                url: '*/api/*',
                statusCode: 200,
                statusText: 'OK',
                delay: 3000,
                responseBody: { data: 'delayed response' },
                testStatus: 'pending',
                hitCount: 8,
                created: new Date().toISOString()
            },
            {
                id: 'rule-4',
                name: 'Product Catalog',
                enabled: true,
                method: 'GET',
                url: '*/api/products',
                statusCode: 200,
                statusText: 'OK',
                responseBody: { products: [], total: 0 },
                testStatus: 'passed',
                hitCount: 42,
                created: new Date().toISOString()
            }
        ];
    }

    /**
     * Setup all event listeners
     */
    setupEventListeners() {
        // Header actions
        document.querySelector('[title="Settings"]').addEventListener('click', () => this.openSettings());
        document.querySelector('[title="Import/Export"]').addEventListener('click', () => this.openImportExport());
        document.querySelector('[title="Refresh"]').addEventListener('click', () => this.refreshData());

        // Search functionality
        document.querySelector('.search-input').addEventListener('input', (e) => this.handleSearch(e));

        // Footer actions
        document.querySelector('.primary-btn').addEventListener('click', () => this.createNewRule());
        document.querySelector('[title="Test All"]').addEventListener('click', () => this.testAllRules());
        document.querySelector('[title="Help"]').addEventListener('click', () => this.openHelp());

        // Global toggle (click on status)
        document.querySelector('.status').addEventListener('click', () => this.toggleGlobalStatus());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));

        // Listen for extension state changes
        chrome.runtime.onMessage?.addListener((message) => this.handleMessage(message));
    }

    /**
     * Render rules list
     */
    renderRules() {
        const container = document.querySelector('.rules-container');
        
        if (this.filteredRules.length === 0) {
            container.innerHTML = this.getEmptyStateHTML();
            return;
        }

        container.innerHTML = this.filteredRules
            .map(rule => this.getRuleCardHTML(rule))
            .join('');

        // Attach event listeners to rule cards
        this.attachRuleEventListeners();
    }

    /**
     * Get HTML for a rule card
     */
    getRuleCardHTML(rule) {
        const statusIcon = this.getStatusIcon(rule.testStatus);
        const methodClass = `method-${rule.method.toLowerCase()}`;
        const enabledClass = rule.enabled ? '' : 'disabled';
        const checkedClass = rule.enabled ? 'checked' : '';

        return `
            <div class="rule-card ${enabledClass}" data-rule-id="${rule.id}">
                <div class="rule-header">
                    <div class="rule-info">
                        <div class="rule-name">
                            <div class="rule-checkbox ${checkedClass}" data-rule-id="${rule.id}"></div>
                            ${this.escapeHtml(rule.name)}
                        </div>
                        <div class="rule-details">
                            <span class="rule-method ${methodClass}">${rule.method}</span>
                            ${this.escapeHtml(rule.url)} → ${rule.statusCode} ${rule.statusText}
                            ${rule.delay ? ` (+${rule.delay}ms)` : ''}
                        </div>
                    </div>
                    <div class="status-indicator" title="${this.getStatusTooltip(rule.testStatus)}">${statusIcon}</div>
                </div>
                <div class="rule-actions">
                    <button class="rule-action" title="Edit" data-action="edit" data-rule-id="${rule.id}">✏️</button>
                    <button class="rule-action" title="Copy" data-action="copy" data-rule-id="${rule.id}">📋</button>
                    <button class="rule-action" title="Test" data-action="test" data-rule-id="${rule.id}">🧪</button>
                    <button class="rule-action" title="Delete" data-action="delete" data-rule-id="${rule.id}">🗑️</button>
                </div>
            </div>
        `;
    }

    /**
     * Get empty state HTML
     */
    getEmptyStateHTML() {
        return `
            <div class="empty-state">
                <div class="empty-icon">🎭</div>
                <div class="empty-title">No rules found</div>
                <div class="empty-description">
                    Create your first API mock rule to get started.<br>
                    Right-click on network requests or use the "New Rule" button.
                </div>
            </div>
        `;
    }

    /**
     * Attach event listeners to rule cards
     */
    attachRuleEventListeners() {
        // Rule checkboxes
        document.querySelectorAll('.rule-checkbox').forEach(checkbox => {
            checkbox.addEventListener('click', (e) => this.toggleRule(e));
        });

        // Rule cards (click to edit)
        document.querySelectorAll('.rule-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (!e.target.closest('.rule-checkbox') && !e.target.closest('.rule-action')) {
                    this.editRule(card.dataset.ruleId);
                }
            });
        });

        // Rule actions
        document.querySelectorAll('.rule-action').forEach(btn => {
            btn.addEventListener('click', (e) => this.handleRuleAction(e));
        });
    }

    /**
     * Handle rule checkbox toggle
     */
    async toggleRule(e) {
        e.stopPropagation();
        
        const ruleId = e.target.dataset.ruleId;
        const rule = this.rules.find(r => r.id === ruleId);
        
        if (!rule) return;

        rule.enabled = !rule.enabled;
        e.target.classList.toggle('checked', rule.enabled);
        
        const card = e.target.closest('.rule-card');
        card.classList.toggle('disabled', !rule.enabled);

        // Save to storage and notify background script
        await this.saveRules();
        this.notifyBackgroundScript('ruleToggled', { ruleId, enabled: rule.enabled });
        this.updateStatus();
    }

    /**
     * Handle rule action buttons
     */
    async handleRuleAction(e) {
        e.stopPropagation();
        
        const action = e.target.dataset.action;
        const ruleId = e.target.dataset.ruleId;
        
        switch (action) {
            case 'edit':
                this.editRule(ruleId);
                break;
            case 'copy':
                await this.copyRule(ruleId);
                break;
            case 'test':
                await this.testRule(ruleId);
                break;
            case 'delete':
                await this.deleteRule(ruleId);
                break;
        }
    }

    /**
     * Edit rule (open rule editor)
     */
    editRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        // Send message to open rule editor
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, {
                type: 'openRuleEditor',
                rule: rule
            });
        });

        // Close popup
        window.close();
    }

    /**
     * Copy rule
     */
    async copyRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        const newRule = {
            ...rule,
            id: this.generateId(),
            name: `${rule.name} (Copy)`,
            enabled: false,
            hitCount: 0,
            created: new Date().toISOString()
        };

        this.rules.push(newRule);
        this.filteredRules = [...this.rules];
        
        await this.saveRules();
        this.renderRules();
        this.updateStatus();
        this.showNotification('Rule copied successfully');
    }

    /**
     * Test rule
     */
    async testRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        try {
            // Show testing state
            const statusIndicator = document.querySelector(`[data-rule-id="${ruleId}"]`).querySelector('.status-indicator');
            const originalIcon = statusIndicator.textContent;
            statusIndicator.textContent = '⏳';

            // Simulate test (in real implementation, this would validate the rule)
            await this.delay(1000);

            // Update test result
            const testPassed = Math.random() > 0.2; // 80% success rate for demo
            rule.testStatus = testPassed ? 'passed' : 'failed';
            rule.lastTested = new Date().toISOString();

            // Update UI
            statusIndicator.textContent = this.getStatusIcon(rule.testStatus);
            
            await this.saveRules();
            this.showNotification(`Test ${testPassed ? 'passed' : 'failed'}: ${rule.name}`);

        } catch (error) {
            console.error('Test failed:', error);
            this.showError('Test failed');
        }
    }

    /**
     * Delete rule
     */
    async deleteRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        if (confirm(`Delete rule "${rule.name}"?`)) {
            this.rules = this.rules.filter(r => r.id !== ruleId);
            this.filteredRules = this.filteredRules.filter(r => r.id !== ruleId);
            
            await this.saveRules();
            this.renderRules();
            this.updateStatus();
            this.showNotification('Rule deleted');
        }
    }

    /**
     * Handle search input
     */
    handleSearch(e) {
        const searchTerm = e.target.value.toLowerCase().trim();
        
        if (!searchTerm) {
            this.filteredRules = [...this.rules];
        } else {
            this.filteredRules = this.rules.filter(rule => 
                rule.name.toLowerCase().includes(searchTerm) ||
                rule.url.toLowerCase().includes(searchTerm) ||
                rule.method.toLowerCase().includes(searchTerm)
            );
        }
        
        this.renderRules();
    }

    /**
     * Create new rule
     */
    createNewRule() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            chrome.tabs.sendMessage(tabs[0].id, {
                type: 'openRuleEditor',
                rule: null // New rule
            });
        });
        
        window.close();
    }

    /**
     * Test all rules
     */
    async testAllRules() {
        const enabledRules = this.rules.filter(r => r.enabled);
        
        if (enabledRules.length === 0) {
            this.showNotification('No enabled rules to test');
            return;
        }

        // Update button state
        const testBtn = document.querySelector('[title="Test All"]');
        const originalText = testBtn.textContent;
        testBtn.textContent = '⏳ Testing...';
        testBtn.disabled = true;

        try {
            for (const rule of enabledRules) {
                await this.testRule(rule.id);
                await this.delay(500); // Stagger tests
            }
            
            this.showNotification(`Tested ${enabledRules.length} rules`);
        } catch (error) {
            this.showError('Testing failed');
        } finally {
            testBtn.textContent = originalText;
            testBtn.disabled = false;
        }
    }

    /**
     * Toggle global extension status
     */
    async toggleGlobalStatus() {
        this.isActive = !this.isActive;
        
        await chrome.storage.local.set({ apiMockerActive: this.isActive });
        this.notifyBackgroundScript('statusChanged', { active: this.isActive });
        
        this.updateStatus();
        this.showNotification(`Extension ${this.isActive ? 'enabled' : 'disabled'}`);
    }

    /**
     * Update status display
     */
    updateStatus() {
        const statusDot = document.querySelector('.status-dot');
        const statusText = document.querySelector('.status-text');
        const enabledCount = this.rules.filter(r => r.enabled).length;
        
        if (this.isActive) {
            statusDot.style.background = '#10b981';
            statusText.textContent = `Active (${enabledCount} rules)`;
        } else {
            statusDot.style.background = '#ef4444';
            statusText.textContent = 'Disabled';
        }
    }

    /**
     * Update stats display
     */
    updateStats() {
        const statsElement = document.querySelector('.stats span:last-child');
        if (statsElement) {
            statsElement.textContent = `Intercepted: ${this.stats.intercepted} requests today`;
        }
    }

    /**
     * Open settings
     */
    openSettings() {
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
        window.close();
    }

    /**
     * Open import/export dialog
     */
    openImportExport() {
        // Create a simple import/export interface
        const exportData = {
            version: '1.0',
            rules: this.rules,
            exported: new Date().toISOString()
        };

        const dataStr = JSON.stringify(exportData, null, 2);
        const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
        
        const exportFileDefaultName = `api-mocker-rules-${new Date().toISOString().split('T')[0]}.json`;
        
        const linkElement = document.createElement('a');
        linkElement.setAttribute('href', dataUri);
        linkElement.setAttribute('download', exportFileDefaultName);
        linkElement.click();
        
        this.showNotification('Rules exported successfully');
    }

    /**
     * Refresh data
     */
    async refreshData() {
        try {
            await this.loadData();
            this.renderRules();
            this.updateStatus();
            this.updateStats();
            this.showNotification('Data refreshed');
        } catch (error) {
            this.showError('Failed to refresh data');
        }
    }

    /**
     * Open help
     */
    openHelp() {
        chrome.tabs.create({ url: 'https://github.com/your-repo/api-mocker#readme' });
        window.close();
    }

    /**
     * Handle keyboard shortcuts
     */
    handleKeyboardShortcuts(e) {
        if (e.ctrlKey || e.metaKey) {
            switch (e.key) {
                case 'n':
                    e.preventDefault();
                    this.createNewRule();
                    break;
                case 'f':
                    e.preventDefault();
                    document.querySelector('.search-input').focus();
                    break;
                case 't':
                    e.preventDefault();
                    this.testAllRules();
                    break;
            }
        }

        if (e.key === 'Escape') {
            window.close();
        }
    }

    /**
     * Handle messages from background script
     */
    handleMessage(message) {
        switch (message.type) {
            case 'statsUpdated':
                this.stats = message.stats;
                this.updateStats();
                break;
            case 'ruleTriggered':
                // Update hit count for rule
                const rule = this.rules.find(r => r.id === message.ruleId);
                if (rule) {
                    rule.hitCount = (rule.hitCount || 0) + 1;
                    this.saveRules();
                }
                break;
        }
    }

    /**
     * Save rules to storage
     */
    async saveRules() {
        try {
            await chrome.storage.local.set({ 
                apiMockerRules: this.rules,
                apiMockerStats: { ...this.stats, rulesCount: this.rules.length }
            });
        } catch (error) {
            console.error('Failed to save rules:', error);
        }
    }

    /**
     * Notify background script
     */
    notifyBackgroundScript(type, data) {
        chrome.runtime.sendMessage({ type, ...data }).catch(() => {
            // Ignore errors if background script is not ready
        });
    }

    /**
     * Utility functions
     */
    getStatusIcon(status) {
        switch (status) {
            case 'passed': return '✅';
            case 'failed': return '❌';
            case 'warning': return '⚠️';
            case 'pending': return '🔄';
            default: return '🔄';
        }
    }

    getStatusTooltip(status) {
        switch (status) {
            case 'passed': return 'Test passed';
            case 'failed': return 'Test failed';
            case 'warning': return 'Needs attention';
            case 'pending': return 'Not tested';
            default: return 'Unknown status';
        }
    }

    generateId() {
        return 'rule-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    showNotification(message) {
        // Simple notification - in production, use a proper notification system
        const notification = document.createElement('div');
        notification.className = 'notification success';
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #10b981;
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            z-index: 1000;
            animation: slideIn 0.3s ease;
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    showError(message) {
        // Simple error notification
        const notification = document.createElement('div');
        notification.className = 'notification error';
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: #ef4444;
            color: white;
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 14px;
            z-index: 1000;
            animation: slideIn 0.3s ease;
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 4000);
    }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new APIPopup();
});

// Add notification animations to CSS
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(100%);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);