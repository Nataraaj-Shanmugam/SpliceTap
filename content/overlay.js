/**
 * SpliceTap in-page editor host.
 *
 * Opens the rule editor over the user's current tab when the popup (or the
 * context menu, or the keyboard shortcut) asks for it:
 *
 *   { type: 'openRuleOverlay', mode: 'new' | 'edit', rule?, prefillUrl? }
 *
 * The editor itself is src/rule-editor.js — the same module the options page
 * mounts as its fallback, so the two can no longer drift apart (R1 / CQ-1;
 * this file used to be a complete second editor). What is specific to this
 * host is the shadow mode: CLOSED, because this runs on arbitrary web pages
 * and the page's own scripts must not be able to read the form or script a
 * click on Save (S-1).
 *
 * Runs in the ISOLATED content-script world, top frame only (see manifest).
 * Loaded after src/common.js, src/templates.js, src/rule-schema.js and
 * src/rule-editor.js in the same content_scripts entry. The ReDoS probe in
 * src/matcher.js is not loaded in this world — it would add parse cost to
 * every page — so a catastrophic regex is caught by the background's save
 * boundary instead, and its message is shown in the editor the same way.
 */
(function () {
    'use strict';

    if (window.__SPLICETAP_OVERLAY_INITIALIZED__) return;
    window.__SPLICETAP_OVERLAY_INITIALIZED__ = true;

    let editor = null;

    // PER-61 / AX-8: after Save the editor just vanished: no sign it worked,
    // nothing announced. A brief confirmation now stays up for a few seconds.
    // It lives in its own CLOSED shadow root (like the editor, S-1: the page
    // cannot read it), and holds a live region so a screen reader says it.
    const TOAST_HOST_ID = 'splicetap-toast-host';
    const TOAST_MS = 5000;
    let toastTimer = null;
    let toastHost = null; // held here, not looked up by id: the page could plant that id

    const TOAST_CSS = `
        :host { all: initial; direction: ltr; }
        .live {
            position: fixed; right: 16px; bottom: 16px; left: 16px;
            display: flex; justify-content: flex-end;
            z-index: 2147483647;
            pointer-events: none; /* never in the way of the page */
            font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        }
        .toast {
            max-width: 360px;
            padding: 10px 14px;
            border-radius: 10px;
            background: #111a27; color: #e7eefb;
            border: 1px solid rgba(148, 163, 184, 0.25);
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
            overflow-wrap: anywhere;
        }
        .mark { color: #6ee7a0; font-weight: 700; margin-right: 6px; }
        @media (prefers-reduced-motion: no-preference) {
            .toast { animation: fade 0.18s ease-out; }
            @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        }
        @media (forced-colors: active) { .toast { border-color: CanvasText; } }
    `;

    function removeToast() {
        clearTimeout(toastTimer);
        toastTimer = null;
        if (toastHost && toastHost.parentNode) toastHost.parentNode.removeChild(toastHost);
        toastHost = null;
    }

    function showSavedToast(ruleName) {
        removeToast();

        const host = document.createElement('div');
        host.id = TOAST_HOST_ID;
        const root = host.attachShadow({ mode: 'closed' });

        const style = document.createElement('style');
        style.textContent = TOAST_CSS;
        root.appendChild(style);

        // The live region has to exist (empty) before its text does, or most
        // screen readers treat the text as part of the page and say nothing.
        const live = document.createElement('div');
        live.className = 'live';
        live.setAttribute('role', 'status');
        live.setAttribute('aria-live', 'polite');
        live.setAttribute('aria-atomic', 'true');
        root.appendChild(live);
        document.documentElement.appendChild(host);
        toastHost = host;

        setTimeout(() => {
            const toast = document.createElement('div');
            toast.className = 'toast';
            const mark = document.createElement('span');
            mark.className = 'mark';
            mark.setAttribute('aria-hidden', 'true');
            mark.textContent = '✓';
            toast.appendChild(mark);
            if (ruleName) {
                // <bdi>: a right-to-left rule name must not reorder the sentence.
                const name = document.createElement('bdi');
                name.textContent = ruleName;
                toast.append("Rule '", name, "' saved");
            } else {
                toast.append('Rule saved');
            }
            live.appendChild(toast);
        }, 60);

        toastTimer = setTimeout(removeToast, TOAST_MS);
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!request || request.type !== 'openRuleOverlay') return false;

        try {
            if (!window.SpliceTapRuleEditor) {
                throw new Error('the rule editor module did not load on this page');
            }
            if (!editor) {
                editor = window.SpliceTapRuleEditor.create({
                    shadowMode: 'closed',
                    onClose({ saved, rule }) {
                        if (saved) showSavedToast(rule && rule.name);
                    }
                });
            }
            editor.open({ rule: request.rule || null, prefillUrl: request.prefillUrl });
            sendResponse({ success: true });
        } catch (error) {
            console.error('SpliceTap: failed to open the rule editor', error);
            sendResponse({ success: false, error: error.message });
        }
        return false;
    });
})();
