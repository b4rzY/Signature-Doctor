@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
node -e "if (!(Number(process.versions.node.split('.')[0]) >= 22)) process.exit(1)"
if errorlevel 1 (
  echo Please update Node.js to version 22 or newer.
  pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed. Check your connection and try npm ci.
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
