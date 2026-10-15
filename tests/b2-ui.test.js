/**
 * Batch 2, group G6 (popup + DevTools panel): the parts that need no browser.
 * The behaviour in Chrome is in tests/e2e/b2-ui.e2e.test.js.
 */

const P = require('../popup/popup-helpers.js');

describe('B2-F6: Requestly import helpers', () => {
    const rule = (over = {}) => ({ id: 'a', name: 'A', ruleType: 'Cancel', status: 'Active', objectType: 'rule', pairs: [{ source: {} }], ...over });

    test('counts rules in an array export and in {rules: []}, and not groups', () => {
        const group = { id: 'g', name: 'Group', objectType: 'group' };
        expect(P.countRequestlyRules([rule(), rule({ id: 'b' }), group])).toBe(2);
        expect(P.countRequestlyRules({ rules: [rule(), group] })).toBe(1);
    });

    test('counts nothing in values that are not an export', () => {
        for (const value of [null, undefined, 3, 'x', {}, [], [1, 'a', null], { rules: 'no' }, [{ name: 'SpliceTap rule', type: 'block' }]]) {
            expect(P.countRequestlyRules(value)).toBe(0);
        }
    });

    test('labels the action with a singular and a plural', () => {
        expect(P.convertLabel(1)).toBe('Convert 1 Requestly rule');
        expect(P.convertLabel(3)).toBe('Convert 3 Requestly rules');
    });

    test('finds the importer only when it has detect and convert', () => {
        const detect = () => true;
        const convert = () => ({});
        expect(P.requestlyImporter({ SpliceTapImporters: { requestly: { detect, convert } } })).toEqual({ detect, convert });
        expect(P.requestlyImporter({ SpliceTapImporters: { requestly: { detect } } })).toBeNull();
        expect(P.requestlyImporter({ SpliceTapImporters: {} })).toBeNull();
        expect(P.requestlyImporter({})).toBeNull();
    });

    test('a detect() that throws is "not Requestly", never an exception', () => {
        expect(P.detectRequestly({ detect: () => { throw new Error('boom'); } }, [])).toBe(false);
        expect(P.detectRequestly(null, [])).toBe(false);
        expect(P.detectRequestly({ detect: () => 1 }, [])).toBe(true);
    });

    test('normalises a converter result and tolerates holes in it', () => {
        expect(P.normalizeConversion(undefined)).toEqual({ rules: [], skipped: [], warnings: [] });
        expect(P.normalizeConversion({
            rules: [{ name: 'x' }, null, 'junk'],
            skipped: [{ name: 'S', reason: 'Script rules are not supported' }, {}, null],
            warnings: [{ name: 'W', message: 'careful' }, { name: 'empty' }]
        })).toEqual({
            rules: [{ name: 'x' }],
            skipped: [
                { name: 'S', reason: 'Script rules are not supported' },
                { name: '', reason: 'not converted' },
                { name: '', reason: 'not converted' }
            ],
            warnings: [{ name: 'W', message: 'careful' }]
        });
    });

    describe('importSummary', () => {
        test('keeps the plain-import wording the popup always used', () => {
            expect(P.importSummary({ added: 1 })).toBe('Imported 1 rule');
            expect(P.importSummary({ added: 3, replaced: 2 })).toBe('Imported 3 rules, replacing 2');
            expect(P.importSummary({ added: 1, duplicates: 1, invalid: 2 })).toBe('Imported 1 rule, skipped 3 (1 duplicate, 2 invalid)');
            expect(P.importSummary({ added: 0, duplicates: 2 })).toBe('Imported 0 rules, skipped 2 (2 duplicates)');
        });

        test('speaks of a conversion when it is given a total', () => {
            expect(P.importSummary({ total: 8, added: 5, notConverted: 2, duplicates: 1 }))
                .toBe('Converted 6 of 8 Requestly rules, imported 5, skipped 3 (2 not converted, 1 duplicate)');
            expect(P.importSummary({ total: 1, added: 1 })).toBe('Converted 1 of 1 Requestly rule, imported 1');
            expect(P.importSummary({ total: 3, converted: 3, added: 3, replaced: 4 })).toBe('Converted 3 of 3 Requestly rules, imported 3, replacing 4');
        });
    });
});

describe('PER-58: the per-tab status line', () => {
    const NOW = 1_000_000;

    test('says so when nothing was intercepted', () => {
        expect(P.tabStatusText([], NOW)).toBe('Nothing intercepted on this tab yet');
        expect(P.tabStatusText(undefined, NOW)).toBe('Nothing intercepted on this tab yet');
        expect(P.tabStatusText(null, NOW)).toBe('Nothing intercepted on this tab yet');
    });

    test('counts the entries and ages the newest one', () => {
        expect(P.tabStatusText([{ ts: NOW - 5000 }], NOW)).toBe('This tab: 1 intercepted · last 5 s ago');
        // Entries are in any order: the newest decides.
        expect(P.tabStatusText([{ ts: NOW - 90000 }, { ts: NOW - 12000 }, { ts: NOW - 30000 }], NOW))
            .toBe('This tab: 3 intercepted · last 12 s ago');
    });

    test('moves up a unit as the age grows, and never reads negative', () => {
        expect(P.formatAgo(0)).toBe('0 s ago');
        expect(P.formatAgo(59999)).toBe('59 s ago');
        expect(P.formatAgo(60000)).toBe('1 min ago');
        expect(P.formatAgo(59 * 60000)).toBe('59 min ago');
        expect(P.formatAgo(3600000)).toBe('1 h ago');
        expect(P.formatAgo(23 * 3600000)).toBe('23 h ago');
        expect(P.formatAgo(24 * 3600000)).toBe('1 d ago');
        expect(P.formatAgo(-5000)).toBe('0 s ago');
        expect(P.formatAgo(NaN)).toBe('0 s ago');
    });

    test('an entry with no usable timestamp counts but has no age', () => {
        expect(P.tabStatusText([{ url: 'x' }, { ts: 'later' }], NOW)).toBe('This tab: 2 intercepted');
    });
});

describe('PER-59: the shadowing chip', () => {
    test('a regex pattern is the only thing the popup cannot ask about', () => {
        expect(P.isRegexPattern('/api\\/users/')).toBe(true);
        expect(P.isRegexPattern('*/api/users*')).toBe(false);
        expect(P.isRegexPattern('https://example.test/api/')).toBe(false);
        expect(P.isRegexPattern('/')).toBe(false);
        expect(P.isRegexPattern('//')).toBe(false);
        expect(P.isRegexPattern('')).toBe(false);
        expect(P.isRegexPattern(undefined)).toBe(false);
    });

    test('names the first shadowing rule and counts the others', () => {
        expect(P.shadowChipText([])).toBe('');
        expect(P.shadowChipText(undefined)).toBe('');
        expect(P.shadowChipText([{ ruleId: 'a', ruleName: 'Mock all' }])).toBe('Shadowed by Mock all');
        expect(P.shadowChipText([{ ruleId: 'a', ruleName: 'Mock all' }, { ruleId: 'b', ruleName: 'Other' }, { ruleId: 'c', ruleName: 'Third' }]))
            .toBe('Shadowed by Mock all +2');
        expect(P.shadowChipText([{ ruleId: 'a' }])).toBe('Shadowed by (unnamed rule)');
    });
});
