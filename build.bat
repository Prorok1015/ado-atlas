@echo off
REM Bundle the extension into a single zip for distribution.
REM Result: dist\ado-work-items-extension.zip — share with colleagues.
REM
REM Install on the colleague's machine:
REM   1. Unzip the archive.
REM   2. chrome://extensions, toggle "Developer mode".
REM   3. "Load unpacked", pick the unzipped folder.
REM   4. Click the icon, paste a PAT on first run.

setlocal
cd /d "%~dp0"

set OUT=dist\ado-work-items-extension.zip

if exist dist rmdir /s /q dist
mkdir dist

echo Packaging extension into %OUT%
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Compress-Archive -Path manifest.json,background.js,index.html,api.js,app.js,app.css,vendor,icons,README.md,LICENSE -DestinationPath '%OUT%' -Force"

if errorlevel 1 (
    echo Packaging failed.
    exit /b 1
)

echo.
echo ===========================================================
echo Done. Distributable: %OUT%
echo Send the zip to a colleague — no Python, no .exe install.
echo ===========================================================
endlocal
