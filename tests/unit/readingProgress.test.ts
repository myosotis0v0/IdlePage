import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadingProgress } from '../../src/application/ReadingProgress';
import { ReadingText } from '../../src/application/ReadingText';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';

test('per-book progress and last book survive storage reconstruction with serialized writes', async () => {
  const data = new Map<string, unknown>();
  const storage = { get: <T>(key: string) => data.get(key) as T | undefined, update: async (key: string, value: unknown) => { await new Promise(r => setTimeout(r, 2)); data.set(key, structuredClone(value)); } };
  const progress = new ReadingProgress(storage, () => assert.fail('write failed'));
  progress.save({ bookId: '1', chapterId: '11', title: 'One', offset: 17, progress: 8 });
  progress.save({ bookId: '2', chapterId: '22', title: 'Two', offset: 20, progress: 10 });
  progress.save({ bookId: '1', chapterId: '11', title: 'One', offset: 31, progress: 18 });
  await progress.flush();
  const restored = new ReadingProgress(storage, () => {});
  assert.equal(restored.last()?.bookId, '1'); assert.equal(restored.get('1')?.offset, 31); assert.equal(restored.get('2')?.offset, 20);
  const copy = restored.last()!; copy.offset = 0; assert.equal(restored.last()?.offset, 31);
});

test('malformed persisted bookmarks are ignored and write failure is reported', async () => {
  let failed = 0;
  const progress = new ReadingProgress({ get: <T>() => ({ books: [{ bookId: '1', chapterId: '2', offset: -1 }], lastBook: '1' } as T), update: async () => { throw new Error('disk'); } }, () => failed++);
  assert.equal(progress.last(), undefined);
  progress.save({ bookId: '1', chapterId: '2', title: 'Fixture', offset: 10, progress: 2 });
  await progress.flush(); assert.equal(failed, 1);
});

test('restoring a UTF-16 position survives layout changes and supports backward navigation', () => {
  const text = '你好，👨‍👩‍👧‍👦今天开始阅读。'.repeat(70);
  const original = new ReadingText(); original.set('1', text); original.resize(20, 2);
  original.next(); original.next(); const saved = original.view().offset;
  const restored = new ReadingText(); restored.set('2', text); restored.resize(30, 3); restored.seek(saved);
  assert.equal(restored.view().offset, saved);
  restored.resize(17, 2); assert.equal(restored.view().offset, saved);
  restored.next(); restored.previous(); assert.equal(restored.view().offset, saved);
  restored.previous(); assert.ok(restored.view().offset < saved);
  restored.seek(text.length + 100); assert.ok(restored.view().offset < text.length);
  restored.seek(5); assert.equal(restored.view().offset, 3, 'resume inside a combined emoji snaps to its start');
});

test('saved book can resume with cached catalog without a bookshelf, then use ordinary cached chapter pipeline', () => {
  const probe = new QidianAccessProbe(true); probe.invalidateTask(); probe.setReadingMode(true);
  const catalog = { bookId: '123', total: 1, declaredCount: 1, truncated: false, strategy: 'catalog-container' as const,
    chapters: [{ id: '456', title: 'Fixture', volume: '', payment: 'unknown' as const, url: 'https://www.qidian.com/chapter/123/456/' }] };
  assert.equal(probe.resumeBook('123', catalog), true);
  assert.equal(probe.selectChapter('123', '456'), true);
  const pending = probe.pendingCacheChapter()!; assert.ok(pending);
  assert.equal(probe.resolveCachedChapter(pending.taskId, { bookId: '123', chapterId: '456', url: catalog.chapters[0].url, title: 'Fixture', text: 'Cached body' }), true);
  assert.equal(probe.getReadingChapter()?.text, 'Cached body');
  probe.resumeBook('123'); assert.equal(probe.nextTask()?.kind, 'catalog');
});
