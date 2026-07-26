
const { SpliceTapPlaceholders } = require('../src/index');

describe('Dynamic Responses', () => {
    test('should replace {{timestamp}}', () => {
        const body = { time: '{{timestamp}}' };
        const result = SpliceTapPlaceholders.processDynamicResponse(body);
        expect(result.time).not.toBe('{{timestamp}}');
        // Check if it looks like an ISO date
        expect(new Date(result.time).toISOString()).toBe(result.time);
    });

    test('should replace {{randomInt}}', () => {
        const body = { id: '{{randomInt}}' };
        const result = SpliceTapPlaceholders.processDynamicResponse(body);
        expect(result.id).not.toBe('{{randomInt}}');
        const num = parseInt(result.id);
        expect(num).toBeGreaterThanOrEqual(0);
        expect(num).toBeLessThan(1000);
    });

    test('should replace {{guid}}', () => {
        const body = { uuid: '{{guid}}' };
        const result = SpliceTapPlaceholders.processDynamicResponse(body);
        expect(result.uuid.length).toBe(36);
        expect(result.uuid[14]).toBe('4'); // Version 4 UUID
    });

    test('should handle string input', () => {
        const body = 'Current time: {{timestamp_ms}}';
        const result = SpliceTapPlaceholders.processDynamicResponse(body);
        expect(result).not.toContain('{{timestamp_ms}}');
        expect(parseInt(result.split(': ')[1])).toBeGreaterThan(0);
    });
});
