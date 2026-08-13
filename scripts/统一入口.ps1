param(
  [Parameter(Position = 0)]
  [string]$Command = 'install',

  [string]$PostmanDir,
  [int]$TimeoutSec = 60,
  [switch]$NoWait,
  [switch]$NoRestart,
  [switch]$KeepUpdates,
  [switch]$NoVerify,
  [switch]$CleanOldVersions,
  [switch]$Clear,
  [Alias('out')]
  [string]$NodeOut,

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

function Assert-NodeRuntime {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw '找不到 Node.js。请安装 Node.js 22 或更高版本。'
  }

  $versionText = (& $node.Source --version 2>$null | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(?<major>\d+)\.') {
    throw '无法读取 Node.js 版本。请安装 Node.js 22 或更高版本。'
  }
  if ([int]$Matches.major -lt 22) {
    throw "当前 Node.js 版本为 $versionText；本工具需要 Node.js 22 或更高版本。"
  }
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
  if ($Arguments.Count -gt 0) {
    if ($Parameters.Count -gt 0) {
      throw "内部调用错误：不能同时使用参数表和透传参数。"
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments
  } else {
    & $ScriptPath @Parameters
  }
  $code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  Stop-WithCode $code
}

function Get-NodeArguments {
  param([string[]]$Arguments = @())

  $result = @()
  if ($NodeOut) { $result += @('--out', $NodeOut) }
  $result += @($Arguments)
  return $result
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
  verify        只验证当前 Postman 汉化状态；加 --details 查看完整诊断
  start         启动 Postman 并等待 CDP 调试端口
  stop          彻底关闭 Postman 进程
  fix-browser   修复系统浏览器 URL 参数引号
  static-scan   扫描磁盘缓存中的 UI 文案；--out 裸名称写入 _generated
  merge         合并 _generated/trans-*.json 译文；加 --check 只检查、不写入
  probe         检查更新页面；--out 裸名称写入 _generated，截图使用同名 PNG
  scan          扫描可点击界面
  audit <名称>  运行指定深度审计；--out 可用裸名称或 .json（见下方名称）
  publish       调用维护者发布脚本
  help          显示本帮助

审计名称：
  all-targets        全部 CDP 调试目标
  deep-areas         深层界面
  entry-modals       入口弹窗
  import             导入界面
  lightweight        轻量界面巡检
  navigation         导航界面
  new-collection     新建集合界面
  new-request        新建请求界面
  phased             分阶段完整审计
  targeted           固定区域审计
  targeted-surfaces  容易漏翻的重点界面

安装示例：
  .\postman-zh.bat install
  .\postman-zh.bat install -PostmanDir C:\Path\To\app-12.19.6 -NoVerify
  .\postman-zh.bat restore
'@
}

try {
  $validCommands = @('install', 'restore', 'collect', 'verify', 'start', 'stop', 'fix-browser', 'static-scan', 'merge', 'probe', 'scan', 'audit', 'publish', 'help')
  if ($validCommands -notcontains $Command) {
    Write-Host "未知命令：$Command"
    Write-Host "请运行 .\postman-zh.bat help 查看可用命令。"
    Stop-WithCode 2
  }

  $nodeCommands = @('install', 'collect', 'verify', 'static-scan', 'merge', 'probe', 'scan', 'audit')
  if ($nodeCommands -contains $Command) {
    Assert-NodeRuntime
  }

  switch ($Command) {
    'help' {
      Show-Help
      Stop-WithCode 0
    }

    'install' {
      $params = @{
        Latest = $true
        DisableUpdates = (-not $KeepUpdates)
        Verify = (-not $NoVerify)
      }
      if ($PostmanDir) { $params.PostmanDir = $PostmanDir }
      if ($NoRestart) { $params.NoRestart = $true }
      if ($CleanOldVersions) { $params.CleanOldVersions = $true }
      Invoke-PowerShellScript (Join-Path $internalRoot '安装汉化.ps1') $params
    }

    'restore' {
      $params = @{ Latest = $true; RestoreOriginal = $true }
      if ($PostmanDir) { $params.PostmanDir = $PostmanDir }
      if ($NoRestart) { $params.NoRestart = $true }
      Invoke-PowerShellScript (Join-Path $internalRoot '安装汉化.ps1') $params
    }

    'collect' {
      $nodeArgs = @($RemainingArguments)
      if ($Clear) { $nodeArgs += '--clear' }
      Invoke-NodeScript (Join-Path $runtimeRoot '收集漏翻.js') $nodeArgs
    }

    'verify' {
      $nodeArgs = @($RemainingArguments)
      if ($PostmanDir) { $nodeArgs += @('--postman-dir', $PostmanDir) }
      if (-not $KeepUpdates) { $nodeArgs += '--expect-updates-disabled' }
      Invoke-NodeScript (Join-Path $PSScriptRoot '验证汉化.js') $nodeArgs
    }

    'start' {
      $params = @{ TimeoutSec = $TimeoutSec }
      if ($PostmanDir) { $params.PostmanDir = $PostmanDir }
      if ($NoWait) { $params.NoWait = $true }
      Invoke-PowerShellScript (Join-Path $internalRoot '启动程序.ps1') $params
    }

    'stop' {
      Invoke-PowerShellScript (Join-Path $internalRoot '关闭程序.ps1') @{}
    }

    'fix-browser' {
      Invoke-PowerShellScript (Join-Path $internalRoot '修复浏览器链接.ps1') @{}
    }

    'static-scan' {
      Invoke-NodeScript (Join-Path $dataRoot '提取界面文案.js') @(Get-NodeArguments $RemainingArguments)
    }

    'merge' {
      Invoke-NodeScript (Join-Path $dataRoot '合并译文.js') @($RemainingArguments)
    }

    'probe' {
      Invoke-NodeScript (Join-Path $runtimeRoot '探测更新页面.js') @(Get-NodeArguments $RemainingArguments)
    }

    'scan' {
      Invoke-NodeScript (Join-Path $auditRoot '扫描可交互界面.js') @(Get-NodeArguments $RemainingArguments)
    }

    'audit' {
      $auditNames = [ordered]@{
        'all-targets' = '审计全部调试目标.js'
        'deep-areas' = '审计深层界面.js'
        'entry-modals' = '审计入口弹窗.js'
        'import' = '审计导入界面.js'
        'lightweight' = '审计轻量界面.js'
        'navigation' = '审计导航界面.js'
        'new-collection' = '审计新建集合.js'
        'new-request' = '审计新建请求.js'
        'phased' = '审计分阶段流程.js'
        'targeted' = '审计指定界面.js'
        'targeted-surfaces' = '审计易漏界面.js'
      }
      $auditDescriptions = [ordered]@{
        'all-targets' = '全部 CDP 调试目标'
        'deep-areas' = '深层界面'
        'entry-modals' = '入口弹窗'
        'import' = '导入界面'
        'lightweight' = '轻量界面巡检'
        'navigation' = '导航界面'
        'new-collection' = '新建集合界面'
        'new-request' = '新建请求界面'
        'phased' = '分阶段完整审计'
        'targeted' = '固定区域审计'
        'targeted-surfaces' = '容易漏翻的重点界面'
      }
      $name = if ($RemainingArguments.Count -gt 0) { $RemainingArguments[0] } else { $null }
      if (-not $name -or -not $auditNames.Contains($name)) {
        Write-Host "请指定审计名称："
        foreach ($auditName in $auditDescriptions.Keys) {
          Write-Host ("  {0,-18} {1}" -f $auditName, $auditDescriptions[$auditName])
        }
        Stop-WithCode 2
      }
      $auditArguments = if ($RemainingArguments.Count -gt 1) { @($RemainingArguments[1..($RemainingArguments.Count - 1)]) } else { @() }
      $nodeArgs = @(Get-NodeArguments $auditArguments)
      Invoke-NodeScript (Join-Path $auditRoot $auditNames[$name]) $nodeArgs
    }

    'publish' {
      Invoke-PowerShellScript (Join-Path $maintenanceRoot '发布中文版.ps1') @{} @($RemainingArguments)
    }
  }
} catch {
  Write-Host "[Postman 汉化] 错误：$($_.Exception.Message)" -ForegroundColor Red
  Stop-WithCode 1
}
