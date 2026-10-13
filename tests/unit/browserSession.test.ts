import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserSession } from '../../src/application/BrowserSession';
test('cold connection launches once and waits for actual task observation', async () => {
  let observed = false; let launches = 0;
  const session = new BrowserSession({ launch: async () => { launches++; setTimeout(() => { observed = true; }, 5); }, isCurrent: () => true, hasObserved: () => observed, tickMs: 1, timeoutMs: 80 });
  const a = session.ensure('task'); const b = session.ensure('task'); assert.equal(a, b);
  assert.equal(await a, 'connected'); assert.equal(launches, 1); assert.equal(session.state, 'ready');
});
test('recent authenticated contact allows running browser to execute without opening another window', async () => {
  let observed = false; let launches = 0;
  const session = new BrowserSession({ launch: async () => { launches++; }, isCurrent: () => true, hasObserved: () => observed, tickMs: 1, graceMs: 50 });
  session.noteContact(); setTimeout(() => { observed = true; }, 5);
  assert.equal(await session.ensure('task'), 'connected'); assert.equal(launches, 0);
});
test('contact without task execution still triggers one recovery launch then times out', async () => {
  let launches = 0;
  const session = new BrowserSession({ launch: async () => { launches++; }, isCurrent: () => true, hasObserved: () => false, tickMs: 1, graceMs: 5, timeoutMs: 5 });
  session.noteContact(); assert.equal(await session.ensure('task'), 'connection-timeout'); assert.equal(launches, 1); assert.equal(session.state, 'failed');
});
test('launch failures and replaced tasks end without endless retries', async () => {
  const failed = new BrowserSession({ launch: async () => { throw new Error('MissingEdge'); }, isCurrent: () => true, hasObserved: () => false });
  assert.equal(await failed.ensure('task'), 'launch-failed');
  let launches = 0;
  const cancelled = new BrowserSession({ launch: async () => { launches++; }, isCurrent: () => false, hasObserved: () => false });
  assert.equal(await cancelled.ensure('old'), 'cancelled'); assert.equal(launches, 0);
});

test('existing hidden browser is never relaunched on stale contact or task timeout', async () => {
  let launches = 0;
  const session = new BrowserSession({ isRunning: async () => true, launch: async () => { launches++; }, isCurrent: () => true, hasObserved: () => false, tickMs: 1, timeoutMs: 5 });
  assert.equal(await session.ensure('task'), 'connection-timeout');
  assert.equal(launches, 0);
});
test('absent browser launches but uncertain ownership does not', async () => {
  for (const uncertain of [false, true]) {
    let launches = 0;
    const session = new BrowserSession({ isRunning: async () => { if (uncertain) throw new Error('ambiguous'); return false; }, launch: async () => { launches++; }, isCurrent: () => true, hasObserved: () => false, tickMs: 1, timeoutMs: 5 });
    assert.equal(await session.ensure('task'), uncertain ? 'launch-failed' : 'connection-timeout');
    assert.equal(launches, uncertain ? 0 : 1);
  }
});
