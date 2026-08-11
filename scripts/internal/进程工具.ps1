function ConvertTo-NativeArgument {
  param(
    [AllowEmptyString()]
    [string]$Value
  )

  if ($null -eq $Value -or $Value.Length -eq 0) {
    return '""'
  }
  if ($Value -notmatch '[\s"]') {
    return $Value
  }

  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append([char]34)
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) {
      $backslashes++
      continue
    }
    if ($character -eq [char]34) {
      [void]$builder.Append([char]92, ($backslashes * 2 + 1))
      [void]$builder.Append([char]34)
      $backslashes = 0
      continue
    }
    [void]$builder.Append([char]92, $backslashes)
    [void]$builder.Append($character)
    $backslashes = 0
  }
  [void]$builder.Append([char]92, ($backslashes * 2))
  [void]$builder.Append([char]34)
  return $builder.ToString()
}

function Start-PostmanDetached {
  param(
    [Parameter(Mandatory)]
    [string]$FilePath,
    [string[]]$ArgumentList = @()
  )

  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  if (-not (Test-Path -LiteralPath $wscript)) {
    throw "找不到 Windows 脚本宿主：$wscript"
  }

  $workingDirectory = Split-Path -Parent $FilePath
  $commandParts = @((ConvertTo-NativeArgument $FilePath))
  foreach ($argument in $ArgumentList) {
    $commandParts += ConvertTo-NativeArgument $argument
  }
  $commandLine = $commandParts -join ' '
  $escapedCommandLine = $commandLine.Replace('"', '""')
  $escapedWorkingDirectory = $workingDirectory.Replace('"', '""')
  $launcherPath = Join-Path ([IO.Path]::GetTempPath()) ("postman-zh-launch-{0}.vbs" -f [guid]::NewGuid().ToString('N'))
  $launcherContent = @"
Option Explicit
Dim shell, fileSystem, result
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$escapedWorkingDirectory"
result = shell.Run("$escapedCommandLine", 1, False)
Set fileSystem = CreateObject("Scripting.FileSystemObject")
fileSystem.DeleteFile WScript.ScriptFullName, True
WScript.Quit result
"@

  try {
    [IO.File]::WriteAllText($launcherPath, $launcherContent, [Text.Encoding]::Unicode)
    $quotedLauncherPath = [char]34 + $launcherPath + [char]34
    $launcher = Start-Process -FilePath $wscript -ArgumentList @('//B', '//Nologo', $quotedLauncherPath) -PassThru
    if (-not $launcher.WaitForExit(10000)) {
      Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
      throw "Windows 脚本宿主启动 Postman 超时。"
    }
    $launcher.Refresh()
    if ($launcher.ExitCode -ne 0) {
      throw "Windows 脚本宿主启动 Postman 失败，退出码：$($launcher.ExitCode)"
    }
  } finally {
    Remove-Item -LiteralPath $launcherPath -Force -ErrorAction SilentlyContinue
  }
}
