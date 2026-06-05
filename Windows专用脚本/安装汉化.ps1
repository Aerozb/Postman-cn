param(
  [string]$PostmanDir,
  [string]$Version,
  [switch]$Latest,
  [switch]$ListVersions,
  [switch]$NoStart,
  [switch]$SkipBrowserFix
)

$ErrorActionPreference = "Stop"
$ScriptRootDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

function Test-PackageRoot {
  param([string]$Dir)
  if ([string]::IsNullOrWhiteSpace($Dir) -or -not (Test-Path -LiteralPath $Dir)) { return $false }
  $match = Get-ChildItem -LiteralPath $Dir -Directory -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -match '^\d+(?:\.\d+){1,3}$' -and
      (Test-Path -LiteralPath (Join-Path $_.FullName "app.asar"))
    } |
    Select-Object -First 1
  return [bool]$match
}

$PackageRoot = $ScriptRootDir
$ScriptParent = Split-Path -Parent $ScriptRootDir
if (-not (Test-PackageRoot $PackageRoot) -and $ScriptParent) {
  $PackageRoot = $ScriptParent
}

function Get-VersionSearchRoots {
  $roots = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in @(
    $ScriptRootDir,
    $PackageRoot,
    (Split-Path -Parent $PackageRoot),
    (Split-Path -Parent (Split-Path -Parent $PackageRoot))
  )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      $roots.Add((Resolve-Path -LiteralPath $candidate).Path)
    }
  }
  return $roots | Select-Object -Unique
}

function Get-VersionHintForRoot {
  param([string]$Root)
  if (-not [string]::IsNullOrWhiteSpace($Version) -and $Version -match '^\d+(?:\.\d+){1,3}$') {
    return $Version
  }

  $roots = New-Object System.Collections.Generic.List[string]
  $cursor = $Root
  for ($i = 0; $i -lt 3 -and $cursor; $i += 1) {
    if (Test-Path -LiteralPath $cursor) {
      $roots.Add((Resolve-Path -LiteralPath $cursor).Path)
    }
    $cursor = Split-Path -Parent $cursor
  }

  foreach ($base in ($roots | Select-Object -Unique)) {
    $versionFile = Join-Path $base "VERSION.txt"
    if (Test-Path -LiteralPath $versionFile) {
      $hint = (Get-Content -LiteralPath $versionFile -TotalCount 1).Trim()
      if ($hint -match '^\d+(?:\.\d+){1,3}$') {
        return $hint
      }
    }
  }

  $installedVersions = foreach ($candidateRoot in Get-CandidateRootDirs) {
    Get-ChildItem -LiteralPath $candidateRoot -Directory -Filter "app-*" -ErrorAction SilentlyContinue |
      Where-Object { Test-PostmanAppDir $_.FullName } |
      ForEach-Object {
        $installedVersion = Get-PostmanAppVersion $_.FullName
        if ($installedVersion) {
          [PSCustomObject]@{
            Version = $installedVersion
            ParsedVersion = [version]$installedVersion
          }
        }
      }
  }

  $latestInstalled = $installedVersions | Sort-Object ParsedVersion -Descending | Select-Object -First 1
  if ($latestInstalled) {
    return $latestInstalled.Version
  }

  return $null
}

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Step {
  param([string]$Message)
  Write-Host "[postman-cn] $Message"
}

function Test-PostmanAppDir {
  param([string]$Dir)
  if ([string]::IsNullOrWhiteSpace($Dir)) { return $false }
  return (
    (Test-Path -LiteralPath (Join-Path $Dir "Postman.exe")) -and
    (Test-Path -LiteralPath (Join-Path $Dir "resources\app.asar"))
  )
}

function Get-PostmanAppVersion {
  param([string]$Dir)
  $leaf = Split-Path -Leaf $Dir
  if ($leaf -match '^app-(\d+(?:\.\d+){1,3})$') {
    return $Matches[1]
  }
  return $null
}

