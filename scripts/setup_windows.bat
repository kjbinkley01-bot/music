@echo off
REM StemDeck one-time developer setup for Windows.
REM Requires: Python 3.11 (python.org, tick "Add to PATH") and Node.js 20 LTS or newer.
setlocal
cd /d "%~dp0\.."

echo.
echo === 1/4  Creating Python environment (backend\.venv) ===
py -3.11 -m venv backend\.venv 2>nul || python -m venv backend\.venv
if errorlevel 1 (echo Could not create a Python venv. Is Python 3.11 installed? & exit /b 1)
call backend\.venv\Scripts\activate.bat
python -m pip install --upgrade pip

echo.
echo === 2/4  Installing PyTorch (CPU build) and audio libraries ===
REM For an NVIDIA GPU instead, replace the next line with the CUDA command from https://pytorch.org
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 exit /b 1
pip install -r backend\requirements-dev.txt
if errorlevel 1 exit /b 1

echo.
echo === 3/4  Downloading Rubber Band (high quality time-stretch, optional) ===
if not exist backend\bin mkdir backend\bin
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; try { $u='https://breakfastquay.com/files/releases/rubberband-3.3.0-gpl-executable-windows.zip'; $z=\"$env:TEMP\rb.zip\"; Invoke-WebRequest $u -OutFile $z; $d=\"$env:TEMP\rb\"; Expand-Archive $z $d -Force; Get-ChildItem $d -Recurse -Include *.exe,*.dll | Copy-Item -Destination 'backend\bin' -Force; Write-Host 'Rubber Band installed.' } catch { Write-Host 'Rubber Band download failed - StemDeck will use the standard stretcher. See README to install it manually.' }"

echo.
echo === 4/4  Installing the desktop app (npm) ===
cd app
call npm install
if errorlevel 1 exit /b 1

echo.
echo Setup complete. Start StemDeck with:  scripts\run_dev.bat
endlocal
