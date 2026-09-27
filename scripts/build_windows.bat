@echo off
REM Builds a Windows installer (app\release\StemDeck Setup x.y.z.exe) with Python bundled inside.
setlocal
cd /d "%~dp0\..\backend"
call .venv\Scripts\activate.bat || (echo Run scripts\setup_windows.bat first & exit /b 1)
echo === Bundling the Python engine with PyInstaller ===
pyinstaller --noconfirm stemdeck-engine.spec
if errorlevel 1 exit /b 1
cd ..\app
echo === Building the Electron installer ===
call npm run dist
if errorlevel 1 exit /b 1
echo.
echo Installer written to app\release\
endlocal
