globalThis.IdlePageCatalog = {
  activate(document, location, bookId) {
    if (!['www.qidian.com', 'book.qidian.com'].includes(location.hostname) || !new RegExp(`^/(?:book|info)/${bookId}(?:/|$)`).test(location.pathname)) return false;
    const target = [...document.querySelectorAll('a, button, [role="tab"]')].find(el => /^目录(?:\s*[（(]\d+\s*章?[)）])?$/.test((el.textContent ?? '').replace(/\s+/g, ' ').trim()) &&
      (typeof el.getClientRects !== 'function' || el.getClientRects().length));
    if (!target) return false;
    const href = target.getAttribute('href');
    if (href) {
      try { const url = new URL(href, location.href); if (url.origin !== location.origin || !new RegExp(`^/(?:book|info)/${bookId}(?:/catalog/?)?/?$`).test(url.pathname)) return false; } catch { return false; }
    }
    target.click(); return true;
  },
  extract(document, location, bookId) {
    if (!/^\d{1,20}$/.test(bookId ?? '') || !['www.qidian.com', 'book.qidian.com'].includes(location.hostname) || !new RegExp(`^/(?:book|info)/${bookId}(?:/|$)`).test(location.pathname)) return null;
    const root = document.querySelector('#j-catalogWrap, #catalogWrap, .catalog-content, .catalog-list, .volume-wrap, #Catalog, [data-role="catalog"]');
    const scope = root ?? document;
    const chapters = new Map();
    for (const anchor of scope.querySelectorAll('a[href]')) {
      if (anchor.closest('aside, nav, header, footer, [class*="recommend"]')) continue;
      let url;
      try { url = new URL(anchor.getAttribute('href'), location.href); } catch { continue; }
      if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
      const modern = /^\/chapter\/(\d{1,20})\/(\d{1,20})\/?$/.exec(url.pathname);
      const legacy = /^\/chapter\/([a-zA-Z0-9_-]{1,80})\/([a-zA-Z0-9_-]{1,80})\/?$/.exec(url.pathname);
      let id;
      if (['www.qidian.com', 'vipreader.qidian.com'].includes(url.hostname) && modern?.[1] === bookId) id = modern[2];
      else if (url.hostname === 'read.qidian.com' && legacy) id = legacy[2];
      if (!id) continue;
      const title = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!title || title.length > 160) continue;
      // Reading-position shortcuts can sit inside the catalog and point to a
      // real chapter. Exclude them before deduplication so its directory row wins.
      if (/^(?:你|您)?(?:已读至|读至|上次读至|上次阅读至|继续阅读)(?:\s|[:：]|\d|$)/.test(title)) continue;
      const volumeElement = anchor.closest('.volume, .volume-wrap, [data-volume], section');
      const heading = (volumeElement?.querySelector('h2, h3, h4, .volume-name')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const row = anchor.closest('li, tr') ?? anchor;
      const marker = (anchor.getAttribute('data-vip') ?? row.getAttribute('data-vip'));
      const payment = marker === '1' || marker === 'true' || /VIP|付费|收费/i.test(heading) || row.querySelector('.vip, .vip-tag, .icon-lock') ? 'paid' :
        marker === '0' || marker === 'false' || /免费/.test(heading) ? 'free' : 'unknown';
      if (!chapters.has(id)) chapters.set(id, { id, title, volume: heading, payment, url: url.origin + url.pathname });
    }
    const text = document.body?.innerText ?? document.body?.textContent ?? '';
    const declared = /目录\s*[（(]\s*(\d+)\s*章\s*[)）]|(?:全部章节|目录)\s*[·:：]?\s*共\s*(\d+)\s*章/.exec(text);
    return { bookId, chapters: [...chapters.values()].slice(0, 5000), total: Math.min(chapters.size, 5000),
      declaredCount: declared ? Number(declared[1] ?? declared[2]) : null,
      truncated: chapters.size > 5000, strategy: root ? 'catalog-container' : 'chapter-links' };
  },
};
