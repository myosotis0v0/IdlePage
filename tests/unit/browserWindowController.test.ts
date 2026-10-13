import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserWindowController, type BrowserWindowResult } from '../../src/application/BrowserWindowController';

const ok: BrowserWindowResult = { status: 'ok', windows: 1, visible: 1 };
test('explicit show prevents automatic hiding until explicit hide succeeds', async () => {
  const calls: string[] = [];
  const windows = new BrowserWindowController({ control: async action => { calls.push(action); return ok; } });
  await windows.show();
  assert.equal(windows.mode, 'diagnostic');
  assert.equal(await windows.hideAutomatically(), undefined);
  assert.deepEqual(calls, ['show']);
  await windows.hide();
  assert.equal(windows.mode, 'managed');
  await windows.hideAutomatically();
  assert.deepEqual(calls, ['show', 'hide', 'hide']);
});
test('unsuccessful show does not enter diagnostic mode and failed hide does not release it', async () => {
  let result: BrowserWindowResult = { status: 'not-running', windows: 0, visible: 0 };
  const windows = new BrowserWindowController({ control: async () => result });
  await windows.show(); assert.equal(windows.mode, 'managed');
  result = ok; await windows.show();
  result = { status: 'failed', windows: 0, visible: 0 }; await windows.hide();
  assert.equal(windows.mode, 'diagnostic');
  assert.equal(await windows.hideAutomatically(), undefined);
});
test('automatic hide queued behind explicit show respects the resulting diagnostic state', async () => {
  const calls: string[] = [];
  let complete!: (result: BrowserWindowResult) => void;
  const windows = new BrowserWindowController({ control: action => {
    calls.push(action); return new Promise(resolve => { complete = resolve; });
  } });
  const show = windows.show();
  const hide = windows.hideAutomatically();
  await Promise.resolve(); complete(ok);
  await show; assert.equal(await hide, undefined);
  assert.deepEqual(calls, ['show']);
});
test('a native control error does not break the command queue or change the existing mode', async () => {
  let fail = true;
  const windows = new BrowserWindowController({ control: async () => {
    if (fail) throw new Error('ControlUnavailable'); return ok;
  } });
  await assert.rejects(windows.show()); assert.equal(windows.mode, 'managed');
  fail = false; await windows.show(); assert.equal(windows.mode, 'diagnostic');
});
