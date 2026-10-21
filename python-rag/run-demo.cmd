@echo off
rem ===========================================================================
rem  Python RAG demo -- double-click this file.
rem
rem  IMPORTANT: THIS FILE MUST STAY PURE ASCII. DO NOT TRANSLATE THESE LINES.
rem  cmd.exe decodes .cmd files using the system ANSI code page (GBK on a
rem  Chinese Windows), regardless of the file's real on-disk encoding.
rem  Chinese text saved as UTF-8 would turn into garbage here, which breaks
rem  the parser (stray quotes swallow whole lines); the window would then
rem  flash and close before you could read anything.
rem  `chcp 65001` does NOT help -- it changes the console streams only, not
rem  how the script itself is decoded.
rem
rem  All the actual work (and all Chinese output) lives in demo.py, which is
rem  a normal UTF-8 Python source file and has none of these problems.
rem ===========================================================================

setlocal
rem Self-locate: always run from the folder that contains this file.
cd /d "%~dp0"

rem Force UTF-8 inside Python.
rem On a Chinese Windows the default text encoding is GBK. Printing to a real
rem console happens to work anyway (Python uses the wide-char console API),
rem but the moment the output is PIPED OR REDIRECTED Python falls back to GBK
rem and raises UnicodeEncodeError on characters such as the section separator
rem used in the chunk headings. Setting this removes that whole failure class.
set PYTHONUTF8=1

rem ---- pick an interpreter ------------------------------------------------
set PY=
if exist "%~dp0.venv\Scripts\python.exe" set PY=%~dp0.venv\Scripts\python.exe
if not defined PY if exist "%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe" set PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe
if not defined PY set PY=python

echo interpreter: %PY%
echo.

"%PY%" demo.py
if errorlevel 1 goto :fail
goto :done

:fail
echo.
echo ---------------------------------------------------------------------------
echo FAILED. Read the messages above.
echo Common causes:
echo   - missing packages :  pip install -r requirements.txt
echo   - no API key       :  fill LLM_API_KEY in ..\.env  (this demo works anyway)
echo ---------------------------------------------------------------------------

:done
echo.
pause
