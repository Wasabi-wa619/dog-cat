@echo off
rem My Workspace を起動します（ブラウザが自動で開きます）
cd /d "%~dp0"
py -3 -m workspace %* || python -m workspace %*
pause
