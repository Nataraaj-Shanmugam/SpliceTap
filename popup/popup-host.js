// Fills the header's host label with the current tab's hostname.
// Separate file (not inline) to stay within the MV3 content security policy.
(async () => {
  const el = document.getElementById('hostLabel');
  if (!el) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab && tab.url ? new URL(tab.url) : null;
    el.textContent = url && /^https?:$/.test(url.protocol) ? url.hostname : 'this tab';
    el.title = el.textContent;
  } catch {
    el.textContent = 'this tab';
  }
})();
