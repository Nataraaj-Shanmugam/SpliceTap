/**
 * Fix group A2b ("matcher-log") — the DevTools panel's reading of the log
 * entries Contract A adds (PER-54, PER-56): redirects, settled delays, chaos
 * failures, notes, the 2xx-rate card and the Chaos filter.
 *
 * The interceptor (A2a) emits the new fields; this suite feeds entries to the
 * background straight from an extension page, which is allowed past the sender
 * checks, so it needs no page traffic. The existing narrow-layout (PER-79) and
 * focus/naming (PER-80) behaviour is re-run with the new row kinds present.
 */

const { launch, waitFor, sleep, auditA11y } = require('./harness');

const rule = (id, type, extra = {}) => ({
    id, name: `Rule ${id}`, enabled: true, type,
    match: { url: `*/api/${id}*`, method: 'GET' },
    ...extra
});
const RULES = [
    rule('m1', 'mock', { response: { statusCode: 200, headers: {}, body: { ok: true }, delay: 0, mode: 'static' } }),
    rule('d1', 'delay', { delayMs: 600 }),
    rule('r1', 'redirect', { redirect: { destination: 'https://dest.test/x' } })
];

let tick = 0;
const entry = (over) => ({
    ts: Date.now() + (tick++), url: 'http://127.0.0.1:9/api/m1', method: 'GET',
    ruleId: 'm1', ruleName: 'Rule m1', ruleType: 'mock', status: 200, ...over
});

// One of each kind the panel has to tell apart.
const ENTRIES = {
    mock: () => entry({ url: 'http://127.0.0.1:9/api/m1/plain' }),
    redirect: () => entry({
        url: 'http://127.0.0.1:9/api/r1/old', ruleId: 'r1', ruleName: 'Rule r1', ruleType: 'redirect',
        status: 302, finalStatus: 200, elapsedMs: 41, redirectedTo: 'https://dest.test/x'
    }),
    redirectLegacy: () => entry({
        url: 'http://127.0.0.1:9/api/r1/legacy', ruleId: 'r1', ruleName: 'Rule r1', ruleType: 'redirect', status: 302
    }),
    redirectFailed: () => entry({
        url: 'http://127.0.0.1:9/api/r1/down', ruleId: 'r1', ruleName: 'Rule r1', ruleType: 'redirect',
        status: 302, finalStatus: 'failed', redirectedTo: 'https://dest.test/down'
    }),
    delay: () => entry({
        url: 'http://127.0.0.1:9/api/d1/slow', ruleId: 'd1', ruleName: 'Rule d1', ruleType: 'delay',
        status: null, finalStatus: 200, elapsedMs: 1503
    }),
    delayFailed: () => entry({
        url: 'http://127.0.0.1:9/api/d1/fail', ruleId: 'd1', ruleName: 'Rule d1', ruleType: 'delay',
        status: null, finalStatus: 'failed', elapsedMs: 120
    }),
    delayServerError: () => entry({
        url: 'http://127.0.0.1:9/api/d1/500', ruleId: 'd1', ruleName: 'Rule d1', ruleType: 'delay',
        status: null, finalStatus: 503, elapsedMs: 80
    }),
    delayPending: () => entry({
        url: 'http://127.0.0.1:9/api/d1/pending', ruleId: 'd1', ruleName: 'Rule d1', ruleType: 'delay', status: null
    }),
    chaos: () => entry({
        url: 'http://127.0.0.1:9/api/anything/chaos', ruleId: null, ruleName: 'Chaos mode', ruleType: undefined,
        status: 'failed', kind: 'chaos'
    }),
    note: () => entry({
        url: 'http://127.0.0.1:9/api/m1/patched', note: 'Patch skipped — response is not a JSON object (text/plain)'
    })
};

