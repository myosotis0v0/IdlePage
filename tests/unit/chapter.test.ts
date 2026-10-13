import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { parseChapterBatch } from '../../src/domain/chapter';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
import { chapterPreview } from '../../src/ui/chapterPreview';
const source = await readFile(new URL('../../browser-extension/chapter.js', import.meta.url), 'utf8');
function extract(html: string) { const context: Record<string, any> = {}; runInNewContext(source, context); return context.IdlePageChapter.extract(parseHTML(`<html><body>${html}</body></html>`).document); }
test('chapter extractor normalizes paragraphs and excludes non-content elements', () => {
  const result = extract('<aside>订阅</aside><div class="read-content"><p>第一段。</p><p>第二段。</p><button>下一章</button><div class="author-say">作者的话</div><p hidden>隐藏内容</p></div>');
  assert.equal(result.status, 'available'); assert.equal(result.text, '第一段。\n\n第二段。');
});

test('observed modern reading container is scoped to the chapter wrapper', () => {
  const result = extract('<main class="content"><p>无关侧栏</p></main><div class="chapter-wrapper"><div class="print"><main class="content relative r-font-black"><p>正文第一段。</p><p>正文第二段。</p></main></div></div>');
  assert.equal(result.status, 'available'); assert.equal(result.text, '正文第一段。\n\n正文第二段。');
});

test('comment counts are excluded while authored numbers at paragraph ends are preserved', () => {
  const result = extract('<div class="read-content"><p>他说数字是53<span class="review-count">10</span></p><p>编号<span>3</span><a aria-label="段落评论">53</a></p><p>真正的数字结尾 2026</p><p>文中<span>10</span>也要保留<span class="paragraph-comment"><span>5</span></span></p></div>');
  assert.equal(result.text, '他说数字是53\n\n编号3\n\n真正的数字结尾 2026\n\n文中10也要保留');
});
test('gates, previews, error text and unsupported glyphs are never accepted as body text', () => {
  for (const html of ['<div class="subscribe-wrap">订阅后可阅读</div>', '<div class="read-content"><p>试读结束</p></div>', '<div class="read-content"><p>请求失败</p></div>', '<div class="read-content"><p>\uE001</p></div>', '<div class="read-content"><canvas></canvas></div>']) assert.equal(extract(html).status, 'unavailable');
  assert.equal(extract('<div>普通页面</div>').status, 'pending');
});
const observation = { state: 'SiteContentVisible', pageKind: 'bookshelf', bodyCharacters: 1500, bookLinks: 1, verification: false, tooFrequent: false, captchaFrame: false };
function session(count = 1) {
  const probe = new QidianAccessProbe(); probe.startChapterExtraction(); let task = probe.nextTask()!;
  probe.accept(task.id, observation);
  probe.acceptBookshelf(task.id, { books: [{ id: '100', title: 'Fixture book', url: 'https://www.qidian.com/book/100/' }], strategy: 'table', anchorCount: 1, truncated: false, pagination: 'not-detected', containerHints: [] });
  task = probe.nextTask()!; probe.accept(task.id, { ...observation, pageKind: 'book' });
  probe.acceptCatalog(task.id, { bookId: '100', offset: 0, total: count, declaredCount: null, truncated: false, strategy: 'catalog-container', chapters: Array.from({ length: count }, (_, i) => ({ id: String(i + 1), title: `Fixture chapter ${i + 1}`, volume: '', payment: 'paid', url: `https://www.qidian.com/chapter/100/${i + 1}/` })) });
  task = probe.nextTask()!; assert.equal(task.kind, 'chapter');
  return { probe, task };
}
test('unified chapter pipeline accepts ordered chunks regardless of price; summaries omit body', () => {
  const { probe, task } = session(); const batch = { status: 'available', offset: 0, total: 6, text: '正文甲' };
  assert.equal(probe.acceptChapter(task.id, batch), 'invalid');
  probe.accept(task.id, { ...observation, pageKind: 'chapter', bookLinks: 0 });
  assert.equal(probe.acceptChapter(task.id, { ...batch, offset: 3 }), 'invalid');
  assert.equal(probe.acceptChapter(task.id, batch), 'accepted'); assert.equal(probe.acceptChapter(task.id, batch), 'accepted');
  assert.equal(probe.acceptChapter(task.id, { ...batch, offset: 3, text: '正文乙' }), 'accepted');
  assert.equal(probe.getChapter()?.status, 'available'); assert.ok(!JSON.stringify(probe.snapshot()).includes('正文甲'));
  assert.equal(probe.snapshot().chapterSummary?.characters, 6);
});

