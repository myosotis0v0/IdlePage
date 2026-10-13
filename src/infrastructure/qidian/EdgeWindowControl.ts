import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { BrowserWindowPort, BrowserWindowResult } from '../../application/BrowserWindowController';
import { edgeProfile } from './edgeProfile';

// Fixed script, bundled with the extension. Paths and actions are data in the
// child environment, never interpolated into executable PowerShell source.
export const edgeWindowScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  if ($env:IDLEPAGE_WINDOW_ACTION -notin @('inspect', 'show', 'hide', 'close', 'watch')) { throw 'InvalidAction' }
  $profile = [IO.Path]::GetFullPath($env:IDLEPAGE_WINDOW_PROFILE).TrimEnd('\')
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class IdlePageWindows {
  public delegate bool Callback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int count);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Arguments(string command) {
    int count; IntPtr memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new InvalidOperationException();
    try {
      var result = new string[count];
      for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i*IntPtr.Size));
      return result;
    } finally { LocalFree(memory); }
  }
  public static IntPtr[] Windows(uint process) {
    var result = new List<IntPtr>();
    bool ok = EnumWindows(delegate(IntPtr window, IntPtr data) {
      uint owner; GetWindowThreadProcessId(window, out owner);
      var name = new StringBuilder(256); GetClassName(window, name, name.Capacity);
      if (owner == process && name.ToString() == "Chrome_WidgetWin_1" && GetWindow(window, 4) == IntPtr.Zero) result.Add(window);
      return true;
    }, IntPtr.Zero);
    if (!ok) throw new InvalidOperationException();
    return result.ToArray();
  }
}
'@
  function Get-IdlePageRoots {
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object {
    if (-not $_.CommandLine) { return $false }
    $arguments = [IdlePageWindows]::Arguments($_.CommandLine)
    if (@($arguments | Where-Object { $_ -eq '--type' -or $_.StartsWith('--type=') }).Count -gt 0) { return $false }
    $profiles = @()
    for ($i = 1; $i -lt $arguments.Length; $i++) {
      if ($arguments[$i].StartsWith('--user-data-dir=')) { $profiles += $arguments[$i].Substring(16) }
      elseif ($arguments[$i] -eq '--user-data-dir' -and $i + 1 -lt $arguments.Length) { $i++; $profiles += $arguments[$i] }
    }
    if ($profiles.Count -ne 1 -or -not [IO.Path]::IsPathRooted($profiles[0])) { return $false }
    return [IO.Path]::GetFullPath($profiles[0]).TrimEnd('\') -eq $profile
    }
  }
  function Close-IdlePageBrowser {
    $targets = @(Get-IdlePageRoots)
    if ($targets.Count -eq 0) { return 'not-running' }
    if ($targets.Count -ne 1) { return 'ambiguous' }
    $target = $targets[0]
    foreach ($window in [IdlePageWindows]::Windows([uint32]$target.ProcessId)) {
      if (-not [IdlePageWindows]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'CloseFailed' }
    }
    # Give Edge time to flush its session. Background-mode residue is then
    # terminated only after rechecking the exact root identity and creation time.
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      if (-not (Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue)) { return 'closed' }
      Start-Sleep -Milliseconds 100
    }
    $remaining = @(Get-IdlePageRoots)
    if ($remaining.Count -eq 0) { return 'closed' }
    if ($remaining.Count -ne 1 -or $remaining[0].ProcessId -ne $target.ProcessId -or $remaining[0].CreationDate -ne $target.CreationDate) { return 'ambiguous' }
    & (Join-Path $env:SystemRoot 'System32/taskkill.exe') /PID $target.ProcessId /T /F 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue)) { throw 'TerminateFailed' }
    return 'closed'
  }
  if ($env:IDLEPAGE_WINDOW_ACTION -eq 'watch') {
    if ($env:IDLEPAGE_BROWSER_MUTEX -notmatch '^[a-f0-9]{64}$' -or $env:IDLEPAGE_BROWSER_OWNER -notmatch '^\d+$') { throw 'InvalidOwner' }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $runtime = $env:IDLEPAGE_BROWSER_RUNTIME
    $mutex = New-Object Threading.Mutex($false, ('Local\IdlePageBrowser-' + $env:IDLEPAGE_BROWSER_MUTEX))
    $claimed = $false
    try { $claimed = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $claimed = $true }
    if (-not $claimed) {
      [IO.File]::WriteAllText((Join-Path $runtime 'ready.json'), '{"status":"busy"}', $encoding)
      $mutex.Dispose(); return
    }
    try {
      $owner = Get-Process -Id ([int]$env:IDLEPAGE_BROWSER_OWNER) -ErrorAction SilentlyContinue
      if ($owner) {
        $birth = $owner.StartTime.ToUniversalTime().Ticks
        [IO.File]::WriteAllText((Join-Path $runtime 'ready.json'), (@{status='ready'; watcherId=$PID} | ConvertTo-Json -Compress), $encoding)
        while (-not (Test-Path -LiteralPath (Join-Path $runtime 'stop'))) {
          $current = Get-Process -Id $owner.Id -ErrorAction SilentlyContinue
          if (-not $current -or $current.StartTime.ToUniversalTime().Ticks -ne $birth) { break }
          Start-Sleep -Milliseconds 500
        }
      }
    } finally {
      try { $closed = Close-IdlePageBrowser } catch { $closed = 'failed' }
      [IO.File]::WriteAllText((Join-Path $runtime 'exit.json'), (@{status=$closed} | ConvertTo-Json -Compress), $encoding)
      $mutex.ReleaseMutex(); $mutex.Dispose()
    }
    return
  }
  if ($env:IDLEPAGE_WINDOW_ACTION -eq 'close') {
    @{ status=(Close-IdlePageBrowser); windows=0; visible=0 } | ConvertTo-Json -Compress
    return
  }
  $roots = @(Get-IdlePageRoots)
  $result = @{ status='ok'; windows=0; visible=0 }
  if ($roots.Count -eq 0) { $result.status='not-running' }
  elseif ($roots.Count -ne 1) { $result.status='ambiguous' }
  else {
    $windows = @([IdlePageWindows]::Windows([uint32]$roots[0].ProcessId))
    $result.windows = $windows.Count
    if ($windows.Count -eq 0) { $result.status='no-window' }
    elseif ($env:IDLEPAGE_WINDOW_ACTION -ne 'inspect') {
      $command = if ($env:IDLEPAGE_WINDOW_ACTION -eq 'hide') { 0 } else { 4 }
      $wantedVisible = $env:IDLEPAGE_WINDOW_ACTION -eq 'show'
      foreach ($window in $windows) {
        if (-not [IdlePageWindows]::IsWindow($window)) { throw 'WindowGone' }
        if ([IdlePageWindows]::IsWindowVisible($window) -ne $wantedVisible) {
          if (-not [IdlePageWindows]::ShowWindowAsync($window, $command)) { throw 'ControlFailed' }
        }
      }
      # ShowWindowAsync only posts a message: verify the actual resulting state.
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $pending = @($windows | Where-Object { -not [IdlePageWindows]::IsWindow($_) -or [IdlePageWindows]::IsWindowVisible($_) -ne $wantedVisible })
        if ($pending.Count -eq 0) { break }
        Start-Sleep -Milliseconds 50
      }
      if ($pending.Count -ne 0) { throw 'StateNotApplied' }
    }
    $result.visible = @($windows | Where-Object { [IdlePageWindows]::IsWindowVisible($_) }).Count
  }
  $result | ConvertTo-Json -Compress
} catch {
  @{ status='failed'; windows=0; visible=0 } | ConvertTo-Json -Compress
}
`;

export class EdgeWindowControl implements BrowserWindowPort {
  async control(action: 'inspect' | 'show' | 'hide'): Promise<BrowserWindowResult> {
    const profile = edgeProfile();
    const executable = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(edgeWindowScript, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 15000, maxBuffer: 16384,
        env: { ...process.env, IDLEPAGE_WINDOW_PROFILE: profile, IDLEPAGE_WINDOW_ACTION: action },
      }, (error, stdout) => error ? reject(new Error('EdgeWindowControlFailed')) : resolve(stdout));
    });
    const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (!['ok', 'not-running', 'no-window', 'ambiguous', 'failed'].includes(result.status) ||
        !Number.isSafeInteger(result.windows) || !Number.isSafeInteger(result.visible) ||
        result.windows < 0 || result.visible < 0 || result.visible > result.windows) throw new Error('InvalidWindowControlResult');
    return result;
  }
}
