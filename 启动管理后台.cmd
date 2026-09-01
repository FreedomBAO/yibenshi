@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)
node tools\cover-admin-server.js %*
if errorlevel 1 (
  echo.
  echo [错误] 管理后台启动失败，请检查上方提示。
  pause
)
