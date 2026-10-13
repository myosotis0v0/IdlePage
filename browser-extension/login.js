// Positive evidence from the official personal bookshelf; never reads cookies or account text.
globalThis.IdlePageLogin = {
  evidence(document, location) {
    if (location.hostname !== 'my.qidian.com' || !/^\/bookcase(?:\/|$)/.test(location.pathname)) return;
    const shelf = globalThis.IdlePageBookshelf?.extract(document, location);
    if (shelf?.books.length && ['table', 'known-container'].includes(shelf.strategy)) return 'bookshelf-content';
    // An empty shelf can be confirmed by an explicit visible official sign-out control.
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (typeof anchor.getClientRects === 'function' && !anchor.getClientRects().length) continue;
      try {
        const url = new URL(anchor.getAttribute('href'), location.href);
        if (url.protocol === 'https:' && /^(?:passport|my|www)\.qidian\.com$/.test(url.hostname) &&
            /\/(?:logout|signout)(?:\/|$)/i.test(url.pathname)) return 'signed-in-control';
      } catch { /* Unrelated link. */ }
    }
  },
};