function Get-PackageVersions {
  $packages = foreach ($root in Get-VersionSearchRoots) {
    $directAsar = Join-Path $root "app.asar"
    if (Test-Path -LiteralPath $directAsar) {
      $directVersion = Get-VersionHintForRoot -Root $root
      if ($directVersion) {
        [PSCustomObject]@{
          Version = $directVersion
          ParsedVersion = [version]$directVersion
          Dir = $root
          AppAsar = $directAsar
          Priority = if ($root -eq $ScriptRootDir) { 0 } else { 1 }
        }
      }
    }

    Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -match '^\d+(?:\.\d+){1,3}$' -and
        (Test-Path -LiteralPath (Join-Path $_.FullName "app.asar"))
      } |
      ForEach-Object {
        [PSCustomObject]@{
          Version = $_.Name
          ParsedVersion = [version]$_.Name
          Dir = $_.FullName
          AppAsar = Join-Path $_.FullName "app.asar"
          Priority = 2
        }
      }
  }

  $packages |
    Sort-Object @{ Expression = "ParsedVersion"; Descending = $true }, @{ Expression = "Priority"; Descending = $false }, @{ Expression = "Dir"; Descending = $false }
}

function Show-PackageVersions {
  $packages = @(Get-PackageVersions)
  if ($packages.Count -eq 0) {
    Write-Step "No version folders were found near: $PackageRoot"
    return
  }

  Write-Step "Available Chinese packages:"
  foreach ($package in $packages) {
    Write-Host "  $($package.Version)  $($package.Dir)"
  }
}

function Resolve-Package {
  $packages = @(Get-PackageVersions)
  if ($packages.Count -eq 0) {
    throw "No version folders containing app.asar were found near: $PackageRoot"
  }

  if (-not [string]::IsNullOrWhiteSpace($Version)) {
    $match = $packages | Where-Object { $_.Version -eq $Version } | Select-Object -First 1
    if (-not $match) {
      $available = ($packages | ForEach-Object { $_.Version }) -join ", "
      throw "Package version '$Version' was not found. Available versions: $available"
    }
    return $match
  }

  return $packages[0]
}

function Get-CandidateRootDirs {
  $roots = New-Object System.Collections.Generic.List[string]
  if ($PackageRoot) { $roots.Add($PackageRoot) }

  $packageParent = Split-Path -Parent $PackageRoot
  if ($packageParent) {
    $roots.Add($packageParent)
    $packageGrandParent = Split-Path -Parent $packageParent
    if ($packageGrandParent) { $roots.Add($packageGrandParent) }
    $siblingPostman = Join-Path $packageParent "Postman"
    if (Test-Path -LiteralPath $siblingPostman) { $roots.Add($siblingPostman) }
  }

  if ($env:LOCALAPPDATA) { $roots.Add((Join-Path $env:LOCALAPPDATA "Postman")) }

  return $roots |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    ForEach-Object { (Resolve-Path -LiteralPath $_).Path } |
    Select-Object -Unique
}

function Resolve-PostmanDir {
  param([string]$PackageVersion)

  if ($PostmanDir) {
    $resolved = (Resolve-Path -LiteralPath $PostmanDir).Path
    if (-not (Test-PostmanAppDir $resolved)) {
      throw "Invalid Postman app directory: $resolved"
    }
    return $resolved
  }

  $matches = New-Object System.Collections.Generic.List[string]
  foreach ($root in Get-CandidateRootDirs) {
    Get-ChildItem -LiteralPath $root -Directory -Filter "app-$PackageVersion" -ErrorAction SilentlyContinue |
      ForEach-Object {
        if (Test-PostmanAppDir $_.FullName) {
          $matches.Add($_.FullName)
        }
      }
  }

  $unique = @($matches | Select-Object -Unique)
  if ($unique.Count -gt 0) {
    return $unique[0]
  }

  throw "Cannot find Postman app-$PackageVersion. Install the matching Postman version or pass -PostmanDir."
}

