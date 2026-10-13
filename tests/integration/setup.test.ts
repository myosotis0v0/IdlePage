import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SetupGuide } from '../../src/application/SetupGuide';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
import { LocalBridgeServer } from '../../src/infrastructure/local-bridge/LocalBridgeServer';

test('setup advances from authenticated contact through manual login to confirmed bookshelf automatically', async t => {
  const guide = new SetupGuide(false), probe = new QidianAccessProbe(); probe.invalidateTask();
  let completions = 0;
  const token = 'b'.repeat(64), origin = 'chrome-extension://' + 'b'.repeat(32);
  const bridge = new LocalBridgeServer({ port: 0, token, origin, probe,
    onContact: () => { if (guide.contact()) probe.startBookshelfExtraction(); },
    onChanged: () => { if (guide.observe(probe.snapshot())) completions++; },
  });
  await bridge.start(); t.after(() => bridge.close());
  const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const next = async () => (await (await fetch(bridge.endpoint() + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  const post = async (path: string, taskId: string, report: unknown) => {
    const response = await fetch(bridge.endpoint() + path, { method: 'POST', headers, body: JSON.stringify({ taskId, report }) });
    assert.equal(response.status, 200);
  };
  assert.equal(guide.stage, 'offer'); guide.start(); guide.opened();
  assert.equal((await fetch(bridge.endpoint() + '/v1/tasks/next', { headers: { ...headers, Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal(guide.stage, 'install');
  const shelf = await next(); assert.equal(shelf.kind, 'bookshelf-list'); assert.equal(guide.stage, 'checking');
  assert.equal((await next()).id, shelf.id, 'Further polls must not restart setup');
  const visible = { state: 'SiteContentVisible', pageKind: 'bookshelf', bodyCharacters: 1000, bookLinks: 1, verification: false, tooFrequent: false, captchaFrame: false };
  await post('/v1/tasks/result', shelf.id, { ...visible, state: 'NeedsLogin', pageKind: 'login' });
  assert.equal(guide.stage, 'login');
  const login = await next(); assert.equal(login.kind, 'login');
  await post('/v1/tasks/result', login.id, { ...visible, loginEvidence: 'bookshelf-content' });
  const resumed = await next(); assert.equal(resumed.kind, 'bookshelf-list');
  await post('/v1/tasks/result', resumed.id, visible);
  assert.notEqual(guide.stage, 'ready', 'A visible site alone is not a completed bookshelf extraction');
  await post('/v1/bookshelf/result', resumed.id, { books: [], strategy: 'table', anchorCount: 0, truncated: false, pagination: 'not-detected', containerHints: ['table'] });
  assert.equal(guide.stage, 'ready'); assert.equal(completions, 1);
  assert.equal(await next(), null); assert.equal(completions, 1);
  guide.dismiss(); assert.equal(guide.view().text, '');
  assert.equal(new SetupGuide(true).stage, 'none');
});

test('setup cancellation, blocked access and timeout stop without implicit retry', () => {
  const guide = new SetupGuide(false);
  assert.equal(guide.start(100), true); assert.equal(guide.start(200), false);
  guide.dismiss(); guide.opened(); assert.equal(guide.contact(), false);
  guide.start(100); guide.opened(); guide.contact();
  guide.observe({ phase: 'task-failed', recovery: { waitingLogin: false }, failure: { reason: 'access-blocked' } });
  assert.equal(guide.stage, 'failed'); assert.equal(guide.active, false); assert.equal(guide.contact(), false);
  assert.ok(guide.view().detail.includes('访问受阻'));
  guide.start(100); guide.opened();
  assert.equal(guide.expire(100 + 10 * 60_000), true); assert.equal(guide.stage, 'failed');
  assert.equal(guide.contact(), false); assert.equal(guide.expire(100 + 20 * 60_000), false);
});
