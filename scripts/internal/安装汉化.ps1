param(
  [string]$PostmanDir,
  [switch]$Latest,
  [string]$PayloadPath,
  [switch]$NoRestart,
  [switch]$Verify,
  [switch]$DisableUpdates,
  [switch]$RestoreOriginal,
  [switch]$CleanOldVersions
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
$packageRoot = $repoRoot
$workspaceRoot = Split-Path -Parent $repoRoot
$workspaceParent = Split-Path -Parent $workspaceRoot
$scriptsRoot = Join-Path $repoRoot "scripts"
. (Join-Path $scriptRoot "进程工具.ps1")

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-Step {
  param([string]$Message)
  Write-Host "[Postman 汉化] $Message"
}

function Resolve-ExistingPath {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return $null
  }
  $candidate = $PathValue
  if (-not [System.IO.Path]::IsPathRooted($candidate)) {
    $candidate = Join-Path (Get-Location) $candidate
  }
  if (-not (Test-Path -LiteralPath $candidate)) {
    throw "路径不存在：$candidate"
  }
  return (Get-Item -LiteralPath $candidate -ErrorAction Stop).FullName
}

function Test-PostmanAppDir {
  param([string]$Dir)
  if ([string]::IsNullOrWhiteSpace($Dir)) {
    return $false
  }
  return (Test-Path -LiteralPath (Join-Path $Dir "Postman.exe")) -and
    (Test-Path -LiteralPath (Join-Path $Dir "resources\app.asar"))
}

function Get-PostmanAppVersion {
  param([string]$Dir)
  $name = Split-Path -Leaf $Dir
  if ($name -match '^app-(\d+(?:\.\d+){1,3})') {
    try {
      return [version]$Matches[1]
    } catch {}
  }
  return [version]"0.0.0"
}

