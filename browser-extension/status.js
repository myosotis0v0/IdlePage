async function render() {
  const state = await chrome.storage.local.get(['connection', 'connectionError', 'phase', 'report', 'serverReport', 'bookshelfSummary', 'catalogSummary', 'chapterSummary', 'taskTabSummary']);
  document.getElementById('report').textContent = JSON.stringify(state, null, 2);
}
chrome.storage.onChanged.addListener(() => { void render(); });
void render();
async function connect() {
  try { await chrome.runtime.sendMessage({ type: 'idlepage-connect' }); } catch { /* Older worker may not implement wake-up. */ }
  const state = await chrome.storage.local.get(['workerVersion', 'recoveryVersion']);
  // A development update may leave the old worker resident. Recover once per
  // protocol version, including when that worker cached an obsolete credential.
  if (state.workerVersion !== 9 && state.recoveryVersion !== 9) {
    await chrome.storage.local.set({ recoveryVersion: 9 }); chrome.runtime.reload();
  }
}
void connect();
