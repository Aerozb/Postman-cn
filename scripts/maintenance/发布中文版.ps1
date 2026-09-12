<#
  Postman-cn 一键发布脚本
  ------------------------------------------------------------------
  本脚本位于仓库内的 scripts\maintenance\，由根目录统一入口调用。
  发布前会扫描入库文件，避免个人信息随仓库公开。

  做四件事：
    1. 预检：git / gh / 当前账号 / 仓库权限 / 提交身份 / 磁盘空间
    2. 推送仓库代码到 GitHub（默认普通推送，-Force 才覆盖远程）
    3. 打包 Postman 完整绿色版 + 单独的 app.asar，发布到 Releases
    4. 确认资产上传成功后，删除本地打包产物（_release，约 280MB）
       想留着就加 -KeepArtifacts

  用法：
    .\postman-zh.bat publish
    .\postman-zh.bat publish -CheckOnly
    .\postman-zh.bat publish -SkipPush
    .\postman-zh.bat publish -SkipRelease
    .\postman-zh.bat publish -SkipRelease -Force
#>
[CmdletBinding()]
param(
  # 只跑预检，不做任何改动
  [switch]$CheckOnly,
  # 只运行隔离回归，不连接 GitHub，也不操作仓库或发布文件
  [switch]$TestOnly,
  # 跳过 git 推送
  [switch]$SkipPush,
  # 跳过打包与 Release
  [switch]$SkipRelease,
  # 跳过打包（复用已存在的压缩包）
  [switch]$SkipZip,
  # 强制覆盖远程历史（默认关闭，确需覆盖时显式传 -Force）
  [switch]$Force,
  # 覆盖已存在的同名 Release
  [switch]$ReplaceRelease,
  # 不询问，直接执行
  [switch]$Yes,
  # 发布成功后保留 _release 里的本地打包产物（默认上传成功即删除）
  [switch]$KeepArtifacts,
  # 指定要打包的 Postman 版本目录名，默认自动取最新的 app-*
  [string]$AppDir,
  # Release 标签，必须与包内版本对应；默认 v<版本号>
  [string]$Tag
)

$ErrorActionPreference = 'Stop'
$script:ExpectedRepo = 'Aerozb/Postman-cn'
$script:RepoDirName  = 'Postman-cn'

# ---------- 输出辅助 ----------
function Write-Head($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Write-Ok($t)   { Write-Host "  [通过] $t" -ForegroundColor Green }
function Write-Warn2($t){ Write-Host "  [注意] $t" -ForegroundColor Yellow }
function Write-Bad($t)  { Write-Host "  [缺失] $t" -ForegroundColor Red }
function Write-Info($t) { Write-Host "  $t" -ForegroundColor Gray }

# ---------- 原生命令调用助手 ----------
# Windows PowerShell 5.1 会把原生 exe 的 stderr 包装成 ErrorRecord，
# 配合 $ErrorActionPreference='Stop' 会让 git/gh 的正常提示（如
# "Everything up-to-date"、"warning: LF will be replaced"）直接终止脚本。
# 这里临时把 EAP 降为 Continue，只靠退出码判断成败。
function Invoke-Native {
  param([Parameter(Mandatory)][string]$Exe, [string[]]$Args = @())
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = (& $Exe @Args 2>&1 | Out-String)
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
  } finally { $ErrorActionPreference = $prev }
}

# 只使用明确的 HTTP/连接错误分类；gh auth status 的非零退出码还可能来自
# 网络故障、其他账号或其他主机，退出码与当前账号的登录状态须分别判断。
function Get-GitHubFailureKind {
  param([int]$Code, [string]$Message)
  if ($Code -eq 0) { return 'None' }
  if ($Message -match '(?i)rate.?limit|abuse detection|HTTP\s+429|retry-after') { return 'RateLimit' }
  if ($Message -match '(?i)HTTP\s+401|bad credentials') { return 'Credentials' }
  if ($Code -eq 4 -or $Message -match '(?i)not logged into any GitHub hosts|please run:\s*gh auth login|authentication required') { return 'LoginRequired' }
  if ($Message -match '(?i)HTTP\s+403|resource not accessible by') { return 'Permission' }
  if ($Message -match '(?i)HTTP\s+404|release not found|no release found') { return 'NotFound' }
  if ($Message -match '(?i)HTTP\s+5\d\d') { return 'Service' }
  if ($Message -match '(?i)\bEOF\b|TLS|SSL|x509|certificate|timed?\s*out|timeout|deadline exceeded|no such host|resolve host|connection|connectex|dial tcp|network is unreachable|proxyconnect') { return 'Network' }
  return 'Unknown'
}

function Get-GitHubFailureMessage {
  param([string]$Kind)
  switch ($Kind) {
    'LoginRequired' { return 'GitHub.com 尚未配置登录，请执行 gh auth login --hostname github.com。' }
    'Credentials' { return 'GitHub 返回 401，当前凭据已失效；请检查 GH_TOKEN/GITHUB_TOKEN，或执行 gh auth login --hostname github.com。' }
    'RateLimit' { return 'GitHub 请求额度受限，请等待额度恢复后重试；这不表示账号退出登录。' }
    'Permission' { return 'GitHub 返回访问权限错误，请检查仓库权限、组织 SSO 和 token 的资源授权。' }
    'NotFound' { return 'GitHub 目标未找到或对当前凭据不可见，请检查目标与访问权限。' }
    'Network' { return 'GitHub 连接异常，请检查网络或代理后重试；网络失败不代表登录失效。' }
    'Service' { return 'GitHub 服务暂时异常，请稍后重试。' }
    default { return 'GitHub 检查失败，检查结果尚未确认，请稍后重试。' }
  }
}

function Invoke-GitHubRead {
  param([string[]]$Arguments, [ValidateRange(1, 3)][int]$MaxAttempts = 3)
  # 仅供只读查询使用。写操作不自动重试，避免重复创建/删除 Release。
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $result = Invoke-Native gh $Arguments
    $kind = Get-GitHubFailureKind -Code $result.Code -Message $result.Out
    if ($kind -notin @('Network', 'Service') -or $attempt -eq $MaxAttempts) {
      return [pscustomobject]@{ Code = $result.Code; Out = $result.Out; Kind = $kind; Attempts = $attempt }
    }
    if ($attempt -eq 1) { Write-Info "GitHub 连接暂时异常，正在重试（最多 $MaxAttempts 次）。" }
    Start-Sleep -Milliseconds (600 * $attempt)
  }
}

