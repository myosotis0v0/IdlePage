import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
import { ReadingPrefetch } from '../../src/application/ReadingPrefetch';
import { ReadingText, splitStatusText, textCells } from '../../src/application/ReadingText';
import type { CachedChapter } from '../../src/domain/readingCache';
const visible = { state: 'SiteContentVisible', pageKind: 'chapter', bodyCharacters: 1000, bookLinks: 0, verification: false, tooFrequent: false, captchaFrame: false };
const catalog = { bookId: '100', total: 6, declaredCount: 6, truncated: false, strategy: 'catalog-container' as const,
  chapters: Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), title: 'Fixture', volume: '', payment: 'unknown' as const, url: `https://www.qidian.com/chapter/100/${i + 1}/` })) };
function probe() {
  const p = new QidianAccessProbe();
  p.restoreMetadata({ books: [{ id: '100', title: 'Fixture', url: 'https://www.qidian.com/book/100/' }], strategy: 'table', anchorCount: 1, truncated: false, pagination: 'not-detected', containerHints: [] }, catalog);
  p.startChapterExtraction(); complete(p); return p;
}
function complete(p: QidianAccessProbe) {
  const task = p.nextTask()!; assert.ok(task);
  p.accept(task.id, visible); assert.equal(p.acceptChapter(task.id, { status: 'available', offset: 0, total: 4, text: 'body' }), 'accepted');
}
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 2)); assert.ok(check()); }
function setup(p: QidianAccessProbe, save = true) {
  const data = new Map<string, CachedChapter>(); const failures: string[] = []; let launches = 0;
  const cache = { chapter: async (_book: string, id: string) => data.get(id), saveChapter: async (c: CachedChapter) => { if (save) data.set(c.chapterId, c); return save; } };
  const scheduler = new ReadingPrefetch(p, cache, () => {}, () => { launches++; }, reason => failures.push(reason));
  return { data, failures, scheduler, launches: () => launches };
}
test('three chapter horizon never changes reading, advances by one and reuses cache', async () => {
  const p = probe(); const h = setup(p); const revision = p.readingContext()!.revision;
  h.scheduler.sync();
  for (const id of ['2', '3', '4']) {
    await until(() => p.isPrefetching()); assert.ok(p.nextTask()!.url.endsWith(`/${id}/`));
    complete(p); assert.equal(p.readingContext()!.revision, revision); assert.equal(p.readingLocation().chapterId, '1');
    h.scheduler.sync(); await until(() => h.data.has(id));
  }
  await until(() => h.data.size === 3); assert.equal(h.launches(), 3);
  h.scheduler.pause(); assert.equal(p.startNextChapter(), 'started'); complete(p); h.scheduler.sync();
  await until(() => p.isPrefetching()); assert.ok(p.nextTask()!.url.endsWith('/5/')); assert.equal(h.launches(), 4);
  complete(p); h.scheduler.sync(); await until(() => h.data.has('5'));
  assert.equal(p.readingLocation().chapterId, '2'); assert.deepEqual(h.failures, []);
});
test('prefetch login and unavailable failures stop silently without altering position or automatic retry', async () => {
  for (const reason of ['needs-login', 'locked', 'access-blocked'] as const) {
    const p = probe(); const h = setup(p); h.scheduler.sync(); await until(() => p.isPrefetching());
    const task = p.nextTask()!;
    p.acceptChapter(task.id, { status: 'unavailable', reason }); h.scheduler.sync();
    await until(() => h.failures.length === 1);
    assert.equal(p.snapshot().recovery.waitingLogin, false); assert.equal(p.nextTask(), null);
    assert.equal(p.readingLocation().chapterId, '1'); assert.equal(p.getReadingChapter()?.text, 'body');
    h.scheduler.sync(); await new Promise(r => setTimeout(r, 5)); assert.equal(h.launches(), 1);
    h.scheduler.retry(); await until(() => p.isPrefetching()); assert.equal(h.launches(), 2);
    h.scheduler.dispose();
  }
});
test('foreground preempts prefetch and stale results cannot commit or cache', async () => {
  const p = probe(); const h = setup(p); h.scheduler.sync(); await until(() => p.isPrefetching()); const old = p.nextTask()!;
  h.scheduler.pause(); p.selectBook('100', catalog); p.selectChapter('100', '5');
  assert.equal(p.acceptChapter(old.id, { status: 'available', offset: 0, total: 4, text: 'body' }), 'stale');
  complete(p); h.scheduler.sync(); await until(() => p.isPrefetching());
  assert.ok(p.nextTask()!.url.endsWith('/6/')); complete(p); h.scheduler.sync(); await until(() => h.data.has('6'));
  assert.equal(p.readingLocation().chapterId, '5'); assert.equal(h.data.size, 1);
});
test('cache disabled, rejected writes and timeout report a single stopped prefetch chain', async () => {
  const p = probe(); const failures: string[] = [];
  new ReadingPrefetch(p, undefined, () => {}, () => {}, reason => failures.push(reason)).sync();
  assert.deepEqual(failures, ['cache-disabled']);
  const h = setup(p, false); h.scheduler.sync(); await until(() => p.isPrefetching()); complete(p); h.scheduler.sync();
  await until(() => h.failures.length === 1); assert.equal(h.failures[0], 'cache-capacity');
  h.scheduler.retry(); await until(() => p.isPrefetching()); p.expireChapter(Date.now() + 100000); h.scheduler.sync();
  await until(() => h.failures.length === 2); assert.equal(h.failures[1], 'timeout');
});
test('reader-mode login failure does not open login and retry keeps the requested chapter', () => {
  const p = probe(); p.setReadingMode(true); p.startNextChapter();
  p.accept(p.nextTask()!.id, { ...visible, state: 'NeedsLogin', pageKind: 'login' });
  assert.equal(p.snapshot().recovery.waitingLogin, false); assert.equal(p.getChapter()?.status, 'unavailable');
  assert.equal(p.retryReadingChapter(), true); assert.ok(p.nextTask()!.url.endsWith('/2/'));
});

