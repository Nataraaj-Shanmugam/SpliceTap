/**
 * TurboMock Utility Functions
 * Shared utilities for request matching, validation, and data handling
 */

class TurboMockUtils {
    /**
     * Generate unique ID for rules
     */
    static generateId(prefix = 'rule') {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Validate URL pattern
     */
    static validateUrlPattern(pattern) {
        if (!pattern || typeof pattern !== 'string') {
            return { isValid: false, error: 'Pattern must be a non-empty string' };
        }

        try {
            if (pattern.includes('*')) {
                // Convert wildcard pattern to regex
                const regexPattern = pattern
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    .replace(/\\\*/g, '.*');
                new RegExp(regexPattern, 'i');
                return { isValid: true };
            } else if (pattern.startsWith('/') && pattern.endsWith('/')) {
                // Validate regex pattern
                const regexBody = pattern.slice(1, -1);
                new RegExp(regexBody, 'i');
                return { isValid: true };
            } else {
                // Simple string match
                return { isValid: true };
            }
        } catch (error) {
            return { isValid: false, error: `Invalid pattern: ${error.message}` };
        }
    }

    /**
     * Match URL against pattern
     */
    static matchUrl(url, pattern) {
        if (!url || !pattern) return false;

        try {
            if (pattern.includes('*')) {
                const regexPattern = pattern
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    .replace(/\\\*/g, '.*');
                const regex = new RegExp('^' + regexPattern + '$', 'i');
                return regex.test(url);
            } else if (pattern.startsWith('/') && pattern.endsWith('/')) {
                const regexBody = pattern.slice(1, -1);
                const regex = new RegExp(regexBody, 'i');
                return regex.test(url);
            } else {
                return url.toLowerCase().includes(pattern.toLowerCase());
            }
        } catch (error) {
            console.error('Error matching URL pattern:', error);
            return false;
        }
    }

    /**
     * Validate JSON string
     */
    static validateJSON(jsonString) {
        if (!jsonString) return { isValid: true, data: null };
        
        try {
            const data = JSON.parse(jsonString);
            return { isValid: true, data };
        } catch (error) {
            return { isValid: false, error: error.message };
        }
    }

    /**
     * Validate HTTP status code
     */
    static validateStatusCode(code) {
        const numCode = parseInt(code, 10);
        if (isNaN(numCode) || numCode < 100 || numCode > 599) {
            return { isValid: false, error: 'Status code must be between 100 and 599' };
        }
        return { isValid: true, code: numCode };
    }

    /**
     * Get status text for HTTP code
     */
    static getStatusText(code) {
        const statusTexts = {
            200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
            400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
            405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity',
            500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
            503: 'Service Unavailable', 504: 'Gateway Timeout'
        };
        return statusTexts[code] || '';
    }

    /**
     * Escape HTML entities
     */
    static escapeHtml(text) {
        if (typeof text !== 'string') return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Deep clone object
     */
    static deepClone(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (obj instanceof Date) return new Date(obj.getTime());
        if (obj instanceof Array) return obj.map(TurboMockUtils.deepClone);
        if (typeof obj === 'object') {
            const cloned = {};
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    cloned[key] = TurboMockUtils.deepClone(obj[key]);
                }
            }
            return cloned;
        }
        return obj;
    }

    /**
     * Debounce function execution
     */
    static debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /**
     * Format file size
     */
    static formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Format timestamp for display
     */
    static formatTimestamp(timestamp) {
        if (!timestamp) return 'Never';
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
        return date.toLocaleDateString();
    }

    /**
     * Create data URL for response body
     */
    static createDataUrl(body, contentType = 'application/json') {
        const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
        return `data:${contentType};charset=utf-8,${encodeURIComponent(bodyString)}`;
    }

    /**
     * Parse headers from various formats
     */
    static parseHeaders(headers) {
        if (!headers) return {};
        
        if (typeof headers === 'string') {
            try {
                return JSON.parse(headers);
            } catch {
                // Parse header string format
                const parsed = {};
                headers.split('\n').forEach(line => {
                    const [key, ...values] = line.split(':');
                    if (key && values.length > 0) {
                        parsed[key.trim()] = values.join(':').trim();
                    }
                });
                return parsed;
            }
        }
        
        if (Array.isArray(headers)) {
            const parsed = {};
            headers.forEach(header => {
                if (header.name && header.value) {
                    parsed[header.name] = header.value;
                }
            });
            return parsed;
        }
        
        return typeof headers === 'object' ? headers : {};
    }

    /**
     * Export rules to JSON file
     */
    static exportRules(rules, filename = 'turbomock-rules.json') {
        const dataStr = JSON.stringify({
            version: '1.0.0',
            exported: new Date().toISOString(),
            rules: rules
        }, null, 2);
        
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        URL.revokeObjectURL(url);
    }

    /**
     * Import rules from file
     */
    static async importRulesFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    
                    if (!data.rules || !Array.isArray(data.rules)) {
                        reject(new Error('Invalid file format: missing rules array'));
                        return;
                    }
                    
                    // Validate each rule
                    const validRules = data.rules.filter(rule => {
                        return rule.id && rule.name && rule.match && rule.response;
                    });
                    
                    resolve({
                        version: data.version || '1.0.0',
                        imported: new Date().toISOString(),
                        rules: validRules,
                        skipped: data.rules.length - validRules.length
                    });
                } catch (error) {
                    reject(new Error(`Failed to parse JSON: ${error.message}`));
                }
            };
            
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    /**
     * Create rule template
     */
    static createRuleTemplate(type = 'success') {
        const baseRule = {
            id: this.generateId(),
            name: 'New Rule',
            enabled: true,
            created: new Date().toISOString(),
            match: {
                method: 'GET',
                url: '*/api/*',
                headers: {}
            },
            testStatus: 'pending',
            hitCount: 0
        };

        const templates = {
            success: {
                ...baseRule,
                name: 'Success Response',
                response: {
                    statusCode: 200,
                    statusText: 'OK',
                    headers: { 'Content-Type': 'application/json' },
                    body: { success: true, message: 'Mock response' },
                    delay: 0
                }
            },
            error: {
                ...baseRule,
                name: 'Error Response',
                response: {
                    statusCode: 500,
                    statusText: 'Internal Server Error',
                    headers: { 'Content-Type': 'application/json' },
                    body: { error: 'Mock server error', code: 'INTERNAL_ERROR' },
                    delay: 0
                }
            },
            notFound: {
                ...baseRule,
                name: 'Not Found',
                response: {
                    statusCode: 404,
                    statusText: 'Not Found',
                    headers: { 'Content-Type': 'application/json' },
                    body: { error: 'Resource not found', code: 'NOT_FOUND' },
                    delay: 0
                }
            },
            unauthorized: {
                ...baseRule,
                name: 'Unauthorized',
                response: {
                    statusCode: 401,
                    statusText: 'Unauthorized',
                    headers: { 'Content-Type': 'application/json' },
                    body: { error: 'Authentication required', code: 'UNAUTHORIZED' },
                    delay: 0
                }
            },
            delayed: {
                ...baseRule,
                name: 'Delayed Response',
                response: {
                    statusCode: 200,
                    statusText: 'OK',
                    headers: { 'Content-Type': 'application/json' },
                    body: { success: true, message: 'Delayed response' },
                    delay: 2000
                }
            }
        };

        return templates[type] || templates.success;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TurboMockUtils;
} else if (typeof window !== 'undefined') {
    window.TurboMockUtils = TurboMockUtils;
}