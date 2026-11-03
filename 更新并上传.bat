@echo off
chcp 65001 >nul
title Blind Hunt - Update and Upload
cd /d "%~dp0"
set "PSEXE=powershell"
where pwsh >nul 2>&1 && set "PSEXE=pwsh"
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\publish.ps1" %*
echo.
pause