test('a cache lookup completing after pause cannot launch an obsolete task', async () => {
  const p = probe(); let finish!: (chapter: CachedChapter | undefined) => void; let launches = 0;
  const scheduler = new ReadingPrefetch(p, { chapter: () => new Promise(resolve => { finish = resolve; }), saveChapter: async () => true }, () => {}, () => { launches++; }, () => {});
  scheduler.sync(); scheduler.pause(); finish(undefined);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(p.currentTaskId(), undefined); assert.equal(launches, 0);
});

test('quota eviction of an earlier horizon entry stops rather than redownloading forever', async () => {
  const p = probe(); let saved: CachedChapter | undefined; const failures: string[] = [];
  const scheduler = new ReadingPrefetch(p, { chapter: async (_, id) => saved?.chapterId === id ? saved : undefined,
    saveChapter: async chapter => { saved = chapter; return true; } }, () => {}, () => {}, reason => failures.push(reason));
  scheduler.sync();
  for (const id of ['2', '3', '4']) {
    await until(() => p.isPrefetching()); complete(p); scheduler.sync(); await until(() => saved?.chapterId === id);
  }
  await until(() => failures.length === 1); assert.deepEqual(failures, ['cache-capacity']);
  scheduler.sync(); assert.equal(p.currentTaskId(), undefined);
});
test('text segmentation covers all code points, preserves offset on resize and keeps native icon syntax literal', () => {
  const r = new ReadingText(); const text = '一二三四五六😀七八九十ABCDEFGHIJ'; r.resize(4); r.set('one', text);
  assert.equal(r.view().progress, 0); let reconstructed = r.view().text;
  while (r.next()) reconstructed += r.view().text;
  assert.equal(reconstructed, text); assert.equal(r.view().progress, 100);
  r.previous(); const offset = r.view().offset; r.resize(7); assert.equal(r.view().offset, offset);
  r.set('two', '$(eye)正文'); assert.equal(r.view().progress, 0); assert.ok(!r.view().text.includes('$(eye)'));
});

test('native 40vw cap is respected by multi-item segments without clipping or skipping text', () => {
  const text = '中文MW😀abc。'.repeat(120);
  for (const width of [640, 1000, 2048]) for (const percentage of [10, 30, 60, 80]) {
    const slots = Math.ceil(percentage / 30);
    const capacity = Math.max(4, Math.floor((width * percentage / 100 / slots - 24) / 13));
    const reader = new ReadingText(); reader.resize(capacity * slots - (slots - 1)); reader.set('fixture', text);
    let all = '';
    do {
      const segment = reader.view().text;
      const chunks = splitStatusText(segment, capacity);
      assert.equal(chunks.join(''), segment); assert.ok(chunks.length <= slots);
      for (const chunk of chunks) {
        const cells = [...chunk].reduce((n, c) => n + textCells(c), 0);
        assert.ok(cells * 13 + 16 < width * 0.4);
      }
      all += chunks.join('');
    } while (reader.next());
    assert.equal(all, text);
  }
});

