import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { LocalBridgeServer } from '../../src/infrastructure/local-bridge/LocalBridgeServer';
import { RemoteChannel } from '../../src/infrastructure/local-bridge/RemoteChannel';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
import { RemoteClient, RemoteError } from '../../src/application/RemoteClient';
import { StudySession } from '../../src/application/StudySession';

const token = 'c'.repeat(64);
const extension = 'chrome-extension://' + 'c'.repeat(32);
const workerSource = (await readFile(new URL('../../browser-extension/remote.js', import.meta.url), 'utf8')).replace(/^export /m, '') + '\n' +
  (await readFile(new URL('../../browser-extension/worker.js', import.meta.url), 'utf8')).replace(/^import .*\r?\n/gm, '');
const until = async (check: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), 'reached expected state');
};

/** A minimal third-party idlepage/1 server: cookie login, same-origin writes, one card bank and one choice bank. */
async function site(t: { after(fn: () => Promise<void>): void }) {
  const submitted: unknown[] = [];
  let origin = '';
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const url = new URL(req.url!, origin);
    if (url.pathname === '/.well-known/idlepage.json') return send(200, { protocol: 'idlepage/1', name: '测试站', login: '/login?rd=%2F.well-known%2Fidlepage.json',
      logout: '/logout?rd=%2F.well-known%2Fidlepage.json', account: '/api/me', study: '/api/study/' });
    if (url.pathname === '/logout') { res.writeHead(200, { 'Set-Cookie': 'session=; Max-Age=0; Path=/', 'Content-Type': 'text/plain' }); res.end('bye'); return; }
    if (url.pathname === '/api/me') return /(?:^|; )session=ok/.test(req.headers.cookie ?? '') ? send(200, { id: 7, username: 'reader' }) : send(401, 'Unauthorized', 'text/plain');
    if (!url.pathname.startsWith('/api/study/')) return send(404, 'not found', 'text/plain');
    if (!/(?:^|; )session=ok/.test(req.headers.cookie ?? '')) return send(401, 'Unauthorized', 'text/plain');
    if (req.method !== 'GET' && req.headers.origin !== origin) return send(403, { error: '来源不被允许' });
    let body = ''; for await (const chunk of req) body += chunk;
    const path = url.pathname.slice('/api/study/'.length);
    if (path === 'banks') return send(200, { banks: [{ id: 'cards', title: '卡片', mode: 'srs', view: true }, { id: 'ear', title: '听音', mode: 'levels', view: true }] });
    if (path === 'banks/ear') return send(200, { units: [{ id: 'int', title: '音程', view: true }, { id: 'dict', title: '听写', view: false }] });
    if (path === 'banks/ear/progress') return send(200, { units: { int: { unlocked: true } }, summary: '今日 0 经验' });
    if (path === 'banks/ear/audio/q1') return send(200, Buffer.from('RIFF....WAVEdata'), 'audio/wav');
    if (path === 'banks/cards/next') {
      assert.equal(JSON.parse(body).view, true);
      return send(200, { lesson: { unit: null, set: null }, questions: [{ qid: 'w1', view: { prompt: '就任', answer: { type: 'self', back: 'しゅうにん', grades: [{ rating: 1, label: '不认识', again: true }, { rating: 3, label: '认识' }] } } }] });
    }
    if (path === 'banks/ear/next') return send(200, { lesson: { unit: 'int', level: 0 }, questions: [{ qid: 'q1', view: { prompt: '几度？', audio: [{ label: '再听', src: 'banks/ear/audio/q1' }], answer: { type: 'choice', choices: [{ id: '7', label: '纯五度' }], correct: '7' } } }] });
    if (/^banks\/\w+\/results$/.test(path)) { submitted.push(JSON.parse(body)); return send(200, { summary: `收到 ${JSON.parse(body).answers.length} 条` }); }
    return send(404, { error: '没有这个接口' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin, submitted };
}

async function harness(t: { after(fn: () => Promise<void>): void }, remotes: string[], granted?: string[]) {
  const channel = new RemoteChannel({ holdMs: 200 });
  channel.wanted = true;
  const bridge = new LocalBridgeServer({ port: 0, token, origin: extension, probe: new QidianAccessProbe(), remote: channel });
  await bridge.start();
  const tabs: Array<{ id: number; url: string; active: boolean; status: string }> = [];
  const jar = { cookie: '' };
  // Normal windows of the dedicated Edge; empty = process alive with every window closed.
  const windows: Array<{ id: number; focused: boolean; state?: string }> = [{ id: 1, focused: true }];
  let reloads = 0;
  const data: Record<string, any> = {};
  // Chromium serializes the injected function and runs it in the page; emulate that page.
  // The site's player page exposes window.idlepagePlayer; other pages do not.
  const player = { calls: [] as string[], result: true };
  const page = (url: string) => ({ location: new URL(url), URL, btoa, Uint8Array, String, setTimeout,
    window: url.endsWith('/player.html') ? { idlepagePlayer: { play: async (src: string) => { player.calls.push(src); return player.result; } } } : {},
    fetch: (path: string, init: RequestInit = {}) => {
      const target = new URL(path, url);
      const headers: Record<string, string> = { ...init.headers as Record<string, string>, cookie: jar.cookie };
      if (init.method && init.method !== 'GET') headers.origin = new URL(url).origin;
      // The page's cookie jar follows Set-Cookie, as the browser does for same-origin fetches.
      return fetch(target, { ...init, headers }).then(response => {
        if (/session=;/.test(response.headers.get('set-cookie') ?? '')) jar.cookie = '';
        return response;
      });
    } });
  const chrome = {
    storage: { local: {
      async get(key: string | string[]) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(data[k])])); },
      async set(values: Record<string, unknown>) { Object.assign(data, structuredClone(values)); },
    } },
    windows: {
      async getAll() { return structuredClone(windows); },
      async create(options: { url: string; focused: boolean; state?: string }) {
        const window = { id: windows.length + 1, focused: options.focused, state: options.state }; windows.push(window);
        const tab = { id: tabs.length + 1, status: 'complete', url: options.url, active: true }; tabs.push(tab);
        return { ...window, tabs: [tab] };
      },
    },
    tabs: {
      async create(options: { url: string; active: boolean; windowId?: number }) {
        if (!windows.some(w => w.id === options.windowId)) throw new Error('No current window');
        const tab = { id: tabs.length + 1, status: 'complete', url: options.url, active: options.active }; tabs.push(tab); return tab;
      },
      async get(id: number) { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('closed'); return tab; },
      async remove(id: number) { tabs.splice(tabs.findIndex(tab => tab.id === id), 1); },
      async update(id: number, options: { active?: boolean }) { Object.assign(tabs.find(tab => tab.id === id)!, options); },
    },
    scripting: { async executeScript({ target, func, args }: { target: { tabId: number }; func: (...a: unknown[]) => unknown; args: unknown[] }) {
      // Chromium rejects injection arguments that are not JSON values (e.g. undefined).
      if (JSON.stringify(args) !== JSON.stringify(JSON.parse(JSON.stringify(args))) || args.includes(undefined)) throw new Error('Error in invocation of scripting.executeScript');
      const tab = await chrome.tabs.get(target.tabId);
      const run = runInNewContext(`(${func.toString()})`, page(tab.url));
      return [{ result: await run(...args) }];
    } },
    runtime: {
      getURL: (path: string) => extension + '/' + path,
      getManifest: () => ({ host_permissions: granted ?? ['http://127.0.0.1/*'] }),
      reload: () => { reloads++; },
      async sendMessage() {},
      onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    },
    alarms: { async create() {}, onAlarm: { addListener() {} } },
  };
  const context = { endpoint: bridge.endpoint(), token, chrome, URL, AbortSignal, setTimeout, btoa,
    fetch: async (url: string, options: RequestInit) => {
      if (url === extension + '/pairing.json') return { ok: true, json: async () => ({ endpoint: bridge.endpoint(), token, remotes }) };
      return fetch(url, { ...options, headers: { ...options.headers, ...(options.method === 'POST' ? { Origin: extension } : {}) } });
    } };
  runInNewContext(workerSource, context);
  t.after(async () => { channel.dispose(); await bridge.close(); });
  return { channel, tabs, windows, jar, data, player, reloads: () => reloads };
}