function Read-GitHubJson {
  param([string[]]$Arguments, [string]$Action)
  $result = Invoke-GitHubRead -Arguments $Arguments
  if ($result.Code -ne 0) { throw ("${Action}：" + (Get-GitHubFailureMessage $result.Kind)) }
  try { $value = $result.Out | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "${Action}：GitHub 返回格式异常，已停止本次检查。" }
  if ($null -eq $value) { throw "${Action}：GitHub 返回空结果，已停止本次检查。" }
  return $value
}

function Get-PublishGitHubIdentity {
  # 直接核验 GitHub.com 当前活动凭据，不读取或打印 token，也不检查无关账号。
  $identity = Read-GitHubJson -Action '校验 GitHub 登录' -Arguments @('api', '--hostname', 'github.com', 'user', '--jq', '{login,id}')
  if ($identity.login -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$' -or
      ($identity.id -isnot [int] -and $identity.id -isnot [long]) -or $identity.id -le 0) {
    throw 'GitHub 账号信息不完整，已停止本次检查。'
  }
  return $identity
}

function Get-PublishGitHubRepository {
  $repo = Read-GitHubJson -Action '检查远程仓库' -Arguments @('api', '--hostname', 'github.com', "repos/$($script:ExpectedRepo)", '--jq', '{full_name,private,default_branch,permissions}')
  if ($repo.full_name -ine $script:ExpectedRepo -or -not $repo.default_branch -or $repo.private -isnot [bool] -or $null -eq $repo.permissions) {
    throw 'GitHub 仓库信息不完整，已停止本次检查。'
  }
  # 按目标仓库的实际权限检查，兼容 public_repo 和细粒度 token；
  # 不再把缺少文本形式的 Token scopes 当作“具有 repo 权限”。
  if ($repo.permissions.push -isnot [bool] -or -not $repo.permissions.push) {
    throw '当前 GitHub 凭据对目标仓库没有写权限；请检查账号、仓库授权及 token 的 Contents 读写权限。'
  }
  return $repo
}

