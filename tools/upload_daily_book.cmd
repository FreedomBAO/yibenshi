@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  python "%~dp0upload_daily_book.py" %*
  exit /b !ERRORLEVEL!
)

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  py -3 "%~dp0upload_daily_book.py" %*
  exit /b !ERRORLEVEL!
)

set "CODEX_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if exist "%CODEX_PYTHON%" (
  "%CODEX_PYTHON%" "%~dp0upload_daily_book.py" %*
  exit /b !ERRORLEVEL!
)

echo {"ok":false,"error":"No usable Python interpreter was found."} 1>&2
exit /b 1
