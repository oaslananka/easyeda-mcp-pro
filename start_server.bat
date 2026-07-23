@echo off
set TRANSPORT=http
set LOG_LEVEL=silent
set TOOL_PROFILE=full
set HTTP_PORT=18600
set HTTP_AUTH_DISABLED=true
set HTTP_RATE_LIMIT_MAX=9999
set BRIDGE_PORT=18601
set BRIDGE_PORT_SCAN=18601
node scripts\check-runtime.mjs --node-only || exit /b 1
start /B node dist/index.js
