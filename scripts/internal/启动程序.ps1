# 启动 Postman，等待 CDP 调试端口可用，并输出本次启动的实际端口。
# 使用 --remote-debugging-port=0 时端口每次都会变化，不能复用旧值。
# 用法：
#   .\postman-zh.bat start
#   .\postman-zh.bat start -TimeoutSec 90

param(
  [string]$PostmanDir = "",       # app-x.y.z dir; auto-detected if empty
  [string]$UserDataDir = "",      # optional isolated Electron userData directory
  [ValidateRange(1, 3600)]
  [int]$TimeoutSec   = 60,        # max seconds to wait for the page
  [switch]$NoWait                 # launch only, do not wait for the page
)

$ErrorActionPreference = "Stop"
$scriptsRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptsRoot
. (Join-Path $PSScriptRoot "进程工具.ps1")
# Postman 目录的探测与解析只有这一份实现，菜单、安装、启动和发布共用。
. (Join-Path $scriptsRoot "lib\查找Postman.ps1")

# --- 定位 Postman.exe ---
# 显式给了目录就宽松解析（版本目录或安装根目录都接受）；否则走共用探测：
# 正在运行的实例 → 官方安装位置和仓库周边（含下一级）→ 上次记住的拖入目录。
if ($PostmanDir) {
  $resolved = Resolve-PostmanAppDirFromPath $PostmanDir
  if (-not $resolved) { throw "PostmanDir 不是有效的 Postman 目录：$PostmanDir" }
  $PostmanDir = $resolved
} else {
  $PostmanDir = Find-InstalledPostmanAppDir -RepoRoot $repoRoot -IncludeRunning -IncludeRemembered
  if (-not $PostmanDir) { throw "未找到 app-* 版本目录，请通过 -PostmanDir 明确指定。" }
}
$exe = Join-Path $PostmanDir "Postman.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "未找到 Postman.exe：$exe" }

# A running single-instance Postman ignores new launch flags. Restart it so the
# requested random CDP port is guaranteed to apply.
Stop-PostmanCompletely
Start-PostmanDebugSession -FilePath $exe -TimeoutSec $TimeoutSec -NoWait:$NoWait -UserDataDir $UserDataDir
