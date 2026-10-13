import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserWindowController, type BrowserWindowResult } from '../../src/application/BrowserWindowController';
import { BrowserVisibility } from '../../src/application/BrowserVisibility';
const hidden: BrowserWindowResult = { status: 'ok', windows: 1, visible: 0 };

test('startup visibility requests coalesce and wait only for the dedicated window to appear', async () => {
  let calls = 0;
  const windows = new BrowserWindowController({ control: async () => ++calls < 3 ? { status: 'no-window', windows: 0, visible: 0 } : hidden });
  const visibility = new BrowserVisibility({ windows, canHide: () => true, delayMs: 1 });
  const first = visibility.requestHide(); assert.equal(visibility.requestHide(), first);
  await first; assert.equal(calls, 3); assert.deepEqual(visibility.lastResult, hidden);
});
test('login, access blocks or disabled hiding cancel pending retries without warnings', async () => {
  let allowed = true; let calls = 0; let failures = 0;
  const windows = new BrowserWindowController({ control: async () => {
    calls++; allowed = false; return { status: 'not-running', windows: 0, visible: 0 };
  } });
  const visibility = new BrowserVisibility({ windows, canHide: () => allowed, onFailure: () => failures++, delayMs: 1 });
  await visibility.requestHide(); await visibility.requestHide();
  assert.equal(calls, 1); assert.equal(failures, 0);
});
test('diagnostic show is respected and temporary login reveal does not latch diagnostic mode', async () => {
  const calls: string[] = [];
  const windows = new BrowserWindowController({ control: async action => { calls.push(action); return hidden; } });
  const visibility = new BrowserVisibility({ windows, canHide: () => true });
  await windows.revealForAttention(); assert.equal(windows.mode, 'managed');
  await visibility.requestHide(); await windows.show(); await visibility.requestHide();
  assert.deepEqual(calls, ['show', 'hide', 'show']);
});
test('ambiguous identity fails once and window absence retries finitely', async () => {
  let calls = 0; let failures = 0;
  const windows = new BrowserWindowController({ control: async () => {
    calls++; return { status: 'ambiguous', windows: 0, visible: 0 };
  } });
  await new BrowserVisibility({ windows, canHide: () => true, onFailure: () => failures++ }).requestHide();
  assert.equal(calls, 1); assert.equal(failures, 1);
  calls = 0; failures = 0;
  const absent = new BrowserWindowController({ control: async () => { calls++; return { status: 'no-window', windows: 0, visible: 0 }; } });
  await new BrowserVisibility({ windows: absent, canHide: () => true, attempts: 3, delayMs: 1, onFailure: () => failures++ }).requestHide();
  assert.equal(calls, 3); assert.equal(failures, 1);
});
test('disposal stops pending window creation recovery', async () => {
  let calls = 0; let failures = 0;
  const windows = new BrowserWindowController({ control: async () => { calls++; return { status: 'no-window', windows: 0, visible: 0 }; } });
  const visibility = new BrowserVisibility({ windows, canHide: () => true, delayMs: 5, onFailure: () => failures++ });
  const result = visibility.requestHide(); await Promise.resolve(); visibility.dispose(); await result;
  assert.equal(calls, 1); assert.equal(failures, 0);
});
