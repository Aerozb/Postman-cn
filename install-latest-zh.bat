@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-postman-zh.ps1" -Latest -DisableUpdates -FixBrowserUrlHandler -Verify
pause
