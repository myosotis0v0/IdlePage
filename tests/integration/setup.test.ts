import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SetupGuide } from '../../src/application/SetupGuide';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
import { LocalBridgeServer } from '../../src/infrastructure/local-bridge/LocalBridgeServer';

test('setup completes on the first authenticated companion contact without visiting any site', async t => {
  const guide = new SetupGuide(false), probe = new QidianAccessProbe(); probe.invalidateTask();
  let completions = 0;
  const token = 'b'.repeat(64), origin = 'chrome-extension://' + 'b'.repeat(32);
  const bridge = new LocalBridgeServer({ port: 0, token, origin, probe, onContact: () => { if (guide.contact()) completions++; } });
  await bridge.start(); t.after(() => bridge.close());
  const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const next = async () => (await (await fetch(bridge.endpoint() + '/v1/tasks/next', { method: 'POST', headers, body: '{}' })).json()).task;
  assert.equal(guide.stage, 'offer'); guide.start(); guide.opened();
  assert.equal((await fetch(bridge.endpoint() + '/v1/tasks/next', { headers: { ...headers, Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal(guide.stage, 'install', 'an unauthenticated poll is not contact');
  assert.equal(await next(), null, 'setup creates no Qidian task: login is lazy');
  assert.equal(guide.stage, 'ready'); assert.equal(guide.active, false); assert.equal(completions, 1);
  assert.equal(await next(), null); assert.equal(completions, 1);
  guide.dismiss(); assert.equal(guide.view().text, '');
  assert.equal(new SetupGuide(true).stage, 'none');
});

test('setup cancellation and timeout stop without implicit retry', () => {
  const guide = new SetupGuide(false);
  assert.equal(guide.start(100), true); assert.equal(guide.start(200), false);
  guide.dismiss(); guide.opened(); assert.equal(guide.contact(), false);
  guide.start(100); guide.opened();
  assert.equal(guide.expire(100 + 10 * 60_000), true); assert.equal(guide.stage, 'failed');
  assert.ok(guide.view().detail.includes('超时'));
  assert.equal(guide.contact(), false); assert.equal(guide.expire(100 + 20 * 60_000), false);
});
