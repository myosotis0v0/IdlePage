import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { catalogStructure, parseCacheEntry, type CacheEntry, type CachedChapter, type CachedCatalog } from '../../domain/readingCache';
import type { BookshelfPage } from '../../domain/bookshelf';
import type { CatalogResult } from '../../domain/catalog';

interface RecordEntry { key: string; kind: CacheEntry['kind']; bytes: number; touched: number }
const digest = (key: string) => createHash('sha256').update(key).digest('hex');
export class ReadingCache {
  private records = new Map<string, RecordEntry>();
  private queue: Promise<unknown> = Promise.resolve();
  private clock = Date.now();
  readonly directory: string;
  constructor(directory: string, private limitBytes = 200 * 1024 * 1024) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1024) throw new Error('InvalidCacheLimit');
    this.directory = resolve(directory);
  }

  initialize(): Promise<void> {
    return this.serial(async () => {
      await mkdir(this.directory, { recursive: true });
      this.records.clear();
      // Rebuild from committed entries; a crash between data and index writes
      // cannot discard a good chapter or trust an arbitrary index path.
      for (const name of await readdir(this.directory)) {
        if (/^[a-f0-9]{64}\.json\.tmp-[a-f0-9-]+$/.test(name)) { await unlink(join(this.directory, name)); continue; }
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        try {
          const info = await stat(join(this.directory, name));
          if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('CacheOversized');
          const entry = parseCacheEntry(JSON.parse(await readFile(join(this.directory, name), 'utf8')));
          if (!entry || name !== digest(entry.key) + '.json') throw new Error('CacheInvalid');
          this.records.set(digest(entry.key), { key: entry.key, kind: entry.kind, bytes: info.size, touched: info.mtimeMs });
        } catch { await unlink(join(this.directory, name)); }
      }
      this.clock = Math.max(this.clock, ...[...this.records.values()].map(r => r.touched));
      await this.trim(); await this.writeIndex();
    });
  }
  setLimit(bytes: number): Promise<void> {
    return this.serial(async () => { if (!Number.isSafeInteger(bytes) || bytes < 1024) throw new Error('InvalidCacheLimit'); this.limitBytes = bytes; await this.trim(); await this.writeIndex(); });
  }
  saveShelf(value: BookshelfPage) { return this.put({ version: 1, key: 'shelf:qidian', kind: 'shelf', value }); }
  saveCatalog(value: CatalogResult) { return this.put({ version: 1, key: `catalog:${value.bookId}`, kind: 'catalog', value: catalogStructure(value) }); }
  saveChapter(value: CachedChapter) { return this.put({ version: 1, key: `chapter:${value.bookId}:${value.chapterId}`, kind: 'chapter', value }); }
  async shelf(): Promise<BookshelfPage | undefined> { const e = await this.get('shelf:qidian'); return e?.kind === 'shelf' ? e.value : undefined; }
  async catalog(bookId: string): Promise<CachedCatalog | undefined> { const e = await this.get(`catalog:${bookId}`); return e?.kind === 'catalog' ? e.value : undefined; }
  async chapter(bookId: string, chapterId: string): Promise<CachedChapter | undefined> { const e = await this.get(`chapter:${bookId}:${chapterId}`); return e?.kind === 'chapter' ? e.value : undefined; }
  summary() { return { entries: this.records.size, bytes: this.size(), limitBytes: this.limitBytes }; }
  flush(): Promise<unknown> { return this.queue; }
  private get(key: string): Promise<CacheEntry | undefined> {
    return this.serial(async () => {
      const hash = digest(key); const record = this.records.get(hash);
      if (!record) return;
      let value: CacheEntry | undefined;
      try {
        const info = await stat(join(this.directory, hash + '.json'));
        if (info.size > 10 * 1024 * 1024) throw new Error('CacheOversized');
        value = parseCacheEntry(JSON.parse(await readFile(join(this.directory, hash + '.json'), 'utf8')));
        if (!value || value.key !== key) throw new Error('CacheInvalid');
      } catch {
        await unlink(join(this.directory, hash + '.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
        this.records.delete(hash); await this.writeIndex(); return;
      }
      record.touched = ++this.clock;
      // Persist LRU without rewriting the chapter text. An LRU/index write
      // failure must not delete a successfully validated chapter.
      const { utimes } = await import('node:fs/promises');
      await utimes(join(this.directory, hash + '.json'), new Date(record.touched), new Date(record.touched));
      await this.writeIndex(); return value;
    });
  }
  private put(value: CacheEntry): Promise<boolean> {
    return this.serial(async () => {
      const entry = parseCacheEntry(value); if (!entry) throw new Error('InvalidCacheData');
      const body = JSON.stringify(entry); const bytes = Buffer.byteLength(body);
      if (bytes + 1024 > this.limitBytes) return false;
      const hash = digest(entry.key); const temporary = join(this.directory, hash + '.json.tmp-' + randomUUID());
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, join(this.directory, hash + '.json'));
      this.records.set(hash, { key: entry.key, kind: entry.kind, bytes, touched: ++this.clock });
      await this.trim(hash); await this.writeIndex(); return this.records.has(hash);
    });
  }
  private indexBody() { return JSON.stringify({ version: 1, entries: Object.fromEntries(this.records) }); }
  private size() { return [...this.records.values()].reduce((sum, entry) => sum + entry.bytes, Buffer.byteLength(this.indexBody())); }
  private async trim(keep?: string) {
    while (this.size() > this.limitBytes && this.records.size) {
      const candidate = [...this.records.entries()].filter(([hash]) => hash !== keep)
        .sort((a, b) => Number(a[1].kind !== 'chapter') - Number(b[1].kind !== 'chapter') || a[1].touched - b[1].touched)[0];
      const victim = candidate ?? [...this.records.entries()][0];
      await unlink(join(this.directory, victim[0] + '.json')); this.records.delete(victim[0]);
    }
  }
  private async writeIndex() {
    const temporary = join(this.directory, 'index.tmp');
    await writeFile(temporary, this.indexBody(), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, join(this.directory, 'index.json'));
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
}
