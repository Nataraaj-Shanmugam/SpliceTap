/**
 * TurboMock Extension - Enhanced Popup JavaScript
 * Handles all popup interactions, rule management, and Chrome extension APIs
 */

class TurboMockPopup {
    constructor() {
        this.rules = [];
        this.filteredRules = [];
        this.isActive = true;
        this.stats = { intercepted: 0, rulesCount: 0 };
        this.storage = new TurboMockStorage();
        
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
            console.log('🎭 TurboMock popup initialized');
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
            const response = await chrome.runtime.sendMessage({ type: 'getRules' });
            
            if (response.success) {
                this.rules = response.rules || [];
                this.isActive = response.active !== false;
                this.stats = response.stats || { intercepted: 0, rulesCount: this.rules.length };
                this.filteredRules = [...this.rules];
            } else {
                // Fallback to direct storage access
                const data = await this.storage.loadAll();
                this.rules = data.rules;
                this.isActive = data.active;
                this.stats = data.stats;
                this.filteredRules = [...this.rules];
            }

        } catch (error) {
            console.error('Error loading data:', error);
            // Fallback to empty state
            this.rules = [];
            this.filteredRules = [];
            this.isActive = true;
            this.stats = { intercepted: 0, rulesCount: 0 };
        }
    }

    /**
     * Setup all event listeners
     */
    setupEventListeners() {
        // Header actions
        document.getElementById('settingsBtn').addEventListener('click', () => this.openSettings());
        document.getElementById('importExportBtn').addEventListener('click', () => this.openImportExport());
        document.getElementById('refreshBtn').addEventListener('click', () => this.refreshData());

        // Search functionality
        document.getElementById('searchInput').addEventListener('input', (e) => this.handleSearch(e));

        // Footer actions
        document.getElementById('newRuleBtn').addEventListener('click', () => this.createNewRule());
        document.getElementById('testAllBtn').addEventListener('click', () => this.testAllRules());
        document.getElementById('helpBtn').addEventListener('click', () => this.openHelp());

        // Global toggle (click on status)
        document.getElementById('statusToggle').addEventListener('click', () => this.toggleGlobalStatus());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboardShortcuts(e));
    }

    /**
     * Render rules list
     */
    renderRules() {
        const container = document.getElementById('rulesContainer');
        
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
        const statusIcon = this.getStatusIcon(rule.testStatus || 'pending');
        const methodClass = `method-${rule.match.method.toLowerCase()}`;
        const enabledClass = rule.enabled ? '' : 'disabled';
        const checkedClass = rule.enabled ? 'checked' : '';

        return `
            <div class="rule-card ${enabledClass}" data-rule-id="${rule.id}" role="listitem">
                <div class="rule-header">
                    <div class="rule-info">
                        <div class="rule-name">
                            <div class="rule-checkbox ${checkedClass}" data-rule-id="${rule.id}" role="checkbox" aria-checked="${rule.enabled}" aria-label="Enable rule: ${TurboMockUtils.escapeHtml(rule.name)}"></div>
                            ${TurboMockUtils.escapeHtml(rule.name)}
                        </div>
                        <div class="rule-details">
                            <span class="rule-method ${methodClass}">${rule.match.method}</span>
                            ${TurboMockUtils.escapeHtml(rule.match.url)} → ${rule.response.statusCode} ${rule.response.statusText}
                            ${rule.response.delay ? ` (+${rule.response.delay}ms)` : ''}
                        </div>
                    </div>
                    <div class="status-indicator" title="${this.getStatusTooltip(rule.testStatus || 'pending')}">${statusIcon}</div>
                </div>
                <div class="rule-actions">
                    <button class="rule-action" title="Edit" data-action="edit" data-rule-id="${rule.id}" aria-label="Edit rule">✏️</button>
                    <button class="rule-action" title="Copy" data-action="copy" data-rule-id="${rule.id}" aria-label="Duplicate rule">📋</button>
                    <button class="rule-action" title="Test" data-action="test" data-rule-id="${rule.id}" aria-label="Test rule">🧪</button>
                    <button class="rule-action" title="Delete" data-action="delete" data-rule-id="${rule.id}" aria-label="Delete rule">🗑️</button>
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

        const newEnabled = !rule.enabled;
        
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'toggleRule',
                ruleId: ruleId,
                enabled: newEnabled
            });

            if (response.success) {
                rule.enabled = newEnabled;
                rule.lastModified = new Date().toISOString();
                
                e.target.classList.toggle('checked', rule.enabled);
                e.target.setAttribute('aria-checked', rule.enabled);
                
                const card = e.target.closest('.rule-card');
                card.classList.toggle('disabled', !rule.enabled);

                this.updateStatus();
                this.showNotification(`Rule ${rule.enabled ? 'enabled' : 'disabled'}: ${rule.name}`);
            } else {
                this.showError('Failed to update rule: ' + response.error);
            }
        } catch (error) {
            console.error('Failed to toggle rule:', error);
            this.showError('Failed to update rule');
        }
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

        // Try to send message to content script to open rule editor
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'openRuleEditor',
                    rule: rule
                }).catch(() => {
                    // If content script is not available, open options page
                    this.openRuleEditorInOptionsPage(rule);
                });
            }
        });

        // Close popup
        window.close();
    }

    /**
     * Open rule editor in options page
     */
    openRuleEditorInOptionsPage(rule) {
        const url = chrome.runtime.getURL('options/options.html') + `?editRule=${rule.id}`;
        chrome.tabs.create({ url });
    }

    /**
     * Copy rule
     */
    async copyRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        try {
            const newRule = TurboMockUtils.deepClone(rule);
            newRule.id = TurboMockUtils.generateId();
            newRule.name = `${rule.name} (Copy)`;
            newRule.enabled = false;
            newRule.hitCount = 0;
            newRule.created = new Date().toISOString();
            newRule.lastUsed = null;
            newRule.lastModified = null;
            newRule.testStatus = 'pending';

            const response = await chrome.runtime.sendMessage({
                type: 'saveRule',
                rule: newRule
            });

            if (response.success) {
                await this.loadData();
                this.renderRules();
                this.updateStatus();
                this.showNotification('Rule duplicated successfully');
            } else {
                this.showError('Failed to duplicate rule: ' + response.error);
            }
        } catch (error) {
            console.error('Failed to copy rule:', error);
            this.showError('Failed to duplicate rule');
        }
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

            const response = await chrome.runtime.sendMessage({
                type: 'testRule',
                rule: rule
            });

            if (response.success) {
                // Update rule test status
                rule.testStatus = response.passed ? 'passed' : 'failed';
                rule.lastTested = new Date().toISOString();
                rule.testResults = response.results;

                // Update UI
                statusIndicator.textContent = this.getStatusIcon(rule.testStatus);
                statusIndicator.title = this.getStatusTooltip(rule.testStatus);
                
                this.showNotification(`Test ${response.passed ? 'passed' : 'failed'}: ${rule.name}`);
            } else {
                statusIndicator.textContent = originalIcon;
                this.showError('Test failed: ' + response.error);
            }

        } catch (error) {
            console.error('Test failed:', error);
            this.showError('Test failed: ' + error.message);
        }
    }

    /**
     * Delete rule
     */
    async deleteRule(ruleId) {
        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        if (confirm(`Delete rule "${rule.name}"?\n\nThis action cannot be undone.`)) {
            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'deleteRule',
                    ruleId: ruleId
                });

                if (response.success) {
                    await this.loadData();
                    this.renderRules();
                    this.updateStatus();
                    this.showNotification('Rule deleted successfully');
                } else {
                    this.showError('Failed to delete rule: ' + response.error);
                }
            } catch (error) {
                console.error('Failed to delete rule:', error);
                this.showError('Failed to delete rule');
            }
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
                rule.match.url.toLowerCase().includes(searchTerm) ||
                rule.match.method.toLowerCase().includes(searchTerm)
            );
        }
        
        this.renderRules();
    }

    /**
     * Create new rule
     */
    createNewRule() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, {
                    type: 'openRuleEditor',
                    rule: null // New rule
                }).catch(() => {
                    // If content script is not available, open options page
                    chrome.runtime.openOptionsPage();
                });
            }
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
        const testBtn = document.getElementById('testAllBtn');
        const originalText = testBtn.textContent;
        testBtn.textContent = '⏳ Testing...';
        testBtn.disabled = true;

        try {
            let passed = 0;
            let failed = 0;

            for (const rule of enabledRules) {
                const response = await chrome.runtime.sendMessage({
                    type: 'testRule',
                    rule: rule
                });

                if (response.success) {
                    rule.testStatus = response.passed ? 'passed' : 'failed';
                    rule.lastTested = new Date().toISOString();
                    rule.testResults = response.results;
                    
                    if (response.passed) passed++;
                    else failed++;
                }
                
                // Small delay between tests
                await this.delay(200);
            }
            
            this.renderRules();
            this.showNotification(`Tests completed: ${passed} passed, ${failed} failed`);
        } catch (error) {
            this.showError('Testing failed: ' + error.message);
        } finally {
            testBtn.textContent = originalText;
            testBtn.disabled = false;
        }
    }

    /**
     * Toggle global extension status
     */
    async toggleGlobalStatus() {
        try {
            const response = await chrome.runtime.sendMessage({
                type: 'toggleExtension',
                active: !this.isActive
            });

            if (response.success) {
                this.isActive = response.active;
                this.updateStatus();
                this.showNotification(`Extension ${this.isActive ? 'enabled' : 'disabled'}`);
            } else {
                this.showError('Failed to toggle extension');
            }
        } catch (error) {
            console.error('Failed to toggle extension:', error);
            this.showError('Failed to toggle extension');
        }
    }

    /**
     * Update status display
     */
    updateStatus() {
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const enabledCount = this.rules.filter(r => r.enabled).length;
        
        if (this.isActive && enabledCount > 0) {
            statusDot.style.background = '#10b981';
            statusDot.style.animation = 'pulse 2s infinite';
            statusText.textContent = `Active (${enabledCount} rules)`;
        } else if (!this.isActive) {
            statusDot.style.background = '#ef4444';
            statusDot.style.animation = 'none';
            statusText.textContent = 'Disabled';
        } else {
            statusDot.style.background = '#f59e0b';
            statusDot.style.animation = 'none';
            statusText.textContent = 'No enabled rules';
        }
    }

    /**
     * Update stats display
     */
    updateStats() {
        const statsText = document.getElementById('statsText');
        if (statsText) {
            statsText.textContent = `Intercepted: ${this.stats.intercepted || 0} requests today`;
        }
    }

    /**
     * Open settings
     */
    openSettings() {
        chrome.runtime.openOptionsPage();
        window.close();
    }

    /**
     * Open import/export dialog
     */
    async openImportExport() {
        // Create file input for import
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.style.display = 'none';

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const data = await TurboMockUtils.importRulesFromFile(file);
                    await this.importRules(data);
                } catch (error) {
                    this.showError('Failed to import rules: ' + error.message);
                }
            }
        };

        // Show import/export options
        if (confirm('Click OK to export rules, Cancel to import rules')) {
            this.exportRules();
        } else {
            document.body.appendChild(input);
            input.click();
            document.body.removeChild(input);
        }
    }

    /**
     * Export rules
     */
    exportRules() {
        TurboMockUtils.exportRules(this.rules, `turbomock-rules-${new Date().toISOString().split('T')[0]}.json`);
        this.showNotification('Rules exported successfully');
    }

    /**
     * Import rules
     */
    async importRules(data) {
        try {
            if (data.rules && data.rules.length > 0) {
                // Import each rule
                for (const rule of data.rules) {
                    await chrome.runtime.sendMessage({
                        type: 'saveRule',
                        rule: rule
                    });
                }
                
                await this.loadData();
                this.renderRules();
                this.updateStatus();
                
                const message = data.skipped > 0 
                    ? `Imported ${data.rules.length} rules (${data.skipped} skipped)`
                    : `Imported ${data.rules.length} rules`;
                this.showNotification(message);
            } else {
                this.showError('No valid rules found in import file');
            }
        } catch (error) {
            console.error('Failed to import rules:', error);
            this.showError('Failed to import rules: ' + error.message);
        }
    }

    /**
     * Refresh data
     */
    async refreshData() {
        const refreshBtn = document.getElementById('refreshBtn');
        const originalText = refreshBtn.textContent;
        
        try {
            refreshBtn.textContent = '⏳';
            refreshBtn.disabled = true;
            
            await this.loadData();
            this.renderRules();
            this.updateStatus();
            this.updateStats();
            
            this.showNotification('Data refreshed');
        } catch (error) {
            this.showError('Failed to refresh data');
        } finally {
            refreshBtn.textContent = originalText;
            refreshBtn.disabled = false;
        }
    }

    /**
     * Open help
     */
    openHelp() {
        chrome.tabs.create({ url: 'https://github.com/turbomock/browser-extension#readme' });
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
                    document.getElementById('searchInput').focus();
                    break;
                case 't':
                    e.preventDefault();
                    this.testAllRules();
                    break;
                case 'r':
                    e.preventDefault();
                    this.refreshData();
                    break;
            }
        } else if (e.key === 'Escape') {
            window.close();
        }
    }

    /**
     * Get status icon for test status
     */
    getStatusIcon(status) {
        const icons = {
            passed: '✅',
            failed: '❌',
            warning: '⚠️',
            pending: '🔄',
            never: '🔄'
        };
        return icons[status] || '🔄';
    }

    /**
     * Get status tooltip for test status
     */
    getStatusTooltip(status) {
        const tooltips = {
            passed: 'Test passed - rule is working correctly',
            failed: 'Test failed - rule has validation errors',
            warning: 'Test passed with warnings',
            pending: 'Test pending - rule not yet tested',
            never: 'Never tested'
        };
        return tooltips[status] || 'Unknown status';
    }

    /**
     * Show notification
     */
    showNotification(message) {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = 'popup-notification';
        notification.textContent = message;
        
        // Add styles
        Object.assign(notification.style, {
            position: 'fixed',
            top: '10px',
            right: '10px',
            background: '#16a34a',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: '500',
            zIndex: '10000',
            animation: 'slideInRight 0.3s ease-out',
            maxWidth: '200px',
            wordWrap: 'break-word'
        });
        
        document.body.appendChild(notification);
        
        // Remove after 3 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.style.animation = 'slideOutRight 0.3s ease-out';
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.remove();
                    }
                }, 300);
            }
        }, 3000);
    }

    /**
     * Show error message
     */
    showError(message) {
        // Create error notification element
        const notification = document.createElement('div');
        notification.className = 'popup-notification error';
        notification.textContent = message;
        
        // Add styles
        Object.assign(notification.style, {
            position: 'fixed',
            top: '10px',
            right: '10px',
            background: '#dc2626',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: '500',
            zIndex: '10000',
            animation: 'slideInRight 0.3s ease-out',
            maxWidth: '200px',
            wordWrap: 'break-word'
        });
        
        document.body.appendChild(notification);
        
        // Remove after 5 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.style.animation = 'slideOutRight 0.3s ease-out';
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.remove();
                    }
                }, 300);
            }
        }, 5000);
    }

    /**
     * Utility delay function
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Initialize the popup when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new TurboMockPopup();
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TurboMockPopup;
}