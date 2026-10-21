@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ===============================================================
rem  IMPORTANT - THIS FILE MUST STAY ASCII-ONLY.
rem
rem  cmd.exe decodes .cmd files with the system ANSI codepage
rem  (GBK / cp936 on Chinese Windows), no matter what encoding the
rem  file is actually saved in. Non-ASCII text saved as UTF-8 gets
rem  decoded to garbage, which breaks `rem` lines and the quoting of
rem  `for /f` blocks. The previous version of this script stored
rem  Chinese comments as UTF-8 and therefore never ran once.
rem
rem  Do NOT add Chinese here. Do NOT add full-width punctuation.
rem  Keep every character within ASCII 0x20-0x7E.
rem ===============================================================

title Stop Knowledge-QA Agent

echo.
echo   Stopping Knowledge-QA Agent ...
echo.

rem Prefer "node" from PATH. An earlier version hardcoded the author's
rem private Node path (C:\Users\...\node.exe), which fails on every
rem other machine - and the user only sees a window that flashes past.
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js was not found.
  echo   Install Node.js 18.17 or newer from https://nodejs.org/
  echo   and make sure "node" is available on PATH, then run again.
  echo.
  pause
  exit /b 1
)

rem Resolve the effective port from .env by way of the Node helper,
rem so this script never hardcodes a port that drifts out of sync.
set "PORT="
for /f "usebackq delims=" %%p in (`"%NODE_EXE%" scripts\service.js port 2^>nul`) do set "PORT=%%p"
if not defined PORT set "PORT=8899"

rem Collect every PID listening on that exact port.
set "PIDS="
for /f "usebackq delims=" %%a in (`"%NODE_EXE%" scripts\service.js status 2^>nul`) do set "PIDS=!PIDS! %%a"

rem NOTE: avoid `goto` inside a parenthesised block - cmd resolves labels
rem within the block's scope and can fail with "cannot find the batch label".
rem Restructure with if/else + a called subroutine instead.
if defined PIDS (
  call :kill
) else (
  echo   Nothing is listening on port %PORT%.
  echo   The service does not appear to be running.
)

echo.
echo   Press any key to close this window.
pause >nul
exit /b 0

rem ---------------------------------------------------------------
rem  Terminate every process found on the port.
rem ---------------------------------------------------------------
:kill
echo   Found process on port %PORT%:!PIDS!
echo.

set "KILLED=0"
for %%p in (!PIDS!) do (
  taskkill /PID %%p /F >nul 2>&1
  if errorlevel 1 (
    echo   [WARN] Could not stop PID %%p.
    echo          Try running this script as Administrator.
  ) else (
    echo   Stopped PID %%p.
    set "KILLED=1"
  )
)

if "!KILLED!"=="1" (
  echo.
  echo   Service stopped. Port %PORT% is now free.
)
exit /b 0
