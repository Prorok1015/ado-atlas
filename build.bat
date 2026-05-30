@echo off
REM Bundle ADO Atlas into dist\ado-atlas-extension.zip (Chrome Web Store-ready).
REM Delegates to build.ps1 so the zip uses spec-correct forward-slash paths.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
if errorlevel 1 ( echo Build failed. & exit /b 1 )
