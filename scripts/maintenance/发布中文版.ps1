<#
  Postman-cn 一键发布脚本
  ------------------------------------------------------------------
  本脚本位于仓库内的 scripts\maintenance\，由根目录统一入口调用。
  发布前会扫描入库文件，避免个人信息随仓库公开。

  做四件事：
    1. 预检：git / gh / 登录状态 / token 权限 / 提交身份 / 磁盘空间
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
  # Release 标签，默认 v<版本号>
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

# --- gh 登录状态 + token 权限 ---
$ghUser = $null
if ($ghCmd) {
  $authRes = Invoke-Native gh @('auth','status')
  $authOut = $authRes.Out
  if ($authRes.Code -ne 0) {
    Write-Bad 'gh 未登录。请执行：gh auth login  （选 GitHub.com → HTTPS → 浏览器授权）'
    $problems.Add('gh 未登录')
  } else {
    try { $ghUser = (gh api user --jq .login 2>$null) } catch { }
    if ($ghUser) { Write-Ok "已登录 GitHub 账号：$ghUser" } else { Write-Ok '已登录 GitHub' }

    # token 必须含 repo 权限才能推送私有内容 / 建 Release
    $scopeLine = ($authOut -split "`n" | Where-Object { $_ -match 'Token scopes' }) -join ''
    if ($scopeLine -and $scopeLine -notmatch "'repo'") {
      Write-Bad "token 缺少 repo 权限（当前：$($scopeLine.Trim())）"
      Write-Info '修复：gh auth refresh -h github.com -s repo,workflow'
      $problems.Add('token 缺少 repo 权限')
    } else {
      Write-Ok 'token 权限含 repo（可推送 + 可建 Release）'
    }
  }
}

# --- git 提交身份 ---
$gitName  = (git config --get user.name)  2>$null
$gitEmail = (git config --get user.email) 2>$null
if (-not $gitName -or -not $gitEmail) {
  Write-Bad 'git 提交身份未配置（user.name / user.email 为空），提交会失败'
  $suggestName = if ($ghUser) { $ghUser } else { '你的用户名' }
  $uid = $null
  if ($ghCmd -and $ghUser) { try { $uid = (gh api user --jq .id 2>$null) } catch { } }
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

# --- 远程仓库可写 ---
if ($ghCmd -and $ghUser) {
  try {
    $repoJson = (gh repo view $script:ExpectedRepo --json name,visibility,defaultBranchRef,viewerPermission 2>$null) | ConvertFrom-Json
    if ($repoJson) {
      $perm = $repoJson.viewerPermission
      if ($perm -in @('ADMIN','MAINTAIN','WRITE')) {
        Write-Ok "远程仓库 $($script:ExpectedRepo)（$($repoJson.visibility)，默认分支 $($repoJson.defaultBranchRef.name)，权限 $perm）"
      } else {
        Write-Bad "对 $($script:ExpectedRepo) 只有 $perm 权限，无法推送"
        $problems.Add('远程仓库无写权限')
      }
    }
  } catch {
    Write-Bad "无法访问远程仓库 $($script:ExpectedRepo)：$($_.Exception.Message)"
    $problems.Add('远程仓库不可访问')
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
if (-not $appPath -or -not (Test-Path -LiteralPath $appPath)) {
  Write-Bad "找不到 Postman 版本目录（$postmanRoot\app-*）"
  $problems.Add('Postman 版本目录不存在')
} else {
  $version = (Split-Path -Leaf $appPath) -replace '^app-',''
  $asar = Join-Path $appPath 'resources\app.asar'
  if (-not (Test-Path -LiteralPath $asar)) {
    Write-Bad "找不到 app.asar：$asar"
    $problems.Add('app.asar 不存在')
  } else {
    Write-Ok "待发布版本：$version（$appPath）"
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

if (-not $Tag) { $Tag = "v$version" }

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
$exists = ((Invoke-Native gh @('release','view',$Tag,'--repo',$script:ExpectedRepo)).Code -eq 0)

if ($exists) {
  if (-not $ReplaceRelease) {
    Write-Warn2 "Release $Tag 已存在。加 -ReplaceRelease 覆盖它，或用 -Tag 指定别的标签。"
    Write-Info "现有资产将保留不变；本次已生成的文件在：$outDir"
    exit 1
  }
  if (-not (Confirm-Step "将删除并重建 Release $Tag（含其现有资产）？")) { Write-Info '已取消'; exit 0 }
  Invoke-Native gh @('release','delete',$Tag,'--repo',$script:ExpectedRepo,'--yes','--cleanup-tag') | Out-Null
  Write-Info "已删除旧 Release $Tag"
}

# 用单引号 here-string（@'...'@）避免反引号被当成 PowerShell 转义符：
# 双引号 here-string 里 `a=响铃(BEL)、`P 等会吃掉反引号，导致 markdown 代码块
# 渲染成乱码（曾出现 “替换 `app-...`” → “替换 <BEL>pp-...”）。变量用 .Replace 注入。
$notes = @'
Postman 中文汉化版 $version

## 下载说明

- **Postman-cn-$version-win64.zip** — 完整绿色版，解压后直接运行 `Postman.exe`，开箱即中文
- **app.asar** — 仅汉化后的核心包，已装同版本 Postman 的话，替换 `app-$version\resources\app.asar` 即可

## 说明

- 汉化基于运行时注入，界面词典约 12500 条
- 已关闭自动更新，避免官方更新覆盖汉化
- 绿色版不含 `app.asar.original`（英文原版备份），如需还原英文请重装官方版
- 部分内容刻意保留英文：HTTP 头名、AI 模型名、协议名、产品专有名词等
'@.Replace('$version', $version)
$notesFile = Join-Path $outDir 'release-notes.md'
Set-Content -LiteralPath $notesFile -Value $notes -Encoding UTF8

Write-Info '上传中（大文件较慢）'
$assets = @($zipPath, $asarOut) | Where-Object { Test-Path -LiteralPath $_ }
$createArgs = @('release','create',$Tag) + $assets + @(
  '--repo',$script:ExpectedRepo,
  '--title',"Postman 中文版 $version",
  '--notes-file',$notesFile
)
$r = Invoke-Native gh $createArgs
if ($r.Code -ne 0) { Write-Bad "创建 Release 失败：`n$($r.Out)"; exit 1 }

Write-Ok "Release 已发布"
# 用 --json 取回后在 PS 侧格式化：--jq 表达式含双引号，
# PS 5.1 传给原生 exe 时会剥引号并按空格拆参，必然报 "accepts at most 1 arg"
$v = Invoke-Native gh @('release','view',$Tag,'--repo',$script:ExpectedRepo,'--json','tagName,name,assets')
$allUploaded = $false
$assetCount  = 0
if ($v.Code -eq 0) {
  try {
    $rel = $v.Out | ConvertFrom-Json
    Write-Info "$($rel.name) [$($rel.tagName)]"
    foreach ($a in $rel.assets) {
      Write-Info ("  - {0}  {1} MB  {2}" -f $a.name, [math]::Round($a.size/1MB,1), $a.state)
    }
    $assetCount = @($rel.assets).Count
    # 期望 2 个资产（绿色版 zip + 单独 app.asar），且都要 uploaded 才算成功
    $expected = @($assets).Count
    $allUploaded = ($assetCount -eq $expected) -and (@($rel.assets | Where-Object { $_.state -ne 'uploaded' }).Count -eq 0)
  } catch { Write-Info '（资产列表解析失败，可到网页查看）' }
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