function Get-PublishSystemProxy {
  param([object]$Settings)
  if ($null -eq $Settings -or $Settings.ProxyEnable -ne 1 -or -not $Settings.ProxyServer) { return $null }
  $server = ([string]$Settings.ProxyServer).Trim()
  $addresses = @{}
  if ($server.Contains('=')) {
    foreach ($part in ($server -split ';')) {
      if ($part -match '^\s*(https?)\s*=\s*(.+?)\s*$') { $addresses[$Matches[1].ToLowerInvariant()] = $Matches[2] }
    }
  } else {
    $addresses.https = $server
    $addresses.http = $server
  }
  # 只有 http= 的按协议代理并不代理 GitHub HTTPS，保持 Windows 的原意。
  if (-not $addresses.https) { return $null }
  foreach ($protocol in @($addresses.Keys)) {
    $address = [string]$addresses[$protocol]
    if ($address -notmatch '^[a-z][a-z0-9+.-]*://') { $address = 'http://' + $address }
    $uri = $null
    if (-not [Uri]::TryCreate($address, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https') -or -not $uri.Host -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { return $null }
    $addresses[$protocol] = $uri.AbsoluteUri.TrimEnd('/')
  }
  # 排除表也随静态系统代理继承；显式 NO_PROXY 在调用处保持优先。
  $bypass = @()
  foreach ($entry in (([string]$Settings.ProxyOverride) -split ';')) {
    $entry = $entry.Trim()
    if (-not $entry) { continue }
    if ($entry -eq '<local>') { $bypass += @('localhost', '127.0.0.1', '::1') }
    else { $bypass += $entry }
  }
  return [pscustomobject]@{ Https = $addresses.https; Http = $addresses.http; NoProxy = ($bypass -join ',') }
}

function Initialize-PublishNetwork {
  # 双击 bat 的新进程没有维护终端里临时设置的 HTTPS_PROXY；仅在没有显式
  # 代理环境变量时沿用 Windows 已启用的静态代理，不写注册表或全局 Git 配置。
  foreach ($name in @('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY')) {
    if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) { return }
  }
  try {
    $settings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
    $proxy = Get-PublishSystemProxy $settings
    if ($null -eq $proxy) { return }
    $env:HTTPS_PROXY = $proxy.Https
    if ($proxy.Http) { $env:HTTP_PROXY = $proxy.Http }
    if (-not $env:NO_PROXY -and $proxy.NoProxy) { $env:NO_PROXY = $proxy.NoProxy }
    Write-Info '已沿用 Windows 系统代理（仅本次发布生效）。'
  } catch {
    Write-Warn2 '读取系统代理失败，继续使用当前网络设置。'
  }
}

# 只读取 ASAR 的 Pickle 文件头、JSON 索引及 package.json，不解包、不写临时文件。
# 流由调用方持有；离线回归可传入内存 ASAR，避免读取真实安装目录。
function Read-PublishAsarPackage {
  param([Parameter(Mandatory)][System.IO.Stream]$Stream)
  $reader = $null
  try {
    if (-not $Stream.CanRead -or -not $Stream.CanSeek -or $Stream.Length -lt 16) { throw '无效的 ASAR 流' }
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $reader = [System.IO.BinaryReader]::new($Stream, $utf8, $true)
    $Stream.Position = 0
    $sizePayload = $reader.ReadUInt32()
    $headerSize = $reader.ReadUInt32()
    $headerPayload = $reader.ReadUInt32()
    $jsonSize = $reader.ReadUInt32()
    if ($sizePayload -ne 4 -or $headerSize -lt 8 -or $headerSize -gt 16MB -or
        ($headerSize % 4) -ne 0 -or $headerPayload -ne ($headerSize - 4) -or
        $jsonSize -eq 0 -or $jsonSize -gt ($headerSize - 8) -or
        ($headerSize - 8 - $jsonSize) -gt 3 -or (8L + $headerSize) -gt $Stream.Length) {
      throw '无效的 ASAR 文件头'
    }
    $headerJson = $utf8.GetString($reader.ReadBytes([int]$jsonSize))
    if (-not $headerJson.TrimStart().StartsWith('{')) { throw '无效的 ASAR 索引对象' }
    $header = $headerJson | ConvertFrom-Json -ErrorAction Stop
    $entry = $header.files.'package.json'
    if ($null -eq $entry -or $entry.unpacked -or $null -ne $entry.link -or
        ($entry.size -isnot [int] -and $entry.size -isnot [long]) -or
        $entry.size -le 0 -or $entry.size -gt 1MB -or
        $entry.offset -isnot [string] -or $entry.offset -notmatch '^(0|[1-9][0-9]*)\z') {
      throw '无效的 package.json 索引'
    }
    $dataStart = 8L + $headerSize
    $offset = [long]$entry.offset
    if ($offset -gt ($Stream.Length - $dataStart - $entry.size)) { throw 'package.json 内容越界' }
    $Stream.Position = $dataStart + $offset
    $packageJson = $utf8.GetString($reader.ReadBytes([int]$entry.size))
    if (-not $packageJson.TrimStart().StartsWith('{')) { throw '无效的 package.json 对象' }
    return ($packageJson | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    throw 'app.asar 的 package.json 读取失败：文件头、索引或内容异常。'
  } finally {
    if ($reader) { $reader.Dispose() }
  }
}

function Get-PublishVersion {
  param([string]$AppDirectoryName, [object]$Package, [string]$ReleaseTag)
  if ($null -eq $Package -or $Package.name -isnot [string] -or $Package.name -cne 'Postman' -or
      $Package.version -isnot [string] -or $Package.version -notmatch '^[0-9]+(?:\.[0-9]+){1,3}\z') {
    throw 'app.asar 的 package.json 不是有效的 Postman 稳定版本。'
  }
  $packageVersion = $Package.version
  if ($AppDirectoryName -cne "app-$packageVersion") {
    throw "版本目录 $AppDirectoryName 与 app.asar 包内版本 $packageVersion 不一致。"
  }
  $expectedTag = "v$packageVersion"
  if ($ReleaseTag -and $ReleaseTag -cne $expectedTag) {
    throw "Release 标签 $ReleaseTag 与 app.asar 包内版本不一致；应为 $expectedTag。"
  }
  return [pscustomobject]@{ Version = $packageVersion; Tag = $expectedTag }
}

if ($TestOnly) {
  try {
    & (Join-Path $PSScriptRoot '验证发布预检.ps1')
    exit 0
  } catch {
    Write-Bad $_.Exception.Message
    exit 1
  }
}

# 发布附件必须按文件名、大小和 GitHub 返回的 SHA-256 与本机产物逐一对应。
# 只数 uploaded 的数量会把漏传、错传同名旧包等情况误当成功。
function Assert-ReleaseAssets {
  param([object]$Release, [string[]]$AssetPaths)
  if (@($Release.assets).Count -ne 2 -or @($AssetPaths).Count -ne 2) {
    throw 'Release 必须包含完整绿色版和 app.asar 两个附件。'
  }
  foreach ($file in $AssetPaths) {
    $local = Get-Item -LiteralPath $file
    $matches = @($Release.assets | Where-Object { $_.name -eq $local.Name })
    if ($matches.Count -ne 1 -or $matches[0].state -ne 'uploaded' -or
        $local.Length -le 0 -or $matches[0].size -ne $local.Length) {
      throw "附件名称、上传状态或大小校验失败：$($local.Name)"
    }
    $expectedDigest = 'sha256:' + (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($matches[0].digest -ne $expectedDigest) {
      throw "附件 SHA-256 校验失败：$($local.Name)"
    }
  }
}

function Get-ReleaseMetadata {
  param([string]$ReleaseTag)
  # /releases/tags 面向已发布版本；先由 gh 定位草稿/正式版，再按 ID 读取含 digest 的 REST 数据。
  $lookup = Invoke-GitHubRead -Arguments @('release', 'view', $ReleaseTag, '--repo', "github.com/$($script:ExpectedRepo)", '--json', 'databaseId', '--jq', '.databaseId')
  $releaseId = $lookup.Out.Trim()
  if ($lookup.Code -ne 0 -or $releaseId -notmatch '^\d+$') {
    throw '定位 GitHub Release 失败，保留本地产物供重试。'
  }
  return (Read-GitHubJson -Action '读取 Release 元数据' -Arguments @('api', '--hostname', 'github.com', "repos/$($script:ExpectedRepo)/releases/$releaseId"))
}

# 发布前只允许把正常的项目源码/文档加入提交。不要等 git add/commit
# 之后才检查：那样敏感文件虽未推送，也已经进入本地提交历史。
function Get-PublishCandidates {
  $result = Invoke-Native git @('-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard', '-z')
  if ($result.Code -ne 0) {
    Write-Bad "无法读取待发布文件列表：$($result.Out.Trim())"
    exit 1
  }
  # Out-String 会在最后一个 NUL 后补换行；去掉它，否则中文/普通文件名
  # 拼接绝对路径时会触发 Windows 的 Illegal characters in path。
  return @($result.Out -split "`0" |
    ForEach-Object { $_.TrimEnd("`r", "`n") } |
    Where-Object { $_ })
}

function Assert-PublishCandidates {
  param([string[]]$Files)

  $normalized = @($Files | ForEach-Object { $_ -replace '\\', '/' })
  $blocked = @($normalized | Where-Object {
      $_ -match '(^|/)_generated(?:/|$)' -or
      $_ -match '(^|/)[^/]*\.asar(?:\.[^/]*)?(?:/|$)' -or
      $_ -match '(^|/)(?:nav-surfaces[^/]*\.json)$' -or
      $_ -match '(^|/)(?:captures|User Data|Partitions|Local Storage|IndexedDB|Cache|Code Cache|GPUCache|Session Storage|Service Worker|Cookies)(?:/|$)' -or
      (($_ -match '\.(?:png|jpe?g|webp|gif|bmp)$') -and ($_ -notmatch '^assets/screenshots/'))
    })
  if ($blocked.Count -gt 0) {
    Write-Bad '待发布文件中发现不应入库的产物或用户数据：'
    $blocked | ForEach-Object { Write-Info "  $_" }
    Write-Info '请移出这些文件；仓库说明截图只能放在 assets/screenshots/。'
    exit 1
  }

  $badNames = @($normalized | Where-Object {
      $_ -match '(^|/)\.env(?:\.|$)|id_rsa|\.pem$|\.pfx$|\.p12$|credentials|hosts\.yml'
    })
  if ($badNames.Count -gt 0) {
    Write-Bad '待发布文件中发现疑似凭据文件：'
    $badNames | ForEach-Object { Write-Info "  $_" }
    exit 1
  }

  # 逐个扫小型文本文件里的 token 形态与本机账户路径。
  $credPattern = 'gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|' +
                 [regex]::Escape("C:\Users\$env:USERNAME")
  $leaks = @()
  foreach ($f in $normalized) {
    $full = Join-Path $repoDir $f
    if (-not (Test-Path -LiteralPath $full)) { continue }
    $fi = Get-Item -LiteralPath $full
    if ($fi.Length -gt 2MB) { continue }
    if ($fi.Extension -notmatch '^\.(ps1|js|md|bat|json|txt|yml|yaml|cfg|ini)$') { continue }
    try {
      if ((Get-Content -LiteralPath $full -Raw -ErrorAction Stop) -match $credPattern) { $leaks += $f }
    } catch { }
  }
  if ($leaks.Count -gt 0) {
    Write-Bad '待发布文件中发现 token 形态或本机账户路径：'
    $leaks | ForEach-Object { Write-Info "  $_" }
    exit 1
  }
  Write-Ok "入库文件安全自检通过（检查了 $($normalized.Count) 个文件）"
}

# ---------- 大文件关键串检索 ----------
# app.asar 有 120MB+，不能整文件读进内存。分块扫描，块间保留一段重叠，
# 避免关键串正好跨在两个块边界上被漏掉。
function Test-BinaryContains {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Needle
  )
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  $overlap = 512
  $fs = $null
  try {
    $fs = [System.IO.File]::OpenRead($Path)
    $buf = New-Object byte[] (4MB)
    $tail = ''
    while (($n = $fs.Read($buf, 0, $buf.Length)) -gt 0) {
      $chunk = $tail + [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
      if ($chunk.Contains($Needle)) { return $true }
      $tail = if ($chunk.Length -gt $overlap) { $chunk.Substring($chunk.Length - $overlap) } else { $chunk }
    }
  } finally { if ($fs) { $fs.Close() } }
  return $false
}

function Confirm-Step([string]$Message) {
  if ($Yes) { return $true }
  Write-Host ""
  Write-Host $Message -ForegroundColor Yellow
  $a = Read-Host "  继续？(y/N)"
  return ($a -eq 'y' -or $a -eq 'Y')
}

# ---------- 路径 ----------
# 本脚本支持放在仓库的 scripts\maintenance\ 下，也兼容放在
# postman-zh-workspace\ 下的旧位置。通过查找 payload\zh-localize.js 定位仓库。
$scriptDir = Split-Path -Parent $PSCommandPath
$repoDir = $null
$candidate = $scriptDir
while ($candidate) {
  if (Test-Path -LiteralPath (Join-Path $candidate 'payload\zh-localize.js')) {
    $repoDir = $candidate
    break
  }
  $parent = Split-Path -Parent $candidate
  if ($parent -eq $candidate) { break }
  $candidate = $parent
}
if (-not $repoDir) {
  $workspaceCandidate = Join-Path $scriptDir $script:RepoDirName
  if (Test-Path -LiteralPath (Join-Path $workspaceCandidate 'payload\zh-localize.js')) {
    $repoDir = $workspaceCandidate
  }
}
if (-not $repoDir) {
  throw "无法定位 Postman-cn 仓库：未找到 payload\zh-localize.js"
}
$workspaceRoot = Split-Path -Parent $repoDir
$postmanRoot = Split-Path -Parent $workspaceRoot            # ...\Desktop\Postman
$outDir      = Join-Path $workspaceRoot '_release'          # 产物始终放仓库外，不会被 git 看到

# =====================================================================
# 阶段 1：预检
# =====================================================================
$problems = New-Object System.Collections.Generic.List[string]

Write-Head '1. 环境预检'
Initialize-PublishNetwork

# --- git ---
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
  Write-Bad 'git 未安装。请装 Git for Windows: https://git-scm.com/download/win'
  $problems.Add('git 未安装')
} else {
  Write-Ok "git $((git --version) -replace '^git version ','')"
}

# --- gh CLI ---
$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghCmd) {
  Write-Bad 'GitHub CLI (gh) 未安装。装法：winget install GitHub.cli'
  $problems.Add('gh 未安装')
} else {
  Write-Ok "gh $(((gh --version) -split "`n")[0] -replace '^gh version ','')"
}

# --- GitHub.com 当前活动凭据 ---
$ghUser = $null
$ghIdentity = $null
if ($ghCmd) {
  try {
    $ghIdentity = Get-PublishGitHubIdentity
    $ghUser = $ghIdentity.login
    Write-Ok "已登录 GitHub.com 账号：$ghUser"
  } catch {
    Write-Bad $_.Exception.Message
    $problems.Add($_.Exception.Message)
  }
}

# --- git 提交身份 ---
$gitName  = (git config --get user.name)  2>$null
$gitEmail = (git config --get user.email) 2>$null
if (-not $gitName -or -not $gitEmail) {
  Write-Bad 'git 提交身份未配置（user.name / user.email 为空），提交会失败'
  $suggestName = if ($ghUser) { $ghUser } else { '你的用户名' }
  $uid = if ($ghIdentity) { $ghIdentity.id } else { $null }
  $suggestMail = if ($uid -and $ghUser) { "$uid+$ghUser@users.noreply.github.com" } else { '你的ID+你的用户名@users.noreply.github.com' }
  Write-Info '建议这样设置（noreply 邮箱不暴露真实邮箱，且能正常关联贡献图）：'
  Write-Info "  git config --global user.name  `"$suggestName`""
  Write-Info "  git config --global user.email `"$suggestMail`""
  $problems.Add('git 提交身份未配置')
} else {
  Write-Ok "提交身份：$gitName <$gitEmail>"
  if ($gitEmail -notmatch 'users\.noreply\.github\.com$') {
  Write-Warn2 '当前邮箱不是 noreply 邮箱，它会随每次提交永久公开'
  }
}

# --- 仓库目录 ---
if (-not (Test-Path -LiteralPath $repoDir)) {
  Write-Bad "找不到仓库目录：$repoDir"
  $problems.Add('仓库目录不存在')
} else {
  Write-Ok "仓库目录：$repoDir"
  if (-not (Test-Path -LiteralPath (Join-Path $repoDir 'payload\zh-localize.js'))) {
    Write-Bad '仓库内缺少 payload\zh-localize.js（词典本体）'
    $problems.Add('词典文件缺失')
  }
}

# --- AGENTS.md 体积 ---
# Codex 默认只读 AGENTS.md 的前 32 KiB（project_doc_max_bytes），超出部分静默截断、
# 不报错，于是 Codex 和 Claude Code 会看到不同的规则。把它当发布门槛，别等踩坑才发现。
# 注意 CRLF：本仓库入库是 LF，Windows 检出成 CRLF 后每行多 1 字节，所以留够余量。
$agentsMd = Join-Path $repoDir 'AGENTS.md'
if (Test-Path -LiteralPath $agentsMd) {
  $agentsBytes = (Get-Item -LiteralPath $agentsMd).Length
  $agentsFree  = 32768 - $agentsBytes
  if ($agentsBytes -gt 32768) {
    Write-Bad "AGENTS.md 有 $agentsBytes 字节，超过 Codex 上限 32768，尾部会被静默截断；把长内容移到 docs\ 并在 AGENTS.md 留指针"
    $problems.Add('AGENTS.md 超过 32 KiB')
  } elseif ($agentsBytes -gt 31744) {
    Write-Warn2 "AGENTS.md $agentsBytes 字节，距 Codex 32 KiB 上限只剩 $agentsFree 字节；再加长内容前先往 docs\ 搬"
  } else {
    Write-Ok "AGENTS.md $agentsBytes 字节（Codex 32 KiB 上限内，余量 $agentsFree）"
  }
}

# --- 远程仓库可写 ---
if ($ghCmd -and $ghUser) {
  try {
    $repoJson = Get-PublishGitHubRepository
    $visibility = if ($repoJson.private) { 'PRIVATE' } else { 'PUBLIC' }
    $perm = if ($repoJson.permissions.admin) { 'ADMIN' } elseif ($repoJson.permissions.maintain) { 'MAINTAIN' } else { 'WRITE' }
    Write-Ok "远程仓库 $($script:ExpectedRepo)（$visibility，默认分支 $($repoJson.default_branch)，权限 $perm）"
  } catch {
    Write-Bad $_.Exception.Message
    $problems.Add($_.Exception.Message)
  }
}

# --- 待打包的 Postman 版本 ---
$appPath = $null; $version = $null
if ($AppDir) {
  $appPath = if ([System.IO.Path]::IsPathRooted($AppDir)) { $AppDir } else { Join-Path $postmanRoot $AppDir }
} else {
  $cands = Get-ChildItem -LiteralPath $postmanRoot -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
           Sort-Object { try { [version]($_.Name -replace '^app-','') } catch { [version]'0.0.0' } } -Descending
  if ($cands) { $appPath = $cands[0].FullName }
}
if (-not $appPath -or -not (Test-Path -LiteralPath $appPath -PathType Container)) {
  Write-Bad "找不到 Postman 版本目录（$postmanRoot\app-*）"
  $problems.Add('Postman 版本目录不存在')
} else {
  $asar = Join-Path $appPath 'resources\app.asar'
  if (-not (Test-Path -LiteralPath $asar)) {
    Write-Bad "找不到 app.asar：$asar"
    $problems.Add('app.asar 不存在')
  } else {
    $asarStream = $null
    try {
      $asarStream = [System.IO.File]::OpenRead($asar)
      $package = Read-PublishAsarPackage -Stream $asarStream
      $releaseVersion = Get-PublishVersion -AppDirectoryName (Get-Item -LiteralPath $appPath).Name -Package $package -ReleaseTag $Tag
      $version = $releaseVersion.Version
      $Tag = $releaseVersion.Tag
      Write-Ok "待发布版本：$version（$appPath）"
      Write-Ok "目录、app.asar 包内版本与 Release 标签一致（$Tag）"
    } catch {
      Write-Bad $_.Exception.Message
      $problems.Add($_.Exception.Message)
    } finally {
      if ($asarStream) { $asarStream.Dispose() }
    }
    # 校验确实打过汉化补丁，别把英文原版发出去
    if (Test-BinaryContains -Path $asar -Needle 'postman-zh-localizer') { Write-Ok 'app.asar 已含汉化补丁标记' }
    else {
      Write-Bad 'app.asar 里没有汉化标记，可能是未汉化的原版！先跑 postman-zh.bat install'
      $problems.Add('app.asar 未汉化')
    }
  }
}

# --- 磁盘空间 ---
if ($appPath -and (Test-Path -LiteralPath $appPath)) {
  $srcBytes = (Get-ChildItem -LiteralPath $appPath -Recurse -File -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -ne 'app.asar.original' } |
               Measure-Object -Property Length -Sum).Sum
  $needGB  = [math]::Round(($srcBytes * 1.6) / 1GB, 1)   # 暂存副本 + 压缩包
  $drive   = (Get-Item -LiteralPath $workspaceRoot).PSDrive.Name
  $freeGB  = [math]::Round((Get-PSDrive $drive).Free / 1GB, 1)
  if ($freeGB -lt $needGB) {
    Write-Bad "磁盘空间不足：$drive 盘剩 ${freeGB}GB，打包约需 ${needGB}GB"
    $problems.Add('磁盘空间不足')
  } else {
    Write-Ok "磁盘空间：$drive 盘剩 ${freeGB}GB（打包约需 ${needGB}GB）"
  }
}

# --- 汇总 ---
Write-Head '预检结果'
if ($problems.Count -gt 0) {
  Write-Host "  发现 $($problems.Count) 个问题，需要先解决：" -ForegroundColor Red
  $i = 1
  foreach ($p in $problems) { Write-Host "    $i. $p" -ForegroundColor Red; $i++ }
  Write-Host ""
  Write-Host "  按上面每项的提示处理后重跑本脚本。" -ForegroundColor Yellow
  exit 1
}
Write-Host "  全部通过，可以发布。" -ForegroundColor Green

if ($CheckOnly) { Write-Host ""; Write-Host "（-CheckOnly 模式，未做任何改动）" -ForegroundColor Gray; exit 0 }

# =====================================================================
# 阶段 2：推送代码
# =====================================================================
if (-not $SkipPush) {
  Write-Head "2. 推送代码到 $($script:ExpectedRepo)"
  Push-Location -LiteralPath $repoDir
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $repoDir '.git'))) {
      Write-Info 'git 仓库未初始化，正在 init'
      git init -b main | Out-Null
    }
    # 远程地址对齐
    $cur = (git remote get-url origin 2>$null)
    if (-not $cur) { git remote add origin "https://github.com/$($script:ExpectedRepo).git" | Out-Null }
    elseif ($cur -notmatch [regex]::Escape($script:ExpectedRepo)) { git remote set-url origin "https://github.com/$($script:ExpectedRepo).git" | Out-Null }

    Assert-PublishCandidates (Get-PublishCandidates)
    Invoke-Native git @('add','-A') | Out-Null
    $staged = (git diff --cached --name-only | Measure-Object -Line).Lines
    $hasHead = ((Invoke-Native git @('rev-parse','--verify','HEAD')).Code -eq 0)

    if ($staged -gt 0) {
      Write-Info "$staged 个文件待提交"
      $c = Invoke-Native git @('commit','-q','-m',"Postman 中文汉化工具链 $version")
      if ($c.Code -ne 0) { Write-Bad "提交失败：`n$($c.Out)"; exit 1 }
      Write-Ok "已提交：$(git log -1 --pretty=%h) $version"
    } elseif ($hasHead) {
  Write-Info '工作区无改动，沿用当前提交'
    } else {
      Write-Bad '没有任何文件可提交'
      exit 1
    }

    $pushArgs = @('push','-u','origin','main')
    if ($Force) {
      Write-Warn2 "将【强制覆盖】远程 main 的全部历史，远程上不在本地的文件会消失（Release 资产不受影响）"
      if (-not (Confirm-Step "确认强推到 $($script:ExpectedRepo) main？")) { Write-Info '已取消推送'; $SkipPush = $true }
      $pushArgs = @('push','--force','-u','origin','main')
    }
    if (-not $SkipPush) {
      $p = Invoke-Native git $pushArgs
      if ($p.Code -ne 0) { Write-Bad "推送失败：`n$($p.Out)"; exit 1 }
      if ($p.Out -match 'Everything up-to-date') { Write-Info '远程已是最新，无需推送' }
      Write-Ok "推送完成（$(git rev-parse --short HEAD) -> origin/main）"
    }
  } finally { Pop-Location }
}

