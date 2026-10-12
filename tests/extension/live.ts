import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
interface Exports { getBridgeStatus(): { endpoint: string }; getCompanionDirectory(): string }
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<Exports>('myosotis0v0.idle-page')!;
  const api = await extension.activate();
  await writeFile(join(extension.extensionPath, '.local/live-ready.json'), JSON.stringify({ endpoint: api.getBridgeStatus().endpoint, companionDirectory: api.getCompanionDirectory() }, null, 2));
  await vscode.commands.executeCommand('idlepage.prepareBrowser');
  // Interactive live verification host. The user can close this window normally.
  await new Promise<void>(() => {});
}