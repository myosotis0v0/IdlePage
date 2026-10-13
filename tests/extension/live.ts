import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { verifyHiddenReading, type LiveApi } from './hiddenReading';
import { verifyLoginRecovery } from './loginRecoveryLive';
interface Exports extends LiveApi { getCompanionDirectory(): string }
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<Exports>('myosotis0v0.idle-page')!;
  const api = await extension.activate();
  await writeFile(join(extension.extensionPath, '.local/live-ready.json'), JSON.stringify({ endpoint: api.getBridgeStatus().endpoint, companionDirectory: api.getCompanionDirectory() }, null, 2));
  if (process.env.IDLEPAGE_UI_TEST === '1') { await new Promise<void>(() => {}); return; }
  if (process.env.IDLEPAGE_LOGIN_SMOKE === '1') {
    await verifyLoginRecovery(api, extension.extensionPath); await new Promise<void>(() => {}); return;
  }
  await vscode.commands.executeCommand('idlepage.extractChapter');
  // This live validation advances exactly once after chapter one succeeds.
  const advance = setInterval(() => {
    const status = api.getBridgeStatus();
    if (status.phase !== 'chapter-preview-ready' || status.chapterNavigation.current !== 1) return;
    clearInterval(advance); void vscode.commands.executeCommand('idlepage.nextChapter');
  }, 1000);
  if (process.env.IDLEPAGE_HIDDEN_SMOKE === '1') await verifyHiddenReading(api, extension.extensionPath);
  if (process.env.IDLEPAGE_LIFETIME_SMOKE === '1') {
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const state = api.getBridgeStatus();
      if (state.phase === 'chapter-preview-ready' && state.chapterNavigation.current === 2) {
        await writeFile(join(extension.extensionPath, '.local/lifetime-smoke.json'), JSON.stringify({ phase: 'closing-vscode', observedAt: new Date().toISOString() }));
        await vscode.commands.executeCommand('workbench.action.closeWindow'); break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  // Interactive live verification host. The user can close this window normally.
  await new Promise<void>(() => {});
}
