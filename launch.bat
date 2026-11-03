@echo off
rem ZCode Bot launcher: starts the server if it is not already running,
rem then opens the dashboard in the default browser. Safe to re-run.
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "ROOT=%~dp0"
set "PORT=8787"
set "TIMEOUT_EXE=%SystemRoot%\System32\timeout.exe"
set "NETSTAT_EXE=%SystemRoot%\System32\netstat.exe"
set "FINDSTR_EXE=%SystemRoot%\System32\findstr.exe"

rem Portable Node (if installed by install.bat) in front of PATH
for /d %%D in ("%LOCALAPPDATA%\zcode-tools\node-v*") do set "PATH=%%D;!PATH!"

rem Preflight: the server cannot start without a local .env.
rem NOTE: never put parentheses inside a parenthesised if-block - cmd parses the
rem whole block upfront and the stray ")" aborts the script.
if not exist "%ROOT%.env" (
  echo ZCode Bot is not configured yet - no .env file found.
  echo Double-click install.bat in this folder once, then use this shortcut again.
  pause
  exit /b 1
)

rem Already running?
"%NETSTAT_EXE%" -ano | "%FINDSTR_EXE%" /r /c:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo ZCode Bot is already running on port %PORT% - opening the dashboard...
  rem Dashboard auto-open disabled: it spawns personal Chrome, which locks the profile copy used by the Fomo adapter. Open http://127.0.0.1:8787 manually.
  "%TIMEOUT_EXE%" /t 2 /nobreak >nul
  exit /b 0
)

echo Starting ZCode Bot (the minimized "ZCode Bot server" window keeps it alive)...
rem The server's output is captured in data\server.log (run-server.bat), so a
rem crash or a closed window always leaves evidence of why it stopped.
start "ZCode Bot server" /min cmd /c "%~dp0run-server.bat"

rem Wait for the port, then open the dashboard.
set /a TRIES=0
:waitport
"%TIMEOUT_EXE%" /t 1 /nobreak >nul
"%NETSTAT_EXE%" -ano | "%FINDSTR_EXE%" /r /c:":%PORT% .*LISTENING" >nul 2>nul
if errorlevel 1 (
  set /a TRIES+=1
  if !TRIES! lss 60 goto :waitport
  echo Server did not start within 60s - check the minimized "ZCode Bot server" window.
  pause
  exit /b 1
)
rem Dashboard auto-open disabled: it spawns personal Chrome, which locks the profile copy used by the Fomo adapter. Open http://127.0.0.1:8787 manually.
echo Dashboard opened. You can close this window.
"%TIMEOUT_EXE%" /t 3 /nobreak >nul
exit /b 0
