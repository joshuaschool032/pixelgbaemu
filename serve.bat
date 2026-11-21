@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title PixelGBA launcher

set "PORT=8080"
if not "%~1"=="" set "PORT=%~1"

echo ==========================================================
echo   PixelGBA - starting the local server
echo   Folder: %CD%
echo   Port:   %PORT%
echo ==========================================================
echo.

rem ---- the launcher must sit next to index.html -------------------------
if not exist "index.html" (
  echo [X] index.html was not found in this folder.
  echo     Keep serve.bat together with index.html and run it again.
  echo.
  pause
  exit /b 1
)

rem ---- pick a runtime by ACTUALLY testing it (not just "where") ----------
set "RUN="
set "KIND="

py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 (
  set "RUN=py -3 -m http.server %PORT%"
  set "KIND=Python launcher (py)"
)

if not defined RUN (
  node -e "process.exit(0)" >nul 2>&1
  if not errorlevel 1 (
    set "RUN=node serve.js %PORT%"
    set "KIND=Node.js"
  )
)

if not defined RUN (
  python -c "import sys" >nul 2>&1
  if not errorlevel 1 (
    set "RUN=python -m http.server %PORT%"
    set "KIND=Python"
  )
)

if not defined RUN (
  set "RUN=__POWERSHELL__"
  set "KIND=PowerShell (built-in fallback)"
)

echo   Using: !KIND!
echo.

rem ---- start the server in its own window so it keeps running -----------
if "!RUN!"=="__POWERSHELL__" (
  start "PixelGBA server" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port %PORT%
) else (
  start "PixelGBA server" /min cmd /c "!RUN!"
)

rem ---- wait until the port really answers, then open the browser --------
echo   Waiting for http://localhost:%PORT% ...
set /a TRIES=0

:wait
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', %PORT%); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto ready
set /a TRIES+=1
if !TRIES! LSS 2 (
  rem give PowerShell a little longer on first run - it is slow to start
  goto wait
)
if !TRIES! LSS 20 goto wait

echo.
echo ----------------------------------------------------------
echo [X] The server did not come up on port %PORT%.
echo.
echo   * A minimized window called "PixelGBA server" holds the
echo     real error message - open it and read the last lines.
echo   * The port may be taken by another program. Try:
echo         serve.bat 8081
echo   * Or serve the folder with Python directly:
echo         py -3 -m http.server 8080
echo ----------------------------------------------------------
echo.
pause
exit /b 1

:ready
echo   Server is up.
start "" "http://localhost:%PORT%/"
echo.
echo ==========================================================
echo   Your browser is opening http://localhost:%PORT%/
echo.
echo   * Leave the minimized "PixelGBA server" window running
echo     while you play - closing it stops the emulator server.
echo   * This launcher window can be closed now.
echo ==========================================================
echo.
timeout /t 8 >nul
exit /b 0
