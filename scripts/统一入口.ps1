param(
  [Parameter(Position = 0)]
  [string]$Command = '',

  [string]$PostmanDir,
  [string]$UserDataDir,
  [int]$TimeoutSec = 60,
  [switch]$NoWait,
  [switch]$NoRestart,
  [switch]$KeepUpdates,
  [switch]$NoVerify,
  [switch]$CleanOldVersions,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArguments
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptsRoot = $PSScriptRoot
$internalRoot = Join-Path $PSScriptRoot 'internal'
$dataRoot = Join-Path $PSScriptRoot 'data'
$maintenanceRoot = Join-Path $PSScriptRoot 'maintenance'
. (Join-Path $PSScriptRoot 'lib\查找Postman.ps1')
Set-Location -LiteralPath $repoRoot

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

# 只有最外层负责退出：菜单模式手动回车关闭，命令行模式直接返回退出码。
$script:MenuMode = $false

function Wait-BeforeClose {
  Write-Host '按回车键关闭窗口… ' -NoNewline -ForegroundColor DarkGray
  try {
    Read-Host | Out-Null
  } catch {
    # stdin 被重定向（自动化调用意外进了菜单模式）时 Read-Host 会抛异常，
    # 此时不该无限阻塞，直接返回让进程退出。
    Write-Host ''
  }
}

function Stop-WithCode {
  param([int]$Code = 0)
  if ($script:MenuMode) {
    Write-Host ''
    if ($Code -eq 0) {
      Write-Host '操作完成。' -ForegroundColor Green
    } else {
      Write-Host "操作失败（退出码 $Code）。上面的中文提示说明了原因。" -ForegroundColor Yellow
    }
    Wait-BeforeClose
  }
  exit $Code
}

# 自动更新开关的偏好文件。主进程守卫（安装汉化.ps1 注入到 main.js）在每次更新
# 调用时读它，Postman「设置 > 更新」页里的开关经 IPC 写它。这里是应用起不来、
# 或想在命令行里直接改时的兜底入口。
# 注意必须写成无 BOM：守卫用 JSON.parse 读，BOM 会让解析失败并静默退回“已关闭”。
function Get-UpdatePreferencePath {
  if (-not $env:APPDATA) {
    throw '找不到 APPDATA 目录，无法定位自动更新开关配置。'
  }
  return Join-Path (Join-Path $env:APPDATA 'Postman') 'postman-zh-updates.json'
}

function Get-UpdatePreference {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    return [bool]((Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json).enabled)
  } catch {
    return $false
  }
}

function Set-UpdatePreference {
  param([string]$Path, [bool]$Enabled)

  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $json = if ($Enabled) { '{"enabled":true}' } else { '{"enabled":false}' }
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding $false))
}

# 汉化版本检查的偏好文件。和上面那个是两回事：
#   上面那个管 Postman 官方升级，**不存在即关闭**（拦截才是安全默认值）；
#   这个只查本汉化包 GitHub 有没有新版，**不存在即开启**，只提示不下载。
# 主进程实现在 payload\zh-version-check-main.js，「设置 > 更新」页的开关经 IPC 写它。
# 同样必须无 BOM：那边用 JSON.parse 读。
function Get-ZhUpdatePreferencePath {
  if (-not $env:APPDATA) {
    throw '找不到 APPDATA 目录，无法定位汉化版本检查配置。'
  }
  return Join-Path (Join-Path $env:APPDATA 'Postman') 'postman-zh-version-check.json'
}

function Get-ZhUpdatePreference {
  param([string]$Path)

  # 文件不存在 = 默认开启
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  try {
    $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    # 只有显式写了 false 才算关闭，与主进程侧 raw.enabled !== false 保持一致
    return ($raw.enabled -ne $false)
  } catch {
    return $true
  }
}

function Set-ZhUpdatePreference {
  param([string]$Path, [bool]$Enabled)

  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  # 保留 dismissedTag：用户点过「不再提示此版本」的记忆不该被命令行清掉
  $dismissed = ''
  if (Test-Path -LiteralPath $Path) {
    try {
      $existing = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($existing.dismissedTag) { $dismissed = [string]$existing.dismissedTag }
    } catch { }
  }
  $payload = [ordered]@{ enabled = $Enabled; dismissedTag = $dismissed }
  $json = $payload | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding $false))
}

