globalThis.IdlePageChapter = {
  diagnose(document) {
    const hints = new Set();
    const annotationNodes = new Set();
    const label = el => {
      const safe = value => /^[a-zA-Z][a-zA-Z_-]{0,39}$/.test(value);
      const id = safe(el.id) ? '#' + el.id : '';
      const classes = [...el.classList].filter(safe).slice(0, 3).map(c => '.' + c).join('');
      return el.tagName.toLowerCase() + id + classes;
    };
    const paragraphs = [...document.querySelectorAll('p')].filter(el => (el.innerText ?? el.textContent ?? '').trim().length > 80);
    for (const paragraph of paragraphs.slice(0, 4)) {
      let el = paragraph.parentElement;
      for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
        hints.add(label(el));
      }
    }
    for (const el of document.querySelectorAll('.chapter-wrapper main.content p *, .read-content p *, .chapter-content p *')) {
      if (el.children.length || !/^\d+$/.test((el.textContent ?? '').trim())) continue;
      annotationNodes.add(label(el));
      let parent = el.parentElement;
      for (let depth = 0; parent && parent.tagName !== 'P' && depth < 2; depth++, parent = parent.parentElement) annotationNodes.add(label(parent));
      if (annotationNodes.size >= 12) break;
    }
    return { paragraphs: Math.min(paragraphs.length, 10000), containers: [...hints].slice(0, 12), annotationNodes: [...annotationNodes].slice(0, 12) };
  },
  extract(document) {
    const visible = el => typeof el.getClientRects !== 'function' || el.getClientRects().length > 0;
    const textOf = el => (el?.innerText ?? el?.textContent ?? '').trim();
    const body = textOf(document.body);
    if (/安全验证|访问验证|拖动下方滑块|人机验证|操作过于频繁/.test(body)) return { status: 'unavailable', reason: 'access-blocked' };
    // Only explicit reading gates qualify; navigation and sidebar subscription
    // buttons must not mark an otherwise readable chapter as locked.
    const gates = [...document.querySelectorAll('.subscribe-wrap, .subscribe-content, .read-pay, .pay-wall, .paywall, .unlock-wrap, [data-role="paywall"]')].filter(visible);
    if (gates.some(el => /订阅|购买|解锁|付费|登录/.test(textOf(el))) || /本章(?:需要|需|尚未|未)订阅|订阅(?:本章|后(?:即可|可)阅读)|购买(?:本章|后(?:即可|可)阅读)|解锁(?:本章|后(?:即可|可)阅读)|本章为试读|试读结束|登录后(?:即可|可)阅读/.test(body)) return { status: 'unavailable', reason: 'locked' };
    const roots = [...document.querySelectorAll('.chapter-wrapper .print main.content, .read-content, #j_readContent, .chapter-content, #chapter-content, [data-role="chapter-content"]')].filter(visible);
    if (!roots.length) return { status: 'pending' };
    if (roots.length !== 1) return { status: 'unavailable', reason: 'unsupported-content' };
    const root = roots[0];
    // Canvas/image-only readers and explicit custom fonts require separate
    // verification; do not claim unreadable glyphs are usable text.
    if (root.querySelector('canvas, img') || root.querySelector('[style*="font-family"]')) return { status: 'unavailable', reason: 'unsupported-content' };
    const copy = root.cloneNode(true);
    // Remove explicit annotation widgets, never trailing digits in plain text.
    for (const el of copy.querySelectorAll('.review-count, .comment-count, .paragraph-comment, .paragraph-review, [data-role="paragraph-comment"], [data-role="review-count"], [aria-label*="评论"], [title*="评论"]')) {
      if (el.tagName !== 'P') el.remove();
    }
    for (const el of copy.querySelectorAll('script, style, button, nav, .ad, .advertisement, .author-say, .authorSay, .chapter-end, [hidden], [aria-hidden="true"]')) el.remove();
    const paragraphs = [...copy.querySelectorAll('p')].map(textOf).filter(Boolean);
    const text = (paragraphs.length ? paragraphs.join('\n\n') : textOf(copy)).replace(/\r\n?/g, '\n').trim();
    if (!text) return { status: 'pending' };
    if (/订阅本章|解锁本章|试读结束|购买本章|加载失败|请求失败|网络错误/.test(text)) return { status: 'unavailable', reason: 'page-error' };
    if (text.length > 500000 || /[\uE000-\uF8FF\uFFFD]/.test(text)) return { status: 'unavailable', reason: 'unsupported-content' };
    return { status: 'available', text };
  },
};
