import { endpoint, token } from './pairing.js';

let running = false;
let messages = Promise.resolve();
async function request(path, options = {}) {
  const response = await fetch(endpoint + path, {
    ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`BridgeStatus${response.status}`);
  return response.json();
}
async function poll() {
  if (running) return;
  running = true;
  try {
    // Privileged extension GET fetches can omit Origin; POST carries the extension Origin.
    const state = await request('/v1/tasks/next', { method: 'POST', body: '{}' });
    await chrome.storage.local.set({ connection: 'connected', connectionError: null, phase: state.phase, serverReport: state.report ?? null });
    const task = state.task;
    if (!task) { await chrome.storage.local.set({ activeTask: null }); return; }
    if (!['https://www.qidian.com/', 'https://my.qidian.com/bookcase/'].includes(task.url) || typeof task.id !== 'string') return;
    const { activeTask } = await chrome.storage.local.get('activeTask');
    if (activeTask?.id === task.id && activeTask.protocolVersion === 2) {
      try { await chrome.tabs.get(activeTask.tabId); return; }
      catch { if (state.report?.state === 'AccessBlocked') return; }
    }
    const tab = await chrome.tabs.create({ url: task.url, active: task.kind === 'access' });
    await chrome.storage.local.set({ activeTask: { ...task, tabId: tab.id, protocolVersion: 2 } });
  } catch (error) {
    const code = /^BridgeStatus\d{3}$/.test(error?.message ?? '') ? error.message :
      error?.name === 'TimeoutError' ? 'BridgeTimeout' : 'BridgeNetworkError';
    await chrome.storage.local.set({ connection: 'disconnected', connectionError: code });
  } finally { running = false; }
}
async function handleObservation(message, sender) {
  const { activeTask } = await chrome.storage.local.get('activeTask');
  if (!activeTask || activeTask.tabId !== sender.tab.id) return { ignored: true };
  if (message.type === 'idlepage-bookshelf') {
    const url = new URL(sender.url);
    if (activeTask.kind !== 'bookshelf-list' || url.hostname !== 'my.qidian.com' || !/^\/bookcase(?:\/|$)/.test(url.pathname)) return { ignored: true };
    const reply = await request('/v1/bookshelf/result', { method: 'POST', body: JSON.stringify({ taskId: activeTask.id, report: message.page }) });
    await chrome.storage.local.set({ phase: reply.phase, bookshelfSummary: reply.bookshelfSummary });
    await poll(); return { accepted: true };
  }
  // Server validates and normalizes the observation before advancing tasks.
  const reply = await request('/v1/tasks/result', {
    method: 'POST', body: JSON.stringify({ taskId: activeTask.id, report: message.report }),
  });
  await chrome.storage.local.set({ connection: 'connected', phase: reply.phase, report: reply.report });
  const state = reply.report?.state;
  if ((state === 'NeedsLogin' || state === 'AccessBlocked') && !activeTask.attentionShown) {
    await chrome.tabs.update(activeTask.tabId, { active: true });
    await chrome.storage.local.set({ activeTask: { ...activeTask, attentionShown: true } });
  }
  await poll();
  return { accepted: true, bookshelfRequested: activeTask.kind === 'bookshelf-list' };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['idlepage-observation', 'idlepage-bookshelf'].includes(message?.type) || sender.frameId !== 0 || !sender.tab) return;
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
  await chrome.alarms.create('idlepage-bridge', { periodInMinutes: 0.5 });
  await poll();
}
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('status.html'), active: false });
    await initialize();
  })();
});
chrome.runtime.onStartup.addListener(() => { void initialize(); });
void initialize();