# =====================================================================
# 阶段 3：打包 + Release
# =====================================================================
if ($SkipRelease) {
  Write-Host ""
  Write-Host "完成（已跳过 Release）。" -ForegroundColor Green
  exit 0
}

Write-Head "3. 打包 Postman $version"
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$zipName  = "Postman-cn-$version-win64.zip"
$zipPath  = Join-Path $outDir $zipName
$asarSrc  = Join-Path $appPath 'resources\app.asar'
$asarOut  = Join-Path $outDir 'app.asar'

if ($SkipZip -and (Test-Path -LiteralPath $zipPath)) {
  Write-Info "复用已有压缩包：$zipName"
} else {
  # 组装绿色版目录：Postman.exe + Update.exe + app-<ver>\（不含 app.asar.original）
  $stage = Join-Path $outDir "_stage-$version"
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null

  Write-Info '复制版本目录（排除 app.asar.original 与日志，省 120MB）'
  $dest = Join-Path $stage (Split-Path -Leaf $appPath)
  # robocopy 比 Copy-Item 快且能按名排除；/NFL /NDL 静默文件级日志
  # Squirrel-*.log 含本机安装路径与 Windows 账户名，不能进公开压缩包
  $rc = Start-Process robocopy -ArgumentList @("`"$appPath`"", "`"$dest`"", '/E','/XF','app.asar.original','*.log','/NFL','/NDL','/NJH','/NJS','/NP','/R:1','/W:1') -Wait -PassThru -NoNewWindow
if ($rc.ExitCode -ge 8) { Write-Bad "robocopy 失败（退出码 $($rc.ExitCode)）"; exit 1 }

  foreach ($f in @('Postman.exe','Update.exe')) {
    $p = Join-Path $postmanRoot $f
    if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination $stage -Force }
  }
  # Squirrel 需要 packages\RELEASES 才认得版本，带上这一个小文件
  $rel = Join-Path $postmanRoot 'packages\RELEASES'
  if (Test-Path -LiteralPath $rel) {
    New-Item -ItemType Directory -Path (Join-Path $stage 'packages') -Force | Out-Null
    Copy-Item -LiteralPath $rel -Destination (Join-Path $stage 'packages') -Force
  }

  $stageMB = [math]::Round((Get-ChildItem -LiteralPath $stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
  Write-Ok "暂存目录就绪：${stageMB} MB"

  # --- 个人信息自检：压缩前拦一道，别把本机痕迹发上公网 ---
  # 只查体积小的文本/日志/配置；app.asar 是二进制，单独在下面按关键串扫
  # 注意：-Include 配合 -Recurse 会误纳其他文件，这里用 Where-Object 精确按扩展名过滤，
  #       并跳过 >1MB 的文件（真正的文本配置都很小，避免把 122MB 的 asar 当文本读）
  $textExt = @('.log','.json','.txt','.ini','.cfg')
  $leakNames = @()
  Get-ChildItem -LiteralPath $stage -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $textExt -contains $_.Extension.ToLower() -and $_.Length -lt 1MB } |
    ForEach-Object { $leakNames += $_.FullName.Substring($stage.Length + 1) }
  # 只认本机真实痕迹：当前 Windows 账户路径、noreply 邮箱、工作区目录名。
  # 不能用宽泛的 C:\Users\ ——官方依赖的调试符号里有构建机路径（如 C:\Users\circleci\...），会误报
  $leakPattern = [regex]::Escape("C:\Users\$env:USERNAME") + '|users\.noreply|postman-zh-workspace'
  if ($leakNames.Count -gt 0) {
    $bad = @()
    foreach ($rel2 in $leakNames) {
      $full = Join-Path $stage $rel2
      try {
        $txt = Get-Content -LiteralPath $full -Raw -ErrorAction Stop
        if ($txt -match $leakPattern) { $bad += $rel2 }
      } catch { }
    }
    if ($bad.Count -gt 0) {
      Write-Bad "压缩包内以下文件含本机路径/个人标识，已中止："
      $bad | ForEach-Object { Write-Info "  $_" }
      Write-Info '请在 robocopy 的 /XF 列表里排除它们后重跑'
      Remove-Item -LiteralPath $stage -Recurse -Force
      exit 1
    }
  }
  Write-Ok "个人信息自检通过（检查了 $($leakNames.Count) 个文本/配置文件）"

  # app.asar 里不能有硬编码的账号名（词典曾误收 "<用户名> (you)" 词条）
  $stageAsar = Join-Path $dest 'resources\app.asar'
  if (Test-Path -LiteralPath $stageAsar) {
    $hit = $null
    foreach ($needle in @('postman-zh-workspace', 'users.noreply', "C:\Users\$env:USERNAME")) {
      if (Test-BinaryContains -Path $stageAsar -Needle $needle) { $hit = $needle; break }
    }
    if ($ghUser -and -not $hit) {
      if (Test-BinaryContains -Path $stageAsar -Needle "$ghUser (you)") { $hit = "$ghUser (you)" }
    }
    if ($hit) {
      Write-Bad "app.asar 内含个人标识 `"$hit`"，已中止发布"
      Write-Info '请从 payload\zh-localize.js 移除硬编码的账号名，重新打补丁后再发'
      Remove-Item -LiteralPath $stage -Recurse -Force
      exit 1
    }
    Write-Ok 'app.asar 无硬编码账号名'
  }

  Write-Info '压缩中（几分钟，请勿中断）'
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  # 优先用 7-Zip（快得多），没有就退回 .NET ZipFile
  $sevenZip = (Get-Command 7z -ErrorAction SilentlyContinue)
  if (-not $sevenZip) {
    foreach ($c in @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe")) {
      if (Test-Path -LiteralPath $c) { $sevenZip = $c; break }
    }
  }
  if ($sevenZip) {
    $exe = if ($sevenZip -is [string]) { $sevenZip } else { $sevenZip.Source }
    $p = Start-Process $exe -ArgumentList @('a','-tzip','-mx=5','-bso0','-bsp0',"`"$zipPath`"", "`"$stage\*`"") -Wait -PassThru -NoNewWindow
if ($p.ExitCode -ne 0) { Write-Bad "7z 压缩失败（退出码 $($p.ExitCode)）"; exit 1 }
  } else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  }
  $sw.Stop()
  Write-Ok "$zipName  $([math]::Round((Get-Item $zipPath).Length/1MB,1)) MB（耗时 $([int]$sw.Elapsed.TotalSeconds)s）"

  Remove-Item -LiteralPath $stage -Recurse -Force
  Write-Info '已清理暂存目录'
}

