# start-postman.ps1 - Launch Postman with a CDP debug port and wait until the
# main page is reachable. Prints the ACTIVE debug port on success.
#
# Why this exists: Postman is launched with --remote-debugging-port=0, so the OS
# assigns a RANDOM port on every start. The real port is written to
# %APPDATA%\Postman\DevToolsActivePort (first line). Never reuse a cached port;
# always read that file. This script launches, waits for the page, and reports
# the current port so callers can connect reliably.
#
# Usage:
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
  if (-not $PostmanDir) { throw "No app-* directory found. Pass -PostmanDir explicitly." }
}
$exe = Join-Path $PostmanDir "Postman.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "Postman.exe not found: $exe" }

$portFile = Join-Path $env:APPDATA "Postman\DevToolsActivePort"

# A running single-instance Postman ignores new launch flags. Restart it so the
# requested random CDP port is guaranteed to apply.
$running = @(Get-Process -Name Postman -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Host "[start-postman] stopping $($running.Count) existing process(es)"
  for ($round = 1; $round -le 12; $round++) {
    $processes = @(Get-Process -Name Postman -ErrorAction SilentlyContinue)
    if ($processes.Count -eq 0) { break }
    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  if (@(Get-Process -Name Postman -ErrorAction SilentlyContinue).Count -gt 0) {
    throw "Could not stop all existing Postman processes before restart."
  }
}

# Remove stale port file so we don't read an old port after launch.
if (Test-Path -LiteralPath $portFile) {
  Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
}

Write-Host "[start-postman] launching: $exe"
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=0"

if ($NoWait) {
  Write-Host "[start-postman] launched (NoWait); port file will appear at $portFile"
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
  Write-Host "[start-postman] READY port=$activePort"
  exit 0
} else {
  Write-Host "[start-postman] TIMEOUT after ${TimeoutSec}s (page not reachable). Check the port file: $portFile"
  exit 1
}
