@echo off
setlocal
cd /d "%~dp0"
node "%~dp0scripts\collect-zh-misses.js" %*
pause
