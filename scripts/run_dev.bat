@echo off
REM Starts the React dev server and Electron (which starts the Python engine automatically).
cd /d "%~dp0\..\app"
call npm run dev
