import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { parseBookshelfPage } from '../../src/domain/bookshelf';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
import { bookshelfPreview } from '../../src/ui/bookshelfPreview';
const source = await readFile(new URL('../../browser-extension/bookshelf.js', import.meta.url), 'utf8');
function extract(html: string, hostname = 'my.qidian.com') {
  const context: Record<string, any> = { URL, TextEncoder };
  runInNewContext(source, context);
  const { document } = parseHTML(html);
  return parseBookshelfPage(context.IdlePageBookshelf.extract(document, { hostname, pathname: '/bookcase/', href: `https://${hostname}/bookcase/` }));
}
const visible = { state: 'SiteContentVisible', pageKind: 'bookshelf', bodyCharacters: 1500, bookLinks: 2, verification: false, tooFrequent: false, captchaFrame: false };
test('DOM extraction scopes to bookshelf table, deduplicates covers and excludes recommendations', () => {
  const page = extract(`<html><body><table><thead><tr><th>书名</th><th>最新更新</th></tr></thead><tbody><tr><td><a href="https://book.qidian.com/info/123/?from=test"><img></a><a href="https://www.qidian.com/book/123/">测试 书甲</a></td></tr><tr><td><a href="https://book.qidian.com/info/456/">测试书乙</a></td></tr></tbody></table><aside><a href="https://www.qidian.com/book/999/">推荐书</a></aside></body></html>`)!;
  assert.equal(page.strategy, 'table');
  assert.equal(page.books.length, 2);
  assert.equal(page.books[0].title, '测试 书甲');
  assert.equal(page.books[0].url, 'https://www.qidian.com/book/123/');
  assert.equal(page.anchorCount, 3);
  assert.ok(!page.books.some(b => b.id === '999'));
});
test('unknown DOM remains unconfirmed and extractor never runs on other hosts', () => {
  const html = '<html><body><div class="unknown"><a href="https://www.qidian.com/book/123/">测试书</a></div></body></html>';
  assert.equal(extract(html)?.strategy, 'unconfirmed');
  assert.equal(extract(html, 'www.qidian.com'), undefined);
});
test('page contract rejects mismatched IDs, unsafe URLs, duplicate IDs and account fields', () => {
  const page = extract('<html><body><div id="bookcaseList"><a href="https://www.qidian.com/book/123/">测试书</a></div></body></html>')!;
  assert.equal(page.strategy, 'known-container');
  for (const value of [
    { ...page, cookie: 'unexpected' },
    { ...page, books: [{ ...page.books[0], url: 'https://evil.example/book/123/' }] },
    { ...page, books: [{ ...page.books[0], url: 'https://www.qidian.com/book/456/' }] },
    { ...page, books: [{ ...page.books[0], url: 'https://www.qidian.com/book/123/?token=x' }] },
    { ...page, books: [page.books[0], page.books[0]] },
  ]) assert.equal(parseBookshelfPage(value), undefined);
});
test('blocked page cannot submit a book list; summaries never expose book names', () => {
  const probe = new QidianAccessProbe(); probe.startBookshelfExtraction();
  let task = probe.nextTask()!;
  const page = extract('<html><body><div id="bookcaseList"><a href="https://www.qidian.com/book/123/">测试书</a></div></body></html>')!;
  assert.equal(probe.acceptBookshelf(task.id, page), 'invalid');
  probe.accept(task.id, { ...visible, captchaFrame: true });
  assert.equal(probe.acceptBookshelf(task.id, page), 'stale');
  assert.equal(probe.nextTask(), null);
  probe.startBookshelfExtraction(); task = probe.nextTask()!;
  probe.accept(task.id, visible);
  assert.equal(probe.acceptBookshelf(task.id, page), 'accepted');
  assert.equal(probe.snapshot().phase, 'bookshelf-page-ready');
  assert.equal(probe.getBookshelf()?.books[0].title, '测试书');
  assert.ok(!JSON.stringify(probe.snapshot()).includes('测试书'));
  assert.equal(probe.acceptBookshelf(task.id, page), 'stale');
  const copy = probe.getBookshelf()!; copy.books[0].title = 'changed';
  assert.equal(probe.getBookshelf()?.books[0].title, '测试书');
});
test('preview escapes untrusted titles and disables scripts and network resources', () => {
  const page = extract('<html><body><div id="bookcaseList"><a href="https://www.qidian.com/book/123/">&lt;script&gt;test&lt;/script&gt;</a></div></body></html>')!;
  const html = bookshelfPreview(page);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes("default-src 'none'"));
});
test('oversized page is explicitly truncated within the bridge payload budget', () => {
  const links = Array.from({ length: 110 }, (_, index) => `<a href="https://www.qidian.com/book/${index + 1000}/">${'测试'.repeat(50)}${index}</a>`).join('');
  const page = extract(`<html><body><div id="bookcaseList">${links}</div></body></html>`)!;
  assert.ok(page.truncated);
  assert.ok(page.books.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 12000);
});