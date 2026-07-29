param(
  [string]$PostmanDir,
  [switch]$Latest,
  [switch]$FixBrowserUrlHandler,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$installer = Join-Path $PSScriptRoot "install-postman-zh.ps1"
$installParams = @{
  DisableUpdates = $true
  Verify = $true
}

if ($PostmanDir) {
  $installParams.PostmanDir = $PostmanDir
}
if ($Latest) {
  $installParams.Latest = $true
}
if ($FixBrowserUrlHandler) {
  $installParams.FixBrowserUrlHandler = $true
}
if ($NoRestart) {
  $installParams.NoRestart = $true
}

& $installer @installParams
exit $LASTEXITCODE
