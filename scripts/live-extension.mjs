import { spawn } from 'node:child_process';
import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve('.');
const env = { ...process.env };
if (process.argv.includes('--hidden-smoke')) env.IDLEPAGE_HIDDEN_SMOKE = '1';
if (process.argv.includes('--lifetime-smoke')) env.IDLEPAGE_LIFETIME_SMOKE = '1';
if (process.argv.includes('--login-smoke')) env.IDLEPAGE_LOGIN_SMOKE = '1';
if (process.argv.includes('--sidebar-demo')) env.IDLEPAGE_SIDEBAR_DEMO = '1';
if (process.argv.includes('--demo')) env.IDLEPAGE_READING_DEMO = '1';
if (process.argv.includes('--ui')) env.IDLEPAGE_UI_TEST = '1';
delete env.ELECTRON_RUN_AS_NODE;
await mkdir(join(root, '.local'), { recursive: true });
const disabled = [];
if (process.argv.includes('--sidebar-demo')) {
  const extensions = join(process.env.USERPROFILE, '.vscode/extensions');
  for (const name of await readdir(extensions)) {
    try {
      const manifest = JSON.parse(await readFile(join(extensions, name, 'package.json'), 'utf8'));
      const id = manifest.publisher + '.' + manifest.name;
      if (id !== 'openai.chatgpt') disabled.push('--disable-extension=' + id);
    } catch {}
  }
}
const log = await open(join(root, '.local/vscode-live.log'), 'a');
const child = spawn(join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe'), [
  root, '--new-window', ...disabled, '--extensionDevelopmentPath=' + root, '--extensionTestsPath=' + join(root, 'out/tests/live.cjs'),
  '--user-data-dir=' + join(root, '.local/vscode-live-user'), '--extensions-dir=' + (process.argv.includes('--sidebar-demo') ? join(process.env.USERPROFILE, '.vscode/extensions') : join(root, '.local/vscode-live-extensions')),
  '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
], { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
child.unref();
await log.close();
console.log('IdlePage interactive development host started. Close its window to stop the local service.');
