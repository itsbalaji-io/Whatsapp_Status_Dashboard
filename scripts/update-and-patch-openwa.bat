@echo off
setlocal EnableExtensions
title Update OpenWA and Reapply Custom Dashboard Patches
cd /d %~dp0

echo ========================================================
echo   OpenWA Updater and Custom Status Fix Auto-Patcher
echo ========================================================
echo.

:: Resolve root workspace directory (supports running from root or scripts\ subfolder)
set "ROOT_DIR=%~dp0"
if exist "%~dp0..\..\OpenWA" (
    pushd "%~dp0..\..\" && (for /f "delims=" %%I in ('cd') do set "ROOT_DIR=%%I\") && popd
) else if exist "%~dp0..\OpenWA" (
    pushd "%~dp0..\" && (for /f "delims=" %%I in ('cd') do set "ROOT_DIR=%%I\") && popd
)

set "OPENWA_DIR=%ROOT_DIR%OpenWA"
set "PATCH_FILE=%ROOT_DIR%Whatsapp_Status_Dashboard\patches\status-broadcast.patch"
set "BACKUP_TS=%ROOT_DIR%Whatsapp_Status_Dashboard\patches\baileys-status.ts"

if not exist "%OPENWA_DIR%" (
    echo [ERROR] OpenWA directory not found at "%OPENWA_DIR%"
    pause
    exit /b 1
)

echo [1/4] Checking OpenWA repository status...
cd /d "%OPENWA_DIR%"

:: Check git
where git >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git is not installed or not in PATH.
    pause
    exit /b 1
)

:: Pull latest OpenWA updates
echo [2/4] Pulling latest updates from upstream OpenWA...
git pull origin main
if errorlevel 1 (
    echo [!] Direct pull had conflicts or local commits.
)

echo.
echo [3/4] Applying custom WhatsApp Status Broadcast patch...
:: Check if fix is already present in source code
findstr /c:"Broadcasting status revoke" "src\engine\adapters\baileys-status.ts" >nul 2>&1
if not errorlevel 1 (
    echo [OK] Status broadcast fix is already present in source code.
) else (
    :: Try applying git patch first
    git apply --check "%PATCH_FILE%" >nul 2>&1
    if not errorlevel 1 (
        git apply "%PATCH_FILE%"
        echo [OK] Patch applied cleanly via git apply.
    ) else (
        echo [!] Git patch had line differences. Using drop-in source replacement...
        copy /y "%BACKUP_TS%" "src\engine\adapters\baileys-status.ts" >nul
        echo [OK] Drop-in replacement copied successfully.
    )
)

echo.
echo [4/4] Rebuilding OpenWA (nest build)...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed! Please inspect the errors above.
    pause
    exit /b 1
)

echo.
echo ========================================================
echo   [SUCCESS] OpenWA updated and patched successfully!
echo   All future status deletions will broadcast to contacts.
echo ========================================================
echo.
pause
