param(
  [Parameter(Position = 0)]
  [string]$Command = '',

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

# 菜单模式（双击 bat、未带命令）下，任务结束后由 bat 直接关闭窗口。
# 不要在这里等待按键：Read-Host 会让双击窗口看起来无法退出。
$script:MenuMode = $false

function Stop-WithCode {
  param([int]$Code = 0)
  if ($script:MenuMode) {
    Write-Host ''
    if ($Code -eq 0) {
      Write-Host '操作完成，窗口即将自动关闭。' -ForegroundColor Green
    } else {
      Write-Host "操作失败（退出码 $Code），窗口即将自动关闭。" -ForegroundColor Yellow
    }
  }
  exit $Code
}

function Assert-NodeRuntime {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw '找不到 Node.js。请安装 Node.js 22 或更高版本。'
  }

  # 先立即保存原生进程退出码，再做 Select-Object 等 PowerShell 管道操作。
  # 否则连续启动入口时管道可能把 $LASTEXITCODE 改成 -1，造成偶发误报。
  $versionLines = @(& $node.Source --version 2>$null)
  $nodeExitCode = $LASTEXITCODE
  $versionText = [string]($versionLines | Select-Object -First 1)
  if ($nodeExitCode -ne 0 -or $versionText -notmatch '^v(?<major>\d+)\.') {
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

唯一入口：双击 postman-zh.bat（弹出交互菜单），或在 PowerShell 中运行：
  .\postman-zh.bat <命令> [参数]

常用命令：
  install       安装汉化、关闭自动更新并验证（菜单里直接回车即为此项）
  restore       还原英文原版
  collect       导出运行时收集到的漏翻；加 -Clear 清空记录，--details 查看候选明细
  verify        只验证当前 Postman 汉化状态；加 --details 查看完整诊断
  start         启动 Postman 并等待 CDP 调试端口
  stop          彻底关闭 Postman 进程
  fix-browser   修复系统浏览器 URL 参数引号
  static-scan   扫描 UI 文案；加 --disk 扫描磁盘缓存，否则扫描运行中的页面；--out 裸名称写入 _generated
  merge         合并 _generated/trans-*.json 译文；加 --check 只检查、不写入
  probe         检查更新页面；--out 裸名称写入 _generated，--screenshot 才保存截图
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

new-request、navigation 和 deep-areas 默认使用受控预算。维护者需要在发布前执行高强度覆盖时，可对相应命令增加 --thorough，例如：
  .\postman-zh.bat audit new-request --thorough
  .\postman-zh.bat audit navigation --thorough
  .\postman-zh.bat audit deep-areas --thorough

审计截图默认关闭。显式增加 --screenshot 后生成的 PNG 可能包含当前可见的工作区或请求内容，截图像素不会自动脱敏。

安装示例：
  .\postman-zh.bat install
  .\postman-zh.bat install -PostmanDir C:\Path\To\app-12.19.6 -NoVerify
  .\postman-zh.bat restore
'@
}

# 按终端显示宽度右侧补空格。中文/全角字符占两列，直接用 -f 的 {0,-14}
# 会按字符数补齐，导致中英混排的菜单项（如“启动 Postman”）对不齐。
function Format-MenuCell {
  param([string]$Text, [int]$Width)

  $displayWidth = 0
  foreach ($ch in $Text.ToCharArray()) {
    $code = [int]$ch
    # CJK 及全角标点区间按两列计算，其余按一列
    if (($code -ge 0x1100 -and $code -le 0x115F) -or
        ($code -ge 0x2E80 -and $code -le 0xA4CF) -or
        ($code -ge 0xAC00 -and $code -le 0xD7A3) -or
        ($code -ge 0xF900 -and $code -le 0xFAFF) -or
        ($code -ge 0xFE30 -and $code -le 0xFE6F) -or
        ($code -ge 0xFF00 -and $code -le 0xFF60) -or
        ($code -ge 0xFFE0 -and $code -le 0xFFE6)) {
      $displayWidth += 2
    } else {
      $displayWidth += 1
    }
  }

  $pad = $Width - $displayWidth
  if ($pad -lt 1) { $pad = 1 }
  return $Text + (' ' * $pad)
}

# 双击 postman-zh.bat（不带任何命令）时显示的交互菜单。
# 返回值：@{ Command = '<命令>'; Arguments = @(...) }，或 $null 表示用户选择退出。
function Show-Menu {
  $items = @(
    @{ Key = '1';  Command = 'install';     Label = '安装汉化';         Note = '打补丁、关闭自动更新并验证（最常用）' }
    @{ Key = '2';  Command = 'verify';      Label = '验证汉化状态';     Note = '只检查，不改动' }
    @{ Key = '3';  Command = 'restore';     Label = '还原英文原版';     Note = '撤销汉化，恢复官方英文界面' }
    @{ Key = '4';  Command = 'start';       Label = '启动 Postman';     Note = '启动并等待 CDP 调试端口' }
    @{ Key = '5';  Command = 'stop';        Label = '关闭 Postman';     Note = '循环杀干净全部进程' }
    @{ Key = '6';  Command = 'collect';     Label = '导出运行时漏翻';   Note = '导出用户实际遇到的漏翻文案' }
    @{ Key = '7';  Command = 'static-scan'; Label = '静态扫描界面文案'; Note = '扫出未翻译候选，供补词条' }
    @{ Key = '8';  Command = 'merge';       Label = '合并译文';         Note = '把 _generated/trans-*.json 并入词典' }
    @{ Key = '9';  Command = 'audit';       Label = '深度审计界面';     Note = '需要再选一个审计名称' }
    @{ Key = '10'; Command = 'fix-browser'; Label = '修复浏览器链接';   Note = '仅在登录页外部链接异常时用' }
    @{ Key = '11'; Command = 'publish';     Label = '发布（维护者）';   Note = '推送代码到 GitHub 并发 Release' }
    @{ Key = 'h';  Command = 'help';        Label = '查看完整命令帮助'; Note = '' }
    @{ Key = '0';  Command = 'exit';        Label = '退出';             Note = '不执行任何操作' }
  )

  while ($true) {
    Write-Host ''
    Write-Host '=== Postman 中文汉化工具 ===' -ForegroundColor Cyan
    Write-Host '输入序号选择操作，直接回车执行【安装汉化】。'
    Write-Host ''
    foreach ($item in $items) {
      $line = '  {0,-3} {1}{2}' -f $item.Key, (Format-MenuCell $item.Label 20), $item.Note
      if ($item.Command -eq 'publish') {
        Write-Host $line -ForegroundColor Yellow
      } else {
        Write-Host $line
      }
    }
    Write-Host ''

    $choice = ''
    try { $choice = (Read-Host '请选择').Trim() } catch { return $null }
    if ($choice -eq '') { $choice = '1' }
    if ($choice -eq 'q' -or $choice -eq 'Q') { $choice = '0' }

    $picked = $items | Where-Object { $_.Key -eq $choice.ToLower() } | Select-Object -First 1
    if (-not $picked) {
      Write-Host "无效选择：$choice，请重新输入。" -ForegroundColor Red
      continue
    }
    if ($picked.Command -eq 'exit') { return $null }
    if ($picked.Command -eq 'help') {
      Write-Host ''
      Show-Help
      continue
    }

    $arguments = @()
    if ($picked.Command -eq 'audit') {
      $auditItems = @(
        @{ Key = '1';  Name = 'lightweight';       Label = '轻量界面巡检' }
        @{ Key = '2';  Name = 'new-request';       Label = '新建请求界面' }
        @{ Key = '3';  Name = 'new-collection';    Label = '新建集合界面' }
        @{ Key = '4';  Name = 'import';            Label = '导入界面' }
        @{ Key = '5';  Name = 'navigation';        Label = '导航与设置界面' }
        @{ Key = '6';  Name = 'deep-areas';        Label = '深层界面' }
        @{ Key = '7';  Name = 'targeted-surfaces'; Label = '容易漏翻的重点界面' }
        @{ Key = '8';  Name = 'entry-modals';      Label = '入口弹窗' }
        @{ Key = '9';  Name = 'phased';            Label = '分阶段完整审计' }
        @{ Key = '10'; Name = 'targeted';          Label = '固定区域审计' }
        @{ Key = '11'; Name = 'all-targets';       Label = '全部调试目标' }
      )

      while ($true) {
        Write-Host ''
        Write-Host '=== 深度审计界面 ===' -ForegroundColor Cyan
        Write-Host '输入序号选择审计，输入 0 返回上一级。'
        Write-Host ''
        foreach ($auditItem in $auditItems) {
          Write-Host ('  {0,-3} {1}' -f $auditItem.Key, $auditItem.Label)
        }
        Write-Host '  0   返回上一级'
        Write-Host ''

        $auditChoice = ''
        try { $auditChoice = (Read-Host '请选择').Trim() } catch { return $null }
        if ($auditChoice -eq 'q' -or $auditChoice -eq 'Q') { return $null }
        if ($auditChoice -eq '0') { break }

        $auditPicked = $auditItems | Where-Object { $_.Key -eq $auditChoice } | Select-Object -First 1
        if (-not $auditPicked) {
          Write-Host "无效选择：$auditChoice，请重新输入。" -ForegroundColor Red
          continue
        }
        $arguments = @($auditPicked.Name)
        break
      }

      if ($arguments.Count -eq 0) { continue }
    }

    Write-Host ''
    Write-Host "正在执行：$($picked.Label)" -ForegroundColor Cyan
    Write-Host ''
    return @{ Command = $picked.Command; Arguments = $arguments }
  }
}

try {
  if (-not $Command) {
    $script:MenuMode = $true
    $selection = Show-Menu
    if (-not $selection) { Stop-WithCode 0 }
    $Command = $selection.Command
    if ($selection.Arguments.Count -gt 0) {
      $RemainingArguments = @($selection.Arguments) + @($RemainingArguments)
    }
  }

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
