import { spawn } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { edgeProfile } from './edgeProfile';

let companionDirectory: string | undefined;
/** The paired companion copy; every launch of the dedicated Edge loads it, so no manual install is needed. */
export function setCompanionDirectory(directory: string): void { companionDirectory = directory; }

/**
 * Switches for the dedicated profile only (never the user's ordinary Edge):
 * - load the paired companion directly; it runs even with developer mode off, and needs no "Load unpacked";
 * - no Edge account: no implicit sign-in with the Windows account, no sync (sync once turned developer mode
 *   off and would pull the user's other extensions and settings into this profile);
 * - no "Edge closed unexpectedly" bubble: the lifetime guardian ends this browser when VS Code exits;
 * - background tabs may play audio without a click (the site's own player pages).
 */
export function dedicatedEdgeArguments(profile: string, directory = companionDirectory): string[] {
  return [`--user-data-dir=${profile}`, '--no-first-run', '--disable-sync', '--allow-browser-signin=false',
    '--disable-features=msImplicitSignin,msEdgeImplicitSignIn,msImplicitSignInFRE', '--hide-crash-restore-bubble',
    '--autoplay-policy=no-user-gesture-required', ...(directory ? [`--load-extension=${directory}`] : [])];
}

async function openEdge(url: string, fresh = false): Promise<void> {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('WindowsEdgeRequired');
  const candidates = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe'),
  ];
  let executable: string | undefined;
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
  if (!executable) throw new Error('EdgeNotFound');
  const profile = edgeProfile();
  await mkdir(profile, { recursive: true });
  // A fresh start shows exactly one blank page: drop the tab-restore records of the last session
  // (only tabs; cookies and site logins stay). Task tabs are reopened by the companion when needed.
  if (fresh) await rm(join(profile, 'Default', 'Sessions'), { recursive: true, force: true }).catch(() => {});
  const child = spawn(executable, [...dedicatedEdgeArguments(profile), url], { detached: true, stdio: 'ignore', windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}
export async function openEdgeExtensions(): Promise<void> { await openEdge('edge://extensions/'); }
/**
 * Starts the dedicated Edge (not running) with one blank page. The companion's service worker starts
 * with the browser and connects by itself; no status page is opened.
 */
export async function openDedicatedEdge(): Promise<void> { await openEdge('about:blank', true); }
