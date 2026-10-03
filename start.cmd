@echo off
setlocal
cd /d "%~dp0"
set "CHRONICLE_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "CHRONICLE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%CHRONICLE_NODE%" scripts\launch.mjs
if errorlevel 1 pause
endlocal
