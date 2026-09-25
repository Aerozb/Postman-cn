# 定位可汉化的 Postman 版本目录（含 Postman.exe 与 resources\app.asar 的 app-<版本> 目录）。
# 这是全部命令共用的唯一探测实现：菜单、安装、还原、启动、验证和发布都从这里取目录，
# 避免各自复制一套规则、在非标准布局下给出互相矛盾的结论。
# 本文件只做纯查找、校验与本地记忆读写，不做交互、不抛异常。
# 交互（Read-Host、菜单回退）由 统一入口.ps1 负责。

# 判断一个目录本身是否就是可汉化的版本目录。
function Test-PostmanAppDir {
  param([string]$Dir)
  if ([string]::IsNullOrWhiteSpace($Dir)) { return $false }
  return (Test-Path -LiteralPath (Join-Path $Dir 'Postman.exe')) -and
         (Test-Path -LiteralPath (Join-Path $Dir 'resources\app.asar'))
}

# 从 app-<版本> 目录名解析版本号；无法解析按 0.0.0 处理。
function Get-PostmanAppVersion {
  param([string]$Dir)
  $name = Split-Path -Leaf $Dir
  if ($name -match '^app-(\d+(?:\.\d+){1,3})') {
    try { return [version]$Matches[1] } catch {}
  }
  return [version]'0.0.0'
}

# 在一个安装根目录（形如 Postman，含 app-* 子目录）里挑最高版本的有效版本目录；没有返回 $null。
function Select-BestPostmanAppDir {
  param([string]$Root)
  if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root)) { return $null }
  $best = Get-ChildItem -LiteralPath $Root -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
    Where-Object { Test-PostmanAppDir $_.FullName } |
    Sort-Object @{ Expression = { Get-PostmanAppVersion $_.FullName }; Descending = $true },
                @{ Expression = 'LastWriteTime'; Descending = $true } |
    Select-Object -First 1
  if ($best) { return $best.FullName }
  return $null
}

# 候选安装根目录：官方安装位置、当前目录、仓库上溯几级，以及桌面和下载目录。
# 只查这些明确位置，不做整盘扫描。
function Get-PostmanSearchRoots {
  param([string]$RepoRoot)
  $roots = @()
  if ($env:LOCALAPPDATA) {
    $roots += (Join-Path $env:LOCALAPPDATA 'Postman')
    $roots += (Join-Path $env:LOCALAPPDATA 'Programs\Postman')
  }
  $roots += (Get-Location).Path
  # 仓库自身及其上溯几级：仓库既可能与安装目录同级，也可能嵌在工作区里。
  $current = $RepoRoot
  for ($i = 0; $i -lt 3; $i++) {
    if ([string]::IsNullOrWhiteSpace($current)) { break }
    $roots += $current
    $parent = Split-Path -Parent $current
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) { break }
    $current = $parent
  }
  if ($env:USERPROFILE) {
    $roots += (Join-Path $env:USERPROFILE 'Desktop')
    $roots += (Join-Path $env:USERPROFILE 'Downloads')
  }
  return ($roots | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)
}

# 在一个根目录下挑版本目录：先看根目录自己的 app-*，再往下看一层。
# 绿色版通常解压成 <某处>\Postman\app-<版本>，只扫根目录必然漏掉，所以要多看一层。
# 下一级按名字含 postman 过滤，避免把无关的大目录树整个翻一遍。
function Select-PostmanAppDirUnderRoot {
  param([string]$Root)
  $direct = Select-BestPostmanAppDir $Root
  if ($direct) { return $direct }
  $children = Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '(?i)postman' }
  $best = $null
  $bestVersion = [version]'0.0.0'
  foreach ($child in $children) {
    $candidate = Select-BestPostmanAppDir $child.FullName
    if (-not $candidate) { continue }
    $version = Get-PostmanAppVersion $candidate
    if ((-not $best) -or $version -gt $bestVersion) {
      $best = $candidate
      $bestVersion = $version
    }
  }
  return $best
}

# 自动探测：正在运行的 Postman 进程 → 官方安装位置和仓库周边（含下一级）→ 上次记住的拖入目录。
# 所有命令都走这一个函数，避免菜单、安装器、启动和发布各判断一套导致结论不一致。
function Find-InstalledPostmanAppDir {
  param([string]$RepoRoot, [switch]$IncludeRunning, [switch]$IncludeRemembered)

  if ($IncludeRunning) {
    try {
      $running = Get-Process Postman -ErrorAction SilentlyContinue |
        Where-Object { $_.Path } |
        ForEach-Object { Split-Path -Parent $_.Path } |
        Select-Object -Unique
      foreach ($dir in $running) {
        if (Test-PostmanAppDir $dir) { return (Get-Item -LiteralPath $dir).FullName }
      }
    } catch {}
  }

  $candidates = @()
  foreach ($root in (Get-PostmanSearchRoots -RepoRoot $RepoRoot)) {
    $best = Select-PostmanAppDirUnderRoot $root
    if ($best) {
      $candidates += [PSCustomObject]@{ Dir = $best; Version = Get-PostmanAppVersion $best }
    }
  }
  $pick = $candidates | Sort-Object @{ Expression = 'Version'; Descending = $true } | Select-Object -First 1
  if ($pick) { return $pick.Dir }

  # 探测不到时才用记忆：Postman 放在非常规位置（改过名的目录等）时免去重复拖拽。
  if ($IncludeRemembered) { return (Get-RememberedPostmanDir) }
  return $null
}

# 由版本目录反推安装根目录（含 Postman.exe、Update.exe、packages\RELEASES 的那一层）。
# 发布打包需要这一层；取不到有效根目录返回 $null。
function Get-PostmanInstallRoot {
  param([string]$AppDir)
  if (-not (Test-PostmanAppDir $AppDir)) { return $null }
  $root = Split-Path -Parent $AppDir
  if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root)) { return $null }
  return (Get-Item -LiteralPath $root).FullName
}

# 解析用户拖入或手输的路径：既接受版本目录本身，也接受含 app-* 的安装根目录。找不到返回 $null。
# 兼容拖拽自动加的引号、首尾空白与相对路径。
function Resolve-PostmanAppDirFromPath {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $null }
  $candidate = $PathValue.Trim().Trim('"').Trim("'").Trim()
  if ([string]::IsNullOrWhiteSpace($candidate)) { return $null }
  if (-not [System.IO.Path]::IsPathRooted($candidate)) {
    $candidate = Join-Path (Get-Location) $candidate
  }
  if (-not (Test-Path -LiteralPath $candidate)) { return $null }
  $item = Get-Item -LiteralPath $candidate -ErrorAction SilentlyContinue
  if (-not $item -or -not $item.PSIsContainer) { return $null }
  $full = $item.FullName
  if (Test-PostmanAppDir $full) { return $full }
  return (Select-BestPostmanAppDir $full)
}

# 记住上一次在菜单里拖入的 Postman 目录。给 Postman 常驻非标准位置（如桌面）的用户免去重复拖拽：
# 自动探测仍失败时直接复用这个目录。与两个更新开关一样写在 %APPDATA%/Postman 下、无 BOM，
# 但这是纯本地便利项——读写失败一律静默忽略，绝不因此打断安装、还原、启动或发布。
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
