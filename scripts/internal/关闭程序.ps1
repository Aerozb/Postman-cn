# 强制关闭全部 Postman 进程，并循环重试，避免守护进程互相拉起。
param(
  [int]$MaxRounds = 12,
  [int]$SleepMs   = 500
)

function Get-PostmanProcs {
  Get-Process -Name Postman -ErrorAction SilentlyContinue
}

$initial = @(Get-PostmanProcs)
Write-Host "[Postman 汉化] 当前发现 $($initial.Count) 个 Postman 进程。"

if ($initial.Count -eq 0) {
  Write-Host "[Postman 汉化] Postman 已经完全关闭。"
  exit 0
}

for ($round = 1; $round -le $MaxRounds; $round++) {
  $procs = @(Get-PostmanProcs)
  if ($procs.Count -eq 0) {
    Write-Host "[Postman 汉化] 已在第 $round 轮关闭全部 Postman 进程。"
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
  Write-Host "[Postman 汉化] 已在 $MaxRounds 轮内关闭全部 Postman 进程。"
  exit 0
} else {
  Write-Host "[Postman 汉化] 警告：重试 $MaxRounds 轮后仍有 $($final.Count) 个 Postman 进程未关闭。"
  $final | ForEach-Object { Write-Host ("  PID {0}" -f $_.Id) }
  exit 1
}
