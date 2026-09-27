@echo off
REM StemDeck one-time setup for Windows.
REM Requires: Python 3.11 (python.org, tick "Add python.exe to PATH") and Node.js 20 LTS or newer.
setlocal
cd /d "%~dp0\.."

echo === Checking prerequisites ===
where node >nul 2>nul || (echo ERROR: Node.js not found. Install the LTS version from https://nodejs.org then run this again. & goto :fail)
set PY=
py -3.11 --version >nul 2>nul && set PY=py -3.11
if not defined PY (python --version >nul 2>nul && set PY=python)
if not defined PY (echo ERROR: Python not found. Install Python 3.11 from https://www.python.org/downloads/windows/ and tick "Add python.exe to PATH". & goto :fail)
echo Using %PY%
%PY% --version
node --version

echo.
echo === 1/4  Creating Python environment (backend\.venv) ===
if not exist backend\.venv\Scripts\python.exe %PY% -m venv backend\.venv
if not exist backend\.venv\Scripts\python.exe (echo ERROR: could not create the Python environment. & goto :fail)
call backend\.venv\Scripts\activate.bat
python -m pip install --upgrade pip

echo.
echo === 2/4  Installing PyTorch (CPU build) and audio libraries - about 1.5 GB, be patient ===
REM For an NVIDIA GPU instead, replace the next line with the CUDA command from https://pytorch.org
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu || goto :fail
pip install -r backend\requirements-dev.txt || goto :fail

echo.
echo === 3/4  Downloading Rubber Band (high quality time-stretch, optional) ===
if not exist backend\bin mkdir backend\bin
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; try { $u='https://breakfastquay.com/files/releases/rubberband-3.3.0-gpl-executable-windows.zip'; $z=\"$env:TEMP\rb.zip\"; Invoke-WebRequest $u -OutFile $z; $d=\"$env:TEMP\rb\"; Expand-Archive $z $d -Force; Get-ChildItem $d -Recurse -Include *.exe,*.dll | Copy-Item -Destination 'backend\bin' -Force; Write-Host 'Rubber Band installed.' } catch { Write-Host 'Rubber Band download failed - StemDeck will use the standard stretcher. See README to install it manually.' }"

echo.
echo === 4/4  Installing the desktop app (npm) ===
pushd app
call npm install || (popd & goto :fail)
popd

echo.
echo Setup complete.
echo   Run the app:        scripts\run_dev.bat
echo   Build the installer: scripts\build_windows.bat
pause
exit /b 0

:fail
echo.
echo Setup did not finish - see the message above.
pause
exit /b 1
