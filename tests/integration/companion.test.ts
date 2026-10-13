import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { LocalBridgeServer } from '../../src/infrastructure/local-bridge/LocalBridgeServer';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
const token = 'b'.repeat(64);
const origin = 'chrome-extension://' + 'b'.repeat(32);
const source = (await readFile(new URL('../../browser-extension/worker.js', import.meta.url), 'utf8')).replace(/^import .*\r?\n/, '');
const visible = { state: 'SiteContentVisible', pageKind: 'other', bodyCharacters: 1500, bookLinks: 3, verification: false, tooFrequent: false, captchaFrame: false };
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), 'companion reached expected state');
}
async function harness(t: { after(fn: () => Promise<void>): void }, online = true, staleImport = false) {
  const data: Record<string, any> = {};
  const tabs: Array<{ id: number; url: string; active: boolean }> = [];
  const closed = new Set<number>();
  const updates: unknown[] = [];
  const events: Record<string, (...args: any[]) => any> = {};
  const probe = new QidianAccessProbe();
  const bridge = new LocalBridgeServer({ port: 0, token, origin, probe });
  await bridge.start(); t.after(() => bridge.close());
  const network = { online, wrongToken: false };
  const chrome = {
    storage: { local: {
      async get(key: string | string[]) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(data[k])])); },
      async set(values: Record<string, unknown>) { Object.assign(data, structuredClone(values)); },
    } },
    tabs: {
      async create(options: { url: string; active: boolean }) { const tab = { id: tabs.length + 1, ...options }; tabs.push(tab); return tab; },
      async get(id: number) { const tab = tabs.find(tab => tab.id === id); if (closed.has(id) || !tab) throw new Error('closed'); return tab; },
      async remove(id: number) { closed.add(id); },
      async update(id: number, options: unknown) { updates.push({ id, options }); },
    },
    runtime: {
      getURL: (path: string) => origin + '/' + path,
      onMessage: { addListener: (fn: (...args: any[]) => any) => { events.message = fn; } },
      onInstalled: { addListener: (fn: (...args: any[]) => any) => { events.installed = fn; } },
      onStartup: { addListener: (fn: (...args: any[]) => any) => { events.startup = fn; } },
    },
    alarms: {
      async create() {},
      onAlarm: { addListener: (fn: (...args: any[]) => any) => { events.alarm = fn; } },
    },
  };
  const context: Record<string, any> = { endpoint: bridge.endpoint(), token: staleImport ? 'd'.repeat(64) : token, chrome, URL, AbortSignal, setTimeout,
    fetch: async (url: string, options: RequestInit) => {
      if (url === origin + '/pairing.json') return { ok: true, json: async () => ({ endpoint: bridge.endpoint(), token }) };
      if (!network.online) throw new Error('offline');
      // Chromium privileged GET omits Origin; POST attaches the extension Origin.
      return fetch(url, { ...options, headers: { ...options.headers, ...(options.method === 'POST' ? { Origin: origin } : {}), ...(network.wrongToken ? { Authorization: 'Bearer wrong' } : {}) } });
    },
  };
  runInNewContext(source + '\nglobalThis.__pollForTest = poll;', context);
  await until(() => online ? !!data.activeTask : data.connection === 'disconnected');
  const emit = (report = visible, override: Record<string, unknown> = {}) => new Promise<any>(resolve => {
    const sender = { frameId: 0, url: 'https://www.qidian.com/', tab: { id: data.activeTask?.tabId }, ...override };
    if (events.message({ type: 'idlepage-observation', report }, sender, resolve) !== true) resolve({ ignored: true });
  });
  const emitShelf = (page: unknown) => new Promise<any>(resolve => {
    if (events.message({ type: 'idlepage-bookshelf', page }, { frameId: 0, url: 'https://my.qidian.com/bookcase/', tab: { id: data.activeTask?.tabId } }, resolve) !== true) resolve({ ignored: true });
  });
  const emitCatalog = (batch: unknown, url = 'https://www.qidian.com/book/100/') => new Promise<any>(resolve => {
    if (events.message({ type: 'idlepage-catalog', batch }, { frameId: 0, url, tab: { id: data.activeTask?.tabId } }, resolve) !== true) resolve({ ignored: true });
  });
  const poll = () => context.__pollForTest();
  const emitChapter = (batch: unknown, url = 'https://www.qidian.com/chapter/100/1/') => new Promise<any>(resolve => {
    if (events.message({ type: 'idlepage-chapter', batch }, { frameId: 0, url, tab: { id: data.activeTask?.tabId } }, resolve) !== true) resolve({ ignored: true });
  });
  const emitChapterDiagnostics = (batch: unknown) => new Promise<any>(resolve => {
    if (events.message({ type: 'idlepage-chapter-diagnostics', batch }, { frameId: 0, url: 'https://www.qidian.com/chapter/100/1/', tab: { id: data.activeTask?.tabId } }, resolve) !== true) resolve({ ignored: true });
  });
  const wake = () => new Promise<any>(resolve => { events.message({ type: 'idlepage-connect' }, { url: origin + '/status.html' }, resolve); });
  return { data, tabs, updates, emit, emitShelf, emitCatalog, emitChapter, emitChapterDiagnostics, wake, poll, network, closed, probe };
}
test('production companion and real HTTP server complete tasks without extraction clicks', async t => {
  const h = await harness(t);
  assert.equal(h.tabs[0].url, 'https://www.qidian.com/');
  assert.equal(h.tabs[0].active, false);
  const previous = h.data.activeTask.tabId;
  await Promise.all([h.emit(), h.emit()]);
  assert.equal(h.tabs.length, 2);
  assert.equal(h.tabs[1].url, 'https://my.qidian.com/bookcase/');
  assert.equal((await h.emit(visible, { tab: { id: previous } })).ignored, true);
  await h.emit({ ...visible, pageKind: 'bookshelf' }, { url: 'https://my.qidian.com/bookcase/' });
  assert.equal(h.data.phase, 'probe-complete');
  assert.equal(h.data.activeTask, null);
  assert.equal(h.probe.snapshot().phase, 'probe-complete');
});
test('offline polling reconnects and closed task tab recovers automatically', async t => {
  const h = await harness(t, false);
  assert.equal(h.tabs.length, 0);
  assert.equal(h.data.connectionError, 'BridgeNetworkError');
  h.network.online = true; await h.poll();
  await until(() => !!h.data.activeTask);
  assert.equal(h.data.connectionError, null);
  const id = h.data.activeTask.id;
  h.closed.add(h.tabs[0].id); await h.poll();
  await until(() => h.tabs.length === 2);
  assert.equal(h.data.activeTask.id, id);
  h.probe.restart(); await h.poll();
  await until(() => h.data.activeTask.id !== id);
});
test('challenge does not reload site or repeatedly focus; rejects foreign senders', async t => {
  const h = await harness(t);
  assert.equal((await h.emit(visible, { url: 'https://qidian.com.evil.example/' })).ignored, true);
  assert.equal((await h.emit(visible, { frameId: 1 })).ignored, true);
  assert.equal((await h.emit({ ...visible, bookLinks: -1 })).accepted, false);
  await h.emit({ ...visible, captchaFrame: true });
  await h.emit({ ...visible, captchaFrame: true });
  assert.equal(h.updates.length, 0);
  assert.equal(h.tabs.length, 1);
  h.closed.add(h.tabs.at(-1)!.id); await h.poll();
  await until(() => h.data.connection === 'connected');
  assert.equal(h.data.report.state, 'AccessBlocked');
  assert.equal(h.probe.nextTask(), null);
  assert.equal(h.tabs.length, 1);
});
test('authentication errors are visible and cleared on successful reconnection', async t => {
  const h = await harness(t);
  h.network.wrongToken = true;
  await h.poll();
  assert.equal(h.data.connection, 'disconnected');
  assert.equal(h.data.connectionError, 'BridgeStatus401');
  assert.equal(h.tabs.length, 1);
  h.network.wrongToken = false;
  await h.poll();
  assert.equal(h.data.connection, 'connected');
  assert.equal(h.data.connectionError, null);
  assert.equal(h.tabs.length, 1);
});

