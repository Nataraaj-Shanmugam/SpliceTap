// API Mocker Extension - Options Page JavaScript

class OptionsManager {
    constructor() {
        this.settings = {};
        this.shortcuts = {};
        this.isEditing = false;
        this.currentShortcutAction = null;
        this.capturedKeys = [];
        this.pendingConfirmAction = null;

        this.init();
    }


    openModal(id) {
        const m = document.getElementById(id);
        if (m) m.classList.add('show');
    }
    closeModal(id) {
        const m = document.getElementById(id);
        if (m) m.classList.remove('show');
    }
    async init() {
        await this.loadSettings();
        this.setupEventListeners();
        this.setupTabNavigation();
        this.updateUI();
        this.loadStatistics();
    }

    // Default settings configuration
    getDefaultSettings() {
        return {
            // General settings
            autoEnable: true,
            showNotifications: true,
            autoTest: true,
            showBadge: true,
            maxRules: 100,
            autoBackup: 'daily',
            ruleHistory: true,
            defaultStatus: 200,
            defaultDelay: 0,
            defaultHeaders: '{"Content-Type": "application/json"}',

            // Appearance settings
            theme: 'light',
            popupSize: 'normal',
            animations: true,
            fontSize: 'normal',
            showStats: true,
            showHitCount: true,
            compactMode: false,

            // Privacy settings
            collectMetrics: true,
            logRequests: false,
            autoCleanup: '30',
            includeStats: true,

            // Advanced settings
            maxResponseSize: 1024,
            requestTimeout: 5000,
            cacheSize: 50,
            debugMode: false,
            interceptHttps: true,
            interceptLocalhost: true,
            corsHeaders: true,
            userAgent: ''
        };
    }

    getDefaultShortcuts() {
        return {
            toggle: 'Ctrl+Shift+M',
            newRule: 'Ctrl+Shift+N',
            openSettings: 'Ctrl+Shift+O',
            testAll: 'Ctrl+Shift+T',
            export: 'Ctrl+Shift+E'
        };
    }

    // Load settings from Chrome storage
    async loadSettings() {
        try {
            const result = await chrome.storage.sync.get([
                'apiMockerSettings',
                'apiMockerShortcuts',
                'apiMockerRules'
            ]);

            this.settings = { ...this.getDefaultSettings(), ...result.apiMockerSettings };
            this.shortcuts = { ...this.getDefaultShortcuts(), ...result.apiMockerShortcuts };
            this.rules = result.apiMockerRules || [];

        } catch (error) {
            console.error('Failed to load settings:', error);
            this.settings = this.getDefaultSettings();
            this.shortcuts = this.getDefaultShortcuts();
            this.rules = [];
        }
    }

    // Save settings to Chrome storage
    async saveSettings() {
        try {
            await chrome.storage.sync.set({
                apiMockerSettings: this.settings,
                apiMockerShortcuts: this.shortcuts
            });

            // Apply theme immediately
            this.applyTheme();

            // Notify background script of settings change
            if (chrome.runtime) {
                chrome.runtime.sendMessage({
                    action: 'settingsUpdated',
                    settings: this.settings
                }).catch(() => {
                    // Ignore errors if background script is not available
                });
            }

            this.showMessage('Settings saved successfully!', 'success');

        } catch (error) {
            console.error('Failed to save settings:', error);
            this.showMessage('Failed to save settings. Please try again.', 'error');
        }
    }

