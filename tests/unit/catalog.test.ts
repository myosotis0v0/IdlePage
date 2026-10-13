import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { parseCatalogBatch, type CatalogBatch } from '../../src/domain/catalog';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
import { catalogPreview } from '../../src/ui/catalogPreview';
const source = await readFile(new URL('../../browser-extension/catalog.js', import.meta.url), 'utf8');
function extract(html: string) {
  const context: Record<string, any> = { URL };
  runInNewContext(source, context);
  const { document } = parseHTML(html);
  return context.IdlePageCatalog.extract(document, { hostname: 'www.qidian.com', pathname: '/book/100/', href: 'https://www.qidian.com/book/100/', origin: 'https://www.qidian.com' }, '100');
}
const chapter = (id: string) => ({ id, title: `测试章节${id}`, url: `https://www.qidian.com/chapter/100/${id}/`, volume: '正文卷', payment: 'unknown' as const });
const batch = (override: Partial<CatalogBatch> = {}): CatalogBatch => ({ bookId: '100', offset: 0, total: 3, declaredCount: 3, truncated: false, strategy: 'catalog-container', chapters: [chapter('1')], ...override });
function session() {
  const probe = new QidianAccessProbe(); probe.startCatalogExtraction();
  const shelf = probe.nextTask()!;
  const visible = { state: 'SiteContentVisible', pageKind: 'bookshelf', bodyCharacters: 1500, bookLinks: 1, verification: false, tooFrequent: false, captchaFrame: false };
  probe.accept(shelf.id, visible);
  probe.acceptBookshelf(shelf.id, { books: [{ id: '100', title: 'Fixture book', url: 'https://www.qidian.com/book/100/' }], strategy: 'table', anchorCount: 1, truncated: false, pagination: 'not-detected', containerHints: ['table'] });
  const task = probe.nextTask()!; assert.equal(task.kind, 'catalog');
  return { probe, task, visible: { ...visible, pageKind: 'book', bookLinks: 0 } };
}
test('catalog DOM preserves volume order, excludes latest/recommended links, and marks only explicit prices', () => {
  const page = extract(`<html><body><div>目录(3章)</div><a href="/chapter/100/3/">最新章节</a><div id="j-catalogWrap"><div class="volume"><h3>正文卷 免费</h3><ul><li><a href="/chapter/100/1/">第一章</a></li><li><a href="/chapter/100/2/">第二章</a></li></ul></div><div class="volume"><h3>第二卷 VIP</h3><li><a href="/chapter/100/3/">第三章</a></li><li><a href="/chapter/200/9/">其他书籍</a></li></div></div></body></html>`);
  assert.equal(page.total, 3);
  assert.equal(page.declaredCount, 3);
  assert.equal(page.chapters.map((c: any) => c.id).join(','), '1,2,3');
  assert.equal(page.chapters.map((c: any) => c.payment).join(','), 'free,free,paid');
  assert.ok(parseCatalogBatch({ ...page, offset: 0 }));
});
test('legacy official chapter links retain opaque IDs and unknown price', () => {
  const page = extract('<html><body><div id="j-catalogWrap"><a href="https://read.qidian.com/chapter/bookToken2/chapterToken2/">测试章</a></div></body></html>');
  assert.equal(page.chapters[0].id, 'chapterToken2');
  assert.equal(page.chapters[0].payment, 'unknown');
  assert.ok(parseCatalogBatch({ ...page, offset: 0 }));
});

test('reading-position shortcut cannot replace its later catalog chapter or change order', () => {
  const page = extract(`<html><body><div id="j-catalogWrap">
    <a href="/chapter/100/3/">你已读至3.测试章节</a>
    <a href="/chapter/100/99/">您已读至：旧进度</a>
    <a href="/chapter/100/3/">继续阅读</a>
    <div class="volume"><h3>正文卷 免费</h3><li><a href="/chapter/100/1/">第一章</a></li></div>
    <div class="volume"><h3>第二卷 VIP</h3><li><a href="/chapter/100/3/">第三章</a></li>
    <li><a href="/chapter/100/4/">继续阅读的故事</a></li></div>
  </div></body></html>`);
  assert.equal(page.total, 3);
  assert.equal(page.chapters.map((c: any) => c.id).join(','), '1,3,4');
  assert.equal(page.chapters[1].title, '第三章');
  assert.equal(page.chapters[1].volume, '第二卷 VIP');
  assert.equal(page.chapters.map((c: any) => c.payment).join(','), 'free,paid,paid');
});
test('batch contract rejects foreign sites, wrong book IDs, raw fields, and oversized batches', () => {
  for (const value of [
    { ...batch(), cookie: 'unexpected' },
    batch({ chapters: [{ ...chapter('1'), url: 'https://evil.example/chapter/100/1/' }] }),
    batch({ chapters: [{ ...chapter('1'), url: 'https://www.qidian.com/chapter/200/1/' }] }),
    batch({ chapters: [{ ...chapter('1'), url: 'https://www.qidian.com/chapter/100/1/?token=x' }] }),
    batch({ total: 11, chapters: Array.from({ length: 11 }, (_, i) => chapter(String(i + 1))) }),
  ]) assert.equal(parseCatalogBatch(value), undefined);
});
test('ordered batches are idempotent, challenge blocks catalog, and summaries omit names and IDs', () => {
  let { probe, task, visible } = session();
  assert.equal(probe.acceptCatalog(task.id, batch()), 'invalid');
  probe.accept(task.id, { ...visible, captchaFrame: true });
  assert.equal(probe.acceptCatalog(task.id, batch()), 'stale');
  assert.equal(probe.nextTask(), null);
  probe.startCatalogExtraction(); task = probe.nextTask()!;
  probe.accept(task.id, visible);
  assert.equal(probe.acceptCatalog(task.id, batch({ offset: 1 })), 'invalid');
  assert.equal(probe.acceptCatalog(task.id, batch()), 'accepted');
  assert.equal(probe.acceptCatalog(task.id, batch()), 'accepted');
  assert.equal(probe.snapshot().catalogSummary?.count, 1);
  assert.equal(probe.acceptCatalog(task.id, batch({ offset: 1, chapters: [chapter('1')] })), 'invalid');
  assert.equal(probe.acceptCatalog(task.id, batch({ offset: 1, chapters: [chapter('2'), chapter('3')] })), 'accepted');
  assert.equal(probe.snapshot().phase, 'catalog-preview-ready');
  assert.equal(probe.getCatalog()?.chapters.length, 3);
  assert.ok(!JSON.stringify(probe.snapshot()).includes('测试章节'));
  assert.equal(probe.acceptCatalog(task.id, batch()), 'stale');
});
test('empty catalog remains pending and preview reports mismatch and escapes text', () => {
  let { probe, task, visible } = session(); probe.accept(task.id, visible);
  assert.equal(probe.acceptCatalog(task.id, batch({ total: 0, chapters: [] })), 'accepted');
  assert.equal(probe.snapshot().phase, 'catalog-not-ready');
  assert.equal(probe.nextTask()?.id, task.id);
  const html = catalogPreview({ ...batch(), declaredCount: 4, chapters: [{ ...chapter('1'), title: '<script>x</script>' }] }, '<book>');
  assert.ok(html.includes('数量不一致'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
});
