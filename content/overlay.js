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

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (!request || request.type !== 'openRuleOverlay') return false;

        try {
            if (!window.SpliceTapRuleEditor) {
                throw new Error('the rule editor module did not load on this page');
            }
            if (!editor) {
                editor = window.SpliceTapRuleEditor.create({ shadowMode: 'closed' });
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
