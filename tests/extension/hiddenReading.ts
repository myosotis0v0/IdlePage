import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { EdgeWindowControl } from '../../src/infrastructure/qidian/EdgeWindowControl';

export interface LiveApi {
  getBridgeStatus(): { endpoint: string; phase: string; chapterNavigation: { current: number }; chapterSummary?: { status: string; characters?: number }; bookshelfSummary?: { count: number }; catalogSummary?: { count: number }; report?: { state: string } };
  getBrowserWindowMode(): string;
}

/** Opt-in real browser check. Stores summaries only; never titles or chapter text. */
export async function verifyHiddenReading(api: LiveApi, root: string): Promise<void> {
  const control = new EdgeWindowControl();
  const path = join(root, '.local/hidden-reading.json');
  const startedAt = new Date().toISOString();
  const record = async (phase: string, values = {}) => writeFile(path, JSON.stringify({ phase, startedAt, observedAt: new Date().toISOString(), ...values }, null, 2));
  const waitChapter = async (index: number) => {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const state = api.getBridgeStatus();
      if (state.phase === 'chapter-unavailable' || ['NeedsLogin', 'AccessBlocked'].includes(state.report?.state ?? '')) throw new Error('LiveReadingUnavailable');
      if (state.phase === 'chapter-preview-ready' && state.chapterNavigation.current === index) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('LiveReadingTimeout');
  };
  const waitHidden = async () => {
    for (let i = 0; i < 6; i++) {
      const result = await control.control('inspect');
      if (result.status === 'ok' && result.windows > 0 && result.visible === 0) return result;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('WindowNotHidden');
  };
  try {
    await record('waiting-hidden-reading');
    await waitChapter(2); await waitHidden();
    const initial = api.getBridgeStatus();
    assert.ok(initial.bookshelfSummary!.count > 0 && initial.catalogSummary!.count > 0);
    await record('checking-diagnostic-show');
    assert.equal(await vscode.commands.executeCommand('idlepage.showBrowser'), 'ok');
    assert.equal(api.getBrowserWindowMode(), 'diagnostic');
    assert.equal(await vscode.commands.executeCommand('idlepage.nextChapter'), 'started');
    await waitChapter(3);
    const diagnostic = await control.control('inspect');
    assert.ok(diagnostic.status === 'ok' && diagnostic.visible > 0);
    await record('checking-hidden-next');
    assert.equal(await vscode.commands.executeCommand('idlepage.hideBrowser'), 'ok');
    assert.equal(api.getBrowserWindowMode(), 'managed');
    assert.equal(await vscode.commands.executeCommand('idlepage.nextChapter'), 'started');
    await waitChapter(4); const hidden = await waitHidden();
    const final = api.getBridgeStatus();
    await record('passed', { books: initial.bookshelfSummary!.count, chapters: initial.catalogSummary!.count,
      current: final.chapterNavigation.current, chapterSummary: final.chapterSummary, hidden, diagnosticProtected: true });
  } catch {
    await record('failed', { phaseAtFailure: api.getBridgeStatus().phase });
  }
}
