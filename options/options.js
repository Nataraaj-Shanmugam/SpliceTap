/**
 * TurboMock Options Page Script
 * Handles settings, data management, and configuration
 */

class OptionsManager {
    constructor() {
        this.settings = {};
        this.shortcuts = {};
        this.rules = [];
        this.pendingConfirmAction = null;
        
        this.init();
    }

    async init() {
        try {
            await this.loadData();
            this.setupEventListeners();
            this.updateUI();
            this.setupTheme();
            this.loadStatistics();
            this.enableAutoSave();
            this.setupKeyboardShortcuts();
            this.initThemeSystem();
            this.startPerformanceMonitoring();
            
            console.log('🎭 TurboMock options page initialized');
        } catch (error) {
            console.error('Failed to initialize options page:', error);
            this.showMessage('Failed to load options page', 'error');
        }
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

    setupEventListeners() {
        // Tab navigation
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.switchTab(e.target.dataset.tab);
            });
        });

        // Header actions
        document.getElementById('saveBtn').addEventListener('click', () => this.saveSettings());
        document.getElementById('exportBtn').addEventListener('click', () => this.exportSettings());
        document.getElementById('importBtn').addEventListener('click', () => this.importSettings());

        // Rules management
        document.getElementById('importRulesBtn').addEventListener('click', () => this.importRules());
        document.getElementById('exportRulesBtn').addEventListener('click', () => this.exportRules());
        document.getElementById('createBackupBtn').addEventListener('click', () => this.createBackup());
        document.getElementById('restoreBackupBtn').addEventListener('click', () => this.restoreBackup());
        document.getElementById('manageTemplatesBtn').addEventListener('click', () => this.manageTemplates());

        // Data management
        document.getElementById('viewDataBtn').addEventListener('click', () => this.viewAllData());
        document.getElementById('exportDataBtn').addEventListener('click', () => this.exportAllData());
        document.getElementById('clearDataBtn').addEventListener('click', () => this.clearAllData());

        // Theme selection
        document.querySelectorAll('input[name="theme"]').forEach(input => {
            input.addEventListener('change', (e) => {
                if (e.target.checked) {
                    this.settings.theme = e.target.value;
                    this.applyTheme();
                }
            });
        });

        // Toggle switches
        ['notifications', 'autoBackup', 'debugMode'].forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener('change', (e) => {
                    this.settings[id] = e.target.checked;
                });
            }
        });

        // Advanced settings
        ['defaultHeaders', 'maxResponseSize', 'requestTimeout', 'cacheSize'].forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener('input', (e) => {
                    this.settings[id] = e.target.value;
                });
            }
        });

        // Modal close events
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal');
                if (modal) {
                    modal.classList.remove('show');
                }
            });
        });

        // Click outside modal to close
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                e.target.classList.remove('show');
            }
        });

        // Confirmation modal
        document.getElementById('confirmBtn').addEventListener('click', () => this.executeConfirmAction());
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
        document.getElementById('toggleShortcut').textContent = this.shortcuts.toggle;
        document.getElementById('newRuleShortcut').textContent = this.shortcuts.newRule;
    }

    setupTheme() {
        this.applyTheme();
    }

    applyTheme() {
        const theme = this.settings.theme || 'auto';
        document.body.className = `theme-${theme}`;
        
        // Handle auto theme
        if (theme === 'auto') {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            document.body.className = prefersDark ? 'theme-dark' : 'theme-light';
        }
    }

    switchTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tabName);
        });

        // Update tab content
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.dataset.tab === tabName);
        });
    }

    async saveSettings() {
        try {
            this.collectSettingsFromUI();
            
            const errors = this.validateSettings();
            if (errors.length > 0) {
                this.showMessage(`Validation errors: ${errors.join(', ')}`, 'error');
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
            this.showMessage('Failed to save settings', 'error');
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

                const mergeImport = document.getElementById('mergeImport').checked;
                
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

                await chrome.storage.local.set({ turboMockRules: this.rules });
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

    async createBackup() {
        try {
            const backupData = {
                version: '1.0.0',
                timestamp: new Date().toISOString(),
                settings: this.settings,
                shortcuts: this.shortcuts,
                rules: this.rules
            };

            await chrome.storage.local.set({ turboMockBackup: backupData });
            this.loadStatistics();
            this.showMessage('Backup created successfully!', 'success');
            
        } catch (error) {
            this.showMessage('Failed to create backup', 'error');
        }
    }

    async restoreBackup() {
        try {
            const result = await chrome.storage.local.get(['turboMockBackup']);
            
            if (!result.turboMockBackup) {
                this.showMessage('No backup found', 'warning');
                return;
            }

            this.showConfirmation(
                'Restore Backup',
                'This will replace all current settings and rules with the backup. Continue?',
                async () => {
                    const backup = result.turboMockBackup;
                    this.settings = backup.settings || this.getDefaultSettings();
                    this.shortcuts = backup.shortcuts || this.getDefaultShortcuts();
                    this.rules = backup.rules || [];
                    
                    await this.saveSettings();
                    await chrome.storage.local.set({ turboMockRules: this.rules });
                    
                    this.updateUI();
                    this.loadStatistics();
                    this.showMessage('Backup restored successfully!', 'success');
                }
            );
            
        } catch (error) {
            this.showMessage('Failed to restore backup', 'error');
        }
    }

    async manageTemplates() {
        // Open templates management (placeholder for future implementation)
        this.showMessage('Template management coming soon!', 'info');
    }

    async viewAllData() {
        try {
            const allData = await chrome.storage.local.get();
            
            const modal = document.getElementById('dataModal');
            const dataDisplay = document.getElementById('dataDisplay');
            
            dataDisplay.value = JSON.stringify(allData, null, 2);
            modal.classList.add('show');
            
        } catch (error) {
            this.showMessage('Failed to load data', 'error');
        }
    }

    async exportAllData() {
        try {
            const allData = await chrome.storage.local.get();
            
            const exportData = {
                version: '1.0.0',
                exported: new Date().toISOString(),
                data: allData
            };

            this.downloadJSON(exportData, `turbomock-complete-data-${new Date().toISOString().split('T')[0]}.json`);
            this.showMessage('All data exported successfully!', 'success');
            
        } catch (error) {
            this.showMessage('Failed to export data', 'error');
        }
    }

    async clearAllData() {
        this.showConfirmation(
            'Clear All Data',
            'This will permanently delete all TurboMock data including rules, settings, and statistics. This action cannot be undone.',
            async () => {
                await this.performDataClear();
            }
        );
    }

    async performDataClear() {
        try {
            await chrome.storage.sync.clear();
            await chrome.storage.local.clear();

            this.settings = this.getDefaultSettings();
            this.shortcuts = this.getDefaultShortcuts();
            this.rules = [];

            this.updateUI();
            this.showMessage('All data cleared successfully.', 'success');

        } catch (error) {
            console.error('Failed to clear data:', error);
            this.showMessage('Failed to clear data.', 'error');
        }
    }

    showPrivacyPolicy() {
        const policyContent = `
TurboMock Privacy Policy

Data Collection:
• All data is stored locally on your device
• No personal information is transmitted to external servers
• Request URLs may be logged locally if enabled
• Usage statistics are collected anonymously for performance

Data Storage:
• Rules and settings are stored in Chrome sync storage
• Logs and metrics are stored in local storage only
• Backups are created locally unless explicitly shared

Data Sharing:
• No data is shared automatically
• Export/share features require explicit user action
• Shared links contain only the rules you choose to include

Your Rights:
• View all stored data at any time
• Export your data in JSON format
• Delete all data with factory reset
• Disable data collection features

Contact: This is a demo extension for educational purposes.
        `;

        alert(policyContent);
    }

    // Utility methods
    async loadStatistics() {
        // Update rule counts
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
        const logsCountElement = document.getElementById('logsCount');

        if (rulesSizeElement) {
            rulesSizeElement.textContent = Math.ceil(rulesData.length / 1024);
        }

        if (metricsSizeElement) {
            metricsSizeElement.textContent = Math.ceil(settingsData.length / 1024);
        }

        if (logsCountElement) {
            logsCountElement.textContent = 0; // Default to 0, would be loaded from storage in real implementation
        }

        // Update last backup time
        try {
            const result = await chrome.storage.local.get(['turboMockBackup']);
            if (result.turboMockBackup) {
                const lastBackupElement = document.getElementById('lastBackup');
                if (lastBackupElement) {
                    const backupDate = new Date(result.turboMockBackup.timestamp);
                    lastBackupElement.textContent = backupDate.toLocaleString();
                }
            }
        } catch (error) {
            console.error('Failed to load backup info:', error);
        }
    }

    showMessage(message, type = 'info') {
        const container = document.getElementById('messageContainer');
        if (!container) return;

        // Remove existing messages
        container.innerHTML = '';

        const messageEl = document.createElement('div');
        messageEl.className = `message message-${type}`;
        messageEl.textContent = message;

        container.appendChild(messageEl);

        // Auto-hide after 5 seconds
        setTimeout(() => {
            if (messageEl.parentNode) {
                messageEl.remove();
            }
        }, 5000);

        // Scroll to top to ensure message is visible
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showConfirmation(title, message, onConfirm) {
        const modal = document.getElementById('confirmModal');
        const titleEl = document.getElementById('confirmTitle');
        const messageEl = document.getElementById('confirmMessage');

        titleEl.textContent = title;
        messageEl.textContent = message;

        this.pendingConfirmAction = onConfirm;
        modal.classList.add('show');
    }

    closeConfirmModal() {
        document.getElementById('confirmModal').classList.remove('show');
        this.pendingConfirmAction = null;
    }

    executeConfirmAction() {
        if (this.pendingConfirmAction) {
            this.pendingConfirmAction();
            this.closeConfirmModal();
        }
    }

    // Reset functions
    async resetToDefaults() {
        this.settings = this.getDefaultSettings();
        this.shortcuts = this.getDefaultShortcuts();

        await this.saveSettings();
        this.updateUI();
        this.showMessage('Settings reset to defaults successfully!', 'success');
    }

    async resetSettingsOnly() {
        this.settings = this.getDefaultSettings();
        await this.saveSettings();
        this.updateUI();
        this.showMessage('Settings reset successfully! Rules preserved.', 'success');
    }

    async clearRules() {
        this.rules = [];
        await chrome.storage.local.set({ turboMockRules: this.rules });
        this.loadStatistics();
        this.showMessage('All rules cleared successfully!', 'success');
    }

    async factoryReset() {
        await this.clearAllData();
        await this.resetToDefaults();
        this.showMessage('Factory reset completed successfully!', 'success');
    }

    // Auto-save functionality
    enableAutoSave() {
        let saveTimeout;

        const formElements = document.querySelectorAll('input, select, textarea');
        formElements.forEach(element => {
            element.addEventListener('input', () => {
                clearTimeout(saveTimeout);
                saveTimeout = setTimeout(() => {
                    this.collectSettingsFromUI();
                    // Don't save automatically, just collect changes
                }, 1000);
            });
        });
    }

    // Keyboard shortcuts for the settings page
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl+S to save
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this.collectSettingsFromUI();
                this.saveSettings();
            }

            // Escape to close modals
            if (e.key === 'Escape') {
                const openModal = document.querySelector('.modal.show');
                if (openModal) {
                    openModal.classList.remove('show');
                }
            }
        });
    }

    // Theme system handler
    initThemeSystem() {
        // Listen for system theme changes
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        mediaQuery.addListener(() => {
            if (this.settings.theme === 'auto') {
                this.applyTheme();
            }
        });

        // Apply initial theme
        this.applyTheme();
    }

    // Validation helpers
    validateSettings() {
        const errors = [];

        // Validate numeric settings
        if (this.settings.maxResponseSize < 1 || this.settings.maxResponseSize > 10240) {
            errors.push('Max response size must be between 1 and 10240 KB');
        }

        if (this.settings.requestTimeout < 100 || this.settings.requestTimeout > 30000) {
            errors.push('Request timeout must be between 100 and 30000 ms');
        }

        if (this.settings.cacheSize < 10 || this.settings.cacheSize > 1000) {
            errors.push('Cache size must be between 10 and 1000 rules');
        }

        // Validate default headers JSON
        try {
            if (this.settings.defaultHeaders.trim()) {
                JSON.parse(this.settings.defaultHeaders);
            }
        } catch (e) {
            errors.push('Default headers must be valid JSON');
        }

        return errors;
    }

    // Performance monitoring
    startPerformanceMonitoring() {
        // Monitor page performance
        if ('performance' in window) {
            window.addEventListener('load', () => {
                setTimeout(() => {
                    const navigation = performance.getEntriesByType('navigation')[0];
                    if (navigation && this.settings.debugMode) {
                        console.log('Options page load time:', navigation.loadEventEnd - navigation.fetchStart, 'ms');
                    }
                }, 0);
            });
        }
    }

    // Utility functions
    downloadJSON(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        
        URL.revokeObjectURL(url);
    }

    generateId() {
        return 'item-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    }
}

