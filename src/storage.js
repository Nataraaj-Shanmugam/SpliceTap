/**
 * SpliceTap Storage Manager
 * Handles all data persistence with Chrome storage APIs
 * Now with quota management and backup cleanup
 */

export class SpliceTapStorage {
    constructor() {
        this.storageKeys = {
            rules: 'spliceTapRules',
            active: 'spliceTapActive',
            stats: 'spliceTapStats',
            settings: 'spliceTapSettings',
            metrics: 'spliceTapMetrics',
            chaos: 'spliceTapChaos',
            backupPrefix: 'spliceTapBackup_', // Changed to prefix for multiple backups
            dnrCounter: 'spliceTapDnrCounter' // integer counter, allocates chrome.declarativeNetRequest rule ids
        };

        this.defaultSettings = {
            theme: 'auto',
            notifications: true,
            autoBackup: true,
            debugMode: false,
            shortcuts: {
                toggle: 'Ctrl+Shift+M',
                newRule: 'Ctrl+Shift+N'
            },
            chaosMode: {
                enabled: false,
                failureRate: 0.1
            }
        };

        this.defaultStats = {
            intercepted: 0,
            rulesCount: 0,
            lastReset: new Date().toISOString(),
            lastUpdated: new Date().toISOString()
        };

        // Storage quota constants
        this.QUOTA_BYTES = chrome.storage.local.QUOTA_BYTES || 10485760; // 10MB default
        this.QUOTA_WARNING_THRESHOLD = 0.8; // Warn at 80%
        this.MAX_BACKUPS = 5; // Keep only 5 most recent backups
    }

    async loadAll() {
        try {
            const result = await chrome.storage.local.get(Object.values(this.storageKeys));

            return {
                rules: (result[this.storageKeys.rules] || []).map(rule => this.normalizeRule(rule)),
                active: result[this.storageKeys.active] !== false,
                stats: { ...this.defaultStats, ...result[this.storageKeys.stats] },
                settings: { ...this.defaultSettings, ...result[this.storageKeys.settings] },
                metrics: result[this.storageKeys.metrics] || {}
            };
        } catch (error) {
            console.error('Failed to load data from storage:', error);
            return this.getDefaults();
        }
    }

    getDefaults() {
        return {
            rules: [],
            active: true,
            stats: { ...this.defaultStats },
            settings: { ...this.defaultSettings },
            metrics: {}
        };
    }

    async saveRules(rules) {
        try {
            // Check quota before saving
            await this.checkQuota();

            await chrome.storage.local.set({
                [this.storageKeys.rules]: rules
            });
            
            await this.updateStats({ 
                rulesCount: rules.length,
                lastUpdated: new Date().toISOString()
            });
            
            return { success: true };
        } catch (error) {
            console.error('Failed to save rules:', error);
            
            // Handle quota exceeded error
            if (error.message && error.message.includes('QUOTA_BYTES')) {
                return { success: false, error: 'Storage quota exceeded. Please delete some rules or clear old data.' };
            }
            
            return { success: false, error: error.message };
        }
    }

    async getRules() {
        try {
            const result = await chrome.storage.local.get(this.storageKeys.rules);
            return (result[this.storageKeys.rules] || []).map(rule => this.normalizeRule(rule));
        } catch (error) {
            console.error('Failed to get rules:', error);
            return [];
        }
    }

    /**
     * Migrate a stored rule to schema v2 shape:
     * defaults `type` to 'mock' and, for mock rules, `response.mode` to
     * 'static' when absent. Non-destructive: returns a new object.
     */
    normalizeRule(rule) {
        if (!rule || typeof rule !== 'object') return rule;

        const normalized = { ...rule, type: rule.type || 'mock' };

        if (normalized.type === 'mock' && normalized.response) {
            normalized.response = {
                ...normalized.response,
                mode: normalized.response.mode || 'static'
            };
        }

        return normalized;
    }

