param(
  [string]$PostmanDir,
  [switch]$Latest,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$installer = Join-Path $PSScriptRoot "install-postman-zh.ps1"
$installParams = @{
  RestoreOriginal = $true
}

if ($PostmanDir) {
  $installParams.PostmanDir = $PostmanDir
}
if ($Latest) {
  $installParams.Latest = $true
}
if ($NoRestart) {
  $installParams.NoRestart = $true
}

& $installer @installParams
exit $LASTEXITCODE
