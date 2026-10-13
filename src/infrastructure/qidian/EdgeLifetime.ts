import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { edgeProfile } from './edgeProfile';
import { edgeWindowScript } from './EdgeWindowControl';

/** An independent guardian survives an extension-host crash, then exits itself. */
export class EdgeLifetime {
  private starting?: Promise<void>;
  private runtime?: string;
  private stopped = false;
  private launches: Promise<void> = Promise.resolve();
  constructor(private readonly storage: string) {}
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('BrowserLifetimeStopped'));
    if (!this.starting) {
      const result = this.attach(); this.starting = result;
      void result.catch(() => { if (this.starting === result) this.starting = undefined; });
    }
    return this.starting;
  }
  launch(operation: () => Promise<void>): Promise<void> {
    const result = this.launches.then(async () => {
      await this.start();
      if (this.stopped) throw new Error('BrowserLifetimeStopped');
      await operation();
    });
    this.launches = result.catch(() => {}); return result;
  }
  private async attach(): Promise<void> {
    const profile = edgeProfile();
    const runtime = join(resolve(this.storage), 'browser-runtime', randomUUID());
    await mkdir(runtime, { recursive: true }); this.runtime = runtime;
    const bootstrap = String.raw`$ErrorActionPreference='Stop'
Start-Process -WindowStyle Hidden -FilePath (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$env:IDLEPAGE_WATCH_SCRIPT)`;
    await new Promise<void>((resolveStart, reject) => execFile(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(bootstrap, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 5000, maxBuffer: 1024,
        env: { ...process.env, IDLEPAGE_WATCH_SCRIPT: Buffer.from(edgeWindowScript, 'utf16le').toString('base64'),
          IDLEPAGE_WINDOW_ACTION: 'watch', IDLEPAGE_WINDOW_PROFILE: profile,
          IDLEPAGE_BROWSER_OWNER: String(process.pid), IDLEPAGE_BROWSER_RUNTIME: runtime,
          IDLEPAGE_BROWSER_MUTEX: createHash('sha256').update(profile.toLowerCase()).digest('hex') },
      }, error => error ? reject(new Error('BrowserGuardianLaunchFailed')) : resolveStart()));
    for (let i = 0; i < 40; i++) {
      const ready = await this.read('ready.json');
      if (ready?.status === 'ready') return;
      if (ready) throw new Error('BrowserLifetimeBusy');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await writeFile(join(runtime, 'stop'), 'stop');
    throw new Error('BrowserLifetimeUnavailable');
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (!this.starting) return;
    try { await this.starting; } catch { return; }
    await this.launches;
    if (!this.runtime) return;
    await writeFile(join(this.runtime, 'stop'), 'stop');
    for (let i = 0; i < 40; i++) {
      const exit = await this.read('exit.json');
      if (exit) {
        if (!['closed', 'not-running'].includes(exit.status)) throw new Error('BrowserCleanupFailed');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // The guardian continues independently if VS Code's shutdown deadline wins.
  }
  private async read(file: string): Promise<{ status: string } | undefined> {
    try { return JSON.parse(await readFile(join(this.runtime!, file), 'utf8')); } catch { return undefined; }
  }
}
