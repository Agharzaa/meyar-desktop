@echo off
setlocal
cd /d "%~dp0"
if not exist package.json (
  echo [XETA] package.json tapilmadi. Bu fayli layihenin esas qovlugunda saxlayin.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo [XETA] Node.js tapilmadi.
  echo Node.js 24 LTS qurasdirildiqdan sonra bu fayli yeniden iki defe klik edin.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
if not exist node_modules (
  echo MEYAR ERP v1.15.0 ilk defe hazirlanir...
  call npm.cmd install
  if errorlevel 1 (
    echo [XETA] Paketler yuklenmedi.
    pause
    exit /b 1
  )
)
start "MEYAR ERP" /wait npm.cmd start
endlocal