function Stop-TargetPostman {
  param([string]$Dir)
  $normalized = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd('\')
  $processes = Get-CimInstance Win32_Process -Filter "name = 'Postman.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($normalized, [System.StringComparison]::OrdinalIgnoreCase) }

  foreach ($proc in $processes) {
    Write-Step "Stopping Postman process: $($proc.ProcessId)"
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Repair-BrowserUrlHandler {
  $schemes = @("http", "https")
  $changed = $false

  foreach ($scheme in $schemes) {
    $choicePath = "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\$scheme\UserChoice"
    $choice = Get-ItemProperty -Path $choicePath -ErrorAction SilentlyContinue
    $progId = $choice.ProgId
    if ([string]::IsNullOrWhiteSpace($progId)) {
      continue
    }

    $hkcuCommandPath = "HKCU:\Software\Classes\$progId\shell\open\command"
    $hklmCommandPath = "HKLM:\Software\Classes\$progId\shell\open\command"
    $sourcePath = $null
    if (Test-Path -LiteralPath $hkcuCommandPath) {
      $sourcePath = $hkcuCommandPath
    } elseif (Test-Path -LiteralPath $hklmCommandPath) {
      $sourcePath = $hklmCommandPath
    }

    if (-not $sourcePath) {
      continue
    }

    $command = (Get-ItemProperty -LiteralPath $sourcePath).'(default)'
    if ([string]::IsNullOrWhiteSpace($command)) {
      continue
    }

    if ($command -notmatch '--single-argument\s+"%1"') {
      if ($command -match '--single-argument\s+%1') {
        Write-Step "$scheme browser URL handler already fixed: $progId"
      }
      continue
    }

    $fixed = [regex]::Replace($command, '--single-argument\s+"%1"', '--single-argument %1')
    New-Item -Path $hkcuCommandPath -Force | Out-Null
    Set-ItemProperty -LiteralPath $hkcuCommandPath -Name "(default)" -Value $fixed
    Write-Step "Fixed $scheme browser URL quote handler: $progId"
    $changed = $true
  }

  if (-not $changed) {
    Write-Step "No browser URL handler changes were needed"
  }
}

if ($ListVersions) {
  Show-PackageVersions
  exit 0
}

$package = Resolve-Package
$PackageVersion = $package.Version
$payloadAsar = $package.AppAsar

$targetDir = Resolve-PostmanDir -PackageVersion $PackageVersion
$targetVersion = Get-PostmanAppVersion $targetDir
if ($targetVersion -ne $PackageVersion) {
  throw "Version mismatch: package is $PackageVersion, target is $targetVersion. Use -Version or download the matching package."
}

Write-Step "Package root: $PackageRoot"
Write-Step "Package version: $PackageVersion"
Write-Step "Package app.asar: $payloadAsar"
Write-Step "Target: $targetDir"
Stop-TargetPostman $targetDir

$resourcesDir = Join-Path $targetDir "resources"
$targetAsar = Join-Path $resourcesDir "app.asar"
$originalAsar = Join-Path $resourcesDir "app.asar.original"

if (-not (Test-Path -LiteralPath $originalAsar)) {
  Copy-Item -LiteralPath $targetAsar -Destination $originalAsar -Force
  Write-Step "Original backup created: $originalAsar"
} else {
  Write-Step "Original backup already exists: $originalAsar"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$beforeBackup = Join-Path $resourcesDir "app.asar.before-cn-$timestamp.bak"
Copy-Item -LiteralPath $targetAsar -Destination $beforeBackup -Force
Write-Step "Pre-replace backup created: $beforeBackup"

Copy-Item -LiteralPath $payloadAsar -Destination $targetAsar -Force
$sourceHash = (Get-FileHash -LiteralPath $payloadAsar -Algorithm SHA256).Hash
$targetHash = (Get-FileHash -LiteralPath $targetAsar -Algorithm SHA256).Hash
if ($sourceHash -ne $targetHash) {
  throw "Replace verification failed: target app.asar hash does not match package app.asar."
}

Write-Step "Replace OK. SHA256: $targetHash"

if (-not $SkipBrowserFix) {
  Repair-BrowserUrlHandler
}

if (-not $NoStart) {
  Start-Process -FilePath (Join-Path $targetDir "Postman.exe")
  Write-Step "Postman started"
}

Write-Step "Done"