test('only a login requirement activates the task tab and does so once', async t => {
  const h = await harness(t);
  await h.emit({ ...visible, state: 'NeedsLogin', pageKind: 'login' });
  await h.emit({ ...visible, state: 'NeedsLogin', pageKind: 'login' });
  assert.equal(h.updates.length, 0);
  assert.equal(h.tabs.length, 2);
  assert.equal(h.tabs[1].active, true); assert.equal(h.data.activeTask.kind, 'login');
});

test('login proof resumes the original task once and cancellation discards late browser messages', async t => {
  const h = await harness(t); h.probe.startBookshelfExtraction(); await h.poll();
  const original = h.data.activeTask.id;
  await h.emit({ ...visible, state: 'NeedsLogin', pageKind: 'login' });
  const loginId = h.data.activeTask.id; assert.equal(h.data.activeTask.kind, 'login');
  await h.emit({ ...visible, pageKind: 'bookshelf' }, { url: 'https://my.qidian.com/bookcase/' });
  assert.equal(h.data.activeTask.id, loginId);
  await h.emit({ ...visible, pageKind: 'bookshelf', loginEvidence: 'bookshelf-content' } as any, { url: 'https://my.qidian.com/bookcase/' });
  assert.equal(h.data.activeTask.kind, 'bookshelf-list'); assert.notEqual(h.data.activeTask.id, original);
  assert.equal(h.tabs.filter(tab => !h.closed.has(tab.id)).length, 2);
  const tabId = h.data.activeTask.tabId; h.probe.cancel(); await h.poll();
  assert.equal(h.data.activeTask, null); assert.equal(h.tabs.filter(tab => !h.closed.has(tab.id)).length, 1);
  assert.equal((await h.emit(visible, { tab: { id: tabId } })).ignored, true);
});

