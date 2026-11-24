@echo off
rem Push to GitHub using the gh login token (see scripts\push.ps1).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\push.ps1" %*
pause