# 记住上一次在菜单里拖入的 Postman 目录。给 Postman 常驻非标准位置（如桌面）的用户免去重复拖拽：
# 自动探测仍失败时直接复用这个目录。和上面两个开关一样写在 %APPDATA%/Postman 下、无 BOM，
# 但这是纯本地便利项——读写失败一律静默忽略，绝不因此打断安装、还原或启动。
function Get-PostmanDirPreferencePath {
  if (-not $env:APPDATA) { return $null }
  return Join-Path (Join-Path $env:APPDATA 'Postman') 'postman-zh-postman-dir.json'
}

function Get-RememberedPostmanDir {
  $path = Get-PostmanDirPreferencePath
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $saved = [string]((Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json).dir)
    if ([string]::IsNullOrWhiteSpace($saved)) { return $null }
    # 记住的目录可能已被删除或再次移动：用时重新解析校验，失效即视为没有记忆。
    return (Resolve-PostmanAppDirFromPath $saved)
  } catch {
    return $null
  }
}

function Set-RememberedPostmanDir {
  param([string]$Dir)
  $path = Get-PostmanDirPreferencePath
  if (-not $path -or [string]::IsNullOrWhiteSpace($Dir)) { return }
  try {
    $parent = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $json = ([ordered]@{ dir = $Dir } | ConvertTo-Json -Compress)
    [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding $false))
  } catch { }
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

function Invoke-ChildProcess {
  param([string]$FilePath, [string[]]$Arguments = @())

  $program = Get-Command $FilePath -ErrorAction Stop
  $previousPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 会将原生 stderr 包成 ErrorRecord；成败仍按进程退出码。
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    & $program.Source @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) }
    $code = $global:LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  return [int]$code
}

function Invoke-NodeScript {
  param(
    [Parameter(Mandatory)][string]$ScriptPath,
    [string[]]$Arguments = @()
  )

  if (-not (Test-Path -LiteralPath $ScriptPath)) {
    throw "找不到脚本：$ScriptPath"
  }
  return (Invoke-ChildProcess -FilePath 'node' -Arguments (@($ScriptPath) + @($Arguments)))
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
    return (Invoke-ChildProcess -FilePath 'powershell.exe' -Arguments (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + @($Arguments)))
  }
  # 无原生命令的脚本正常返回时也应为 0，避免继承上一条命令的退出码。
  $global:LASTEXITCODE = 0
  & $ScriptPath @Parameters | Out-Host
  return [int]$global:LASTEXITCODE
}

