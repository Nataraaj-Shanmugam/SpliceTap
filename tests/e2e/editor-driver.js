/**
 * Drive the SpliceTap rule editor from a test, wherever it is mounted.
 *
 * The editor lives in a CLOSED shadow root on web pages (S-1: so the page's
 * own scripts cannot read its fields or script a click on Save). That also
 * hides it from Puppeteer's selectors, which go through `element.shadowRoot`
 * — null for a closed root. The Chrome DevTools Protocol is not limited that
 * way: DOM.getDocument with pierce:true returns closed shadow roots too, so
 * this driver resolves the root through CDP and runs queries against it.
 *
 * Input is real input. Save ignores untrusted clicks (`!e.isTrusted`, the S-1
 * defence in depth), so clicks are issued as mouse events at the control's
 * on-screen position and text is typed through the keyboard — exactly the
 * path a user's input takes, which is the point of an end-to-end test.
 */

const HOST_ID = 'splicetap-rule-overlay-host';

async function findShadowRoot(page) {
    const client = await page.createCDPSession();
    try {
        const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
        const stack = [root];
        while (stack.length) {
            const node = stack.pop();
            const attrs = node.attributes || [];
            for (let i = 0; i < attrs.length; i += 2) {
                if (attrs[i] === 'id' && attrs[i + 1] === HOST_ID && node.shadowRoots && node.shadowRoots[0]) {
                    const { object } = await client.send('DOM.resolveNode', { backendNodeId: node.shadowRoots[0].backendNodeId });
                    return { client, objectId: object.objectId };
                }
            }
            for (const child of node.children || []) stack.push(child);
            for (const sr of node.shadowRoots || []) stack.push(sr);
            if (node.contentDocument) stack.push(node.contentDocument);
        }
    } catch (error) {
        await client.detach().catch(() => {});
        throw error;
    }
    await client.detach().catch(() => {});
    return null;
}

/** Run fn(shadowRoot, ...args) in the page and return its (JSON) result. */
async function inShadow(page, fn, ...args) {
    const found = await findShadowRoot(page);
    if (!found) throw new Error('editor is not open (no #' + HOST_ID + ' shadow root)');
    try {
        // callFunctionOn binds the target object as `this`, not as an
        // argument, so wrap fn to receive the shadow root first.
        const { result, exceptionDetails } = await found.client.send('Runtime.callFunctionOn', {
            objectId: found.objectId,
            functionDeclaration: `function (...args) { return (${fn.toString()})(this, ...args); }`,
            arguments: args.map((value) => ({ value })),
            returnByValue: true,
            awaitPromise: true
        });
        if (exceptionDetails) {
            throw new Error('in-shadow evaluation failed: ' + (exceptionDetails.exception && exceptionDetails.exception.description || exceptionDetails.text));
        }
        return result.value;
    } finally {
        await found.client.detach().catch(() => {});
    }
}

async function isOpen(page) {
    return !!(await findShadowRoot(page).then(async (f) => {
        if (f) await f.client.detach().catch(() => {});
        return f;
    }));
}

/** Click a control inside the editor with a real (trusted) mouse event. */
async function click(page, id) {
    const point = await inShadow(page, (root, elId) => {
        const el = root.getElementById(elId);
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, id);
    if (!point) throw new Error('no #' + id + ' in the editor');
    await page.mouse.click(point.x, point.y);
}

/**
 * Set a field. Selects and checkboxes are set directly (with the events a
 * user's change fires); text fields are cleared and then typed into.
 */
async function fill(page, id, value) {
    const kind = await inShadow(page, (root, elId, v) => {
        const el = root.getElementById(elId);
        if (!el) return 'missing';
        if (el.tagName === 'SELECT') {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'select';
        }
        if (el.type === 'checkbox') {
            if (el.checked !== !!v) el.click();
            return 'checkbox';
        }
        el.focus();
        el.select && el.select();
        return 'text';
    }, id, value);
    if (kind === 'missing') throw new Error('no #' + id + ' in the editor');
    if (kind === 'text') {
        await page.keyboard.press('Backspace');
        // Long JSON is pasted in one go rather than typed key by key: the
        // editor is not what is under test there, and typing it is slow.
        if (String(value).length > 40) {
            await inShadow(page, (root, elId, v) => {
                const el = root.getElementById(elId);
                el.value = v;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }, id, String(value));
        } else {
            await page.keyboard.type(String(value));
        }
    }
}

async function value(page, id) {
    return inShadow(page, (root, elId) => {
        const el = root.getElementById(elId);
        if (!el) return undefined;
        return el.type === 'checkbox' ? el.checked : el.value;
    }, id);
}

async function errorText(page) {
    return inShadow(page, (root) => {
        const box = root.getElementById('tmError');
        return box && box.classList.contains('tm-show') ? box.textContent : '';
    });
}

/** Which type-scoped fields are visible right now. */
async function visibleFieldIds(page) {
    return inShadow(page, (root) => Array.from(root.querySelectorAll('input, select, textarea'))
        .filter((el) => el.offsetParent !== null)
        .map((el) => el.id)
        .filter(Boolean));
}

async function activeElementId(page) {
    return inShadow(page, (root) => (root.activeElement && root.activeElement.id) || null);
}

module.exports = { inShadow, isOpen, click, fill, value, errorText, visibleFieldIds, activeElementId, HOST_ID };
