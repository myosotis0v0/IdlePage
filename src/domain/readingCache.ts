import { parseBookshelfPage, type BookshelfPage } from './bookshelf';
import { parseCatalogBatch, type CatalogResult } from './catalog';

export interface CachedChapter { bookId: string; chapterId: string; url: string; title: string; text: string }
export interface CachedCatalog { catalog: CatalogResult; volumes: Array<{ id: string; title: string; chapterIds: string[] }> }
export type CacheEntry = { version: 1; key: string } & (
  { kind: 'shelf'; value: BookshelfPage } | { kind: 'catalog'; value: CachedCatalog } | { kind: 'chapter'; value: CachedChapter }
);
export function catalogStructure(catalog: CatalogResult): CachedCatalog {
  const volumes: CachedCatalog['volumes'] = [];
  for (const chapter of catalog.chapters) {
    if (volumes.at(-1)?.title !== chapter.volume) volumes.push({ id: `${catalog.bookId}:volume:${volumes.length}`, title: chapter.volume, chapterIds: [] });
    volumes.at(-1)!.chapterIds.push(chapter.id);
  }
  return { catalog: structuredClone(catalog), volumes };
}
export function parseCacheEntry(value: unknown): CacheEntry | undefined {
  if (!value || typeof value !== 'object') return;
  const entry = value as Record<string, any>;
  if (entry.version !== 1 || typeof entry.key !== 'string' || Object.keys(entry).some(k => !['version', 'key', 'kind', 'value'].includes(k))) return;
  if (entry.kind === 'shelf' && entry.key === 'shelf:qidian') {
    const shelf = parseBookshelfPage(entry.value);
    if (shelf) return { version: 1, key: entry.key, kind: 'shelf', value: shelf };
  }
  if (entry.kind === 'catalog') {
    const catalog = entry.value?.catalog;
    if (!catalog || !Array.isArray(catalog.chapters) || catalog.chapters.length !== catalog.total || catalog.total > 5000 ||
        entry.key !== `catalog:${catalog.bookId}` || !catalog.total || Object.keys(catalog).some(k => !['bookId', 'total', 'declaredCount', 'truncated', 'strategy', 'chapters'].includes(k))) return;
    const ids = new Set<string>();
    for (let offset = 0; offset < catalog.total; offset += 10) {
      const batch = parseCatalogBatch({ ...catalog, offset, chapters: catalog.chapters.slice(offset, offset + 10) });
      if (!batch) return;
      for (const chapter of batch.chapters) { if (ids.has(chapter.id)) return; ids.add(chapter.id); }
    }
    const structure = catalogStructure(catalog);
    if (JSON.stringify(entry.value.volumes) !== JSON.stringify(structure.volumes)) return;
    return { version: 1, key: entry.key, kind: 'catalog', value: structure };
  }
  if (entry.kind === 'chapter') {
    const chapter = entry.value;
    if (!chapter || Object.keys(chapter).some(k => !['bookId', 'chapterId', 'url', 'title', 'text'].includes(k)) ||
        typeof chapter.text !== 'string' || !chapter.text.trim() || chapter.text.length > 500000 ||
        typeof chapter.title !== 'string' || !chapter.title.trim() || chapter.title.length > 160 ||
        entry.key !== `chapter:${chapter.bookId}:${chapter.chapterId}`) return;
    const mapping = parseCatalogBatch({ bookId: chapter.bookId, offset: 0, total: 1, declaredCount: null, truncated: false,
      strategy: 'chapter-links', chapters: [{ id: chapter.chapterId, title: chapter.title, url: chapter.url, volume: '', payment: 'unknown' }] });
    if (mapping) return { version: 1, key: entry.key, kind: 'chapter', value: { ...chapter } };
  }
}