function Invoke-ZhUpdateCheck {
  Assert-NodeRuntime
  $checkScript = Join-Path $repoRoot 'payload\zh-version-check-main.js'
  if (-not (Test-Path -LiteralPath $checkScript)) { throw '找不到汉化版本检查脚本。' }
  # 复用主进程实现；临时调用器仅打印状态，最终收尾前先执行 finally 清理。
  $inline = @'
const m = require(process.argv[2]);
m.check(true).then((r) => {
  if (r.status === 'disabled') { console.log('汉化版本检查已关闭。先运行 zh-updates on 再查。'); return; }
  if (r.status === 'error') {
    if (/rate limited/.test(r.detail || '')) { console.log('GitHub 接口访问次数暂时用尽，过一会儿会自动恢复。'); }
    else { console.log('暂时查不到最新版本（' + (r.detail || '未知原因') + '）。'); }
    return;
  }
  if (r.status === 'update-available') {
    console.log('发现新版本 ' + r.latestVersion + '（当前 v' + (r.localVersion || '?') + '）');
    console.log('下载地址：' + r.url);
    return;
  }
  if (r.status === 'local-unpublished') {
    console.log('当前 Postman v' + (r.localVersion || '?') + ' 对应的汉化包尚未在 GitHub 发布。');
    console.log('最新已发布版本：' + r.latestVersion);
    console.log('发布页：' + r.page);
    return;
  }
  if (r.status === 'release-incomplete') {
    console.log('GitHub 上的 ' + r.latestVersion + ' 汉化产物尚未上传完整，请稍后再检查。');
    console.log('发布页：' + r.page);
    return;
  }
  if (r.status === 'latest') {
    console.log('已是 GitHub 最新已发布汉化版本（' + r.latestVersion + '）。');
    return;
  }
  console.log('暂未确认 GitHub 发布状态，请稍后再试。');
}).catch((e) => { console.log('查询失败：' + ((e && e.message) || e)); process.exit(1); });
'@
  $tmp = Join-Path $env:TEMP ("postman-zh-check-{0}.js" -f ([guid]::NewGuid().ToString('N')))
  try {
    [System.IO.File]::WriteAllText($tmp, $inline, (New-Object System.Text.UTF8Encoding $false))
    return (Invoke-NodeScript $tmp @($checkScript))
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Show-Help {
  Write-Host @'
Postman 中文汉化工具

唯一入口：双击 postman-zh.bat（弹出交互菜单），或在 PowerShell 中运行：
  .\postman-zh.bat <命令> [参数]

常用命令：
  install       安装汉化、安装更新守卫并验证（保留已有开关偏好；菜单 1 / 回车成功后清理旧版）
  restore       还原英文原版
  updates       查看自动更新开关；updates on 允许更新，updates off 恢复拦截（默认）
  zh-updates    查看汉化版本检查开关；zh-updates on|off 切换（默认开启），zh-updates check 立即查一次
  verify        只验证当前 Postman 汉化状态；加 --details 查看完整诊断
                使用 install -KeepUpdates 安装的实例，请用 verify -KeepUpdates 验证
  test          运行离线隔离回归；加 --details 查看分项，不启动 Postman、不连接网络
  start         启动 Postman 并等待 CDP 调试端口
                -UserDataDir <目录> 使用独立 Postman 数据目录（汉化偏好仍由 APPDATA 定位）
  stop          彻底关闭 Postman 进程
  fix-browser   修复系统浏览器 URL 参数引号
  merge         合并 _generated/trans-*.json 译文；加 --check 只检查、不写入
  publish       调用维护者发布脚本
  stats         查看 GitHub 项目数据（Star、下载量、访问来源、热门页面）；加 --full 看完整 14 天逐日
  help          显示本帮助

安装示例：
  .\postman-zh.bat install
  .\postman-zh.bat install -CleanOldVersions
  .\postman-zh.bat install -PostmanDir C:\Path\To\Postman\app-<版本> -NoVerify
  .\postman-zh.bat restore

旧版本清理：
  菜单 1 / 直接回车：安装验证成功后自动清理旧 app-*、旧 nupkg，并精简 RELEASES。
  命令行 install 默认保留旧版本；需要清理时加 -CleanOldVersions。
  保留当前版本及其英文原版备份；安装或验证失败时跳过旧版清理。

自动更新开关：
  安装后默认拦截 Postman 自动更新，避免官方升级把汉化覆盖掉。
  也可以在 Postman 的「设置 > 更新」页里直接切换同一个开关。
  .\postman-zh.bat updates       查看当前状态
  .\postman-zh.bat updates on    允许 Postman 自动更新（升级后需要重新汉化）
  .\postman-zh.bat updates off   恢复拦截

汉化版本检查（与上面那个是两件事）：
  上面那个管 Postman 官方升级，默认关闭；这个只查本汉化包 GitHub 有没有新版，
  默认开启，只提示不自动下载。同一个开关也在「设置 > 更新」页里。
  .\postman-zh.bat zh-updates        查看当前状态
  .\postman-zh.bat zh-updates on     开启检查（默认）
  .\postman-zh.bat zh-updates off    关闭检查，一个请求都不发
  .\postman-zh.bat zh-updates check  刷新一小时普通缓存，立即查一次（保留限额退避）

发布预检：
  .\postman-zh.bat publish -CheckOnly  实际核验 GitHub 登录、仓库权限和发布环境，不推送或上传
  .\postman-zh.bat publish -TestOnly   只跑隔离回归，不连接 GitHub，不读取凭据
  网络异常与登录失效分别提示；未设置代理环境变量时沿用 Windows 已启用的静态代理。
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

# 菜单模式下为需要 Postman 的操作（install/restore/start）确定版本目录。
# 默认使用 Postman 官方安装位置自动探测；找不到时提示用户把 Postman 目录拖进来。
# 返回解析好的版本目录；用户直接回车放弃时返回 $null（调用方应退回菜单）。
function Resolve-PostmanDirForMenu {
  # 命令行在菜单前显式给了 -PostmanDir：宽松解析（版本目录或安装根目录都接受）后沿用。
  if ($script:PostmanDir) {
    $fromArg = Resolve-PostmanAppDirFromPath $script:PostmanDir
    if ($fromArg) { return $fromArg }
    Write-Host "指定的 -PostmanDir 不是有效的 Postman 目录：$($script:PostmanDir)" -ForegroundColor Yellow
  }

  # 默认：自动探测官方安装位置与正在运行的实例。
  $found = Find-InstalledPostmanAppDir -RepoRoot $repoRoot -IncludeRunning
  if ($found) {
    Write-Host "已找到 Postman：$found" -ForegroundColor DarkGray
    return $found
  }

  # 自动探测失败：先看上次记住的拖入目录，仍然有效就直接沿用，免得每次都拖。
  $remembered = Get-RememberedPostmanDir
  if ($remembered) {
    Write-Host "沿用上次记住的 Postman 目录：$remembered" -ForegroundColor DarkGray
    Write-Host '（如需更换，把新的 Postman 目录拖进来即可覆盖；或用 -PostmanDir 指定。）' -ForegroundColor DarkGray
    return $remembered
  }

  # 找不到：默认位置没有 Postman（可能装在别处或被移动过），提示拖入目录。
  Write-Host ''
  Write-Host '未在默认安装位置找到 Postman。' -ForegroundColor Yellow
  Write-Host '默认会自动使用 Postman 的安装位置；如果你把 Postman 装在别处或移动过，请把它的目录拖到这里再回车。'
  Write-Host '可以是含 Postman.exe 的版本目录（形如 app-12.x.y），也可以是含 app-* 子目录的安装根目录。'
  Write-Host '拖入成功后会记住这个目录，下次自动复用，不用再拖一遍。'
  Write-Host '直接回车则返回菜单，不做任何改动。'
  Write-Host ''

  while ($true) {
    $raw = ''
    try { $raw = (Read-Host '拖入 Postman 目录并回车（回车返回）') } catch { return $null }
    if ($null -eq $raw -or $raw.Trim() -eq '') { return $null }

    $resolved = Resolve-PostmanAppDirFromPath $raw
    if ($resolved) {
      Write-Host "已选择版本目录：$resolved" -ForegroundColor Green
      Set-RememberedPostmanDir $resolved  # 记住，下次自动探测失败时复用
      return $resolved
    }
    Write-Host '这个目录里没找到可汉化的 Postman（需要 Postman.exe 和 resources\app.asar，或含 app-* 子目录）。请重新拖入，或直接回车返回菜单。' -ForegroundColor Red
  }
}

# 双击 postman-zh.bat（不带任何命令）时显示的交互菜单。
# 返回值：@{ Command = '<命令>'; Arguments = @(...) }，或 $null 表示用户选择退出。
function Show-Menu {
  $items = @(
    @{ Key = '1';  Command = 'install';     Label = '安装汉化';         Note = '打补丁、关闭更新并验证；成功后清理旧版' }
    @{ Key = '2';  Command = 'verify';      Label = '验证汉化状态';     Note = '只检查，不改动' }
    @{ Key = '3';  Command = 'restore';     Label = '还原英文原版';     Note = '撤销汉化，恢复官方英文界面' }
    @{ Key = '4';  Command = 'start';       Label = '启动 Postman';     Note = '启动并等待 CDP 调试端口' }
    @{ Key = '5';  Command = 'stop';        Label = '关闭 Postman';     Note = '循环杀干净全部进程' }
    @{ Key = '6';  Command = 'merge';       Label = '合并译文';         Note = '把 _generated/trans-*.json 并入词典' }
    @{ Key = '7';  Command = 'updates';     Label = '自动更新开关';     Note = '默认关闭；开启后官方升级会覆盖汉化' }
    @{ Key = '8';  Command = 'fix-browser'; Label = '修复浏览器链接';   Note = '仅在登录页外部链接异常时用' }
    @{ Key = '9';  Command = 'publish';     Label = '发布（维护者）';   Note = '推送代码到 GitHub 并发 Release' }
    @{ Key = '10'; Command = 'stats';       Label = '查看项目数据';     Note = 'Star、下载量、访问与克隆趋势' }
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

    if ($picked.Command -eq 'updates') {
      $currentPref = Get-UpdatePreference -Path (Get-UpdatePreferencePath)
      while ($true) {
        Write-Host ''
        Write-Host '=== 自动更新开关 ===' -ForegroundColor Cyan
        if ($currentPref) {
          Write-Host '当前状态：已开启' -ForegroundColor Yellow
        } else {
          Write-Host '当前状态：已关闭（默认）' -ForegroundColor Green
        }
        Write-Host '开启后 Postman 可能自动升级，升级后界面会变回英文，需要重新安装汉化。'
        Write-Host ''
        Write-Host '  1   开启自动更新'
        Write-Host '  2   关闭自动更新'
        Write-Host '  0   返回上一级'
        Write-Host ''

        $updateChoice = ''
        try { $updateChoice = (Read-Host '请选择').Trim() } catch { return $null }
        if ($updateChoice -eq 'q' -or $updateChoice -eq 'Q') { return $null }
        if ($updateChoice -eq '0') { break }
        if ($updateChoice -eq '1') { $arguments = @('on'); break }
        if ($updateChoice -eq '2') { $arguments = @('off'); break }
        Write-Host "无效选择：$updateChoice，请重新输入。" -ForegroundColor Red
      }

      if ($arguments.Count -eq 0) { continue }
    }

    # install/restore/start 需要一个 Postman 版本目录：默认自动探测，找不到就提示拖入。
    if ($picked.Command -in @('install', 'restore', 'start')) {
      $resolvedDir = Resolve-PostmanDirForMenu
      if (-not $resolvedDir) { continue }  # 用户放弃 → 退回菜单
      $script:PostmanDir = $resolvedDir
    }

    Write-Host ''
    Write-Host "正在执行：$($picked.Label)" -ForegroundColor Cyan
    Write-Host ''
    return @{ Command = $picked.Command; Arguments = $arguments }
  }
}

function Invoke-SelectedCommand {
  param([string]$Command, [string[]]$RemainingArguments = @())

  $validCommands = @('install', 'restore', 'updates', 'zh-updates', 'verify', 'test', 'start', 'stop', 'fix-browser', 'merge', 'publish', 'stats', 'help')
  if ($validCommands -notcontains $Command) {
    Write-Host "未知命令：$Command"
    Write-Host "请运行 .\postman-zh.bat help 查看可用命令。"
    return 2
  }

  $nodeCommands = @('install', 'verify', 'test', 'merge', 'stats')
  if ($nodeCommands -contains $Command) {
    Assert-NodeRuntime
  }

  switch ($Command) {
    'help' {
      Show-Help
      return 0
    }

    'install' {
      $params = @{
        Latest = $true
        DisableUpdates = (-not $KeepUpdates)
        Verify = (-not $NoVerify)
      }
      if ($PostmanDir) { $params.PostmanDir = $PostmanDir }
      if ($NoRestart) { $params.NoRestart = $true }
      # 菜单 1（含直接回车）默认清理；命令行仍由显式参数选择。
      # 通过命名参数交给安装器，在安装/验证成功后执行，避免提前删除旧版。
      if ($CleanOldVersions -or $script:MenuMode) { $params.CleanOldVersions = $true }
      return (Invoke-PowerShellScript (Join-Path $internalRoot '安装汉化.ps1') $params)
    }

    'restore' {
      $params = @{ Latest = $true; RestoreOriginal = $true }
      if ($PostmanDir) { $params.PostmanDir = $PostmanDir }
      if ($NoRestart) { $params.NoRestart = $true }
      return (Invoke-PowerShellScript (Join-Path $internalRoot '安装汉化.ps1') $params)
    }

    'updates' {
      $prefPath = Get-UpdatePreferencePath
      $action = if ($RemainingArguments.Count -gt 0) { ([string]$RemainingArguments[0]).ToLowerInvariant() } else { '' }

      if ($action -eq '') {
        if (Get-UpdatePreference -Path $prefPath) {
          Write-Host '自动更新：已开启。Postman 可能自动升级，升级后界面会变回英文，需要重新运行 install。'
        } else {
          Write-Host '自动更新：已关闭（默认）。官方升级不会覆盖汉化。'
        }
      } elseif (@('on', 'enable', 'true', '1') -contains $action) {
        Set-UpdatePreference -Path $prefPath -Enabled $true
        Write-Host '自动更新已开启。升级后界面会变回英文，届时请重新运行 install 恢复汉化。'
      } elseif (@('off', 'disable', 'false', '0') -contains $action) {
        Set-UpdatePreference -Path $prefPath -Enabled $false
        Write-Host '自动更新已关闭，汉化不会被官方升级覆盖。'
      } else {
        Write-Host "无法识别的参数：$($RemainingArguments[0])"
        Write-Host '用法：.\postman-zh.bat updates [on|off]'
        return 2
      }
    }

    'zh-updates' {
      # 汉化包自己的版本检查。与 'updates' 无关：那个管 Postman 官方升级。
      $prefPath = Get-ZhUpdatePreferencePath
      $action = if ($RemainingArguments.Count -gt 0) { ([string]$RemainingArguments[0]).ToLowerInvariant() } else { '' }

      if ($action -eq '') {
        if (Get-ZhUpdatePreference -Path $prefPath) {
          Write-Host '汉化版本检查：已开启（默认）。启动或进入更新页即检查，之后每小时检查，支持手动刷新；只提示不自动下载。'
        } else {
          Write-Host '汉化版本检查：已关闭。不会发出任何网络请求。'
        }
      } elseif (@('on', 'enable', 'true', '1') -contains $action) {
        Set-ZhUpdatePreference -Path $prefPath -Enabled $true
        Write-Host '汉化版本检查已开启。有新版时会在右下角提示，可在「设置 > 更新」页关闭。'
      } elseif (@('off', 'disable', 'false', '0') -contains $action) {
        Set-ZhUpdatePreference -Path $prefPath -Enabled $false
        Write-Host '汉化版本检查已关闭。'
      } elseif (@('check', 'now') -contains $action) {
        return (Invoke-ZhUpdateCheck)
      } else {
        Write-Host "无法识别的参数：$($RemainingArguments[0])"
        Write-Host '用法：.\postman-zh.bat zh-updates [on|off|check]'
        return 2
      }
    }

    'verify' {
      $nodeArgs = @($RemainingArguments)
      if ($PostmanDir) { $nodeArgs += @('--postman-dir', $PostmanDir) }
      if (-not $KeepUpdates) { $nodeArgs += '--expect-updates-disabled' }
      return (Invoke-NodeScript (Join-Path $scriptsRoot '验证汉化.js') $nodeArgs)
    }

    'test' {
      $unknown = @($RemainingArguments | Where-Object { $_ -and $_ -notin @('--details', '-Details') })
      if ($unknown.Count -gt 0) {
        Write-Host '用法：.\postman-zh.bat test [--details]'
        return 2
      }
      $details = @($RemainingArguments | Where-Object { $_ -in @('--details', '-Details') }).Count -gt 0
      $nodeArgs = if ($details) { @('--details') } else { @() }
      $code = Invoke-NodeScript (Join-Path $scriptsRoot '运行回归.js') $nodeArgs
      if ($code -ne 0) { return $code }
      $testParameters = @{}
      if ($details) { $testParameters.Details = $true }
      $code = Invoke-PowerShellScript (Join-Path $maintenanceRoot '验证入口进程.ps1') $testParameters
      if ($code -ne 0) { return $code }
      return (Invoke-PowerShellScript (Join-Path $maintenanceRoot '验证发布预检.ps1') @{})
    }

    'start' {
      $params = @{ TimeoutSec = $TimeoutSec }
      if ($PostmanDir) { $params.PostmanDir = $PostmanDir }
      if ($UserDataDir) { $params.UserDataDir = $UserDataDir }
      if ($NoWait) { $params.NoWait = $true }
      return (Invoke-PowerShellScript (Join-Path $internalRoot '启动程序.ps1') $params)
    }

    'stop' {
      return (Invoke-PowerShellScript (Join-Path $internalRoot '关闭程序.ps1') @{})
    }

    'fix-browser' {
      return (Invoke-PowerShellScript (Join-Path $internalRoot '修复浏览器链接.ps1') @{})
    }

    'merge' {
      return (Invoke-NodeScript (Join-Path $dataRoot '合并译文.js') @($RemainingArguments))
    }

    'publish' {
      return (Invoke-PowerShellScript (Join-Path $maintenanceRoot '发布中文版.ps1') @{} @($RemainingArguments))
    }

    'stats' {
      # 只读 GitHub 公开数据 + 本仓库流量，走 gh CLI（认证由 gh 管，脚本里不出现令牌）
      # 输出是整屏表格，靠 Stop-WithCode 的手动等待留给用户读完。
      return (Invoke-NodeScript (Join-Path $maintenanceRoot '查看项目数据.js') @($RemainingArguments))
    }
  }
  return 0
}

function Invoke-EntryPoint {
  param([string]$Command, [string[]]$Arguments = @())

  $script:MenuMode = -not $Command
  try {
    if ($script:MenuMode) {
      $selection = Show-Menu
      if (-not $selection) { return 0 }
      $Command = $selection.Command
      $Arguments = @($selection.Arguments) + @($Arguments)
    }
    return (Invoke-SelectedCommand -Command $Command -RemainingArguments $Arguments)
  } catch {
    Write-Host "[Postman 汉化] 错误：$($_.Exception.Message)" -ForegroundColor Red
    return 1
  }
}

Stop-WithCode -Code (Invoke-EntryPoint -Command $Command -Arguments $RemainingArguments)
