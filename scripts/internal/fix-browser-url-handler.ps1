param()

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Step {
  param([string]$Message)
  Write-Host "[postman-zh] $Message"
}

$schemes = @("http", "https")
$backupLines = New-Object System.Collections.Generic.List[string]
$changed = $false

foreach ($scheme in $schemes) {
  $choicePath = "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\$scheme\UserChoice"
  $choice = Get-ItemProperty -Path $choicePath -ErrorAction SilentlyContinue
  $progId = $choice.ProgId
  if ([string]::IsNullOrWhiteSpace($progId)) {
    Write-Step "No browser handler ProgId found for $scheme"
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
    Write-Step "Browser handler command not found for $scheme ($progId)"
    continue
  }

  $command = (Get-ItemProperty -LiteralPath $sourcePath).'(default)'
  if ([string]::IsNullOrWhiteSpace($command)) {
    Write-Step "Browser handler command is empty for $scheme ($progId)"
    continue
  }

  if ($command -notmatch '--single-argument\s+"%1"') {
    if ($command -match '--single-argument\s+%1') {
      Write-Step "Browser URL handler already fixed for $scheme ($progId)"
    } else {
      Write-Step "Browser URL handler for $scheme ($progId) does not match the Chrome quote issue pattern"
    }
    continue
  }

  $fixed = [regex]::Replace($command, '--single-argument\s+"%1"', '--single-argument %1')
  $backupLines.Add("[$scheme] $sourcePath")
  $backupLines.Add($command)
  $backupLines.Add("")

  New-Item -Path $hkcuCommandPath -Force | Out-Null
  Set-ItemProperty -LiteralPath $hkcuCommandPath -Name "(default)" -Value $fixed
  Write-Step "Fixed browser URL handler quotes for $scheme ($progId)"
  $changed = $true
}

if ($backupLines.Count -gt 0) {
  $backupDir = Join-Path $env:APPDATA "Postman"
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  $backupFile = Join-Path $backupDir ("postman-zh-browser-handler-backup-{0}.txt" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
  $backupLines | Set-Content -LiteralPath $backupFile -Encoding UTF8
  Write-Step "Browser handler backup: $backupFile"
}

if (-not $changed) {
  Write-Step "No browser URL handler changes were needed"
}

