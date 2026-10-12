(() => {
  let last = '';
  let sending = false;
  async function observe() {
    if (sending) return;
    const text = document.body?.innerText ?? '';
    const verification = /安全验证|访问验证|拖动下方滑块|人机验证|完成拼图/.test(text);
    const tooFrequent = /操作过于频繁|操作太频繁/.test(text);
    const captchaFrame = [...document.querySelectorAll('iframe')].some(frame => {
      try {
        const url = new URL(frame.src, location.href);
        return url.hostname === 'captcha.gtimg.com' && frame.getClientRects().length > 0;
      } catch { return false; }
    });
    const bookLinks = new Set([...document.querySelectorAll('a[href]')].flatMap(anchor => {
      try {
        const url = new URL(anchor.getAttribute('href'), location.href);
        return url.hostname.endsWith('.qidian.com') && /\/(book|info)\/[a-zA-Z0-9]+/.test(url.pathname) ? [url.origin + url.pathname] : [];
      } catch { return []; }
    })).size;
    const bodyCharacters = [...text].length;
    const loginFrame = [...document.querySelectorAll('iframe')].some(frame => /passport\.(?:qidian|yuewen)\.com|ptlogin\.qidian\.com/.test(frame.src) && frame.getClientRects().length > 0);
    const pageKind = loginFrame ? 'login' : /\/bookcase/.test(location.pathname) ? 'bookshelf' :
      /passport|login/.test(location.hostname + location.pathname) ? 'login' : 'other';
    const state = verification || tooFrequent || captchaFrame ? 'AccessBlocked' :
      pageKind === 'login' ? 'NeedsLogin' : bodyCharacters > 500 && bookLinks > 0 ? 'SiteContentVisible' : 'Indeterminate';
    // Send counts and status only; no DOM text, names, cookies or URL queries.
    const report = { state, pageKind, bodyCharacters, bookLinks, verification, tooFrequent, captchaFrame };
    const encoded = JSON.stringify(report);
    if (encoded === last) return;
    sending = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'idlepage-observation', report });
      if (response?.accepted) last = encoded;
    } catch { /* Extension reloaded or local bridge offline. */ }
    finally { sending = false; }
  }
  const timer = setInterval(() => { void observe(); }, 2000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  setTimeout(() => { void observe(); }, 1000);
})();
