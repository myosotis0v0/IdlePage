import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
interface Exports { getBridgeStatus(): { endpoint: string; phase: string; chapterNavigation: { current: number } }; getCompanionDirectory(): string }
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<Exports>('myosotis0v0.idle-page')!;
  const api = await extension.activate();
  await writeFile(join(extension.extensionPath, '.local/live-ready.json'), JSON.stringify({ endpoint: api.getBridgeStatus().endpoint, companionDirectory: api.getCompanionDirectory() }, null, 2));
  await vscode.commands.executeCommand('idlepage.extractChapter');
  await vscode.commands.executeCommand('idlepage.prepareBrowser');
  // This live validation advances exactly once after chapter one succeeds.
  const advance = setInterval(() => {
    const status = api.getBridgeStatus();
    if (status.phase !== 'chapter-preview-ready' || status.chapterNavigation.current !== 1) return;
    clearInterval(advance); void vscode.commands.executeCommand('idlepage.nextChapter');
  }, 1000);
  // Interactive live verification host. The user can close this window normally.
  await new Promise<void>(() => {});
}
