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
async function harness(t: { after(fn: () => Promise<void>): void }, online = true) {
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
      async get(key: string) { return { [key]: structuredClone(data[key]) }; },
      async set(values: Record<string, unknown>) { Object.assign(data, structuredClone(values)); },
    } },
    tabs: {
      async create(options: { url: string; active: boolean }) { const tab = { id: tabs.length + 1, ...options }; tabs.push(tab); return tab; },
      async get(id: number) { if (closed.has(id)) throw new Error('closed'); return tabs.find(tab => tab.id === id); },
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
  const context: Record<string, any> = { endpoint: bridge.endpoint(), token, chrome, URL, AbortSignal,
    fetch: async (url: string, options: RequestInit) => {
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
  const poll = () => context.__pollForTest();
  return { data, tabs, updates, emit, emitShelf, poll, network, closed, probe };
}
test('production companion and real HTTP server complete tasks without extraction clicks', async t => {
  const h = await harness(t);
  assert.equal(h.tabs[0].url, 'https://www.qidian.com/');
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
  h.closed.add(h.data.activeTask.tabId); await h.poll();
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
  assert.equal(h.updates.length, 1);
  assert.equal(h.tabs.length, 1);
  h.closed.add(h.data.activeTask.tabId); await h.poll();
  await until(() => h.data.connection === 'connected');
  assert.equal(h.data.report.state, 'AccessBlocked');
  assert.equal(h.probe.nextTask()?.kind, 'access');
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