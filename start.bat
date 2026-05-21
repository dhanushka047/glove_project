@echo off
:: ============================================================
::  start.bat — SignGlove one-click launcher (Windows)
::  Usage: double-click  OR  start.bat [port]
:: ============================================================

setlocal enabledelayedexpansion

:: Port (default 3000, or pass as argument)
set PORT=3000
if not "%~1"=="" set PORT=%~1

:: Paths
set "SCRIPT_DIR=%~dp0"
set "SERVER_DIR=%SCRIPT_DIR%server"

echo.
echo  =========================================
echo   ^🧤  SignGlove Dashboard
echo       Sign Language Detection System
echo  =========================================
echo.

:: ── Check Node.js ─────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found!
    echo  Please install from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [OK]  Node.js %NODE_VER%

:: ── Install dependencies if needed ────────────────────────
if not exist "%SERVER_DIR%\node_modules" (
    echo  [..] Installing dependencies...
    cd /d "%SERVER_DIR%"
    call npm install --silent
    if %errorlevel% neq 0 (
        echo  [ERROR] npm install failed
        pause
        exit /b 1
    )
    echo  [OK]  Dependencies installed
) else (
    echo  [OK]  Dependencies ready
)

:: ── Get local IP ──────────────────────────────────────────
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set LOCAL_IP=%%a
    goto :got_ip
)
:got_ip
:: Trim leading space
set LOCAL_IP=%LOCAL_IP: =%

:: Handle multiple IPs — just use the first one
for /f "tokens=1" %%i in ("%LOCAL_IP%") do set LOCAL_IP=%%i

echo.
echo  =========================================
echo   ^🌐  Web Dashboard
echo       http://localhost:%PORT%
echo.
echo   ^📡  On your local network:
echo       http://%LOCAL_IP%:%PORT%
echo.
echo   ^🔌  ESP32 firmware - update this line:
echo       SERVER_HOST = "%LOCAL_IP%"
echo  =========================================
echo.
echo  Press Ctrl+C to stop the server
echo.

:: ── Open browser after short delay ────────────────────────
start "" /b cmd /c "timeout /t 2 >nul && start http://localhost:%PORT%"

:: ── Start server ──────────────────────────────────────────
cd /d "%SERVER_DIR%"
set PORT=%PORT%
node server.js

if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] Server exited with an error.
    echo  If port %PORT% is in use, run: start.bat 3001
    pause
)
