@echo off
setlocal EnableExtensions
title OpenWA + Status Dashboard Launcher
cd /d %~dp0

:: Resolve root workspace directory (supports running from root or scripts\ subfolder)
set "ROOT_DIR=%~dp0"
if exist "%~dp0..\..\OpenWA" (
    pushd "%~dp0..\..\" && (for /f "delims=" %%I in ('cd') do set "ROOT_DIR=%%I\") && popd
) else if exist "%~dp0..\OpenWA" (
    pushd "%~dp0..\" && (for /f "delims=" %%I in ('cd') do set "ROOT_DIR=%%I\") && popd
)

echo ========================================
echo   OpenWA + WhatsApp Status Dashboard
echo ========================================
echo.

:: Check if node is available
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Check administrator rights for Windows Firewall configuration
net session >nul 2>&1
set "IS_ADMIN="
if not errorlevel 1 set "IS_ADMIN=1"

if defined IS_ADMIN (
    echo [*] Administrator detected - configuring Windows Firewall for port 3000...
    netsh advfirewall firewall add rule name="WhatsApp Status Dashboard (3000)" dir=in action=allow protocol=TCP localport=3000 profile=Domain,Private,Public >nul 2>&1
    if not errorlevel 1 (
        echo [OK] Firewall rule added: inbound TCP 3000 allowed.
    ) else (
        echo [!] Firewall rule may already exist.
    )
) else (
    echo [!] Not running as administrator - skipping firewall configuration.
    echo     To access the dashboard from other PCs on your LAN, right-click this
    echo     file and choose "Run as administrator" once to open port 3000.
)
echo.

:: Quick probe: skip starting a service already answering on its port.
:: (Re-running while previous cmd windows are open would crash with
::  "address already in use".)
set "OPENWA_RUNNING="
set "DASH_RUNNING="
where curl >nul 2>&1
if not errorlevel 1 (
    curl -s -m 2 http://127.0.0.1:2785/ >nul 2>&1 && set "OPENWA_RUNNING=1"
    curl -s -m 2 http://127.0.0.1:3000/ >nul 2>&1 && set "DASH_RUNNING=1"
)

:: Detect Windows Terminal (wt.exe) to open services in tabs inside a single window
set "USE_WT="
where wt >nul 2>&1
if not errorlevel 1 set "USE_WT=1"

:: Target current WT window if already inside Windows Terminal, otherwise open a new window
set "WT_WINDOW=-w new"
if defined WT_SESSION set "WT_WINDOW=-w 0"

:: If both services need to start and Windows Terminal is available, launch them as tabs in one window
if not defined OPENWA_RUNNING if not defined DASH_RUNNING if defined USE_WT (
    echo [1/2] Starting OpenWA API on http://127.0.0.1:2785 ...
    echo [2/2] Starting WhatsApp Status Dashboard on http://0.0.0.0:3000 ...
    wt %WT_WINDOW% nt --title "OpenWA-API" -d "%ROOT_DIR%OpenWA" cmd /k "title OpenWA-API&& set PORT=2785&& set BIND_HOST=127.0.0.1&& set AUTO_START_SESSIONS=true&& node dist/main" ; nt --title "Status-Dashboard" -d "%ROOT_DIR%Whatsapp_Status_Dashboard\web-app" cmd /k "title Status-Dashboard&& ping 127.0.0.1 -n 4 >nul&& set PORT=3000&& set BIND_HOST=0.0.0.0&& set NODE_ENV=development&& set OPENWA_BASE_URL=http://localhost:2785&& set OPENWA_API_KEY=owa_k1_8b8333ea3cb9c88276c2995df17bdd2bfeb214b46241c6b77308ed543e0d8879&& node server.js"
    goto :services_started
)

:: Start OpenWA API (localhost only - not exposed to LAN)
if not defined OPENWA_RUNNING (
    echo [1/2] Starting OpenWA API on http://127.0.0.1:2785 ...
    if defined USE_WT (
        wt %WT_WINDOW% nt --title "OpenWA-API" -d "%ROOT_DIR%OpenWA" cmd /k "title OpenWA-API&& set PORT=2785&& set BIND_HOST=127.0.0.1&& set AUTO_START_SESSIONS=true&& node dist/main"
    ) else (
        start "OpenWA-API" cmd /k "cd /d ""%ROOT_DIR%OpenWA""&& set PORT=2785&& set BIND_HOST=127.0.0.1&& set AUTO_START_SESSIONS=true&& node dist/main"
    )
) else (
    echo [1/2] OpenWA API already running on http://127.0.0.1:2785
)

:: Give OpenWA a moment to bind its port before the dashboard tries to use it
ping 127.0.0.1 -n 4 >nul

:: Start WhatsApp Status Dashboard (LAN accessible via computer name)
if not defined DASH_RUNNING (
    echo [2/2] Starting WhatsApp Status Dashboard on http://0.0.0.0:3000 ...
    if defined USE_WT (
        wt %WT_WINDOW% nt --title "Status-Dashboard" -d "%ROOT_DIR%Whatsapp_Status_Dashboard\web-app" cmd /k "title Status-Dashboard&& set PORT=3000&& set BIND_HOST=0.0.0.0&& set NODE_ENV=development&& set OPENWA_BASE_URL=http://localhost:2785&& set OPENWA_API_KEY=owa_k1_8b8333ea3cb9c88276c2995df17bdd2bfeb214b46241c6b77308ed543e0d8879&& node server.js"
    ) else (
        start "Status-Dashboard" cmd /k "cd /d ""%ROOT_DIR%Whatsapp_Status_Dashboard\web-app""&& set PORT=3000&& set BIND_HOST=0.0.0.0&& set NODE_ENV=development&& set OPENWA_BASE_URL=http://localhost:2785&& set OPENWA_API_KEY=owa_k1_8b8333ea3cb9c88276c2995df17bdd2bfeb214b46241c6b77308ed543e0d8879&& node server.js"
    )
) else (
    echo [2/2] Status Dashboard already running on http://0.0.0.0:3000
)

:services_started
echo.
echo ========================================
echo   Services are starting...
echo ========================================
echo.
echo   OpenWA API:        http://127.0.0.1:2785  (localhost only)
echo   Status Dashboard:  http://0.0.0.0:3000    (LAN accessible)
echo   Share with colleague: http://TALLYSERVER-PC:3000
echo.
if defined USE_WT (
    echo   Both services opened in tabs inside a single Windows Terminal window:
    echo     [Tab 1] OpenWA-API
    echo     [Tab 2] Status-Dashboard
    echo   Switch between the tabs at the top of that window.
) else (
    echo   Two command windows have opened - one for each service.
    echo   Close either window to stop that service.
)
echo.
echo   Press any key to exit this launcher...
pause >nul
