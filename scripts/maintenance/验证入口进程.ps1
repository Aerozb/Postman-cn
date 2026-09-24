param([switch]$Details)

# 由 postman-zh.bat test 调用。只加载函数；进程、偏好、网络和时钟全部使用内存桩。
$ErrorActionPreference = 'Stop'
$scriptsRoot = Split-Path -Parent $PSScriptRoot
$internalRoot = Join-Path $scriptsRoot 'internal'
$dataRoot = Join-Path $scriptsRoot 'data'
$maintenanceRoot = $PSScriptRoot
$script:Checks = New-Object 'System.Collections.Generic.List[string]'

function Assert-Test([bool]$Condition, [string]$Name) {
  if (-not $Condition) { throw "入口/进程回归失败：$Name" }
  $script:Checks.Add($Name)
}

function Assert-TestThrows([scriptblock]$Action, [string]$Pattern, [string]$Name) {
  $message = ''
  try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
  Assert-Test ($message -match $Pattern) $Name
}

function Read-TestAst([string]$Path) {
  $tokens = $null
  $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw "测试源文件语法错误：$Path" }
  return $ast
}

foreach ($file in Get-ChildItem -LiteralPath $scriptsRoot -Recurse -File -Filter '*.ps1') {
  [void](Read-TestAst $file.FullName)
  Assert-Test $true ("PowerShell 语法：" + $file.Name)
}

$entryAst = Read-TestAst (Join-Path $scriptsRoot '统一入口.ps1')
$processAst = Read-TestAst (Join-Path $internalRoot '进程工具.ps1')
foreach ($ast in @($entryAst, $processAst)) {
  foreach ($definition in @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] })) {
    . ([scriptblock]::Create($definition.Extent.Text))
  }
}
$entryCall = $entryAst.EndBlock.Statements[-1].Extent.Text
$realChildProcess = ${function:Invoke-ChildProcess}
$realNodeScript = ${function:Invoke-NodeScript}
$realPowerShellScript = ${function:Invoke-PowerShellScript}
$realShowMenu = ${function:Show-Menu}

$stopCalls = @($entryAst.FindAll({ param($node)
  $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Stop-WithCode'
}, $true))
Assert-Test ($stopCalls.Count -eq 1 -and $entryCall -match '^Stop-WithCode ') '统一入口只有一个最外层收尾调用'
$entryParameters = @($entryAst.ParamBlock.Parameters.Name.VariablePath.UserPath)
Assert-Test ($entryParameters -notcontains 'Clear' -and $entryParameters -notcontains 'NodeOut') '入口已清除旧扫描专属参数'
Assert-Test ($entryParameters -contains 'UserDataDir') '入口支持显式独立数据目录'

