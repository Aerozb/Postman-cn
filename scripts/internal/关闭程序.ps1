# 强制关闭全部 Postman 进程，并循环重试，避免守护进程互相拉起。
param(
  [ValidateRange(1, 120)]
  [int]$MaxRounds = 20,
  [ValidateRange(50, 10000)]
  [int]$SleepMs = 500,
  [ValidateRange(1, 10)]
  [int]$StableChecks = 3
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '进程工具.ps1')
Stop-PostmanCompletely -MaxRounds $MaxRounds -SleepMs $SleepMs -StableChecks $StableChecks