Copy-Item -LiteralPath $asarSrc -Destination $asarOut -Force
Write-Ok "app.asar  $([math]::Round((Get-Item $asarOut).Length/1MB,1)) MB"

# --- 建 Release ---
Write-Head "4. 发布 Release $Tag"
$existingRelease = Invoke-GitHubRead -Arguments @('release','view',$Tag,'--repo',"github.com/$($script:ExpectedRepo)",'--json','tagName')
if ($existingRelease.Code -ne 0 -and $existingRelease.Kind -ne 'NotFound') {
  Write-Bad (Get-GitHubFailureMessage $existingRelease.Kind)
  Write-Info "Release 状态尚未确认，已停止创建；本地产物保留在：$outDir"
  exit 1
}
$exists = ($existingRelease.Code -eq 0)

if ($exists) {
  if (-not $ReplaceRelease) {
    Write-Warn2 "Release $Tag 已存在。确认需要重建同版本发布时加 -ReplaceRelease。"
    Write-Info "现有资产将保留不变；本次已生成的文件在：$outDir"
    exit 1
  }
  if (-not (Confirm-Step "将删除并重建 Release $Tag（含其现有资产）？")) { Write-Info '已取消'; exit 0 }
  $deleted = Invoke-Native gh @('release','delete',$Tag,'--repo',"github.com/$($script:ExpectedRepo)",'--yes','--cleanup-tag')
  if ($deleted.Code -ne 0) { Write-Bad '删除旧 Release 未确认成功，已停止重建并保留本地产物。'; exit 1 }
  Write-Info "已删除旧 Release $Tag"
}

