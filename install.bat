@echo off
setlocal EnableDelayedExpansion
title ZCode Bot - Installer
cd /d "%~dp0"
set "ROOT=%~dp0"
set "NODE_DIR=%LOCALAPPDATA%\zcode-tools"
set "TIMEOUT_EXE=%SystemRoot%\System32\timeout.exe"

echo ============================================================
echo   ZCODE BOT - one-click installer (Windows, no admin)
echo   Repo: %ROOT%
echo ============================================================
echo.

rem ---- 1. Node.js -----------------------------------------------------------
set "NODE_EXE="
set "NODE_HOME="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE (
  for /d %%D in ("%NODE_DIR%\node-v*") do (
    if exist "%%D\node.exe" (
      set "NODE_EXE=%%D\node.exe"
      set "NODE_HOME=%%D"
    )
  )
)
if defined NODE_EXE (
  echo [1/7] Node.js found: !NODE_EXE!
) else (
  echo [1/7] Node.js not found - installing a portable, user-local copy...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; $dir='%NODE_DIR%'; New-Item -ItemType Directory -Force -Path $dir | Out-Null; $rel=Invoke-RestMethod https://nodejs.org/dist/index.json; $lts=($rel | Where-Object { $_.lts } | Select-Object -First 1).version; Write-Host ('  downloading Node '+$lts); Invoke-WebRequest ('https://nodejs.org/dist/'+$lts+'/node-'+$lts+'-win-x64.zip') -OutFile ($dir+'\node.zip'); tar -xf ($dir+'\node.zip') -C $dir; Remove-Item ($dir+'\node.zip')"
  if errorlevel 1 (
    echo   ERROR: automatic download failed. Install Node LTS from https://nodejs.org and re-run.
    goto :fail
  )
  for /d %%D in ("%NODE_DIR%\node-v*") do (
    if exist "%%D\node.exe" (
      set "NODE_EXE=%%D\node.exe"
      set "NODE_HOME=%%D"
    )
  )
  if not defined NODE_EXE (
    echo   ERROR: Node extracted but not found. Re-run this installer.
    goto :fail
  )
  powershell -NoProfile -Command ^
    "$p=[Environment]::GetEnvironmentVariable('PATH','User'); $d='%NODE_HOME%'; if(($p -split ';') -notcontains $d){[Environment]::SetEnvironmentVariable('PATH', ($p.TrimEnd(';')+';'+$d), 'User')}"
  set "PATH=!NODE_HOME!;%PATH%"
  echo   Node installed to %NODE_HOME% and added to your user PATH.
)
if defined NODE_HOME set "PATH=!NODE_HOME!;!PATH!"

rem ---- 2. pnpm ---------------------------------------------------------------
echo [2/7] Checking pnpm...
call pnpm --version >nul 2>nul
if errorlevel 1 (
  echo   Installing pnpm into the local Node prefix...
  call npm install -g pnpm --no-fund --no-audit
  call pnpm --version >nul 2>nul
  if errorlevel 1 (
    echo   ERROR: could not install pnpm. Run: npm install -g pnpm
    goto :fail
  )
)
for /f "delims=" %%V in ('call pnpm --version') do set "PNPM_VERSION=%%V"
echo   pnpm !PNPM_VERSION! ready.

rem ---- 3. dependencies ---------------------------------------------------------
echo [3/7] Installing dependencies (this can take a few minutes)...
call pnpm install
if errorlevel 1 (
  echo   ERROR: pnpm install failed.
  goto :fail
)

rem ---- 4. build ------------------------------------------------------------------
echo [4/7] Building all packages...
call pnpm build
if errorlevel 1 (
  echo   ERROR: build failed.
  goto :fail
)

rem ---- 5. configuration -----------------------------------------------------------
rem The server refuses to start without SESSION_SECRET. Generate a local one so the
rem app is launchable immediately; never overwrite an existing .env.
echo [5/7] Preparing local configuration (.env)...
if exist "%ROOT%.env" (
  echo   .env already exists - keeping it untouched.
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$src='%ROOT%.env.example'; $dst='%ROOT%.env'; if(-not (Test-Path $src)){ throw '.env.example is missing' }; $b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $secret=([Convert]::ToBase64String($b) -replace '[+/=]',''); $txt=Get-Content -Raw $src; $txt=$txt -replace '(?m)^SESSION_SECRET=.*$', ('SESSION_SECRET='+$secret); $txt=$txt -replace '(?m)^DATA_DIR=.*$', 'DATA_DIR=./data'; Set-Content -Path $dst -Value $txt -Encoding UTF8"
  if errorlevel 1 (
    echo   ERROR: could not create .env from .env.example.
    goto :fail
  )
  echo   Created .env with a freshly generated SESSION_SECRET.
  echo   API keys are NOT set yet - add them in Settings/OPS when you need paper or live data.
)

rem ---- 6. database -------------------------------------------------------------
echo [6/7] Creating the database...
call pnpm db:migrate
if errorlevel 1 (
  echo   ERROR: migration failed.
  goto :fail
)
set /p SEED="      Import example candidates too? [y/N] "
if /i "!SEED!"=="y" call pnpm db:seed

rem ---- 7. shortcuts --------------------------------------------------------------
echo [7/7] Creating Start Menu + Desktop shortcuts...
call :make_shortcuts

echo.
echo ============================================================
echo   DONE. Use the "ZCode Bot" shortcut to launch the app,
echo   or double-click launch.bat. No terminal needed.
echo   First launch prints a one-time setup token in its window.
echo ============================================================
set /p STARTNOW="Start ZCode Bot now? [Y/n] "
if /i not "!STARTNOW!"=="n" (
  start "ZCode Bot" /min cmd /c "%ROOT%launch.bat"
)
exit /b 0

:make_shortcuts
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws=New-Object -ComObject WScript.Shell; $root='%ROOT%'; $sm=[Environment]::GetFolderPath('StartMenu')+'\Programs\ZCode Bot'; New-Item -ItemType Directory -Force -Path $sm | Out-Null; foreach($loc in @($sm, [Environment]::GetFolderPath('Desktop'))){ $s=$ws.CreateShortcut(($loc+'\ZCode Bot.lnk')); $s.TargetPath=$root+'launch.bat'; $s.WorkingDirectory=$root; $s.Description='ZCode Bot copy-trading dashboard'; $s.WindowStyle=7; $s.Save() }"
exit /b 0

:fail
echo.
echo   Installation FAILED - fix the error above and re-run install.bat
pause
exit /b 1
