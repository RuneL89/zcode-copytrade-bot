param([int]$TargetPid)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Fg2 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$shell = New-Object -ComObject WScript.Shell
$ok = $shell.AppActivate($TargetPid)
Start-Sleep -Milliseconds 800
$hwnd = [Win32Fg2]::GetForegroundWindow()
$fgPid = 0
[void][Win32Fg2]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)
$fg = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
Write-Output ("APPACTIVATE=" + $ok)
Write-Output ("FOREGROUND_PID=" + $fgPid)
Write-Output ("FOREGROUND_NAME=" + $(if ($fg) { $fg.ProcessName } else { 'unknown' }))
Write-Output ("FOREGROUND_TITLE=" + $(if ($fg) { $fg.MainWindowTitle } else { '' }))
if ($fgPid -ne $TargetPid) { Write-Output 'ABORT_NOT_FRONTMOST'; exit 2 }
Write-Output 'FRONTMOST_OK'
