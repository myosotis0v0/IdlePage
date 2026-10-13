import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve('.');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
await mkdir(join(root, '.local'), { recursive: true });
const log = await open(join(root, '.local/vscode-live.log'), 'a');
const child = spawn(join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'), [
  root, '--new-window', '--extensionDevelopmentPath=' + root, '--extensionTestsPath=' + join(root, 'out/tests/live.cjs'),
  '--user-data-dir=' + join(root, '.local/vscode-live-user'), '--extensions-dir=' + join(root, '.local/vscode-live-extensions'),
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
], { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
child.unref();
await log.close();
console.log('IdlePage interactive development host started. Close its window to stop the local service.');