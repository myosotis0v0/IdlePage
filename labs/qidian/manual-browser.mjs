import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const candidates = [
  join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  join(process.env.LOCALAPPDATA ?? homedir(), 'Microsoft/Edge/Application/msedge.exe'),
];
let executable;
for (const candidate of candidates) {
  try { await access(candidate); executable = candidate; break; } catch {}
}
if (!executable) throw new Error('Microsoft Edge not found. Open https://www.qidian.com/ manually in your ordinary browser.');
const profile = join(process.env.LOCALAPPDATA ?? join(homedir(), '.local/share'), 'IdlePage/qidian-probe/manual-edge-profile');
await mkdir(profile, { recursive: true });
const browser = spawn(executable, [`--user-data-dir=${profile}`, '--new-window', 'https://www.qidian.com/'], {
  detached: true, stdio: 'ignore',
});
browser.on('error', () => { console.error('Unable to open Edge.'); process.exitCode = 1; });
await new Promise((resolve, reject) => { browser.once('spawn', resolve); browser.once('error', reject); });
browser.unref();
console.log('Ordinary Edge opened. This launcher uses no Playwright or remote-debugging connection.');
