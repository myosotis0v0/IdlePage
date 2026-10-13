import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
import type { CatalogResult } from '../../src/domain/catalog';
const catalog = (bookId: string): CatalogResult => ({ bookId, total: 2, declaredCount: 2, strategy: 'catalog-container', truncated: false,
  chapters: [1, 2].map(id => ({ id: String(id), title: 'Fixture', url: `https://www.qidian.com/chapter/${bookId}/${id}/`, volume: 'Volume', payment: 'unknown' })) });
const shelf = { books: ['100', '200'].map(id => ({ id, title: 'Fixture', url: `https://www.qidian.com/book/${id}/` })), strategy: 'table' as const, anchorCount: 2, truncated: false, pagination: 'not-detected' as const, containerHints: [] };
test('select any shelf book and chapter by identity; switching books rejects old results and keeps current reading', () => {
  const probe = new QidianAccessProbe(); probe.restoreMetadata(shelf);
  assert.equal(probe.selectBook('999'), false);
  assert.equal(probe.selectBook('200', catalog('200')), true); assert.equal(probe.nextTask(), null);
  assert.equal(probe.selectChapter('100', '2'), false); assert.equal(probe.selectChapter('200', '2'), true);
  const task = probe.nextTask()!; assert.equal(task.url, 'https://www.qidian.com/chapter/200/2/');
  probe.accept(task.id, { state: 'SiteContentVisible', pageKind: 'chapter', bodyCharacters: 1000, bookLinks: 0, verification: false, tooFrequent: false, captchaFrame: false });
  probe.acceptChapter(task.id, { status: 'available', offset: 0, total: 4, text: 'body' });
  assert.deepEqual(probe.readingLocation(), { bookId: '200', chapterId: '2' });
  probe.selectBook('100'); const old = probe.nextTask()!;
  probe.selectBook('200', catalog('200'));
  assert.equal(probe.acceptCatalog(old.id, { ...catalog('100'), offset: 0 }), 'stale');
  assert.equal(probe.getReadingChapter()?.text, 'body');
  assert.equal(probe.getCatalog()?.bookId, '200');
});
test('fresh shelf request invalidates outstanding work and accepts a confirmed empty shelf', () => {
  const probe = new QidianAccessProbe(); probe.restoreMetadata(shelf); probe.selectBook('100'); const task = probe.nextTask()!;
  probe.invalidateTask(); assert.equal(probe.nextTask(), null); assert.equal(probe.snapshot().failure, undefined);
  probe.startBookshelfExtraction(); assert.equal(probe.acceptCatalog(task.id, {}), 'stale');
  const fresh = probe.nextTask()!;
  probe.accept(fresh.id, { state: 'SiteContentVisible', pageKind: 'bookshelf', bodyCharacters: 20, bookLinks: 0, verification: false, tooFrequent: false, captchaFrame: false, loginEvidence: 'signed-in-control' });
  assert.equal(probe.acceptBookshelf(fresh.id, { ...shelf, books: [], anchorCount: 0 }), 'accepted');
  assert.equal(probe.getBookshelf()?.books.length, 0); assert.equal(probe.nextTask(), null);
});
