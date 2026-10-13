export interface CatalogChapter { id: string; title: string; url: string; volume: string; payment: 'free' | 'paid' | 'unknown' }
export interface CatalogBatch {
  bookId: string; offset: number; total: number; declaredCount: number | null; truncated: boolean;
  strategy: 'catalog-container' | 'chapter-links'; chapters: CatalogChapter[];
}
export interface CatalogResult extends Omit<CatalogBatch, 'offset'> {}
export function parseCatalogBatch(value: unknown): CatalogBatch | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some(k => !['bookId', 'offset', 'total', 'declaredCount', 'truncated', 'strategy', 'chapters'].includes(k)) ||
      typeof r.bookId !== 'string' || !/^\d{1,20}$/.test(r.bookId) || typeof r.truncated !== 'boolean' ||
      !['catalog-container', 'chapter-links'].includes(r.strategy as string) ||
      !['offset', 'total'].every(k => Number.isSafeInteger(r[k]) && (r[k] as number) >= 0 && (r[k] as number) <= 5000) ||
      !(r.declaredCount === null || Number.isSafeInteger(r.declaredCount) && (r.declaredCount as number) >= 0 && (r.declaredCount as number) <= 100000) ||
      !Array.isArray(r.chapters) || r.chapters.length > 10 || (r.offset as number) + r.chapters.length > (r.total as number) ||
      r.total !== 0 && !r.chapters.length) return;
  const chapters: CatalogChapter[] = [];
  for (const value of r.chapters) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['id', 'title', 'url', 'volume', 'payment'].includes(k))) return;
    const { id, title, url, volume, payment } = value as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || typeof title !== 'string' || !title.trim() || title.length > 160 ||
        typeof volume !== 'string' || volume.length > 80 || /[\u0000-\u001f]/.test(title + volume) ||
        !['free', 'paid', 'unknown'].includes(payment as string) || typeof url !== 'string' || url.length > 220) return;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return;
      const modern = ['www.qidian.com', 'vipreader.qidian.com'].includes(u.hostname) && new RegExp(`^/chapter/${r.bookId}/${id}/?$`).test(u.pathname) && /^\d+$/.test(id);
      const legacy = u.hostname === 'read.qidian.com' && new RegExp(`^/chapter/[a-zA-Z0-9_-]{1,80}/${id}/?$`).test(u.pathname);
      if (!modern && !legacy) return;
    } catch { return; }
    chapters.push({ id, title: title.trim(), url, volume, payment: payment as CatalogChapter['payment'] });
  }
  return { bookId: r.bookId, offset: r.offset as number, total: r.total as number, declaredCount: r.declaredCount as number | null,
    truncated: r.truncated, strategy: r.strategy as CatalogBatch['strategy'], chapters };
}