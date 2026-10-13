import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

// Read-only geometry helper, tied to the extension host's PID and creation time.
// It never reads window titles, controls windows, or launches a browser.
const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class IdlePageGeometry {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
[void][IdlePageGeometry]::SetThreadDpiAwarenessContext([IntPtr](-4))
$owner=Get-Process -Id ([int]$env:IDLEPAGE_WIDTH_OWNER)
$birth=$owner.StartTime.Ticks
$last=0
while ($true) {
 $alive=Get-Process -Id $owner.Id -ErrorAction SilentlyContinue
 if (-not $alive -or $alive.StartTime.Ticks -ne $birth) { break }
 $h=[IdlePageGeometry]::GetForegroundWindow()
 $windowPid=[uint32]0
 [void][IdlePageGeometry]::GetWindowThreadProcessId($h,[ref]$windowPid)
 $foreground=Get-Process -Id $windowPid -ErrorAction SilentlyContinue
 if ($foreground -and $foreground.ProcessName -match '^Code(?: - Insiders)?$') {
  $rect=New-Object IdlePageGeometry+Rect
  if ([IdlePageGeometry]::GetClientRect($h,[ref]$rect)) {
   $dpi=[Math]::Max(96.0,[double][IdlePageGeometry]::GetDpiForWindow($h))
   $width=[int](($rect.Right-$rect.Left)*96/$dpi)
   if ($width -ge 300 -and $width -le 16000) { [Console]::WriteLine($width) }
  }
 }
 Start-Sleep -Milliseconds 1000
}
`;
export class WindowWidth {
  private child?: ChildProcess;
  private pending = '';
  constructor(private changed: (width: number) => void) {}
  start() {
    if (this.child || process.platform !== 'win32') return;
    const child = spawn(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, IDLEPAGE_WIDTH_OWNER: String(process.pid) } });
    this.child = child;
    child.on('error', () => {});
    child.stdout!.on('data', data => {
      this.pending += data.toString(); const lines = this.pending.split(/\r?\n/); this.pending = lines.pop()!;
      if (this.pending.length > 64) this.pending = '';
      for (const line of lines) { const width = Number(line); if (Number.isInteger(width) && width >= 300 && width <= 16000) this.changed(width); }
    });
  }
  dispose() { this.child?.kill(); this.child = undefined; }
}
