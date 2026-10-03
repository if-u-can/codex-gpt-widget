@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "GPT_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%GPT_NODE%" set "GPT_NODE=node"
"%GPT_NODE%" scripts\start-widget.mjs
if errorlevel 1 pause
