@echo off
rem Build and run the app (normal use).
rem Uses node directly so it also works when the folder path contains "&".
cd /d "%~dp0"
node node_modules\electron-vite\bin\electron-vite.js build
if errorlevel 1 pause & exit /b 1
start "" "node_modules\electron\dist\electron.exe" .
