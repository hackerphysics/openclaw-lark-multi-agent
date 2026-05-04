@echo off
REM Install lark-multi-agent as a Windows Service using NSSM
REM Download NSSM from https://nssm.cc/download
REM Place nssm.exe in your PATH or same directory

SET SERVICE_NAME=lark-multi-agent
SET NODE_PATH=C:\Program Files\nodejs\node.exe
SET APP_DIR=%~dp0
SET APP_SCRIPT=%APP_DIR%dist\index.js
SET APP_ARGS=config.json

echo Installing %SERVICE_NAME%...
nssm install %SERVICE_NAME% "%NODE_PATH%" "%APP_SCRIPT%" %APP_ARGS%
nssm set %SERVICE_NAME% AppDirectory "%APP_DIR%"
nssm set %SERVICE_NAME% AppStdout "%APP_DIR%logs\stdout.log"
nssm set %SERVICE_NAME% AppStderr "%APP_DIR%logs\stderr.log"
nssm set %SERVICE_NAME% AppRotateFiles 1
nssm set %SERVICE_NAME% AppRotateBytes 10485760
nssm set %SERVICE_NAME% AppEnvironmentExtra NODE_ENV=production
nssm set %SERVICE_NAME% Start SERVICE_AUTO_START

echo Starting %SERVICE_NAME%...
nssm start %SERVICE_NAME%

echo Done. Use "nssm status %SERVICE_NAME%" to check.
pause
