import { runTests } from '@vscode/test-electron';
import { resolve, join } from 'node:path';
import { access, mkdir, writeFile } from 'node:fs/promises';
// Codex terminal may inherit Electron's Node mode; desktop VS Code must run as an app.
delete process.env.ELECTRON_RUN_AS_NODE;
const root = resolve('.');
const vscodeExecutablePath = join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
await access(vscodeExecutablePath);
const user = join(root, '.local/vscode-test-user/User');
await mkdir(user, { recursive: true });
await writeFile(join(user, 'settings.json'), JSON.stringify({ 'idlepage.bridge.port': 17656, 'idlepage.browser.autoStart': false, 'idlepage.browser.autoHide': false, 'idlepage.cache.enabled': false }));
for (const suite of (process.env.IDLEPAGE_SUITES?.split(',') ?? ['suite', 'resume', 'study', 'addsite'])) await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, `out/tests/${suite}.cjs`),
  launchArgs: [root, '--user-data-dir=' + join(root, '.local/vscode-test-user'), '--extensions-dir=' + join(root, '.local/vscode-test-extensions'), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-extensions'],
});
