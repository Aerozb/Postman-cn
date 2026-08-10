@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\统一入口.ps1" %*
set "exitCode=%errorlevel%"

if "%~1"=="" (
  echo.
  echo 脚本已结束，窗口将在 5 秒后自动关闭；按任意键可提前关闭。
  timeout /t 5 >nul
)
exit /b %exitCode%