describe('DevTools panel: the Contract A log entries', () => {
    let h;
    let panel;

    beforeAll(async () => { h = await launch(); });
    afterAll(async () => { if (h) await h.close(); });
    afterEach(async () => {
        if (panel && !panel.isClosed()) await panel.close();
        panel = null;
    });

    /** Seed the rules, feed `entries` to the background, open the panel. */
    async function setUp(kinds, { width = 900, theme = 'dark' } = {}) {
        await h.reset();
        await h.extensionEval((t) => chrome.storage.local.get('spliceTapSettings').then((r) =>
            chrome.storage.local.set({ spliceTapSettings: { ...(r.spliceTapSettings || {}), theme: t } })), theme);
        for (const r of RULES) await h.saveRule(r);
        const entries = kinds.map((k) => ENTRIES[k]());
        await h.bg({ type: 'logInterceptionBatch', entries });
        const stored = await h.bg({ type: 'getInterceptionLog' });
        expect(stored.entries).toHaveLength(entries.length); // none refused
        panel = await h.browser.newPage();
        await panel.setViewport({ width, height: 800 });
        await panel.goto(h.extUrl('devtools/panel.html'), { waitUntil: 'load' });
        await panel.bringToFront();
        await waitFor(async () => (await panel.$$('#requestItems .request-item')).length >= entries.length, { timeout: 8000, label: 'the rows' });
    }

    /** What one row (found by a piece of its URL) shows. */
    const rowFor = (fragment) => panel.evaluate((frag) => {
        const row = Array.from(document.querySelectorAll('#requestItems .request-item'))
            .find((r) => r.querySelector('.url-toggle').title.includes(frag));
        if (!row) return null;
        const status = row.querySelector('.request-status');
        const note = row.querySelector('.request-note');
        const button = row.querySelector('.url-toggle');
        return {
            text: row.textContent.replace(/\s+/g, ' ').trim(),
            status: status.textContent.trim(),
            statusClass: status.className,
            badge: row.querySelector('.rule-type-badge').textContent,
            ruleName: row.querySelector('.rule-name').textContent,
            ruleTitle: row.querySelector('.rule-name').title,
            note: note ? note.textContent : null,
            noteInUrlCell: note ? !!note.closest('.request-url') : null,
            describedBy: button.getAttribute('aria-describedby'),
            describedText: button.getAttribute('aria-describedby')
                ? document.getElementById(button.getAttribute('aria-describedby')).textContent : null
        };
    }, fragment);
    const successRate = () => panel.$eval('#successRate', (el) => el.textContent);
    const visibleUrls = () => panel.$$eval('#requestItems .url-toggle', (els) => els.map((e) => e.title));

    test('a redirect reads "→ <final status> via <destination>" in a neutral style, not as an error', async () => {
        await setUp(['redirect']);
        const row = await rowFor('/api/r1/old');
        expect(row.status).toBe('→ 200 via https://dest.test/x');
        expect(row.statusClass).toContain('status-neutral');
        expect(row.statusClass).not.toContain('status-error');
        expect(row.text).toContain('→ 200 via https://dest.test/x');
        expect(row.status).not.toMatch(/302/);
    });

    test('a redirect that has not settled, or whose destination failed, is still neutral and still not "302"', async () => {
        await setUp(['redirectLegacy', 'redirectFailed']);
        const legacy = await rowFor('/api/r1/legacy');
        expect(legacy.status).toBe('→ redirected');
        expect(legacy.statusClass).toContain('status-neutral');
        const failed = await rowFor('/api/r1/down');
        expect(failed.status).toBe('→ failed via https://dest.test/down');
        expect(failed.statusClass).toContain('status-neutral');
    });

    test('a settled delay reads "<final status> after <ms> ms" and is never "pending"', async () => {
        await setUp(['delay', 'delayFailed', 'delayServerError']);
        const ok = await rowFor('/api/d1/slow');
        expect(ok.status).toBe('200 after 1503 ms');
        expect(ok.statusClass).toContain('status-success');
        expect(ok.text).not.toMatch(/pending/i);

        const failed = await rowFor('/api/d1/fail');
        expect(failed.status).toBe('failed after 120 ms');
        expect(failed.statusClass).toContain('status-error');

        const server = await rowFor('/api/d1/500');
        expect(server.status).toBe('503 after 80 ms');
        expect(server.statusClass).toContain('status-error');
    });

    test('a delay with no final status yet is "pending", as before', async () => {
        await setUp(['delayPending']);
        const row = await rowFor('/api/d1/pending');
        expect(row.status).toBe('pending');
        expect(row.statusClass).toContain('status-pending');
    });

    test('a chaos failure reads "failed (chaos)" under the name "Chaos mode", with no rule id', async () => {
        await setUp(['chaos']);
        const row = await rowFor('/api/anything/chaos');
        expect(row.status).toBe('failed (chaos)');
        expect(row.statusClass).toContain('status-error');
        expect(row.ruleName).toBe('Chaos mode');
        expect(row.badge).toBe('chaos');
        expect(row.ruleTitle).toBe('');
    });

    test('a note shows under the URL, in the row\'s text, and is the URL button\'s description', async () => {
        await setUp(['note']);
        const row = await rowFor('/api/m1/patched');
        expect(row.note).toBe('Patch skipped — response is not a JSON object (text/plain)');
        expect(row.noteInUrlCell).toBe(true);
        expect(row.text).toContain('Patch skipped — response is not a JSON object (text/plain)');
        expect(row.describedBy).toBeTruthy();
        expect(row.describedText).toBe(row.note);

        // The browser agrees: the button's accessible description is the note.
        const cdp = await panel.createCDPSession();
        const { nodes } = await cdp.send('Accessibility.getFullAXTree');
        await cdp.detach();
        const button = nodes.find((n) => !n.ignored && n.role && n.role.value === 'button'
            && n.description && /Patch skipped/.test(n.description.value));
        expect(button).toBeDefined();
        expect(button.description.value).toBe('Patch skipped — response is not a JSON object (text/plain)');
    });

    test('a row with no note has no note element and no description', async () => {
        await setUp(['mock']);
        const row = await rowFor('/api/m1/plain');
        expect(row.note).toBeNull();
        expect(row.describedBy).toBeNull();
    });

    test('the 2xx rate counts only entries that have a numeric final status', async () => {
        // 200 (mock), 200 (delay), 200 (redirect): 3 of 3. The pending delay,
        // the failed delay, the failed redirect, the legacy redirect and the
        // chaos failure have no status to count.
        await setUp(['mock', 'delay', 'redirect', 'delayPending', 'delayFailed', 'redirectFailed', 'redirectLegacy', 'chaos']);
        expect(await successRate()).toBe('100%');
        expect(await panel.$eval('#totalRequests', (el) => el.textContent)).toBe('8'); // all of them are logged
    });

    test('and a real non-2xx among them counts against it', async () => {
        await setUp(['mock', 'delay', 'redirect', 'delayServerError', 'chaos']);
        expect(await successRate()).toBe('75%'); // 3 of 4 numeric final statuses
    });

    test('with nothing to count, the card says 0%', async () => {
        await setUp(['chaos', 'delayPending']);
        expect(await successRate()).toBe('0%');
    });

    test('the type filter has "Chaos", and it shows only chaos failures', async () => {
        await setUp(['mock', 'redirect', 'delay', 'chaos', 'chaos']);
        const options = await panel.$$eval('#filterType option', (els) => els.map((o) => [o.value, o.textContent]));
        expect(options).toContainEqual(['chaos', 'Chaos']);

        await panel.select('#filterType', 'chaos');
        await waitFor(async () => (await visibleUrls()).length === 2, { label: 'two chaos rows' });
        expect((await visibleUrls()).every((u) => u.includes('/chaos'))).toBe(true);

        await panel.select('#filterType', 'redirect');
        await waitFor(async () => (await visibleUrls()).length === 1, { label: 'one redirect row' });
        expect((await visibleUrls())[0]).toContain('/api/r1/old');

        await panel.select('#filterType', 'mock');
        await waitFor(async () => (await visibleUrls()).length === 1, { label: 'one mock row' });
        expect((await visibleUrls())[0]).toContain('/api/m1/plain');
    });

    test('the live region announces the outcome in the same words as the row', async () => {
        await setUp(['mock']);
        await h.bg({ type: 'logInterceptionBatch', entries: [ENTRIES.redirect()] });
        await waitFor(async () => /→ 200 via https:\/\/dest\.test\/x/.test(await panel.$eval('#logAnnouncer', (el) => el.textContent)),
            { timeout: 8000, label: 'the announcement' });
    });

    describe('layout (PER-79) and focus and naming (PER-80) with the new row kinds', () => {
        const ALL = ['mock', 'redirect', 'redirectFailed', 'delay', 'delayFailed', 'delayPending', 'chaos', 'note'];

        test('at 320 px each row stacks, a long outcome wraps on a line of its own, and nothing scrolls sideways', async () => {
            await setUp(ALL, { width: 320 });
            const g = await panel.evaluate(() => {
                const list = document.getElementById('requestsList');
                const rows = Array.from(document.querySelectorAll('#requestItems .request-item')).map((row) => {
                    const r = (sel) => row.querySelector(sel).getBoundingClientRect();
                    return {
                        detail: row.classList.contains('request-item-detail'),
                        methodTop: r('.request-method').top, statusTop: r('.request-status').top,
                        urlTop: r('.request-url').top, ruleTop: r('.rule-info').top,
                        statusRight: r('.request-status').right, rowRight: row.getBoundingClientRect().right,
                        urlW: r('.request-url').width,
                        scrollOk: row.scrollWidth <= row.clientWidth
                    };
                });
                return { rows, listOk: list.scrollWidth <= list.clientWidth };
            });
            expect(g.listOk).toBe(true);
            expect(g.rows.length).toBe(ALL.length);
            for (const row of g.rows) {
                expect(row.scrollOk).toBe(true);
                expect(row.urlW).toBeGreaterThan(200);
                expect(row.urlTop).toBeGreaterThan(row.methodTop + 10);
                expect(row.ruleTop).toBeGreaterThan(row.urlTop + 10);
                expect(row.statusRight).toBeLessThanOrEqual(row.rowRight + 1);
            }
            // The long outcomes (redirect, settled delay, chaos) sit above the URL.
            const detail = g.rows.filter((r) => r.detail);
            expect(detail.length).toBeGreaterThanOrEqual(5);
            for (const row of detail) expect(row.urlTop).toBeGreaterThan(row.statusTop + 8);
        });

        test('at 900 px the first line of every row is one line with its columns in line, and a long outcome takes a second line', async () => {
            await setUp(['mock', 'redirect', 'chaos', 'delay'], { width: 900 });
            const g = await panel.evaluate(() => Array.from(document.querySelectorAll('#requestItems .request-item')).map((row) => {
                const r = (sel) => row.querySelector(sel).getBoundingClientRect();
                return {
                    detail: row.classList.contains('request-item-detail'),
                    methodTop: r('.request-method').top, urlTop: r('.request-url').top, urlW: r('.request-url').width,
                    ruleLeft: Math.round(r('.rule-info').left), timeLeft: Math.round(r('.timestamp').left),
                    statusLeft: r('.request-status').left, statusTop: r('.request-status').top,
                    urlRight: r('.request-url').right, urlBottom: r('.request-url').bottom
                };
            }));
            for (const row of g) {
                expect(Math.abs(row.urlTop - row.methodTop)).toBeLessThan(12);
                expect(row.urlW).toBeGreaterThan(150);
                if (row.detail) expect(row.statusTop).toBeGreaterThanOrEqual(row.urlBottom - 1); // under the URL
                else expect(row.statusLeft).toBeGreaterThanOrEqual(row.urlRight - 1);            // in its own column
            }
            // Detail or not, the rule and time columns start in the same place on every row.
            expect(new Set(g.map((row) => row.ruleLeft)).size).toBe(1);
            expect(new Set(g.map((row) => row.timeLeft)).size).toBe(1);
            expect(g.filter((row) => row.detail).length).toBe(3);
        });

        test('between the breakpoint and a roomy panel the URL is never squeezed to nothing', async () => {
            await setUp(['redirect', 'note', 'delay', 'chaos'], { width: 900 });
            for (const w of [700, 600, 561, 560, 480, 360]) {
                await panel.setViewport({ width: w, height: 800 });
                await sleep(100);
                const g = await panel.evaluate(() => ({
                    urlW: Math.min(...Array.from(document.querySelectorAll('#requestItems .request-url')).map((e) => e.getBoundingClientRect().width)),
                    listOk: document.getElementById('requestsList').scrollWidth <= document.getElementById('requestsList').clientWidth
                }));
                expect({ w, ok: g.urlW > 100 && g.listOk }).toEqual({ w, ok: true });
            }
        });

        test('every dismiss button has its own name, including the chaos and redirect rows, and dismissing keeps focus in the list', async () => {
            await setUp(['mock', 'redirect', 'chaos'], { width: 900 });
            const names = await panel.$$eval('.dismiss-btn', (els) => els.map((e) => e.getAttribute('aria-label')));
            expect(new Set(names).size).toBe(3);
            expect(names.join('|')).toMatch(/Dismiss GET http:\/\/127\.0\.0\.1:9\/api\/anything\/chaos/);

            // newest first: chaos, redirect, mock. Dismiss the chaos row by keyboard.
            await panel.evaluate(() => document.querySelectorAll('.dismiss-btn')[0].focus());
            await panel.keyboard.press('Enter');
            const focused = await panel.evaluate(() => {
                const a = document.activeElement;
                return { label: a.getAttribute('aria-label'), isBody: a === document.body };
            });
            expect(focused.isBody).toBe(false);
            expect(focused.label).toMatch(/\/api\/r1\/old$/);
        });

        test('a new entry arriving does not knock focus off the button a keyboard user is on', async () => {
            await setUp(['mock', 'redirect'], { width: 900 });
            await panel.evaluate(() => document.querySelectorAll('.dismiss-btn')[1].focus());
            const before = await panel.evaluate(() => document.activeElement.getAttribute('aria-label'));
            await h.bg({ type: 'logInterceptionBatch', entries: [ENTRIES.chaos()] });
            await waitFor(async () => (await panel.$$('#requestItems .request-item')).length === 3, { timeout: 8000, label: 'the chaos row' });
            expect(await panel.evaluate(() => document.activeElement.getAttribute('aria-label'))).toBe(before);
        });

        test.each([['dark', 900], ['light', 900], ['dark', 320], ['light', 320]])(
            'has no WCAG A/AA violations with every kind of row (%s theme, %d px wide)', async (theme, width) => {
                await setUp(ALL, { width, theme });
                await sleep(500); // let the theme and button transitions settle
                const violations = (await auditA11y(panel)).map((v) => ({ state: 'rows', ...v }));
                await panel.select('#filterType', 'chaos');
                await sleep(400);
                violations.push(...(await auditA11y(panel)).map((v) => ({ state: 'chaos filter', ...v })));
                await panel.select('#filterType', 'all');
                await panel.click('#pauseBtn');
                await sleep(400);
                violations.push(...(await auditA11y(panel)).map((v) => ({ state: 'paused', ...v })));
                expect(violations).toEqual([]);
            });
    });

    test('ran without errors', () => {
        expect(h.allErrors).toEqual([]);
    });
});
