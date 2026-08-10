# 启动 Postman，等待 CDP 调试端口可用，并输出本次启动的实际端口。
# 使用 --remote-debugging-port=0 时端口每次都会变化，不能复用旧值。
# 用法：
#   .\postman-zh.bat start
#   .\postman-zh.bat start -TimeoutSec 90

param(
  [string]$PostmanDir = "",       # app-x.y.z dir; auto-detected if empty
  [int]$TimeoutSec   = 60,        # max seconds to wait for the page
  [switch]$NoWait                 # launch only, do not wait for the page
)

$ErrorActionPreference = "Stop"

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

$portFile = Join-Path $env:APPDATA "Postman\DevToolsActivePort"

# A running single-instance Postman ignores new launch flags. Restart it so the
# requested random CDP port is guaranteed to apply.
$running = @(Get-Process -Name Postman -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Host "[Postman 汉化] 正在关闭现有的 $($running.Count) 个 Postman 进程。"
  for ($round = 1; $round -le 12; $round++) {
    $processes = @(Get-Process -Name Postman -ErrorAction SilentlyContinue)
    if ($processes.Count -eq 0) { break }
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  if (@(Get-Process -Name Postman -ErrorAction SilentlyContinue).Count -gt 0) {
    throw "重新启动前无法关闭全部 Postman 进程。"
  }
}

# Remove stale port file so we don't read an old port after launch.
if (Test-Path -LiteralPath $portFile) {
  Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
}

Write-Host "[Postman 汉化] 正在启动：$exe"
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=0"

if ($NoWait) {
  Write-Host "[Postman 汉化] 已启动；已按 -NoWait 跳过等待。端口文件将写入：$portFile"
  exit 0
}

# --- Wait for the main page to be reachable via CDP ---
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$activePort = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 1500
  if (-not (Test-Path -LiteralPath $portFile)) { continue }
  $port = (Get-Content -LiteralPath $portFile -TotalCount 1).Trim()
  if (-not $port) { continue }
  try {
    $list = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 3
    $pages = @($list | Where-Object {
      $_.type -eq "page" -and
      $_.webSocketDebuggerUrl -and
      $_.url -notlike "devtools://*" -and
      $_.url -notlike "https://www.postman.com/complete-checkout*"
    })
    $page = $pages | Where-Object {
      $_.url -match "^https://desktop\.postman\.com(?::\d+)?(?:[/?#]|$)|^file:///.*?/(?:requester|scratchpad)\.html(?:[?#]|$)"
    } | Select-Object -First 1
    if ($page) { $activePort = $port; break }
  } catch {
    # page not ready yet; keep waiting
  }
}

if ($activePort) {
  Write-Host "[Postman 汉化] Postman 已就绪，CDP 端口：$activePort"
  exit 0
} else {
  Write-Host "[Postman 汉化] 等待 ${TimeoutSec} 秒后超时，仍无法访问页面。请检查端口文件：$portFile"
  exit 1
}
