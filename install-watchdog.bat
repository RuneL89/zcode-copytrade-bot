@echo off
rem Installs the self-healing startup (re-runnable):
rem   1. "Copydesk watchdog" scheduled task - every 5 minutes, starts the server
rem      if it died. Created under THIS user, no Windows password stored.
rem   2. A Startup-folder shortcut - starts the server when you log on, so a
rem      laptop reboot brings the bot back without anyone clicking anything.
rem
rem Both run only while you are logged on. To also run before login (true
rem unattended reboot), run these once yourself in your own terminal - Windows
rem stores the password, never Copydesk:
rem   schtasks /Change /TN "Copydesk watchdog" /RU %USERNAME%
rem Remove any time with:
rem   schtasks /Delete /TN "Copydesk watchdog" /F
rem   del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Copydesk.lnk"

setlocal
cd /d "%~dp0"
set "HERE=%~dp0"

schtasks /Create /F /TN "Copydesk watchdog" /SC MINUTE /MO 5 /TR "wscript.exe \"%HERE%run-hidden.vbs\" \"%HERE%watchdog.bat\"" >nul
if errorlevel 1 (
  echo Could not create the "Copydesk watchdog" scheduled task.
  pause
  exit /b 1
)
echo Created scheduled task "Copydesk watchdog" (every 5 minutes, hidden).

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $startup = [Environment]::GetFolderPath('Startup'); $lnk = $ws.CreateShortcut((Join-Path $startup 'Copydesk.lnk')); $lnk.TargetPath = '%HERE%run-hidden.vbs'; $lnk.Arguments = '\"%HERE%launch.bat\"'; $lnk.WorkingDirectory = '%HERE%'; $lnk.Save()"
if errorlevel 1 (
  echo Could not create the Startup-folder shortcut.
  pause
  exit /b 1
)
echo Created Startup-folder shortcut "Copydesk.lnk" (starts at logon).

echo.
echo Done. The server starts at logon and is revived within 5 minutes whenever
echo it stops. Watchdog actions are logged in data\watchdog.log; the server's
echo own output in data\server.log.
pause
