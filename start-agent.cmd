@echo off
rem Starts the prodProcess PC agent. Put a shortcut to this file in shell:startup to run it at login.
cd /d "%~dp0"
title prodProcess agent
node agent\agent.mjs
pause
