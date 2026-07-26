@echo off
title TeamZero Cloud (local)
cd /d "%~dp0"
color 0F
echo.
echo   TeamZero Cloud - local test server
echo   Opening http://localhost:8090
echo   (DEV_UNLOCK is on; uses local claude CLI until you add an API key.)
echo   Leave this window open. Close it to stop.
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8090"
node server.js
pause
