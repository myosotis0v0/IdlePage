import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { BrowserWindowPort, BrowserWindowResult } from '../../application/BrowserWindowController';
import { edgeProfile } from './edgeProfile';

// Fixed script, bundled with the extension. Paths and actions are data in the
// child environment, never interpolated into executable PowerShell source.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  if ($env:IDLEPAGE_WINDOW_ACTION -notin @('inspect', 'show', 'hide')) { throw 'InvalidAction' }
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
  $roots = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object {
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
  })
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
      execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
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
