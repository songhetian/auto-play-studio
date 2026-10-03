@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo  Screen Guard - package as single EXE
echo  Output : %~dp0dist\ScreenGuard.exe
echo  Note   : packaged exe keeps its data (config.json / zones\ /
echo           notic_error.log) NEXT TO the exe, i.e. in dist\.
echo ============================================================

rem ---- Must use the system Python (has PyQt5); the Python first in
rem ---- PATH may be a managed one without the deps = broken exe.
set "PYEXE=D:\Program Files\FlyEnv-Data\env\python\python.exe"

echo.
echo [1/5] Check toolchain ...
if not exist "%PYEXE%" (
    echo       ERROR: Python not found: "%PYEXE%"
    echo       Edit PYEXE at the top of this script, then retry.
    pause
    exit /b 1
)
"%PYEXE%" -c "import PyQt5, cv2, numpy, mss, PyInstaller" >nul 2>&1
if errorlevel 1 (
    echo       ERROR: "%PYEXE%" is missing dependencies. Install with:
    echo       "%PYEXE%" -m pip install PyQt5 pyinstaller opencv-python mss
    pause
    exit /b 1
)
echo       OK: %PYEXE%

echo [2/5] Stop old ScreenGuard.exe and clean stale output ...
taskkill /f /t /im ScreenGuard.exe >nul 2>&1
ping -n 2 127.0.0.1 >nul

set RETRIES=0
:clean_loop
del /f /q "dist\ScreenGuard.exe" >nul 2>&1
if not exist "dist\ScreenGuard.exe" goto clean_ok
set /a RETRIES+=1
if %RETRIES% GTR 5 goto clean_fail
taskkill /f /t /im ScreenGuard.exe >nul 2>&1
ping -n 2 127.0.0.1 >nul
goto clean_loop
:clean_fail
echo  ERROR: cannot delete dist\ScreenGuard.exe, it may be running.
echo  Please close the app/tray icon, then run this script again.
exit /b 1
:clean_ok

echo [3/5] Check for running dev instances (python run.py) ...
rem wmic is removed on newer Win11 builds - use PowerShell CIM instead
powershell -NoProfile -Command "$hit=0; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'run\.py' } | ForEach-Object { $hit++; Write-Host ('      WARN: PID ' + $_.ProcessId + '  ' + $_.CommandLine) }; if ($hit -gt 0) { exit 1 } else { Write-Host '      OK: no dev instance running.'; exit 0 }"
if errorlevel 1 (
    echo       ^> Exit the instance(s) above first. A dev instance and the
    echo         packaged exe use DIFFERENT data dirs and lock files, so the
    echo         single-instance guard will NOT stop them running together
    echo         = double alarms.
)

set T0=%TIME%
echo [4/5] Packaging (one-file, no console window) ...
"%PYEXE%" -m PyInstaller --noconfirm --clean --onefile --noconsole ^
    --name "ScreenGuard" ^
    --hidden-import mss ^
    run.py

if errorlevel 1 (
    echo.
    echo  PACKAGE FAILED. Check errors above (missing deps / no compiler).
    exit /b 1
)

echo [5/5] Verify output ...
if not exist "dist\ScreenGuard.exe" (
    echo  ERROR: dist\ScreenGuard.exe not found although PyInstaller
    echo         reported success. Check the log above.
    exit /b 1
)
for %%F in ("dist\ScreenGuard.exe") do set /a EXE_MB=%%~zF / 1048576

echo.
echo ============================================================
echo  DONE.  Started %T0%  -  finished %TIME%
echo  Output : %~dp0dist\ScreenGuard.exe  (!EXE_MB! MB)
echo.
echo  First run creates config.json and zones\ next to the exe
echo  (in dist\). Configure monitors/alerts there once - it is
echo  separate from the "python run.py" data in the project root.
echo ============================================================
pause
