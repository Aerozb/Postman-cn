# 强制关闭全部 Postman 进程，并循环重试，避免守护进程互相拉起。
param(
  [ValidateRange(1, 120)]
  [int]$MaxRounds = 20,
  [ValidateRange(50, 10000)]
  [int]$SleepMs = 500,
  [ValidateRange(1, 10)]
  [int]$StableChecks = 3
)

function Get-PostmanProcs {
  Get-Process -Name Postman -ErrorAction SilentlyContinue
}

$initialCount = @(Get-PostmanProcs).Count
if ($initialCount -gt 0) {
  Write-Host "[Postman 汉化] 正在关闭 $initialCount 个 Postman 进程。"
}

$emptyChecks = 0
for ($round = 1; $round -le $MaxRounds; $round++) {
  $procs = @(Get-PostmanProcs)
  if ($procs.Count -eq 0) {
    $emptyChecks++
    if ($emptyChecks -ge $StableChecks) {
      Write-Host "[Postman 汉化] Postman 进程已全部关闭。"
      exit 0
    }
  } else {
    $emptyChecks = 0
    foreach ($p in $procs) {
      try {
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
      } catch {
        # 进程可能已自行退出；最终清零检查会决定命令是否成功。
      }
    }
  }
  if ($round -lt $MaxRounds) {
    Start-Sleep -Milliseconds $SleepMs
  }
}

$final = @(Get-PostmanProcs)
if ($final.Count -gt 0) {
  $ids = ($final | Select-Object -ExpandProperty Id | Sort-Object) -join ", "
  Write-Host "[Postman 汉化] 错误：仍有 $($final.Count) 个 Postman 进程未关闭（PID：$ids）。" -ForegroundColor Red
  exit 1
}

Write-Host "[Postman 汉化] 错误：未能连续 $StableChecks 次确认 Postman 进程为零。" -ForegroundColor Red
exit 1
