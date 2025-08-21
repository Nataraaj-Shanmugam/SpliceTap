/**
 * TurboMock Storage Manager
 * Handles all data persistence with Chrome storage APIs and local file system
 */

class TurboMockStorage {
    constructor() {
        this.storageKeys = {
            rules: 'turboMockRules',
            active: 'turboMockActive',
            stats: 'turboMockStats',
            settings: 'turboMockSettings',
            metrics: 'turboMockMetrics'
        };
        
        this.defaultSettings = {
            theme: 'auto',
            notifications: true,
            autoBackup: true,
            debugMode: false,
            shortcuts: {
                toggle: 'Ctrl+Shift+M',
                newRule: 'Ctrl+Shift+N'
            }
        };
        
        this.defaultStats = {
            intercepted: 0,
            rulesCount: 0,
            lastUpdated: new Date().toISOString()
        };
    }

    /**
     * Get all data from storage
     */
    async loadAll() {
        try {
            const result = await chrome.storage.local.get(Object.values(this.storageKeys));
            
            return {
                rules: result[this.storageKeys.rules] || [],
                active: result[this.storageKeys.active] !== false, // Default to true
                stats: { ...this.defaultStats, ...result[this.storageKeys.stats] },
                settings: { ...this.defaultSettings, ...result[this.storageKeys.settings] },
                metrics: result[this.storageKeys.metrics] || {}
            };
        } catch (error) {
            console.error('Failed to load data from storage:', error);
            return this.getDefaults();
        }
    }

    /**
     * Get default data structure
     */
    getDefaults() {
        return {
            rules: [],
            active: true,
            stats: { ...this.defaultStats },
            settings: { ...this.defaultSettings },
            metrics: {}
        };
    }

