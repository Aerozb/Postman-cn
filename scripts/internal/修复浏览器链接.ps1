param()

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Step {
  param([string]$Message)
  Write-Host "[Postman 汉化] $Message"
}

$schemes = @("http", "https")
$backupLines = New-Object System.Collections.Generic.List[string]
$changed = $false

foreach ($scheme in $schemes) {
  $choicePath = "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\$scheme\UserChoice"
  $choice = Get-ItemProperty -Path $choicePath -ErrorAction SilentlyContinue
  $progId = $choice.ProgId
  if ([string]::IsNullOrWhiteSpace($progId)) {
    Write-Step "未找到 $scheme 的浏览器处理程序标识。"
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
    Write-Step "未找到 $scheme 的浏览器处理命令（$progId）。"
    continue
  }

  $command = (Get-ItemProperty -LiteralPath $sourcePath).'(default)'
  if ([string]::IsNullOrWhiteSpace($command)) {
    Write-Step "$scheme 的浏览器处理命令为空（$progId）。"
    continue
  }

  if ($command -notmatch '--single-argument\s+"%1"') {
    if ($command -match '--single-argument\s+%1') {
      Write-Step "$scheme 的浏览器链接处理程序已经修复（$progId）。"
    } else {
      Write-Step "$scheme 的浏览器链接处理程序不符合 Chrome 引号问题特征，无需修改（$progId）。"
    }
    continue
  }

  $fixed = [regex]::Replace($command, '--single-argument\s+"%1"', '--single-argument %1')
  $backupLines.Add("[$scheme] $sourcePath")
  $backupLines.Add($command)
  $backupLines.Add("")

  New-Item -Path $hkcuCommandPath -Force | Out-Null
  Set-ItemProperty -LiteralPath $hkcuCommandPath -Name "(default)" -Value $fixed
  Write-Step "已修复 $scheme 浏览器链接处理程序的引号（$progId）。"
  $changed = $true
}

if ($backupLines.Count -gt 0) {
  $backupDir = Join-Path $env:APPDATA "Postman"
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $backupFile = Join-Path $backupDir ("postman-zh-browser-handler-backup-{0}.txt" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
  $backupLines | Set-Content -LiteralPath $backupFile -Encoding UTF8
  Write-Step "浏览器处理程序备份：$backupFile"
}

if (-not $changed) {
  Write-Step "浏览器链接处理程序无需修改。"
}
