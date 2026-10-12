@echo off
rem Double-click to start The Crucible's desktop UI on Windows.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing packages...
  call npm install || goto :fail
)
if not exist vendor\forge (
  echo Downloading Forge card data, this takes a few minutes the first time...
  call npm run fetch-cards || goto :fail
)
call npm run ui
goto :eof

:fail
echo.
echo Setup failed. Make sure Node 20+ and Git for Windows are installed, then try again.
pause
