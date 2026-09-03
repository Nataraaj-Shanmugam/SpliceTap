const { escapeHtml, generateId, LIMITS } = require('../src/common');
const { listTemplates, getTemplate, getStatusText } = require('../src/templates');

describe('escapeHtml', () => {
    test('escapes every character that can break out of markup or an attribute', () => {
        expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
        expect(escapeHtml('a & b')).toBe('a &amp; b');
        expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
        expect(escapeHtml("it's")).toBe('it&#39;s');
        expect(escapeHtml('a/b')).toBe('a&#47;b');
    });

    test('escaping quotes matters because output lands in attributes', () => {
        // A rule name is interpolated into title="..." — escaping only & < >
        // would let a crafted name close the attribute and add its own.
        const hostile = '" onmouseover="alert(1)';
        expect(escapeHtml(hostile)).not.toContain('"');
    });

    test('null and undefined become empty strings, not "null"', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });

    test('coerces non-strings rather than throwing', () => {
        expect(escapeHtml(42)).toBe('42');
        expect(escapeHtml(true)).toBe('true');
    });

    test('leaves ordinary text untouched', () => {
        expect(escapeHtml('User Profile API')).toBe('User Profile API');
    });
});

describe('generateId', () => {
    test('defaults to the rule_ prefix every surface expects', () => {
        // CQ-6: options.js used to emit `item-...` here, so a rule created on
        // the options page was shaped differently from the same rule created
        // anywhere else.
        expect(generateId()).toMatch(/^rule_\d+_[a-z0-9]+$/);
    });

    test('honours a custom prefix', () => {
        expect(generateId('cap')).toMatch(/^cap_\d+_[a-z0-9]+$/);
    });

    test('does not collide across rapid successive calls', () => {
        const ids = new Set(Array.from({ length: 500 }, () => generateId()));
        expect(ids.size).toBe(500);
    });
});

describe('LIMITS', () => {
    test('exposes one definition of every rule-schema bound', () => {
        expect(LIMITS).toEqual({
            NAME_MAX: 100,
            URL_MAX: 500,
            STATUS_MIN: 100,
            STATUS_MAX: 599,
            DELAY_MIN: 0,
            DELAY_MAX: 30000,
            DELAY_MS_MIN: 1,
            DELAY_MS_MAX: 30000
        });
    });

    test('status bounds match the valid HTTP range', () => {
        expect(LIMITS.STATUS_MIN).toBe(100);
        expect(LIMITS.STATUS_MAX).toBe(599);
    });
});

describe('templates', () => {
    test('every template the README advertises exists', () => {
        const labels = listTemplates().map((t) => t.label);
        for (const promised of ['GraphQL Mock', 'Patch Response', 'Block Request',
            'Slow Request', 'Redirect to localhost', 'CORS Unblock', 'Custom User-Agent']) {
            expect(labels).toContain(promised);
        }
    });

    test('every template carries a type and a URL pattern', () => {
        for (const meta of listTemplates()) {
            const t = getTemplate(meta.id);
            expect(typeof t.type).toBe('string');
            expect(typeof t.url).toBe('string');
            expect(t.url.length).toBeGreaterThan(0);
        }
    });

    test('header templates are scoped, never every site', () => {
        // C-15: a CORS-disabling rule left on '*' is a real security
        // downgrade, not a mocking convenience.
        for (const meta of listTemplates()) {
            const t = getTemplate(meta.id);
            if (t.type === 'headers') {
                expect(t.url).not.toBe('*');
                expect(t.url).toContain('localhost');
            }
        }
    });

    test('returns a deep copy so one editor cannot corrupt the shared source', () => {
        const first = getTemplate('graphqlMock');
        first.url = 'MUTATED';
        first.headersModResponse = ['tampered'];
        expect(getTemplate('graphqlMock').url).toBe('*/graphql*');
    });

    test('unknown template id returns null rather than throwing', () => {
        expect(getTemplate('does-not-exist')).toBeNull();
    });
});

describe('getStatusText', () => {
    test('maps the codes a mock rule commonly uses', () => {
        expect(getStatusText(200)).toBe('OK');
        expect(getStatusText(404)).toBe('Not Found');
        expect(getStatusText(500)).toBe('Internal Server Error');
    });

    test('accepts a numeric string, since form values arrive as text', () => {
        expect(getStatusText('404')).toBe('Not Found');
    });

    test('returns empty for an unmapped code rather than a wrong phrase', () => {
        // CQ-2: the overlay hardcoded 'OK' for every code, so a 404 mock
        // reported "404 OK" to the page under test.
        expect(getStatusText(299)).toBe('');
        expect(getStatusText(999)).toBe('');
    });
});
