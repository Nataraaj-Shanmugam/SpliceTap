/**
 * Headless end-to-end harness: the real, unpacked extension in a real browser.
 *
 * The unit suites run the shipped files under node with shims. That is fast
 * and catches logic regressions, but it cannot see anything that only exists
 * in Chrome: declarativeNetRequest's own validation, MAIN/ISOLATED world
 * injection order, content-script match behaviour, the service worker
 * lifecycle, real Shadow DOM and focus, or what the popup actually renders.
 * This harness covers that layer.
 *
 * Browser choice: Chrome for Testing, as provisioned by Puppeteer. Branded
 * Google Chrome stopped honouring --load-extension in v137, so the Chrome
 * installed on a developer machine cannot load an unpacked extension
 * headlessly; Chrome for Testing still can. Runs in new headless mode, which
 * supports extensions (the old headless shell never did).
 *
 * Every test talks to the background through a real extension page and
 * chrome.runtime.sendMessage — the same boundary the popup and editors use —
 * rather than reaching into storage, so the handlers, DNR sync and state
 * broadcast are all exercised for real.
 */

const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

const EXTENSION_PATH = path.resolve(__dirname, '..', '..');

/**
 * Local test origin. Endpoints are designed so an assertion can tell a mocked
 * response from a real one, and so DNR effects — which happen in the network
 * stack, invisible to page JavaScript — can be read back from the server's
 * view of the request.
 */
function startServer() {
    const requests = [];

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers });

        const json = (status, body, extraHeaders = {}) => {
            res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
            res.end(JSON.stringify(body));
        };

        if (url.pathname === '/favicon.ico') {
            // Answered so the browser's automatic favicon request does not
            // show up as a console error in every test's error log.
            res.writeHead(204);
            res.end();
            return;
        }

        if (url.pathname === '/page' || url.pathname === '/page2') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<!doctype html><html><head><meta charset="utf-8"><title>SpliceTap E2E</title></head>' +
                '<body><h1>SpliceTap e2e target</h1><p id="status">ready</p></body></html>');
            return;
        }

        if (url.pathname === '/echo') {
            // Everything the network stack actually delivered: lets a test see
            // a header DNR added or a query param DNR rewrote.
            json(200, {
                real: true,
                headers: req.headers,
                query: Object.fromEntries(url.searchParams.entries())
            });
            return;
        }

        if (url.pathname === '/redirect-target') {
            json(200, { real: true, redirected: true });
            return;
        }

        if (url.pathname === '/graphql') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => json(200, { real: true, received: body }));
            return;
        }

        if (url.pathname.startsWith('/api/')) {
            json(200, { real: true, id: 1, name: 'real', keep: true, path: url.pathname }, {
                'X-Origin-Server': 'yes'
            });
            return;
        }

        json(404, { real: true, error: 'not found' });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, requests, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

async function launch(options = {}) {
    const extensionPath = options.extensionPath || EXTENSION_PATH;
    const { server, requests, baseUrl } = await startServer();

    const browser = await puppeteer.launch({
        headless: true,
        pipe: true,
        enableExtensions: [extensionPath],
        args: ['--no-first-run', '--no-default-browser-check']
    });

    const swTarget = await browser.waitForTarget(
        (t) => t.type() === 'service_worker' && t.url().endsWith('/service_worker/background.js'),
        { timeout: 20000 }
    );
    const extensionId = new URL(swTarget.url()).host;
    const worker = await swTarget.worker();

    // Everything the extension logs at error level, across every context, is
    // collected so a test can assert a flow ran clean — not merely that it
    // produced the right answer while throwing on the side.
    // `errors` is per test (reset() clears it). `allErrors` is never cleared,
    // so a suite's closing "ran without errors" check sees everything any of
    // its tests caused. `startupErrors` is a snapshot taken once the control
    // page has loaded — an earlier version only had the per-test list, and a
    // reset() before the assertion erased the popup crashing on every open.
    const errors = [];
    const allErrors = [];
    const record = (entry) => { errors.push(entry); allErrors.push(entry); };
    worker.on('console', (msg) => {
        if (msg.type() === 'error') record({ where: 'service_worker', text: msg.text() });
    });

    const extUrl = (p) => `chrome-extension://${extensionId}/${p}`;

    // Snapshot of tabs before the harness opens anything, so a test can check
    // that installing the extension did not open a page on its own.
    await new Promise((r) => setTimeout(r, 500));
    const initialPages = (await browser.pages()).map((p) => p.url());

    // Control page: a real extension page, used as the sender for background
    // messages. popup.html is the natural choice — it is the surface that
    // sends these messages in production.
    const control = await browser.newPage();
    watchPage(control, 'control', record);
    await control.goto(extUrl('popup/popup.html'), { waitUntil: 'load' });

    // Let the control page finish initialising before the snapshot.
    await new Promise((r) => setTimeout(r, 300));
    const startupErrors = errors.slice();

    async function bg(message) {
        return control.evaluate((m) => chrome.runtime.sendMessage(m), message);
    }

    async function extensionEval(fn, ...args) {
        return control.evaluate(fn, ...args);
    }

    /** Return the extension to a known state between tests. */
    async function reset() {
        await bg({ type: 'toggleExtension', active: true });
        await bg({ type: 'setCaptureArmed', armed: false });
        await bg({ type: 'clearRules' });
        await bg({ type: 'clearInterceptionLog' });
        await bg({ type: 'clearCaptures' });
        requests.length = 0;
        errors.length = 0;
    }

    async function saveRule(rule) {
        const response = await bg({ type: 'saveRule', rule });
        if (!response || !response.success) {
            throw new Error('saveRule failed: ' + JSON.stringify(response));
        }
        return response;
    }

    /** Open a page on the test origin, with the content scripts loaded. */
    async function openPage(pathname = '/page') {
        const page = await browser.newPage();
        watchPage(page, 'page', record);
        await page.goto(baseUrl + pathname, { waitUntil: 'load' });
        return page;
    }

    /**
     * Ask a tab's content script to open the in-page editor, the way the
     * popup does. Returns the overlay's shadow host element handle.
     */
    async function openOverlay(page, payload = { mode: 'new' }) {
        const pageUrl = page.url();
        const response = await control.evaluate(async (url, p) => {
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find((t) => t.url === url);
            if (!tab) return { success: false, error: 'tab not found' };
            return chrome.tabs.sendMessage(tab.id, { type: 'openRuleOverlay', ...p });
        }, pageUrl, payload);
        if (!response || !response.success) {
            throw new Error('openRuleOverlay failed: ' + JSON.stringify(response));
        }
        return page;
    }

    async function close() {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }

    return {
        browser, worker, control, extensionId, extUrl, baseUrl, requests, errors, allErrors, startupErrors, initialPages, record,
        bg, extensionEval, reset, saveRule, openPage, openOverlay, close
    };
}