test('next chapter commits position only after success, retains current text on failure, and retries same neighbor', () => {
  const { probe, task } = session(2);
  const complete = (id: string, text: string) => {
    probe.accept(id, { ...observation, pageKind: 'chapter' });
    assert.equal(probe.acceptChapter(id, { status: 'available', offset: 0, total: text.length, text }), 'accepted');
  };
  assert.equal(probe.startNextChapter(), 'busy');
  complete(task.id, '第一章正文');
  assert.equal(probe.snapshot().chapterNavigation.current, 1);
  assert.equal(probe.startNextChapter(), 'started');
  const second = probe.nextTask()!; assert.equal(second.url, 'https://www.qidian.com/chapter/100/2/');
  assert.equal(probe.startNextChapter(), 'busy');
  assert.equal(probe.acceptChapter(task.id, { status: 'unavailable', reason: 'locked' }), 'stale');
  probe.acceptChapter(second.id, { status: 'unavailable', reason: 'locked' });
  assert.equal(probe.snapshot().chapterNavigation.current, 1); assert.equal(probe.getReadingChapter()?.text, '第一章正文');
  assert.equal(probe.startNextChapter(), 'started'); const retry = probe.nextTask()!;
  assert.equal(retry.url, second.url); assert.notEqual(retry.id, second.id);
  complete(retry.id, '第二章正文');
  assert.equal(probe.snapshot().chapterNavigation.current, 2); assert.equal(probe.getReadingChapter()?.text, '第二章正文');
  assert.equal(probe.startNextChapter(), 'end'); assert.equal(probe.nextTask(), null);
  assert.equal(new QidianAccessProbe().startNextChapter(), 'busy');
  const empty = session(); empty.probe.acceptChapter(empty.task.id, { status: 'unavailable', reason: 'locked' }); assert.equal(empty.probe.startNextChapter(), 'not-ready');
});
test('login, challenge, explicit unavailable and navigation timeout all produce reminders', () => {
  for (const state of ['NeedsLogin', 'AccessBlocked']) { const { probe, task } = session(); probe.accept(task.id, { ...observation, pageKind: state === 'NeedsLogin' ? 'login' : 'chapter', state, captchaFrame: state === 'AccessBlocked' }); assert.equal(probe.getChapter()?.status, 'unavailable'); }
  const { probe, task } = session(); assert.equal(probe.acceptChapter(task.id, { status: 'unavailable', reason: 'locked' }), 'accepted'); assert.equal(probe.snapshot().phase, 'chapter-unavailable');
  const other = session(); assert.ok(other.probe.expireChapter(Date.now() + 91000)); assert.deepEqual(other.probe.getChapter(), { status: 'unavailable', reason: 'timeout' });
});
test('chapter contract rejects oversized chunks and unexpected fields; preview escapes content', () => {
  assert.equal(parseChapterBatch({ status: 'available', offset: 0, total: 2001, text: 'x'.repeat(2001) }), undefined);
  assert.equal(parseChapterBatch({ status: 'unavailable', reason: 'locked', cookie: 'unexpected' }), undefined);
  assert.equal(parseChapterBatch({ status: 'available', offset: 1, total: 1, text: 'x' }), undefined);
  assert.ok(chapterPreview({ status: 'available', title: '<title>', text: '<script>x</script>' }).includes('&lt;script&gt;'));
});

test('structural diagnostics expose container labels only and reject raw page fields', () => {
  const context: Record<string, any> = {}; runInNewContext(source, context);
  const { document } = parseHTML(`<html><body><section class="reader"><div id="chapter-body"><p>${'Fixture private content '.repeat(8)}</p></div></section></body></html>`);
  const diagnostic = context.IdlePageChapter.diagnose(document);
  assert.equal(diagnostic.paragraphs, 1); assert.ok(diagnostic.containers.includes('div#chapter-body'));
  assert.ok(!JSON.stringify(diagnostic).includes('Fixture private'));
  const { probe, task } = session();
  assert.equal(probe.acceptChapterDiagnostics(task.id, diagnostic), 'accepted');
  assert.equal(probe.acceptChapterDiagnostics(task.id, { ...diagnostic, text: 'not allowed' }), 'invalid');
  assert.equal(probe.acceptChapterDiagnostics(task.id, { paragraphs: 1, containers: ['div[data-account=x]'] }), 'invalid');
});
