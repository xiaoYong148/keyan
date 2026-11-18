@echo off
setlocal
cd /d "%~dp0"
title LabMate - Research Data Agent

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 22+ is required.
  echo Install it from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 (
  echo.
  echo Node.js 22+ is required. Current version:
  node --version
  echo.
  pause
  exit /b 1
)

echo.
echo Starting LabMate...
echo Demo mode works without any API key.
echo If port 4173 is already in use, stop the other LabMate server first.
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:4173/'"
node server.mjs

echo.
echo LabMate server stopped.
pause
