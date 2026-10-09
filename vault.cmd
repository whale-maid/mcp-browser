@echo off
rem dsh credential vault - interactive menu. Double-click this file.
rem ASCII-only on purpose (cmd reads .cmd as ANSI).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0vault.ps1" %*