# 执行真实入口末行；仅把边界调用换成桩，检查全部命令的退出码和收尾次数。
& {
  function Write-Host { param($Object, $ForegroundColor, [switch]$NoNewline) }
  function Assert-NodeRuntime { if ($script:Fixture.ThrowNode) { throw 'fixture node failure' } }
  function Get-UpdatePreferencePath { return 'memory:updates' }
  function Get-ZhUpdatePreferencePath { return 'memory:zh-updates' }
  function Get-UpdatePreference { param($Path); return $false }
  function Get-ZhUpdatePreference { param($Path); return $true }
  function Set-UpdatePreference { param($Path, $Enabled); $script:Fixture.PreferenceWrites.Add("updates:$Enabled") }
  function Set-ZhUpdatePreference { param($Path, $Enabled); $script:Fixture.PreferenceWrites.Add("zh-updates:$Enabled") }
  function Show-Help { }
  function Show-Menu { return $script:Fixture.Selection }
  function Stop-WithCode { param([int]$Code); $script:Fixture.Exits.Add($Code) }
  function Next-FixtureCode {
    if ($script:Fixture.ThrowChild) { throw 'fixture child failure' }
    if ($script:Fixture.Codes.Count -gt 0) { return $script:Fixture.Codes.Dequeue() }
    return 0
  }
  function Invoke-NodeScript {
    param($ScriptPath, [string[]]$Arguments = @())
    $script:Fixture.Calls.Add(@{ Kind = 'node'; Path = $ScriptPath; Arguments = @($Arguments) })
    return (Next-FixtureCode)
  }
  function Invoke-PowerShellScript {
    param($ScriptPath, [hashtable]$Parameters = @{}, [string[]]$Arguments = @())
    $script:Fixture.Calls.Add(@{ Kind = 'powershell'; Path = $ScriptPath; Parameters = $Parameters; Arguments = @($Arguments) })
    return (Next-FixtureCode)
  }
  function Invoke-ZhUpdateCheck {
    $script:Fixture.Calls.Add(@{ Kind = 'check'; Path = 'memory:version-check' })
    return (Next-FixtureCode)
  }
  function Reset-EntryFixture([int[]]$Codes = @(0)) {
    $script:Fixture = @{
      Codes = New-Object 'System.Collections.Generic.Queue[int]'
      Calls = New-Object 'System.Collections.Generic.List[object]'
      Exits = New-Object 'System.Collections.Generic.List[int]'
      PreferenceWrites = New-Object 'System.Collections.Generic.List[string]'
      Selection = $null; ThrowChild = $false; ThrowNode = $false
    }
    foreach ($code in $Codes) { $script:Fixture.Codes.Enqueue($code) }
  }
  function Invoke-EntryFixture([string]$Name, [string[]]$Arguments = @()) {
    $Command = $Name
    $RemainingArguments = @($Arguments)
    & ([scriptblock]::Create($entryCall))
    Assert-Test ($script:Fixture.Exits.Count -eq 1) "$Name 只收尾一次"
    return $script:Fixture.Exits[0]
  }

  $children = @('install', 'restore', 'verify', 'start', 'stop', 'fix-browser', 'merge', 'publish', 'stats', 'test')
  foreach ($name in $children) {
    foreach ($code in @(0, 1, 2)) {
      Reset-EntryFixture @($code)
      $actual = Invoke-EntryFixture $name
      Assert-Test ($actual -eq $code) "$name 保留退出码 $code"
      Assert-Test (-not $script:MenuMode) "$name 命令行不进入菜单等待"
    }
  }
  foreach ($name in @('updates', 'zh-updates')) {
    foreach ($action in @('', 'on', 'off')) {
      Reset-EntryFixture
      $arguments = if ($action) { @($action) } else { @() }
      Assert-Test ((Invoke-EntryFixture $name $arguments) -eq 0) "$name $action 成功返回 0"
      Assert-Test ($script:Fixture.PreferenceWrites.Count -eq [int][bool]$action) "$name 只在切换时写入内存偏好"
    }
    Reset-EntryFixture
    Assert-Test ((Invoke-EntryFixture $name @('unexpected')) -eq 2) "$name 非法参数返回 2"
  }
  foreach ($code in @(0, 1, 2)) {
    Reset-EntryFixture @($code)
    Assert-Test ((Invoke-EntryFixture 'zh-updates' @('check')) -eq $code) "版本检查保留退出码 $code"
  }
  foreach ($name in @('unknown', 'test')) {
    Reset-EntryFixture
    $arguments = if ($name -eq 'test') { @('--unknown') } else { @() }
    Assert-Test ((Invoke-EntryFixture $name $arguments) -eq 2) "$name 错误输入返回 2"
    Assert-Test ($script:Fixture.Calls.Count -eq 0) "$name 错误输入不执行子任务"
  }
  $removedCommands = [ordered]@{
    'collect' = @('-Clear', '--details')
    'static-scan' = @('--disk', '--max', '10')
    'probe' = @('--details', '--screenshot')
    'scan' = @('--details', '--screenshot')
    'audit' = @('lightweight', '--details')
  }
  foreach ($name in $removedCommands.Keys) {
    foreach ($withArguments in @($false, $true)) {
      Reset-EntryFixture
      $script:Fixture.ThrowNode = $true
      $arguments = if ($withArguments) { @($removedCommands[$name]) } else { @() }
      Assert-Test ((Invoke-EntryFixture $name $arguments) -eq 2) "已移除命令 $name 参数=$withArguments 返回 2，且不检查 Node"
      Assert-Test ($script:Fixture.Calls.Count -eq 0 -and $script:Fixture.PreferenceWrites.Count -eq 0) "已移除命令 $name 参数=$withArguments 不执行子任务或修改偏好"
    }
  }
  Reset-EntryFixture
  Assert-Test ((Invoke-EntryFixture 'help') -eq 0) '帮助成功返回 0'
  Reset-EntryFixture
  $script:Fixture.ThrowChild = $true
  Assert-Test ((Invoke-EntryFixture 'stop') -eq 1) '子任务异常统一返回 1'
  Reset-EntryFixture
  $script:Fixture.ThrowNode = $true
  Assert-Test ((Invoke-EntryFixture 'verify') -eq 1) '环境异常统一返回 1'

  Reset-EntryFixture
  $script:Fixture.Selection = @{ Command = 'updates'; Arguments = @('on') }
  Assert-Test ((Invoke-EntryFixture '') -eq 0) '菜单自动更新成功仍走最外层收尾'
  Assert-Test ($script:MenuMode -and $script:Fixture.PreferenceWrites.Count -eq 1) '菜单自动更新保留手动等待状态'
  Reset-EntryFixture
  Assert-Test ((Invoke-EntryFixture '') -eq 0 -and $script:Fixture.Calls.Count -eq 0) '菜单取消也只收尾一次'
  Reset-EntryFixture
  $script:Fixture.Selection = @{ Command = 'install'; Arguments = @() }
  [void](Invoke-EntryFixture '')
  Assert-Test ($script:Fixture.Calls[0].Parameters.CleanOldVersions -eq $true) '菜单安装默认清理旧版'
  Reset-EntryFixture
  [void](Invoke-EntryFixture 'install')
  Assert-Test (-not $script:Fixture.Calls[0].Parameters.ContainsKey('CleanOldVersions')) '命令行安装默认保留旧版'
  Reset-EntryFixture
  [void](Invoke-EntryFixture 'start')
  Assert-Test (-not $script:Fixture.Calls[0].Parameters.ContainsKey('UserDataDir')) '默认启动不改数据目录'

  $PostmanDir = 'fixture-app'; $NoRestart = $true; $NoVerify = $true; $KeepUpdates = $true
  Reset-EntryFixture
  [void](Invoke-EntryFixture 'install')
  $passed = $script:Fixture.Calls[0].Parameters
  Assert-Test ($passed.NoRestart -and -not $passed.Verify -and -not $passed.DisableUpdates -and $passed.PostmanDir -eq $PostmanDir) '安装命名参数原样透传'
  $TimeoutSec = 90; $NoWait = $true; $UserDataDir = 'C:\fixture profile\Postman'
  Reset-EntryFixture
  [void](Invoke-EntryFixture 'start')
  Assert-Test ($script:Fixture.Calls[0].Parameters.NoWait -and $script:Fixture.Calls[0].Parameters.TimeoutSec -eq 90) '启动 NoWait 和超时透传'
  Assert-Test ($script:Fixture.Calls[0].Parameters.UserDataDir -eq $UserDataDir) '启动独立数据目录原样透传'
  Reset-EntryFixture
  [void](Invoke-EntryFixture 'verify' @('--details'))
  Assert-Test (($script:Fixture.Calls[0].Arguments -join '|') -eq '--details|--postman-dir|fixture-app') '验证目录、KeepUpdates 和 details 透传'
  Reset-EntryFixture
  [void](Invoke-EntryFixture 'merge' @('--check'))
  Assert-Test (($script:Fixture.Calls[0].Arguments -join '|') -eq '--check') '合并检查参数透传'
  Reset-EntryFixture
  $publishArguments = @('-ReplaceRelease', '-Yes', '-AppDir', 'fixture app', '-Tag', 'v99.0.0')
  [void](Invoke-EntryFixture 'publish' $publishArguments)
  Assert-Test ((Split-Path -Leaf $script:Fixture.Calls[0].Path) -eq '发布中文版.ps1' -and ($script:Fixture.Calls[0].Arguments -join '|') -eq ($publishArguments -join '|')) '发布覆盖、确认、目录和标签参数原样透传'

  Reset-EntryFixture @(0, 0, 0)
  Assert-Test ((Invoke-EntryFixture 'test' @('--details')) -eq 0) '离线回归全部通过'
  Assert-Test (($script:Fixture.Calls | ForEach-Object { Split-Path -Leaf $_.Path }) -join '|' -eq '运行回归.js|验证入口进程.ps1|验证发布预检.ps1') '离线回归顺序固定且覆盖三组'
  Assert-Test ($script:Fixture.Calls[0].Arguments -contains '--details' -and $script:Fixture.Calls[1].Parameters.Details) '离线回归 details 透传'
  foreach ($codes in @(@(0, 2), @(0, 0, 1))) {
    Reset-EntryFixture $codes
    Assert-Test ((Invoke-EntryFixture 'test') -eq $codes[-1] -and $script:Fixture.Calls.Count -eq $codes.Count) '回归中途失败即停止并保留原码'
  }
}