    // Update UI elements with current settings
    updateUI() {
        // Update all form elements with current settings
        Object.keys(this.settings).forEach(key => {
            const element = document.getElementById(key);
            if (!element) return;

            if (element.type === 'checkbox') {
                element.checked = this.settings[key];
            } else if (element.type === 'radio') {
                if (element.value === this.settings[key]) {
                    element.checked = true;
                }
            } else if (element.tagName === 'SELECT') {
                element.value = this.settings[key];
            } else {
                element.value = this.settings[key];
            }
        });

        // Update shortcuts display
        Object.keys(this.shortcuts).forEach(action => {
            const shortcutElement = document.querySelector(`[data-action="${action}"] .key-display`);
            if (shortcutElement) {
                shortcutElement.textContent = this.shortcuts[action] || 'Not set';
            }
        });

        // Update theme radio buttons
        const themeRadios = document.querySelectorAll('input[name="theme"]');
        themeRadios.forEach(radio => {
            if (radio.value === this.settings.theme) {
                radio.checked = true;
            }
        });

        this.applyTheme();
    }

    // Apply theme to the page
    applyTheme() {
        const body = document.body;
        body.className = body.className.replace(/theme-\w+/g, '');

        if (this.settings.theme === 'auto') {
            const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            body.classList.add(isDark ? 'theme-dark' : 'theme-light');
        } else {
            body.classList.add(`theme-${this.settings.theme}`);
        }
    }

    // Setup all event listeners
    setupEventListeners() {
        // Save button
        document.getElementById('saveSettings').addEventListener('click', () => {
            this.collectSettingsFromUI();
            this.saveSettings();
        });

        // Reset button
        document.getElementById('resetSettings').addEventListener('click', () => {
            this.showConfirmation(
                'Reset Settings',
                'Are you sure you want to reset all settings to defaults? This cannot be undone.',
                () => this.resetToDefaults()
            );
        });

        // Form change listeners
        this.setupFormChangeListeners();

        // Shortcut editor listeners
        this.setupShortcutListeners();

        // Import/Export listeners
        this.setupImportExportListeners();

        // Privacy listeners
        this.setupPrivacyListeners();

        // Advanced listeners
        this.setupAdvancedListeners();

        // Modal listeners
        this.setupModalListeners();
    }

    setupFormChangeListeners() {
        const formElements = document.querySelectorAll('input, select, textarea');
        formElements.forEach(element => {
            element.addEventListener('change', () => {
                this.collectSettingsFromUI();
            });
        });

        // Special handling for theme changes
        const themeRadios = document.querySelectorAll('input[name="theme"]');
        themeRadios.forEach(radio => {
            radio.addEventListener('change', () => {
                if (radio.checked) {
                    this.settings.theme = radio.value;
                    this.applyTheme();
                }
            });
        });
    }