# 词条数实测，不写常量：每轮补词条都会变，写死必然过时
# （2026-09-01 之前硬编码 13400，实测已 24190，少报约 45%）。
$entryCount = ''
$countScript = Join-Path $repoDir 'scripts\data\统计词条.js'
if (Test-Path -LiteralPath $countScript) {
  $c = Invoke-Native node @($countScript)
  if ($c.Code -eq 0 -and $c.Out.Trim() -match '^\d+$') {
    # 向下取整到百位，避免说明里出现「24190 条」这种假精确
    $entryCount = [string]([math]::Floor([int]$c.Out.Trim() / 100) * 100)
    Write-Ok "词条实测 $($c.Out.Trim()) 条（说明里写约 $entryCount 条）"
  }
}
if (-not $entryCount) {
  Write-Bad '统计词条失败，无法生成 Release 说明里的条数'
  exit 1
}

# 用单引号 here-string（@'...'@）避免反引号被当成 PowerShell 转义符：
# 双引号 here-string 里 `a=响铃(BEL)、`P 等会吃掉反引号，导致 markdown 代码块
# 渲染成乱码（曾出现 “替换 `app-...`” → “替换 <BEL>pp-...”）。变量用 .Replace 注入。
$notes = @'
Postman 中文汉化版 $version

