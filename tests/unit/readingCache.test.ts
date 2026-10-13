import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadingCache } from '../../src/infrastructure/cache/ReadingCache';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
import { catalogStructure, parseCacheEntry } from '../../src/domain/readingCache';
import type { CatalogResult } from '../../src/domain/catalog';
import type { BookshelfPage } from '../../src/domain/bookshelf';
const shelf: BookshelfPage = { books: [{ id: '100', title: 'Fixture', url: 'https://www.qidian.com/book/100/' }], strategy: 'table', anchorCount: 1, truncated: false, pagination: 'not-detected', containerHints: [] };
const catalog: CatalogResult = { bookId: '100', total: 3, declaredCount: 3, truncated: false, strategy: 'catalog-container', chapters: [1, 2, 3].map(id => ({ id: String(id), title: `Fixture ${id}`, url: `https://www.qidian.com/chapter/100/${id}/`, volume: id < 3 ? 'A' : 'B', payment: 'unknown' })) };
const chapter = (id: number, text = 'Fixture body') => ({ bookId: '100', chapterId: String(id), url: `https://www.qidian.com/chapter/100/${id}/`, title: `Fixture ${id}`, text });
async function setup(t: { after(fn: () => Promise<void>): void }, limit?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'idlepage-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = new ReadingCache(directory, limit); await cache.initialize(); return cache;
}
test('cache reconstructs book/volume/chapter/body mapping after restart and missing index', async t => {
  const cache = await setup(t); await cache.saveShelf(shelf); await cache.saveCatalog(catalog); await cache.saveChapter(chapter(1));
  await writeFile(join(cache.directory, 'index.json'), 'broken');
  const restored = new ReadingCache(cache.directory); await restored.initialize();
  assert.deepEqual(await restored.shelf(), shelf);
  assert.deepEqual(await restored.catalog('100'), catalogStructure(catalog));
  assert.deepEqual((await restored.catalog('100'))?.volumes.map(v => v.chapterIds), [['1', '2'], ['3']]);
  assert.deepEqual(await restored.chapter('100', '1'), chapter(1));
  const bytes = (await Promise.all((await readdir(cache.directory)).map(async name => (await readFile(join(cache.directory, name))).length))).reduce((a, b) => a + b, 0);
  assert.equal(restored.summary().bytes, bytes);
});
test('quota includes index, evicts LRU bodies first, and rejects oversized writes without replacing content', async t => {
  const cache = await setup(t); await cache.saveShelf(shelf); await cache.saveCatalog(catalog);
  await cache.saveChapter(chapter(1, 'a'.repeat(2000))); await cache.saveChapter(chapter(2, 'b'.repeat(2000)));
  await cache.chapter('100', '1');
  const before = cache.summary().bytes; await cache.setLimit(before - 1000);
  assert.equal(await cache.chapter('100', '2'), undefined); assert.ok(await cache.chapter('100', '1'));
  assert.ok(await cache.shelf()); assert.ok(await cache.catalog('100'));
  assert.equal(await cache.saveChapter(chapter(1, 'x'.repeat(before))), false);
  assert.equal((await cache.chapter('100', '1'))?.text, 'a'.repeat(2000));
  assert.ok(cache.summary().bytes <= cache.summary().limitBytes);
});
test('corrupt files and temporary writes are discarded; foreign mappings are rejected', async t => {
  const cache = await setup(t); await cache.saveChapter(chapter(1));
  const file = (await readdir(cache.directory)).find(n => /^[a-f0-9]{64}\.json$/.test(n))!;
  await writeFile(join(cache.directory, file), 'broken'); await writeFile(join(cache.directory, file + '.tmp-deadbeef'), 'unfinished');
  const restored = new ReadingCache(cache.directory); await restored.initialize();
  assert.equal(restored.summary().entries, 0); assert.deepEqual(await readdir(cache.directory), ['index.json']);
  await assert.rejects(restored.saveChapter({ ...chapter(1), url: 'https://www.qidian.com/chapter/200/1/' }));
  assert.equal(parseCacheEntry({ version: 1, key: 'chapter:100:1', kind: 'chapter', value: { ...chapter(1), reason: 'locked' } }), undefined);
});
test('cache lookup blocks browser publication, commits only matching results, and rejects stale resolution', () => {
  const probe = new QidianAccessProbe(true); probe.restoreMetadata(shelf, catalog); probe.startChapterExtraction();
  const pending = probe.pendingCacheChapter()!; assert.equal(probe.nextTask(), null);
  assert.equal(probe.expireChapter(Date.now() + 100000), false);
  assert.equal(probe.resolveCachedChapter(pending.taskId, chapter(1)), true);
  assert.equal(probe.snapshot().chapterSource, 'cache'); assert.equal(probe.snapshot().chapterNavigation.current, 1);
  assert.equal(probe.nextTask(), null); assert.equal(probe.cacheChapter(), undefined);
  probe.startNextChapter(); const second = probe.pendingCacheChapter()!;
  assert.equal(probe.resolveCachedChapter(pending.taskId, chapter(1)), false);
  probe.resolveCachedChapter(second.taskId, chapter(3));
  assert.equal(probe.nextTask()?.url, chapter(2).url);
  probe.acceptChapter(second.taskId, { status: 'unavailable', reason: 'locked' });
  assert.equal(probe.snapshot().chapterNavigation.current, 1); assert.equal(probe.getReadingChapter()?.text, chapter(1).text);
});