# 真实收尾函数只替换 exit 这个进程边界；菜单等待及所有判断执行原代码。
$stopDefinition = $entryAst.Find({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-WithCode'
}, $false)
$exitStatement = $stopDefinition.Find({ param($node) $node -is [Management.Automation.Language.ExitStatementAst] }, $true)
Assert-Test ($null -ne $exitStatement) '收尾保留明确的进程退出语句'
$stopText = $stopDefinition.Extent.Text
$start = $exitStatement.Extent.StartOffset - $stopDefinition.Extent.StartOffset
$stopText = $stopText.Remove($start, $exitStatement.Extent.Text.Length).Insert($start, 'return $Code')
& {
  function Write-Host { param($Object, $ForegroundColor, [switch]$NoNewline) }
  function Read-Host { $script:ReadCalls++; if ($script:ReadFailure) { throw 'fixture redirected input' }; return '' }
  . ([scriptblock]::Create($stopText))
  foreach ($menu in @($false, $true)) {
    foreach ($code in @(0, 1, 2)) {
      $script:MenuMode = $menu; $script:ReadCalls = 0; $script:ReadFailure = $false
      Assert-Test ((Stop-WithCode $code) -eq $code -and $script:ReadCalls -eq [int]$menu) "收尾码 $code 菜单=$menu 的等待次数正确"
    }
  }
  $script:ReadFailure = $true; $script:ReadCalls = 0
  Assert-Test ((Stop-WithCode 0) -eq 0 -and $script:ReadCalls -eq 1) '重定向输入异常也正常收尾'
  $script:ReadFailure = $false
  function Get-UpdatePreferencePath { return 'memory:updates' }
  function Get-UpdatePreference { param($Path); return $false }
  function Read-Host { return $script:MenuInputs.Dequeue() }
  # install/restore/start 会先确定 Postman 版本目录：这里桩掉 lib/查找Postman.ps1 的探测与解析，
  # 用内存值模拟“自动找到”与“拖入解析”，避免依赖真实文件系统。
  $script:FixtureFoundDir = 'fixture-app'
  function Find-InstalledPostmanAppDir { param($RepoRoot, [switch]$IncludeRunning); return $script:FixtureFoundDir }
  function Resolve-PostmanAppDirFromPath { param($PathValue); if ($PathValue -and "$PathValue".Trim()) { return ('resolved:' + "$PathValue".Trim()) }; return $null }
  # 记住上次拖入目录的偏好也用内存桩：$script:RememberedDir 模拟已持久化的值，
  # Set-RememberedPostmanDir 记录写入，避免读写真实 %APPDATA% 文件。
  $script:RememberedDir = $null
  $script:RememberedWrites = New-Object 'System.Collections.Generic.List[string]'
  function Get-RememberedPostmanDir { return $script:RememberedDir }
  function Set-RememberedPostmanDir { param($Dir); $script:RememberedWrites.Add($Dir) }
  function Select-FixtureMenu([string[]]$Choices) {
    $script:PostmanDir = $null  # 每次菜单相当于全新进程，目录未定
    $script:MenuInputs = New-Object 'System.Collections.Generic.Queue[string]'
    foreach ($choice in $Choices) { $script:MenuInputs.Enqueue($choice) }
    return (& $realShowMenu)
  }
  $menuCommands = @('install', 'verify', 'restore', 'start', 'stop', 'merge', 'updates', 'fix-browser', 'publish', 'stats')
  for ($i = 0; $i -lt $menuCommands.Count; $i++) {
    $choices = @([string]($i + 1))
    if ($menuCommands[$i] -eq 'updates') { $choices += '2' }
    $selection = Select-FixtureMenu $choices
    Assert-Test ($selection.Command -eq $menuCommands[$i]) "菜单 $($i + 1) 对应 $($menuCommands[$i])"
    $expectedArguments = if ($menuCommands[$i] -eq 'updates') { 'off' } else { '' }
    Assert-Test (($selection.Arguments -join '|') -eq $expectedArguments) "菜单 $($i + 1) 只携带必要参数"
  }
  Assert-Test ((Select-FixtureMenu @('')).Command -eq 'install') '真实菜单回车仍默认安装'
  Assert-Test ((Select-FixtureMenu @('7', '0', '6')).Command -eq 'merge') '更新子菜单返回后可选择合并'
  foreach ($choice in @('0', 'q')) {
    Assert-Test ($null -eq (Select-FixtureMenu @($choice))) "真实菜单 $choice 正常退出"
  }

  # install/restore/start 的版本目录确定：自动探测命中直接用，未命中则提示拖入并解析，回车放弃退回菜单。
  $script:FixtureFoundDir = 'auto-app'
  Assert-Test ((Select-FixtureMenu @('1')).Command -eq 'install' -and $script:PostmanDir -eq 'auto-app') '自动探测到 Postman 时菜单安装直接采用'
  $script:FixtureFoundDir = $null
  $dragged = Select-FixtureMenu @('1', 'C:\dragged\Postman')
  Assert-Test ($dragged.Command -eq 'install' -and $script:PostmanDir -eq 'resolved:C:\dragged\Postman') '找不到时拖入目录解析并用于安装'
  Assert-Test ($null -eq (Select-FixtureMenu @('3', '', '0'))) '拖入提示直接回车则放弃并退回菜单'

  # 记住上次拖入目录：拖入成功即记住；下次自动探测仍失败时无需再拖直接复用；自动探测命中优先于记忆。
  $script:FixtureFoundDir = $null
  $script:RememberedDir = $null
  $script:RememberedWrites = New-Object 'System.Collections.Generic.List[string]'
  [void](Select-FixtureMenu @('1', 'C:\dragged\Postman'))
  Assert-Test (($script:RememberedWrites -join '|') -eq 'resolved:C:\dragged\Postman') '拖入目录后记住解析结果供下次复用'
  $script:RememberedDir = 'remembered-app'
  Assert-Test ((Select-FixtureMenu @('1')).Command -eq 'install' -and $script:PostmanDir -eq 'remembered-app') '自动探测失败时沿用上次记住的目录，无需再拖入'
  $script:FixtureFoundDir = 'auto-app'
  Assert-Test ((Select-FixtureMenu @('1')).Command -eq 'install' -and $script:PostmanDir -eq 'auto-app') '自动探测命中时优先于记住的目录'
}