function Resolve-PostmanAppDir {
  if ($PostmanDir) {
    $resolved = Resolve-ExistingPath $PostmanDir
    if (-not (Test-PostmanAppDir $resolved)) {
      throw "PostmanDir 不是有效的 Postman 版本目录：$resolved"
    }
    return $resolved
  }

  if (-not $Latest) {
    $processCandidates = @()
    try {
      $processCandidates = Get-Process Postman -ErrorAction SilentlyContinue |
        Where-Object { $_.Path } |
        ForEach-Object { Split-Path -Parent $_.Path } |
        Select-Object -Unique
    } catch {}

    foreach ($candidate in $processCandidates) {
      if (Test-PostmanAppDir $candidate) {
        return (Get-Item -LiteralPath $candidate).FullName
      }
    }
  }

  $roots = @(
    (Get-Location).Path,
    $workspaceRoot,
    $workspaceParent,
    (Join-Path $env:LOCALAPPDATA "Postman")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique

  $dirCandidates = @()
  foreach ($root in $roots) {
    $dirCandidates += Get-ChildItem -LiteralPath $root -Directory -Filter "app-*" -ErrorAction SilentlyContinue
  }

  $match = $dirCandidates |
    Where-Object { Test-PostmanAppDir $_.FullName } |
    ForEach-Object {
      [PSCustomObject]@{
        Item = $_
        Version = Get-PostmanAppVersion $_.FullName
        LastWriteTime = $_.LastWriteTime
      }
    } |
    Sort-Object @{ Expression = "Version"; Descending = $true }, @{ Expression = "LastWriteTime"; Descending = $true } |
    Select-Object -First 1

  if ($match) {
    return $match.Item.FullName
  }

  throw "找不到 Postman。请通过 -PostmanDir `"C:\Path\To\Postman\app-x.y.z`" 指定版本目录。"
}

function Invoke-Asar {
  param([string[]]$AsarArgs)
  $npx = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $npx) {
    $npx = Get-Command npx -ErrorAction SilentlyContinue
  }
  if (-not $npx) {
    throw "找不到 npx。请先安装 Node.js，再重新运行本脚本。"
  }

  $nativeArguments = @('--yes', '@electron/asar') + @($AsarArgs)
  $commandParts = @((ConvertTo-NativeArgument $npx.Source))
  foreach ($argument in $nativeArguments) {
    $commandParts += ConvertTo-NativeArgument $argument
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $env:ComSpec
  $startInfo.Arguments = '/d /s /c "' + ($commandParts -join ' ') + '"'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "无法启动 asar 命令。"
  }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(180000)) {
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F *> $null
    $process.Dispose()
    throw "asar 命令执行超过 180 秒，已终止相关进程。"
  }
  $process.WaitForExit()
  $exitCode = $process.ExitCode
  [void]$stdoutTask.GetAwaiter().GetResult()
  [void]$stderrTask.GetAwaiter().GetResult()
  $process.Dispose()
  if ($exitCode -ne 0) {
    throw "asar 命令执行失败：$($AsarArgs -join ' ')"
  }
}

function Read-Utf8 {
  param([string]$PathValue)
  return [System.IO.File]::ReadAllText($PathValue, [System.Text.Encoding]::UTF8)
}

function Write-Utf8 {
  param([string]$PathValue, [string]$Content)
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($PathValue, $Content, $encoding)
}

function Get-Sha256 {
  param([string]$PathValue)
  return (Get-FileHash -LiteralPath $PathValue -Algorithm SHA256).Hash
}

function Assert-JavaScriptSyntax {
  param([string]$PathValue, [string]$Name)

  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $node) {
    $node = Get-Command node -ErrorAction SilentlyContinue
  }
  if (-not $node) {
    throw "找不到 node，无法验证 $Name。"
  }
  & $node.Source --check $PathValue *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "$Name 未通过 JavaScript 语法验证：$PathValue"
  }
}

function Assert-PayloadFiles {
  param([string]$Payload, [string]$AuthPayload)

  if (-not (Test-Path -LiteralPath $Payload)) {
    throw "找不到汉化主体文件：$Payload"
  }
  if (-not (Test-Path -LiteralPath $AuthPayload)) {
    throw "找不到登录授权页面汉化文件：$AuthPayload"
  }
  Assert-JavaScriptSyntax -PathValue $Payload -Name "zh-localize.js"
  Assert-JavaScriptSyntax -PathValue $AuthPayload -Name "zh-auth-webview-preload.js"

  $payloadContent = Read-Utf8 $Payload
  $required = @(
    "__POSTMAN_ZH_LOCALIZER__",
    "data-postman-zh-localized",
    "MutationObserver",
    "installShadowRootLocalization"
  )
  $missing = @($required | Where-Object { -not $payloadContent.Contains($_) })
  if ($missing.Count -gt 0) {
    throw "汉化主体文件不完整，缺少标记：$($missing -join ', ')"
  }
  Write-Step "汉化文件语法和必需标记验证通过。"
}

function Assert-OriginalTree {
  param([string]$UnpackedDir, [string]$AppDir)

  $packageJson = Join-Path $UnpackedDir "package.json"
  $mainJs = Join-Path $UnpackedDir "main.js"
  $desktopPreload = Join-Path $UnpackedDir "preload_desktop.js"
  $utilityPreload = Join-Path $UnpackedDir "js\preload.js"
  if (-not (Test-Path -LiteralPath $packageJson) -or
      -not (Test-Path -LiteralPath $mainJs) -or
      -not (Test-Path -LiteralPath $desktopPreload) -or
      -not (Test-Path -LiteralPath $utilityPreload)) {
    throw "英文原版 app.asar 备份不完整。"
  }

  try {
    $metadata = ConvertFrom-Json (Read-Utf8 $packageJson)
  } catch {
    throw "英文原版 app.asar 的 package.json 无效。"
  }
  $appName = Split-Path -Leaf $AppDir
  if ($appName -match '^app-(\d+(?:\.\d+){1,3})') {
    $expectedVersion = $Matches[1]
    if ([string]$metadata.version -ne $expectedVersion) {
      throw "app.asar.original 的版本 $($metadata.version) 与 $appName 不一致。请先妥善保存旧备份，再移除它并重试。"
    }
  }

  $markerFiles = @($mainJs, $desktopPreload, $utilityPreload)
  foreach ($markerFile in $markerFiles) {
    if ((Read-Utf8 $markerFile) -match 'postman-zh-localizer|postmanZhLocalizeMenuTemplate|postmanZhPatchOpenExternalQuotes|postman-zh:update-guard|updates disabled by postman-zh|update restart blocked by postman-zh') {
      throw "app.asar.original 已含汉化标记，不是干净的英文原版：$markerFile"
    }
  }
  if (Test-Path -LiteralPath (Join-Path $UnpackedDir "js\zh-localize.js")) {
    throw "app.asar.original 已包含 js\zh-localize.js，不是干净的英文原版。"
  }
  Write-Step "英文原版备份的版本和完整性验证通过。"
}

function Assert-PatchedTree {
  param(
    [string]$UnpackedDir,
    [string]$Payload,
    [string]$AuthPayload,
    [switch]$ExpectUpdatesDisabled
  )

  $localizedPayload = Join-Path $UnpackedDir "js\zh-localize.js"
  $localizedAuthPayload = Join-Path $UnpackedDir "js\zh-auth-webview-preload.js"
  $desktopPreload = Join-Path $UnpackedDir "preload_desktop.js"
  $utilityPreload = Join-Path $UnpackedDir "js\preload.js"
  $mainJs = Join-Path $UnpackedDir "main.js"
  foreach ($requiredFile in @($localizedPayload, $localizedAuthPayload, $desktopPreload, $utilityPreload, $mainJs)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
      throw "补丁目录缺少文件：$requiredFile"
    }
  }

  if ((Get-Sha256 $localizedPayload) -ne (Get-Sha256 $Payload)) {
    throw "打包目录中的汉化主体与选定的 zh-localize.js 不一致。"
  }
  if ((Get-Sha256 $localizedAuthPayload) -ne (Get-Sha256 $AuthPayload)) {
    throw "打包目录中的登录授权汉化文件与 zh-auth-webview-preload.js 不一致。"
  }

  $desktopContent = Read-Utf8 $desktopPreload
  $utilityContent = Read-Utf8 $utilityPreload
  $mainContent = Read-Utf8 $mainJs
  $requiredMarkers = @(
    @($desktopContent, "postman-zh-localizer:desktop"),
    @($utilityContent, "postman-zh-localizer:utility"),
    @($utilityContent, "postman-zh-localizer:auth-webview-preload"),
    @($mainContent, "postmanZhLocalizeMenuTemplate"),
    @($mainContent, "postmanZhPatchOpenExternalQuotes")
  )
  foreach ($entry in $requiredMarkers) {
    if (-not ([string]$entry[0]).Contains([string]$entry[1])) {
      throw "补丁目录缺少注入标记：$($entry[1])"
    }
  }
  if ($ExpectUpdatesDisabled -and -not $mainContent.Contains("postman-zh:update-guard")) {
    throw "补丁目录缺少与版本无关的更新拦截补丁。"
  }
  Assert-JavaScriptSyntax -PathValue $mainJs -Name "main.js"
  Assert-JavaScriptSyntax -PathValue $desktopPreload -Name "preload_desktop.js"
  Assert-JavaScriptSyntax -PathValue $utilityPreload -Name "js/preload.js"
  Write-Step "补丁目录的文件哈希和注入标记验证通过。"
}

function Assert-OriginalAsarBackup {
  param([string]$BackupAsar, [string]$AppDir)

  if (-not (Test-Path -LiteralPath $BackupAsar -PathType Leaf)) {
    throw "找不到英文原版备份：$BackupAsar"
  }
  if ((Get-Item -LiteralPath $BackupAsar).Length -le 0) {
    throw "英文原版备份为空文件：$BackupAsar"
  }

  $checkDir = Join-Path ([IO.Path]::GetTempPath()) ("postman-zh-restore-check-{0}" -f [guid]::NewGuid().ToString("N"))
  try {
    Write-Step "正在检查英文原版备份。"
    Invoke-Asar @("extract", $BackupAsar, $checkDir)
    Assert-OriginalTree -UnpackedDir $checkDir -AppDir $AppDir
  } finally {
    Remove-Item -LiteralPath $checkDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Stop-PostmanCompletely {
  $stopScript = Join-Path $scriptRoot "关闭程序.ps1"
  if (-not (Test-Path -LiteralPath $stopScript -PathType Leaf)) {
    throw "找不到关闭程序脚本：$stopScript"
  }

  $powershellExe = Join-Path $PSHOME "powershell.exe"
  & $powershellExe -NoProfile -ExecutionPolicy Bypass -File $stopScript -MaxRounds 20 -SleepMs 500 -StableChecks 3
  if ($LASTEXITCODE -ne 0) {
    throw "无法彻底关闭 Postman，安装已中止。"
  }
  $remaining = @(Get-Process -Name Postman -ErrorAction SilentlyContinue)
  if ($remaining.Count -gt 0) {
    $ids = ($remaining | Select-Object -ExpandProperty Id | Sort-Object) -join ", "
    throw "关闭检查后 Postman 又重新启动（PID：$ids），安装已中止。"
  }
}

function New-OriginalAsarBackup {
  param([string]$SourceAsar, [string]$BackupAsar)

  if (-not (Test-Path -LiteralPath $SourceAsar -PathType Leaf)) {
    throw "找不到待备份的 app.asar：$SourceAsar"
  }
  if (Test-Path -LiteralPath $BackupAsar) {
    throw "英文原版备份已经存在，不能覆盖：$BackupAsar"
  }

  $creatingAsar = "$BackupAsar.creating"
  Remove-Item -LiteralPath $creatingAsar -Force -ErrorAction SilentlyContinue
  $sourceHash = Get-Sha256 $SourceAsar
  try {
    Copy-Item -LiteralPath $SourceAsar -Destination $creatingAsar
    if ((Get-Sha256 $creatingAsar) -ne $sourceHash) {
      throw "英文原版临时备份未通过哈希校验。"
    }
    Move-Item -LiteralPath $creatingAsar -Destination $BackupAsar
    if ((Get-Sha256 $BackupAsar) -ne $sourceHash) {
      Remove-Item -LiteralPath $BackupAsar -Force -ErrorAction SilentlyContinue
      throw "英文原版备份未通过哈希校验。"
    }
  } finally {
    Remove-Item -LiteralPath $creatingAsar -Force -ErrorAction SilentlyContinue
  }
  Write-Step "已创建英文原版备份：$BackupAsar"
}

function Install-AsarAtomically {
  param([string]$SourceAsar, [string]$DestinationAsar)

  $installingAsar = "$DestinationAsar.installing"
  $rollbackAsar = "$DestinationAsar.rollback"
  Remove-Item -LiteralPath $installingAsar -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $rollbackAsar) {
    throw "发现上次替换失败后保留的回滚副本：$rollbackAsar。请先确认并恢复该文件，避免覆盖可恢复数据。"
  }

  $sourceHash = Get-Sha256 $SourceAsar
  $destinationHash = Get-Sha256 $DestinationAsar
  Copy-Item -LiteralPath $SourceAsar -Destination $installingAsar -Force
  if ((Get-Sha256 $installingAsar) -ne $sourceHash) {
    Remove-Item -LiteralPath $installingAsar -Force -ErrorAction SilentlyContinue
    throw "临时 app.asar 副本未通过哈希验证。"
  }

  $safeToRemoveRollback = $false
  try {
    [System.IO.File]::Replace($installingAsar, $DestinationAsar, $rollbackAsar, $true)
    if ((Get-Sha256 $DestinationAsar) -ne $sourceHash) {
      if (-not (Test-Path -LiteralPath $rollbackAsar)) {
        throw "安装后的 app.asar 未通过哈希验证，且找不到回滚副本。"
      }
      Copy-Item -LiteralPath $rollbackAsar -Destination $DestinationAsar -Force
      if ((Get-Sha256 $DestinationAsar) -ne $destinationHash) {
        throw "安装后的 app.asar 未通过哈希验证，自动恢复原文件也未通过哈希验证；回滚副本已保留。"
      }
      $safeToRemoveRollback = $true
      throw "安装后的 app.asar 未通过哈希验证，已恢复原文件。"
    }
    $safeToRemoveRollback = $true
  } finally {
    Remove-Item -LiteralPath $installingAsar -Force -ErrorAction SilentlyContinue
    if ($safeToRemoveRollback) {
      Remove-Item -LiteralPath $rollbackAsar -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Step "app.asar 已安全替换并通过哈希校验。"
}

function Remove-InstallArtifacts {
  param([string]$UnpackedDir, [string]$PatchedAsar, [string]$AppAsar)
  # 只删除本工具创建的明确路径，保留 Postman 官方可能使用的 app.asar.unpacked。
  if ($UnpackedDir -and (Test-Path -LiteralPath $UnpackedDir)) {
    try {
      Remove-Item -LiteralPath $UnpackedDir -Recurse -Force -ErrorAction Stop
    } catch {
      throw "无法删除本工具的解包目录 '$UnpackedDir'：$($_.Exception.Message)"
    }
  }
  Remove-Item -LiteralPath $PatchedAsar -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "$AppAsar.installing" -Force -ErrorAction SilentlyContinue
  Write-Step "已清理安装临时文件。"
}

function Add-ZhLoaderToPreload {
  param(
    [string]$PreloadPath,
    [string]$RequirePath,
    [string]$Name,
    [string]$ExtraScript
  )

  if (-not (Test-Path -LiteralPath $PreloadPath)) {
    Write-Step "未找到 $Name 预加载文件，已跳过。"
    return
  }

  $marker = "postman-zh-localizer:$Name"
  $loader = @"
;(()=>{try{/* $marker */var p=require.resolve("$RequirePath");delete require.cache[p];require(p);if(document&&document.documentElement){document.documentElement.setAttribute("data-postman-zh-preload","true");}}catch(e){try{console.warn("Postman zh localizer preload failed",e);}catch(_){}}})();
"@

  $content = Read-Utf8 $PreloadPath
  $changed = $false
  if (-not $content.Contains($marker)) {
    $content = $content.TrimEnd() + "`r`n" + $loader.TrimEnd() + "`r`n"
    $changed = $true
  }
  if ($ExtraScript -and -not $content.Contains("postman-zh-localizer:auth-webview-preload")) {
    $content = $content.TrimEnd() + "`r`n" + $ExtraScript.TrimEnd() + "`r`n"
    $changed = $true
  }

  if ($changed) {
    Write-Utf8 $PreloadPath $content
    Write-Step "已注入 $Name 预加载文件。"
  } else {
    Write-Step "$Name 预加载文件已包含汉化注入。"
  }
}

function Patch-Preload {
  param([string]$UnpackedDir, [string]$Payload)

  $jsDir = Join-Path $UnpackedDir "js"
  New-Item -ItemType Directory -Force -Path $jsDir | Out-Null
  Copy-Item -LiteralPath $Payload -Destination (Join-Path $jsDir "zh-localize.js") -Force

  $payloadDir = Split-Path -Parent $Payload
  $authWebviewPreloadPayload = Join-Path $payloadDir "zh-auth-webview-preload.js"
  if (-not (Test-Path -LiteralPath $authWebviewPreloadPayload)) {
    throw "payload 目录中缺少 zh-auth-webview-preload.js。"
  }
  Copy-Item -LiteralPath $authWebviewPreloadPayload -Destination (Join-Path $jsDir "zh-auth-webview-preload.js") -Force

  $desktopPreload = Join-Path $UnpackedDir "preload_desktop.js"
  if (-not (Test-Path -LiteralPath $desktopPreload)) {
    throw "解包后的应用中缺少 preload_desktop.js。"
  }

  Add-ZhLoaderToPreload -PreloadPath $desktopPreload -RequirePath "./js/zh-localize.js" -Name "desktop" -ExtraScript $null

  $authPreloadHelper = @'
;(()=>{try{/* postman-zh-localizer:auth-webview-preload */function a(){try{if(!/[/\\]html[/\\]auth[/\\]auth\.html(?:$|[?#])/i.test(location.href)){return;}var w=document.querySelector("webview[partition='authentication'],webview");if(!w){return;}var u=new URL("../../js/zh-auth-webview-preload.js",location.href);w.setAttribute("preload",u.href);w.setAttribute("data-postman-zh-auth-preload","true");}catch(e){try{console.warn("Postman zh auth webview preload hook failed",e);}catch(_){}}}if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",a,{once:true});}else{a();}}catch(e){try{console.warn("Postman zh auth webview hook failed",e);}catch(_){}}})();
'@
  Add-ZhLoaderToPreload -PreloadPath (Join-Path $jsDir "preload.js") -RequirePath "./zh-localize.js" -Name "utility" -ExtraScript $authPreloadHelper
}

function Patch-AuthWindowLocalization {
  param([string]$UnpackedDir)

  $authHtml = Join-Path $UnpackedDir "html\auth\auth.html"
  if (-not (Test-Path -LiteralPath $authHtml)) {
    Write-Step "未找到 auth.html，已跳过登录授权页面预加载补丁。"
    return
  }

  $content = Read-Utf8 $authHtml
  if ($content -match "zh-auth-webview-preload\.js") {
    Write-Step "登录授权页面的预加载补丁已经安装。"
    return
  }

  $pattern = '<webview([^>]*partition=[''"]authentication[''"][^>]*)></webview>'
  $replacement = '<webview$1 preload="../../js/zh-auth-webview-preload.js"></webview>'
  $updated = [System.Text.RegularExpressions.Regex]::Replace($content, $pattern, $replacement, 1)
  if ($updated -eq $content) {
    Write-Step "未找到登录授权页面锚点，继续使用通用预加载兜底。"
    return
  }

  Write-Utf8 $authHtml $updated
  Write-Step "已安装登录授权页面汉化预加载补丁。"
}

function Patch-ScratchpadCompatibility {
  param([string]$UnpackedDir)

  $scratchpad = Join-Path $UnpackedDir "js\scratchpad\scratchpad.js"
  if (-not (Test-Path -LiteralPath $scratchpad)) {
    return
  }

  $content = Read-Utf8 $scratchpad
  $from = 'e.target.closest(".requester-tab")'
  $to = 'e.target.closest(".requester-tab,[data-tab-id]")'
  if ($content.Contains($from)) {
    $content = $content.Replace($from, $to)
    Write-Utf8 $scratchpad $content
    Write-Step "已修复请求标签页右键菜单选择器。"
  } else {
    Write-Step "请求标签页右键菜单选择器无需修复。"
  }
}

function Patch-MainMenuLocalization {
  param([string]$UnpackedDir)

  $mainJs = Join-Path $UnpackedDir "main.js"
  if (-not (Test-Path -LiteralPath $mainJs)) {
    Write-Step "未找到 main.js，已跳过应用菜单汉化。"
    return
  }

  $content = Read-Utf8 $mainJs
  if ($content.Contains("postmanZhLocalizeMenuTemplate")) {
    Write-Step "应用菜单汉化补丁已经安装。"
    return
  }
  # Version-robust strategy: wrap electron Menu.buildFromTemplate globally at the
  # top of main.js instead of patching minified call sites (whose variable names
  # change with every Postman release). Covers app menu, dock menu and every
  # native context menu built in the main process.

  $helper = @'
;(()=>{try{/* postman-zh:app-menu */var zhMenu=require("electron").Menu;function postmanZhLocalizeMenuTemplate(e){const t={"File":"\u6587\u4ef6","Edit":"\u7f16\u8f91","View":"\u67e5\u770b","Help":"\u5e2e\u52a9","New":"\u65b0\u5efa","New...":"\u65b0\u5efa...","New Tab":"\u65b0\u5efa\u6807\u7b7e\u9875","New Runner Tab":"\u65b0\u5efa\u8fd0\u884c\u5668\u6807\u7b7e\u9875","New Postman Window":"\u65b0\u5efa Postman \u7a97\u53e3","New Window":"\u65b0\u5efa\u7a97\u53e3","New Window ":"\u65b0\u5efa\u7a97\u53e3","New Collection":"\u65b0\u5efa\u96c6\u5408","New Request":"\u65b0\u5efa\u8bf7\u6c42","Import":"\u5bfc\u5165","Import...":"\u5bfc\u5165...","Close Window":"\u5173\u95ed\u7a97\u53e3","Close Tab":"\u5173\u95ed\u6807\u7b7e\u9875","Force Close Tab":"\u5f3a\u5236\u5173\u95ed\u6807\u7b7e\u9875","Close Other Tabs":"\u5173\u95ed\u5176\u4ed6\u6807\u7b7e\u9875","Close All Tabs":"\u5173\u95ed\u6240\u6709\u6807\u7b7e\u9875","Undo":"\u64a4\u9500","Redo":"\u91cd\u505a","Cut":"\u526a\u5207","Copy":"\u590d\u5236","Paste":"\u7c98\u8d34","Paste and Match Style":"\u7c98\u8d34\u5e76\u5339\u914d\u6837\u5f0f","Delete":"\u5220\u9664","Select All":"\u5168\u9009","Find":"\u67e5\u627e","Find and Replace":"\u67e5\u627e\u548c\u66ff\u6362","Zoom In":"\u653e\u5927","Zoom Out":"\u7f29\u5c0f","Reset Zoom":"\u91cd\u7f6e\u7f29\u653e","Toggle Full Screen":"\u5207\u6362\u5168\u5c4f","Toggle Two-Pane View":"\u5207\u6362\u53cc\u680f\u89c6\u56fe","Toggle Sidebar":"\u5207\u6362\u4fa7\u8fb9\u680f","Toggle Left Sidebar":"\u5207\u6362\u5de6\u4fa7\u8fb9\u680f","Toggle Right Sidebar":"\u5207\u6362\u53f3\u4fa7\u8fb9\u680f","Toggle Workbench":"\u5207\u6362\u5de5\u4f5c\u53f0","Swap Left and Right Sidebar":"\u4ea4\u6362\u5de6\u53f3\u4fa7\u8fb9\u680f","Reset Layout":"\u91cd\u7f6e\u5e03\u5c40","Go Back":"\u540e\u9000","Go Forward":"\u524d\u8fdb","Next Tab":"\u4e0b\u4e00\u4e2a\u6807\u7b7e\u9875","Previous Tab":"\u4e0a\u4e00\u4e2a\u6807\u7b7e\u9875","Show Console":"\u663e\u793a\u63a7\u5236\u53f0","Show Postman Console":"\u663e\u793a Postman \u63a7\u5236\u53f0","Developer":"\u5f00\u53d1\u8005","Show DevTools":"\u663e\u793a\u5f00\u53d1\u8005\u5de5\u5177","Show DevTools (Current View)":"\u663e\u793a\u5f00\u53d1\u8005\u5de5\u5177\uff08\u5f53\u524d\u89c6\u56fe\uff09","View Logs":"\u67e5\u770b\u65e5\u5fd7","View Logs in Explorer":"\u5728\u8d44\u6e90\u7ba1\u7406\u5668\u4e2d\u67e5\u770b\u65e5\u5fd7","Check for Updates...":"\u68c0\u67e5\u66f4\u65b0...","Check for Updates":"\u68c0\u67e5\u66f4\u65b0","Clear Cache and Reload":"\u6e05\u9664\u7f13\u5b58\u5e76\u91cd\u65b0\u52a0\u8f7d","Disable Hardware Acceleration":"\u7981\u7528\u786c\u4ef6\u52a0\u901f","Region Preference for New Accounts":"\u65b0\u8d26\u53f7\u533a\u57df\u504f\u597d","Use US Region by Default":"\u9ed8\u8ba4\u4f7f\u7528\u7f8e\u56fd\u533a","Use EU Region by Default":"\u9ed8\u8ba4\u4f7f\u7528\u6b27\u76df\u533a","Always Ask for Region Selection":"\u59cb\u7ec8\u8be2\u95ee\u533a\u57df\u9009\u62e9","Documentation":"\u6587\u6863","GitHub":"GitHub","Twitter":"Twitter","Support":"\u652f\u6301","Trust and Security":"\u4fe1\u4efb\u4e0e\u5b89\u5168","Privacy Policy":"\u9690\u79c1\u653f\u7b56","Terms":"\u6761\u6b3e","Community":"\u793e\u533a","Github Issues":"GitHub \u95ee\u9898\u53cd\u9988","GitHub Issues":"GitHub \u95ee\u9898\u53cd\u9988","Keyboard Shortcuts":"\u952e\u76d8\u5feb\u6377\u952e","Disable GPU":"\u7981\u7528 GPU","Enable GPU":"\u542f\u7528 GPU","Open Logs Folder":"\u6253\u5f00\u65e5\u5fd7\u6587\u4ef6\u5939","About Postman":"\u5173\u4e8e Postman","Preferences":"\u504f\u597d\u8bbe\u7f6e","Settings":"\u8bbe\u7f6e","Exit":"\u9000\u51fa","Hide Postman":"\u9690\u85cf Postman","Hide Others":"\u9690\u85cf\u5176\u4ed6","Show All":"\u5168\u90e8\u663e\u793a","Quit Postman":"\u9000\u51fa Postman","Services":"\u670d\u52a1","Window":"\u7a97\u53e3","Minimize":"\u6700\u5c0f\u5316","Zoom":"\u7f29\u653e","Bring All to Front":"\u5168\u90e8\u7f6e\u4e8e\u524d\u53f0"};function n(e){if(!e||"string"!=typeof e)return e;let n=e.replace(/\s+/g," ").trim();return Object.prototype.hasOwnProperty.call(t,n)?e.replace(n,t[n]):e}function r(e){if(!e||"object"!=typeof e)return e;try{"string"==typeof e.label&&(e.label=n(e.label));"string"==typeof e.sublabel&&(e.sublabel=n(e.sublabel));"string"==typeof e.toolTip&&(e.toolTip=n(e.toolTip));Array.isArray(e.submenu)?e.submenu.forEach(r):e.submenu&&e.submenu.items&&Array.prototype.forEach.call(e.submenu.items,r)}catch(e){}return e}return Array.isArray(e)&&e.forEach(r),e}if(zhMenu&&zhMenu.buildFromTemplate&&!zhMenu.__postmanZhMenuPatched){var zhOrigBuild=zhMenu.buildFromTemplate.bind(zhMenu);zhMenu.buildFromTemplate=function(e){try{postmanZhLocalizeMenuTemplate(e)}catch(t){}return zhOrigBuild(e)};zhMenu.__postmanZhMenuPatched=!0}}catch(e){try{console.warn("postman-zh menu patch failed",e)}catch(t){}}})();
'@

  Write-Utf8 $mainJs ($helper.TrimEnd() + "`r`n" + $content)
  Write-Step "已安装应用菜单汉化补丁（全局 Menu.buildFromTemplate 包装器）。"
}

function Patch-ExternalUrlOpening {
  param([string]$UnpackedDir)

  $mainJs = Join-Path $UnpackedDir "main.js"
  if (-not (Test-Path -LiteralPath $mainJs)) {
    Write-Step "未找到 main.js，已跳过外部链接引号补丁。"
    return
  }

  $content = Read-Utf8 $mainJs
  if ($content.Contains("postmanZhPatchOpenExternalQuotes")) {
    Write-Step "外部链接引号补丁已经安装。"
    return
  }

  $helper = @'
;(()=>{try{/* postmanZhPatchOpenExternalQuotes */const e=require("electron").shell;if(e&&e.openExternal&&!e.__postmanZhOpenExternalPatched){const t=e.openExternal.bind(e);function n(e){if("string"!=typeof e)return e;let t=e.trim();for(let e=0;e<8;e++){const n=t;t=t.replace(/^\\(["'])([\s\S]*)\\\1$/,"$2").replace(/^%5c%22([\s\S]*)%5c%22$/i,"$1").replace(/^%5c%27([\s\S]*)%5c%27$/i,"$1").replace(/^%2522([\s\S]*)%2522$/i,"$1").replace(/^%2527([\s\S]*)%2527$/i,"$1").replace(/^%22([\s\S]*)%22$/i,"$1").replace(/^%27([\s\S]*)%27$/i,"$1").replace(/^&quot;([\s\S]*)&quot;$/i,"$1").replace(/^&#34;([\s\S]*)&#34;$/i,"$1").replace(/^&#39;([\s\S]*)&#39;$/i,"$1").trim();if(('"'===t[0]&&'"'===t[t.length-1])||("'"===t[0]&&"'"===t[t.length-1])){t=t.slice(1,-1).trim()}if(t===n)break}return t}function o(e,t){if(!process||!process.env||!process.env.POSTMAN_ZH_DEBUG_OPEN_EXTERNAL)return;try{const n=require("fs"),o=require("path"),r=process.env.APPDATA||process.env.TEMP;if(!r)return;const s=o.join(r,"Postman","logs");try{n.mkdirSync(s,{recursive:!0})}catch(e){}n.appendFileSync(o.join(s,"postman-zh-open-external.log"),JSON.stringify({time:(new Date).toISOString(),before:e,after:t})+"\n")}catch(e){}}e.openExternal=function(...e){if(e.length){const t=e[0],r=n(t);e[0]=r,o(t,r)}return t(...e)},e.__postmanZhNormalizeExternalUrl=n,e.__postmanZhOpenExternalPatched=!0}}catch(e){try{console.warn("Postman zh openExternal quote patch failed",e)}catch(e){}}})();
'@

  Write-Utf8 $mainJs ($helper.TrimEnd() + "`r`n" + $content)
  Write-Step "已修复外部浏览器链接的引号处理。"
}

function Patch-DisableUpdates {
  param([string]$UnpackedDir)

  $mainJs = Join-Path $UnpackedDir "main.js"
  if (-not (Test-Path -LiteralPath $mainJs)) {
    throw "未找到 main.js，无法禁用 Postman 自动更新。"
  }

  $content = Read-Utf8 $mainJs
  $patchCount = 0

  # Keep a version-independent guard at the top of main.js. The targeted
  # source rewrites below make the Settings page nicer, while this guard still
  # blocks downloads/restarts if Postman's minifier changes those method bodies.
  $runtimeMarker = 'postman-zh:update-guard'
  if (-not $content.Contains($runtimeMarker)) {
    $runtimeGuard = @'
;(()=>{try{/* postman-zh:update-guard */const u=require("electron").autoUpdater;if(u&&!u.__postmanZhUpdatesDisabled){function p(n,f){try{u[n]=f}catch(e){try{Object.defineProperty(u,n,{value:f,configurable:!0,writable:!0})}catch(e){}}}function e(){setTimeout(()=>{try{u.emit("update-not-available",{},"postman-zh update guard")}catch(e){}},0)}p("checkForUpdates",function(){return e(),Promise.resolve(null)}),p("quitAndInstall",function(){return void 0}),"function"==typeof u.downloadUpdate&&p("downloadUpdate",function(){return e(),Promise.resolve(null)}),u.__postmanZhUpdatesDisabled=!0}}catch(e){try{console.warn("Postman zh update guard failed",e)}catch(e){}}})();
'@
    $content = $runtimeGuard.TrimEnd() + "`r`n" + $content
  }

  # NOTE: we deliberately do NOT force isUpdateEnabled=false anymore.
  # Doing so makes the Settings > Update page render a connection error.
  # Neutralizing downloadUpdate below is enough to block real updates while
  # keeping the page functional ("Postman vX.Y.Z is the latest version").

  $downloadMarker = 'updates disabled by postman-zh'
  if ($content.Contains($downloadMarker)) {
    $patchCount += 1
  } else {
    # Tolerate minifier renames of the local variable across Postman versions.
    $downloadPattern = 'downloadUpdate\((\w+)\)\{var (\w+)=this\.getFeedUrl\(\1\);this\.autoUpdater\.setFeedURL\(\2\),this\.autoUpdater\.checkForUpdates\(\)\}'
    $downloadReplacement = 'downloadUpdate($1){this.logger&&this.logger.warn&&this.logger.warn("@postman/app-updater: updates disabled by postman-zh");this.emit("updateNotAvailable",$1||{})}'
    $updated = [System.Text.RegularExpressions.Regex]::Replace($content, $downloadPattern, $downloadReplacement, 1)
    if ($updated -ne $content) {
      $content = $updated
      $patchCount += 1
    }
  }

  $restartMarker = 'update restart blocked by postman-zh'
  if ($content.Contains($restartMarker)) {
    $patchCount += 1
  } else {
    $restartPattern = 'restartAppToUpdate\((\w+)\)\{this\.emit\("beforeAppQuit"\),\1\.restart\?this\.logger\.info\("@postman/app-updater: restarting app to update"\):this\.logger\.info\("@postman/app-updater: quitting app to update"\),this\.autoUpdater\.quitAndInstall\(\1\)\}'
    $restartReplacement = 'restartAppToUpdate($1){this.logger&&this.logger.warn&&this.logger.warn("@postman/app-updater: update restart blocked by postman-zh")}'
    $updated = [System.Text.RegularExpressions.Regex]::Replace($content, $restartPattern, $restartReplacement, 1)
    if ($updated -ne $content) {
      $content = $updated
      $patchCount += 1
    }
  }

  if ($patchCount -eq 0) {
    throw "当前版本未找到可确认的更新方法锚点，已中止安装更新拦截补丁。"
  }
  Write-Utf8 $mainJs $content
  Write-Step "已安装与版本无关的更新拦截补丁，并处理 $patchCount 个更新方法锚点。"
}

function Remove-OldPostmanVersions {
  param([string]$CurrentAppDir)

  $parent = Split-Path -Parent $CurrentAppDir
  $currentName = Split-Path -Leaf $CurrentAppDir
  if (-not (Test-Path -LiteralPath (Join-Path $parent "Update.exe"))) {
    Write-Step "已跳过旧版本清理：$parent 不是 Squirrel 安装根目录。"
    return
  }

  Get-ChildItem -LiteralPath $parent -Directory -Filter "app-*" -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -ne $currentName
  } | ForEach-Object {
    Write-Step "正在删除旧版本目录：$($_.Name)"
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
  }

  $currentVersion = $null
  if ($currentName -match '^app-(.+)$') {
    $currentVersion = $Matches[1]
  }
  $packagesDir = Join-Path $parent "packages"
  if ($currentVersion -and (Test-Path -LiteralPath $packagesDir)) {
    Get-ChildItem -LiteralPath $packagesDir -File -Filter "*.nupkg" -ErrorAction SilentlyContinue | Where-Object {
      $_.Name -notlike "*$currentVersion*"
    } | ForEach-Object {
      Write-Step "正在删除旧安装包：$($_.Name)"
      Remove-Item -LiteralPath $_.FullName -Force
    }
    $releasesFile = Join-Path $packagesDir "RELEASES"
    if (Test-Path -LiteralPath $releasesFile) {
      $keep = @(Get-Content -LiteralPath $releasesFile | Where-Object { $_ -like "*$currentVersion*" })
      if ($keep.Count -gt 0) {
        Set-Content -LiteralPath $releasesFile -Value $keep -Encoding Ascii
        Write-Step "已将 RELEASES 精简为仅保留当前版本。"
      }
    }
  }
}

if (-not $PayloadPath) {
  $PayloadPath = Join-Path $packageRoot "payload\zh-localize.js"
}
$appDir = Resolve-PostmanAppDir
$payloadFull = $null
$authPayloadFull = $null
if (-not $RestoreOriginal) {
  $payloadFull = Resolve-ExistingPath $PayloadPath
  $authPayloadFull = Join-Path (Split-Path -Parent $payloadFull) "zh-auth-webview-preload.js"
  Assert-PayloadFiles -Payload $payloadFull -AuthPayload $authPayloadFull
}
$resourcesDir = Join-Path $appDir "resources"
$appAsar = Join-Path $resourcesDir "app.asar"
$backupAsar = Join-Path $resourcesDir "app.asar.original"
$unpackedDir = Join-Path $resourcesDir "app.asar.unpacked.zh"
$patchedAsar = Join-Path $resourcesDir "app.asar.zh"

Write-Step "目标目录：$appDir"
if ($payloadFull) {
  Write-Step "汉化主体：$payloadFull"
}

Stop-PostmanCompletely

if ($RestoreOriginal) {
  Assert-OriginalAsarBackup -BackupAsar $backupAsar -AppDir $appDir
  Install-AsarAtomically -SourceAsar $backupAsar -DestinationAsar $appAsar
  Write-Step "已恢复英文原版 app.asar。"
  Remove-InstallArtifacts -UnpackedDir $unpackedDir -PatchedAsar $patchedAsar -AppAsar $appAsar
  if (-not $NoRestart) {
    Write-Step "正在启动 Postman。"
    Start-PostmanDetached -FilePath (Join-Path $appDir "Postman.exe")
  }
  Write-Step "操作完成。"
  exit 0
}

$backupCreatedThisRun = $false
if (-not (Test-Path -LiteralPath $backupAsar)) {
  New-OriginalAsarBackup -SourceAsar $appAsar -BackupAsar $backupAsar
  $backupCreatedThisRun = $true
} else {
  Write-Step "英文原版备份已经存在：$backupAsar"
}
$sourceAsar = $backupAsar

$formalAsarReplaced = $false
$installCompleted = $false
$installError = $null
$cleanupError = $null
$rollbackError = $null
$originalTreeValidated = $false

try {
  if (Test-Path -LiteralPath $unpackedDir) {
    Write-Step "正在删除旧的解包目录。"
    Remove-Item -LiteralPath $unpackedDir -Recurse -Force
  }

  Write-Step "正在解包英文原版 app.asar 备份。"
  Invoke-Asar @("extract", $sourceAsar, $unpackedDir)
  Assert-OriginalTree -UnpackedDir $unpackedDir -AppDir $appDir
  $originalTreeValidated = $true

  Patch-Preload -UnpackedDir $unpackedDir -Payload $payloadFull
  Patch-AuthWindowLocalization -UnpackedDir $unpackedDir
  Patch-ScratchpadCompatibility -UnpackedDir $unpackedDir
  Patch-MainMenuLocalization -UnpackedDir $unpackedDir
  Patch-ExternalUrlOpening -UnpackedDir $unpackedDir
  if ($DisableUpdates) {
    Patch-DisableUpdates -UnpackedDir $unpackedDir
  } else {
    Write-Step "已保留 Postman 自动更新；如需拦截应用内更新检查，请使用 -DisableUpdates。"
  }
  Assert-PatchedTree -UnpackedDir $unpackedDir -Payload $payloadFull -AuthPayload $authPayloadFull -ExpectUpdatesDisabled:$DisableUpdates

  if (Test-Path -LiteralPath $patchedAsar) {
    Remove-Item -LiteralPath $patchedAsar -Force
  }

  Write-Step "正在打包已汉化的 app.asar。"
  Invoke-Asar @("pack", $unpackedDir, $patchedAsar)
  $formalAsarReplaced = $true
  Install-AsarAtomically -SourceAsar $patchedAsar -DestinationAsar $appAsar
  Write-Step "中文汉化已安装。"

  if (-not $NoRestart) {
    $args = @()
    if ($Verify) {
      $portFile = Join-Path $env:APPDATA "Postman\DevToolsActivePort"
      if (Test-Path -LiteralPath $portFile) {
        Remove-Item -LiteralPath $portFile -Force
      }
      $args += "--remote-debugging-port=0"
    }
    Write-Step "正在启动 Postman。"
    Start-PostmanDetached -FilePath (Join-Path $appDir "Postman.exe") -ArgumentList $args
  }

  if ($Verify) {
    if ($NoRestart) {
      Write-Step "由于使用了 -NoRestart，已跳过运行时验证。"
    } else {
      Start-Sleep -Seconds 18
      $verifyScript = Join-Path $scriptsRoot "验证汉化.js"
      if (Test-Path -LiteralPath $verifyScript) {
        $verifyArgs = @("--postman-dir", $appDir)
        if ($DisableUpdates) {
          $verifyArgs += "--expect-updates-disabled"
        }
        & node $verifyScript @verifyArgs
        if ($LASTEXITCODE -ne 0) {
          throw "汉化验证失败。"
        }
      } else {
        throw "找不到验证脚本：$verifyScript"
      }
    }
  }

  $installCompleted = $true
} catch {
  $installError = $_
  if ($formalAsarReplaced) {
    Write-Step "安装未通过，正在恢复英文原版。"
    try {
      Stop-PostmanCompletely
      Install-AsarAtomically -SourceAsar $backupAsar -DestinationAsar $appAsar
      Write-Step "已恢复英文原版 app.asar。"
    } catch {
      $rollbackError = $_
    }
  }
} finally {
  try {
    Remove-InstallArtifacts -UnpackedDir $unpackedDir -PatchedAsar $patchedAsar -AppAsar $appAsar
  } catch {
    $cleanupError = $_
  }
}

if ($backupCreatedThisRun -and -not $originalTreeValidated) {
  Remove-Item -LiteralPath $backupAsar -Force -ErrorAction SilentlyContinue
  Write-Step "本轮新建的备份未通过原版检查，已移除。"
}

if ($cleanupError -and -not $installError) {
  $firstCleanupError = $cleanupError
  $installError = $firstCleanupError
  if ($formalAsarReplaced) {
    Write-Step "临时文件未清理干净，正在恢复英文原版。"
    try {
      Stop-PostmanCompletely
      Install-AsarAtomically -SourceAsar $backupAsar -DestinationAsar $appAsar
      Write-Step "已恢复英文原版 app.asar。"
    } catch {
      $rollbackError = $_
    }
  }
  $cleanupError = $null
  try {
    Remove-InstallArtifacts -UnpackedDir $unpackedDir -PatchedAsar $patchedAsar -AppAsar $appAsar
  } catch {
    $cleanupError = $_
  }
}

if ($installError) {
  $message = "汉化安装失败：$($installError.Exception.Message)"
  if ($rollbackError) {
    $message += "；自动回滚也失败：$($rollbackError.Exception.Message)"
  }
  if ($cleanupError) {
    $message += "；临时文件清理失败：$($cleanupError.Exception.Message)"
  }
  throw $message
}
if ($cleanupError) {
  throw "汉化已安装，但临时文件清理失败：$($cleanupError.Exception.Message)"
}
if (-not $installCompleted) {
  throw "汉化安装未完成。"
}

if (Test-Path -LiteralPath $unpackedDir) {
  throw "清理后仍残留本工具的解包目录：$unpackedDir"
}

if ($CleanOldVersions) {
  Remove-OldPostmanVersions -CurrentAppDir $appDir
}
Write-Step "操作完成。"
