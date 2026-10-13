(() => {
  let last = '';
  let bookshelfRequested = false;
  let shelfSignature = '';
  let stableSamples = 0;
  let shelfSent = false;
  let catalogRequested = false;
  let catalogBookId;
  let catalogActivated = false;
  let catalogSignature = '';
  let catalogStable = 0;
  let catalogOffset = 0;
  let catalogSent = false;
  let emptyCatalogSent = false;
  let chapterRequested = false;
  let chapterSent = false;
  let chapterSignature = '';
  let chapterStable = 0;
  let chapterOffset = 0;
  let chapterDiagnosed = false;
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
      /passport|login/.test(location.hostname + location.pathname) ? 'login' : /^\/chapter\//.test(location.pathname) ? 'chapter' : /\/(?:book|info)\/\d+/.test(location.pathname) ? 'book' : 'other';
    const state = verification || tooFrequent || captchaFrame ? 'AccessBlocked' :
      pageKind === 'login' ? 'NeedsLogin' : bodyCharacters > 500 && (bookLinks > 0 || ['book', 'chapter'].includes(pageKind)) ? 'SiteContentVisible' : 'Indeterminate';
    // Send counts and status only; no DOM text, names, cookies or URL queries.
    const report = { state, pageKind, bodyCharacters, bookLinks, verification, tooFrequent, captchaFrame };
    const encoded = JSON.stringify(report);
    sending = true;
    try {
      if (encoded !== last) {
        const response = await chrome.runtime.sendMessage({ type: 'idlepage-observation', report });
        if (response?.accepted) { last = encoded; bookshelfRequested = response.bookshelfRequested === true; catalogRequested = response.catalogRequested === true; chapterRequested = response.chapterRequested === true; catalogBookId = response.bookId; }
      }
      if (chapterRequested && !chapterSent && pageKind === 'chapter' && !['AccessBlocked', 'NeedsLogin'].includes(state)) {
        if (!chapterDiagnosed) {
          const batch = globalThis.IdlePageChapter?.diagnose(document);
          if (batch) { const response = await chrome.runtime.sendMessage({ type: 'idlepage-chapter-diagnostics', batch }); if (response?.accepted) chapterDiagnosed = true; }
        }
        const chapter = globalThis.IdlePageChapter?.extract(document);
        if (!chapter || chapter.status === 'pending') return;
        const signature = JSON.stringify(chapter);
        if (chapterOffset > 0 && signature !== chapterSignature) return;
        chapterStable = signature === chapterSignature ? chapterStable + 1 : 1; chapterSignature = signature;
        if (chapterStable < 3) return;
        if (chapter.status === 'unavailable') {
          const response = await chrome.runtime.sendMessage({ type: 'idlepage-chapter', batch: chapter });
          if (response?.accepted) chapterSent = true;
          return;
        }
        if (state !== 'SiteContentVisible') return;
        while (chapterOffset < chapter.text.length) {
          const batch = { status: 'available', offset: chapterOffset, total: chapter.text.length, text: chapter.text.slice(chapterOffset, chapterOffset + 2000) };
          const response = await chrome.runtime.sendMessage({ type: 'idlepage-chapter', batch });
          if (!response?.accepted) return;
          chapterOffset += batch.text.length;
        }
        chapterSent = true; return;
      }
      if (catalogRequested && !catalogSent && state === 'SiteContentVisible' && pageKind === 'book') {
        if (!catalogActivated) {
          catalogActivated = globalThis.IdlePageCatalog?.activate(document, location, catalogBookId) === true;
        }
        const catalog = globalThis.IdlePageCatalog?.extract(document, location, catalogBookId);
        if (!catalog) return;
        const signature = JSON.stringify(catalog);
        if (catalogSignature && signature !== catalogSignature && catalogOffset > 0) return; // Do not combine inconsistent snapshots.
        catalogStable = signature === catalogSignature ? catalogStable + 1 : 1;
        catalogSignature = signature;
        if (catalogStable < (catalog.total ? 3 : 15)) return;
        if (!catalog.total) {
          if (!emptyCatalogSent) {
            const response = await chrome.runtime.sendMessage({ type: 'idlepage-catalog', batch: { ...catalog, offset: 0 } });
            if (response?.accepted) emptyCatalogSent = true;
          }
          return;
        }
        while (catalogOffset < catalog.total) {
          const batch = { ...catalog, offset: catalogOffset, chapters: catalog.chapters.slice(catalogOffset, catalogOffset + 10) };
          const response = await chrome.runtime.sendMessage({ type: 'idlepage-catalog', batch });
          if (!response?.accepted) return;
          catalogOffset += batch.chapters.length;
        }
        catalogSent = true;
        return;
      }
      if (!bookshelfRequested || shelfSent || state !== 'SiteContentVisible' || pageKind !== 'bookshelf') return;
      const page = globalThis.IdlePageBookshelf?.extract(document, location);
      if (!page || !page.books.length) return;
      const signature = JSON.stringify(page);
      stableSamples = signature === shelfSignature ? stableSamples + 1 : 1;
      shelfSignature = signature;
      if (stableSamples < 3) return;
      const response = await chrome.runtime.sendMessage({ type: 'idlepage-bookshelf', page });
      if (response?.accepted) shelfSent = true;
    } catch { /* Extension reloaded or local bridge offline. */ }
    finally { sending = false; }
  }
  const timer = setInterval(() => { void observe(); }, 2000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  setTimeout(() => { void observe(); }, 1000);
})();
