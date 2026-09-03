/**
 * SpliceTap Utility Functions
 * Shared utilities for request matching, validation, and data handling
 * Enhanced with better validation and more dynamic placeholders
 */

// Side-effect imports of the UMD shared modules (src/matcher.js, src/placeholders.js)
// so their globals are always populated wherever this file is loaded — including the
// MV3 service worker, which has no `window` (CQ-Q6). Each of those files falls back to
// `globalThis` internally when `window` is undefined, so this works in every context.
import './matcher.js';
import './placeholders.js';

export class SpliceTapUtils {
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
                // SEC-1: compiling only proves the syntax is legal, not that the
                // pattern terminates. A shape like /(a|a)+$/ compiles fine and
                // then hangs the tab for ~42s per request. Reject it at save
                // time so it can never reach the interceptor.
                const matcher = (typeof window !== 'undefined' && window.SpliceTapMatcher)
                    || (typeof globalThis !== 'undefined' && globalThis.SpliceTapMatcher);
                if (matcher && matcher.isCatastrophicRegex && matcher.isCatastrophicRegex(regexBody)) {
                    return {
                        isValid: false,
                        error: 'This regex can backtrack catastrophically and would freeze the page. Simplify it — nested or ambiguous repetition like (a|a)+ is the usual cause.'
                    };
                }
                return { isValid: true };
            } else {
                // Literal string pattern
                return { isValid: true };
            }
        } catch (error) {
            return { isValid: false, error: `Invalid pattern: ${error.message}` };
        }
    }

    // Delegates to SpliceTapMatcher (src/matcher.js).
    // Kept here as a thin wrapper for backward compatibility with existing
    // callers of SpliceTapUtils.matchUrl. Uses globalThis (not window) so this
    // does not throw a ReferenceError when called from the MV3 service worker,
    // which has no `window` global (CQ-Q6).
    static matchUrl(url, pattern) {
        return globalThis.SpliceTapMatcher.matchUrl(url, pattern);
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
        if (obj instanceof Array) return obj.map(item => SpliceTapUtils.deepClone(item));
        
        if (typeof obj === 'object') {
            const cloned = {};
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    cloned[key] = SpliceTapUtils.deepClone(obj[key]);
                }
            }
            return cloned;
        }
        return obj;
    }









    /**
     * Process dynamic response with enhanced placeholders.
     * Delegates to SpliceTapPlaceholders (src/placeholders.js).
     * Kept here as a thin wrapper for backward compatibility with existing
     * callers of SpliceTapUtils.processDynamicResponse. Uses globalThis (not
     * window) so this does not throw a ReferenceError in the MV3 service
     * worker, which has no `window` global (CQ-Q6).
     */
    static processDynamicResponse(body, requestDetails = {}) {
        return globalThis.SpliceTapPlaceholders.processDynamicResponse(body, requestDetails);
    }


}

// Also expose as global for non-module contexts
if (typeof window !== 'undefined') {
    window.SpliceTapUtils = SpliceTapUtils;
}