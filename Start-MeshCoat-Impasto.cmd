@echo off
setlocal
set "MESHCOAT_USER_DATA=%~dp0impasto-user-data"
set "MESHCOAT_MCP=0"
cd /d "%~dp0"
start "" "dist\win-unpacked\MeshCoat.exe"
