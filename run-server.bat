@echo off
rem Runs the Copydesk server with its output captured, so a crash or a closed
rem window always leaves evidence. Started (minimized) by launch.bat, which also
rem works standalone.
rem This file sits in the repo root; %~dp0 already ends with a backslash.
cd /d "%~dp0"

rem Portable Node (if installed by install.bat) in front of PATH - the same
rem preflight launch.bat does, so this script also works when started directly.
rem Plain %PATH% (not !PATH!): this script has no delayed expansion, and the
rem literal "!PATH!" once wiped the real PATH, which hid powershell.exe and
rem broke the unattended wallet unlock.
for /d %%D in ("%LOCALAPPDATA%\zcode-tools\node-v*") do set "PATH=%%D;%PATH%"

rem Rotate once the log passes 5 MB; the previous run stays as .old.log.
if exist data\server.log for %%F in (data\server.log) do if %%~zF gtr 5000000 move /y data\server.log data\server.old.log >nul

echo Copydesk server starting; output is captured in data\server.log
pnpm start >> data\server.log 2>&1

echo.
echo SERVER STOPPED - the last lines of data\server.log hold the reason.
pause
