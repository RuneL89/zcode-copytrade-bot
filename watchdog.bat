@echo off
rem Copydesk watchdog (scheduled every 5 minutes by install-watchdog.bat):
rem asks the dashboard's health endpoint; if nothing answers (connection
rem refused = the process is gone), starts the server again.
rem
rem A server that LISTENS but does not answer within 10s is left alone and only
rem logged: a hung event loop cannot be mid-swap (swaps are submitted from that
rem same loop), but it may be a slow GC spike, and killing it blind could turn a
rem finished trade into an unknown outcome. The next checks will show whether it
rem recovered.

cd /d "%~dp0"
rem An explicit OPS shutdown writes this file; never undo it.
if exist "logs\copydesk.stop" exit /b 0
set "LOG=data\watchdog.log"
set "STATE=data\watchdog.state"
rem Last known state: 1 = was healthy (default when no state file exists).
set /a LASTSTATE=1
if exist "%STATE%" set /p LASTSTATE=<"%STATE%"

curl -s -o nul --max-time 10 http://127.0.0.1:8787/api/bootstrap
set /a RC=%ERRORLEVEL%
if %RC% EQU 0 goto healthy
if %RC% EQU 28 goto hung
goto dead

:healthy
if %LASTSTATE% NEQ 1 echo %DATE% %TIME% server is back up >> "%LOG%"
(echo 1)>"%STATE%"
exit /b 0

:hung
echo %DATE% %TIME% server listening but no answer within 10s - NOT restarting (could interrupt an in-flight trade) >> "%LOG%"
(echo 2)>"%STATE%"
exit /b 0

:dead
echo %DATE% %TIME% server down (curl exit %RC%) - starting it >> "%LOG%"
start "Copydesk watchdog" /min cmd /c "%~dp0run-server.bat"
(echo 0)>"%STATE%"
exit /b 0