    setupTabNavigation() {
        const tabButtons = document.querySelectorAll('.tab-btn');
        const tabContents = document.querySelectorAll('.tab-content');

        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                const targetTab = button.dataset.tab;

                // Update active tab button
                tabButtons.forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');

                // Update active tab content
                tabContents.forEach(content => {
                    content.classList.remove('active');
                    if (content.id === targetTab) {
                        content.classList.add('active');
                    }
                });
            });
        });
    }

    setupShortcutListeners() {
        // Edit shortcut buttons
        document.querySelectorAll('.btn-edit').forEach(button => {
            button.addEventListener('click', (e) => {
                const shortcutKey = e.target.closest('.shortcut-key');
                const action = shortcutKey.dataset.action;
                this.openShortcutEditor(action);
            });
        });

        // Shortcut modal listeners
        document.getElementById('closeModal').addEventListener('click', () => {
            this.closeShortcutModal();
        });

        document.getElementById('cancelShortcut').addEventListener('click', () => {
            this.closeShortcutModal();
        });

        document.getElementById('saveShortcut').addEventListener('click', () => {
            this.saveShortcut();
        });

        document.getElementById('clearShortcut').addEventListener('click', () => {
            this.clearShortcut();
        });

        // Shortcut capture
        document.getElementById('shortcutCapture').addEventListener('keydown', (e) => {
            e.preventDefault();
            this.captureShortcut(e);
        });
    }

    setupImportExportListeners() {
        // Export buttons
        document.getElementById('exportAll').addEventListener('click', () => {
            this.exportRules(false);
        });

        document.getElementById('exportEnabled').addEventListener('click', () => {
            this.exportRules(true);
        });

        // Import buttons
        document.getElementById('importRules').addEventListener('click', () => {
            document.getElementById('importFile').click();
        });

        document.getElementById('importFile').addEventListener('change', (e) => {
            this.importRules(e.target.files[0]);
        });

        document.getElementById('mergeRules').addEventListener('click', () => {
            document.getElementById('importFile').click();
        });

        // Backup buttons
        document.getElementById('createBackup').addEventListener('click', () => {
            this.createBackup();
        });

        document.getElementById('restoreBackup').addEventListener('click', () => {
            this.restoreBackup();
        });

        // Template buttons
        document.getElementById('loadTemplates').addEventListener('click', () => {
            this.loadTemplate();
        });

        document.getElementById('saveAsTemplate').addEventListener('click', () => {
            this.saveAsTemplate();
        });

        document.getElementById('generateShareLink').addEventListener('click', () => {
            this.generateShareLink();
        });
    }

    setupPrivacyListeners() {
        document.getElementById('viewData').addEventListener('click', () => {
            this.openDataViewer();
        });

        document.getElementById('clearLogs').addEventListener('click', () => {
            this.showConfirmation(
                'Clear Logs',
                'Are you sure you want to clear all logs?',
                () => this.clearLogs()
            );
        });

        document.getElementById('clearAllData').addEventListener('click', () => {
            this.showConfirmation(
                'Clear All Data',
                'This will permanently delete all rules, settings, and data. This cannot be undone!',
                () => this.clearAllData()
            );
        });

        document.getElementById('fullPrivacyPolicy').addEventListener('click', (e) => {
            e.preventDefault();
            this.showPrivacyPolicy();
        });
    }

    setupAdvancedListeners() {
        document.getElementById('resetSettingsOnly').addEventListener('click', () => {
            this.showConfirmation(
                'Reset Settings Only',
                'Reset all settings but keep your rules?',
                () => this.resetSettingsOnly()
            );
        });

        document.getElementById('clearRules').addEventListener('click', () => {
            this.showConfirmation(
                'Clear All Rules',
                'This will permanently delete all your API mocking rules. Settings will be preserved.',
                () => this.clearRules()
            );
        });

        document.getElementById('factoryReset').addEventListener('click', () => {
            this.showConfirmation(
                'Factory Reset',
                'This will delete ALL data and reset the extension to factory defaults. This cannot be undone!',
                () => this.factoryReset()
            );
        });
    }

    setupModalListeners() {
        // Data viewer modal
        document.getElementById('closeDataModal').addEventListener('click', () => {
            this.closeDataModal();
        });

        document.getElementById('copyData').addEventListener('click', () => {
            this.copyDataToClipboard();
        });

        document.getElementById('downloadData').addEventListener('click', () => {
            this.downloadData();
        });

        document.getElementById('closeDataViewer').addEventListener('click', () => {
            this.closeDataModal();
        });

        // Data tabs
        document.querySelectorAll('.data-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                const type = e.target.dataset.type;
                this.switchDataTab(type);
            });
        });

        // Confirmation modal
        document.getElementById('confirmCancel').addEventListener('click', () => {
            this.closeConfirmModal();
        });

        document.getElementById('confirmOk').addEventListener('click', () => {
            if (this.pendingConfirmAction) {
                this.pendingConfirmAction();
                this.closeConfirmModal();
            }
        });

        // Close modals on outside click
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                e.target.style.display = 'none';
            }
        });
    }

    // Collect current settings from UI elements
    collectSettingsFromUI() {
        const newSettings = {};

        Object.keys(this.settings).forEach(key => {
            const element = document.getElementById(key);
            if (!element) return;

            if (element.type === 'checkbox') {
                newSettings[key] = element.checked;
            } else if (element.type === 'radio') {
                const radioGroup = document.querySelectorAll(`input[name="${element.name}"]`);
                for (const radio of radioGroup) {
                    if (radio.checked) {
                        newSettings[key] = radio.value;
                        break;
                    }
                }
            } else if (element.type === 'number') {
                newSettings[key] = parseInt(element.value) || 0;
            } else {
                newSettings[key] = element.value;
            }
        });

        // Handle theme separately
        const themeRadio = document.querySelector('input[name="theme"]:checked');
        if (themeRadio) {
            newSettings.theme = themeRadio.value;
        }

        this.settings = { ...this.settings, ...newSettings };
    }

    // Shortcut management
    openShortcutEditor(action) {
        this.currentShortcutAction = action;
        const modal = document.getElementById('shortcutModal');
        const actionSpan = document.getElementById('shortcutAction');
        const input = document.getElementById('shortcutCapture');

        actionSpan.textContent = action;
        input.value = this.shortcuts[action] || '';
        modal.style.display = 'block';
        input.focus();
    }

    closeShortcutModal() {
        document.getElementById('shortcutModal').style.display = 'none';
        this.currentShortcutAction = null;
        this.capturedKeys = [];
    }

    captureShortcut(event) {
        const keys = [];

        if (event.ctrlKey || event.metaKey) keys.push('Ctrl');
        if (event.shiftKey) keys.push('Shift');
        if (event.altKey) keys.push('Alt');

        if (event.key && !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
            keys.push(event.key.toUpperCase());
        }

        const shortcut = keys.join('+');
        document.getElementById('shortcutCapture').value = shortcut;
        this.capturedKeys = keys;

        // Check for conflicts
        this.checkShortcutConflicts(shortcut);
    }

    checkShortcutConflicts(shortcut) {
        const warning = document.getElementById('shortcutWarning');
        const commonConflicts = [
            'Ctrl+T', 'Ctrl+N', 'Ctrl+W', 'Ctrl+R', 'Ctrl+S',
            'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z'
        ];

        if (commonConflicts.includes(shortcut)) {
            warning.style.display = 'block';
            warning.textContent = 'This shortcut conflicts with common browser shortcuts.';
        } else {
            warning.style.display = 'none';
        }
    }

    saveShortcut() {
        const shortcut = document.getElementById('shortcutCapture').value;
        if (this.currentShortcutAction && shortcut) {
            this.shortcuts[this.currentShortcutAction] = shortcut;
            this.updateShortcutDisplay(this.currentShortcutAction, shortcut);
        }
        this.closeShortcutModal();
    }

    clearShortcut() {
        if (this.currentShortcutAction) {
            delete this.shortcuts[this.currentShortcutAction];
            this.updateShortcutDisplay(this.currentShortcutAction, 'Not set');
        }
        this.closeShortcutModal();
    }

    updateShortcutDisplay(action, shortcut) {
        const element = document.querySelector(`[data-action="${action}"] .key-display`);
        if (element) {
            element.textContent = shortcut;
        }
    }

    // Import/Export functionality
    async exportRules(enabledOnly = false) {
        try {
            const rules = this.rules.filter(rule => !enabledOnly || rule.enabled);
            const exportData = {
                version: '1.0',
                timestamp: new Date().toISOString(),
                rules: rules,
                settings: this.settings.includeStats ? this.settings : undefined
            };

            const blob = new Blob([JSON.stringify(exportData, null, 2)], {
                type: 'application/json'
            });

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `api-mocker-rules-${new Date().toISOString().split('T')[0]}.json`;
            a.click();

            URL.revokeObjectURL(url);
            this.showMessage('Rules exported successfully!', 'success');

        } catch (error) {
            console.error('Export failed:', error);
            this.showMessage('Failed to export rules.', 'error');
        }
    }

    async importRules(file) {
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            if (!data.rules || !Array.isArray(data.rules)) {
                throw new Error('Invalid file format');
            }

            const replaceExisting = document.getElementById('replaceExisting').checked;

            if (replaceExisting) {
                this.rules = data.rules;
            } else {
                // Merge rules, avoiding duplicates
                data.rules.forEach(newRule => {
                    const exists = this.rules.some(rule =>
                        rule.name === newRule.name && rule.url === newRule.url
                    );
                    if (!exists) {
                        this.rules.push(newRule);
                    }
                });
            }

            await chrome.storage.sync.set({ apiMockerRules: this.rules });
            this.loadStatistics(); // Refresh stats

            this.showMessage(
                `Imported ${data.rules.length} rules successfully!`,
                'success'
            );

        } catch (error) {
            console.error('Import failed:', error);
            this.showMessage('Failed to import rules. Please check the file format.', 'error');
        }
    }

    async createBackup() {
        try {
            const backupData = {
                timestamp: new Date().toISOString(),
                settings: this.settings,
                rules: this.rules,
                shortcuts: this.shortcuts
            };

            await chrome.storage.local.set({
                apiMockerBackup: backupData
            });

            document.getElementById('lastBackup').textContent = new Date().toLocaleString();
            this.showMessage('Backup created successfully!', 'success');

        } catch (error) {
            console.error('Backup failed:', error);
            this.showMessage('Failed to create backup.', 'error');
        }
    }

    async restoreBackup() {
        try {
            const result = await chrome.storage.local.get(['apiMockerBackup']);
            if (!result.apiMockerBackup) {
                this.showMessage('No backup found.', 'error');
                return;
            }

            const backup = result.apiMockerBackup;
            this.settings = backup.settings;
            this.rules = backup.rules;
            this.shortcuts = backup.shortcuts;

            await this.saveSettings();
            await chrome.storage.sync.set({ apiMockerRules: this.rules });

            this.updateUI();
            this.showMessage('Backup restored successfully!', 'success');

        } catch (error) {
            console.error('Restore failed:', error);
            this.showMessage('Failed to restore backup.', 'error');
        }
    }

    loadTemplate() {
        const templateSelect = document.getElementById('templateSelect');
        const template = templateSelect.value;

        if (!template) return;

        const templates = this.getTemplates();
        if (templates[template]) {
            this.showConfirmation(
                'Load Template',
                `Load the "${templates[template].name}" template? This will add ${templates[template].rules.length} new rules.`,
                () => {
                    this.rules.push(...templates[template].rules);
                    chrome.storage.sync.set({ apiMockerRules: this.rules });
                    this.showMessage(`Loaded ${templates[template].rules.length} rules from template.`, 'success');
                    this.loadStatistics();
                }
            );
        }
    }

    saveAsTemplate() {
        const templateName = prompt('Enter a name for this template:');
        if (!templateName) return;

        const templateData = {
            name: templateName,
            rules: this.rules.filter(rule => rule.enabled),
            created: new Date().toISOString()
        };

        // In a real implementation, this would save to storage or server
        this.showMessage(`Template "${templateName}" saved with ${templateData.rules.length} rules.`, 'success');
    }

    getTemplates() {
        return {
            'rest-api': {
                name: 'REST API Basics',
                rules: [
                    {
                        id: Date.now() + 1,
                        name: 'GET Users',
                        url: '*/api/users',
                        method: 'GET',
                        response: '{"users": [{"id": 1, "name": "John Doe"}]}',
                        status: 200,
                        enabled: true
                    },
                    {
                        id: Date.now() + 2,
                        name: 'POST User',
                        url: '*/api/users',
                        method: 'POST',
                        response: '{"id": 2, "message": "User created"}',
                        status: 201,
                        enabled: true
                    }
                ]
            },
            'error-testing': {
                name: 'Error Response Testing',
                rules: [
                    {
                        id: Date.now() + 3,
                        name: '404 Not Found',
                        url: '*/api/notfound',
                        method: 'GET',
                        response: '{"error": "Not Found"}',
                        status: 404,
                        enabled: true
                    },
                    {
                        id: Date.now() + 4,
                        name: '500 Server Error',
                        url: '*/api/error',
                        method: 'GET',
                        response: '{"error": "Internal Server Error"}',
                        status: 500,
                        enabled: true
                    }
                ]
            },
            'performance': {
                name: 'Performance Testing',
                rules: [
                    {
                        id: Date.now() + 5,
                        name: 'Slow Response',
                        url: '*/api/slow',
                        method: 'GET',
                        response: '{"message": "Delayed response"}',
                        status: 200,
                        delay: 3000,
                        enabled: true
                    }
                ]
            },
            'auth': {
                name: 'Authentication Scenarios',
                rules: [
                    {
                        id: Date.now() + 6,
                        name: 'Unauthorized',
                        url: '*/api/protected',
                        method: 'GET',
                        response: '{"error": "Unauthorized"}',
                        status: 401,
                        enabled: true
                    }
                ]
            }
        };
    }

    generateShareLink() {
        try {
            const shareData = {
                rules: this.rules.filter(rule => rule.enabled),
                timestamp: new Date().toISOString()
            };

            const encoded = btoa(JSON.stringify(shareData));
            const shareUrl = `${window.location.origin}/share.html#${encoded}`;

            navigator.clipboard.writeText(shareUrl);
            this.showMessage('Share link copied to clipboard!', 'success');

        } catch (error) {
            console.error('Failed to generate share link:', error);
            this.showMessage('Failed to generate share link.', 'error');
        }
    }

    // Data management
    openDataViewer() {
        document.getElementById('dataModal').style.display = 'block';
        this.switchDataTab('rules');
    }

    closeDataModal() {
        document.getElementById('dataModal').style.display = 'none';
    }

    switchDataTab(type) {
        // Update active tab
        document.querySelectorAll('.data-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.type === type);
        });

        // Update content
        const display = document.getElementById('dataDisplay');
        let data;

        switch (type) {
            case 'rules':
                data = this.rules;
                break;
            case 'settings':
                data = this.settings;
                break;
            case 'metrics':
                data = {
                    totalHits: 1234,
                    averageResponseTime: '120ms',
                    lastUsed: new Date().toISOString(),
                    popularRules: ['GET /api/users', 'POST /api/login']
                };
                break;
            case 'logs':
                data = {
                    recentRequests: [
                        { url: '/api/users', method: 'GET', timestamp: new Date().toISOString(), matched: true },
                        { url: '/api/posts', method: 'GET', timestamp: new Date().toISOString(), matched: false }
                    ]
                };
                break;
            default:
                data = {};
        }

        display.textContent = JSON.stringify(data, null, 2);
    }

    copyDataToClipboard() {
        const data = document.getElementById('dataDisplay').textContent;
        navigator.clipboard.writeText(data).then(() => {
            this.showMessage('Data copied to clipboard!', 'success');
        });
    }

    downloadData() {
        const data = document.getElementById('dataDisplay').textContent;
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `api-mocker-data-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    async clearLogs() {
        await chrome.storage.local.remove(['apiMockerLogs']);
        this.showMessage('Logs cleared successfully.', 'success');
        this.loadStatistics();
    }

    async clearAllData() {
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
API Mocker Privacy Policy

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
            const result = await chrome.storage.local.get(['apiMockerBackup']);
            if (result.apiMockerBackup) {
                const lastBackupElement = document.getElementById('lastBackup');
                if (lastBackupElement) {
                    const backupDate = new Date(result.apiMockerBackup.timestamp);
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
        modal.style.display = 'block';
    }

    closeConfirmModal() {
        document.getElementById('confirmModal').style.display = 'none';
        this.pendingConfirmAction = null;
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
        await chrome.storage.sync.set({ apiMockerRules: this.rules });
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
                const openModal = document.querySelector('.modal[style*="block"]');
                if (openModal) {
                    openModal.style.display = 'none';
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

