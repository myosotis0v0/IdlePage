import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

async function openEdge(url: string): Promise<void> {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('WindowsEdgeRequired');
  const candidates = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe'),
  ];
  let executable: string | undefined;
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
  if (!executable) throw new Error('EdgeNotFound');
  const profile = join(process.env.LOCALAPPDATA, 'IdlePage/qidian-probe/manual-edge-profile');
  await mkdir(profile, { recursive: true });
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--no-first-run', url], { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}
export async function openEdgeExtensions(): Promise<void> { await openEdge('edge://extensions/'); }
export async function openEdgeCompanion(origin: string): Promise<void> {
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw new Error('InvalidCompanionOrigin');
  await openEdge(origin + '/status.html?connect=' + Date.now());
}
