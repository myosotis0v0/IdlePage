import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QidianAccessProbe } from '../../src/application/QidianAccessProbe';
import { parseObservation } from '../../src/domain/browserBridge';
const visible = { state: 'SiteContentVisible', pageKind: 'other', bodyCharacters: 1500, bookLinks: 3, verification: false, tooFrequent: false, captchaFrame: false };

test('validation canonicalizes challenges and rejects raw data and invalid counts', () => {
  assert.equal(parseObservation({ ...visible, captchaFrame: true })?.state, 'AccessBlocked');
  assert.equal(parseObservation({ ...visible, pageKind: 'login' })?.state, 'NeedsLogin');
  assert.equal(parseObservation({ ...visible, bookLinks: 0 })?.state, 'Indeterminate');
  for (const value of [{ ...visible, bodyCharacters: -1 }, { ...visible, bookLinks: NaN }, { ...visible, cookie: 'unexpected' }, { ...visible, verification: 'false' }, null]) assert.equal(parseObservation(value), undefined);
});
test('challenge retains task; only current task can advance to bookshelf and complete', () => {
  const probe = new QidianAccessProbe();
  const first = probe.nextTask()!;
  assert.equal(probe.accept(first.id, { ...visible, verification: true }), 'accepted');
  assert.equal(probe.snapshot().report?.state, 'AccessBlocked');
  assert.equal(probe.nextTask()?.id, first.id);
  assert.equal(probe.accept(first.id, visible), 'accepted');
  const shelf = probe.nextTask()!;
  assert.equal(shelf.kind, 'bookshelf');
  assert.notEqual(shelf.id, first.id);
  assert.equal(probe.accept(first.id, visible), 'stale');
  probe.accept(shelf.id, visible);
  assert.equal(probe.snapshot().phase, 'waiting-bookshelf');
  probe.accept(shelf.id, { ...visible, pageKind: 'bookshelf' });
  assert.equal(probe.snapshot().phase, 'probe-complete');
  assert.equal(probe.nextTask(), null);
  probe.restart();
  assert.notEqual(probe.nextTask()?.id, first.id);
  assert.equal(probe.snapshot().report, undefined);
});