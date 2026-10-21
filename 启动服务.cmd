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
rem  `for /f` blocks.
rem
rem  Do NOT add Chinese here. Do NOT add full-width punctuation.
rem  Keep every character within ASCII 0x20-0x7E.
rem ===============================================================

title Knowledge-QA Agent - close this window to stop

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

rem Resolve the effective port from .env, so it can never drift out
rem of sync with server/config.js again.
set "PORT="
for /f "usebackq delims=" %%p in (`"%NODE_EXE%" scripts\service.js port 2^>nul`) do set "PORT=%%p"
if not defined PORT set "PORT=8899"

rem Already running? The helper does an EXACT port match, so ports
rem like 18899 / 88990 can no longer be mistaken for ours. The old
rem version used `findstr ":8899"`, which matched those by substring
rem and made the window flash and vanish.
rem
rem NOTE: do not `goto :done` from inside a parenthesised block - cmd
rem resolves labels within the block's scope and fails with
rem "cannot find the batch label". Restructure with `if not defined`.
set "RUNNING="
set "PIDS="
for /f "usebackq delims=" %%a in (`"%NODE_EXE%" scripts\service.js status 2^>nul`) do (
  set "RUNNING=1"
  set "PIDS=!PIDS! %%a"
)

if defined RUNNING (
  echo.
  echo   [i] Service is already running on port %PORT% ^(PID:!PIDS! ^).
  echo       Opening the page ...
  echo.
  explorer "http://127.0.0.1:%PORT%"
) else (
  call :launch
)

echo.
echo   Press any key to close this window.
pause >nul
exit /b 0

rem ---------------------------------------------------------------
rem  Start the server in the foreground. Falls through to the caller,
rem  so the pause above is the single exit point of this script.
rem ---------------------------------------------------------------
:launch
echo.
echo   ============================================
echo      Knowledge-QA Agent  -  starting
echo   ============================================
echo.
echo   URL: http://127.0.0.1:%PORT%
echo.
echo   The browser will open in about 3 seconds.
echo   Keep this window open - closing it stops the service.
echo.

rem Open the browser after a short delay so the server is ready.
rem NOTE: use explorer here, not `start "" http://...` - nesting the
rem empty title quotes inside an already-quoted cmd /c string closes
rem the outer quote early and breaks the whole line.
start "" /min cmd /c "timeout /t 3 >nul & explorer http://127.0.0.1:%PORT%"

"%NODE_EXE%" server\index.js
set "CODE=%errorlevel%"

echo.
if not "%CODE%"=="0" (
  echo   [ERROR] Server exited with code %CODE%.
  echo   Scroll up for the reason. Common causes:
  echo     - port %PORT% is taken by another program
  echo     - a dependency is missing: run "npm install"
  echo     - LLM_API_KEY is not set in .env
) else (
  echo   Server stopped.
)
exit /b 0