test('a generic idlepage/1 server is used through the paired browser with its own login', async t => {
  const { origin, submitted } = await site(t);
  const h = await harness(t, [origin]);
  await until(() => h.channel.connected());
  const client = new RemoteClient((job, timeout) => h.channel.run(job, timeout), { origin, home: '/.well-known/idlepage.json' });
  assert.equal((await client.discover()).name, '测试站');
  const own = () => h.tabs.filter(tab => tab.url.startsWith(origin));
  assert.equal(own().length, 1, 'one background tab on the server origin');
  assert.equal(own()[0].active, false);

  // Not logged in: the API answers 401 inside the page, so the client asks for login.
  await assert.rejects(client.banks(), (e: RemoteError) => e.code === 'needs-login');
  await client.login();
  assert.equal(own().length, 2);
  const login = own()[1];
  assert.deepEqual([login.url, login.active], [origin + '/login?rd=%2F.well-known%2Fidlepage.json', true]);
  h.jar.cookie = 'session=ok'; login.url = origin + '/.well-known/idlepage.json'; // the user logged in
  assert.deepEqual((await client.banks()).map(b => b.id), ['cards', 'ear']);
  await client.loginDone();
  assert.equal(own().length, 1, 'owned login tab closed after login');
  assert.equal(await client.account(), 'reader');

  // Self-graded card lesson; writes pass the server's same-origin check.
  const lesson = await client.next('cards', { day: '2026-10-15' });
  const s = new StudySession('cards', '卡片', lesson);
  s.reveal(); s.grade(1); s.reveal(); s.grade(3);
  assert.equal(s.phase, 'finished');
  assert.equal(await client.results('cards', s.submission('2026-10-15')!), '收到 2 条');
  assert.deepEqual((submitted[0] as { answers: Array<{ rating: number }> }).answers.map(a => a.rating), [1, 3]);

  // Choice lesson with units; its audio is played by the site's player page.
  assert.deepEqual((await client.units('ear', '2026-10-15')).map(u => [u.id, u.view, u.unlocked]), [['int', true, true], ['dict', false, undefined]]);
  const ear = await client.next('ear', { unit: 'int', day: '2026-10-15' });
  assert.deepEqual(await client.play(ear.questions[0].view.audio[0].src, '/player.html'), { played: true });
  assert.deepEqual(h.player.calls, ['/api/study/banks/ear/audio/q1']);
  const s2 = new StudySession('ear', '听音', ear); s2.choose('7');
  await client.results('ear', s2.submission('2026-10-15')!);
  assert.deepEqual(submitted[1], { unit: 'int', level: 0, lesson_id: s2.lessonId, day: '2026-10-15', answers: [{ qid: 'q1', answer: '7', retry: false, ms: (submitted[1] as any).answers[0].ms }] });

  // Logout runs the site's own logout path inside the page, then the session is confirmed gone.
  await client.logout();
  await assert.rejects(client.account(), (e: RemoteError) => e.code === 'needs-login');
});

