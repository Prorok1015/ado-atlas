@echo off
REM Bundle ADO Atlas into dist\ado-atlas-extension.zip (Chrome Web Store-ready).
node "%~dp0tools\build.js"
if errorlevel 1 ( echo Build failed. & exit /b 1 )
