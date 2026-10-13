import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { EdgeWindowControl } from '../../src/infrastructure/qidian/EdgeWindowControl';
import { readCompanionOrigin } from '../../src/infrastructure/local-bridge/prepareCompanion';

// Inject only the initial NeedsLogin event. Authentication proof, resumed
// navigation and chapter content must then come from the real companion/site.
// This does NOT simulate an expired account or prove manual sign-in works.
export async function verifyLoginRecovery(api: { getBridgeStatus(): any; getCompanionDirectory(): string }, root: string) {
  const pairing = JSON.parse(await readFile(join(api.getCompanionDirectory(), 'pairing.json'), 'utf8'));
  const headers = { Origin: await readCompanionOrigin(root), Authorization: `Bearer ${pairing.token}`, 'Content-Type': 'application/json' };
  const call = async (path: string, body: unknown) => {
    const response = await fetch(pairing.endpoint + path, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('LiveBridgeRejected'); return response.json();
  };
  const wait = async (check: () => boolean, timeout = 150000) => {
    const end = Date.now() + timeout;
    while (!check()) { if (Date.now() >= end) throw new Error('LiveRecoveryTimeout'); await new Promise(resolve => setTimeout(resolve, 200)); }
  };
  const control = new EdgeWindowControl();
  let phase = 'failed'; let shown = false; let hidden = false;
  try {
    await vscode.commands.executeCommand('idlepage.extractChapter');
    // Skip already cached chapters, leaving their body intact during recovery.
    for (let i = 0; i < 8; i++) {
      await wait(() => api.getBridgeStatus().phase !== 'checking-cache', 5000);
      if (api.getBridgeStatus().phase !== 'chapter-preview-ready') break;
      await vscode.commands.executeCommand('idlepage.nextChapter');
    }
    await wait(() => api.getBridgeStatus().phase === 'waiting-chapter');
    // Wait until the actual browser was launched before injecting the event;
    // an artificial observation before launch would legitimately cancel the
    // original BrowserSession.ensure() operation as already observed.
    const launchDeadline = Date.now() + 45000;
    while ((await control.control('inspect')).status !== 'ok') {
      if (Date.now() >= launchDeadline) throw new Error('LiveBrowserNotStarted');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const original = (await call('/v1/tasks/next', {})).task;
    if (original?.kind !== 'chapter') throw new Error('LiveExpectedChapter');
    await call('/v1/tasks/result', { taskId: original.id, report: { state: 'NeedsLogin', pageKind: 'login', bodyCharacters: 0, bookLinks: 0, verification: false, tooFrequent: false, captchaFrame: false } });
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const state = api.getBridgeStatus();
      if (state.recovery?.waitingLogin) {
        const window = await control.control('inspect'); if (window.status === 'ok' && window.visible > 0) shown = true;
      }
      if (state.recovery?.resumed && state.phase === 'chapter-preview-ready' && state.chapterSource === 'online') {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const window = await control.control('inspect'); hidden = window.status === 'ok' && window.visible === 0;
        phase = shown && hidden ? 'passed' : 'visibility-not-confirmed'; break;
      }
      if (['task-failed', 'chapter-unavailable', 'cancelled'].includes(state.phase)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally {
    const state = api.getBridgeStatus();
    await writeFile(join(root, '.local/login-recovery.json'), JSON.stringify({ phase, injectedNeedsLogin: true, shown, hidden,
      resumed: state.recovery?.resumed, finalPhase: state.phase, source: state.chapterSource, characters: state.chapterSummary?.characters, observedAt: new Date().toISOString() }));
    await vscode.commands.executeCommand('workbench.action.closeWindow');
  }
}
