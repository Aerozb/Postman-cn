# 启动 Postman，等待 CDP 调试端口可用，并输出本次启动的实际端口。
# 使用 --remote-debugging-port=0 时端口每次都会变化，不能复用旧值。
# 用法：
#   .\postman-zh.bat start
#   .\postman-zh.bat start -TimeoutSec 90

param(
  [string]$PostmanDir = "",       # app-x.y.z dir; auto-detected if empty
  [ValidateRange(1, 3600)]
  [int]$TimeoutSec   = 60,        # max seconds to wait for the page
  [switch]$NoWait                 # launch only, do not wait for the page
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "进程工具.ps1")

# --- Locate Postman.exe ---
# Auto-detect the Squirrel install root (the dir that holds app-x.y.z folders).
# Search order: the official per-user install location, then each ancestor of
# this script (so it works whether the repo sits beside the install or elsewhere).
if (-not $PostmanDir) {
  $candidates = @()
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Postman') }
  $d = Split-Path -Parent $PSCommandPath
  while ($d) { $candidates += $d; $parent = Split-Path -Parent $d; if ($parent -eq $d) { break }; $d = $parent }

  foreach ($base in $candidates) {
    if (-not (Test-Path -LiteralPath $base)) { continue }
    $appDirs = Get-ChildItem -LiteralPath $base -Directory -Filter "app-*" -ErrorAction SilentlyContinue
    if ($appDirs) {
      # pick highest version by natural sort of the version suffix
      $PostmanDir = ($appDirs | Sort-Object {
        $v = $_.Name -replace '^app-',''
        try { [version]$v } catch { [version]"0.0.0" }
      } | Select-Object -Last 1).FullName
      break
    }
  }
  if (-not $PostmanDir) { throw "未找到 app-* 版本目录，请通过 -PostmanDir 明确指定。" }
}
$exe = Join-Path $PostmanDir "Postman.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "未找到 Postman.exe：$exe" }

# A running single-instance Postman ignores new launch flags. Restart it so the
# requested random CDP port is guaranteed to apply.
Stop-PostmanCompletely
Start-PostmanDebugSession -FilePath $exe -TimeoutSec $TimeoutSec -NoWait:$NoWait