function watchPage(page, where, record) {
    page.on('console', (msg) => {
        if (msg.type() === 'error') record({ where, text: msg.text() });
    });
    page.on('pageerror', (error) => record({ where, text: 'pageerror: ' + error.message }));
}

/** fetch() from inside a page, reporting what page code would observe. */
function pageFetch(page, url, init) {
    return page.evaluate(async (u, i) => {
        const start = performance.now();
        try {
            const response = await fetch(u, i || {});
            const text = await response.text();
            let body = text;
            try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
            return {
                ok: true,
                status: response.status,
                statusText: response.statusText,
                marker: response.headers.get('x-splicetap'),
                originHeader: response.headers.get('x-origin-server'),
                contentType: response.headers.get('content-type'),
                url: response.url,
                body,
                ms: performance.now() - start
            };
        } catch (error) {
            return { ok: false, error: String(error && error.message || error), name: error && error.name, ms: performance.now() - start };
        }
    }, url, init || null);
}

/** XMLHttpRequest from inside a page. */
function pageXHR(page, url, options = {}) {
    return page.evaluate((u, o) => new Promise((resolve) => {
        const start = performance.now();
        const xhr = new XMLHttpRequest();
        const states = [];
        let loads = 0;
        if (o.responseType) xhr.responseType = o.responseType;
        xhr.onreadystatechange = () => states.push(xhr.readyState);
        xhr.onload = () => { loads++; };
        const finish = (outcome) => {
            let body = o.responseType === 'json' ? xhr.response : xhr.responseText;
            if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* text */ } }
            resolve({
                outcome,
                status: xhr.status,
                statusText: xhr.statusText,
                marker: xhr.getResponseHeader('x-splicetap'),
                body,
                states,
                loads,
                ms: performance.now() - start
            });
        };
        xhr.addEventListener('loadend', () => setTimeout(() => finish(xhr.status ? 'load' : 'error'), 0));
        xhr.open(o.method || 'GET', u);
        for (const [k, v] of Object.entries(o.headers || {})) xhr.setRequestHeader(k, v);
        xhr.send(o.body || null);
    }), url, options);
}

const AXE_SOURCE = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/**
 * Run an axe-core WCAG 2.1/2.2 A+AA audit on a page (optionally scoped to a
 * selector) and return the violations in a compact, assertion-friendly form.
 */
async function auditA11y(page, { include, disableRules = [] } = {}) {
    await page.evaluate(AXE_SOURCE);
    return page.evaluate(async (inc, disabled) => {
        const rules = {};
        for (const id of disabled) rules[id] = { enabled: false };
        const result = await window.axe.run(inc ? { include: [[inc]] } : document, {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
            rules
        });
        return result.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
            summary: v.nodes[0] && v.nodes[0].failureSummary
        }));
    }, include || null, disableRules);
}

/** Poll until fn() returns truthy, or fail with the last observed value. */
async function waitFor(fn, { timeout = 5000, interval = 100, label = 'condition' } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        last = await fn();
        if (last) return last;
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { launch, pageFetch, pageXHR, waitFor, sleep, auditA11y, EXTENSION_PATH };
