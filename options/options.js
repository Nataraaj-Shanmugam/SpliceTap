/**
 * SpliceTap options page: the fallback host for the rule editor.
 *
 * Entry points, all handed over by the popup or the background:
 *   ?action=new         open the editor for a new rule
 *   ?editRule=<id>      open the editor on an existing rule
 *   spliceTapPrefill    a { url, ts } handover in storage from the context
 *                       menu, used when the in-page editor could not open
 *
 * R1 / CQ-1: this file used to be a complete second rule editor — about 1,500
 * lines, including a 377-line save function and settings, statistics and
 * auto-save code for UI that had already moved to the popup. It drifted from
 * the in-page editor in ways the headless suite caught (dropped fields on
 * edit, dropped match conditions on block rules, different validation). The
 * editor is now src/rule-editor.js, shared with content/overlay.js; this page
 * only decides what to open and reports how it went.
 */

// Matches the background's handover: a prefill older than this is stale.
const PREFILL_MAX_AGE_MS = 30000;

// UX-1: apply the last resolved theme synchronously, before any await, so a
// light-theme user does not get a dark flash on every open. This script is the
// last element in <body>, so document.body exists already.
(function applyCachedThemeEarly() {
    try {
        const cached = window.localStorage.getItem('tm-theme');
        if ((cached === 'dark' || cached === 'light') && document.body) {
            document.body.classList.remove('theme-dark', 'theme-light');
            document.body.classList.add(`theme-${cached}`);
        }
    } catch (error) {
        // localStorage unavailable — applyTheme() still runs once settings load.
    }
})();

const statusEl = document.getElementById('status');

function setStatus(message, kind = 'info') {
    statusEl.textContent = message;
    statusEl.dataset.kind = kind;
}

function applyTheme(settings) {
    const theme = (settings && settings.theme) || 'auto';
    const resolved = theme === 'auto'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme;
    document.body.classList.remove('theme-dark', 'theme-light');
    document.body.classList.add(`theme-${resolved}`);
    try {
        window.localStorage.setItem('tm-theme', resolved);
    } catch (error) {
        // cosmetic only
    }
}

const editor = window.SpliceTapRuleEditor.create({
    // This is an extension page: no page script to defend the form against,
    // so the shadow root can be open (which also lets accessibility tooling
    // audit the editor here).
    shadowMode: 'open',
    onClose({ saved, rule }) {
        if (saved) {
            setStatus(`Saved "${rule && rule.name}". You can close this tab, or create another rule.`, 'success');
        } else {
            setStatus('Closed without saving.');
        }
        document.getElementById('newRuleBtn').focus();
    }
});

/** A context-menu prefill, if one was handed over recently. Consumed once. */
async function takePrefill() {
    try {
        const { spliceTapPrefill: prefill } = await chrome.storage.local.get('spliceTapPrefill');
        if (!prefill) return null;
        await chrome.storage.local.remove('spliceTapPrefill');
        if (typeof prefill.ts !== 'number' || !prefill.url) return null;
        if (Date.now() - prefill.ts > PREFILL_MAX_AGE_MS) return null;
        return prefill.url;
    } catch (error) {
        return null;
    }
}

async function init() {
    const manifest = chrome.runtime.getManifest();
    document.getElementById('version').textContent = `v${manifest.version}`;

    document.getElementById('newRuleBtn').addEventListener('click', () => {
        setStatus('');
        editor.open({});
    });
    document.getElementById('closeTabBtn').addEventListener('click', () => window.close());

    let state = null;
    try {
        state = await chrome.runtime.sendMessage({ type: 'getRules' });
        applyTheme(state && state.settings);
    } catch (error) {
        setStatus('SpliceTap could not be reached. Reload this tab to try again.', 'error');
        return;
    }

    const params = new URLSearchParams(window.location.search);
    const editRuleId = params.get('editRule');
    const prefillUrl = await takePrefill();

    if (prefillUrl) {
        editor.open({ prefillUrl });
    } else if (editRuleId) {
        const rule = state && Array.isArray(state.rules) && state.rules.find((r) => r.id === editRuleId);
        if (rule) {
            editor.open({ rule });
        } else {
            setStatus('That rule no longer exists — it may have been deleted. You can create a new one instead.', 'error');
        }
    } else if (params.get('action') === 'new') {
        editor.open({});
    }
}

init();
