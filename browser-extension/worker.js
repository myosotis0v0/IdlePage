import { endpoint, token } from './pairing.js';

let activeEndpoint = endpoint;
let activeToken = token;
let running = false;
let messages = Promise.resolve();
let navigationEpoch = 0;
async function removeOwned(record) {
  if (!record) return;
  let tab;
  try { tab = await chrome.tabs.get(record.id); } catch { return; }
  // Do not remove a recycled tab ID or a tab the user navigated elsewhere.
  const actual = new URL(tab.url); const expected = new URL(record.url);
  if (actual.origin !== expected.origin || actual.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')) return;
  await chrome.tabs.remove(record.id);
}
async function settleTabs(tabId, failed = false) {
  const { managedTabs } = await chrome.storage.local.get('managedTabs');
  if (managedTabs?.current?.id !== tabId) return;
  if (failed) {
    await removeOwned(managedTabs.current);
    await chrome.storage.local.set({ managedTabs: { current: managedTabs.previous ?? null, previous: null }, taskTabSummary: { count: managedTabs.previous ? 1 : 0 } });
  } else {
    await removeOwned(managedTabs.previous);
    await chrome.storage.local.set({ managedTabs: { current: managedTabs.current, previous: null }, taskTabSummary: { count: 1 } });
  }
}
async function refreshPairing() {
  const response = await fetch(chrome.runtime.getURL('pairing.json'), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('InvalidPairing');
  const data = await response.json();
  if (!data || Object.keys(data).some(k => !['endpoint', 'token'].includes(k)) || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(data.endpoint ?? '') ||
      Number(new URL(data.endpoint).port) < 1 || Number(new URL(data.endpoint).port) > 65535 || !/^[a-f0-9]{64}$/.test(data.token ?? '')) throw new Error('InvalidPairing');
  activeEndpoint = data.endpoint; activeToken = data.token;
}
async function request(path, options = {}) {
  const send = () => fetch(activeEndpoint + path, {
    ...options, headers: { Authorization: `Bearer ${activeToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  let response = await send();
  if (response.status === 401) { await refreshPairing(); response = await send(); }
  if (!response.ok) throw new Error(`BridgeStatus${response.status}`);
  return response.json();
}
async function poll() {
  if (running) return;
  running = true;
  const epoch = navigationEpoch;
  try {
    await refreshPairing();
    // Privileged extension GET fetches can omit Origin; POST carries the extension Origin.
    const state = await request('/v1/tasks/next', { method: 'POST', body: '{}' });
    await chrome.storage.local.set({ connection: 'connected', connectionError: null, phase: state.phase, serverReport: state.report ?? null });
    const task = state.task;
    if (!task) {
      const { managedTabs } = await chrome.storage.local.get('managedTabs');
      if (managedTabs?.previous) await settleTabs(managedTabs.current.id,
        ['chapter-unavailable', 'cancelled', 'task-failed'].includes(state.phase) && state.failure?.reason !== 'access-blocked' && !['needs-login', 'access-blocked'].includes(state.chapterSummary?.reason));
      await chrome.storage.local.set({ activeTask: null }); return;
    }
    const safeCatalog = task.kind === 'catalog' && /^\d{1,20}$/.test(task.bookId ?? '') && task.url === `https://www.qidian.com/book/${task.bookId}/#Catalog`;
    const safeChapter = task.kind === 'chapter' && /^\d{1,20}$/.test(task.bookId ?? '') &&
      (new RegExp(`^https://(?:www|vipreader)\\.qidian\\.com/chapter/${task.bookId}/\\d{1,20}/?$`).test(task.url) || /^https:\/\/read\.qidian\.com\/chapter\/[a-zA-Z0-9_-]{1,80}\/[a-zA-Z0-9_-]{1,80}\/?$/.test(task.url));
    if ((!safeCatalog && !safeChapter && !['https://www.qidian.com/', 'https://my.qidian.com/bookcase/'].includes(task.url)) || typeof task.id !== 'string') return;
    const { activeTask, managedTabs } = await chrome.storage.local.get(['activeTask', 'managedTabs']);
    if (epoch !== navigationEpoch) return;
    if (activeTask?.id === task.id && activeTask.protocolVersion === 6) {
      try { await chrome.tabs.get(activeTask.tabId); return; }
      catch { if (state.report?.state === 'AccessBlocked') return; }
    }
    await removeOwned(managedTabs?.previous);
    const tab = await chrome.tabs.create({ url: task.url, active: task.kind === 'login' });
    if (epoch !== navigationEpoch) { await chrome.tabs.remove(tab.id); return; }
    await chrome.storage.local.set({ activeTask: { ...task, tabId: tab.id, protocolVersion: 6, attentionShown: task.kind === 'login' },
      managedTabs: { current: { id: tab.id, url: task.url, kind: task.kind }, previous: managedTabs?.current ?? null },
      taskTabSummary: { count: managedTabs?.current ? 2 : 1 } });
  } catch (error) {
    const code = /^BridgeStatus\d{3}$/.test(error?.message ?? '') ? error.message :
      error?.name === 'TimeoutError' ? 'BridgeTimeout' : 'BridgeNetworkError';
    await chrome.storage.local.set({ connection: 'disconnected', connectionError: code });
  } finally { running = false; }
}
async function handleObservation(message, sender) {
  const { activeTask } = await chrome.storage.local.get('activeTask');
  if (!activeTask || activeTask.tabId !== sender.tab.id) return { ignored: true };
  if (['idlepage-chapter', 'idlepage-chapter-diagnostics'].includes(message.type)) {
    const url = new URL(sender.url); const target = new URL(activeTask.url);
    if (activeTask.kind !== 'chapter' || url.origin !== target.origin || url.pathname.replace(/\/$/, '') !== target.pathname.replace(/\/$/, '')) return { ignored: true };
    const reply = await request(message.type === 'idlepage-chapter' ? '/v1/chapter/result' : '/v1/chapter/diagnostics', { method: 'POST', body: JSON.stringify({ taskId: activeTask.id, report: message.batch }) });
    await chrome.storage.local.set({ phase: reply.phase, chapterSummary: reply.chapterSummary ?? null });
    if (reply.phase === 'chapter-preview-ready') await settleTabs(activeTask.tabId);
    if (reply.phase === 'chapter-unavailable') await settleTabs(activeTask.tabId, !['needs-login', 'access-blocked'].includes(message.batch?.reason));
    if (['chapter-preview-ready', 'chapter-unavailable', 'waiting-login'].includes(reply.phase)) await poll();
    return { accepted: true };
  }
  if (message.type === 'idlepage-catalog') {
    const url = new URL(sender.url);
    if (activeTask.kind !== 'catalog' || !['www.qidian.com', 'book.qidian.com'].includes(url.hostname) || !new RegExp(`^/(?:book|info)/${activeTask.bookId}(?:/catalog/?)?/?$`).test(url.pathname)) return { ignored: true };
    const reply = await request('/v1/catalog/result', { method: 'POST', body: JSON.stringify({ taskId: activeTask.id, report: message.batch }) });
    await chrome.storage.local.set({ phase: reply.phase, catalogSummary: reply.catalogSummary ?? null });
    if (['catalog-preview-ready', 'waiting-chapter', 'checking-cache'].includes(reply.phase)) await settleTabs(activeTask.tabId);
    if (['catalog-preview-ready', 'waiting-chapter', 'checking-cache'].includes(reply.phase)) await poll();
    return { accepted: true };
  }
  if (message.type === 'idlepage-bookshelf') {
    const url = new URL(sender.url);
    if (activeTask.kind !== 'bookshelf-list' || url.hostname !== 'my.qidian.com' || !/^\/bookcase(?:\/|$)/.test(url.pathname)) return { ignored: true };
    const reply = await request('/v1/bookshelf/result', { method: 'POST', body: JSON.stringify({ taskId: activeTask.id, report: message.page }) });
    await chrome.storage.local.set({ phase: reply.phase, bookshelfSummary: reply.bookshelfSummary });
    await settleTabs(activeTask.tabId);
    await poll(); return { accepted: true };
  }
  // Server validates and normalizes the observation before advancing tasks.
  const reply = await request('/v1/tasks/result', {
    method: 'POST', body: JSON.stringify({ taskId: activeTask.id, report: message.report }),
  });
  await chrome.storage.local.set({ connection: 'connected', phase: reply.phase, report: reply.report });
  const state = reply.report?.state;
  if (reply.phase === 'chapter-unavailable') await settleTabs(activeTask.tabId);
  if (state === 'SiteContentVisible' && ['access', 'bookshelf'].includes(activeTask.kind)) await settleTabs(activeTask.tabId);
  if (activeTask.kind === 'login' && reply.recovery?.waitingLogin && !activeTask.attentionShown) {
    await chrome.tabs.update(activeTask.tabId, { active: true });
    await chrome.storage.local.set({ activeTask: { ...activeTask, attentionShown: true } });
  }
  if (activeTask.kind === 'login' && reply.recovery?.resumed) await settleTabs(activeTask.tabId);
  await poll();
  return { accepted: true, bookshelfRequested: activeTask.kind === 'bookshelf-list', catalogRequested: activeTask.kind === 'catalog', chapterRequested: activeTask.kind === 'chapter', bookId: activeTask.bookId };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'idlepage-connect' && sender.url?.split('?')[0] === chrome.runtime.getURL('status.html')) {
    void poll().then(() => respond({ accepted: true })); return true;
  }
  if (!['idlepage-observation', 'idlepage-bookshelf', 'idlepage-catalog', 'idlepage-chapter', 'idlepage-chapter-diagnostics'].includes(message?.type) || sender.frameId !== 0 || !sender.tab) return;
  let url;
  try { url = new URL(sender.url); } catch { return; }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.qidian.com')) return;
  // Process messages in order so duplicate observations cannot spawn extra tabs.
  messages = messages.then(async () => {
    try { respond(await handleObservation(message, sender)); }
    catch { respond({ accepted: false }); }
  });
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'idlepage-bridge') void poll(); });
async function initialize() {
  await chrome.storage.local.set({ workerVersion: 9 });
  await chrome.alarms.create('idlepage-bridge', { periodInMinutes: 0.5 });
  await poll();
}
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('status.html'), active: false });
    await initialize();
  })();
});
chrome.runtime.onStartup.addListener(() => {
  navigationEpoch++;
  void (async () => {
    await chrome.storage.local.set({ activeTask: null, managedTabs: null, taskTabSummary: { count: 0 } });
    // A startup can invalidate an in-flight initialization poll.
    while (running) await new Promise(resolve => setTimeout(resolve, 25));
    await initialize();
  })();
});
void initialize();
