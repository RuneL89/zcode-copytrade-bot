@echo off
rem ===========================================================================
rem  ZCode Bot - enable phone (LAN) access
rem  Adds the Windows Firewall inbound rule for the dashboard port and prints
rem  the URL to open on your phone. Needs one administrator approval (UAC).
rem  Safe to run more than once.
rem ===========================================================================
setlocal EnableDelayedExpansion
set "PORT=8787"
set "RULE=ZCode Bot LAN %PORT%"

net session >nul 2>nul
if errorlevel 1 (
  echo Requesting administrator permission...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

echo ============================================================
echo   ZCODE BOT - PHONE ACCESS SETUP
echo ============================================================
echo.

rem 1. Firewall rule for this port (both network profiles).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='SilentlyContinue'; $n='%RULE%'; if (Get-NetFirewallRule -DisplayName $n) { Remove-NetFirewallRule -DisplayName $n }; New-NetFirewallRule -DisplayName $n -Direction Inbound -Protocol TCP -LocalPort %PORT% -Action Allow -Profile Private,Public -Description 'ZCode Bot dashboard (LAN)' | Out-Null; if (Get-NetFirewallRule -DisplayName $n) { 'OK: firewall rule installed' } else { 'ERROR: could not install the firewall rule' }"

rem 2. Make sure the server is configured to listen on the network.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$envFile='%~dp0.env'; if (Test-Path $envFile) { $t=Get-Content -Raw $envFile; if ($t -match '(?m)^HOST=127\.0\.0\.1') { $t = $t -replace '(?m)^HOST=.*$','HOST=0.0.0.0'; Set-Content -Path $envFile -Value $t -Encoding UTF8; 'OK: HOST set to 0.0.0.0 in .env' } elseif ($t -match '(?m)^HOST=0\.0\.0\.0') { 'OK: HOST already 0.0.0.0' } else { 'NOTE: check HOST in .env manually' } } else { 'ERROR: .env not found - run install.bat first' }"

echo.
echo This PC's addresses:
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '172.*' } | ForEach-Object { '   http://' + $_.IPAddress + ':%PORT%   (' + $_.InterfaceAlias + ')' }"

echo.
echo ============================================================
echo   Open one of those URLs on your phone, on the SAME Wi-Fi.
echo   Traffic is plain HTTP on your home network - use a strong
echo   password. Do not expose this port to the internet.
echo ============================================================
echo.
echo Restarting ZCode Bot so the new network setting takes effect...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
"%SystemRoot%\System32\timeout.exe" /t 2 /nobreak >nul
rem cmd quoting: a path with spaces needs doubled quotes inside start, not backslashes.
start "" /min cmd /c ""%~dp0launch.bat""
echo.
echo Done. Give the server a few seconds, then open the URL on your phone.
pause
