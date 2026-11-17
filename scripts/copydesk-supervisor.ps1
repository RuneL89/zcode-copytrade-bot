# Restart loop for the Copydesk paper-mode server. Honors logs\copydesk.stop.
# Does not log secret values. Does not touch unrelated processes.
$ErrorActionPreference = 'Continue'
$Root = 'C:\Users\atavi\Documents\projects\copydesk'
$LogDir = Join-Path $Root 'logs'
$StopFile = Join-Path $LogDir 'copydesk.stop'
$ServerPidFile = Join-Path $LogDir 'copydesk-server.pid'
$WatchdogLog = Join-Path $LogDir 'watchdog.log'
$NodeDir = 'C:\Users\atavi\AppData\Local\zcode-tools\node-v24.22.1-win-x64'
$SecretsEnv = 'C:\Users\atavi\.copydesk-secrets\env'
$ServerJs = Join-Path $Root 'apps\server\dist\index.js'
$Meter = (Join-Path $Root 'scripts\helius-meter.mjs') -replace '\\', '/'
$GuardPy = Join-Path $Root 'scripts\credit-guard.py'
$GuardPidFile = Join-Path $LogDir 'credit-guard.pid'
$GuardStop = Join-Path $LogDir 'overnight-monitor.stop'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$env:Path = "$NodeDir;" + $env:Path
$env:NODE_ENV = 'production'
# OPS restart/shutdown use this flag: the supervisor owns the single worker,
# so a restart exits instead of spawning a second process that races the lock.
$env:COPYDESK_SUPERVISED = '1'
$env:HELIUS_METER_LOG = Join-Path $LogDir 'helius-credits.jsonl'
$env:FOMO_METER_LOG = Join-Path $LogDir 'fomo-credits.jsonl'
$env:NODE_OPTIONS = "--import file:///$Meter"

function Write-Watchdog([string]$msg) {
    $line = "$(Get-Date -Format o) $msg"
    Add-Content -Path $WatchdogLog -Value $line -Encoding UTF8
}

function Import-Secrets {
    if (-not (Test-Path $SecretsEnv)) { return }
    $lines = Get-Content -Path $SecretsEnv -ErrorAction Stop
    foreach ($line in $lines) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { continue }
        $name = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1)
        if ($name -eq '') { continue }
        Set-Item -Path "Env:$name" -Value $value
    }
}

function Get-LivePid([string]$pidFile) {
    if (-not (Test-Path $pidFile)) { return $null }
    $raw = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not $raw) { return $null }
    $p = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$p)) { return $null }
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc) { return $p }
    return $null
}

function Start-CreditGuard {
    if (Get-LivePid $GuardPidFile) { return }
    if (Test-Path $GuardStop) { Remove-Item $GuardStop -Force -ErrorAction SilentlyContinue }
    $proc = Start-Process -FilePath 'py' -ArgumentList @('-3', $GuardPy) -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $LogDir 'credit-guard-stdout.log') -RedirectStandardError (Join-Path $LogDir 'credit-guard-stderr.log')
    if ($proc) { Set-Content -Path $GuardPidFile -Value $proc.Id -Encoding ASCII }
    Write-Watchdog "credit-guard started pid $($proc.Id)"
}

Import-Secrets
Set-Location $Root
$commit = 'unknown'
try { $commit = (git -C $Root rev-parse --short HEAD 2>$null) } catch {}
$backoff = 5

while ($true) {
    if (Test-Path $StopFile) {
        Write-Watchdog 'stop file present - supervisor exiting'
        if (Test-Path $ServerPidFile) { Remove-Item $ServerPidFile -Force -ErrorAction SilentlyContinue }
        exit 0
    }
    Start-CreditGuard
    Write-Watchdog "starting copydesk server (commit $commit)"
    $server = Start-Process -FilePath (Join-Path $NodeDir 'node.exe') -ArgumentList @($ServerJs) -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $LogDir 'server.log') -RedirectStandardError (Join-Path $LogDir 'server.err.log')
    if (-not $server) {
        Write-Watchdog 'failed to start node'
        Start-Sleep -Seconds $backoff
        continue
    }
    Set-Content -Path $ServerPidFile -Value $server.Id -Encoding ASCII
    Write-Watchdog "server pid $($server.Id)"
    Wait-Process -Id $server.Id
    $code = $server.ExitCode
    if (Test-Path $ServerPidFile) { Remove-Item $ServerPidFile -Force -ErrorAction SilentlyContinue }
    Write-Watchdog "server exited code=$code"
    if (Test-Path $StopFile) {
        Write-Watchdog 'stop file present after exit - supervisor exiting'
        exit 0
    }
    Write-Watchdog "restarting in ${backoff}s"
    Start-Sleep -Seconds $backoff
    if ($backoff -lt 60) {
        $backoff = [Math]::Min(60, $backoff * 2)
    }
}
