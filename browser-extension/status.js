async function render() {
  const state = await chrome.storage.local.get(['connection', 'connectionError', 'phase', 'report', 'serverReport', 'bookshelfSummary', 'catalogSummary', 'chapterSummary']);
  document.getElementById('report').textContent = JSON.stringify(state, null, 2);
}
chrome.storage.onChanged.addListener(() => { void render(); });
void render();
