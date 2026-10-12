import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('./browser-companion/worker.js', import.meta.url), 'utf8');
function harness() {
  const data = {};
  const tabs = [];
  const events = {};
  const updates = [];
  const chrome = {
    storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); },
      async set(values) { Object.assign(data, structuredClone(values)); },
      async clear() { for (const key of Object.keys(data)) delete data[key]; },
    } },
    tabs: {
      async create(options) { const tab = { id: tabs.length + 1, ...options }; tabs.push(tab); return tab; },
      async get(id) { const tab = tabs.find(t => t.id === id); if (!tab) throw new Error('closed'); return tab; },
      async update(id, options) { updates.push({ id, ...options }); },
    },
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      onMessage: { addListener: fn => { events.message = fn; } },
      onInstalled: { addListener: fn => { events.installed = fn; } },
      onStartup: { addListener: fn => { events.startup = fn; } },
    },
  };
  runInNewContext(source, { chrome, URL, Date });
  const report = overrides => ({ state: 'SiteContentVisible', pageKind: 'other', bodyCharacters: 1000, bookLinks: 4, verification: false, tooFrequent: false, captchaFrame: false, ...overrides });
  async function start() {
    events.installed();
    for (let tries = 0; tries < 20 && !data.activeTask; tries++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(data.activeTask.kind, 'access');
  }
  async function emit(overrides = {}, senderOverride = {}) {
    const sender = { frameId: 0, url: 'https://www.qidian.com/', tab: { id: data.activeTask.tabId }, ...senderOverride };
    return new Promise(resolve => {
      const result = events.message({ type: 'idlepage-observation', report: report(overrides) }, sender, resolve);
      if (result !== true) resolve({ ignored: true });
    });
  }
  return { data, tabs, updates, start, emit };
}

test('loads homepage and then bookshelf automatically without extraction clicks', async () => {
  const h = harness(); await h.start();
  assert.equal(h.tabs.at(-1).url, 'https://www.qidian.com/');
  await h.emit();
  assert.equal(h.tabs.at(-1).url, 'https://my.qidian.com/bookcase/');
  assert.equal(h.tabs.at(-1).active, false);
  await h.emit({ pageKind: 'bookshelf' }, { url: 'https://my.qidian.com/bookcase/' });
  assert.equal(h.data.phase, 'probe-complete');
  assert.equal(h.data.activeTask, null);
});

test('verification blocks navigation and does not trigger repeated page loads or focus changes', async () => {
  const h = harness(); await h.start();
  const count = h.tabs.length;
  await h.emit({ captchaFrame: true });
  await h.emit({ captchaFrame: true });
  assert.equal(h.data.report.state, 'AccessBlocked');
  assert.equal(h.tabs.length, count);
  assert.equal(h.updates.length, 1);
  await h.emit();
  assert.equal(h.data.activeTask.kind, 'bookshelf');
});

test('ignores foreign origins, subframes and malformed counts', async () => {
  const h = harness(); await h.start();
  const count = h.tabs.length;
  await h.emit({}, { url: 'https://qidian.com.evil.example/' });
  await h.emit({}, { frameId: 1 });
  assert.equal((await h.emit({ bookLinks: -1 })).accepted, false);
  assert.equal(h.tabs.length, count);
  assert.equal(h.data.report, undefined);
});

test('ignores stale reports from a previous task tab', async () => {
  const h = harness(); await h.start();
  const previousTab = h.data.activeTask.tabId;
  await h.emit();
  const count = h.tabs.length;
  assert.equal((await h.emit({}, { tab: { id: previousTab } })).ignored, true);
  assert.equal(h.tabs.length, count);
});
