@echo off
REM Builds a Windows installer (app\release\StemDeck Setup x.y.z.exe) with Python bundled inside.
setlocal
cd /d "%~dp0\.."

if not exist backend\.venv\Scripts\activate.bat (echo ERROR: run scripts\setup_windows.bat first - the Python environment is missing. & goto :fail)
if not exist app\node_modules (echo ERROR: run scripts\setup_windows.bat first - the app's npm packages are missing. & goto :fail)

call backend\.venv\Scripts\activate.bat
echo === 1/2  Bundling the Python engine with PyInstaller (several minutes) ===
pushd backend
pyinstaller --noconfirm stemdeck-engine.spec || (popd & goto :fail)
popd
if not exist backend\dist\stemdeck-engine\stemdeck-engine.exe (echo ERROR: engine bundle was not created. & goto :fail)

echo.
echo === 2/2  Building the Electron installer ===
pushd app
call npm run dist || (popd & goto :fail)
popd

echo.
echo Done! Installer:  %CD%\app\release\
dir /b app\release\*.exe
explorer app\release
pause
exit /b 0

:fail
echo.
echo Build did not finish - see the message above.
pause
exit /b 1
