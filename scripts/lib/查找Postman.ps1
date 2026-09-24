# 定位可汉化的 Postman 版本目录（含 Postman.exe 与 resources\app.asar 的 app-<版本> 目录）。
# 供统一入口在自动探测失败时提示用户拖入目录；本文件只做纯查找与校验，不做交互、不抛异常。
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

# 自动探测：正在运行的 Postman 进程 + 官方安装位置 + 仓库周边根目录。找不到返回 $null。
# 与 安装汉化.ps1 的探测范围保持一致，避免菜单与安装器判断不一。
function Find-InstalledPostmanAppDir {
  param([string]$RepoRoot, [switch]$IncludeRunning)

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

  $roots = @()
  if ($env:LOCALAPPDATA) { $roots += (Join-Path $env:LOCALAPPDATA 'Postman') }
  $roots += (Get-Location).Path
  if ($RepoRoot) {
    $ws = Split-Path -Parent $RepoRoot
    if ($ws) {
      $roots += $ws
      $wp = Split-Path -Parent $ws
      if ($wp) { $roots += $wp }
    }
  }
  $roots = $roots | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

  $candidates = @()
  foreach ($root in $roots) {
    $best = Select-BestPostmanAppDir $root
    if ($best) {
      $candidates += [PSCustomObject]@{ Dir = $best; Version = Get-PostmanAppVersion $best }
    }
  }
  $pick = $candidates | Sort-Object @{ Expression = 'Version'; Descending = $true } | Select-Object -First 1
  if ($pick) { return $pick.Dir }
  return $null
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