# 执行器的 stdout 不混入返回值；无外部命令的 PS 脚本不继承旧退出码。
& {
  function Write-Host { param($Object, $ForegroundColor, [switch]$NoNewline) }
  function Out-Host { param([Parameter(ValueFromPipeline)]$InputObject); process { } }
  function Test-Path { param($LiteralPath); return $true }
  function Get-Command { param($Name, $ErrorAction); return @{ Source = 'Invoke-FixtureNative' } }
  function Invoke-FixtureNative { Write-Output 'fixture stdout'; Write-Error 'fixture stderr'; $global:LASTEXITCODE = 2 }
  $actual = & $realChildProcess -FilePath 'fixture'
  Assert-Test ($actual -is [int] -and $actual -eq 2) '原生 stdout/stderr 不污染退出码 2'
  Assert-Test ($ErrorActionPreference -eq 'Stop') '原生执行器恢复错误处理偏好'
  function Invoke-ChildProcess { param($FilePath, $Arguments); return 2 }
  Assert-Test ((& $realNodeScript -ScriptPath 'fixture.js') -eq 2) 'Node 执行器仅返回子进程退出码'
  Assert-Test ((& $realPowerShellScript -ScriptPath 'fixture.ps1' -Arguments @('-TestOnly')) -eq 2) '透传 PS 执行器保留退出码'
  function Invoke-FixturePowerShell { Write-Output 'fixture stdout' }
  $global:LASTEXITCODE = 9
  Assert-Test ((& $realPowerShellScript -ScriptPath 'Invoke-FixturePowerShell') -eq 0) '普通 PS 成功不继承旧退出码'
  Assert-TestThrows { & $realPowerShellScript -ScriptPath 'fixture' -Parameters @{ A = 1 } -Arguments @('x') } '内部调用错误' '参数表和透传参数互斥'
}