## 下载说明

- **Postman-cn-$version-win64.zip** — 完整绿色版，解压后直接运行 `Postman.exe`，开箱即中文
- **app.asar** — Windows x64 汉化核心包，已装同版本 Postman 的话，备份后替换 `app-$version\resources\app.asar` 即可

## 本次维护

- 基于官方 Postman $version Windows x64 完整包重新安装汉化，本地保留匹配版本的英文原版备份
- 重新抓取并复核当前官方 i18n 资源和真实翻译输出；官方资源用于取材，仍由运行时词典完成汉化
- 修复首次升级菜单延迟初始化导致的验证误报，按实际就绪状态轮询；支持独立数据目录启动旧版回归
- 发布匹配同一 Postman 版本的完整绿色包和 app.asar，预检校验包内版本、版本目录与 Release 标签一致
- 保留两个独立更新开关：Postman 官方更新默认关闭，汉化版本检查默认开启且只提示，不自动下载安装

## 使用说明

- 两个下载文件均用于 Windows x64，且须与 Postman $version 匹配；macOS / Linux 需分别适配
- 汉化基于运行时注入，界面词典约 $entryCount 条；官方 i18n 是取材来源，并非直接替换官方语言包
- 请求编辑器等界面由 Postman 服务端下发，文案会独立更新；遇到漏翻欢迎携截图提 Issue，请先遮住个人信息
- Postman 自动更新默认关闭，汉化版本检查默认开启；两个开关位于「设置 > 更新」，汉化检查只提示，不自动下载安装
- 手动替换 `app.asar` 前**请先备份原文件**；保留英文原版才可还原
- 绿色版不含工具链和英文原版备份（`app.asar.original`）。如需脚本重装或还原，请安装官方版 Postman，再用本仓库的 `postman-zh.bat`：菜单第 `1` 项安装、第 `3` 项还原；别把绿色版的已汉化 asar 当英文原版
- HTTP 状态短语、请求头、模型名、协议与产品名、代码标识符和快捷键等保持原样
'@.Replace('$version', $version).Replace('$entryCount', $entryCount)
$notesFile = Join-Path $outDir 'release-notes.md'
Set-Content -LiteralPath $notesFile -Value $notes -Encoding UTF8

