@echo off
REM Starts the React dev server and Electron (which starts the Python engine automatically).
cd /d "%~dp0\..\app"
if not exist node_modules (echo Run scripts\setup_windows.bat first. & pause & exit /b 1)
call npm run dev
pause