# 进程计数波动：中间短暂为零不等于退出，默认最多 20 轮、间隔 500ms。
& {
  function Write-Host { param($Object, $ForegroundColor, [switch]$NoNewline) }
  function Reset-ProcessFixture([object[]]$States) {
    $script:Fixture = @{ States = $States; Reads = 0; Kills = New-Object 'System.Collections.Generic.List[int]'; Sleeps = New-Object 'System.Collections.Generic.List[int]' }
  }
  function Get-Process {
    param($Name, $ErrorAction)
    if ($Name -ne 'Postman') { throw 'unexpected process name' }
    $index = [Math]::Min($script:Fixture.Reads, $script:Fixture.States.Count - 1)
    $script:Fixture.Reads++
    foreach ($id in $script:Fixture.States[$index].Ids) { [pscustomobject]@{ Id = $id } }
  }
  function Stop-Process { param([int]$Id, [switch]$Force, $ErrorAction); $script:Fixture.Kills.Add($Id) }
  function Start-Sleep { param([int]$Milliseconds); $script:Fixture.Sleeps.Add($Milliseconds) }
  Reset-ProcessFixture @(@{Ids=@(11)}, @{Ids=@(11)}, @{Ids=@()}, @{Ids=@()}, @{Ids=@(22)}, @{Ids=@()}, @{Ids=@()}, @{Ids=@()})
  Stop-PostmanCompletely
  Assert-Test (($script:Fixture.Kills -join ',') -eq '11,22' -and $script:Fixture.Reads -eq 8) '进程再次出现后重新连续检查三次'
  Assert-Test ($script:Fixture.Sleeps.Count -eq 6 -and @($script:Fixture.Sleeps | Where-Object { $_ -ne 500 }).Count -eq 0) '共享关闭使用 500ms 间隔'
  Reset-ProcessFixture @(@{Ids=@(11)})
  Assert-TestThrows { Stop-PostmanCompletely } '仍有 1 个' '持续存活的进程明确失败'
  Assert-Test ($script:Fixture.Kills.Count -eq 20 -and $script:Fixture.Sleeps.Count -eq 19) '共享关闭限制为 20 轮'
  Reset-ProcessFixture @(@{Ids=@()})
  Assert-TestThrows { Stop-PostmanCompletely -MaxRounds 2 } '未能连续 3 次' '不足三次空检查不报告成功'
}