test('worker reads fresh pairing data despite a stale imported module and reconnects from its own page', async t => {
  const h = await harness(t, true, true);
  assert.equal(h.data.connection, 'connected');
  await h.emit(); assert.equal(h.data.activeTask.kind, 'bookshelf');
  const count = h.tabs.length; assert.equal((await h.wake()).accepted, true); assert.equal(h.tabs.length, count);
});
test('bookshelf task transfers structured books while browser storage keeps only summary', async t => {
  const h = await harness(t);
  h.probe.startBookshelfExtraction(); await h.poll();
  assert.equal(h.data.activeTask.kind, 'bookshelf-list');
  const page = { books: [{ id: '123', title: 'Fixture book', url: 'https://www.qidian.com/book/123/' }], strategy: 'table', anchorCount: 1, truncated: false, pagination: 'not-detected', containerHints: ['table'] };
  assert.equal((await h.emitShelf(page)).accepted, false);
  const observation = await h.emit({ ...visible, pageKind: 'bookshelf' }, { url: 'https://my.qidian.com/bookcase/' });
  assert.equal(observation.bookshelfRequested, true);
  assert.equal((await h.emitShelf(page)).accepted, true);
  assert.equal(h.data.phase, 'bookshelf-page-ready');
  assert.equal(h.data.bookshelfSummary.count, 1);
  assert.ok(!JSON.stringify(h.data).includes('Fixture book'));
  assert.equal(h.probe.getBookshelf()?.books[0].id, '123');
});
test('catalog pipeline selects first shelf book, receives ordered batches, and rejects another book page', async t => {
  const h = await harness(t); h.probe.startCatalogExtraction(); await h.poll();
  await h.emit({ ...visible, pageKind: 'bookshelf' }, { url: 'https://my.qidian.com/bookcase/' });
  await h.emitShelf({ books: [{ id: '100', title: 'Fixture book', url: 'https://www.qidian.com/book/100/' }], strategy: 'table', anchorCount: 1, truncated: false, pagination: 'not-detected', containerHints: ['table'] });
  assert.equal(h.data.activeTask.kind, 'catalog');
  assert.equal(h.tabs.at(-1)?.url, 'https://www.qidian.com/book/100/#Catalog');
  const ready = await h.emit({ ...visible, pageKind: 'book', bookLinks: 0 }, { url: 'https://www.qidian.com/book/100/' });
  assert.equal(ready.catalogRequested, true);
  const chapter = (id: string) => ({ id, title: 'Fixture chapter', url: `https://www.qidian.com/chapter/100/${id}/`, volume: 'Fixture volume', payment: 'unknown' });
  const batch = { bookId: '100', offset: 0, total: 2, declaredCount: null, truncated: false, strategy: 'catalog-container', chapters: [chapter('1')] };
  assert.equal((await h.emitCatalog(batch, 'https://www.qidian.com/book/200/')).ignored, true);
  assert.equal((await h.emitCatalog(batch)).accepted, true);
  assert.equal(h.data.catalogSummary.count, 1);
  assert.equal((await h.emitCatalog({ ...batch, offset: 1, chapters: [chapter('2')] })).accepted, true);
  assert.equal(h.data.phase, 'catalog-preview-ready');
  assert.equal(h.data.catalogSummary.count, 2);
  assert.ok(!JSON.stringify(h.data).includes('Fixture chapter'));
});

