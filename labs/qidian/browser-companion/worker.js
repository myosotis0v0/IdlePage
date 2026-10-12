let advancing = false;
async function openTask(kind) {
  const url = kind === 'access' ? 'https://www.qidian.com/' : 'https://my.qidian.com/bookcase/';
  const tab = await chrome.tabs.create({ url, active: kind === 'access' });
  await chrome.storage.local.set({ activeTask: { kind, tabId: tab.id }, phase: `waiting-${kind}` });
}
async function initialize() {
  if (advancing) return;
  advancing = true;
  try {
    const { activeTask, phase } = await chrome.storage.local.get(['activeTask', 'phase']);
    if (phase === 'probe-complete') return;
    if (activeTask) {
      try { await chrome.tabs.get(activeTask.tabId); return; } catch {}
    }
    await openTask('access');
  } finally { advancing = false; }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== 'idlepage-observation' || sender.frameId !== 0 || !sender.tab) return;
  let url;
  try { url = new URL(sender.url); } catch { return; }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.qidian.com')) return;
  void (async () => {
    try {
      const { activeTask } = await chrome.storage.local.get('activeTask');
      if (!activeTask || activeTask.tabId !== sender.tab.id) { respond({ ignored: true }); return; }
      const r = message.report;
      if (!r || !['AccessBlocked', 'NeedsLogin', 'SiteContentVisible', 'Indeterminate'].includes(r.state) ||
          !['bookshelf', 'login', 'other'].includes(r.pageKind) ||
          !['bodyCharacters', 'bookLinks'].every(key => Number.isSafeInteger(r[key]) && r[key] >= 0 && r[key] < 100000000) ||
          !['verification', 'tooFrequent', 'captchaFrame'].every(key => typeof r[key] === 'boolean')) {
        respond({ accepted: false }); return;
      }
      const report = { observedAt: new Date().toISOString(), taskKind: activeTask.kind,
        state: r.verification || r.tooFrequent || r.captchaFrame ? 'AccessBlocked' : r.state,
        pageKind: r.pageKind, bodyCharacters: r.bodyCharacters, bookLinks: r.bookLinks,
        verification: r.verification, tooFrequent: r.tooFrequent, captchaFrame: r.captchaFrame };
      await chrome.storage.local.set({ report });
      if (report.state === 'NeedsLogin' || report.state === 'AccessBlocked') {
        if (!activeTask.attentionShown) {
          await chrome.tabs.update(activeTask.tabId, { active: true });
          await chrome.storage.local.set({ activeTask: { ...activeTask, attentionShown: true } });
        }
      } else if (report.state === 'SiteContentVisible' && !advancing) {
        advancing = true;
        try {
          if (activeTask.kind === 'access') await openTask('bookshelf');
          else if (r.pageKind === 'bookshelf') await chrome.storage.local.set({ activeTask: null, phase: 'probe-complete' });
        } finally { advancing = false; }
      }
      respond({ accepted: true });
    } catch { respond({ accepted: false }); }
  })();
  return true;
});
chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await chrome.storage.local.clear();
    await chrome.tabs.create({ url: chrome.runtime.getURL('status.html'), active: false });
    await initialize();
  })();
});
chrome.runtime.onStartup.addListener(() => { void initialize(); });
