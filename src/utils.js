/**
 * TurboMock Utility Functions
 * Shared utilities for request matching, validation, and data handling
 * Enhanced with better validation and more dynamic placeholders
 */

// Side-effect imports of the UMD shared modules (src/matcher.js, src/placeholders.js)
// so their globals are always populated wherever this file is loaded — including the
// MV3 service worker, which has no `window` (CQ-Q6). Each of those files falls back to
// `globalThis` internally when `window` is undefined, so this works in every context.
import './matcher.js';
import './placeholders.js';

export class TurboMockUtils {
    static generateId(prefix = 'rule') {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    static validateUrlPattern(pattern) {
        // Enhanced validation with edge cases
        if (!pattern) {
            return { isValid: false, error: 'Pattern is required' };
        }

        if (typeof pattern !== 'string') {
            return { isValid: false, error: 'Pattern must be a string' };
        }

        if (pattern.trim().length === 0) {
            return { isValid: false, error: 'Pattern cannot be empty' };
        }

        if (pattern.length > 500) {
            return { isValid: false, error: 'Pattern is too long (max 500 characters)' };
        }

        try {
            if (pattern.includes('*')) {
                // Wildcard pattern - convert to regex for validation
                const regexPattern = pattern
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    .replace(/\\\*/g, '.*');
                new RegExp(regexPattern, 'i');
                return { isValid: true };
            } else if (pattern.startsWith('/') && pattern.endsWith('/')) {
                // Regex pattern
                const regexBody = pattern.slice(1, -1);
                if (regexBody.length === 0) {
                    return { isValid: false, error: 'Regex pattern cannot be empty' };
                }
                new RegExp(regexBody, 'i');
                return { isValid: true };
            } else {
                // Literal string pattern
                return { isValid: true };
            }
        } catch (error) {
            return { isValid: false, error: `Invalid pattern: ${error.message}` };
        }
    }

    // Delegates to TurboMockMatcher (src/matcher.js) — see TODO.md §1.3.
    // Kept here as a thin wrapper for backward compatibility with existing
    // callers of TurboMockUtils.matchUrl. Uses globalThis (not window) so this
    // does not throw a ReferenceError when called from the MV3 service worker,
    // which has no `window` global (CQ-Q6).
    static matchUrl(url, pattern) {
        return globalThis.TurboMockMatcher.matchUrl(url, pattern);
    }

    static validateJSON(jsonString) {
        if (!jsonString) return { isValid: true, data: null };

        if (typeof jsonString !== 'string') {
            return { isValid: false, error: 'Input must be a string' };
        }

        try {
            const data = JSON.parse(jsonString);
            return { isValid: true, data };
        } catch (error) {
            return { isValid: false, error: error.message };
        }
    }

    static validateStatusCode(code) {
        const numCode = parseInt(code, 10);
        
        if (isNaN(numCode)) {
            return { isValid: false, error: 'Status code must be a number' };
        }

        if (numCode < 100 || numCode > 599) {
            return { isValid: false, error: 'Status code must be between 100 and 599' };
        }

        return { isValid: true, code: numCode };
    }

    static getStatusText(code) {
        const statusTexts = {
            // 1xx Informational
            100: 'Continue', 101: 'Switching Protocols', 102: 'Processing',
            // 2xx Success
            200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
            204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
            // 3xx Redirection
            300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found',
            303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
            // 4xx Client Error
            400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden',
            404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
            408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 422: 'Unprocessable Entity',
            429: 'Too Many Requests',
            // 5xx Server Error
            500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
            503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported'
        };
        return statusTexts[code] || 'Unknown Status';
    }

    // S-6: the textContent -> innerHTML round-trip escapes & < > but NOT
    // quotes, which is unsafe when the output is placed inside an HTML
    // attribute (e.g. title="${escapeHtml(x)}"). Escape explicitly instead.
    static escapeHtml(text) {
        if (typeof text !== 'string') return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    static deepClone(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (obj instanceof Date) return new Date(obj.getTime());
        if (obj instanceof Array) return obj.map(item => TurboMockUtils.deepClone(item));
        
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

    static formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    static formatTimestamp(timestamp) {
        if (!timestamp) return 'Never';
        
        try {
            const date = new Date(timestamp);
            const now = new Date();
            const diff = now - date;

            if (diff < 0) return 'Future';
            if (diff < 60000) return 'Just now';
            if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
            if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
            if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
            
            return date.toLocaleDateString();
        } catch (error) {
            return 'Invalid date';
        }
    }

    static createDataUrl(body, contentType = 'application/json') {
        const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
        return `data:${contentType};charset=utf-8,${encodeURIComponent(bodyString)}`;
    }

    static parseHeaders(headers) {
        if (!headers) return {};

        if (typeof headers === 'string') {
            try {
                return JSON.parse(headers);
            } catch {
                // Parse as header string
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
                if (header.name && header.value !== undefined) {
                    parsed[header.name] = header.value;
                }
            });
            return parsed;
        }

        return typeof headers === 'object' ? headers : {};
    }

    static exportRules(rules, filename = 'turbomock-rules.json') {
        try {
            const dataStr = JSON.stringify({
                version: '1.0.0',
                exported: new Date().toISOString(),
                rulesCount: rules.length,
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

            // Clean up
            setTimeout(() => URL.revokeObjectURL(url), 100);
        } catch (error) {
            console.error('Failed to export rules:', error);
            throw new Error(`Export failed: ${error.message}`);
        }
    }

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
                    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
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

    /**
     * Process dynamic response with enhanced placeholders.
     * Delegates to TurboMockPlaceholders (src/placeholders.js) — see TODO.md §1.3.
     * Kept here as a thin wrapper for backward compatibility with existing
     * callers of TurboMockUtils.processDynamicResponse. Uses globalThis (not
     * window) so this does not throw a ReferenceError in the MV3 service
     * worker, which has no `window` global (CQ-Q6).
     */
    static processDynamicResponse(body, requestDetails = {}) {
        return globalThis.TurboMockPlaceholders.processDynamicResponse(body, requestDetails);
    }

    /**
     * Sanitize user input to prevent XSS
     */
    static sanitizeInput(input, maxLength = 1000) {
        if (!input) return '';
        
        let sanitized = String(input).trim();
        
        // Truncate if too long
        if (sanitized.length > maxLength) {
            sanitized = sanitized.substring(0, maxLength);
        }
        
        // Remove any HTML tags
        sanitized = sanitized.replace(/<[^>]*>/g, '');
        
        // Remove any script-like content
        sanitized = sanitized.replace(/javascript:/gi, '');
        sanitized = sanitized.replace(/on\w+\s*=/gi, '');
        
        return sanitized;
    }

    /**
     * Validate rule object structure
     */
    static validateRuleStructure(rule) {
        const errors = [];

        if (!rule) {
            errors.push('Rule is required');
            return { isValid: false, errors };
        }

        if (!rule.id) errors.push('Rule ID is required');
        if (!rule.name || rule.name.trim().length === 0) errors.push('Rule name is required');
        if (!rule.match) errors.push('Rule match configuration is required');
        if (!rule.response) errors.push('Rule response configuration is required');

        if (rule.match) {
            if (!rule.match.url) errors.push('URL pattern is required');
            if (!rule.match.method) errors.push('HTTP method is required');
        }

        if (rule.response) {
            if (!rule.response.statusCode) errors.push('Status code is required');
            if (!rule.response.statusText) errors.push('Status text is required');
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }
}

// Also expose as global for non-module contexts
if (typeof window !== 'undefined') {
    window.TurboMockUtils = TurboMockUtils;
}