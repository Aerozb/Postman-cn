@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\统一入口.ps1" %*
set "exitCode=%errorlevel%"

if "%~1"=="" exit %exitCode%
exit /b %exitCode%