# 虚拟时钟控制端口文件出现、无效端口、端口变化及请求异常，不发真实 CDP 请求。
& {
  function Reset-PortFixture([object[]]$States) {
    $script:Fixture = @{ States = $States; Ms = 0; Reads = New-Object 'System.Collections.Generic.List[string]'; Requests = New-Object 'System.Collections.Generic.List[object]' }
  }
  function Get-PortState { return ($script:Fixture.States | Where-Object { $_.At -le $script:Fixture.Ms } | Select-Object -Last 1) }
  function Get-Date { return ([datetime]'2020-01-01').AddMilliseconds($script:Fixture.Ms) }
  function Start-Sleep { param([int]$Milliseconds); $script:Fixture.Ms += $Milliseconds }
  function Test-Path { param($LiteralPath, $PathType); return [bool](Get-PortState).Exists }
  function Get-Content {
    param($LiteralPath, $TotalCount, $Encoding, $ErrorAction)
    if ($TotalCount -ne 1 -or $Encoding -ne 'UTF8') { throw 'expected first UTF8 line' }
    $state = Get-PortState
    $script:Fixture.Reads.Add($state.Port)
    return $state.Port
  }
  function Invoke-RestMethod {
    param($Uri, $TimeoutSec, $ErrorAction)
    $script:Fixture.Requests.Add(@{ Uri = $Uri; Timeout = $TimeoutSec })
    $state = Get-PortState
    if ($state.Fail) { throw 'fixture connection not ready' }
    if ($state.Url) { return @([pscustomobject]@{ type = 'page'; url = $state.Url; webSocketDebuggerUrl = 'memory:socket' }) }
    return @()
  }
  Reset-PortFixture @(
    @{At=0; Exists=$false},
    @{At=500; Exists=$true; Port='invalid'},
    @{At=1000; Exists=$true; Port='40101'; Fail=$true},
    @{At=1500; Exists=$true; Port='40102'; Url='https://desktop.postman.com/?fixture=1'}
  )
  $port = Wait-PostmanReady -PortFile 'memory:port' -TimeoutSec 5
  Assert-Test ($port -eq 40102 -and $script:Fixture.Ms -eq 1500) '端口延迟出现后及时返回，无固定等待'
  Assert-Test (($script:Fixture.Reads -join ',') -eq 'invalid,40101,40102') '每轮重读端口且忽略无效半写入值'
  Assert-Test (($script:Fixture.Requests.Uri -join ',') -eq 'http://127.0.0.1:40101/json/list,http://127.0.0.1:40102/json/list') '端口变化后不复用旧地址'
  Reset-PortFixture @(@{At=0; Exists=$false})
  Assert-TestThrows { Wait-PostmanReady -PortFile 'memory:port' -TimeoutSec 2 } '等待 2 秒' '端口一直缺失时有界超时'
  Assert-Test ($script:Fixture.Ms -eq 2000 -and $script:Fixture.Requests.Count -eq 0) '缺失端口不发请求且不超出预算'
  Reset-PortFixture @(@{At=0; Exists=$true; Port='40101'; Url='https://desktop.postman.com.example.invalid/'})
  Assert-TestThrows { Wait-PostmanReady -PortFile 'memory:port' -TimeoutSec 1 } '等待 1 秒' '域名相似的辅助页面不算主页面'
  Assert-Test (@($script:Fixture.Requests | Where-Object { $_.Timeout -gt 1 }).Count -eq 0) 'CDP 单次超时限制在剩余预算内'
  Reset-PortFixture @(@{At=0; Exists=$true; Port='70000'})
  Assert-TestThrows { Wait-PostmanReady -PortFile 'memory:port' -TimeoutSec 1 } '等待 1 秒' '越界端口有界等待'
  Assert-Test ($script:Fixture.Requests.Count -eq 0) '越界端口不用于请求'
  Reset-PortFixture @(@{At=0; Exists=$true; Port='40103'; Url='file:///fixture/resources/app.asar/html/requester.html'})
  Assert-Test ((Wait-PostmanReady -PortFile 'memory:port' -TimeoutSec 1) -eq 40103) '保留本地 requester 页面兼容'
}

