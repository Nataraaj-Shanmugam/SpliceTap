/**
 * SpliceTap Storage Manager
 * Handles all data persistence with Chrome storage APIs
 * Quota-aware, with all persistence serialized through one mutation chain.
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
            dnrCounter: 'spliceTapDnrCounter' // integer counter, allocates chrome.declarativeNetRequest rule ids
        };

        // CQ-5: `notifications` and `autoBackup` were removed — no runtime code
        // ever read either, and options.js already documents them as dead.
        this.defaultSettings = {
            theme: 'auto',
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

        // QA-2: saveRule/deleteRule/toggleRule are read-modify-write
        // (getRules -> mutate -> saveRules). Run concurrently — popup and
        // options open at once, or an import racing a toggle — the second read
        // sees the pre-first-write array and its write clobbers the first,
        // silently dropping a rule while both callers are told they succeeded.
        // Reproduced: two concurrent saveRule calls left only one rule stored.
        //
        // Every such operation is funnelled through this promise chain so they
        // execute one at a time. This mirrors allocateDnrIdSerialized() in
        // background.js, which already solved exactly this race for the DNR id
        // counter but was never applied to the rules array itself.
        this._mutationChain = Promise.resolve();
    }

    /**
     * Queue a read-modify-write behind any mutation already in flight.
     * The chain deliberately swallows rejections for the *chain's* purposes
     * (so one failure doesn't wedge every later write) while still returning
     * the real result — success or failure — to this particular caller.
     */
    _serializeMutation(operation) {
        const result = this._mutationChain.then(operation, operation);
        this._mutationChain = result.then(() => undefined, () => undefined);
        return result;
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
            // PERF-9: this ran getBytesInUse() before every single save — a
            // scan of all extension storage to answer a question that only
            // changes slowly. Throttled to once a minute; the write itself
            // still surfaces a genuine QUOTA_BYTES failure through the catch
            // below, so nothing depends on the pre-check to stay correct.
            const now = Date.now();
            if (now - (this._lastQuotaCheck || 0) > 60000) {
                this._lastQuotaCheck = now;
                await this.checkQuota();
            }

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

    /**
     * Whole-array replacement (bulk import, clear-all), queued behind any
     * in-flight single-rule mutation.
     *
     * This is a separate entry point rather than serialization inside
     * saveRules() because saveRule/deleteRule/toggleRule call saveRules() from
     * *within* the chain — serializing it there would make them await a lock
     * they already hold, and deadlock.
     *
     * Note this closes the storage-level race only. Import still merges in the
     * popup (getRules -> combine -> setRules), so a rule created between those
     * two steps can still be missed; fixing that needs the merge to move into
     * the background, which is a larger change than a launch fix.
     */
    async replaceRules(rules) {
        return this._serializeMutation(() => this.saveRules(rules));
    }

    /**
     * Upsert a rule by id. Returns a uniform { success, rule?, error? } — the
     * old contract returned the bare rule on success and a result object on
     * failure, which is exactly why background.js's `savedRule` could hold an
     * error object while the handler still answered success:true (QA-1).
     */
    async saveRule(rule) {
        return this._serializeMutation(async () => {
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
                return result.success
                    ? { success: true, rule }
                    : { success: false, error: result.error };
            } catch (error) {
                console.error('Failed to save rule:', error);
                return { success: false, error: error.message };
            }
        });
    }

    async deleteRule(ruleId) {
        return this._serializeMutation(async () => {
            try {
                const rules = await this.getRules();
                const filteredRules = rules.filter(r => r.id !== ruleId);
                return await this.saveRules(filteredRules);
            } catch (error) {
                console.error('Failed to delete rule:', error);
                return { success: false, error: error.message };
            }
        });
    }

    async toggleRule(ruleId, enabled) {
        return this._serializeMutation(async () => {
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
        });
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
                // CQ-5: this used to prune old backups here. Nothing in the
                // product ever created one — createBackup() had no callers —
                // so it was scanning storage to delete keys that never exist,
                // on a path that runs before every rule save.
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
}

// Also expose as global for non-module contexts (popup, options page)
if (typeof window !== 'undefined') {
    window.SpliceTapStorage = SpliceTapStorage;
}