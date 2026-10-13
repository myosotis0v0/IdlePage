export interface ShelfBook { id: string; title: string; url: string }
export interface BookshelfPage {
  books: ShelfBook[];
  strategy: 'table' | 'known-container' | 'unconfirmed';
  anchorCount: number;
  truncated: boolean;
  pagination: 'next-visible' | 'controls-visible' | 'not-detected';
  containerHints: string[];
}
export function parseBookshelfPage(value: unknown): BookshelfPage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const page = value as Record<string, unknown>;
  if (Object.keys(page).some(k => !['books', 'strategy', 'anchorCount', 'truncated', 'pagination', 'containerHints'].includes(k))) return;
  if (!['table', 'known-container', 'unconfirmed'].includes(page.strategy as string) ||
      !['next-visible', 'controls-visible', 'not-detected'].includes(page.pagination as string) ||
      typeof page.truncated !== 'boolean' || !Number.isSafeInteger(page.anchorCount) || (page.anchorCount as number) < 0 || (page.anchorCount as number) > 10000 ||
      !Array.isArray(page.containerHints) || page.containerHints.length > 12 || !page.containerHints.every(x => typeof x === 'string' && /^[a-zA-Z0-9 .#_-]{1,120}$/.test(x)) ||
      !Array.isArray(page.books) || page.books.length > 100) return;
  const books: ShelfBook[] = [];
  const ids = new Set<string>();
  for (const value of page.books) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['id', 'title', 'url'].includes(k))) return;
    const { id, title, url } = value as Record<string, unknown>;
    if (typeof id !== 'string' || !/^\d{1,20}$/.test(id) || ids.has(id) || typeof title !== 'string' || !title.trim() || title.length > 120 || /[\u0000-\u001f]/.test(title) || typeof url !== 'string') return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !['www.qidian.com', 'book.qidian.com'].includes(parsed.hostname) || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !new RegExp(`^/(?:book|info)/${id}/?$`).test(parsed.pathname)) return;
    } catch { return; }
    ids.add(id); books.push({ id, title: title.trim(), url: `https://www.qidian.com/book/${id}/` });
  }
  if ((page.anchorCount as number) < books.length) return;
  return { books, strategy: page.strategy as BookshelfPage['strategy'], anchorCount: page.anchorCount as number, truncated: page.truncated as boolean,
    pagination: page.pagination as BookshelfPage['pagination'], containerHints: [...page.containerHints] };
}