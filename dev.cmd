@echo off
rem Start the app in development mode (hot reload).
rem Uses node directly so it also works when the folder path contains "&".
cd /d "%~dp0"
node node_modules\electron-vite\bin\electron-vite.js dev
