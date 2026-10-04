@echo off
REM ============================================================================
REM  Jewelry ERP - desktop shortcut with SILENT printing (see docs/DEPLOYMENT.md section 9).
REM
REM  Creates "<SHORTCUT_NAME>.lnk" on the desktop of the CURRENT Windows user. It opens the ERP in
REM  Chrome (or Edge if Chrome is missing) as an app window, with:
REM    --kiosk-printing      print immediately, without the print window, to the default printer
REM    --user-data-dir=...   a dedicated browser profile (its own print settings, no extensions)
REM    --app=<url>           the ERP alone, without tabs or address bar
REM
REM  Silent printing gives NO success or failure message: if nothing comes out, check the printer
REM  and use "Reprint" (managers) - every reprint is marked COPY n and recorded.
REM
REM  Edit the three values below, save, then double-click this file once on the shop PC.
REM ============================================================================
setlocal

set "APP_URL=https://erp.example.com"
set "SHORTCUT_NAME=Jewelry ERP"
set "PROFILE_DIR=%LOCALAPPDATA%\JewelryERP\BrowserProfile"

REM Optional: 1 = also turn off browser headers/footers on printouts for this Windows user
REM (Chrome/Edge policy "PrintHeaderFooter" = 0). 0 = leave browser policies untouched.
set "DISABLE_HEADER_FOOTER=1"

set "BROWSER="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do (
  if not defined BROWSER if exist "%%~P" set "BROWSER=%%~P"
)
if not defined BROWSER (
  echo Chrome or Edge was not found. Install Google Chrome, then run this file again.
  pause
  exit /b 1
)

if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

if "%DISABLE_HEADER_FOOTER%"=="1" (
  reg add "HKCU\Software\Policies\Google\Chrome" /v PrintHeaderFooter /t REG_DWORD /d 0 /f >nul
  reg add "HKCU\Software\Policies\Microsoft\Edge" /v PrintHeaderFooter /t REG_DWORD /d 0 /f >nul
)

REM The values travel to PowerShell as environment variables: no quoting problems with spaces.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "$l = $w.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), $env:SHORTCUT_NAME + '.lnk'));" ^
  "$l.TargetPath = $env:BROWSER;" ^
  "$l.Arguments = '--kiosk-printing --no-first-run --user-data-dir=' + [char]34 + $env:PROFILE_DIR + [char]34 + ' --app=' + $env:APP_URL;" ^
  "$l.WorkingDirectory = Split-Path $env:BROWSER;" ^
  "$l.IconLocation = $env:BROWSER + ',0';" ^
  "$l.Save()"
if errorlevel 1 (
  echo The shortcut could not be created.
  pause
  exit /b 1
)

echo.
echo Shortcut "%SHORTCUT_NAME%" created on the desktop.
echo   Browser : %BROWSER%
echo   Address : %APP_URL%
echo   Profile : %PROFILE_DIR%
echo.
echo Before the first sale:
echo   1. Make the receipt printer the DEFAULT printer in Windows (Settings - Printers).
echo   2. Close every window of the browser, open the ERP with the new shortcut.
echo   3. Settings - Printing - "Test print": the ruler must reach both paper edges.
pause