test('chapter task navigates to selected catalog URL and transfers only sanitized summary to browser storage', async t => {
  const h = await harness(t); h.probe.startChapterExtraction(); await h.poll();
  await h.emit({ ...visible, pageKind: 'bookshelf' }, { url: 'https://my.qidian.com/bookcase/' });
  await h.emitShelf({ books: [{ id: '100', title: 'Fixture book', url: 'https://www.qidian.com/book/100/' }], strategy: 'table', anchorCount: 1, truncated: false, pagination: 'not-detected', containerHints: [] });
  await h.emit({ ...visible, pageKind: 'book' }, { url: 'https://www.qidian.com/book/100/' });
  await h.emitCatalog({ bookId: '100', offset: 0, total: 1, declaredCount: null, truncated: false, strategy: 'catalog-container', chapters: [{ id: '1', title: 'Fixture chapter', volume: '', payment: 'unknown', url: 'https://www.qidian.com/chapter/100/1/' }] });
  assert.equal(h.data.activeTask.kind, 'chapter'); assert.equal(h.tabs.at(-1)?.url, 'https://www.qidian.com/chapter/100/1/');
  const ack = await h.emit({ ...visible, pageKind: 'chapter', bookLinks: 0 }, { url: 'https://www.qidian.com/chapter/100/1/' }); assert.equal(ack.chapterRequested, true);
  assert.equal((await h.emitChapterDiagnostics({ paragraphs: 3, containers: ['div.read-content'] })).accepted, true);
  assert.equal(h.probe.snapshot().chapterDiagnostics?.paragraphs, 3);
  const batch = { status: 'available', offset: 0, total: 16, text: 'Fixture body abc' };
  assert.equal((await h.emitChapter(batch, 'https://www.qidian.com/chapter/100/2/')).ignored, true);
  assert.equal((await h.emitChapter(batch)).accepted, true);
  assert.equal(h.data.phase, 'chapter-preview-ready'); assert.equal(h.data.chapterSummary.characters, 16);
  assert.ok(!JSON.stringify(h.data).includes('Fixture body'));
});

test('managed chapter tabs stay at one after success, two in transit, and restore the old tab on failure', async t => {
  const h = await harness(t);
  h.probe.restoreMetadata({ books: [{ id: '100', title: 'Fixture', url: 'https://www.qidian.com/book/100/' }], strategy: 'table', anchorCount: 1, truncated: false, pagination: 'not-detected', containerHints: [] },
    { bookId: '100', total: 3, declaredCount: 3, truncated: false, strategy: 'catalog-container', chapters: [1, 2, 3].map(id => ({ id: String(id), title: 'Fixture', volume: '', payment: 'unknown', url: `https://www.qidian.com/chapter/100/${id}/` })) });
  const count = () => h.tabs.filter(tab => !h.closed.has(tab.id)).length;
  h.probe.startChapterExtraction(); await h.poll(); assert.equal(count(), 2);
  const complete = async (id: number) => {
    const url = `https://www.qidian.com/chapter/100/${id}/`;
    await h.emit({ ...visible, pageKind: 'chapter' }, { url });
    await h.emitChapter({ status: 'available', offset: 0, total: 4, text: 'body' }, url);
  };
  await complete(1); assert.equal(count(), 1);
  h.probe.startNextChapter(); await h.poll(); assert.equal(count(), 2);
  await complete(2); assert.equal(count(), 1); const old = h.data.managedTabs.current.id;
  h.probe.startNextChapter(); await h.poll(); assert.equal(count(), 2);
  await h.emitChapter({ status: 'unavailable', reason: 'locked' }, 'https://www.qidian.com/chapter/100/3/');
  assert.equal(count(), 1); assert.equal(h.data.managedTabs.current.id, old);
  assert.equal(h.probe.snapshot().chapterNavigation.current, 2);
  h.probe.startNextChapter(); await h.poll(); assert.equal(count(), 2);
  h.probe.expireChapter(Date.now() + 100000); await h.poll();
  assert.equal(count(), 1); assert.equal(h.data.managedTabs.current.id, old);
  // A user-owned navigation is not closed when the next managed chapter succeeds.
  h.tabs.find(tab => tab.id === old)!.url = 'https://example.com/';
  h.probe.startNextChapter(); await h.poll(); await complete(3);
  assert.equal(h.closed.has(old), false); assert.equal(h.data.taskTabSummary.count, 1);
});