& {
  function Write-Host { param($Object, $ForegroundColor, [switch]$NoNewline) }
  function Get-PostmanPortFile {
    param($UserDataDir)
    if ($UserDataDir) { return Join-Path $UserDataDir 'DevToolsActivePort' }
    return 'memory:port'
  }
  function Test-Path { param($LiteralPath); return $true }
  function New-Item { param($ItemType, $Path, [switch]$Force); $script:Calls.Add('mkdir'); $script:CreatedProfile = $Path }
  function Remove-Item { param($LiteralPath, [switch]$Force, $ErrorAction); $script:Calls.Add('clear'); $script:ClearedPort = $LiteralPath }
  function Start-PostmanDetached { param($FilePath, $ArgumentList); $script:Calls.Add("start:$ArgumentList"); $script:LaunchArguments = @($ArgumentList) }
  function Wait-PostmanReady { param($TimeoutSec, $PortFile); $script:Calls.Add("wait:$TimeoutSec"); $script:WaitedPort = $PortFile; return 40101 }
  foreach ($noWait in @($false, $true)) {
    $script:Calls = New-Object 'System.Collections.Generic.List[string]'
    Start-PostmanDebugSession -FilePath 'memory:Postman.exe' -TimeoutSec 90 -NoWait:$noWait
    $expected = 'clear,start:--remote-debugging-port=0'
    if (-not $noWait) { $expected += ',wait:90' }
    Assert-Test (($script:Calls -join ',') -eq $expected) "调试启动清旧端口、随机端口与 NoWait=$noWait 的调用顺序"
  }
  foreach ($noWait in @($false, $true)) {
    $script:Calls = New-Object 'System.Collections.Generic.List[string]'
    $script:CreatedProfile = ''; $script:ClearedPort = ''; $script:WaitedPort = ''
    $profile = 'C:\fixture profile\Postman'
    Start-PostmanDebugSession -FilePath 'memory:Postman.exe' -TimeoutSec 90 -NoWait:$noWait -UserDataDir $profile
    $expected = "mkdir,clear,start:--remote-debugging-port=0 --user-data-path=$profile"
    if (-not $noWait) { $expected += ',wait:90' }
    Assert-Test (($script:Calls -join ',') -eq $expected) "独立目录先创建再启动，保留 NoWait=$noWait 语义"
    Assert-Test ($script:CreatedProfile -eq $profile -and $script:ClearedPort -eq "$profile\DevToolsActivePort") '独立启动只清理目标目录的旧端口'
    Assert-Test ($script:LaunchArguments.Count -eq 2 -and $script:LaunchArguments[1] -eq "--user-data-path=$profile") '含空格的数据目录作为单个启动参数'
    $expectedPort = if ($noWait) { '' } else { "$profile\DevToolsActivePort" }
    Assert-Test ($script:WaitedPort -eq $expectedPort) '独立启动轮询使用同一个数据目录'
  }
}

