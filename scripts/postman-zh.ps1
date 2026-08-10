[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'restore', 'collect', 'verify', 'start', 'stop', 'fix-browser', 'static-scan', 'merge', 'probe', 'scan', 'audit', 'publish', 'help')]
  [string]$Command = 'install',

  [string]$PostmanDir,
  [int]$TimeoutSec = 60,
  [switch]$NoWait,
  [switch]$NoRestart,
  [switch]$KeepUpdates,
  [switch]$NoVerify,
  [switch]$CleanOldVersions,
  [switch]$Clear,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArguments
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$internalRoot = Join-Path $PSScriptRoot 'internal'
$auditRoot = Join-Path $PSScriptRoot 'audit'
$runtimeRoot = Join-Path $PSScriptRoot 'runtime'
$dataRoot = Join-Path $PSScriptRoot 'data'
$maintenanceRoot = Join-Path $PSScriptRoot 'maintenance'
Set-Location -LiteralPath $repoRoot

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Stop-WithCode {
  param([int]$Code = 0)
  exit $Code
}

function Invoke-NodeScript {
  param(
    [Parameter(Mandatory)][string]$ScriptPath,
    [string[]]$Arguments = @()
  )

  if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw "找不到脚本：$ScriptPath"
  }
  & node $ScriptPath @Arguments
  Stop-WithCode $LASTEXITCODE
}

function Invoke-PowerShellScript {
  param(
    [Parameter(Mandatory)][string]$ScriptPath,
    [hashtable]$Parameters = @{},
    [string[]]$Arguments = @()
  )

  if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw "找不到脚本：$ScriptPath"
  }
  & $ScriptPath @Parameters @Arguments
  $code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  Stop-WithCode $code
}

function Show-Help {
  Write-Host @'
Postman 中文汉化工具

唯一入口：双击 postman-zh.bat，或在 PowerShell 中运行：
  .\postman-zh.bat <命令> [参数]

常用命令：
  install       安装汉化、关闭自动更新并验证（默认命令）
  restore       还原英文原版
  collect       导出运行时收集到的漏翻；加 -Clear 同时清空记录
  verify        只验证当前 Postman 汉化状态
  start         启动 Postman 并等待 CDP 调试端口
  stop          彻底关闭 Postman 进程
  fix-browser   修复系统浏览器 URL 参数引号
  static-scan   扫描磁盘缓存中的 UI 文案
  merge         合并 _generated/trans-*.json 译文
  probe         检查更新页面
  scan          扫描可点击界面
  audit <名称>  运行指定深度审计（见下方名称）
  publish       调用维护者发布脚本
  help          显示本帮助

审计名称：
  all-targets, deep-areas, entry-modals, import, lightweight,
  navigation, new-collection, new-request, phased, targeted,
  targeted-surfaces

安装示例：
  .\postman-zh.bat install
  .\postman-zh.bat install -PostmanDir C:\Path\To\app-12.19.6 -NoVerify
  .\postman-zh.bat restore
'@
}

try {
  switch ($Command) {
    'help' {
      Show-Help
      Stop-WithCode 0
    }

    'install' {
      $params = @{
        Latest = $true
        DisableUpdates = (-not $KeepUpdates)
        FixBrowserUrlHandler = $true
        Verify = (-not $NoVerify)
      }
      if ($PostmanDir) { $params.PostmanDir = $PostmanDir }
      if ($NoRestart) { $params.NoRestart = $true }
      if ($CleanOldVersions) { $params.CleanOldVersions = $true }
      Invoke-PowerShellScript (Join-Path $internalRoot 'install-postman-zh.ps1') $params
    }

    'restore' {
      $params = @{ Latest = $true; RestoreOriginal = $true }
      if ($PostmanDir) { $params.PostmanDir = $PostmanDir }
      if ($NoRestart) { $params.NoRestart = $true }
      Invoke-PowerShellScript (Join-Path $internalRoot 'install-postman-zh.ps1') $params
    }

    'collect' {
      $nodeArgs = @($RemainingArguments)
      if ($Clear) { $nodeArgs += '--clear' }
      Invoke-NodeScript (Join-Path $runtimeRoot 'collect-zh-misses.js') $nodeArgs
    }

    'verify' {
      $nodeArgs = @($RemainingArguments)
      if ($PostmanDir) { $nodeArgs += @('--postman-dir', $PostmanDir) }
      Invoke-NodeScript (Join-Path $PSScriptRoot 'verify-postman-zh.js') $nodeArgs
    }

    'start' {
      $params = @{ TimeoutSec = $TimeoutSec }
      if ($PostmanDir) { $params.PostmanDir = $PostmanDir }
      if ($NoWait) { $params.NoWait = $true }
      Invoke-PowerShellScript (Join-Path $internalRoot 'start-postman.ps1') $params
    }

    'stop' {
      Invoke-PowerShellScript (Join-Path $internalRoot 'kill-postman.ps1') @{}
    }

    'fix-browser' {
      Invoke-PowerShellScript (Join-Path $internalRoot 'fix-browser-url-handler.ps1') @{}
    }

    'static-scan' {
      Invoke-NodeScript (Join-Path $dataRoot 'extract-ui-strings.js') @($RemainingArguments)
    }

    'merge' {
      Invoke-NodeScript (Join-Path $dataRoot 'merge-translations.js') @($RemainingArguments)
    }

    'probe' {
      Invoke-NodeScript (Join-Path $runtimeRoot 'probe-update-page.js') @($RemainingArguments)
    }

    'scan' {
      Invoke-NodeScript (Join-Path $auditRoot 'scan-postman-clickables.js') @($RemainingArguments)
    }

    'audit' {
      $auditNames = @{
        'all-targets' = 'audit-postman-all-cdp-targets.js'
        'deep-areas' = 'audit-postman-deep-areas.js'
        'entry-modals' = 'audit-postman-entry-modals.js'
        'import' = 'audit-postman-import.js'
        'lightweight' = 'audit-postman-lightweight-ui.js'
        'navigation' = 'audit-postman-navigation-surfaces.js'
        'new-collection' = 'audit-postman-new-collection.js'
        'new-request' = 'audit-postman-new-request.js'
        'phased' = 'audit-postman-phased.js'
        'targeted' = 'audit-postman-targeted.js'
        'targeted-surfaces' = 'audit-postman-targeted-surfaces.js'
      }
      $name = if ($RemainingArguments.Count -gt 0) { $RemainingArguments[0] } else { $null }
      if (-not $name -or -not $auditNames.ContainsKey($name)) {
        Write-Host "请指定审计名称：$($auditNames.Keys -join ', ')"
        Stop-WithCode 2
      }
      $nodeArgs = if ($RemainingArguments.Count -gt 1) { @($RemainingArguments[1..($RemainingArguments.Count - 1)]) } else { @() }
      Invoke-NodeScript (Join-Path $auditRoot $auditNames[$name]) $nodeArgs
    }

    'publish' {
      Invoke-PowerShellScript (Join-Path $maintenanceRoot 'publish-postman-cn.ps1') @{} @($RemainingArguments)
    }
  }
} catch {
  Write-Error $_.Exception.Message
  Stop-WithCode 1
}
