# kill-postman.ps1
# Forcibly terminate ALL Postman processes, retrying until none remain.
# Postman has watchdog/helper processes that can relaunch each other, so a
# single taskkill often leaves survivors. This loops until the count is zero.
# ASCII-only (no Chinese) to avoid PowerShell 5.1 ANSI-decoding issues on non-BOM files.
param(
  [int]$MaxRounds = 12,
  [int]$SleepMs   = 500
)

function Get-PostmanProcs {
  Get-Process -Name Postman -ErrorAction SilentlyContinue
}

$initial = @(Get-PostmanProcs)
Write-Host "[kill-postman] initial process count: $($initial.Count)"

if ($initial.Count -eq 0) {
  Write-Host "[kill-postman] nothing to kill; already clear"
  exit 0
}

for ($round = 1; $round -le $MaxRounds; $round++) {
  $procs = @(Get-PostmanProcs)
  if ($procs.Count -eq 0) {
    Write-Host "[kill-postman] cleared at round $round"
    exit 0
  }
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop }
    catch { }
  }
  Start-Sleep -Milliseconds $SleepMs
}

$final = @(Get-PostmanProcs)
if ($final.Count -eq 0) {
  Write-Host "[kill-postman] cleared after $MaxRounds rounds"
  exit 0
} else {
  Write-Host "[kill-postman] WARNING: $($final.Count) process(es) still alive after $MaxRounds rounds"
  $final | ForEach-Object { Write-Host ("  PID {0}" -f $_.Id) }
  exit 1
}
