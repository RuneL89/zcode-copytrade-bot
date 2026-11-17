# Start, stop, restart, or show status for the Copydesk paper-mode service on Windows.
# Usage: copydesk-service.ps1 start|stop|restart|status
# Never touches unrelated processes (does not kill pids 11448 or 19696, or ports 8123/8124/8130).
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status')]
    [string]$Command = 'status'
)

$Root = 'C:\Users\atavi\Documents\projects\copydesk'
$LogDir = Join-Path $Root 'logs'
$Supervisor = Join-Path $Root 'scripts\copydesk-supervisor.ps1'
$WatchdogPidFile = Join-Path $LogDir 'copydesk-watchdog.pid'
$ServerPidFile = Join-Path $LogDir 'copydesk-server.pid'
$GuardPidFile = Join-Path $LogDir 'credit-guard.pid'
$StopFile = Join-Path $LogDir 'copydesk.stop'
$GuardStop = Join-Path $LogDir 'overnight-monitor.stop'
$ProtectedPids = @(11448, 19696)

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Get-LivePid([string]$pidFile) {
    if (-not (Test-Path $pidFile)) { return $null }
    $raw = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $raw) { return $null }
    $p = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$p)) { return $null }
    if ($ProtectedPids -contains $p) { return $null }
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc) { return $p }
    return $null
}

function Stop-Tracked([string]$pidFile) {
    $p = Get-LivePid $pidFile
    if (-not $p) { return }
    if ($ProtectedPids -contains $p) { return }
    try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
}

function Test-Listening {
    $conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
    return [bool]$conn
}

switch ($Command) {
    'start' {
        $wd = Get-LivePid $WatchdogPidFile
        $sv = Get-LivePid $ServerPidFile
        if ($wd -or $sv) {
            Write-Output "Copydesk already running (watchdog pid $(if ($wd) { $wd } else { 'none' }), server pid $(if ($sv) { $sv } else { 'none' }))"
            exit 0
        }
        if (Test-Path $StopFile) { Remove-Item $StopFile -Force }
        $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Supervisor) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
        if ($proc) { Set-Content -Path $WatchdogPidFile -Value $proc.Id -Encoding ASCII }
        Start-Sleep -Seconds 1
        Write-Output "started watchdog pid $($proc.Id) - logs in $LogDir"
    }
    'stop' {
        New-Item -ItemType File -Force -Path $StopFile | Out-Null
        New-Item -ItemType File -Force -Path $GuardStop | Out-Null
        Stop-Tracked $ServerPidFile
        Stop-Tracked $WatchdogPidFile
        Stop-Tracked $GuardPidFile
        for ($i = 0; $i -lt 10; $i++) {
            if (-not (Get-LivePid $ServerPidFile) -and -not (Get-LivePid $WatchdogPidFile) -and -not (Get-LivePid $GuardPidFile)) { break }
            Start-Sleep -Seconds 1
        }
        Stop-Tracked $ServerPidFile
        Stop-Tracked $WatchdogPidFile
        Stop-Tracked $GuardPidFile
        if (Test-Path $ServerPidFile) { Remove-Item $ServerPidFile -Force -ErrorAction SilentlyContinue }
        if (Test-Path $WatchdogPidFile) { Remove-Item $WatchdogPidFile -Force -ErrorAction SilentlyContinue }
        if (Test-Path $GuardPidFile) { Remove-Item $GuardPidFile -Force -ErrorAction SilentlyContinue }
        Write-Output 'stopped'
    }
    'status' {
        $wd = Get-LivePid $WatchdogPidFile
        $sv = Get-LivePid $ServerPidFile
        $cg = Get-LivePid $GuardPidFile
        if ($wd) { Write-Output "watchdog running pid=$wd" } else { Write-Output 'watchdog not running' }
        if ($sv) { Write-Output "server running pid=$sv" } else { Write-Output 'server not running' }
        if ($cg) { Write-Output "credit-guard running pid=$cg" } else { Write-Output 'credit-guard not running' }
        if (Test-Listening) { Write-Output 'listening on 127.0.0.1:8787' } else { Write-Output 'not listening on 127.0.0.1:8787' }
    }
    'restart' {
        & $PSCommandPath stop
        & $PSCommandPath start
    }
}
