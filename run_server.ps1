& node scripts/check-runtime.mjs --node-only
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$nodePath = (Get-Command node -ErrorAction Stop).Source

$env:TRANSPORT="http"
$env:LOG_LEVEL="silent"
$env:TOOL_PROFILE="full"
$env:HTTP_PORT="18600"
$env:HTTP_AUTH_DISABLED="true"
$env:HTTP_RATE_LIMIT_MAX="9999"
$env:BRIDGE_PORT="18601"
$env:BRIDGE_PORT_SCAN="18601,50100-50110"
Start-Process -WindowStyle Hidden -FilePath $nodePath -ArgumentList "dist/index.js" -WorkingDirectory "$PWD"