    /**
     * Allocate the next integer DNR (declarativeNetRequest) rule id.
     * Starts at 1 and persists under a dedicated counter key so ids are
     * never reused across rule lifetimes.
     */
    async allocateDnrId() {
        try {
            const key = this.storageKeys.dnrCounter;
            const result = await chrome.storage.local.get(key);
            const next = (result[key] || 0) + 1;
            await chrome.storage.local.set({ [key]: next });
            return next;
        } catch (error) {
            console.error('Failed to allocate DNR id:', error);
            throw error;
        }
    }

    async saveRule(rule) {
        try {
            const rules = await this.getRules();
            const existingIndex = rules.findIndex(r => r.id === rule.id);

            if (existingIndex >= 0) {
                rules[existingIndex] = { 
                    ...rule, 
                    lastModified: new Date().toISOString() 
                };
            } else {
                rules.push({ 
                    ...rule, 
                    created: new Date().toISOString(),
                    lastModified: new Date().toISOString()
                });
            }

            const result = await this.saveRules(rules);
            return result.success ? rule : result;
        } catch (error) {
            console.error('Failed to save rule:', error);
            return { success: false, error: error.message };
        }
    }

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

    async getActiveState() {
        try {
            const result = await chrome.storage.local.get(this.storageKeys.active);
            return result[this.storageKeys.active] !== false;
        } catch (error) {
            console.error('Failed to get active state:', error);
            return true;
        }
    }

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
     * P-14: write a full, already-authoritative stats object directly,
     * skipping the get-then-merge that updateStats() does. Used by
     * background.js's throttled persistence, which already holds the
     * complete current stats in memory — re-reading storage first is pure
     * waste there (an extra storage.get on the hot throttled-flush path).
     */
    async setStatsDirect(stats) {
        try {
            const newStats = { ...stats, lastUpdated: new Date().toISOString() };
            await chrome.storage.local.set({ [this.storageKeys.stats]: newStats });
            return { success: true, stats: newStats };
        } catch (error) {
            console.error('Failed to set stats:', error);
            return { success: false, error: error.message };
        }
    }

    async getStats() {
        try {
            const result = await chrome.storage.local.get(this.storageKeys.stats);
            return { ...this.defaultStats, ...result[this.storageKeys.stats] };
        } catch (error) {
            console.error('Failed to get stats:', error);
            return { ...this.defaultStats };
        }
    }

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
     * Check storage quota and warn if approaching limit
     */
    async checkQuota() {
        try {
            const bytesInUse = await chrome.storage.local.getBytesInUse();
            const percentUsed = bytesInUse / this.QUOTA_BYTES;

            if (percentUsed > this.QUOTA_WARNING_THRESHOLD) {
                console.warn(`Storage quota warning: ${Math.round(percentUsed * 100)}% used (${this.formatBytes(bytesInUse)} / ${this.formatBytes(this.QUOTA_BYTES)})`);
                
                // Auto-cleanup old backups if over threshold
                if (percentUsed > 0.9) {
                    await this.cleanOldBackups(2); // Keep only 2 when critically low
                } else {
                    await this.cleanOldBackups(this.MAX_BACKUPS);
                }
            }

            return {
                bytesInUse,
                quota: this.QUOTA_BYTES,
                percentUsed: percentUsed * 100,
                warning: percentUsed > this.QUOTA_WARNING_THRESHOLD
            };
        } catch (error) {
            console.error('Failed to check quota:', error);
            return null;
        }
    }

