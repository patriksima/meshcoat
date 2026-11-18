@echo off
setlocal
set "MESHCOAT_USER_DATA=%~dp0impasto-user-data"
set "MESHCOAT_MCP=1"
cd /d "%~dp0"
if exist "dist\win-unpacked\MeshCoat.exe" (
  start "" "dist\win-unpacked\MeshCoat.exe"
) else (
  node mcp\launch.mjs
)