// Global functions for HTML onclick handlers
function editShortcut(shortcutName) {
    // Placeholder for shortcut editing functionality
    alert('Shortcut editing will be available in a future version.');
}

function switchDataTab(tabName) {
    document.querySelectorAll('.data-tab').forEach(tab => {
        tab.classList.toggle('active', tab.textContent.toLowerCase() === tabName);
    });
    
    // Update data display based on tab
    // This is a placeholder - would show different data based on tab
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('show');
}

function resetSettingsOnly() {
    window.optionsManager.showConfirmation(
        'Reset Settings',
        'Reset all settings to default values? Your rules will be preserved.',
        () => window.optionsManager.resetSettingsOnly()
    );
}

function clearRules() {
    window.optionsManager.showConfirmation(
        'Clear All Rules',
        'Delete all mock rules? This cannot be undone.',
        () => window.optionsManager.clearRules()
    );
}

function factoryReset() {
    window.optionsManager.showConfirmation(
        'Factory Reset',
        'Reset everything to default state? This will delete all data and cannot be undone.',
        () => window.optionsManager.factoryReset()
    );
}

function showPrivacyPolicy() {
    if (window.optionsManager) {
        window.optionsManager.showPrivacyPolicy();
    }
}

// Initialize the options manager when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.optionsManager = new OptionsManager();
});

// Handle unload to save any pending changes
window.addEventListener('beforeunload', () => {
    if (window.optionsManager) {
        window.optionsManager.collectSettingsFromUI();
        // Note: Can't use async here due to beforeunload restrictions
    }
});