    /**
     * Backup data to local storage with automatic cleanup
     */
    async createBackup() {
        try {
            // Check quota first
            await this.checkQuota();

            const data = await this.loadAll();
            const timestamp = new Date().toISOString();
            const backupKey = `${this.storageKeys.backupPrefix}${timestamp}`;
            
            const backup = {
                version: '1.0.0',
                timestamp: timestamp,
                data: data
            };

            // Store backup
            await chrome.storage.local.set({ [backupKey]: backup });

            // Clean old backups (keep only MAX_BACKUPS)
            await this.cleanOldBackups(this.MAX_BACKUPS);

            // Update last backup time in settings
            const settings = await this.getSettings();
            settings.lastBackup = timestamp;
            await this.saveSettings(settings);

            console.log(`Backup created: ${backupKey}`);
            return { success: true, backup, key: backupKey };
        } catch (error) {
            console.error('Failed to create backup:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Clean old backups, keeping only the most recent ones
     */
    async cleanOldBackups(keepCount = 5) {
        try {
            const allData = await chrome.storage.local.get(null);
            
            // Find all backup keys
            const backupKeys = Object.keys(allData)
                .filter(key => key.startsWith(this.storageKeys.backupPrefix))
                .map(key => ({
                    key,
                    timestamp: allData[key].timestamp,
                    date: new Date(allData[key].timestamp)
                }))
                .sort((a, b) => b.date - a.date); // Sort newest first

            // Determine which to delete
            const toDelete = backupKeys.slice(keepCount).map(b => b.key);

            if (toDelete.length > 0) {
                await chrome.storage.local.remove(toDelete);
                console.log(`Cleaned ${toDelete.length} old backup(s)`);
            }

            return { success: true, deleted: toDelete.length, kept: Math.min(backupKeys.length, keepCount) };
        } catch (error) {
            console.error('Failed to clean old backups:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get all available backups
     */
    async getAllBackups() {
        try {
            const allData = await chrome.storage.local.get(null);
            
            const backups = Object.keys(allData)
                .filter(key => key.startsWith(this.storageKeys.backupPrefix))
                .map(key => ({
                    key,
                    ...allData[key]
                }))
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            return backups;
        } catch (error) {
            console.error('Failed to get backups:', error);
            return [];
        }
    }

    /**
     * Restore from a specific backup
     */
    async restoreFromBackup(backupKey) {
        try {
            const result = await chrome.storage.local.get(backupKey);
            const backup = result[backupKey];

            if (!backup || !backup.data) {
                return { success: false, error: 'Backup not found or invalid' };
            }

            const { rules, settings, stats } = backup.data;

            if (rules) await this.saveRules(rules);
            if (settings) await this.saveSettings(settings);
            if (stats) await this.updateStats(stats);

            return { success: true, restored: backup };
        } catch (error) {
            console.error('Failed to restore backup:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Restore from uploaded backup file
     */
    async restoreFromFile(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);

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

    async clearAll() {
        try {
            await chrome.storage.local.clear();
            return { success: true };
        } catch (error) {
            console.error('Failed to clear all data:', error);
            return { success: false, error: error.message };
        }
    }

    async getStorageUsage() {
        try {
            const bytesInUse = await chrome.storage.local.getBytesInUse();
            const data = await this.loadAll();

            return {
                bytesInUse,
                quota: this.QUOTA_BYTES,
                percentUsed: (bytesInUse / this.QUOTA_BYTES) * 100,
                sizeFormatted: this.formatBytes(bytesInUse),
                quotaFormatted: this.formatBytes(this.QUOTA_BYTES),
                rulesCount: data.rules.length,
                enabledRulesCount: data.rules.filter(r => r.enabled).length,
                warning: bytesInUse > this.QUOTA_BYTES * this.QUOTA_WARNING_THRESHOLD
            };
        } catch (error) {
            console.error('Failed to get storage usage:', error);
            return {
                bytesInUse: 0,
                quota: this.QUOTA_BYTES,
                percentUsed: 0,
                sizeFormatted: '0 Bytes',
                quotaFormatted: this.formatBytes(this.QUOTA_BYTES),
                rulesCount: 0,
                enabledRulesCount: 0,
                warning: false
            };
        }
    }

    /**
     * Format bytes to human readable size
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Generate unique ID for rules
     */
    generateId(prefix = 'rule') {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

// Also expose as global for non-module contexts (popup, options page)
if (typeof window !== 'undefined') {
    window.SpliceTapStorage = SpliceTapStorage;
}