    /**
     * Save rules
     */
    async saveRules(rules) {
        try {
            await chrome.storage.local.set({
                [this.storageKeys.rules]: rules
            });
            
            // Update stats
            await this.updateStats({ rulesCount: rules.length });
            
            return { success: true };
        } catch (error) {
            console.error('Failed to save rules:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get rules
     */
    async getRules() {
        try {
            const result = await chrome.storage.local.get(this.storageKeys.rules);
            return result[this.storageKeys.rules] || [];
        } catch (error) {
            console.error('Failed to get rules:', error);
            return [];
        }
    }

    /**
     * Add or update rule
     */
    async saveRule(rule) {
        try {
            const rules = await this.getRules();
            const existingIndex = rules.findIndex(r => r.id === rule.id);
            
            if (existingIndex >= 0) {
                rules[existingIndex] = { ...rule, lastModified: new Date().toISOString() };
            } else {
                rules.push({ ...rule, created: new Date().toISOString() });
            }
            
            return await this.saveRules(rules);
        } catch (error) {
            console.error('Failed to save rule:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Delete rule
     */
    async deleteRule(ruleId) {
        try {
            const rules = await this.getRules();
            const filteredRules = rules.filter(r => r.id !== ruleId);
            
            return await this.saveRules(filteredRules);
        } catch (error) {
            console.error('Failed to delete rule:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Toggle rule enabled state
     */
    async toggleRule(ruleId, enabled) {
        try {
            const rules = await this.getRules();
            const rule = rules.find(r => r.id === ruleId);
            
            if (!rule) {
                return { success: false, error: 'Rule not found' };
            }
            
            rule.enabled = enabled;
            rule.lastModified = new Date().toISOString();
            
            return await this.saveRules(rules);
        } catch (error) {
            console.error('Failed to toggle rule:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Save extension active state
     */
    async saveActiveState(active) {
        try {
            await chrome.storage.local.set({
                [this.storageKeys.active]: active
            });
            return { success: true };
        } catch (error) {
            console.error('Failed to save active state:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get extension active state
     */
    async getActiveState() {
        try {
            const result = await chrome.storage.local.get(this.storageKeys.active);
            return result[this.storageKeys.active] !== false; // Default to true
        } catch (error) {
            console.error('Failed to get active state:', error);
            return true;
        }
    }

    /**
     * Update statistics
     */
    async updateStats(updates) {
        try {
            const currentStats = await this.getStats();
            const newStats = {
                ...currentStats,
                ...updates,
                lastUpdated: new Date().toISOString()
            };
            
            await chrome.storage.local.set({
                [this.storageKeys.stats]: newStats
            });
            
            return { success: true, stats: newStats };
        } catch (error) {
            console.error('Failed to update stats:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get statistics
     */
    async getStats() {
        try {
            const result = await chrome.storage.local.get(this.storageKeys.stats);
            return { ...this.defaultStats, ...result[this.storageKeys.stats] };
        } catch (error) {
            console.error('Failed to get stats:', error);
            return { ...this.defaultStats };
        }
    }

    /**
     * Save settings
     */
    async saveSettings(settings) {
        try {
            const newSettings = { ...this.defaultSettings, ...settings };
            await chrome.storage.local.set({
                [this.storageKeys.settings]: newSettings
            });
            return { success: true, settings: newSettings };
        } catch (error) {
            console.error('Failed to save settings:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get settings
     */
    async getSettings() {
        try {
            const result = await chrome.storage.local.get(this.storageKeys.settings);
            return { ...this.defaultSettings, ...result[this.storageKeys.settings] };
        } catch (error) {
            console.error('Failed to get settings:', error);
            return { ...this.defaultSettings };
        }
    }

    /**
     * Backup data to user folder (for cross-session persistence)
     */
    async createBackup() {
        try {
            const data = await this.loadAll();
            const backup = {
                version: '1.0.0',
                timestamp: new Date().toISOString(),
                data: data
            };

            // Create backup file
            const filename = `turbomock-backup-${new Date().toISOString().split('T')[0]}.json`;
            TurboMockUtils.exportRules([backup], filename);
            
            // Update last backup time in settings
            const settings = await this.getSettings();
            settings.lastBackup = new Date().toISOString();
            await this.saveSettings(settings);
            
            return { success: true, filename };
        } catch (error) {
            console.error('Failed to create backup:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Restore from backup file
     */
    async restoreFromBackup(file) {
        try {
            const data = await TurboMockUtils.importRulesFromFile(file);
            
            if (data.data) {
                // Restore full backup
                const { rules, settings, stats } = data.data;
                
                if (rules) await this.saveRules(rules);
                if (settings) await this.saveSettings(settings);
                if (stats) await this.updateStats(stats);
                
                return { success: true, restored: data };
            } else if (data.rules) {
                // Restore rules only
                await this.saveRules(data.rules);
                return { success: true, restored: data };
            }
            
            return { success: false, error: 'Invalid backup format' };
        } catch (error) {
            console.error('Failed to restore backup:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Clear all data
     */
    async clearAll() {
        try {
            await chrome.storage.local.clear();
            return { success: true };
        } catch (error) {
            console.error('Failed to clear all data:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get storage usage
     */
    async getStorageUsage() {
        try {
            const data = await this.loadAll();
            const dataString = JSON.stringify(data);
            const sizeInBytes = new Blob([dataString]).size;
            
            return {
                sizeInBytes,
                sizeFormatted: TurboMockUtils.formatFileSize(sizeInBytes),
                rulesCount: data.rules.length,
                enabledRulesCount: data.rules.filter(r => r.enabled).length
            };
        } catch (error) {
            console.error('Failed to get storage usage:', error);
            return {
                sizeInBytes: 0,
                sizeFormatted: '0 Bytes',
                rulesCount: 0,
                enabledRulesCount: 0
            };
        }
    }

    /**
     * Migrate data from old versions
     */
    async migrateData(fromVersion, toVersion) {
        try {
            console.log(`Migrating TurboMock data from ${fromVersion} to ${toVersion}`);
            
            // Add migration logic here for future versions
            // For now, just ensure data structure is correct
            const data = await this.loadAll();
            
            // Ensure all rules have required fields
            const migratedRules = data.rules.map(rule => ({
                id: rule.id || TurboMockUtils.generateId(),
                name: rule.name || 'Unnamed Rule',
                enabled: rule.enabled !== false,
                created: rule.created || new Date().toISOString(),
                lastModified: rule.lastModified || null,
                lastUsed: rule.lastUsed || null,
                lastTested: rule.lastTested || null,
                testStatus: rule.testStatus || 'pending',
                hitCount: rule.hitCount || 0,
                match: {
                    method: rule.match?.method || 'GET',
                    url: rule.match?.url || '*',
                    headers: rule.match?.headers || {}
                },
                response: {
                    statusCode: rule.response?.statusCode || 200,
                    statusText: rule.response?.statusText || 'OK',
                    headers: rule.response?.headers || { 'Content-Type': 'application/json' },
                    body: rule.response?.body || {},
                    delay: rule.response?.delay || 0
                },
                testResults: rule.testResults || null
            }));
            
            await this.saveRules(migratedRules);
            
            return { success: true, migratedRules: migratedRules.length };
        } catch (error) {
            console.error('Failed to migrate data:', error);
            return { success: false, error: error.message };
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TurboMockStorage;
} else if (typeof window !== 'undefined') {
    window.TurboMockStorage = TurboMockStorage;
}