@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\统一入口.ps1" %*
set "exitCode=%errorlevel%"

if "%~1"=="" (
  echo.
  set /p "postmanZhClose=脚本已结束。按 Enter 键关闭窗口..."
)
exit /b %exitCode%