test('switching to cached book retires reading tabs but retains bookshelf without creating tabs', async t => {
  const h = await harness(t);
  await h.emit();
  const shelfTab = h.data.activeTask.tabId;
  await h.emit({ ...visible, pageKind: 'bookshelf' }, { url: 'https://my.qidian.com/bookcase/' });
  const shelf = { books: ['100', '200'].map(id => ({ id, title: 'Fixture', url: `https://www.qidian.com/book/${id}/` })), strategy: 'table' as const, anchorCount: 2, truncated: false, pagination: 'not-detected' as const, containerHints: [] };
  const catalog = (id: string) => ({ bookId: id, total: 1, declaredCount: 1, truncated: false, strategy: 'catalog-container' as const, chapters: [{ id: '1', title: 'Fixture', volume: '', payment: 'unknown' as const, url: `https://www.qidian.com/chapter/${id}/1/` }] });
  h.probe.restoreMetadata(shelf, catalog('100'));
  h.probe.selectBook('100', catalog('100')); await h.poll();
  assert.equal(h.closed.has(shelfTab), false);
  assert.equal(h.data.retainedShelf.id, shelfTab);
  h.probe.selectChapter('100', '1'); await h.poll();
  const chapterTab = h.data.activeTask.tabId;
  await h.emitChapter({ status: 'available', offset: 0, total: 4, text: 'body' });
  const created = h.tabs.length;
  h.probe.selectBook('200', catalog('200')); await h.poll();
  assert.equal(h.tabs.length, created);
  assert.equal(h.closed.has(chapterTab), true);
  assert.equal(h.closed.has(shelfTab), false);
  assert.equal(h.data.managedTabs, null);
  h.probe.selectChapter('200', '1'); await h.poll();
  assert.equal(h.tabs.at(-1)?.active, false);
  assert.equal(h.closed.has(shelfTab), false);
});

test('prefetch result leaves reading fixed and a failed page stays available without activating tabs', async t => {
  const h = await harness(t);
  h.probe.restoreMetadata({ books: [{ id: '100', title: 'Fixture', url: 'https://www.qidian.com/book/100/' }], strategy: 'table', anchorCount: 1, truncated: false, pagination: 'not-detected', containerHints: [] },
    { bookId: '100', total: 3, declaredCount: 3, truncated: false, strategy: 'catalog-container', chapters: [1, 2, 3].map(id => ({ id: String(id), title: 'Fixture', volume: '', payment: 'unknown', url: `https://www.qidian.com/chapter/100/${id}/` })) });
  h.probe.startChapterExtraction(); await h.poll();
  await h.emit({ ...visible, pageKind: 'chapter' }, { url: 'https://www.qidian.com/chapter/100/1/' });
  await h.emitChapter({ status: 'available', offset: 0, total: 4, text: 'body' });
  assert.equal(h.probe.startPrefetch(1), true); await h.poll();
  await h.emit({ ...visible, pageKind: 'chapter' }, { url: 'https://www.qidian.com/chapter/100/2/' });
  await h.emitChapter({ status: 'available', offset: 0, total: 4, text: 'body' }, 'https://www.qidian.com/chapter/100/2/');
  assert.equal(h.probe.readingLocation().chapterId, '1'); assert.equal(h.data.phase, 'prefetch-ready');
  assert.equal(h.probe.takePrefetchResult()?.chapter?.chapterId, '2');
  assert.equal(h.probe.startPrefetch(2), true); await h.poll(); const failedTab = h.data.activeTask.tabId;
  await h.emitChapter({ status: 'unavailable', reason: 'needs-login' }, 'https://www.qidian.com/chapter/100/3/');
  assert.equal(h.data.phase, 'prefetch-failed'); assert.equal(h.closed.has(failedTab), false);
  assert.equal(h.data.managedTabs.current.id, failedTab); assert.equal(h.data.managedTabs.previous, null);
  assert.ok(h.tabs.every(tab => !tab.active)); assert.equal(h.updates.length, 0);
  assert.equal(h.probe.readingLocation().chapterId, '1');
});
