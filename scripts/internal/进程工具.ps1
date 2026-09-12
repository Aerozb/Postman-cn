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

function Stop-PostmanCompletely {
  param(
    [ValidateRange(1, 120)][int]$MaxRounds = 20,
    [ValidateRange(50, 10000)][int]$SleepMs = 500,
    [ValidateRange(1, 10)][int]$StableChecks = 3
  )

  $initialCount = @(Get-Process -Name Postman -ErrorAction SilentlyContinue).Count
  if ($initialCount -gt 0) {
    Write-Host "[Postman 汉化] 正在关闭 $initialCount 个 Postman 进程。"
  }
  $emptyChecks = 0
  for ($round = 1; $round -le $MaxRounds; $round++) {
    $processes = @(Get-Process -Name Postman -ErrorAction SilentlyContinue)
    if ($processes.Count -eq 0) {
      $emptyChecks++
      if ($emptyChecks -ge $StableChecks) {
        Write-Host '[Postman 汉化] Postman 进程已全部关闭。'
        return
      }
    } else {
      $emptyChecks = 0
      foreach ($process in $processes) {
        try { Stop-Process -Id $process.Id -Force -ErrorAction Stop }
        catch { }
      }
    }
    if ($round -lt $MaxRounds) { Start-Sleep -Milliseconds $SleepMs }
  }

  $remaining = @(Get-Process -Name Postman -ErrorAction SilentlyContinue)
  if ($remaining.Count -gt 0) {
    $ids = ($remaining | Select-Object -ExpandProperty Id | Sort-Object) -join ', '
    throw "仍有 $($remaining.Count) 个 Postman 进程未关闭（PID：$ids）。"
  }
  throw "未能连续 $StableChecks 次确认 Postman 进程为零。"
}

function Get-PostmanPortFile {
  if (-not $env:APPDATA) { throw '未设置 APPDATA，找不到 Postman 调试端口文件。' }
  return Join-Path $env:APPDATA 'Postman\DevToolsActivePort'
}

function Wait-PostmanReady {
  param(
    [ValidateRange(1, 3600)][int]$TimeoutSec = 60,
    [ValidateRange(50, 10000)][int]$PollMs = 500,
    [string]$PortFile = (Get-PostmanPortFile)
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      if (Test-Path -LiteralPath $PortFile -PathType Leaf) {
        # 每轮重读第一行；启动期间端口文件可能尚未写完，也可能再次变化。
        $portText = ([string](Get-Content -LiteralPath $PortFile -TotalCount 1 -Encoding UTF8 -ErrorAction Stop)).Trim()
        $port = 0
        if ($portText -match '^\d+$' -and [int]::TryParse($portText, [ref]$port) -and $port -gt 0 -and $port -le 65535) {
          $secondsLeft = ($deadline - (Get-Date)).TotalSeconds
          if ($secondsLeft -le 0) { break }
          $requestTimeout = [int][Math]::Max(1, [Math]::Min(3, [Math]::Ceiling($secondsLeft)))
          $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec $requestTimeout -ErrorAction Stop
          $page = $targets | Where-Object {
            $_.type -eq 'page' -and $_.webSocketDebuggerUrl -and
            $_.url -match '^https://desktop\.postman\.com(?::\d+)?(?:[/?#]|$)|^file:///.*?/(?:requester|scratchpad)\.html(?:[?#]|$)'
          } | Select-Object -First 1
          if ($page) { return $port }
        }
      }
    } catch {
      # 端口、页面或本地 CDP 请求暂未就绪，统一在时间预算内重试。
    }
    $millisecondsLeft = ($deadline - (Get-Date)).TotalMilliseconds
    if ($millisecondsLeft -le 0) { break }
    Start-Sleep -Milliseconds ([int][Math]::Min($PollMs, [Math]::Ceiling($millisecondsLeft)))
  }
  throw "等待 ${TimeoutSec} 秒后仍未找到 Postman 页面，请检查调试端口文件：$PortFile"
}

function Start-PostmanDebugSession {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [ValidateRange(1, 3600)][int]$TimeoutSec = 60,
    [switch]$NoWait
  )

  $portFile = Get-PostmanPortFile
  if (Test-Path -LiteralPath $portFile) {
    Remove-Item -LiteralPath $portFile -Force -ErrorAction Stop
  }
  Write-Host "[Postman 汉化] 正在启动：$FilePath"
  Start-PostmanDetached -FilePath $FilePath -ArgumentList '--remote-debugging-port=0'
  if ($NoWait) {
    Write-Host "[Postman 汉化] 已启动；已按 -NoWait 跳过等待。端口文件将写入：$portFile"
    return
  }
  $port = Wait-PostmanReady -TimeoutSec $TimeoutSec -PortFile $portFile
  Write-Host "[Postman 汉化] Postman 已就绪，CDP 端口：$port"
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
    $launcher = Start-Process -FilePath $wscript -ArgumentList @('//B', '//Nologo', $quotedLauncherPath) -WindowStyle Hidden -PassThru
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