Write-Info '上传中（大文件较慢）'
$assets = @($zipPath, $asarOut)
if (@($assets | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -gt 0) {
  Write-Bad '发布产物未生成完整，已停止上传。'
  exit 1
}
$releaseCommit = (git -C $repoDir rev-parse HEAD).Trim()
# 先建草稿、上传并校验，再公开。上传途中不进入 /releases/latest，
# 版本检查也就不会把空标签或只传了一半的包展示成已发布版本。
$createArgs = @('release','create',$Tag) + $assets + @(
  '--repo',"github.com/$($script:ExpectedRepo)",
  '--title',"Postman 中文版 $version",
  '--notes-file',$notesFile,
  '--draft', '--target', $releaseCommit
)
$r = Invoke-Native gh $createArgs
if ($r.Code -ne 0) { Write-Bad "创建 Release 失败：`n$($r.Out)"; exit 1 }

$allUploaded = $false
try {
  $rel = Get-ReleaseMetadata $Tag
  if ($rel.draft -ne $true -or $rel.prerelease -ne $false -or $rel.tag_name -cne $Tag) {
    throw 'Release 草稿状态或标签校验失败。'
  }
  Assert-ReleaseAssets -Release $rel -AssetPaths $assets
  Write-Ok '草稿的两个附件已通过名称、大小和 SHA-256 校验。'
  $publish = Invoke-Native gh @('release','edit',$Tag,'--repo',"github.com/$($script:ExpectedRepo)",'--draft=false','--latest')
  if ($publish.Code -ne 0) { throw '公开 Release 失败，附件保留在草稿中，可核对后重试。' }
  $rel = Get-ReleaseMetadata $Tag
  if ($rel.draft -ne $false -or $rel.prerelease -ne $false -or -not $rel.published_at -or $rel.tag_name -cne $Tag) {
    throw 'Release 公开状态校验失败。'
  }
  Assert-ReleaseAssets -Release $rel -AssetPaths $assets
  $allUploaded = $true
  Write-Ok "Release 已发布：$($rel.name) [$($rel.tag_name)]"
  foreach ($a in $rel.assets) {
    Write-Info ("  - {0}  {1} MB  已上传并校验" -f $a.name, [math]::Round($a.size/1MB,1))
  }
} catch {
  Write-Bad $_.Exception.Message
  Write-Info "本地产物已保留：$outDir"
  exit 1
}

# --- 清理本地打包产物 ---
# 上传成功后 _release 里的 280MB 就没用了（线上已有），默认删掉省磁盘。
# 只在确认资产全部 uploaded 后才删，失败时保留好让人排查/手动补传。
Write-Head '5. 清理本地产物'
if ($KeepArtifacts) {
  Write-Info "-KeepArtifacts 已指定，保留：$outDir"
} elseif (-not $allUploaded) {
  Write-Warn2 "资产状态未全部确认为已上传（uploaded），保留本地产物以便排查：$outDir"
} else {
  $freed = 0
  if (Test-Path -LiteralPath $outDir) {
    $freed = [math]::Round((Get-ChildItem -LiteralPath $outDir -Recurse -File -ErrorAction SilentlyContinue |
                            Measure-Object Length -Sum).Sum / 1MB, 1)
    # 用 .NET 删除：Remove-Item 在部分沙箱/策略下会对变量路径误判
    try {
      [System.IO.Directory]::Delete($outDir, $true)
      Write-Ok "已删除 $outDir（释放 ${freed} MB）"
    } catch {
      Write-Warn2 "自动清理失败（$($_.Exception.Message)），请手动删除：$outDir"
    }
  } else {
    Write-Info '没有需要清理的产物'
  }
}

Write-Host ""
Write-Host "全部完成。" -ForegroundColor Green
Write-Host "  仓库：  https://github.com/$($script:ExpectedRepo)" -ForegroundColor Gray
Write-Host "  Release：https://github.com/$($script:ExpectedRepo)/releases/tag/$Tag" -ForegroundColor Gray
