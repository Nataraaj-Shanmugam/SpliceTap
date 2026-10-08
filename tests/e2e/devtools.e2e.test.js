/**
 * The DevTools panel, and markup injection across every surface that renders
 * user- or page-supplied text.
 *
 * The panel is loaded as an extension page. Outside DevTools it has no
 * inspected tab, and it is written to fall back to showing every tab's
 * entries in that case, which is what is driven here.
 */

const { launch, pageFetch, waitFor, sleep, auditA11y } = require('./harness');
const ed = require('./editor-driver');

const mock = (id, overrides = {}) => ({
    id,
    name: `Mock ${id}`,
    enabled: true,
    type: 'mock',
    match: { url: `*/api/${id}*`, method: 'GET' },
    response: { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: { mocked: id }, delay: 0, mode: 'static' },
    ...overrides
});

describe('DevTools panel', () => {
    let h;
    let panel;
    let page;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => {
        for (const p of [panel, page]) if (p && !p.isClosed()) await p.close();
        panel = null;
        page = null;
    });

    async function setUp(rules) {
        await h.reset();
        for (const r of rules) await h.saveRule(r);
        page = await h.openPage();
        panel = await h.browser.newPage();
        await panel.setViewport({ width: 900, height: 600 });
        await panel.goto(h.extUrl('devtools/panel.html'), { waitUntil: 'load' });
    }

    const rows = () => panel.$$eval('#requestItems [role="row"]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    const untilRows = (n, label) => waitFor(async () => {
        const r = await rows();
        return r.length >= n ? r : null;
    }, { label, timeout: 8000 });

    test('lists intercepted requests as they happen', async () => {
        await setUp([mock('users'), mock('orders', { type: 'block', response: undefined })]);
        await waitFor(async () => (await pageFetch(page, '/api/users')).marker === 'true', { label: 'mock active' });
        await pageFetch(page, '/api/orders');

        const listed = await untilRows(2, 'two rows in the panel');
        expect(listed.join(' ')).toMatch(/Mock users/);
        expect(listed.join(' ')).toMatch(/Mock orders/);
    });

    test('filters by text and by rule type', async () => {
        await setUp([mock('users'), mock('orders', { type: 'block', response: undefined })]);
        await waitFor(async () => (await pageFetch(page, '/api/users')).marker === 'true', { label: 'mock active' });
        await pageFetch(page, '/api/orders');
        await untilRows(2, 'rows');

        await panel.type('#filterText', 'orders');
        await waitFor(async () => (await rows()).length === 1, { label: 'text filter' });
        await panel.$eval('#filterText', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });

        await panel.select('#filterType', 'mock');
        await waitFor(async () => {
            const r = await rows();
            return r.length >= 1 && r.every((t) => /Mock users/.test(t));
        }, { label: 'type filter' });
    });

    test('Clear empties the log, and late-arriving entries do not refill it', async () => {
        await setUp([mock('users')]);
        await waitFor(async () => (await pageFetch(page, '/api/users')).marker === 'true', { label: 'mock active' });
        await untilRows(1, 'a row');

        // A request made immediately before Clear is still in the page's
        // 250ms batch when Clear lands.
        await pageFetch(page, '/api/users?late=1');
        await panel.click('#clearRequestsBtn');
        await sleep(3500); // a full poll cycle after the late batch arrives

        expect(await rows()).toEqual([]);
    });

    test('Pause stops the list updating until resumed', async () => {
        await setUp([mock('users')]);
        await waitFor(async () => (await pageFetch(page, '/api/users')).marker === 'true', { label: 'mock active' });
        const before = (await untilRows(1, 'a row')).length;

        await panel.click('#pauseBtn');
        expect(await panel.$eval('#pauseBtn', (b) => b.getAttribute('aria-pressed'))).toBe('true');
        await pageFetch(page, '/api/users?while-paused=1');
        await sleep(3500);
        expect((await rows()).length).toBe(before);

        await panel.click('#pauseBtn');
        await untilRows(before + 1, 'the paused entry after resuming');
    });

    test.each(['dark', 'light'])('has no WCAG A/AA violations (%s theme)', async (theme) => {
        await setUp([mock('users')]);
        await h.extensionEval((t) => chrome.storage.local.get('spliceTapSettings').then((r) =>
            chrome.storage.local.set({ spliceTapSettings: { ...(r.spliceTapSettings || {}), theme: t } })), theme);
        await h.saveRule(mock('reload-settings'));
        await panel.reload({ waitUntil: 'load' });
        await waitFor(async () => (await pageFetch(page, '/api/users')).marker === 'true', { label: 'mock active' });
        await untilRows(1, 'a row');
        expect(await auditA11y(panel)).toEqual([]);
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});

describe('markup injection', () => {
    // Rule names arrive by import and request URLs come from web pages; both
    // are rendered by the popup, the editor and the DevTools panel. If any of
    // them used innerHTML on that text unescaped, an imported rule (or a page
    // a developer visits) could run script inside the extension's own pages,
    // which hold chrome.* APIs.
    const PAYLOAD = '<img src=x onerror="window.__pwned=(window.__pwned||0)+1">';
    let h;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });

    test('a hostile rule name and URL are shown as text everywhere', async () => {
        await h.reset();
        const hostile = mock('xss', {
            name: 'Evil ' + PAYLOAD,
            match: { url: '*/api/xss*', method: 'GET', headers: { 'X-Note': PAYLOAD } }
        });
        await h.saveRule(hostile);

        const page = await h.openPage();
        await waitFor(async () => (await pageFetch(page, '/api/xss?q=' + encodeURIComponent(PAYLOAD), {
            headers: { 'X-Note': PAYLOAD }
        })).marker === 'true', { label: 'the hostile rule to apply' });

        const popup = await h.browser.newPage();
        await popup.goto(h.extUrl('popup/popup.html'), { waitUntil: 'load' });
        await popup.waitForSelector('.rule-card[data-rule-id="xss"]');

        const panel = await h.browser.newPage();
        await panel.goto(h.extUrl('devtools/panel.html'), { waitUntil: 'load' });
        await waitFor(async () => (await panel.$$('#requestItems [role="row"]')).length >= 1, { label: 'panel row', timeout: 8000 });

        const editorPage = await h.browser.newPage();
        await editorPage.goto(h.extUrl('options/options.html?editRule=xss'), { waitUntil: 'load' });
        await waitFor(() => ed.isOpen(editorPage), { label: 'editor' });
        await sleep(300);

        for (const [label, p] of [['popup', popup], ['panel', panel], ['editor', editorPage]]) {
            const injected = await p.evaluate(() => ({
                ran: window.__pwned || 0,
                imgs: document.querySelectorAll('img[src="x"]').length
            }));
            expect({ surface: label, ...injected }).toEqual({ surface: label, ran: 0, imgs: 0 });
        }
        // And the name is visible as literal text.
        expect(await popup.$eval('.rule-card[data-rule-id="xss"] .rule-name-btn', (b) => b.textContent)).toContain('<img src=x');

        for (const p of [page, popup, panel, editorPage]) await p.close();
    });
});
