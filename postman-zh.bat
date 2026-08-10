@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\postman-zh.ps1" %*
set "exitCode=%errorlevel%"

if "%~1"=="" pause
exit /b %exitCode%