test('the companion refuses origins it was not paired with and reloads once for a new server permission', async t => {
  const { origin } = await site(t);
  const h = await harness(t, ['https://other.example'], ['http://127.0.0.1/*']);
  await until(() => h.reloads() === 1);
  await until(() => h.channel.connected());
  assert.deepEqual(await h.channel.run({ op: 'fetch', origin, home: '/.well-known/idlepage.json', path: '/api/study/banks', method: 'GET' }), { error: 'NotAllowed' });
  assert.deepEqual(await h.channel.run({ op: 'fetch', origin: 'https://other.example', home: '/.well-known/idlepage.json', path: 'https://evil.example/', method: 'GET' }), { error: 'NotAllowed' });
  assert.equal(h.tabs.filter(tab => !tab.url.includes('qidian.com')).length, 0);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(h.reloads(), 1, 'reload is rate limited');
});

test('media is played only by the site player page', async t => {
  const { origin } = await site(t);
  const h = await harness(t, [origin]);
  await until(() => h.channel.connected());
  h.jar.cookie = 'session=ok';
  const client = new RemoteClient((job, timeout) => h.channel.run(job, timeout), { origin, home: '/.well-known/idlepage.json' });
  assert.deepEqual(await client.play('/api/study/banks/ear/audio/q1', '/player.html'), { played: true });
  assert.deepEqual(h.player.calls, ['/api/study/banks/ear/audio/q1']);
  assert.equal(h.tabs.filter(tab => tab.url === origin + '/player.html').length, 1);
  await client.play('/api/study/banks/ear/audio/q1', '/player.html');
  assert.equal(h.tabs.filter(tab => tab.url === origin + '/player.html').length, 1, 'player tab reused');
  h.player.result = false;   // the site cannot play (e.g. no voice): no sound, nothing downloaded
  assert.deepEqual(await client.play('/api/study/banks/ear/audio/q1', '/player.html'), { played: false, reason: 'PlayerDeclined' });
  assert.deepEqual(await client.play('/api/study/banks/ear/audio/q1'), { played: false, reason: 'NoPlayerPage' }, 'no player page: no sound and no request');
  assert.equal(h.player.calls.length, 3);
  assert.deepEqual(await h.channel.run({ op: 'play', origin, home: '/.well-known/idlepage.json', path: '/x', player: 'https://evil.example/p' }), { error: 'NotAllowed' });
});

test('a dedicated Edge with every window closed still serves requests from a minimized window', async t => {
  const { origin } = await site(t);
  const h = await harness(t, [origin]);
  await until(() => h.channel.connected());
  h.windows.splice(0);
  const client = new RemoteClient((job, timeout) => h.channel.run(job, timeout), { origin, home: '/.well-known/idlepage.json' });
  assert.equal((await client.discover()).name, '测试站');
  assert.deepEqual(h.windows.map(w => [w.focused, w.state]), [[false, 'minimized']]);
  assert.equal(h.tabs.filter(tab => tab.url.startsWith(origin)).length, 1);
});

test('bridge returns NotPickedUp when no companion polls', async () => {
  const channel = new RemoteChannel();
  assert.equal(channel.connected(), false);
  assert.deepEqual(await channel.run({ op: 'login-done', origin: 'https://x.example' }, 50), { error: 'NotPickedUp' });
});
