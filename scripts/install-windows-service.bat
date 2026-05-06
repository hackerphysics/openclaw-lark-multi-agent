@echo off
REM Install openclaw-lark-multi-agent as a Windows Service using NSSM.
REM Recommended for npm installs:
REM   npm install -g openclaw-lark-multi-agent
REM   openclaw-lark-multi-agent init
REM   openclaw-lark-multi-agent install-windows-service
REM
REM Download NSSM from https://nssm.cc/download and put nssm.exe in PATH.

SET SERVICE_NAME=openclaw-lark-multi-agent
SET STATE_DIR=%USERPROFILE%\.openclaw\openclaw-lark-multi-agent
SET CONFIG_PATH=%STATE_DIR%\config.json
SET DATA_DIR=%STATE_DIR%\data

IF NOT EXIST "%CONFIG_PATH%" (
  openclaw-lark-multi-agent init
)

where openclaw-lark-multi-agent >nul 2>nul
IF ERRORLEVEL 1 (
  echo openclaw-lark-multi-agent CLI not found in PATH.
  echo Run: npm install -g openclaw-lark-multi-agent
  pause
  exit /b 1
)

FOR /F "usebackq delims=" %%i IN (`where openclaw-lark-multi-agent`) DO (
  SET CLI_PATH=%%i
  GOTO :found_cli
)
:found_cli

echo Installing %SERVICE_NAME%...
nssm install %SERVICE_NAME% "%CLI_PATH%" start "%CONFIG_PATH%"
nssm set %SERVICE_NAME% AppDirectory "%STATE_DIR%"
nssm set %SERVICE_NAME% AppStdout "%STATE_DIR%\stdout.log"
nssm set %SERVICE_NAME% AppStderr "%STATE_DIR%\stderr.log"
nssm set %SERVICE_NAME% AppRotateFiles 1
nssm set %SERVICE_NAME% AppRotateBytes 10485760
nssm set %SERVICE_NAME% AppEnvironmentExtra NODE_ENV=production LMA_DATA_DIR="%DATA_DIR%"
nssm set %SERVICE_NAME% Start SERVICE_AUTO_START

echo Starting %SERVICE_NAME%...
nssm start %SERVICE_NAME%

echo Done. Use "nssm status %SERVICE_NAME%" to check.
pause