Assert-Test ((Get-PostmanPortFile -UserDataDir 'C:\fixture profile\Postman') -eq 'C:\fixture profile\Postman\DevToolsActivePort') '显式数据目录优先定位调试端口'
Assert-Test ((Get-PostmanPortFile) -eq (Join-Path $env:APPDATA 'Postman\DevToolsActivePort')) '默认端口文件位置保持不变'
Assert-Test ((ConvertTo-NativeArgument '--user-data-path=C:\fixture profile\Postman') -eq '"--user-data-path=C:\fixture profile\Postman"') '含空格的数据目录传给 Windows 启动器时正确加引号'

$startupAst = Read-TestAst (Join-Path $internalRoot '启动程序.ps1')
& {
  function Start-PostmanDebugSession {
    param($FilePath, $TimeoutSec, [switch]$NoWait, $UserDataDir)
    $script:StartupArguments = @{ FilePath = $FilePath; TimeoutSec = $TimeoutSec; NoWait = $NoWait; UserDataDir = $UserDataDir }
  }
  $exe = 'memory:Postman.exe'; $TimeoutSec = 91; $NoWait = $true; $UserDataDir = 'C:\fixture profile\Postman'
  & ([scriptblock]::Create($startupAst.EndBlock.Statements[-1].Extent.Text))
  Assert-Test ($script:StartupArguments.FilePath -eq $exe -and $script:StartupArguments.TimeoutSec -eq 91 -and $script:StartupArguments.NoWait -and $script:StartupArguments.UserDataDir -eq $UserDataDir) '启动脚本把独立数据目录交给共享调试启动器'
}

$installerAst = Read-TestAst (Join-Path $internalRoot '安装汉化.ps1')
$restartBlock = $installerAst.Find({ param($node)
  $node -is [Management.Automation.Language.IfStatementAst] -and
  $node.Clauses[0].Item1.Extent.Text -eq '-not $NoRestart' -and
  $node.Extent.Text -match 'Start-PostmanDebugSession'
}, $true)
Assert-Test ($null -ne $restartBlock) '安装重启使用共享调试启动器'
& {
  function Write-Step { param($Message) }
  function Start-PostmanDebugSession { param($FilePath); $script:RestartCalls.Add('debug') }
  function Start-PostmanDetached { param($FilePath); $script:RestartCalls.Add('normal') }
  $appDir = $internalRoot
  foreach ($NoRestart in @($false, $true)) {
    foreach ($Verify in @($false, $true)) {
      $script:RestartCalls = New-Object 'System.Collections.Generic.List[string]'
      & ([scriptblock]::Create($restartBlock.Extent.Text))
      $expected = if ($NoRestart) { '' } elseif ($Verify) { 'debug' } else { 'normal' }
      Assert-Test (($script:RestartCalls -join ',') -eq $expected) "安装 NoRestart=$NoRestart / Verify=$Verify 保持原有启动语义"
    }
  }
}

if ($Details) { foreach ($name in $script:Checks) { Write-Host "  [通过] $name" } }
Write-Host "[Postman 汉化] 入口与进程隔离回归通过（$($script:Checks.Count) 项）。"
