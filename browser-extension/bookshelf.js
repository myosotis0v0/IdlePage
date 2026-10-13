// The DOM extractor runs only on the official bookshelf page. No cookie/network access.
globalThis.IdlePageBookshelf = {
  extract(document, location) {
    if (location.hostname !== 'my.qidian.com' || !/^\/bookcase(?:\/|$)/.test(location.pathname)) return null;
    const visible = element => typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
    const tables = [...document.querySelectorAll('table')].filter(table => visible(table) &&
      /书名|作品名称/.test(table.querySelector('thead')?.textContent ?? '') && /作者|更新|最近阅读|操作/.test(table.querySelector('thead')?.textContent ?? ''));
    let root = tables[0];
    let strategy = root ? 'table' : 'unconfirmed';
    if (!root) {
      root = document.querySelector('#bookcaseTable, #bookcaseList, .bookcase-table');
      if (root && visible(root)) strategy = 'known-container'; else root = null;
    }
    const anchors = [...(root ?? document).querySelectorAll('a[href]')];
    const books = new Map();
    let anchorCount = 0;
    const hints = new Set();
    for (const anchor of anchors) {
      if (!visible(anchor) || anchor.closest('aside, nav, header, footer, [class*="recommend"]')) continue;
      let url;
      try { url = new URL(anchor.getAttribute('href'), location.href); } catch { continue; }
      const match = /^\/(?:book|info)\/(\d{1,20})\/?$/.exec(url.pathname);
      if (url.protocol !== 'https:' || !['www.qidian.com', 'book.qidian.com'].includes(url.hostname) || !match || url.username || url.password || url.port) continue;
      anchorCount++;
      const title = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!title || title.length > 120) continue;
      const id = match[1];
      if (!books.has(id)) books.set(id, { id, title, url: `https://www.qidian.com/book/${id}/` });
      let parent = anchor.parentElement;
      for (let i = 0; i < 3 && parent; i++, parent = parent.parentElement) {
        const classes = [...parent.classList].filter(c => /^[a-zA-Z_-]{1,40}$/.test(c)).slice(0, 3);
        hints.add(parent.tagName.toLowerCase() + classes.map(c => '.' + c).join(''));
      }
    }
    const controls = [...document.querySelectorAll('.pagination a, .pagination button, .lbf-pagination a, .page-box a, [rel="next"]')].filter(visible);
    const hasNext = controls.some(el => (/下一页|下页|next/i.test((el.textContent ?? '') + (el.getAttribute('title') ?? '') + (el.getAttribute('rel') ?? ''))) &&
      !el.hasAttribute('disabled') && !el.closest('.disabled, [aria-disabled="true"]'));
    const page = { books: [...books.values()].slice(0, 100), strategy, anchorCount, truncated: books.size > 100,
      pagination: hasNext ? 'next-visible' : controls.length ? 'controls-visible' : 'not-detected',
      containerHints: [...hints].slice(0, 12) };
    while (new TextEncoder().encode(JSON.stringify(page)).length > 12000 && page.books.length) {
      page.books.pop(); page.truncated = true;
    }
    return page;
  },
};