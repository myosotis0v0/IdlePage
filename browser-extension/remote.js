// Generic remote-server channel (protocol idlepage/1, see docs/PLAN.md).
// VS Code queues requests on the loopback bridge; each one runs inside a tab on the
// configured server's own origin, so the site's login cookies and same-origin write
// checks apply exactly as they do for the site's own pages. Login itself happens in a
// separate visible tab; this channel never reads or stores credentials.
export function createRemote({ request, refresh, remotes, chrome }) {
  let looping = false;
  const allowed = origin => remotes().includes(origin);
  const sameOrigin = (origin, path) => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return false;
    try { return new URL(path, origin).origin === origin; } catch { return false; }
  };
  // The dedicated Edge can keep running with every window closed; tabs.create then fails
  // with "No current window". Use an existing normal window, or open one (minimized unless active).
  async function openTab(url, active) {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (!windows.length) {
      const window = await chrome.windows.create(active ? { url, focused: true } : { url, focused: false, state: 'minimized' });
      return window.tabs[0];
    }
    const target = windows.find(w => w.focused) ?? windows[0];
    return chrome.tabs.create({ url, active, windowId: target.id });
  }
  async function waitLoaded(tabId) {
    for (let i = 0; i < 150; i++) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return tab;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('RemoteTabTimeout');
  }
  async function remoteTab(origin, home) {
    // One background tab per page: the API home page, and the site's player page when it has one.
    const key = origin + home;
    const { remoteTabs } = await chrome.storage.local.get('remoteTabs');
    const record = remoteTabs?.[key];
    if (record) {
      try {
        const tab = await waitLoaded(record.id);
        if (new URL(tab.url).origin === origin) return tab.id;
      } catch {}
    }
    const tab = await openTab(origin + home, false);
    const loaded = await waitLoaded(tab.id);
    // Only a tab that stayed on the server origin may carry API requests.
    if (new URL(loaded.url).origin !== origin) { await chrome.tabs.remove(tab.id); throw new Error('RemoteTabRedirected'); }
    await chrome.storage.local.set({ remoteTabs: { ...remoteTabs, [key]: { id: tab.id } } });
    return tab.id;
  }
  // Runs in the server page: same-origin fetch with the page's own cookies and Origin.
  async function pageFetch(path, method, body) {
    try {
      const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store',
        headers: body === null ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' }, body });
      if (new URL(response.url).origin !== location.origin) return { status: 0, error: 'Redirected' };
      const type = response.headers.get('content-type') || '';
      const text = await response.text();
      if (text.length > 1000000) return { status: response.status, error: 'TooLarge' };
      return { status: response.status, type, text };
    } catch { return { status: 0, error: 'Network' }; }
  }
  async function inPage(job) {
    const tabId = await remoteTab(job.origin, job.home);
    // Injection arguments must be JSON values: an absent body travels as null.
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: pageFetch, args: [job.path, job.method ?? 'GET', job.body ?? null] });
    return injection?.result ?? { status: 0, error: 'Injection' };
  }
  // Runs in the site's player page (main world). Media is always played by the site itself, with
  // its own instrument/voice and caching; we only hand over the card's audio address.
  // Returns a short reason when it cannot play, so the user sees why (never page content).
  async function sitePlay(src) {
    for (let i = 0; i < 100 && !window.idlepagePlayer; i++) await new Promise(resolve => setTimeout(resolve, 50));
    if (!window.idlepagePlayer) return 'NoPlayerFunction';
    try { return (await window.idlepagePlayer.play(src)) === true ? true : 'PlayerDeclined'; }
    catch (error) { return 'PlayerError: ' + String(error?.message ?? error).slice(0, 100); }
  }
  async function playOnSite(job) {
    try {
      const tabId = await remoteTab(job.origin, job.player);
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: sitePlay, args: [job.path] });
      return injection?.result ?? 'NoResult';
    } catch (error) { return 'PlayerPage: ' + String(error?.message ?? error).slice(0, 100); }
  }
  async function loginTab(origin) {
    const { remoteLogin } = await chrome.storage.local.get('remoteLogin');
    return remoteLogin?.origin === origin ? remoteLogin.id : undefined;
  }
  async function handle(job) {
    if (!job || typeof job.id !== 'string' || !allowed(job.origin)) return { error: 'NotAllowed' };
    if (['fetch', 'play'].includes(job.op) && (!sameOrigin(job.origin, job.home) || !sameOrigin(job.origin, job.path))) return { error: 'NotAllowed' };
    if (job.op === 'fetch') {
      if (!['GET', 'POST', 'PUT'].includes(job.method ?? 'GET') || (job.body !== undefined && typeof job.body !== 'string')) return { error: 'NotAllowed' };
      return inPage(job);
    }
    if (job.op === 'play') {
      // Only the site's player page plays media; without one there is simply no sound.
      if (typeof job.player !== 'string' || !sameOrigin(job.origin, job.player)) return { error: 'NotAllowed' };
      const result = await playOnSite(job);
      return result === true ? { status: 200, played: true } : { status: 200, played: false, error: String(result) };
    }
    if (job.op === 'login') {
      if (!sameOrigin(job.origin, job.path)) return { error: 'NotAllowed' };
      const existing = await loginTab(job.origin);
      if (existing !== undefined) { try { await chrome.tabs.update(existing, { active: true }); return { ok: true }; } catch {} }
      const tab = await openTab(job.origin + job.path, true);
      await chrome.storage.local.set({ remoteLogin: { origin: job.origin, id: tab.id } });
      return { ok: true };
    }
    if (job.op === 'login-done') {
      const id = await loginTab(job.origin);
      await chrome.storage.local.set({ remoteLogin: null });
      if (id === undefined) return { ok: true };
      // Close the owned login tab only while it is still on the server host (login page or return page).
      try {
        const tab = await chrome.tabs.get(id);
        if (new URL(tab.url).hostname === new URL(job.origin).hostname) await chrome.tabs.remove(id);
      } catch {}
      return { ok: true };
    }
    return { error: 'UnknownOperation' };
  }
  async function loop() {
    if (looping) return;
    looping = true;
    try {
      for (;;) {
        // Any extension API call keeps the service worker alive between long polls.
        await chrome.runtime.getPlatformInfo?.();
        // Picks up a newly configured server (and reloads for its permission) within one poll.
        try { await refresh(); } catch { break; }
        let reply;
        try { reply = await request('/v1/remote/next', { method: 'POST', body: '{}' }, 10000); } catch { break; }
        const job = reply?.request;
        if (!job) continue;
        void handle(job).catch(error => ({ error: `Failed: ${String(error?.message ?? error).slice(0, 120)}` })).then(result =>
          request('/v1/remote/result', { method: 'POST', body: JSON.stringify({ id: job.id, result }) })).catch(() => {});
      }
    } finally { looping = false; }
  }
  return { loop, handle };
}
