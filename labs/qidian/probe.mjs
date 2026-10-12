export const PUBLIC_TARGETS = [
  'https://www.qidian.com/',
  'https://my.qidian.com/bookcase/',
  'https://m.qidian.com/',
];

export function isOfficialPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'qidian.com' || parsed.hostname.endsWith('.qidian.com'));
  } catch { return false; }
}

export async function observePage(page) {
  if (!isOfficialPage(page.url())) return { skipped: true, reason: 'outside-qidian' };
  const location = new URL(page.url());
  const signals = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const links = [...document.querySelectorAll('a[href]')].map(a => {
      try { return new URL(a.getAttribute('href'), location.href); }
      catch { return null; }
    }).filter(Boolean);
    const uniqueLinks = regex => new Set(links.filter(url =>
      (url.hostname === 'qidian.com' || url.hostname.endsWith('.qidian.com')) &&
      regex.test(url.pathname)).map(url => url.origin + url.pathname)).size;
    const selectors = ['.read-content', '.j_readContent', '.chapter-content', '#chapter-content'];
    const contentCandidates = selectors.map(selector => {
      const nodes = [...document.querySelectorAll(selector)].filter(node => node.getClientRects().length);
      const content = nodes.map(node => node.innerText ?? '').join('\n');
      return {
        selector, visibleNodes: nodes.length,
        characters: [...content.replace(/\s/g, '')].length,
        hanCharacters: (content.match(/\p{Script=Han}/gu) ?? []).length,
        privateUseCharacters: (content.match(/[\uE000-\uF8FF]/g) ?? []).length,
        replacementCharacters: (content.match(/\uFFFD/g) ?? []).length,
      };
    }).filter(candidate => candidate.visibleNodes > 0);
    return {
      bodyCharacters: [...text].length,
      loginPromptPresent: /登录|登錄/.test(text),
      logoutControlPresent: /退出登录|退出登錄/.test(text),
      verificationPromptPresent: /访问验证|安全验证|滑块验证|人机验证/.test(text),
      purchasePromptPresent: /订阅本章|购买本章|订阅后阅读/.test(text),
      bookLinks: uniqueLinks(/\/(?:book|info)\/[a-zA-Z0-9]+/),
      chapterLinks: uniqueLinks(/\/chapter\//),
      bookshelfLinks: uniqueLinks(/\/bookcase(?:\/|$)/),
      contentCandidates,
    };
  });
  // Never record URL queries, DOM text, names, cookies or response bodies.
  return {
    observedAt: new Date().toISOString(),
    host: location.hostname,
    pageKind: /\/bookcase/.test(location.pathname) ? 'bookshelf' :
      /\/chapter\//.test(location.pathname) ? 'chapter' :
      /\/(?:book|info)\//.test(location.pathname) ? 'book' : 'other',
    ...signals,
    verdict: 'signals-only-manual-validation-required',
  };
}
